// tests/jupiter-ultra/01-probe-order.js
//
// Layer 1 — probe Jupiter Ultra /order at multiple SOL amounts. No signing,
// no funds at risk. Dumps the FULL response body so we can see why Ultra
// refuses to build a tx for tiny amounts (the production code throws away
// the errorCode/errorMessage on `!o.transaction`).
//
// Run: node tests/jupiter-ultra/01-probe-order.js [--taker <pubkey>]
//
// Use --taker to override the BURNER_PUBKEY from .env.test for one run —
// useful for probing the production on-device burner pubkey without
// rotating the test wallet.
//
// Expected output: a table with [amount, status, has_transaction, route,
// in_amount, out_amount, error] for each probe amount. The threshold for
// "has_transaction = true" is the answer to the 0.005 SOL mystery.

'use strict';

const { load, requireKeys } = require('./lib/load-env');
const { ultraOrder } = require('./lib/jupiter');

const SOL_MINT  = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Amounts in SOL (decimal) — we probe across a wide range to find the cliff.
const AMOUNTS_SOL = [0.001, 0.003, 0.005, 0.0075, 0.01, 0.015, 0.02, 0.05, 0.1];

function solToLamports(sol) {
    // 9 decimals — use BigInt-safe parsing so 0.0075 doesn't drift.
    const [whole, frac = ''] = String(sol).split('.');
    const padded = (frac + '000000000').slice(0, 9);
    return BigInt(whole) * 1_000_000_000n + BigInt(padded || '0');
}

function summarize(data) {
    if (typeof data !== 'object' || data === null) return { kind: 'raw', value: String(data).slice(0, 200) };
    const keys = Object.keys(data);
    const summary = {
        keys,
        hasTransaction: typeof data.transaction === 'string' && data.transaction.length > 0,
        hasRequestId:   typeof data.requestId   === 'string' && data.requestId.length > 0,
        inAmount:       data.inAmount   ?? null,
        outAmount:      data.outAmount  ?? null,
        otherAmount:    data.otherAmountThreshold ?? null,
        priceImpactPct: data.priceImpactPct ?? null,
        slippageBps:    data.slippageBps ?? null,
        errorCode:      data.errorCode  ?? null,
        errorMessage:   data.errorMessage ?? null,
        error:          data.error ?? null,
        message:        data.message ?? null,
        routePlan:      Array.isArray(data.routePlan)
            ? data.routePlan.map(s => s.swapInfo?.label || s.swapInfo?.ammKey || '?').join(' → ')
            : null,
        swapType:       data.swapType ?? null,
        feeBps:         data.feeBps ?? null,
    };
    return summary;
}

function parseArgs(argv) {
    const out = { taker: null };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--taker' && argv[i + 1]) { out.taker = argv[i + 1]; i++; }
    }
    return out;
}

async function main() {
    const env = requireKeys(load(), 'probe');
    const args = parseArgs(process.argv);
    const taker = args.taker || env.BURNER_PUBKEY;
    console.log('Taker pubkey:', taker, args.taker ? '(--taker override)' : '(from .env.test)');
    console.log('Probing SOL → USDC at amounts:', AMOUNTS_SOL.join(', '));
    console.log('');

    const rows = [];
    for (const sol of AMOUNTS_SOL) {
        const lamports = solToLamports(sol);
        process.stdout.write(`[${sol.toString().padEnd(7)} SOL = ${lamports.toString().padStart(11)} lamports] `);
        let res;
        try {
            res = await ultraOrder({
                apiKey: env.JUPITER_API_KEY,
                inputMint: SOL_MINT,
                outputMint: USDC_MINT,
                amount: lamports.toString(),
                taker,
            });
        } catch (e) {
            console.log(`THROW: ${e.message}`);
            rows.push({ sol, status: 'throw', error: e.message });
            continue;
        }
        const summary = summarize(res.data);
        console.log(`HTTP ${res.status} | tx=${summary.hasTransaction ? 'YES' : 'NO '} | out=${summary.outAmount ?? '—'} | route=${summary.routePlan || '—'}${summary.errorCode ? ` | errorCode=${summary.errorCode}` : ''}${summary.errorMessage ? ` | "${summary.errorMessage}"` : ''}`);
        rows.push({ sol, status: res.status, ...summary });
    }

    console.log('');
    console.log('═══ FULL RESPONSE BODIES (first failure + first success) ═══');
    const firstFail = rows.find(r => r.hasTransaction === false);
    const firstOk   = rows.find(r => r.hasTransaction === true);
    if (firstFail) {
        console.log(`\n--- FAIL @ ${firstFail.sol} SOL ---`);
        console.log(JSON.stringify(firstFail, null, 2));
    }
    if (firstOk) {
        console.log(`\n--- OK   @ ${firstOk.sol} SOL ---`);
        console.log(JSON.stringify({ ...firstOk, transaction: '[truncated]' }, null, 2));
    }

    console.log('');
    console.log('═══ SUMMARY ═══');
    console.log('Threshold (smallest amount that returns a tx): ' +
        (firstOk ? `${firstOk.sol} SOL` : 'NONE — no probe size succeeded'));
    if (firstFail && firstOk) {
        console.log(`Failures below threshold: ${rows.filter(r => r.hasTransaction === false).map(r => r.sol).join(', ')} SOL`);
        console.log(`Successes at/above threshold: ${rows.filter(r => r.hasTransaction === true).map(r => r.sol).join(', ')} SOL`);
    }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(2); });
