#!/usr/bin/env node
// internal-control-server.test.js — tests for BAT-514's loopback HTTP
// server on 127.0.0.1:8766 hosting both /stats/db-summary AND the new
// /mcp/reconcile + /healthz endpoints.
//
// Run:  node tests/nodejs-project/internal-control-server.test.js
// Exit: 0 = all pass, 1 = at least one failure.
//
// Pins:
//   - port 8766 (must match AndroidBridge.kt's proxy URL)
//   - GET /stats/db-summary works without auth (preserves BAT-31 contract)
//   - POST /mcp/reconcile requires bridge-token auth
//   - POST /mcp/reconcile enqueues to MCPManager.requestReconcile
//   - POST /healthz round-trip
//   - 401 / 404 / 405 status codes
//   - id validation: non-string/empty becomes full reconcile
//
// Rate-limit (429) behavior is documented in internal-control-server.js
// (RATE_LIMIT_RECONCILE = 30/min; RATE_LIMIT_HEALTHZ = 60/min) but
// not exercised here — firing 31+ requests would pollute the
// shared per-process bucket state for later tests in the run.

'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');

const SERVER_JS = path.join(__dirname, '..', '..', 'app', 'src', 'main',
    'assets', 'nodejs-project', 'internal-control-server.js');
const server = require(SERVER_JS);

const HOST = '127.0.0.1';
const PORT = server.PORT;
const BRIDGE_TOKEN = 'test-bridge-token-1234567890';

// Aggregate state for assertions
let _reconcileCalls = [];
let _dbSummary = { messages: 1, tools: 2 };

function _post(path, body, headers) {
    return new Promise((resolve, reject) => {
        const data = body == null ? '' : JSON.stringify(body);
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
                resolve({ status: res.statusCode, headers: res.headers, body: parsed });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        if (data) req.write(data);
        req.end();
    });
}

function _get(path, headers) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: HOST,
            port: PORT,
            path,
            method: 'GET',
            headers: headers || {},
            timeout: 2000,
        }, (res) => {
            let raw = '';
            res.on('data', (c) => raw += c);
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
                resolve({ status: res.statusCode, headers: res.headers, body: parsed });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
    });
}

// --- runner ---
const tests = [];
let pass = 0, fail = 0;
function test(name, fn) { tests.push({ name, fn }); }
async function run() {
    const httpServer = server.start({
        bridgeToken: BRIDGE_TOKEN,
        getDbSummary: () => _dbSummary,
        requestReconcile: (id) => { _reconcileCalls.push(id); },
        logFn: () => {}, // suppress
    });
    // Wait deterministically for the listening event (Copilot R9 PR
    // #352 finding — the prior fixed 30ms sleep could race CI loaded
    // runners and produce ECONNREFUSED on the first request).
    await new Promise((resolve) => {
        if (httpServer.listening) resolve();
        else httpServer.once('listening', resolve);
    });
    for (const { name, fn } of tests) {
        try {
            _reconcileCalls = [];
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

// ---------- port + drift ----------

test('drift: PORT is exactly 8766 (must match AndroidBridge proxy URL)', () => {
    assert.strictEqual(PORT, 8766);
});

// ---------- /stats/db-summary ----------

test('GET /stats/db-summary works without auth (BAT-31 contract preserved)', async () => {
    const r = await _get('/stats/db-summary');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, _dbSummary);
});

test('GET on non-stats path falls through to 405 (method check before 404)', async () => {
    // _route's first check is "GET + path === /stats/db-summary"; any
    // other GET hits the "method !== POST" gate before the 404 fallback.
    // 405 (not 404) is the documented behavior for unknown GET paths.
    const r = await _get('/stats/something-else');
    assert.strictEqual(r.status, 405);
});

// ---------- /mcp/reconcile auth ----------

test('POST /mcp/reconcile without X-Bridge-Token returns 401', async () => {
    const r = await _post('/mcp/reconcile', {});
    assert.strictEqual(r.status, 401);
    assert.deepStrictEqual(_reconcileCalls, []);
});

test('POST /mcp/reconcile with wrong token returns 401', async () => {
    const r = await _post('/mcp/reconcile', {}, { 'X-Bridge-Token': 'wrong' });
    assert.strictEqual(r.status, 401);
    assert.deepStrictEqual(_reconcileCalls, []);
});

test('POST /mcp/reconcile with correct token returns 200 and enqueues full reconcile', async () => {
    const r = await _post('/mcp/reconcile', {}, { 'X-Bridge-Token': BRIDGE_TOKEN });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(_reconcileCalls, [null]);
});

test('POST /mcp/reconcile with id enqueues per-server reconcile', async () => {
    const r = await _post('/mcp/reconcile', { id: 'ctx7' }, { 'X-Bridge-Token': BRIDGE_TOKEN });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(_reconcileCalls, ['ctx7']);
});

test('POST /mcp/reconcile with empty body enqueues full reconcile', async () => {
    const r = await _post('/mcp/reconcile', null, { 'X-Bridge-Token': BRIDGE_TOKEN });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(_reconcileCalls, [null]);
});

test('POST /mcp/reconcile with oversized body returns 413 and skips reconcile', async () => {
    // BAT-514 R19: oversized requests should produce a clean 413
    // response and not trigger reconcile work. Build a JSON-shaped
    // payload >4 KB.
    const oversized = JSON.stringify({ id: 'a'.repeat(8192) });
    const r = await new Promise((resolve, reject) => {
        const req = http.request({
            hostname: HOST,
            port: PORT,
            path: '/mcp/reconcile',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(oversized),
                'X-Bridge-Token': BRIDGE_TOKEN,
            },
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
        req.write(oversized);
        req.end();
    });
    assert.strictEqual(r.status, 413);
    assert.deepStrictEqual(_reconcileCalls, []);
});

test('POST /mcp/reconcile with non-string id falls back to full reconcile', async () => {
    const r = await _post('/mcp/reconcile', { id: 123 }, { 'X-Bridge-Token': BRIDGE_TOKEN });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(_reconcileCalls, [null]);
});

test('POST /mcp/reconcile with malformed JSON falls back to full reconcile', async () => {
    // Send a body the server's body-reader will see as non-JSON
    const data = 'not json';
    const r = await new Promise((resolve, reject) => {
        const req = http.request({
            hostname: HOST,
            port: PORT,
            path: '/mcp/reconcile',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
                'X-Bridge-Token': BRIDGE_TOKEN,
            },
            timeout: 2000,
        }, (res) => {
            let raw = '';
            res.on('data', (c) => raw += c);
            res.on('end', () => resolve({ status: res.statusCode, body: raw }));
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(_reconcileCalls, [null]);
});

// ---------- /healthz ----------

test('POST /healthz with valid token returns 200 ok:true', async () => {
    const r = await _post('/healthz', {}, { 'X-Bridge-Token': BRIDGE_TOKEN });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { ok: true });
});

test('POST /healthz without token returns 401', async () => {
    const r = await _post('/healthz', {});
    assert.strictEqual(r.status, 401);
});

// ---------- method / path errors ----------

test('GET /mcp/reconcile returns 405', async () => {
    const r = await _get('/mcp/reconcile', { 'X-Bridge-Token': BRIDGE_TOKEN });
    assert.strictEqual(r.status, 405);
});

test('POST /unknown returns 404', async () => {
    const r = await _post('/unknown', {}, { 'X-Bridge-Token': BRIDGE_TOKEN });
    assert.strictEqual(r.status, 404);
});

run();
