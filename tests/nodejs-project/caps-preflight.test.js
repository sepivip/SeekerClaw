#!/usr/bin/env node
// caps-preflight.test.js — BAT-582 Phase 4.
//
// Tests caps/preflight.js's wouldReserve and routeFor against a mocked
// bridge. routeFor is the routing decision matrix used by getWalletState.

'use strict';

const assert = require('assert');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

// Mock config.js for bridge.js dependency.
const configPath = require.resolve(path.join(BUNDLE, 'config.js'));
require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: { BRIDGE_TOKEN: 't', log: () => {} },
};

// Programmable bridge mock — tests overwrite `_burnerStatus` per case.
// `_bridgeCallCount` lets the BAT-582 R3 statusOverride test count how many
// /burner/status round-trips routeFor issues with vs. without an override.
const bridgePath = require.resolve(path.join(BUNDLE, 'bridge.js'));
let _burnerStatus = { configured: false };
let _bridgeCallCount = 0;
require.cache[bridgePath] = {
    id: bridgePath,
    filename: bridgePath,
    loaded: true,
    exports: {
        androidBridgeCall: async (endpoint /* , body */) => {
            if (endpoint === '/burner/status') {
                _bridgeCallCount++;
                return _burnerStatus;
            }
            return {};
        },
    },
};

const { wouldReserve, routeFor, _principalForTool, _decimalToAtomic } = require(
    path.join(BUNDLE, 'caps', 'preflight')
);

let failures = 0;
async function check(label, fn) {
    try { await fn(); console.log(`  ✓ ${label}`); }
    catch (e) { failures++; console.error(`  ✗ ${label}\n    ${e.stack || e.message}`); }
}

(async () => {
    // ── _decimalToAtomic — BigInt math sanity ────────────────────────────────
    await check('_decimalToAtomic SOL: 0.05 → 50_000_000n', () => {
        assert.strictEqual(_decimalToAtomic('0.05', 9), 50000000n);
    });
    await check('_decimalToAtomic USDC: 1 → 1_000_000n', () => {
        assert.strictEqual(_decimalToAtomic('1', 6), 1000000n);
    });
    await check('_decimalToAtomic rejects negatives + scientific notation', () => {
        assert.strictEqual(_decimalToAtomic('-1', 9), null);
        assert.strictEqual(_decimalToAtomic('1e9', 9), null);
        assert.strictEqual(_decimalToAtomic('abc', 9), null);
    });
    await check('_decimalToAtomic rejects too many fractional digits', () => {
        assert.strictEqual(_decimalToAtomic('0.0000000001', 9), null); // 10 fractional digits, > 9
    });

    // ── _principalForTool — per-tool atomic principal ────────────────────────
    await check('_principalForTool: solana_send SOL', () => {
        const p = _principalForTool('solana_send', { to: 'X', amount: '0.1' });
        assert.strictEqual(p.capName, 'burner.pertx.sol');
        assert.strictEqual(p.dailyCapName, 'burner.daily.sol');
        assert.strictEqual(p.principalAtomic, 100000000n); // 0.1 SOL = 100_000_000 lamports
    });
    await check('_principalForTool: solana_send USDC', () => {
        const p = _principalForTool('solana_send', { to: 'X', amount: '5', token: 'USDC' });
        assert.strictEqual(p.capName, 'burner.pertx.usdc');
        assert.strictEqual(p.principalAtomic, 5000000n);
    });
    await check('_principalForTool: solana_send BONK → null (uncapped V1)', () => {
        const p = _principalForTool('solana_send', { to: 'X', amount: '1', token: 'BONK' });
        assert.strictEqual(p, null);
    });
    await check('_principalForTool: solana_swap SOL → USDC', () => {
        const p = _principalForTool('solana_swap', { inputToken: 'SOL', outputToken: 'USDC', amount: '0.05' });
        assert.strictEqual(p.capName, 'burner.pertx.sol');
        assert.strictEqual(p.principalAtomic, 50000000n);
    });
    await check('_principalForTool: jupiter_dca_create — total = perCycle × cycles', () => {
        const p = _principalForTool('jupiter_dca_create', {
            inputToken: 'USDC', outputToken: 'SOL',
            amountPerCycle: '1', totalCycles: 10,
        });
        assert.strictEqual(p.capName, 'burner.pertx.usdc');
        assert.strictEqual(p.principalAtomic, 10000000n); // 1 × 10 USDC
    });
    await check('_principalForTool: jupiter_dca_create defaults to 30 cycles', () => {
        const p = _principalForTool('jupiter_dca_create', {
            inputToken: 'USDC', outputToken: 'SOL',
            amountPerCycle: '1',
        });
        assert.strictEqual(p.principalAtomic, 30000000n); // 1 × 30 USDC
    });
    // BAT-582 R3: same-class sweep — agent-emitted JSON often passes numeric
    // fields as strings. Without normalization, `typeof '10' !== 'number'`
    // silently fell through to the 30-cycle default, under-reporting the
    // committed principal in cap math. Regression contract: numeric strings
    // must be honored for the totalCycles field.
    await check('_principalForTool: jupiter_dca_create accepts numeric-string totalCycles="10"', () => {
        const p = _principalForTool('jupiter_dca_create', {
            inputToken: 'USDC', outputToken: 'SOL',
            amountPerCycle: '0.5', totalCycles: '10',
        });
        // 0.5 USDC × 10 cycles = 5 USDC = 5_000_000 microunits.
        // Pre-fix this returned 0.5 × 30 = 15_000_000 (the wrong default).
        assert.strictEqual(p.principalAtomic, 5000000n,
            `expected 5_000_000n (10 cycles); got ${p.principalAtomic} — fell through to 30-cycle default?`);
    });
    await check('_principalForTool: jupiter_dca_create rejects non-positive numeric strings', () => {
        // "0" and "-5" should fall through to the 30-cycle default (treated as garbage).
        const pZero = _principalForTool('jupiter_dca_create', {
            inputToken: 'USDC', amountPerCycle: '1', totalCycles: '0',
        });
        assert.strictEqual(pZero.principalAtomic, 30000000n);
        const pNeg = _principalForTool('jupiter_dca_create', {
            inputToken: 'USDC', amountPerCycle: '1', totalCycles: '-5',
        });
        assert.strictEqual(pNeg.principalAtomic, 30000000n);
        // "abc" / "1.5" / "" are also rejected (default to 30).
        const pBad = _principalForTool('jupiter_dca_create', {
            inputToken: 'USDC', amountPerCycle: '1', totalCycles: 'abc',
        });
        assert.strictEqual(pBad.principalAtomic, 30000000n);
    });
    await check('_principalForTool: jupiter_trigger_create', () => {
        const p = _principalForTool('jupiter_trigger_create', {
            inputToken: 'SOL', outputToken: 'USDC', inputAmount: '0.05', triggerPrice: 100,
        });
        assert.strictEqual(p.principalAtomic, 50000000n);
    });
    await check('_principalForTool: cancel tools → null', () => {
        assert.strictEqual(_principalForTool('jupiter_trigger_cancel', { orderId: 'X' }), null);
        assert.strictEqual(_principalForTool('jupiter_dca_cancel', { orderId: 'X' }), null);
    });

    // ── wouldReserve — reads bridge ────────────────────────────────────────
    await check('wouldReserve: burner_not_configured when status.configured=false', async () => {
        _burnerStatus = { configured: false };
        const r = await wouldReserve('burner.pertx.sol', '1');
        assert.strictEqual(r.wouldAllow, false);
        assert.strictEqual(r.reason, 'burner_not_configured');
    });
    await check('wouldReserve: under cap → wouldAllow=true', async () => {
        _burnerStatus = {
            configured: true,
            capPerTxSol: '50000000',
            capDailySol: '200000000',
            spentTodaySol: '0',
        };
        const r = await wouldReserve('burner.pertx.sol', '40000000');
        assert.strictEqual(r.wouldAllow, true);
    });
    await check('wouldReserve: over per-tx cap → over_per_tx_or_window_cap', async () => {
        const r = await wouldReserve('burner.pertx.sol', '60000000');
        assert.strictEqual(r.wouldAllow, false);
        assert.strictEqual(r.reason, 'over_per_tx_or_window_cap');
    });
    await check('wouldReserve: daily cap exceeded by spend + amt', async () => {
        _burnerStatus.spentTodaySol = '180000000';
        const r = await wouldReserve('burner.daily.sol', '40000000'); // 180+40 = 220 > 200 cap
        assert.strictEqual(r.wouldAllow, false);
        assert.strictEqual(r.reason, 'window_cap_would_be_exceeded');
    });

    // ── routeFor — routing decision matrix ───────────────────────────────
    await check('routeFor: burner not configured → routing=main, underCap=true', async () => {
        _burnerStatus = { configured: false };
        const r = await routeFor('solana_send', { to: 'X', amount: '0.001' });
        assert.strictEqual(r.routingDecision, 'main');
        assert.strictEqual(r.underCap, true);
    });

    await check('routeFor: burner under cap → routing=burner, underCap=true', async () => {
        _burnerStatus = {
            configured: true,
            capPerTxSol: '50000000',
            capDailySol: '200000000',
            capPerTxUsdc: '0',
            capDailyUsdc: '0',
            spentTodaySol: '0',
            spentTodayUsdc: '0',
        };
        const r = await routeFor('solana_send', { to: 'X', amount: '0.001' });
        assert.strictEqual(r.routingDecision, 'burner');
        assert.strictEqual(r.underCap, true);
        assert.strictEqual(r.capName, 'burner.pertx.sol');
    });

    await check('routeFor: burner over cap → routing=burner, underCap=false', async () => {
        const r = await routeFor('solana_send', { to: 'X', amount: '1' }); // 1 SOL = 1e9 > 5e7 cap
        assert.strictEqual(r.routingDecision, 'burner');
        assert.strictEqual(r.underCap, false);
        assert.strictEqual(r.reason, 'over_per_tx_or_window_cap');
    });

    await check('routeFor: uncapped principal (BONK) → routing=main, underCap=true', async () => {
        const r = await routeFor('solana_send', { to: 'X', amount: '1', token: 'BONK' });
        assert.strictEqual(r.routingDecision, 'main');
        assert.strictEqual(r.underCap, true);
        assert.strictEqual(r.principalAtomic, null);
    });

    await check('routeFor: USDC under cap', async () => {
        _burnerStatus = {
            configured: true,
            capPerTxSol: '0',
            capDailySol: '0',
            capPerTxUsdc: '5000000',  // 5 USDC
            capDailyUsdc: '20000000', // 20 USDC
            spentTodaySol: '0',
            spentTodayUsdc: '0',
        };
        const r = await routeFor('solana_send', { to: 'X', amount: '1', token: 'USDC' });
        assert.strictEqual(r.routingDecision, 'burner');
        assert.strictEqual(r.underCap, true);
    });

    await check('routeFor: cancel tool → routing=main, underCap=true (no capped principal)', async () => {
        const r = await routeFor('jupiter_trigger_cancel', { orderId: 'abc' });
        assert.strictEqual(r.routingDecision, 'main');
        assert.strictEqual(r.principalAtomic, null);
    });

    // BAT-582 R3: hot-path optimization. routeFor (and wouldReserve) accept a
    // `statusOverride` argument that bypasses the /burner/status bridge call.
    // getWalletState fetches /burner/status ONCE per dispatch and threads the
    // result down — avoiding 2 redundant round-trips on every Solana write
    // tool. This is a contract test: the bridge call count must drop to 0
    // when an override is supplied (vs. 2 without — per-tx + daily checks).
    await check('routeFor: statusOverride bypasses bridge fetch (saves 2 round-trips)', async () => {
        _burnerStatus = {
            configured: true,
            capPerTxSol: '50000000',
            capDailySol: '200000000',
            capPerTxUsdc: '0',
            capDailyUsdc: '0',
            spentTodaySol: '0',
            spentTodayUsdc: '0',
        };

        // Baseline — no override; routeFor should hit the bridge twice
        // (per-tx + daily). This pins the pre-fix call count so a future
        // refactor that accidentally adds extra fetches gets caught.
        _bridgeCallCount = 0;
        const noOverride = await routeFor('solana_send', { to: 'X', amount: '0.001' });
        assert.strictEqual(noOverride.routingDecision, 'burner');
        assert.strictEqual(_bridgeCallCount, 2,
            `expected 2 bridge fetches without override; got ${_bridgeCallCount}`);

        // With override — same status payload, but routeFor should make
        // ZERO bridge calls because both wouldReserve invocations reuse the
        // override.
        _bridgeCallCount = 0;
        const withOverride = await routeFor('solana_send', { to: 'X', amount: '0.001' }, _burnerStatus);
        assert.strictEqual(withOverride.routingDecision, 'burner');
        assert.strictEqual(withOverride.underCap, true);
        assert.strictEqual(_bridgeCallCount, 0,
            `expected 0 bridge fetches with statusOverride; got ${_bridgeCallCount}`);
    });

    await check('wouldReserve: statusOverride supports zero-amount path (cancels)', async () => {
        // Cancels go through wouldReserve with amount=0 — verify the override
        // works on the zero path too (otherwise getWalletState's hot-path
        // optimization would silently miss the cancel branch).
        _bridgeCallCount = 0;
        const r = await wouldReserve('burner.pertx.sol', '0', { configured: true });
        assert.strictEqual(r.wouldAllow, true);
        assert.strictEqual(_bridgeCallCount, 0);
    });

    await check('wouldReserve: null statusOverride → bridge_unreachable (matches live failure)', async () => {
        // Defensive contract: passing null/error status (as wallet/index.js
        // does when the live fetch fails) must produce the same response as
        // a failed live fetch — not a successful proceed.
        _bridgeCallCount = 0;
        const r = await wouldReserve('burner.pertx.sol', '1000', null);
        assert.strictEqual(r.wouldAllow, false);
        assert.strictEqual(r.reason, 'bridge_unreachable');
        assert.strictEqual(_bridgeCallCount, 0);
    });

    if (failures > 0) {
        console.error(`\n${failures} failure(s).`);
        process.exit(1);
    }
    console.log('\nPASS: caps-preflight.test.js');
})();
