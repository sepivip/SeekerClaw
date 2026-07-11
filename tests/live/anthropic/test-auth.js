#!/usr/bin/env node
// test-auth.js — Test authentication against Anthropic API
// Tests both API key and setup token auth types against /v1/models

const https = require('https');
const { loadEnv } = require('./lib');

loadEnv();

// ── HTTP helper ─────────────────────────────────────────────────────────────

function httpRequest(options) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                let data;
                try { data = JSON.parse(body); } catch { data = body; }
                resolve({ status: res.statusCode, headers: res.headers, data });
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
        req.end();
    });
}

// ── Test functions ──────────────────────────────────────────────────────────

async function testAuth(label, key, authType) {
    const auth = authType === 'setup_token'
        ? { 'Authorization': `Bearer ${key}` }
        : { 'x-api-key': key };

    const betaHeaders = authType === 'setup_token'
        ? 'prompt-caching-2024-07-31,oauth-2025-04-20'
        : 'prompt-caching-2024-07-31';

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`🔑 Testing: ${label}`);
    console.log(`   Auth type: ${authType}`);
    console.log(`   Key prefix: ${key.slice(0, 10)}...`);
    console.log(`   Beta header: ${betaHeaders}`);

    try {
        const res = await httpRequest({
            hostname: 'api.anthropic.com',
            path: '/v1/models',
            method: 'GET',
            headers: {
                'anthropic-version': '2023-06-01',
                'anthropic-beta': betaHeaders,
                ...auth,
            },
        });

        if (res.status === 200) {
            const models = res.data?.data?.map(m => m.id) || [];
            console.log(`   ✅ SUCCESS (${res.status})`);
            console.log(`   Models available: ${models.length}`);
            if (models.length <= 10) {
                models.forEach(m => console.log(`     - ${m}`));
            } else {
                models.slice(0, 5).forEach(m => console.log(`     - ${m}`));
                console.log(`     ... and ${models.length - 5} more`);
            }
        } else {
            console.log(`   ❌ FAILED (${res.status})`);
            console.log(`   Response:`, JSON.stringify(res.data, null, 2));
        }
    } catch (err) {
        console.log(`   ❌ ERROR: ${err.message}`);
    }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    console.log('🧪 SeekerClaw Auth Test');
    console.log(`   Time: ${new Date().toISOString()}`);

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const setupToken = process.env.SETUP_TOKEN;

    if (!apiKey && !setupToken) {
        console.error('\n❌ No credentials found. Set ANTHROPIC_API_KEY or SETUP_TOKEN in .env');
        process.exit(1);
    }

    if (apiKey) {
        await testAuth('API Key', apiKey, 'api_key');
    }

    if (setupToken) {
        await testAuth('Setup Token (with oauth beta)', setupToken, 'setup_token');

        // Also test WITHOUT the oauth beta header to compare
        console.log(`\n${'─'.repeat(60)}`);
        console.log(`🔑 Testing: Setup Token (WITHOUT oauth beta)`);
        console.log(`   Key prefix: ${setupToken.slice(0, 10)}...`);
        try {
            const res = await httpRequest({
                hostname: 'api.anthropic.com',
                path: '/v1/models',
                method: 'GET',
                headers: {
                    'anthropic-version': '2023-06-01',
                    'anthropic-beta': 'prompt-caching-2024-07-31',
                    'Authorization': `Bearer ${setupToken}`,
                },
            });
            if (res.status === 200) {
                console.log(`   ✅ SUCCESS (${res.status}) — oauth beta NOT required for /models`);
            } else {
                console.log(`   ❌ FAILED (${res.status})`);
                console.log(`   Response:`, JSON.stringify(res.data, null, 2));
            }
        } catch (err) {
            console.log(`   ❌ ERROR: ${err.message}`);
        }
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log('Done.\n');
}

main();
