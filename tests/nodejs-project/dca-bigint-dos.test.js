#!/usr/bin/env node
// dca-bigint-dos.test.js — BAT-582 R10 DoS-protection regression test.
//
// PURPOSE
// -------
// Verifies that the model-controlled `totalCycles` and decimal-amount
// paths reject pathologically long digit strings BEFORE invoking BigInt(),
// so a prompt-injected 10MB digit payload can't burn O(n²) CPU and heap
// in V8's arbitrary-precision parser.
//
// HISTORY
// -------
// R7 introduced `BigInt(totalCycles)` on the agent-controlled string
// path of _formatDcaTotalDeposit and _principalForTool to preserve
// precision past Number.MAX_SAFE_INTEGER. The fix was correct for
// precision but unbounded for length — a 1M-character digit string
// would still hit BigInt() and stall the confirmation pipeline.
//
// R10 adds an explicit length gate (≤20 digits for cycle counts,
// ≤40 chars for decimal monetary inputs, ≤30 digits for x402 atomic
// amounts) BEFORE the regex + BigInt() pipeline runs. This test pins
// that contract.
//
// CONTRACT PINNED
// ---------------
//   1. _formatDcaTotalDeposit(_, "<1M digits>", "USDC") must return
//      quickly (≤500 ms) AND fall back to the 30-cycle default rather
//      than attempting to BigInt-parse the megastring.
//
//   2. _principalForTool('jupiter_dca_create', { totalCycles: "<1M>" })
//      must do the same — fall back to 30 cycles.
//
//   3. _decimalToAtomic("<1M digits>") in caps/preflight, agent_pay,
//      wallet, and confirmation/policy must return null for an over-long
//      input WITHOUT calling BigInt().
//
//   4. _parseAmountAtomic("<1M digits>") in payment/x402.js must return
//      null without BigInt().
//
//   5. The R7 BigInt-precision regression test (16-digit values past
//      Number.MAX_SAFE_INTEGER) MUST continue to pass — the length cap
//      is set to 20 specifically so it stays well above 16.
//
// HOW IT FAILS PRE-FIX
// --------------------
// Without the length cap, `BigInt("1".repeat(1_000_000))` takes ~tens of
// seconds in V8 (O(n²) digit conversion) and allocates ~hundreds of MB.
// This test wraps each call in a 500ms wall-clock timeout — pre-fix
// it would either timeout or, on a fast machine, complete after burning
// tens of seconds of CPU. Post-fix the regex rejects in microseconds.

'use strict';

const assert = require('assert');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

// ── Minimal mocks (same pattern as dca-bigint-precision.test.js) ────────────

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
const { _principalForTool, _decimalToAtomic: _decimalToAtomicCaps } = require(path.join(BUNDLE, 'caps', 'preflight'));
const { _decimalToAtomic: _decimalToAtomicWallet } = require(path.join(BUNDLE, 'tools', 'wallet'));
const { _decimalToAtomic: _decimalToAtomicAgentPay } = require(path.join(BUNDLE, 'tools', 'agent_pay'));
const { _parseAmountAtomic } = require(path.join(BUNDLE, 'payment', 'x402'));

let failures = 0;
function check(label, fn) {
    try { fn(); console.log(`  ✓ ${label}`); }
    catch (e) { failures++; console.error(`  ✗ ${label}\n    ${e.stack || e.message}`); }
}

// ── DoS payload — 1 million '1' characters ──────────────────────────────────
// Pre-fix: BigInt("1".repeat(1_000_000)) is O(n²), takes seconds, allocates
// hundreds of MB. Post-fix: rejected by length gate in microseconds.
//
// Sized to be obviously pathological without making a slow CI machine OOM
// during the pre-fix demonstration. The contract is "any > cap is rejected
// fast" — 1M digits is well past the 20-digit cycle cap and 40-char decimal
// cap, but still allocates well under typical Node heap defaults.
const DOS_PAYLOAD = '1'.repeat(1_000_000);

// Wall-clock-bounded check. Pre-fix the inner function takes seconds;
// post-fix it returns in single-digit microseconds. We give 500ms slack
// so a slow CI runner doesn't false-positive on legitimate work.
function fastCheck(label, fn) {
    check(label, () => {
        const t0 = process.hrtime.bigint();
        fn();
        const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
        assert.ok(
            elapsedMs < 500,
            `expected fast rejection (<500ms); got ${elapsedMs.toFixed(1)}ms — DoS gate broken?`,
        );
    });
}

console.log('── _formatDcaTotalDeposit DoS protection (tools/index.js) ──────');

fastCheck('rejects 1M-digit totalCycles string in <500ms (falls back to 30-cycle default)', () => {
    // 1 USDC × 30 (default) = 30 USDC. If the DoS gate is broken, this
    // call would either OOM or take >>500ms parsing the megastring.
    const out = _formatDcaTotalDeposit('1', DOS_PAYLOAD, 'USDC');
    assert.strictEqual(
        out,
        '30',
        `expected 30-cycle fallback; got "${out}" — the gate let the megastring through to BigInt()?`,
    );
});

fastCheck('rejects 21-digit totalCycles (just above the 20-digit cap)', () => {
    // 21 digits — exactly one past the cap. Falls back to 30-cycle default.
    const cycles21 = '1'.repeat(21);
    const out = _formatDcaTotalDeposit('1', cycles21, 'USDC');
    assert.strictEqual(out, '30');
});

fastCheck('accepts 20-digit totalCycles (right at the cap, R7 contract preserved)', () => {
    // 20 digits — exactly at the cap. Should still parse.
    // 1 microUSDC × 99999999999999999999n = the BigInt result formatted
    // with USDC's 6 decimals.
    const cycles20 = '9'.repeat(20);  // 99999999999999999999 (20 nines)
    const out = _formatDcaTotalDeposit('0.000001', cycles20, 'USDC');
    // 99999999999999999999 microunits = 99999999999999.999999 USDC
    assert.strictEqual(out, '99999999999999.999999');
});

console.log('── _principalForTool DoS protection (caps/preflight.js) ────────');

fastCheck('rejects 1M-digit totalCycles in <500ms (falls back to 30 cycles)', () => {
    const p = _principalForTool('jupiter_dca_create', {
        inputToken: 'USDC',
        outputToken: 'SOL',
        amountPerCycle: '1',
        totalCycles: DOS_PAYLOAD,
    });
    // 1 USDC × 30 = 30_000_000n microunits.
    assert.strictEqual(
        p.principalAtomic,
        30000000n,
        `expected 30-cycle fallback principal; got ${p.principalAtomic} — DoS gate failed?`,
    );
});

fastCheck('rejects 21-digit totalCycles', () => {
    const p = _principalForTool('jupiter_dca_create', {
        inputToken: 'USDC',
        outputToken: 'SOL',
        amountPerCycle: '1',
        totalCycles: '1'.repeat(21),
    });
    assert.strictEqual(p.principalAtomic, 30000000n);
});

fastCheck('accepts 20-digit totalCycles (at the cap, R7 contract preserved)', () => {
    const cycles20 = '9'.repeat(20);
    const p = _principalForTool('jupiter_dca_create', {
        inputToken: 'USDC',
        outputToken: 'SOL',
        amountPerCycle: '0.000001',
        totalCycles: cycles20,
    });
    // 1n × 99999999999999999999n = 99999999999999999999n
    assert.strictEqual(p.principalAtomic, 99999999999999999999n);
});

fastCheck('R7 16-digit precision case still passes (HUGE_CYCLES below the 20-cap)', () => {
    const p = _principalForTool('jupiter_dca_create', {
        inputToken: 'USDC',
        outputToken: 'SOL',
        amountPerCycle: '0.000001',
        totalCycles: '9007199254740993',  // 16 digits, past Number.MAX_SAFE_INTEGER
    });
    assert.strictEqual(p.principalAtomic, 9007199254740993n);
});

console.log('── _decimalToAtomic DoS protection (4 clones, all paths) ───────');

fastCheck('caps/preflight._decimalToAtomic rejects 1M-char input in <500ms', () => {
    // The function applies a 40-char cap. A 1M-char string of '1's
    // is well over the cap and must be rejected without BigInt().
    const out = _decimalToAtomicCaps(DOS_PAYLOAD, 9);
    assert.strictEqual(out, null);
});

fastCheck('caps/preflight._decimalToAtomic rejects 41-char input (just over cap)', () => {
    // 41 chars = "1".repeat(41) — int-only, no decimal point.
    const out = _decimalToAtomicCaps('1'.repeat(41), 9);
    assert.strictEqual(out, null);
});

fastCheck('caps/preflight._decimalToAtomic accepts 40-char input (at cap)', () => {
    // 40 chars: 30 int digits + '.' + 9 frac digits = 40.
    const input = '1'.repeat(30) + '.' + '5'.repeat(9);
    const out = _decimalToAtomicCaps(input, 9);
    assert.notStrictEqual(out, null, '40-char input should still parse');
    assert.strictEqual(typeof out, 'bigint');
});

fastCheck('tools/wallet._decimalToAtomic rejects 1M-char input in <500ms', () => {
    const out = _decimalToAtomicWallet(DOS_PAYLOAD, 9);
    assert.strictEqual(out, null);
});

fastCheck('tools/agent_pay._decimalToAtomic rejects 1M-char input in <500ms', () => {
    const out = _decimalToAtomicAgentPay(DOS_PAYLOAD, 6);
    assert.strictEqual(out, null);
});

console.log('── _parseAmountAtomic DoS protection (payment/x402.js) ─────────');

fastCheck('rejects 1M-digit server-supplied atomic amount in <500ms', () => {
    // x402 spec defines maxAmountRequired as an atomic-microunit string
    // received over the wire from a third-party 402 challenge response.
    // A misbehaving/malicious server could emit a megastring; we must
    // reject without BigInt-parsing it.
    const out = _parseAmountAtomic(DOS_PAYLOAD);
    assert.strictEqual(out, null);
});

fastCheck('rejects 31-digit input (just over the 30-digit x402 cap)', () => {
    const out = _parseAmountAtomic('1'.repeat(31));
    assert.strictEqual(out, null);
});

fastCheck('accepts 30-digit input (at cap, realistic upper bound preserved)', () => {
    const out = _parseAmountAtomic('1'.repeat(30));
    assert.notStrictEqual(out, null);
    assert.strictEqual(typeof out, 'bigint');
});

console.log('── R3 / R7 contracts unchanged ────────────────────────────────');

check('R3: small numeric strings still work', () => {
    const out = _formatDcaTotalDeposit('0.5', '10', 'USDC');
    assert.strictEqual(out, '5');
});

check('R3: non-digit string falls through to default', () => {
    const out = _formatDcaTotalDeposit('1', 'abc', 'USDC');
    assert.strictEqual(out, '30');
});

check('Number-path totalCycles unchanged (config/internal callers)', () => {
    const out = _formatDcaTotalDeposit('1', 30, 'USDC');
    assert.strictEqual(out, '30');
});

if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exit(1);
}
console.log('\nAll BAT-582 R10 BigInt-DoS protection tests passed.');
