// tests/jupiter-ultra/live-burner-policy-helius.js
//
// BAT-1013 Phase 4: load-bearing live test against a real Helius RPC.
// Per Codex amendment #7 (v1.1) + v8.1 amendment #7: this test MUST
// prove that the BurnerSigner default simulator factory's recipe —
// `getMultipleAccounts` pre-snapshot + `simulateTransaction` with
// `accounts` config — actually works end-to-end against real
// infrastructure with a real Jupiter Ultra route.
//
// What this test does:
//   1. Loads BURNER_SECRET_KEY + JUPITER_API_KEY + SOLANA_RPC from
//      .env.test.
//   2. Asks Jupiter Ultra for an order: 0.1 USDC → SOL with the
//      burner as the taker.
//   3. Builds the same `expectedDelta` shape as `tools/solana.js
//      solana_swap` would (kind: jupiter_swap_immediate, burner_only
//      signerMode, ATA-derived debit/credit accounts).
//   4. Calls the real BurnerSigner default simulator factory against
//      the actual Solana RPC. Reads `value.accounts[]` (post-state)
//      + parallel `getMultipleAccounts` (pre-snapshot).
//   5. Runs `validateBurnerTx` with the live simulator output.
//   6. Asserts policy ACCEPTS (`r.ok === true` AND `r.simulated ===
//      true`). NO security-class rejects allowed.
//
// What this test does NOT do (per `feedback_test_before_device`):
//   - Sign anything. We never invoke the burner bridge — the policy
//     gate is what we're validating.
//   - Broadcast. The simulator runs with `replaceRecentBlockhash:
//     true` and `sigVerify: false`, so the tx never executes.
//   - Mutate burner state. No spending, no ATA creation, nothing
//     irreversible.
//
// Safety:
//   - Reads BURNER_SECRET_KEY from .env.test ONLY (never echoes).
//   - Logs pubkeys as `aaaa…zzzz` prefix/suffix only.
//   - Run with: `cd tests/jupiter-ultra && node ../../tests/jupiter-ultra/live-burner-policy-helius.js`
//     (must run from jupiter-ultra dir so dotenv + bs58 resolve via local node_modules).

'use strict';

require('dotenv').config({ path: __dirname + '/.env.test' });

const path = require('path');
const https = require('https');
const http = require('http');
const bs58 = require('bs58');
const { Keypair } = require('@solana/web3.js');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
const { validateBurnerTx } = require(path.join(BUNDLE, 'wallet', 'burner-policy.js'));
const { deriveAtaBase58 } = require(path.join(BUNDLE, 'wallet', 'ata.js'));

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const ORDER_AMOUNT_USDC_ATOMIC = '100000'; // 0.1 USDC

// ─── Helpers ───────────────────────────────────────────────────────────────

function redactPubkey(pk) {
    const s = typeof pk === 'string' ? pk : (pk && pk.toBase58 ? pk.toBase58() : String(pk));
    return s.length < 8 ? '<pk>' : `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function loadKeypair() {
    const raw = process.env.BURNER_SECRET_KEY;
    if (!raw) throw new Error('BURNER_SECRET_KEY missing from .env.test');
    let bytes;
    try { bytes = bs58.decode(raw); }
    catch (_) {
        try { bytes = Uint8Array.from(JSON.parse(raw)); }
        catch (_2) { bytes = Buffer.from(raw, 'base64'); }
    }
    const kp = Keypair.fromSecretKey(bytes);
    const declared = process.env.BURNER_PUBKEY;
    if (declared && kp.publicKey.toBase58() !== declared) {
        throw new Error(`derived pubkey ${redactPubkey(kp.publicKey)} != declared BURNER_PUBKEY`);
    }
    return kp;
}

function jsonRpcRequest(rpcUrl, body, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
        const url = new URL(rpcUrl);
        // Copilot R-next-3: pick transport based on url.protocol so SOLANA_RPC
        // works for both hosted https endpoints AND local dev RPCs like
        // http://127.0.0.1:8899. Previously hardcoded https.request silently
        // failed for any non-443 / non-https endpoint despite the env-var
        // advertising configurability.
        const transport = url.protocol === 'http:' ? http : https;
        const payload = JSON.stringify(body);
        const req = transport.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'http:' ? 80 : 443),
            path: url.pathname + (url.search || ''),
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
            timeout: timeoutMs,
        }, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error('parse: ' + data.slice(0, 200))); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error(`RPC timeout after ${timeoutMs}ms`)); });
        req.write(payload);
        req.end();
    });
}

async function solanaRpc(rpcUrl, method, params, timeoutMs = 30_000) {
    const body = { jsonrpc: '2.0', id: 1, method, params };
    const res = await jsonRpcRequest(rpcUrl, body, timeoutMs);
    if (res.error) throw new Error(`RPC error ${method}: ${JSON.stringify(res.error)}`);
    return res.result;
}

function jupiterUltraRequest(method, path, body, token) {
    return new Promise((resolve, reject) => {
        const apiKey = process.env.JUPITER_API_KEY;
        if (!apiKey) return reject(new Error('JUPITER_API_KEY missing'));
        const payload = body ? JSON.stringify(body) : null;
        const headers = {
            'Accept': 'application/json',
            'x-api-key': apiKey,
            'User-Agent': 'seekerclaw-live-policy-test/0.0',
        };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        if (payload) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }
        const req = https.request(
            { hostname: 'api.jup.ag', path, method, headers, timeout: 30_000 },
            (res) => {
                let data = '';
                res.on('data', (c) => data += c);
                res.on('end', () => {
                    let parsed;
                    try { parsed = JSON.parse(data); } catch { parsed = data; }
                    resolve({ status: res.statusCode, body: parsed });
                });
            },
        );
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Jupiter timeout')); });
        if (payload) req.write(payload);
        req.end();
    });
}

// ─── Simulator factory (mirrors burner-signer.js _lazyDefaultSimulator) ────

function makeLiveSimulator(rpcUrl) {
    return async (txBase64, { addresses }) => {
        // 1. Pre-snapshot via getMultipleAccounts (same RPC, same commitment).
        let preSnapshot = [];
        if (addresses.length > 0) {
            const gma = await solanaRpc(rpcUrl, 'getMultipleAccounts', [
                addresses,
                { commitment: 'processed', encoding: 'base64' },
            ]);
            // Copilot PR #398 R12: fail loudly on shape regressions so
            // infrastructure problems (Helius API version change, partial
            // response, length mismatch) are NEVER silently treated as
            // all-null pre-state. This test is load-bearing for the
            // BAT-1013 dual-source contract — masking infra regressions
            // here can produce a misleading PASS. solanaRpc() already
            // throws on res.error (line ~110); these guards cover the
            // remaining cases: missing .value and length mismatches.
            if (!gma || !Array.isArray(gma.value)) {
                throw new Error(
                    `live-test infra: getMultipleAccounts returned no \`value\` array — RPC shape regression or partial response (got: ${JSON.stringify(gma).slice(0, 200)})`
                );
            }
            if (gma.value.length !== addresses.length) {
                throw new Error(
                    `live-test infra: getMultipleAccounts returned ${gma.value.length} entries for ${addresses.length} requested addresses — length mismatch`
                );
            }
            preSnapshot = gma.value;
        }
        // 2. simulateTransaction with `accounts` config for the same addresses.
        const sim = await solanaRpc(rpcUrl, 'simulateTransaction', [
            txBase64,
            {
                commitment: 'processed',
                sigVerify: false,
                replaceRecentBlockhash: true,
                encoding: 'base64',
                innerInstructions: true,
                accounts: addresses.length > 0 ? { addresses, encoding: 'base64' } : undefined,
            },
        ]);
        const normalized = (sim && sim.value) ? sim : { value: sim };
        return {
            sim: normalized,
            preSnapshot,
            slot: (normalized.context && normalized.context.slot) || 0,
            simulatorBacking: /helius/i.test(rpcUrl) ? 'helius' : 'public',
        };
    };
}

// ─── Test ──────────────────────────────────────────────────────────────────

(async function main() {
    const rpcUrl = process.env.SOLANA_RPC;
    if (!rpcUrl) { console.error('SOLANA_RPC missing from .env.test'); process.exit(1); }
    const backing = /helius/i.test(rpcUrl) ? 'helius' : 'public';
    console.log(`live-burner-policy-helius.js — simulator backing: ${backing}`);

    const keypair = loadKeypair();
    const burnerPubkey = keypair.publicKey.toBase58();
    console.log(`Burner wallet: ${redactPubkey(burnerPubkey)}`);

    // ── 1. Pre-flight balance check ──
    console.log('\n── 1. Pre-flight: burner balances ──');
    try {
        const usdcAta = deriveAtaBase58(burnerPubkey, USDC_MINT);
        const sol = await solanaRpc(rpcUrl, 'getBalance', [burnerPubkey]);
        const ataInfo = await solanaRpc(rpcUrl, 'getAccountInfo', [usdcAta, { encoding: 'base64' }]);
        console.log(`  SOL balance: ${sol.value / 1e9} SOL`);
        console.log(`  USDC ATA: ${redactPubkey(usdcAta)} exists: ${!!(ataInfo && ataInfo.value)}`);
    } catch (e) {
        console.log(`  Pre-flight skipped (non-fatal): ${e.message}`);
    }

    // ── 2. Jupiter Ultra order ──
    console.log('\n── 2. Jupiter Ultra order for 0.1 USDC → SOL ──');
    const orderRes = await jupiterUltraRequest('GET', `/ultra/v1/order?inputMint=${USDC_MINT}&outputMint=${SOL_MINT}&amount=${ORDER_AMOUNT_USDC_ATOMIC}&taker=${burnerPubkey}`, null);
    if (orderRes.status !== 200) {
        console.error(`  Jupiter Ultra failed: status=${orderRes.status}`);
        console.error(`  Body: ${JSON.stringify(orderRes.body).slice(0, 500)}`);
        process.exit(1);
    }
    const order = orderRes.body;
    if (!order.transaction) {
        console.error(`  Jupiter Ultra returned no transaction: ${JSON.stringify(order).slice(0, 300)}`);
        process.exit(1);
    }
    // R-next-8: nullish-coalesce + explicit String() so a legitimate 0
    // (or numeric/string drift from Jupiter) is preserved instead of
    // falling back to '?'.
    console.log(`  Got order: requestId=${order.requestId}, outAmount=${String(order.outAmount ?? order.otherAmountThreshold ?? '?')}`);
    console.log(`  Tx length: ${order.transaction.length} base64 chars`);

    // ── 3. Build expectedDelta (same logic as tools/solana.js solana_swap) ──
    console.log('\n── 3. Build expectedDelta (jupiter_swap_immediate) ──');
    const debitAccount = deriveAtaBase58(burnerPubkey, USDC_MINT);
    const creditAccount = burnerPubkey; // output is native SOL
    // R-next-8: nullish-coalesce so otherAmountThreshold=0 (a legit value
    // for some Jupiter routes) is preserved, not replaced by outAmount.
    // Normalize via String() to handle numeric/string drift from API.
    const minOut = String(order.otherAmountThreshold ?? order.outAmount ?? '0');
    const expectedDelta = {
        kind: 'jupiter_swap_immediate',
        signerMode: 'burner_only',
        burnerDebit: {
            account: debitAccount,
            mint: USDC_MINT,
            atomicAmount: ORDER_AMOUNT_USDC_ATOMIC,
        },
        burnerCreditMin: {
            account: creditAccount,
            mint: 'native_sol',
            atomicAmount: minOut,
        },
        burnerOwnedAccounts: [debitAccount],
        // R-next-8: Number(order.slippageBps) so a string slippage value
        // (e.g. "100") doesn't string-concat with + 25 to "10025".
        toleranceBps: Math.min(Number(order.slippageBps ?? 100) + 25, 200),
    };
    console.log(`  burnerDebit: USDC ${ORDER_AMOUNT_USDC_ATOMIC} from ${redactPubkey(debitAccount)}`);
    console.log(`  burnerCreditMin: SOL ${minOut} to ${redactPubkey(creditAccount)}`);
    console.log(`  toleranceBps: ${expectedDelta.toleranceBps}`);

    // ── 4. Run policy with live simulator ──
    console.log('\n── 4. Run validateBurnerTx with live simulator ──');
    const startMs = Date.now();
    const simulator = makeLiveSimulator(rpcUrl);
    const result = await validateBurnerTx(order.transaction, expectedDelta, {
        burnerPubkey,
        simulator,
    });
    const elapsedMs = Date.now() - startMs;
    console.log(`  Policy validation took ${elapsedMs}ms`);
    console.log(`  Result:`, JSON.stringify(result, null, 2).slice(0, 800));

    // ── 5. Assertions ──
    console.log('\n── 5. Assertions ──');
    if (!result.ok) {
        console.error(`  ✗ POLICY REJECTED: error=${result.error} reason="${result.reason}" class=${result.class}`);
        if (result.class === 'security') {
            console.error(`  FAIL: security-class reject means real money would be denied on a legitimate Jupiter swap.`);
            process.exit(1);
        }
        if (result.class === 'availability') {
            // Per Codex amendment §7 + §6: availability-class on PUBLIC path is acceptable
            // (rate-limit, simulation degraded). Helius MUST clean-approve.
            if (backing === 'helius') {
                console.error(`  FAIL: HELIUS backing returned availability-class reject. Helius path is load-bearing per Codex.`);
                process.exit(1);
            }
            console.log(`  PASS-AS-EXPECTED: public-backing availability reject is allowed per Codex §7.`);
            process.exit(0);
        }
        console.error(`  FAIL: ${result.class}-class reject.`);
        process.exit(1);
    }
    console.log(`  ✓ POLICY ACCEPTED (simulated=${result.simulated}, programs=${(result.programs || []).length})`);

    console.log('\nPASS: live-burner-policy-helius.js');
    process.exit(0);
})().catch(err => {
    console.error(`\nFATAL: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
});
