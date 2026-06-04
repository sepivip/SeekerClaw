// SeekerClaw — wallet/tx-parser.js
//
// Shared hand-rolled Solana transaction parser (BAT-1013).
//
// WHY THIS EXISTS
// ---------------
// The app's nodejs-mobile runtime has NO `@solana/web3.js` dependency
// (verified 2026-06-04: `nodejs-project/package.json` lists only `ws`
// for Discord; zero `@solana/*` requires anywhere in the bundle). Every
// piece of code that touches serialized transactions hand-rolls its own
// binary parsing — `solana.js verifySwapTransaction()` for the structural
// payer/signer check, `payment/x402.js` for the legacy + v2 USDC transfer
// builders. This module consolidates that parsing pattern in one place
// so:
//   1. `verifySwapTransaction()` (structural check + log labels) and
//   2. `wallet/burner-policy.js validateBurnerTx()` (drainer blocklist
//       + simulate-vs-quote)
// share the same bytes-on-the-wire interpretation.
//
// EXPORTS
// -------
//   - `TxParseError`: Error subclass thrown on malformed bytes. Carries
//     `.position` (byte offset where parsing failed) and `.reason`.
//   - `parseTransaction(txBase64)`: returns `{ kind, numRequiredSignatures,
//     numReadonlySigned, numReadonlyUnsigned, staticAccountKeys[],
//     altLookups[]|null, instructions[], recentBlockhash }`.
//   - `readCompactU16(buf, offset)`: low-level helper. Kept exported so
//     other modules don't re-roll their own.
//   - `base58Encode(bytes)` / `base58Decode(str)`: re-exported from
//     ./internal/base58 (hand-rolled in the codebase already).
//
// CONTRACT (deterministic; fail-closed)
// -------------------------------------
//   - Empty / non-base64 input → TxParseError('invalid_base64')
//   - Truncated bytes (read past end) → TxParseError('truncated', position)
//   - Compact-u16 with > 3 continuation bytes → TxParseError('compact_u16_overflow')
//   - Account-index out of range in instruction.accountIdxs is NOT a
//     parser concern — the parser surfaces the raw indices. Callers
//     decide whether to fail closed on out-of-range (verifySwapTransaction
//     does; burner-policy uses simulation's loadedAddresses to resolve
//     ALT-resolved indices).
//
// HISTORY
// -------
// Extracted from `solana.js verifySwapTransaction()` (BAT-1013 Phase 2).
// The inline parser there is retained for now; a follow-up may migrate
// `verifySwapTransaction()` to use this module. Codex review v1.1
// amendment #1 explicitly OK'd extraction provided tests cover legacy +
// v0 + malformed (see `tests/nodejs-project/tx-parser.test.js`).

'use strict';

// ─── Base58 ────────────────────────────────────────────────────────────────
//
// Solana addresses are 32-byte Ed25519 public keys encoded in base58.
// We re-implement encode/decode here rather than pull in a dependency,
// matching the pattern in `solana.js` and `payment/x402.js`.

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_INDEX = (() => {
    const idx = new Array(128).fill(-1);
    for (let i = 0; i < BASE58_ALPHABET.length; i++) {
        idx[BASE58_ALPHABET.charCodeAt(i)] = i;
    }
    return idx;
})();

function base58Encode(bytes) {
    if (!bytes || bytes.length === 0) return '';
    // Count leading zeros.
    let leadingZeros = 0;
    while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros++;
    // All-zero input (e.g. System Program ID) — emit exactly one '1' per byte.
    // Without this guard the digits accumulator below would emit one extra '1'
    // because `digits = [0]` survives the empty inner loop.
    if (leadingZeros === bytes.length) {
        return BASE58_ALPHABET[0].repeat(bytes.length);
    }
    // Convert bytes to base-58 digits (little-endian accumulator).
    const digits = [0];
    for (let i = leadingZeros; i < bytes.length; i++) {
        let carry = bytes[i];
        for (let j = 0; j < digits.length; j++) {
            carry += digits[j] << 8;
            digits[j] = carry % 58;
            carry = (carry / 58) | 0;
        }
        while (carry) {
            digits.push(carry % 58);
            carry = (carry / 58) | 0;
        }
    }
    let out = '';
    for (let i = 0; i < leadingZeros; i++) out += BASE58_ALPHABET[0];
    for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]];
    return out;
}

function base58Decode(str) {
    if (typeof str !== 'string') {
        throw new TxParseError('invalid_base58', 0, 'input is not a string');
    }
    if (str.length === 0) return Buffer.alloc(0);
    // Count leading '1's (decode to leading zero bytes).
    let leadingOnes = 0;
    while (leadingOnes < str.length && str[leadingOnes] === '1') leadingOnes++;
    // All-'1' input (e.g. System Program ID) → all-zero output. Without this
    // guard the loop's initial `bytes = [0]` would leak one phantom byte.
    if (leadingOnes === str.length) {
        return Buffer.alloc(leadingOnes);
    }
    const bytes = [0];
    for (let i = leadingOnes; i < str.length; i++) {
        const code = str.charCodeAt(i);
        const digit = code < 128 ? BASE58_INDEX[code] : -1;
        if (digit < 0) {
            throw new TxParseError('invalid_base58', i, `non-base58 character at position ${i}`);
        }
        let carry = digit;
        for (let j = 0; j < bytes.length; j++) {
            carry += bytes[j] * 58;
            bytes[j] = carry & 0xff;
            carry >>>= 8;
        }
        while (carry) {
            bytes.push(carry & 0xff);
            carry >>>= 8;
        }
    }
    const out = Buffer.alloc(leadingOnes + bytes.length);
    for (let i = 0; i < bytes.length; i++) out[leadingOnes + i] = bytes[bytes.length - 1 - i];
    return out;
}

// ─── Parser error ──────────────────────────────────────────────────────────

class TxParseError extends Error {
    constructor(reason, position, detail) {
        super(`tx_parse_error:${reason} at byte ${position}${detail ? ` (${detail})` : ''}`);
        this.name = 'TxParseError';
        this.reason = reason;
        this.position = position;
        this.detail = detail || null;
    }
}

// ─── Low-level helpers ─────────────────────────────────────────────────────

/**
 * Read a Solana compact-u16 (1-3 bytes, 7 data bits per byte, MSB = continue).
 *
 * Solana's wire format caps the encoded value at 0xFFFF (65535), so the
 * parser tolerates at most 3 bytes. A 4th continuation byte indicates
 * malformed bytes and throws.
 *
 * @param {Buffer} buf
 * @param {number} offset
 * @returns {{ value: number, offset: number }}
 */
function readCompactU16(buf, offset) {
    let value = 0;
    let shift = 0;
    let pos = offset;
    let count = 0;
    while (pos < buf.length) {
        const byte = buf[pos]; pos++;
        value |= (byte & 0x7F) << shift;
        if ((byte & 0x80) === 0) {
            return { value, offset: pos };
        }
        shift += 7;
        count++;
        if (count > 2) {
            throw new TxParseError('compact_u16_overflow', pos, 'more than 3 continuation bytes');
        }
    }
    throw new TxParseError('truncated', pos, 'unterminated compact-u16');
}

function readBytes(buf, offset, n) {
    if (offset + n > buf.length) {
        throw new TxParseError('truncated', offset, `wanted ${n} bytes, only ${buf.length - offset} remain`);
    }
    return buf.slice(offset, offset + n);
}

function readU8(buf, offset) {
    if (offset >= buf.length) {
        throw new TxParseError('truncated', offset, 'wanted 1 byte');
    }
    return buf[offset];
}

// ─── Top-level: parseTransaction ───────────────────────────────────────────

/**
 * Parse a serialized Solana transaction (base64-encoded) into a structured
 * object that callers can validate. Distinguishes legacy and v0 transactions
 * by the message prefix byte.
 *
 * @param {string} txBase64
 * @returns {{
 *   kind: 'legacy' | 'v0',
 *   numRequiredSignatures: number,
 *   numReadonlySigned: number,
 *   numReadonlyUnsigned: number,
 *   staticAccountKeys: string[],
 *   altLookups: Array<{
 *     tableAccount: string,
 *     writableIndexes: number[],
 *     readonlyIndexes: number[]
 *   }> | null,
 *   instructions: Array<{
 *     programIdIdx: number,
 *     accountIdxs: number[],
 *     dataBytes: Buffer
 *   }>,
 *   recentBlockhash: string
 * }}
 *
 * Throws `TxParseError` on malformed input. Callers must catch and convert
 * to their domain reject code (`tx_unparseable` in burner-policy.js,
 * `Transaction rejected: ...` in verifySwapTransaction()).
 */
function parseTransaction(txBase64) {
    if (typeof txBase64 !== 'string' || txBase64.length === 0) {
        throw new TxParseError('invalid_base64', 0, 'tx must be a non-empty base64 string');
    }
    let txBuf;
    try {
        txBuf = Buffer.from(txBase64, 'base64');
    } catch (e) {
        throw new TxParseError('invalid_base64', 0, e.message);
    }
    if (txBuf.length < 1) {
        throw new TxParseError('truncated', 0, 'empty buffer after base64 decode');
    }

    // ── Signature section ──
    let offset = 0;
    const numSigs = readCompactU16(txBuf, offset);
    offset = numSigs.offset;
    offset += numSigs.value * 64;
    if (offset > txBuf.length) {
        throw new TxParseError('truncated', offset, 'signature section overruns buffer');
    }

    // ── Detect v0 vs legacy ──
    const prefix = readU8(txBuf, offset);
    const isV0 = prefix === 0x80;
    const kind = isV0 ? 'v0' : 'legacy';
    if (isV0) offset++;

    // ── Header (3 bytes) ──
    const numRequiredSignatures = readU8(txBuf, offset); offset++;
    const numReadonlySigned = readU8(txBuf, offset); offset++;
    const numReadonlyUnsigned = readU8(txBuf, offset); offset++;

    // ── Static account keys ──
    const numStatic = readCompactU16(txBuf, offset);
    offset = numStatic.offset;
    const staticAccountKeys = [];
    for (let i = 0; i < numStatic.value; i++) {
        staticAccountKeys.push(base58Encode(readBytes(txBuf, offset, 32)));
        offset += 32;
    }

    // ── Recent blockhash ──
    const recentBlockhash = base58Encode(readBytes(txBuf, offset, 32));
    offset += 32;

    // ── Instructions ──
    const numInstr = readCompactU16(txBuf, offset);
    offset = numInstr.offset;
    const instructions = [];
    for (let i = 0; i < numInstr.value; i++) {
        const programIdIdx = readU8(txBuf, offset); offset++;
        const numAccts = readCompactU16(txBuf, offset);
        offset = numAccts.offset;
        const accountIdxs = [];
        for (let j = 0; j < numAccts.value; j++) {
            accountIdxs.push(readU8(txBuf, offset));
            offset++;
        }
        const dataLen = readCompactU16(txBuf, offset);
        offset = dataLen.offset;
        const dataBytes = readBytes(txBuf, offset, dataLen.value);
        offset += dataLen.value;
        instructions.push({ programIdIdx, accountIdxs, dataBytes });
    }

    // ── Address Lookup Tables (v0 only) ──
    let altLookups = null;
    if (isV0) {
        const numAlt = readCompactU16(txBuf, offset);
        offset = numAlt.offset;
        altLookups = [];
        for (let i = 0; i < numAlt.value; i++) {
            const tableAccount = base58Encode(readBytes(txBuf, offset, 32));
            offset += 32;
            const numWritable = readCompactU16(txBuf, offset);
            offset = numWritable.offset;
            const writableIndexes = [];
            for (let j = 0; j < numWritable.value; j++) {
                writableIndexes.push(readU8(txBuf, offset));
                offset++;
            }
            const numReadonly = readCompactU16(txBuf, offset);
            offset = numReadonly.offset;
            const readonlyIndexes = [];
            for (let j = 0; j < numReadonly.value; j++) {
                readonlyIndexes.push(readU8(txBuf, offset));
                offset++;
            }
            altLookups.push({ tableAccount, writableIndexes, readonlyIndexes });
        }
    }

    return {
        kind,
        numRequiredSignatures,
        numReadonlySigned,
        numReadonlyUnsigned,
        staticAccountKeys,
        altLookups,
        instructions,
        recentBlockhash,
    };
}

module.exports = {
    TxParseError,
    parseTransaction,
    readCompactU16,
    base58Encode,
    base58Decode,
};
