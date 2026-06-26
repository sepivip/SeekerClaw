#!/usr/bin/env node
// tests/nodejs-project/token2022-mint.test.js
//
// BAT-1057: readMintTransferFeeBps — the pre-routing Token-2022 transfer-fee
// detector. Fee-free (classic, or Token-2022 with feeBps 0) → eligible for
// burner conversion; fee-bearing or unparseable → null (route to main, never
// assume fee-free). Layout pinned against real PYUSD mint data (type byte at
// 165, TLV from 166, TransferFeeConfig = type 1, bps at data+88/+106).

'use strict';

const assert = require('assert');
const path = require('path');
const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
const { readMintTransferFeeBps, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require(path.join(BUNDLE, 'wallet', 'token2022-mint.js'));

// Build a Token-2022 extended mint: 165-byte pad + type byte (1=Mint) + TLV exts.
function buildT2022Mint(exts) {
    const head = Buffer.alloc(166);
    head[165] = 1; // Mint account type
    const parts = [head];
    for (const e of exts) {
        const hdr = Buffer.alloc(4);
        hdr.writeUInt16LE(e.type, 0);
        hdr.writeUInt16LE(e.data.length, 2);
        parts.push(hdr, e.data);
    }
    return Buffer.concat(parts).toString('base64');
}
// TransferFeeConfig data (108B): bps at data+88 (older) and data+106 (newer).
function feeConfig(olderBps, newerBps) {
    const d = Buffer.alloc(108);
    d.writeUInt16LE(olderBps, 88);
    d.writeUInt16LE(newerBps, 106);
    return d;
}

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); if (process.env.VERBOSE) console.error(e.stack); }
}

console.log('token2022-mint.test.js — BAT-1057 transfer-fee detection');
console.log();

check('classic SPL owner → fee-free (feeBps 0), no parsing needed', () => {
    assert.deepStrictEqual(readMintTransferFeeBps(TOKEN_PROGRAM_ID, ''), { standard: 'classic', feeBps: 0 });
});

check('unknown owner program → standard=unknown, feeBps=null (→ main)', () => {
    assert.deepStrictEqual(readMintTransferFeeBps('11111111111111111111111111111111', 'AAAA'), { standard: 'unknown', feeBps: null });
});

check('Token-2022 BASE mint (exactly 82 bytes, no extensions) → fee-free', () => {
    const data = Buffer.alloc(82).toString('base64');
    assert.deepStrictEqual(readMintTransferFeeBps(TOKEN_2022_PROGRAM_ID, data), { standard: 'token_2022', feeBps: 0 });
});

check('CodeRabbit #411: malformed Token-2022 mint size (83-165 bytes) → null, not fee-free', () => {
    for (const len of [83, 120, 165]) {
        const data = Buffer.alloc(len).toString('base64');
        assert.strictEqual(readMintTransferFeeBps(TOKEN_2022_PROGRAM_ID, data).feeBps, null, `len ${len} must be unparseable → null`);
    }
});

check('Token-2022 with TransferFeeConfig feeBps 0 (PYUSD-like) → fee-free, eligible', () => {
    const data = buildT2022Mint([{ type: 1, data: feeConfig(0, 0) }]);
    assert.deepStrictEqual(readMintTransferFeeBps(TOKEN_2022_PROGRAM_ID, data), { standard: 'token_2022', feeBps: 0 });
});

check('Token-2022 with NEWER feeBps 100 → fee-bearing (feeBps 100, → main)', () => {
    const data = buildT2022Mint([{ type: 1, data: feeConfig(0, 100) }]);
    assert.deepStrictEqual(readMintTransferFeeBps(TOKEN_2022_PROGRAM_ID, data), { standard: 'token_2022', feeBps: 100 });
});

check('Token-2022 fee = max(older, newer) — older 50, newer 0 → 50', () => {
    const data = buildT2022Mint([{ type: 1, data: feeConfig(50, 0) }]);
    assert.strictEqual(readMintTransferFeeBps(TOKEN_2022_PROGRAM_ID, data).feeBps, 50);
});

check('Token-2022 with other extensions before TransferFeeConfig → still found', () => {
    const data = buildT2022Mint([
        { type: 3, data: Buffer.alloc(32) },   // MintCloseAuthority
        { type: 12, data: Buffer.alloc(32) },  // InterestBearingConfig (PYUSD has this)
        { type: 1, data: feeConfig(0, 0) },
    ]);
    assert.strictEqual(readMintTransferFeeBps(TOKEN_2022_PROGRAM_ID, data).feeBps, 0);
});

check('Token-2022 with extensions but NO TransferFeeConfig → fee-free', () => {
    const data = buildT2022Mint([{ type: 3, data: Buffer.alloc(32) }, { type: 18, data: Buffer.alloc(64) }]);
    assert.strictEqual(readMintTransferFeeBps(TOKEN_2022_PROGRAM_ID, data).feeBps, 0);
});

check('Token-2022 extended but byte-165 not Mint type → null (unparseable → main)', () => {
    const buf = Buffer.alloc(200); buf[165] = 2; // Account type, not Mint
    assert.strictEqual(readMintTransferFeeBps(TOKEN_2022_PROGRAM_ID, buf.toString('base64')).feeBps, null);
});

check('Token-2022 truncated TLV (len claims past buffer) → null', () => {
    const head = Buffer.alloc(166); head[165] = 1;
    const hdr = Buffer.alloc(4); hdr.writeUInt16LE(1, 0); hdr.writeUInt16LE(500, 2); // len 500 but no data
    const data = Buffer.concat([head, hdr]).toString('base64');
    assert.strictEqual(readMintTransferFeeBps(TOKEN_2022_PROGRAM_ID, data).feeBps, null);
});

check('Token-2022 TransferFeeConfig with short data (< 108) → null', () => {
    const data = buildT2022Mint([{ type: 1, data: Buffer.alloc(40) }]);
    assert.strictEqual(readMintTransferFeeBps(TOKEN_2022_PROGRAM_ID, data).feeBps, null);
});

check('BAT-1060: malformed base64 mint data (invalid chars) → null, not feeBps:0', () => {
    // A valid 82-byte base mint, then inject non-base64 chars so Buffer.from
    // silently drops them and the decoded bytes no longer round-trip → reject.
    const good = Buffer.alloc(82).toString('base64');
    const bad = good.slice(0, 12) + '!@# ' + good.slice(12);
    assert.strictEqual(readMintTransferFeeBps(TOKEN_2022_PROGRAM_ID, bad).feeBps, null);
});

console.log();
console.log(`Result: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.error('FAIL: token2022-mint.test.js'); process.exit(1); }
console.log('PASS: token2022-mint.test.js');
