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
//   node tests/paysh/live-pay-production.js                              # dry-run all
//   node tests/paysh/live-pay-production.js --live                       # spend real USDC (safe)
//   node tests/paysh/live-pay-production.js --live --include-side-effecting --phone +<num>

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

const burnerPub58 = env.BURNER_PUBKEY;
let secret32 = null, pubkey32 = null;
if (args.live) {
    const parsed = parseSecretKey(env.BURNER_SECRET_KEY);
    secret32 = parsed.secret;
    pubkey32 = parsed.pubkey;
}
const maxUsdcAtomic = args.live ? BigInt(env.MAX_USDC_ATOMIC) : 100_000_000n;
const rpcUrl = env.SOLANA_RPC;

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
                // Caps must be high enough to allow the test (≤ $1/call,
                // ≤ $5/day) — these are the same conservative ceilings
                // the unit tests use. Bridge stub returns generous values
                // so the production cap preflight doesn't false-reject;
                // the real on-chain check would still fail if the wallet
                // is empty.
                return {
                    configured: true,
                    pubkey: burnerPub58,
                    capPerTxSol: '1000000000',     // 1 SOL
                    capPerTxUsdc: '1000000',       // 1 USDC
                    capDailySol: '5000000000',     // 5 SOL
                    capDailyUsdc: '5000000',       // 5 USDC
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
    console.log(`Cap:    ${maxUsdcAtomic.toString()} atomic ($${Number(maxUsdcAtomic) / 1e6} USDC) per call`);
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
            max_usdc: (Number(maxUsdcAtomic) / 1e6).toString(),
            method: svc.method,
            body: runtimeBody,
        });
        const dt = Date.now() - t0;

        if (result.error) {
            console.log(`  ✗ ${result.error}: ${result.reason || ''} (${dt}ms)`);
            summary.push({ label: svc.label, status: 'error', error: result.error, reason: result.reason });
            continue;
        }

        // Successful response.
        const spent = result.payment && result.payment.amount_atomic_usdc;
        console.log(`  ✓ HTTP ${result.status} — spent ${spent} atomic ($${spent ? Number(spent) / 1e6 : '?'})`);
        if (result.payment && result.payment.signature) {
            console.log(`    on-chain sig: ${result.payment.signature}`);
        }
        // Verify the bridge handshake order matches production expectations.
        const bridgeEndpoints = bridgeCalls.map(c => c.endpoint).join(' → ');
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
    let succeeded = 0, failed = 0;
    for (const s of summary) {
        if (s.status === 'success') { succeeded++; console.log(`  ✓ ${s.label.padEnd(20)} spent=${s.spent}`); }
        else { failed++; console.log(`  ✗ ${s.label.padEnd(20)} ${s.error || 'failed'}`); }
    }
    console.log('');
    if (args.live) {
        console.log(`Total spent: ${totalSpent.toString()} atomic ($${Number(totalSpent) / 1e6})`);
        console.log(`Production-path verification: ${succeeded} succeeded, ${failed} failed`);
        if (failed > 0) process.exit(1);
    } else {
        console.log('Dry-run complete. Pass --live to spend real USDC.');
    }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(2); });
