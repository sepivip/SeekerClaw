#!/usr/bin/env node
// test-cc-bigrequest.js — recreate the agent's "out of extra usage" condition.
// The device log showed the agent failing on ~110K-byte payloads with 64 tools
// on claude-sonnet-4-6, while a tiny probe succeeds. This sends a SMALL control
// then a BIG (agent-sized) request on the same model + setup_token, to see if
// request size / usage is what trips it.
// Run: node testing/test-cc-bigrequest.js
'use strict';
const https = require('https');
const { loadEnv, CC_BILLING_HEADER } = require('./lib');
loadEnv();

const BETA = 'prompt-caching-2024-07-31,oauth-2025-04-20,interleaved-thinking-2025-05-14';
const CC = process.env.CC_VER; // override only; default = the shipped CC_BILLING_HEADER
const billing = CC ? `x-anthropic-billing-header: cc_version=${CC}; cc_entrypoint=cli; cch=00000;` : CC_BILLING_HEADER;
const EFFECTIVE_CC = (billing.match(/cc_version=([^;]+)/) || [])[1] || '(unknown)'; // what actually goes on the wire
const MODEL = process.env.TEST_MODEL || 'claude-sonnet-4-6'; // the agent's actual model

function post(token, body) {
    return new Promise((res, rej) => {
        const r = https.request({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-beta': BETA, 'Authorization': `Bearer ${token}` } },
            (rp) => { let d = ''; rp.on('data', (c) => d += c); rp.on('end', () => { let p; try { p = JSON.parse(d); } catch { p = d; } res({ status: rp.statusCode, data: p }); }); });
        r.on('error', rej); r.setTimeout(90000, () => r.destroy(new Error('timeout')));
        r.write(JSON.stringify(body)); r.end();
    });
}

// Bulk a request to ~agent size: N tools with padded schemas + a big system block.
function makeTools(n) {
    const pad = 'Detailed behavior notes and usage guidance for this capability. '.repeat(16); // ~1KB
    return Array.from({ length: n }, (_, i) => ({
        name: `capability_${i}`,
        description: `Capability #${i}. ${pad}`,
        input_schema: { type: 'object', properties: { query: { type: 'string', description: pad }, options: { type: 'string', description: pad } }, required: ['query'] },
    }));
}

async function run(label, token, { tools, maxTokens, sysPad }) {
    const body = {
        model: MODEL, max_tokens: maxTokens, stream: false,
        system: [{ type: 'text', text: billing }, { type: 'text', text: ('You are a helpful assistant with many tools. ').repeat(sysPad) }],
        messages: [{ role: 'user', content: 'Hey' }],
    };
    if (tools) body.tools = makeTools(tools);
    const payloadSize = JSON.stringify(body).length;
    const r = await post(token, body);
    const errMsg = r.data?.error ? `${r.data.error.type}: ${r.data.error.message}` : '';
    const text = !r.data?.error && Array.isArray(r.data?.content) ? r.data.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : '';
    console.log(`${label.padEnd(28)} payload=${String(payloadSize).padStart(7)}B tools=${tools || 0}  → ${r.status} ${errMsg ? '❌ ' + errMsg.slice(0, 90) : '✅ "' + text.slice(0, 40) + '"'}`);
    return r.status;
}

(async () => {
    const token = process.env.SETUP_TOKEN || process.env.ANTHROPIC_SETUP_TOKEN;
    if (!token) { console.error('❌ no SETUP_TOKEN'); process.exit(1); }
    console.log(`🧪 Recreate agent usage condition — model=${MODEL}, cc_version=${EFFECTIVE_CC}\n`);
    await run('SMALL (control)', token, { tools: 0, maxTokens: 128, sysPad: 1 });
    await new Promise((r) => setTimeout(r, 1200));
    await run('BIG (agent-sized, 64 tools)', token, { tools: 64, maxTokens: 4096, sysPad: 400 });
    console.log('\nIf BIG → 400 "out of extra usage" but SMALL → 200: request size/usage is the trigger (account near its cap).');
})();
