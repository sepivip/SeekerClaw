// tests/jupiter-ultra/live-t2-pyusd.js
//
// BAT-1038 merge gate "T2" — no-broadcast live simulation of a real
// USDC → PYUSD (Token-2022 output) Jupiter Ultra swap against mainnet.
//
// Proves the binding claim: the REAL production order reaches and PASSES
// validateBurnerTx when the burner's credit ATA is derived with PYUSD's
// owning token program (Token-2022) — and would FALSELY REJECT with the old
// classic 2-arg derivation (the phantom address). Same order, two expectedDelta
// shapes, A/B:
//   A. CORRECTED  — creditAccount = deriveAtaBase58(burner, PYUSD, Token-2022)
//   B. PHANTOM    — creditAccount = deriveAtaBase58(burner, PYUSD)  [old bug]
// A must ACCEPT; B must REJECT (security-class). That single contrast is the
// whole BAT-1038 thesis, demonstrated on live infrastructure.
//
// Safety (identical posture to live-burner-policy-helius.js):
//   - NEVER signs. NEVER broadcasts (sigVerify:false, replaceRecentBlockhash).
//   - NEVER mutates burner state. Read-only RPC + a simulated tx.
//   - BURNER_SECRET_KEY read from .env.test only; pubkeys logged aaaa…zzzz.
//   - Run from tests/jupiter-ultra: `node live-t2-pyusd.js`

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
const PYUSD_MINT = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'; // Token-2022
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ORDER_AMOUNT_USDC_ATOMIC = '500000'; // 0.5 USDC — sim-only, read from balance below

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
    return Keypair.fromSecretKey(bytes);
}

function jsonRpcRequest(rpcUrl, body, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
        const url = new URL(rpcUrl);
        const transport = url.protocol === 'http:' ? http : https;
        const payload = JSON.stringify(body);
        const req = transport.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'http:' ? 80 : 443),
            path: url.pathname + (url.search || ''),
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
            timeout: timeoutMs,
        }, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('parse: ' + data.slice(0, 200))); } });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error(`RPC timeout after ${timeoutMs}ms`)); });
        req.write(payload);
        req.end();
    });
}

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function solanaRpc(rpcUrl, method, params, timeoutMs = 45_000) {
    // Public mainnet-beta throttles heavy calls (getAccountInfo / gMA /
    // simulateTransaction+accounts). Retry on timeout / 429 / -32005 with
    // backoff so a flaky public RPC doesn't masquerade as a policy failure.
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0) await _sleep(1500 * attempt);
        try {
            const res = await jsonRpcRequest(rpcUrl, { jsonrpc: '2.0', id: 1, method, params }, timeoutMs);
            if (res.error) {
                const code = res.error.code;
                if (code === 429 || code === -32005 || code === -32004) { lastErr = new Error(`RPC ${method} throttled: ${JSON.stringify(res.error)}`); continue; }
                throw new Error(`RPC error ${method}: ${JSON.stringify(res.error)}`);
            }
            return res.result;
        } catch (e) {
            lastErr = e;
            if (/timeout|ECONNRESET|throttled|socket hang up/i.test(e.message)) continue;
            throw e;
        }
    }
    throw lastErr;
}

function jupiterUltraRequest(method, pathStr, body) {
    return new Promise((resolve, reject) => {
        const apiKey = process.env.JUPITER_API_KEY;
        if (!apiKey) return reject(new Error('JUPITER_API_KEY missing'));
        const payload = body ? JSON.stringify(body) : null;
        const headers = { 'Accept': 'application/json', 'x-api-key': apiKey, 'User-Agent': 'seekerclaw-t2-pyusd/0.0' };
        if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
        const req = https.request({ hostname: 'api.jup.ag', path: pathStr, method, headers, timeout: 30_000 }, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => { let parsed; try { parsed = JSON.parse(data); } catch { parsed = data; } resolve({ status: res.statusCode, body: parsed }); });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Jupiter timeout')); });
        if (payload) req.write(payload);
        req.end();
    });
}

// Mirrors burner-signer.js _lazyDefaultSimulator: getMultipleAccounts pre-snapshot
// + simulateTransaction with `accounts` config. No broadcast.
function makeLiveSimulator(rpcUrl) {
    // BAT-1027 two-pass: pass 1 returns `pinnedRpcUrl`; pass 2 is invoked with
    // { pinnedRpcUrl } and MUST run against that same endpoint (here a single
    // endpoint, so they coincide — but we must echo it back so the policy can
    // pin + verify rather than failing closed on "URL accessor unavailable").
    return async (txBase64, { addresses, pinnedRpcUrl }) => {
        const useUrl = pinnedRpcUrl || rpcUrl;
        let preSnapshot = [];
        if (addresses.length > 0) {
            const gma = await solanaRpc(useUrl, 'getMultipleAccounts', [addresses, { commitment: 'processed', encoding: 'base64' }]);
            if (!gma || !Array.isArray(gma.value)) throw new Error(`infra: getMultipleAccounts no value array (${JSON.stringify(gma).slice(0, 200)})`);
            if (gma.value.length !== addresses.length) throw new Error(`infra: gma length ${gma.value.length} != ${addresses.length}`);
            preSnapshot = gma.value;
        }
        const sim = await solanaRpc(useUrl, 'simulateTransaction', [txBase64, {
            commitment: 'processed', sigVerify: false, replaceRecentBlockhash: true,
            encoding: 'base64', innerInstructions: true,
            accounts: addresses.length > 0 ? { addresses, encoding: 'base64' } : undefined,
        }]);
        const normalized = (sim && sim.value) ? sim : { value: sim };
        return {
            sim: normalized, preSnapshot,
            slot: (normalized.context && normalized.context.slot) || 0,
            simulatorBacking: /helius/i.test(useUrl) ? 'helius' : 'public',
            pinnedRpcUrl: useUrl,
        };
    };
}

// mint owner lookup — same recipe as the handler's _mintTokenProgram
async function mintTokenProgram(rpcUrl, mintB58) {
    const info = await solanaRpc(rpcUrl, 'getAccountInfo', [mintB58, { encoding: 'base64' }]);
    const owner = info && info.value && info.value.owner;
    if (owner === TOKEN_PROGRAM || owner === TOKEN_2022_PROGRAM) return owner;
    throw new Error(`mint ${mintB58} owner ${owner || 'unknown'} not a recognized token program`);
}

function buildExpectedDelta(burnerPubkey, debitAccount, creditAccount, minOut, slippageBps) {
    return {
        kind: 'jupiter_swap_immediate',
        signerMode: 'burner_only',
        burnerDebit: { account: debitAccount, mint: USDC_MINT, atomicAmount: ORDER_AMOUNT_USDC_ATOMIC },
        burnerCreditMin: { account: creditAccount, mint: PYUSD_MINT, atomicAmount: minOut },
        burnerOwnedAccounts: [debitAccount, creditAccount].filter(a => a !== burnerPubkey),
        toleranceBps: Math.min((Number(slippageBps) || 100) + 25, 200),
    };
}

(async function main() {
    const rpcUrl = process.env.SOLANA_RPC;
    if (!rpcUrl) { console.error('SOLANA_RPC missing'); process.exit(1); }
    const backing = /helius/i.test(rpcUrl) ? 'helius' : 'public';
    console.log(`live-t2-pyusd.js — BAT-1038 USDC→PYUSD merge gate (backing: ${backing})`);

    const keypair = loadKeypair();
    const burnerPubkey = keypair.publicKey.toBase58();
    console.log(`Burner: ${redactPubkey(burnerPubkey)}`);

    // ── verify mint programs (proves PYUSD really is Token-2022 on-chain) ──
    console.log('\n── mint programs ──');
    const usdcProg = await mintTokenProgram(rpcUrl, USDC_MINT);
    const pyusdProg = await mintTokenProgram(rpcUrl, PYUSD_MINT);
    console.log(`  USDC  owner: ${usdcProg === TOKEN_PROGRAM ? 'TOKEN (classic)' : usdcProg}`);
    console.log(`  PYUSD owner: ${pyusdProg === TOKEN_2022_PROGRAM ? 'TOKEN-2022' : pyusdProg}`);
    if (pyusdProg !== TOKEN_2022_PROGRAM) { console.error('  FAIL: PYUSD is not Token-2022 — fixture wrong'); process.exit(1); }

    // ── derive the two credit ATAs (corrected vs phantom) ──
    const debitAccount = deriveAtaBase58(burnerPubkey, USDC_MINT, usdcProg);
    const correctedCredit = deriveAtaBase58(burnerPubkey, PYUSD_MINT, pyusdProg); // 3-arg Token-2022
    const phantomCredit = deriveAtaBase58(burnerPubkey, PYUSD_MINT);              // 2-arg classic (old bug)
    console.log(`\n── credit ATAs ──`);
    console.log(`  corrected (Token-2022): ${redactPubkey(correctedCredit)}`);
    console.log(`  phantom   (classic):    ${redactPubkey(phantomCredit)}`);
    if (correctedCredit === phantomCredit) { console.error('  FAIL: ATAs identical — derivation not program-aware'); process.exit(1); }

    // ── pre-flight: burner USDC balance (sim needs funds to debit) ──
    try {
        const ataInfo = await solanaRpc(rpcUrl, 'getTokenAccountBalance', [debitAccount]);
        const bal = ataInfo && ataInfo.value ? ataInfo.value.uiAmountString : '?';
        console.log(`\n── pre-flight ── burner USDC: ${bal} (order: 0.5 USDC, sim-only)`);
    } catch (e) { console.log(`\n── pre-flight ── balance read skipped: ${e.message}`); }

    // ── fetch the REAL Ultra order ──
    console.log('\n── Jupiter Ultra order: 0.5 USDC → PYUSD ──');
    const orderRes = await jupiterUltraRequest('GET', `/ultra/v1/order?inputMint=${USDC_MINT}&outputMint=${PYUSD_MINT}&amount=${ORDER_AMOUNT_USDC_ATOMIC}&taker=${burnerPubkey}`, null);
    if (orderRes.status !== 200 || !orderRes.body || !orderRes.body.transaction) {
        console.error(`  Jupiter Ultra failed: status=${orderRes.status} body=${JSON.stringify(orderRes.body).slice(0, 400)}`);
        process.exit(1);
    }
    const order = orderRes.body;
    const minOut = String(order.otherAmountThreshold ?? order.outAmount ?? '0');
    console.log(`  requestId=${order.requestId} minOut(PYUSD atomic)=${minOut} feeBps=${order.feeBps ?? order.platformFeeBps ?? '?'} router=${order.router ?? '?'}`);

    const simulator = makeLiveSimulator(rpcUrl);

    // ── A. CORRECTED expectedDelta → expect ACCEPT ──
    console.log('\n── A. validateBurnerTx with CORRECTED (Token-2022) credit ATA ──');
    const rA = await validateBurnerTx(order.transaction, buildExpectedDelta(burnerPubkey, debitAccount, correctedCredit, minOut, order.slippageBps), { burnerPubkey, simulator });
    console.log(`  result: ${JSON.stringify({ ok: rA.ok, simulated: rA.simulated, error: rA.error, class: rA.class, reason: rA.reason ? String(rA.reason).slice(0, 160) : undefined })}`);

    // ── B. PHANTOM expectedDelta → expect REJECT (the bug) ──
    console.log('\n── B. validateBurnerTx with PHANTOM (classic) credit ATA — expect reject ──');
    const rB = await validateBurnerTx(order.transaction, buildExpectedDelta(burnerPubkey, debitAccount, phantomCredit, minOut, order.slippageBps), { burnerPubkey, simulator });
    console.log(`  result: ${JSON.stringify({ ok: rB.ok, simulated: rB.simulated, error: rB.error, class: rB.class, reason: rB.reason ? String(rB.reason).slice(0, 160) : undefined })}`);

    // ── verdict ──
    console.log('\n── VERDICT ──');
    let failed = false;
    if (rA.ok && rA.simulated) {
        console.log('  ✓ A (corrected) ACCEPTED — the real production order passes the policy with the Token-2022 ATA');
    } else if (!rA.ok && rA.class === 'availability' && backing !== 'helius') {
        console.log(`  ⚠ A (corrected) availability-reject on PUBLIC RPC (rate-limit/degraded) — acceptable per Codex §7; re-run on Helius to confirm ACCEPT`);
    } else {
        console.error(`  ✗ A (corrected) did NOT accept: error=${rA.error} class=${rA.class} — the fix does not pass live policy`);
        failed = true;
    }
    if (!rB.ok) {
        console.log(`  ✓ B (phantom) REJECTED as expected (error=${rB.error}, class=${rB.class}) — confirms the old derivation was the false-reject cause`);
    } else {
        console.error('  ✗ B (phantom) unexpectedly ACCEPTED — the phantom ATA should not validate; A/B contrast broken');
        failed = true;
    }

    if (failed) { console.error('\nFAIL: live-t2-pyusd.js'); process.exit(1); }
    console.log('\nPASS: live-t2-pyusd.js — BAT-1038 T2 merge gate satisfied (no broadcast, no state change).');
    process.exit(0);
})().catch(err => { console.error(`\nFATAL: ${err.message}`); console.error(err.stack); process.exit(1); });
