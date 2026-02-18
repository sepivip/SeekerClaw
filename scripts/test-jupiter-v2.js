#!/usr/bin/env node
/**
 * Jupiter API Deep Diagnostic — v2
 * Prints exact field names, nested structures, every detail.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf8');
const apiKeyMatch = envContent.match(/^JUPITER_API_KEY=(.+)$/m);
const API_KEY = apiKeyMatch[1].trim();

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function httpReq(method, hostname, urlPath, headers = {}, body = null) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname, path: urlPath, method,
            headers: { 'Accept': 'application/json', 'x-api-key': API_KEY, ...headers },
        }, (res) => {
            let raw = '';
            res.on('data', chunk => raw += chunk);
            res.on('end', () => {
                let data;
                try { data = JSON.parse(raw); } catch { data = raw; }
                resolve({ status: res.statusCode, data, raw: raw.slice(0, 2000) });
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}

function hr(title) { console.log(`\n${'━'.repeat(60)}\n  ${title}\n${'━'.repeat(60)}`); }

(async () => {

    // ══════════════════════════════════════════════════════════════
    // 1. TOKEN LIST — field names check
    // ══════════════════════════════════════════════════════════════
    hr('1. TOKEN LIST — /tokens/v2/tag?query=verified');
    const t1 = await httpReq('GET', 'api.jup.ag', '/tokens/v2/tag?query=verified');
    console.log('  Status:', t1.status);
    console.log('  Is array:', Array.isArray(t1.data));
    if (Array.isArray(t1.data) && t1.data.length > 0) {
        console.log('  Count:', t1.data.length);
        const sample = t1.data[0];
        console.log('  FIELD NAMES of first token:', Object.keys(sample));
        console.log('  Has "address":', 'address' in sample);
        console.log('  Has "id":', 'id' in sample);
        console.log('  Has "mint":', 'mint' in sample);
        console.log('  sample.address =', sample.address);
        console.log('  sample.id =', sample.id);
        console.log('  sample.symbol =', sample.symbol);
        console.log('  sample.decimals =', sample.decimals);
        console.log('  Full sample:', JSON.stringify(sample, null, 2));

        // Find SOL specifically
        const sol = t1.data.find(t => t.symbol === 'SOL');
        if (sol) {
            console.log('\n  SOL token object:', JSON.stringify(sol, null, 2).slice(0, 500));
        }
    }

    // ══════════════════════════════════════════════════════════════
    // 2. TOKEN SEARCH — field names + wrapper check
    // ══════════════════════════════════════════════════════════════
    hr('2. TOKEN SEARCH — /tokens/v2/search?query=SOL');
    const t2 = await httpReq('GET', 'api.jup.ag', '/tokens/v2/search?query=SOL&limit=3');
    console.log('  Status:', t2.status);
    console.log('  typeof data:', typeof t2.data);
    console.log('  Is array:', Array.isArray(t2.data));
    if (Array.isArray(t2.data)) {
        console.log('  Count:', t2.data.length);
        if (t2.data.length > 0) {
            console.log('  FIELD NAMES:', Object.keys(t2.data[0]));
            console.log('  Has "address":', 'address' in t2.data[0]);
            console.log('  Has "id":', 'id' in t2.data[0]);
            console.log('  Has "tokens":', 'tokens' in t2.data[0]);
            console.log('  Full [0]:', JSON.stringify(t2.data[0], null, 2).slice(0, 500));
        }
    } else if (typeof t2.data === 'object') {
        console.log('  Top-level keys:', Object.keys(t2.data));
        if (t2.data.tokens) {
            console.log('  .tokens is array:', Array.isArray(t2.data.tokens));
            console.log('  .tokens count:', t2.data.tokens.length);
            if (t2.data.tokens[0]) {
                console.log('  FIELD NAMES:', Object.keys(t2.data.tokens[0]));
                console.log('  Full [0]:', JSON.stringify(t2.data.tokens[0], null, 2).slice(0, 500));
            }
        }
    }

    // Also test BONK search
    hr('2b. TOKEN SEARCH — /tokens/v2/search?query=BONK');
    const t2b = await httpReq('GET', 'api.jup.ag', '/tokens/v2/search?query=BONK&limit=3');
    console.log('  Status:', t2b.status);
    if (Array.isArray(t2b.data)) {
        console.log('  Count:', t2b.data.length);
        if (t2b.data[0]) console.log('  [0]:', JSON.stringify(t2b.data[0], null, 2).slice(0, 400));
    }

    // ══════════════════════════════════════════════════════════════
    // 3. PRICE API — exact response structure
    // ══════════════════════════════════════════════════════════════
    hr('3. PRICE API v3 — /price/v3');
    const t3 = await httpReq('GET', 'api.jup.ag', `/price/v3?ids=${SOL},${USDC}`);
    console.log('  Status:', t3.status);
    console.log('  typeof data:', typeof t3.data);
    console.log('  Top-level keys:', Object.keys(t3.data));
    console.log('  Has "data" key:', 'data' in t3.data);

    // Check if SOL is at top level or nested in .data
    const solAtTop = t3.data[SOL];
    const solInData = t3.data.data?.[SOL];
    console.log('  t3.data[SOL_MINT]:', JSON.stringify(solAtTop));
    console.log('  t3.data.data?.[SOL_MINT]:', JSON.stringify(solInData));
    console.log('\n  FULL RESPONSE:', JSON.stringify(t3.data, null, 2).slice(0, 1000));

    // Also test with BONK to check null handling
    hr('3b. PRICE API — BONK (check null/missing)');
    const t3b = await httpReq('GET', 'api.jup.ag', `/price/v3?ids=${BONK}`);
    console.log('  Status:', t3b.status);
    console.log('  FULL:', JSON.stringify(t3b.data, null, 2).slice(0, 500));

    // ══════════════════════════════════════════════════════════════
    // 4. QUOTE v6 — detailed response
    // ══════════════════════════════════════════════════════════════
    hr('4. QUOTE v6 — /swap/v1/quote (0.01 SOL → USDC)');
    const qParams = new URLSearchParams({ inputMint: SOL, outputMint: USDC, amount: '10000000', slippageBps: '100' });
    const t4 = await httpReq('GET', 'api.jup.ag', `/swap/v1/quote?${qParams}`);
    console.log('  Status:', t4.status);
    console.log('  Has outAmount:', 'outAmount' in t4.data);
    console.log('  outAmount:', t4.data.outAmount);
    if (t4.data.error) console.log('  ERROR:', t4.data.error);

    // ══════════════════════════════════════════════════════════════
    // 5. ULTRA ORDER — detailed response
    // ══════════════════════════════════════════════════════════════
    hr('5. ULTRA ORDER — /ultra/v1/order (0.01 SOL → USDC)');
    const uParams = new URLSearchParams({ inputMint: SOL, outputMint: USDC, amount: '10000000' });
    const t5 = await httpReq('GET', 'api.jup.ag', `/ultra/v1/order?${uParams}`);
    console.log('  Status:', t5.status);
    console.log('  Has requestId:', 'requestId' in t5.data);
    console.log('  Has transaction:', 'transaction' in t5.data);
    console.log('  outAmount:', t5.data.outAmount);
    if (t5.data.error) console.log('  ERROR:', t5.data.error);

    // ══════════════════════════════════════════════════════════════
    // 6. SHIELD — test different param formats
    // ══════════════════════════════════════════════════════════════
    hr('6a. SHIELD — /ultra/v1/shield?inputMint=X&outputMint=Y');
    const s1 = await httpReq('GET', 'api.jup.ag', `/ultra/v1/shield?inputMint=${SOL}&outputMint=${USDC}`);
    console.log('  Status:', s1.status);
    console.log('  Response:', JSON.stringify(s1.data).slice(0, 300));

    hr('6b. SHIELD — /ultra/v1/shield?mints=X,Y');
    const s2 = await httpReq('GET', 'api.jup.ag', `/ultra/v1/shield?mints=${SOL},${USDC}`);
    console.log('  Status:', s2.status);
    console.log('  Response:', JSON.stringify(s2.data).slice(0, 300));

    // ══════════════════════════════════════════════════════════════
    // 7. DCA — test getRecurringOrders with correct format
    // ══════════════════════════════════════════════════════════════
    hr('7a. DCA — /recurring/v1/getRecurringOrders?user=X');
    const d1 = await httpReq('GET', 'api.jup.ag', `/recurring/v1/getRecurringOrders?user=${SOL}`);
    console.log('  Status:', d1.status);
    console.log('  Response:', JSON.stringify(d1.data).slice(0, 500));

    hr('7b. DCA — /recurring/v1/getRecurringOrders?user=X&orderStatus=active');
    const d2 = await httpReq('GET', 'api.jup.ag', `/recurring/v1/getRecurringOrders?user=${SOL}&orderStatus=active`);
    console.log('  Status:', d2.status);
    console.log('  Response:', JSON.stringify(d2.data).slice(0, 500));

    // ══════════════════════════════════════════════════════════════
    // 8. TRIGGER — test with orderStatus
    // ══════════════════════════════════════════════════════════════
    hr('8. TRIGGER — /trigger/v1/getTriggerOrders?user=X&orderStatus=active');
    const tr1 = await httpReq('GET', 'api.jup.ag', `/trigger/v1/getTriggerOrders?user=${SOL}&orderStatus=active`);
    console.log('  Status:', tr1.status);
    console.log('  Response:', JSON.stringify(tr1.data).slice(0, 500));

    // ══════════════════════════════════════════════════════════════
    // 9. DCA createOrder — test params format (dry run, no wallet)
    // ══════════════════════════════════════════════════════════════
    hr('9. DCA createOrder — /recurring/v1/createOrder (test params validation)');
    const dcaBody = {
        user: SOL, // dummy
        inputMint: SOL,
        outputMint: USDC,
        params: {
            time: {
                inAmount: '1000000000',  // 1 SOL as string
                numberOfOrders: 5,
                interval: 3600,
            }
        },
    };
    const d3 = await httpReq('POST', 'api.jup.ag', '/recurring/v1/createOrder',
        { 'Content-Type': 'application/json' }, dcaBody);
    console.log('  Status:', d3.status);
    console.log('  Response:', JSON.stringify(d3.data).slice(0, 500));

    // Also test with inAmount as number
    hr('9b. DCA createOrder — inAmount as NUMBER');
    dcaBody.params.time.inAmount = 1000000000;
    const d4 = await httpReq('POST', 'api.jup.ag', '/recurring/v1/createOrder',
        { 'Content-Type': 'application/json' }, dcaBody);
    console.log('  Status:', d4.status);
    console.log('  Response:', JSON.stringify(d4.data).slice(0, 500));

    console.log(`\n${'━'.repeat(60)}\n  ALL TESTS COMPLETE\n${'━'.repeat(60)}\n`);
})();
