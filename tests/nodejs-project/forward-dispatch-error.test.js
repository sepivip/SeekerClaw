#!/usr/bin/env node
// tests/nodejs-project/forward-dispatch-error.test.js
//
// BAT-1039: forwardDispatchError(result) — the shared helper every wallet tool
// handler uses to forward a burner-policy rejection to its return WITHOUT
// dropping policyClass. It returns a STRICT SUPERSET of { error, reason } and
// preserves policyClass UNCHANGED — it must NEVER infer the security class from
// the error name (a security code like simulation_delta_mismatch has no
// drainer_* prefix yet is still security-class).

'use strict';

const assert = require('assert');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

// dispatch.js requires config.js (process.exit at load) + index/preflight/bridge.
// forwardDispatchError uses NONE of them, so stub each in the require cache
// before loading dispatch.js.
function stub(rel, exports) {
    const p = require.resolve(path.join(BUNDLE, rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub('config.js', { log: () => {} });
stub('bridge.js', { androidBridgeCall: async () => ({}) });
stub('caps/preflight.js', { routeFor: () => ({}) });
stub('wallet/index.js', { getWallet: () => ({}) });

const { forwardDispatchError } = require(path.join(BUNDLE, 'wallet', 'dispatch.js'));

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); if (process.env.VERBOSE) console.error(e.stack); }
}

console.log('forward-dispatch-error.test.js — BAT-1039 policyClass forwarding helper');
console.log();

check('preserves policyClass:security for a NON-prefixed security code', () => {
    // simulation_delta_mismatch is security-class but has no drainer_* prefix —
    // the helper must forward the class verbatim, not infer it.
    const r = forwardDispatchError({ ok: false, error: 'simulation_delta_mismatch', reason: 'delta off', policyClass: 'security' });
    assert.strictEqual(r.error, 'simulation_delta_mismatch');
    assert.strictEqual(r.reason, 'delta off');
    assert.strictEqual(r.policyClass, 'security');
});

check('forwards availability + contract_gap classes unchanged', () => {
    assert.strictEqual(forwardDispatchError({ error: 'simulation_failed', reason: 'rpc', policyClass: 'availability' }).policyClass, 'availability');
    assert.strictEqual(forwardDispatchError({ error: 'expected_delta_required', reason: 'bug', policyClass: 'contract_gap' }).policyClass, 'contract_gap');
});

check('does NOT infer security from a drainer_* error name when policyClass is absent', () => {
    // If the dispatch result carried no policyClass (e.g. an MWA path), the
    // helper must forward undefined — NOT pattern-match drainer_* → security.
    const r = forwardDispatchError({ error: 'drainer_set_authority', reason: 'x' });
    assert.strictEqual(r.policyClass, undefined, 'class must not be invented from the error name');
});

check('returns a strict superset of { error, reason }', () => {
    const r = forwardDispatchError({ error: 'burner_not_signer', reason: 'r', policyClass: 'security', extra: 'ignored' });
    assert.deepStrictEqual(Object.keys(r).sort(), ['error', 'policyClass', 'reason']);
});

check('handles null/undefined result without throwing', () => {
    assert.deepStrictEqual(forwardDispatchError(null), { error: null, reason: null, policyClass: null });
    assert.deepStrictEqual(forwardDispatchError(undefined), { error: undefined, reason: undefined, policyClass: undefined });
});

console.log();
console.log(`Result: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.error('FAIL: forward-dispatch-error.test.js'); process.exit(1); }
console.log('PASS: forward-dispatch-error.test.js');
