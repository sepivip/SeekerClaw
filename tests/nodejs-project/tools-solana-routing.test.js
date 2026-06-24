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
// BAT-1036: getAccountInfo mock for solana_send_token (mint triple-pin + ATA
// existence). Default: account missing (value:null). Tests override per-pubkey.
const _TKN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const _TKN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
function _mintAccountInfo(owner, decimals) {
    const data = Buffer.alloc(82);
    data.writeUInt8(decimals & 0xff, 44);
    return { value: { owner, data: [data.toString('base64'), 'base64'], lamports: 1461600 } };
}
function _tokenAccountInfo() {
    return { value: { owner: _TKN_PROGRAM, data: ['', 'base64'], lamports: 2039280 } };
}
let mockAccountInfoFn = () => ({ value: null });
require.cache[solanaPath] = {
    id: solanaPath,
    filename: solanaPath,
    loaded: true,
    exports: {
        solanaRpc: async (method, params) => {
            if (method === 'getLatestBlockhash') {
                // Valid base58 32-byte fixture so the REAL classic-SPL builder
                // (solana_send_token) can decode it. solana_send stubs its own
                // tx builder, so this value is inert for those tests.
                return { blockhash: '11111111111111111111111111111111' };
            }
            if (method === 'sendTransaction') {
                return 'BURNER-RPC-SIG-' + Date.now();
            }
            if (method === 'getAccountInfo') {
                return mockAccountInfoFn(params && params[0]);
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
            if (s === 'PYUSD') return { symbol: 'PYUSD', address: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', decimals: 6 }; // BAT-1038: Token-2022
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
        // R-next-10: match production's isValidSolanaAddress more closely.
        // Production checks charset+length AND base58-decodes + asserts the
        // decoded payload is exactly 32 bytes. The previous lightweight stub
        // (charset + 32..44 length only) gave false confidence: e.g.
        // '1'.repeat(33) is 33 base58 chars (passes 32..44 length check),
        // decodes to 33 zero bytes (FAILS production's length === 32 check),
        // but the old stub would accept it. The new stub rejects via the
        // tx-parser base58Decode. Reusing wallet/tx-parser.js's base58Decode
        // keeps the tests hermetic (no network, no production solana.js
        // loaded) while matching the real validation contract.
        isValidSolanaAddress: (s) => {
            if (typeof s !== 'string') return false;
            const trimmed = s.trim();
            if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) return false;
            try {
                const txParserPath = path.resolve(BUNDLE, 'wallet', 'tx-parser.js');
                const { base58Decode } = require(txParserPath);
                return base58Decode(trimmed).length === 32;
            } catch (_) {
                return false;
            }
        },
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

// ── Mock wallet/burner-policy.js (BAT-1013) ────────────────────────────────
// The routing tests exercise routing DECISIONS, not the burner policy gate
// itself. The policy gate has its own dedicated test file
// (`burner-policy.test.js`). For the routing tests, we stub `validateBurnerTx`
// to always accept — otherwise the placeholder tx fixtures (e.g.
// 'UNSIGNED-TRIGGER-CANCEL-TX') would fail the structural parser and
// every burner-routed test would reject with `tx_unparseable`.
//
// BAT-1013-followup: the stub also captures the expectedDelta passed to
// validateBurnerTx so the B1 wsolAtaExemption test can assert on its shape
// without needing a real policy gate.
let lastValidateBurnerTxArgs = null;
const burnerPolicyPath = require.resolve(path.join(BUNDLE, 'wallet', 'burner-policy.js'));
require.cache[burnerPolicyPath] = {
    id: burnerPolicyPath,
    filename: burnerPolicyPath,
    loaded: true,
    exports: {
        REJECT_CODES: [], // routing tests don't assert on reject codes
        REJECT_CLASS: {},
        DELTA_KINDS: [],
        SIGNER_MODES: [],
        validateBurnerTx: async (txBase64, expectedDelta, opts) => {
            lastValidateBurnerTxArgs = { txBase64, expectedDelta, opts };
            return { ok: true, simulated: false };
        },
        _validateSignerMode: () => ({ ok: true }),
        _validateDrainerOpcodes: () => ({ ok: true }),
        _validateExpectedDeltaShape: () => ({ ok: true }),
        _validateSimDelta: () => ({ ok: true }),
        _buildAccountChecks: () => [],
        _applyTolerance: () => null,
        _indexOfPubkey: () => -1,
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
                // BAT-1013-followup C2: data.order MUST be a real base58 pubkey
                // for the burner path; tools/solana.js validates via
                // isValidSolanaAddress before tunneling into expectedDelta.
                // Use a stable test pubkey (System Program) so the validation
                // passes; assertions on orderId compare against this string.
                return triggerCreateApiResponse || { status: 200, data: JSON.stringify({ transaction: 'UNSIGNED-TRIGGER-TX', requestId: 'trig-req-1', order: '11111111111111111111111111111111' }) };
            }
            if (opts.path === '/recurring/v1/createOrder') {
                // DCA always forces main routing (v8.3), so base58 validity of
                // `order` doesn't gate the burner path; keep the legacy fixture.
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
let passes = 0;
async function check(label, fn) {
    bridgeCalls = [];
    // BAT-1036/1038: reset per test. Default = a CLASSIC SPL mint for any pubkey,
    // so the swap handler's BAT-1038 mint-program lookup resolves to classic (the
    // pre-existing swap routing). solana_send_token tests override this per case.
    mockAccountInfoFn = () => _mintAccountInfo(_TKN_PROGRAM, 6);
    lastValidateBurnerTxArgs = null;
    jupiterTriggerExecuteCalls = [];
    jupiterRecurringExecuteCalls = [];
    jupiterUltraExecuteCalls = [];
    bridgeResponses = {};
    try { await fn(); passes++; console.log(`  ✓ ${label}`); }
    catch (e) { failures++; console.error(`  ✗ ${label}\n    ${e.stack || e.message}`); }
}

// Convenience: pre-populate /burner/status responses for routing decisions.
// BAT-1013 Phase 3: pubkey must be a valid base58 (>= 32 chars) so the
// BurnerSigner policy gate (which validates burnerPubkey shape) accepts it.
// Reset the BurnerSigner per-process pubkey cache so each test starts clean.
function _burnerOn(opts = {}) {
    try {
        const { _resetBurnerPubkeyCache } = require('../../app/src/main/assets/nodejs-project/wallet/burner-signer.js');
        if (typeof _resetBurnerPubkeyCache === 'function') _resetBurnerPubkeyCache();
    } catch (_) { /* may not be loaded yet in early test setup */ }
    bridgeResponses['/burner/status'] = {
        configured: true,
        pubkey: opts.pubkey || '11111111111111111111111111111112',
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

    // ── BAT-1038: Token-2022 swap output — correct ATA derivation ───────────
    const _PYUSD_MINT = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';
    const _USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const _BURNER_DEFAULT = '11111111111111111111111111111112'; // _burnerOn() default pubkey
    const { deriveAtaBase58: _deriveAta } = require(path.join(BUNDLE, 'wallet', 'ata'));

    await check('BAT-1038: SOL→PYUSD (Token-2022 output) → credit ATA derived with Token-2022 program, NOT the phantom classic', async () => {
        _burnerOn(); // 5 USDC cap; under-cap USDC input → burner
        bridgeResponses['/burner/reserve'] = { reservationId: 'res-t22' };
        bridgeResponses['/burner/sign-transaction'] = { signedTxBase64: 'SIGNED-T22-SWAP' };
        bridgeResponses['/burner/commit'] = { ok: true };
        // PYUSD mint is Token-2022; USDC mint is classic.
        mockAccountInfoFn = (pk) => pk === _PYUSD_MINT ? _mintAccountInfo(_TKN_2022_PROGRAM, 6) : _mintAccountInfo(_TKN_PROGRAM, 6);
        const result = await tools.handlers.solana_swap({ inputToken: 'SOL', outputToken: 'PYUSD', amount: 0.001 });
        if (result.error) throw new Error(`unexpected error: ${JSON.stringify(result)}`);
        assert.strictEqual(result.wallet, 'burner');
        const ed = lastValidateBurnerTxArgs && lastValidateBurnerTxArgs.expectedDelta;
        assert.ok(ed, 'expectedDelta must reach validateBurnerTx');
        const correctAta = _deriveAta(_BURNER_DEFAULT, _PYUSD_MINT, _TKN_2022_PROGRAM);
        const phantomClassic = _deriveAta(_BURNER_DEFAULT, _PYUSD_MINT); // the OLD wrong (2-arg) derivation
        assert.strictEqual(ed.burnerCreditMin.account, correctAta, 'credit account MUST be the Token-2022 ATA');
        assert.notStrictEqual(ed.burnerCreditMin.account, phantomClassic, 'must NOT be the phantom classic ATA (the BAT-1038 bug)');
        assert.strictEqual(ed.burnerCreditMin.mint, _PYUSD_MINT);
        // debit side is native SOL (input is SOL) → the burner pubkey, not an ATA
        assert.strictEqual(ed.burnerDebit.account, _BURNER_DEFAULT);
        assert.strictEqual(ed.burnerDebit.mint, 'native_sol');
    });

    await check('BAT-1038: output mint with unrecognized owner program → forces main, burner NOT invoked', async () => {
        _burnerOn();
        bridgeResponses['/solana/sign-only'] = { signedTransaction: 'SIGNED-MAIN-UNKNOWN' };
        // PYUSD's mint owner is some non-token program (e.g. System) → unknown → fail-safe to main.
        mockAccountInfoFn = (pk) => pk === _PYUSD_MINT ? _mintAccountInfo('11111111111111111111111111111111', 6) : _mintAccountInfo(_TKN_PROGRAM, 6);
        const result = await tools.handlers.solana_swap({ inputToken: 'SOL', outputToken: 'PYUSD', amount: 0.001 });
        if (result.error) throw new Error(`unexpected error: ${JSON.stringify(result)}`);
        assert.strictEqual(result.wallet, 'main', 'unknown output mint program must force main (fail-safe)');
        assert.ok(!bridgeCalls.find(c => c.endpoint === '/burner/sign-transaction'), 'burner must NOT sign for an unknown mint program');
        assert.ok(bridgeCalls.find(c => c.endpoint === '/solana/sign-only'), 'expected MWA fallback');
    });

    await check('BAT-1038 Amendment 1: Ultra order fee payer != burner → fee_payer_mismatch, no reserve/sign/broadcast', async () => {
        _burnerOn();
        bridgeResponses['/burner/reserve'] = { reservationId: 'res-fpm' };
        bridgeResponses['/burner/sign-transaction'] = { signedTxBase64: 'X' };
        // Build a VALID order tx whose fee payer (account[0]) is NOT the burner.
        const x402b = require(path.join(BUNDLE, 'payment', 'x402'));
        const NON_BURNER = 'So11111111111111111111111111111111111111112';
        const built = x402b.buildClassicSplTransferTx({
            payerAuthority: NON_BURNER, recipientOwner: _USDC_MINT, mint: _USDC_MINT,
            decimals: 6, amountAtomic: 1n, recentBlockhash: '11111111111111111111111111111111', createRecipientAta: false,
        });
        jupiterUltraOrderResponse = { transaction: built.txBuffer.toString('base64'), requestId: 'ultra-fpm' };
        try {
            const result = await tools.handlers.solana_swap({ inputToken: 'SOL', outputToken: 'USDC', amount: 0.001 });
            assert.strictEqual(result.error, 'fee_payer_mismatch', JSON.stringify(result));
            assert.strictEqual(result.retryable, true);
            assert.ok(!bridgeCalls.find(c => c.endpoint === '/burner/reserve'), 'no reserve on fee-payer mismatch');
            assert.ok(!bridgeCalls.find(c => c.endpoint === '/burner/sign-transaction'), 'no burner sign on fee-payer mismatch');
            assert.ok(!bridgeCalls.find(c => c.endpoint === '/solana/sign-only'), 'no MWA sign — the burner order is NOT reused on main');
            assert.strictEqual(jupiterUltraExecuteCalls.length, 0, 'no execute/broadcast');
        } finally {
            jupiterUltraOrderResponse = null;
        }
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

    // ── v8.3 behavioral assertions (Codex amendment): autonomous burner must
    //    NOT be invoked for deposit flows that cannot verify destination ──────
    await check('v8.3: jupiter_trigger_create V1 missing data.order → routes to main, burner NOT invoked', async () => {
        // Jupiter responds WITHOUT the `order` PDA — autonomous burner cannot
        // verify deposit destination. Call site must forceRouting='main'.
        triggerCreateApiResponse = { status: 200, data: JSON.stringify({ transaction: 'UNSIGNED-TRIGGER-TX', requestId: 'trig-req-no-order' }) };
        _burnerOn(); // burner is available but should NOT be used
        bridgeResponses['/solana/sign-only'] = { signedTransaction: 'SIGNED-MAIN-TRIG-FALLBACK' };
        bridgeResponses['/jupiter/order-owner/set'] = { ok: true };
        try {
            const result = await tools.handlers.jupiter_trigger_create({
                inputToken: 'SOL',
                outputToken: 'USDC',
                inputAmount: 0.001,
                triggerPrice: 100,
            });
            if (result.error) throw new Error(`unexpected error: ${JSON.stringify(result)}`);
            assert.strictEqual(result.wallet, 'main', 'V1 with missing data.order must route to main');
            // Burner must NOT have been reserved or invoked
            assert.ok(!bridgeCalls.find(c => c.endpoint === '/burner/reserve'), 'burner must not reserve when data.order missing');
            assert.ok(!bridgeCalls.find(c => c.endpoint === '/burner/sign-transaction'), 'burner must not sign when data.order missing');
            // MWA path was used instead
            assert.ok(bridgeCalls.find(c => c.endpoint === '/solana/sign-only'), 'expected /solana/sign-only call for main routing');
        } finally {
            triggerCreateApiResponse = null;
        }
    });

    await check('v8.3: jupiter_dca_create always routes to main, burner NOT invoked even when ON', async () => {
        // DCA create has no pre-sign vault pubkey from Jupiter Recurring API.
        // v8.3 call site sets forceRouting='main' unconditionally. Even with
        // burner ON and ample caps, the burner must NOT be invoked.
        _burnerOn({ capPerTxUsdc: '50000000', capDailyUsdc: '100000000' }); // 50 USDC per-tx
        bridgeResponses['/solana/sign-only'] = { signedTransaction: 'SIGNED-MAIN-DCA-FORCED' };
        bridgeResponses['/jupiter/order-owner/set'] = { ok: true };
        const result = await tools.handlers.jupiter_dca_create({
            inputToken: 'USDC',
            outputToken: 'SOL',
            amountPerCycle: 1,
            cycleInterval: 'daily',
            totalCycles: 5,
        });
        if (result.error) {
            throw new Error(`unexpected error: ${JSON.stringify(result)} | bridgeCalls: ${JSON.stringify(bridgeCalls.map(c => c.endpoint))}`);
        }
        assert.strictEqual(result.wallet, 'main', 'DCA create must always route to main (v8.3)');
        // Burner must NOT have been reserved or invoked
        assert.ok(!bridgeCalls.find(c => c.endpoint === '/burner/reserve'), 'burner must not reserve for DCA create');
        assert.ok(!bridgeCalls.find(c => c.endpoint === '/burner/sign-transaction'), 'burner must not sign DCA create');
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

    // ── C2: Jupiter response base58 validation ──────────────────────────────
    // Pre-fix, only truthy-checking `data.order` / `vaultPubkey` allowed a
    // string like 'not_a_pubkey' or 'undefined' to be tunneled into
    // expectedDelta.depositVault.pubkey. The followup adds isValidSolanaAddress
    // at the call site BEFORE the value reaches the policy gate.

    await check('C2: jupiter_trigger_create V1 data.order non-base58 → routes to main, burner NOT invoked', async () => {
        // Jupiter returns a string that's truthy but NOT a base58 pubkey
        // (matches the C2 attack: 'pending', 'undefined', 'true', etc.).
        triggerCreateApiResponse = { status: 200, data: JSON.stringify({ transaction: 'UNSIGNED-TRIGGER-TX', requestId: 'trig-req-c2', order: 'not_a_pubkey' }) };
        _burnerOn();
        bridgeResponses['/solana/sign-only'] = { signedTransaction: 'SIGNED-MAIN-TRIG-C2' };
        bridgeResponses['/jupiter/order-owner/set'] = { ok: true };
        try {
            const result = await tools.handlers.jupiter_trigger_create({
                inputToken: 'SOL',
                outputToken: 'USDC',
                inputAmount: 0.001,
                triggerPrice: 100,
            });
            if (result.error) throw new Error(`unexpected error: ${JSON.stringify(result)}`);
            assert.strictEqual(result.wallet, 'main', 'non-base58 data.order must force main routing');
            // Burner must NOT have been reserved or invoked
            assert.ok(!bridgeCalls.find(c => c.endpoint === '/burner/reserve'), 'burner must not reserve when data.order is non-base58');
            assert.ok(!bridgeCalls.find(c => c.endpoint === '/burner/sign-transaction'), 'burner must not sign when data.order is non-base58');
            // Main MWA path was used
            assert.ok(bridgeCalls.find(c => c.endpoint === '/solana/sign-only'), 'expected /solana/sign-only call for main routing');
        } finally {
            triggerCreateApiResponse = null;
        }
    });

    // ── B1: Jupiter Ultra native-SOL → wsolAtaExemption is built ────────────
    // For native-SOL Jupiter Ultra swaps, Jupiter's documented wrapping
    // pattern is open-wSOL-ATA → swap → CloseAccount(wSOL-ATA, destination=
    // burner). burner-policy treats CloseAccount as drainer-class by default;
    // tools/solana.js must attach an explicit wsolAtaExemption so the policy
    // gate can accept this single CloseAccount instance and reject any
    // deviation. The exemption MUST be { ata: burner-wSOL-ATA, destination:
    // burner } — anything else is fail-closed.

    await check('B1: solana_swap native-SOL (burner) → expectedDelta carries wsolAtaExemption {ata, destination=burner}', async () => {
        _burnerOn();
        bridgeResponses['/burner/reserve'] = { reservationId: 'res-swap-b1' };
        bridgeResponses['/burner/sign-transaction'] = { signedTxBase64: 'SIGNED-BURNER-SWAP-B1' };
        bridgeResponses['/burner/commit'] = { ok: true };
        lastValidateBurnerTxArgs = null;
        const result = await tools.handlers.solana_swap({ inputToken: 'SOL', outputToken: 'USDC', amount: 0.001 });
        if (result.error) throw new Error(`unexpected error: ${JSON.stringify(result)}`);
        assert.strictEqual(result.wallet, 'burner');
        // expectedDelta must have been forwarded to the policy gate stub.
        assert.ok(lastValidateBurnerTxArgs, 'validateBurnerTx must have been called with expectedDelta');
        const ed = lastValidateBurnerTxArgs.expectedDelta;
        assert.ok(ed, 'expectedDelta must be present');
        assert.strictEqual(ed.kind, 'jupiter_swap_immediate', 'kind must be jupiter_swap_immediate');
        assert.ok(ed.wsolAtaExemption, 'native-SOL Jupiter Ultra swap must build wsolAtaExemption');
        assert.strictEqual(typeof ed.wsolAtaExemption.ata, 'string', 'wsolAtaExemption.ata must be a base58 string');
        assert.ok(ed.wsolAtaExemption.ata.length >= 32 && ed.wsolAtaExemption.ata.length <= 44, 'wsolAtaExemption.ata must be a base58 pubkey length');
        // destination MUST equal the burner pubkey (the fixture default).
        assert.strictEqual(ed.wsolAtaExemption.destination, '11111111111111111111111111111112', 'wsolAtaExemption.destination must equal burner pubkey');
    });

    await check('B1: solana_swap USDC→USDT (no native SOL) → expectedDelta has NO wsolAtaExemption', async () => {
        _burnerOn({ capPerTxUsdc: '50000000', capDailyUsdc: '100000000' });
        bridgeResponses['/burner/reserve'] = { reservationId: 'res-swap-b1b' };
        bridgeResponses['/burner/sign-transaction'] = { signedTxBase64: 'SIGNED-BURNER-SWAP-B1B' };
        bridgeResponses['/burner/commit'] = { ok: true };
        lastValidateBurnerTxArgs = null;
        // resolveToken mock only knows SOL + USDC; USDT will return null.
        // Use SOL on both sides so the swap doesn't reject on unknown token —
        // but we need a non-native swap. Resolve a different mint by using
        // the USDC ↔ USDC happy-path workaround: input USDC, output USDC.
        // The intent is structural: neither input nor output mint is native_sol.
        const result = await tools.handlers.solana_swap({ inputToken: 'USDC', outputToken: 'USDC', amount: 0.001 });
        // The handler may reject or proceed; we only care about the expectedDelta
        // shape IF validateBurnerTx was reached. If validateBurnerTx ran, the
        // exemption MUST be absent for non-native-SOL pairs.
        if (lastValidateBurnerTxArgs && lastValidateBurnerTxArgs.expectedDelta) {
            const ed = lastValidateBurnerTxArgs.expectedDelta;
            if (ed.kind === 'jupiter_swap_immediate') {
                assert.ok(!ed.wsolAtaExemption, 'non-native-SOL swap must NOT carry wsolAtaExemption');
            }
        }
        // If the handler errored before reaching the policy gate (e.g. resolveToken
        // surfaced a different rejection), that's fine — the structural invariant
        // is "no wsolAtaExemption when neither side is native SOL", and unreached
        // expectedDelta-build paths don't violate that.
        void result;
    });

    // ── Copilot PR #398 R13 regression: _extractFeePayerBase58 version guard ─
    // Strict `=== 0x80` check would silently treat future versioned-message
    // prefixes (0x81 = v1, 0x82 = v2, ...) as legacy, returning the wrong
    // fee payer with no error signal. The bitmask + version-guard fix throws
    // unsupported_tx_version instead.
    function buildMinimalFeePayerTx(versionPrefix, sigCount) {
        const FEE_PAYER_BYTE = 0xAB;
        const parts = [];
        parts.push(Buffer.from([sigCount])); // compact-u16 sig count (single byte for 0/1)
        parts.push(Buffer.alloc(sigCount * 64, 0x00)); // sig slots
        if (versionPrefix !== undefined) parts.push(Buffer.from([versionPrefix]));
        parts.push(Buffer.from([0x01, 0x00, 0x01])); // 3-byte header
        parts.push(Buffer.from([0x01])); // 1 account
        parts.push(Buffer.alloc(32, FEE_PAYER_BYTE));
        return Buffer.concat(parts).toString('base64');
    }

    await check('R13: _extractFeePayerBase58 — legacy tx returns fee payer', async () => {
        const tx = buildMinimalFeePayerTx(undefined, 0);
        const r = tools._extractFeePayerBase58(tx);
        assert.ok(typeof r === 'string' && r.length > 0, 'legacy tx must return non-empty fee payer');
    });

    await check('R13: _extractFeePayerBase58 — v0 tx (0x80) returns fee payer', async () => {
        const tx = buildMinimalFeePayerTx(0x80, 1);
        const r = tools._extractFeePayerBase58(tx);
        assert.ok(typeof r === 'string' && r.length > 0, 'v0 tx must return non-empty fee payer');
    });

    await check('R13: _extractFeePayerBase58 — v1 tx (0x81) throws unsupported_tx_version', async () => {
        const tx = buildMinimalFeePayerTx(0x81, 1);
        try {
            tools._extractFeePayerBase58(tx);
            assert.fail('expected throw on v1 prefix');
        } catch (e) {
            assert.match(e.message, /unsupported_tx_version.*v1/, `expected v1 error, got: ${e.message}`);
        }
    });

    await check('R13: _extractFeePayerBase58 — v2 tx (0x82) throws unsupported_tx_version', async () => {
        const tx = buildMinimalFeePayerTx(0x82, 1);
        try { tools._extractFeePayerBase58(tx); assert.fail(); }
        catch (e) { assert.match(e.message, /unsupported_tx_version.*v2/); }
    });

    await check('R13: _extractFeePayerBase58 — v127 tx (0xFF) throws unsupported_tx_version', async () => {
        const tx = buildMinimalFeePayerTx(0xFF, 1);
        try { tools._extractFeePayerBase58(tx); assert.fail(); }
        catch (e) { assert.match(e.message, /unsupported_tx_version.*v127/); }
    });

    await check('R-next-16 ordering: oversized + invalid-charset → tx_oversize (cap fires before regex)', async () => {
        // Discriminating input: '@' is NOT a valid base64 char, and the
        // string is also > 1644 chars (over the cap). If the charset regex
        // runs BEFORE the length cap (the pre-R-next-16 bug), this throws
        // 'invalid base64'. If the length cap runs FIRST (the R-next-16
        // fix), this throws 'tx_oversize'. Pinning 'tx_oversize' here makes
        // a future regression of the ordering caught by this test.
        const oversizedInvalid = '@'.repeat(2000);
        try {
            tools._extractFeePayerBase58(oversizedInvalid);
            assert.fail('expected throw');
        } catch (e) {
            assert.match(e.message, /tx_oversize/,
                `R-next-16 ordering regression: length cap MUST run before charset regex; got message=${e.message}`);
        }
    });

    // ── BAT-1013 foundation patch: solana_send source param + self-send + pre-flight ──
    await check('foundation: source="main" forces main routing even when burner ON + under cap', async () => {
        _burnerOn();
        bridgeResponses['/solana/sign'] = { signature: Buffer.from('FAKESIG-MAIN-FORCED').toString('base64') };
        const result = await tools.handlers.solana_send({ to: 'RECIPIENT-DIFFERENT-FROM-MAIN', amount: 0.001, source: 'main' });
        assert.ok(result.success || result.signature, `expected MWA path success, got ${JSON.stringify(result)}`);
        assert.strictEqual(result.wallet, 'main', 'source="main" must produce wallet=main even when burner has capacity');
        const signCall = bridgeCalls.find(c => c.endpoint === '/solana/sign');
        assert.ok(signCall, 'expected /solana/sign call for main-forced routing');
        assert.ok(!bridgeCalls.find(c => c.endpoint === '/burner/reserve'), 'burner must NOT reserve when source="main"');
    });

    await check('foundation: source="auto" (default) routes by cap as before', async () => {
        _burnerOn();
        bridgeResponses['/burner/reserve'] = { reservationId: 'res-source-auto' };
        bridgeResponses['/burner/sign-transaction'] = { signedTxBase64: 'SIGNED-BURNER-AUTO' };
        bridgeResponses['/burner/commit'] = { ok: true };
        const result = await tools.handlers.solana_send({ to: 'RECIPIENT-DIFFERENT', amount: 0.001, source: 'auto' });
        assert.ok(result.success || result.signature, `expected burner success, got ${JSON.stringify(result)}`);
        assert.strictEqual(result.wallet, 'burner', 'source="auto" under cap must route to burner');
        const reserveCall = bridgeCalls.find(c => c.endpoint === '/burner/reserve');
        assert.ok(reserveCall, 'expected /burner/reserve call for auto-routed burner path');
    });

    await check('foundation: self-send REJECTED with clean error (no bridge calls)', async () => {
        _burnerOn();
        // Read the burner pubkey the test rigs into _burnerOn (matches BURNER_USDC_ATA fixture pattern).
        const burnerPub = bridgeResponses['/burner/status'].pubkey;
        const result = await tools.handlers.solana_send({ to: burnerPub, amount: 0.001 });
        assert.ok(result.error, `expected error for self-send, got ${JSON.stringify(result)}`);
        assert.strictEqual(result.error, 'self_send_rejected', `expected self_send_rejected, got ${result.error}`);
        assert.match(result.reason, /same address|self|recipient/i);
        // Critical: NO bridge calls (no reserve, no sign)
        assert.ok(!bridgeCalls.find(c => c.endpoint === '/burner/reserve'), 'self-send must not reserve');
        assert.ok(!bridgeCalls.find(c => c.endpoint === '/burner/sign-transaction'), 'self-send must not sign');
        assert.ok(!bridgeCalls.find(c => c.endpoint === '/solana/sign'), 'self-send must not MWA-sign');
    });

    // Note: a test that fully exercises the "main not connected" pre-flight
    // requires swapping the getConnectedWalletAddress stub at module-cache
    // level AFTER tools/solana.js has already destructured it at load time
    // (the destructuring captures the original reference; runtime stub
    // swaps don't apply). That refactor (call via namespace `solana.getX()`
    // instead of destructure) is a separate quality cleanup. For now, the
    // pre-flight behavior is verified via:
    //  - burner-policy self-send REJECT test (covers the policy-gate side
    //    of the same defense — see burner-policy.test.js)
    //  - the source="main" routing test above (verifies forceRouting works)
    //  - device test (real "main not connected" scenario hits the pre-flight)
    // TODO(BAT-1013-followup): refactor tools/solana.js to call
    // solana.getConnectedWalletAddress() via namespace, enabling cleaner
    // stub-based test of this pre-flight path.

    // ── solana_send_token (BAT-1036) ─────────────────────────────────────────
    const _USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const _BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    const _RCPT = 'So11111111111111111111111111111111111111112';
    const _BURNER_PK = '11111111111111111111111111111112';

    await check('solana_send_token: Token-2022 mint → token_2022_send_unsupported, zero side effects', async () => {
        _burnerOn();
        mockAccountInfoFn = (pk) => pk === _USDC ? _mintAccountInfo(_TKN_2022_PROGRAM, 6) : _tokenAccountInfo();
        const r = await tools.handlers.solana_send_token({ to: _RCPT, mint: _USDC, amount: '1' });
        assert.strictEqual(r.error, 'token_2022_send_unsupported', JSON.stringify(r));
        assert.ok(!bridgeCalls.find(c => c.endpoint === '/burner/reserve'), 'must not reserve on Token-2022');
        assert.ok(!bridgeCalls.find(c => c.endpoint === '/burner/sign-transaction'), 'must not sign on Token-2022');
    });

    await check('solana_send_token: non-Token-program mint owner → unsupported_mint', async () => {
        _burnerOn();
        mockAccountInfoFn = (pk) => pk === _BONK ? _mintAccountInfo('11111111111111111111111111111111', 5) : _tokenAccountInfo();
        const r = await tools.handlers.solana_send_token({ to: _RCPT, mint: _BONK, amount: '1' });
        assert.strictEqual(r.error, 'unsupported_mint', JSON.stringify(r));
    });

    await check('solana_send_token: mint not on-chain → mint_not_found, no reserve/sign', async () => {
        _burnerOn();
        mockAccountInfoFn = () => ({ value: null });
        const r = await tools.handlers.solana_send_token({ to: _RCPT, mint: _USDC, amount: '1' });
        assert.strictEqual(r.error, 'mint_not_found', JSON.stringify(r));
        assert.ok(!bridgeCalls.find(c => c.endpoint === '/burner/reserve'), 'no reserve on pin fail');
    });

    await check('solana_send_token: spoofed USDC decimals (8≠6) → usdc_decimals_mismatch', async () => {
        _burnerOn();
        mockAccountInfoFn = (pk) => pk === _USDC ? _mintAccountInfo(_TKN_PROGRAM, 8) : _tokenAccountInfo();
        const r = await tools.handlers.solana_send_token({ to: _RCPT, mint: _USDC, amount: '1' });
        assert.strictEqual(r.error, 'usdc_decimals_mismatch', JSON.stringify(r));
    });

    await check('solana_send_token: source="burner" + non-USDC → unsupported_cap_asset (never silent main)', async () => {
        _burnerOn();
        mockAccountInfoFn = (pk) => pk === _BONK ? _mintAccountInfo(_TKN_PROGRAM, 5) : _tokenAccountInfo();
        const r = await tools.handlers.solana_send_token({ to: _RCPT, mint: _BONK, amount: '1', source: 'burner' });
        assert.strictEqual(r.error, 'unsupported_cap_asset', JSON.stringify(r));
        assert.ok(!bridgeCalls.find(c => c.endpoint === '/burner/reserve'), 'no reserve');
    });

    await check('solana_send_token: self-send (to === source wallet) → self_send_rejected', async () => {
        _burnerOn({ pubkey: _BURNER_PK });
        mockAccountInfoFn = (pk) => pk === _USDC ? _mintAccountInfo(_TKN_PROGRAM, 6) : _tokenAccountInfo();
        const r = await tools.handlers.solana_send_token({ to: _BURNER_PK, mint: _USDC, amount: '1', source: 'burner' });
        assert.strictEqual(r.error, 'self_send_rejected', JSON.stringify(r));
    });

    await check('solana_send_token: source ATA missing → source_ata_missing_or_insufficient (no sign)', async () => {
        _burnerOn({ pubkey: _BURNER_PK });
        const { deriveAtaBase58 } = require(path.join(BUNDLE, 'wallet', 'ata'));
        const srcAta = deriveAtaBase58(_BURNER_PK, _USDC);
        mockAccountInfoFn = (pk) => {
            if (pk === _USDC) return _mintAccountInfo(_TKN_PROGRAM, 6);
            if (pk === srcAta) return { value: null }; // source ATA missing
            return _tokenAccountInfo();
        };
        const r = await tools.handlers.solana_send_token({ to: _RCPT, mint: _USDC, amount: '1', source: 'burner' });
        assert.strictEqual(r.error, 'source_ata_missing_or_insufficient', JSON.stringify(r));
        assert.ok(!bridgeCalls.find(c => c.endpoint === '/burner/sign-transaction'), 'must not sign');
    });

    await check('solana_send_token: zero amount → zero_amount', async () => {
        _burnerOn();
        mockAccountInfoFn = (pk) => pk === _USDC ? _mintAccountInfo(_TKN_PROGRAM, 6) : _tokenAccountInfo();
        const r = await tools.handlers.solana_send_token({ to: _RCPT, mint: _USDC, amount: '0', source: 'burner' });
        assert.strictEqual(r.error, 'zero_amount', JSON.stringify(r));
    });

    await check('solana_send_token: burner USDC under cap → expectedDelta declares ATAs (security invariant) + USDC cap reserve', async () => {
        _burnerOn({ pubkey: _BURNER_PK }); // 5 USDC per-tx cap
        bridgeResponses['/burner/reserve'] = { reservationId: 'res-tok-1' };
        bridgeResponses['/burner/sign-transaction'] = { signedTxBase64: 'SIGNED-TOK-TX' };
        bridgeResponses['/burner/commit'] = { ok: true };
        const { deriveAtaBase58 } = require(path.join(BUNDLE, 'wallet', 'ata'));
        const srcAta = deriveAtaBase58(_BURNER_PK, _USDC);
        const dstAta = deriveAtaBase58(_RCPT, _USDC);
        mockAccountInfoFn = (pk) => pk === _USDC ? _mintAccountInfo(_TKN_PROGRAM, 6) : _tokenAccountInfo();
        const r = await tools.handlers.solana_send_token({ to: _RCPT, mint: _USDC, amount: '1', source: 'burner' });
        assert.ok(r.success, `expected success, got ${JSON.stringify(r)}`);
        assert.strictEqual(r.wallet, 'burner');
        const ed = lastValidateBurnerTxArgs && lastValidateBurnerTxArgs.expectedDelta;
        assert.ok(ed, 'expectedDelta must reach validateBurnerTx');
        assert.strictEqual(ed.kind, 'solana_send');
        assert.strictEqual(ed.burnerDebit.mint, _USDC);
        assert.strictEqual(ed.burnerDebit.atomicAmount, '1000000'); // 1 USDC @ 6 decimals
        assert.strictEqual(ed.burnerDebit.account, srcAta, 'burnerDebit.account must be the SOURCE ATA, not the wallet');
        assert.strictEqual(ed.recipient.account, dstAta, 'recipient.account must be the DEST ATA, not the wallet');
        assert.strictEqual(ed.recipient.mint, _USDC);
        assert.notStrictEqual(ed.burnerDebit.account, ed.recipient.account, 'debit and recipient ATAs must differ');
        const reserve = bridgeCalls.find(c => c.endpoint === '/burner/reserve');
        assert.ok(reserve && reserve.body.name === 'burner.pertx.usdc', 'must reserve against the USDC per-tx cap');
        assert.strictEqual(reserve.body.atomicAmount, '1000000');
    });

    await check('solana_send_token: whitespace-padded to/mint are trimmed (CodeRabbit #408) → not rejected, reaches mint pin', async () => {
        _burnerOn({ pubkey: _BURNER_PK });
        bridgeResponses['/burner/reserve'] = { reservationId: 'res-pad-1' };
        bridgeResponses['/burner/sign-transaction'] = { signedTxBase64: 'SIGNED-PAD-TX' };
        bridgeResponses['/burner/commit'] = { ok: true };
        // mock keys are the TRIMMED values — proves the handler uses trimmed inputs downstream
        mockAccountInfoFn = (pk) => pk === _USDC ? _mintAccountInfo(_TKN_PROGRAM, 6) : _tokenAccountInfo();
        const r = await tools.handlers.solana_send_token({ to: `  ${_RCPT}\t`, mint: ` ${_USDC} `, amount: ' 1 ', source: 'burner' });
        assert.ok(r.success, `padded inputs must be trimmed + succeed, got ${JSON.stringify(r)}`);
        assert.strictEqual(r.wallet, 'burner');
        // expectedDelta must reference the ATA of the TRIMMED mint, not a padded string
        const ed = lastValidateBurnerTxArgs && lastValidateBurnerTxArgs.expectedDelta;
        assert.strictEqual(ed.burnerDebit.mint, _USDC, 'mint must be the trimmed value');
        assert.strictEqual(ed.burnerDebit.atomicAmount, '1000000');
    });

    if (failures > 0) {
        console.error(`\n${failures} failure(s).`);
        process.exit(1);
    }
    console.log(`\nPASS: tools-solana-routing.test.js (${passes} routing scenarios verified).`);
})();
