#!/usr/bin/env node
// agent-preferences.test.js — pin BAT-515 agent-preferences.js
// invariants per v3 §5 + final guard.
//
// What this guards:
//   - DEFAULTS match Kotlin AgentPreferences companion values
//   - read() returns DEFAULTS-merged for direct callers
//   - readLiveOrNull() returns null on absent / parse-fail / wrong-type
//     / unknown-provider / blank-name (precedence-chain caller path)
//   - write() validates types + allowlist + non-blank for all incoming
//     fields (Node-side write is the NEW-edit boundary; unchanged-skip
//     lives in the Kotlin caller layer)
//   - Partial-update merge: write({searchProvider}) preserves agentName
//   - Sanitize-on-merge: corrupt persisted value heals on next legacy
//     partial-write
//
// Run:  node tests/nodejs-project/agent-preferences.test.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bat515-agentprefs-'));
const workDir = path.join(tmpRoot, 'workspace');
fs.mkdirSync(workDir, { recursive: true });

const agentPreferencesModule = require('../../app/src/main/assets/nodejs-project/agent-preferences');

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
function expectThrow(label, fn, fragment) {
    try { fn(); ok(`${label} (did NOT throw)`, false); }
    catch (e) {
        ok(label, (e.message || '').includes(fragment),
            `wrong message: ${e.message}`);
    }
}

console.log('── DEFAULTS lock-step with Kotlin ──');
eq('DEFAULTS.searchProvider = brave', agentPreferencesModule.DEFAULTS.searchProvider, 'brave');
eq('DEFAULTS.agentName = MyAgent', agentPreferencesModule.DEFAULTS.agentName, 'MyAgent');
eq('AGENT_NAME_MAX = 64', agentPreferencesModule.AGENT_NAME_MAX, 64);
ok('KNOWN_SEARCH_PROVIDERS contains brave',
    agentPreferencesModule.KNOWN_SEARCH_PROVIDERS.has('brave'));
ok('KNOWN_SEARCH_PROVIDERS contains all 5 expected',
    ['brave', 'perplexity', 'exa', 'tavily', 'firecrawl']
        .every((p) => agentPreferencesModule.KNOWN_SEARCH_PROVIDERS.has(p)));

console.log();
console.log('── read() returns DEFAULTS when file absent ──');
const handle = agentPreferencesModule.open(workDir);
eq('read() on fresh dir', handle.read(), {
    searchProvider: 'brave',
    agentName: 'MyAgent',
});

console.log();
console.log('── readLiveOrNull() returns null on absent file ──');
ok('readLiveOrNull on absent file', handle.readLiveOrNull() === null);

console.log();
console.log('── write() validates types + allowlist + non-blank ──');
expectThrow('write rejects unknown searchProvider',
    () => handle.write({ searchProvider: 'duckduckgo', agentName: 'X' }),
    'invalid searchProvider');
expectThrow('write rejects non-string searchProvider',
    () => handle.write({ searchProvider: 12345, agentName: 'X' }),
    'searchProvider must be string');
expectThrow('write rejects blank agentName',
    () => handle.write({ searchProvider: 'brave', agentName: '' }),
    'must not be blank');
expectThrow('write rejects whitespace-only agentName',
    () => handle.write({ searchProvider: 'brave', agentName: '   ' }),
    'must not be blank');
expectThrow('write rejects 65-char agentName',
    () => handle.write({ searchProvider: 'brave', agentName: 'A'.repeat(65) }),
    'exceeds max');
expectThrow('write rejects non-string agentName',
    () => handle.write({ searchProvider: 'brave', agentName: 42 }),
    'agentName must be string');
expectThrow('write rejects non-object value',
    () => handle.write('not an object'),
    'plain object');

console.log();
console.log('── write() valid value persists + roundtrips ──');
ok('write({brave, Cortana}) persists',
    handle.write({ searchProvider: 'brave', agentName: 'Cortana' }) === true);
eq('read() returns persisted', handle.read(), {
    searchProvider: 'brave',
    agentName: 'Cortana',
});
eq('readLiveOrNull() returns same shape',
    handle.readLiveOrNull(),
    { searchProvider: 'brave', agentName: 'Cortana' });

console.log();
console.log('── readLiveOrNull() rejects various corrupt shapes ──');
function writeFile(json) {
    fs.writeFileSync(handle.filePath, json, 'utf8');
}
writeFile('{not valid json}');
ok('parse-fail file → null', handle.readLiveOrNull() === null);
writeFile('null');
ok('JSON null → null', handle.readLiveOrNull() === null);
writeFile('"a string"');
ok('JSON string → null', handle.readLiveOrNull() === null);
writeFile('[1,2,3]');
ok('JSON array → null', handle.readLiveOrNull() === null);
writeFile('{}');
ok('empty object (missing fields) → null', handle.readLiveOrNull() === null);
writeFile(JSON.stringify({ searchProvider: 'brave', agentName: 12345 }));
ok('agentName non-string → null', handle.readLiveOrNull() === null);
writeFile(JSON.stringify({ searchProvider: 'duckduckgo', agentName: 'X' }));
ok('searchProvider not in allowlist → null', handle.readLiveOrNull() === null);
writeFile(JSON.stringify({ searchProvider: 'brave', agentName: '' }));
ok('blank agentName → null', handle.readLiveOrNull() === null);

console.log();
console.log('── readLiveOrNull() accepts over-cap agentName from migration paths ──');
// BAT-515 v3 §1: migration paths legitimately carry over-cap names.
// readLiveOrNull MUST accept them (the cap only applies to NEW writes).
writeFile(JSON.stringify({ searchProvider: 'brave', agentName: 'A'.repeat(100) }));
const overCap = handle.readLiveOrNull();
ok('over-cap agentName → not null', overCap !== null);
eq('over-cap agentName preserved verbatim', overCap?.agentName?.length, 100);

console.log();
console.log('── Partial-update merge ──');
// Reset to a known state
handle.write({ searchProvider: 'exa', agentName: 'Athena' });
ok('legacy 1-field write preserves the other field',
    handle.write({ searchProvider: 'brave' }) === true);
eq('after partial searchProvider write — agentName preserved',
    handle.read(),
    { searchProvider: 'brave', agentName: 'Athena' });
ok('legacy 1-field agentName write preserves searchProvider',
    handle.write({ agentName: 'Donna' }) === true);
eq('after partial agentName write — searchProvider preserved',
    handle.read(),
    { searchProvider: 'brave', agentName: 'Donna' });

console.log();
console.log('── Sanitize-on-merge for corrupt persisted values ──');
// Manually write a corrupt file (non-string searchProvider) then do a
// legacy partial write. The merge should heal the corrupt field.
writeFile(JSON.stringify({ searchProvider: 12345, agentName: 'Donna' }));
ok('legacy partial write heals corrupt searchProvider',
    handle.write({ agentName: 'Athena' }) === true);
eq('after heal — searchProvider back to default, agentName updated',
    handle.read(),
    { searchProvider: 'brave', agentName: 'Athena' });

console.log();
console.log('── update(transform) reads, modifies, writes ──');
handle.write({ searchProvider: 'brave', agentName: 'Cortana' });
ok('update() applies transform',
    handle.update((current) => ({ ...current, agentName: 'NewName' })) === true);
eq('update result', handle.read(),
    { searchProvider: 'brave', agentName: 'NewName' });

console.log();
console.log('── R2: write() context-sensitive validation (parity with Kotlin validateForWrite) ──');
// BAT-515 v3 §1: migration paths legitimately carry over-cap names; the
// 64-char cap only applies to NEW edits. Kotlin's validateForWrite skips
// per-field validation when the field is unchanged from the persisted
// current value. The Node side must match.
//
// Setup: persist an over-cap agentName the way Kotlin's seedFromPrefs
// would (existing user upgraded from pre-BAT-515 with a long name).
// Bypass the JS write() validation by writing the file directly — this
// simulates the migration write coming from the Kotlin side.
writeFile(JSON.stringify({ searchProvider: 'brave', agentName: 'A'.repeat(100) }));

// Pre-fix: write({searchProvider: 'exa'}) alone passed (agentName not
// in input → not validated). That works fine — keep it green.
ok('partial write {searchProvider} succeeds with persisted over-cap name',
    handle.write({ searchProvider: 'exa' }) === true);
eq('after partial searchProvider write — over-cap name preserved',
    handle.read(),
    { searchProvider: 'exa', agentName: 'A'.repeat(100) });

// The bug: a JS caller doing `update(c => ({...c, searchProvider: 'X'}))`
// would have its transform return BOTH fields (over-cap name copied
// from `current` AND the new searchProvider). Pre-fix this threw on
// the unchanged over-cap name; post-fix the unchanged name skips the
// cap check.
ok('update() copying over-cap name + changing searchProvider succeeds (R2 fix)',
    handle.update((current) => ({ ...current, searchProvider: 'tavily' })) === true);
eq('after update — both fields land correctly',
    handle.read(),
    { searchProvider: 'tavily', agentName: 'A'.repeat(100) });

// Sibling: changing the over-cap name to a NEW over-cap name still throws
// (the cap applies to NEW edits, even if the prior was also over-cap).
expectThrow('write rejects NEW over-cap agentName even when current is over-cap',
    () => handle.write({ searchProvider: 'tavily', agentName: 'B'.repeat(100) }),
    'exceeds max');

// Sibling: changing searchProvider to an unknown one still throws.
expectThrow('write rejects unknown new searchProvider even when other field unchanged',
    () => handle.write({ searchProvider: 'duckduckgo', agentName: 'A'.repeat(100) }),
    'invalid searchProvider');

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
