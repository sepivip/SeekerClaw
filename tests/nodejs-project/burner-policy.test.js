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
//   - `REJECT_CODES.length === 29` drift guard (was 26 before
//     BAT-1013-followup; +3 for drainer_burn, token_2022_extension_unsupported,
//     token_2022_send_unsupported; -5 dead aspirational codes pruned R11)
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
    check('REJECT_CODES.length === 29 (BAT-1013-followup contract amendment)', () => {
        // Locked length bumped 26 → 29 by BAT-1013-followup, adding the
        // three new codes that ship with producers in this PR:
        //   drainer_burn, token_2022_extension_unsupported,
        //   token_2022_send_unsupported.
        // Five additional aspirational codes (slot_drift,
        // alt_account_unresolved, tx_oversize, invalid_header,
        // priority_fee_drain) are DEFERRED to a separate Codex amendment
        // that will land alongside producers — keeping length pinned to
        // 29 here so this drift guard catches premature code-only
        // additions.
        assert.strictEqual(policy.REJECT_CODES.length, 29);
    });
    check('REJECT_CODES includes BAT-1013-followup additions (with producers)', () => {
        for (const code of [
            'drainer_burn',
            'token_2022_extension_unsupported',
            'token_2022_send_unsupported',
        ]) {
            assert.ok(policy.REJECT_CODES.includes(code), `${code} missing from REJECT_CODES`);
        }
    });
    // ── Copilot PR #398 R15 finding #1 regression: isNonEmptyBase58 upper bound ──
    // Pre-fix: only s.length >= 32 was enforced. A long base58-alphabet string
    // (e.g. 88 chars = ed25519 signature length, or arbitrary attacker input)
    // would pass the validator and propagate into account ownership checks.
    // Fix: cap at 44 (Solana pubkey max length).
    check('R15: isNonEmptyBase58 rejects 45-char base58-alphabet string (just past pubkey max)', () => {
        const r = policy._validateExpectedDeltaShape({
            kind: 'solana_send',
            signerMode: 'burner_only',
            burnerDebit: { account: 'A'.repeat(45), mint: 'native_sol', atomicAmount: '1000' },
            recipient: { account: BURNER_USDC_ATA, mint: 'native_sol' },
        });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, 'expected_delta_invalid_shape');
        assert.match(r.reason, /burnerDebit\.account/);
    });
    check('R15: isNonEmptyBase58 rejects 88-char base58 (ed25519 signature length)', () => {
        const r = policy._validateExpectedDeltaShape({
            kind: 'solana_send',
            signerMode: 'burner_only',
            burnerDebit: { account: '1'.repeat(88), mint: 'native_sol', atomicAmount: '1000' },
            recipient: { account: BURNER_USDC_ATA, mint: 'native_sol' },
        });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, 'expected_delta_invalid_shape');
    });
    check('R15: isNonEmptyBase58 still accepts 32-char pubkey (System Program)', () => {
        const r = policy._validateExpectedDeltaShape({
            kind: 'solana_send',
            signerMode: 'burner_only',
            burnerDebit: { account: '11111111111111111111111111111111', mint: 'native_sol', atomicAmount: '1000' },
            recipient: { account: BURNER_USDC_ATA, mint: 'native_sol' },
        });
        assert.strictEqual(r.ok, true);
    });
    check('R15: isNonEmptyBase58 still accepts 44-char pubkey (USDC mint)', () => {
        assert.strictEqual(USDC.length, 44, 'precondition: USDC must be 44 chars');
        const r = policy._validateExpectedDeltaShape({
            kind: 'solana_send',
            signerMode: 'burner_only',
            burnerDebit: { account: USDC, mint: 'native_sol', atomicAmount: '1000' },
            recipient: { account: BURNER_USDC_ATA, mint: 'native_sol' },
        });
        assert.strictEqual(r.ok, true);
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
        const r = policy._validateDrainerOpcodes(parsed, [BURNER], { kind: 'jupiter_swap_immediate' }, BURNER);
        assert.strictEqual(r.error, 'drainer_assign');
    });

    // ── Copilot PR #398 R14 regression: burnerPubkey implicitly in ownedSet ──
    // Pre-fix bug: System::Assign on burnerPubkey escaped drainer-walk because
    // burnerPubkey was NOT in ownedSet (ownedSet only contained SPL-ATA
    // burnerOwnedAccounts). The production caller passes only the SPL-ATA
    // list, so a real attack could land an Assign on the burner's system
    // account silently. Fix: ownedSet implicitly includes burnerPubkey.
    check('R14: System::Assign on burnerPubkey REJECTED when burnerPubkey NOT in burnerOwnedAccounts', () => {
        // Exact bug path — burnerOwnedAccounts is the typical SPL-ATA list
        // and does NOT include BURNER itself. Pre-fix this passed silently.
        const parsed = {
            staticAccountKeys: [BURNER, SYSTEM_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 1,
                accountIdxs: [0], // subject = BURNER (the system account)
                dataBytes: Buffer.from([0x01, 0x00, 0x00, 0x00, ...Buffer.alloc(32)]),
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [BURNER_USDC_ATA], {
            kind: 'jupiter_swap_immediate',
        }, BURNER);
        assert.strictEqual(r.error, 'drainer_assign', `expected drainer_assign reject, got ${JSON.stringify(r)}`);
    });

    check('R14: System::Assign on burnerPubkey REJECTED in zero_value_auth (empty ownedAccounts)', () => {
        // Another real caller pattern: zero_value_auth with empty
        // burnerOwnedAccounts. Without the fix, the empty Set has no entry
        // for BURNER and the Assign passes.
        const parsed = {
            staticAccountKeys: [BURNER, SYSTEM_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 1,
                accountIdxs: [0],
                dataBytes: Buffer.from([0x01, 0x00, 0x00, 0x00, ...Buffer.alloc(32)]),
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [], {
            kind: 'zero_value_auth',
        }, BURNER);
        assert.strictEqual(r.error, 'drainer_assign');
    });

    check('R14: System::Assign on NON-burner account (not in ownedAccounts) is ACCEPTED', () => {
        // Sanity: an Assign on a third-party account the burner doesn't own
        // must NOT be rejected — the burner doesn't own it, so it's not a drain.
        const THIRD_PARTY = '3rd3ParTyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXz';
        const parsed = {
            staticAccountKeys: [BURNER, THIRD_PARTY, SYSTEM_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 2,
                accountIdxs: [1], // subject = THIRD_PARTY
                dataBytes: Buffer.from([0x01, 0x00, 0x00, 0x00, ...Buffer.alloc(32)]),
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [], {
            kind: 'jupiter_swap_immediate',
        }, BURNER);
        assert.strictEqual(r.ok, true, `expected accept for non-owned account, got ${JSON.stringify(r)}`);
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

    // ── Copilot PR #398 R15 finding #3: programs[] returns base58 strings ──
    // Pre-fix: programs[] contained raw programIdIdx integers (e.g. [0, 1, 4])
    // which were misleading — the field name implies program IDs/names, and
    // verifySwapTransaction returns base58 strings. Fix: resolve via
    // staticAccountKeys (structural-only) or combinedAccountKeys (simulated).
    await runAsync('R15: programs[] contains base58 strings, not programIdIdx integers', async () => {
        const r = await policy.validateBurnerTx(memoOnlyTx(), {
            kind: 'zero_value_auth',
            signerMode: 'burner_only',
            allowedInstructionClasses: ['memo'],
        }, { burnerPubkey: BURNER, allowStructuralOnly: true });
        assert.strictEqual(r.ok, true);
        assert.ok(Array.isArray(r.programs), 'programs must be an array');
        assert.ok(r.programs.length > 0, 'memo tx must have at least one program entry');
        for (const p of r.programs) {
            assert.strictEqual(typeof p, 'string', `expected string, got ${typeof p}: ${p}`);
            // Must NOT be a pure integer-as-string (e.g. "0", "1") — that
            // would suggest a regression to the pre-fix integer behavior.
            assert.ok(!/^\d+$/.test(p), `programs entry "${p}" looks like a raw integer index`);
        }
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

    await runAsync('v8.3 amendment regression: skim attack — vault credit X-50bps + attacker takes 50bps → REJECT (exact mode)', async () => {
        // Codex amendment to v8.3: the previous 50-bps tolerance was a
        // sanctioned skim window. This test proves exact mode catches
        // the case where the burner debit looks correct AND the named
        // vault receives almost-correct credit (e.g. 99.5%) but a 0.5%
        // skim lands in an attacker account. Without exact mode, the
        // vault-credit check would have accepted this as "within tolerance".
        const txB64 = buildTx({
            accountKeys: [BURNER, JUP_V2_PROGRAM, BURNER_USDC_ATA, JUPITER_V2_VAULT, ATTACKER_ATA],
            numRequiredSignatures: 1,
            instructions: [{ programIdIdx: 1, accountIdxs: [0, 2, 3, 4], dataBytes: Buffer.from([0xAB]) }],
        });
        const simulator = mockSimulator({
            accounts: {
                // Burner spent exactly the declared 1 USDC
                [BURNER_USDC_ATA]: {
                    pre: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '1000000' }),
                    post: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '0' }),
                },
                // Jupiter vault received only 99.5% — 5000 atomic units skimmed
                [JUPITER_V2_VAULT]: {
                    pre: splTokenAccountInfo({ mint: USDC, owner: JUP_V2_PROGRAM, amountAtomic: '0' }),
                    post: splTokenAccountInfo({ mint: USDC, owner: JUP_V2_PROGRAM, amountAtomic: '995000' }),
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
        assert.strictEqual(r.ok, false, `expected reject of skim attack, got ${JSON.stringify(r)}`);
        assert.strictEqual(r.error, 'simulation_delta_mismatch');
        assert.strictEqual(r.class, 'security');
        // Reason should mention the exact-vs-observed mismatch
        assert.match(r.reason, /delta does not match exactly|995000|1000000/);
    });

    await runAsync('R7 amendment: zero_value_auth with SPL drain on burner-owned ATA → simulation_delta_mismatch', async () => {
        // Without the R7 fix, a zero_value_auth tx labeled by the caller as
        // "no value movement" could quietly transfer SPL tokens out of a
        // burner-owned ATA — drainer-walk catches SetAuthority/Approve/
        // CloseAccount but NOT a plain Transfer. With R7, the policy
        // constrains every declared burnerOwnedAccount to zero delta.
        const txB64 = buildTx({
            accountKeys: [BURNER, JUP_V2_PROGRAM, BURNER_USDC_ATA],
            numRequiredSignatures: 1,
            instructions: [{ programIdIdx: 1, accountIdxs: [0, 2], dataBytes: Buffer.from([0xAB]) }],
        });
        const simulator = mockSimulator({
            accounts: {
                // Burner SOL unchanged (no fee headroom needed for this test)
                [BURNER]: {
                    pre: nativeAccountInfo({ lamports: 2_000_000_000 }),
                    post: nativeAccountInfo({ lamports: 1_999_995_000 }),
                },
                // Burner USDC ATA had 1 USDC, now drained to 0 — should reject
                [BURNER_USDC_ATA]: {
                    pre: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '1000000' }),
                    post: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '0' }),
                },
            },
        });
        const r = await policy.validateBurnerTx(txB64, {
            kind: 'zero_value_auth',
            signerMode: 'burner_only',
            allowedInstructionClasses: ['memo'],
            burnerOwnedAccounts: [BURNER_USDC_ATA],
        }, { burnerPubkey: BURNER, simulator });
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
                // C7 (BAT-1013-followup): SPL-input deposits now require a
                // burner native-SOL fee-headroom check. Supply the BURNER
                // native account so the policy can verify fees are within
                // headroom.
                [BURNER]: {
                    pre: nativeAccountInfo({ lamports: 2_000_000_000 }),
                    post: nativeAccountInfo({ lamports: 1_999_995_000 }),
                },
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

    // ─── BAT-1013-followup: B1 / B2 / B3 / C3..C7 / C11 / C14 / C15 / Q3 / Q9 ───

    console.log();
    console.log('BAT-1013-followup B2: SPL Burn / BurnChecked drainer rejection');
    check('rejects SPL Burn (ix=8) on burner-owned account', () => {
        const parsed = {
            staticAccountKeys: [BURNER, BURNER_USDC_ATA, USDC, TOKEN_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 3, // TOKEN_PROGRAM
                accountIdxs: [1, 2, 0], // source=BURNER_USDC_ATA, mint=USDC, authority=BURNER
                dataBytes: Buffer.from([8, 0, 0, 0, 0, 0, 0, 0, 0]), // Burn discriminator + u64 amount
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [BURNER_USDC_ATA], { kind: 'jupiter_swap_immediate' });
        assert.strictEqual(r.error, 'drainer_burn');
        assert.strictEqual(r.class, 'security');
    });
    check('rejects SPL BurnChecked (ix=15) on burner-owned account', () => {
        const parsed = {
            staticAccountKeys: [BURNER, BURNER_USDC_ATA, USDC, TOKEN_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 3,
                accountIdxs: [1, 2, 0],
                dataBytes: Buffer.from([15, 0, 0, 0, 0, 0, 0, 0, 0, 6]), // BurnChecked + amount + decimals
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [BURNER_USDC_ATA], { kind: 'jupiter_swap_immediate' });
        assert.strictEqual(r.error, 'drainer_burn');
    });
    check('allows SPL Burn when target is NOT burner-owned', () => {
        const ATTACKER_OWNED = 'AttacKerOwnedAtaXXXXXXXXXXXXXXXXXXXXXXXXXz';
        const parsed = {
            staticAccountKeys: [BURNER, ATTACKER_OWNED, USDC, TOKEN_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 3,
                accountIdxs: [1, 2, 0],
                dataBytes: Buffer.from([8, 0, 0, 0, 0, 0, 0, 0, 0]),
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [BURNER_USDC_ATA], { kind: 'jupiter_swap_immediate' });
        assert.strictEqual(r.ok, true);
    });
    check('Codex v8.4 amendment 2: Burn on burner trade ATA in zero_value_cancel STILL REJECTS (no allowedBurnAccounts)', () => {
        // Without explicit allowedBurnAccounts declaration, even cancel
        // flows reject Burn on burner-owned trade ATAs.
        const parsed = {
            staticAccountKeys: [BURNER, BURNER_USDC_ATA, USDC, TOKEN_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 3,
                accountIdxs: [1, 2, 0],
                dataBytes: Buffer.from([8, 0, 0, 0, 0, 0, 0, 0, 0]),
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [BURNER_USDC_ATA], {
            kind: 'zero_value_cancel',
            allowedInstructionClasses: ['token_close', 'memo'],
            // NO allowedBurnAccounts → reject
        });
        assert.strictEqual(r.error, 'drainer_burn');
        assert.match(r.reason, /not in expectedDelta\.allowedBurnAccounts/);
    });
    check('Copilot R11 finding #2: SPL Transfer on burner-owned source in zero_value_auth REJECTED', () => {
        // Drainer-walk previously covered Auth/Close/Approve/Assign/Burn but
        // NOT Transfer. A zero_value_auth tx could include a Transfer
        // instruction draining the burner's SPL tokens. Now rejects.
        const parsed = {
            staticAccountKeys: [BURNER, BURNER_USDC_ATA, RECIPIENT_USDC_ATA, TOKEN_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 3, // TOKEN_PROGRAM
                accountIdxs: [1, 2, 0], // source=BURNER_USDC_ATA, dest=RECIPIENT, authority=BURNER
                dataBytes: Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0]), // Transfer + u64 amount
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [BURNER_USDC_ATA], {
            kind: 'zero_value_auth',
            allowedInstructionClasses: ['memo'],
        }, BURNER);
        assert.strictEqual(r.error, 'drainer_approve');
        // R-next-8 hardening updated the reason format to mention both
        // possible triggers (authority OR source-in-burnerOwnedAccounts).
        assert.match(r.reason, /SPL Transfer.*(burner.*authority|burnerOwnedAccounts)/i);
    });

    check('Copilot R11: TransferChecked also caught in zero_value_cancel without allowedTransferAccounts', () => {
        const parsed = {
            staticAccountKeys: [BURNER, BURNER_USDC_ATA, RECIPIENT_USDC_ATA, USDC, TOKEN_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 4,
                accountIdxs: [1, 3, 2, 0], // source, mint, dest, authority
                dataBytes: Buffer.from([12, 0, 0, 0, 0, 0, 0, 0, 0, 6]), // TransferChecked
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [BURNER_USDC_ATA], {
            kind: 'zero_value_cancel',
            allowedInstructionClasses: ['token_close', 'memo'],
            // NO allowedTransferAccounts → reject
        });
        assert.strictEqual(r.error, 'drainer_approve');
    });

    check('Copilot R11: SPL Transfer in jupiter_swap_immediate (legitimate swap) NOT rejected by new Transfer guard', () => {
        // Confirms the guard only fires for zero_value_* kinds; swaps still flow.
        const parsed = {
            staticAccountKeys: [BURNER, BURNER_USDC_ATA, RECIPIENT_USDC_ATA, TOKEN_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 3,
                accountIdxs: [1, 2, 0],
                dataBytes: Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0]),
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [BURNER_USDC_ATA], {
            kind: 'jupiter_swap_immediate',
        });
        // No drainer reject — swap kinds allow Transfer.
        assert.strictEqual(r.ok, true, `expected accept, got ${JSON.stringify(r)}`);
    });

    check('Codex v8.4 amendment 2: Burn on DECLARED order/position marker in zero_value_cancel ACCEPTED', () => {
        const ORDER_MARKER = 'orderMarKerPdaXXXXXXXXXXXXXXXXXXXXXXXXXXXXz';
        const parsed = {
            staticAccountKeys: [BURNER, ORDER_MARKER, USDC, TOKEN_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 3,
                accountIdxs: [1, 2, 0],
                dataBytes: Buffer.from([8, 0, 0, 0, 0, 0, 0, 0, 0]),
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [ORDER_MARKER], {
            kind: 'zero_value_cancel',
            allowedInstructionClasses: ['token_close', 'memo'],
            allowedBurnAccounts: [ORDER_MARKER], // explicit caller declaration
        });
        assert.strictEqual(r.ok, true, `expected accept, got ${JSON.stringify(r)}`);
    });

    console.log();
    console.log('BAT-1013-followup B3: Token-2022 extension drainer rejection');
    check('rejects Token-2022 PermanentDelegate (0x22) when tokenStandard declared', () => {
        const parsed = {
            staticAccountKeys: [BURNER, BURNER_USDC_ATA, TOKEN_2022_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 2,
                accountIdxs: [1, 0],
                dataBytes: Buffer.from([0x22, 0x00]), // PermanentDelegate discriminator
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [BURNER_USDC_ATA], {
            kind: 'jupiter_swap_immediate',
            tokenStandard: 'token_2022',
        });
        assert.strictEqual(r.error, 'token_2022_extension_unsupported');
        assert.match(r.reason, /PermanentDelegate/);
    });
    check('rejects Token-2022 TransferHook (0x2b)', () => {
        const parsed = {
            staticAccountKeys: [BURNER, BURNER_USDC_ATA, TOKEN_2022_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 2,
                accountIdxs: [1, 0],
                dataBytes: Buffer.from([0x2b, 0x00]),
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [BURNER_USDC_ATA], {
            kind: 'jupiter_swap_immediate',
            tokenStandard: 'token_2022',
        });
        assert.strictEqual(r.error, 'token_2022_extension_unsupported');
        assert.match(r.reason, /TransferHook/);
    });
    check('rejects Token-2022 ConfidentialTransfer (0x32)', () => {
        const parsed = {
            staticAccountKeys: [BURNER, BURNER_USDC_ATA, TOKEN_2022_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 2,
                accountIdxs: [1, 0],
                dataBytes: Buffer.from([0x32, 0x00]),
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [BURNER_USDC_ATA], {
            kind: 'jupiter_swap_immediate',
            tokenStandard: 'token_2022',
        });
        assert.strictEqual(r.error, 'token_2022_extension_unsupported');
    });
    check('rejects unknown Token-2022 extension opcode (>= 0x20)', () => {
        const parsed = {
            staticAccountKeys: [BURNER, BURNER_USDC_ATA, TOKEN_2022_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 2,
                accountIdxs: [1, 0],
                dataBytes: Buffer.from([0x3f, 0x00]),
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [BURNER_USDC_ATA], {
            kind: 'jupiter_swap_immediate',
            tokenStandard: 'token_2022',
        });
        assert.strictEqual(r.error, 'token_2022_extension_unsupported');
        assert.match(r.reason, /0x3f/);
    });

    console.log();
    console.log('BAT-1013-followup C6: Token-2022 solana_send / agent_pay_x402 fail-closed');
    check('rejects Token-2022 solana_send without tokenStandardConfig', () => {
        const r = policy._validateExpectedDeltaShape({
            kind: 'solana_send',
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '1000000' },
            recipient: { account: RECIPIENT_USDC_ATA, mint: USDC },
            tokenStandard: 'token_2022',
            // tokenStandardConfig: missing
        });
        assert.strictEqual(r.error, 'token_2022_send_unsupported');
        assert.strictEqual(r.class, 'security');
        assert.match(r.reason, /transferFeeBps/);
    });
    check('rejects Token-2022 solana_send with invalid transferFeeBps (>10000)', () => {
        const r = policy._validateExpectedDeltaShape({
            kind: 'solana_send',
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '1000000' },
            recipient: { account: RECIPIENT_USDC_ATA, mint: USDC },
            tokenStandard: 'token_2022',
            tokenStandardConfig: { transferFeeBps: 20000 },
        });
        assert.strictEqual(r.error, 'token_2022_send_unsupported');
    });
    check('accepts Token-2022 solana_send with valid tokenStandardConfig', () => {
        const r = policy._validateExpectedDeltaShape({
            kind: 'solana_send',
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '1000000' },
            recipient: { account: RECIPIENT_USDC_ATA, mint: USDC },
            tokenStandard: 'token_2022',
            tokenStandardConfig: { transferFeeBps: 100 },
        });
        assert.strictEqual(r.ok, true);
    });
    check('rejects Token-2022 agent_pay_x402 v1 without tokenStandardConfig', () => {
        const r = policy._validateExpectedDeltaShape({
            kind: 'agent_pay_x402',
            x402Version: 1,
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '10000' },
            recipient: { account: RECIPIENT_USDC_ATA, mint: USDC },
            tokenStandard: 'token_2022',
        });
        assert.strictEqual(r.error, 'token_2022_send_unsupported');
    });
    check('legacy SPL solana_send (no tokenStandard) still accepted', () => {
        const r = policy._validateExpectedDeltaShape({
            kind: 'solana_send',
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '1000000' },
            recipient: { account: RECIPIENT_USDC_ATA, mint: USDC },
        });
        assert.strictEqual(r.ok, true);
    });

    console.log();
    console.log('BAT-1013-followup C5 + Q3: drainer-walk fail-closed on out-of-range subject');
    check('SetAuthority with missing accountIdxs[0] → account_ownership_uncertain', () => {
        const parsed = {
            staticAccountKeys: [BURNER, BURNER_USDC_ATA, TOKEN_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 2,
                accountIdxs: [], // no subject
                dataBytes: Buffer.from([6, 0]),
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [BURNER_USDC_ATA], { kind: 'jupiter_swap_immediate' });
        assert.strictEqual(r.error, 'account_ownership_uncertain');
    });
    check('Approve with out-of-range accountIdxs[0] (255) → account_ownership_uncertain (C5 fix)', () => {
        // Pre-fix this slipped through silently (truthy guard); now fails closed.
        const parsed = {
            staticAccountKeys: [BURNER, BURNER_USDC_ATA, TOKEN_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 2,
                accountIdxs: [255], // out of range
                dataBytes: Buffer.from([4, 0]),
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [BURNER_USDC_ATA], { kind: 'jupiter_swap_immediate' });
        assert.strictEqual(r.error, 'account_ownership_uncertain');
    });
    check('CloseAccount with out-of-range accountIdxs[0] → account_ownership_uncertain (C5 fix)', () => {
        const parsed = {
            staticAccountKeys: [BURNER, BURNER_USDC_ATA, TOKEN_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 2,
                accountIdxs: [99],
                dataBytes: Buffer.from([9]),
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [BURNER_USDC_ATA], { kind: 'jupiter_swap_immediate' });
        assert.strictEqual(r.error, 'account_ownership_uncertain');
    });
    check('System::Assign with out-of-range accountIdxs[0] → account_ownership_uncertain (C5 fix)', () => {
        const parsed = {
            staticAccountKeys: [BURNER, SYSTEM_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 1,
                accountIdxs: [42],
                dataBytes: Buffer.from([0x01, 0x00, 0x00, 0x00, ...Buffer.alloc(32)]),
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [BURNER], { kind: 'jupiter_swap_immediate' });
        assert.strictEqual(r.error, 'account_ownership_uncertain');
    });
    check('Q3: drainer re-walk respects combinedAccountKeys length', () => {
        // Re-walk pass uses combinedAccountKeys as `parsed.staticAccountKeys`.
        // An index beyond combined-keys length must reject as
        // account_ownership_uncertain, not silently continue.
        const combinedKeys = [BURNER, BURNER_USDC_ATA, TOKEN_PROGRAM]; // length 3
        const parsedRewalk = {
            staticAccountKeys: combinedKeys,
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 2,
                accountIdxs: [10], // out of range for combined keys (only 3 entries)
                dataBytes: Buffer.from([6, 0]), // SetAuthority
            }],
        };
        const r = policy._validateDrainerOpcodes(parsedRewalk, [BURNER_USDC_ATA], { kind: 'jupiter_swap_immediate' });
        assert.strictEqual(r.error, 'account_ownership_uncertain');
    });

    console.log();
    console.log('BAT-1013-followup C3: sponsored mode signer-count bounds');
    check('sponsored: numRequiredSignatures=0 rejected', () => {
        const sponsoredDelta = {
            kind: 'jupiter_swap_immediate',
            signerMode: 'sponsored',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '1000000' },
            burnerCreditMin: { account: BURNER_USDC_ATA, mint: 'native_sol', atomicAmount: '5000000' },
            toleranceBps: 100,
            feePayerAllowlist: [FACILITATOR],
            cosignerAllowlist: [],
        };
        const r = policy._validateSignerMode(
            { staticAccountKeys: [FACILITATOR], numRequiredSignatures: 0 },
            BURNER, sponsoredDelta);
        assert.strictEqual(r.error, 'signer_count_mismatch');
    });
    check('sponsored: numRequiredSignatures=17 rejected (above Solana cap of 16)', () => {
        const sponsoredDelta = {
            kind: 'jupiter_swap_immediate',
            signerMode: 'sponsored',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '1000000' },
            burnerCreditMin: { account: BURNER_USDC_ATA, mint: 'native_sol', atomicAmount: '5000000' },
            toleranceBps: 100,
            feePayerAllowlist: [FACILITATOR],
            cosignerAllowlist: [],
        };
        const keys = [FACILITATOR, BURNER];
        for (let i = 0; i < 15; i++) keys.push(`KEY${i.toString().padStart(2, '0')}XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXz`);
        const r = policy._validateSignerMode(
            { staticAccountKeys: keys.slice(0, 17), numRequiredSignatures: 17 },
            BURNER, sponsoredDelta);
        assert.strictEqual(r.error, 'signer_count_mismatch');
        assert.match(r.reason, /16|cap/);
    });

    console.log();
    console.log('BAT-1013-followup C4: cosigned mode invariant — burner not in feePayerAllowlist');
    check('Codex v8.4 amendment 3: cosigned happy path — fee payer in feePayerAllowlist accepts', () => {
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
        assert.strictEqual(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
    });

    check('Codex v8.4 amendment 3: cosigned fee payer NOT in feePayerAllowlist REJECTS even if cosignerAllowlist contains it', () => {
        // The "fee payer in either allowlist" loosening is rejected by Codex
        // when feePayerAllowlist is present — it MUST be authoritative.
        const ALT_FACILITATOR = 'AltFaciLitatorXXXXXXXXXXXXXXXXXXXXXXXXXXXXz';
        const x402Delta = {
            kind: 'agent_pay_x402',
            x402Version: 2,
            signerMode: 'cosigned',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '10000' },
            recipient: { account: RECIPIENT_USDC_ATA, mint: USDC },
            feePayerAllowlist: [FACILITATOR],         // only FACILITATOR allowed as fee payer
            cosignerAllowlist: [FACILITATOR, ALT_FACILITATOR], // ALT_FACILITATOR in cosigner list
        };
        // Tx places ALT_FACILITATOR at slot 0 (fee payer). cosigner list
        // contains it, but feePayerAllowlist is authoritative → REJECT.
        const r = policy._validateSignerMode(
            { staticAccountKeys: [ALT_FACILITATOR, BURNER], numRequiredSignatures: 2 },
            BURNER, x402Delta);
        assert.strictEqual(r.error, 'fee_payer_not_in_allowlist');
    });

    check('cosigned: burner in feePayerAllowlist rejected (cross-allowlist invariant)', () => {
        const x402Delta = {
            kind: 'agent_pay_x402',
            x402Version: 2,
            signerMode: 'cosigned',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '10000' },
            recipient: { account: RECIPIENT_USDC_ATA, mint: USDC },
            // BURNER incorrectly listed in feePayerAllowlist — should reject.
            feePayerAllowlist: [FACILITATOR, BURNER],
            cosignerAllowlist: [FACILITATOR],
        };
        const r = policy._validateSignerMode(
            { staticAccountKeys: [FACILITATOR, BURNER], numRequiredSignatures: 2 },
            BURNER, x402Delta);
        assert.strictEqual(r.error, 'fee_payer_not_in_allowlist');
        assert.match(r.reason, /burner.*must NOT appear in feePayerAllowlist|invariant/i);
    });

    console.log();
    console.log('BAT-1013-followup C11: sponsored mode happy + reject paths');
    const sponsoredHappyDelta = {
        kind: 'jupiter_swap_immediate',
        signerMode: 'sponsored',
        burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '1000000' },
        burnerCreditMin: { account: BURNER_USDC_ATA, mint: 'native_sol', atomicAmount: '5000000' },
        toleranceBps: 100,
        feePayerAllowlist: [FACILITATOR],
        cosignerAllowlist: [],
    };
    check('sponsored happy path: facilitator pays fees, burner co-signs', () => {
        const r = policy._validateSignerMode(
            { staticAccountKeys: [FACILITATOR, BURNER], numRequiredSignatures: 2 },
            BURNER, sponsoredHappyDelta);
        assert.strictEqual(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
    });
    check('sponsored reject: fee_payer not in allowlist', () => {
        const r = policy._validateSignerMode(
            { staticAccountKeys: [ALT_PUBKEY, BURNER], numRequiredSignatures: 2 },
            BURNER, sponsoredHappyDelta);
        assert.strictEqual(r.error, 'fee_payer_not_in_allowlist');
    });
    check('sponsored reject: burner not in required-signer set', () => {
        const r = policy._validateSignerMode(
            { staticAccountKeys: [FACILITATOR, ALT_PUBKEY], numRequiredSignatures: 2 },
            BURNER, sponsoredHappyDelta);
        assert.strictEqual(r.error, 'burner_not_signer');
    });
    check('sponsored reject: unknown additional signer', () => {
        const r = policy._validateSignerMode(
            { staticAccountKeys: [FACILITATOR, BURNER, ALT_PUBKEY], numRequiredSignatures: 3 },
            BURNER, sponsoredHappyDelta);
        assert.strictEqual(r.error, 'cosigner_not_in_allowlist');
    });

    console.log();
    console.log('BAT-1013-followup B1: Jupiter Ultra wSOL ATA close exemption');
    // wSOL ATA exemption shape validation
    check('wsolAtaExemption shape: missing ata rejected', () => {
        const r = policy._validateExpectedDeltaShape({
            kind: 'jupiter_swap_immediate',
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER, mint: 'native_sol', atomicAmount: '1000000' },
            burnerCreditMin: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '5000000' },
            toleranceBps: 100,
            wsolAtaExemption: { destination: BURNER }, // missing ata
        });
        assert.strictEqual(r.error, 'expected_delta_invalid_shape');
        assert.match(r.reason, /wsolAtaExemption\.ata/);
    });
    check('wsolAtaExemption shape: missing destination rejected', () => {
        const r = policy._validateExpectedDeltaShape({
            kind: 'jupiter_swap_immediate',
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER, mint: 'native_sol', atomicAmount: '1000000' },
            burnerCreditMin: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '5000000' },
            toleranceBps: 100,
            wsolAtaExemption: { ata: BURNER_USDC_ATA },
        });
        assert.strictEqual(r.error, 'expected_delta_invalid_shape');
        assert.match(r.reason, /wsolAtaExemption\.destination/);
    });
    check('wsolAtaExemption shape: well-formed accepted', () => {
        const r = policy._validateExpectedDeltaShape({
            kind: 'jupiter_swap_immediate',
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER, mint: 'native_sol', atomicAmount: '1000000' },
            burnerCreditMin: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '5000000' },
            toleranceBps: 100,
            wsolAtaExemption: { ata: BURNER_USDC_ATA, destination: BURNER },
        });
        assert.strictEqual(r.ok, true);
    });
    // Drainer-walk: CloseAccount with declared exemption accepted
    check('drainer-walk: wSOL ATA CloseAccount (target=ata, dest=burner, auth=burner) ACCEPTED with exemption', () => {
        const WSOL_ATA = 'WSoBurNerAtaXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXz';
        const parsed = {
            staticAccountKeys: [BURNER, WSOL_ATA, TOKEN_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 2,
                accountIdxs: [1, 0, 0], // target=WSOL_ATA, destination=BURNER, authority=BURNER
                dataBytes: Buffer.from([9]),
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [WSOL_ATA], {
            kind: 'jupiter_swap_immediate',
            wsolAtaExemption: { ata: WSOL_ATA, destination: BURNER },
        }, BURNER);
        assert.strictEqual(r.ok, true, `expected accept, got ${JSON.stringify(r)}`);
    });
    check('drainer-walk: wSOL ATA CloseAccount to ATTACKER (not burner) REJECTED even with exemption', () => {
        const WSOL_ATA = 'WSoBurNerAtaXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXz';
        const ATTACKER = 'AttacKerXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXz';
        const parsed = {
            staticAccountKeys: [BURNER, WSOL_ATA, TOKEN_PROGRAM, ATTACKER],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 2,
                accountIdxs: [1, 3, 0], // destination=ATTACKER, not BURNER
                dataBytes: Buffer.from([9]),
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [WSOL_ATA], {
            kind: 'jupiter_swap_immediate',
            wsolAtaExemption: { ata: WSOL_ATA, destination: BURNER },
        }, BURNER);
        assert.strictEqual(r.error, 'drainer_close_account');
    });
    check('Codex v8.4 amendment 1: wSOL CloseAccount with wrong close-authority REJECTED even with exemption', () => {
        // Without the authority check, an authority hijacked to a relayer
        // could redirect rent. Authority MUST be the burner.
        const WSOL_ATA = 'WSoBurNerAtaXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXz';
        const RELAYER = 'ReLayerXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXz';
        const parsed = {
            staticAccountKeys: [BURNER, WSOL_ATA, TOKEN_PROGRAM, RELAYER],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 2,
                accountIdxs: [1, 0, 3], // target=WSOL_ATA, dest=BURNER, authority=RELAYER (wrong!)
                dataBytes: Buffer.from([9]),
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [WSOL_ATA], {
            kind: 'jupiter_swap_immediate',
            wsolAtaExemption: { ata: WSOL_ATA, destination: BURNER },
        }, BURNER);
        assert.strictEqual(r.error, 'drainer_close_account');
    });

    check('Codex v8.4 amendment 1: wSOL exemption declared on SPL→SPL swap (no native SOL) still rejects unrelated CloseAccount', () => {
        // Exemption declared on a swap that has no native-SOL wrap/unwrap
        // intent. A CloseAccount on a DIFFERENT burner-owned ATA must still
        // reject — the exemption only matches the declared ata+dest+authority.
        const REAL_WSOL_ATA = 'WSoBurNerAtaXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXz';
        const VICTIM_ATA = 'VictiMSpLAtaXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXz';
        const parsed = {
            staticAccountKeys: [BURNER, VICTIM_ATA, TOKEN_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 2,
                accountIdxs: [1, 0, 0], // close VICTIM_ATA (not the declared wsol ATA)
                dataBytes: Buffer.from([9]),
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [VICTIM_ATA], {
            kind: 'jupiter_swap_immediate',
            wsolAtaExemption: { ata: REAL_WSOL_ATA, destination: BURNER },
        }, BURNER);
        assert.strictEqual(r.error, 'drainer_close_account');
    });

    check('drainer-walk: wSOL exemption is SINGLE-FIRE — second matching CloseAccount REJECTED (B1 replay defense)', () => {
        // A malicious tx attaching TWO CloseAccount(WSOL_ATA, dest=BURNER)
        // instructions would otherwise both fall through the exemption
        // continue branch. The exemption is documented as covering exactly
        // ONE legitimate Jupiter Ultra unwrap; second use is replay.
        const WSOL_ATA = 'WSoBurNerAtaXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXz';
        const parsed = {
            staticAccountKeys: [BURNER, WSOL_ATA, TOKEN_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [
                { programIdIdx: 2, accountIdxs: [1, 0, 0], dataBytes: Buffer.from([9]) },
                { programIdIdx: 2, accountIdxs: [1, 0, 0], dataBytes: Buffer.from([9]) }, // replay
            ],
        };
        const r = policy._validateDrainerOpcodes(parsed, [WSOL_ATA], {
            kind: 'jupiter_swap_immediate',
            wsolAtaExemption: { ata: WSOL_ATA, destination: BURNER },
        }, BURNER);
        assert.strictEqual(r.error, 'drainer_close_account');
    });
    check('drainer-walk: wSOL ATA CloseAccount on DIFFERENT ATA (not declared) REJECTED', () => {
        const WSOL_ATA = 'WSoBurNerAtaXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXz';
        const OTHER_ATA = 'OtherBurNerAtaXXXXXXXXXXXXXXXXXXXXXXXXXXXXz';
        const parsed = {
            staticAccountKeys: [BURNER, OTHER_ATA, TOKEN_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 2,
                accountIdxs: [1, 0, 0],
                dataBytes: Buffer.from([9]),
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [OTHER_ATA], {
            kind: 'jupiter_swap_immediate',
            wsolAtaExemption: { ata: WSOL_ATA, destination: BURNER }, // declared for different ATA
        }, BURNER);
        assert.strictEqual(r.error, 'drainer_close_account');
    });
    check('drainer-walk: CloseAccount without exemption declared still REJECTED in jupiter_swap_immediate', () => {
        const WSOL_ATA = 'WSoBurNerAtaXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXz';
        const parsed = {
            staticAccountKeys: [BURNER, WSOL_ATA, TOKEN_PROGRAM],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 2,
                accountIdxs: [1, 0, 0],
                dataBytes: Buffer.from([9]),
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [WSOL_ATA], {
            kind: 'jupiter_swap_immediate',
            // no wsolAtaExemption declared
        });
        assert.strictEqual(r.error, 'drainer_close_account');
    });

    console.log();
    console.log('BAT-1013-followup C15: toleranceBps boundary');
    check('toleranceBps=200 (max) accepted', () => {
        const r = policy._validateExpectedDeltaShape({
            kind: 'jupiter_swap_immediate',
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '1000000' },
            burnerCreditMin: { account: BURNER_USDC_ATA, mint: 'native_sol', atomicAmount: '5000000' },
            toleranceBps: 200,
        });
        assert.strictEqual(r.ok, true);
    });
    check('toleranceBps=201 (above max) rejected', () => {
        const r = policy._validateExpectedDeltaShape({
            kind: 'jupiter_swap_immediate',
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '1000000' },
            burnerCreditMin: { account: BURNER_USDC_ATA, mint: 'native_sol', atomicAmount: '5000000' },
            toleranceBps: 201,
        });
        assert.strictEqual(r.error, 'expected_delta_invalid_shape');
        assert.match(r.reason, /toleranceBps|200|maximum/i);
    });
    check('toleranceBps=10000 (100%) rejected — would create zero floor', () => {
        const r = policy._validateExpectedDeltaShape({
            kind: 'jupiter_swap_immediate',
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '1000000' },
            burnerCreditMin: { account: BURNER_USDC_ATA, mint: 'native_sol', atomicAmount: '5000000' },
            toleranceBps: 10000,
        });
        assert.strictEqual(r.error, 'expected_delta_invalid_shape');
    });
    // Internal applyTolerance boundary tests
    check('applyTolerance: gte_min_minus_bps observed=floor accepted', () => {
        // minRequired=1000, bps=100 → floor = 1000 * 9900/10000 = 990
        // observed=990 must accept (>= floor)
        const r = policy._applyTolerance(990n, 1000n,
            { mode: 'gte_min_minus_bps', minRequired: 1000n, bps: 100n }, USDC);
        assert.strictEqual(r, null);
    });
    check('applyTolerance: gte_min_minus_bps observed=floor-1 (1 atomic below) REJECTED', () => {
        // minRequired=1000, bps=100 → floor = 990; observed=989 rejects.
        const r = policy._applyTolerance(989n, 1000n,
            { mode: 'gte_min_minus_bps', minRequired: 1000n, bps: 100n }, USDC);
        assert.notStrictEqual(r, null);
        assert.match(r.reason, /below floor/);
    });
    check('applyTolerance: 51bps tolerance accepts 50bps shortfall', () => {
        // minRequired=1_000_000, observed=995_000 (50bps shortfall).
        // With tolerance bps=51, floor = 1000000 * 9949/10000 = 994900 → 995000 accepted.
        const r = policy._applyTolerance(995_000n, 1_000_000n,
            { mode: 'gte_min_minus_bps', minRequired: 1_000_000n, bps: 51n }, USDC);
        assert.strictEqual(r, null);
    });
    check('applyTolerance: 49bps tolerance rejects 50bps shortfall', () => {
        // Tolerance bps=49, floor = 1000000 * 9951/10000 = 995100 → 995000 rejects.
        const r = policy._applyTolerance(995_000n, 1_000_000n,
            { mode: 'gte_min_minus_bps', minRequired: 1_000_000n, bps: 49n }, USDC);
        assert.notStrictEqual(r, null);
        assert.match(r.reason, /below floor/);
    });

    console.log();
    console.log('BAT-1013-followup C14: SPL_MINT_AGNOSTIC behavior');
    await runAsync('C14: zero_value_auth with both pre/post splToken metadata + zero delta → ACCEPT', async () => {
        const BURNER_ALT_ATA = 'BurNerAuxAtaXXXXXXXXXXXXXXXXXXXXXXXXXXXXXz';
        const txB64 = buildTx({
            accountKeys: [BURNER, JUPITER_V6, BURNER_ALT_ATA],
            numRequiredSignatures: 1,
            instructions: [{ programIdIdx: 1, accountIdxs: [0], dataBytes: Buffer.from([0xAB]) }],
        });
        const simulator = mockSimulator({
            accounts: {
                [BURNER]: {
                    pre: nativeAccountInfo({ lamports: 2_000_000_000 }),
                    post: nativeAccountInfo({ lamports: 1_999_995_000 }),
                },
                // Burner-owned token account whose AMOUNT is unchanged.
                // Mint can be ANYTHING (SPL_MINT_AGNOSTIC skips the mint
                // match check); amount delta=0 satisfies "exact" tolerance.
                [BURNER_ALT_ATA]: {
                    pre: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '500' }),
                    post: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '500' }),
                },
            },
        });
        const r = await policy.validateBurnerTx(txB64, {
            kind: 'zero_value_auth',
            signerMode: 'burner_only',
            allowedInstructionClasses: ['memo'],
            burnerOwnedAccounts: [BURNER_ALT_ATA],
        }, { burnerPubkey: BURNER, simulator });
        assert.strictEqual(r.ok, true, `expected accept, got ${JSON.stringify(r)}`);
    });
    await runAsync('C14: zero_value_auth with SPL_MINT_AGNOSTIC + non-zero delta → REJECT', async () => {
        const BURNER_ALT_ATA = 'BurNerAuxAtaXXXXXXXXXXXXXXXXXXXXXXXXXXXXXz';
        const txB64 = buildTx({
            accountKeys: [BURNER, JUPITER_V6, BURNER_ALT_ATA],
            numRequiredSignatures: 1,
            instructions: [{ programIdIdx: 1, accountIdxs: [0], dataBytes: Buffer.from([0xAB]) }],
        });
        const simulator = mockSimulator({
            accounts: {
                [BURNER]: {
                    pre: nativeAccountInfo({ lamports: 2_000_000_000 }),
                    post: nativeAccountInfo({ lamports: 1_999_995_000 }),
                },
                [BURNER_ALT_ATA]: {
                    pre: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '500' }),
                    post: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '100' }),
                },
            },
        });
        const r = await policy.validateBurnerTx(txB64, {
            kind: 'zero_value_auth',
            signerMode: 'burner_only',
            allowedInstructionClasses: ['memo'],
            burnerOwnedAccounts: [BURNER_ALT_ATA],
        }, { burnerPubkey: BURNER, simulator });
        assert.strictEqual(r.error, 'simulation_delta_mismatch');
    });

    console.log();
    console.log('BAT-1013-followup C7: burner-native-SOL floor on SPL-input flows');
    await runAsync('C7: SPL-input swap with hidden SOL drain → simulation_delta_mismatch', async () => {
        // Burner SPL debit/credit look correct, but tx drains 50M lamports of
        // native SOL (way past 10M fee headroom). Pre-fix this would have
        // passed because there was no burner-native-SOL check on SPL-input
        // swaps. With C7 in place, the burnerSolFloor check rejects.
        const txB64 = buildTx({
            accountKeys: [BURNER, JUPITER_V6, BURNER_USDC_ATA],
            numRequiredSignatures: 1,
            instructions: [{ programIdIdx: 1, accountIdxs: [0, 2], dataBytes: Buffer.from([0xAB]) }],
        });
        const simulator = mockSimulator({
            accounts: {
                [BURNER]: {
                    // 50M lamport drain — way above 10M headroom
                    pre: nativeAccountInfo({ lamports: 2_000_000_000 }),
                    post: nativeAccountInfo({ lamports: 1_950_000_000 }),
                },
                [BURNER_USDC_ATA]: {
                    pre: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '1000000' }),
                    post: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '0' }),
                },
                // burnerCreditMin uses a different ATA so the SPL credit
                // check doesn't collide with the burner-system check.
                [RECIPIENT_USDC_ATA]: {
                    pre: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '0' }),
                    post: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '5000000' }),
                },
            },
        });
        const r = await policy.validateBurnerTx(txB64, {
            kind: 'jupiter_swap_immediate',
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '1000000' },
            burnerCreditMin: { account: RECIPIENT_USDC_ATA, mint: USDC, atomicAmount: '5000000' },
            burnerOwnedAccounts: [BURNER_USDC_ATA, RECIPIENT_USDC_ATA],
            toleranceBps: 100,
        }, { burnerPubkey: BURNER, simulator });
        assert.strictEqual(r.error, 'simulation_delta_mismatch');
        assert.strictEqual(r.class, 'security');
    });
    await runAsync('C7: SPL-input swap within fee headroom → ACCEPT', async () => {
        // 5000 lamport drain (typical Solana base fee) — within 10M headroom.
        const txB64 = buildTx({
            accountKeys: [BURNER, JUPITER_V6, BURNER_USDC_ATA],
            numRequiredSignatures: 1,
            instructions: [{ programIdIdx: 1, accountIdxs: [0, 2], dataBytes: Buffer.from([0xAB]) }],
        });
        const simulator = mockSimulator({
            accounts: {
                [BURNER]: {
                    pre: nativeAccountInfo({ lamports: 2_000_000_000 }),
                    post: nativeAccountInfo({ lamports: 1_999_995_000 }),
                },
                [BURNER_USDC_ATA]: {
                    pre: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '1000000' }),
                    post: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '0' }),
                },
                [RECIPIENT_USDC_ATA]: {
                    pre: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '0' }),
                    post: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '5000000' }),
                },
            },
        });
        const r = await policy.validateBurnerTx(txB64, {
            kind: 'jupiter_swap_immediate',
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '1000000' },
            burnerCreditMin: { account: RECIPIENT_USDC_ATA, mint: USDC, atomicAmount: '5000000' },
            burnerOwnedAccounts: [BURNER_USDC_ATA, RECIPIENT_USDC_ATA],
            toleranceBps: 100,
        }, { burnerPubkey: BURNER, simulator });
        assert.strictEqual(r.ok, true, `expected accept, got ${JSON.stringify(r)}`);
    });

    console.log();
    console.log('BAT-1013-followup Q9: x402 v1 happy path end-to-end');
    await runAsync('Q9: x402 v1 burner-only USDC payment → ACCEPT', async () => {
        // v1 x402 is a single-signer USDC transfer from burner ATA to
        // recipient ATA. signerMode=burner_only; legacy SPL (no
        // tokenStandard). This is the happy path baseline that confirms
        // the new C6 / C7 checks don't break legacy x402 v1 flows.
        const txB64 = buildTx({
            accountKeys: [BURNER, TOKEN_PROGRAM, BURNER_USDC_ATA, RECIPIENT_USDC_ATA],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 1, // TOKEN_PROGRAM
                accountIdxs: [2, 3, 0], // source=BURNER_USDC_ATA, dest=RECIPIENT_USDC_ATA, authority=BURNER
                dataBytes: Buffer.from([3, 16, 39, 0, 0, 0, 0, 0, 0]), // Transfer + amount=10000
            }],
        });
        const simulator = mockSimulator({
            accounts: {
                [BURNER]: {
                    pre: nativeAccountInfo({ lamports: 2_000_000_000 }),
                    post: nativeAccountInfo({ lamports: 1_999_995_000 }),
                },
                [BURNER_USDC_ATA]: {
                    pre: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '20000' }),
                    post: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '10000' }),
                },
                [RECIPIENT_USDC_ATA]: {
                    pre: splTokenAccountInfo({ mint: USDC, owner: FACILITATOR, amountAtomic: '0' }),
                    post: splTokenAccountInfo({ mint: USDC, owner: FACILITATOR, amountAtomic: '10000' }),
                },
            },
        });
        const r = await policy.validateBurnerTx(txB64, {
            kind: 'agent_pay_x402',
            x402Version: 1,
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '10000' },
            recipient: { account: RECIPIENT_USDC_ATA, mint: USDC },
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

    // ── BAT-1013 foundation patch: solana_send self-send guard ──────────
    // Pre-fix: shape validator passed self-send through to simulation,
    // which returned cryptic AccountLoadedTwice. Post-fix: rejects at
    // shape validation with expected_delta_invalid_shape (contract_gap).
    console.log();
    console.log('Foundation patch: self-send guards (PR #398)');

    check('solana_send self-send REJECTED when burnerDebit.account === recipient.account', () => {
        const r = policy._validateExpectedDeltaShape({
            kind: 'solana_send',
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER, mint: 'native_sol', atomicAmount: '1000000' },
            recipient: { account: BURNER, mint: 'native_sol' },
        });
        assert.strictEqual(r.ok, false, `expected reject, got ${JSON.stringify(r)}`);
        assert.strictEqual(r.error, 'expected_delta_invalid_shape');
        assert.match(r.reason, /self-send/i);
    });

    check('solana_send distinct addresses ACCEPTED (regression guard)', () => {
        const r = policy._validateExpectedDeltaShape({
            kind: 'solana_send',
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER, mint: 'native_sol', atomicAmount: '1000000' },
            recipient: { account: BURNER_USDC_ATA, mint: 'native_sol' },
        });
        assert.strictEqual(r.ok, true, `expected accept for distinct addresses, got ${JSON.stringify(r)}`);
    });

    check('agent_pay_x402 self-send REJECTED (mirrored guard for x402)', () => {
        const r = policy._validateExpectedDeltaShape({
            kind: 'agent_pay_x402',
            x402Version: 1,
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '10000' },
            recipient: { account: BURNER_USDC_ATA, mint: USDC },
            burnerOwnedAccounts: [BURNER_USDC_ATA],
            allowMemo: true,
        });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, 'expected_delta_invalid_shape');
        assert.match(r.reason, /self-send/i);
    });

    // ── R-next-8: SPL Transfer authority-based drainer check ───────────
    // Pre-fix: zero_value Transfer/TransferChecked guard only fired when the
    // source account was in burnerOwnedAccounts. A caller who forgot to
    // include their burner ATA in the list could let a malicious zero-value
    // tx drain tokens. Post-fix: guard ALSO fires when the burner is the
    // Transfer's authority (chain-enforced semantic; cannot be forgotten).
    check('R-next-8: zero_value_auth SPL Transfer rejected via AUTHORITY check even when burnerOwnedAccounts is EMPTY', () => {
        // TRANSFER opcode = 3, accountIdxs = [source, dest, authority]
        // Source: a token account NOT in burnerOwnedAccounts (caller forgot)
        // Authority: BURNER pubkey (chain enforces — this is what catches it)
        const SOURCE_FORGOTTEN_ATA = 'F0rg0ttenAtA111111111111111111111111111111';
        const DEST = 'AttackerDest111111111111111111111111111111';
        const parsed = {
            staticAccountKeys: [BURNER, TOKEN_PROGRAM, SOURCE_FORGOTTEN_ATA, DEST],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 1, // TOKEN_PROGRAM
                accountIdxs: [2, 3, 0], // [source, dest, authority=BURNER]
                dataBytes: Buffer.from([0x03, ...Buffer.alloc(8)]), // Transfer opcode + amount
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [/* CALLER FORGOT */], {
            kind: 'zero_value_auth',
        }, BURNER);
        assert.strictEqual(r.ok, false,
            `expected reject via authority check even with empty burnerOwnedAccounts, got ${JSON.stringify(r)}`);
        assert.strictEqual(r.error, 'drainer_approve');
        assert.match(r.reason, /transfer authority/i);
    });

    check('R-next-8: zero_value_cancel SPL TransferChecked still allowed when source is in allowedTransferAccounts', () => {
        // Regression: the allowlist semantic for cancel flows must continue
        // to work post-fix. burner is authority, source is whitelisted.
        const SOURCE = 'SourceAtA1111111111111111111111111111111111';
        const DEST = 'OrderVault11111111111111111111111111111111';
        const parsed = {
            staticAccountKeys: [BURNER, TOKEN_PROGRAM, SOURCE, USDC, DEST],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 1,
                accountIdxs: [2, 3, 4, 0], // [source, mint, dest, authority=BURNER]
                // TransferChecked opcode = 12 (0x0c) + u64 amount + u8 decimals
                dataBytes: Buffer.from([0x0c, ...Buffer.alloc(8), 6]),
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [], {
            kind: 'zero_value_cancel',
            allowedTransferAccounts: [SOURCE], // explicitly declared by caller
        }, BURNER);
        assert.strictEqual(r.ok, true,
            `allowedTransferAccounts must still permit declared sources, got ${JSON.stringify(r)}`);
    });

    check('R-next-8: zero_value_auth SPL Transfer where burner is NOT authority is NOT rejected', () => {
        // Regression: when burner is not the authority (someone else's wallet
        // is doing the transfer), the guard must NOT fire — that transfer is
        // not the burner's concern.
        const OTHER_WALLET = '0thrWa11et1111111111111111111111111111111111';
        const SOURCE = 'OtherSourc31111111111111111111111111111111';
        const DEST = 'OtherDest1111111111111111111111111111111111';
        const parsed = {
            staticAccountKeys: [BURNER, TOKEN_PROGRAM, SOURCE, DEST, OTHER_WALLET],
            numRequiredSignatures: 1,
            instructions: [{
                programIdIdx: 1,
                accountIdxs: [2, 3, 4], // [source, dest, authority=OTHER_WALLET]
                dataBytes: Buffer.from([0x03, ...Buffer.alloc(8)]),
            }],
        };
        const r = policy._validateDrainerOpcodes(parsed, [], {
            kind: 'zero_value_auth',
        }, BURNER);
        assert.strictEqual(r.ok, true,
            `non-burner-authority transfers must not be rejected, got ${JSON.stringify(r)}`);
    });

    // ── R-next-7: SPL-decode-fail-closed in validateSimDelta ────────
    // Pre-fix: when a required SPL-token account EXISTS but the data
    // can't be decoded (e.g. Token-2022 with extensions our decoder
    // doesn't recognize), tokenDelta() returned 0 / create / close
    // semantics silently. The policy then accepted a state we couldn't
    // actually verify. Post-fix: reject as simulation_metadata_missing
    // (availability class) so the agent can offer MWA fallback.
    function nonDecodableSplAccountInfo({ lamports = 2_039_280 }) {
        // Account exists, has SPL Token Program as owner, but data buffer
        // is too short (< 72 bytes) to decode as SPL Token account.
        return {
            lamports,
            owner: TOKEN_PROGRAM,
            data: [Buffer.alloc(40).toString('base64'), 'base64'], // 40 bytes, decoder needs ≥72
            executable: false,
            rentEpoch: 0,
        };
    }

    await runAsync('R-next-7: SPL account exists but PRE not decodable → simulation_metadata_missing', async () => {
        const txB64 = buildTx({
            accountKeys: [BURNER, JUPITER_V6, BURNER_USDC_ATA],
            numRequiredSignatures: 1,
            instructions: [{ programIdIdx: 1, accountIdxs: [0, 2], dataBytes: Buffer.from([0xAB]) }],
        });
        const simulator = mockSimulator({
            accounts: {
                [BURNER_USDC_ATA]: {
                    pre: nonDecodableSplAccountInfo({}), // exists, undecodable
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
        assert.strictEqual(r.ok, false, `expected reject, got ${JSON.stringify(r)}`);
        assert.strictEqual(r.error, 'simulation_metadata_missing');
        assert.match(r.reason, /pre.*not decodable as SPL Token/i);
        assert.strictEqual(r.class, 'availability');
    });

    await runAsync('R-next-7: SPL account exists but POST not decodable → simulation_metadata_missing', async () => {
        const txB64 = buildTx({
            accountKeys: [BURNER, JUPITER_V6, BURNER_USDC_ATA],
            numRequiredSignatures: 1,
            instructions: [{ programIdIdx: 1, accountIdxs: [0, 2], dataBytes: Buffer.from([0xAB]) }],
        });
        const simulator = mockSimulator({
            accounts: {
                [BURNER_USDC_ATA]: {
                    pre: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '1000000' }),
                    post: nonDecodableSplAccountInfo({}), // exists, undecodable
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
        assert.strictEqual(r.ok, false, `expected reject, got ${JSON.stringify(r)}`);
        assert.strictEqual(r.error, 'simulation_metadata_missing');
        assert.match(r.reason, /post.*not decodable as SPL Token/i);
    });

    await runAsync('R-next-7: happy-path with BOTH pre/post decodable → NOT over-rejected', async () => {
        // Regression guard #1: the new guard must NOT over-reject the
        // standard happy path where both pre and post are fully decodable.
        // Confirms the guard's condition (`exists && !splToken`) doesn't
        // misfire when splToken IS present.
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
        });
        const r = await policy.validateBurnerTx(txB64, {
            kind: 'jupiter_swap_immediate',
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '1000000' },
            burnerCreditMin: { account: BURNER, mint: 'native_sol', atomicAmount: '500000' },
            burnerOwnedAccounts: [BURNER_USDC_ATA],
            toleranceBps: 100,
        }, { burnerPubkey: BURNER, simulator });
        assert.strictEqual(r.ok, true, `decode guard must NOT over-reject legitimate happy path, got ${JSON.stringify(r)}`);
    });

    await runAsync('R-next-7: pre=null (legitimate ATA-create) → NOT triggered by decode guard', async () => {
        // Regression guard #2: when pre.exists=false (legit ATA create
        // before the swap), the new guard's `preAI.exists && !preAI.splToken`
        // short-circuits on the `exists` check — never reaches the
        // !splToken branch. Uses jupiter_trigger_create_deposit which
        // declares allowCreate on the depositVault so pre=null is
        // legitimate, and the only burner-debit account has a normal
        // pre to satisfy the burnerDebit mustExistBefore policy.
        const VAULT_ATA = 'VauLtAtA111111111111111111111111111111111111';
        const txB64 = buildTx({
            accountKeys: [BURNER, JUPITER_LIMIT_ORDER_V2, BURNER_USDC_ATA, VAULT_ATA],
            numRequiredSignatures: 1,
            instructions: [{ programIdIdx: 1, accountIdxs: [0, 2, 3], dataBytes: Buffer.from([0xAB]) }],
        });
        const simulator = mockSimulator({
            accounts: {
                [BURNER_USDC_ATA]: {
                    pre: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '1000000' }),
                    post: splTokenAccountInfo({ mint: USDC, owner: BURNER, amountAtomic: '0' }),
                },
                [VAULT_ATA]: {
                    // pre = null = ATA didn't exist — this is the case the
                    // decode guard must NOT mis-trigger on.
                    pre: null,
                    post: splTokenAccountInfo({ mint: USDC, owner: JUPITER_LIMIT_ORDER_V2, amountAtomic: '1000000' }),
                },
                [BURNER]: {
                    pre: nativeAccountInfo({ lamports: 2_000_000_000 }),
                    post: nativeAccountInfo({ lamports: 1_999_995_000 }),
                },
            },
        });
        const r = await policy.validateBurnerTx(txB64, {
            kind: 'jupiter_trigger_create_deposit',
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC, atomicAmount: '1000000' },
            depositVault: { pubkey: VAULT_ATA, expectedOwner: JUPITER_LIMIT_ORDER_V2, mint: USDC, atomicAmount: '1000000' },
            burnerOwnedAccounts: [BURNER_USDC_ATA],
            toleranceBps: 100,
        }, { burnerPubkey: BURNER, simulator });
        // The test accepts EITHER r.ok===true (full validation passed) OR a
        // reject reason that is NOT 'simulation_metadata_missing' caused by
        // our new guard. Any "not decodable" mention in the reason fails
        // this test — the guard fired on a pre=null account.
        if (!r.ok) {
            assert.ok(
                !/not decodable as SPL Token/i.test(r.reason || ''),
                `decode guard should not fire on pre=null; got reason: ${r.reason}`,
            );
        }
    });

    // ─── BAT-1024: Custom:N decoder + sim.logs surfacing ────────────────────
    //
    // Caught during BAT-1013 device test 2026-06-08: burner-policy stringifies
    // sim.value.err and throws away sim.value.logs, leaving the agent with
    // `{"InstructionError":[3,{"Custom":1}]}` and no way to act on it. These
    // tests pin the new decoder + log-surfacing contract.

    const SPL_TOKEN_PID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const TOKEN_2022_PID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
    const SYSTEM_PID = '11111111111111111111111111111111';
    const UNKNOWN_PID = 'UnknownProgram1111111111111111111111111111';

    check('BAT-1024: decodeCustomError SPL Token InsufficientFunds (code 1)', () => {
        const d = policy._decodeCustomError(SPL_TOKEN_PID, 1);
        assert.ok(d, 'expected a decoded entry, got null');
        assert.strictEqual(d.program, 'SPL Token');
        assert.strictEqual(d.name, 'InsufficientFunds');
        assert.match(d.description, /tokens|lamports|rent/i);
    });

    check('BAT-1024: decodeCustomError System Program ResultWithNegativeLamports (code 1)', () => {
        const d = policy._decodeCustomError(SYSTEM_PID, 1);
        assert.ok(d);
        assert.strictEqual(d.program, 'System Program');
        assert.strictEqual(d.name, 'ResultWithNegativeLamports');
    });

    check('BAT-1024: decodeCustomError Token-2022 InsufficientFunds (code 1)', () => {
        const d = policy._decodeCustomError(TOKEN_2022_PID, 1);
        assert.ok(d);
        assert.strictEqual(d.program, 'Token-2022');
        assert.strictEqual(d.name, 'InsufficientFunds');
    });

    check('BAT-1024: decodeCustomError returns null for unknown program', () => {
        const d = policy._decodeCustomError(UNKNOWN_PID, 1);
        assert.strictEqual(d, null);
    });

    check('BAT-1024: decodeCustomError returns null for unknown code in known program', () => {
        // SPL Token tops out at 19 (NonNativeNotSupported) in our table.
        const d = policy._decodeCustomError(SPL_TOKEN_PID, 9999);
        assert.strictEqual(d, null);
    });

    check('BAT-1024: programNameOf names known programs, friendly-trims unknown', () => {
        assert.strictEqual(policy._programNameOf(SPL_TOKEN_PID), 'SPL Token');
        assert.strictEqual(policy._programNameOf(SYSTEM_PID), 'System Program');
        const u = policy._programNameOf(UNKNOWN_PID);
        assert.match(u, /unknown program \(Unkn…1111\)/);
        assert.strictEqual(policy._programNameOf(null), 'unknown program');
        assert.strictEqual(policy._programNameOf(undefined), 'unknown program');
    });

    check('BAT-1024: summarizeSimulationLogs bounds output to last 5 lines, 160 chars each', () => {
        const longLine = 'x'.repeat(500);
        const logs = ['a', 'b', 'c', 'd', 'e', 'f', 'g', longLine];
        const out = policy._summarizeSimulationLogs(logs);
        const lines = out.split('\n  '); // joiner from impl
        assert.strictEqual(lines.length, 5, `expected exactly 5 lines, got ${lines.length}`);
        assert.strictEqual(lines[0], 'd', `first kept line should be "d", got "${lines[0]}"`);
        assert.strictEqual(lines[4].length, 160, `last line (long) should be trimmed to 160, got ${lines[4].length}`);
        assert.ok(lines[4].endsWith('...'), 'long line should be ellipsis-trimmed');
    });

    check('BAT-1024: summarizeSimulationLogs handles empty/missing logs', () => {
        assert.strictEqual(policy._summarizeSimulationLogs(undefined), '');
        assert.strictEqual(policy._summarizeSimulationLogs(null), '');
        assert.strictEqual(policy._summarizeSimulationLogs([]), '');
        assert.strictEqual(policy._summarizeSimulationLogs('not an array'), '');
    });

    check('BAT-1024: formatSimulationErrorReason decodes SPL Token InsufficientFunds AND appends topup suggestion', () => {
        // Today's actual failure: createOrder fails at ix index 3 with SPL Token Custom:1.
        const parsed = {
            staticAccountKeys: [
                'BurnerPubkey1111111111111111111111111111111',
                'UsdcMint111111111111111111111111111111111111',
                'SystemProgram111111111111111111111111111111',
                SPL_TOKEN_PID, // idx 3 — the failing instruction's programIdIdx
                'VaultATA1111111111111111111111111111111111',
            ],
            instructions: [
                { programIdIdx: 2, accountIdxs: [0], dataBytes: Buffer.alloc(0) },
                { programIdIdx: 2, accountIdxs: [0], dataBytes: Buffer.alloc(0) },
                { programIdIdx: 2, accountIdxs: [0], dataBytes: Buffer.alloc(0) },
                { programIdIdx: 3, accountIdxs: [4, 0], dataBytes: Buffer.alloc(0) }, // SPL Token transfer
            ],
        };
        const simValue = {
            err: { InstructionError: [3, { Custom: 1 }] },
            unitsConsumed: 8421,
            logs: [
                'Program 11111111111111111111111111111111 invoke [1]',
                'Program 11111111111111111111111111111111 success',
                `Program ${SPL_TOKEN_PID} invoke [2]`,
                'Program log: Error: insufficient funds',
                `Program ${SPL_TOKEN_PID} failed: custom program error: 0x1`,
            ],
        };
        const reason = policy._formatSimulationErrorReason(simValue, parsed, parsed.staticAccountKeys);
        // Primary decoded line
        assert.match(reason, /SPL Token returned InsufficientFunds \(code 1\)/, `missing primary decoded line: ${reason}`);
        // Topup suggestion (Layer 2)
        assert.match(reason, /burner likely needs SOL top-up/i, `missing topup suggestion: ${reason}`);
        assert.match(reason, /solana_send\(source=main/, `missing actionable solana_send hint: ${reason}`);
        // Units consumed
        assert.match(reason, /unitsConsumed=8421/);
        // Log tail
        assert.match(reason, /logs\[-5\.\.\]:/);
        assert.match(reason, /Program log: Error: insufficient funds/);
        // NO raw InstructionError JSON leaking through
        assert.ok(!/\{"InstructionError"/.test(reason), `raw err JSON leaked: ${reason}`);
    });

    check('BAT-1024: Layer 2 topup hint must NOT fire for SPL Token non-InsufficientFunds codes', () => {
        // Same shape as the SPL Token + Custom:1 case, but Custom:4 (OwnerMismatch)
        // — the decoder must surface the human reason WITHOUT the topup suggestion,
        // because OwnerMismatch isn't fixed by topping up the burner.
        const parsed = {
            staticAccountKeys: ['BurnerPubkey1111111111111111111111111111111', SPL_TOKEN_PID],
            instructions: [{ programIdIdx: 1, accountIdxs: [], dataBytes: Buffer.alloc(0) }],
        };
        const simValue = { err: { InstructionError: [0, { Custom: 4 }] }, logs: [] };
        const reason = policy._formatSimulationErrorReason(simValue, parsed, parsed.staticAccountKeys);
        assert.match(reason, /SPL Token returned OwnerMismatch \(code 4\)/);
        assert.ok(!/top-up|topup/i.test(reason),
            `topup hint must not fire for non-InsufficientFunds codes; got: ${reason}`);
        assert.ok(!/solana_send/.test(reason),
            `solana_send hint must not fire for non-InsufficientFunds codes; got: ${reason}`);
    });

    check('BAT-1024: Layer 2 topup hint must NOT fire for non-token-program InsufficientFunds-equivalent', () => {
        // System Program code 1 = ResultWithNegativeLamports. The decoder
        // should surface the System Program error WITHOUT the SPL-Token
        // topup suggestion (different mitigation: it's an arithmetic issue
        // at the System layer, not always a top-up fix).
        const parsed = {
            staticAccountKeys: [SYSTEM_PID],
            instructions: [{ programIdIdx: 0, accountIdxs: [], dataBytes: Buffer.alloc(0) }],
        };
        const simValue = { err: { InstructionError: [0, { Custom: 1 }] }, logs: [] };
        const reason = policy._formatSimulationErrorReason(simValue, parsed, parsed.staticAccountKeys);
        assert.match(reason, /System Program returned ResultWithNegativeLamports/);
        assert.ok(!/top-up|topup/i.test(reason),
            `topup hint is SPL-Token-specific; got: ${reason}`);
    });

    check('BAT-1024: formatSimulationErrorReason names unknown program when code is unknown', () => {
        const parsed = {
            staticAccountKeys: [UNKNOWN_PID],
            instructions: [{ programIdIdx: 0, accountIdxs: [], dataBytes: Buffer.alloc(0) }],
        };
        const simValue = { err: { InstructionError: [0, { Custom: 42 }] }, logs: [] };
        const reason = policy._formatSimulationErrorReason(simValue, parsed, parsed.staticAccountKeys);
        assert.match(reason, /unknown program \(Unkn…1111\) rejected at instruction 0 with Custom:42/);
    });

    check('BAT-1024: formatSimulationErrorReason falls back gracefully when logs absent', () => {
        const parsed = {
            staticAccountKeys: [SPL_TOKEN_PID],
            instructions: [{ programIdIdx: 0, accountIdxs: [], dataBytes: Buffer.alloc(0) }],
        };
        const simValue = { err: { InstructionError: [0, { Custom: 1 }] } };
        const reason = policy._formatSimulationErrorReason(simValue, parsed, parsed.staticAccountKeys);
        assert.match(reason, /SPL Token returned InsufficientFunds/);
        assert.ok(!/logs\[-5\.\.\]/.test(reason), 'log section should be absent when no logs');
        assert.ok(!/unitsConsumed/.test(reason), 'unitsConsumed section should be absent when missing');
    });

    check('BAT-1024: formatSimulationErrorReason handles non-InstructionError shapes (preserve current behavior)', () => {
        const parsed = { staticAccountKeys: [], instructions: [] };
        const simValue = { err: 'BlockhashNotFound', logs: ['Program 11111 invoke [1]'] };
        const reason = policy._formatSimulationErrorReason(simValue, parsed, []);
        // Falls through to original "simulation failed on-chain: ..." style for unrecognized shapes
        assert.match(reason, /simulation failed on-chain: BlockhashNotFound/);
        // Logs are still appended for diagnostics
        assert.match(reason, /logs\[-5\.\.\]:/);
    });

    check('BAT-1024: formatSimulationErrorReason handles out-of-bounds ix index without throwing', () => {
        const parsed = { staticAccountKeys: [], instructions: [] };
        const simValue = { err: { InstructionError: [99, { Custom: 1 }] }, logs: [] };
        // Should not throw, should preserve original err JSON
        const reason = policy._formatSimulationErrorReason(simValue, parsed, []);
        assert.match(reason, /simulation failed on-chain:/);
    });

    console.log();
    console.log(`Result: ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
    console.log('PASS: burner-policy.test.js');
})();
