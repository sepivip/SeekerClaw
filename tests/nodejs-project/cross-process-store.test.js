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
    cleanupScratchDirs();
    process.exit(fail === 0 ? 0 : 1);
}

// Per-test scratch directories — track every mkdtemp we create so the
// runner can rmSync them at the end. Without this, repeated CI runs
// accumulate `bat512-store-*` directories under the OS temp dir
// indefinitely (Copilot round-4 review fix). Same cleanup pattern
// active-model.test.js uses.
const _scratchDirs = [];
function tmpDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bat512-store-'));
    _scratchDirs.push(dir);
    return dir;
}
function cleanupScratchDirs() {
    for (const dir of _scratchDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
    _scratchDirs.length = 0;
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

test('write cleans up .tmp on rename failure (defensive, monkey-patched failure path)', () => {
    // BAT-512 (Copilot review fix): the original test only asserted
    // the SUCCESS path leaves no .tmp behind, which doesn't actually
    // exercise the catch-block cleanup. Monkey-patch renameSync so
    // the live code's failure handling runs, then verify .tmp is
    // gone and the real file is untouched.
    const dir = tmpDir();
    const file = path.join(dir, 'fail.json');
    const tmpFile = file + '.tmp';
    const store = createStore(file, {});

    const originalRenameSync = fs.renameSync;
    fs.renameSync = (from, to) => {
        if (from === tmpFile && to === file) {
            throw new Error('simulated rename failure');
        }
        return originalRenameSync.call(fs, from, to);
    };

    let ok;
    try {
        ok = store.write({ a: 1 });
    } finally {
        fs.renameSync = originalRenameSync;
    }

    assert.strictEqual(ok, false, 'write returns false on rename failure');
    assert.ok(!fs.existsSync(file), 'real file not written when rename fails');
    assert.ok(!fs.existsSync(tmpFile), '.tmp removed by defensive cleanup');
    assert.ok(logCalls.some(l => l.level === 'ERROR'),
        'failure must produce an ERROR log');
});

test('write success path also leaves no .tmp behind (rename consumed it)', () => {
    // Sanity check on the happy path — separated from the failure
    // test above so each one validates exactly one thing.
    const dir = tmpDir();
    const file = path.join(dir, 'happy.json');
    const store = createStore(file, {});
    store.write({ a: 1 });
    assert.ok(fs.existsSync(file), 'real file written');
    assert.ok(!fs.existsSync(file + '.tmp'), '.tmp consumed by rename');
});

test('mutating the original `defaults` AFTER createStore() does not affect future reads (round-5 snapshot)', () => {
    // BAT-512 (Copilot review fix round-5): defaults must be
    // snapshotted at createStore() construction, not closed over by
    // reference. Otherwise a caller mutating their `defaults`
    // object after construction would see those mutations leak
    // through subsequent missing/malformed read() calls.
    const dir = tmpDir();
    const defaults = { provider: 'anthropic', nested: { count: 0 } };
    const store = createStore(path.join(dir, 'absent.json'), defaults);
    // Mutate the ORIGINAL reference the caller still holds.
    defaults.provider = 'caller-mutated-provider';
    defaults.nested.count = 999;
    defaults.newField = 'caller-added';
    // read() must return the snapshot taken at construction time —
    // NOT the post-mutation defaults.
    const v = store.read();
    assert.strictEqual(v.provider, 'anthropic',
        'snapshot must reflect construction-time defaults, not post-mutation');
    assert.strictEqual(v.nested.count, 0,
        'snapshot must protect nested fields too');
    assert.strictEqual(v.newField, undefined,
        'snapshot freezes the schema at construction time');
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

test('drift: this test file cleans up scratch dirs after running (Copilot round-4)', () => {
    // Pin that the cleanup helper exists so a future refactor that
    // drops it can't silently leak `bat512-store-*` dirs into
    // os.tmpdir() on every CI run.
    const self = fs.readFileSync(__filename, 'utf8');
    assert.ok(/_scratchDirs/.test(self),
        'must track scratch dirs in _scratchDirs for cleanup');
    assert.ok(/cleanupScratchDirs\s*\(\s*\)/.test(self),
        'must call cleanupScratchDirs() in run()');
    assert.ok(/fs\.rmSync\s*\(\s*dir\s*,\s*\{\s*recursive\s*:\s*true/.test(self),
        'cleanup must rmSync recursively');
});

test('drift: live source snapshots `defaults` at createStore() (round-5)', () => {
    const src = fs.readFileSync(STORE_JS, 'utf8');
    assert.ok(/const\s+defaultsSnapshot\s*=\s*_clone\s*\(\s*defaults\s*\)/.test(src),
        'must snapshot defaults via _clone(defaults) at construction');
    assert.ok(/_clone\s*\(\s*defaultsSnapshot\s*\)/.test(src),
        'read() paths must clone from defaultsSnapshot, not the raw defaults reference');
    // Negative: read() must NOT clone the raw `defaults` reference
    // (would re-introduce the post-construction mutation hazard).
    assert.ok(!/return\s+_clone\s*\(\s*defaults\s*\)/.test(src),
        'read() must NOT clone `defaults` directly — that path is the bug');
});

test('drift: live source defensively unlinks leaked .tmp on failure', () => {
    const src = fs.readFileSync(STORE_JS, 'utf8');
    assert.ok(/unlinkSync\s*\(\s*tmpPath\s*\)/.test(src),
        'failure path must clean up the leaked .tmp');
});

run();
