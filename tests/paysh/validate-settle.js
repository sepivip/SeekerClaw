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
//   - extra.feePayer present; other server extension fields preserved by
//     shallow-clone (R-pr367-fix-7). Memo is NOT in accepted.extra unless
//     the challenge included it (R-pr368-live-fix-1) — it lives in the
//     tx as a Memo instruction (on-chain commitment).
//   - payload.transaction round-trips the built tx base64 (Layer 2.5
//     passes the unsigned/placeholder tx straight into settle — actual
//     signing happens in agent_pay between build() and settle() via the
//     Android bridge; what we're pinning here is the round-trip plumbing).
//
// Run: node tests/paysh/validate-settle.js

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const X402_PATH = require.resolve('../../app/src/main/assets/nodejs-project/payment/x402.js');
const { X402Protocol, _setBlockhashFetcher, _extractPayload } = require(X402_PATH);

const CAPTURES_DIR = path.join(__dirname, 'captures');

const TEST_BURNER_PUBKEY = '7xKXTg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const TEST_MAX_USDC_ATOMIC = 100_000_000n; // 100 USDC

// Inject deterministic blockhash so build() never touches RPC.
_setBlockhashFetcher(async () => '2tLBHqeQdeq4Pzioote4ueMkQjrpdnNLBTuDtyKo4ds9');

// Fake on-chain signature the mock facilitator "returns" in PAYMENT-RESPONSE.
// Asserted exactly by per-capture checks so a parsing regression that picks
// the wrong field (e.g. reads payer/network instead of transaction) fails
// loud rather than silently returning a non-empty-but-wrong value.
const FAKE_SETTLEMENT_SIGNATURE = '5gZxBkLZ7gXrZyrwbqWUf8x8tNzM1tQyVfYwwjmHKvL3xVNbZK4Av7PKLfvgwjJa7vYpqEPTH1WuxPLnAvjGm9zQ';

// Build a fake PAYMENT-RESPONSE header value the server would return on a
// successful settlement. v2 spec: base64-encoded JSON SettlementResponse.
function _buildFakeV2SuccessHeader() {
    return Buffer.from(JSON.stringify({
        success: true,
        transaction: FAKE_SETTLEMENT_SIGNATURE,
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
// expectDelivery values: 'body' (challenge in JSON body, accepts[]) or
// 'header' (challenge in the `payment-required` response header, base64).
// Asserted at run time so the field actually means something.
const SETTLE_CAPTURES = [
    {
        file: 'tripadvisor-search-402.json',
        // v2 multi-chain (Base + Solana). Body-delivered.
        expectV2: true,
        expectDelivery: 'body',
        expectResourceUrlPrefix: 'https://tripadvisor.x402.paysponge.com',
        expectAmount: '10000',
        expectPayTo: '9hw9Py9uMGtXRNpABZjifcK1t3suwzjyri9L9QYKg6zZ',
        expectFeePayer: '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4',
    },
    {
        file: 'coingecko-trending-pools.json',
        // v2 multi-chain. Header-delivered (payment-required base64).
        expectV2: true,
        expectDelivery: 'header',
        // CoinGecko's resource URL — verified from the live capture.
        expectResourceUrlPrefix: 'https://pro-api.coingecko.com',
    },
    {
        file: 'textbelt-text-402.json',
        // v2 single-chain Solana. POST endpoint.
        expectV2: true,
        expectDelivery: 'body',
        expectResourceUrlPrefix: 'https://api.paysponge.com',
    },
    // BAT-769: Perplexity catalog (Tier 1c) — both endpoints multi-chain
    // (Base + Solana), POST. paysponge delivers the challenge in BOTH the
    // body's accepts[] AND a base64 payment-required header — parser picks
    // body first (the spec-preferred channel), so the validated delivery
    // mode for these captures is 'body'.
    {
        file: 'perplexity-search-402.json',
        expectV2: true,
        expectDelivery: 'body',
        expectResourceUrlPrefix: 'https://pplx.x402.paysponge.com',
    },
    {
        file: 'perplexity-agent-402.json',
        expectV2: true,
        expectDelivery: 'body',
        expectResourceUrlPrefix: 'https://pplx.x402.paysponge.com',
    },
];

// Detect which delivery mode a capture uses by calling the parser's own
// `_extractPayload` directly. R-pr368-fix-4: prior versions duplicated
// the logic and drifted from the parser (missing max-base64 length cap,
// no body-shape decode/parse, etc.). Using the exported helper keeps
// this test bit-identical to production behavior — any parser change
// flows through automatically.
function detectDelivery(capture) {
    const response = {
        status: capture.status,
        bodyJson: capture.body,
        headers: capture.headers,
    };
    const extracted = _extractPayload(response);
    return extracted ? extracted.source : 'none';
}

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

// Run detect → build → settle once for a capture and return the
// captured artifacts. Cached per-capture in `runCache` below so the
// per-capture assertions and the cross-cutting invariants don't redo
// the same work (was R1 finding 2 on PR #368).
async function runSettleForCapture(captureEntry) {
    const proto = new X402Protocol();
    const file = path.join(CAPTURES_DIR, captureEntry.file);
    const capture = JSON.parse(fs.readFileSync(file, 'utf8'));
    const response = { status: capture.status, bodyJson: capture.body, headers: capture.headers };

    // ── delivery mode ──
    const actualDelivery = detectDelivery(capture);
    if (captureEntry.expectDelivery && captureEntry.expectDelivery !== actualDelivery) {
        throw new Error(`delivery mismatch: capture is ${actualDelivery}, expected ${captureEntry.expectDelivery}`);
    }

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
        // R-pr368-fix-6: paymentMeta carries BigInt fields (e.g. amountAtomic);
        // plain JSON.stringify throws on those, which would hide the underlying
        // malformed-build error path. Log shape only (keys + types).
        const shape = Object.entries(built || {}).map(([k, v]) => `${k}=${typeof v}`).join(',');
        throw new Error(`build() returned malformed: {${shape}}`);
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
        // R-pr368-live-fix-1 / R-pr369-fix-1 / R-pr369-fix-4: assert the
        // real invariant — `accepted.extra` must equal the challenge's
        // `accepts[i].extra` EXACTLY (deep strict equality). Pre-fix this
        // hard-coded `!('memo' in ...)` (false alarms on future captures
        // with extra.memo); intermediate fix used per-key `!==` (would
        // false-fail on any nested object/array because JSON.parse creates
        // a new identity). Now uses assert.deepStrictEqual which handles
        // nested structures correctly. The key-mismatch error message is
        // kept for diagnostic clarity since deepStrictEqual's default
        // message can be hard to read for object diffs.
        const challengeExtra = built.paymentMeta.requirement.extra || {};
        const proofExtraKeys = Object.keys(decoded.accepted.extra).sort();
        const challengeExtraKeys = Object.keys(challengeExtra).sort();
        if (proofExtraKeys.join(',') !== challengeExtraKeys.join(',')) {
            throw new Error(`PAYMENT-SIGNATURE.accepted.extra keys mismatch challenge.accepts[i].extra: proof=[${proofExtraKeys.join(',')}] challenge=[${challengeExtraKeys.join(',')}] — strict facilitators (paysponge) reject "No matching payment requirements"`);
        }
        assert.deepStrictEqual(
            decoded.accepted.extra,
            challengeExtra,
            `PAYMENT-SIGNATURE.accepted.extra does not deep-equal challenge.accepts[i].extra`,
        );
        if (!decoded.payload || !decoded.payload.transaction) {
            throw new Error(`PAYMENT-SIGNATURE.payload.transaction missing`);
        }
        if (decoded.payload.transaction !== built.txBase64) {
            throw new Error(`PAYMENT-SIGNATURE.payload.transaction must round-trip the built tx base64 (Layer 2.5 doesn't sign — pins the build→settle plumbing, not signing)`);
        }
        // Header size sanity (under R-pr367-fix-8 cap)
        if (capturedHeaders['payment-signature'].length > 8192) {
            throw new Error(`PAYMENT-SIGNATURE header > 8KB cap (${capturedHeaders['payment-signature'].length} bytes)`);
        }
    }

    // Settle response parsing — must surface the on-chain signature from
    // PAYMENT-RESPONSE. Pin the exact value (not just truthy) so a
    // parser regression that picks the wrong field (e.g. payer, network,
    // or a generic non-empty stub) fails loud here.
    if (result.signature !== FAKE_SETTLEMENT_SIGNATURE) {
        throw new Error(`settle() returned signature="${result.signature}" — expected exact match against fake PAYMENT-RESPONSE.transaction (parser may be reading the wrong field)`);
    }
    return { built, capturedHeaders, result };
}

// Coverage guard: every real capture in captures/ that should pass through
// Layer 2.5 MUST appear in SETTLE_CAPTURES, else a new fixture committed
// without an entry would silently bypass settle-path coverage. Mirrors the
// "fail loud" pattern from validate-detect.js (R19 in PR #366 review).
//
// What's NOT covered here (and shouldn't be):
//   - Synthetic edge-case fixtures (filename prefix `synthetic-`) — they
//     reject at detect/build, so settle is never reached in production;
//     validate-detect.js asserts their rejection codes.
//   - The `textbelt-status-free` fixture — pay.sh returns 402 with
//     amount=0 for free endpoints, which build() correctly rejects as
//     `invalid_demand`. settle never runs.
function _isExcludedFromSettleCoverage(fname) {
    if (fname.startsWith('synthetic-')) return true;
    if (fname === 'textbelt-status-free.json') return true;
    // Layer 3 live-pay captures the success response (status 200 + a
    // PAYMENT-RESPONSE header) as `<service>-v2-success.json`. These
    // are NOT 402 challenges — Layer 2.5 only validates the
    // detect/build/settle path against challenge captures.
    // Catch both Layer 3 and Layer 3-prod success fixtures (see
    // validate-detect.js _isV2SuccessFixture for the matching pattern).
    if (fname.endsWith('-v2-success.json')) return true;
    if (fname.endsWith('-v2-prod-success.json')) return true;
    return false;
}

function _assertSettleCoverage() {
    const all = fs.readdirSync(CAPTURES_DIR).filter(f => f.endsWith('.json'));
    const covered = new Set(SETTLE_CAPTURES.map(e => e.file));
    const missing = [];
    for (const fname of all) {
        if (_isExcludedFromSettleCoverage(fname)) continue;
        if (!covered.has(fname)) missing.push(fname);
    }
    if (missing.length > 0) {
        console.error('');
        console.error(`✗ COVERAGE GAP: real capture(s) committed without a SETTLE_CAPTURES entry:`);
        for (const m of missing) console.error(`    - ${m}`);
        console.error(`  Add an entry to SETTLE_CAPTURES in this file (or, if the capture should NOT`);
        console.error(`  exercise settle, document why in _isExcludedFromSettleCoverage).`);
        process.exit(1);
    }
}

async function main() {
    _assertSettleCoverage();

    console.log(`═══ Layer 2.5 — validate-settle (${SETTLE_CAPTURES.length} real captures, mocked network) ═══`);
    console.log('');

    // Run each capture once, cache the artifacts, and reuse them in the
    // cross-cutting invariants below. Pre-fix the invariants re-ran
    // detect/build/settle per capture which scaled O(captures × invariants).
    const runCache = new Map();
    for (const entry of SETTLE_CAPTURES) {
        await check(`${entry.file.padEnd(40)} detect→build→settle (v2 PAYMENT-SIGNATURE shape)`,
            async () => {
                const artifacts = await runSettleForCapture(entry);
                runCache.set(entry.file, artifacts);
            });
    }

    // ── Cross-cutting invariants ──
    // All invariants iterate the cached artifacts produced above — no
    // re-running of detect/build/settle. Entries that failed their
    // per-capture check are absent from the cache; we skip those so an
    // unrelated failure doesn't cascade into invariant noise.
    console.log('');
    console.log('── Cross-cutting invariants ──');

    await check('all v2 captures negotiate to network=solana:* (not normalized to bare "solana")', () => {
        for (const entry of SETTLE_CAPTURES.filter(e => e.expectV2)) {
            const artifacts = runCache.get(entry.file);
            if (!artifacts) continue;
            const decoded = JSON.parse(Buffer.from(artifacts.capturedHeaders['payment-signature'], 'base64').toString('utf8'));
            // Real pay.sh services send "solana:<genesis>" — we must echo back verbatim.
            if (!decoded.accepted.network.startsWith('solana:')) {
                throw new Error(`${entry.file}: accepted.network="${decoded.accepted.network}" — expected CAIP-2 form "solana:<genesis>"`);
            }
        }
    });

    await check('all v2 captures: accepted.extra deep-equals challenge accepts[i].extra (R-pr368-live-fix-1 / R-pr369-fix-4)', () => {
        // Strict facilitators (paysponge) reject "No matching payment
        // requirements" when accepted.extra differs from the challenge.
        // Use deepStrictEqual so nested objects/arrays compare correctly
        // (per-key `!==` would false-fail because JSON.parse creates new
        // object identities even for equivalent values).
        for (const entry of SETTLE_CAPTURES.filter(e => e.expectV2)) {
            const artifacts = runCache.get(entry.file);
            if (!artifacts) continue;
            const decoded = JSON.parse(Buffer.from(artifacts.capturedHeaders['payment-signature'], 'base64').toString('utf8'));
            const challengeExtra = artifacts.built.paymentMeta.requirement.extra || {};
            const proofKeys = Object.keys(decoded.accepted.extra).sort();
            const chKeys = Object.keys(challengeExtra).sort();
            if (proofKeys.join(',') !== chKeys.join(',')) {
                throw new Error(`${entry.file}: accepted.extra keys [${proofKeys.join(',')}] != challenge.extra keys [${chKeys.join(',')}]`);
            }
            assert.deepStrictEqual(
                decoded.accepted.extra,
                challengeExtra,
                `${entry.file}: accepted.extra does not deep-equal challenge.extra`,
            );
        }
    });

    await check('all v2 captures produce wire-valid transactions (non-empty base64, decodable)', () => {
        for (const entry of SETTLE_CAPTURES.filter(e => e.expectV2)) {
            const artifacts = runCache.get(entry.file);
            if (!artifacts) continue;
            const buf = Buffer.from(artifacts.built.txBase64, 'base64');
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
