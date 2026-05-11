// tests/jupiter-ultra/lib/jupiter.js
//
// Minimal Jupiter REST client for tests. Mirrors the production calls but
// surfaces FULL response bodies (the production solana.js drops Ultra's
// errorCode/errorMessage on `!o.transaction` — we keep them so we can see
// why Ultra refused to build a tx).

'use strict';

const https = require('https');

function request({ hostname, path, method = 'GET', headers = {}, body = null, timeoutMs = 15000 }) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname,
            path,
            method,
            headers: { 'Accept': 'application/json', ...headers },
        };
        const req = https.request(opts, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                let data;
                try { data = JSON.parse(raw); } catch (_) { data = raw; }
                resolve({ status: res.statusCode, headers: res.headers, data, raw });
            });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => { req.destroy(new Error(`timeout after ${timeoutMs}ms`)); });
        if (body !== null) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}

// Jupiter Ultra — get order (quote + unsigned tx in one call).
// Mirrors solana.js:jupiterUltraOrder but returns the full envelope.
async function ultraOrder({ apiKey, inputMint, outputMint, amount, taker }) {
    const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount: String(amount),
        taker,
    });
    return request({
        hostname: 'api.jup.ag',
        path: `/ultra/v1/order?${params.toString()}`,
        method: 'GET',
        headers: { 'x-api-key': apiKey },
    });
}

// Jupiter Ultra — execute signed transaction.
async function ultraExecute({ apiKey, signedTransaction, requestId }) {
    return request({
        hostname: 'api.jup.ag',
        path: '/ultra/v1/execute',
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
        body: { signedTransaction, requestId },
        timeoutMs: 30000,
    });
}

// Public quote endpoint (no key required) — useful for sanity check.
async function publicQuote({ inputMint, outputMint, amount, slippageBps = 100 }) {
    const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount: String(amount),
        slippageBps: String(slippageBps),
    });
    return request({
        hostname: 'public.jupiterapi.com',
        path: `/quote?${params.toString()}`,
        method: 'GET',
    });
}

module.exports = { request, ultraOrder, ultraExecute, publicQuote };
