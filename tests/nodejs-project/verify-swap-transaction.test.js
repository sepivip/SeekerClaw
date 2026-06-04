#!/usr/bin/env node
// tests/nodejs-project/verify-swap-transaction.test.js
//
// Unit tests for solana.js verifySwapTransaction (PR #397 R3): proves the
// security-sensitive parsing/validation logic actually fails closed on
// malformed/truncated transactions. Copilot R3 explicitly flagged the
// absence of these tests as a quality blocker.
//
// Hand-rolled binary tx builder (no @solana/web3.js, mirrors the parser).

'use strict';

const assert = require('assert');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');

// Mock config/http/bridge before loading solana.js (which requires them at
// module top level). Same pattern as tools-solana-routing.test.js.
const configPath = require.resolve(path.join(BUNDLE, 'config.js'));
require.cache[configPath] = {
    id: configPath, filename: configPath, loaded: true,
    exports: {
        config: { jupiterApiKey: 'test-key' },
        log: () => {},
        workDir: '/tmp/seekerclaw-test',
    },
};
const httpPath = require.resolve(path.join(BUNDLE, 'http.js'));
require.cache[httpPath] = {
    id: httpPath, filename: httpPath, loaded: true,
    exports: { httpRequest: async () => ({ status: 404 }) },
};
const bridgePath = require.resolve(path.join(BUNDLE, 'bridge.js'));
require.cache[bridgePath] = {
    id: bridgePath, filename: bridgePath, loaded: true,
    exports: { androidBridgeCall: async () => ({}) },
};

const { verifySwapTransaction, base58Encode } = require(path.join(BUNDLE, 'solana.js'));

function compactU16(value) {
    const bytes = [];
    let v = value;
    while (true) {
        if (v < 0x80) { bytes.push(v); break; }
        bytes.push((v & 0x7F) | 0x80);
        v >>>= 7;
    }
    return Buffer.from(bytes);
}

// Build a 32-byte synthetic pubkey for tests from an arbitrary ASCII label.
// The label is NOT base58 — we just need unique 32-byte slabs whose
// base58Encode() output is deterministic and comparable. Renamed parameter
// from `base58` to `label` (Copilot PR #397 R8 doc-clarity nit) so the
// helper's purpose is self-evident when debugging.
function pubkeyBytes(label) {
    const buf = Buffer.alloc(32);
    Buffer.from(label).copy(buf);
    return buf;
}

const SIG_BYTES = Buffer.alloc(64);
const BLOCKHASH = Buffer.alloc(32);

// Build a legacy tx: 1 sig + header(3) + numAccounts + accountKeys[] + blockhash + numInstructions + ...
function buildLegacyTx({ accountKeys, instructions = [] }) {
    const parts = [];
    parts.push(compactU16(1)); // 1 signature
    parts.push(SIG_BYTES);
    parts.push(Buffer.from([1, 0, 0])); // numRequired, numReadonlySigned, numReadonlyUnsigned
    parts.push(compactU16(accountKeys.length));
    for (const k of accountKeys) parts.push(pubkeyBytes(k));
    parts.push(BLOCKHASH);
    parts.push(compactU16(instructions.length));
    for (const ix of instructions) {
        parts.push(Buffer.from([ix.programIdIdx]));
        parts.push(compactU16(ix.accountIdxs.length));
        parts.push(Buffer.from(ix.accountIdxs));
        parts.push(compactU16(ix.data.length));
        parts.push(ix.data);
    }
    return Buffer.concat(parts).toString('base64');
}

// Build a v0 tx: 1 sig + 0x80 prefix + header(3) + numStaticAccounts + accountKeys[] + blockhash + numInstructions + ... + numAlts
function buildV0Tx({ accountKeys, instructions = [], alts = [] }) {
    const parts = [];
    parts.push(compactU16(1));
    parts.push(SIG_BYTES);
    parts.push(Buffer.from([0x80])); // v0 prefix
    parts.push(Buffer.from([1, 0, 0]));
    parts.push(compactU16(accountKeys.length));
    for (const k of accountKeys) parts.push(pubkeyBytes(k));
    parts.push(BLOCKHASH);
    parts.push(compactU16(instructions.length));
    for (const ix of instructions) {
        parts.push(Buffer.from([ix.programIdIdx]));
        parts.push(compactU16(ix.accountIdxs.length));
        parts.push(Buffer.from(ix.accountIdxs));
        parts.push(compactU16(ix.data.length));
        parts.push(ix.data);
    }
    parts.push(compactU16(alts.length));
    for (const alt of alts) {
        parts.push(pubkeyBytes(alt.address));
        parts.push(compactU16(alt.writable.length));
        parts.push(Buffer.from(alt.writable));
        parts.push(compactU16(alt.readonly.length));
        parts.push(Buffer.from(alt.readonly));
    }
    return Buffer.concat(parts).toString('base64');
}

const PAYER = 'PayerXXXXXXXXXXXXXXXXXXXXXXXXXX';
const PROGRAM = 'ProgXXXXXXXXXXXXXXXXXXXXXXXXXXX';

let pass = 0, fail = 0;
function test(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); }
}

console.log('verify-swap-transaction.test.js — fail-closed structural verification (R3)');

test('happy path: legacy tx with valid structure returns valid:true', () => {
    const txB64 = buildLegacyTx({
        accountKeys: [PAYER, PROGRAM],
        instructions: [{ programIdIdx: 1, accountIdxs: [0], data: Buffer.from([0xAB]) }],
    });
    const r = verifySwapTransaction(txB64, base58Encode(pubkeyBytes(PAYER)));
    assert.strictEqual(r.valid, true, `expected valid, got ${JSON.stringify(r)}`);
});

test('happy path: v0 tx with valid structure returns valid:true', () => {
    const txB64 = buildV0Tx({
        accountKeys: [PAYER, PROGRAM],
        instructions: [{ programIdIdx: 1, accountIdxs: [0], data: Buffer.from([0xAB]) }],
    });
    const r = verifySwapTransaction(txB64, base58Encode(pubkeyBytes(PAYER)));
    assert.strictEqual(r.valid, true, `expected valid, got ${JSON.stringify(r)}`);
});

test('fails closed: tx with zero account keys (legacy)', () => {
    const txB64 = buildLegacyTx({ accountKeys: [] });
    const r = verifySwapTransaction(txB64, base58Encode(pubkeyBytes(PAYER)));
    assert.strictEqual(r.valid, false);
    assert.match(r.error, /no account keys/i);
});

test('fails closed: legacy tx with declared accounts exceeding buffer', () => {
    // Build a header that claims 1000 accounts but the buffer ends after 2 keys.
    const parts = [];
    parts.push(compactU16(1));
    parts.push(SIG_BYTES);
    parts.push(Buffer.from([1, 0, 0]));
    parts.push(compactU16(1000)); // huge count
    parts.push(pubkeyBytes(PAYER));
    parts.push(pubkeyBytes(PROGRAM));
    // Stop here — should be 1000*32 bytes, only have 64.
    const txB64 = Buffer.concat(parts).toString('base64');
    const r = verifySwapTransaction(txB64, base58Encode(pubkeyBytes(PAYER)));
    assert.strictEqual(r.valid, false);
    assert.match(r.error, /account keys exceeds remaining buffer/i);
});

test('fails closed: v0 tx with declared static accounts exceeding buffer', () => {
    const parts = [];
    parts.push(compactU16(1));
    parts.push(SIG_BYTES);
    parts.push(Buffer.from([0x80])); // v0
    parts.push(Buffer.from([1, 0, 0]));
    parts.push(compactU16(1000)); // huge
    parts.push(pubkeyBytes(PAYER));
    const txB64 = Buffer.concat(parts).toString('base64');
    const r = verifySwapTransaction(txB64, base58Encode(pubkeyBytes(PAYER)));
    assert.strictEqual(r.valid, false);
    assert.match(r.error, /static account keys exceeds remaining buffer/i);
});

test('fails closed: legacy tx truncated after account keys (blockhash missing)', () => {
    const parts = [];
    parts.push(compactU16(1));
    parts.push(SIG_BYTES);
    parts.push(Buffer.from([1, 0, 0]));
    parts.push(compactU16(1));
    parts.push(pubkeyBytes(PAYER));
    // Truncated — no blockhash.
    const txB64 = Buffer.concat(parts).toString('base64');
    const r = verifySwapTransaction(txB64, base58Encode(pubkeyBytes(PAYER)));
    assert.strictEqual(r.valid, false);
    assert.match(r.error, /blockhash truncated/i);
});

test('fails closed: v0 tx truncated after account keys (blockhash missing)', () => {
    const parts = [];
    parts.push(compactU16(1));
    parts.push(SIG_BYTES);
    parts.push(Buffer.from([0x80]));
    parts.push(Buffer.from([1, 0, 0]));
    parts.push(compactU16(1));
    parts.push(pubkeyBytes(PAYER));
    const txB64 = Buffer.concat(parts).toString('base64');
    const r = verifySwapTransaction(txB64, base58Encode(pubkeyBytes(PAYER)));
    assert.strictEqual(r.valid, false);
    assert.match(r.error, /blockhash truncated/i);
});

test('fails closed: legacy tx truncated after blockhash (instruction count missing)', () => {
    const parts = [];
    parts.push(compactU16(1));
    parts.push(SIG_BYTES);
    parts.push(Buffer.from([1, 0, 0]));
    parts.push(compactU16(1));
    parts.push(pubkeyBytes(PAYER));
    parts.push(BLOCKHASH);
    // Tx ends at end of blockhash — no instruction count byte.
    const txB64 = Buffer.concat(parts).toString('base64');
    const r = verifySwapTransaction(txB64, base58Encode(pubkeyBytes(PAYER)));
    assert.strictEqual(r.valid, false);
    assert.match(r.error, /instruction count truncated/i);
});

test('fails closed: v0 tx truncated after blockhash (instruction count missing)', () => {
    const parts = [];
    parts.push(compactU16(1));
    parts.push(SIG_BYTES);
    parts.push(Buffer.from([0x80]));
    parts.push(Buffer.from([1, 0, 0]));
    parts.push(compactU16(1));
    parts.push(pubkeyBytes(PAYER));
    parts.push(BLOCKHASH);
    const txB64 = Buffer.concat(parts).toString('base64');
    const r = verifySwapTransaction(txB64, base58Encode(pubkeyBytes(PAYER)));
    assert.strictEqual(r.valid, false);
    assert.match(r.error, /instruction count truncated/i);
});

test('fails closed: v0 tx with ALT-resolved programIdIdx exceeding total keys', () => {
    // 1 static account, no ALTs declared, but instruction uses programIdIdx=5 which
    // claims ALT resolution but has nothing to resolve from.
    const parts = [];
    parts.push(compactU16(1));
    parts.push(SIG_BYTES);
    parts.push(Buffer.from([0x80]));
    parts.push(Buffer.from([1, 0, 0]));
    parts.push(compactU16(1)); // 1 static account
    parts.push(pubkeyBytes(PAYER));
    parts.push(BLOCKHASH);
    parts.push(compactU16(1)); // 1 instruction
    parts.push(Buffer.from([5])); // programIdIdx=5 (>= 1 static, would need 5 ALT keys)
    parts.push(compactU16(0)); // 0 account indexes
    parts.push(compactU16(0)); // 0 data bytes
    parts.push(compactU16(0)); // 0 ALTs declared
    const txB64 = Buffer.concat(parts).toString('base64');
    const r = verifySwapTransaction(txB64, base58Encode(pubkeyBytes(PAYER)));
    assert.strictEqual(r.valid, false);
    assert.match(r.error, /exceeds static\+ALT key count/i);
});

test('fails closed: v0 ALT key-count exceeds remaining buffer', () => {
    // Declare numWritable=1000 but no index bytes after.
    const parts = [];
    parts.push(compactU16(1));
    parts.push(SIG_BYTES);
    parts.push(Buffer.from([0x80]));
    parts.push(Buffer.from([1, 0, 0]));
    parts.push(compactU16(1));
    parts.push(pubkeyBytes(PAYER));
    parts.push(BLOCKHASH);
    parts.push(compactU16(0)); // 0 instructions
    parts.push(compactU16(1)); // 1 ALT
    parts.push(pubkeyBytes('AltAddrXX'));
    parts.push(compactU16(1000)); // claimed huge writable count
    // Stop — no actual index bytes.
    const txB64 = Buffer.concat(parts).toString('base64');
    const r = verifySwapTransaction(txB64, base58Encode(pubkeyBytes(PAYER)));
    assert.strictEqual(r.valid, false);
    assert.match(r.error, /writable indexes exceeds remaining buffer/i);
});

test('R4: fails closed on non-string input', () => {
    const r = verifySwapTransaction(null, base58Encode(pubkeyBytes(PAYER)));
    assert.strictEqual(r.valid, false);
    assert.match(r.error, /tx_unparseable/);
});

test('R4: fails closed on empty string', () => {
    const r = verifySwapTransaction('', base58Encode(pubkeyBytes(PAYER)));
    assert.strictEqual(r.valid, false);
    assert.match(r.error, /tx_unparseable/);
});

test('R4: fails closed on invalid base64 characters', () => {
    const r = verifySwapTransaction('***not-base64-at-all***', base58Encode(pubkeyBytes(PAYER)));
    assert.strictEqual(r.valid, false);
    assert.match(r.error, /tx_unparseable.*invalid base64/i);
});

test('R4: fails closed on base64 with wrong length (not divisible by 4)', () => {
    const r = verifySwapTransaction('AAA', base58Encode(pubkeyBytes(PAYER)));
    assert.strictEqual(r.valid, false);
    assert.match(r.error, /tx_unparseable/);
});

test('R4: fails closed on signature bytes truncated (claims 100 sigs, only has 10)', () => {
    const parts = [];
    parts.push(compactU16(100)); // claim 100 signatures
    parts.push(Buffer.alloc(10)); // only have 10 bytes
    const txB64 = Buffer.concat(parts).toString('base64');
    const r = verifySwapTransaction(txB64, base58Encode(pubkeyBytes(PAYER)));
    assert.strictEqual(r.valid, false);
    assert.match(r.error, /Signature bytes truncated/);
});

test('R4: fails closed on legacy tx with mid-varint truncation (instruction count)', () => {
    const parts = [];
    parts.push(compactU16(1));
    parts.push(SIG_BYTES);
    parts.push(Buffer.from([1, 0, 0]));
    parts.push(compactU16(1));
    parts.push(pubkeyBytes(PAYER));
    parts.push(BLOCKHASH);
    parts.push(Buffer.from([0x80])); // continuation byte with no terminator
    const txB64 = Buffer.concat(parts).toString('base64');
    const r = verifySwapTransaction(txB64, base58Encode(pubkeyBytes(PAYER)));
    assert.strictEqual(r.valid, false);
    assert.match(r.error, /truncated mid-varint/);
});

test('R4: fails closed on v0 tx with mid-varint truncation (instruction count)', () => {
    const parts = [];
    parts.push(compactU16(1));
    parts.push(SIG_BYTES);
    parts.push(Buffer.from([0x80]));
    parts.push(Buffer.from([1, 0, 0]));
    parts.push(compactU16(1));
    parts.push(pubkeyBytes(PAYER));
    parts.push(BLOCKHASH);
    parts.push(Buffer.from([0x80])); // continuation byte with no terminator
    const txB64 = Buffer.concat(parts).toString('base64');
    const r = verifySwapTransaction(txB64, base58Encode(pubkeyBytes(PAYER)));
    assert.strictEqual(r.valid, false);
    assert.match(r.error, /truncated mid-varint/);
});

test('R5: fails closed on v0 tx missing ALT section (truncated after last instruction)', () => {
    // Valid v0 tx structure but ends immediately after the last instruction's
    // data — no numAlts byte.
    const parts = [];
    parts.push(compactU16(1));
    parts.push(SIG_BYTES);
    parts.push(Buffer.from([0x80]));
    parts.push(Buffer.from([1, 0, 0]));
    parts.push(compactU16(2));
    parts.push(pubkeyBytes(PAYER));
    parts.push(pubkeyBytes(PROGRAM));
    parts.push(BLOCKHASH);
    parts.push(compactU16(1));
    parts.push(Buffer.from([1])); // programIdIdx=1 (in static range)
    parts.push(compactU16(0)); // 0 account indexes
    parts.push(compactU16(0)); // 0 data bytes
    // STOP — no numAlts byte.
    const txB64 = Buffer.concat(parts).toString('base64');
    const r = verifySwapTransaction(txB64, base58Encode(pubkeyBytes(PAYER)));
    assert.strictEqual(r.valid, false);
    assert.match(r.error, /ALT section truncated/i);
});

test('R5: readCompactU16 rejects 5+ byte varint overflow', () => {
    // A varint encoded with 5 bytes all 0xFF (except last) would overflow
    // into negative 32-bit. Through the verifier, this manifests as a
    // bounds failure (huge value catches in the * 32 check) OR an
    // overflowed signal. Either way: not valid.
    const parts = [];
    parts.push(compactU16(1));
    parts.push(SIG_BYTES);
    parts.push(Buffer.from([0x80]));
    parts.push(Buffer.from([1, 0, 0]));
    // numStaticAccounts as a 5-byte overflowing varint
    parts.push(Buffer.from([0xFF, 0xFF, 0xFF, 0xFF, 0x7F])); // overflow
    const txB64 = Buffer.concat(parts).toString('base64');
    const r = verifySwapTransaction(txB64, base58Encode(pubkeyBytes(PAYER)));
    assert.strictEqual(r.valid, false);
});

test('R6: fails closed on overflowing numSigs varint (5-byte)', () => {
    // numSigs = 5-byte varint overflow. With the R6 sentinel fix, value
    // becomes 0xFFFFFFFF -> 0xFFFFFFFF * 64 bytes required = catastrophically
    // larger than buffer -> reject.
    const parts = [];
    parts.push(Buffer.from([0xFF, 0xFF, 0xFF, 0xFF, 0x7F])); // overflowing numSigs
    parts.push(Buffer.alloc(64)); // some sig bytes
    const txB64 = Buffer.concat(parts).toString('base64');
    const r = verifySwapTransaction(txB64, base58Encode(pubkeyBytes(PAYER)));
    assert.strictEqual(r.valid, false);
});

test('R6: fails closed on legacy per-instruction numAcctIdx mid-varint truncation', () => {
    const parts = [];
    parts.push(compactU16(1));
    parts.push(SIG_BYTES);
    parts.push(Buffer.from([1, 0, 0]));
    parts.push(compactU16(1));
    parts.push(pubkeyBytes(PAYER));
    parts.push(BLOCKHASH);
    parts.push(compactU16(1)); // 1 instruction
    parts.push(Buffer.from([0])); // programIdIdx=0
    parts.push(Buffer.from([0x80])); // numAcctIdx as continuation byte with no terminator
    const txB64 = Buffer.concat(parts).toString('base64');
    const r = verifySwapTransaction(txB64, base58Encode(pubkeyBytes(PAYER)));
    assert.strictEqual(r.valid, false);
});

test('R6: fails closed on v0 ALT numWritable mid-varint truncation', () => {
    const parts = [];
    parts.push(compactU16(1));
    parts.push(SIG_BYTES);
    parts.push(Buffer.from([0x80]));
    parts.push(Buffer.from([1, 0, 0]));
    parts.push(compactU16(1));
    parts.push(pubkeyBytes(PAYER));
    parts.push(BLOCKHASH);
    parts.push(compactU16(0)); // 0 instructions
    parts.push(compactU16(1)); // 1 ALT
    parts.push(pubkeyBytes('AltAddrXX'));
    parts.push(Buffer.from([0x80])); // numWritable as continuation byte (no terminator)
    const txB64 = Buffer.concat(parts).toString('base64');
    const r = verifySwapTransaction(txB64, base58Encode(pubkeyBytes(PAYER)));
    assert.strictEqual(r.valid, false);
});

test('R7: fails closed when tx truncated immediately after signature section', () => {
    // 1 sig + 64 sig bytes + STOP. No prefix byte.
    const parts = [];
    parts.push(compactU16(1));
    parts.push(SIG_BYTES);
    const txB64 = Buffer.concat(parts).toString('base64');
    const r = verifySwapTransaction(txB64, base58Encode(pubkeyBytes(PAYER)));
    assert.strictEqual(r.valid, false);
    assert.match(r.error, /Message section truncated/);
});

test('R7: fails closed on legacy tx truncated mid-3-byte-header', () => {
    const parts = [];
    parts.push(compactU16(1));
    parts.push(SIG_BYTES);
    parts.push(Buffer.from([1, 0])); // only 2 of 3 header bytes (no v0 prefix → legacy path)
    const txB64 = Buffer.concat(parts).toString('base64');
    const r = verifySwapTransaction(txB64, base58Encode(pubkeyBytes(PAYER)));
    assert.strictEqual(r.valid, false);
    assert.match(r.error, /Legacy: 3-byte message header truncated/);
});

test('R7: fails closed on v0 tx truncated mid-3-byte-header', () => {
    const parts = [];
    parts.push(compactU16(1));
    parts.push(SIG_BYTES);
    parts.push(Buffer.from([0x80])); // v0 prefix
    parts.push(Buffer.from([1, 0])); // only 2 of 3 header bytes
    const txB64 = Buffer.concat(parts).toString('base64');
    const r = verifySwapTransaction(txB64, base58Encode(pubkeyBytes(PAYER)));
    assert.strictEqual(r.valid, false);
    assert.match(r.error, /v0: 3-byte message header truncated/);
});

test('R7: skipPayerCheck=true accepts v0 tx where payer is a required signer (Ultra)', () => {
    const txB64 = buildV0Tx({
        accountKeys: [PAYER, PROGRAM],
        instructions: [{ programIdIdx: 1, accountIdxs: [0], data: Buffer.from([0xAB]) }],
    });
    const r = verifySwapTransaction(txB64, base58Encode(pubkeyBytes(PAYER)), { skipPayerCheck: true });
    assert.strictEqual(r.valid, true, `expected valid, got ${JSON.stringify(r)}`);
});

test('R7: skipPayerCheck=true rejects v0 tx where expected payer is NOT among required signers', () => {
    const txB64 = buildV0Tx({
        accountKeys: [PAYER, PROGRAM],
        instructions: [{ programIdIdx: 1, accountIdxs: [0], data: Buffer.from([0xAB]) }],
    });
    const wrongSigner = base58Encode(pubkeyBytes('NotASignerXXX'));
    const r = verifySwapTransaction(txB64, wrongSigner, { skipPayerCheck: true });
    assert.strictEqual(r.valid, false);
    assert.match(r.error, /Signer mismatch/);
});

test('R7: skipPayerCheck=true rejects legacy tx (Ultra requires v0)', () => {
    const txB64 = buildLegacyTx({
        accountKeys: [PAYER, PROGRAM],
        instructions: [{ programIdIdx: 1, accountIdxs: [0], data: Buffer.from([0xAB]) }],
    });
    const r = verifySwapTransaction(txB64, base58Encode(pubkeyBytes(PAYER)), { skipPayerCheck: true });
    assert.strictEqual(r.valid, false);
    assert.match(r.error, /Expected v0 transaction for Ultra/);
});

test('fails closed: fee payer mismatch on legacy tx', () => {
    const txB64 = buildLegacyTx({
        accountKeys: [PAYER, PROGRAM],
        instructions: [{ programIdIdx: 1, accountIdxs: [0], data: Buffer.from([0xAB]) }],
    });
    const wrongPayer = base58Encode(pubkeyBytes('WrongPayerXX'));
    const r = verifySwapTransaction(txB64, wrongPayer);
    assert.strictEqual(r.valid, false);
    assert.match(r.error, /Fee payer mismatch/);
});

console.log();
console.log(`Result: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('PASS: verify-swap-transaction.test.js');
