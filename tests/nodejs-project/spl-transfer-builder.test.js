#!/usr/bin/env node
// tests/nodejs-project/spl-transfer-builder.test.js
//
// BAT-1036: buildClassicSplTransferTx — the shared generic classic-SPL
// TransferChecked builder (payment/x402.js). Security-critical serialization;
// the no-create path must stay byte-for-byte identical to the proven
// _buildUsdcTransferTx, and the create path must pin the exact account layout.
//
// Pure — loads x402.js directly (no config dependency in the builder path).

'use strict';

const assert = require('assert');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
const x402 = require(path.join(BUNDLE, 'payment', 'x402.js'));
const {
    buildClassicSplTransferTx, _buildUsdcTransferTx, _base58Encode,
    USDC_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} = x402;

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

// Distinct valid 32-byte base58 pubkeys (round-tripped through x402's encoder).
const BURNER    = _base58Encode(Buffer.alloc(32, 11));
const MAIN      = _base58Encode(Buffer.alloc(32, 22));
const RECIPIENT = _base58Encode(Buffer.alloc(32, 33));
const MINT9     = _base58Encode(Buffer.alloc(32, 44)); // arbitrary 9-decimal mint
const BLOCKHASH = _base58Encode(Buffer.alloc(32, 7));
const AMT = 1500000n; // 1.5 USDC atomic

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); if (process.env.VERBOSE) console.error(e.stack); }
}

// ── minimal legacy-message decoder (counts here are all < 128 → 1-byte shortvec)
function rcu16(buf, o) { return [buf[o], 1]; } // sufficient for these fixtures
function decodeTx(txBuffer) {
    let o = 0;
    const [sigCount, n1] = rcu16(txBuffer, o); o += n1;
    o += 64 * sigCount;
    const numRequiredSignatures = txBuffer[o];
    const numReadonlySigned = txBuffer[o + 1];
    const numReadonlyUnsigned = txBuffer[o + 2];
    o += 3;
    const [keyCount, n2] = rcu16(txBuffer, o); o += n2;
    const keys = [];
    for (let i = 0; i < keyCount; i++) { keys.push(_base58Encode(txBuffer.slice(o, o + 32))); o += 32; }
    const blockhash = _base58Encode(txBuffer.slice(o, o + 32)); o += 32;
    const [ixCount, n3] = rcu16(txBuffer, o); o += n3;
    const ixs = [];
    for (let i = 0; i < ixCount; i++) {
        const programIdIndex = txBuffer[o]; o += 1;
        const [na, nn] = rcu16(txBuffer, o); o += nn;
        const accs = []; for (let j = 0; j < na; j++) { accs.push(txBuffer[o]); o += 1; }
        const [dl, nd] = rcu16(txBuffer, o); o += nd;
        const data = txBuffer.slice(o, o + dl); o += dl;
        ixs.push({ programIdIndex, accs, data });
    }
    return { sigCount, numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned, keys, blockhash, ixs };
}

console.log('spl-transfer-builder.test.js — BAT-1036 buildClassicSplTransferTx');
console.log();

// ── Test 1: byte-for-byte parity with the proven _buildUsdcTransferTx ─────────
check('1. USDC / no-create is BYTE-FOR-BYTE identical to _buildUsdcTransferTx', () => {
    const legacy = _buildUsdcTransferTx(BURNER, RECIPIENT, AMT, BLOCKHASH);
    const generic = buildClassicSplTransferTx({
        payerAuthority: BURNER, recipientOwner: RECIPIENT, mint: USDC_MINT,
        decimals: 6, amountAtomic: AMT, recentBlockhash: BLOCKHASH, createRecipientAta: false,
    });
    assert.ok(legacy.txBuffer.equals(generic.txBuffer), 'no-create txBuffer must match the hot-path builder byte-for-byte');
    assert.strictEqual(generic.instructionCount, 1);
    // both builders surface the same derived ATAs (base58)
    assert.strictEqual(generic.sourceAta, legacy.paymentMeta.sourceAta, 'sourceAta parity');
    assert.strictEqual(generic.destAta, legacy.paymentMeta.destAta, 'destAta parity');
});

// ── Test 2: arbitrary classic mint + arbitrary decimals ───────────────────────
check('2. arbitrary mint + 9 decimals builds (decimals byte = 9 in TransferChecked data)', () => {
    const r = buildClassicSplTransferTx({
        payerAuthority: BURNER, recipientOwner: RECIPIENT, mint: MINT9,
        decimals: 9, amountAtomic: AMT, recentBlockhash: BLOCKHASH, createRecipientAta: false,
    });
    const d = decodeTx(r.txBuffer);
    assert.strictEqual(d.ixs.length, 1);
    const ix = d.ixs[0];
    assert.strictEqual(ix.data.length, 10, 'TransferChecked data is 10 bytes');
    assert.strictEqual(ix.data[0], 12, 'TransferChecked discriminator = 12');
    assert.strictEqual(ix.data.readBigUInt64LE(1), AMT, 'amount u64 LE');
    assert.strictEqual(ix.data[9], 9, 'decimals byte = 9');
    assert.strictEqual(d.keys[3], MINT9, 'mint at idx 3 on the no-create path');
});

// ── Test 3: create=true → idempotent ATA-create BEFORE TransferChecked ────────
check('3. createRecipientAta=true → ATA-create (idempotent) precedes TransferChecked', () => {
    const r = buildClassicSplTransferTx({
        payerAuthority: BURNER, recipientOwner: RECIPIENT, mint: MINT9,
        decimals: 9, amountAtomic: AMT, recentBlockhash: BLOCKHASH, createRecipientAta: true,
    });
    assert.strictEqual(r.instructionCount, 2);
    const d = decodeTx(r.txBuffer);
    assert.strictEqual(d.ixs.length, 2);
    // ix0 = ATA program CreateIdempotent (data = [1])
    assert.strictEqual(d.keys[d.ixs[0].programIdIndex], ASSOCIATED_TOKEN_PROGRAM_ID, 'ix0 programId = ATA program');
    assert.strictEqual(d.ixs[0].data.length, 1, 'CreateIdempotent data is 1 byte');
    assert.strictEqual(d.ixs[0].data[0], 1, 'discriminator 1 = CreateIdempotent');
    // ix1 = Token program TransferChecked
    assert.strictEqual(d.keys[d.ixs[1].programIdIndex], TOKEN_PROGRAM_ID, 'ix1 programId = token program');
    assert.strictEqual(d.ixs[1].data[0], 12, 'ix1 = TransferChecked');
});

// ── Test 4: selected payer = fee payer + authority (burner vs main) ───────────
check('4. payerAuthority selects fee payer AND transfer authority (burner / main fixtures)', () => {
    for (const PAYER of [BURNER, MAIN]) {
        const r = buildClassicSplTransferTx({
            payerAuthority: PAYER, recipientOwner: RECIPIENT, mint: USDC_MINT,
            decimals: 6, amountAtomic: AMT, recentBlockhash: BLOCKHASH, createRecipientAta: false,
        });
        const d = decodeTx(r.txBuffer);
        assert.strictEqual(d.keys[0], PAYER, 'staticAccountKeys[0] = selected payer (fee payer)');
        // TransferChecked authority is the 4th instruction account → must be payer (idx 0)
        const ix = d.ixs[0];
        assert.strictEqual(ix.accs[3], 0, 'TransferChecked authority index = 0 (payer)');
    }
});

// ── Test 5: exact header / signature / account-index pins ─────────────────────
check('5. exact header + signature-count + account-index layout (both paths)', () => {
    // no-create
    const nc = decodeTx(buildClassicSplTransferTx({
        payerAuthority: BURNER, recipientOwner: RECIPIENT, mint: USDC_MINT,
        decimals: 6, amountAtomic: AMT, recentBlockhash: BLOCKHASH, createRecipientAta: false,
    }).txBuffer);
    assert.strictEqual(nc.sigCount, 1, 'one signature slot');
    assert.strictEqual(nc.numRequiredSignatures, 1);
    assert.strictEqual(nc.numReadonlySigned, 0);
    assert.strictEqual(nc.numReadonlyUnsigned, 2);
    assert.deepStrictEqual(nc.ixs[0].accs, [1, 3, 2, 0], 'TransferChecked accounts [source, mint, dest, owner]');
    assert.strictEqual(nc.keys[4], TOKEN_PROGRAM_ID, 'token program at idx 4');

    // create — Codex-pinned ATA layout [payer, destATA, recipientOwner, mint, system, token]
    const cr = buildClassicSplTransferTx({
        payerAuthority: BURNER, recipientOwner: RECIPIENT, mint: USDC_MINT,
        decimals: 6, amountAtomic: AMT, recentBlockhash: BLOCKHASH, createRecipientAta: true,
    });
    const d = decodeTx(cr.txBuffer);
    assert.strictEqual(d.numRequiredSignatures, 1);
    assert.strictEqual(d.numReadonlySigned, 0);
    assert.strictEqual(d.numReadonlyUnsigned, 5);
    assert.strictEqual(d.keys[0], BURNER);
    assert.strictEqual(d.keys[1], cr.sourceAta);
    assert.strictEqual(d.keys[2], cr.destAta);
    assert.strictEqual(d.keys[3], RECIPIENT);
    assert.strictEqual(d.keys[4], USDC_MINT);
    assert.strictEqual(d.keys[5], SYSTEM_PROGRAM_ID);
    assert.strictEqual(d.keys[6], TOKEN_PROGRAM_ID);
    assert.strictEqual(d.keys[7], ASSOCIATED_TOKEN_PROGRAM_ID);
    // ATA-create instruction account meta order (indices into keys):
    //   funder=payer(0), assoc=destATA(2), owner=recipient(3), mint(4), system(5), token(6)
    assert.deepStrictEqual(d.ixs[0].accs, [0, 2, 3, 4, 5, 6], 'ATA-create account order pinned');
    // TransferChecked on the create path: source(1), mint(4), dest(2), owner(0)
    assert.deepStrictEqual(d.ixs[1].accs, [1, 4, 2, 0], 'TransferChecked accounts on create path');
});

// ── Test 6: malformed inputs fail BEFORE serialization (no partial tx) ────────
check('6. malformed pubkey / u64 overflow / bad decimals throw before serialization', () => {
    const base = {
        payerAuthority: BURNER, recipientOwner: RECIPIENT, mint: USDC_MINT,
        decimals: 6, amountAtomic: AMT, recentBlockhash: BLOCKHASH, createRecipientAta: false,
    };
    assert.throws(() => buildClassicSplTransferTx({ ...base, payerAuthority: 'not-base58!!' }), /payerAuthority/);
    assert.throws(() => buildClassicSplTransferTx({ ...base, mint: 'x' }), /mint/);
    assert.throws(() => buildClassicSplTransferTx({ ...base, decimals: 256 }), /decimals/);
    assert.throws(() => buildClassicSplTransferTx({ ...base, decimals: 1.5 }), /decimals/);
    assert.throws(() => buildClassicSplTransferTx({ ...base, amountAtomic: 0n }), /amountAtomic/);
    assert.throws(() => buildClassicSplTransferTx({ ...base, amountAtomic: 2n ** 64n }), /amountAtomic/);
    assert.throws(() => buildClassicSplTransferTx({ ...base, recentBlockhash: 'short' }), /recentBlockhash/);
});

console.log();
console.log(`Result: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.error('FAIL: spl-transfer-builder.test.js'); process.exit(1); }
console.log('PASS: spl-transfer-builder.test.js');
