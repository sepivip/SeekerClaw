#!/usr/bin/env node
// test-recreate-failure.js — recreate the DEVICE's FAILING turn, not a success.
// The device's 400 "out of extra usage" turns had payloadSize≈116014 bytes,
// 64 tools, model claude-opus-4-8, ~26K UNCACHED tokens billed. My earlier
// recreations passed because they were cheap (cached/tiny). This one matches
// the device's WEIGHT: ~26K fresh tokens on the same setup_token, so it hits
// the shared usage meter as hard as the device does. If the account is at its
// ceiling, this returns the SAME 400. Sends the exact same bytes TWICE so you
// can see cold vs (attempted) warm.
// Run: node testing/test-recreate-failure.js
'use strict';
const path = require('path');
const https = require('https');
const configPath = path.resolve(__dirname, '../app/src/main/assets/nodejs-project/config.js');
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true,
    exports: { log: () => {}, CHANNEL: 'telegram', config: {}, API_TIMEOUT_MS: 60000 } };
const claude = require('../app/src/main/assets/nodejs-project/providers/claude');
const { loadEnv } = require('./lib');
loadEnv();

const MODEL = process.env.TEST_MODEL || 'claude-opus-4-8'; // the device's real failing model
const TARGET_BYTES = 116014;                  // device's exact failing payloadSize

// Build system (~26K tokens) + 64 tools, tuned to hit the device's payload size.
// BUST=1 prepends a unique marker so the prefix has NEVER been cached → bills
// full FRESH tokens, matching the device's uncached 26K/turn cost profile.
const BUST = process.env.BUST === '1' ? `UNIQUE-${process.pid}-${Date.now && Date.now()}-${Math.round(Math.random ? Math.random() * 1e9 : 0)} ` : '';
const STABLE = BUST + ('You are a capable on-device personal AI agent. You have tools for messaging, '
    + 'memory, files, skills, cron, wallet and web access. Follow safety and reply rules. ').repeat(560);
const dynamic = (seed) => `Runtime tick ${seed}. Burner snapshot SOL ${seed % 1000}. message_id ${seed}.`;
function rawTools(n) {
    const d = 'Detailed capability with usage guidance, safety notes, and parameter semantics. '.repeat(9);
    return Array.from({ length: n }, (_, i) => ({
        name: `tool_${i}`, description: `Tool ${i}: ${d}`,
        input_schema: { type: 'object', properties: { query: { type: 'string', description: d } }, required: ['query'] },
    }));
}
const MESSAGES = [{ role: 'user', content: 'status' }];

// NOCACHE=1 strips cache_control everywhere → the whole prefix bills as PURE
// input_tokens with cache_write=0, cache_read=0 — the device's exact billing
// profile (input≈26K, no cache benefit). Combine with BUST for unique content.
const NOCACHE = process.env.NOCACHE === '1';
function build(seed) {
    const sys = claude.formatSystemPrompt(STABLE, dynamic(seed), 'setup_token');
    let tools = claude.formatTools(rawTools(64));
    if (NOCACHE) {
        sys.forEach(b => { delete b.cache_control; });
        tools = tools.map(t => { const c = { ...t }; delete c.cache_control; return c; });
    }
    const body = JSON.parse(claude.formatRequest(MODEL, 4096, sys, MESSAGES, tools, { reasoningMode: 'off' }));
    if (process.env.STREAM !== '1') body.stream = false; // STREAM=1 → match the agent exactly (stream:true)
    return body;
}

function post(token, body) {
    const headers = claude.buildHeaders(token, 'setup_token');
    return new Promise((res, rej) => {
        const r = https.request({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers },
            (rp) => { let d = ''; rp.on('data', c => d += c); rp.on('end', () => { let p; try { p = JSON.parse(d); } catch { p = d; } res({ status: rp.statusCode, data: p }); }); });
        r.on('error', rej); r.setTimeout(90000, () => r.destroy(new Error('timeout')));
        r.write(JSON.stringify(body)); r.end();
    });
}

(async () => {
    const token = process.env.SETUP_TOKEN || process.env.ANTHROPIC_SETUP_TOKEN;
    if (!token) { console.error('❌ no SETUP_TOKEN'); process.exit(1); }
    const sample = build(1);
    console.log(`token …${token.slice(-6)}  model=${MODEL}  payload=${JSON.stringify(sample).length}B (device failing turn=${TARGET_BYTES}B)  tools=64\n`);
    for (const [label, seed] of [['SEND 1 (cold)', 7001], ['SEND 2 (same bytes)', 7001]]) {
        const r = await post(token, build(seed));
        if (r.data?.error || r.status !== 200) {
            const msg = r.data?.error ? `${r.data.error.type}: "${r.data.error.message}"`
                : (typeof r.data === 'string' ? r.data : JSON.stringify(r.data)).slice(0, 120); // non-JSON/HTML error body
            console.log(`${label} → ${r.status} ❌ ${msg}`);
            if (/extra usage|usage/i.test(r.data?.error?.message || '')) console.log('   ✅ RECREATED — identical to the device error.');
        } else {
            const u = r.data.usage || {};
            console.log(`${label} → ${r.status} ✅ input=${u.input_tokens} cache_write=${u.cache_creation_input_tokens} cache_read=${u.cache_read_input_tokens} out=${u.output_tokens}`);
        }
        await new Promise(res => setTimeout(res, 1500));
    }
    console.log('\n400 "out of extra usage" here = same token + device-weight request reproduces the failure → shared usage meter, not a device difference.');
    console.log('200 here = meter has headroom this instant; the device fails because it spends ~26K FRESH tokens every 30-min heartbeat and keeps the meter pinned.');
})();
