#!/usr/bin/env node
// bridge-token-reload.test.js — BAT-1001 PR-B
//
// Proves the bridge.js → AndroidBridge 403 retry contract:
//   1. androidBridgeCall reads getBridgeToken() per request (NOT
//      cached at module-load time).
//   2. On HTTP 403 from AndroidBridge, the call re-reads the token
//      and retries EXACTLY ONCE. Persistent 403 surfaces cleanly.
//   3. A second consecutive 403 returns the body as a hard error
//      (no infinite loop).
//
// Test seam: we stub `./config` via require.cache BEFORE requiring
// `bridge.js`, so the bridge module sees a fake getBridgeToken whose
// value we mutate between calls. This is the same require-cache
// stubbing pattern main-wallet-balance.test.js:51-85 establishes.
// A fake AndroidBridge HTTP server bound to 127.0.0.1:8765 (the port
// bridge.js hardcodes) returns 403/200 based on the current
// "expected" token.
//
// Run:  node tests/nodejs-project/bridge-token-reload.test.js

'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');

const CONFIG_JS = path.join(__dirname, '..', '..', 'app', 'src', 'main',
    'assets', 'nodejs-project', 'config.js');
const BRIDGE_JS = path.join(__dirname, '..', '..', 'app', 'src', 'main',
    'assets', 'nodejs-project', 'bridge.js');

// --- stub config.js BEFORE requiring bridge.js ---
// `bridge.js` destructures `getBridgeToken` at require-time. If we
// later did `fakeConfig.getBridgeToken = newFn`, bridge.js would
// keep using the OLD function reference. So the exported getter is
// fixed at module load and reads from controllable closure state:
//
//   - `_stubbedToken` (string) — simple single-value tests mutate this
//     to simulate a rotation. The exported getter just returns it.
//   - `_tokenSequence` (string[]) + `_tokenSeqIdx` (number) — for the
//     rotation-race test that needs DIFFERENT values across the two
//     attempts in a single androidBridgeCall. When non-null, the
//     sequence wins; each getter call returns the next entry (sticky
//     on the last entry so over-reads return the final value).
//
// Tests reset both via the runner between cases.
let _stubbedToken = 'initial-token-AAAAAAAAAA';
let _tokenSequence = null;
let _tokenSeqIdx = 0;

const fakeConfig = {
    getBridgeToken: () => {
        if (_tokenSequence && _tokenSequence.length > 0) {
            const idx = Math.min(_tokenSeqIdx, _tokenSequence.length - 1);
            _tokenSeqIdx++;
            return _tokenSequence[idx];
        }
        return _stubbedToken;
    },
    log: (_msg, _level) => {}, // silent
};
require.cache[require.resolve(CONFIG_JS)] = {
    id: CONFIG_JS,
    filename: CONFIG_JS,
    loaded: true,
    exports: fakeConfig,
};

const { androidBridgeCall } = require(BRIDGE_JS);

// --- fake AndroidBridge on 127.0.0.1:8765 ---
let _expectedToken = 'initial-token-AAAAAAAAAA';
let _requestLog = [];
let _bridgeServer = null;
// When non-null, the fake bridge returns this status + body on every
// request (regardless of auth) — used for the non-403 no-retry test.
// Reset to null between tests by the runner.
let _forcedResponse = null;

function _startFakeBridge() {
    return new Promise((resolve) => {
        _bridgeServer = http.createServer((req, res) => {
            let body = '';
            req.on('data', (c) => body += c);
            req.on('end', () => {
                const headerToken = req.headers['x-bridge-token'];
                _requestLog.push({ path: req.url, token: headerToken });
                if (_forcedResponse !== null) {
                    res.writeHead(_forcedResponse.status, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(_forcedResponse.body));
                    return;
                }
                if (headerToken !== _expectedToken) {
                    // Match AndroidBridge.kt:163 — 403, NOT 401.
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'bridge-token mismatch' }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, echo: body }));
            });
        });
        _bridgeServer.listen(8765, '127.0.0.1', () => resolve());
    });
}

function _stopFakeBridge() {
    return new Promise((resolve) => {
        if (!_bridgeServer) return resolve();
        _bridgeServer.close(() => resolve());
    });
}

// --- runner ---
const tests = [];
let pass = 0, fail = 0;
function test(name, fn) { tests.push({ name, fn }); }
async function run() {
    await _startFakeBridge();
    for (const { name, fn } of tests) {
        try {
            _requestLog = [];
            // Reset rotation state each test.
            _stubbedToken = 'initial-token-AAAAAAAAAA';
            _expectedToken = 'initial-token-AAAAAAAAAA';
            _tokenSequence = null;
            _tokenSeqIdx = 0;
            _forcedResponse = null;
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
    await _stopFakeBridge();
    process.exit(fail === 0 ? 0 : 1);
}

// ── per-call getter contract ──────────────────────────────────────

test('happy path: token matches → 200 with one request', async () => {
    const result = await androidBridgeCall('/ping', { hello: 'world' });
    assert.deepStrictEqual(result, { ok: true, echo: JSON.stringify({ hello: 'world' }) });
    assert.strictEqual(_requestLog.length, 1, 'no retry on success');
});

test('per-call getter: stubbedToken change between calls is picked up immediately', async () => {
    // Call 1: stubbedToken == expectedToken → 200.
    const r1 = await androidBridgeCall('/ping', {});
    assert.strictEqual(r1.ok, true);

    // Mutate BOTH stubbed (Node side) and expected (fake bridge side)
    // — simulates Kotlin rotating bridge_token on disk AND
    // AndroidBridge picking up the new value.
    _stubbedToken = 'token-B-XXXXXXXXXX';
    _expectedToken = 'token-B-XXXXXXXXXX';

    // Call 2: per-call getter MUST read the new value (not the
    // cached initial-token-A from module load). If it used the
    // cached value, the request would 403 and the retry would also
    // fail (Node-side still has stale value).
    const r2 = await androidBridgeCall('/ping', {});
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(_requestLog.length, 2, 'no retry needed on second call');
});

// ── single-shot 403 retry contract ────────────────────────────────

test('rotation race: Node sees stale token on first send, refreshes from disk on 403, retries once and succeeds', async () => {
    // Setup the rotation race via the token-sequence mechanism: the
    // getter returns 'token-A-OLD' on first read (request 1) and
    // 'token-B-NEW' on the second (the post-403 retry). This mirrors
    // "disk file changed between attempts" — exactly the production
    // race the bridge.js retry exists to absorb.
    _tokenSequence = ['token-A-OLD-PRE-ROTATION', 'token-B-NEW-POST-ROTATION'];
    _expectedToken = 'token-B-NEW-POST-ROTATION';

    const result = await androidBridgeCall('/ping', {});
    // The 403-retry path MUST kick in: first send 403, refresh
    // getter → token-B, retry → 200.
    assert.strictEqual(result.ok, true, 'retry with refreshed token must succeed');
    assert.strictEqual(_requestLog.length, 2, 'exactly one retry');
    assert.strictEqual(_requestLog[0].token, 'token-A-OLD-PRE-ROTATION');
    assert.strictEqual(_requestLog[1].token, 'token-B-NEW-POST-ROTATION');
});

test('persistent 403: both attempts fail → caller gets the second-response body (no infinite loop)', async () => {
    // Both the initial token and the post-refresh token are wrong
    // — simulates AndroidBridge genuinely rejecting this caller
    // (Kotlin rotated to something we don't know about). The retry
    // cap is 1; a third request MUST NOT fire.
    _stubbedToken = 'genuinely-wrong-token';
    _expectedToken = 'completely-different-token';

    const result = await androidBridgeCall('/ping', {});
    // Second 403's body is JSON `{error:"bridge-token mismatch"}`.
    // bridge.js parses the body and returns it — the caller sees
    // the error string and surfaces it as a hard failure.
    assert.strictEqual(result.error, 'bridge-token mismatch', 'caller sees second 403 body');
    assert.strictEqual(_requestLog.length, 2, 'capped at exactly 2 attempts (1 original + 1 retry)');
});

test('non-403 error response: no retry, body is returned directly', async () => {
    // Simulate a 500 from AndroidBridge (e.g. an unrelated server
    // error). The retry MUST only fire on 403 — other status codes
    // pass through immediately so callers can react to them.
    _forcedResponse = { status: 500, body: { error: 'internal' } };

    const result = await androidBridgeCall('/ping', {});
    assert.strictEqual(result.error, 'internal');
    assert.strictEqual(_requestLog.length, 1, '500 must NOT trigger retry');
});

run();
