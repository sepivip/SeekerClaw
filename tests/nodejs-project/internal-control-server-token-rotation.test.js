#!/usr/bin/env node
// internal-control-server-token-rotation.test.js — BAT-1001 PR-B
//
// Proves the AC-3 rotation contract: after a Kotlin-side bridge_token
// rotation, the very next inbound POST authenticates against the NEW
// token without restarting the Node control server. Pre-fix, the
// startup-frozen `_bridgeToken` rejected every POST after the rotation
// until a process restart.
//
// We exercise this by passing a getter that we can mutate live — the
// getter mirrors the production wiring `getBridgeToken: () =>
// getBridgeToken()` (where getBridgeToken re-reads the file each
// call). The test mutates what the getter returns BETWEEN requests
// to simulate Kotlin writing a new token to disk.
//
// Run:  node tests/nodejs-project/internal-control-server-token-rotation.test.js
// Exit: 0 = all pass, 1 = at least one failure.

'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');

const SERVER_JS = path.join(__dirname, '..', '..', 'app', 'src', 'main',
    'assets', 'nodejs-project', 'internal-control-server.js');
const server = require(SERVER_JS);

const HOST = '127.0.0.1';
const PORT = server.PORT;

// Mutable token — assigned by the getter wired into start(). Tests
// reassign this between requests to simulate a Kotlin-side rotation.
let _currentToken = 'token-A-1234567890';

function _post(path, body, headers) {
    return new Promise((resolve, reject) => {
        const data = body == null ? '{}' : JSON.stringify(body);
        const req = http.request({
            hostname: HOST,
            port: PORT,
            path,
            method: 'POST',
            headers: Object.assign({
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
            }, headers || {}),
            timeout: 2000,
        }, (res) => {
            let raw = '';
            res.on('data', (c) => raw += c);
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        if (data) req.write(data);
        req.end();
    });
}

// --- runner ---
const tests = [];
let pass = 0, fail = 0;
function test(name, fn) { tests.push({ name, fn }); }
async function run() {
    const httpServer = server.start({
        // Production wiring shape: a function that returns the
        // current token. The getter closes over _currentToken so
        // mutating it between requests is what the test exercises.
        getBridgeToken: () => _currentToken,
        getDbSummary: () => ({}),
        requestReconcile: () => {},
        logFn: () => {},
    });
    await new Promise((resolve) => {
        if (httpServer.listening) resolve();
        else httpServer.once('listening', resolve);
    });
    for (const { name, fn } of tests) {
        try {
            // Reset rotation state for each test so they don't bleed.
            _currentToken = 'token-A-1234567890';
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
    await server.stop();
    process.exit(fail === 0 ? 0 : 1);
}

// ── core rotation contract ─────────────────────────────────────────

test('AC-3: initial token-A accepted, post-rotation token-A rejected, token-B accepted', async () => {
    // Step 1: pre-rotation, token-A is the current token. Authed POST passes.
    const r1 = await _post('/healthz', {}, { 'X-Bridge-Token': 'token-A-1234567890' });
    assert.strictEqual(r1.status, 200, 'pre-rotation token-A should pass');

    // Step 2: simulate Kotlin rotation — file on disk changed from
    // token-A to token-B. With the per-request getter, the very next
    // POST should use the new token for the auth compare.
    _currentToken = 'token-B-9876543210';

    // Step 3: an in-flight caller still sending the OLD token-A is
    // now rejected. Pre-fix (startup-frozen _bridgeToken) this would
    // have been accepted forever — the bug v1.1 fixes.
    const r2 = await _post('/healthz', {}, { 'X-Bridge-Token': 'token-A-1234567890' });
    assert.strictEqual(r2.status, 401, 'post-rotation old token must be rejected');

    // Step 4: the new caller with token-B is accepted IMMEDIATELY,
    // without a server restart. This is the load-bearing assertion.
    const r3 = await _post('/healthz', {}, { 'X-Bridge-Token': 'token-B-9876543210' });
    assert.strictEqual(r3.status, 200, 'post-rotation new token must be accepted without restart');
});

test('getter returning empty string → all POSTs reject 401 (never short-circuit to allow)', async () => {
    // Simulates the file-missing case during a Kotlin restart — the
    // getter returns ''. Auth gate MUST reject; we never short-circuit
    // to "no token configured = allow".
    _currentToken = '';
    const r = await _post('/healthz', {}, { 'X-Bridge-Token': 'anything' });
    assert.strictEqual(r.status, 401);
});

test('throwing getter → server returns 500 cleanly, listener survives for next request', async () => {
    // server.start() is idempotent for the listener but always
    // rebinds _getBridgeToken — that lets us swap in a throwing
    // getter mid-session without restarting the server. Production
    // shouldn't ever see this (config.js getBridgeToken catches all
    // fs errors and returns the cold-fallback), but a getter that
    // genuinely threw would propagate up through _route's outer
    // try/catch and surface as 500. We verify both:
    //   (a) the request returns 500 (not a hang, not a 200, not a
    //       socket reset),
    //   (b) the server's listener is still alive for the next call
    //       after the throw — proving the throw didn't crash the
    //       handler.
    server.start({
        getBridgeToken: () => { throw new Error('simulated disk read failure'); },
        getDbSummary: () => ({}),
        requestReconcile: () => {},
        logFn: () => {}, // suppress the [ControlServer] handler error log
    });
    const r1 = await _post('/healthz', {}, { 'X-Bridge-Token': 'anything' });
    assert.strictEqual(r1.status, 500, 'throwing getter → outer try/catch → 500');

    // Restore the rotation getter for any subsequent test AND prove
    // the listener survived the throw — a successful POST after
    // means the server didn't crash mid-handler.
    server.start({
        getBridgeToken: () => _currentToken,
        getDbSummary: () => ({}),
        requestReconcile: () => {},
        logFn: () => {},
    });
    const r2 = await _post('/healthz', {}, { 'X-Bridge-Token': _currentToken });
    assert.strictEqual(r2.status, 200, 'listener survived the throw — next request works');
});

run();
