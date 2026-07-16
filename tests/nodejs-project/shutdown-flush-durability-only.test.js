#!/usr/bin/env node
// shutdown-flush-durability-only.test.js — BAT-1155 soak-brick behavioral regression.
//
// THE BUG (found on-device 2026-07-14): /shutdown/flush computed the brick-critical `diskUnsafe`
// durability signal fast (the xAI drain) but BLOCKED its HTTP response behind the best-effort
// session summary (up to 1200ms). On a loaded device the summary times out, so the endpoint
// answers past the Kotlin durability gate's per-round read budget → the gate reads null →
// interprets it as "Node unreachable" → fail-closes by marking the freshly-signed-in family
// reauth-required → the token reads as "credential missing" and the UI reverts to "Sign in with
// Grok". Every retry re-runs the trap.
//
// THE FIX: a `{"durabilityOnly":true}` body makes the endpoint answer with the durability signal
// as soon as the xAI drain completes, WITHOUT invoking the summary flush at all. This test drives
// the REAL internal-control-server handler with injected spies to prove:
//   1. durabilityOnly:true  → responds fast with the drain's diskUnsafe, and NEVER calls the
//      (deliberately slow) summary flush.
//   2. durabilityOnly:true  → still surfaces a genuinely-stranded token (diskUnsafe:true) fast.
//   3. a full flush ({})    → STILL runs the summary (no regression to shutdown persistence).

'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');

const SERVER_JS = path.join(__dirname, '..', '..', 'app', 'src', 'main',
    'assets', 'nodejs-project', 'internal-control-server.js');
const server = require(SERVER_JS);

const HOST = '127.0.0.1';
const PORT = server.PORT;
const TOKEN = 'test-bridge-token-durability';

// --- injectable spies ---
let summaryCalls = 0;
let drainCalls = 0;
let drainResult = { pendingPersist: false, diskUnsafe: false, notifyPending: false };

function reset() {
    summaryCalls = 0;
    drainCalls = 0;
    drainResult = { pendingPersist: false, diskUnsafe: false, notifyPending: false };
}

function _post(p, body) {
    return new Promise((resolve, reject) => {
        const data = body == null ? '' : JSON.stringify(body);
        const req = http.request({
            hostname: HOST, port: PORT, path: p, method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
                'X-Bridge-Token': TOKEN,
            },
            timeout: 3000,
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

const tests = [];
let pass = 0, fail = 0;
function test(name, fn) { tests.push({ name, fn }); }

async function run() {
    const httpServer = server.start({
        getBridgeToken: () => TOKEN,
        // The summary flush is DELIBERATELY slow (300ms) — the on-device shape that used to
        // outlast the gate's read budget. durabilityOnly must never wait for (or invoke) it.
        flushShutdown: async () => {
            summaryCalls++;
            await new Promise((r) => setTimeout(r, 300));
            return { ok: true };
        },
        xaiFlush: async () => {
            drainCalls++;
            return drainResult;
        },
        logFn: () => {},
    });
    await new Promise((resolve) => {
        if (httpServer.listening) resolve();
        else httpServer.once('listening', resolve);
    });

    for (const { name, fn } of tests) {
        try {
            reset();
            await fn();
            pass++;
            console.log(`PASS  ${name}`);
        } catch (e) {
            fail++;
            console.log(`FAIL  ${name}`);
            console.log(`  ${e.message}`);
        }
    }

    server.stop();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

test('durabilityOnly returns the drain diskUnsafe WITHOUT running the summary flush', async () => {
    const t0 = Date.now();
    const res = await _post('/shutdown/flush', { durabilityOnly: true });
    const elapsed = Date.now() - t0;
    assert.strictEqual(res.status, 200, 'durabilityOnly must ack 200');
    assert.strictEqual(res.body.diskUnsafe, false, 'must surface the drain diskUnsafe signal');
    assert.strictEqual(drainCalls, 1, 'the xAI drain (the durability answer) must run');
    assert.strictEqual(summaryCalls, 0, 'the best-effort summary flush must be SKIPPED for durabilityOnly');
    assert.ok(elapsed < 250, `must answer before the slow (300ms) summary would finish (was ${elapsed}ms)`);
});

test('durabilityOnly surfaces a genuinely stranded token (diskUnsafe:true) fast', async () => {
    drainResult = { pendingPersist: true, diskUnsafe: true, notifyPending: false };
    const res = await _post('/shutdown/flush', { durabilityOnly: true });
    assert.strictEqual(res.status, 200, 'durabilityOnly acks 200 even when unsafe (the caller gates the kill)');
    assert.strictEqual(res.body.diskUnsafe, true, 'a real stranded rotation must still be reported (fail-closed stays intact)');
    assert.strictEqual(summaryCalls, 0, 'still no summary flush on the durability path');
});

test('a full flush ({}) STILL runs the summary — no shutdown-persistence regression', async () => {
    const res = await _post('/shutdown/flush', {});
    assert.strictEqual(summaryCalls, 1, 'the terminal shutdown flush must still persist the session summary');
    assert.strictEqual(drainCalls, 1, 'the xAI drain runs first on the full path too');
    // 200 on clean summary; the body still carries the durability signal for the caller.
    assert.strictEqual(res.body.diskUnsafe, false, 'full flush also reports diskUnsafe');
});

run();
