#!/usr/bin/env node
// dca-bigint-precision.test.js — BAT-582 R7 regression test.
//
// PURPOSE
// -------
// Verifies that the DCA total-deposit math paths preserve BigInt precision
// for `totalCycles` digit strings beyond Number.MAX_SAFE_INTEGER (2^53 - 1
// = 9_007_199_254_740_991).
//
// HISTORY
// -------
// R3 added support for numeric-string `totalCycles` like "10" — but used
// `parseInt(s, 10)` to convert before re-coercing to BigInt, which silently
// truncates digit strings above 2^53-1. For monetary cap math the loss is
// quiet AND wrong: the cap-product (perCycle × cycles) gets a corrupted
// cycle count that under- or over-charges burner caps without any error.
//
// R7 fixes both call sites (tools/index.js _formatDcaTotalDeposit and
// caps/preflight.js _principalForTool) to convert digit strings directly
// to BigInt — no Number round-trip on the agent-controlled string path.
//
// CONTRACT PINNED
// ---------------
//   1. _formatDcaTotalDeposit("0.000001", "9007199254740993", "USDC")
//      must produce a decimal display whose tail reflects 9007199254740993,
//      NOT 9007199254740992 (the Number-rounded value).
//
//   2. _principalForTool('jupiter_dca_create', { ..., totalCycles: "<huge>" })
//      must return principalAtomic === BigInt(<huge>), not the Number-truncated
//      value.
//
// Both call sites share the same risk; this test covers both as a
// same-class sweep so a future regression on either path is caught.

'use strict';

const assert = require('assert');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

// ── Minimal mocks so tools/index.js can load without bringing up the full
//    Node bundle (channel, telegram, system tools, etc.). Only the BigInt
//    math paths are exercised; nothing here makes a real bridge call.

const configPath = require.resolve(path.join(BUNDLE, 'config.js'));
require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: {
        BRIDGE_TOKEN: 't',
        CHANNEL: 'telegram',
        log: () => {},
        config: { jupiterApiKey: 'fixture-jupiter-key' },
        workDir: '/tmp/fixture',
    },
};

const bridgePath = require.resolve(path.join(BUNDLE, 'bridge.js'));
require.cache[bridgePath] = {
    id: bridgePath,
    filename: bridgePath,
    loaded: true,
    exports: { androidBridgeCall: async () => ({}) },
};

const { _formatDcaTotalDeposit } = require(path.join(BUNDLE, 'tools', 'index.js'));
const { _principalForTool } = require(path.join(BUNDLE, 'caps', 'preflight'));

let failures = 0;
function check(label, fn) {
    try { fn(); console.log(`  ✓ ${label}`); }
    catch (e) { failures++; console.error(`  ✗ ${label}\n    ${e.stack || e.message}`); }
}

// 2^53 - 1 = 9_007_199_254_740_991 (Number.MAX_SAFE_INTEGER)
// 2^53 + 1 = 9_007_199_254_740_993 — first odd integer Number cannot represent
//            exactly; Number rounds to 9_007_199_254_740_992 (nearest even).
const HUGE_CYCLES = '9007199254740993';
const NUMBER_TRUNC = '9007199254740992'; // what parseInt → BigInt would produce

console.log('── _formatDcaTotalDeposit (tools/index.js) ────────────────────');

check('preserves digit string above MAX_SAFE_INTEGER (USDC)', () => {
    // amountPerCycle = "0.000001" USDC = 1 microunit (atomic).
    // totalDeposit atomic = 1 × 9007199254740993 = 9007199254740993 microunits.
    // Formatted with USDC's 6 decimals → "9007199254.740993".
    // If parseInt truncates: "9007199254.740992" — distinct, test fails.
    const out = _formatDcaTotalDeposit('0.000001', HUGE_CYCLES, 'USDC');
    assert.strictEqual(
        out,
        '9007199254.740993',
        `expected "9007199254.740993" (BigInt-preserved); got "${out}" — Number precision loss?`,
    );
});

check('Number-rounded value would be visibly different (sanity)', () => {
    // Confirms the test discriminates: feeding the Number-rounded string
    // produces a different output, so the assertion above is non-trivial.
    const out = _formatDcaTotalDeposit('0.000001', NUMBER_TRUNC, 'USDC');
    assert.strictEqual(out, '9007199254.740992');
});

check('still handles small numeric strings (R3 regression)', () => {
    // 0.5 USDC × 10 cycles = 5 USDC.
    const out = _formatDcaTotalDeposit('0.5', '10', 'USDC');
    assert.strictEqual(out, '5');
});

check('still handles Number cycles (existing path)', () => {
    // 1 USDC × 30 cycles = 30 USDC.
    const out = _formatDcaTotalDeposit('1', 30, 'USDC');
    assert.strictEqual(out, '30');
});

check('rejects non-digit strings (falls through to 30 default)', () => {
    // "abc" → 30-cycle default. 1 × 30 = 30.
    const out = _formatDcaTotalDeposit('1', 'abc', 'USDC');
    assert.strictEqual(out, '30');
});

console.log('── _principalForTool (caps/preflight.js) ──────────────────────');

check('preserves digit string above MAX_SAFE_INTEGER (USDC)', () => {
    // amountPerCycle = "0.000001" USDC = 1 microunit. cycles = HUGE.
    // total = 1n × 9007199254740993n = 9007199254740993n.
    const p = _principalForTool('jupiter_dca_create', {
        inputToken: 'USDC',
        outputToken: 'SOL',
        amountPerCycle: '0.000001',
        totalCycles: HUGE_CYCLES,
    });
    assert.strictEqual(
        p.principalAtomic,
        9007199254740993n,
        `expected 9007199254740993n (BigInt-preserved); got ${p.principalAtomic} — Number truncation?`,
    );
});

check('Number-rounded value differs (sanity)', () => {
    const p = _principalForTool('jupiter_dca_create', {
        inputToken: 'USDC',
        outputToken: 'SOL',
        amountPerCycle: '0.000001',
        totalCycles: NUMBER_TRUNC,
    });
    assert.strictEqual(p.principalAtomic, 9007199254740992n);
});

check('still respects R3 contract (small numeric strings)', () => {
    // 0.5 USDC × 10 cycles = 5_000_000n microunits.
    const p = _principalForTool('jupiter_dca_create', {
        inputToken: 'USDC',
        outputToken: 'SOL',
        amountPerCycle: '0.5',
        totalCycles: '10',
    });
    assert.strictEqual(p.principalAtomic, 5000000n);
});

check('still respects 30-cycle default (no totalCycles)', () => {
    const p = _principalForTool('jupiter_dca_create', {
        inputToken: 'USDC',
        outputToken: 'SOL',
        amountPerCycle: '1',
    });
    assert.strictEqual(p.principalAtomic, 30000000n);
});

check('rejects non-positive numeric string (falls through to default)', () => {
    const p = _principalForTool('jupiter_dca_create', {
        inputToken: 'USDC',
        outputToken: 'SOL',
        amountPerCycle: '1',
        totalCycles: '0',
    });
    assert.strictEqual(p.principalAtomic, 30000000n);
});

if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exit(1);
}
console.log('\nAll BAT-582 R7 BigInt-precision tests passed.');
