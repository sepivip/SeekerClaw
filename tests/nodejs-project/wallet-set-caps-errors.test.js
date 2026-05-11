#!/usr/bin/env node
// wallet-set-caps-errors.test.js — BAT-582 R9.
//
// Pins the failure-shape contract for the wallet_set_caps tool. The tool's
// description promises `{ error: <code>, reason: <message> }` for every
// failure path, with three stable codes the agent can pattern-match on:
//
//   - "missing_fields"  — no cap fields provided
//   - "invalid_decimal" — one or more cap values failed decimal parsing
//   - "bridge_failure"  — /config/burner-caps bridge call failed
//
// Pre-fix (R8), failures returned `{ error: <human message string> }` only,
// so the agent had to substring-match to recover. The R9 fix normalizes
// every failure to the structured shape; this test fails the build if a
// future change reverts to plain-string errors.

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
    exports: { BRIDGE_TOKEN: 't', log: () => {} },
};

// ── Mock bridge.js — driver controls the next response ──────────────────────
// State the test driver sets BEFORE each scenario:
//   - bridgeMode === 'response': mock returns bridgeResponse (default {})
//   - bridgeMode === 'unreachable': mock returns null verbatim (no body)
// Each call resets to the default after firing.
let bridgeMode = 'response';
let bridgeResponse = {};
const bridgeCalls = [];
const bridgePath = require.resolve(path.join(BUNDLE, 'bridge.js'));
require.cache[bridgePath] = {
    id: bridgePath,
    filename: bridgePath,
    loaded: true,
    exports: {
        androidBridgeCall: async (endpoint, body) => {
            bridgeCalls.push({ endpoint, body });
            const mode = bridgeMode;
            const resp = bridgeResponse;
            // Reset to "next call returns success-shaped {}" unless the
            // test driver re-arms before the next call.
            bridgeMode = 'response';
            bridgeResponse = {};
            if (mode === 'unreachable') return null;
            return resp;
        },
    },
};

// ── Stub solana.js so getWallet('main') doesn't pull in the real one ────────
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

const walletTools = require(path.join(BUNDLE, 'tools', 'wallet'));
const setCaps = walletTools.handlers.wallet_set_caps;

let failures = 0;
async function check(label, fn) {
    try { await fn(); console.log(`  ✓ ${label}`); }
    catch (e) { failures++; console.error(`  ✗ ${label}\n    ${e.stack || e.message}`); }
}

// Helper — assert the canonical {error, reason} shape with the expected code.
function assertStructuredError(r, expectedCode) {
    assert.ok(r && typeof r === 'object',
        `result must be an object, got ${JSON.stringify(r)}`);
    assert.strictEqual(typeof r.error, 'string',
        `error must be a string code, got ${JSON.stringify(r.error)}`);
    assert.strictEqual(r.error, expectedCode,
        `error code must be "${expectedCode}", got "${r.error}"`);
    assert.strictEqual(typeof r.reason, 'string',
        `reason must be a human-readable string message, got ${JSON.stringify(r.reason)}`);
    assert.ok(r.reason.length > 0, 'reason must not be empty');
    // The "ok" key must NOT be set on a failure.
    assert.notStrictEqual(r.ok, true, 'failed result must not have ok=true');
}

(async () => {
    // ── missing_fields ──────────────────────────────────────────────────────
    await check('wallet_set_caps with no fields → {error: "missing_fields", reason: <msg>}', async () => {
        bridgeCalls.length = 0;
        const r = await setCaps({});
        assertStructuredError(r, 'missing_fields');
        assert.strictEqual(bridgeCalls.length, 0,
            'must not call bridge for missing-fields rejection');
    });

    await check('wallet_set_caps with null input → {error: "missing_fields", reason: <msg>}', async () => {
        bridgeCalls.length = 0;
        const r = await setCaps(null);
        assertStructuredError(r, 'missing_fields');
        assert.strictEqual(bridgeCalls.length, 0);
    });

    await check('wallet_set_caps with all fields explicitly null/undefined → "missing_fields"', async () => {
        bridgeCalls.length = 0;
        const r = await setCaps({
            per_tx_sol: null,
            daily_sol: undefined,
            per_tx_usdc: null,
            daily_usdc: null,
        });
        assertStructuredError(r, 'missing_fields');
        assert.strictEqual(bridgeCalls.length, 0);
    });

    // ── invalid_decimal ─────────────────────────────────────────────────────
    await check('wallet_set_caps with garbled decimal → {error: "invalid_decimal", reason: <msg>}', async () => {
        bridgeCalls.length = 0;
        const r = await setCaps({ per_tx_sol: 'not-a-number' });
        assertStructuredError(r, 'invalid_decimal');
        // Reason should mention which arg(s) failed for the agent's correction prompt.
        assert.ok(r.reason.includes('per_tx_sol'),
            `reason should reference the failing arg name, got: ${r.reason}`);
        assert.strictEqual(bridgeCalls.length, 0,
            'must not call bridge when decimal parse fails');
    });

    await check('wallet_set_caps with negative number → {error: "invalid_decimal", reason: <msg>}', async () => {
        bridgeCalls.length = 0;
        // Leading minus is rejected by the decimal regex (matches /^\d+(\.\d+)?$/).
        const r = await setCaps({ daily_usdc: '-1' });
        assertStructuredError(r, 'invalid_decimal');
        assert.strictEqual(bridgeCalls.length, 0);
    });

    await check('wallet_set_caps with too-many fractional digits → "invalid_decimal"', async () => {
        bridgeCalls.length = 0;
        // SOL is 9 decimals, so 10+ digits after the point is rejected.
        const r = await setCaps({ per_tx_sol: '0.1234567890' });
        assertStructuredError(r, 'invalid_decimal');
        assert.strictEqual(bridgeCalls.length, 0);
    });

    await check('wallet_set_caps with multiple invalid fields → reason concatenates', async () => {
        bridgeCalls.length = 0;
        const r = await setCaps({
            per_tx_sol: 'bad',
            daily_usdc: 'also-bad',
        });
        assertStructuredError(r, 'invalid_decimal');
        assert.ok(r.reason.includes('per_tx_sol') && r.reason.includes('daily_usdc'),
            `reason should reference both failing args, got: ${r.reason}`);
    });

    // ── bridge_failure ──────────────────────────────────────────────────────
    await check('wallet_set_caps with bridge error → {error: "bridge_failure", reason: <upstream msg>}', async () => {
        bridgeCalls.length = 0;
        bridgeMode = 'response';
        bridgeResponse = { error: 'config_locked', reason: 'caps file is read-only' };
        const r = await setCaps({ per_tx_sol: '0.05' });
        assertStructuredError(r, 'bridge_failure');
        assert.ok(r.reason.includes('caps file is read-only'),
            `reason should surface upstream message verbatim, got: ${r.reason}`);
        assert.strictEqual(bridgeCalls.length, 1, 'should attempt bridge call exactly once');
        assert.strictEqual(bridgeCalls[0].endpoint, '/config/burner-caps');
    });

    await check('wallet_set_caps with null bridge response → "bridge_failure"', async () => {
        bridgeCalls.length = 0;
        bridgeMode = 'unreachable'; // mock returns null verbatim
        const r = await setCaps({ per_tx_sol: '0.05' });
        assertStructuredError(r, 'bridge_failure');
        assert.strictEqual(r.reason, 'bridge_unreachable',
            `expected reason="bridge_unreachable" for null response, got: ${r.reason}`);
    });

    await check('wallet_set_caps with bridge error string only → "bridge_failure" surfaces error as reason', async () => {
        bridgeCalls.length = 0;
        bridgeMode = 'response';
        bridgeResponse = { error: 'unauthorized' };
        const r = await setCaps({ daily_sol: '1.5' });
        assertStructuredError(r, 'bridge_failure');
        // No upstream `reason` → the upstream `error` becomes the human message.
        assert.strictEqual(r.reason, 'unauthorized');
    });

    // ── happy path still works (sanity) ──────────────────────────────────────
    await check('wallet_set_caps success unchanged: {ok: true, applied: ...}', async () => {
        bridgeCalls.length = 0;
        bridgeMode = 'response';
        bridgeResponse = { ok: true };
        const r = await setCaps({ per_tx_sol: '0.05' });
        assert.strictEqual(r.ok, true);
        assert.deepStrictEqual(r.applied, { capPerTxSol: '50000000' });
        assert.strictEqual(r.error, undefined, 'success path must not have error key');
    });

    if (failures > 0) {
        console.error(`\n${failures} failure(s).`);
        process.exit(1);
    }
    console.log('\nPASS: wallet-set-caps-errors.test.js');
})().catch((e) => {
    console.error('Unhandled error in test runner:', e);
    process.exit(1);
});
