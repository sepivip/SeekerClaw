// tests/nodejs-project/tx-parser.test.js
//
// Tests for wallet/tx-parser.js (BAT-1013 Phase 2). Covers Codex review v1.1
// amendment #1: "If Claude creates a reusable parser helper, add focused
// tests around legacy + v0 + malformed bytes."

'use strict';

const assert = require('assert');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
const {
    TxParseError,
    parseTransaction,
    readCompactU16,
    base58Encode,
    base58Decode,
} = require(path.join(BUNDLE, 'wallet', 'tx-parser.js'));

// ─── Fixture builders ──────────────────────────────────────────────────────

function compactU16(value) {
    // Encode an unsigned integer (0..65535) into Solana's compact-u16 wire form.
    if (value < 0 || value > 0xFFFF) throw new Error(`out of range: ${value}`);
    const bytes = [];
    let v = value;
    while (true) {
        if (v < 0x80) { bytes.push(v); break; }
        bytes.push((v & 0x7F) | 0x80);
        v >>>= 7;
    }
    return Buffer.from(bytes);
}

function fakePubkey(seed) {
    // 32-byte buffer with first byte = seed, rest zero. Distinct, deterministic.
    const b = Buffer.alloc(32);
    b[0] = seed & 0xFF;
    return b;
}

/**
 * Build a minimal LEGACY tx (no instructions, one account = fee payer).
 * Structure: [sig_count=1] [sig:64 zero bytes] [header:3] [keys_count=1]
 *            [pubkey:32] [blockhash:32] [instr_count=0]
 */
function buildLegacyTxMinimal({ feePayer = fakePubkey(1), blockhash = fakePubkey(99) } = {}) {
    return Buffer.concat([
        compactU16(1),                  // 1 signature
        Buffer.alloc(64),               // sig slot (empty)
        Buffer.from([1, 0, 0]),         // header: numRequired=1, numReadonlySigned=0, numReadonlyUnsigned=0
        compactU16(1),                  // 1 account key
        feePayer,                       // fee payer (32 bytes)
        blockhash,                      // recent blockhash (32 bytes)
        compactU16(0),                  // 0 instructions
    ]);
}

/**
 * Build a minimal V0 tx (no instructions, no ALTs, one account).
 */
function buildV0TxMinimal({ feePayer = fakePubkey(1), blockhash = fakePubkey(99) } = {}) {
    return Buffer.concat([
        compactU16(1),                  // 1 signature
        Buffer.alloc(64),               // sig slot
        Buffer.from([0x80]),            // v0 prefix
        Buffer.from([1, 0, 0]),         // header
        compactU16(1),                  // 1 static account
        feePayer,
        blockhash,
        compactU16(0),                  // 0 instructions
        compactU16(0),                  // 0 ALT lookups
    ]);
}

/**
 * Build a V0 tx with one instruction (Token Program transfer-shaped, no real semantics)
 * and one ALT lookup.
 */
function buildV0TxWithInstrAndAlt() {
    const feePayer = fakePubkey(1);
    const tokenProg = fakePubkey(2);
    const altTable = fakePubkey(99);
    const blockhash = fakePubkey(50);
    const instrData = Buffer.from([0x03, 0xAA, 0xBB]); // Transfer discriminator + payload
    return Buffer.concat([
        compactU16(1),
        Buffer.alloc(64),
        Buffer.from([0x80]),
        Buffer.from([1, 0, 1]),         // numRequired=1, numReadonlySigned=0, numReadonlyUnsigned=1
        compactU16(2),
        feePayer,
        tokenProg,
        blockhash,
        compactU16(1),                  // 1 instruction
        Buffer.from([1]),               // programIdIdx = 1 (tokenProg)
        compactU16(2),                  // 2 account refs
        Buffer.from([0, 1]),            // accountIdxs
        compactU16(instrData.length),
        instrData,
        compactU16(1),                  // 1 ALT lookup
        altTable,
        compactU16(2),                  // 2 writable indexes
        Buffer.from([5, 7]),
        compactU16(1),                  // 1 readonly index
        Buffer.from([3]),
    ]);
}

// ─── Test cases ────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;

function check(name, fn) {
    try {
        fn();
        pass++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        fail++;
        console.error(`  ✗ ${name}: ${e.message}`);
        console.error(e.stack.split('\n').slice(1, 4).join('\n'));
    }
}

console.log('tx-parser.test.js — wallet/tx-parser.js contract');
console.log();

console.log('readCompactU16');
check('reads single-byte value (0)', () => {
    const r = readCompactU16(Buffer.from([0x00]), 0);
    assert.strictEqual(r.value, 0);
    assert.strictEqual(r.offset, 1);
});
check('reads single-byte value (127)', () => {
    const r = readCompactU16(Buffer.from([0x7F]), 0);
    assert.strictEqual(r.value, 127);
});
check('reads two-byte value (128)', () => {
    const r = readCompactU16(Buffer.from([0x80, 0x01]), 0);
    assert.strictEqual(r.value, 128);
    assert.strictEqual(r.offset, 2);
});
check('reads two-byte value (16383)', () => {
    const r = readCompactU16(Buffer.from([0xFF, 0x7F]), 0);
    assert.strictEqual(r.value, 16383);
});
check('throws on overflow (>3 continuation bytes)', () => {
    assert.throws(() => readCompactU16(Buffer.from([0x80, 0x80, 0x80, 0x80]), 0), TxParseError);
});
check('throws on truncated', () => {
    assert.throws(() => readCompactU16(Buffer.from([0x80]), 0), TxParseError);
});

console.log();
console.log('base58 roundtrip');
check('roundtrips 32 random bytes', () => {
    const bytes = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) bytes[i] = (i * 13 + 7) & 0xFF;
    const encoded = base58Encode(bytes);
    const decoded = base58Decode(encoded);
    assert.deepStrictEqual(decoded, bytes);
});
check('handles all-zero pubkey (System Program)', () => {
    const bytes = Buffer.alloc(32);
    const encoded = base58Encode(bytes);
    assert.strictEqual(encoded, '11111111111111111111111111111111');
    const decoded = base58Decode(encoded);
    assert.deepStrictEqual(decoded, bytes);
});
check('throws on invalid base58 chars', () => {
    assert.throws(() => base58Decode('invalid!chars'), TxParseError);
});

console.log();
console.log('parseTransaction: legacy');
check('parses minimal legacy tx', () => {
    const txBase64 = buildLegacyTxMinimal().toString('base64');
    const parsed = parseTransaction(txBase64);
    assert.strictEqual(parsed.kind, 'legacy');
    assert.strictEqual(parsed.numRequiredSignatures, 1);
    assert.strictEqual(parsed.numReadonlySigned, 0);
    assert.strictEqual(parsed.numReadonlyUnsigned, 0);
    assert.strictEqual(parsed.staticAccountKeys.length, 1);
    assert.strictEqual(parsed.instructions.length, 0);
    assert.strictEqual(parsed.altLookups, null);
    assert.ok(parsed.recentBlockhash, 'recent blockhash present');
});

console.log();
console.log('parseTransaction: v0');
check('parses minimal v0 tx (no ALTs)', () => {
    const txBase64 = buildV0TxMinimal().toString('base64');
    const parsed = parseTransaction(txBase64);
    assert.strictEqual(parsed.kind, 'v0');
    assert.strictEqual(parsed.numRequiredSignatures, 1);
    assert.strictEqual(parsed.staticAccountKeys.length, 1);
    assert.strictEqual(parsed.instructions.length, 0);
    assert.deepStrictEqual(parsed.altLookups, []);
});
check('parses v0 tx with instruction and ALT', () => {
    const txBase64 = buildV0TxWithInstrAndAlt().toString('base64');
    const parsed = parseTransaction(txBase64);
    assert.strictEqual(parsed.kind, 'v0');
    assert.strictEqual(parsed.staticAccountKeys.length, 2);
    assert.strictEqual(parsed.instructions.length, 1);
    const instr = parsed.instructions[0];
    assert.strictEqual(instr.programIdIdx, 1);
    assert.deepStrictEqual(instr.accountIdxs, [0, 1]);
    assert.deepStrictEqual(Array.from(instr.dataBytes), [0x03, 0xAA, 0xBB]);
    assert.strictEqual(parsed.altLookups.length, 1);
    assert.deepStrictEqual(parsed.altLookups[0].writableIndexes, [5, 7]);
    assert.deepStrictEqual(parsed.altLookups[0].readonlyIndexes, [3]);
});

console.log();
console.log('parseTransaction: malformed');
check('throws on empty string', () => {
    assert.throws(() => parseTransaction(''), TxParseError);
});
check('throws on non-string', () => {
    assert.throws(() => parseTransaction(null), TxParseError);
    assert.throws(() => parseTransaction(undefined), TxParseError);
    assert.throws(() => parseTransaction(123), TxParseError);
});
check('throws on truncated buffer (mid-signature)', () => {
    // Claim 1 signature but provide only 30 bytes of it.
    const buf = Buffer.concat([compactU16(1), Buffer.alloc(30)]);
    assert.throws(() => parseTransaction(buf.toString('base64')), TxParseError);
});
check('throws on truncated buffer (mid-account-key)', () => {
    const buf = Buffer.concat([
        compactU16(1), Buffer.alloc(64),
        Buffer.from([1, 0, 0]),
        compactU16(1),
        Buffer.alloc(20),               // truncated — should be 32
    ]);
    assert.throws(() => parseTransaction(buf.toString('base64')), TxParseError);
});
check('throws on truncated v0 ALT section', () => {
    const buf = Buffer.concat([
        compactU16(1), Buffer.alloc(64),
        Buffer.from([0x80]),
        Buffer.from([1, 0, 0]),
        compactU16(1),
        Buffer.alloc(32),               // 1 static key
        Buffer.alloc(32),               // blockhash
        compactU16(0),                  // 0 instructions
        compactU16(1),                  // claim 1 ALT lookup ...
        Buffer.alloc(10),               // ... but truncate it
    ]);
    assert.throws(() => parseTransaction(buf.toString('base64')), TxParseError);
});

// ── Copilot PR #397 R12 regression: future versioned messages ────────────
// Solana versioned-message prefix has the high bit set (0x80) with the
// lower 7 bits encoding the version. Today only v0 exists. A future v1
// would have prefix 0x81. The strict `=== 0x80` check would silently fall
// into the legacy parsing path; the bitmask check + version-guard rejects
// the unsupported version explicitly.
console.log();
console.log('parseTransaction: future versioned (R12)');
check('throws unsupported_tx_version on v1 prefix (0x81)', () => {
    const buf = Buffer.concat([
        compactU16(1), Buffer.alloc(64),
        Buffer.from([0x81]),            // v1 prefix (high bit set + version=1)
        Buffer.from([1, 0, 0]),
        compactU16(1),
        Buffer.alloc(32),
        Buffer.alloc(32),
        compactU16(0),
        compactU16(0),
    ]);
    try {
        parseTransaction(buf.toString('base64'));
        assert.fail('expected throw on v1 prefix');
    } catch (e) {
        assert.ok(e instanceof TxParseError, `expected TxParseError, got ${e.constructor.name}`);
        assert.strictEqual(e.reason, 'unsupported_tx_version');
        assert.match(e.message, /v1/);
    }
});
check('throws unsupported_tx_version on v2 prefix (0x82)', () => {
    const buf = Buffer.concat([
        compactU16(1), Buffer.alloc(64),
        Buffer.from([0x82]),
        Buffer.from([1, 0, 0]),
        compactU16(1), Buffer.alloc(32), Buffer.alloc(32),
        compactU16(0), compactU16(0),
    ]);
    try { parseTransaction(buf.toString('base64')); assert.fail(); }
    catch (e) {
        assert.strictEqual(e.reason, 'unsupported_tx_version');
        assert.match(e.message, /v2/);
    }
});

// ── R-next-6 regression: tx_oversize fail-closed (DoS mitigation) ────────
// parseTransaction must reject base64 inputs longer than ~1644 chars
// (decoded > 1232 bytes = Solana packet cap) BEFORE allocating a buffer.
// Mirrors the same two-stage check in solana.js verifySwapTransaction (R12).
console.log();
console.log('parseTransaction: tx_oversize (R-next-6)');
check('throws tx_oversize on 2000-char base64 (pre-decode estimate)', () => {
    const oversized = 'A'.repeat(2000);
    try { parseTransaction(oversized); assert.fail('expected throw on oversized input'); }
    catch (e) {
        assert.ok(e instanceof TxParseError);
        assert.strictEqual(e.reason, 'tx_oversize');
        assert.match(e.message, /1232/);
    }
});
check('throws tx_oversize on 1644-char unpadded base64 (post-decode path, decodes to 1233 bytes)', () => {
    // 'A'.repeat(1644) passes the pre-decode length check (1644 is not > 1644)
    // but decodes to ceil(1644/4)*3 = 1233 bytes — one byte over the 1232 cap.
    // Tests the post-decode guard in isolation.
    const boundary = 'A'.repeat(1644);
    try { parseTransaction(boundary); assert.fail('expected throw'); }
    catch (e) {
        assert.ok(e instanceof TxParseError);
        assert.strictEqual(e.reason, 'tx_oversize');
    }
});
check('admits 1232-byte tx at exact cap (size guard must NOT over-reject)', () => {
    // A real 1232-byte tx: 1232 % 3 == 2, so it encodes to 1644 chars with
    // one '=' pad. Both size guards must pass; the parser will then fail
    // later on content (random zeros are not a valid tx), which is fine —
    // proves the size guards do not over-reject at the exact cap.
    const exactly1232 = Buffer.alloc(1232).toString('base64');
    assert.strictEqual(exactly1232.length, 1644, 'precondition: 1232 bytes → 1644 chars');
    try { parseTransaction(exactly1232); }
    catch (e) {
        assert.ok(e instanceof TxParseError);
        assert.notStrictEqual(e.reason, 'tx_oversize',
            `size guard must NOT fire on exact 1232-byte tx; got reason=${e.reason}`);
    }
});

console.log();
console.log(`Result: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('PASS: tx-parser.test.js');
