// tests/jupiter-ultra/04-x402-paysh.js
//
// Layer 4 — pay.sh + x402 end-to-end. Reproduces what agent_pay does
// in production:
//   1. GET pay.sh URL (PAYSH_TEST_URL) → expect HTTP 402 with x402 body
//   2. X402Protocol.detect(response) → true
//   3. X402Protocol.build({burnerPubkey, maxUsdcAtomic}) → unsigned tx
//   4. signSolanaTx(tx, secret) → signed tx
//   5. X402Protocol.settle(originalRequest, signedTx, meta) → success
//
// We import the REAL production module (payment/x402.js) — same code path
// as agent_pay. Only the things that depend on the Android bridge or the
// agent_pay tool's fetch helpers are injected as locals.
//
// Run: node tests/jupiter-ultra/04-x402-paysh.js [--fixture <name>] [--dry-run]
//
// MODES:
//   live     (default) — fetch PAYSH_TEST_URL, expect HTTP 402, run full flow
//   fixture  (--fixture paysh-sandbox-402) — mock the 402 from a committed
//            fixture in tests/payment/fixtures/. settle() will fail (the
//            recipient endpoint isn't real) — use --dry-run to skip it.
//
// SAFETY: live + non-dry-run spends real USDC microunits up to
// MAX_USDC_ATOMIC (default 1 USDC). Use --dry-run to skip the settle step.
// Fixture mode + non-dry-run will broadcast a real USDC transfer to the
// fixture's payTo address — only run with --dry-run unless that's intended.

'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { URL } = require('url');

const { load, requireKeys, parseSecretKey } = require('./lib/load-env');
const { signSolanaTx, isSigned } = require('./lib/sign-tx');
const base58 = require('./lib/base58');

const X402_PATH = require.resolve('../../app/src/main/assets/nodejs-project/payment/x402.js');
const x402 = require(X402_PATH);
const { X402Protocol, _setBlockhashFetcher } = x402;

const FIXTURE_DIR = path.join(__dirname, '..', 'payment', 'fixtures');

function parseArgs(argv) {
    const out = { fixture: null, dryRun: false };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--dry-run') out.dryRun = true;
        if (argv[i] === '--fixture' && argv[i + 1]) { out.fixture = argv[i + 1]; i++; }
    }
    return out;
}

function loadFixture402(name) {
    const file = path.join(FIXTURE_DIR, `${name}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Strip _fixture metadata, return wire shape.
    const { _fixture, ...wire } = raw;
    return {
        status: wire.status,
        headers: wire.headers || {},
        body: JSON.stringify(wire.body),
        bodyJson: wire.body,
        _meta: _fixture,
    };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fetchUrl(parsed, pinnedIp, pinnedFamily, headers = {}, timeoutMs = 30000) {
    const lib = parsed.protocol === 'http:' ? http : https;
    return new Promise((resolve) => {
        const opts = {
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers: { 'Accept': 'application/json', ...headers },
        };
        const req = lib.request(opts, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                let bodyJson = null;
                try { bodyJson = JSON.parse(body); } catch (_) {}
                resolve({ status: res.statusCode, headers: res.headers, body, bodyJson });
            });
        });
        req.on('error', (e) => resolve({ error: 'fetch_failed', reason: e.message }));
        req.setTimeout(timeoutMs, () => { req.destroy(new Error(`timeout after ${timeoutMs}ms`)); });
        req.end();
    });
}

async function rpcCall(rpcUrl, method, params) {
    const u = new URL(rpcUrl);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: u.hostname,
            port: u.port || 443,
            path: u.pathname + u.search,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
                catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('rpc timeout')));
        req.write(body); req.end();
    });
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
    const args = parseArgs(process.argv);
    const env = requireKeys(load(), 'x402');
    const { secret, pubkey } = parseSecretKey(env.BURNER_SECRET_KEY);
    const burnerPubkey = base58.encode(pubkey);
    if (burnerPubkey !== env.BURNER_PUBKEY) {
        console.error('✗ BURNER_PUBKEY does not match derived pubkey from BURNER_SECRET_KEY'); process.exit(1);
    }
    const maxUsdcAtomic = BigInt(env.MAX_USDC_ATOMIC || '1000000');
    const paysh = env.PAYSH_TEST_URL;
    console.log('═══ Layer 4 — pay.sh + x402 ═══');
    console.log(`Wallet:      ${burnerPubkey}`);
    console.log(`Cap:         ${maxUsdcAtomic} microUSDC (${(Number(maxUsdcAtomic) / 1e6).toFixed(6)} USDC)`);
    if (args.fixture) {
        console.log(`Fixture:     ${args.fixture}.json (mocked 402)`);
    } else {
        console.log(`Endpoint:    ${paysh}`);
    }
    console.log(`Mode:        ${args.dryRun ? 'DRY RUN (no settle)' : 'LIVE'}`);
    console.log('');

    // Wire up blockhash fetcher to use our test RPC.
    _setBlockhashFetcher(async () => {
        const res = await rpcCall(env.SOLANA_RPC, 'getLatestBlockhash', [{ commitment: 'finalized' }]);
        if (!res.result || !res.result.value || !res.result.value.blockhash) {
            throw new Error('getLatestBlockhash returned no blockhash');
        }
        return res.result.value.blockhash;
    });

    const proto = new X402Protocol();

    // Step 1 — GET → 402 (or load from fixture)
    let initial, parsed;
    if (args.fixture) {
        console.log(`[1/5] Loading fixture ${args.fixture}.json...`);
        try { initial = loadFixture402(args.fixture); }
        catch (e) { console.error(`✗ fixture load failed: ${e.message}`); process.exit(2); }
        const r = initial.bodyJson?.accepts?.[0] || initial.bodyJson?.paymentRequirements?.[0];
        const recipientResource = r?.resource || `https://fixture.local/${args.fixture}`;
        parsed = new URL(recipientResource);
        console.log(`      ✓ status=${initial.status}, payTo=${r?.payTo || '?'}, demand=${r?.maxAmountRequired || '?'} microUSDC`);
    } else {
        console.log('[1/5] GET pay.sh URL...');
        parsed = new URL(paysh);
        initial = await fetchUrl(parsed, null, null, {}, 30000);
        if (initial.error) { console.error(`✗ fetch failed: ${initial.reason}`); process.exit(2); }
        console.log(`      HTTP ${initial.status}`);
        if (initial.status !== 402) {
            console.error('✗ expected 402, got something else. Body:');
            console.error(initial.body.slice(0, 500));
            process.exit(2);
        }
    }

    // Step 2 — detect
    console.log('');
    console.log('[2/5] X402Protocol.detect()...');
    const detected = proto.detect(initial);
    console.log(`      detected = ${detected}`);
    if (!detected) {
        console.error('✗ x402 detect() returned false. Body:');
        console.error(JSON.stringify(initial.bodyJson, null, 2));
        process.exit(2);
    }

    // Step 3 — build
    console.log('');
    console.log('[3/5] X402Protocol.build()...');
    const built = await proto.build(initial, { burnerPubkey, maxUsdcAtomic });
    if (built.error) {
        console.error(`✗ build failed: ${built.error} — ${built.reason}`);
        process.exit(2);
    }
    console.log(`      ✓ tx built (${Buffer.from(built.txBase64, 'base64').length} bytes)`);
    const bigIntReplacer = (_k, v) => (typeof v === 'bigint' ? v.toString() + 'n' : v);
    console.log(`      ✓ paymentMeta:`, JSON.stringify(built.paymentMeta, bigIntReplacer, 2));

    // Step 4 — sign locally
    console.log('');
    console.log('[4/5] Signing locally with Ed25519...');
    const signedTx = signSolanaTx(built.txBase64, secret, pubkey);
    if (!isSigned(signedTx)) { console.error('✗ local sign produced unsigned tx'); process.exit(2); }
    console.log('      ✓ signature spliced');

    if (args.dryRun) {
        console.log('');
        console.log('[5/5] SKIPPED (--dry-run). Build + sign succeeded.');
        return;
    }
    if (args.fixture) {
        console.log('');
        console.log('[5/5] SKIPPED (fixture mode — settle would broadcast a real USDC transfer to the fixture\'s payTo address; pass --dry-run to suppress this notice or run live without --fixture).');
        return;
    }

    // Step 5 — settle
    console.log('');
    console.log('[5/5] X402Protocol.settle()...');
    const originalRequest = { parsed, pinnedIp: null, pinnedFamily: null, timeoutLeftMs: 30000 };
    const settled = await proto.settle(originalRequest, signedTx, built.paymentMeta, { _fetchWithLimits: fetchUrl });
    if (settled.error) {
        console.error(`✗ settle failed: ${settled.error} — ${settled.reason}`);
        process.exit(2);
    }
    console.log(`      ✓ HTTP ${settled.response.status}`);
    if (settled.signature) {
        console.log(`      ✓ on-chain signature: ${settled.signature}`);
        console.log(`      ✓ Explorer: https://solscan.io/tx/${settled.signature}`);
    } else {
        console.log('      (no X-Payment-Response signature header — server may not echo)');
    }
    console.log('');
    console.log('═══ SUCCESS — full x402 flow works locally ═══');
}

main().catch((e) => { console.error('FATAL:', e); process.exit(2); });
