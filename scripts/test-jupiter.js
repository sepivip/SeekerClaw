#!/usr/bin/env node
/**
 * Jupiter API Integration Test
 * Tests all endpoints used by SeekerClaw to diagnose issues.
 * Usage: node scripts/test-jupiter.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Load API key from .env
const envPath = path.join(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf8');
const apiKeyMatch = envContent.match(/^JUPITER_API_KEY=(.+)$/m);
if (!apiKeyMatch || !apiKeyMatch[1].trim()) {
    console.error('ERROR: JUPITER_API_KEY not found in .env');
    process.exit(1);
}
const API_KEY = apiKeyMatch[1].trim();
console.log(`API Key: ${API_KEY.slice(0, 8)}...${API_KEY.slice(-4)}\n`);

// Well-known mints
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function httpGet(hostname, urlPath, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname,
            path: urlPath,
            method: 'GET',
            headers: { 'Accept': 'application/json', 'x-api-key': API_KEY, ...headers },
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                let data;
                try { data = JSON.parse(body); } catch { data = body; }
                resolve({ status: res.statusCode, data, rawLength: body.length });
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
        req.end();
    });
}

async function test(name, fn) {
    process.stdout.write(`\n${'='.repeat(60)}\n[TEST] ${name}\n${'='.repeat(60)}\n`);
    try {
        await fn();
    } catch (e) {
        console.log(`  EXCEPTION: ${e.message}`);
    }
}

(async () => {
    // ─────────────────────────────────────────────────────────────
    // TEST 1: Token list (verified) — used by fetchJupiterTokenList()
    // Current code: GET /tokens/v2/tag?query=verified
    // Expects: Array.isArray(res.data)
    // ─────────────────────────────────────────────────────────────
    await test('Token List (verified) — /tokens/v2/tag?query=verified', async () => {
        const res = await httpGet('api.jup.ag', '/tokens/v2/tag?query=verified');
        console.log(`  Status: ${res.status}`);
        console.log(`  Response length: ${res.rawLength} bytes`);
        console.log(`  Is array: ${Array.isArray(res.data)}`);
        console.log(`  Type: ${typeof res.data}`);
        if (Array.isArray(res.data)) {
            console.log(`  Token count: ${res.data.length}`);
            console.log(`  Sample [0]:`, JSON.stringify(res.data[0], null, 2).slice(0, 300));
        } else if (typeof res.data === 'object') {
            console.log(`  Top-level keys: ${Object.keys(res.data).join(', ')}`);
            // Check if it's wrapped in a container
            for (const key of Object.keys(res.data)) {
                if (Array.isArray(res.data[key])) {
                    console.log(`  >>> res.data.${key} IS an array with ${res.data[key].length} items`);
                    console.log(`  >>> Sample:`, JSON.stringify(res.data[key][0], null, 2).slice(0, 200));
                }
            }
        } else {
            console.log(`  Raw (first 500):`, String(res.data).slice(0, 500));
        }
    });

    // ─────────────────────────────────────────────────────────────
    // TEST 2: Token search — used by jupiter_token_search tool
    // Current code: GET /tokens/v2/search?query=SOL&limit=10
    // Expects: res.data.tokens (array)
    // ─────────────────────────────────────────────────────────────
    await test('Token Search — /tokens/v2/search?query=SOL', async () => {
        const res = await httpGet('api.jup.ag', '/tokens/v2/search?query=SOL&limit=5');
        console.log(`  Status: ${res.status}`);
        console.log(`  Type: ${typeof res.data}`);
        console.log(`  Is array: ${Array.isArray(res.data)}`);
        if (typeof res.data === 'object' && !Array.isArray(res.data)) {
            console.log(`  Top-level keys: ${Object.keys(res.data).join(', ')}`);
            if (res.data.tokens) {
                console.log(`  tokens count: ${res.data.tokens.length}`);
                console.log(`  Sample token:`, JSON.stringify(res.data.tokens[0], null, 2).slice(0, 300));
            }
        } else if (Array.isArray(res.data)) {
            console.log(`  >>> Response IS a flat array (not {tokens: [...]})!`);
            console.log(`  Count: ${res.data.length}`);
            console.log(`  Sample:`, JSON.stringify(res.data[0], null, 2).slice(0, 300));
        } else {
            console.log(`  Raw (first 500):`, String(res.data).slice(0, 500));
        }
    });

    // ─────────────────────────────────────────────────────────────
    // TEST 3: Price API v3 — used by jupiterPrice()
    // Current code: GET /price/v3?ids=<mints>
    // Expects: res.data.data[mint].price
    // ─────────────────────────────────────────────────────────────
    await test('Price API v3 — /price/v3?ids=SOL,USDC', async () => {
        const ids = `${SOL_MINT},${USDC_MINT}`;
        const res = await httpGet('api.jup.ag', `/price/v3?ids=${encodeURIComponent(ids)}`);
        console.log(`  Status: ${res.status}`);
        console.log(`  Type: ${typeof res.data}`);
        if (typeof res.data === 'object') {
            console.log(`  Top-level keys: ${Object.keys(res.data).join(', ')}`);
            if (res.data.data) {
                console.log(`  data keys: ${Object.keys(res.data.data).join(', ').slice(0, 120)}`);
                const solPrice = res.data.data[SOL_MINT];
                console.log(`  SOL price entry:`, JSON.stringify(solPrice, null, 2));
                const usdcPrice = res.data.data[USDC_MINT];
                console.log(`  USDC price entry:`, JSON.stringify(usdcPrice, null, 2));
            }
        } else {
            console.log(`  Raw (first 500):`, String(res.data).slice(0, 500));
        }
    });

    // ─────────────────────────────────────────────────────────────
    // TEST 4: Old Quote API v6 — used by jupiterQuote() (SUSPECTED BROKEN)
    // Current code: GET /swap/v1/quote?inputMint=...&outputMint=...&amount=...
    // ─────────────────────────────────────────────────────────────
    await test('OLD Quote v6 — /swap/v1/quote (SUSPECTED BROKEN)', async () => {
        const params = new URLSearchParams({
            inputMint: SOL_MINT,
            outputMint: USDC_MINT,
            amount: '10000000', // 0.01 SOL
            slippageBps: '100',
        });
        const res = await httpGet('api.jup.ag', `/swap/v1/quote?${params.toString()}`);
        console.log(`  Status: ${res.status}`);
        console.log(`  Type: ${typeof res.data}`);
        if (typeof res.data === 'object') {
            console.log(`  Top-level keys: ${Object.keys(res.data).join(', ')}`);
            if (res.data.error) console.log(`  ERROR: ${JSON.stringify(res.data.error)}`);
            if (res.data.outAmount) console.log(`  outAmount: ${res.data.outAmount}`);
            console.log(`  Full response (first 500):`, JSON.stringify(res.data).slice(0, 500));
        } else {
            console.log(`  Raw (first 500):`, String(res.data).slice(0, 500));
        }
    });

    // ─────────────────────────────────────────────────────────────
    // TEST 5: Ultra API order — used by jupiterUltraOrder() in solana_swap
    // Current code: GET /ultra/v1/order?inputMint=...&outputMint=...&amount=...
    // ─────────────────────────────────────────────────────────────
    await test('Ultra API — /ultra/v1/order (no taker, just check endpoint)', async () => {
        const params = new URLSearchParams({
            inputMint: SOL_MINT,
            outputMint: USDC_MINT,
            amount: '10000000', // 0.01 SOL
        });
        // Note: Ultra order needs a taker (wallet pubkey), we skip it to just test if endpoint responds
        const res = await httpGet('api.jup.ag', `/ultra/v1/order?${params.toString()}`);
        console.log(`  Status: ${res.status}`);
        console.log(`  Type: ${typeof res.data}`);
        if (typeof res.data === 'object') {
            console.log(`  Top-level keys: ${Object.keys(res.data).join(', ')}`);
            if (res.data.error) console.log(`  Error: ${JSON.stringify(res.data.error)}`);
            console.log(`  Full (first 500):`, JSON.stringify(res.data).slice(0, 500));
        }
    });

    // ─────────────────────────────────────────────────────────────
    // TEST 6: Ultra Shield — used for token security checks
    // Current code: GET /ultra/v1/shield?inputMint=...&outputMint=...
    // ─────────────────────────────────────────────────────────────
    await test('Ultra Shield — /ultra/v1/shield', async () => {
        const params = new URLSearchParams({
            inputMint: SOL_MINT,
            outputMint: USDC_MINT,
        });
        const res = await httpGet('api.jup.ag', `/ultra/v1/shield?${params.toString()}`);
        console.log(`  Status: ${res.status}`);
        console.log(`  Response:`, JSON.stringify(res.data).slice(0, 400));
    });

    // ─────────────────────────────────────────────────────────────
    // TEST 7: DCA/Recurring — list orders (read-only test)
    // Current code: GET /recurring/v1/getRecurringOrders?user=...
    // ─────────────────────────────────────────────────────────────
    await test('DCA Recurring — /recurring/v1/getRecurringOrders (dummy user)', async () => {
        // Use a random address — should return empty, not error
        const res = await httpGet('api.jup.ag', '/recurring/v1/getRecurringOrders?user=' + SOL_MINT);
        console.log(`  Status: ${res.status}`);
        console.log(`  Type: ${typeof res.data}`);
        if (typeof res.data === 'object') {
            console.log(`  Top-level keys: ${Object.keys(res.data).join(', ')}`);
            console.log(`  Full (first 500):`, JSON.stringify(res.data).slice(0, 500));
        }
    });

    // ─────────────────────────────────────────────────────────────
    // TEST 8: Trigger/Limit Orders — list orders
    // Current code: GET /trigger/v1/getTriggerOrders?user=...
    // ─────────────────────────────────────────────────────────────
    await test('Trigger Orders — /trigger/v1/getTriggerOrders (dummy user)', async () => {
        const res = await httpGet('api.jup.ag', '/trigger/v1/getTriggerOrders?user=' + SOL_MINT);
        console.log(`  Status: ${res.status}`);
        console.log(`  Type: ${typeof res.data}`);
        if (typeof res.data === 'object') {
            console.log(`  Top-level keys: ${Object.keys(res.data).join(', ')}`);
            console.log(`  Full (first 500):`, JSON.stringify(res.data).slice(0, 500));
        }
    });

    // ─────────────────────────────────────────────────────────────
    // TEST 9: Ultra Holdings — wallet token balances
    // ─────────────────────────────────────────────────────────────
    await test('Ultra Holdings — /ultra/v1/holdings (dummy wallet)', async () => {
        const res = await httpGet('api.jup.ag', `/ultra/v1/holdings/${SOL_MINT}`);
        console.log(`  Status: ${res.status}`);
        console.log(`  Response (first 300):`, JSON.stringify(res.data).slice(0, 300));
    });

    console.log(`\n${'='.repeat(60)}\nDONE — All tests complete\n${'='.repeat(60)}\n`);
})();
