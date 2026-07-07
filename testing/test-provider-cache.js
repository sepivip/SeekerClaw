#!/usr/bin/env node
/*
 * test-provider-cache.js — reusable prompt-cache / request-shape diagnostic
 * across ALL providers (claude, openai, openrouter, custom).
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-07-07 the on-device agent (setup_token, sonnet-4-6) started billing
 * ~26K UNCACHED tokens every turn — only the 8192-token tool block was
 * caching, the ~26K system prompt was not. Heartbeats every 30 min at 26K
 * fresh tokens drained the claude.ai subscription's Claude Code usage
 * allowance, and Anthropic then rejected the large requests at the billing
 * gate: `400 invalid_request_error "You're out of extra usage …"`. A tiny
 * request still succeeded — so the request SHAPE was valid; the caching was
 * the problem. This test pins that class of regression for every provider.
 *
 * MODES
 * -----
 *  DRY-RUN (default, FREE, no network): builds the request with the provider's
 *    REAL formatters and asserts cache_control lands where it should
 *    (stable system block + last tool) and NOT on the per-turn dynamic block.
 *    Also prints stable/dynamic/tools byte+token estimates. Safe for CI.
 *  LIVE (LIVE=1): sends the request TWICE with a CHANGING dynamic block and
 *    reports the provider's cache metrics (cache_read/write). Costs tokens —
 *    run deliberately. NOTE: on setup_token this bills the user's subscription.
 *
 * KNOBS
 * -----
 *  TEST_PROVIDER=claude|openai|openrouter|custom   (default claude)
 *  TEST_AUTH=setup_token|api_key                   (claude only; default setup_token)
 *  TEST_MODEL=<id>                                 (default per provider)
 *  AGENT_SIZE=full                                 (recreate the ~26K agent prompt; default small)
 *  LIVE=1                                          (actually send; default dry-run)
 *
 * Run: node testing/test-provider-cache.js
 *      TEST_PROVIDER=openrouter node testing/test-provider-cache.js
 *      LIVE=1 AGENT_SIZE=full node testing/test-provider-cache.js
 */
'use strict';

const path = require('path');
const https = require('https');

// Stub config.js so provider adapters load standalone.
const NP = path.resolve(__dirname, '../app/src/main/assets/nodejs-project');
const configPath = path.join(NP, 'config.js');
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true,
    exports: { log: () => {}, CHANNEL: 'telegram', config: {}, API_TIMEOUT_MS: 60000 } };

const { loadEnv } = require('./lib');
loadEnv();

const PROVIDER = (process.env.TEST_PROVIDER || 'claude').toLowerCase();
const AUTH = process.env.TEST_AUTH || 'setup_token';
const AGENT_SIZE = process.env.AGENT_SIZE || 'small';
const LIVE = process.env.LIVE === '1';

// ── Provider registry: real adapter + endpoint + how it wraps a request ──────
const REG = {
    claude: {
        adapter: () => require(path.join(NP, 'providers/claude')),
        model: process.env.TEST_MODEL || 'claude-sonnet-4-6',
        host: 'api.anthropic.com', reqPath: '/v1/messages',
        // claude: formatSystemPrompt(stable, dynamic, authType) → block[]; formatRequest(model,max,systemBlocks,messages,tools,opts)
        build(a, model, stable, dyn, tools, msgs) {
            const sys = a.formatSystemPrompt(stable, dyn, AUTH);
            const ftools = a.formatTools(tools);
            return JSON.parse(a.formatRequest(model, 4096, sys, msgs, ftools, { reasoningMode: 'off' }));
        },
        headers(a, keyOrToken) { return a.buildHeaders(keyOrToken, AUTH); },
        secret: () => (AUTH === 'api_key'
            ? process.env.ANTHROPIC_API_KEY
            : (process.env.SETUP_TOKEN || process.env.ANTHROPIC_SETUP_TOKEN)),
    },
    openrouter: {
        adapter: () => require(path.join(NP, 'providers/openrouter')),
        model: process.env.TEST_MODEL || 'anthropic/claude-3.5-sonnet',
        host: 'openrouter.ai', reqPath: '/api/v1/chat/completions',
        // openrouter: formatSystemPrompt(stable,dynamic)→string; formatRequest(model,max,systemPrompt,messages,tools,opts)
        build(a, model, stable, dyn, tools, msgs) {
            const sys = a.formatSystemPrompt(stable, dyn);
            const ftools = a.formatTools(tools);
            return JSON.parse(a.formatRequest(model, 4096, sys, msgs, ftools, {}));
        },
        headers(a, key) { return a.buildHeaders(key); },
        secret: () => process.env.OPENROUTER_API_KEY,
    },
    openai: {
        adapter: () => require(path.join(NP, 'providers/openai')),
        model: process.env.TEST_MODEL || 'gpt-4o',
        host: 'api.openai.com', reqPath: '/v1/responses',
        // openai: formatSystemPrompt(stable,dynamic); formatRequest(model,max,instructions,input,tools,opts)
        build(a, model, stable, dyn, tools, msgs) {
            const instr = a.formatSystemPrompt(stable, dyn);
            const ftools = a.formatTools(tools);
            return JSON.parse(a.formatRequest(model, 4096, instr, msgs, ftools, {}));
        },
        headers(a, key) { return a.buildHeaders(key); },
        secret: () => process.env.OPENAI_API_KEY,
    },
    custom: {
        adapter: () => require(path.join(NP, 'providers/custom')),
        model: process.env.TEST_MODEL || 'gpt-4o',
        host: (process.env.CUSTOM_BASE_URL || '').replace(/^https?:\/\//, '').split('/')[0] || 'api.openai.com',
        reqPath: '/v1/chat/completions',
        build(a, model, stable, dyn, tools, msgs) {
            const instr = a.formatSystemPrompt(stable, dyn, AUTH);
            const ftools = a.formatTools(tools);
            return JSON.parse(a.formatRequest(model, 4096, instr, msgs, ftools, {}));
        },
        headers(a, key) { return a.buildHeaders(key); },
        secret: () => process.env.CUSTOM_API_KEY,
    },
};

// ── Agent-shaped payload ─────────────────────────────────────────────────────
const REPEAT = AGENT_SIZE === 'full' ? 360 : 12; // full ≈ agent's ~26K system; small ≈ cheap
const STABLE = ('You are a capable on-device personal AI agent running inside a mobile app. '
    + 'You have tools for messaging, memory, files, skills, cron, wallet and web access. '
    + 'Follow the safety, confirmation-gate, and reply-formatting rules precisely. ').repeat(REPEAT);
const dynamic = (seed) => `Runtime tick ${seed}. Burner balance snapshot: SOL ${seed % 1000}. Current message_id: ${seed}.`;
const TOOLCOUNT = AGENT_SIZE === 'full' ? 64 : 8;
function rawTools(n) {
    const d = 'Detailed capability with usage guidance, safety notes, and parameter semantics. '.repeat(AGENT_SIZE === 'full' ? 9 : 2);
    return Array.from({ length: n }, (_, i) => ({
        name: `tool_${i}`, description: `Tool ${i}: ${d}`,
        input_schema: { type: 'object', properties: { query: { type: 'string', description: d } }, required: ['query'] },
    }));
}
const MESSAGES = [{ role: 'user', content: 'Hey' }];
const approxTokens = (s) => Math.round((s || '').length / 4);

// Deep-scan a built request for cache_control markers → list of paths.
function findCacheControl(obj, prefix = '') {
    const hits = [];
    if (Array.isArray(obj)) obj.forEach((v, i) => hits.push(...findCacheControl(v, `${prefix}[${i}]`)));
    else if (obj && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) {
            if (k === 'cache_control') hits.push(prefix || '(root)');
            else hits.push(...findCacheControl(v, prefix ? `${prefix}.${k}` : k));
        }
    }
    return hits;
}

function post(host, reqPath, headers, bodyObj) {
    return new Promise((res, rej) => {
        const r = https.request({ hostname: host, path: reqPath, method: 'POST', headers },
            (rp) => { let d = ''; rp.on('data', (c) => d += c); rp.on('end', () => { let p; try { p = JSON.parse(d); } catch { p = d; } res({ status: rp.statusCode, data: p }); }); });
        r.on('error', rej); r.setTimeout(90000, () => r.destroy(new Error('timeout')));
        r.write(JSON.stringify(bodyObj)); r.end();
    });
}
// Normalize cache usage across Anthropic + OpenAI/OpenRouter response shapes.
function readUsage(data) {
    const u = data?.usage || {};
    return {
        cacheRead: u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? u.prompt_tokens_details?.cache_write_tokens ?? 0,
        input: u.input_tokens ?? u.prompt_tokens ?? 0,
        output: u.output_tokens ?? u.completion_tokens ?? 0,
    };
}

(async () => {
    const cfg = REG[PROVIDER];
    if (!cfg) { console.error(`❌ unknown TEST_PROVIDER "${PROVIDER}" (claude|openai|openrouter|custom)`); process.exit(1); }
    const a = cfg.adapter();
    const model = cfg.model;
    console.log(`🧪 provider=${PROVIDER}${PROVIDER === 'claude' ? ` auth=${AUTH}` : ''}  model=${model}  size=${AGENT_SIZE}  mode=${LIVE ? 'LIVE' : 'DRY-RUN'}\n`);

    // ---- DRY-RUN structural check (free) ----
    const body1 = cfg.build(a, model, STABLE, dynamic(1001), rawTools(TOOLCOUNT), MESSAGES);
    const cc = findCacheControl(body1);
    console.log(`Sizes: stable≈${approxTokens(STABLE)}tok  dynamic≈${approxTokens(dynamic(1001))}tok  tools≈${approxTokens(JSON.stringify(rawTools(TOOLCOUNT)))}tok  (${TOOLCOUNT} tools)`);
    console.log(`cache_control markers at: ${cc.length ? cc.join(', ') : '(none — provider uses implicit prefix caching, e.g. OpenAI)'}`);

    // Structural verdict for providers with explicit markers (claude, openrouter).
    if (['claude', 'openrouter'].includes(PROVIDER)) {
        // The stable/system block must be marked; the dynamic block must NOT sit after
        // an unmarked boundary that a per-turn change would invalidate. For claude we can
        // check the system array precisely.
        let verdict = 'PASS';
        const notes = [];
        if (PROVIDER === 'claude') {
            const sys = body1.system || [];
            const stableIdx = sys.findIndex(b => b.cache_control && (b.text || '').length > 500);
            const dynIdx = sys.length - 1;
            if (stableIdx === -1) { verdict = 'FAIL'; notes.push('stable system block has NO cache_control → whole system re-billed each turn'); }
            if (sys[dynIdx]?.cache_control && dynIdx !== stableIdx) { verdict = 'FAIL'; notes.push('dynamic (last) block IS cached → per-turn change invalidates the cache every turn'); }
            const toolsMarked = (body1.tools || []).some(t => t.cache_control);
            if ((body1.tools || []).length && !toolsMarked) { verdict = 'FAIL'; notes.push('no tool carries cache_control → tool block never caches'); }
        }
        console.log(`\nStructural verdict: ${verdict === 'PASS' ? '✅ PASS' : '❌ FAIL'}${notes.length ? ' — ' + notes.join('; ') : ' (stable cached, dynamic uncached, tools cached)'}`);
    } else {
        console.log('\nStructural verdict: N/A (implicit prefix caching — validate with LIVE mode)');
    }

    if (!LIVE) {
        console.log('\n(dry-run only — set LIVE=1 to send twice and measure real cache_read. LIVE bills tokens.)');
        return;
    }

    // ---- LIVE: send twice with a CHANGING dynamic block ----
    const secret = cfg.secret();
    if (!secret) { console.error(`\n❌ LIVE requested but no credential for ${PROVIDER} (${PROVIDER === 'claude' ? (AUTH === 'api_key' ? 'ANTHROPIC_API_KEY' : 'SETUP_TOKEN') : PROVIDER.toUpperCase() + '_API_KEY'}) in testing/.env`); process.exit(1); }
    const headers = cfg.headers(a, secret);
    console.log('\nLIVE — sending twice (dynamic block changes between calls):');
    for (const [label, seed] of [['REQ 1 (cold)   ', 1001], ['REQ 2 (dyn ≠ 1) ', 2002]]) {
        const body = cfg.build(a, model, STABLE, dynamic(seed), rawTools(TOOLCOUNT), MESSAGES);
        if (body.stream) body.stream = false; // read usage synchronously
        const r = await post(cfg.host, cfg.reqPath, headers, body);
        if (r.data?.error) { console.log(`  ${label} → ${r.status} ❌ ${r.data.error.type}: ${(r.data.error.message || '').slice(0, 70)}`); }
        else { const u = readUsage(r.data); console.log(`  ${label} → ${r.status} | input=${u.input} cache_write=${u.cacheWrite} cache_read=${u.cacheRead} out=${u.output}`); }
        await new Promise(res => setTimeout(res, 1500));
    }
    console.log('\nHealthy caching: REQ 2 cache_read ≈ stable+tools (dynamic change should NOT reset the big prefix).');
})();
