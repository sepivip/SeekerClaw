// tests/paysh/validate-detect.js
//
// Layer 2 — runs every committed capture under tests/paysh/captures/
// through `X402Protocol.detect()` and `build()` (no signing, no settle).
// Validates:
//   - Real captures (tripadvisor, coingecko, textbelt) → detect=true,
//     build returns a usable {txBase64, paymentMeta} OR an EXPECTED
//     error code the caller can handle.
//   - Synthetic captures → detect/build reject with the documented
//     `_meta.expectedRejection` code.
//
// Per BAT-582 v1.6 contract: this layer is $0 cost — no network calls,
// no signing. Runs anywhere Node runs. Future CI will execute this.
//
// Run: node tests/paysh/validate-detect.js

'use strict';

const fs   = require('fs');
const path = require('path');

const X402_PATH = require.resolve('../../app/src/main/assets/nodejs-project/payment/x402.js');
const { X402Protocol, _setBlockhashFetcher } = require(X402_PATH);

const CAPTURES_DIR = path.join(__dirname, 'captures');

// A consistent fake burner pubkey + USDC cap for the build() path. The
// pubkey is base58 valid (32 bytes on-curve, generated once via Solana
// CLI for these tests). The cap is high enough to never trigger
// demand_exceeds_max_usdc on small amounts so we can isolate other
// rejection codes during validation.
const TEST_BURNER_PUBKEY = '7xKXTg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const TEST_MAX_USDC_ATOMIC = 100_000_000n; // 100 USDC

// Inject a stable blockhash so build() doesn't hit RPC.
_setBlockhashFetcher(async () => '2tLBHqeQdeq4Pzioote4ueMkQjrpdnNLBTuDtyKo4ds9');

// EXPECTATIONS maps each capture file → its expected outcome at the
// detect() + build() level.
//
// BAT-582 R23: synthetic captures ALSO must appear here (single source
// of truth for the regression gate), but the `expectedBuildError`
// value is cross-checked against the fixture's own `_meta.expectedRejection`
// field at run time — if they disagree, the test fails with a clear
// "synthetic fixture _meta disagrees with EXPECTATIONS" error. This
// keeps the fixture self-documenting (a reviewer can read the fixture
// alone and know what it asserts) AND ensures EXPECTATIONS isn't out
// of step with the committed fixture.
const EXPECTATIONS = {
    'tripadvisor-search-402.json':         { detect: true,  buildOk: true  },
    'coingecko-trending-pools.json':       { detect: true,  buildOk: true  },
    'textbelt-text-402.json':              { detect: true,  buildOk: true  },
    // BAT-769: Perplexity catalog entries (Tier 1c). Both POST endpoints,
    // both Solana-USDC parseable, both $0.01.
    'perplexity-search-402.json':          { detect: true,  buildOk: true  },
    'perplexity-agent-402.json':           { detect: true,  buildOk: true  },
    // BAT-768: StableCrypto market-data extras (20 POST endpoints, all $0.01,
    // header-delivered payment-required). CoinGecko + DefiLlama sub-APIs.
    'stablecrypto-coingecko-price-402.json':                   { detect: true, buildOk: true },
    'stablecrypto-coingecko-markets-402.json':                 { detect: true, buildOk: true },
    'stablecrypto-coingecko-chart-402.json':                   { detect: true, buildOk: true },
    'stablecrypto-coingecko-ohlc-402.json':                    { detect: true, buildOk: true },
    'stablecrypto-coingecko-top-movers-402.json':              { detect: true, buildOk: true },
    'stablecrypto-coingecko-trending-402.json':                { detect: true, buildOk: true },
    'stablecrypto-coingecko-categories-402.json':              { detect: true, buildOk: true },
    'stablecrypto-coingecko-onchain-pool-402.json':            { detect: true, buildOk: true },
    'stablecrypto-coingecko-onchain-trending-402.json':        { detect: true, buildOk: true },
    'stablecrypto-defillama-protocols-402.json':               { detect: true, buildOk: true },
    'stablecrypto-defillama-protocol-402.json':                { detect: true, buildOk: true },
    'stablecrypto-defillama-chains-402.json':                  { detect: true, buildOk: true },
    'stablecrypto-defillama-chain-tvl-402.json':               { detect: true, buildOk: true },
    'stablecrypto-defillama-yields-pools-402.json':            { detect: true, buildOk: true },
    'stablecrypto-defillama-yields-perps-402.json':            { detect: true, buildOk: true },
    'stablecrypto-defillama-stablecoins-402.json':             { detect: true, buildOk: true },
    'stablecrypto-defillama-dex-overview-402.json':            { detect: true, buildOk: true },
    'stablecrypto-defillama-fees-overview-402.json':           { detect: true, buildOk: true },
    'stablecrypto-defillama-derivatives-overview-402.json':    { detect: true, buildOk: true },
    'stablecrypto-defillama-coins-prices-historical-402.json': { detect: true, buildOk: true },
    // BAT-766: Same-provider extras (13 endpoints across 5 existing services).
    'wolframalpha-v2-query-402.json':              { detect: true, buildOk: true },
    'rentcast-avm-value-402.json':                 { detect: true, buildOk: true },
    'rentcast-properties-402.json':                { detect: true, buildOk: true },
    'rentcast-listings-sale-402.json':             { detect: true, buildOk: true },
    'rentcast-listings-rental-402.json':           { detect: true, buildOk: true },
    // tripadvisor-search-402.json — entry already exists above; not re-added (would be duplicate key)
    'tripadvisor-location-details-402.json':       { detect: true, buildOk: true },
    'tripadvisor-location-reviews-402.json':       { detect: true, buildOk: true },
    'tripadvisor-location-photos-402.json':        { detect: true, buildOk: true },
    'reducto-parse-402.json':                      { detect: true, buildOk: true },
    'crushrewards-analyst-inflation-402.json':     { detect: true, buildOk: true },
    'crushrewards-shopper-price-history-402.json': { detect: true, buildOk: true },
    'crushrewards-shopper-deal-finder-402.json':   { detect: true, buildOk: true },
    // BAT-582 v1.6 quirk: pay.sh's "free" status endpoint returns 402
    // with amount=0 (instead of 200 OK). Our build correctly rejects
    // zero demand as invalid_demand — free-via-x402 isn't a supported
    // mode in v1.6. The agent should hit free URLs directly without
    // agent_pay. If pay.sh ecosystem standardizes amount=0 as a real
    // "free" signal, a future BAT can add zero-demand handling.
    'textbelt-status-free.json':           { detect: true,  expectedBuildError: 'invalid_demand' },
    // Synthetic captures — expectedBuildError must match the fixture's
    // own _meta.expectedRejection. Cross-checked at run time.
    'synthetic-malformed-402.json':            { detect: false, expectedBuildError: 'no_payment_requirements' },
    'synthetic-no-solana-multichain-402.json': { detect: false, expectedBuildError: 'no_solana_offer' },
    'synthetic-v3-402.json':                   { detect: false, expectedBuildError: 'unsupported_version' },
    'synthetic-non-usdc-402.json':             { detect: true,  expectedBuildError: 'non_usdc_asset' }, // detect=true because we have a Solana mainnet offer; build catches asset
};

function fromCapture(capture) {
    // The capture file has shape { _meta, url, method, status, headers, body }.
    // X402Protocol expects { status, bodyJson, headers } in detect/build.
    return {
        status: capture.status,
        bodyJson: capture.body,
        headers: capture.headers,
    };
}

// Layer 3 live-pay captures the success response (status 200 + a
// PAYMENT-RESPONSE header) as `<service>-v2-success.json`. Those are NOT
// 402 challenges — Layer 2 only validates the detect/build path against
// challenges. Filter them out (same convention as validate-settle.js).
function _isV2SuccessFixture(fname) {
    // Catch both Layer 3 (test-side signing → `-v2-success.json`) and
    // Layer 3-prod (production agent_pay path → `-v2-prod-success.json`)
    // success fixtures. Neither is a 402 challenge — Layer 2 should skip.
    return fname.endsWith('-v2-success.json') || fname.endsWith('-v2-prod-success.json');
}

async function main() {
    const proto = new X402Protocol();
    const files = fs.readdirSync(CAPTURES_DIR)
        .filter(f => f.endsWith('.json'))
        .filter(f => !_isV2SuccessFixture(f))
        .sort();
    console.log(`═══ Layer 2 — validate-detect (${files.length} captures) ═══`);
    console.log('');

    let pass = 0, fail = 0;
    for (const fname of files) {
        const file = path.join(CAPTURES_DIR, fname);
        const capture = JSON.parse(fs.readFileSync(file, 'utf8'));
        const expected = EXPECTATIONS[fname];
        if (!expected) {
            // BAT-582 v1.6 R19: fail loud rather than warn-and-continue.
            // Pre-fix, a new capture committed without an entry in
            // EXPECTATIONS could pass validate-detect with a warning the
            // CI / review reader might miss — the regression gate would
            // be silently uncovered. Treat as a hard fail so adding a
            // capture forces adding the expectation in the same commit.
            console.log(`  ✗ ${fname.padEnd(48)} NO EXPECTATION DEFINED — add an entry to EXPECTATIONS map in this file`);
            fail++;
            continue;
        }
        // BAT-582 R23/R30: for synthetic fixtures, the fixture is the
        // single source of truth. The fixture's _meta.expectedRejection
        // MUST exist (R30 enforcement) and MUST match
        // EXPECTATIONS.expectedBuildError (R23 cross-check). Pre-R30 the
        // existence check was missing — a synthetic capture committed
        // without _meta.expectedRejection would silently pass even
        // though the README/comments describe it as required.
        const isSynthetic = fname.startsWith('synthetic-') ||
            (capture._meta && capture._meta.kind === 'synthetic');
        const fixtureExpectedRejection = capture._meta && capture._meta.expectedRejection;
        if (isSynthetic) {
            if (!fixtureExpectedRejection) {
                console.log(`  ✗ ${fname.padEnd(48)} SYNTHETIC FIXTURE MISSING _meta.expectedRejection — required for synthetic captures (see README "Adding a new synthetic edge-case fixture")`);
                fail++;
                continue;
            }
            if (!expected.expectedBuildError) {
                console.log(`  ✗ ${fname.padEnd(48)} SYNTHETIC EXPECTATIONS ENTRY MISSING expectedBuildError — must mirror _meta.expectedRejection="${fixtureExpectedRejection}"`);
                fail++;
                continue;
            }
        }
        if (fixtureExpectedRejection && expected.expectedBuildError &&
            fixtureExpectedRejection !== expected.expectedBuildError) {
            console.log(`  ✗ ${fname.padEnd(48)} META MISMATCH — fixture._meta.expectedRejection="${fixtureExpectedRejection}" but EXPECTATIONS.expectedBuildError="${expected.expectedBuildError}"`);
            fail++;
            continue;
        }

        const response = fromCapture(capture);
        const actualDetect = proto.detect(response);
        const detectOk = actualDetect === expected.detect;
        let buildLine = '';
        let buildPass = true;
        try {
            const built = await proto.build(response, {
                burnerPubkey: TEST_BURNER_PUBKEY,
                maxUsdcAtomic: TEST_MAX_USDC_ATOMIC,
            });
            if (expected.buildOk) {
                if (built.error) {
                    buildLine = ` build=UNEXPECTED_ERROR(${built.error})`;
                    buildPass = false;
                } else if (!built.txBase64 || !built.paymentMeta) {
                    buildLine = ' build=UNEXPECTED_SHAPE';
                    buildPass = false;
                } else {
                    buildLine = ` build=OK(${Buffer.from(built.txBase64, 'base64').length}b)`;
                }
            } else {
                if (built.error === expected.expectedBuildError) {
                    buildLine = ` build=REJECTED(${built.error}) ✓`;
                } else {
                    buildLine = ` build=WRONG_REJECTION(got=${built.error || 'success'} expected=${expected.expectedBuildError})`;
                    buildPass = false;
                }
            }
        } catch (e) {
            buildLine = ` build=THREW(${e.message})`;
            buildPass = false;
        }

        const ok = detectOk && buildPass;
        if (ok) pass++; else fail++;
        const mark = ok ? '✓' : '✗';
        console.log(`  ${mark} ${fname.padEnd(48)} detect=${actualDetect}${detectOk ? '' : ` (expected ${expected.detect})`}${buildLine}`);
    }

    console.log('');
    console.log(`═══ ${pass} pass, ${fail} fail ═══`);
    if (fail > 0) process.exit(1);
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
