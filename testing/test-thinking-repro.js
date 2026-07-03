#!/usr/bin/env node
// test-thinking-repro.js — LIVE recreation of the BAT-1033 / v2.1.1 bug.
//
// Replicates SeekerClaw's production request (setup_token + interleaved-thinking
// beta + a tool) across 3 thinking configs per model, then a REPLAY round to
// detect the "each thinking block must contain thinking" 400:
//   - off      : no thinking param            (/think OFF)
//   - extended : {type:enabled, budget_tokens}(/think ON — what SeekerClaw sends today)
//   - adaptive : {type:adaptive}              (the proposed fix)
//
// Run for claude-opus-4-8 (works in prod) + claude-sonnet-5 (breaks).
// Setup: SETUP_TOKEN=sk-ant-oat01-… in testing/.env    Run: node testing/test-thinking-repro.js
'use strict';

const https = require('https');
const { loadEnv, CC_BILLING_HEADER } = require('./lib');
loadEnv();

const MODELS = (process.env.TEST_MODELS && process.env.TEST_MODELS.trim() !== 'all')
    ? process.env.TEST_MODELS.split(',').map((s) => s.trim()).filter(Boolean)
    : ['claude-opus-4-8', 'claude-sonnet-5'];

const BETA = 'prompt-caching-2024-07-31,oauth-2025-04-20,interleaved-thinking-2025-05-14';

const CONFIGS = [
    { name: 'off      ', thinking: null },
    { name: 'extended ', thinking: { type: 'enabled', budget_tokens: 2000 } },
    { name: 'adaptive ', thinking: { type: 'adaptive' } },
];

const TOOL = { name: 'get_weather', description: 'Get the current weather for a city.', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } };
const USER_MSG = 'What is the weather in Tbilisi right now? Use the get_weather tool, then tell me.';

function httpPost(token, bodyObj) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-beta': BETA, 'Authorization': `Bearer ${token}` },
        }, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => { let p; try { p = JSON.parse(d); } catch { p = d; } resolve({ status: res.statusCode, data: p }); }); });
        req.on('error', reject); req.setTimeout(60000, () => req.destroy(new Error('timeout')));
        req.write(JSON.stringify(bodyObj)); req.end();
    });
}

const sys = () => [{ type: 'text', text: CC_BILLING_HEADER }, { type: 'text', text: 'You are a helpful assistant. Use tools when appropriate.' }];

async function probe(model, token, cfg) {
    const base = { model, max_tokens: 4096, stream: false, system: sys(), tools: [TOOL] };
    if (cfg.thinking) base.thinking = cfg.thinking;

    const r1 = await httpPost(token, { ...base, messages: [{ role: 'user', content: USER_MSG }] });
    if (r1.status !== 200) {
        console.log(`  [${cfg.name}] R1 ❌ ${r1.status} — ${(r1.data?.error?.message || JSON.stringify(r1.data)).slice(0, 90)}`);
        return;
    }
    const content = Array.isArray(r1.data.content) ? r1.data.content : [];
    const thinking = content.filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking');
    const toolUse = content.find((b) => b.type === 'tool_use');
    const emptyT = content.some((b) => b.type === 'thinking' && (b.thinking || '').trim() === '');
    const tdesc = thinking.map((t) => t.type === 'thinking'
        ? `thinking(len=${(t.thinking || '').trim().length}${emptyT ? ' ⚠️EMPTY' : ''},sig=${t.signature ? 'y' : 'n'})`
        : `redacted(len=${(t.data || '').length})`).join('+') || 'none';

    let r2 = 'n/a (no tool_use)';
    if (toolUse) {
        const rr = await httpPost(token, { ...base, messages: [
            { role: 'user', content: USER_MSG },
            { role: 'assistant', content },  // verbatim (per API "must be unchanged")
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: '{"temp_c":18,"condition":"clear"}' }] },
        ] });
        const m = rr.data?.error?.message || '';
        r2 = rr.status === 200 ? '200 ✅'
            : `${rr.status} ❌ ${/each thinking block must contain thinking/i.test(m) ? '🎯 THE BUG' : m.slice(0, 55)}`;
    }
    console.log(`  [${cfg.name}] R1 blocks=[${content.map((b) => b.type).join(',')}] thinking=${tdesc} | REPLAY=${r2}`);
}

(async () => {
    const token = process.env.SETUP_TOKEN || process.env.ANTHROPIC_SETUP_TOKEN;
    if (!token) { console.error('❌ Set SETUP_TOKEN in testing/.env'); process.exit(1); }
    console.log('🧪 BAT-1033 live recreation — setup_token + interleaved-thinking beta + tool');
    for (const model of MODELS) {
        console.log(`\n=== ${model} ===`);
        for (const cfg of CONFIGS) { await probe(model, token, cfg); await new Promise((r) => setTimeout(r, 1200)); }
    }
    console.log('\nDone.');
})();
