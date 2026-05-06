#!/usr/bin/env node
// confirmation-policy.test.js — BAT-582 regression-snapshot test.
//
// PURPOSE
// -------
// The Phase 4 confirmation hook MUST preserve v1.0 behavior for every
// existing tool when the burner wallet is unconfigured. This test pins
// that contract.
//
// HISTORY
//   - Phase 1: snapshot was anchored against the live CONFIRM_REQUIRED set
//     in config.js (string-parsing the source).
//   - Phase 4: CONFIRM_REQUIRED was REMOVED from config.js in favor of the
//     dynamic policy hook. The snapshot in confirmation/policy.js
//     (V1_STATIC_CONFIRM) is now the source of truth.
//
// WHAT THIS ASSERTS
// -----------------
//   1. V1_STATIC_CONFIRM matches the documented v1.0 contract — exactly
//      these 8 tools (no more, no less). Drift here means we either added
//      a v1.0-style "always confirm" tool without updating the snapshot,
//      or removed one without auditing the regression case.
//
//   2. getConfirmationPolicy(toolName, {}, { burnerConfigured: false })
//      returns "confirm" for every tool in V1_STATIC_CONFIRM. This is the
//      v1.0 behavior — Phase 4 replaced the static check in ai.js with this
//      hook and any divergence here would silently change which tools
//      require confirmation.
//
//   3. Hook returns "none" for sample non-confirm tools (wallet_status,
//      memory_save, etc.) when burner is unconfigured.
//
//   4. config.js no longer exports CONFIRM_REQUIRED — guards against
//      accidental re-introduction.
//
// HOW TO RUN
//   node tests/nodejs-project/confirmation-policy.test.js
//
// Exit code 0 = pass, non-zero = fail. Pre-push gate.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

const { getConfirmationPolicy, normalizePolicy, V1_STATIC_CONFIRM } = require(
    path.join(BUNDLE, 'confirmation', 'policy')
);

let failures = 0;
function fail(msg) {
    console.error(`FAIL: ${msg}`);
    failures++;
}

// ── 1. Snapshot matches the documented v1.0 contract ────────────────────────
//
// The 8 tools below ARE the v1.0 contract. If you change either side, you
// must update the contract docs (BAT-582 Phase 4 spec — Confirmation policy)
// AND walk through the regression case in your PR description.
const EXPECTED_V1 = [
    'android_call',
    'android_camera_capture',
    'android_location',
    'android_sms',
    'jupiter_dca_create',
    'jupiter_trigger_create',
    'solana_send',
    'solana_swap',
];
const snapSorted = Array.from(V1_STATIC_CONFIRM).sort();
if (JSON.stringify(snapSorted) !== JSON.stringify(EXPECTED_V1)) {
    fail(
        'V1_STATIC_CONFIRM does not match the documented v1.0 contract.\n' +
            `  expected: ${JSON.stringify(EXPECTED_V1)}\n` +
            `  actual:   ${JSON.stringify(snapSorted)}\n` +
            '  Fix: update either confirmation/policy.js V1_STATIC_CONFIRM or\n' +
            '  the EXPECTED_V1 list in this test (and the contract docs).'
    );
}

// ── 2. Hook returns "confirm" for every v1.0 tool when burner is unconfigured ─
for (const tool of V1_STATIC_CONFIRM) {
    const result = normalizePolicy(getConfirmationPolicy(tool, {}, { burnerConfigured: false }));
    if (result.policy !== 'confirm') {
        fail(`getConfirmationPolicy("${tool}") returned "${result.policy}", expected "confirm" (no-burner regression case)`);
    }
}

// ── 3. Hook returns "none" for sample non-confirm tools ─────────────────────
const sampleNone = ['memory_save', 'web_search', 'skill_read', 'session_status'];
for (const tool of sampleNone) {
    if (V1_STATIC_CONFIRM.has(tool)) continue;
    const result = normalizePolicy(getConfirmationPolicy(tool, {}, { burnerConfigured: false }));
    if (result.policy !== 'none') {
        fail(`getConfirmationPolicy("${tool}") returned "${result.policy}", expected "none"`);
    }
}

// wallet_status is its own special case (always "none" regardless of state).
{
    const r = normalizePolicy(getConfirmationPolicy('wallet_status', {}, { burnerConfigured: true }));
    assert.strictEqual(r.policy, 'none', 'wallet_status must always be "none"');
}

// ── 4. config.js no longer exports CONFIRM_REQUIRED (guard against regress) ─
const configSrc = fs.readFileSync(path.join(BUNDLE, 'config.js'), 'utf8');
// Match a literal `const CONFIRM_REQUIRED = new Set([...])` block.
// Any active definition (uncommented) would re-introduce static behavior.
// Comments mentioning CONFIRM_REQUIRED are fine.
if (/^\s*const\s+CONFIRM_REQUIRED\s*=\s*new\s+Set/m.test(configSrc)) {
    fail(
        'config.js re-introduced `const CONFIRM_REQUIRED = new Set(...)`.\n' +
            '  BAT-582 Phase 4 removed this in favor of confirmation/policy.js\'s\n' +
            '  dynamic hook. If you need a new "always-confirm" tool, add it to\n' +
            '  V1_STATIC_CONFIRM in confirmation/policy.js instead.'
    );
}

if (failures > 0) {
    console.error(`\n${failures} failure(s).`);
    process.exit(1);
}
console.log(`PASS: confirmation policy regression snapshot (${V1_STATIC_CONFIRM.size} tools, no-burner branch verified, config.js clean).`);
