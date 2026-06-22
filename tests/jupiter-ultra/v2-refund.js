#!/usr/bin/env node
// v2-refund.js — refund 10 USDC from the test wallet to the destination
// address Beka provided. Uses SPL TransferChecked (verifies mint + decimals,
// safer than bare Transfer).
//
// SAFETY:
//   - Pre-broadcast logging prints every field of the tx before signing/sending
//     so a wrong destination ATA is impossible to miss.
//   - Aborts if the destination's USDC ATA doesn't exist (refuses to create one
//     silently — would cost the sender ~0.002 SOL rent, and might indicate the
//     destination is wrong).
//   - Uses TransferChecked (asserts decimals == 6 + mint == USDC); a malformed
//     ATA can't accept the transfer.
//
// Run: node tests/jupiter-ultra/v2-refund.js

'use strict';

const fs = require('fs');
const path = require('path');
const {
    Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {
    getAssociatedTokenAddressSync, createTransferCheckedInstruction, TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');

const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDC_DECIMALS = 6;
const AMOUNT_UI = 10;
const AMOUNT_ATOMIC = BigInt(AMOUNT_UI * 10 ** USDC_DECIMALS); // 10_000_000

const DEST_PUBKEY = new PublicKey('FnUV4FBpUHizZppx7EToGj3dtfsAYdJfa6zjgJBVjNGf');

// Load env
function loadEnv(file) {
    const out = {};
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    return out;
}
const env = loadEnv(path.join(__dirname, '.env.test'));
const SOLANA_RPC = env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const BURNER_SECRET_KEY = env.BURNER_SECRET_KEY;
if (!BURNER_SECRET_KEY) { console.error('Missing BURNER_SECRET_KEY in .env.test'); process.exit(1); }
const secretKeyArr = JSON.parse(BURNER_SECRET_KEY);
if (!Array.isArray(secretKeyArr) || secretKeyArr.length !== 64) {
    console.error('BURNER_SECRET_KEY must be a JSON array of 64 numbers'); process.exit(1);
}

(async () => {
    console.log('═══ USDC refund (test wallet → Beka destination) ═══');

    const sender = Keypair.fromSecretKey(Uint8Array.from(secretKeyArr));
    const senderPubkey = sender.publicKey;
    const sourceAta = getAssociatedTokenAddressSync(USDC_MINT, senderPubkey, false);
    const destAta = getAssociatedTokenAddressSync(USDC_MINT, DEST_PUBKEY, false);

    console.log('rpc:        ' + SOLANA_RPC);
    console.log('sender:     ' + senderPubkey.toBase58());
    console.log('source ATA: ' + sourceAta.toBase58());
    console.log('dest owner: ' + DEST_PUBKEY.toBase58());
    console.log('dest ATA:   ' + destAta.toBase58());
    console.log('mint:       ' + USDC_MINT.toBase58() + ' (USDC, 6 decimals)');
    console.log('amount:     ' + AMOUNT_UI + ' USDC  (' + AMOUNT_ATOMIC.toString() + ' atomic)');
    console.log('');

    const connection = new Connection(SOLANA_RPC, 'confirmed');

    // ── Pre-flight: confirm destination ATA exists ──────────────────────────
    console.log('1) pre-flight: check destination USDC ATA exists …');
    const destAtaInfo = await connection.getAccountInfo(destAta);
    if (!destAtaInfo) {
        console.error('');
        console.error('   ✗ destination USDC ATA does not exist on-chain.');
        console.error('   Refusing to create silently (would cost ~0.002 SOL rent from sender,');
        console.error('   AND a missing ATA suggests the destination address may not be set up');
        console.error('   for USDC yet — double-check FnUV4FBpUHizZppx7EToGj3dtfsAYdJfa6zjgJBVjNGf');
        console.error('   is correct. Re-run with --create-ata to force creation if intentional.');
        process.exit(2);
    }
    console.log('   ✓ destination ATA exists (' + destAtaInfo.data.length + ' bytes, owner=' + destAtaInfo.owner.toBase58().slice(0, 8) + '…)');

    // ── Pre-flight: confirm source has enough USDC + SOL ────────────────────
    console.log('2) pre-flight: check source balances …');
    const srcAtaInfo = await connection.getAccountInfo(sourceAta);
    if (!srcAtaInfo) { console.error('   ✗ source USDC ATA missing — nothing to send'); process.exit(2); }
    const senderSolLamports = await connection.getBalance(senderPubkey);
    console.log('   ✓ source ATA exists; sender SOL: ' + (senderSolLamports / 1e9).toFixed(6));
    if (senderSolLamports < 5000) { console.error('   ✗ insufficient SOL for fee (<5000 lamports)'); process.exit(2); }

    // ── Build + sign + send transaction ─────────────────────────────────────
    console.log('3) build TransferChecked tx …');
    const ix = createTransferCheckedInstruction(
        sourceAta,        // source
        USDC_MINT,        // mint (verified on-chain by TransferChecked)
        destAta,          // destination
        senderPubkey,     // owner of source
        AMOUNT_ATOMIC,    // amount (bigint)
        USDC_DECIMALS,    // decimals (verified on-chain by TransferChecked)
        [],               // multisig signers (none)
        TOKEN_PROGRAM_ID,
    );

    const tx = new Transaction().add(ix);
    tx.feePayer = senderPubkey;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;

    console.log('   ✓ tx built; blockhash=' + blockhash.slice(0, 8) + '…');
    console.log('');

    console.log('4) signing + sending (this moves real funds) …');
    const sig = await sendAndConfirmTransaction(connection, tx, [sender], {
        commitment: 'confirmed',
        skipPreflight: false,
    });
    console.log('   ✓ confirmed signature: ' + sig);
    console.log('');

    // ── Post-flight verify ──────────────────────────────────────────────────
    console.log('5) post-flight verify …');
    const statusRes = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const st = (statusRes.value && statusRes.value[0]) || null;
    console.log('   status=' + (st ? st.confirmationStatus : '<not found>') + ' err=' + JSON.stringify(st && st.err));

    console.log('');
    console.log('═══ refund complete ═══');
    console.log('signature: ' + sig);
    console.log('Solscan:   https://solscan.io/tx/' + sig);
    console.log('Run --balance after ~15s to confirm sender USDC dropped by 10.');
})().catch((e) => {
    console.error('refund crashed:', e.message);
    if (e.logs) console.error('logs:', e.logs);
    process.exit(1);
});
