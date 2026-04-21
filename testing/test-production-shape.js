#!/usr/bin/env node
// test-production-shape.js — reproduce ai.js's actual wire shape:
// streaming + tools + cache_control + real-size system prompt.
// Tests each model individually so we can see where (if anywhere) it breaks.

const https = require('https');
const { loadEnv, getModels, CC_BILLING_HEADER } = require('./lib');

loadEnv();

const token = process.env.SETUP_TOKEN;
if (!token) {
    console.error('❌ SETUP_TOKEN not in .env');
    process.exit(1);
}

// Approximate a realistic system prompt. Actual size here:
//   50 × ~75 chars ≈  3.7k chars
//  200 × ~40 chars ≈  8.0k chars
//              sum ≈ 11.7k chars ≈ ~3k tokens (rough 4 chars/token).
// SeekerClaw's real system prompt is ~4–8k tokens; 3k is on the low end but
// enough to exercise the cache_control path + meet Anthropic's 1024-token
// minimum for prompt caching.
const STABLE_PROMPT = 'You are SeekerClaw, a personal AI agent running on a Solana Seeker phone.\n'.repeat(50) +
    'Be concise. Use tools when appropriate. '.repeat(200);

// Match claude.js::formatTools — last tool gets cache_control
const TOOLS_RAW = [
    { name: 'get_weather', description: 'Get the weather for a city', input_schema: {
        type: 'object', properties: { city: { type: 'string' } }, required: ['city'],
    }},
    { name: 'echo', description: 'Echo back the input', input_schema: {
        type: 'object', properties: { text: { type: 'string' } }, required: ['text'],
    }},
];
const TOOLS = [...TOOLS_RAW];
TOOLS[TOOLS.length - 1] = { ...TOOLS[TOOLS.length - 1], cache_control: { type: 'ephemeral' } };

function buildBody(model, { stream, withTools, withBilling, cacheOnSystem }) {
    const blocks = [];
    if (withBilling) blocks.push({ type: 'text', text: CC_BILLING_HEADER });
    if (cacheOnSystem) {
        blocks.push({ type: 'text', text: STABLE_PROMPT, cache_control: { type: 'ephemeral' } });
    } else {
        blocks.push({ type: 'text', text: STABLE_PROMPT });
    }
    const body = {
        model,
        max_tokens: 128,
        stream,
        system: blocks,
        messages: [{ role: 'user', content: 'Say "ready" and nothing else.' }],
    };
    if (withTools) body.tools = TOOLS;
    return JSON.stringify(body);
}

function buildHeaders() {
    return {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31,oauth-2025-04-20',
        'Authorization': `Bearer ${token}`,
    };
}

function httpPost(body) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.anthropic.com',
            path: '/v1/messages',
            method: 'POST',
            headers: buildHeaders(),
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                resolve({ status: res.statusCode, raw: data, headers: res.headers });
            });
        });
        req.on('error', reject);
        req.setTimeout(60000, () => { req.destroy(new Error('timeout')); });
        req.write(body);
        req.end();
    });
}

function summarizeSSE(raw) {
    const lines = raw.split('\n').filter(l => l.startsWith('event:') || l.startsWith('data:'));
    const events = [];
    for (const l of lines) {
        if (l.startsWith('event:')) events.push(l.slice(7).trim());
    }
    const errorLine = raw.split('\n').find(l => l.startsWith('event: error'));
    let errorBody = null;
    if (errorLine) {
        const idx = raw.indexOf(errorLine);
        const snippet = raw.slice(idx, idx + 500);
        errorBody = snippet;
    }
    return { eventCount: events.length, eventTypes: [...new Set(events)].slice(0, 5), errorBody };
}

function summarize(res) {
    if (res.status !== 200) {
        let parsed;
        try { parsed = JSON.parse(res.raw); } catch { parsed = { error: { message: res.raw.slice(0, 300) } }; }
        return `❌ ${res.status} — ${parsed?.error?.type || ''}: ${parsed?.error?.message || res.raw.slice(0, 200)}`;
    }
    // 200 — could be streaming or not
    if (res.raw.startsWith('event:') || res.raw.includes('event: message_start')) {
        const s = summarizeSSE(res.raw);
        if (s.errorBody) return `⚠️  200 but stream contains error: ${s.errorBody.slice(0, 200)}`;
        return `✅ 200 stream — ${s.eventCount} events (${s.eventTypes.join(',')})`;
    }
    try {
        const j = JSON.parse(res.raw);
        const text = j.content?.[0]?.text || '';
        return `✅ 200 — "${text.slice(0, 60)}"`;
    } catch {
        return `✅ 200 — (raw ${res.raw.length} bytes)`;
    }
}

async function main() {
    console.log('🧪 Production-shape test (streaming + tools + cache)');
    console.log(`   Time: ${new Date().toISOString()}`);
    // Only log the fixed, non-secret prefix (13 chars: "sk-ant-oat01-") — never
    // bytes of the actual token, so CI logs/console scrollback can't leak it.
    const prefix = token.startsWith('sk-ant-oat01-') ? 'sk-ant-oat01-' : '<unknown-prefix>';
    console.log(`   Token: ${prefix}[REDACTED] (len=${token.length})`);

    const scenarios = [
        { label: 'A: stream=false, no tools, billing, system cache', opts: { stream: false, withTools: false, withBilling: true, cacheOnSystem: true }},
        { label: 'B: stream=true,  no tools, billing, system cache', opts: { stream: true,  withTools: false, withBilling: true, cacheOnSystem: true }},
        { label: 'C: stream=true,  WITH tools, billing, system cache (PROD)', opts: { stream: true, withTools: true, withBilling: true, cacheOnSystem: true }},
        { label: 'D: stream=true,  WITH tools, NO billing, system cache', opts: { stream: true, withTools: true, withBilling: false, cacheOnSystem: true }},
        { label: 'E: stream=true,  WITH tools, billing, NO system cache', opts: { stream: true, withTools: true, withBilling: true, cacheOnSystem: false }},
    ];

    for (const model of getModels()) {
        console.log(`\n${'═'.repeat(70)}\nMODEL: ${model}\n${'═'.repeat(70)}`);
        for (const s of scenarios) {
            process.stdout.write(`  ${s.label}\n    → `);
            try {
                const body = buildBody(model, s.opts);
                const res = await httpPost(body);
                console.log(summarize(res));
            } catch (e) {
                console.log(`❌ transport: ${e.message}`);
            }
            await new Promise(r => setTimeout(r, 1200));
        }
    }
    console.log('\nDone.');
}

main();
