// tests/jupiter-ultra/lib/sign-tx.js
//
// Local Ed25519 signer for Solana transactions. Mirrors what Android's
// KeyVault does on-device — but here in pure Node so we can exercise the
// sign+execute path without the Android bridge.
//
// Wire format we handle:
//   [compact-u16 sigCount][sigCount × 64-byte signature][message bytes]
//
// We ONLY support sigCount === 1. The burner is the sole signer for both
// Jupiter Ultra swaps (Ultra builds a single-signer tx — Jupiter pays gas
// and rent via gasless mode, so no co-signer fee payer) and x402 USDC
// transfers we build (also single-signer). Hard-failing on sigCount > 1
// here prevents a subtle bug class: signing slot 0 in a multi-sig tx and
// proceeding produces an unsigned-but-positionally-shifted tx that the
// network rejects later with a confusing "missing signature" error.

'use strict';

const crypto = require('crypto');

// compact-u16 (shortvec) decode — same as solana.js / payment/x402.js
//
// BAT-582 R27: track whether the encoding TERMINATED (saw a byte with
// MSB clear) versus ran out of input. Pre-fix the function returned
// successfully even if the buffer ended with the continuation bit
// (0x80) still set on the last byte — silently produced a partial
// value from a truncated/malformed shortvec. A signer downstream would
// then read garbage for sigCount, leading to weird-looking signatures
// against the wrong byte ranges. Fail loud on unterminated input.
function readCompactU16(buf, offset) {
    let value = 0;
    let shift = 0;
    let pos = offset;
    let terminated = false;
    while (pos < buf.length) {
        const byte = buf[pos]; pos++;
        value |= (byte & 0x7F) << shift;
        if ((byte & 0x80) === 0) { terminated = true; break; }
        shift += 7;
        if (shift > 21) throw new Error('compact-u16 overflow');
    }
    if (!terminated) {
        throw new Error('compact-u16 unterminated: buffer ended with continuation bit still set');
    }
    // BAT-582 R28: enforce u16 range. The overflow guard above bails at
    // shift > 21 (3 bytes × 7 bits = 21), but a 3-byte encoding can
    // legitimately produce values up to 2^21 - 1 = 2097151, far above the
    // u16 ceiling of 65535. Solana's compact-u16 spec is u16-bounded;
    // accepting larger values would let a malformed tx carry e.g. a
    // bogus sigCount that overflows downstream slot indexing. Throw
    // loud here so callers get a clear error code, not garbage slots.
    if (value > 0xFFFF) {
        throw new Error(`compact-u16 out of range: decoded value ${value} exceeds u16 max (65535)`);
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
    if (sigCount !== 1) {
        // See top-of-file comment: any tx with multiple required signers is
        // out of scope. Filling slot 0 only would produce an invalid tx
        // that fails late on /execute or chain submission with a confusing
        // error — fail loud here instead.
        throw new Error(`tx requires ${sigCount} signers but this signer only fills slot 0 — burner-only single-signer tx required`);
    }
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
