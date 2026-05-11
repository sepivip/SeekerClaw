// tests/jupiter-ultra/02-find-threshold.js
//
// Layer 2 — binary-search the SPONSORED-MODE CLIFF. Layer 1 revealed that
// Ultra has two regimes: sponsored mode (low fee, works at small amounts)
// and gasless mode (10% fee, requires output ≥ $5). Above the sponsored
// max but below the gasless minimum is a "dead zone" where Ultra returns
// no transaction.
//
// This binary-searches the upper boundary of sponsored mode (= the floor
// of the dead zone) so the production code can pre-flight-reject swaps in
// the dead zone with a clear "below Jupiter's $5 gasless minimum" message.
//
// Run: node tests/jupiter-ultra/02-find-threshold.js [--lo <lamports>] [--hi <lamports>]
//
// Defaults bracket [0.01 SOL, 0.015 SOL] — adjust if the price changes
// (the cliff is value-based, not amount-based).

'use strict';

const { load, requireKeys } = require('./lib/load-env');
const { ultraOrder } = require('./lib/jupiter');

const SOL_MINT  = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Bracket: lo SUCCEEDS (sponsored mode), hi FAILS (gasless dead zone).
// We're searching for the largest lo that still works.
const DEFAULT_LO_LAMPORTS = 10_000_000n;  // 0.01 SOL  — sponsored mode succeeds
const DEFAULT_HI_LAMPORTS = 15_000_000n;  // 0.015 SOL — gasless dead zone fails
const PRECISION_LAMPORTS = 100_000n;      // stop when bracket is tighter than ~0.0001 SOL
const MAX_ITERATIONS = 24;

function parseArgs(argv) {
    const out = { lo: null, hi: null };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--lo' && argv[i + 1]) { out.lo = BigInt(argv[i + 1]); i++; }
        if (argv[i] === '--hi' && argv[i + 1]) { out.hi = BigInt(argv[i + 1]); i++; }
    }
    return out;
}

async function tryAt(env, lamports) {
    try {
        const res = await ultraOrder({
            apiKey: env.JUPITER_API_KEY,
            inputMint: SOL_MINT,
            outputMint: USDC_MINT,
            amount: lamports.toString(),
            taker: env.BURNER_PUBKEY,
        });
        const ok = res.status === 200 && typeof res.data?.transaction === 'string' && res.data.transaction.length > 0;
        return {
            ok,
            status: res.status,
            errorCode: res.data?.errorCode,
            errorMessage: res.data?.errorMessage || res.data?.message,
            outAmount: res.data?.outAmount,
        };
    } catch (e) {
        return { ok: false, status: 'throw', errorMessage: e.message };
    }
}

function fmtSol(lamports) {
    const s = lamports.toString().padStart(10, '0');
    return s.slice(0, -9) + '.' + s.slice(-9);
}

async function main() {
    const env = requireKeys(load(), 'threshold');
    const args = parseArgs(process.argv);
    let lo = args.lo ?? DEFAULT_LO_LAMPORTS;
    let hi = args.hi ?? DEFAULT_HI_LAMPORTS;
    console.log('Binary-searching Ultra sponsored-mode cliff (SOL → USDC)');
    console.log(`  Initial bracket: [${fmtSol(lo)} SOL (expect OK), ${fmtSol(hi)} SOL (expect FAIL)]`);
    console.log('');

    // Verify endpoints — lo must SUCCEED (sponsored mode), hi must FAIL (dead zone).
    process.stdout.write(`Verify lo (${fmtSol(lo)}): `);
    const loRes = await tryAt(env, lo);
    console.log(loRes.ok ? 'succeeds ✓' : `unexpected — lo failed (${loRes.errorMessage || loRes.status}). Adjust --lo lower.`);
    if (!loRes.ok) process.exit(2);

    process.stdout.write(`Verify hi (${fmtSol(hi)}): `);
    const hiRes = await tryAt(env, hi);
    console.log(hiRes.ok ? `unexpected — hi succeeded (${hiRes.outAmount}). Adjust --hi higher.` : `fails ✓ (${hiRes.errorMessage || hiRes.status})`);
    if (hiRes.ok) process.exit(2);

    console.log('');
    console.log('Bracket binary search (looking for largest lamport amount where sponsored mode still works):');

    let iterations = 0;
    while ((hi - lo) > PRECISION_LAMPORTS && iterations < MAX_ITERATIONS) {
        iterations++;
        const mid = (lo + hi) / 2n;
        process.stdout.write(`  iter ${String(iterations).padStart(2)} | mid=${fmtSol(mid)} SOL: `);
        const res = await tryAt(env, mid);
        if (res.ok) {
            lo = mid;
            console.log(`OK   (out=${res.outAmount ?? '—'}) — narrow lower bound up`);
        } else {
            hi = mid;
            console.log(`FAIL (${res.errorMessage || res.status}) — narrow upper bound down`);
        }
    }

    console.log('');
    console.log('═══ SPONSORED-MODE CLIFF ═══');
    console.log(`Largest known PASS:   ${fmtSol(lo)} SOL  (≈ $${(Number(lo) / 1e9 * 94).toFixed(2)} at ~$94/SOL)`);
    console.log(`Smallest known FAIL:  ${fmtSol(hi)} SOL  (≈ $${(Number(hi) / 1e9 * 94).toFixed(2)})`);
    console.log(`Cliff is between ${fmtSol(lo)} and ${fmtSol(hi)} SOL.`);
    console.log('');
    console.log('Above the cliff and below ~$5 of output value: Ultra dead zone.');
    console.log('Production code should pre-flight-reject in this band with a clear message.');
}

main().catch((e) => { console.error('FATAL:', e); process.exit(2); });
