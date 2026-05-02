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

const PORT = 8766;
const HOST = '127.0.0.1';
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_RECONCILE = 30; // 30 reconciles/min — drain coalesces, this is just intake throttle
const RATE_LIMIT_HEALTHZ = 60;   // 1/sec average is fine for a liveness probe

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
let _bridgeToken = null;
let _getDbSummary = null;
let _requestReconcile = null;
// BAT-525: flushShutdown is an async callback that drives Node's
// graceful-shutdown sequence (session summaries + dirty-DB flush)
// before Kotlin's `killProcess()`. Wired in main.js as
// `database.flushForShutdown` so this module doesn't need a direct
// `require('./database')` (which would create a circular import:
// database -> ... -> internal-control-server -> database).
let _flushShutdown = null;
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
    _bridgeToken = typeof options.bridgeToken === 'string' ? options.bridgeToken : '';
    _getDbSummary = typeof options.getDbSummary === 'function' ? options.getDbSummary : null;
    _requestReconcile = typeof options.requestReconcile === 'function' ? options.requestReconcile : null;
    _flushShutdown = typeof options.flushShutdown === 'function' ? options.flushShutdown : null;
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

async function _route(req, res) {
    const method = (req.method || 'GET').toUpperCase();
    const url = req.url || '/';

    // GET /stats/db-summary — preserved BAT-31 behavior. No auth, no
    // rate-limit. AndroidBridge proxies this from its own (already-
    // authed + rate-limited) /stats/db-summary endpoint, so the inner
    // hop doesn't need to reauthenticate. Keeping it open also matches
    // the pre-BAT-514 contract — no UI behaviour change.
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

    // Bridge-token auth for the new endpoints (NOT /stats — see above).
    const headerToken = req.headers['x-bridge-token'];
    if (!_bridgeToken || headerToken !== _bridgeToken) {
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
        // R1 Copilot: drain the request body before awaiting the
        // flush. Body is currently expected to be `{}` (≤256 bytes
        // is generous). Leaving it unread can cause keep-alive
        // connection issues and unnecessary buffering on the
        // listener. The shared _readBody also handles abort/close
        // (R3) so a Kotlin-side timeout doesn't leak this handler.
        try {
            await _readBody(req, 256);
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
                return _json(res, 200, { ok: true });
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
            });
        } catch (err) {
            _logFn(`[ControlServer] /shutdown/flush threw: ${err.message}`, 'ERROR');
            return _json(res, 500, { ok: false, error: err.message });
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
