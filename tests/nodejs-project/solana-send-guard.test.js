#!/usr/bin/env node
// tests/nodejs-project/solana-send-guard.test.js
//
// BAT-1037: solana_send native-SOL-only denomination guard. Inspect ALL
// denomination hints (a SOL-valued earlier key never suppresses a contradictory
// later key — the v3 break-bypass), deterministic precedence other > fiat > sol,
// wrapped-SOL mint classifies as SPL ('other'), field-only logging.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
// Pure, dependency-free module — loads without the config scaffold.
const { classifySolSendDenomination, SOL_DENOM_KEYS } = require(path.join(BUNDLE, 'tools', 'solana-send-guard.js'));

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); if (process.env.VERBOSE) console.error(e.stack); }
}
const cls = (i) => classifySolSendDenomination(i);

console.log('solana-send-guard.test.js — BAT-1037 native-SOL-only denomination guard');
console.log();

// ── AC-SOL-PURE: all-SOL or no hints → proceed (null) ──
check('AC-SOL-PURE: SOL-only / no hints → proceed (null)', () => {
    assert.strictEqual(cls({}), null);
    assert.strictEqual(cls({ to: 'X', amount: 1 }), null);
    assert.strictEqual(cls({ token: 'SOL' }), null);
    assert.strictEqual(cls({ token: 'sol' }), null);
    assert.strictEqual(cls({ mint: 'native_sol' }), null);
    assert.strictEqual(cls({ token: 'SOL', asset: 'SOL' }), null);   // multiple SOL hints
    assert.strictEqual(cls({ token: '  SOL  ' }), null);             // trimmed
    assert.strictEqual(cls(null), null);
});

// ── AC-CONTRA-1: token:SOL + currency:USDC → sol_only (the exact Codex bypass) ──
check('AC-CONTRA-1: {token:SOL, currency:USDC} → solana_send_sol_only (SOL hint does NOT suppress later key)', () => {
    const r = cls({ token: 'SOL', currency: 'USDC' });
    assert.strictEqual(r.error, 'solana_send_sol_only', JSON.stringify(r));
    // order-invariant: reversed key order, same outcome
    const r2 = cls({ currency: 'USDC', token: 'SOL' });
    assert.strictEqual(r2.error, 'solana_send_sol_only');
});

// ── AC-CONTRA-2: other > fiat ──
check('AC-CONTRA-2: {currency:USD, mint:<USDC>} → solana_send_sol_only (other dominates fiat)', () => {
    assert.strictEqual(cls({ currency: 'USD', mint: USDC }).error, 'solana_send_sol_only');
    assert.strictEqual(cls({ mint: USDC, currency: 'USD' }).error, 'solana_send_sol_only');
});

// ── AC-CONTRA-3 ──
check('AC-CONTRA-3: {mint:native_sol, asset:BONK} → solana_send_sol_only', () => {
    assert.strictEqual(cls({ mint: 'native_sol', asset: 'BONK' }).error, 'solana_send_sol_only');
});

// ── AC-CONTRA-4: sol + fiat (no other) → fiat ──
check('AC-CONTRA-4: {token:SOL, currency:USD} → solana_send_fiat_denomination', () => {
    const r = cls({ token: 'SOL', currency: 'USD' });
    assert.strictEqual(r.error, 'solana_send_fiat_denomination', JSON.stringify(r));
});

// ── AC-CONTRA-5: order invariance across permutations ──
check('AC-CONTRA-5: mixed-class outcome is independent of key order', () => {
    for (const perm of [
        { token: 'SOL', currency: 'USD', mint: USDC },
        { mint: USDC, token: 'SOL', currency: 'USD' },
        { currency: 'USD', mint: USDC, token: 'SOL' },
    ]) {
        assert.strictEqual(cls(perm).error, 'solana_send_sol_only', `order-variant leaked: ${JSON.stringify(perm)}`);
    }
});

// ── AC-WSOL: wrapped-SOL mint is SPL, not native ──
check('AC-WSOL: wrapped-SOL mint (So111…112) → solana_send_sol_only via token AND mint', () => {
    assert.strictEqual(cls({ token: WSOL }).error, 'solana_send_sol_only');
    assert.strictEqual(cls({ mint: WSOL }).error, 'solana_send_sol_only');
});

// ── all 7 aliases independently trigger ──
check('all 7 denomination aliases independently classify a wrong asset', () => {
    assert.deepStrictEqual(SOL_DENOM_KEYS, ['token', 'mint', 'asset', 'symbol', 'currency', 'coin', 'denom']);
    for (const k of SOL_DENOM_KEYS) {
        const r = cls({ [k]: 'BONK' });
        assert.strictEqual(r.error, 'solana_send_sol_only', `alias ${k} did not classify SPL token`);
        assert.strictEqual(r.field, k, `field should name the offending key ${k}`);
    }
    // fiat via every alias too
    for (const k of SOL_DENOM_KEYS) {
        assert.strictEqual(cls({ [k]: 'EUR' }).error, 'solana_send_fiat_denomination', `alias ${k} fiat`);
    }
});

// ── fiat reason must not imply solana_price performs FX ──
check('fiat reason: tells user to convert non-USD to USD; does NOT imply solana_price converts currencies', () => {
    const r = cls({ currency: 'EUR' });
    assert.strictEqual(r.error, 'solana_send_fiat_denomination');
    assert.ok(/does not perform currency conversion/i.test(r.reason), 'must disclaim FX conversion');
    assert.ok(/convert to USD|supply SOL/i.test(r.reason), 'must tell user to convert to USD or supply SOL');
});

// ── field-only: the supplied value is never echoed back ──
check('field-only: reject names the field, never the supplied value', () => {
    const r = cls({ token: USDC });
    assert.strictEqual(r.field, 'token');
    assert.ok(!r.reason.includes(USDC), 'reason must NOT contain the supplied token value');
    assert.ok(!('value' in r), 'reject object must not carry the supplied value');
});

// ── registry guard: solana_send_token must not be recommended imperatively while unregistered ──
check('registry guard: solana_send_token is NOT a registered tool yet; sol_only reason is conditional', () => {
    const solanaSrc = fs.readFileSync(path.join(BUNDLE, 'tools', 'solana.js'), 'utf8');
    assert.ok(!/name:\s*['"]solana_send_token['"]/.test(solanaSrc),
        'solana_send_token is not registered yet — update this test (and the conditional wording) when BAT-1036 ships it');
    const reason = cls({ token: 'USDC' }).reason;
    assert.ok(/when solana_send_token ships/i.test(reason),
        'sol_only reason must phrase solana_send_token conditionally ("when it ships"), not instruct calling it now');
    assert.ok(/wallet app|main wallet/i.test(reason), 'sol_only reason must give the manual fallback');
});

console.log();
console.log(`Result: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.error('FAIL: solana-send-guard.test.js'); process.exit(1); }
console.log('PASS: solana-send-guard.test.js');
