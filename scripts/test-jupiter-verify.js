#!/usr/bin/env node
/**
 * Jupiter API Fix Verification
 * Simulates the code's logic after fixes to confirm everything works.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf8');
const API_KEY = envContent.match(/^JUPITER_API_KEY=(.+)$/m)[1].trim();

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function httpReq(method, hostname, urlPath, headers = {}, body = null) {
    return new Promise((resolve, reject) => {
        const req = https.request({ hostname, path: urlPath, method,
            headers: { 'Accept': 'application/json', 'x-api-key': API_KEY, ...headers }
        }, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                let data; try { data = JSON.parse(raw); } catch { data = raw; }
                resolve({ status: res.statusCode, data });
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}

let passed = 0, failed = 0;

function check(name, condition, detail = '') {
    if (condition) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.log(`  ❌ ${name} ${detail}`);
        failed++;
    }
}

(async () => {
    console.log('\n═══════════════════════════════════════════════');
    console.log('  JUPITER FIX VERIFICATION');
    console.log('═══════════════════════════════════════════════\n');

    // ─── TEST 1: Token list normalization (Fix A) ───
    console.log('TEST 1: Token list normalization (Fix A)');
    const tl = await httpReq('GET', 'api.jup.ag', '/tokens/v2/tag?query=verified');
    const rawToken = tl.data[0];

    // Simulate Fix A normalization
    const normalized = {
        ...rawToken,
        address: rawToken.id || rawToken.address,
        verified: rawToken.isVerified ?? rawToken.verified ?? false,
        price: rawToken.usdPrice ?? rawToken.price ?? null,
        marketCap: rawToken.mcap ?? rawToken.marketCap ?? null,
    };
    check('Token has .address after normalization', typeof normalized.address === 'string' && normalized.address.length > 20,
        `got: ${normalized.address}`);
    check('Token.address matches id', normalized.address === rawToken.id);
    check('Token has .decimals', typeof normalized.decimals === 'number');
    check('Token has .verified (boolean)', typeof normalized.verified === 'boolean');
    check('Token has .price (number)', typeof normalized.price === 'number');

    // Simulate byMint cache
    const byMint = new Map();
    byMint.set(normalized.address, normalized);
    const solFromCache = byMint.get(SOL);
    check('SOL found in cache by mint', solFromCache !== undefined);

    // ─── TEST 2: Token search (Fix B+I) ───
    console.log('\nTEST 2: Token search response handling (Fix B+I)');
    const ts = await httpReq('GET', 'api.jup.ag', '/tokens/v2/search?query=BONK&limit=3');
    const searchData = ts.data;

    // Simulate Fix B
    const tokens = Array.isArray(searchData) ? searchData : (searchData.tokens || []);
    check('Token search returns results', tokens.length > 0, `got: ${tokens.length}`);

    if (tokens.length > 0) {
        const t = tokens[0];
        // Simulate Fix I field remapping
        const mint = t.id || t.address;
        const usdPrice = t.usdPrice ?? t.price ?? null;
        const mCap = t.mcap ?? t.marketCap ?? null;
        const verified = t.isVerified ?? t.verified ?? false;

        check('Search result has valid mint address', typeof mint === 'string' && mint.length > 20);
        check('Search result has usdPrice', usdPrice !== null, `got: ${usdPrice}`);
        check('Search result has marketCap', mCap !== null, `got: ${mCap}`);
        check('Search result has verified flag', typeof verified === 'boolean');
        check('Search result symbol is BONK-related', t.symbol.toLowerCase().includes('bonk'),
            `got: ${t.symbol}`);
    }

    // ─── TEST 3: Price API (Fix C+D) ───
    console.log('\nTEST 3: Price API response handling (Fix C+D)');
    const pr = await httpReq('GET', 'api.jup.ag', `/price/v3?ids=${SOL},${USDC},${BONK}`);
    const priceData = pr.data;

    // Simulate Fix C: direct access (no .data wrapper)
    const solPd = priceData[SOL];
    const usdcPd = priceData[USDC];
    const bonkPd = priceData[BONK];

    check('SOL price found (direct access, no .data wrapper)', solPd !== undefined);
    check('USDC price found', usdcPd !== undefined);
    check('BONK price found', bonkPd !== undefined);

    // Simulate Fix D: use usdPrice
    if (solPd) {
        const solPrice = solPd.usdPrice != null ? parseFloat(solPd.usdPrice) : null;
        check('SOL usdPrice is valid number', typeof solPrice === 'number' && solPrice > 10,
            `got: $${solPrice}`);
        console.log(`    → SOL price: $${solPrice}`);
    }
    if (usdcPd) {
        const usdcPrice = usdcPd.usdPrice != null ? parseFloat(usdcPd.usdPrice) : null;
        check('USDC usdPrice ~$1', typeof usdcPrice === 'number' && usdcPrice > 0.9 && usdcPrice < 1.1,
            `got: $${usdcPrice}`);
    }
    if (bonkPd) {
        const bonkPrice = bonkPd.usdPrice != null ? parseFloat(bonkPd.usdPrice) : null;
        check('BONK usdPrice is valid number', typeof bonkPrice === 'number' && bonkPrice > 0,
            `got: $${bonkPrice}`);
    }

    // OLD code would have done: priceData.data?.[SOL] → should be undefined
    check('OLD priceData.data?.[SOL] would fail', priceData.data === undefined,
        'WARNING: data wrapper exists — old code would work');

    // ─── TEST 4: Quote still works ───
    console.log('\nTEST 4: Quote endpoint (v6 still works)');
    const qp = new URLSearchParams({ inputMint: SOL, outputMint: USDC, amount: '10000000', slippageBps: '100' });
    const q = await httpReq('GET', 'api.jup.ag', `/swap/v1/quote?${qp}`);
    check('Quote returns 200', q.status === 200);
    check('Quote has outAmount', q.data.outAmount !== undefined, `got: ${q.data.outAmount}`);
    if (q.data.outAmount) {
        const usdcOut = Number(q.data.outAmount) / 1e6;
        console.log(`    → 0.01 SOL = ${usdcOut.toFixed(4)} USDC`);
    }

    // ─── TEST 5: Trigger orders with orderStatus (Fix H) ───
    console.log('\nTEST 5: Trigger orders with orderStatus=active (Fix H)');
    const tr = await httpReq('GET', 'api.jup.ag', `/trigger/v1/getTriggerOrders?user=${SOL}&orderStatus=active`);
    check('Trigger orders returns 200', tr.status === 200, `got: ${tr.status}`);
    check('Trigger response has orders array', Array.isArray(tr.data?.orders));

    // ─── TEST 6: DCA createOrder with number inAmount (Fix G) ───
    console.log('\nTEST 6: DCA createOrder with number inAmount (Fix G)');
    const dcaBody = {
        user: SOL,
        inputMint: SOL,
        outputMint: USDC,
        params: {
            time: {
                inAmount: 50000000000, // 50 SOL as NUMBER (not string)
                numberOfOrders: 5,
                interval: 3600,
            }
        },
    };
    const dca = await httpReq('POST', 'api.jup.ag', '/recurring/v1/createOrder',
        { 'Content-Type': 'application/json' }, dcaBody);
    // Should get proper validation (not 422 deserialization error)
    check('DCA does NOT return 422 (deserialization)', dca.status !== 422,
        `got status: ${dca.status}`);
    // Expected: 200 with transaction (or 400 if amount too small, NOT 422)
    const dcaMsg = typeof dca.data === 'string' ? dca.data : JSON.stringify(dca.data);
    check('DCA no "untagged enum" error', !dcaMsg.includes('untagged enum'),
        `response: ${dcaMsg.slice(0, 200)}`);
    console.log(`    → DCA status: ${dca.status}, response: ${dcaMsg.slice(0, 150)}`);

    // ─── SUMMARY ───
    console.log(`\n═══════════════════════════════════════════════`);
    console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
    console.log(`═══════════════════════════════════════════════\n`);

    if (failed > 0) process.exit(1);
})();
