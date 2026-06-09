// tests/nodejs-project/burner-policy-carveout.test.js
//
// BAT-1031 v1.2 §3 Gate 0 carve-out boundary regression suite.
//
// Codex sign-off (2026-06-09T10:49) required ALL four cases (A/B/C/D):
//   A — Reference happy path (mirrors 2026-06-09 prod capture)
//   B — Non-zero balance (condition 3 violated)
//   C — Drainer-class op interleaved (condition 4 violated)
//   D — Excess lamport spend (condition 6 violated)
//
// The carve-out is anchored at the instruction-set level — a tx that
// creates a 0-balance WSOL ATA in same tx AND ALSO drains an UNRELATED
// burner-owned ATA gets caught: the drain instruction violates condition 4
// regardless of any carve-out for the unrelated freshly-created ATA.

'use strict';

const assert = require('assert');
const path = require('path');

const { extractTripwires, applyCarveOut, _internals } = require(
    path.resolve(__dirname, '..', 'jupiter-ultra', 'tripwire-extract.js'),
);
const {
    TOKEN_PROGRAM,
    SYSTEM_PROGRAM,
    ATA_PROGRAM,
    ZERO_VALUE_SOL_HEADROOM_LAMPORTS,
} = _internals;

// ── Constants (valid Solana base58, no 0/O/I/l) ───────────────────────────
const BURNER = '221Y7STwi4XC8yzT39p8vuKMa8K5XemoXLeDQcsjP1dd';            // prod capture burner
const BURNER_WSOL_ATA = 'BhbeLQtcVNWmVxexcKoM5oN1WRUEG97VAe1F36GWTtdi';  // prod capture freshly-created WSOL ATA
const BURNER_USDC_ATA = 'B222FF3SVvHbcmmsQehBPnAunenSTWMBJMtAY2MeQvSe';  // prod capture existing burner USDC ATA
const DEPOSIT_VAULT = '4t9ZpxoxA4sStsGEyAiKiuDvrBeXe4CTUnHXve9M22ST';    // prod capture deposit vault
const DEPOSIT_VAULT_USDC_ATA = 'FWrmS4E6Jz4mkyrESBRyZdYRwEcXtmPyRNJHctLoA7a6';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const JUP_V2_PROGRAM = 'j1o2qRpjcyUwEvwtcfhEQefh773ZgjxcVRry7LDqg5X';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const JUP_AUTH = 'jupoNjAxXgZ4rjzxzPMP4oxduvQsQtZzyknqvzYNrNu';
const EVENT_AUTH = 'ArsDfE54RTkC3zhtzPdtvTtKw9XSV5w1PCTBFVGiLd52';
const SLOT_HASHES = '27ZASRjinQgXKsrijKqb9xyRnH6W5KWgLSDveRghvHqc';

// ── Fixture builder: SPL Token Account (165 bytes) ────────────────────────
function splTokenAccountInfo({ mint, owner, amountAtomic, lamports = 2_039_280 }) {
    const buf = Buffer.alloc(165, 0);
    // mint
    const m = _internals.base58Decode(mint);
    m.copy(buf, 0, 0, Math.min(32, m.length));
    // owner
    const o = _internals.base58Decode(owner);
    o.copy(buf, 32, 0, Math.min(32, o.length));
    // amount (u64 LE)
    buf.writeBigUInt64LE(BigInt(amountAtomic), 64);
    return {
        lamports,
        owner: TOKEN_PROGRAM,
        data: [buf.toString('base64'), 'base64'],
        executable: false,
        rentEpoch: 0,
        space: 165,
    };
}

function nativeAccountInfo({ lamports, owner = SYSTEM_PROGRAM }) {
    return {
        lamports,
        owner,
        data: ['', 'base64'],
        executable: false,
        rentEpoch: 0,
        space: 0,
    };
}

// ── Fixture A: happy path (mirrors 2026-06-09 prod capture) ───────────────
//
// requestedAddresses ordering — sim.value.accounts is index-aligned to this.
// IMPORTANT: this MUST mirror the canonical prod-burner capture
// (fixtures/prod-burner-v2-trigger-2026-06-09.json) which requests only
// [BURNER_USDC_ATA, DEPOSIT_VAULT, BURNER]. The freshly-created burner
// WSOL ATA (BURNER_WSOL_ATA) is intentionally NOT in requestedAddresses
// or sim.value.accounts — it is discoverable ONLY via postTokenBalances
// and innerInstructions, matching the on-chain producer behavior. The
// extractor's isPostBurnerOwnedSpl helper falls back to postTokenBalances
// to prove condition 2 in this shape (Copilot R2.3/R2.4).
function buildHappyFixture(overrides) {
    const requestedAddresses = [
        BURNER_USDC_ATA,        // existing burner USDC ATA — debit source
        DEPOSIT_VAULT,          // jupiter limit order v2 deposit vault (Anchor PDA)
        BURNER,                 // burner native SOL
    ];

    const combinedAccountKeys = [
        BURNER,                     // 0 fee payer = burner
        BURNER_WSOL_ATA,            // 1 freshly created
        DEPOSIT_VAULT,              // 2 deposit vault
        DEPOSIT_VAULT_USDC_ATA,     // 3
        BURNER_USDC_ATA,            // 4 existing burner USDC ATA
        COMPUTE_BUDGET,             // 5
        ATA_PROGRAM,                // 6
        WSOL_MINT,                  // 7
        SYSTEM_PROGRAM,             // 8
        TOKEN_PROGRAM,              // 9
        JUP_V2_PROGRAM,             // 10
        SLOT_HASHES,                // 11
        USDC_MINT,                  // 12
        EVENT_AUTH,                 // 13
    ];

    // Inner instructions: ix#2 = setup WSOL ATA; ix#3 = create deposit
    // vault + transferChecked USDC from burner ATA → deposit vault ATA.
    const innerInstructions = [
        {
            index: 2,
            instructions: [
                {
                    parsed: { type: 'getAccountDataSize', info: { extensionTypes: ['immutableOwner'], mint: WSOL_MINT } },
                    program: 'spl-token', programId: TOKEN_PROGRAM, stackHeight: 2,
                },
                {
                    parsed: { type: 'createAccount', info: { lamports: 2_039_280, newAccount: BURNER_WSOL_ATA, owner: TOKEN_PROGRAM, source: BURNER, space: 165 } },
                    program: 'system', programId: SYSTEM_PROGRAM, stackHeight: 2,
                },
                {
                    parsed: { type: 'initializeImmutableOwner', info: { account: BURNER_WSOL_ATA } },
                    program: 'spl-token', programId: TOKEN_PROGRAM, stackHeight: 2,
                },
                {
                    parsed: { type: 'initializeAccount3', info: { account: BURNER_WSOL_ATA, mint: WSOL_MINT, owner: BURNER } },
                    program: 'spl-token', programId: TOKEN_PROGRAM, stackHeight: 2,
                },
            ],
        },
        {
            index: 3,
            instructions: [
                {
                    parsed: { type: 'createAccount', info: { lamports: 3_480_000, newAccount: DEPOSIT_VAULT, owner: JUP_V2_PROGRAM, source: BURNER, space: 372 } },
                    program: 'system', programId: SYSTEM_PROGRAM, stackHeight: 2,
                },
                {
                    parsed: {
                        type: 'create',
                        info: {
                            account: DEPOSIT_VAULT_USDC_ATA,
                            mint: USDC_MINT,
                            source: BURNER,
                            systemProgram: SYSTEM_PROGRAM,
                            tokenProgram: TOKEN_PROGRAM,
                            wallet: DEPOSIT_VAULT,
                        },
                    },
                    program: 'spl-associated-token-account',
                    programId: ATA_PROGRAM,
                    stackHeight: 2,
                },
                {
                    parsed: {
                        type: 'transferChecked',
                        info: {
                            authority: BURNER,
                            destination: DEPOSIT_VAULT_USDC_ATA,
                            mint: USDC_MINT,
                            source: BURNER_USDC_ATA,
                            tokenAmount: { amount: '1000000', decimals: 6, uiAmount: 1, uiAmountString: '1' },
                        },
                    },
                    program: 'spl-token', programId: TOKEN_PROGRAM, stackHeight: 2,
                },
            ],
        },
    ];

    // sim.value.accounts — index-aligned to requestedAddresses. Mirrors
    // canonical prod capture: NO entry for BURNER_WSOL_ATA — the carve-out
    // discovers it via postTokenBalances + innerInstructions instead.
    const accounts = [
        // 0: BURNER_USDC_ATA — existing burner USDC ATA, post-debit balance
        splTokenAccountInfo({ mint: USDC_MINT, owner: BURNER, amountAtomic: '10719298' }),
        // 1: DEPOSIT_VAULT — owned by JUP_V2_PROGRAM (Anchor PDA, 372 bytes)
        { lamports: 3_480_000, owner: JUP_V2_PROGRAM, data: ['', 'base64'], executable: false, rentEpoch: 0, space: 372 },
        // 2: BURNER — native SOL
        nativeAccountInfo({ lamports: 7_294_460 }),
    ];

    // postTokenBalances — declares owner-per-account.
    const postTokenBalances = [
        {
            accountIndex: 1, // BURNER_WSOL_ATA
            mint: WSOL_MINT, owner: BURNER, programId: TOKEN_PROGRAM,
            uiTokenAmount: { amount: '0', decimals: 9, uiAmount: 0, uiAmountString: '0' },
        },
        {
            accountIndex: 3, // DEPOSIT_VAULT_USDC_ATA
            mint: USDC_MINT, owner: DEPOSIT_VAULT, programId: TOKEN_PROGRAM,
            uiTokenAmount: { amount: '1000000', decimals: 6, uiAmount: 1, uiAmountString: '1' },
        },
        {
            accountIndex: 4, // BURNER_USDC_ATA — existing, post-debit balance
            mint: USDC_MINT, owner: BURNER, programId: TOKEN_PROGRAM,
            uiTokenAmount: { amount: '10719298', decimals: 6, uiAmount: 10.719298, uiAmountString: '10.719298' },
        },
    ];

    const preTokenBalances = [
        {
            accountIndex: 4, // BURNER_USDC_ATA — existed pre-tx
            mint: USDC_MINT, owner: BURNER, programId: TOKEN_PROGRAM,
            uiTokenAmount: { amount: '11719298', decimals: 6, uiAmount: 11.719298, uiAmountString: '11.719298' },
        },
    ];

    // Lamport balances — index-aligned to combinedAccountKeys.
    // Burner spent (14_865_720 - 7_294_460) = 7_571_260 lamports — under 10M headroom.
    const preBalances = [
        14_865_720, 0, 0, 0, 2_039_280, 1, 3_388_604_256, 1_527_599_009_066, 1, 43_712_780, 1_141_441, 17_810_858, 508_366_528_745, 1_000_005,
    ];
    const postBalances = [
        7_294_460, 2_039_280, 3_480_000, 2_039_280, 2_039_280, 1, 3_388_604_256, 1_527_599_009_066, 1, 43_712_780, 1_141_441, 17_810_858, 508_366_528_745, 1_000_005,
    ];

    const fixture = {
        bat: 'BAT-1031',
        gate: 0,
        kind: 'jupiter_trigger_create_deposit',
        burnerPubkey: BURNER,
        expectedDelta: {
            kind: 'jupiter_trigger_create_deposit',
            signerMode: 'burner_only',
            burnerDebit: { account: BURNER_USDC_ATA, mint: USDC_MINT, atomicAmount: '1000000' },
            depositVault: { pubkey: DEPOSIT_VAULT, expectedOwner: JUP_AUTH },
            burnerOwnedAccounts: [BURNER_USDC_ATA],
        },
        requestedAddresses,
        combinedAccountKeys,
        signerSetSize: 1,
        signerSetSources: ['fee_payer'],
        sim: {
            context: { apiVersion: '4.0.0', slot: 425307484 },
            value: {
                accounts,
                err: null,
                fee: 12700,
                innerInstructions,
                loadedAccountsDataSize: 737170,
                loadedAddresses: { readonly: [], writable: [] },
                logs: [],
                postBalances,
                postTokenBalances,
                preBalances,
                preTokenBalances,
            },
        },
    };

    if (overrides) overrides(fixture);
    return fixture;
}

// ── Test harness ──────────────────────────────────────────────────────────
// check() is sync-only: the previous Promise-handling branch returned a
// Promise that callers never awaited, so an async invariant could pass
// PASS or be reported after the process printed the summary. If you need
// async, use runAsync() (defined below) which IS properly awaited from
// main(). Copilot R4.2.
let pass = 0, fail = 0;
function check(name, fn) {
    try {
        const r = fn();
        if (r && typeof r.then === 'function') {
            throw new Error(
                `${name}: check() is synchronous-only. Use runAsync(name, async () => { ... }) ` +
                `from main() instead — main() awaits runAsync, but check() returns immediately.`,
            );
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
    console.log('burner-policy-carveout.test.js — BAT-1031 v1.2 §3 Gate 0 carve-out');
    console.log();

    // ── Case A: Reference happy path ───────────────────────────────────────
    console.log('Case A — Reference happy path (mirrors 2026-06-09 prod capture)');
    await runAsync('A: extractTripwires returns all five tripwires', async () => {
        const fx = buildHappyFixture();
        const r = extractTripwires(fx, {
            burnerPubkey: BURNER,
            declaredBurnerOwned: fx.expectedDelta.burnerOwnedAccounts,
        });
        assert.ok(r.t1 && r.t2 && r.t3 && r.t4 && r.t5, 'all five tripwires present');
    });
    check('A: T1 PASS — signer set size === 1 (burner-only)', () => {
        const fx = buildHappyFixture();
        const r = extractTripwires(fx, { burnerPubkey: BURNER, declaredBurnerOwned: [BURNER_USDC_ATA] });
        assert.strictEqual(r.t1.pass, true);
        assert.strictEqual(r.t1.count, 1);
    });
    check('A: T2 PASS — no ALT-resolved burner-owned writables', () => {
        const fx = buildHappyFixture();
        const r = extractTripwires(fx, { burnerPubkey: BURNER, declaredBurnerOwned: [BURNER_USDC_ATA] });
        assert.strictEqual(r.t2.pass, true);
        assert.deepStrictEqual(r.t2.altResolvedBurnerOwned, []);
    });
    check('A: T3 — declared burner USDC ATA surfaces with drainer op (transferChecked); freshly-created WSOL ATA does NOT (carve-out applies)', () => {
        const fx = buildHappyFixture();
        const r = extractTripwires(fx, { burnerPubkey: BURNER, declaredBurnerOwned: [BURNER_USDC_ATA] });
        // T3 surfaces drainer-class ops on every burner-owned account
        // (declared or observed). The transferChecked on BURNER_USDC_ATA
        // IS a drainer op — and BURNER_USDC_ATA pre-existed in the
        // fixture (it had USDC pre-balance), so the carve-out CANNOT
        // apply (condition 1: pre-state-does-not-exist is violated).
        // The extractor therefore records BURNER_USDC_ATA in violatingOps
        // with reason `carve_out_pre_state_exists`. This is the
        // pure-extractor semantics — the live policy would never reach
        // this T3 evaluation for the declared debit because
        // validateSimDelta short-circuits earlier on the declared
        // burnerDebit, but the carve-out test pins what the extractor
        // sees independent of the runtime short-circuit.
        const usdcViolation = r.t3.violatingOps.find(v => v.account === BURNER_USDC_ATA);
        assert.ok(usdcViolation,
            'BURNER_USDC_ATA (declared debit, pre-existed, has transferChecked drainer op) must appear in T3 violations under pure-extractor semantics');
        assert.ok(
            usdcViolation.reasons.includes('carve_out_pre_state_exists'),
            `BURNER_USDC_ATA carve-out must fail with carve_out_pre_state_exists, got ${JSON.stringify(usdcViolation.reasons)}`,
        );

        // The freshly-created WSOL ATA has NO drainer-class op touching
        // it (only canonical create/init ops), so it must NOT appear in
        // T3 violations.
        const wsolViolation = r.t3.violatingOps.find(v => v.account === BURNER_WSOL_ATA);
        assert.strictEqual(wsolViolation, undefined,
            'BURNER_WSOL_ATA has no drainer op → must not appear in T3 violations');

        // And the WSOL ATA is the one that SHOULD have the carve-out
        // applied successfully because of its T5 footprint (zero balance
        // + canonical-init ops only). t3.carveOutAppliedTo only collects
        // accounts that had a drainer op AND passed the carve-out — the
        // WSOL ATA has neither.
        assert.ok(!r.t3.carveOutAppliedTo.includes(BURNER_WSOL_ATA),
            'BURNER_WSOL_ATA is not a T3 carve-out application target (no drainer op against it)');
    });
    check('A: T4 PASS — fee payer is burner', () => {
        const fx = buildHappyFixture();
        const r = extractTripwires(fx, { burnerPubkey: BURNER, declaredBurnerOwned: [BURNER_USDC_ATA] });
        assert.strictEqual(r.t4.pass, true);
        assert.strictEqual(r.t4.feePayer, BURNER);
    });
    check('A: T5 PASS — freshly-created burner WSOL ATA carve-out APPLIES (all 6 conditions met)', () => {
        const fx = buildHappyFixture();
        const r = extractTripwires(fx, { burnerPubkey: BURNER, declaredBurnerOwned: [BURNER_USDC_ATA] });
        // Observed: BURNER_WSOL_ATA + BURNER_USDC_ATA
        // Declared: BURNER_USDC_ATA
        // Undeclared: BURNER_WSOL_ATA → carve-out APPLIES (zero balance, no drainer, canonical init ops, within headroom)
        assert.ok(r.t5.observed.includes(BURNER_WSOL_ATA), 'WSOL ATA observed via postTokenBalances+accounts');
        assert.ok(r.t5.observed.includes(BURNER_USDC_ATA), 'USDC ATA observed via postTokenBalances');
        assert.ok(r.t5.carveOutAppliedTo.includes(BURNER_WSOL_ATA),
            'carve-out must apply to freshly-created WSOL ATA');
        assert.strictEqual(r.t5.pass, true, 'T5 PASS — no undeclared, no non-standard');
        assert.deepStrictEqual(r.t5.undeclared, [], 'no T5 violations');
        assert.deepStrictEqual(r.t5.nonStandardTokenSet, [], 'no Token-2022 detected');
    });

    console.log();

    // ── Case B: Non-zero balance (condition 3 violated) ────────────────────
    console.log('Case B — Non-zero balance on freshly-created WSOL ATA (cond 3)');
    check('B: T5 FAIL — WSOL ATA post amount = 1000000 disqualifies carve-out', () => {
        const fx = buildHappyFixture((f) => {
            // WSOL ATA somehow ended up with 1 USDC equivalent — should never happen
            // in a clean Jupiter trigger deposit, but the test pins the boundary.
            // The WSOL ATA is discoverable only via postTokenBalances in the
            // canonical prod fixture shape, so mutating postTokenBalances[0]
            // alone is the correct boundary mutation.
            f.sim.value.postTokenBalances[0].uiTokenAmount = {
                amount: '1000000', decimals: 9, uiAmount: 0.001, uiAmountString: '0.001',
            };
        });
        const r = extractTripwires(fx, {
            burnerPubkey: BURNER,
            declaredBurnerOwned: [BURNER_USDC_ATA],
        });
        assert.strictEqual(r.t5.pass, false, 'T5 must FAIL');
        const v = r.t5.undeclared.find(x => x.account === BURNER_WSOL_ATA);
        assert.ok(v, 'BURNER_WSOL_ATA must appear in T5 violations');
        assert.ok(v.reasons.includes('carve_out_nonzero_balance'),
            `expected carve_out_nonzero_balance, got ${JSON.stringify(v.reasons)}`);
        assert.ok(!r.t5.carveOutAppliedTo.includes(BURNER_WSOL_ATA),
            'carve-out must NOT have applied');
    });

    console.log();

    // ── Case C: Drainer-class op interleaved (condition 4 violated) ────────
    console.log('Case C — Drainer-class op (SetAuthority) on freshly-created WSOL ATA (cond 4)');
    check('C: T3 FAIL — SetAuthority on WSOL ATA disqualifies carve-out', () => {
        const fx = buildHappyFixture((f) => {
            // Append a Token::SetAuthority op targeting the freshly-created
            // WSOL ATA — this is a drainer-class op (the attacker could
            // re-key it before draining in a follow-up tx).
            f.sim.value.innerInstructions[0].instructions.push({
                parsed: {
                    type: 'setAuthority',
                    info: {
                        account: BURNER_WSOL_ATA,
                        authority: BURNER,
                        authorityType: 'accountOwner',
                        newAuthority: 'AttackerNewAuthSomeRandomPubkeyHerePadXXX',
                    },
                },
                program: 'spl-token',
                programId: TOKEN_PROGRAM,
                stackHeight: 2,
            });
        });
        const r = extractTripwires(fx, {
            burnerPubkey: BURNER,
            declaredBurnerOwned: [BURNER_USDC_ATA],
        });
        assert.strictEqual(r.t3.pass, false, 'T3 must FAIL');
        const v = r.t3.violatingOps.find(x => x.account === BURNER_WSOL_ATA);
        assert.ok(v, 'BURNER_WSOL_ATA must appear in T3 violations');
        assert.ok(v.reasons.includes('carve_out_drainer_op'),
            `expected carve_out_drainer_op, got ${JSON.stringify(v.reasons)}`);
        assert.ok(!r.t3.carveOutAppliedTo.includes(BURNER_WSOL_ATA),
            'carve-out must NOT have applied for WSOL ATA');
    });

    console.log();

    // ── Case D: Excess lamport spend (condition 6 violated) ────────────────
    console.log('Case D — Burner net SOL spend exceeds headroom (cond 6)');
    check('D: T5 FAIL — burner spent 20M lamports > 10M ZERO_VALUE_SOL_HEADROOM', () => {
        const fx = buildHappyFixture((f) => {
            // Burner net SOL delta: preBalances[0] - postBalances[0]
            // Set pre = 2_000_000_000, post = 1_980_000_000 → 20M spent.
            f.sim.value.preBalances[0] = 2_000_000_000;
            f.sim.value.postBalances[0] = 1_980_000_000;
        });
        const r = extractTripwires(fx, {
            burnerPubkey: BURNER,
            declaredBurnerOwned: [BURNER_USDC_ATA],
        });
        assert.strictEqual(r.t5.pass, false, 'T5 must FAIL');
        const v = r.t5.undeclared.find(x => x.account === BURNER_WSOL_ATA);
        assert.ok(v, 'BURNER_WSOL_ATA must appear in T5 violations (carve-out blocked)');
        assert.ok(v.reasons.includes('carve_out_headroom_exceeded'),
            `expected carve_out_headroom_exceeded, got ${JSON.stringify(v.reasons)}`);
        assert.ok(!r.t5.carveOutAppliedTo.includes(BURNER_WSOL_ATA),
            'carve-out must NOT have applied');
    });

    console.log();

    // ── Boundary sanity: ZERO_VALUE_SOL_HEADROOM_LAMPORTS pinned ──────────
    console.log('Boundary sanity');
    check('ZERO_VALUE_SOL_HEADROOM_LAMPORTS pinned at 10_000_000', () => {
        assert.strictEqual(ZERO_VALUE_SOL_HEADROOM_LAMPORTS, 10_000_000);
    });
    check('applyCarveOut: clean inputs → applies=true, no reasons', () => {
        const r = applyCarveOut({
            preExists: false,
            postIsValidBurnerOwnedSpl: true,
            postAmountAtomic: '0',
        }, [
            { parsed: { type: 'createAccount', info: { newAccount: 'x' } }, programId: SYSTEM_PROGRAM },
            { parsed: { type: 'initializeAccount3', info: { account: 'x' } }, programId: TOKEN_PROGRAM },
        ], 100_000);
        assert.strictEqual(r.applies, true);
        assert.deepStrictEqual(r.reasons, []);
    });
    check('applyCarveOut: drainer op → applies=false, reason=drainer_op', () => {
        const r = applyCarveOut({
            preExists: false,
            postIsValidBurnerOwnedSpl: true,
            postAmountAtomic: '0',
        }, [
            { parsed: { type: 'transfer', info: { source: 'x' } }, programId: TOKEN_PROGRAM },
        ], 100_000);
        assert.strictEqual(r.applies, false);
        assert.ok(r.reasons.includes('carve_out_drainer_op'));
    });
    check('applyCarveOut: nonzero balance → reason=nonzero_balance', () => {
        const r = applyCarveOut({
            preExists: false,
            postIsValidBurnerOwnedSpl: true,
            postAmountAtomic: '1000000',
        }, [{ parsed: { type: 'createAccount' }, programId: SYSTEM_PROGRAM }], 100_000);
        assert.strictEqual(r.applies, false);
        assert.ok(r.reasons.includes('carve_out_nonzero_balance'));
    });
    check('applyCarveOut: missing postAmountAtomic → reason=post_amount_unknown (distinct from nonzero_balance)', () => {
        // Copilot R2.2: a null/undefined postAmountAtomic must produce a
        // distinct disqualifier reason so the caller can tell "data gap"
        // apart from "non-zero balance proven by data."
        const rNull = applyCarveOut({
            preExists: false,
            postIsValidBurnerOwnedSpl: true,
            postAmountAtomic: null,
        }, [{ parsed: { type: 'createAccount' }, programId: SYSTEM_PROGRAM }], 100_000);
        assert.strictEqual(rNull.applies, false);
        assert.ok(rNull.reasons.includes('carve_out_post_amount_unknown'),
            `expected carve_out_post_amount_unknown, got ${JSON.stringify(rNull.reasons)}`);
        assert.ok(!rNull.reasons.includes('carve_out_nonzero_balance'),
            'missing-amount must NOT be reported as nonzero_balance');

        const rUndef = applyCarveOut({
            preExists: false,
            postIsValidBurnerOwnedSpl: true,
            postAmountAtomic: undefined,
        }, [{ parsed: { type: 'createAccount' }, programId: SYSTEM_PROGRAM }], 100_000);
        assert.strictEqual(rUndef.applies, false);
        assert.ok(rUndef.reasons.includes('carve_out_post_amount_unknown'),
            'undefined amount must also surface carve_out_post_amount_unknown');
    });
    check('T2: ALT-resolved burner-owned account detected via postTokenBalances filter (Copilot R3.1 regression)', () => {
        // R3.1: previously T2 passed `addressOrder: loadedWritable` into
        // buildObservedBurnerOwnedSet, but Source 1 iterates sim.value.accounts
        // assuming index-alignment to addressOrder. Per Solana JSON-RPC docs,
        // sim.value.accounts[i] is index-aligned to the caller-supplied
        // accounts.config.addresses (requestedAddresses), NOT to
        // loadedAddresses.writable. The fix disables Source 1 for T2
        // (addressOrder: []) and relies on Source 2 filtered to ALT keys.
        //
        // This regression test builds a fixture where loadedAddresses.writable
        // contains an ALT-resolved key that postTokenBalances reports as
        // burner-owned. The extractor MUST detect it as T2 fail.
        const ALT_BURNER_ATA = 'AltResolvedBurnerATAforR3pinXXXXXXXXXXXXXXz';
        const fx = buildHappyFixture((f) => {
            f.sim.value.loadedAddresses = {
                writable: [ALT_BURNER_ATA],
                readonly: [],
            };
            // ALT-resolved key appears in combinedAccountKeys (post-resolution)
            // at a new index. postTokenBalances references it via accountIndex.
            f.combinedAccountKeys = f.combinedAccountKeys.concat([ALT_BURNER_ATA]);
            f.sim.value.postTokenBalances.push({
                accountIndex: f.combinedAccountKeys.length - 1,
                mint: WSOL_MINT,
                owner: BURNER,
                programId: TOKEN_PROGRAM,
                uiTokenAmount: { amount: '0', decimals: 9, uiAmount: 0, uiAmountString: '0' },
            });
            // preBalances / postBalances also extend.
            f.sim.value.preBalances.push(0);
            f.sim.value.postBalances.push(2_039_280);
        });
        const r = extractTripwires(fx, {
            burnerPubkey: BURNER,
            declaredBurnerOwned: [BURNER_USDC_ATA],
        });
        assert.strictEqual(r.t2.pass, false, 'T2 must FAIL on ALT-resolved burner-owned');
        assert.ok(
            r.t2.altResolvedBurnerOwned.includes(ALT_BURNER_ATA),
            `expected ALT_BURNER_ATA in altResolvedBurnerOwned, got ${JSON.stringify(r.t2.altResolvedBurnerOwned)}`,
        );
    });
    check('T2: source-1 disabled (sim.value.accounts NOT misattributed when addressOrder is empty)', () => {
        // Companion regression: even when sim.value.accounts contains
        // entries that LOOK like burner-owned SPL, T2 must NOT attribute
        // them to any ALT-resolved address when loadedWritable is empty.
        // This proves the Source-1 disable holds even under hostile shapes.
        const fx = buildHappyFixture();
        // Sanity: loadedAddresses.writable is empty in the happy fixture.
        assert.deepStrictEqual(fx.sim.value.loadedAddresses.writable, []);
        const r = extractTripwires(fx, {
            burnerPubkey: BURNER,
            declaredBurnerOwned: [BURNER_USDC_ATA],
        });
        assert.strictEqual(r.t2.pass, true);
        assert.deepStrictEqual(r.t2.altResolvedBurnerOwned, []);
    });
    check('isPostBurnerOwnedSpl: postTokenBalances-only account passes condition 2 (Copilot R2.3 regression)', () => {
        // Pin the dual-source helper: an account that is NOT in
        // sim.value.accounts but IS reported by postTokenBalances as
        // burner-owned classic SPL must satisfy condition 2. This is the
        // shape of the canonical prod-burner capture's WSOL ATA.
        const { isPostBurnerOwnedSpl } = _internals;
        const ABSENT = 'AbsentFromValueAccountsXXXXXXXXXXXXXXXXXXXz';
        const capture = {
            combinedAccountKeys: [BURNER, ABSENT],
            sim: {
                value: {
                    accounts: [], // intentionally empty — only postTokenBalances proves it
                    postTokenBalances: [
                        {
                            accountIndex: 1,
                            mint: WSOL_MINT,
                            owner: BURNER,
                            programId: TOKEN_PROGRAM,
                            uiTokenAmount: { amount: '0', decimals: 9, uiAmount: 0, uiAmountString: '0' },
                        },
                    ],
                },
            },
        };
        assert.strictEqual(
            isPostBurnerOwnedSpl(ABSENT, capture, BURNER, new Map()),
            true,
            'postTokenBalances declaration must satisfy condition 2 even when sim.value.accounts has no entry',
        );
    });
    check('applyCarveOut: headroom exceeded → reason=headroom_exceeded', () => {
        const r = applyCarveOut({
            preExists: false,
            postIsValidBurnerOwnedSpl: true,
            postAmountAtomic: '0',
        }, [{ parsed: { type: 'createAccount' }, programId: SYSTEM_PROGRAM }],
        ZERO_VALUE_SOL_HEADROOM_LAMPORTS + 1);
        assert.strictEqual(r.applies, false);
        assert.ok(r.reasons.includes('carve_out_headroom_exceeded'));
    });
    check('applyCarveOut: missing lamport spend → reason=lamport_spend_unknown (fail-closed, Copilot R4.3)', () => {
        // null postLamports must NOT pass the carve-out — proven-spend bound
        // is load-bearing per BAT-1031 v1.2 §3 condition 6.
        const rNull = applyCarveOut({
            preExists: false,
            postIsValidBurnerOwnedSpl: true,
            postAmountAtomic: '0',
        }, [{ parsed: { type: 'createAccount' }, programId: SYSTEM_PROGRAM }], null);
        assert.strictEqual(rNull.applies, false);
        assert.ok(
            rNull.reasons.includes('carve_out_lamport_spend_unknown'),
            `expected carve_out_lamport_spend_unknown, got ${JSON.stringify(rNull.reasons)}`,
        );
        assert.ok(
            !rNull.reasons.includes('carve_out_headroom_exceeded'),
            'unknown spend must not be reported as headroom_exceeded',
        );

        // undefined and NaN also fail closed.
        const rUndef = applyCarveOut({
            preExists: false, postIsValidBurnerOwnedSpl: true, postAmountAtomic: '0',
        }, [{ parsed: { type: 'createAccount' }, programId: SYSTEM_PROGRAM }], undefined);
        assert.ok(rUndef.reasons.includes('carve_out_lamport_spend_unknown'));

        const rNan = applyCarveOut({
            preExists: false, postIsValidBurnerOwnedSpl: true, postAmountAtomic: '0',
        }, [{ parsed: { type: 'createAccount' }, programId: SYSTEM_PROGRAM }], Number.NaN);
        assert.ok(rNan.reasons.includes('carve_out_lamport_spend_unknown'));
    });
    check('burnerNetSolDelta: returns null when burner not in combinedAccountKeys (R4.3 helper)', () => {
        const { burnerNetSolDelta } = _internals;
        const capture = {
            combinedAccountKeys: ['SomeOtherAcctXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXz'],
            sim: { value: { preBalances: [100], postBalances: [50] } },
        };
        assert.strictEqual(burnerNetSolDelta(capture, BURNER), null);
    });
    check('burnerNetSolDelta: returns number when burner is present (R4.3 helper)', () => {
        const { burnerNetSolDelta } = _internals;
        const capture = {
            combinedAccountKeys: [BURNER],
            sim: { value: { preBalances: [10_000_000], postBalances: [5_000_000] } },
        };
        assert.strictEqual(burnerNetSolDelta(capture, BURNER), 5_000_000);
    });
    check('applyCarveOut: non-canonical op → reason=non_canonical_op', () => {
        const r = applyCarveOut({
            preExists: false,
            postIsValidBurnerOwnedSpl: true,
            postAmountAtomic: '0',
        }, [
            { parsed: { type: 'someWeirdInstruction' }, programId: TOKEN_PROGRAM },
        ], 100_000);
        assert.strictEqual(r.applies, false);
        assert.ok(r.reasons.some(s => s.startsWith('carve_out_non_canonical_op:')));
    });

    console.log();
    console.log(`${pass} passed, ${fail} failed`);
    if (fail > 0) {
        console.log('FAIL: tests/nodejs-project/burner-policy-carveout.test.js');
        process.exit(1);
    }
    console.log('PASS: tests/nodejs-project/burner-policy-carveout.test.js');
})();