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
        req.on('data', (chunk) => {
            if (done) return;
            len += Buffer.byteLength(chunk);
            if (len > maxBytes) {
                done = true;
                const err = new Error('body too large');
                err.code = _BODY_TOO_LARGE;
                reject(err);
                return;
            }
            data += chunk;
        });
        req.on('end', () => {
            if (done) return;
            done = true;
            resolve(data);
        });
        req.on('error', (err) => {
            if (done) return;
            done = true;
            reject(err);
        });
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
