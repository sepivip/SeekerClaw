#!/usr/bin/env node
// test-cc-fullresponse.js — does the setup_token path return a REAL answer
// (not just a 200)? Dumps the full response: status, error, content text,
// stop_reason, usage. Uses the shipped CC_BILLING_HEADER (currently cc_version
// 2.1.195) by default; override with CC_VER to probe another version.
// Run: node testing/test-cc-fullresponse.js
'use strict';
const https = require('https');
const { loadEnv, CC_BILLING_HEADER } = require('./lib');
loadEnv();

const BETA = 'prompt-caching-2024-07-31,oauth-2025-04-20,interleaved-thinking-2025-05-14';
const CC = process.env.CC_VER; // override only; default = the shipped CC_BILLING_HEADER
const billing = CC ? `x-anthropic-billing-header: cc_version=${CC}; cc_entrypoint=cli; cch=00000;` : CC_BILLING_HEADER;
const EFFECTIVE_CC = (billing.match(/cc_version=([^;]+)/) || [])[1] || '(unknown)'; // what actually goes on the wire
const MODELS = ['claude-sonnet-5', 'claude-opus-4-8'];

function post(token, body) {
    return new Promise((res, rej) => {
        const r = https.request({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-beta': BETA, 'Authorization': `Bearer ${token}` } },
            (rp) => { let d = ''; rp.on('data', (c) => d += c); rp.on('end', () => { let p; try { p = JSON.parse(d); } catch { p = d; } res({ status: rp.statusCode, data: p }); }); });
        r.on('error', rej); r.setTimeout(60000, () => r.destroy(new Error('timeout')));
        r.write(JSON.stringify(body)); r.end();
    });
}

(async () => {
    const token = process.env.SETUP_TOKEN || process.env.ANTHROPIC_SETUP_TOKEN;
    if (!token) { console.error('❌ no SETUP_TOKEN'); process.exit(1); }
    console.log(`🧪 Full-response check — setup_token, cc_version=${EFFECTIVE_CC}\n`);
    for (const model of MODELS) {
        const r = await post(token, {
            model, max_tokens: 256, stream: false,
            system: [{ type: 'text', text: billing }, { type: 'text', text: 'You are a helpful assistant.' }],
            messages: [{ role: 'user', content: 'What is 2+2? Reply in one short sentence.' }],
        });
        console.log(`=== ${model} ===`);
        console.log(`  status: ${r.status}`);
        if (r.data?.error) { console.log(`  ERROR: ${JSON.stringify(r.data.error)}`); }
        else {
            const blocks = Array.isArray(r.data?.content) ? r.data.content : [];
            const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
            console.log(`  block types: [${blocks.map((b) => b.type).join(',')}]`);
            console.log(`  TEXT: "${(text || '').slice(0, 200)}"`);
            console.log(`  stop_reason: ${r.data?.stop_reason} | usage: in=${r.data?.usage?.input_tokens} out=${r.data?.usage?.output_tokens}`);
        }
        console.log('');
        await new Promise((res) => setTimeout(res, 800));
    }
})();
