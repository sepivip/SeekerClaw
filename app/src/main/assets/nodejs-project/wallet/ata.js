// SeekerClaw — wallet/ata.js
//
// BAT-1013 Phase 3b: thin wrapper exposing the existing Associated Token
// Account (ATA) derivation from `payment/x402.js` to the wallet layer.
//
// The hand-rolled ATA + Ed25519 on-curve check has been live since BAT-582
// (used by every x402 v1 + v2 USDC transfer) and is pinned by fixture tests
// in tests/nodejs-project/x402.test.js. Re-using that battle-tested code
// avoids re-implementing the (subtle) ed25519 curve math in a second place.
//
// The wallet/burner-policy.js per-tool callers need to derive the burner's
// USDC / SOL / arbitrary-SPL ATAs at tx-build time so they can declare them
// in expectedDelta.burnerDebit.account / burnerOwnedAccounts.

'use strict';

const x402 = require('../payment/x402');

const TOKEN_PROGRAM_ID = x402.TOKEN_PROGRAM_ID;
const ASSOCIATED_TOKEN_PROGRAM_ID = x402.ASSOCIATED_TOKEN_PROGRAM_ID;

/**
 * Derive the ATA pubkey (base58) for the given owner + mint, both base58.
 * Throws on invalid input. Returns the canonical base58 ATA address as a
 * string.
 */
function deriveAtaBase58(ownerBase58, mintBase58) {
    const owner = x402._decodeSolanaPubkey(ownerBase58);
    const mint = x402._decodeSolanaPubkey(mintBase58);
    if (!owner) throw new Error(`invalid owner pubkey: ${ownerBase58}`);
    if (!mint) throw new Error(`invalid mint pubkey: ${mintBase58}`);
    const ata = x402._findAssociatedTokenAddress(owner, mint);
    // _findAssociatedTokenAddress returns { address: Buffer(32), bump: number }
    return _base58EncodeBuffer(ata.address);
}

// Lightweight base58 encoder. Avoid pulling in the tx-parser's encoder to
// keep this module dependency-free except for x402 (which already pulls
// crypto).
const _ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function _base58EncodeBuffer(buf) {
    if (!buf || buf.length === 0) return '';
    let zeros = 0;
    while (zeros < buf.length && buf[zeros] === 0) zeros++;
    let value = 0n;
    for (let i = 0; i < buf.length; i++) value = value * 256n + BigInt(buf[i]);
    let result = '';
    while (value > 0n) {
        result = _ALPHABET[Number(value % 58n)] + result;
        value = value / 58n;
    }
    return '1'.repeat(zeros) + result;
}

module.exports = {
    deriveAtaBase58,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
};
