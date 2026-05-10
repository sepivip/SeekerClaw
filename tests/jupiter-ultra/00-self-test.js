// tests/jupiter-ultra/00-self-test.js
//
// Self-test for the local sign + base58 helpers. NO network. Catches
// wire-format / Ed25519 bugs before we burn real SOL on Layer 3+.
//
// Run: node tests/jupiter-ultra/00-self-test.js

'use strict';

const crypto = require('crypto');
const { signSolanaTx, isSigned, readCompactU16 } = require('./lib/sign-tx');
const base58 = require('./lib/base58');

let failures = 0;
function assert(cond, msg) {
    if (cond) { console.log(`  ✓ ${msg}`); }
    else { console.log(`  ✗ ${msg}`); failures++; }
}

console.log('═══ Self-tests ═══');
console.log('');

// 1. base58 round-trip
console.log('[1] base58 encode/decode round-trip');
for (const hex of ['00', '0001', 'deadbeef', '00ff00ff', 'ff'.repeat(32)]) {
    const buf = Buffer.from(hex, 'hex');
    const enc = base58.encode(buf);
    const dec = base58.decode(enc);
    assert(dec.equals(buf), `${hex} → ${enc} → ${dec.toString('hex')}`);
}
// Known Solana System Program ID (32 zero bytes)
const sysProgram = '11111111111111111111111111111111';
const sysBytes = base58.decode(sysProgram);
assert(sysBytes.length === 32 && sysBytes.every(b => b === 0), 'System Program ID decodes to 32 zero bytes');

// 2. compact-u16 decode
console.log('');
console.log('[2] compact-u16 decode');
const cases = [
    [Buffer.from([0x00]), 0, 1],
    [Buffer.from([0x01]), 1, 1],
    [Buffer.from([0x7f]), 127, 1],
    [Buffer.from([0x80, 0x01]), 128, 2],
    [Buffer.from([0xff, 0x7f]), 16383, 2],
];
for (const [buf, expectedValue, expectedLen] of cases) {
    const r = readCompactU16(buf, 0);
    assert(r.value === expectedValue && r.length === expectedLen,
        `[${buf.toString('hex')}] → value=${r.value}, length=${r.length} (expected ${expectedValue}/${expectedLen})`);
}

// 3. sign + verify round-trip on a synthetic tx
console.log('');
console.log('[3] Ed25519 sign + verify round-trip on synthetic tx');
const { generateKeyPairSync } = crypto;
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const secret = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
const pub    = Buffer.from(publicKey.export({  format: 'jwk' }).x, 'base64url');

// Build a fake tx: sigCount=1, 64 zero bytes for sig slot, "hello world" as message
const fakeTx = Buffer.concat([
    Buffer.from([0x01]),           // sigCount = 1
    Buffer.alloc(64),              // empty signature slot
    Buffer.from('hello world'),    // message
]);
const fakeTxB64 = fakeTx.toString('base64');

assert(!isSigned(fakeTxB64), 'unsigned tx detected as unsigned');

const signedB64 = signSolanaTx(fakeTxB64, secret, pub);
const signedBuf = Buffer.from(signedB64, 'base64');

assert(isSigned(signedB64), 'after signing, tx detected as signed');
assert(signedBuf.length === fakeTx.length, 'signed tx has same length as unsigned');
assert(signedBuf.subarray(65).equals(Buffer.from('hello world')), 'message bytes preserved exactly');

const sig = signedBuf.subarray(1, 65);
const verified = crypto.verify(null, Buffer.from('hello world'), publicKey, sig);
assert(verified, 'signature verifies against public key for "hello world"');

// 4. v0 transaction (version byte 0x80) — must be part of the message, not skipped
console.log('');
console.log('[4] v0 transaction handling (version byte preserved as message[0])');
const v0Tx = Buffer.concat([
    Buffer.from([0x01]),           // sigCount = 1
    Buffer.alloc(64),              // sig slot
    Buffer.from([0x80]),           // v0 version byte (high bit set)
    Buffer.from('messagebody'),
]);
const v0Signed = signSolanaTx(v0Tx.toString('base64'), secret, pub);
const v0SignedBuf = Buffer.from(v0Signed, 'base64');
const expectedV0Msg = Buffer.concat([Buffer.from([0x80]), Buffer.from('messagebody')]);
const v0Sig = v0SignedBuf.subarray(1, 65);
const v0Verified = crypto.verify(null, expectedV0Msg, publicKey, v0Sig);
assert(v0Verified, 'v0 tx signature verifies — version byte is part of signed message');

// 5. base58 pubkey from secret matches generated public
console.log('');
console.log('[5] base58 pubkey derivation');
const encoded = base58.encode(pub);
const decoded = base58.decode(encoded);
assert(decoded.equals(pub), `pubkey ${encoded} round-trips`);

console.log('');
if (failures > 0) {
    console.log(`✗ ${failures} test(s) failed`);
    process.exit(1);
}
console.log('═══ ALL SELF-TESTS PASSED ═══');
console.log('');
console.log('Safe to run Layer 1+. Note: Layer 1 only needs JUPITER_API_KEY +');
console.log('BURNER_PUBKEY in .env.test (no signing happens).');
