#!/usr/bin/env node
// runtime-state-reasoning.test.js — pin BAT-549 Commit 3b dual-side
// compatibility invariants for the new RuntimeState fields:
//
//  - DEFAULTS include the 4 new fields (reasoningEnabled,
//    reasoningDisplayInChat, customEchoReasoning, customConfigSignature)
//  - Old `runtime_state.json` files (pre-BAT-549, just provider/authType/
//    model) load cleanly via cross-process-store DEFAULTS-merge —
//    missing fields filled, no crash, no schema migration needed
//  - New write() type-checks the new optional fields IF present
//    (boolean flags, string-or-null signature)
//  - BAT-513 read/write paths for provider/auth/model still work
//    untouched (no regression of existing contract)
//
// Run:  node tests/nodejs-project/runtime-state-reasoning.test.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bat549-rtstate-'));
// runtime-state.js wants `workDir`; the file lives at workDir's parent.
// Create both.
const workDir = path.join(tmpRoot, 'workspace');
fs.mkdirSync(workDir, { recursive: true });

const runtimeState = require('../../app/src/main/assets/nodejs-project/runtime-state');

let failures = 0;
function ok(label, cond, hint = '') {
    if (cond) console.log(`PASS: ${label}`);
    else { console.log(`FAIL: ${label}${hint ? ' — ' + hint : ''}`); failures++; }
}
function eq(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) console.log(`PASS: ${label}`);
    else { console.log(`FAIL: ${label}\n  actual:   ${a}\n  expected: ${e}`); failures++; }
}

console.log('── DEFAULTS include the 4 new BAT-549 fields ──');
const D = runtimeState.DEFAULTS;
eq('DEFAULTS.reasoningEnabled = false', D.reasoningEnabled, false);
eq('DEFAULTS.reasoningDisplayInChat = false', D.reasoningDisplayInChat, false);
eq('DEFAULTS.customEchoReasoning = false', D.customEchoReasoning, false);
eq('DEFAULTS.customConfigSignature = null', D.customConfigSignature, null);
// Existing fields untouched
eq('DEFAULTS.provider = claude (preserved)', D.provider, 'claude');
eq('DEFAULTS.authType = api_key (preserved)', D.authType, 'api_key');
eq('DEFAULTS.model = claude-opus-4-7 (preserved)', D.model, 'claude-opus-4-7');

console.log();
console.log('── Old-shape file loads cleanly (3-field upgrade compat) ──');

// Simulate a pre-BAT-549 runtime_state.json (3 fields only)
const oldShapeFile = path.join(tmpRoot, 'runtime_state.json');
fs.writeFileSync(oldShapeFile, JSON.stringify({
    provider: 'openai',
    authType: 'api_key',
    model: 'gpt-5.4',
}, null, 2), 'utf8');

const handle = runtimeState.open(workDir);
const loaded = handle.read();
eq('Old-shape: provider preserved', loaded.provider, 'openai');
eq('Old-shape: authType preserved', loaded.authType, 'api_key');
eq('Old-shape: model preserved', loaded.model, 'gpt-5.4');
eq('Old-shape: missing reasoningEnabled fills from DEFAULT (false)',
    loaded.reasoningEnabled, false);
eq('Old-shape: missing reasoningDisplayInChat fills from DEFAULT (false)',
    loaded.reasoningDisplayInChat, false);
eq('Old-shape: missing customEchoReasoning fills from DEFAULT (false)',
    loaded.customEchoReasoning, false);
eq('Old-shape: missing customConfigSignature fills from DEFAULT (null)',
    loaded.customConfigSignature, null);

console.log();
console.log('── write() type-checks new optional fields ──');

// Wrong type → throws
const baseValid = {
    provider: 'claude', authType: 'api_key', model: 'claude-opus-4-7',
};

function expectThrow(label, fn, msgFragment) {
    try { fn(); ok(label + ' (did NOT throw)', false); }
    catch (e) {
        const m = e.message || '';
        ok(label, m.includes(msgFragment), `wrong message: ${m}`);
    }
}

expectThrow('write rejects reasoningEnabled = "true" (string, not boolean)',
    () => handle.write({ ...baseValid, reasoningEnabled: 'true' }),
    'reasoningEnabled must be boolean');
expectThrow('write rejects reasoningDisplayInChat = 1 (number)',
    () => handle.write({ ...baseValid, reasoningDisplayInChat: 1 }),
    'reasoningDisplayInChat must be boolean');
expectThrow('write rejects customEchoReasoning = null (must be boolean)',
    () => handle.write({ ...baseValid, customEchoReasoning: null }),
    'customEchoReasoning must be boolean');
expectThrow('write rejects customConfigSignature = 12345 (number)',
    () => handle.write({ ...baseValid, customConfigSignature: 12345 }),
    'customConfigSignature must be string or null');

// Valid types accepted
ok('write accepts reasoningEnabled = true',
    handle.write({ ...baseValid, reasoningEnabled: true }) === true);
ok('write accepts reasoningEnabled absent (undefined)',
    handle.write({ ...baseValid }) === true);
ok('write accepts customConfigSignature = null',
    handle.write({ ...baseValid, customConfigSignature: null }) === true);
ok('write accepts customConfigSignature = "abc123sha"',
    handle.write({ ...baseValid, customConfigSignature: 'abc123sha' }) === true);

console.log();
console.log('── Round-trip with all 4 new fields ──');

const fullValue = {
    provider: 'custom', authType: 'api_key', model: 'deepseek-v4-pro',
    reasoningEnabled: true,
    reasoningDisplayInChat: true,
    customEchoReasoning: true,
    customConfigSignature: 'sha256-abc-def',
};
handle.write(fullValue);
const readBack = handle.read();
eq('Round-trip: provider', readBack.provider, 'custom');
eq('Round-trip: reasoningEnabled', readBack.reasoningEnabled, true);
eq('Round-trip: reasoningDisplayInChat', readBack.reasoningDisplayInChat, true);
eq('Round-trip: customEchoReasoning', readBack.customEchoReasoning, true);
eq('Round-trip: customConfigSignature', readBack.customConfigSignature, 'sha256-abc-def');

console.log();
console.log('── update() works with new fields (read-modify-write) ──');

handle.update((current) => ({ ...current, reasoningEnabled: false, reasoningDisplayInChat: false }));
const afterUpdate = handle.read();
eq('update: reasoningEnabled flipped to false', afterUpdate.reasoningEnabled, false);
eq('update: reasoningDisplayInChat flipped to false', afterUpdate.reasoningDisplayInChat, false);
eq('update: other fields preserved (customEchoReasoning still true)',
    afterUpdate.customEchoReasoning, true);
eq('update: customConfigSignature still set',
    afterUpdate.customConfigSignature, 'sha256-abc-def');

console.log();
console.log('── BAT-513 contract preserved (no regression) ──');

// Matrix violation still throws
expectThrow('write rejects (claude, oauth) per matrix',
    () => handle.write({ ...baseValid, provider: 'claude', authType: 'oauth' }),
    'invalid (provider=claude, authType=oauth)');

// Shape violation still throws
expectThrow('write rejects missing model',
    () => handle.write({ provider: 'claude', authType: 'api_key' }),
    'invalid shape');

// Cleanup
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}

console.log();
if (failures === 0) {
    console.log('ALL TESTS PASS');
    process.exit(0);
} else {
    console.log(`${failures} TEST(S) FAILED`);
    process.exit(1);
}
