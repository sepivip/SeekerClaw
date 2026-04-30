#!/usr/bin/env node
// runtime-state-reasoning.test.js — pin BAT-549 Commit 3b dual-side
// compatibility invariants for the new RuntimeState fields:
//
//  - DEFAULTS include the 4 new fields (reasoningEnabled,
//    reasoningDisplayInChat, customEchoReasoning, customConfigSignature)
//  - Old `runtime_state.json` files (pre-BAT-549, just provider/authType/
//    model) load cleanly via the explicit DEFAULTS-merge layered in
//    runtime-state.js's `read()` (cross-process-store itself returns the
//    raw JSON.parse on file-exists; only `read()` here fills in absent
//    BAT-549 fields from DEFAULTS) — no crash, no schema migration needed
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
console.log('── 3b R2 Copilot: write() merges with persisted state (no field-loss) ──');

// Scenario: existing user has reasoningEnabled=true on disk. A legacy
// 3-field write (e.g. Telegram /model command at message-handler.js:573)
// MUST NOT silently drop reasoningEnabled back to false.
handle.write({
    provider: 'claude', authType: 'api_key', model: 'claude-opus-4-7',
    reasoningEnabled: true,
    reasoningDisplayInChat: true,
    customEchoReasoning: true,
    customConfigSignature: 'sig-baseline',
});

// Legacy 3-field write — only provider/authType/model
handle.write({ provider: 'openai', authType: 'oauth', model: 'gpt-5.4' });
const afterLegacy = handle.read();
eq('Legacy write: provider updated', afterLegacy.provider, 'openai');
eq('Legacy write: authType updated', afterLegacy.authType, 'oauth');
eq('Legacy write: model updated', afterLegacy.model, 'gpt-5.4');
eq('Legacy write: reasoningEnabled PRESERVED (NOT reset to false)',
    afterLegacy.reasoningEnabled, true);
eq('Legacy write: reasoningDisplayInChat PRESERVED',
    afterLegacy.reasoningDisplayInChat, true);
eq('Legacy write: customEchoReasoning PRESERVED',
    afterLegacy.customEchoReasoning, true);
eq('Legacy write: customConfigSignature PRESERVED',
    afterLegacy.customConfigSignature, 'sig-baseline');

// Partial update of only ONE new field — others preserved
handle.write({
    provider: 'openai', authType: 'oauth', model: 'gpt-5.4',
    reasoningEnabled: false, // flip back off
});
const afterPartial = handle.read();
eq('Partial write: reasoningEnabled flipped', afterPartial.reasoningEnabled, false);
eq('Partial write: reasoningDisplayInChat preserved (still true)',
    afterPartial.reasoningDisplayInChat, true);
eq('Partial write: customEchoReasoning preserved (still true)',
    afterPartial.customEchoReasoning, true);

// Full 7-field write still works as full-replace
handle.write({
    provider: 'claude', authType: 'api_key', model: 'claude-opus-4-7',
    reasoningEnabled: true,
    reasoningDisplayInChat: false,
    customEchoReasoning: false,
    customConfigSignature: null,
});
const afterFull = handle.read();
eq('Full write: customEchoReasoning replaced', afterFull.customEchoReasoning, false);
eq('Full write: customConfigSignature replaced', afterFull.customConfigSignature, null);

// Allowlist: unknown extra fields in incoming value are dropped (don't reach disk)
handle.write({
    provider: 'claude', authType: 'api_key', model: 'claude-opus-4-7',
    bogusField: 'should not persist',
});
const afterBogus = handle.read();
ok('Allowlist merge: bogus field NOT persisted',
    afterBogus.bogusField === undefined);

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

console.log();
console.log('── 3e R5 Copilot: corrupt persisted values heal on legacy write ──');

// If runtime_state.json is corrupt (manual edit, schema rolled back, etc.)
// with a string "true" instead of boolean true for reasoningEnabled, a
// legacy 3-field write must NOT carry the bad value forward. The merge
// layer's sanitize-on-merge resets it to DEFAULTS.
fs.writeFileSync(oldShapeFile, JSON.stringify({
    provider: 'claude',
    authType: 'api_key',
    model: 'claude-opus-4-7',
    reasoningEnabled: 'true', // corrupted: string instead of boolean
    reasoningDisplayInChat: 1, // corrupted: number instead of boolean
    customEchoReasoning: null, // corrupted: null instead of boolean
    customConfigSignature: 12345, // corrupted: number instead of string|null
}, null, 2), 'utf8');

// Legacy 3-field write
handle.write({ provider: 'openai', authType: 'oauth', model: 'gpt-5.4' });
const afterHeal = handle.read();
eq('Sanitize: corrupted reasoningEnabled "true" → false (default)',
    afterHeal.reasoningEnabled, false);
eq('Sanitize: corrupted reasoningDisplayInChat 1 → false (default)',
    afterHeal.reasoningDisplayInChat, false);
eq('Sanitize: corrupted customEchoReasoning null → false (default)',
    afterHeal.customEchoReasoning, false);
eq('Sanitize: corrupted customConfigSignature 12345 → null (default)',
    afterHeal.customConfigSignature, null);
// Legacy fields still updated correctly
eq('Sanitize: legacy fields written correctly', afterHeal.provider, 'openai');

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
