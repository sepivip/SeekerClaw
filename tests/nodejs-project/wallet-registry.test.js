#!/usr/bin/env node
// wallet-registry.test.js — BAT-582 Phase 4.
//
// Tests the wallet registry's basic shape: getWallet('burner') returns a
// BurnerWallet whose signer is a BurnerSigner; getWallet('main') returns a
// MainWallet whose signer is an MwaSigner; unknown roles return null.
//
// We mock bridge.js + config.js so we don't need a workDir or live Android.

'use strict';

const assert = require('assert');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

// Inject a fake config.js into the require cache (bridge.js requires it).
const configPath = require.resolve(path.join(BUNDLE, 'config.js'));
require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: {
        BRIDGE_TOKEN: 'test-token',
        log: () => {},
    },
};

// Inject a fake bridge.js so the wallet modules don't actually hit localhost.
const bridgePath = require.resolve(path.join(BUNDLE, 'bridge.js'));
const bridgeCalls = [];
require.cache[bridgePath] = {
    id: bridgePath,
    filename: bridgePath,
    loaded: true,
    exports: {
        androidBridgeCall: async (endpoint, body) => {
            bridgeCalls.push({ endpoint, body });
            return {}; // safe default — unconfigured/empty
        },
    },
};

// Stub solana.js so MainWallet's lazy require doesn't pull in the real one
// (which transitively requires the real config.js).
const solanaPath = require.resolve(path.join(BUNDLE, 'solana.js'));
require.cache[solanaPath] = {
    id: solanaPath,
    filename: solanaPath,
    loaded: true,
    exports: {
        getConnectedWalletAddress: () => { throw new Error('not connected'); },
        solanaRpc: async () => ({ error: 'mocked' }),
    },
};

const { getWallet, getWalletState, _resetForTests } = require(path.join(BUNDLE, 'wallet'));
const { BurnerSigner } = require(path.join(BUNDLE, 'wallet', 'burner-signer'));
const { MwaSigner } = require(path.join(BUNDLE, 'wallet', 'mwa-signer'));

let failures = 0;
// Async test runner — fn may be sync or async. Awaits the returned
// promise so async assertion failures surface as ✗ instead of unhandled
// rejections (which Node logs but doesn't fail the process for).
async function check(label, fn) {
    try { await fn(); console.log(`  ✓ ${label}`); }
    catch (e) { failures++; console.error(`  ✗ ${label}\n    ${e.message}`); }
}

(async () => {
    _resetForTests();

    await check("getWallet('burner') returns a wallet with role 'burner' and BurnerSigner", () => {
        const w = getWallet('burner');
        assert.ok(w, 'should not be null');
        assert.strictEqual(w.role(), 'burner');
        assert.ok(w.signer() instanceof BurnerSigner, 'signer must be BurnerSigner');
    });

    await check("getWallet('main') returns a wallet with role 'main' and MwaSigner", () => {
        const w = getWallet('main');
        assert.ok(w, 'should not be null');
        assert.strictEqual(w.role(), 'main');
        assert.ok(w.signer() instanceof MwaSigner, 'signer must be MwaSigner');
    });

    await check("getWallet returns the same instance on repeated calls (singleton)", () => {
        const a = getWallet('burner');
        const b = getWallet('burner');
        assert.strictEqual(a, b);
    });

    await check("getWallet returns null for unknown roles", () => {
        assert.strictEqual(getWallet('nonsense'), null);
        assert.strictEqual(getWallet(''), null);
        assert.strictEqual(getWallet(null), null);
        assert.strictEqual(getWallet(undefined), null);
    });

    await check("getWalletState returns burnerConfigured=false when bridge returns empty", async () => {
        const s = await getWalletState('memory_save', {});
        assert.strictEqual(s.burnerConfigured, false);
    });

    await check("getWalletState routes Solana write tools through routeFor (uncapped → main, underCap=true)", async () => {
        // BONK send isn't in (SOL, USDC) so principal=null → routing='main', underCap=true.
        const s = await getWalletState('solana_send', { to: 'X', amount: '1', token: 'BONK' });
        assert.strictEqual(s.routingDecision, 'main');
        assert.strictEqual(s.underCap, true);
    });

    await check("getWalletState looks up Jupiter cancel ownership", async () => {
        bridgeCalls.length = 0;
        const s = await getWalletState('jupiter_trigger_cancel', { orderId: 'order-abc' });
        // creatorRole defaults to 'unknown' when bridge returns empty {}
        assert.ok(['burner', 'main', 'unknown'].includes(s.creatorRole), `bad creatorRole: ${s.creatorRole}`);
        assert.strictEqual(s.creatorRole, 'unknown'); // empty bridge response → unknown
        // Bridge was called for the lookup
        const ownerCall = bridgeCalls.find(c => c.endpoint === '/jupiter/order-owner/get');
        assert.ok(ownerCall, 'expected /jupiter/order-owner/get bridge call');
        assert.strictEqual(ownerCall.body.orderId, 'order-abc');
    });

    await check("getWalletState handles missing orderId on cancel (creatorRole='unknown')", async () => {
        const s = await getWalletState('jupiter_dca_cancel', {});
        assert.strictEqual(s.creatorRole, 'unknown');
    });

    // BAT-582 R3: /burner/status is fetched ONCE per dispatch. Pre-fix,
    // getWalletState fetched once for state hydration, then routeFor()
    // fetched it AGAIN inside both wouldReserve calls — 3 round-trips per
    // Solana write tool. The fix threads the cached status into routeFor.
    // Contract: at most ONE /burner/status call regardless of routing branch.
    await check('getWalletState dispatches /burner/status exactly once for solana_send', async () => {
        bridgeCalls.length = 0;
        await getWalletState('solana_send', { to: 'X', amount: '0.001' });
        const statusCalls = bridgeCalls.filter(c => c.endpoint === '/burner/status');
        assert.strictEqual(statusCalls.length, 1,
            `expected exactly 1 /burner/status fetch; got ${statusCalls.length}`);
    });

    // BAT-582 R5: Jupiter cancel tools' confirmation policy reads
    // walletState.creatorRole (populated via /jupiter/order-owner/get) and
    // ignores burnerConfigured / burnerCaps / burnerSpentToday. Pre-fix,
    // getWalletState ALSO fetched /burner/status for cancels — a wasted
    // bridge round-trip on every cancel call. The fix branches: cancels
    // skip /burner/status entirely.
    await check('R5: getWalletState skips /burner/status for jupiter_trigger_cancel', async () => {
        bridgeCalls.length = 0;
        const s = await getWalletState('jupiter_trigger_cancel', { orderId: 'order-abc' });
        const statusCalls = bridgeCalls.filter(c => c.endpoint === '/burner/status');
        const ownerCalls = bridgeCalls.filter(c => c.endpoint === '/jupiter/order-owner/get');
        assert.strictEqual(statusCalls.length, 0,
            `cancels must NOT fetch /burner/status (got ${statusCalls.length} calls)`);
        assert.strictEqual(ownerCalls.length, 1,
            `cancels must fetch /jupiter/order-owner/get exactly once (got ${ownerCalls.length})`);
        // Sanity: state shape is correct
        assert.strictEqual(s.burnerConfigured, false, 'creatorRole-only path leaves burnerConfigured=false');
        assert.ok(['burner', 'main', 'unknown'].includes(s.creatorRole));
    });

    await check('R5: getWalletState skips /burner/status for jupiter_dca_cancel', async () => {
        bridgeCalls.length = 0;
        await getWalletState('jupiter_dca_cancel', { orderId: 'order-xyz' });
        const statusCalls = bridgeCalls.filter(c => c.endpoint === '/burner/status');
        assert.strictEqual(statusCalls.length, 0,
            `dca cancels must NOT fetch /burner/status (got ${statusCalls.length})`);
    });

    await check('R5: cancel without orderId — no bridge calls at all', async () => {
        bridgeCalls.length = 0;
        const s = await getWalletState('jupiter_trigger_cancel', {});
        // No orderId → no /jupiter/order-owner/get either; creatorRole=unknown.
        assert.strictEqual(bridgeCalls.length, 0,
            `cancel without orderId should make 0 bridge calls (got ${bridgeCalls.length})`);
        assert.strictEqual(s.creatorRole, 'unknown');
    });

    // BAT-582 R9: agent_pay's confirmation policy reads only args.max_usdc
    // (block-or-none gate) and never reads burner state. The agent_pay
    // handler ALSO does its own /burner/status fetch internally to refuse
    // fast when unconfigured (before any outbound HTTP). Pre-fix, the gate
    // ALSO fetched /burner/status — a wasted bridge round-trip on every
    // agent_pay dispatch. The fix removes agent_pay from the gate set.
    await check('R9: getWalletState skips /burner/status for agent_pay', async () => {
        bridgeCalls.length = 0;
        const s = await getWalletState('agent_pay', { max_usdc: '0.10', url: 'https://example.com' });
        const statusCalls = bridgeCalls.filter(c => c.endpoint === '/burner/status');
        assert.strictEqual(statusCalls.length, 0,
            `agent_pay must NOT fetch /burner/status from the gate (got ${statusCalls.length} calls)`);
        // Sanity: state shape is the empty short-circuit shape — handler
        // populates everything it needs on its own.
        assert.strictEqual(s.burnerConfigured, false,
            'short-circuit path leaves burnerConfigured=false (handler does its own fetch)');
        assert.strictEqual(bridgeCalls.length, 0,
            `agent_pay gate should make 0 bridge calls (got ${bridgeCalls.length})`);
    });

    // BAT-582 R9: wallet_status's confirmation policy returns the literal
    // 'none' regardless of state — pre-fix, the gate fetched /burner/status
    // anyway (the handler does its own fetch to populate the response).
    // Wasted round-trip removed.
    await check('R9: getWalletState skips /burner/status for wallet_status', async () => {
        bridgeCalls.length = 0;
        const s = await getWalletState('wallet_status', {});
        const statusCalls = bridgeCalls.filter(c => c.endpoint === '/burner/status');
        assert.strictEqual(statusCalls.length, 0,
            `wallet_status must NOT fetch /burner/status from the gate (got ${statusCalls.length} calls)`);
        assert.strictEqual(s.burnerConfigured, false);
    });

    if (failures > 0) {
        console.error(`\n${failures} failure(s).`);
        process.exit(1);
    }
    console.log('\nPASS: wallet-registry.test.js');
})().catch((e) => {
    console.error('Unhandled error in test runner:', e);
    process.exit(1);
});
