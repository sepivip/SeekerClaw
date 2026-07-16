// SeekerClaw — internal-control-server.js
// Loopback HTTP server bound to 127.0.0.1:8766. Single endpoint for
// internal control & introspection traffic between the main process
// (Kotlin) and Node.
//
// History:
//   - Pre-BAT-514: this lived inline in database.js as the "stats
//     server" — one endpoint (GET /stats/db-summary) for the Android UI
//     stats screen. Bound to 8766.
//   - BAT-514: extracted here. Same port (8766) — adding a new
//     `control-server.js` on a second port would EADDRINUSE-conflict.
//     New endpoints (POST /mcp/reconcile, POST /healthz) added with
//     bridge-token auth + per-endpoint rate-limit.
//
// This module exports `start(options)` / `stop()` / `getPort()`. It
// does NOT own the data — handlers are passed in via options:
//   - options.bridgeToken    : per-boot string for X-Bridge-Token auth
//   - options.getDbSummary   : () => object  (database.js hands this in)
//   - options.requestReconcile: (id?: string) => void  (mcp-client.js
//                              MCPManager hands this in)
//
// Why callbacks instead of requires: lets `main.js` wire dependencies
// in the right order (DB init → MCP manager init → control server
// start) without internal-control-server.js becoming a god module that
// requires database + mcp-client (which would create circular imports
// in the test harness).

'use strict';

const http = require('http');
const crypto = require('crypto');

const PORT = 8766;
const HOST = '127.0.0.1';
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_RECONCILE = 30; // 30 reconciles/min — drain coalesces, this is just intake throttle
const RATE_LIMIT_HEALTHZ = 60;   // 1/sec average is fine for a liveness probe

// BAT-1001 PR-B: DNS-rebind defense + IPv6 policy.
// The server binds only `127.0.0.1` (line 33). A browser doing a
// DNS-rebind attack would resolve `attacker.com` to 127.0.0.1 and the
// connection would land here, but the browser still sends
// `Host: attacker.com:8766` per RFC 7230 §5.4 — we reject any Host
// that isn't the bound loopback authority. Allowlist is a single
// literal (NOT sourced from PORT) so the allowed value is auditable
// at a glance. Case-insensitive compare (`Host: 127.0.0.1:8766` and
// `127.0.0.1:8766` already collapse, but `Host: LOCALHOST` etc. are
// rejected explicitly). IPv6 loopback `[::1]:8766` is NOT accepted
// (server doesn't dual-bind; accepting would be a policy/code
// mismatch per Codex BAT-1001 v1.1 #6). `localhost:8766` is rejected
// too — too many name-resolution surprises to allow.
const ALLOWED_HOST = '127.0.0.1:8766';

// Per-endpoint rate-limit state. Cleared on stop() so test harnesses
// don't leak state between cases.
const _buckets = new Map();

function _allow(endpoint, limit) {
    const now = Date.now();
    const arr = _buckets.get(endpoint) || [];
    // Drop stamps older than the window
    while (arr.length && now - arr[0] > RATE_LIMIT_WINDOW_MS) arr.shift();
    if (arr.length >= limit) {
        _buckets.set(endpoint, arr);
        return false;
    }
    arr.push(now);
    _buckets.set(endpoint, arr);
    return true;
}

// Sentinel error code so `_route` can distinguish "body exceeded
// limit" from a generic transport error and return 413 cleanly
// instead of letting the connection die with ECONNRESET. (Copilot
// R19 PR #352 finding.)
const _BODY_TOO_LARGE = 'BODY_TOO_LARGE';

function _readBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        let data = '';
        let len = 0;
        // `done` guard so a single oversized chunk doesn't fire both
        // reject() AND resolve() via subsequent `end`/`error` events.
        let done = false;
        const finish = (settle) => {
            if (done) return;
            done = true;
            settle();
        };
        req.on('data', (chunk) => {
            if (done) return;
            len += Buffer.byteLength(chunk);
            if (len > maxBytes) {
                const err = new Error('body too large');
                err.code = _BODY_TOO_LARGE;
                finish(() => reject(err));
                return;
            }
            data += chunk;
        });
        req.on('end', () => finish(() => resolve(data)));
        req.on('error', (err) => finish(() => reject(err)));
        // BAT-525 R3 Copilot: if the client (typically Kotlin's
        // SeekerClawService) times out and closes the socket before
        // sending `end`, neither `end` nor `error` fires — the await
        // would hang forever, leaking the request handler. Listen for
        // `aborted` (legacy) and `close` (always emitted on socket
        // disconnect) and reject so the route handler can return.
        // The `done` guard makes this safe to fire alongside an
        // already-resolved `end`/`error` (no-op if already settled).
        req.on('aborted', () => finish(() => reject(Object.assign(new Error('client aborted'), { code: 'ECONNABORTED' }))));
        req.on('close', () => finish(() => reject(Object.assign(new Error('client closed'), { code: 'ECONNCLOSED' }))));
    });
}

function _json(res, status, obj, extraHeaders) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {});
    res.writeHead(status, headers);
    res.end(JSON.stringify(obj));
}

let _server = null;
// BAT-1001 PR-B: per-request bridge-token getter (was a startup-frozen
// string `_bridgeToken`). main.js passes `getBridgeToken: () =>
// getBridgeToken()` so a Kotlin-side rotation (NodeControlClient
// reads ServiceState.bridgeToken per call → server now reads the
// matching live file per call) authenticates the next inbound POST
// without a server restart. Default `() => ''` makes the auth gate
// always reject when start() was called without the option — never
// short-circuits to "no token configured = allow".
let _getBridgeToken = () => '';
let _getDbSummary = null;
let _requestReconcile = null;
// BAT-525: flushShutdown is an async callback that drives Node's
// graceful-shutdown sequence (session summaries + dirty-DB flush)
// before Kotlin's `killProcess()`. Wired in main.js as
// `database.flushForShutdown` so this module doesn't need a direct
// `require('./database')` (which would create a circular import:
// database -> ... -> internal-control-server -> database).
let _flushShutdown = null;
// BAT-1155 D6: xAI OAuth token drain, run BEFORE the session-summary flush on USER_STOP
// so a just-rotated token pair reaches disk before the unavoidable killProcess() (else
// the next boot reloads a consumed refresh token). Wired in main.js as the active
// provider's bounded flushPendingPersist (300ms). No-op / absent for non-xAI providers.
let _xaiFlush = null;
let _logFn = console.log;

/**
 * Start the loopback control server. Idempotent — calling twice with
 * the same options is a no-op (returns the existing server).
 *
 * The handlers are stored at module scope so a future hot-reload of
 * one of them (e.g. swapping the MCP manager during test setup)
 * doesn't need to bring the server down.
 */
function start(options) {
    if (!options || typeof options !== 'object') {
        throw new Error('internal-control-server.start: options required');
    }
    // BAT-1001 PR-B: getBridgeToken (function) replaces the
    // startup-frozen bridgeToken (string). The function form is the
    // only supported option — the previous `bridgeToken: <string>`
    // option is intentionally NOT honored as a back-compat shim
    // because it would silently preserve the rotation bug v1.1 is
    // fixing. Existing tests have been updated to pass
    // `getBridgeToken: () => TOKEN` (constant getter == old behavior).
    _getBridgeToken = typeof options.getBridgeToken === 'function'
        ? options.getBridgeToken
        : () => '';
    _getDbSummary = typeof options.getDbSummary === 'function' ? options.getDbSummary : null;
    _requestReconcile = typeof options.requestReconcile === 'function' ? options.requestReconcile : null;
    _flushShutdown = typeof options.flushShutdown === 'function' ? options.flushShutdown : null;
    _xaiFlush = typeof options.xaiFlush === 'function' ? options.xaiFlush : null;
    _logFn = typeof options.logFn === 'function' ? options.logFn : console.log;

    if (_server) return _server;

    _server = http.createServer(async (req, res) => {
        try {
            await _route(req, res);
        } catch (err) {
            _logFn(`[ControlServer] handler error: ${err.message}`, 'ERROR');
            try { _json(res, 500, { error: 'internal' }); } catch (_) {}
        }
    });

    _server.on('error', (err) => {
        _logFn(`[ControlServer] server error (${err.code || 'UNKNOWN'}): ${err.message}`, 'ERROR');
    });

    _server.listen(PORT, HOST, () => {
        _logFn(`[ControlServer] Listening on ${HOST}:${PORT}`, 'INFO');
    });

    return _server;
}

// BAT-1001 PR-B: constant-time token compare with byte-length guard.
// `crypto.timingSafeEqual` throws on Buffer-length mismatch — we MUST
// pre-check, otherwise an attacker can probe the token's length by
// triggering 500s.
//
// Subtlety (Copilot PR #395 R2 finding): the length check is on
// **byte length**, not String `.length` (which is UTF-16 code units).
// A non-ASCII input like `Buffer.from('ñ', 'utf8').length === 2`
// while `'ñ'.length === 1`. If we length-checked on `.length` and
// then fed Buffers to timingSafeEqual, an attacker sending
// X-Bridge-Token: '<UTF-8-multibyte string with the same JS .length
// as the expected token>' would pass the pre-check, hit timingSafeEqual
// with mismatched Buffer lengths, throw, get a 500 from the outer
// try/catch — reintroducing the length-probe surface this helper
// exists to close. Solution: build the Buffers first, then compare
// buffer.length (== byte length) before timingSafeEqual.
//
// Both inputs are strict-type-checked to be strings (no coercion —
// a non-string header from header folding etc. returns false cleanly
// instead of throwing). Empty expected → reject (we never short-
// circuit to "no token = allow").
function _safeTokenEq(expected, actual) {
    if (typeof expected !== 'string' || typeof actual !== 'string') return false;
    if (expected.length === 0) return false;
    const expectedBuf = Buffer.from(expected, 'utf8');
    const actualBuf = Buffer.from(actual, 'utf8');
    if (expectedBuf.length !== actualBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

async function _route(req, res) {
    const method = (req.method || 'GET').toUpperCase();
    const url = req.url || '/';

    // BAT-1001 PR-B: DNS-rebind defense, applied BEFORE any path
    // matching so the gate covers `/stats/db-summary` too (and any
    // future unauthenticated endpoint). Two layers:
    //
    //   1. Host header allowlist — rejects DNS-rebind attempts where
    //      the browser resolved attacker.com → 127.0.0.1 but is still
    //      sending `Host: attacker.com:8766` per RFC 7230 §5.4. Only
    //      `127.0.0.1:8766` is accepted (case-insensitive). `[::1]:8766`
    //      and `localhost:8766` are rejected — the server binds only
    //      127.0.0.1 (no dual-bind) and accepting other Hosts would
    //      create a policy/code mismatch.
    //
    //   2. Origin header rejection — any non-empty Origin header
    //      means a browser sent the request. Every legitimate caller
    //      (AndroidBridge.kt:954-975 proxy via HttpURLConnection,
    //      Kotlin NodeControlClient, in-process tests) sends NO
    //      Origin. Deny-all is strictly safer than an allowlist
    //      while we have zero legitimate browser callers (per
    //      Codex BAT-1001 v1.1 #4 sign-off).
    //
    // Status code 403 (not 400) since the request reached the
    // listener cleanly — it's the *origin* of the call that we're
    // rejecting, not a malformed wire.
    //
    // Copilot R3 #3349684637: `req.headers.host` and `.origin` are
    // typed as `string | string[] | undefined` in Node's HTTP types.
    // Today Node's HTTP parser discards duplicate Host headers (only
    // the first wins, kept as string) — but Copilot is correct that
    // a future parser change OR a pathological proxy chain could
    // surface an array. Calling `.toLowerCase()` on a non-string
    // would throw → outer try/catch → 500, reintroducing the DoS
    // surface this gate exists to close. Defensive: explicit
    // typeof checks, anything non-string rejects 403 cleanly.
    const rawHost = req.headers.host;
    if (typeof rawHost !== 'string') {
        return _json(res, 403, { error: 'host not allowed' });
    }
    const hostHeader = rawHost.toLowerCase();
    if (hostHeader !== ALLOWED_HOST) {
        return _json(res, 403, { error: 'host not allowed' });
    }
    const rawOrigin = req.headers.origin;
    if (typeof rawOrigin === 'string') {
        // Empty string passes (some HTTP libs always set the header);
        // any non-empty value is browser-initiated → reject.
        if (rawOrigin.length > 0) {
            return _json(res, 403, { error: 'origin not allowed' });
        }
    } else if (rawOrigin !== undefined) {
        // Non-string non-undefined Origin (array from duplicate
        // headers, or anything else exotic) → definitely not a
        // legitimate Kotlin caller, reject.
        return _json(res, 403, { error: 'origin not allowed' });
    }

    // GET /stats/db-summary — preserved BAT-31 behavior. No bridge-
    // token auth, no rate-limit. AndroidBridge proxies this from its
    // own (already-authed + rate-limited) /stats/db-summary endpoint,
    // so the inner hop doesn't need to reauthenticate. The new Host/
    // Origin gate above now covers exfil risk — a browser can't reach
    // this endpoint via DNS-rebind even though it's unauthenticated.
    if (method === 'GET' && url === '/stats/db-summary') {
        if (!_getDbSummary) return _json(res, 503, { error: 'stats unavailable' });
        try {
            return _json(res, 200, _getDbSummary());
        } catch (err) {
            _logFn(`[ControlServer] getDbSummary failed: ${err.message}`, 'ERROR');
            return _json(res, 500, { error: 'stats failed' });
        }
    }

    // All MCP / healthz endpoints are POST + bridge-token-authed +
    // rate-limited.
    if (method !== 'POST') {
        return _json(res, 405, { error: 'method not allowed' });
    }

    // BAT-1001 PR-B: bridge-token auth via per-request getter +
    // constant-time compare. The getter (wired from main.js as
    // `() => getBridgeToken()`) re-reads `filesDir/bridge_token` on
    // every call so a Kotlin rotation is picked up without restarting
    // the server. _safeTokenEq length-guards before timingSafeEqual
    // so a length mismatch returns 401 cleanly instead of throwing
    // 500. Empty `expected` (file missing / getter returns '') also
    // rejects — we never short-circuit to "no token = allow".
    const headerToken = req.headers['x-bridge-token'];
    const expected = _getBridgeToken();
    if (!_safeTokenEq(expected, headerToken)) {
        return _json(res, 401, { error: 'unauthorized' });
    }

    if (url === '/mcp/reconcile') {
        if (!_allow('/mcp/reconcile', RATE_LIMIT_RECONCILE)) {
            return _json(res, 429, { error: 'rate limit exceeded' }, { 'Retry-After': '60' });
        }
        // Body is optional `{ id?: string }` (typically <50 bytes).
        // JSON parse failures are accepted silently and treated as
        // full-reconcile — defensive against a buggy caller /
        // truncated body. Body-size overflow is a different class of
        // failure (oversized request implies a misbehaving or
        // hostile caller); return 413 cleanly and skip the reconcile
        // so we don't do work for an already-rejected request.
        // (Copilot R19 PR #352 finding.)
        let raw
        try {
            raw = await _readBody(req, 4096)
        } catch (err) {
            if (err && err.code === _BODY_TOO_LARGE) {
                return _json(res, 413, { error: 'request body too large' })
            }
            // Other transport errors: fall back to full-reconcile
            // (matches the prior tolerant behavior).
            raw = ''
        }
        let id = null;
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed.id === 'string' && parsed.id.length > 0) {
                    id = parsed.id;
                }
            } catch (_) { /* full reconcile on parse failure */ }
        }
        if (_requestReconcile) {
            try { _requestReconcile(id); } catch (err) {
                _logFn(`[ControlServer] requestReconcile threw: ${err.message}`, 'ERROR');
            }
        }
        return _json(res, 200, {});
    }

    if (url === '/healthz') {
        if (!_allow('/healthz', RATE_LIMIT_HEALTHZ)) {
            return _json(res, 429, { error: 'rate limit exceeded' }, { 'Retry-After': '60' });
        }
        return _json(res, 200, { ok: true });
    }

    if (url === '/quiesce') {
        // BAT-1155 Codex re-review blocker: (re)ARM the quiesce lease. Kotlin's lease renewer
        // POSTs this on an independent (non-main-looper) cadence from the moment durability is
        // proven until the process kill begins, so a delayed main-looper handoff can't let the
        // lease expire and admit a new rotation between the durability ack and teardown. Idempotent.
        require('./quiesce').quiesce();
        return _json(res, 200, { ok: true });
    }

    if (url === '/unquiesce') {
        // BAT-1155 Codex re-review blocker: Kotlin calls this when a controlled Stop is
        // ABANDONED (durability could not be established and the service is kept alive instead
        // of killed) so the agent resumes accepting turns/heartbeats/rotations. Idempotent.
        require('./quiesce').unquiesce();
        return _json(res, 200, { ok: true });
    }

    if (url === '/shutdown/flush') {
        // BAT-525: Android user-Stop kills :node via `killProcess()`,
        // which bypasses Node's SIGTERM/SIGINT handlers (nodejs-mobile
        // runs Node in-process via JNI). Kotlin calls this endpoint
        // first and waits ≤2s, giving Node a chance to flush pending
        // session summaries + debounced SQL.js mutations before the
        // unavoidable kill. Without this hook, the last ~60s of
        // `api_request_log` rows in the BAT-523 debounce window are
        // lost on every user-Stop.
        if (!_flushShutdown) {
            return _json(res, 503, { error: 'flush unavailable' });
        }
        // BAT-1155 Codex re-review blocker: QUIESCE first — atomically stop accepting new
        // turns/heartbeats/token rotations BEFORE draining, so nothing can consume the on-disk
        // T0 and mint a fresh unsafe pair between this "disk safe" acknowledgement and the kill.
        // The process stays quiesced until teardown; if the Stop is abandoned (kept alive),
        // Kotlin calls /unquiesce to resume normal operation.
        require('./quiesce').quiesce();
        // R1 Copilot: drain the request body before awaiting the
        // flush. Body is currently expected to be `{}` (≤256 bytes
        // is generous). Leaving it unread can cause keep-alive
        // connection issues and unnecessary buffering on the
        // listener. The shared _readBody also handles abort/close
        // (R3) so a Kotlin-side timeout doesn't leak this handler.
        // BAT-1155 hotfix: a `{"durabilityOnly":true}` body makes this endpoint answer the
        // brick-critical durability question FAST (xAI drain only) and SKIP the best-effort
        // session summary — see the durabilityOnly short-circuit after the drain. The pre-stop
        // gate and onDestroy guard send this so a slow summary can't null out their durability
        // answer. Absent/`{}` body preserves the full flush (summary + db) for a real shutdown.
        let _durabilityOnly = false;
        try {
            const _rawBody = await _readBody(req, 256);
            if (_rawBody) {
                try { _durabilityOnly = !!JSON.parse(_rawBody).durabilityOnly; } catch (_) { /* {} → full flush */ }
            }
        } catch (err) {
            // Body-too-large is unlikely (Kotlin sends `{}`) but
            // surface as 413 for symmetry with the other endpoints.
            // Other transport errors (abort/close) reach here too —
            // the client is gone, but we still attempt the flush
            // because the user-Stop intent is to persist state.
            // Log and continue rather than abort the flush.
            if (err && err.code === _BODY_TOO_LARGE) {
                return _json(res, 413, { error: 'request body too large' });
            }
            _logFn(`[ControlServer] /shutdown/flush body read failed (${err.code || 'UNKNOWN'}): ${err.message}`, 'WARN');
        }
        // R2 Copilot: surface flush failures to the caller. Pre-fix
        // returned 200 even when `flushForShutdown` threw (the
        // original PR caught and logged but returned `{ok:true}`).
        // Kotlin's "flush acknowledged" log would lie in exactly the
        // failure mode this endpoint exists to handle. Now: 200 +
        // `{ok:true}` only on clean success; 500 + `{ok:false,
        // error:...}` if `flushShutdown` rejects.
        // BAT-1155 D6: drain the xAI OAuth token persist FIRST — token durability
        // outranks the session summary. Bounded to 300ms inside flushPendingPersist so
        // the endpoint total stays ≤1700ms (300 drain + 1200 summary + overhead). Never
        // throws; a failed drain must not block the summary flush that follows.
        // BAT-1155 verify major-2: report whether a rotated pair is STILL stranded
        // after the drain. The Kotlin controlled-stop durability gate fires ONLY on
        // this signal, so a benign summary-flush hiccup can't force a healthy family
        // to re-pair.
        let xaiPending = false;
        // Codex re-review blocker-2: the AUTHORITATIVE "on-disk record unsafe to boot from"
        // signal — a superset of pendingPersist that also covers convergence-exhausted
        // (T1 discarded, consumed T0 on disk) and a failed dead-family mark (disk still
        // says the revoked family is live). The Kotlin gate keys on THIS, not pendingPersist.
        let xaiDiskUnsafe = false;
        // Codex re-review major-2: separate metadata — the notify-once mark is still unpersisted.
        // Not a brick (won't gate the kill); surfaced for observability + the shutdown drain attempt.
        let xaiNotifyPending = false;
        if (_xaiFlush) {
            try {
                const r = await _xaiFlush();
                xaiPending = !!(r && r.pendingPersist);
                xaiDiskUnsafe = !!(r && r.diskUnsafe);
                xaiNotifyPending = !!(r && r.notifyPending);
            } catch (err) {
                // flushPendingPersist is designed never to throw; if it does, a rotated
                // pair may be stranded → fail closed so the Kotlin gate fires.
                xaiPending = true;
                xaiDiskUnsafe = true;
                _logFn(`[ControlServer] /shutdown/flush xAI token drain failed: ${err.message}`, 'WARN');
            }
        }
        // BAT-1155 hotfix: the pre-stop durability gate and the onDestroy guard need ONLY the
        // diskUnsafe signal, which the xAI drain above has already computed (≤300ms). Respond
        // NOW — WITHOUT waiting on the best-effort, up-to-1200ms, sometimes-timing-out session
        // summary. Blocking the durability answer behind the summary is what let a slow summary
        // exceed the Kotlin gate's per-round read budget → return null → misread as "Node
        // unreachable" → fail-closed markReauth on a VALID fresh sign-in (the soak brick). The
        // terminal onDestroy path still flushes the summary via a separate (non-durabilityOnly)
        // call, so no session-summary durability is lost.
        if (_durabilityOnly) {
            return _json(res, 200, { ok: true, pendingPersist: xaiPending, diskUnsafe: xaiDiskUnsafe, notifyPending: xaiNotifyPending });
        }
        try {
            // R4 Copilot: summaryTimeoutMs reduced 1500 → 1200 so the
            // Kotlin-side worst-case wall time (CONNECT 250 + READ
            // 1500 = 1750ms) fits within SeekerClawService.onDestroy()'s
            // outer withTimeoutOrNull(2000) budget. HttpURLConnection
            // isn't cooperatively cancellable, so the underlying
            // timeouts must guarantee the bound — the outer coroutine
            // timeout can't interrupt an in-flight blocking I/O. 1200ms
            // still covers realistic flush profiles (a real flush is
            // <100ms; the budget exists for an unresponsive SQL.js
            // reentry case).
            //
            // R5 Copilot: flushShutdown returns a {ok, summaryFailed?,
            // dbFailed?} result instead of just resolving. Pre-fix it
            // caught all errors internally and resolved unconditionally,
            // so this endpoint always returned 200/{ok:true} even when
            // the flush genuinely failed — Kotlin's "flush acknowledged"
            // log was misleading in the exact failure mode this
            // endpoint exists to surface. Now: 200 only on a clean
            // result.ok=true; 500/{ok:false, ...details} when either
            // the summary path threw OR saveDatabase reported an I/O
            // error. The catch below covers the rare case where
            // flushShutdown itself throws (shouldn't happen — all
            // step errors are caught inside — but defense-in-depth).
            const result = await _flushShutdown('USER_STOP', { summaryTimeoutMs: 1200 });
            if (result && result.ok) {
                return _json(res, 200, { ok: true, pendingPersist: xaiPending, diskUnsafe: xaiDiskUnsafe, notifyPending: xaiNotifyPending });
            }
            const detail = result || {};
            // R8 Copilot: log partial flush at WARN, not ERROR. A partial
            // flush is best-effort degradation (one summary timed out OR
            // saveDatabase hit transient I/O); the caller proceeds with
            // killProcess() either way and the next service start
            // reconciles via mcp_servers.json + AutoResume. Match the
            // gracefulShutdown convention in database.js so operators
            // don't treat partial results as fatal.
            _logFn(
                `[ControlServer] /shutdown/flush partial: summary=${detail.summaryFailed || 'ok'} db=${detail.dbFailed ? 'failed' : 'ok'}`,
                'WARN',
            );
            return _json(res, 500, {
                ok: false,
                summaryFailed: detail.summaryFailed || null,
                dbFailed: !!detail.dbFailed,
                pendingPersist: xaiPending,
                diskUnsafe: xaiDiskUnsafe,
                notifyPending: xaiNotifyPending,
            });
        } catch (err) {
            _logFn(`[ControlServer] /shutdown/flush threw: ${err.message}`, 'ERROR');
            return _json(res, 500, { ok: false, error: err.message, pendingPersist: xaiPending, diskUnsafe: xaiDiskUnsafe, notifyPending: xaiNotifyPending });
        }
    }

    return _json(res, 404, { error: 'not found' });
}

function stop() {
    _buckets.clear();
    if (_server) {
        const s = _server;
        _server = null;
        return new Promise((resolve) => s.close(() => resolve()));
    }
    return Promise.resolve();
}

function getPort() { return PORT; }

module.exports = { start, stop, getPort, PORT };
