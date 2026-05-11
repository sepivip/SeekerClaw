// tests/jupiter-ultra/03-sign-execute.js
//
// Layer 3 — end-to-end local swap. Reproduces the exact flow our
// production code runs (Ultra /order → local Ed25519 sign → Ultra
// /execute) but with a test wallet whose secret lives in .env.test
// instead of Android KeyVault.
//
// Run: node tests/jupiter-ultra/03-sign-execute.js [amountSol]
//   default amountSol = 0.01
//
// SAFETY:
//   - mainnet, real funds
//   - swaps SOL → USDC at the requested amount + 1% slippage
//   - prints the tx signature for explorer follow-up
//   - DOES NOT proceed if BURNER_PUBKEY in .env.test doesn't match the
//     pubkey derived from BURNER_SECRET_KEY (catches "wrong wallet" mistakes)

'use strict';

const { load, requireKeys, parseSecretKey } = require('./lib/load-env');
const { ultraOrder, ultraExecute } = require('./lib/jupiter');
const { signSolanaTx, isSigned } = require('./lib/sign-tx');
const base58 = require('./lib/base58');

const SOL_MINT  = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function solToLamports(solStr) {
    // BAT-582 R20: parse from the ORIGINAL CLI argv string, never from
    // parseFloat'd Number. `parseFloat("0.0000001")` yields 1e-7, whose
    // `String(...)` representation is "1e-7" — split('.') then gives
    // `whole="1e-7"` and BigInt(whole) throws. Since this is the
    // tiny-amount diagnostic script, reject scientific notation
    // explicitly with a clear error.
    if (typeof solStr !== 'string') {
        throw new Error('solToLamports: pass the original argv string, not a Number');
    }
    const s = solStr.trim();
    if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) {
        throw new Error(`solToLamports: "${solStr}" must be a positive decimal (no signs, no scientific notation)`);
    }
    const [whole, frac = ''] = s.split('.');
    const padded = (frac + '000000000').slice(0, 9);
    return BigInt(whole) * 1_000_000_000n + BigInt(padded || '0');
}

async function main() {
    const env = requireKeys(load(), 'signExecute');
    // Keep the raw argv string for lamport conversion (avoids parseFloat
    // precision loss on tiny amounts). parseFloat is fine for the
    // display-only `amountSol` Number used in log output.
    const amountSolStr = (process.argv[2] || '0.01').trim();
    const amountSol = parseFloat(amountSolStr);
    if (!Number.isFinite(amountSol) || amountSol <= 0) {
        console.error('✗ amountSol must be a positive number'); process.exit(1);
    }

    const { secret, pubkey } = parseSecretKey(env.BURNER_SECRET_KEY);
    const derivedPubkey = base58.encode(pubkey);
    if (derivedPubkey !== env.BURNER_PUBKEY) {
        console.error('✗ BURNER_PUBKEY in .env.test does not match BURNER_SECRET_KEY');
        console.error(`  .env.test BURNER_PUBKEY:   ${env.BURNER_PUBKEY}`);
        console.error(`  derived from secret:       ${derivedPubkey}`);
        console.error('  Update one of them so they match.');
        process.exit(1);
    }

    const lamports = solToLamports(amountSolStr);
    console.log('═══ Layer 3 — Sign + Execute ═══');
    console.log(`Wallet:  ${derivedPubkey}`);
    console.log(`Swap:    ${amountSol} SOL (${lamports} lamports) → USDC`);
    console.log('');

    // Step 1 — Ultra /order
    console.log('[1/3] Requesting Ultra order...');
    const orderRes = await ultraOrder({
        apiKey: env.JUPITER_API_KEY,
        inputMint: SOL_MINT,
        outputMint: USDC_MINT,
        amount: lamports.toString(),
        taker: derivedPubkey,
    });
    if (orderRes.status !== 200) {
        console.error(`✗ Ultra /order returned HTTP ${orderRes.status}`);
        console.error(JSON.stringify(orderRes.data, null, 2));
        process.exit(2);
    }
    const order = orderRes.data;
    if (!order.transaction) {
        console.error('✗ Ultra /order succeeded but returned no transaction.');
        console.error(`  errorCode:    ${order.errorCode ?? '—'}`);
        console.error(`  errorMessage: ${order.errorMessage ?? order.message ?? '—'}`);
        console.error('  This is the same failure mode the production code hits at tiny');
        console.error('  amounts — try a larger amount (e.g. 0.02 SOL).');
        process.exit(2);
    }
    console.log(`      ✓ requestId=${order.requestId}`);
    console.log(`      ✓ outAmount=${order.outAmount} USDC microunits (${(Number(order.outAmount) / 1e6).toFixed(6)} USDC)`);
    console.log(`      ✓ priceImpactPct=${order.priceImpactPct ?? '—'}`);

    // Step 2 — Sign locally (this is what KeyVault does on Android)
    console.log('');
    console.log('[2/3] Signing locally with Ed25519...');
    const signedTx = signSolanaTx(order.transaction, secret, pubkey);
    if (!isSigned(signedTx)) {
        console.error('✗ Local sign produced an unsigned tx — bug in sign-tx.js');
        process.exit(2);
    }
    console.log('      ✓ signature spliced into slot 0');

    // Step 3 — Ultra /execute (Jupiter broadcasts)
    console.log('');
    console.log('[3/3] Executing via Jupiter Ultra...');
    const exec = await ultraExecute({
        apiKey: env.JUPITER_API_KEY,
        signedTransaction: signedTx,
        requestId: order.requestId,
    });

    if (exec.status !== 200) {
        console.error(`✗ Ultra /execute returned HTTP ${exec.status}`);
        console.error(JSON.stringify(exec.data, null, 2));
        process.exit(2);
    }
    if (exec.data.status === 'Failed') {
        console.error(`✗ Ultra reported Failed: ${exec.data.error || JSON.stringify(exec.data)}`);
        process.exit(2);
    }
    if (!exec.data.signature) {
        console.error('✗ Ultra /execute returned no signature');
        console.error(JSON.stringify(exec.data, null, 2));
        process.exit(2);
    }

    console.log(`      ✓ signature: ${exec.data.signature}`);
    console.log('');
    console.log('═══ SUCCESS ═══');
    console.log(`Explorer: https://solscan.io/tx/${exec.data.signature}`);
    console.log('');
    console.log('Next: Layer 4 (pay.sh / x402) — node tests/jupiter-ultra/04-x402-paysh.js');
}

main().catch((e) => { console.error('FATAL:', e); process.exit(2); });
