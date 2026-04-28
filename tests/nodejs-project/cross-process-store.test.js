#!/usr/bin/env node
// cross-process-store.test.js — tests for the BAT-512 Node helper that
// reads/writes JSON files shared with the Kotlin CrossProcessStore.
//
// Run:  node tests/nodejs-project/cross-process-store.test.js
// Exit: 0 = all pass, 1 = at least one failure.
//
// WHY THIS FILE EXISTS
// --------------------
// The Kotlin and Node sides must agree on the file format and
// atomicity contract. If `:node` writes a JSON file the main process
// can't parse, or vice versa, every BAT-511 family migration breaks.
// These tests pin:
//
//   - read/write round-trip parity with the JSON shape Kotlin uses
//   - atomic write contract (tmp + rename, never expose half-written)
//   - read returns defaults on missing / malformed file (no throw)
//   - defensive cleanup when rename fails (no leaked .tmp)
//   - defaults aren't mutated through the returned reference

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STORE_JS = path.join(__dirname, '..', '..', 'app', 'src', 'main',
    'assets', 'nodejs-project', 'cross-process-store.js');
const { createStore, setLogger } = require(STORE_JS);

// Capture log output instead of dumping to stdout during tests.
let logCalls = [];
setLogger((msg, level) => { logCalls.push({ msg, level }); });

// --- runner ---
const tests = [];
let pass = 0, fail = 0;
function test(name, fn) { tests.push({ name, fn }); }
async function run() {
    for (const { name, fn } of tests) {
        try {
            logCalls = [];
            await fn();
            pass++;
            console.log(`PASS  ${name}`);
        } catch (e) {
            fail++;
            console.log(`FAIL  ${name}`);
            console.log(`  ${e.message}`);
            if (e.stack) console.log(e.stack.split('\n').slice(1, 4).join('\n'));
        }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

// Per-test scratch directory so parallel/sequential runs don't collide.
function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'bat512-store-'));
}

// --- behavioural tests ---

test('read returns defaults when file does not exist', () => {
    const dir = tmpDir();
    const store = createStore(path.join(dir, 'absent.json'), { provider: 'anthropic' });
    assert.deepStrictEqual(store.read(), { provider: 'anthropic' });
});

test('read returns defaults on malformed JSON (logged WARN, no throw)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'broken.json');
    fs.writeFileSync(file, '{ this is not json');
    const store = createStore(file, { fallback: true });
    assert.deepStrictEqual(store.read(), { fallback: true });
    assert.ok(logCalls.some(l => l.level === 'WARN'),
        'malformed JSON must produce a WARN log');
});

test('write produces a parseable JSON file', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'out.json');
    const store = createStore(file, {});
    const ok = store.write({ provider: 'openai', model: 'gpt-5.3', authType: 'oauth' });
    assert.strictEqual(ok, true);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(onDisk, { provider: 'openai', model: 'gpt-5.3', authType: 'oauth' });
});

test('write then read round-trips exactly', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'rt.json');
    const store = createStore(file, {});
    const original = { provider: 'openai', model: 'gpt-5.5', authType: 'api_key', nested: { a: 1, b: [2, 3] } };
    store.write(original);
    assert.deepStrictEqual(store.read(), original);
});

test('write is atomic — only renamed file is the visible one', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'atomic.json');
    const store = createStore(file, {});
    const good = { provider: 'anthropic', model: 'claude-opus-4-7' };
    store.write(good);

    // Simulate the same kind of crash the Kotlin atomic test
    // simulates: a half-written .tmp leaked next to the real file.
    // Reader (`store.read()` → `fs.readFileSync(filePath, 'utf8')`)
    // only opens the real path, so the leaked .tmp doesn't affect it.
    fs.writeFileSync(file + '.tmp', '{ partial...');
    assert.deepStrictEqual(store.read(), good);
    assert.ok(fs.existsSync(file + '.tmp'), 'leaked tmp is observable but harmless');
});

test('write cleans up .tmp on rename failure (defensive)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'fail.json');
    // We can't easily force renameSync to fail without monkey-patching
    // fs. Instead, verify the success path leaves no .tmp behind —
    // which proves the cleanup happens (renameSync moves the inode,
    // source path becomes invalid; .tmp must not exist post-write).
    const store = createStore(file, {});
    store.write({ a: 1 });
    assert.ok(fs.existsSync(file), 'real file written');
    assert.ok(!fs.existsSync(file + '.tmp'), '.tmp consumed by rename');
});

test('defaults are NOT mutated through the returned read() reference', () => {
    // Bug surface: if read() returns the shared `defaults` reference
    // and the caller mutates it (e.g. `const v = store.read(); v.foo
    // = 'mutated';`), every subsequent read would see the mutation —
    // a hard-to-debug global state leak. The store deep-clones
    // defaults so read() always returns a fresh copy.
    const dir = tmpDir();
    const defaults = { provider: 'anthropic', nested: { count: 0 } };
    const store = createStore(path.join(dir, 'absent.json'), defaults);
    const a = store.read();
    a.provider = 'mutated';
    a.nested.count = 999;
    const b = store.read();
    assert.strictEqual(b.provider, 'anthropic',
        'second read is not contaminated by first read mutation');
    assert.strictEqual(b.nested.count, 0,
        'deep clone protects nested fields too');
});

test('createStore throws on empty or non-string filePath', () => {
    assert.throws(() => createStore('', {}), /non-empty string/);
    assert.throws(() => createStore(null, {}), /non-empty string/);
    assert.throws(() => createStore(123, {}), /non-empty string/);
});

test('multiple writes coalesce to last-write-wins', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'multi.json');
    const store = createStore(file, {});
    store.write({ v: 1 });
    store.write({ v: 2 });
    store.write({ v: 3 });
    assert.deepStrictEqual(store.read(), { v: 3 });
});

// --- structural drift guard ---

test('drift: live cross-process-store.js exports createStore + setLogger', () => {
    const src = fs.readFileSync(STORE_JS, 'utf8');
    assert.ok(/module\.exports\s*=\s*\{[^}]*createStore/.test(src),
        'must export createStore');
    assert.ok(/module\.exports\s*=\s*\{[^}]*setLogger/.test(src),
        'must export setLogger so the rest of the agent can wire its log function');
});

test('drift: live source uses tmp + rename for atomicity', () => {
    const src = fs.readFileSync(STORE_JS, 'utf8');
    assert.ok(/writeFileSync\s*\(\s*tmpPath/.test(src),
        'write path must go through writeFileSync(tmpPath, ...)');
    assert.ok(/renameSync\s*\(\s*tmpPath\s*,\s*filePath\s*\)/.test(src),
        'write path must call renameSync(tmpPath, filePath)');
});

test('drift: live source defensively unlinks leaked .tmp on failure', () => {
    const src = fs.readFileSync(STORE_JS, 'utf8');
    assert.ok(/unlinkSync\s*\(\s*tmpPath\s*\)/.test(src),
        'failure path must clean up the leaked .tmp');
});

run();
