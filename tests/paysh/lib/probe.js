// tests/paysh/lib/probe.js
//
// Probe helper for pay.sh endpoints. Hits a URL once with a configurable
// HTTP method and captures the full response (status, headers, body).
// Returns the raw capture; the caller is responsible for piping it
// through `sanitize.js` before committing.
//
// Per BAT-582 contract addendum v1.6 (Codex sign-off 2026-05-10):
//   - Default: probe-only. We send NO X-PAYMENT, NO PAYMENT-SIGNATURE.
//     Paid endpoints will return 402 with their requirements — that's
//     exactly what we want to capture.
//   - Rate: 1 req/sec (caller-enforced — see probe-all.js)
//   - Timeout: 15s per request

'use strict';

const https = require('https');
const http  = require('http');
const { URL } = require('url');

function probe({ url, method = 'GET', headers = {}, body = null, timeoutMs = 15000 }) {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const opts = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers: {
            'Accept': 'application/json',
            'User-Agent': 'SeekerClaw-paysh-probe/1.0 (+https://github.com/sepivip/SeekerClaw)',
            ...headers,
        },
    };
    if (method !== 'GET' && method !== 'HEAD' && body !== null) {
        const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
        opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/json';
        opts.headers['Content-Length'] = Buffer.byteLength(bodyStr, 'utf8');
    }
    return new Promise((resolve) => {
        const startedAt = Date.now();
        const req = lib.request(opts, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                let bodyJson = null;
                try { bodyJson = JSON.parse(raw); } catch (_) { /* leave null */ }
                resolve({
                    url,
                    method,
                    status: res.statusCode,
                    headers: res.headers,
                    body: bodyJson !== null ? bodyJson : raw,
                    bodyBytes: Buffer.byteLength(raw, 'utf8'),
                    durationMs: Date.now() - startedAt,
                });
            });
        });
        req.on('error', (e) => {
            resolve({ url, method, error: 'fetch_failed', reason: e.message, durationMs: Date.now() - startedAt });
        });
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`probe timeout after ${timeoutMs}ms`));
        });
        if (method !== 'GET' && method !== 'HEAD' && body !== null) {
            const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
            req.write(bodyStr);
        }
        req.end();
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { probe, sleep };
