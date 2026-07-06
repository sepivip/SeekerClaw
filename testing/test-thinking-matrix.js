#!/usr/bin/env node
// test-thinking-matrix.js — definitive per-model thinking-shape matrix on the
// RAW API-KEY path. One request per (model × shape); reports 200/400 so we get
// the exact extended-vs-adaptive mapping straight from the API (no doc-trust).
//
// Setup: ANTHROPIC_API_KEY=sk-ant-api03-… in testing/.env
// Run:   node testing/test-thinking-matrix.js
'use strict';

const https = require('https');
const { loadEnv } = require('./lib');
loadEnv();

// Registry reasoning models (haiku-4-5 is reasoningSupport:'no' → SeekerClaw
// never sends a thinking param, so it's N/A here).
const MODELS = ['claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-5', 'claude-sonnet-4-6'];
const BETA = 'prompt-caching-2024-07-31,interleaved-thinking-2025-05-14'; // api_key path
const SHAPES = [
    { name: 'extended', thinking: { type: 'enabled', budget_tokens: 2000 } },
    { name: 'adaptive', thinking: { type: 'adaptive' } },
];

function httpPost(key, bodyObj) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-beta': BETA, 'x-api-key': key },
        }, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => { let p; try { p = JSON.parse(d); } catch { p = d; } resolve({ status: res.statusCode, data: p }); }); });
        req.on('error', reject); req.setTimeout(60000, () => req.destroy(new Error('timeout')));
        req.write(JSON.stringify(bodyObj)); req.end();
    });
}

(async () => {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) { console.error('❌ Set ANTHROPIC_API_KEY in testing/.env'); process.exit(1); }
    console.log('🧪 Per-model thinking-shape matrix (raw api-key path)\n');
    console.log('model'.padEnd(20) + 'extended'.padEnd(14) + 'adaptive');
    console.log('─'.repeat(48));
    for (const model of MODELS) {
        const cells = [];
        for (const shape of SHAPES) {
            const r = await httpPost(key, { model, max_tokens: 1024, thinking: shape.thinking, messages: [{ role: 'user', content: 'Say hi in one word.' }] });
            if (r.status === 200) cells.push('200 ✅');
            else {
                const m = r.data?.error?.message || JSON.stringify(r.data);
                cells.push(`${r.status} ${/not supported/i.test(m) ? '❌ removed' : '❌ ' + m.slice(0, 24)}`);
            }
            await new Promise((res) => setTimeout(res, 900));
        }
        console.log(model.padEnd(20) + cells[0].padEnd(14) + cells[1]);
    }
    console.log('\n→ "extended 400 / adaptive 200" = must migrate to adaptive.  "extended 200" = keep as-is.');
})();
