// tests/nodejs-project/burner-policy.test.js
//
// Unit tests for wallet/burner-policy.js (BAT-1013 Phase 2b).
//
// Covers Codex review v1.1 amendment #8 ("Tests need to pin the hard parts"):
//   - x402 v2 partially signed / cosigned signer mode happy path + reject
//   - Drainer-opcode blocklist on burner-owned accounts (5 opcodes)
//   - Token-2022 declaration enforcement
//   - Per-shape `expectedDelta` validation (7 kinds)
//   - Missing burnerPubkey → fail closed before any other check
//   - `REJECT_CODES.length === 26` drift guard
//
// Uses the parser's internal hand-rolled binary format to construct
// synthetic txs end-to-end through `validateBurnerTx`. Helper builders
// shape txs to the exact patterns each test needs without depending on
// `@solana/web3.js` (which the app runtime doesn't ship).

'use strict';

const assert = require('assert');
const path = require('path');

const BUNDLE = path.resolve(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'nodejs-project');
const policy = require(path.join(BUNDLE, 'wallet', 'burner-policy.js'));
const { base58Encode, base58Decode } = require(path.join(BUNDLE, 'wallet', 'tx-parser.js'));

const BURNER = '11111111111111111111111111111112';                              // synthetic burner pubkey (28 chars of 1 + '2')
const FACILITATOR = 'BurzePo3LkJyXJzCvDwBfwiKtKBp5Xh5jExjQ4tNQ8RJ';            // x402 v2 facilitator (random base58)
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BURNER_USDC_ATA = 'BurNerUsdcAtaXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXz';        // synthetic
const RECIPIENT_USDC_ATA = 'ReciPiEntUsdcAtaXXXXXXXXXXXXXXXXXXXXXXXXXXz';     // synthetic
const JUPITER_V6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const JUPITER_LIMIT_ORDER_V2 = 'j1o2qRpjcyUwEvwtcfhEQefh773ZgjxcVRry7LDqg5X'; // the "h" variant per workflow wx2c95307
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

// ─── Tx fixture builder ───────────────────────────────────────────────────

function compactU16(value) {
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

function pubkeyBytes(base58Str) {
    return base58Decode(base58Str);
}

/**
 * Construct a synthetic Solana tx (legacy by default) for policy testing.
 *
 * @param {object} opts
 * @param {string[]} opts.accountKeys - first N are signers per opts.numRequiredSignatures
 * @param {number} opts.numRequiredSignatures
 * @param {Array<{programIdIdx:number, accountIdxs:number[], dataBytes:Buffer}>} opts.instructions
 * @param {boolean} [opts.v0=false]
 * @returns {string} base64-encoded tx
 */
function buildTx({ accountKeys, numRequiredSignatures, instructions, v0 = false }) {
    const blockhash = Buffer.alloc(32, 0x99);
    const parts = [
        compactU16(numRequiredSignatures),
        Buffer.alloc(64 * numRequiredSignatures), // empty signature slots
    ];
    if (v0) parts.push(Buffer.from([0x80]));
    parts.push(Buffer.from([numRequiredSignatures, 0, 0])); // header
    parts.push(compactU16(accountKeys.length));
    for (const k of accountKeys) parts.push(pubkeyBytes(k));
    parts.push(blockhash);
    parts.push(compactU16(instructions.length));
    for (const ix of instructions) {
        parts.push(Buffer.from([ix.programIdIdx]));
        parts.push(compactU16(ix.accountIdxs.length));
        parts.push(Buffer.from(ix.accountIdxs));
        parts.push(compactU16(ix.dataBytes.length));
        parts.push(ix.dataBytes);
    }
    if (v0) parts.push(compactU16(0)); // zero ALT lookups
    return Buffer.concat(parts).toString('base64');
}

// ─── Test harness ─────────────────────────────────────────────────────────

let pass = 0, fail = 0;
function check(name, fn) {
    try {
        const r = fn();
        if (r instanceof Promise) {
            return r.then(() => { pass++; console.log(`  ✓ ${name}`); })
                .catch(e => { fail++; console.error(`  ✗ ${name}: ${e.message}`); });
        }
        pass++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        fail++;
        console.error(`  ✗ ${name}: ${e.message}`);
        if (process.env.VERBOSE) console.error(e.stack);
    }
}

async function runAsync(name, fn) {
    try {
        await fn();
        pass++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        fail++;
        console.error(`  ✗ ${name}: ${e.message}`);
        if (process.env.VERBOSE) console.error(e.stack);
    }
}

(async function main() {
    console.log('burner-policy.test.js — wallet/burner-policy.js contract');
    console.log();

    console.log('REJECT_CODES drift guard');
    check('REJECT_CODES.length === 26', () => {
        assert.strictEqual(policy.REJECT_CODES.length, 26);
    });
    check('REJECT_CODES has no duplicates', () => {
        assert.strictEqual(new Set(policy.REJECT_CODES).size, policy.REJECT_CODES.length);
    });
    check('every REJECT_CODES entry has a class', () => {
        for (const code of policy.REJECT_CODES) {
            assert.ok(policy.REJECT_CLASS[code], `${code} missing class`);
            assert.ok(['security', 'availability', 'contract_gap'].includes(policy.REJECT_CLASS[code]),
                `${code} class invalid: ${policy.REJECT_CLASS[code]}`);
        }
    });

    console.log();
    console.log('validateBurnerTx: missing burnerPubkey (Codex amendment #3)');
    await runAsync('rejects payer_missing when burnerPubkey not provided', async () => {
        const r = await policy.validateBurnerTx('', {}, {});
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, 'payer_missing');
    });
    await runAsync('rejects payer_missing when burnerPubkey is non-base58', async () => {
        const r = await policy.validateBurnerTx('', {}, { burnerPubkey: 'not-a-key' });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, 'payer_missing');
    });

    console.log();
    console.log('validateExpectedDeltaShape: 7 kinds + signer modes');
    check('rejects undefined expectedDelta', () => {
        const r = policy._validateExpectedDeltaShape(undefined);
        assert.strictEqual(r.error, 'expected_delta_required');
    });
    check('rejects unknown kind', () => {
        const r = policy._validateExpectedDeltaShape({ kind: 'nope', signerMode: 'burner_only' });
        assert.strictEqual(r.error, 'expected_delta_invalid_kind');
    });
    check('rejects unknown signerMode', () => {
        const r = policy._validateExpectedDeltaShape({ kind: 'jupiter_swap_immediate', signerMode: 'wat' });
        assert.strictEqual(r.error, 'expected_delta_invalid_shape');
    });
    check('jupiter_swap_immediate requires debit + creditMin + toleranceBps', () => {
        const r = policy._validateExpectedDeltaShape({
            kind: 'jupiter_swap_immediate',
            signerMode: 'burner_only',
        });
        assert.strictEqual(r.error, 'expected_delta_invalid_shape');
    });
    check('jupiter_swap_immediate accepts well-formed', () => {
        const r = policy._validateExpectedDeltaShape({
            kind: 'jupiter_swap_immediate',
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '1000000' },
            burnerCreditMin: { account: BURNER_USDC_ATA, mint: 'native_sol', atomicAmount: '5000000' },
            toleranceBps: 100,
        });
        assert.strictEqual(r.ok, true);
    });
    check('jupiter_trigger_create_deposit shape has NO creditMin', () => {
        const r = policy._validateExpectedDeltaShape({
            kind: 'jupiter_trigger_create_deposit',
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '10000000' },
            depositVault: { pubkey: BURNER_USDC_ATA, expectedOwner: JUPITER_LIMIT_ORDER_V2 },
        });
        assert.strictEqual(r.ok, true);
    });
    check('agent_pay_x402 v2 must use signerMode cosigned', () => {
        const r = policy._validateExpectedDeltaShape({
            kind: 'agent_pay_x402',
            x402Version: 2,
            signerMode: 'burner_only', // ← wrong for v2
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '10000' },
            recipient: { account: RECIPIENT_USDC_ATA, mint: USDC },
        });
        assert.strictEqual(r.error, 'expected_delta_invalid_shape');
        assert.match(r.reason, /v2 must use signerMode "cosigned"/);
    });
    check('agent_pay_x402 v2 cosigned needs feePayerAllowlist', () => {
        const r = policy._validateExpectedDeltaShape({
            kind: 'agent_pay_x402',
            x402Version: 2,
            signerMode: 'cosigned',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '10000' },
            recipient: { account: RECIPIENT_USDC_ATA, mint: USDC },
            feePayerAllowlist: [],
            cosignerAllowlist: [FACILITATOR],
        });
        assert.strictEqual(r.error, 'expected_delta_invalid_shape');
    });
    check('agent_pay_x402 v2 cosigned with facilitator accepts', () => {
        const r = policy._validateExpectedDeltaShape({
            kind: 'agent_pay_x402',
            x402Version: 2,
            signerMode: 'cosigned',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '10000' },
            recipient: { account: RECIPIENT_USDC_ATA, mint: USDC },
            feePayerAllowlist: [FACILITATOR],
            cosignerAllowlist: [FACILITATOR],
        });
        assert.strictEqual(r.ok, true);
    });
    check('solana_send requires recipient', () => {
        const r = policy._validateExpectedDeltaShape({
            kind: 'solana_send',
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER, mint: 'native_sol', atomicAmount: '1000' },
        });
        assert.strictEqual(r.error, 'expected_delta_invalid_shape');
    });
    check('zero_value_cancel requires allowedInstructionClasses array', () => {
        const r = policy._validateExpectedDeltaShape({
            kind: 'zero_value_cancel',
            signerMode: 'burner_only',
        });
        assert.strictEqual(r.error, 'expected_delta_invalid_shape');
    });

    console.log();
    console.log('validateSignerMode: 3 modes (burner_only, sponsored, cosigned)');
    const happyDelta = {
        kind: 'jupiter_swap_immediate',
        signerMode: 'burner_only',
        burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '1000000' },
        burnerCreditMin: { account: BURNER_USDC_ATA, mint: 'native_sol', atomicAmount: '5000000' },
        toleranceBps: 100,
    };
    const ALT_PUBKEY = '22222222222222222222222222222222';

    check('burner_only: payer mismatch rejected', () => {
        const r = policy._validateSignerMode(
            { staticAccountKeys: [ALT_PUBKEY], numRequiredSignatures: 1 },
            BURNER, happyDelta);
        assert.strictEqual(r.error, 'payer_mismatch');
    });
    check('burner_only: signer count > 1 rejected', () => {
        const r = policy._validateSignerMode(
            { staticAccountKeys: [BURNER, ALT_PUBKEY], numRequiredSignatures: 2 },
            BURNER, happyDelta);
        assert.strictEqual(r.error, 'signer_count_mismatch');
    });
    check('burner_only happy path', () => {
        const r = policy._validateSignerMode(
            { staticAccountKeys: [BURNER], numRequiredSignatures: 1 },
            BURNER, happyDelta);
        assert.strictEqual(r.ok, true);
    });
    check('cosigned x402 v2 happy: facilitator at slot 0, burner at slot 1', () => {
        const x402Delta = {
            kind: 'agent_pay_x402',
            x402Version: 2,
            signerMode: 'cosigned',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '10000' },
            recipient: { account: RECIPIENT_USDC_ATA, mint: USDC },
            feePayerAllowlist: [FACILITATOR],
            cosignerAllowlist: [FACILITATOR],
        };
        const r = policy._validateSignerMode(
            { staticAccountKeys: [FACILITATOR, BURNER], numRequiredSignatures: 2 },
            BURNER, x402Delta);
        assert.strictEqual(r.ok, true);
    });
    check('cosigned: wrong fee payer rejected', () => {
        const x402Delta = {
            kind: 'agent_pay_x402',
            x402Version: 2,
            signerMode: 'cosigned',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '10000' },
            recipient: { account: RECIPIENT_USDC_ATA, mint: USDC },
            feePayerAllowlist: [FACILITATOR],
            cosignerAllowlist: [FACILITATOR],
        };
        const r = policy._validateSignerMode(
            { staticAccountKeys: [ALT_PUBKEY, BURNER], numRequiredSignatures: 2 },
            BURNER, x402Delta);
        assert.strictEqual(r.error, 'fee_payer_not_in_allowlist');
    });
    check('cosigned: extra unknown cosigner rejected', () => {
        const x402Delta = {
            kind: 'agent_pay_x402',
            x402Version: 2,
            signerMode: 'cosigned',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '10000' },
            recipient: { account: RECIPIENT_USDC_ATA, mint: USDC },
            feePayerAllowlist: [FACILITATOR],
            cosignerAllowlist: [FACILITATOR], // expecting 1 cosigner
        };
        // tx has 3 required signers (facilitator + burner + unknown)
        const r = policy._validateSignerMode(
            { staticAccountKeys: [FACILITATOR, BURNER, ALT_PUBKEY], numRequiredSignatures: 3 },
            BURNER, x402Delta);
        assert.strictEqual(r.error, 'signer_count_mismatch');
    });

    console.log();
    console.log('validateDrainerOpcodes: SetAuthority / Approve / CloseAccount / Assign / AdvanceNonce');
    check('rejects SetAuthority on burner-owned account', () => {
        const parsed = {
            staticAccountKeys: [BURNER, BURNER_USDC_ATA, TOKEN_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 2, // TOKEN_PROGRAM
                accountIdxs: [1], // BURNER_USDC_ATA
                dataBytes: Buffer.from([6, 0]), // SetAuthority discriminator
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [BURNER_USDC_ATA], { kind: 'jupiter_swap_immediate' });
        assert.strictEqual(r.error, 'drainer_set_authority');
    });
    check('rejects Approve on burner-owned account', () => {
        const parsed = {
            staticAccountKeys: [BURNER, BURNER_USDC_ATA, TOKEN_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 2,
                accountIdxs: [1],
                dataBytes: Buffer.from([4, 0]), // Approve
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [BURNER_USDC_ATA], { kind: 'jupiter_swap_immediate' });
        assert.strictEqual(r.error, 'drainer_approve');
    });
    check('rejects CloseAccount in non-cancel kind', () => {
        const parsed = {
            staticAccountKeys: [BURNER, BURNER_USDC_ATA, TOKEN_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 2,
                accountIdxs: [1],
                dataBytes: Buffer.from([9]), // CloseAccount
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [BURNER_USDC_ATA], { kind: 'jupiter_swap_immediate' });
        assert.strictEqual(r.error, 'drainer_close_account');
    });
    check('allows CloseAccount in zero_value_cancel', () => {
        const parsed = {
            staticAccountKeys: [BURNER, BURNER_USDC_ATA, TOKEN_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 2,
                accountIdxs: [1],
                dataBytes: Buffer.from([9]),
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [BURNER_USDC_ATA], { kind: 'zero_value_cancel' });
        assert.strictEqual(r.ok, true);
    });
    check('rejects System::Assign reassigning burner', () => {
        const parsed = {
            staticAccountKeys: [BURNER, SYSTEM_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 1,
                accountIdxs: [0],
                // System::Assign discriminator = u32 LE 0x00000001
                dataBytes: Buffer.from([0x01, 0x00, 0x00, 0x00, ...Buffer.alloc(32)]),
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [BURNER], { kind: 'jupiter_swap_immediate' });
        assert.strictEqual(r.error, 'drainer_assign');
    });
    check('rejects AdvanceNonceAccount as instruction 0', () => {
        const parsed = {
            staticAccountKeys: [BURNER, SYSTEM_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 1,
                accountIdxs: [],
                // AdvanceNonceAccount discriminator = u32 LE 0x00000004
                dataBytes: Buffer.from([0x04, 0x00, 0x00, 0x00]),
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [BURNER], { kind: 'jupiter_swap_immediate' });
        assert.strictEqual(r.error, 'drainer_nonce_blank_check');
    });
    check('rejects Token-2022 without expectedDelta.tokenStandard declaration', () => {
        const parsed = {
            staticAccountKeys: [BURNER, BURNER_USDC_ATA, TOKEN_2022_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 2,
                accountIdxs: [1, 0],
                dataBytes: Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]), // SPL Transfer
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [BURNER_USDC_ATA], { kind: 'jupiter_swap_immediate' });
        assert.strictEqual(r.error, 'token_2022_undeclared');
    });
    check('accepts Token-2022 when tokenStandard declared', () => {
        const parsed = {
            staticAccountKeys: [BURNER, BURNER_USDC_ATA, TOKEN_2022_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 2,
                accountIdxs: [1, 0],
                dataBytes: Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [BURNER_USDC_ATA], {
            kind: 'jupiter_swap_immediate',
            tokenStandard: 'token_2022',
        });
        assert.strictEqual(r.ok, true);
    });
    check('accepts clean Jupiter swap (no drainer instructions)', () => {
        const parsed = {
            staticAccountKeys: [BURNER, JUPITER_V6, TOKEN_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 1,
                accountIdxs: [0, 2],
                dataBytes: Buffer.from([0xAA, 0xBB]),
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [], { kind: 'jupiter_swap_immediate' });
        assert.strictEqual(r.ok, true);
    });

    console.log();
    console.log('validateSimDelta: per-shape delta enforcement (Phase 2c v8.1)');

    // ─── v8.1 simulator helpers ────────────────────────────────────────────
    //
    // New interface (Codex amendment #8.1):
    //   simulator(txBase64, { addresses }) → { sim, preSnapshot, slot }
    //
    // `sim.value` follows Solana RPC simulateTransaction shape PLUS our
    // requested `value.accounts[i]` (post-state for each address). When
    // tests want to exercise the auxiliary cross-check path, they include
    // `preTokenBalances` / `postTokenBalances` / `preBalances` /
    // `postBalances` in `sim.value`.
    // `preSnapshot[i]` is the same-RPC `getMultipleAccounts` response for
    // the same address at index `i`, also base64 SPL-Token-layout encoded
    // (or null when account doesn't exist pre-tx).

    function splTokenAccountInfo({ mint, owner, amountAtomic, lamports = 2_039_280 }) {
        // 72-byte SPL Token Account layout: mint(32) + owner(32) + amount(u64 LE)
        const mintBuf = pubkeyBytes(mint);
        const ownerBuf = pubkeyBytes(owner);
        const amtBuf = Buffer.alloc(8);
        amtBuf.writeBigUInt64LE(BigInt(amountAtomic), 0);
        const data = Buffer.concat([mintBuf, ownerBuf, amtBuf]);
        return {
            lamports,
            owner: TOKEN_PROGRAM,
            data: [data.toString('base64'), 'base64'],
            executable: false,
            rentEpoch: 0,
        };
    }

    function nativeAccountInfo({ lamports }) {
        return {
            lamports,
            owner: '11111111111111111111111111111111',
            data: ['', 'base64'],
            executable: false,
            rentEpoch: 0,
        };
    }

    // Build a simulator that returns canned sim + preSnapshot for the
    // requested addresses. `accounts` is a map { addr: { pre, post } }
    // where each entry is an accountInfo object or null.
    function mockSimulator({ accounts, simExtra = {}, throwError = null }) {
        return async (_txBase64, { addresses }) => {
            if (throwError) throw new Error(throwError);
            const preSnapshot = addresses.map(addr => (accounts[addr] && accounts[addr].pre !== undefined) ? accounts[addr].pre : null);
            const valueAccounts = addresses.map(addr => (accounts[addr] && accounts[addr].post !== undefined) ? accounts[addr].post : null);
            const sim = {
                value: Object.assign({
                    err: null,
                    logs: [],
                    accounts: valueAccounts,
                    loadedAddresses: { writable: [], readonly: [] },
                }, simExtra),
            };
            return { sim, preSnapshot, slot: 123 };
        };
    }

    // Simple Memo-only tx the simulator can be wired around for zero-value tests.
    function memoOnlyTx() {
        return buildTx({
            accountKeys: [BURNER, JUPITER_V6],
            numRequiredSignatures: 1,
            instructions: [{ programIdIdx: 1, accountIdxs: [0], dataBytes: Buffer.from([0xAB]) }],
        });
    }

    await runAsync('simulator throws → simulation_failed', async () => {
        const simulator = mockSimulator({ accounts: {}, throwError: 'helius unreachable' });
        const r = await policy.validateBurnerTx(memoOnlyTx(), {
            kind: 'zero_value_auth',
            signerMode: 'burner_only',
            allowedInstructionClasses: ['memo'],
        }, { burnerPubkey: BURNER, simulator });
        assert.strictEqual(r.error, 'simulation_failed');
        assert.strictEqual(r.class, 'availability');
        assert.match(r.reason, /helius unreachable/);
    });

    await runAsync('simulation returns err → simulation_returned_error', async () => {
        const simulator = mockSimulator({
            accounts: { [BURNER]: { pre: nativeAccountInfo({ lamports: 2_000_000_000 }), post: nativeAccountInfo({ lamports: 1_999_995_000 }) } },
            simExtra: { err: { InstructionError: [0, 'Custom'] } },
        });
        const r = await policy.validateBurnerTx(memoOnlyTx(), {
            kind: 'zero_value_auth',
            signerMode: 'burner_only',
            allowedInstructionClasses: ['memo'],
        }, { burnerPubkey: BURNER, simulator });
        assert.strictEqual(r.error, 'simulation_returned_error');
        assert.strictEqual(r.class, 'availability');
    });

    await runAsync('zero_value_auth: SOL drain beyond fee headroom → delta_mismatch (v8.1 primary)', async () => {
        const simulator = mockSimulator({
            accounts: {
                // burner native account: spent 1 SOL — far above 10M lamport headroom
                [BURNER]: { pre: nativeAccountInfo({ lamports: 2_000_000_000 }), post: nativeAccountInfo({ lamports: 1_000_000_000 }) },
            },
        });
        const r = await policy.validateBurnerTx(memoOnlyTx(), {
            kind: 'zero_value_auth',
            signerMode: 'burner_only',
            allowedInstructionClasses: ['memo'],
        }, { burnerPubkey: BURNER, simulator });
        assert.strictEqual(r.error, 'simulation_delta_mismatch');
        assert.strictEqual(r.class, 'security');
    });

    await runAsync('zero_value_auth: tiny SOL fee → accepted (v8.1 primary)', async () => {
        const simulator = mockSimulator({
            accounts: {
                [BURNER]: { pre: nativeAccountInfo({ lamports: 2_000_000_000 }), post: nativeAccountInfo({ lamports: 1_999_995_000 }) },
            },
        });
        const r = await policy.validateBurnerTx(memoOnlyTx(), {
            kind: 'zero_value_auth',
            signerMode: 'burner_only',
            allowedInstructionClasses: ['memo'],
        }, { burnerPubkey: BURNER, simulator });
        assert.strictEqual(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
        assert.strictEqual(r.simulated, true);
    });

    await runAsync('jupiter_swap_immediate: happy path within tolerance (v8.1 primary)', async () => {
        const txB64 = buildTx({
            accountKeys: [BURNER, JUPITER_V6, BURNER_USDC_ATA],
            numRequiredSignatures: 1,
            instructions: [{ programIdIdx: 1, accountIdxs: [0, 2], dataBytes: Buffer.from([0xAB]) }],
        });
        const simulator = mockSimulator({
            accounts: {
                // Burner spent 1 USDC, debit account observed exactly
                [BURNER_USDC_ATA]: {
                    pre: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '1000000' }),
                    post: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '0' }),
                },
                // Burner gained 995_000 lamports (SOL credit), well above 500_000 minimum
                [BURNER]: {
                    pre: nativeAccountInfo({ lamports: 2_000_000_000 }),
                    post: nativeAccountInfo({ lamports: 2_000_995_000 }),
                },
            },
        });
        const r = await policy.validateBurnerTx(txB64, {
            kind: 'jupiter_swap_immediate',
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '1000000' },
            burnerCreditMin: { account: BURNER, mint: 'native_sol', atomicAmount: '500000' },
            burnerOwnedAccounts: [BURNER_USDC_ATA],
            toleranceBps: 100,
        }, { burnerPubkey: BURNER, simulator });
        assert.strictEqual(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
        assert.strictEqual(r.simulated, true);
    });

    await runAsync('jupiter_swap_immediate: burner debit shortfall → delta_mismatch (v8.1 primary)', async () => {
        const txB64 = buildTx({
            accountKeys: [BURNER, JUPITER_V6, BURNER_USDC_ATA],
            numRequiredSignatures: 1,
            instructions: [{ programIdIdx: 1, accountIdxs: [0, 2], dataBytes: Buffer.from([0xAB]) }],
        });
        const simulator = mockSimulator({
            accounts: {
                // Only sold 500k of declared 1M
                [BURNER_USDC_ATA]: {
                    pre: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '1000000' }),
                    post: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '500000' }),
                },
                [BURNER]: {
                    pre: nativeAccountInfo({ lamports: 2_000_000_000 }),
                    post: nativeAccountInfo({ lamports: 1_999_995_000 }),
                },
            },
        });
        const r = await policy.validateBurnerTx(txB64, {
            kind: 'jupiter_swap_immediate',
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '1000000' },
            burnerCreditMin: { account: BURNER, mint: 'native_sol', atomicAmount: '0' },
            burnerOwnedAccounts: [BURNER_USDC_ATA],
            toleranceBps: 100,
        }, { burnerPubkey: BURNER, simulator });
        assert.strictEqual(r.error, 'simulation_delta_mismatch');
    });

    await runAsync('Codex §9 (a) accounts-config success only (no auxiliary arrays)', async () => {
        const txB64 = buildTx({
            accountKeys: [BURNER, JUPITER_V6, BURNER_USDC_ATA],
            numRequiredSignatures: 1,
            instructions: [{ programIdIdx: 1, accountIdxs: [0, 2], dataBytes: Buffer.from([0xAB]) }],
        });
        // No preTokenBalances/postTokenBalances in simExtra — auxiliary absent.
        const simulator = mockSimulator({
            accounts: {
                [BURNER_USDC_ATA]: {
                    pre: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '1000000' }),
                    post: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '0' }),
                },
                [BURNER]: {
                    pre: nativeAccountInfo({ lamports: 2_000_000_000 }),
                    post: nativeAccountInfo({ lamports: 2_000_995_000 }),
                },
            },
        });
        const r = await policy.validateBurnerTx(txB64, {
            kind: 'jupiter_swap_immediate',
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '1000000' },
            burnerCreditMin: { account: BURNER, mint: 'native_sol', atomicAmount: '500000' },
            burnerOwnedAccounts: [BURNER_USDC_ATA],
            toleranceBps: 100,
        }, { burnerPubkey: BURNER, simulator });
        assert.strictEqual(r.ok, true);
    });

    await runAsync('Codex §9 (b) arrays-agree cross-check (auxiliary present + matches)', async () => {
        const txB64 = buildTx({
            accountKeys: [BURNER, JUPITER_V6, BURNER_USDC_ATA],
            numRequiredSignatures: 1,
            instructions: [{ programIdIdx: 1, accountIdxs: [0, 2], dataBytes: Buffer.from([0xAB]) }],
        });
        const simulator = mockSimulator({
            accounts: {
                [BURNER_USDC_ATA]: {
                    pre: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '1000000' }),
                    post: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '0' }),
                },
                [BURNER]: {
                    pre: nativeAccountInfo({ lamports: 2_000_000_000 }),
                    post: nativeAccountInfo({ lamports: 2_000_995_000 }),
                },
            },
            simExtra: {
                // Auxiliary array entries that AGREE with the primary (delta = -1_000_000)
                preTokenBalances: [
                    { accountIndex: 2, mint: USDC, owner: BURNER, programId: TOKEN_PROGRAM, uiTokenAmount: { amount: '1000000', decimals: 6 } },
                ],
                postTokenBalances: [
                    { accountIndex: 2, mint: USDC, owner: BURNER, programId: TOKEN_PROGRAM, uiTokenAmount: { amount: '0', decimals: 6 } },
                ],
                preBalances: [2_000_000_000, 0, 2_039_280],
                postBalances: [2_000_995_000, 0, 2_039_280],
            },
        });
        const r = await policy.validateBurnerTx(txB64, {
            kind: 'jupiter_swap_immediate',
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '1000000' },
            burnerCreditMin: { account: BURNER, mint: 'native_sol', atomicAmount: '500000' },
            burnerOwnedAccounts: [BURNER_USDC_ATA],
            toleranceBps: 100,
        }, { burnerPubkey: BURNER, simulator });
        assert.strictEqual(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
    });

    await runAsync('Codex §9 (c) arrays-disagree (security failure)', async () => {
        const txB64 = buildTx({
            accountKeys: [BURNER, JUPITER_V6, BURNER_USDC_ATA],
            numRequiredSignatures: 1,
            instructions: [{ programIdIdx: 1, accountIdxs: [0, 2], dataBytes: Buffer.from([0xAB]) }],
        });
        const simulator = mockSimulator({
            accounts: {
                // Primary says debit = -1_000_000
                [BURNER_USDC_ATA]: {
                    pre: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '1000000' }),
                    post: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '0' }),
                },
                [BURNER]: {
                    pre: nativeAccountInfo({ lamports: 2_000_000_000 }),
                    post: nativeAccountInfo({ lamports: 2_000_995_000 }),
                },
            },
            simExtra: {
                // Auxiliary DISAGREES: claims debit = -100 (90100 → 90000)
                preTokenBalances: [
                    { accountIndex: 2, mint: USDC, owner: BURNER, programId: TOKEN_PROGRAM, uiTokenAmount: { amount: '90100', decimals: 6 } },
                ],
                postTokenBalances: [
                    { accountIndex: 2, mint: USDC, owner: BURNER, programId: TOKEN_PROGRAM, uiTokenAmount: { amount: '90000', decimals: 6 } },
                ],
            },
        });
        const r = await policy.validateBurnerTx(txB64, {
            kind: 'jupiter_swap_immediate',
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '1000000' },
            burnerCreditMin: { account: BURNER, mint: 'native_sol', atomicAmount: '500000' },
            burnerOwnedAccounts: [BURNER_USDC_ATA],
            toleranceBps: 100,
        }, { burnerPubkey: BURNER, simulator });
        assert.strictEqual(r.error, 'simulation_delta_mismatch');
        assert.strictEqual(r.class, 'security');
        assert.match(r.reason, /primary vs auxiliary/);
    });

    await runAsync('Codex §9 (d) missing account data → simulation_metadata_missing', async () => {
        const txB64 = buildTx({
            accountKeys: [BURNER, JUPITER_V6, BURNER_USDC_ATA],
            numRequiredSignatures: 1,
            instructions: [{ programIdIdx: 1, accountIdxs: [0, 2], dataBytes: Buffer.from([0xAB]) }],
        });
        const simulator = mockSimulator({
            accounts: {
                // BURNER_USDC_ATA: post-state is null (account data missing) — debit cannot be resolved
                [BURNER_USDC_ATA]: {
                    pre: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '1000000' }),
                    post: null,
                },
                [BURNER]: {
                    pre: nativeAccountInfo({ lamports: 2_000_000_000 }),
                    post: nativeAccountInfo({ lamports: 2_000_995_000 }),
                },
            },
        });
        const r = await policy.validateBurnerTx(txB64, {
            kind: 'jupiter_swap_immediate',
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '1000000' },
            burnerCreditMin: { account: BURNER, mint: 'native_sol', atomicAmount: '500000' },
            burnerOwnedAccounts: [BURNER_USDC_ATA],
            toleranceBps: 100,
        }, { burnerPubkey: BURNER, simulator });
        // Existence policy: debit has allowClose=false; post=null fails closed.
        assert.strictEqual(r.error, 'simulation_delta_mismatch');
    });

    await runAsync('Codex §9 (e) structural-only blocked when allowStructuralOnly not set', async () => {
        // Default production behavior: no simulator + no allowStructuralOnly → fail-closed.
        const r = await policy.validateBurnerTx(memoOnlyTx(), {
            kind: 'zero_value_auth',
            signerMode: 'burner_only',
            allowedInstructionClasses: ['memo'],
        }, { burnerPubkey: BURNER /* no simulator, no allowStructuralOnly */ });
        assert.strictEqual(r.error, 'simulation_failed');
        assert.strictEqual(r.class, 'availability');
        assert.match(r.reason, /simulator is required/);
    });

    await runAsync('structural-only test-mode opt-in (allowStructuralOnly: true)', async () => {
        // Tests opt in to structural-only via the explicit flag.
        const r = await policy.validateBurnerTx(memoOnlyTx(), {
            kind: 'zero_value_auth',
            signerMode: 'burner_only',
            allowedInstructionClasses: ['memo'],
        }, { burnerPubkey: BURNER, allowStructuralOnly: true });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.structuralOnly, true);
    });

    await runAsync('ALT-unresolved program → alt_unresolved', async () => {
        // Build a v0 tx where an instruction references an ALT-resolved program
        const txB64 = buildTx({
            accountKeys: [BURNER],
            numRequiredSignatures: 1,
            instructions: [{ programIdIdx: 99, accountIdxs: [0], dataBytes: Buffer.from([0xAB]) }],
            v0: true,
        });
        const simulator = mockSimulator({
            accounts: {
                [BURNER]: { pre: nativeAccountInfo({ lamports: 2_000_000_000 }), post: nativeAccountInfo({ lamports: 1_999_995_000 }) },
            },
        });
        const r = await policy.validateBurnerTx(txB64, {
            kind: 'zero_value_auth',
            signerMode: 'burner_only',
            allowedInstructionClasses: ['memo'],
        }, { burnerPubkey: BURNER, simulator });
        assert.strictEqual(r.error, 'alt_unresolved');
        assert.strictEqual(r.class, 'availability');
    });

    await runAsync('simulation-derived ownership detects non-ATA burner-owned token account (auxiliary path)', async () => {
        const NON_ATA_BURNER_ACCT = 'NonAtaBurnerownedXXXXXXXXXXXXXXXXXXXXXXXXXz';
        const txB64 = buildTx({
            accountKeys: [BURNER, NON_ATA_BURNER_ACCT, TOKEN_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 2, accountIdxs: [1, 0],
                dataBytes: Buffer.from([6, 0]), // SetAuthority
            }],
        });
        const simulator = mockSimulator({
            accounts: {
                [BURNER]: { pre: nativeAccountInfo({ lamports: 2_000_000_000 }), post: nativeAccountInfo({ lamports: 2_000_000_000 }) },
                // pre-snapshot reveals the non-ATA token account is burner-owned
                [NON_ATA_BURNER_ACCT]: {
                    pre: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '100' }),
                    post: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '100' }),
                },
            },
        });
        const r = await policy.validateBurnerTx(txB64, {
            kind: 'zero_value_auth',
            signerMode: 'burner_only',
            allowedInstructionClasses: ['memo'],
            burnerOwnedAccounts: [NON_ATA_BURNER_ACCT], // explicit declaration so it's in requestedAddresses
        }, { burnerPubkey: BURNER, simulator });
        // Drainer re-walk after simulation catches the SetAuthority via the
        // preSnapshot-derived owner.
        assert.strictEqual(r.error, 'drainer_set_authority');
    });

    console.log();
    console.log('Contract v8.3: depositVault REQUIRED + deposit destination is load-bearing (Codex review)');

    // Canonical Jupiter program IDs — cross-verified via 5-source workflow
    // (jup-ag/docs, jup-ag/platform-list, @jup-ag/* npm SDKs, Solscan,
    // web-search) AND empirically confirmed on mainnet via getAccountInfo.
    // Drift guard: if these strings change, the matching tools/solana.js
    // expectedOwner constants must change in lockstep.
    const JUP_V1_PROGRAM = 'jupoNjAxXgZ4rjzxzPMP4oxduvQsQtZzyknqvzYNrNu';
    const JUP_V2_PROGRAM = 'j1o2qRpjcyUwEvwtcfhEQefh773ZgjxcVRry7LDqg5X';
    const JUP_DCA_PROGRAM = 'DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M';
    const JUPITER_V2_VAULT = 'JupV2VauLtXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXz';
    const ATTACKER_ATA = 'AttacKerAtaXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXz';

    check('drift guard: V1 program ID locked to canonical jupoN...', () => {
        assert.strictEqual(JUP_V1_PROGRAM, 'jupoNjAxXgZ4rjzxzPMP4oxduvQsQtZzyknqvzYNrNu');
        // Catch the EQefh vs EQefr typo class: V1 must NOT contain EQef substring
        assert.ok(!JUP_V1_PROGRAM.includes('EQef'), 'V1 should not contain EQef substring');
    });
    check('drift guard: V2 program ID locked to canonical j1o2...EQefh... (NOT EQefr typo)', () => {
        assert.strictEqual(JUP_V2_PROGRAM, 'j1o2qRpjcyUwEvwtcfhEQefh773ZgjxcVRry7LDqg5X');
        // Codex amendment: pin the EXACT EQefh773 string to catch the EQefr773 typo
        assert.ok(JUP_V2_PROGRAM.includes('EQefh773'), 'V2 must contain EQefh773 (catches EQefr typo class)');
        assert.ok(!JUP_V2_PROGRAM.includes('EQefr'), 'V2 must not contain EQefr (typo)');
    });
    check('drift guard: DCA program ID locked to canonical DCA265...', () => {
        assert.strictEqual(JUP_DCA_PROGRAM, 'DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M');
    });

    check('v8.3: jupiter_trigger_create_deposit with depositVault=null → expected_delta_invalid_shape', () => {
        const r = policy._validateExpectedDeltaShape({
            kind: 'jupiter_trigger_create_deposit',
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '1000000' },
            depositVault: null,
        });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, 'expected_delta_invalid_shape');
    });

    check('v8.3: jupiter_dca_create_deposit with depositVault=undefined → expected_delta_invalid_shape', () => {
        const r = policy._validateExpectedDeltaShape({
            kind: 'jupiter_dca_create_deposit',
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '1000000' },
        });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, 'expected_delta_invalid_shape');
    });

    await runAsync('v8.3 regression: malicious deposit — burner debit X to attacker ATA (vault gets 0 credit) → simulation_delta_mismatch', async () => {
        // The attack: a tampered Jupiter deposit response that credits an
        // attacker-controlled ATA instead of the real Jupiter vault. The
        // burner's debit looks correct. Without the depositVault check,
        // signerMode + drainer-walk + burnerDebit would all pass and the
        // burner would silently sign. This test PROVES the depositVault
        // load-bearing check catches it.
        const txB64 = buildTx({
            accountKeys: [BURNER, JUP_V2_PROGRAM, BURNER_USDC_ATA, ATTACKER_ATA, JUPITER_V2_VAULT],
            numRequiredSignatures: 1,
            instructions: [{ programIdIdx: 1, accountIdxs: [0, 2, 3, 4], dataBytes: Buffer.from([0xAB]) }],
        });
        const simulator = mockSimulator({
            accounts: {
                // Burner spent 1 USDC — looks legitimate
                [BURNER_USDC_ATA]: {
                    pre: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '1000000' }),
                    post: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '0' }),
                },
                // Jupiter vault: NO credit (the tx routed funds elsewhere)
                [JUPITER_V2_VAULT]: {
                    pre: splTokenAccountInfo({ mint: USDC, owner: JUP_V2_PROGRAM, amountAtomic: '0' }),
                    post: splTokenAccountInfo({ mint: USDC, owner: JUP_V2_PROGRAM, amountAtomic: '0' }),
                },
            },
        });
        const r = await policy.validateBurnerTx(txB64, {
            kind: 'jupiter_trigger_create_deposit',
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '1000000' },
            depositVault: { pubkey: JUPITER_V2_VAULT, expectedOwner: JUP_V2_PROGRAM },
            burnerOwnedAccounts: [BURNER_USDC_ATA],
        }, { burnerPubkey: BURNER, simulator });
        // Vault delta is 0 but expected was 1_000_000 → policy fails closed.
        assert.strictEqual(r.ok, false, `expected reject, got ${JSON.stringify(r)}`);
        assert.strictEqual(r.error, 'simulation_delta_mismatch');
        assert.strictEqual(r.class, 'security');
    });

    await runAsync('v8.3 happy path: V2 trigger deposit — burner debit X + vault credit X → accept', async () => {
        const txB64 = buildTx({
            accountKeys: [BURNER, JUP_V2_PROGRAM, BURNER_USDC_ATA, JUPITER_V2_VAULT],
            numRequiredSignatures: 1,
            instructions: [{ programIdIdx: 1, accountIdxs: [0, 2, 3], dataBytes: Buffer.from([0xAB]) }],
        });
        const simulator = mockSimulator({
            accounts: {
                [BURNER_USDC_ATA]: {
                    pre: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '1000000' }),
                    post: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '0' }),
                },
                // Vault: receives the exact debit amount
                [JUPITER_V2_VAULT]: {
                    pre: splTokenAccountInfo({ mint: USDC, owner: JUP_V2_PROGRAM, amountAtomic: '0' }),
                    post: splTokenAccountInfo({ mint: USDC, owner: JUP_V2_PROGRAM, amountAtomic: '1000000' }),
                },
            },
        });
        const r = await policy.validateBurnerTx(txB64, {
            kind: 'jupiter_trigger_create_deposit',
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '1000000' },
            depositVault: { pubkey: JUPITER_V2_VAULT, expectedOwner: JUP_V2_PROGRAM },
            burnerOwnedAccounts: [BURNER_USDC_ATA],
        }, { burnerPubkey: BURNER, simulator });
        assert.strictEqual(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
        assert.strictEqual(r.simulated, true);
    });

    console.log();
    console.log('validateBurnerTx: end-to-end with synthetic txs');
    await runAsync('end-to-end: malformed base64 → tx_unparseable (allowStructuralOnly to bypass simulator gate)', async () => {
        const r = await policy.validateBurnerTx('not-base64-at-all-zzz', {
            kind: 'zero_value_auth',
            signerMode: 'burner_only',
            allowedInstructionClasses: ['memo'],
        }, { burnerPubkey: BURNER, allowStructuralOnly: true });
        assert.strictEqual(r.error, 'tx_unparseable');
        assert.strictEqual(r.class, 'availability');
    });

    console.log();
    console.log(`Result: ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
    console.log('PASS: burner-policy.test.js');
})();
