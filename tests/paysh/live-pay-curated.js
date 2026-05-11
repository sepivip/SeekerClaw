// tests/paysh/live-pay-curated.js
//
// Layer 3 — REAL live-pay test against the curated pay.sh services with
// the funded test burner wallet from .env.test. Spends real USDC.
//
// Per BAT-582 v1.6 contract: this is the highest-fidelity validator we
// have. It exercises the EXACT production code path that agent_pay uses
// on-device:
//
//   1. Probe the service live → real 402 with current payment requirements
//   2. X402Protocol.detect() + build({burnerPubkey, maxUsdcAtomic})
//   3. Local Ed25519 sign of slot 1 (mirrors Android KeyVault behavior;
//      see lib/sign-v2-tx.js for the bridge-equivalence note)
//   4. X402Protocol.settle() against the REAL endpoint → real money moves
//   5. Capture PAYMENT-RESPONSE shape as a fresh fixture
//
// SAFETY:
//   - Default mode is DRY-RUN: builds the tx but stops before signing
//     and settle. Pass `--live` to actually sign with the test wallet
//     and broadcast the payment.
//   - Side-effecting probes (textbelt-text sends SMS) require explicit
//     `--include-side-effecting` flag.
//   - MAX_USDC_ATOMIC env var caps per-call spending (build() rejects if
//     a service's demand exceeds it).
//   - Use `--service <label>` to limit to one service.
//
// Run:
//   node tests/paysh/live-pay-curated.js                  # dry run all
//   node tests/paysh/live-pay-curated.js --live           # spend real USDC (safe services)
//   node tests/paysh/live-pay-curated.js --live --service tripadvisor
//   node tests/paysh/live-pay-curated.js --live --include-side-effecting

'use strict';

const fs   = require('fs');
const path = require('path');

const { load, requireKeys, parseSecretKey } = require('./lib/load-env');
const { signV2TxSlot1 } = require('./lib/sign-v2-tx');
const { fetchLive, sleep } = require('./lib/http-live');
const { sanitize } = require('./lib/sanitize');

const X402_PATH = require.resolve('../../app/src/main/assets/nodejs-project/payment/x402.js');
const { X402Protocol, _setBlockhashFetcher, _decodeSolanaPubkey } = require(X402_PATH);

const CAPTURES_DIR = path.join(__dirname, 'captures');

// Curated probe list — mirrors probe-all.js but adds an `expectV2Success`
// flag for services we expect to successfully settle. Layer 3 doesn't
// probe textbelt-status-free (zero-demand free endpoint — agent_pay
// rejects pre-settle as invalid_demand).
const SERVICES = [
    {
        label: 'tripadvisor',
        description: 'v2 paid GET (~$0.01 per call)',
        url: 'https://tripadvisor.x402.paysponge.com/api/v1/location/search?searchQuery=Tbilisi&category=restaurants',
        method: 'GET',
        sideEffecting: false,
    },
    {
        label: 'coingecko',
        description: 'v2 paid GET (header-delivered 402)',
        url: 'https://pro-api.coingecko.com/api/v3/x402/onchain/networks/solana/trending_pools',
        method: 'GET',
        sideEffecting: false,
    },
    {
        label: 'textbelt-text',
        description: 'v2 paid POST (SMS send) — US/Canada-only at the textbelt service tier',
        url: 'https://api.paysponge.com/x402/purchase/svc_d6kszbre4qwg5n4n4/text',
        method: 'POST',
        // Default placeholder; pass --phone <number> at run time for a
        // real-delivery test. Committed body never carries a real phone
        // number (per BAT-582 contract amendment 6 — see sanitize.js).
        body: { phone: '+15555555555', message: 'SeekerClaw test probe' },
        sideEffecting: true,
        // Layer 3 finding (2026-05-11): full payment flow works
        // end-to-end against this endpoint; HTTP 200 returned with
        // textbelt's response body. Whether the SMS actually delivers
        // depends on the recipient region — paysponge's textbelt
        // wrapper supports US/Canada numbers only. Non-US/Canada
        // numbers get 200 + `{success:false, error:"You are trying
        // to use US/Canada SMS credits outside of US/Canada."}`.
        //
        // Production agent_pay is currently GET-only (BAT-582 v1.4
        // scope). BAT-664 lifts that gate; this entry becomes the
        // live regression net for the POST path once BAT-664 lands.
    },
];

function parseArgs(argv) {
    const out = { live: false, service: null, includeSideEffecting: false, phone: null };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--live') out.live = true;
        else if (argv[i] === '--service' && argv[i + 1]) { out.service = argv[i + 1]; i++; }
        else if (argv[i] === '--include-side-effecting') out.includeSideEffecting = true;
        // Override the placeholder textbelt-text phone (+15555555555) for
        // real-delivery testing. Number is NEVER read from the committed
        // SERVICES list — operator passes it at run time so the repo
        // history stays free of personal info.
        else if (argv[i] === '--phone' && argv[i + 1]) { out.phone = argv[i + 1]; i++; }
    }
    return out;
}

// ── Solana RPC: blockhash + balance ─────────────────────────────────────────
async function rpcCall(rpcUrl, method, params) {
    const parsed = new URL(rpcUrl);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const resp = await fetchLive(parsed, null, null, {}, 15000, { method: 'POST', body });
    if (resp.error) return { error: resp.error, reason: resp.reason };
    if (!resp.bodyJson) return { error: 'rpc_no_json', reason: resp.body && resp.body.slice(0, 200) };
    if (resp.bodyJson.error) return { error: 'rpc_error', reason: JSON.stringify(resp.bodyJson.error) };
    return { ok: true, result: resp.bodyJson.result };
}

async function fetchLatestBlockhash(rpcUrl) {
    const r = await rpcCall(rpcUrl, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
    if (r.error) throw new Error(`getLatestBlockhash failed: ${r.reason || r.error}`);
    return r.result.value.blockhash;
}

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

async function fetchUsdcBalance(rpcUrl, ownerPubkey58) {
    const r = await rpcCall(rpcUrl, 'getTokenAccountsByOwner', [
        ownerPubkey58,
        { mint: USDC_MINT },
        { encoding: 'jsonParsed' },
    ]);
    if (r.error) throw new Error(`getTokenAccountsByOwner failed: ${r.reason || r.error}`);
    const accounts = (r.result && r.result.value) || [];
    let total = 0n;
    for (const a of accounts) {
        const ui = a.account && a.account.data && a.account.data.parsed && a.account.data.parsed.info;
        if (ui && ui.tokenAmount && typeof ui.tokenAmount.amount === 'string') {
            total += BigInt(ui.tokenAmount.amount);
        }
    }
    return total;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const args = parseArgs(process.argv);

    const { env, file: envFile } = load();
    const mode = args.live ? 'live' : 'dryrun';
    requireKeys(env, mode);

    console.log(`═══ pay.sh Layer 3 — live-pay-curated (mode=${mode.toUpperCase()}) ═══`);
    console.log(`Env: ${path.relative(process.cwd(), envFile)}`);
    console.log('');

    // ── Parse credentials ──
    const burnerPub58 = env.BURNER_PUBKEY;
    if (!_decodeSolanaPubkey(burnerPub58)) {
        throw new Error(`BURNER_PUBKEY ${burnerPub58} doesn't decode to 32 bytes`);
    }
    let secret32 = null, pubkey32 = null;
    if (args.live) {
        const parsed = parseSecretKey(env.BURNER_SECRET_KEY);
        secret32 = parsed.secret;
        pubkey32 = parsed.pubkey;
        if (_decodeSolanaPubkey(burnerPub58).compare(pubkey32) !== 0) {
            throw new Error('BURNER_PUBKEY does not match the derived pubkey from BURNER_SECRET_KEY');
        }
    }

    // R-pr369-fix-5: friendly errors for malformed env vars instead of
    // raw TypeError stack traces. Operator mistakes (typos, trailing
    // whitespace, hex-instead-of-decimal) get diagnosed cleanly.
    let maxUsdcAtomic;
    if (args.live) {
        try { maxUsdcAtomic = BigInt(env.MAX_USDC_ATOMIC); }
        catch (_) {
            console.error('');
            console.error(`✗ MAX_USDC_ATOMIC must be an integer decimal string (got: "${env.MAX_USDC_ATOMIC}")`);
            console.error('  Example: MAX_USDC_ATOMIC=1000000 (= 1 USDC, since USDC has 6 decimals)');
            process.exit(1);
        }
        if (maxUsdcAtomic <= 0n) {
            console.error(`✗ MAX_USDC_ATOMIC must be positive, got ${maxUsdcAtomic.toString()}`);
            process.exit(1);
        }
    } else {
        maxUsdcAtomic = 100_000_000n;
    }
    const rpcUrl = env.SOLANA_RPC;
    try { new URL(rpcUrl); }
    catch (_) {
        console.error(`✗ SOLANA_RPC must be a valid URL (got: "${rpcUrl}")`);
        console.error('  Example: SOLANA_RPC=https://api.mainnet-beta.solana.com');
        process.exit(1);
    }
    console.log(`Burner: ${burnerPub58}`);
    console.log(`Cap:    ${maxUsdcAtomic.toString()} atomic ($${Number(maxUsdcAtomic) / 1e6} USDC) per call`);
    console.log(`RPC:    ${rpcUrl}`);
    console.log('');

    // ── Wire X402Protocol's blockhash fetcher to the live RPC ──
    _setBlockhashFetcher(async () => fetchLatestBlockhash(rpcUrl));

    // ── Pre-flight: USDC balance (live mode only) ──
    //
    // MAX_USDC_ATOMIC is a per-call UPPER BOUND that build() uses to
    // reject services whose demand exceeds it (demand_exceeds_max_usdc).
    // It's NOT a minimum-balance requirement. Per-service actual demand
    // is ~$0.01 across the curated set; the on-chain transfer will fail
    // with its own clear error if balance is insufficient at any point.
    // Surface the balance for visibility but don't gate on it.
    if (args.live) {
        try {
            const bal = await fetchUsdcBalance(rpcUrl, burnerPub58);
            const usd = Number(bal) / 1e6;
            console.log(`Burner USDC balance: ${bal.toString()} atomic ($${usd.toFixed(6)})`);
            // ~$0.03 covers tripadvisor + coingecko + textbelt at $0.01 each.
            // Below that, surface a warning but proceed — each service has
            // its own per-call demand check via the cap.
            if (bal < 30_000n) {
                console.log(`⚠ Balance < $0.03 — may not cover all 3 services. Continuing; per-call settle will surface insufficient-funds clearly.`);
            }
        } catch (e) {
            console.error(`⚠ Balance check failed: ${e.message}`);
            console.error('  Continuing — settle will surface the real error if balance is insufficient.');
        }
        console.log('');
    }

    // ── Filter service list ──
    let services = args.service
        ? SERVICES.filter(s => s.label.toLowerCase().includes(args.service.toLowerCase()))
        : SERVICES.slice();
    if (services.length === 0) {
        console.error(`No service matches "${args.service}"`);
        console.error(`Available: ${SERVICES.map(s => s.label).join(', ')}`);
        process.exit(1);
    }
    // Side-effecting opt-in: enforce ALWAYS, not just when --service is
    // unset (R-pr369-fix-3). Pre-fix `--service textbelt-text --live`
    // would bypass the gate and send a real SMS without the explicit
    // --include-side-effecting opt-in.
    if (!args.includeSideEffecting) {
        const skipped = services.filter(s => s.sideEffecting);
        services = services.filter(s => !s.sideEffecting);
        if (skipped.length > 0) {
            console.log(`Note: skipping ${skipped.length} side-effecting service(s) (pass --include-side-effecting to capture):`);
            for (const s of skipped) console.log(`  • ${s.label}: ${s.description}`);
            console.log('');
        }
        if (services.length === 0) {
            console.error(`✗ No services remain after side-effecting filter. Pass --include-side-effecting if you intentionally want to exercise side-effecting services.`);
            process.exit(1);
        }
    }

    // ── Run each service ──
    const proto = new X402Protocol();
    const summary = [];
    let totalSpentAtomic = 0n;

    for (const svc of services) {
        const t0 = Date.now();
        // Apply --phone override for textbelt-text if provided. svc.body
        // is the committed placeholder; we never mutate the SERVICES entry
        // directly so other runs stay deterministic.
        let runtimeBody = svc.body;
        if (svc.label === 'textbelt-text' && args.phone) {
            runtimeBody = { ...svc.body, phone: args.phone };
            console.log(`── ${svc.label} ──────────────────── (phone override: ${args.phone})`);
        } else {
            console.log(`── ${svc.label} ────────────────────`);
        }
        console.log(`  ${svc.method} ${svc.url}`);

        // 1. Live probe → fresh 402
        const probeBody = runtimeBody ? JSON.stringify(runtimeBody) : null;
        const probeUrl = new URL(svc.url);
        const probeResp = await fetchLive(
            probeUrl, null, null, {}, 30000,
            { method: svc.method, body: probeBody }
        );
        if (probeResp.error) {
            console.log(`  ✗ probe failed: ${probeResp.error}: ${probeResp.reason}`);
            summary.push({ label: svc.label, status: 'probe_error', reason: probeResp.reason });
            continue;
        }
        if (probeResp.status !== 402) {
            console.log(`  ✗ probe returned HTTP ${probeResp.status} (expected 402 for paid service)`);
            summary.push({ label: svc.label, status: `http_${probeResp.status}`, reason: 'service may have flipped to free' });
            continue;
        }
        console.log(`  → HTTP 402 (${probeResp.bodyBytes} bytes, ${Date.now() - t0}ms)`);

        // 2. detect + build
        const response = { status: probeResp.status, bodyJson: probeResp.bodyJson, headers: probeResp.headers };
        if (!proto.detect(response)) {
            console.log(`  ✗ detect=false (not an x402 challenge — should not happen for v2 pay.sh)`);
            summary.push({ label: svc.label, status: 'no_detect' });
            continue;
        }
        let built;
        try {
            built = await proto.build(response, { burnerPubkey: burnerPub58, maxUsdcAtomic });
        } catch (e) {
            console.log(`  ✗ build threw: ${e.message}`);
            summary.push({ label: svc.label, status: 'build_threw', reason: e.message });
            continue;
        }
        if (built.error) {
            console.log(`  ✗ build error: ${built.error} — ${built.reason}`);
            summary.push({ label: svc.label, status: 'build_error', error: built.error });
            continue;
        }
        const amt = built.paymentMeta.amountAtomic;
        const txBytes = Buffer.from(built.txBase64, 'base64').length;
        console.log(`  ✓ build → x402Version=${built.paymentMeta.x402Version}, demand=${amt} atomic ($${Number(amt)/1e6}), tx=${txBytes} bytes`);
        console.log(`    network=${built.paymentMeta.negotiatedNetwork}, payTo=${built.paymentMeta.recipient}`);
        console.log(`    facilitator (slot 0)=${built.paymentMeta.facilitator}`);

        // 3. Sign slot 1 (skip in dry run)
        if (!args.live) {
            console.log(`  ⏸ dry-run mode — skipping sign + settle (pass --live to actually broadcast)`);
            summary.push({ label: svc.label, status: 'dryrun', demandAtomic: amt });
            await sleep(1000);
            continue;
        }
        let signedTxBase64;
        try {
            signedTxBase64 = signV2TxSlot1(built.txBase64, secret32, pubkey32);
        } catch (e) {
            console.log(`  ✗ sign threw: ${e.message}`);
            summary.push({ label: svc.label, status: 'sign_threw', reason: e.message });
            continue;
        }
        console.log(`  ✓ signed slot 1 (burner)`);

        // 4. Real settle against the live endpoint. CRITICAL: replay
        //    against the ORIGINAL URL (svc.url) including its query string
        //    — NOT the bare `resource.url` from the challenge. paysh
        //    forwards the request body+query to the upstream service
        //    after payment, so any params we sent during probe must be
        //    sent again during settle. Pre-fix we settled against
        //    `resource.url` (no query string) and tripadvisor returned
        //    HTTP 400 "Required parameter searchQuery was null" — the
        //    payment validated, but the upstream API didn't get its
        //    inputs.
        const settleTarget = svc.url;
        const settleParsed = new URL(settleTarget);
        let capturedRespHeaders = null;
        let capturedRespBody = null;
        let capturedRespStatus = null;
        let sentProofHeaders = null;
        const fetchFn = async (parsed, ip, fam, headers, timeout) => {
            // Replay the EXACT same request shape the probe used: same
            // method, same body (when applicable). Per pay.sh protocol
            // docs: "Preserve method, headers, body, and gateway URL."
            // Pre-fix this branched on `runtimeBody` and hard-coded
            // method='POST' when body was present — that would break
            // any future curated entry that has body+non-POST (or
            // POST+no-body).
            sentProofHeaders = headers;
            const method = (svc.method || 'GET').toUpperCase();
            const opts = { method };
            if (runtimeBody !== undefined && runtimeBody !== null) {
                opts.body = JSON.stringify(runtimeBody);
            }
            const r = await fetchLive(parsed, null, null, headers, timeout, opts);
            if (!r.error) {
                capturedRespHeaders = r.headers;
                capturedRespBody = r.bodyJson;
                capturedRespStatus = r.status;
            }
            return r;
        };
        const settleResult = await proto.settle(
            { parsed: settleParsed, pinnedIp: null, pinnedFamily: null, timeoutLeftMs: 60000 },
            signedTxBase64,
            built.paymentMeta,
            { _fetchWithLimits: fetchFn }
        );

        if (settleResult.error) {
            console.log(`  ✗ settle error: ${settleResult.error} — ${settleResult.reason || ''}`);
            // Diagnostic capture: write the request we sent + the response
            // we got so failures can be diffed against successful runs.
            // Goes under captures/_debug/ which is gitignored — never commit
            // these (may contain server-side error detail referencing keys).
            const debugDir = path.join(CAPTURES_DIR, '_debug');
            if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            const debugFile = path.join(debugDir, `${svc.label}-fail-${ts}.json`);
            const sentSig = sentProofHeaders && sentProofHeaders['payment-signature'];
            const decodedSentSig = sentSig
                ? (() => { try { return JSON.parse(Buffer.from(sentSig, 'base64').toString('utf8')); } catch (_) { return null; } })()
                : null;
            fs.writeFileSync(debugFile, JSON.stringify({
                _meta: { label: svc.label, capturedAt: new Date().toISOString(), reason: 'settle failed — debug capture' },
                error: settleResult.error,
                errorReason: settleResult.reason,
                request: {
                    url: settleTarget,
                    method: svc.method,
                    runtimeBody,
                    sentHeaders: sentProofHeaders,
                    sentPaymentSignatureDecoded: decodedSentSig,
                },
                response: {
                    status: capturedRespStatus,
                    headers: capturedRespHeaders,
                    body: capturedRespBody,
                },
            }, null, 2) + '\n', 'utf8');
            console.log(`    → debug capture: ${path.relative(process.cwd(), debugFile)}`);
            summary.push({ label: svc.label, status: 'settle_error', error: settleResult.error, reason: settleResult.reason });
            continue;
        }
        console.log(`  ✓ settle SUCCESS — on-chain signature: ${settleResult.signature}`);
        totalSpentAtomic += amt;

        // 5. Capture the success response shape for future regression pinning.
        // R-pr369-fix-4: pass `paidSummary: true` so the response body is
        // replaced with a one-line summary string — we PAID for that content
        // and committing it would leak paid API data. The fixture captures
        // the PAYMENT-RESPONSE header shape + status (what we need for
        // regression pinning), not the paid body content.
        //
        // The `_meta` block is hand-built here from explicitly-safe fields
        // only (label + description + ISO timestamp + on-chain sig + atomic
        // demand + a fixed note string). No user input flows into _meta,
        // so passing it through sanitize unchanged is safe. The on-chain
        // signature IS public (it's broadcast to the Solana network) so
        // committing it is fine.
        const fixtureFile = path.join(CAPTURES_DIR, `${svc.label}-v2-success.json`);
        const fixture = sanitize({
            _meta: {
                label: `${svc.label}-v2-success`,
                description: `v2 PAYMENT-RESPONSE captured during Layer 3 live-pay (${svc.label})`,
                capturedAt: new Date().toISOString(),
                onChainSignature: settleResult.signature,
                demandAtomic: amt.toString(),
                note: 'Spent real USDC. Body redacted via paidSummary=true (we paid for that content). Captured for regression pinning of v2 settle path.',
            },
            url: settleTarget,
            method: svc.method,
            status: capturedRespStatus,
            headers: capturedRespHeaders,
            body: capturedRespBody,
        }, { paidSummary: true });
        fs.writeFileSync(fixtureFile, JSON.stringify(fixture, null, 2) + '\n', 'utf8');
        console.log(`  ✓ wrote ${path.relative(process.cwd(), fixtureFile)}`);

        summary.push({
            label: svc.label,
            status: 'success',
            demandAtomic: amt,
            signature: settleResult.signature,
        });

        // Rate-limit between services
        await sleep(2000);
    }

    // ── Summary ──
    console.log('');
    console.log('═══ Summary ═══');
    let liveSucceeded = 0, liveFailed = 0;
    for (const s of summary) {
        const tag = s.status === 'success' ? '✓' : s.status === 'dryrun' ? '⏸' : '✗';
        let extra = '';
        if (s.status === 'success') {
            liveSucceeded++;
            extra = `spent=${s.demandAtomic} atomic`;
        } else if (s.status === 'dryrun') {
            extra = `would-spend=${s.demandAtomic} atomic`;
        } else {
            liveFailed++;
            extra = `${s.error || s.reason || ''}`.slice(0, 80);
        }
        console.log(`  ${tag} ${s.label.padEnd(20)} ${s.status.padEnd(15)} ${extra}`);
    }
    console.log('');
    if (args.live) {
        console.log(`Total USDC spent: ${totalSpentAtomic.toString()} atomic ($${Number(totalSpentAtomic)/1e6})`);
        console.log(`Live results: ${liveSucceeded} succeeded, ${liveFailed} failed`);
        if (liveFailed > 0) process.exit(1);
    } else {
        console.log('Dry-run complete. Pass --live to actually broadcast and spend real USDC.');
    }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(2); });
