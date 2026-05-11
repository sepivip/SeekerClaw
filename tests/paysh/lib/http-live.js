// tests/paysh/lib/http-live.js
//
// HTTP fetch helper compatible with X402Protocol.settle's expected
// _fetchWithLimits signature. Production uses pinned-IP fetch (from
// agent_pay) to defend against mid-flight DNS rebinding; tests do
// regular DNS resolve since we're hitting public pay.sh services
// from a dev machine.
//
// Signature: (parsedUrl, pinnedIp, pinnedFamily, headers, timeoutMs) → resp
// resp shape: { status, headers, bodyJson } on success
//             { error, reason } on transport failure

'use strict';

const https = require('https');
const http  = require('http');

function fetchLive(parsed, _pinnedIp, _pinnedFamily, extraHeaders, timeoutMs = 30000, options = {}) {
    const method = options.method || 'GET';
    const requestBody = options.body || null;
    const lib = parsed.protocol === 'http:' ? http : https;
    return new Promise((resolve) => {
        const baseHeaders = {
            'Accept': 'application/json',
            'User-Agent': 'SeekerClaw-paysh-test/1.0',
            ...(extraHeaders || {}),
        };
        if (requestBody) {
            baseHeaders['Content-Type'] = 'application/json';
            baseHeaders['Content-Length'] = Buffer.byteLength(requestBody);
        }
        const opts = {
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + (parsed.search || ''),
            method,
            headers: baseHeaders,
            timeout: timeoutMs,
        };
        const req = lib.request(opts, (res) => {
            const chunks = [];
            let total = 0;
            res.on('data', (chunk) => {
                chunks.push(chunk);
                total += chunk.length;
                if (total > 1_000_000) {
                    req.destroy(new Error('response_too_large'));
                }
            });
            res.on('end', () => {
                const bodyBuf = Buffer.concat(chunks);
                const bodyStr = bodyBuf.toString('utf8');
                let bodyJson = null;
                try { bodyJson = bodyStr ? JSON.parse(bodyStr) : null; } catch (_) { /* non-JSON body */ }
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: bodyStr,
                    bodyJson,
                    bodyBytes: bodyBuf.length,
                });
            });
            res.on('error', (e) => resolve({ error: 'response_error', reason: e.message }));
        });
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.on('error', (e) => {
            if (e.message === 'response_too_large') return resolve({ error: 'response_too_large', reason: 'body exceeded 1MB cap' });
            if (e.message === 'timeout') return resolve({ error: 'timeout', reason: `request exceeded ${timeoutMs}ms` });
            resolve({ error: 'request_error', reason: e.message });
        });
        if (requestBody) req.write(requestBody);
        req.end();
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { fetchLive, sleep };
