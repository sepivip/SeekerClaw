#!/usr/bin/env node
// burner-cancel-zero-amount.test.js — BAT-582 Phase 5.
//
// Verifies the cancel-with-zero-principal path:
//   1. caps/preflight.js wouldReserve(name, 0n) returns wouldAllow=true when
//      the burner is configured (cancels are ownership-gated, not principal-
//      gated, so they don't consume cap state).
//   2. wouldReserve still rejects negative amounts.
//   3. Zero-amount reserve still verifies the burner is configured —
//      can't sign on an unconfigured burner just because the amount is 0.
//
// This pins the contract decision documented in wallet/dispatch.js's
// signCancelViaBurner: cancels reserve 0, sign-transaction, then release
// (not commit). Daily ledger stays pristine.

'use strict';

const assert = require('assert');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

// Mock config.js
const configPath = require.resolve(path.join(BUNDLE, 'config.js'));
require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: { BRIDGE_TOKEN: 't', log: () => {} },
};

// Mock bridge.js — deterministic /burner/status responses keyed by test setup.
let mockStatus = null;
const bridgePath = require.resolve(path.join(BUNDLE, 'bridge.js'));
require.cache[bridgePath] = {
    id: bridgePath,
    filename: bridgePath,
    loaded: true,
    exports: {
        androidBridgeCall: async (endpoint, _body, _timeoutMs) => {
            if (endpoint === '/burner/status') return mockStatus;
            return {};
        },
    },
};

const { wouldReserve } = require(path.join(BUNDLE, 'caps', 'preflight'));

let failures = 0;
async function check(label, fn) {
    try { await fn(); console.log(`  ✓ ${label}`); }
    catch (e) { failures++; console.error(`  ✗ ${label}\n    ${e.stack || e.message}`); }
}

(async () => {
    // ── Burner configured + zero amount → wouldAllow=true ───────────────────
    await check('wouldReserve(name, 0n) → wouldAllow=true when burner configured', async () => {
        mockStatus = {
            configured: true,
            pubkey: 'BURNER',
            capPerTxSol: '50000000',
            capDailySol: '100000000',
            capPerTxUsdc: '5000000',
            capDailyUsdc: '20000000',
            spentTodaySol: '0',
            spentTodayUsdc: '0',
        };
        const r = await wouldReserve('burner.pertx.sol', 0n);
        assert.strictEqual(r.wouldAllow, true, `expected wouldAllow=true, got ${JSON.stringify(r)}`);
    });

    await check('wouldReserve("burner.daily.sol", "0") (string) → wouldAllow=true when burner configured', async () => {
        const r = await wouldReserve('burner.daily.sol', '0');
        assert.strictEqual(r.wouldAllow, true);
    });

    // ── Zero amount + burner unconfigured → still rejected ──────────────────
    await check('wouldReserve(name, 0n) → wouldAllow=false when burner NOT configured', async () => {
        mockStatus = { configured: false };
        const r = await wouldReserve('burner.pertx.sol', 0n);
        assert.strictEqual(r.wouldAllow, false);
        assert.strictEqual(r.reason, 'burner_not_configured');
    });

    // ── Negative amount → still rejected (not silently allowed) ─────────────
    await check('wouldReserve(name, -1n) → wouldAllow=false (negative_amount)', async () => {
        mockStatus = { configured: true, capPerTxSol: '50000000', capDailySol: '100000000', spentTodaySol: '0' };
        const r = await wouldReserve('burner.pertx.sol', -1n);
        assert.strictEqual(r.wouldAllow, false);
        assert.strictEqual(r.reason, 'negative_amount');
    });

    // ── Bridge unreachable + zero amount → wouldAllow=false ─────────────────
    await check('wouldReserve(name, 0n) → wouldAllow=false when bridge unreachable', async () => {
        mockStatus = null; // bridge returns null/undefined
        const r = await wouldReserve('burner.pertx.sol', 0n);
        assert.strictEqual(r.wouldAllow, false);
        assert.strictEqual(r.reason, 'bridge_unreachable');
    });

    // ── Positive amount path still works (regression — existing tests rely on this) ─
    await check('wouldReserve(name, 100000n) → wouldAllow=true under cap', async () => {
        mockStatus = {
            configured: true,
            capPerTxSol: '50000000',
            capDailySol: '100000000',
            spentTodaySol: '0',
        };
        const r = await wouldReserve('burner.pertx.sol', 100000n);
        assert.strictEqual(r.wouldAllow, true);
    });

    if (failures > 0) {
        console.error(`\n${failures} failure(s).`);
        process.exit(1);
    }
    console.log('\nPASS: burner-cancel-zero-amount.test.js (cancel-with-zero principal path verified).');
})();
