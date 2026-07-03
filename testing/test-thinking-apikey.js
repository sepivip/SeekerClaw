#!/usr/bin/env node
// test-thinking-apikey.js — settles BAT-1033 open question #2 (the adaptive/
// budget_tokens migration) on the RAW API-KEY path — the common dApp Store
// user path (QR payload carries anthropic_api_key), which the setup_token
// probes never covered.
//
// Replicates EXACTLY what SeekerClaw sends on api_key auth (claude.js
// buildHeaders + formatSystemPrompt):
//   - header:  x-api-key: <key>            (NOT Authorization: Bearer)
//   - beta:    prompt-caching-2024-07-31,interleaved-thinking-2025-05-14
//              (NO oauth-2025-04-20 — that's setup_token only)
//   - system:  plain instruction, NO CC billing-header block (setup_token only)
//
// Question it answers, per model, for /think-ON:
//   extended {type:'enabled', budget_tokens}  → 200 or 400?  (is the migration LIVE for api-key users?)
//   adaptive {type:'adaptive'}                → 200?          (does the proposed fix work on api-key?)
//
// Setup: ANTHROPIC_API_KEY=sk-ant-api03-… in testing/.env
// Run:   node testing/test-thinking-apikey.js
'use strict';

const https = require('https');
const { loadEnv } = require('./lib');
loadEnv();

const MODELS = (process.env.TEST_MODELS && process.env.TEST_MODELS.trim() !== 'all')
    ? process.env.TEST_MODELS.split(',').map((s) => s.trim()).filter(Boolean)
    : ['claude-opus-4-8', 'claude-sonnet-5'];

// api_key path betas — NO oauth. Mirrors claude.js:356.
const BETA = 'prompt-caching-2024-07-31,interleaved-thinking-2025-05-14';

const CONFIGS = [
    { name: 'off      ', thinking: null },
    { name: 'extended ', thinking: { type: 'enabled', budget_tokens: 2000 } },
    { name: 'adaptive ', thinking: { type: 'adaptive' } },
];

const TOOL = { name: 'get_weather', description: 'Get the current weather for a city.', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } };
const USER_MSG = 'What is the weather in Tbilisi right now? Use the get_weather tool, then tell me.';
// api_key path: NO billing-header system block (formatSystemPrompt adds it only for setup_token).
const sys = () => [{ type: 'text', text: 'You are a helpful assistant. Use tools when appropriate.' }];

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

async function probe(model, key, cfg) {
    const base = { model, max_tokens: 4096, stream: false, system: sys(), tools: [TOOL] };
    if (cfg.thinking) base.thinking = cfg.thinking;

    const r1 = await httpPost(key, { ...base, messages: [{ role: 'user', content: USER_MSG }] });
    if (r1.status !== 200) {
        const msg = r1.data?.error?.message || JSON.stringify(r1.data);
        const isBudget = /budget_tokens|thinking\.type|thinking\.budget/i.test(msg);
        console.log(`  [${cfg.name}] R1 ❌ ${r1.status} ${isBudget ? '🎯 budget/thinking rejected' : ''}— ${msg.slice(0, 90)}`);
        return;
    }
    const content = Array.isArray(r1.data.content) ? r1.data.content : [];
    const thinking = content.filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking');
    const toolUse = content.find((b) => b.type === 'tool_use');
    const tdesc = thinking.map((t) => t.type === 'thinking'
        ? `thinking(len=${(t.thinking || '').trim().length},sig=${t.signature ? 'y' : 'n'})`
        : `redacted(len=${(t.data || '').length})`).join('+') || 'none';

    let r2 = 'n/a (no tool_use)';
    if (toolUse) {
        const rr = await httpPost(key, { ...base, messages: [
            { role: 'user', content: USER_MSG },
            { role: 'assistant', content },  // verbatim
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: '{"temp_c":18,"condition":"clear"}' }] },
        ] });
        const m = rr.data?.error?.message || '';
        r2 = rr.status === 200 ? '200 ✅'
            : `${rr.status} ❌ ${/each thinking block must contain thinking/i.test(m) ? '🎯 THE BUG' : m.slice(0, 55)}`;
    }
    console.log(`  [${cfg.name}] R1 blocks=[${content.map((b) => b.type).join(',')}] thinking=${tdesc} | REPLAY=${r2}`);
}

(async () => {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) { console.error('❌ Set ANTHROPIC_API_KEY in testing/.env'); process.exit(1); }
    if (!/^sk-ant-/.test(key)) { console.error('❌ ANTHROPIC_API_KEY does not look like a raw sk-ant-… key'); process.exit(1); }
    console.log('🧪 BAT-1033 #2 — RAW API-KEY path (x-api-key, no billing masquerade) — is budget_tokens live?');
    for (const model of MODELS) {
        console.log(`\n=== ${model} ===`);
        for (const cfg of CONFIGS) { await probe(model, key, cfg); await new Promise((r) => setTimeout(r, 1200)); }
    }
    console.log('\nKey question: does [extended] 400 here? If yes → migration is LIVE for api-key users → v2.1.1.');
})();
