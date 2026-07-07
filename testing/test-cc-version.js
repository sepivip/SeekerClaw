#!/usr/bin/env node
// test-cc-version.js — verify a cc_version bump for the setup_token billing
// masquerade BEFORE shipping it. Replicates exactly what SeekerClaw sends on the
// setup_token path (Authorization: Bearer + oauth/interleaved betas + the
// `x-anthropic-billing-header` cc_version as a SYSTEM BLOCK), and checks that
// the target cc_version is accepted (HTTP 200) on our non-Haiku models.
//
// Legacy control: cc_version=2.1.116. Current shipped: 2.1.195 (BAT-1123 — see
// providers/claude.js CC_BILLING_HEADER). Override the pair via CC_VERSIONS.
//
// Setup: SETUP_TOKEN=sk-ant-oat01-… in testing/.env   Run: node testing/test-cc-version.js
'use strict';

const https = require('https');
const { loadEnv, CC_BILLING_HEADER } = require('./lib');
loadEnv();

const BETA = 'prompt-caching-2024-07-31,oauth-2025-04-20,interleaved-thinking-2025-05-14';
// Current shipped value — parsed from CC_BILLING_HEADER so there's ONE source of truth.
const SHIPPED_CC = (CC_BILLING_HEADER.match(/cc_version=([^;]+)/) || [])[1] || '2.1.195';
// Parse the override, dropping blanks (a trailing/double comma must not send cc_version=).
const parsedCC = (process.env.CC_VERSIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
const CC_VERSIONS = parsedCC.length ? parsedCC : ['2.1.116', SHIPPED_CC]; // else: legacy control + current shipped (from CC_BILLING_HEADER)
const MODELS = ['claude-sonnet-5', 'claude-opus-4-8'];

const billingHeader = (ver) => `x-anthropic-billing-header: cc_version=${ver}; cc_entrypoint=cli; cch=00000;`;

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

async function probe(model, token, ccVersion) {
    const r = await httpPost(token, {
        model, max_tokens: 64, stream: false,
        system: [{ type: 'text', text: billingHeader(ccVersion) }, { type: 'text', text: 'You are a helpful assistant.' }],
        messages: [{ role: 'user', content: 'Say hi in exactly one word.' }],
    });
    if (r.status === 200) return '200 ✅';
    const m = r.data?.error?.message || JSON.stringify(r.data);
    return `${r.status} ❌ ${m.slice(0, 70)}`;
}

(async () => {
    const token = process.env.SETUP_TOKEN || process.env.ANTHROPIC_SETUP_TOKEN;
    if (!token) { console.error('❌ Set SETUP_TOKEN in testing/.env'); process.exit(1); }
    console.log('🧪 cc_version acceptance check (setup_token path, real billing-header format)\n');
    console.log('cc_version'.padEnd(12) + MODELS.map((m) => m.padEnd(22)).join(''));
    console.log('─'.repeat(12 + MODELS.length * 22));
    for (const ver of CC_VERSIONS) {
        const cells = [];
        for (const model of MODELS) { cells.push(await probe(model, token, ver)); await new Promise((r) => setTimeout(r, 900)); }
        console.log(ver.padEnd(12) + cells.map((c) => c.padEnd(22)).join(''));
    }
    console.log(`\n→ each cc_version must be 200 on both models; ${SHIPPED_CC} is the current shipped value.`);
})();
