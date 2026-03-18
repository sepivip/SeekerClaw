#!/usr/bin/env node
// test-messages.js — Send a minimal message to Anthropic API per model
// Matches the app's auth headers and billing attribution; uses non-streaming + simplified prompts for test clarity

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
        req.setTimeout(60000, () => { req.destroy(new Error('timeout')); });
        req.write(body);
        req.end();
    });
}

// ── Build request exactly like the app ──────────────────────────────────────

function buildHeaders(apiKey, authType) {
    const auth = authType === 'setup_token'
        ? { 'Authorization': `Bearer ${apiKey}` }
        : { 'x-api-key': apiKey };

    return {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': authType === 'setup_token'
            ? 'prompt-caching-2024-07-31,oauth-2025-04-20'
            : 'prompt-caching-2024-07-31',
        ...auth,
    };
}

function buildBody(model, authType) {
    const system = [];
    // Billing attribution — required for setup tokens to access non-Haiku models
    if (authType === 'setup_token') {
        system.push({ type: 'text', text: CC_BILLING_HEADER });
    }
    system.push({ type: 'text', text: 'Reply with exactly: PONG', cache_control: { type: 'ephemeral' } });

    return JSON.stringify({
        model,
        max_tokens: 128,
        stream: false,
        system,
        messages: [{ role: 'user', content: 'PING' }],
    });
}

// ── Test a single model ─────────────────────────────────────────────────────

async function testModel(model, apiKey, authType) {
    const headers = buildHeaders(apiKey, authType);
    const body = buildBody(model, authType);

    process.stdout.write(`   ${model.padEnd(24)} → `);

    try {
        const res = await httpPost(headers, body);

        if (res.status === 200) {
            const text = res.data?.content?.[0]?.text || '(no text)';
            const usage = res.data?.usage || {};
            console.log(`✅ ${res.status} | "${text.slice(0, 40)}" | in=${usage.input_tokens} out=${usage.output_tokens}`);
            return { model, status: 'ok' };
        } else {
            const errMsg = res.data?.error?.message || JSON.stringify(res.data).slice(0, 120);
            console.log(`❌ ${res.status} | ${errMsg}`);
            return { model, status: 'error', code: res.status, message: errMsg };
        }
    } catch (err) {
        console.log(`❌ ${err.message}`);
        return { model, status: 'error', message: err.message };
    }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    console.log('🧪 SeekerClaw Messages Test');
    console.log(`   Time: ${new Date().toISOString()}`);

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const setupToken = process.env.SETUP_TOKEN;

    if (!apiKey && !setupToken) {
        console.error('\n❌ No credentials found. Set ANTHROPIC_API_KEY or SETUP_TOKEN in .env');
        process.exit(1);
    }

    const models = getModels();
    console.log(`   Models: ${models.join(', ')}`);

    // Test with API key
    if (apiKey) {
        console.log(`\n${'─'.repeat(60)}`);
        console.log(`🔑 API Key auth (x-api-key)`);
        console.log(`   Key: ${apiKey.slice(0, 10)}...`);
        for (const model of models) {
            await testModel(model, apiKey, 'api_key');
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    // Test with setup token
    if (setupToken) {
        console.log(`\n${'─'.repeat(60)}`);
        console.log(`🔑 Setup Token auth (Bearer + oauth beta + billing attribution)`);
        console.log(`   Token: ${setupToken.slice(0, 10)}...`);
        for (const model of models) {
            await testModel(model, setupToken, 'setup_token');
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log('Done.\n');
}

main();
