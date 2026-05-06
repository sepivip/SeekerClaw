#!/usr/bin/env node
// confirmation-policy.test.js — BAT-582 Phase 1 regression-snapshot test.
//
// PURPOSE
// -------
// The Phase 4 confirmation hook MUST preserve v1.0 behavior for every
// existing tool when the burner wallet is unconfigured. This test pins
// that contract by verifying:
//
//   1. confirmation/policy.js's `V1_STATIC_CONFIRM` is byte-equal to
//      config.js's live `CONFIRM_REQUIRED` set. If drift, the snapshot
//      is wrong and the regression guarantee is broken.
//
//   2. getConfirmationPolicy(toolName) returns "confirm" for every tool
//      in the live CONFIRM_REQUIRED set, "none" for tools NOT in it.
//      This is the v1.0 behavior — Phase 4 replaces the static check
//      in ai.js with this hook and any divergence here would silently
//      change which tools require confirmation.
//
// HOW TO RUN
//   node tests/nodejs-project/confirmation-policy.test.js
//
// Exit code 0 = pass, non-zero = fail. Pre-push gate.

'use strict';

const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

// Read the live set straight from config.js — but DON'T require config.js
// itself (it has IO + may exit). Parse the source instead.
const fs = require('fs');
const configSrc = fs.readFileSync(path.join(BUNDLE, 'config.js'), 'utf8');

// Match the literal `const CONFIRM_REQUIRED = new Set([...])` block.
// Tolerant to comments and whitespace inside the array.
const setMatch = configSrc.match(/const\s+CONFIRM_REQUIRED\s*=\s*new\s+Set\(\[([\s\S]*?)\]\)/);
if (!setMatch) {
    console.error('FAIL: could not locate CONFIRM_REQUIRED in config.js');
    process.exit(1);
}

// Extract quoted strings from the body, ignore comments.
const body = setMatch[1].replace(/\/\/[^\n]*\n/g, '\n');
const liveTools = new Set(
    Array.from(body.matchAll(/['"]([^'"]+)['"]/g)).map((m) => m[1])
);

const { getConfirmationPolicy, V1_STATIC_CONFIRM } = require(
    path.join(BUNDLE, 'confirmation', 'policy')
);

let failures = 0;
function fail(msg) {
    console.error(`FAIL: ${msg}`);
    failures++;
}

// 1. Snapshot must equal live set
const liveSorted = Array.from(liveTools).sort();
const snapSorted = Array.from(V1_STATIC_CONFIRM).sort();
if (JSON.stringify(liveSorted) !== JSON.stringify(snapSorted)) {
    fail(
        'V1_STATIC_CONFIRM drifts from config.js CONFIRM_REQUIRED.\n' +
            `  live: ${JSON.stringify(liveSorted)}\n` +
            `  snap: ${JSON.stringify(snapSorted)}\n` +
            '  Fix: update confirmation/policy.js V1_STATIC_CONFIRM to match config.js, ' +
            'OR update config.js CONFIRM_REQUIRED to match the new contract.'
    );
}

// 2. Hook returns "confirm" for every tool in the live set
for (const tool of liveTools) {
    const policy = getConfirmationPolicy(tool, {}, { burnerConfigured: false });
    if (policy !== 'confirm') {
        fail(`getConfirmationPolicy("${tool}") returned "${policy}", expected "confirm"`);
    }
}

// 3. Hook returns "none" for some tools NOT in the live set (smoke)
const sampleNone = ['wallet_status', 'memory_save', 'web_search', 'skill_read'];
for (const tool of sampleNone) {
    if (liveTools.has(tool)) continue;
    const policy = getConfirmationPolicy(tool, {}, { burnerConfigured: false });
    if (policy !== 'none') {
        fail(`getConfirmationPolicy("${tool}") returned "${policy}", expected "none"`);
    }
}

if (failures > 0) {
    console.error(`\n${failures} failure(s).`);
    process.exit(1);
}
console.log(`PASS: confirmation policy snapshot matches config.js (${liveTools.size} tools).`);
