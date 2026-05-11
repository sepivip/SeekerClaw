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

// Map each capture file → its expected outcome at the build() level.
// For real captures we expect detect=true and a real build success.
// For synthetic captures we read `_meta.expectedRejection`.
// For multi-chain real captures (Tripadvisor, Textbelt with EVM+Solana
// offers), detect=true and build picks Solana → success.
const EXPECTATIONS = {
    'tripadvisor-search-402.json':         { detect: true,  buildOk: true  },
    'coingecko-trending-pools.json':       { detect: true,  buildOk: true  },
    'textbelt-text-402.json':              { detect: true,  buildOk: true  },
    // BAT-582 v1.6 quirk: pay.sh's "free" status endpoint returns 402
    // with amount=0 (instead of 200 OK). Our build correctly rejects
    // zero demand as invalid_demand — free-via-x402 isn't a supported
    // mode in v1.6. The agent should hit free URLs directly without
    // agent_pay. If pay.sh ecosystem standardizes amount=0 as a real
    // "free" signal, a future BAT can add zero-demand handling.
    'textbelt-status-free.json':           { detect: true,  expectedBuildError: 'invalid_demand' },
    // Synthetic captures pull expectedRejection from _meta.
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

async function main() {
    const proto = new X402Protocol();
    const files = fs.readdirSync(CAPTURES_DIR).filter(f => f.endsWith('.json')).sort();
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
