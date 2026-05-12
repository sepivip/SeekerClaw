// tests/paysh/live-pay-production.js
//
// Layer 3-prod — exercise the PRODUCTION `handlers.agent_pay` path against
// real pay.sh services. Where live-pay-curated.js drives X402Protocol
// directly (test-side signing for protocol-shape coverage), this script
// drives the full agent_pay handler so the BAT-664 wires (preflight, body
// validation, idempotency-key, content-length, settle replay) are
// exercised end-to-end against real wire endpoints.
//
// The Android bridge isn't present on the dev box, so we stub
// `androidBridgeCall` at require-cache time:
//   - /burner/status → configured: true + pubkey from .env.test
//   - /burner/reserve → synthetic reservationId
//   - /burner/sign-transaction → Node-side Ed25519 via lib/sign-v2-tx.js
//     using the .env.test secret (for x402 v2 partial-sign tx) or the
//     legacy v1 path
//   - /burner/commit, /burner/release → no-ops
//
// This produces a SIGNED partially-signed tx using the same Ed25519
// algorithm BC uses on Android, so the facilitator can validate it the
// same way as a real device call.
//
// Run:
//   node tests/paysh/live-pay-production.js                              # exercise production wires up to signing (no spend)
//   node tests/paysh/live-pay-production.js --live                       # spend real USDC (safe services only)
//   node tests/paysh/live-pay-production.js --live --include-side-effecting --phone +<num>
//
// "Dry-run" semantics (default, no --live):
//   - Exercises preflight, burner-check, DNS pin, 402 probe (including
//     POST body propagation + Idempotency-Key), X402 detect+build,
//     cap preflight, and /burner/reserve.
//   - STOPS at /burner/sign-transaction (the stub returns
//     `dryrun_no_sign`; each service surfaces a friendly "dry-run OK —
//     would have signed" line in the summary, not a real failure).
//   - No on-chain transfer, no USDC spent.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

// ── Load test wallet credentials BEFORE requiring any production module ──
const { load, requireKeys, parseSecretKey } = require('./lib/load-env');
const { signV2TxSlot1 } = require('./lib/sign-v2-tx');
const { sanitize } = require('./lib/sanitize');
const { fetchLive, sleep } = require('./lib/http-live');

function parseArgs(argv) {
    const out = { live: false, service: null, includeSideEffecting: false, phone: null };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--live') out.live = true;
        else if (argv[i] === '--service' && argv[i + 1]) { out.service = argv[i + 1]; i++; }
        else if (argv[i] === '--include-side-effecting') out.includeSideEffecting = true;
        else if (argv[i] === '--phone' && argv[i + 1]) { out.phone = argv[i + 1]; i++; }
    }
    return out;
}

const args = parseArgs(process.argv);
const mode = args.live ? 'live' : 'dryrun';

const { env, file: envFile } = load();
requireKeys(env, mode);

// R-pr371-fix-5: friendly env validation mirroring live-pay-curated.js
// so operator typos in .env.test surface as clear messages rather than
// raw stack traces.
const burnerPub58 = env.BURNER_PUBKEY;
if (typeof burnerPub58 !== 'string' || burnerPub58.length === 0) {
    console.error(`✗ BURNER_PUBKEY missing or empty`);
    console.error(`  Set it to the base58 burner pubkey in tests/paysh/.env.test or tests/jupiter-ultra/.env.test.`);
    process.exit(1);
}

let secret32 = null, pubkey32 = null;
if (args.live) {
    try {
        const parsed = parseSecretKey(env.BURNER_SECRET_KEY);
        secret32 = parsed.secret;
        pubkey32 = parsed.pubkey;
    } catch (e) {
        console.error(`✗ BURNER_SECRET_KEY: ${e.message}`);
        process.exit(1);
    }
}

let maxUsdcAtomic;
if (args.live) {
    try { maxUsdcAtomic = BigInt(env.MAX_USDC_ATOMIC); }
    catch (_) {
        console.error(`✗ MAX_USDC_ATOMIC must be an integer decimal string (got: "${env.MAX_USDC_ATOMIC}")`);
        console.error(`  Example: MAX_USDC_ATOMIC=1000000  (= 1 USDC, since USDC has 6 decimals)`);
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
    console.error(`  Example: SOLANA_RPC=https://api.mainnet-beta.solana.com`);
    process.exit(1);
}

// R-pr371-fix-1: format max_usdc from BigInt EXACTLY via string math.
// Pre-fix used `Number(maxUsdcAtomic) / 1e6` which silently loses
// precision for atomic amounts > 2^53−1. Since this script runs real
// payments, the cap arg passed to agent_pay must match the env value
// exactly (no float coercion). USDC decimals = 6.
function _atomicToDecimal(atomic, decimals) {
    const s = atomic.toString();
    if (atomic === 0n) return '0';
    if (s.length <= decimals) {
        const padded = s.padStart(decimals, '0');
        const trimmed = padded.replace(/0+$/, '');
        return trimmed.length === 0 ? '0' : `0.${trimmed}`;
    }
    const intPart = s.slice(0, s.length - decimals);
    const fracPart = s.slice(s.length - decimals).replace(/0+$/, '');
    return fracPart.length === 0 ? intPart : `${intPart}.${fracPart}`;
}
const MAX_USDC_DECIMAL = _atomicToDecimal(maxUsdcAtomic, 6);

// ── Stub bridge.js BEFORE production modules require it ──────────────────────
// Track every call for audit at the end. The handler captures
// `androidBridgeCall` at require time (destructuring import), so the stub
// MUST be installed in require.cache before any production module loads.
const bridgeCalls = [];
const bridgePath = require.resolve(path.join(BUNDLE, 'bridge.js'));
require.cache[bridgePath] = {
    id: bridgePath, filename: bridgePath, loaded: true,
    exports: {
        androidBridgeCall: async (endpoint, body /* , timeoutMs */) => {
            bridgeCalls.push({ endpoint, body });
            if (endpoint === '/burner/status') {
                // R-pr371-fix-4: derive caps from env.MAX_USDC_ATOMIC so
                // the bridge stub adapts to whatever the operator has
                // configured (and a future service whose demand exceeds
                // a hard-coded 1 USDC won't false-reject at preflight).
                // Daily cap = 10× per-tx to allow several test runs.
                // SOL caps stay generous and constant — agent_pay's USDC
                // path doesn't touch them.
                const perTxUsdc = maxUsdcAtomic.toString();
                const dailyUsdc = (maxUsdcAtomic * 10n).toString();
                return {
                    configured: true,
                    pubkey: burnerPub58,
                    capPerTxSol: '1000000000',     // 1 SOL (generous; USDC path only)
                    capPerTxUsdc: perTxUsdc,
                    capDailySol: '10000000000',    // 10 SOL
                    capDailyUsdc: dailyUsdc,
                    spentTodaySol: '0',
                    spentTodayUsdc: '0',
                    network: 'mainnet',
                };
            }
            if (endpoint === '/burner/reserve') {
                return { reservationId: 'test-reservation-' + crypto.randomUUID() };
            }
            if (endpoint === '/burner/sign-transaction') {
                if (!args.live) {
                    return { error: 'dryrun_no_sign', reason: 'dry-run mode skips real signing' };
                }
                // body: { txBase64, reservationId, allowPartiallySigned? }
                // v2 path uses partial-sign (allowPartiallySigned=true); v1
                // path is legacy fully-signed — for the curated set all
                // entries are v2.
                if (body && body.allowPartiallySigned === true) {
                    try {
                        const signed = signV2TxSlot1(body.txBase64, secret32, pubkey32);
                        return { signedTxBase64: signed };
                    } catch (e) {
                        return { error: 'sign_failed', reason: e.message };
                    }
                }
                return { error: 'unsupported_sign_mode', reason: 'v1 fully-signed not implemented in dev stub' };
            }
            if (endpoint === '/burner/commit' || endpoint === '/burner/release') {
                return { ok: true };
            }
            return { error: 'unknown_endpoint', reason: endpoint };
        },
    },
};

// ── Stub solana.js too (matches the unit-test pattern) ──────────────────────
const solanaPath = require.resolve(path.join(BUNDLE, 'solana.js'));
require.cache[solanaPath] = {
    id: solanaPath, filename: solanaPath, loaded: true,
    exports: {
        getConnectedWalletAddress: () => { throw new Error('main wallet not used in agent_pay path'); },
        solanaRpc: async () => ({ error: 'mocked' }),
    },
};

// ── Stub config.js so security.js loads cleanly ──────────────────────────────
const configPath = require.resolve(path.join(BUNDLE, 'config.js'));
require.cache[configPath] = {
    id: configPath, filename: configPath, loaded: true,
    exports: { BRIDGE_TOKEN: 't', log: () => {}, config: {}, workDir: '/tmp' },
};

// ── Now require production modules — they'll see the stubs ──────────────────
const agentPay = require(path.join(BUNDLE, 'tools', 'agent_pay'));
const X402_PATH = require.resolve(path.join(BUNDLE, 'payment', 'x402'));
const { _setBlockhashFetcher } = require(X402_PATH);

// ── Wire X402's blockhash fetcher to live RPC ──
async function rpcCall(rpcUrl, method, params) {
    const parsed = new URL(rpcUrl);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const resp = await fetchLive(parsed, null, null, {}, 15000, { method: 'POST', body });
    if (resp.error) return { error: resp.error, reason: resp.reason };
    if (!resp.bodyJson) return { error: 'rpc_no_json' };
    if (resp.bodyJson.error) return { error: 'rpc_error', reason: JSON.stringify(resp.bodyJson.error) };
    return { ok: true, result: resp.bodyJson.result };
}
async function fetchLatestBlockhash() {
    const r = await rpcCall(rpcUrl, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
    if (r.error) throw new Error(`getLatestBlockhash failed: ${r.reason || r.error}`);
    return r.result.value.blockhash;
}
_setBlockhashFetcher(fetchLatestBlockhash);

// ── DNS override: bypass for non-localhost hostnames in test ──
// The handler's DNS pre-flight pins an IP; for testing we just resolve
// normally and let it pass through.
agentPay._setDnsLookup(async (hostname) => {
    const dns = require('dns');
    return new Promise((resolve, reject) => {
        dns.lookup(hostname, { family: 0 }, (err, address, family) => {
            if (err) return reject(err);
            resolve({ address, family });
        });
    });
});

// ── Curated services (same as live-pay-curated.js) ──
const SERVICES = [
    {
        label: 'tripadvisor', method: 'GET',
        url: 'https://tripadvisor.x402.paysponge.com/api/v1/location/search?searchQuery=Tbilisi&category=restaurants',
        sideEffecting: false,
    },
    {
        label: 'coingecko', method: 'GET',
        url: 'https://pro-api.coingecko.com/api/v3/x402/onchain/networks/solana/trending_pools',
        sideEffecting: false,
    },
    {
        label: 'textbelt-text', method: 'POST',
        url: 'https://api.paysponge.com/x402/purchase/svc_d6kszbre4qwg5n4n4/text',
        body: { phone: '+15555555555', message: 'SeekerClaw production-path probe' },
        sideEffecting: true,
    },
];

async function main() {
    console.log(`═══ pay.sh Layer 3-prod — production agent_pay path (mode=${mode.toUpperCase()}) ═══`);
    console.log(`Env: ${path.relative(process.cwd(), envFile)}`);
    console.log(`Burner: ${burnerPub58}`);
    console.log(`Cap:    ${maxUsdcAtomic.toString()} atomic ($${MAX_USDC_DECIMAL} USDC) per call`);
    console.log(`RPC:    ${rpcUrl}`);
    console.log('');

    // Filter + side-effecting opt-in (matches live-pay-curated.js logic)
    let services = args.service
        ? SERVICES.filter(s => s.label.toLowerCase().includes(args.service.toLowerCase()))
        : SERVICES.slice();
    if (services.length === 0) {
        console.error(`No service matches "${args.service}"`);
        process.exit(1);
    }
    if (!args.includeSideEffecting) {
        const skipped = services.filter(s => s.sideEffecting);
        services = services.filter(s => !s.sideEffecting);
        if (skipped.length > 0) {
            console.log(`Skipping ${skipped.length} side-effecting service(s) (pass --include-side-effecting):`);
            for (const s of skipped) console.log(`  • ${s.label}`);
            console.log('');
        }
        if (services.length === 0) {
            console.error('No services remain. Pass --include-side-effecting if intended.');
            process.exit(1);
        }
    }

    const summary = [];
    let totalSpent = 0n;

    for (const svc of services) {
        console.log(`── ${svc.label} ────────────────────`);
        // Apply --phone override to textbelt-text body (committed body
        // never contains a real phone).
        let runtimeBody = svc.body;
        if (svc.label === 'textbelt-text' && args.phone) {
            runtimeBody = { ...svc.body, phone: args.phone };
            console.log(`  (phone override: ${args.phone})`);
        }

        const t0 = Date.now();
        bridgeCalls.length = 0;  // reset per-service for audit
        const result = await agentPay.handlers.agent_pay({
            url: svc.url,
            max_usdc: MAX_USDC_DECIMAL,
            method: svc.method,
            body: runtimeBody,
        });
        const dt = Date.now() - t0;

        if (result.error) {
            // R-pr371-fix-2: distinguish dry-run sign rejection from real
            // failures. In dry-run mode the bridge stub returns
            // `dryrun_no_sign` from /burner/sign-transaction; agent_pay
            // bubbles it up VERBATIM (the stable error code IS
            // `dryrun_no_sign`, not wrapped as `sign_failed`). Render
            // as a friendly "dry-run OK — would have signed" line so
            // users don't see a misleading "✗" mark.
            const isDryRunSign = !args.live && result.error === 'dryrun_no_sign';
            if (isDryRunSign) {
                console.log(`  ⏸ dry-run OK — production wires reached signing (would have signed) (${dt}ms)`);
                summary.push({ label: svc.label, status: 'dryrun_ok' });
                continue;
            }
            console.log(`  ✗ ${result.error}: ${result.reason || ''} (${dt}ms)`);
            summary.push({ label: svc.label, status: 'error', error: result.error, reason: result.reason });
            continue;
        }

        // Successful response. Two sub-cases:
        //   (a) Paid: result.payment is set with amount_atomic_usdc + signature.
        //       agent_pay went through the full x402 flow.
        //   (b) Unpaid: URL returned non-402 (200/4xx) on the initial fetch
        //       — agent_pay short-circuits and returns the body unchanged.
        //       result.payment is null. For Layer 3-prod this is unexpected:
        //       the curated services SHOULD return 402, and a 200 means the
        //       service flipped to free OR is misconfigured. Treat as a
        //       diagnostic warning (not a clean success).
        const spent = result.payment && result.payment.amount_atomic_usdc;
        const bridgeEndpoints = bridgeCalls.map(c => c.endpoint).join(' → ');

        if (!result.payment) {
            // R-pr371-fix-6: non-paid 200/4xx — treat as unexpected for the
            // curated paid services. Print a warning, don't write a fixture,
            // don't add to spend total.
            console.log(`  ⚠ HTTP ${result.status} but NO PAYMENT made — service may have flipped to free or is misconfigured`);
            console.log(`    bridge sequence: ${bridgeEndpoints}`);
            summary.push({ label: svc.label, status: 'no_payment', httpStatus: result.status });
            await sleep(2000);
            continue;
        }

        // R-pr371-fix-3: format via _atomicToDecimal (BigInt-safe string
        // math) instead of Number(...)/1e6, which loses precision above
        // 2^53−1. Matches the formatting used for max_usdc / totalSpent.
        const spentDecimal = spent ? _atomicToDecimal(BigInt(spent), 6) : '?';
        console.log(`  ✓ HTTP ${result.status} — spent ${spent} atomic ($${spentDecimal})`);
        if (result.payment.signature) {
            console.log(`    on-chain sig: ${result.payment.signature}`);
        }
        // Verify the bridge handshake order matches production expectations.
        console.log(`    bridge sequence: ${bridgeEndpoints}`);
        if (spent) totalSpent += BigInt(spent);

        // Capture the success-path response as a fixture.
        if (args.live) {
            const fixtureFile = path.join(__dirname, 'captures', `${svc.label}-v2-prod-success.json`);
            const fixture = sanitize({
                _meta: {
                    label: `${svc.label}-v2-prod-success`,
                    description: 'PRODUCTION agent_pay path success — full BAT-664 wire including idempotency',
                    capturedAt: new Date().toISOString(),
                    onChainSignature: result.payment && result.payment.signature,
                    spentAtomic: spent,
                    note: 'Body redacted via paidSummary=true. Captured via stubbed bridge + Node-side signing.',
                },
                url: svc.url,
                method: svc.method,
                status: result.status,
                headers: result.headers || {},
                body: result.body,
            }, { paidSummary: true });
            fs.writeFileSync(fixtureFile, JSON.stringify(fixture, null, 2) + '\n', 'utf8');
            console.log(`    wrote ${path.relative(process.cwd(), fixtureFile)}`);
        }

        summary.push({ label: svc.label, status: 'success', spent, signature: result.payment && result.payment.signature });
        await sleep(2000);
    }

    console.log('');
    console.log('═══ Summary ═══');
    let succeeded = 0, failed = 0, dryRunOk = 0, noPayment = 0;
    for (const s of summary) {
        if (s.status === 'success') { succeeded++; console.log(`  ✓ ${s.label.padEnd(20)} spent=${s.spent}`); }
        else if (s.status === 'dryrun_ok') { dryRunOk++; console.log(`  ⏸ ${s.label.padEnd(20)} dry-run OK (production wires reached signing)`); }
        else if (s.status === 'no_payment') { noPayment++; console.log(`  ⚠ ${s.label.padEnd(20)} unexpected HTTP ${s.httpStatus} without payment (service flipped to free?)`); }
        else { failed++; console.log(`  ✗ ${s.label.padEnd(20)} ${s.error || 'failed'}`); }
    }
    console.log('');
    if (args.live) {
        console.log(`Total spent: ${totalSpent.toString()} atomic ($${_atomicToDecimal(totalSpent, 6)})`);
        console.log(`Production-path verification: ${succeeded} succeeded, ${noPayment} flipped-to-free, ${failed} failed`);
        // Exit 1 on failed; no_payment is a warning (drift detection),
        // not a code-correctness failure.
        if (failed > 0) process.exit(1);
    } else {
        console.log(`Dry-run complete: ${dryRunOk} services reached signing, ${noPayment} flipped-to-free, ${failed} hit pre-sign errors.`);
        console.log('Pass --live to spend real USDC and complete the full settle path.');
        if (failed > 0) process.exit(1);
    }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(2); });
