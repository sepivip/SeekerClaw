#!/usr/bin/env node
// x402-v2-tx.test.js — BAT-582 v1.6 Phase 5a.
//
// Verifies the v0 versioned partially-signed transaction built by
// `_buildV2UsdcTransferTx` is byte-correct per the Coinbase x402 v2
// spec (specs/schemes/exact/scheme_exact_svm.md). Tests are
// fixture-driven against synthetic but spec-compliant inputs.
//
// Pre-fix verification: temporarily change any field (wrong account
// index, wrong instruction order, wrong cuLimit value) and rerun —
// the appropriate test should fail.

'use strict';

const assert = require('assert');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

// Stub config.js so x402.js loads without workspace/env state.
const configPath = require.resolve(path.join(BUNDLE, 'config.js'));
require.cache[configPath] = {
    id: configPath, filename: configPath, loaded: true,
    exports: { BRIDGE_TOKEN: 'test', log: () => {} },
};

const x402 = require(path.join(BUNDLE, 'payment', 'x402'));
const {
    _buildV2UsdcTransferTx,
    _buildCuLimitData,
    _buildCuPriceData,
    _buildMemoData,
    _generateRandomMemoNonce,
    _buildV2PaymentSignatureHeader,
    _decodeSolanaPubkey,
    USDC_MINT,
    COMPUTE_BUDGET_PROGRAM_ID,
    MEMO_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
} = x402;

// Fixture pubkeys (all valid base58, decoded to 32 bytes — known mainnet keys for tests).
const BURNER       = '7xKXTg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const RECIPIENT    = '9hw9Py9uMGtXRNpABZjifcK1t3suwzjyri9L9QYKg6zZ';  // Tripadvisor capture's payTo
const FACILITATOR  = '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4';  // Tripadvisor capture's extra.feePayer
const BLOCKHASH    = '2tLBHqeQdeq4Pzioote4ueMkQjrpdnNLBTuDtyKo4ds9';   // arbitrary valid base58, 32 bytes
const MEMO_FIXED   = 'abcdef0123456789abcdef0123456789';                // 32 hex chars = 16 bytes
const AMOUNT_USDC  = 10000n;                                            // $0.01 (Tripadvisor pricing)

let failures = 0;
function check(label, fn) {
    try { fn(); console.log(`  ✓ ${label}`); }
    catch (e) { failures++; console.error(`  ✗ ${label}\n    ${e.stack || e.message}`); }
}

// compact-u16 decode (mirrors x402.js implementation for parsing the
// tx in the assertions below).
function readShortvec(buf, offset) {
    let value = 0, shift = 0, pos = offset;
    while (pos < buf.length) {
        const b = buf[pos]; pos++;
        value |= (b & 0x7F) << shift;
        if ((b & 0x80) === 0) return { value, length: pos - offset };
        shift += 7;
    }
    throw new Error('compact-u16 unterminated');
}

console.log('═══ x402 v2 tx builder ═══');
console.log('');

// ── Instruction data builders ────────────────────────────────────────────

check('_buildCuLimitData encodes [0x02, u32_le(limit)]', () => {
    const out = _buildCuLimitData(50000);
    assert.strictEqual(out.length, 5, 'CU-limit data must be 5 bytes');
    assert.strictEqual(out[0], 0x02, 'discriminator must be 0x02');
    assert.strictEqual(out.readUInt32LE(1), 50000, 'u32 LE encoding');
});

check('_buildCuPriceData encodes [0x03, u64_le(microLamports)]', () => {
    const out = _buildCuPriceData(1000n);
    assert.strictEqual(out.length, 9, 'CU-price data must be 9 bytes');
    assert.strictEqual(out[0], 0x03, 'discriminator must be 0x03');
    assert.strictEqual(out.readBigUInt64LE(1), 1000n, 'u64 LE encoding');
});

check('_buildMemoData encodes raw UTF-8', () => {
    const out = _buildMemoData('hello');
    assert.deepStrictEqual(Array.from(out), [104, 101, 108, 108, 111]);
});

check('_generateRandomMemoNonce returns 32 hex chars (16 bytes entropy)', () => {
    const n = _generateRandomMemoNonce();
    assert.strictEqual(n.length, 32);
    assert.ok(/^[0-9a-f]{32}$/.test(n), 'must be lowercase hex');
    // Two calls must differ (cryptographic randomness).
    const n2 = _generateRandomMemoNonce();
    assert.notStrictEqual(n, n2);
});

// ── Input validation (BAT-582 v1.6 R-pr367-fix-5) ───────────────────────

check('_buildCuLimitData rejects negative limits (no bitwise wrap)', () => {
    assert.throws(() => _buildCuLimitData(-1), /positive integer in u32 range/);
});

check('_buildCuLimitData rejects zero', () => {
    assert.throws(() => _buildCuLimitData(0), /positive integer in u32 range/);
});

check('_buildCuLimitData rejects non-integer (float)', () => {
    assert.throws(() => _buildCuLimitData(3.7), /positive integer in u32 range/);
});

check('_buildCuLimitData rejects NaN and non-numeric', () => {
    assert.throws(() => _buildCuLimitData(NaN), /positive integer in u32 range/);
    assert.throws(() => _buildCuLimitData('abc'), /positive integer in u32 range/);
});

check('_buildCuLimitData rejects values above u32 max', () => {
    assert.throws(() => _buildCuLimitData(0x100000000), /positive integer in u32 range/);
});

check('_buildV2UsdcTransferTx rejects negative opts.cuLimit', () => {
    assert.throws(
        () => _buildV2UsdcTransferTx(BURNER, RECIPIENT, FACILITATOR, AMOUNT_USDC, BLOCKHASH, MEMO_FIXED, { cuLimit: -1 }),
        /opts\.cuLimit must be a positive integer/,
    );
});

check('_buildV2UsdcTransferTx rejects float opts.cuLimit (no silent truncation)', () => {
    assert.throws(
        () => _buildV2UsdcTransferTx(BURNER, RECIPIENT, FACILITATOR, AMOUNT_USDC, BLOCKHASH, MEMO_FIXED, { cuLimit: 3.7 }),
        /opts\.cuLimit must be a positive integer/,
    );
});

check('_buildV2UsdcTransferTx defaults cuLimit when undefined (existing behavior preserved)', () => {
    const { paymentMeta: m } = _buildV2UsdcTransferTx(
        BURNER, RECIPIENT, FACILITATOR, AMOUNT_USDC, BLOCKHASH, MEMO_FIXED
    );
    assert.strictEqual(m.cuLimit, 50_000);
});

check('_buildV2PaymentSignatureHeader rejects missing signedTxBase64', () => {
    const meta = {
        requirement: { extra: { feePayer: FACILITATOR }, resource: { url: 'https://x' }, payTo: RECIPIENT },
        memo: MEMO_FIXED,
        amountAtomic: AMOUNT_USDC,
        negotiatedNetwork: 'solana',
    };
    const r1 = _buildV2PaymentSignatureHeader(meta, undefined);
    assert.strictEqual(r1.error, 'v2_settle_missing_signed_tx');
    const r2 = _buildV2PaymentSignatureHeader(meta, '');
    assert.strictEqual(r2.error, 'v2_settle_missing_signed_tx');
    const r3 = _buildV2PaymentSignatureHeader(meta, null);
    assert.strictEqual(r3.error, 'v2_settle_missing_signed_tx');
    const r4 = _buildV2PaymentSignatureHeader(meta, 42);
    assert.strictEqual(r4.error, 'v2_settle_missing_signed_tx');
});

check('_buildV2PaymentSignatureHeader accepts valid non-empty signedTxBase64', () => {
    const meta = {
        requirement: { extra: { feePayer: FACILITATOR }, resource: { url: 'https://x' }, payTo: RECIPIENT },
        memo: MEMO_FIXED,
        amountAtomic: AMOUNT_USDC,
        negotiatedNetwork: 'solana',
    };
    const r = _buildV2PaymentSignatureHeader(meta, 'AQABBA==');
    assert.ok(r.value, 'must return a base64 header value');
    assert.ok(!r.error, 'must not error on valid input');
});

check('_buildV2PaymentSignatureHeader preserves server-provided extra fields (R-pr367-fix-7)', () => {
    // Future facilitators may add fields beyond feePayer + memo (e.g.,
    // signing nonces, fee tiers, expiration hints). Pre-fix dropped them
    // by rebuilding `extra` as `{ feePayer, memo }`. Now we shallow-clone
    // so unknown fields round-trip back in the PAYMENT-SIGNATURE proof.
    const meta = {
        requirement: {
            extra: {
                feePayer: FACILITATOR,
                signingNonce: 'abc123',
                feeTier: 'priority',
                expiresAt: 1234567890,
            },
            resource: { url: 'https://x' },
            payTo: RECIPIENT,
        },
        memo: MEMO_FIXED,
        amountAtomic: AMOUNT_USDC,
        negotiatedNetwork: 'solana',
    };
    const r = _buildV2PaymentSignatureHeader(meta, 'AQABBA==');
    assert.ok(r.value);
    const decoded = JSON.parse(Buffer.from(r.value, 'base64').toString('utf8'));
    assert.strictEqual(decoded.accepted.extra.feePayer, FACILITATOR);
    assert.strictEqual(decoded.accepted.extra.memo, MEMO_FIXED, 'memo must be the one used in tx (overrides server value)');
    assert.strictEqual(decoded.accepted.extra.signingNonce, 'abc123', 'extension field must be preserved');
    assert.strictEqual(decoded.accepted.extra.feeTier, 'priority', 'extension field must be preserved');
    assert.strictEqual(decoded.accepted.extra.expiresAt, 1234567890, 'extension field must be preserved');
});

check('_buildV2PaymentSignatureHeader rejects oversized proofs (R-pr367-fix-8 DoS guard)', () => {
    // Hostile facilitator inflates server-controlled fields (extra.*,
    // resource.description, mimeType) to force a huge PAYMENT-SIGNATURE
    // header. Must fail closed with v2_settle_proof_too_large before any
    // network call.
    const meta = {
        requirement: {
            extra: { feePayer: FACILITATOR, junk: 'A'.repeat(10_000) },
            resource: { url: 'https://x' },
            payTo: RECIPIENT,
        },
        memo: MEMO_FIXED,
        amountAtomic: AMOUNT_USDC,
        negotiatedNetwork: 'solana',
    };
    const r = _buildV2PaymentSignatureHeader(meta, 'AQABBA==');
    assert.strictEqual(r.error, 'v2_settle_proof_too_large');
    assert.ok(!r.value);
});

check('_buildV2PaymentSignatureHeader accepts normal-sized proofs (under 8KB cap)', () => {
    // Sanity: a reasonable proof (small extra, small description) must
    // pass — the cap exists to block pathological inputs only.
    const meta = {
        requirement: {
            extra: { feePayer: FACILITATOR, signingNonce: 'abc123' },
            resource: { url: 'https://x.example.com/resource', description: 'A short description' },
            payTo: RECIPIENT,
        },
        memo: MEMO_FIXED,
        amountAtomic: AMOUNT_USDC,
        negotiatedNetwork: 'solana',
    };
    const r = _buildV2PaymentSignatureHeader(meta, 'AQABBA==');
    assert.ok(r.value, 'normal proof must pass the size check');
    assert.ok(r.value.length <= 8192);
});

check('_buildV2PaymentSignatureHeader overrides server-provided memo with paymentMeta.memo', () => {
    // build() may have generated a random nonce if challenge had no
    // extra.memo; the proof must reflect what's actually IN the signed tx,
    // not what the server originally sent.
    const meta = {
        requirement: {
            extra: { feePayer: FACILITATOR, memo: 'stale-server-memo' },
            resource: { url: 'https://x' },
            payTo: RECIPIENT,
        },
        memo: MEMO_FIXED,  // what we actually used in the tx
        amountAtomic: AMOUNT_USDC,
        negotiatedNetwork: 'solana',
    };
    const r = _buildV2PaymentSignatureHeader(meta, 'AQABBA==');
    const decoded = JSON.parse(Buffer.from(r.value, 'base64').toString('utf8'));
    assert.strictEqual(decoded.accepted.extra.memo, MEMO_FIXED);
});

// ── Full v2 tx structure ────────────────────────────────────────────────

const { txBuffer, paymentMeta } = _buildV2UsdcTransferTx(
    BURNER, RECIPIENT, FACILITATOR, AMOUNT_USDC, BLOCKHASH, MEMO_FIXED
);

check('Tx starts with shortvec(2) for two signature slots', () => {
    const { value, length } = readShortvec(txBuffer, 0);
    assert.strictEqual(value, 2, 'sigCount must be 2 (facilitator + burner)');
    assert.strictEqual(length, 1, 'sigCount encodes as single byte for value=2');
});

check('Both signature slots are 64 zero bytes (empty, pre-sign)', () => {
    // shortvec is 1 byte; signatures start at offset 1
    const slot0 = txBuffer.subarray(1, 65);
    const slot1 = txBuffer.subarray(65, 129);
    assert.ok(slot0.every(b => b === 0), 'slot 0 (facilitator) must be empty');
    assert.ok(slot1.every(b => b === 0), 'slot 1 (burner) must be empty until signed');
});

check('Message version byte is 0x80 (v0 versioned tx)', () => {
    // After shortvec(1 byte) + 2*64 sigs, message starts at offset 129
    assert.strictEqual(txBuffer[129], 0x80, 'v0 marker missing');
});

check('Message header is [2, 1, 4] (numSig, numReadonlySig, numReadonlyUnsigned)', () => {
    // Right after version byte
    assert.strictEqual(txBuffer[130], 2, 'numRequiredSignatures');
    assert.strictEqual(txBuffer[131], 1, 'numReadonlySigned (burner is readonly-signer)');
    assert.strictEqual(txBuffer[132], 4, 'numReadonlyUnsigned (mint + 3 programs)');
});

check('Account-keys section: 8 accounts in spec-required order', () => {
    // Offset 133: shortvec(accountKeys.length) then 32*8 bytes
    const { value: count, length: cntLen } = readShortvec(txBuffer, 133);
    assert.strictEqual(count, 8, 'must have 8 account keys');
    const keysStart = 133 + cntLen;
    const expectedKeys = [
        _decodeSolanaPubkey(FACILITATOR),
        _decodeSolanaPubkey(BURNER),
        // ATAs are PDAs we'd have to recompute to assert; instead validate
        // by paymentMeta below.
        null, null,
        _decodeSolanaPubkey(USDC_MINT),
        _decodeSolanaPubkey(COMPUTE_BUDGET_PROGRAM_ID),
        _decodeSolanaPubkey(TOKEN_PROGRAM_ID),
        _decodeSolanaPubkey(MEMO_PROGRAM_ID),
    ];
    for (let i = 0; i < 8; i++) {
        const got = txBuffer.subarray(keysStart + i * 32, keysStart + (i + 1) * 32);
        if (expectedKeys[i] !== null) {
            assert.ok(got.equals(expectedKeys[i]), `account[${i}] mismatch`);
        }
    }
});

check('paymentMeta carries x402Version=2 and burnerSigSlot=1', () => {
    assert.strictEqual(paymentMeta.x402Version, 2);
    assert.strictEqual(paymentMeta.burnerSigSlot, 1, 'burner signs slot 1, not slot 0');
    assert.strictEqual(paymentMeta.facilitator, FACILITATOR);
    assert.strictEqual(paymentMeta.amountAtomic, AMOUNT_USDC);
    assert.strictEqual(paymentMeta.memo, MEMO_FIXED);
});

check('paymentMeta carries cuLimit + cuPriceMicroLamports defaults', () => {
    assert.strictEqual(paymentMeta.cuLimit, 50_000);
    assert.strictEqual(paymentMeta.cuPriceMicroLamports, '1000');
});

// ── Instruction count + order ───────────────────────────────────────────

check('Tx contains exactly 4 instructions in spec order', () => {
    // Walk: shortvec(sigCount) + sigs + version + header + shortvec(keysCount)
    // + 32*keysCount + 32 (blockhash) + shortvec(ixCount)
    let pos = 0;
    const sc = readShortvec(txBuffer, pos); pos += sc.length + sc.value * 64;
    pos += 1; // version
    pos += 3; // header
    const kc = readShortvec(txBuffer, pos); pos += kc.length + kc.value * 32;
    pos += 32; // blockhash
    const ic = readShortvec(txBuffer, pos);
    assert.strictEqual(ic.value, 4, 'must have exactly 4 instructions');
    pos += ic.length;
    // First two are ComputeBudget (programIdIndex=5)
    assert.strictEqual(txBuffer[pos], 5, 'ix[0] (cu-limit) programId = ComputeBudget (5)');
    // Skip ix[0]: programIdIx(1) + shortvec(accounts=0)(1) + shortvec(data=5)(1) + 5
    pos += 1 + 1 + 1 + 5;
    assert.strictEqual(txBuffer[pos], 5, 'ix[1] (cu-price) programId = ComputeBudget (5)');
    // Skip ix[1]: programIdIx(1) + shortvec(0)(1) + shortvec(9)(1) + 9
    pos += 1 + 1 + 1 + 9;
    assert.strictEqual(txBuffer[pos], 6, 'ix[2] (transferChecked) programId = Token (6)');
    // Skip ix[2]: programIdIx(1) + shortvec(4)(1) + 4 + shortvec(10)(1) + 10
    pos += 1 + 1 + 4 + 1 + 10;
    assert.strictEqual(txBuffer[pos], 7, 'ix[3] (memo) programId = Memo (7)');
});

// ── ALT section ─────────────────────────────────────────────────────────

check('Tx ends with empty address-lookup-tables section (compact-u16(0))', () => {
    assert.strictEqual(txBuffer[txBuffer.length - 1], 0, 'last byte must be ALT count = 0');
});

console.log('');
if (failures > 0) {
    console.log(`✗ ${failures} test(s) failed`);
    process.exit(1);
}
console.log('✓ All x402 v2 tx builder tests passed.');
