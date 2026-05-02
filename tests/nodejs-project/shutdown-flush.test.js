#!/usr/bin/env node
// shutdown-flush.test.js - drift guards for BAT-525 user-Stop durability.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DATABASE_JS = path.join(ROOT, 'app', 'src', 'main', 'assets', 'nodejs-project', 'database.js');
const CONTROL_JS = path.join(ROOT, 'app', 'src', 'main', 'assets', 'nodejs-project', 'internal-control-server.js');
const MAIN_JS = path.join(ROOT, 'app', 'src', 'main', 'assets', 'nodejs-project', 'main.js');
const SERVICE_KT = path.join(ROOT, 'app', 'src', 'main', 'java', 'com', 'seekerclaw', 'app', 'service', 'SeekerClawService.kt');

let pass = 0;
let fail = 0;

function test(name, fn) {
    try {
        fn();
        pass++;
        console.log(`PASS  ${name}`);
    } catch (e) {
        fail++;
        console.log(`FAIL  ${name}`);
        console.log(`  ${e.message}`);
        if (e.stack) console.log(e.stack.split('\n').slice(1, 4).join('\n'));
    }
}

test('database.js exposes a non-exiting shutdown flush helper', () => {
    const src = fs.readFileSync(DATABASE_JS, 'utf8');
    const helper = src.match(/async function flushForShutdown\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
    assert.ok(helper, 'flushForShutdown helper must exist');
    assert.ok(/saveDatabase\s*\(\s*\{\s*force:\s*true\s*,\s*scheduleRetry:\s*false\s*\}\s*\)/.test(helper[1]),
        'flushForShutdown must force-flush the DB without scheduling dead retries');
    assert.ok(!/process\.exit\s*\(/.test(helper[1]),
        'flushForShutdown must not exit before the HTTP caller receives an ack');
});

test('R5 Copilot: saveDatabase returns Boolean so flush can detect I/O failures', () => {
    // Pre-fix saveDatabase returned undefined and caught I/O errors
    // internally — flushForShutdown couldn't tell whether the DB
    // actually persisted. Now saveDatabase returns true on
    // success/no-op and false on caught error.
    const src = fs.readFileSync(DATABASE_JS, 'utf8');
    const fnMatch = src.match(/function saveDatabase\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
    assert.ok(fnMatch, 'saveDatabase function body not found');
    const body = fnMatch[1];
    // Three return paths: db-not-init, idle-no-op, success → all true.
    // The catch must end with `return false`.
    assert.ok(/if\s*\(!db\)\s*return\s+true/.test(body),
        'saveDatabase must return true on no-op (db not initialized)');
    assert.ok(/if\s*\(!dirty\s*&&\s*!force\)\s*return\s+true/.test(body),
        'saveDatabase must return true on idle no-op');
    assert.ok(/return\s+true\s*;\s*\}\s*catch/.test(body),
        'saveDatabase must return true after a successful write');
    assert.ok(/return\s+false\s*;\s*\}\s*\}/.test(body) || /return\s+false\s*;\s*\}\s*$/.test(body.trim()),
        'saveDatabase must return false when the catch block runs (caught I/O error)');
});

test('R5 Copilot: flushForShutdown returns {ok, summaryFailed?, dbFailed?} result', () => {
    // Pre-fix flushForShutdown caught both summary and saveDatabase
    // errors and resolved unconditionally, so the HTTP endpoint
    // always returned 200/{ok:true} even when the flush failed.
    const src = fs.readFileSync(DATABASE_JS, 'utf8');
    const fnMatch = src.match(/async\s+function\s+flushForShutdown\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
    assert.ok(fnMatch, 'flushForShutdown function body not found');
    const body = fnMatch[1];
    // Must capture summary error (string), then return result with ok flag.
    assert.ok(/summaryFailed\s*=\s*err\.message/.test(body),
        'flushForShutdown must capture the summary error message into summaryFailed');
    assert.ok(/const\s+dbOk\s*=\s*saveDatabase\s*\(/.test(body),
        'flushForShutdown must capture saveDatabase return value');
    assert.ok(/result\.summaryFailed\s*=\s*summaryFailed/.test(body),
        'flushForShutdown result must include summaryFailed when present');
    assert.ok(/result\.dbFailed\s*=\s*true/.test(body),
        'flushForShutdown result must set dbFailed when saveDatabase returns false');
    assert.ok(/return\s+result\s*;?\s*$/.test(body.trim()),
        'flushForShutdown must return the result object');
});

test('R5 Copilot: /shutdown/flush returns 500 when flushForShutdown reports failure', () => {
    // Pre-fix the endpoint always returned 200/{ok:true} unless
    // flushForShutdown threw — but it never throws, since it catches
    // both summary and DB errors internally. R5 makes the endpoint
    // inspect the returned result and surface 500 + details when
    // ok=false.
    const src = fs.readFileSync(CONTROL_JS, 'utf8');
    const startIdx = src.indexOf("url === '/shutdown/flush'");
    const tail = src.slice(startIdx);
    const endIdx = tail.search(/(?:^|\n)\s{4}(?:if \(url ===|return _json\(res, 404)/);
    const flushBlock = endIdx >= 0 ? tail.slice(0, endIdx) : tail;
    // Must capture the result and gate the 200 response on result.ok.
    assert.ok(/const\s+result\s*=\s*await\s+_flushShutdown\s*\(/.test(flushBlock),
        '/shutdown/flush must capture the flushForShutdown result');
    assert.ok(/result\s*&&\s*result\.ok/.test(flushBlock) || /result\.ok\s*===\s*true/.test(flushBlock),
        '/shutdown/flush 200 response must be gated on result.ok');
    // Failure response must surface the per-step details in the
    // body so a user-Stop log triage can identify which path
    // failed (summary vs db).
    assert.ok(/summaryFailed\s*:\s*detail\.summaryFailed/.test(flushBlock),
        '/shutdown/flush 500 body must include summaryFailed detail');
    assert.ok(/dbFailed\s*:\s*!!detail\.dbFailed/.test(flushBlock),
        '/shutdown/flush 500 body must include dbFailed detail');
});

test('database.js keeps signal shutdown as flush then process exit', () => {
    const src = fs.readFileSync(DATABASE_JS, 'utf8');
    // Match the gracefulShutdown function body and assert it awaits
    // flushForShutdown AND exits via process.exit(0). R5 added a
    // result-inspection block between them to log partial failures
    // (summary/db); the SEMANTIC ordering "await flush, then exit"
    // is preserved — just allow text between the two anchors.
    const fnMatch = src.match(/async\s+function\s+gracefulShutdown\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
    assert.ok(fnMatch, 'gracefulShutdown function body not found');
    const body = fnMatch[1];
    assert.ok(/await\s+flushForShutdown\s*\(/.test(body),
        'gracefulShutdown must await the shared flushForShutdown helper');
    assert.ok(/process\.exit\s*\(\s*0\s*\)/.test(body),
        'gracefulShutdown must call process.exit(0)');
    const flushIdx = body.search(/await\s+flushForShutdown/);
    const exitIdx = body.search(/process\.exit\s*\(\s*0\s*\)/);
    assert.ok(flushIdx < exitIdx,
        'flushForShutdown must be awaited BEFORE process.exit so persistence completes pre-termination');
});

test('internal-control-server.js exposes POST /shutdown/flush', () => {
    // BAT-525 originally lived in database.js's startStatsServer.
    // BAT-514 moved that server to internal-control-server.js, so the
    // BAT-525 endpoint had to follow.
    const src = fs.readFileSync(CONTROL_JS, 'utf8');
    assert.ok(/url\s*===\s*'\/shutdown\/flush'/.test(src),
        'internal-control-server must expose /shutdown/flush');
    assert.ok(/await\s+_flushShutdown\s*\(\s*'USER_STOP'\s*,\s*\{\s*summaryTimeoutMs:\s*1200\s*\}\s*\)/.test(src),
        'POST /shutdown/flush must await flushShutdown with summaryTimeoutMs=1200 — the R4-tightened budget that fits within Kotlin\'s 1750ms worst-case wall time (CONNECT 250 + READ 1500), which itself fits within the 2000ms outer withTimeoutOrNull. HttpURLConnection isn\'t cooperatively cancellable so the bound MUST come from the underlying timeouts, not the outer coroutine timeout.');
});

test('R1 Copilot: /shutdown/flush drains the request body', () => {
    // Without draining, the keep-alive socket can't recycle and the
    // listener buffers an unread body. Slice the file from the
    // /shutdown/flush block start to the next route or end-of-route
    // function so we don't accidentally match _readBody usage in
    // other endpoints.
    const src = fs.readFileSync(CONTROL_JS, 'utf8');
    const startIdx = src.indexOf("url === '/shutdown/flush'");
    assert.ok(startIdx >= 0, '/shutdown/flush block must exist');
    // End of block: next `if (url ===` OR `return _json(res, 404` (fallthrough).
    const tail = src.slice(startIdx);
    const endIdx = tail.search(/(?:^|\n)\s{4}(?:if \(url ===|return _json\(res, 404)/);
    const flushBlock = endIdx >= 0 ? tail.slice(0, endIdx) : tail;
    assert.ok(/_readBody\s*\(\s*req\s*,/.test(flushBlock),
        '/shutdown/flush must drain request body via _readBody');
});

test('R2 Copilot: /shutdown/flush surfaces flush failures as 500', () => {
    // The original PR caught the throw and returned 200 + {ok:true},
    // making Kotlin's "flush acknowledged" log lie in exactly the
    // failure mode this endpoint exists to handle.
    const src = fs.readFileSync(CONTROL_JS, 'utf8');
    const startIdx = src.indexOf("url === '/shutdown/flush'");
    const tail = src.slice(startIdx);
    const endIdx = tail.search(/(?:^|\n)\s{4}(?:if \(url ===|return _json\(res, 404)/);
    const flushBlock = endIdx >= 0 ? tail.slice(0, endIdx) : tail;
    assert.ok(/_json\(res,\s*200,\s*\{\s*ok:\s*true\s*\}/.test(flushBlock),
        '/shutdown/flush must return 200/{ok:true} on success');
    assert.ok(/_json\(res,\s*500,\s*\{\s*ok:\s*false/.test(flushBlock),
        '/shutdown/flush must return 500/{ok:false} on flush failure (not 200/{ok:true})');
});

test('R3 Copilot: _readBody handles aborted/close events', () => {
    // If Kotlin times out and closes the socket before sending `end`,
    // neither `end` nor `error` fires on the request stream — without
    // an aborted/close listener the body-drain promise hangs forever.
    const src = fs.readFileSync(CONTROL_JS, 'utf8');
    assert.ok(/req\.on\s*\(\s*['"]aborted['"]/.test(src),
        '_readBody must listen for aborted to handle client timeout');
    assert.ok(/req\.on\s*\(\s*['"]close['"]/.test(src),
        '_readBody must listen for close to handle abrupt disconnects');
});

test('main.js wires flushForShutdown into internal-control-server.start', () => {
    // Without this wire-up the new endpoint's _flushShutdown stays
    // null and the route returns 503. Both Telegram and Discord
    // startup paths must wire the callback.
    const src = fs.readFileSync(MAIN_JS, 'utf8');
    const wireCount = (src.match(/flushShutdown:\s*flushForShutdown/g) || []).length;
    assert.ok(wireCount >= 2,
        `main.js must wire flushShutdown in BOTH start() call sites (Telegram + Discord); found ${wireCount}`);
});

test('SeekerClawService calls Node flush before stopping NodeBridge', () => {
    const src = fs.readFileSync(SERVICE_KT, 'utf8');
    const onDestroy = src.match(/override fun onDestroy\s*\(\)\s*\{([\s\S]*?)\n    \}/);
    assert.ok(onDestroy, 'onDestroy body must be found');
    const body = onDestroy[1];
    const flushIdx = body.indexOf('flushNodeBeforeProcessKill()');
    const stopIdx = body.indexOf('NodeBridge.stop()');
    const killIdx = body.indexOf('killProcess');
    assert.ok(flushIdx >= 0, 'onDestroy must call flushNodeBeforeProcessKill()');
    assert.ok(stopIdx >= 0, 'onDestroy must still call NodeBridge.stop()');
    assert.ok(killIdx >= 0, 'onDestroy must still kill the :node process');
    assert.ok(flushIdx < stopIdx, 'Node flush must happen before NodeBridge.stop()');
    assert.ok(flushIdx < killIdx, 'Node flush must happen before killProcess()');
});

test('SeekerClawService posts to Node flush endpoint with a bounded timeout', () => {
    // R3 Copilot: SeekerClawService used to roll its own
    // HttpURLConnection POST without setting `X-Bridge-Token`, which
    // meant /shutdown/flush would 401 every user-Stop in production.
    // The fix delegates to NodeControlClient.flushShutdown(), which
    // already handles auth, JSON body, response drain, and timeouts —
    // assert that both the bounded outer timeout AND the shared
    // client are used.
    const src = fs.readFileSync(SERVICE_KT, 'utf8');
    assert.ok(/withTimeoutOrNull\s*\(\s*timeoutMs\s*\)/.test(src),
        'flush wait must be bounded by withTimeoutOrNull');
    assert.ok(/NodeControlClient\.flushShutdown\s*\(\s*\)/.test(src),
        'Kotlin must delegate to NodeControlClient.flushShutdown() so the bridge-token header is set (otherwise /shutdown/flush 401s in production)');
    // Match actual usage patterns (variable type, cast, instantiation) — not
    // KDoc prose. The pre-fix code had `var conn: HttpURLConnection?` and
    // `URL("http://127.0.0.1:8766/shutdown/flush").openConnection()`; the
    // post-fix code shouldn't have either form.
    assert.ok(!/:\s*HttpURLConnection\??|as\s+HttpURLConnection|URL\s*\(\s*"http:\/\/127\.0\.0\.1:8766/.test(src),
        'Kotlin must NOT roll its own HTTP client for the flush — the rolled-own version omitted the X-Bridge-Token header and 401\'d the endpoint');
});

test('R4 Copilot: timeout budget chain stays within outer 2000ms (HttpURLConnection isn\'t cancellable)', () => {
    // R4 Copilot: HttpURLConnection's blocking connect/read can't be
    // interrupted by withTimeoutOrNull on the outer coroutine. The
    // hard upper bound MUST therefore come from the underlying
    // connect+read timeouts, summed against the Node-side
    // summaryTimeoutMs. Pin both ends so a future "let's bump the
    // read timeout to 5000" change immediately fails this guard
    // instead of silently breaking the 2s service-teardown SLA.
    const NCC_KT = path.join(ROOT, 'app', 'src', 'main', 'java', 'com',
        'seekerclaw', 'app', 'bridge', 'NodeControlClient.kt');
    const ncc = fs.readFileSync(NCC_KT, 'utf8');
    const connect = parseInt((ncc.match(/CONNECT_TIMEOUT_MS\s*=\s*(\d+)/) || [])[1], 10);
    const read = parseInt((ncc.match(/READ_TIMEOUT_MS\s*=\s*(\d+)/) || [])[1], 10);
    assert.ok(Number.isFinite(connect) && Number.isFinite(read),
        'NodeControlClient must declare numeric CONNECT_TIMEOUT_MS + READ_TIMEOUT_MS');
    const ktWorstCase = connect + read;
    assert.ok(ktWorstCase <= 2000,
        `NodeControlClient timeout budget (CONNECT=${connect} + READ=${read} = ${ktWorstCase}ms) must fit within SeekerClawService.onDestroy() outer withTimeoutOrNull(2000)`);

    const ctrl = fs.readFileSync(CONTROL_JS, 'utf8');
    const summary = parseInt((ctrl.match(/summaryTimeoutMs:\s*(\d+)/) || [])[1], 10);
    assert.ok(Number.isFinite(summary),
        'internal-control-server.js /shutdown/flush must set summaryTimeoutMs');
    // Node-side flush must finish AND respond before Kotlin's read
    // timeout fires; need a small buffer for response stream + JSON
    // encode + socket write back to Kotlin.
    assert.ok(summary < read,
        `Node summaryTimeoutMs (${summary}) must be less than Kotlin READ_TIMEOUT_MS (${read}) so the flush response actually lands`);
    assert.ok(read - summary >= 200,
        `Node summaryTimeoutMs (${summary}) needs ≥200ms buffer below Kotlin READ_TIMEOUT_MS (${read}) for response encode + socket write — current buffer is ${read - summary}ms`);
});

test('NodeControlClient exposes flushShutdown that hits POST /shutdown/flush with auth', () => {
    // R3.1 Copilot: pin the auth-header behavior of the shared client
    // so a future refactor can't silently drop it. The endpoint
    // requires X-Bridge-Token (every POST does, per BAT-514's
    // internal-control-server contract).
    const NCC_KT = path.join(ROOT, 'app', 'src', 'main', 'java', 'com',
        'seekerclaw', 'app', 'bridge', 'NodeControlClient.kt');
    const src = fs.readFileSync(NCC_KT, 'utf8');
    assert.ok(/suspend\s+fun\s+flushShutdown\s*\(\s*\)/.test(src),
        'NodeControlClient must expose suspend fun flushShutdown()');
    assert.ok(/post\s*\(\s*"\/shutdown\/flush"/.test(src),
        'flushShutdown must POST to /shutdown/flush via the shared post() helper');
    // The shared post() helper sets the X-Bridge-Token header from
    // ServiceState.bridgeToken — these are pre-existing invariants
    // (since BAT-514) but pinning them here as well makes the
    // BAT-525 contract robust against drift in either layer.
    assert.ok(/AUTH_HEADER\s*=\s*"X-Bridge-Token"/.test(src),
        'NodeControlClient must declare the X-Bridge-Token auth header');
    assert.ok(/setRequestProperty\s*\(\s*AUTH_HEADER\s*,\s*token\s*\)/.test(src),
        'NodeControlClient.post() must set the X-Bridge-Token header on every request');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
