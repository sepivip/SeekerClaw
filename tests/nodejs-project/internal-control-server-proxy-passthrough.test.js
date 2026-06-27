#!/usr/bin/env node
// internal-control-server-proxy-passthrough.test.js — BAT-1001 PR-B
//
// Regression guard for the AndroidBridge → /stats/db-summary proxy.
// AndroidBridge.kt:954-975 opens an HttpURLConnection to
// http://127.0.0.1:8766/stats/db-summary and sets neither a custom
// Host header (Java auto-fills 127.0.0.1:8766) nor an Origin header
// (HttpURLConnection doesn't set Origin by default).
//
// The new Host/Origin gate in internal-control-server.js MUST let
// this proxy shape through — pre-fix the gate didn't exist, the
// proxy worked. Post-fix the proxy MUST still work or the Settings
// "DB summary" screen breaks.
//
// Run:  node tests/nodejs-project/internal-control-server-proxy-passthrough.test.js

'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');

const SERVER_JS = path.join(__dirname, '..', '..', 'app', 'src', 'main',
    'assets', 'nodejs-project', 'internal-control-server.js');
const server = require(SERVER_JS);

const HOST = '127.0.0.1';
const PORT = server.PORT;
const DB_SUMMARY = { messages: 42, tools: 7, mcpServers: 3 };

function _request(method, path, headers) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: HOST,
            port: PORT,
            path,
            method,
            headers: headers || {},
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
        req.end();
    });
}

// --- runner ---
const tests = [];
let pass = 0, fail = 0;
function test(name, fn) { tests.push({ name, fn }); }
async function run() {
    const httpServer = server.start({
        getBridgeToken: () => 'unused-by-stats-endpoint',
        getDbSummary: () => DB_SUMMARY,
        requestReconcile: () => {},
        logFn: () => {},
    });
    await new Promise((resolve) => {
        if (httpServer.listening) resolve();
        else httpServer.once('listening', resolve);
    });
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
    await server.stop();
    process.exit(fail === 0 ? 0 : 1);
}

// ── proxy-shape passthrough ────────────────────────────────────────

test('AndroidBridge proxy shape (Host: 127.0.0.1:8766, no Origin) → 200', async () => {
    // This is exactly what AndroidBridge.kt's HttpURLConnection sends:
    // - Host header = the URL authority = 127.0.0.1:8766
    // - No Origin header (Java HttpURLConnection doesn't set one)
    // - No Bridge-Token (the inner /stats hop is unauthenticated by
    //   contract; the outer AndroidBridge endpoint authed already).
    const r = await _request('GET', '/stats/db-summary', {
        Host: '127.0.0.1:8766',
        // Intentionally NO Origin header.
    });
    assert.strictEqual(r.status, 200, 'proxy must still work after Host/Origin gate landed');
    assert.deepStrictEqual(r.body, DB_SUMMARY);
});

test('proxy with Origin: https://attacker.example → 403 (DNS-rebind defense)', async () => {
    // Even with the correct Host, an Origin-bearing request is
    // browser-initiated and rejected.
    const r = await _request('GET', '/stats/db-summary', {
        Host: '127.0.0.1:8766',
        Origin: 'https://attacker.example',
    });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.error, 'origin not allowed');
});

test('proxy with Host: localhost:8766 → 403 (case + variant rejection)', async () => {
    // Codex v1.1 #4: localhost:8766 is rejected even though it
    // resolves to the same IP. Single allowed Host literal keeps the
    // gate auditable.
    const r = await _request('GET', '/stats/db-summary', {
        Host: 'localhost:8766',
    });
    assert.strictEqual(r.status, 403);
});

run();
