#!/usr/bin/env node
// test-usage-probe.js — minimal one-shot to read the CURRENT account state on the
// setup_token billing path. The device agent is 400ing with
// "You're out of extra usage. Add more at claude.ai/settings/usage" — an
// invalid_request_error returned at the billing gate (0 tokens), NOT a malformed
// request. This sends the smallest possible request on the agent's exact model
// (claude-sonnet-4-6) via the setup_token to confirm whether the account is
// capped right now. Deliberately tiny — every setup_token call bills the user's
// subscription quota. Run: node tests/live/anthropic/test-usage-probe.js
'use strict';
const path = require('path');
const https = require('https');
const configPath = path.resolve(__dirname, '../../../app/src/main/assets/nodejs-project/config.js');
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true,
    exports: { log: () => {}, CHANNEL: 'telegram', config: {}, API_TIMEOUT_MS: 60000 } };
const claude = require('../../../app/src/main/assets/nodejs-project/providers/claude');
const { loadEnv, CC_BILLING_HEADER } = require('./lib');
loadEnv();

const MODEL = 'claude-sonnet-4-6'; // the agent's exact model
const BILL = CC_BILLING_HEADER; // shared with providers/claude.js — no drift on cc_version bumps

function post(token, body) {
    const headers = claude.buildHeaders(token, 'setup_token');
    return new Promise((res, rej) => {
        const r = https.request({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers },
            (rp) => { let d = ''; rp.on('data', (c) => d += c); rp.on('end', () => { let p; try { p = JSON.parse(d); } catch { p = d; } res({ status: rp.statusCode, data: p }); }); });
        r.on('error', rej); r.setTimeout(30000, () => r.destroy(new Error('timeout')));
        r.write(JSON.stringify(body)); r.end();
    });
}

(async () => {
    const token = process.env.SETUP_TOKEN || process.env.ANTHROPIC_SETUP_TOKEN;
    if (!token) { console.error('❌ no SETUP_TOKEN in tests/live/anthropic/.env'); process.exit(1); }
    console.log(`token tail …${token.slice(-6)}  model=${MODEL}\n`);
    const r = await post(token, {
        model: MODEL, max_tokens: 8, stream: false,
        system: [{ type: 'text', text: BILL }, { type: 'text', text: 'Reply with the single word OK.' }],
        messages: [{ role: 'user', content: 'ping' }],
    });
    console.log(`HTTP ${r.status}`);
    if (r.data?.error) {
        console.log(`ERROR type: ${r.data.error.type}`);
        console.log(`ERROR message: "${r.data.error.message}"`);
        console.log(`\n→ Account state on this token: ${/extra usage|usage/i.test(r.data.error.message) ? 'USAGE-CAPPED (matches the device error)' : 'other'}`);
    } else {
        const txt = Array.isArray(r.data?.content) ? r.data.content.filter(b => b.type === 'text').map(b => b.text).join('') : '';
        console.log(`OK — reply: "${txt}"  usage in=${r.data?.usage?.input_tokens} out=${r.data?.usage?.output_tokens}`);
        console.log('\n→ Account has room RIGHT NOW (the cap is intermittent / at the edge — the agent burns it faster than a tiny probe).');
    }
})();
