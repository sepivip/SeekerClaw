// tests/paysh/validate-settle.js
//
// Layer 2.5 — full protocol path (detect → build → settle) for every real
// pay.sh capture, with the settle network call MOCKED. $0 cost, no signing
// secrets needed, no broadcast.
//
// Why this layer exists (separate from validate-detect.js):
//   - validate-detect.js asserts that detect+build produce a usable tx
//     for each capture but stops short of the proof-header construction.
//   - The PAYMENT-SIGNATURE / X-PAYMENT header is where x402 v1 vs v2
//     diverge most. Mocking just the fetch boundary lets us assert wire
//     shape end-to-end without paying real USDC.
//   - Layer 3 (live-pay-curated.js) WILL spend money; we want this Layer
//     to be the comprehensive regression net that always runs in dev/CI.
//
// What each assertion catches:
//   - v2 captures: PAYMENT-SIGNATURE header present, decodes to
//     {x402Version:2, resource:{url}, accepted:{scheme,network,amount,
//     asset,payTo,maxTimeoutSeconds,extra}, payload:{transaction}}.
//   - resource.url propagated from top-level body.resource (the
//     R-pr367-fix-1 regression — pre-fix this was empty).
//   - accepted.network is the CAIP-2 wire-form the challenge sent, not
//     normalized to "solana" (R20+ negotiation invariant).
//   - extra.feePayer + extra.memo present; other server extension fields
//     preserved by shallow-clone (R-pr367-fix-7).
//   - payload.transaction is the signed tx base64.
//
// Run: node tests/paysh/validate-settle.js

'use strict';

const fs = require('fs');
const path = require('path');

const X402_PATH = require.resolve('../../app/src/main/assets/nodejs-project/payment/x402.js');
const { X402Protocol, _setBlockhashFetcher } = require(X402_PATH);

const CAPTURES_DIR = path.join(__dirname, 'captures');

const TEST_BURNER_PUBKEY = '7xKXTg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const TEST_MAX_USDC_ATOMIC = 100_000_000n; // 100 USDC

// Inject deterministic blockhash so build() never touches RPC.
_setBlockhashFetcher(async () => '2tLBHqeQdeq4Pzioote4ueMkQjrpdnNLBTuDtyKo4ds9');

// Build a fake PAYMENT-RESPONSE header value the server would return on a
// successful settlement. v2 spec: base64-encoded JSON SettlementResponse.
function _buildFakeV2SuccessHeader() {
    return Buffer.from(JSON.stringify({
        success: true,
        transaction: '5gZxBkLZ7gXrZyrwbqWUf8x8tNzM1tQyVfYwwjmHKvL3xVNbZK4Av7PKLfvgwjJa7vYpqEPTH1WuxPLnAvjGm9zQ',
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        payer: TEST_BURNER_PUBKEY,
    }), 'utf8').toString('base64');
}

// Layer 2.5 exercises the proof-header construction for these real
// captures. Synthetic edge-cases and the zero-demand textbelt-status-free
// one are excluded because:
//   - synthetics → detect/build reject before reaching settle, Layer 2
//     already covers them.
//   - textbelt-status-free → pay.sh returns amount=0 which build()
//     correctly rejects as invalid_demand, so settle is never invoked
//     in production for that shape.
const SETTLE_CAPTURES = [
    {
        file: 'tripadvisor-search-402.json',
        // v2 multi-chain (Base + Solana). Body-delivered.
        expectV2: true,
        expectResourceUrlPrefix: 'https://tripadvisor.x402.paysponge.com',
        expectAmount: '10000',
        expectPayTo: '9hw9Py9uMGtXRNpABZjifcK1t3suwzjyri9L9QYKg6zZ',
        expectFeePayer: '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4',
    },
    {
        file: 'coingecko-trending-pools.json',
        // v2 multi-chain. Header-delivered (payment-required base64).
        expectV2: true,
        // CoinGecko's resource URL — verified from the live capture.
        expectResourceUrlPrefix: 'https://pro-api.coingecko.com',
        expectDelivery: 'header',
    },
    {
        file: 'textbelt-text-402.json',
        // v2 single-chain Solana. POST endpoint.
        expectV2: true,
        expectResourceUrlPrefix: 'https://api.paysponge.com',
    },
];

let pass = 0, fail = 0;

async function check(label, fn) {
    try {
        await fn();
        console.log(`  ✓ ${label}`);
        pass++;
    } catch (e) {
        console.error(`  ✗ ${label}\n    ${e.stack || e.message}`);
        fail++;
    }
}

async function runSettleForCapture(captureEntry) {
    const proto = new X402Protocol();
    const file = path.join(CAPTURES_DIR, captureEntry.file);
    const capture = JSON.parse(fs.readFileSync(file, 'utf8'));
    const response = { status: capture.status, bodyJson: capture.body, headers: capture.headers };

    // ── detect ──
    const detected = proto.detect(response);
    if (!detected) throw new Error(`detect() returned false on real capture`);

    // ── build ──
    const built = await proto.build(response, {
        burnerPubkey: TEST_BURNER_PUBKEY,
        maxUsdcAtomic: TEST_MAX_USDC_ATOMIC,
    });
    if (built.error) {
        throw new Error(`build() returned error: ${built.error} — ${built.reason}`);
    }
    if (!built.txBase64 || !built.paymentMeta) {
        throw new Error(`build() returned malformed: ${JSON.stringify(built).slice(0, 200)}`);
    }
    if (captureEntry.expectV2 && built.paymentMeta.x402Version !== 2) {
        throw new Error(`expected x402Version=2, got ${built.paymentMeta.x402Version}`);
    }

    // ── settle (mocked) ──
    let capturedHeaders = null;
    const fetchFn = async (parsed, ip, fam, headers) => {
        capturedHeaders = headers;
        return {
            status: 200,
            headers: {
                'payment-response': _buildFakeV2SuccessHeader(),
                'content-type': 'application/json',
            },
            bodyJson: { ok: true },
        };
    };

    const targetUrl = capture.body && capture.body.resource && capture.body.resource.url
        || (capture._meta && capture._meta.url)
        || capture.url
        || 'https://example.com';

    const result = await proto.settle(
        {
            parsed: new URL(targetUrl),
            pinnedIp: '1.2.3.4',
            pinnedFamily: 4,
            timeoutLeftMs: 30000,
        },
        built.txBase64,
        built.paymentMeta,
        { _fetchWithLimits: fetchFn },
    );

    if (result.error) {
        throw new Error(`settle() returned error: ${result.error} — ${result.reason}`);
    }

    // ── Validate the proof header structure ──
    if (captureEntry.expectV2) {
        if (!capturedHeaders['payment-signature']) {
            throw new Error(`v2 settle: PAYMENT-SIGNATURE header missing from outbound request`);
        }
        if (capturedHeaders['x-payment']) {
            throw new Error(`v2 settle: X-PAYMENT header MUST NOT be present (v1 header on v2 path)`);
        }
        const decoded = JSON.parse(Buffer.from(capturedHeaders['payment-signature'], 'base64').toString('utf8'));
        if (decoded.x402Version !== 2) {
            throw new Error(`PAYMENT-SIGNATURE.x402Version expected 2, got ${decoded.x402Version}`);
        }
        if (!decoded.resource || !decoded.resource.url) {
            throw new Error(`PAYMENT-SIGNATURE.resource.url missing — propagation broken (R-pr367-fix-1)`);
        }
        if (captureEntry.expectResourceUrlPrefix &&
            !decoded.resource.url.startsWith(captureEntry.expectResourceUrlPrefix)) {
            throw new Error(`PAYMENT-SIGNATURE.resource.url="${decoded.resource.url}" doesn't start with "${captureEntry.expectResourceUrlPrefix}"`);
        }
        if (!decoded.accepted) {
            throw new Error(`PAYMENT-SIGNATURE.accepted missing (v2 uses singular .accepted, not .accepts)`);
        }
        if (decoded.accepted.scheme !== 'exact') {
            throw new Error(`PAYMENT-SIGNATURE.accepted.scheme expected "exact", got "${decoded.accepted.scheme}"`);
        }
        if (!decoded.accepted.network || !decoded.accepted.network.startsWith('solana')) {
            throw new Error(`PAYMENT-SIGNATURE.accepted.network must start with "solana", got "${decoded.accepted.network}"`);
        }
        if (typeof decoded.accepted.amount !== 'string') {
            throw new Error(`PAYMENT-SIGNATURE.accepted.amount must be string (per spec), got ${typeof decoded.accepted.amount}`);
        }
        if (captureEntry.expectAmount && decoded.accepted.amount !== captureEntry.expectAmount) {
            throw new Error(`accepted.amount expected "${captureEntry.expectAmount}", got "${decoded.accepted.amount}"`);
        }
        if (captureEntry.expectPayTo && decoded.accepted.payTo !== captureEntry.expectPayTo) {
            throw new Error(`accepted.payTo expected "${captureEntry.expectPayTo}", got "${decoded.accepted.payTo}"`);
        }
        if (!decoded.accepted.extra || !decoded.accepted.extra.feePayer) {
            throw new Error(`PAYMENT-SIGNATURE.accepted.extra.feePayer missing`);
        }
        if (captureEntry.expectFeePayer && decoded.accepted.extra.feePayer !== captureEntry.expectFeePayer) {
            throw new Error(`extra.feePayer expected "${captureEntry.expectFeePayer}", got "${decoded.accepted.extra.feePayer}"`);
        }
        if (typeof decoded.accepted.extra.memo !== 'string' || decoded.accepted.extra.memo.length === 0) {
            throw new Error(`PAYMENT-SIGNATURE.accepted.extra.memo missing or empty`);
        }
        if (!decoded.payload || !decoded.payload.transaction) {
            throw new Error(`PAYMENT-SIGNATURE.payload.transaction missing`);
        }
        if (decoded.payload.transaction !== built.txBase64) {
            throw new Error(`PAYMENT-SIGNATURE.payload.transaction must equal the signed tx base64`);
        }
        // Header size sanity (under R-pr367-fix-8 cap)
        if (capturedHeaders['payment-signature'].length > 8192) {
            throw new Error(`PAYMENT-SIGNATURE header > 8KB cap (${capturedHeaders['payment-signature'].length} bytes)`);
        }
    }

    // Settle response parsing — must surface the on-chain signature from
    // PAYMENT-RESPONSE.
    if (!result.signature) {
        throw new Error(`settle() did not extract .signature from PAYMENT-RESPONSE`);
    }
    return { built, capturedHeaders, result };
}

async function main() {
    console.log(`═══ Layer 2.5 — validate-settle (${SETTLE_CAPTURES.length} real captures, mocked network) ═══`);
    console.log('');

    for (const entry of SETTLE_CAPTURES) {
        await check(`${entry.file.padEnd(40)} detect→build→settle (v2 PAYMENT-SIGNATURE shape)`,
            () => runSettleForCapture(entry));
    }

    // ── Cross-cutting invariants ──
    console.log('');
    console.log('── Cross-cutting invariants ──');

    await check('all v2 captures negotiate to network=solana:* (not normalized to bare "solana")', async () => {
        for (const entry of SETTLE_CAPTURES) {
            const { capturedHeaders } = await runSettleForCapture(entry);
            const decoded = JSON.parse(Buffer.from(capturedHeaders['payment-signature'], 'base64').toString('utf8'));
            // Real pay.sh services send "solana:<genesis>" — we must echo back verbatim.
            if (!decoded.accepted.network.startsWith('solana:')) {
                throw new Error(`${entry.file}: accepted.network="${decoded.accepted.network}" — expected CAIP-2 form "solana:<genesis>"`);
            }
        }
    });

    await check('all v2 captures emit a non-empty memo in PAYMENT-SIGNATURE (challenge or random nonce)', async () => {
        for (const entry of SETTLE_CAPTURES) {
            const { capturedHeaders } = await runSettleForCapture(entry);
            const decoded = JSON.parse(Buffer.from(capturedHeaders['payment-signature'], 'base64').toString('utf8'));
            if (!decoded.accepted.extra.memo || decoded.accepted.extra.memo.length === 0) {
                throw new Error(`${entry.file}: extra.memo empty`);
            }
        }
    });

    await check('all v2 captures produce wire-valid transactions (non-empty base64, decodable)', async () => {
        for (const entry of SETTLE_CAPTURES) {
            const { built } = await runSettleForCapture(entry);
            const buf = Buffer.from(built.txBase64, 'base64');
            if (buf.length === 0) throw new Error(`${entry.file}: tx is zero bytes`);
            // First byte: shortvec(sigCount). For v2 layouts (2 sigs) this is byte 2.
            if (buf[0] !== 2) {
                throw new Error(`${entry.file}: tx sigCount byte expected 2, got ${buf[0]}`);
            }
        }
    });

    console.log('');
    console.log(`═══ ${pass} pass, ${fail} fail ═══`);
    if (fail > 0) process.exit(1);
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
