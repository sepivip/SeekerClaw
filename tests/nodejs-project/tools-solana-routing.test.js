#!/usr/bin/env node
// tools-solana-routing.test.js — BAT-582 Phase 5 autonomy gate.
//
// PURPOSE
// -------
// Verify that the 6 wallet-aware Solana tools (solana_send, solana_swap,
// jupiter_trigger_create, jupiter_dca_create, jupiter_trigger_cancel,
// jupiter_dca_cancel) route through the right signer based on
// caps/preflight.routeFor() decisions, and that Jupiter create tools
// record ownership via /jupiter/order-owner/set after a successful
// broadcast.
//
// TEST DOUBLE
// -----------
// We mock the bridge transport (bridge.js) and capture every outbound
// request. We do NOT call the real solana.js / Jupiter API helpers —
// instead we mock the subset the tools dispatch uses. This is a unit
// test of routing, not an end-to-end integration test.

'use strict';

const assert = require('assert');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

// ── Mock config.js ──────────────────────────────────────────────────────────
const configPath = require.resolve(path.join(BUNDLE, 'config.js'));
require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: {
        BRIDGE_TOKEN: 't',
        log: () => {},
        config: { jupiterApiKey: 'fixture-jupiter-key' },
        workDir: '/tmp/fixture',
    },
};

// ── Mock bridge.js — captures every outbound call ──────────────────────────
const bridgePath = require.resolve(path.join(BUNDLE, 'bridge.js'));
let bridgeCalls = [];
let bridgeResponses = {}; // endpoint → response
require.cache[bridgePath] = {
    id: bridgePath,
    filename: bridgePath,
    loaded: true,
    exports: {
        androidBridgeCall: async (endpoint, body, _timeoutMs) => {
            bridgeCalls.push({ endpoint, body });
            const resp = bridgeResponses[endpoint];
            if (typeof resp === 'function') return resp(body);
            return resp || {};
        },
    },
};

// ── Mock solana.js — only the helpers the tools actually call ──────────────
const solanaPath = require.resolve(path.join(BUNDLE, 'solana.js'));
let jupiterTriggerExecuteCalls = [];
let jupiterRecurringExecuteCalls = [];
let jupiterUltraExecuteCalls = [];
let jupiterUltraOrderResponse = null;
let triggerCreateApiResponse = null;
let recurringCreateApiResponse = null;
require.cache[solanaPath] = {
    id: solanaPath,
    filename: solanaPath,
    loaded: true,
    exports: {
        solanaRpc: async (method, _params) => {
            if (method === 'getLatestBlockhash') {
                return { blockhash: 'BLOCKHASH-FIXTURE-' + Date.now() };
            }
            if (method === 'sendTransaction') {
                return 'BURNER-RPC-SIG-' + Date.now();
            }
            if (method === 'getBalance') return { value: 1_000_000_000 }; // 1 SOL
            if (method === 'getTokenAccountsByOwner') return { value: [] };
            return {};
        },
        base58Encode: (buf) => 'BASE58-' + Buffer.from(buf).toString('hex').slice(0, 16),
        buildSolTransferTx: (_from, _to, _lam, _bh) => Buffer.from('UNSIGNED-SOL-TX-FIXTURE'),
        resolveToken: async (sym) => {
            if (!sym) return null;
            const s = String(sym).toUpperCase();
            if (s === 'SOL') return { symbol: 'SOL', address: 'So11111111111111111111111111111111111111112', decimals: 9 };
            if (s === 'USDC') return { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 };
            return null;
        },
        jupiterQuote: async () => ({ outAmount: '1000000', otherAmountThreshold: '990000', priceImpactPct: '0.1', routePlan: [] }),
        jupiterPrice: async () => ({}),
        jupiterUltraOrder: async () => jupiterUltraOrderResponse || { transaction: 'UNSIGNED-ULTRA-TX', requestId: 'ultra-req-1' },
        jupiterUltraExecute: async (signedTx, requestId) => {
            jupiterUltraExecuteCalls.push({ signedTx, requestId });
            return { signature: 'ULTRA-SIG-FIXTURE', status: 'Success' };
        },
        jupiterTriggerExecute: async (signedTx, requestId) => {
            jupiterTriggerExecuteCalls.push({ signedTx, requestId });
            return { signature: 'TRIGGER-SIG-FIXTURE', order: 'order-trigger-123', status: 'Success' };
        },
        jupiterRecurringExecute: async (signedTx, requestId) => {
            jupiterRecurringExecuteCalls.push({ signedTx, requestId });
            return { signature: 'DCA-SIG-FIXTURE', order: 'order-dca-456', status: 'Success' };
        },
        verifySwapTransaction: () => ({ valid: true }),
        jupiterRequest: async () => ({ status: 200, data: '{}' }),
        isValidSolanaAddress: () => true,
        parseInputAmountToLamports: (amount, decimals) => {
            const [intPart, fracPart = ''] = String(amount).split('.');
            const padded = fracPart.padEnd(decimals, '0').slice(0, decimals);
            return (intPart + padded).replace(/^0+/, '') || '0';
        },
        ensureWalletAuthorized: async () => {},
        getConnectedWalletAddress: () => 'MAIN-PUBKEY-FIXTURE',
        refreshJupiterProgramLabels: async () => {},
        heliusDasRequest: async () => ({}),
    },
};

// ── Mock http.js (used by jupiter_trigger_create / jupiter_dca_create create-order calls) ─
const httpPath = require.resolve(path.join(BUNDLE, 'http.js'));
require.cache[httpPath] = {
    id: httpPath,
    filename: httpPath,
    loaded: true,
    exports: {
        httpRequest: async (opts, body) => {
            if (opts.path === '/trigger/v1/createOrder') {
                return triggerCreateApiResponse || { status: 200, data: JSON.stringify({ transaction: 'UNSIGNED-TRIGGER-TX', requestId: 'trig-req-1', order: 'order-trigger-123' }) };
            }
            if (opts.path === '/recurring/v1/createOrder') {
                return recurringCreateApiResponse || { status: 200, data: JSON.stringify({ transaction: 'UNSIGNED-DCA-TX', requestId: 'dca-req-1', order: 'order-dca-456' }) };
            }
            if (opts.path === '/trigger/v1/cancelOrder') {
                return { status: 200, data: JSON.stringify({ transaction: 'UNSIGNED-TRIGGER-CANCEL-TX', requestId: 'trig-cancel-1' }) };
            }
            if (opts.path === '/recurring/v1/cancelOrder') {
                return { status: 200, data: JSON.stringify({ transaction: 'UNSIGNED-DCA-CANCEL-TX', requestId: 'dca-cancel-1' }) };
            }
            return { status: 404 };
        },
    },
};

// ── Reset wallet registry singletons before requiring tools/solana.js ──────
const walletIndexPath = require.resolve(path.join(BUNDLE, 'wallet', 'index.js'));
delete require.cache[walletIndexPath];
const { _resetForTests } = require(walletIndexPath);
_resetForTests();

const tools = require(path.join(BUNDLE, 'tools', 'solana.js'));
// Provide numberToDecimalString (normally injected from tools/index.js)
tools._setNumberToDecimalString((n) => String(n));

// ── Test harness ────────────────────────────────────────────────────────────
let failures = 0;
async function check(label, fn) {
    bridgeCalls = [];
    jupiterTriggerExecuteCalls = [];
    jupiterRecurringExecuteCalls = [];
    jupiterUltraExecuteCalls = [];
    bridgeResponses = {};
    try { await fn(); console.log(`  ✓ ${label}`); }
    catch (e) { failures++; console.error(`  ✗ ${label}\n    ${e.stack || e.message}`); }
}

// Convenience: pre-populate /burner/status responses for routing decisions.
function _burnerOn(opts = {}) {
    bridgeResponses['/burner/status'] = {
        configured: true,
        pubkey: opts.pubkey || 'BURNER-PUBKEY-FIXTURE',
        balanceSol: '1000000000',
        balanceUsdc: '1000000',
        capPerTxSol: opts.capPerTxSol || '50000000',     // 0.05 SOL default
        capDailySol: opts.capDailySol || '100000000',    // 0.10 SOL default
        capPerTxUsdc: opts.capPerTxUsdc || '5000000',    // 5 USDC default
        capDailyUsdc: opts.capDailyUsdc || '20000000',   // 20 USDC default
        spentTodaySol: '0',
        spentTodayUsdc: '0',
        network: 'mainnet',
    };
}
function _burnerOff() {
    bridgeResponses['/burner/status'] = { configured: false };
}

(async () => {
    // ── solana_send routing ─────────────────────────────────────────────────
    await check('solana_send: burner OFF → routes through MWA /solana/sign', async () => {
        _burnerOff();
        // /solana/sign returns base64-encoded signature bytes (existing v1.0 contract).
        bridgeResponses['/solana/sign'] = { signature: Buffer.from('FAKESIG').toString('base64') };
        const result = await tools.handlers.solana_send({ to: 'TO-ADDR', amount: 0.001 });
        assert.ok(result.success, `expected success, got ${JSON.stringify(result)}`);
        const signCall = bridgeCalls.find(c => c.endpoint === '/solana/sign');
        assert.ok(signCall, 'expected /solana/sign call');
        assert.strictEqual(result.wallet, 'main');
    });

    await check('solana_send: burner ON, under cap → reserves + signs via burner + RPC broadcasts', async () => {
        _burnerOn(); // 0.05 SOL per-tx cap
        bridgeResponses['/burner/reserve'] = { reservationId: 'res-1' };
        bridgeResponses['/burner/sign-transaction'] = { signedTxBase64: 'SIGNED-BURNER-TX' };
        bridgeResponses['/burner/commit'] = { ok: true };
        const result = await tools.handlers.solana_send({ to: 'TO-ADDR', amount: 0.001 });
        assert.ok(result.success, `expected success, got ${JSON.stringify(result)}`);
        assert.strictEqual(result.wallet, 'burner');
        // Verify the routing dance:
        const reserveCall = bridgeCalls.find(c => c.endpoint === '/burner/reserve');
        assert.ok(reserveCall, 'expected /burner/reserve call');
        assert.strictEqual(reserveCall.body.name, 'burner.pertx.sol');
        assert.strictEqual(reserveCall.body.atomicAmount, '1000000'); // 0.001 SOL = 1_000_000 lamports
        const signCall = bridgeCalls.find(c => c.endpoint === '/burner/sign-transaction');
        assert.ok(signCall, 'expected /burner/sign-transaction call');
        assert.strictEqual(signCall.body.reservationId, 'res-1');
        const commitCall = bridgeCalls.find(c => c.endpoint === '/burner/commit');
        assert.ok(commitCall, 'expected /burner/commit call after success');
        assert.strictEqual(commitCall.body.reservationId, 'res-1');
        // Should NOT have called /solana/sign (MWA path)
        assert.ok(!bridgeCalls.find(c => c.endpoint === '/solana/sign'), 'MWA /solana/sign must not be called on burner path');
    });

    await check('solana_send: burner ON, over cap → routeAndSign returns error (gate would have blocked)', async () => {
        _burnerOn({ capPerTxSol: '50000000' }); // 0.05 SOL
        // 1.0 SOL > 0.05 cap; routeFor returns underCap=false. routeAndSign refuses.
        const result = await tools.handlers.solana_send({ to: 'TO-ADDR', amount: 1.0 });
        assert.ok(result.error, `expected error, got ${JSON.stringify(result)}`);
        // No reservation, no sign attempts.
        assert.ok(!bridgeCalls.find(c => c.endpoint === '/burner/reserve'), 'must NOT reserve over-cap');
        assert.ok(!bridgeCalls.find(c => c.endpoint === '/burner/sign-transaction'), 'must NOT sign over-cap');
    });

    await check('solana_send: burner OFF, USDC SPL → routes through MWA (no burner reserve)', async () => {
        _burnerOff();
        const result = await tools.handlers.solana_send({ to: 'TO-ADDR', amount: 0.001, token: 'USDC' });
        // Non-SOL send still goes through MWA when burner is off (and routing principal is null for non-USDC SPL).
        // We just verify NO burner reserve was attempted.
        assert.ok(!bridgeCalls.find(c => c.endpoint === '/burner/reserve'));
    });

    // ── solana_swap routing ─────────────────────────────────────────────────
    await check('solana_swap: burner ON, under cap → burner signs, Jupiter Ultra executes', async () => {
        _burnerOn(); // 0.05 SOL per-tx
        bridgeResponses['/burner/reserve'] = { reservationId: 'res-swap-1' };
        bridgeResponses['/burner/sign-transaction'] = { signedTxBase64: 'SIGNED-BURNER-SWAP' };
        bridgeResponses['/burner/commit'] = { ok: true };
        const result = await tools.handlers.solana_swap({ inputToken: 'SOL', outputToken: 'USDC', amount: 0.001 });
        if (result.error) throw new Error(`unexpected error: ${JSON.stringify(result)}`);
        assert.strictEqual(result.wallet, 'burner');
        // Confirm Ultra execute was called with the burner-signed tx
        assert.strictEqual(jupiterUltraExecuteCalls.length, 1);
        assert.strictEqual(jupiterUltraExecuteCalls[0].signedTx, 'SIGNED-BURNER-SWAP');
        // Confirm /solana/sign-only (MWA) was NOT called
        assert.ok(!bridgeCalls.find(c => c.endpoint === '/solana/sign-only'));
    });

    await check('solana_swap: burner OFF → MWA /solana/sign-only + Jupiter Ultra executes', async () => {
        _burnerOff();
        bridgeResponses['/solana/sign-only'] = { signedTransaction: 'SIGNED-MWA-SWAP' };
        const result = await tools.handlers.solana_swap({ inputToken: 'SOL', outputToken: 'USDC', amount: 0.001 });
        if (result.error) throw new Error(`unexpected error: ${JSON.stringify(result)}`);
        assert.strictEqual(result.wallet, 'main');
        const signOnlyCall = bridgeCalls.find(c => c.endpoint === '/solana/sign-only');
        assert.ok(signOnlyCall, 'expected /solana/sign-only call');
        // Confirm NO burner reserve happened
        assert.ok(!bridgeCalls.find(c => c.endpoint === '/burner/reserve'));
    });

    // ── jupiter_trigger_create routing + ownership ──────────────────────────
    await check('jupiter_trigger_create: burner ON → records ownership=burner', async () => {
        _burnerOn();
        bridgeResponses['/burner/reserve'] = { reservationId: 'res-trig' };
        bridgeResponses['/burner/sign-transaction'] = { signedTxBase64: 'SIGNED-BURNER-TRIG' };
        bridgeResponses['/burner/commit'] = { ok: true };
        bridgeResponses['/jupiter/order-owner/set'] = { ok: true };
        const result = await tools.handlers.jupiter_trigger_create({
            inputToken: 'SOL',
            outputToken: 'USDC',
            inputAmount: 0.001,
            triggerPrice: 100,
        });
        if (result.error) throw new Error(`unexpected error: ${JSON.stringify(result)}`);
        assert.strictEqual(result.wallet, 'burner');
        const ownershipCall = bridgeCalls.find(c => c.endpoint === '/jupiter/order-owner/set');
        assert.ok(ownershipCall, 'must record ownership after successful broadcast');
        assert.strictEqual(ownershipCall.body.creatorWalletRole, 'burner');
        assert.strictEqual(ownershipCall.body.orderId, 'order-trigger-123');
    });

    await check('jupiter_trigger_create: burner OFF → records ownership=main', async () => {
        _burnerOff();
        bridgeResponses['/solana/sign-only'] = { signedTransaction: 'SIGNED-MAIN-TRIG' };
        bridgeResponses['/jupiter/order-owner/set'] = { ok: true };
        const result = await tools.handlers.jupiter_trigger_create({
            inputToken: 'SOL',
            outputToken: 'USDC',
            inputAmount: 0.001,
            triggerPrice: 100,
        });
        if (result.error) throw new Error(`unexpected error: ${JSON.stringify(result)}`);
        assert.strictEqual(result.wallet, 'main');
        const ownershipCall = bridgeCalls.find(c => c.endpoint === '/jupiter/order-owner/set');
        assert.ok(ownershipCall, 'must record ownership after successful broadcast');
        assert.strictEqual(ownershipCall.body.creatorWalletRole, 'main');
    });

    // ── jupiter_dca_create routing + ownership ──────────────────────────────
    await check('jupiter_dca_create: burner OFF → main, records ownership=main', async () => {
        _burnerOff();
        bridgeResponses['/solana/sign-only'] = { signedTransaction: 'SIGNED-MAIN-DCA' };
        bridgeResponses['/jupiter/order-owner/set'] = { ok: true };
        const result = await tools.handlers.jupiter_dca_create({
            inputToken: 'USDC',
            outputToken: 'SOL',
            amountPerCycle: 100,
            cycleInterval: 'daily',
            totalCycles: 5,
        });
        if (result.error) {
            // jupiter_dca_create may reject on USD-min validation. The price-check
            // mock returns empty {} so the validation is gracefully skipped (per
            // tool source: "Continue without USD validation"). If we hit a different
            // error, surface it for debugging.
            throw new Error(`unexpected error: ${JSON.stringify(result)} | bridgeCalls: ${JSON.stringify(bridgeCalls.map(c => c.endpoint))}`);
        }
        assert.strictEqual(result.wallet, 'main');
        const ownershipCall = bridgeCalls.find(c => c.endpoint === '/jupiter/order-owner/set');
        assert.ok(ownershipCall, 'must record ownership after successful broadcast');
        assert.strictEqual(ownershipCall.body.creatorWalletRole, 'main');
    });

    // ── jupiter_trigger_cancel routing by creator role ──────────────────────
    await check('jupiter_trigger_cancel: creator=burner → signs via burner (zero-amount reserve)', async () => {
        _burnerOn();
        bridgeResponses['/jupiter/order-owner/get'] = { creatorWalletRole: 'burner' };
        bridgeResponses['/burner/reserve'] = (body) => {
            // Verify cancels reserve 0 (the contract path).
            assert.strictEqual(body.atomicAmount, '0', `cancel must reserve 0, got ${body.atomicAmount}`);
            return { reservationId: 'res-cancel-1' };
        };
        bridgeResponses['/burner/sign-transaction'] = { signedTxBase64: 'SIGNED-CANCEL' };
        bridgeResponses['/burner/release'] = { ok: true };
        const result = await tools.handlers.jupiter_trigger_cancel({ orderId: 'order-trigger-123' });
        if (result.error) throw new Error(`unexpected error: ${JSON.stringify(result)}`);
        assert.strictEqual(result.wallet, 'burner');
        assert.strictEqual(result.creatorRole, 'burner');
        // Cancels release (don't commit) — burner ledger stays pristine.
        const releaseCall = bridgeCalls.find(c => c.endpoint === '/burner/release');
        assert.ok(releaseCall, 'cancel must release reservation, not commit');
        assert.ok(!bridgeCalls.find(c => c.endpoint === '/burner/commit'), 'cancel must NOT commit');
        // Did NOT use MWA
        assert.ok(!bridgeCalls.find(c => c.endpoint === '/solana/sign-only'), 'burner cancel must NOT call MWA');
    });

    await check('jupiter_trigger_cancel: creator=main → signs via MWA', async () => {
        _burnerOn();
        bridgeResponses['/jupiter/order-owner/get'] = { creatorWalletRole: 'main' };
        bridgeResponses['/solana/sign-only'] = { signedTransaction: 'SIGNED-MAIN-CANCEL' };
        const result = await tools.handlers.jupiter_trigger_cancel({ orderId: 'order-trigger-123' });
        if (result.error) throw new Error(`unexpected error: ${JSON.stringify(result)}`);
        assert.strictEqual(result.wallet, 'main');
        assert.strictEqual(result.creatorRole, 'main');
        const signOnly = bridgeCalls.find(c => c.endpoint === '/solana/sign-only');
        assert.ok(signOnly, 'main-owned cancel uses MWA /solana/sign-only');
        // Did NOT touch burner reserve
        assert.ok(!bridgeCalls.find(c => c.endpoint === '/burner/reserve'));
    });

    await check('jupiter_trigger_cancel: creator=unknown → defaults to MWA', async () => {
        _burnerOn();
        bridgeResponses['/jupiter/order-owner/get'] = { creatorWalletRole: null };
        bridgeResponses['/solana/sign-only'] = { signedTransaction: 'SIGNED-MAIN-CANCEL' };
        const result = await tools.handlers.jupiter_trigger_cancel({ orderId: 'unknown-order' });
        if (result.error) throw new Error(`unexpected error: ${JSON.stringify(result)}`);
        assert.strictEqual(result.creatorRole, 'unknown');
        assert.strictEqual(result.wallet, 'main');
    });

    // ── jupiter_dca_cancel routing by creator role ──────────────────────────
    await check('jupiter_dca_cancel: creator=burner → signs via burner', async () => {
        _burnerOn();
        bridgeResponses['/jupiter/order-owner/get'] = { creatorWalletRole: 'burner' };
        bridgeResponses['/burner/reserve'] = (body) => {
            assert.strictEqual(body.atomicAmount, '0', 'DCA cancel must reserve 0');
            return { reservationId: 'res-dca-cancel' };
        };
        bridgeResponses['/burner/sign-transaction'] = { signedTxBase64: 'SIGNED-DCA-CANCEL' };
        bridgeResponses['/burner/release'] = { ok: true };
        const result = await tools.handlers.jupiter_dca_cancel({ orderId: 'order-dca-456' });
        if (result.error) throw new Error(`unexpected error: ${JSON.stringify(result)}`);
        assert.strictEqual(result.wallet, 'burner');
        assert.ok(!bridgeCalls.find(c => c.endpoint === '/solana/sign-only'));
    });

    await check('jupiter_dca_cancel: creator=main → signs via MWA', async () => {
        _burnerOn();
        bridgeResponses['/jupiter/order-owner/get'] = { creatorWalletRole: 'main' };
        bridgeResponses['/solana/sign-only'] = { signedTransaction: 'SIGNED-MAIN-DCA-CANCEL' };
        const result = await tools.handlers.jupiter_dca_cancel({ orderId: 'order-dca-456' });
        if (result.error) throw new Error(`unexpected error: ${JSON.stringify(result)}`);
        assert.strictEqual(result.wallet, 'main');
    });

    if (failures > 0) {
        console.error(`\n${failures} failure(s).`);
        process.exit(1);
    }
    console.log(`\nPASS: tools-solana-routing.test.js (${5 + 6} routing scenarios verified).`);
})();
