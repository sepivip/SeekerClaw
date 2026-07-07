#!/usr/bin/env node
// test-recreate-agent.js — recreate the agent's EXACT request using SeekerClaw's
// own request builders (formatSystemPrompt + formatTools + formatRequest from
// providers/claude.js — the same calls ai.js:2433/2510/2689 make on a real turn),
// at the agent's real size, via the setup_token. Sends TWICE with a CHANGING
// dynamic block (mimicking the per-turn burner snapshot / timestamps) to measure
// whether the 64 tools actually cache — the crux of the ~26K-uncached-per-turn burn.
//
// Compare against the device DB: input_tokens ~26K, cache_read_tokens ~8192.
// Run: node testing/test-recreate-agent.js
'use strict';

const path = require('path');
const https = require('https');

// Stub config.js (claude.js + reasoning-gating require it) before load.
const configPath = path.resolve(__dirname, '../app/src/main/assets/nodejs-project/config.js');
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true,
    exports: { log: () => {}, CHANNEL: 'telegram', config: {}, API_TIMEOUT_MS: 60000 } };
const claude = require('../app/src/main/assets/nodejs-project/providers/claude');
const { loadEnv } = require('./lib');
loadEnv();

const MODEL = process.env.TEST_MODEL || 'claude-sonnet-4-6'; // the agent's actual model
const THINK = process.env.THINK === 'on';

// ---- build an agent-sized payload -------------------------------------------
// Stable system (~21K tokens; realistic prose, ~4 chars/token) ⇒ becomes the cached
// prefix. Larger than the device's ~8K cached prefix, but size isn't the point here —
// the diagnostic is whether cache_read tracks stable-only vs stable+tools (see below).
const STABLE = ('You are a capable on-device personal AI agent running inside a mobile app. '
    + 'You have tools for messaging, memory, files, skills, cron, wallet and web access. '
    + 'Follow the safety, confirmation-gate, and reply-formatting rules precisely. ').repeat(360);

// Dynamic block (changes every turn — burner snapshot, timestamps). This sits
// BETWEEN the cached stable block and the tools, which is the whole question.
const dynamic = (seed) => `Runtime: ${seed}. Burner balance snapshot: SOL ${seed % 1000}, USDC ${seed % 500}. `
    + `Active model: ${MODEL}. Heartbeat window token: ${seed}.`;

// 64 realistic tool schemas (~18K tokens total).
function rawTools(n) {
    const desc = 'Detailed capability with usage guidance, safety notes, parameter semantics, and examples. '.repeat(9);
    return Array.from({ length: n }, (_, i) => ({
        name: `tool_${i}`,
        description: `Tool ${i}: ${desc}`,
        input_schema: { type: 'object', properties: {
            query: { type: 'string', description: desc },
            options: { type: 'string', description: desc },
        }, required: ['query'] },
    }));
}

const MESSAGES = [{ role: 'user', content: 'Hey' }];
const REQ_OPTS = THINK ? { reasoningEnabled: true, reasoningSupport: 'yes' } : { reasoningEnabled: false, reasoningSupport: 'no' };

function buildBody(seed) {
    const systemBlocks = claude.formatSystemPrompt(STABLE, dynamic(seed), 'setup_token'); // [billing, stable+cache, dynamic]
    const tools = claude.formatTools(rawTools(64)); // cache_control on last tool
    const bodyStr = claude.formatRequest(MODEL, 4096, systemBlocks, MESSAGES, tools, REQ_OPTS);
    const body = JSON.parse(bodyStr);
    body.stream = false; // easier usage read; does NOT affect caching or billing
    return body;
}

function post(token, bodyObj) {
    const headers = claude.buildHeaders(token, 'setup_token'); // exact betas + Authorization
    return new Promise((res, rej) => {
        const r = https.request({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers },
            (rp) => { let d = ''; rp.on('data', (c) => d += c); rp.on('end', () => { let p; try { p = JSON.parse(d); } catch { p = d; } res({ status: rp.statusCode, data: p }); }); });
        r.on('error', rej); r.setTimeout(90000, () => r.destroy(new Error('timeout')));
        r.write(JSON.stringify(bodyObj)); r.end();
    });
}

async function send(label, token, seed) {
    const body = buildBody(seed);
    const payloadSize = JSON.stringify(body).length;
    const r = await post(token, body);
    const u = r.data?.usage || {};
    if (r.data?.error) { console.log(`${label}  payload=${payloadSize}B → ${r.status} ❌ ${r.data.error.type}: ${(r.data.error.message || '').slice(0, 80)}`); return r.status; }
    console.log(`${label}  payload=${payloadSize}B → ${r.status} | input(non-cached)=${u.input_tokens} cache_write=${u.cache_creation_input_tokens} cache_read=${u.cache_read_input_tokens} out=${u.output_tokens}`);
    return r.status;
}

(async () => {
    const token = process.env.SETUP_TOKEN || process.env.ANTHROPIC_SETUP_TOKEN;
    if (!token) { console.error('❌ no SETUP_TOKEN'); process.exit(1); }
    console.log(`🧪 Recreate agent request — model=${MODEL}, /think=${THINK ? 'on' : 'off'}, SeekerClaw's own builders\n`);
    console.log('Device DB reference: input≈26,000  cache_read≈8,192  (tools NOT cached)\n');
    await send('REQ 1 (dyn=A, cold)  ', token, 1001);
    await new Promise((r) => setTimeout(r, 1500));
    await send('REQ 2 (dyn=B, changed)', token, 2002);
    console.log('\nIf REQ 2 cache_read ≈ stable only (~21K) while input ≈ tools (~18K):');
    console.log('→ the dynamic block between stable-cache and tools INVALIDATES the tool cache — exactly the agent pattern.');
})();
