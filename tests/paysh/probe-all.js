// tests/paysh/probe-all.js
//
// Layer 1 — pay.sh catalog probe. Hits a curated list of pay.sh services
// once each, captures the 402 response (or 200 if free), sanitizes per
// the BAT-582 v1.6 contract, and writes to tests/paysh/captures/.
//
// COSTS NOTHING: we send NO X-PAYMENT header. Paid endpoints respond with
// 402 + their payment requirements — that IS the data we want to commit
// as a fixture for the v2 parser. Free endpoints respond with 200 and
// some content; we sanitize and keep the shape.
//
// Run: node tests/paysh/probe-all.js
//      node tests/paysh/probe-all.js --service tripadvisor   (single service)
//
// PER CONTRACT v1.6 (Codex sign-off 2026-05-10):
//   - Default mode is probe-only. NO `--live` payment flag exists in this
//     script. Live payment is in a separate `live-pay-curated.js`.
//   - Rate: 1 req/sec to avoid overloading pay.sh
//   - Captures sanitized via lib/sanitize.js before write
//   - Synthetic edge-case fixtures (malformed-402, no-Solana-multichain,
//     v3, non-USDC) are authored separately, not generated here.

'use strict';

const fs = require('fs');
const path = require('path');

const { probe, sleep } = require('./lib/probe');
const { sanitize } = require('./lib/sanitize');

const CAPTURES_DIR = path.join(__dirname, 'captures');

// Curated probe list. Each entry pins the exact endpoint we capture and a
// short label for the output filename. We deliberately do NOT auto-discover
// from the live pay.sh catalog because:
//   1. Catalog pages are HTML — parsing them is brittle.
//   2. The catalog can grow/shrink; the captures we commit are a snapshot
//      at PR-merge time, not a live mirror.
//   3. We want named, reviewable fixtures, not 72 anonymous JSON files.
//
// Add new services here when we want them in the regression set.
const PROBE_LIST = [
    {
        label: 'tripadvisor-search-402',
        description: 'v2 paid GET, multi-chain Base+Solana',
        url: 'https://tripadvisor.x402.paysponge.com/api/v1/location/search?searchQuery=Tbilisi&category=restaurants',
        method: 'GET',
        expect: { status: 402, version: 'v2' },
    },
    {
        label: 'coingecko-trending-pools',
        description: 'v2 endpoint, expected free at probe time',
        url: 'https://pro-api.coingecko.com/api/v3/x402/onchain/networks/solana/trending_pools',
        method: 'GET',
        expect: { status: 'any', version: 'unknown' },
    },
    {
        label: 'textbelt-text-402',
        description: 'v2 paid POST, single-chain Solana, side-effecting (SMS send)',
        url: 'https://api.paysponge.com/x402/purchase/svc_d6kszbre4qwg5n4n4/text',
        method: 'POST',
        // Send a minimal probe body so the endpoint sees a well-formed
        // request and responds with payment requirements (not a 4xx for
        // missing/invalid body). Phone is a placeholder; we never reach
        // settle in probe mode.
        body: { phone: '+15555555555', message: 'probe' },
        expect: { status: 402, version: 'v2' },
        // BAT-582 R34: flag side-effecting probes (POST endpoints whose
        // action mutates external state). Skipped by default. Pass
        // `--include-side-effecting` to capture. Reason: pay.sh could
        // drop the payment gate (free trial, policy change, bug) and
        // a "refresh fixtures" run would then fire a real SMS to the
        // placeholder phone without any operator intent. Opt-in keeps
        // the routine refresh-all workflow side-effect-free.
        sideEffecting: true,
    },
    {
        label: 'textbelt-status-free',
        description: 'v2 free GET, single-chain Solana',
        url: 'https://api.paysponge.com/x402/purchase/svc_d6kszbre4qwg5n4n4/status/probe-test-id',
        method: 'GET',
        expect: { status: 'any', version: 'unknown' },
    },
];

function parseArgs(argv) {
    const out = { service: null, includeSideEffecting: false };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--service' && argv[i + 1]) { out.service = argv[i + 1]; i++; }
        if (argv[i] === '--include-side-effecting') out.includeSideEffecting = true;
    }
    return out;
}

function summarize402(capture) {
    // x402 v2 endpoints surface payment requirements in EITHER:
    //   (a) the JSON body — `accepts` or `paymentRequirements` array
    //       (Tripadvisor, Textbelt — typical shape)
    //   (b) the `payment-required` response header, base64-encoded JSON
    //       (CoinGecko — header-form delivery)
    // We summarize whichever is present so the operator can see at a
    // glance which delivery mode each service uses. Per BAT-582 v1.6
    // contract amendment 2, both must be supported by the parser.
    const body = capture.body;
    let payload = null;
    let delivery = 'none';
    if (typeof body === 'object' && body !== null && (body.accepts || body.paymentRequirements)) {
        payload = body;
        delivery = 'body';
    } else if (capture.headers && capture.headers['payment-required']) {
        try {
            const decoded = Buffer.from(capture.headers['payment-required'], 'base64').toString('utf8');
            payload = JSON.parse(decoded);
            delivery = 'header';
        } catch (_) { delivery = 'header-malformed'; }
    }
    if (!payload) return { delivery, x402Version: null, reqsField: 'none' };

    const accepts = payload.accepts || payload.paymentRequirements || null;
    const networks = Array.isArray(accepts) ? accepts.map(a => a.network).filter(Boolean) : [];
    return {
        delivery,
        x402Version: payload.x402Version ?? null,
        amountField: accepts?.[0]
            ? (Object.prototype.hasOwnProperty.call(accepts[0], 'amount') ? 'amount'
              : Object.prototype.hasOwnProperty.call(accepts[0], 'maxAmountRequired') ? 'maxAmountRequired'
              : 'none')
            : null,
        networksOffered: networks,
        offerCount: Array.isArray(accepts) ? accepts.length : 0,
        reqsField: payload.accepts ? 'accepts' : (payload.paymentRequirements ? 'paymentRequirements' : 'neither'),
    };
}

async function main() {
    const args = parseArgs(process.argv);
    let list = args.service
        ? PROBE_LIST.filter(p => p.label.toLowerCase().includes(args.service.toLowerCase()))
        : PROBE_LIST;
    if (list.length === 0) {
        console.error(`No service matches "${args.service}"`);
        console.error(`Available: ${PROBE_LIST.map(p => p.label).join(', ')}`);
        process.exit(1);
    }

    // BAT-582 R34: side-effecting probes (POST endpoints whose action
    // mutates external state) are opt-in. Default skip; require explicit
    // `--include-side-effecting` flag to capture. Single-service runs
    // via `--service <name>` bypass the filter — if the operator
    // explicitly named a side-effecting probe, that IS intent.
    let skipped = [];
    if (!args.includeSideEffecting && !args.service) {
        const before = list.length;
        skipped = list.filter(p => p.sideEffecting);
        list = list.filter(p => !p.sideEffecting);
        if (before !== list.length) {
            console.log(`Note: skipping ${skipped.length} side-effecting probe(s) — pass --include-side-effecting to capture them:`);
            for (const s of skipped) console.log(`  • ${s.label}: ${s.description}`);
            console.log('');
        }
    }

    console.log('═══ pay.sh Layer 1 — probe-all ═══');
    console.log(`Probing ${list.length} service(s), 1 req/sec, no payment.`);
    console.log('');

    if (!fs.existsSync(CAPTURES_DIR)) fs.mkdirSync(CAPTURES_DIR, { recursive: true });

    const summary = [];
    let anyDriftDetected = false;
    for (const entry of list) {
        process.stdout.write(`[${entry.label}] ${entry.method} ${entry.url}\n`);
        const captured = await probe({
            url: entry.url,
            method: entry.method,
            body: entry.body,
        });

        if (captured.error) {
            console.log(`  ✗ ${captured.error}: ${captured.reason}`);
            summary.push({ label: entry.label, status: 'error', reason: captured.reason });
            anyDriftDetected = true;
        } else {
            const meta = captured.status === 402 ? summarize402(captured) : null;
            console.log(`  → HTTP ${captured.status} (${captured.bodyBytes} bytes, ${captured.durationMs}ms)`);
            if (meta) {
                console.log(`    delivery=${meta.delivery} | x402Version=${meta.x402Version} | reqs=${meta.reqsField} | amountField=${meta.amountField} | networks=${(meta.networksOffered || []).join(',') || '—'}`);
            }

            // BAT-582 R23: enforce entry.expect against capture. Pre-fix
            // the `expect` field on PROBE_LIST entries was declarative-
            // only (read by humans), so a service flipping from 402→200
            // (e.g. pay.sh making something free) would silently pass —
            // the regression net we're trying to build would be blind to
            // exactly the kind of drift it's supposed to catch.
            const expect = entry.expect || {};
            const driftLines = [];
            if (expect.status && expect.status !== 'any' && expect.status !== captured.status) {
                driftLines.push(`expected status=${expect.status}, got ${captured.status}`);
            }
            if (expect.version && expect.version !== 'unknown' && meta) {
                const expectedV = expect.version.replace(/^v/, '');
                const actualV = String(meta.x402Version ?? '?');
                if (expectedV !== actualV) {
                    driftLines.push(`expected x402Version=${expect.version}, got v${actualV}`);
                }
            }
            if (driftLines.length > 0) {
                console.log(`  ⚠ DRIFT: ${driftLines.join('; ')}`);
                anyDriftDetected = true;
            }

            const sanitized = sanitize({
                _meta: {
                    label: entry.label,
                    description: entry.description,
                    capturedAt: new Date().toISOString(),
                    note: 'Sanitized per BAT-582 v1.6 contract amendment 6.',
                },
                url: captured.url,
                method: captured.method,
                status: captured.status,
                headers: captured.headers,
                body: captured.body,
            });
            const outFile = path.join(CAPTURES_DIR, `${entry.label}.json`);
            fs.writeFileSync(outFile, JSON.stringify(sanitized, null, 2) + '\n', 'utf8');
            console.log(`  ✓ wrote ${path.relative(process.cwd(), outFile)}`);
            summary.push({ label: entry.label, status: captured.status, ...(meta || {}) });
        }

        // 1 req/sec rate limit
        await sleep(1000);
    }

    console.log('');
    console.log('═══ Summary ═══');
    for (const s of summary) {
        console.log(`  ${s.label.padEnd(30)} status=${s.status} ${s.x402Version != null ? `v=${s.x402Version} delivery=${s.delivery} reqs=${s.reqsField} amount=${s.amountField} chains=${(s.networksOffered || []).length}` : (s.delivery ? `delivery=${s.delivery}` : '')}`);
    }
    console.log('');
    console.log('Captures committed to tests/paysh/captures/. Review before push:');
    console.log(`  git diff tests/paysh/captures/`);

    if (anyDriftDetected) {
        console.log('');
        console.log('⚠ Protocol drift detected — see DRIFT lines above. Either:');
        console.log('  - Update PROBE_LIST entry.expect to match new reality, AND');
        console.log('  - Update tests/paysh/captures/{label}.json to reflect new shape, AND');
        console.log('  - Audit X402Protocol parser for any newly-required handling.');
        process.exit(2);
    }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(2); });
