#!/usr/bin/env node
// mcp-servers.test.js — tests for the BAT-514 Node helper that
// reads/writes mcp_servers.json shared with the Kotlin
// McpServersStore.
//
// Run:  node tests/nodejs-project/mcp-servers.test.js
// Exit: 0 = all pass, 1 = at least one failure.
//
// Pins the parity contract between Kotlin McpServersStore and Node
// mcp-servers.js:
//   - schema: { servers: [ { id, name, url, enabled, rateLimit } ] }
//   - id matches ^[A-Za-z0-9_-]+$
//   - url is http/https with non-empty host
//   - rateLimit > 0
//   - read drops invalid entries with WARN, write throws on invalid

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STORE_JS = path.join(__dirname, '..', '..', 'app', 'src', 'main',
    'assets', 'nodejs-project', 'mcp-servers.js');
const { open, validateShape, ID_REGEX, FILE_NAME } = require(STORE_JS);

// Suppress test-time console.warn so a "drops invalid" assertion's
// expected warning doesn't litter the run output.
const _origWarn = console.warn;
console.warn = () => {};

// --- runner ---
const tests = [];
let pass = 0, fail = 0;
function test(name, fn) { tests.push({ name, fn }); }
async function run() {
    for (const { name, fn } of tests) {
        try {
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
    cleanupTmp();
    console.warn = _origWarn;
    process.exit(fail === 0 ? 0 : 1);
}

const _scratch = [];
// Returns a `workspace` subdirectory inside a fresh tmpdir, mirroring
// the production layout where Node's workDir is `filesDir/workspace`
// and the mcp_servers.json file lives at `filesDir/mcp_servers.json`
// (one level up). `mcp-servers.js open(workDir)` resolves the file
// via `path.dirname(workDir)`, so passing the workspace path here
// makes tests exercise the real path-resolution logic — the bug
// caught at device test on the first MCP-add was specifically that
// pre-fix tests used `tmpDir → file in same dir`, which masked the
// production mismatch between workspace/ and filesDir/.
function tmpDir() {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-servers-test-'));
    _scratch.push(parent);
    const workspace = path.join(parent, 'workspace');
    fs.mkdirSync(workspace);
    return workspace;
}
// Resolve the actual mcp_servers.json file path the way the module
// will. Used by tests that pre-seed file content before calling
// open(workDir).read().
function fileFor(workDir) {
    return path.join(path.dirname(workDir), FILE_NAME);
}
function cleanupTmp() {
    for (const d of _scratch) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
    }
}

// ---------- validateShape ----------

test('validateShape accepts canonical entry', () => {
    assert.strictEqual(validateShape({
        id: 'context7',
        name: 'Context7',
        url: 'https://api.example.com/mcp',
        rateLimit: 10,
    }), null);
});

test('validateShape rejects bad id (regex mismatch)', () => {
    for (const bad of ['', 'a b', 'a/b', 'a.b', 'a;b', '🦄', 'a/../b']) {
        const reason = validateShape({ id: bad, name: 'n', url: 'https://x', rateLimit: 1 });
        assert.notStrictEqual(reason, null, `expected reject id='${bad}'`);
        assert.match(reason, /^id /, `reason should mention id, got "${reason}"`);
    }
});

test('validateShape rejects blank name', () => {
    const r = validateShape({ id: 'x', name: '   ', url: 'https://x', rateLimit: 1 });
    assert.match(r || '', /name/);
});

test('validateShape rejects bad URL schemes', () => {
    for (const bad of ['ftp://x', 'file:///etc/passwd', 'javascript:alert(1)', '']) {
        const r = validateShape({ id: 'x', name: 'n', url: bad, rateLimit: 1 });
        assert.notStrictEqual(r, null, `expected reject url='${bad}'`);
    }
});

test('validateShape accepts http and https', () => {
    assert.strictEqual(
        validateShape({ id: 'x', name: 'n', url: 'http://localhost:8080/mcp', rateLimit: 1 }),
        null,
    );
    assert.strictEqual(
        validateShape({ id: 'x', name: 'n', url: 'https://example.com/mcp', rateLimit: 1 }),
        null,
    );
});

test('validateShape rejects rateLimit not a positive integer', () => {
    // Cross-language schema parity check (BAT-514 R19): Kotlin
    // McpServer.rateLimit is Int, so non-integer values would fail
    // kotlinx-serialization decode. Floats and non-numbers must
    // both reject.
    for (const bad of [0, -1, 1.5, -0.5, 'ten', NaN, Infinity, null, undefined]) {
        const r = validateShape({ id: 'x', name: 'n', url: 'https://x', rateLimit: bad });
        assert.notStrictEqual(r, null, `expected reject rateLimit=${bad}`);
    }
});

test('validateShape rejects non-boolean enabled', () => {
    const r = validateShape({ id: 'x', name: 'n', url: 'https://x', rateLimit: 1, enabled: 'yes' });
    assert.match(r || '', /enabled/);
});

// ---------- read ----------

test('read returns empty array when file is absent', () => {
    const dir = tmpDir();
    const store = open(dir);
    assert.deepStrictEqual(store.read(), []);
});

test('read returns empty array on malformed JSON', () => {
    const dir = tmpDir();
    fs.writeFileSync(fileFor(dir), 'not valid json{{{');
    const store = open(dir);
    assert.deepStrictEqual(store.read(), []);
});

test('read drops invalid entries and keeps the rest', () => {
    const dir = tmpDir();
    fs.writeFileSync(fileFor(dir), JSON.stringify({
        servers: [
            { id: 'ok1', name: 'OK1', url: 'https://a', rateLimit: 5 },
            { id: 'bad id', name: 'X', url: 'https://b', rateLimit: 1 },     // bad id
            { id: 'ok2', name: 'OK2', url: 'https://c', rateLimit: 3 },
            { id: 'ok3', name: '', url: 'https://d', rateLimit: 1 },         // blank name
            { id: 'ok4', name: 'OK4', url: 'ftp://e', rateLimit: 1 },        // bad scheme
        ],
    }));
    const cleaned = open(dir).read();
    assert.deepStrictEqual(cleaned.map((s) => s.id), ['ok1', 'ok2']);
});

test('read drops duplicate ids (first wins)', () => {
    const dir = tmpDir();
    fs.writeFileSync(fileFor(dir), JSON.stringify({
        servers: [
            { id: 'ctx', name: 'First', url: 'https://a', rateLimit: 1 },
            { id: 'ctx', name: 'Dupe', url: 'https://b', rateLimit: 2 },
        ],
    }));
    const cleaned = open(dir).read();
    assert.strictEqual(cleaned.length, 1);
    assert.strictEqual(cleaned[0].name, 'First');
});

test('read defaults enabled to true and trims name/url', () => {
    const dir = tmpDir();
    fs.writeFileSync(fileFor(dir), JSON.stringify({
        servers: [
            { id: 'ctx', name: '  Context7  ', url: '  https://api.example.com/mcp  ', rateLimit: 5 },
        ],
    }));
    const [s] = open(dir).read();
    assert.strictEqual(s.enabled, true);
    assert.strictEqual(s.name, 'Context7');
    assert.strictEqual(s.url, 'https://api.example.com/mcp');
});

// ---------- write ----------

test('write throws on invalid entry', () => {
    const dir = tmpDir();
    const store = open(dir);
    assert.throws(() => store.write({
        servers: [{ id: 'bad id', name: 'n', url: 'https://x', rateLimit: 1 }],
    }), /TypeError/);
});

test('write throws on missing servers array', () => {
    const dir = tmpDir();
    const store = open(dir);
    assert.throws(() => store.write({ foo: 'bar' }), /TypeError/);
    assert.throws(() => store.write(null), /TypeError/);
    assert.throws(() => store.write([]), /TypeError/);
});

test('write persists valid input atomically and read round-trips', () => {
    const dir = tmpDir();
    const store = open(dir);
    const value = {
        servers: [
            { id: 'ctx', name: 'Context7', url: 'https://api.example.com/mcp', rateLimit: 10, enabled: true },
            { id: 'time', name: 'Time', url: 'https://time.example.com/mcp', rateLimit: 5, enabled: false },
        ],
    };
    store.write(value);
    // No leftover .tmp
    assert.strictEqual(fs.existsSync(fileFor(dir) + '.tmp'), false);
    const back = store.read();
    assert.strictEqual(back.length, 2);
    assert.strictEqual(back[0].id, 'ctx');
    assert.strictEqual(back[1].enabled, false);
});

// ---------- drift guards ----------

test('drift: file basename is exactly mcp_servers.json', () => {
    assert.strictEqual(FILE_NAME, 'mcp_servers.json',
        'Kotlin McpServersStore.FILE_NAME pins this name; do not change without updating both sides');
});

test('drift: open(workDir).filePath resolves to dirname(workDir)/mcp_servers.json', () => {
    // Pin the production path-resolution rule. Kotlin's CrossProcessStore
    // writes to `filesDir/mcp_servers.json` (no path separators allowed
    // in CrossProcessStore.fileName), but Node receives `workDir =
    // filesDir/workspace`. Without the dirname climb, Node's fs.watch
    // + read would target workspace/ and never see Kotlin's writes —
    // exactly the device-test failure mode the BAT-514 R20-fix patches.
    const workDir = '/data/data/com.seekerclaw.app/files/workspace';
    const expected = '/data/data/com.seekerclaw.app/files/mcp_servers.json';
    // path.posix.normalize for cross-platform comparison (test runs on
    // Windows in dev but the production target is Android/Linux).
    const actual = open(workDir).filePath.replace(/\\/g, '/');
    assert.strictEqual(actual, expected);
});

test('open() rejects empty/non-string workDir', () => {
    assert.throws(() => open(''), TypeError);
    assert.throws(() => open(undefined), TypeError);
    assert.throws(() => open(null), TypeError);
    assert.throws(() => open(123), TypeError);
});

test('drift: ID_REGEX matches the documented pattern', () => {
    assert.strictEqual(ID_REGEX.source, '^[A-Za-z0-9_-]+$',
        'Must match McpServersStore.ID_REGEX exactly so Kotlin and Node agree');
});

run();
