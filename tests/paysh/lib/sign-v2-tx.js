// tests/paysh/lib/sign-v2-tx.js
//
// Node-side Ed25519 signing for x402 v2 partially-signed transactions.
// Mirrors SolanaTxSigner.kt's insertSignature(allowPartiallySigned=true)
// path but in pure Node — so Layer 3 live-pay tests can exercise the
// full settle path WITHOUT going through the Android bridge.
//
// Why this exists separately from app/.../wallet/burner-signer.js:
//   - burner-signer.js delegates to the Android bridge (HTTP call to
//     /burner/sign-transaction). On the dev machine there is no bridge.
//   - Production (on Seeker) STILL uses the bridge. This file is test-
//     only; treat it as a synthetic local KeyVault.
//
// Wire format we handle (v2 partially-signed):
//   [shortvec(2)=0x02][slot 0 (64 zero bytes)][slot 1 (64 zero bytes)]
//   [message]
// where message = [0x80][header(3 bytes)][shortvec(8) account keys]
//                 [8 × 32 byte pubkeys][32 byte blockhash][instructions...][ALT]
//
// We sign slot 1 (burner) and leave slot 0 (facilitator) zero. The
// facilitator co-signs server-side after receiving PAYMENT-SIGNATURE.

'use strict';

const crypto = require('crypto');

function _makePrivateKey(secret32, pubkey32) {
    if (secret32.length !== 32) throw new Error(`secret must be 32 bytes, got ${secret32.length}`);
    if (pubkey32.length !== 32) throw new Error(`pubkey must be 32 bytes, got ${pubkey32.length}`);
    // OKP JWK per RFC 8037. Both `d` and `x` required for private key.
    const jwk = {
        kty: 'OKP',
        crv: 'Ed25519',
        d: Buffer.from(secret32).toString('base64url'),
        x: Buffer.from(pubkey32).toString('base64url'),
    };
    return crypto.createPrivateKey({ key: jwk, format: 'jwk' });
}

/**
 * Sign slot 1 of a v2 partially-signed Solana tx.
 *
 * @param {string} txBase64 — the partially-signed tx as produced by
 *                            X402Protocol.build() for x402 v2
 * @param {Buffer} secret32 — 32-byte burner Ed25519 seed
 * @param {Buffer} pubkey32 — 32-byte burner public key (validated against
 *                            account-keys[1] in the tx)
 * @returns {string} signed tx base64 (slot 0 still zero, slot 1 filled)
 */
function signV2TxSlot1(txBase64, secret32, pubkey32) {
    const buf = Buffer.from(txBase64, 'base64');

    // 1. shortvec(sigCount). v2 layout is always 2 → encoded as single byte 0x02.
    if (buf[0] !== 2) {
        throw new Error(`v2 partial-sign expects sigCount=2 (shortvec single byte 0x02), got 0x${buf[0].toString(16)}`);
    }
    const sigCountLen = 1;
    const numSigs = 2;

    // 2. Verify both slots are currently empty (partial-sign invariant).
    const sigsStart = sigCountLen;
    const messageStart = sigsStart + numSigs * 64;
    for (let i = 0; i < 64; i++) {
        if (buf[sigsStart + i] !== 0) throw new Error('slot 0 (facilitator) not empty — must remain unset for partial sign');
        if (buf[sigsStart + 64 + i] !== 0) throw new Error('slot 1 (burner) not empty — tx may have been signed already');
    }

    // 3. Verify v0 marker.
    if (buf[messageStart] !== 0x80) {
        throw new Error(`expected v0 versioned tx (marker 0x80) at messageStart, got 0x${buf[messageStart].toString(16)}`);
    }

    // 4. Verify header: numRequiredSignatures === 2 (matches our sigCount).
    const numRequiredSigs = buf[messageStart + 1];
    if (numRequiredSigs !== 2) {
        throw new Error(`header.numRequiredSignatures=${numRequiredSigs}, expected 2 (must match sigCount)`);
    }

    // 5. Validate that account-keys[1] is the burner pubkey. Account-keys
    //    section starts at messageStart + 1 (version byte) + 3 (header) = +4,
    //    with a shortvec(accountKeysCount) prefix. For v2 layouts the count
    //    is 8 — fits in one shortvec byte.
    const accountKeysCountByte = messageStart + 4;
    const accountKeysCount = buf[accountKeysCountByte];
    if (accountKeysCount < 2) throw new Error(`account-keys count ${accountKeysCount} < 2`);
    const slot1KeyStart = accountKeysCountByte + 1 + 1 * 32; // skip shortvec + slot 0 (32 bytes)
    const slot1Key = buf.subarray(slot1KeyStart, slot1KeyStart + 32);
    if (!slot1Key.equals(pubkey32)) {
        throw new Error(
            `account-keys[1] does not match burner pubkey:\n` +
            `  expected: ${pubkey32.toString('hex')}\n` +
            `  found:    ${slot1Key.toString('hex')}\n` +
            `  Did build() use the right burnerPubkey?`
        );
    }

    // 6. Sign canonical message bytes = everything from messageStart to end.
    const canonicalMessage = buf.subarray(messageStart);
    const privateKey = _makePrivateKey(secret32, pubkey32);
    const signature = crypto.sign(null, canonicalMessage, privateKey);
    if (signature.length !== 64) throw new Error(`Ed25519 signature must be 64 bytes, got ${signature.length}`);

    // 7. Insert into slot 1. Slot 0 stays zero (facilitator co-signs server-side).
    const out = Buffer.from(buf);
    signature.copy(out, sigsStart + 64);
    return out.toString('base64');
}

module.exports = { signV2TxSlot1 };
