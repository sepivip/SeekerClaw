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
function check(label, fn) {
    try { fn(); console.log(`  ✓ ${label}`); }
    catch (e) { failures++; console.error(`  ✗ ${label}\n    ${e.message}`); }
}

_resetForTests();

check("getWallet('burner') returns a wallet with role 'burner' and BurnerSigner", () => {
    const w = getWallet('burner');
    assert.ok(w, 'should not be null');
    assert.strictEqual(w.role(), 'burner');
    assert.ok(w.signer() instanceof BurnerSigner, 'signer must be BurnerSigner');
});

check("getWallet('main') returns a wallet with role 'main' and MwaSigner", () => {
    const w = getWallet('main');
    assert.ok(w, 'should not be null');
    assert.strictEqual(w.role(), 'main');
    assert.ok(w.signer() instanceof MwaSigner, 'signer must be MwaSigner');
});

check("getWallet returns the same instance on repeated calls (singleton)", () => {
    const a = getWallet('burner');
    const b = getWallet('burner');
    assert.strictEqual(a, b);
});

check("getWallet returns null for unknown roles", () => {
    assert.strictEqual(getWallet('nonsense'), null);
    assert.strictEqual(getWallet(''), null);
    assert.strictEqual(getWallet(null), null);
    assert.strictEqual(getWallet(undefined), null);
});

check("getWalletState returns burnerConfigured=false when bridge returns empty", async () => {
    const s = await getWalletState('memory_save', {});
    assert.strictEqual(s.burnerConfigured, false);
});

check("getWalletState routes Solana write tools through routeFor (uncapped → main, underCap=true)", async () => {
    // BONK send isn't in (SOL, USDC) so principal=null → routing='main', underCap=true.
    const s = await getWalletState('solana_send', { to: 'X', amount: '1', token: 'BONK' });
    assert.strictEqual(s.routingDecision, 'main');
    assert.strictEqual(s.underCap, true);
});

check("getWalletState looks up Jupiter cancel ownership", async () => {
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

check("getWalletState handles missing orderId on cancel (creatorRole='unknown')", async () => {
    const s = await getWalletState('jupiter_dca_cancel', {});
    assert.strictEqual(s.creatorRole, 'unknown');
});

if (failures > 0) {
    console.error(`\n${failures} failure(s).`);
    process.exit(1);
}
console.log('\nPASS: wallet-registry.test.js');
