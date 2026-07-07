#!/usr/bin/env node
// test-sse-dump.js — raw SSE event dump for the Claude setup_token stream.
// Prints thinking / signature content-block events AS THEY ARRIVE (incremental,
// not buffered) so you can watch the wire during live debugging (the BAT-1033
// signature-drop class). LIVE — needs SETUP_TOKEN in testing/.env.
// Run: node testing/test-sse-dump.js
'use strict';
const https = require('https');
const { loadEnv, CC_BILLING_HEADER } = require('./lib');
loadEnv();

const TOKEN = process.env.SETUP_TOKEN || process.env.ANTHROPIC_SETUP_TOKEN;
if (!TOKEN) { console.error('❌ SETUP_TOKEN (or ANTHROPIC_SETUP_TOKEN) required in testing/.env'); process.exit(1); }

const BETA = 'prompt-caching-2024-07-31,oauth-2025-04-20,interleaved-thinking-2025-05-14';
const body = JSON.stringify({
    model: process.env.TEST_MODEL || 'claude-sonnet-5', max_tokens: 2048, stream: true,
    system: [{ type: 'text', text: CC_BILLING_HEADER }, { type: 'text', text: 'Use tools when appropriate.' }],
    tools: [{ name: 'get_weather', description: 'Weather', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
    messages: [{ role: 'user', content: 'Weather in Tbilisi? Use get_weather then tell me.' }],
});

const req = https.request({
    hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-beta': BETA, 'Authorization': `Bearer ${TOKEN}` },
}, (res) => {
    res.setEncoding('utf8'); // decode UTF-8 across chunk boundaries so a split multibyte char can't corrupt JSON
    if (res.statusCode !== 200) { let e = ''; res.on('data', (c) => e += c); res.on('end', () => console.error(`❌ HTTP ${res.statusCode}: ${e.slice(0, 300)}`)); return; }
    let buf = ''; // hold partial lines across chunks → truly incremental parse
    res.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const j = line.slice(5).trim(); if (!j || j === '[DONE]') continue;
            let p; try { p = JSON.parse(j); } catch { continue; }
            if (p.type === 'content_block_start' && p.content_block && (p.content_block.type === 'thinking' || p.content_block.type === 'redacted_thinking')) {
                console.log('START idx', p.index, JSON.stringify(p.content_block));
            }
            if (p.type === 'content_block_delta' && /thinking|signature/.test(p.delta?.type || '')) {
                console.log('DELTA idx', p.index, p.delta.type, JSON.stringify(p.delta).slice(0, 80));
            }
        }
    });
    res.on('end', () => console.log('— stream ended —'));
});
req.on('error', (e) => { console.error('❌ request error:', e.message); process.exit(1); });
req.setTimeout(60000, () => req.destroy(new Error('timeout')));
req.end(body);
