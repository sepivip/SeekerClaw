// tests/jupiter-ultra/lib/sign-tx.js
//
// Local Ed25519 signer for Solana transactions. Mirrors what Android's
// KeyVault does on-device — but here in pure Node so we can exercise the
// sign+execute path without the Android bridge.
//
// Wire format we handle:
//   [compact-u16 sigCount][sigCount × 64-byte signature][message bytes]
//
// We only support sigCount === 1 (the burner is the sole signer for both
// Jupiter Ultra swaps and x402 USDC transfers we build). Multisig is out of
// scope for these tests.

'use strict';

const crypto = require('crypto');

// compact-u16 (shortvec) decode — same as solana.js / payment/x402.js
function readCompactU16(buf, offset) {
    let value = 0;
    let shift = 0;
    let pos = offset;
    while (pos < buf.length) {
        const byte = buf[pos]; pos++;
        value |= (byte & 0x7F) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
        if (shift > 21) throw new Error('compact-u16 overflow');
    }
    return { value, length: pos - offset };
}

function makePrivateKey(secret32, pubkey32) {
    if (secret32.length !== 32) throw new Error(`secret must be 32 bytes, got ${secret32.length}`);
    if (pubkey32.length !== 32) throw new Error(`pubkey must be 32 bytes, got ${pubkey32.length}`);
    // Node 22+ requires `x` in the JWK even though the spec calls it optional.
    // The caller already has both halves of the 64-byte Solana secret_key.
    const jwk = {
        kty: 'OKP',
        crv: 'Ed25519',
        d: Buffer.from(secret32).toString('base64url'),
        x: Buffer.from(pubkey32).toString('base64url'),
    };
    return crypto.createPrivateKey({ key: jwk, format: 'jwk' });
}

/**
 * Sign a Solana transaction in-place. Returns a NEW base64 string with the
 * signature spliced into signature slot 0.
 *
 * @param {string} txBase64        — unsigned tx as Jupiter Ultra returns it
 * @param {Buffer} secret32        — 32-byte Ed25519 secret (NOT the 64-byte secret_key)
 * @param {Buffer} pubkey32        — 32-byte Ed25519 public key
 * @returns {string}               — signed tx, base64
 */
function signSolanaTx(txBase64, secret32, pubkey32) {
    const buf = Buffer.from(txBase64, 'base64');
    const { value: sigCount, length: sigCountLen } = readCompactU16(buf, 0);
    if (sigCount < 1) throw new Error('tx has no signature slots');
    if (sigCount > 4) throw new Error(`tx has too many signers (${sigCount}) — burner is sole signer`);
    const sigStart = sigCountLen;
    const messageStart = sigStart + sigCount * 64;
    if (messageStart > buf.length) throw new Error('tx truncated — sig section runs past end');
    const message = buf.subarray(messageStart);
    const privateKey = makePrivateKey(secret32, pubkey32);
    const signature = crypto.sign(null, message, privateKey);
    if (signature.length !== 64) throw new Error(`unexpected signature length: ${signature.length}`);
    const out = Buffer.from(buf); // copy
    signature.copy(out, sigStart); // overwrite slot 0
    return out.toString('base64');
}

/**
 * Verify a tx is signed (signature slot 0 is non-zero). Useful sanity check
 * before sending to Jupiter Ultra /execute.
 */
function isSigned(txBase64) {
    const buf = Buffer.from(txBase64, 'base64');
    const { value: sigCount, length: sigCountLen } = readCompactU16(buf, 0);
    if (sigCount < 1) return false;
    const sig0 = buf.subarray(sigCountLen, sigCountLen + 64);
    return !sig0.every(b => b === 0);
}

module.exports = { signSolanaTx, isSigned, readCompactU16 };
