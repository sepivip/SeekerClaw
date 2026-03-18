#!/usr/bin/env node
// test-headers.js — Test different header combinations to find what works
// Diagnostic script: if you're getting 400s, run this to find which
// header combination the API currently accepts.

const https = require('https');
const { loadEnv, getModels, CC_BILLING_HEADER } = require('./lib');

loadEnv();

// ── HTTP helper ─────────────────────────────────────────────────────────────

function httpPost(headers, body) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.anthropic.com',
            path: '/v1/messages',
            method: 'POST',
            headers,
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsed;
                try { parsed = JSON.parse(data); } catch { parsed = data; }
                resolve({ status: res.statusCode, headers: res.headers, data: parsed });
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(new Error('timeout')); });
        req.write(body);
        req.end();
    });
}

// ── Header combinations to test ─────────────────────────────────────────────

function getVariants(token, model) {
    const body = JSON.stringify({
        model, max_tokens: 64, stream: false,
        messages: [{ role: 'user', content: 'Say OK' }],
    });

    const bodyWithBilling = JSON.stringify({
        model, max_tokens: 64, stream: false,
        system: [
            { type: 'text', text: CC_BILLING_HEADER },
            { type: 'text', text: 'Reply with OK', cache_control: { type: 'ephemeral' } },
        ],
        messages: [{ role: 'user', content: 'test' }],
    });

    const bodyWithSystemOnly = JSON.stringify({
        model, max_tokens: 64, stream: false,
        system: [
            { type: 'text', text: 'Reply with OK', cache_control: { type: 'ephemeral' } },
        ],
        messages: [{ role: 'user', content: 'test' }],
    });

    const bodyPlainSystem = JSON.stringify({
        model, max_tokens: 64, stream: false,
        system: 'Reply with OK',
        messages: [{ role: 'user', content: 'test' }],
    });

    return [
        {
            name: 'Bearer + oauth+cache beta (NO billing)',
            headers: {
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
                'anthropic-beta': 'prompt-caching-2024-07-31,oauth-2025-04-20',
                'Authorization': `Bearer ${token}`,
            },
            body,
        },
        {
            name: 'Bearer + oauth+cache beta + BILLING in system',
            headers: {
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
                'anthropic-beta': 'prompt-caching-2024-07-31,oauth-2025-04-20',
                'Authorization': `Bearer ${token}`,
            },
            body: bodyWithBilling,
        },
        {
            name: 'Bearer + oauth beta only + BILLING',
            headers: {
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
                'anthropic-beta': 'oauth-2025-04-20',
                'Authorization': `Bearer ${token}`,
            },
            body: bodyWithBilling,
        },
        {
            name: 'Bearer + cache beta only (no oauth)',
            headers: {
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
                'anthropic-beta': 'prompt-caching-2024-07-31',
                'Authorization': `Bearer ${token}`,
            },
            body,
        },
        {
            name: 'Bearer + no beta headers',
            headers: {
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
                'Authorization': `Bearer ${token}`,
            },
            body,
        },
        {
            name: 'x-api-key auth (instead of Bearer)',
            headers: {
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
                'anthropic-beta': 'prompt-caching-2024-07-31',
                'x-api-key': token,
            },
            body,
        },
        {
            name: 'Bearer + oauth+cache + system (no billing)',
            headers: {
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
                'anthropic-beta': 'prompt-caching-2024-07-31,oauth-2025-04-20',
                'Authorization': `Bearer ${token}`,
            },
            body: bodyWithSystemOnly,
        },
        {
            name: 'Bearer + no beta + plain system string',
            headers: {
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
                'Authorization': `Bearer ${token}`,
            },
            body: bodyPlainSystem,
        },
    ];
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    console.log('🧪 SeekerClaw Header Combination Test');
    console.log(`   Time: ${new Date().toISOString()}`);

    const token = process.env.SETUP_TOKEN;
    if (!token) {
        console.error('\n❌ SETUP_TOKEN not found in .env — this script tests setup token auth.');
        console.error('   Set SETUP_TOKEN=sk-ant-oat01-... in .env');
        process.exit(1);
    }

    const models = getModels();
    console.log(`   Token: ${token.slice(0, 20)}...`);
    console.log(`   Models: ${models.join(', ')}`);

    for (const model of models) {
        console.log(`\n${'═'.repeat(60)}`);
        console.log(`MODEL: ${model}`);
        console.log(`${'═'.repeat(60)}`);

        const variants = getVariants(token, model);
        const results = [];

        for (let i = 0; i < variants.length; i++) {
            const v = variants[i];
            console.log(`\n  [${i + 1}/${variants.length}] ${v.name}`);

            try {
                const res = await httpPost(v.headers, v.body);
                if (res.status === 200) {
                    const text = res.data?.content?.[0]?.text || '';
                    console.log(`     ✅ ${res.status} — "${text.slice(0, 50)}"`);
                    results.push({ name: v.name, status: res.status, ok: true });
                } else {
                    const errMsg = res.data?.error?.message || JSON.stringify(res.data).slice(0, 150);
                    console.log(`     ❌ ${res.status} — ${errMsg}`);
                    results.push({ name: v.name, status: res.status, ok: false, error: errMsg });
                }
            } catch (err) {
                console.log(`     ❌ ERROR — ${err.message}`);
                results.push({ name: v.name, status: 0, ok: false, error: err.message });
            }

            await new Promise(r => setTimeout(r, 1000));
        }

        // Per-model summary
        const working = results.filter(r => r.ok);
        const failing = results.filter(r => !r.ok);
        console.log(`\n  Summary for ${model}:`);
        if (working.length > 0) {
            console.log(`  ✅ Working: ${working.map(r => r.name).join(', ')}`);
        }
        if (failing.length > 0) {
            console.log(`  ❌ Failing: ${failing.length}/${results.length}`);
        }
    }

    console.log(`\n${'═'.repeat(60)}`);
    console.log('Done.\n');
}

main();
