// SeekerClaw — wallet/burner-policy.js
//
// BAT-1013 Tier 2: Autonomous burner signing policy.
//
// WHY THIS EXISTS
// ---------------
// BAT-582's burner wallet lets the agent sign Solana transactions WITHOUT
// user click-through. That's the named 2026 "agentic drainer" attack
// surface (Helius/Turnkey/Crossmint/Phantom-MCP all explicitly flag it):
// when the human review step is removed, the integrator becomes the only
// defense against drainer-instruction injection, supply-chain-tampered
// upstream responses, and unexpected on-chain mutations.
//
// This module is the policy gate. Every burner sign goes through
// `BurnerSigner.signTransaction()` / `signAndSend()`, which call
// `validateBurnerTx()` before any bridge HTTP call. If policy rejects,
// no signature ever leaves the device.
//
// ARCHITECTURE (per BAT-1013 contract v1.1 + Codex sign-off 2026-06-04)
// --------------------------------------------------------------------
// 1. Parse the tx (shared `wallet/tx-parser.js`) — fail closed on
//    malformed bytes.
// 2. Validate signer mode (one of three: `burner_only` / `sponsored` /
//    `cosigned`) against the per-tool `expectedDelta`. The single
//    "sole signer == burner" invariant from v1 was wrong for x402 v2,
//    which is a 2-of-2 cosigned tx (facilitator at slot 0, burner at
//    slot 1).
// 3. Walk instructions and reject drainer SPL Token / System Program
//    opcodes targeting burner-owned accounts. Phantom's pattern is
//    BLOCKLIST + simulation, not allowlist — drainer opcodes are stable
//    SPL primitives and won't decay.
// 4. Validate `expectedDelta` shape per kind. Seven kinds, each with
//    its own validator — Trigger create + DCA create are DEPOSITS, not
//    swaps, so they have no `burnerCreditMin` field.
// 5. (Phase 2c, follow-up commit) Run `simulateTransaction` and assert
//    burner's net delta matches `expectedDelta` within caller-provided
//    tolerance. This commit defers the simulation step; the structural
//    + drainer + signer-mode checks alone close the immediate failure
//    modes from the BAT-995 device incident (whitelist DoS) and from
//    the Crypto Copilot drainer class (extra SystemProgram::transfer
//    instructions slipped into a swap — caught here by the per-shape
//    instruction validator + drainer blocklist).
//
// CODEX AMENDMENTS RESPONDED TO
// -----------------------------
// (A1) Parser: uses `wallet/tx-parser.js` (extracted, tested). No
//      reference to a nonexistent `_decodeVersionedMessage`.
// (A2) Simulation: deferred to follow-up commit; uses `loadedAddresses`
//      from the simulation response when it lands (NOT
//      `value.accountKeys`, which doesn't exist).
// (A3) Burner pubkey is REQUIRED as a parameter to `validateBurnerTx`.
//      Missing → reject `payer_missing` before any other check. The
//      caller (`BurnerSigner`) is responsible for fetching it from
//      `/burner/status`.
// (A4) Signer modes (3) handle x402 v2 cosigned tx; allowlists are
//      caller-declared per-tx, NEVER a global file.
// (A5) Token-2022: detected at the program-ID level; if any instruction
//      uses Token-2022, `expectedDelta.tokenStandard` must be declared
//      as `'token_2022'`. Live route coverage deferred per Codex
//      (no supported autonomous flow produces Token-2022 today).
// (A6) Rejection wording: see `REJECT_CLASS` map below. Security-class
//      rejections explicitly do NOT recommend MWA retry.
// (A7) Live simulation gate: enforced in Tier 6 live test
//      `tests/jupiter-ultra/live-burner-policy.js`, NOT in this module.
// (A8) Foundation/security review class — R10+ Copilot expected.

'use strict';

const { TxParseError, parseTransaction } = require('./tx-parser');
const { readAccountInfo, tokenDelta, lamportsDelta } = require('./spl-token-layout');

// ─── Reject codes (locked: REJECT_CODES.length must equal 26) ─────────────

const REJECT_CODES = Object.freeze([
    // Structural / parsing
    'tx_unparseable',
    'policy_parse_uncertainty',
    'alt_unresolved',
    // Signer modes
    'payer_missing',
    'payer_mismatch',
    'fee_payer_not_in_allowlist',
    'signer_set_unexpected',
    'signer_count_mismatch',
    'burner_not_signer',
    'cosigner_not_in_allowlist',
    // Drainer opcodes
    'drainer_set_authority',
    'drainer_approve',
    'drainer_close_account',
    'drainer_assign',
    'drainer_nonce_blank_check',
    // Account ownership
    'account_ownership_uncertain',
    'token_2022_undeclared',
    // Expected delta shape
    'expected_delta_required',
    'expected_delta_invalid_kind',
    'expected_delta_invalid_shape',
    // Simulation (Phase 2c+ — enforced in production mode; when no simulator
    // is wired, structural checks still run via { allowStructuralOnly: true })
    'simulation_failed',
    'simulation_returned_error',
    'simulation_metadata_missing',
    'simulation_delta_mismatch',
    'simulation_mint_mismatch',
    'simulation_recipient_mismatch',
]);

// Each rejection code's class — drives agent guidance in DIAGNOSTICS.md
// (Tier 4, Phase 5). Per Codex amendment #6: security-class rejections
// MUST NOT recommend MWA retry; availability-class MAY ask the user.
const REJECT_CLASS = Object.freeze({
    // security: refuse; surface reason verbatim; NO MWA retry suggestion
    drainer_set_authority: 'security',
    drainer_approve: 'security',
    drainer_close_account: 'security',
    drainer_assign: 'security',
    drainer_nonce_blank_check: 'security',
    signer_set_unexpected: 'security',
    signer_count_mismatch: 'security',
    burner_not_signer: 'security',
    payer_mismatch: 'security',
    fee_payer_not_in_allowlist: 'security',
    cosigner_not_in_allowlist: 'security',
    simulation_delta_mismatch: 'security',
    simulation_mint_mismatch: 'security',
    simulation_recipient_mismatch: 'security',
    account_ownership_uncertain: 'security',
    token_2022_undeclared: 'security',
    // availability: ask user; offer explicit MWA fallback
    simulation_failed: 'availability',
    simulation_returned_error: 'availability',
    simulation_metadata_missing: 'availability',
    tx_unparseable: 'availability',
    policy_parse_uncertainty: 'availability',
    alt_unresolved: 'availability',
    // contract-gap: internal bug; report as bug, do not retry/bypass
    expected_delta_required: 'contract_gap',
    expected_delta_invalid_kind: 'contract_gap',
    expected_delta_invalid_shape: 'contract_gap',
    payer_missing: 'contract_gap',
});

// ─── Solana primitive program IDs (stable since 2020) ─────────────────────

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

// SPL Token instruction discriminators (drainer primitives — first byte of data).
// Source: github.com/solana-program/token, Token v3 + Token-2022 share these IDs.
const TOKEN_IX = Object.freeze({
    APPROVE: 4,
    SET_AUTHORITY: 6,
    CLOSE_ACCOUNT: 9,
    APPROVE_CHECKED: 13,
});

// System Program instruction discriminators (little-endian u32, first 4 bytes).
// Source: github.com/solana-labs/solana/blob/master/runtime/src/system_processor.rs
const SYSTEM_IX = Object.freeze({
    ASSIGN: 1,
    ADVANCE_NONCE_ACCOUNT: 4,
});

// ─── Expected-delta `kind` constants (closed enum) ────────────────────────

const DELTA_KINDS = Object.freeze([
    'jupiter_swap_immediate',
    'jupiter_trigger_create_deposit',
    'jupiter_dca_create_deposit',
    'solana_send',
    'agent_pay_x402',
    'zero_value_cancel',
    'zero_value_auth',
]);

const SIGNER_MODES = Object.freeze(['burner_only', 'sponsored', 'cosigned']);

// ─── Structured response helpers ──────────────────────────────────────────

function reject(code, reason, extra) {
    return Object.assign(
        { ok: false, error: code, reason: String(reason), class: REJECT_CLASS[code] || 'security' },
        extra || {}
    );
}

function accept(extra) {
    return Object.assign({ ok: true }, extra || {});
}

// ─── Signer-mode validator ────────────────────────────────────────────────

/**
 * Validate that the parsed tx's fee-payer and required-signer set match
 * the caller's declared `signerMode`. The three modes encode three real
 * Solana signing flows:
 *
 *   - `burner_only`: classic single-signer self-paid tx (Jupiter Ultra
 *     single-signer path, Trigger/DCA create, solana_send, cancels,
 *     zero-cap auth). Fee payer == burner. Exactly 1 required signer.
 *   - `sponsored`: gasless relayer pays fees; burner is one of N
 *     required signers; the fee payer must match a caller-declared
 *     allowlist parsed from the protocol response (e.g. Jupiter Ultra
 *     gasless relayer set when/if that flow ships).
 *   - `cosigned`: facilitator co-signs server-side (x402 v2 USDC
 *     payment). Fee payer is in `feePayerAllowlist`; every additional
 *     required signer must be in `cosignerAllowlist`; numRequired must
 *     equal `1 (burner) + cosignerAllowlist.length`.
 */
function validateSignerMode(parsed, burnerPubkey, expectedDelta) {
    const mode = expectedDelta.signerMode;
    const feePayerAllowlist = Array.isArray(expectedDelta.feePayerAllowlist)
        ? expectedDelta.feePayerAllowlist
        : [];
    const cosignerAllowlist = Array.isArray(expectedDelta.cosignerAllowlist)
        ? expectedDelta.cosignerAllowlist
        : [];

    if (parsed.staticAccountKeys.length === 0) {
        return reject('payer_missing', 'tx has zero account keys');
    }
    const feePayer = parsed.staticAccountKeys[0];
    const requiredSigners = parsed.staticAccountKeys.slice(0, parsed.numRequiredSignatures);

    switch (mode) {
        case 'burner_only': {
            if (feePayer !== burnerPubkey) {
                return reject('payer_mismatch', `fee payer ${feePayer} ≠ burner ${burnerPubkey}`);
            }
            if (parsed.numRequiredSignatures !== 1) {
                return reject('signer_count_mismatch',
                    `burner_only requires exactly 1 signer, got ${parsed.numRequiredSignatures}`);
            }
            if (requiredSigners.length !== 1 || requiredSigners[0] !== burnerPubkey) {
                return reject('signer_set_unexpected',
                    `burner_only requires {${burnerPubkey}} as sole signer, got ${JSON.stringify(requiredSigners)}`);
            }
            return accept();
        }
        case 'sponsored': {
            if (!feePayerAllowlist.includes(feePayer)) {
                return reject('fee_payer_not_in_allowlist',
                    `fee payer ${feePayer} not in declared feePayerAllowlist`);
            }
            if (!requiredSigners.includes(burnerPubkey)) {
                return reject('burner_not_signer', `burner ${burnerPubkey} not in required-signer set`);
            }
            const otherSigners = requiredSigners.filter(s => s !== burnerPubkey);
            for (const s of otherSigners) {
                if (!cosignerAllowlist.includes(s) && !feePayerAllowlist.includes(s)) {
                    return reject('cosigner_not_in_allowlist',
                        `unknown additional required signer ${s} not in feePayer or cosigner allowlist`);
                }
            }
            return accept();
        }
        case 'cosigned': {
            if (!feePayerAllowlist.includes(feePayer)) {
                return reject('fee_payer_not_in_allowlist',
                    `fee payer ${feePayer} not in declared feePayerAllowlist`);
            }
            if (!requiredSigners.includes(burnerPubkey)) {
                return reject('burner_not_signer', `burner ${burnerPubkey} not in required-signer set`);
            }
            const expectedCount = 1 + cosignerAllowlist.length;
            if (parsed.numRequiredSignatures !== expectedCount) {
                return reject('signer_count_mismatch',
                    `cosigned mode expects ${expectedCount} signers (burner + ${cosignerAllowlist.length} cosigners), got ${parsed.numRequiredSignatures}`);
            }
            const otherSigners = requiredSigners.filter(s => s !== burnerPubkey);
            for (const s of otherSigners) {
                if (!cosignerAllowlist.includes(s)) {
                    return reject('cosigner_not_in_allowlist',
                        `cosigner ${s} not in declared cosignerAllowlist`);
                }
            }
            return accept();
        }
        default:
            return reject('expected_delta_invalid_shape',
                `signerMode must be one of [${SIGNER_MODES.join(', ')}], got "${mode}"`);
    }
}

// ─── Drainer-opcode blocklist ─────────────────────────────────────────────

/**
 * Walk every instruction and reject drainer SPL Token / System Program
 * opcodes targeting a burner-owned account. Phantom-pattern blocklist
 * over Turnkey-style program allowlist (industry consensus per workflows
 * `wx2c95307` + `wejjbmfpz`): drainer opcodes are stable SPL primitives
 * that won't decay, while allowlists rot every time a DEX ships a new
 * router.
 *
 * `burnerOwnedAccounts` is the layered-detection union (Codex amendment
 * #4): caller-declared `expectedDelta.burnerOwnedAccounts[]` ∪
 * simulation-derived owners (Phase 2c). For drainer instructions where
 * the target account's ownership cannot be resolved from either layer,
 * we fail closed with `account_ownership_uncertain` rather than guess.
 *
 * Returns `accept()` on clean walk OR `reject(drainer_*, ...)` on first
 * drainer hit. Token-2022 program use REQUIRES caller to declare
 * `tokenStandard: 'token_2022'` (Codex amendment #5).
 */
function validateDrainerOpcodes(parsed, burnerOwnedAccounts, expectedDelta) {
    const ownedSet = new Set(burnerOwnedAccounts);

    for (let i = 0; i < parsed.instructions.length; i++) {
        const instr = parsed.instructions[i];
        // For ALT-resolved program IDs (programIdIdx >= staticAccountKeys.length),
        // we cannot determine the program identity from this commit's structural
        // pass alone. Phase 2c will use simulation.loadedAddresses to resolve.
        // For now, ALT-resolved program references are NOT checked for drainer
        // opcodes — the per-shape validator + signer-mode check above provide
        // structural defense for the current Jupiter/x402 flows. Flag as
        // policy_parse_uncertainty if we ever land an autonomous flow that uses
        // ALT-resolved drainer-class programs.
        if (instr.programIdIdx >= parsed.staticAccountKeys.length) continue;

        const programId = parsed.staticAccountKeys[instr.programIdIdx];
        const dataBytes = instr.dataBytes;
        if (!dataBytes || dataBytes.length === 0) continue;

        if (programId === TOKEN_PROGRAM_ID || programId === TOKEN_2022_PROGRAM_ID) {
            if (programId === TOKEN_2022_PROGRAM_ID && expectedDelta.tokenStandard !== 'token_2022') {
                return reject('token_2022_undeclared',
                    `instruction[${i}] uses Token-2022 program but expectedDelta.tokenStandard is not declared`);
            }
            const ix = dataBytes[0];
            // Drainer instructions on burner-owned accounts:
            if (ix === TOKEN_IX.SET_AUTHORITY) {
                const targetIdx = instr.accountIdxs[0];
                const targetAcct = parsed.staticAccountKeys[targetIdx];
                if (!targetAcct) {
                    return reject('account_ownership_uncertain',
                        `instruction[${i}] SetAuthority target account index ${targetIdx} out of range`);
                }
                if (ownedSet.has(targetAcct)) {
                    return reject('drainer_set_authority',
                        `instruction[${i}] SetAuthority targets burner-owned account ${targetAcct}`);
                }
            } else if (ix === TOKEN_IX.APPROVE || ix === TOKEN_IX.APPROVE_CHECKED) {
                const sourceIdx = instr.accountIdxs[0];
                const sourceAcct = parsed.staticAccountKeys[sourceIdx];
                if (sourceAcct && ownedSet.has(sourceAcct)) {
                    return reject('drainer_approve',
                        `instruction[${i}] Approve on burner-owned account ${sourceAcct}`);
                }
            } else if (ix === TOKEN_IX.CLOSE_ACCOUNT) {
                const targetIdx = instr.accountIdxs[0];
                const targetAcct = parsed.staticAccountKeys[targetIdx];
                // Cancel flows legitimately close ATAs; the per-shape validator
                // for `zero_value_cancel` allows token_close. Non-cancel kinds
                // hit a drainer reject.
                if (targetAcct && ownedSet.has(targetAcct) && expectedDelta.kind !== 'zero_value_cancel') {
                    return reject('drainer_close_account',
                        `instruction[${i}] CloseAccount on burner-owned account ${targetAcct} (only allowed in zero_value_cancel)`);
                }
            }
        } else if (programId === SYSTEM_PROGRAM_ID) {
            // System Program ix discriminator is u32 little-endian.
            if (dataBytes.length < 4) continue;
            const ix = dataBytes.readUInt32LE(0);
            if (ix === SYSTEM_IX.ASSIGN) {
                const targetIdx = instr.accountIdxs[0];
                const targetAcct = parsed.staticAccountKeys[targetIdx];
                if (targetAcct && ownedSet.has(targetAcct)) {
                    return reject('drainer_assign',
                        `instruction[${i}] System::Assign reassigns ownership of burner account ${targetAcct}`);
                }
            } else if (ix === SYSTEM_IX.ADVANCE_NONCE_ACCOUNT && i === 0) {
                // Durable nonce blank-check defense: a tx using durable-nonce
                // semantics MUST start with AdvanceNonceAccount as instruction 0.
                // If an autonomous burner tx uses this, the agent is signing a
                // potentially-arbitrary tx — fail closed unless explicitly
                // declared (no current flow declares it).
                return reject('drainer_nonce_blank_check',
                    `instruction[0] is AdvanceNonceAccount — durable-nonce blank-check signing not allowed for autonomous burner`);
            }
        }
    }
    return accept();
}

// ─── expectedDelta shape validators ───────────────────────────────────────

function isNonEmptyBase58(s) {
    return typeof s === 'string' && s.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

function isBigintAtomicString(s) {
    return typeof s === 'string' && /^\d+$/.test(s);
}

function validateMint(s) {
    return s === 'native_sol' || isNonEmptyBase58(s);
}

function validateExpectedDeltaShape(expectedDelta) {
    if (!expectedDelta || typeof expectedDelta !== 'object') {
        return reject('expected_delta_required', 'expectedDelta must be an object');
    }
    if (!DELTA_KINDS.includes(expectedDelta.kind)) {
        return reject('expected_delta_invalid_kind',
            `expectedDelta.kind must be one of [${DELTA_KINDS.join(', ')}], got "${expectedDelta.kind}"`);
    }
    if (!SIGNER_MODES.includes(expectedDelta.signerMode)) {
        return reject('expected_delta_invalid_shape',
            `expectedDelta.signerMode must be one of [${SIGNER_MODES.join(', ')}], got "${expectedDelta.signerMode}"`);
    }

    const requireBurnerDebit = (d) => {
        if (!d || typeof d !== 'object') return 'burnerDebit must be object';
        if (!isNonEmptyBase58(d.account)) return 'burnerDebit.account must be a base58 pubkey';
        if (!validateMint(d.mint)) return 'burnerDebit.mint must be base58 mint or "native_sol"';
        if (!isBigintAtomicString(d.atomicAmount)) return 'burnerDebit.atomicAmount must be a non-negative integer string';
        return null;
    };

    switch (expectedDelta.kind) {
        case 'jupiter_swap_immediate': {
            const dErr = requireBurnerDebit(expectedDelta.burnerDebit);
            if (dErr) return reject('expected_delta_invalid_shape', dErr);
            const cm = expectedDelta.burnerCreditMin;
            if (!cm || typeof cm !== 'object') return reject('expected_delta_invalid_shape', 'burnerCreditMin required');
            if (!isNonEmptyBase58(cm.account)) return reject('expected_delta_invalid_shape', 'burnerCreditMin.account must be base58');
            if (!validateMint(cm.mint)) return reject('expected_delta_invalid_shape', 'burnerCreditMin.mint required');
            if (!isBigintAtomicString(cm.atomicAmount)) return reject('expected_delta_invalid_shape', 'burnerCreditMin.atomicAmount required');
            if (typeof expectedDelta.toleranceBps !== 'number' || expectedDelta.toleranceBps < 0) {
                return reject('expected_delta_invalid_shape', 'toleranceBps required (non-negative number)');
            }
            return accept();
        }
        case 'jupiter_trigger_create_deposit':
        case 'jupiter_dca_create_deposit': {
            // Contract v8.3 (per Codex review of v8.2): depositVault is
            // LOAD-BEARING for deposit flows, not icing. Without a verified
            // destination, a tampered tx could debit the exact expected
            // amount from the burner to an attacker-controlled token
            // account while still passing signerMode, fee-payer, drainer-
            // opcode, and burnerDebit checks. depositVault is REQUIRED.
            //
            // Call sites that cannot supply a verified depositVault MUST
            // route the tx to the main wallet (forceRouting='main') and
            // not invoke autonomous burner signing for this kind.
            const dErr = requireBurnerDebit(expectedDelta.burnerDebit);
            if (dErr) return reject('expected_delta_invalid_shape', dErr);
            const v = expectedDelta.depositVault;
            if (!v || typeof v !== 'object') return reject('expected_delta_invalid_shape', 'depositVault required');
            if (!isNonEmptyBase58(v.pubkey)) return reject('expected_delta_invalid_shape', 'depositVault.pubkey required');
            if (!isNonEmptyBase58(v.expectedOwner)) return reject('expected_delta_invalid_shape', 'depositVault.expectedOwner required');
            return accept();
        }
        case 'solana_send': {
            const dErr = requireBurnerDebit(expectedDelta.burnerDebit);
            if (dErr) return reject('expected_delta_invalid_shape', dErr);
            const r = expectedDelta.recipient;
            if (!r || typeof r !== 'object') return reject('expected_delta_invalid_shape', 'recipient required');
            if (!isNonEmptyBase58(r.account)) return reject('expected_delta_invalid_shape', 'recipient.account required');
            if (!validateMint(r.mint)) return reject('expected_delta_invalid_shape', 'recipient.mint required');
            return accept();
        }
        case 'agent_pay_x402': {
            const dErr = requireBurnerDebit(expectedDelta.burnerDebit);
            if (dErr) return reject('expected_delta_invalid_shape', dErr);
            const r = expectedDelta.recipient;
            if (!r || typeof r !== 'object') return reject('expected_delta_invalid_shape', 'recipient required');
            if (!isNonEmptyBase58(r.account)) return reject('expected_delta_invalid_shape', 'recipient.account required');
            if (!validateMint(r.mint)) return reject('expected_delta_invalid_shape', 'recipient.mint required');
            if (expectedDelta.x402Version !== 1 && expectedDelta.x402Version !== 2) {
                return reject('expected_delta_invalid_shape', 'x402Version must be 1 or 2');
            }
            if (expectedDelta.x402Version === 2 && expectedDelta.signerMode !== 'cosigned') {
                return reject('expected_delta_invalid_shape', 'x402 v2 must use signerMode "cosigned"');
            }
            if (expectedDelta.signerMode === 'cosigned') {
                if (!Array.isArray(expectedDelta.feePayerAllowlist) || expectedDelta.feePayerAllowlist.length === 0) {
                    return reject('expected_delta_invalid_shape', 'cosigned mode requires non-empty feePayerAllowlist');
                }
                if (!Array.isArray(expectedDelta.cosignerAllowlist)) {
                    return reject('expected_delta_invalid_shape', 'cosigned mode requires cosignerAllowlist array');
                }
            }
            return accept();
        }
        case 'zero_value_cancel':
        case 'zero_value_auth': {
            if (!Array.isArray(expectedDelta.allowedInstructionClasses)) {
                return reject('expected_delta_invalid_shape', 'allowedInstructionClasses must be an array');
            }
            return accept();
        }
        default:
            return reject('expected_delta_invalid_kind', `unhandled kind "${expectedDelta.kind}"`);
    }
}

// ─── Simulation helpers (v8.1 — accounts-config primary + auxiliary x-check) ──

/**
 * Resolve a base58 pubkey to its index in the combined account keys
 * (static + ALT.writable + ALT.readonly). Returns -1 if not found.
 * Used by the auxiliary pre/post-balance-array cross-check.
 */
function indexOfPubkey(combinedAccountKeys, pubkey) {
    for (let i = 0; i < combinedAccountKeys.length; i++) {
        if (combinedAccountKeys[i] === pubkey) return i;
    }
    return -1;
}

/**
 * Auxiliary path (Codex amendment #8.1 §2): if `value.preTokenBalances` and
 * `value.postTokenBalances` are present for a specific (combinedIndex, mint)
 * pair, compute the delta. Returns null when the entries are absent — the
 * primary accounts-config path is authoritative when auxiliary is missing.
 */
function auxiliaryTokenDelta(simValue, combinedIndex, mint) {
    if (!Array.isArray(simValue.preTokenBalances) && !Array.isArray(simValue.postTokenBalances)) {
        return null;
    }
    const findEntry = (arr) => {
        if (!Array.isArray(arr)) return null;
        for (const b of arr) {
            if (b && b.accountIndex === combinedIndex && b.mint === mint) return b;
        }
        return null;
    };
    const preE = findEntry(simValue.preTokenBalances);
    const postE = findEntry(simValue.postTokenBalances);
    if (!preE && !postE) return null;
    const getAmt = (e) => {
        if (!e || !e.uiTokenAmount || typeof e.uiTokenAmount.amount !== 'string') return 0n;
        try { return BigInt(e.uiTokenAmount.amount); } catch { return 0n; }
    };
    return getAmt(postE) - getAmt(preE);
}

/**
 * Auxiliary path for native SOL: `value.preBalances[i]` and `postBalances[i]`
 * are indexed by combined account keys. Returns null when arrays are absent
 * or the index is out of range.
 */
function auxiliarySolDelta(simValue, combinedIndex) {
    if (!Array.isArray(simValue.preBalances) || !Array.isArray(simValue.postBalances)) return null;
    if (combinedIndex < 0 || combinedIndex >= simValue.preBalances.length) return null;
    if (combinedIndex >= simValue.postBalances.length) return null;
    try {
        return BigInt(simValue.postBalances[combinedIndex]) - BigInt(simValue.preBalances[combinedIndex]);
    } catch {
        return null;
    }
}

// Network fee + ATA rent ceiling for "zero-value" cancel/auth shapes.
// Solana base fee is 5000 lamports per signature; ATA rent-exempt minimum
// is ~2_039_280 lamports (165 bytes). Allow generous headroom: 10 SOL-
// cents-equivalent (~0.01 SOL = 10_000_000 lamports) as the upper bound
// on what an autonomous zero-value tx is allowed to consume from the
// burner. Larger SOL delta on a "zero_value_*" shape indicates the agent
// is signing something other than the declared no-movement contract.
const ZERO_VALUE_SOL_HEADROOM_LAMPORTS = 10_000_000n;

// ─── Per-shape delta validators ────────────────────────────────────────────

function rejectDeltaMismatch(reason, ctx) {
    const detail = ctx ? ` (${JSON.stringify(ctx)})` : '';
    return reject('simulation_delta_mismatch', `${reason}${detail}`);
}

/**
 * Build the list of accounts whose delta we'll validate, with per-account
 * existence policy + expected delta semantics, given `expectedDelta`.
 *
 * Each entry:
 *   {
 *     address: base58,
 *     mint: <base58> | 'native_sol',
 *     role: 'debit' | 'credit' | 'recipient' | 'vault' | 'cancel-target' | 'burner-system',
 *     expectedDeltaAtomic: bigint (signed; negative = burner spends),
 *     existencePolicy: {
 *       mustExistBefore: boolean,  // pre=null → simulation_metadata_missing
 *       allowCreate: boolean,      // pre=null → post=exists is OK (ATA created in tx)
 *       allowClose: boolean,       // post=null is OK (cancel/close)
 *     },
 *     deltaTolerance: { mode: 'exact' | 'gte_min_minus_bps' | 'sol_fee_headroom' | 'zero_within_headroom' | 'nonneg', minRequired?: bigint, bps?: bigint },
 *   }
 *
 * Codex amendment #2: debit/source = mustExistBefore; recipient/output ATA
 * + deposit vault = allowCreate; cancel/close target = allowClose; any
 * undeclared null transition stays fail-closed.
 */
function buildAccountChecks(expectedDelta, burnerPubkey) {
    const kind = expectedDelta.kind;
    const checks = [];

    const debitTolerance = (mint) => mint === 'native_sol'
        ? { mode: 'sol_fee_headroom', headroom: ZERO_VALUE_SOL_HEADROOM_LAMPORTS }
        : { mode: 'exact' };

    if (kind === 'zero_value_auth' || kind === 'zero_value_cancel') {
        // Only check the burner's native SOL. Token deltas on
        // burnerOwnedAccounts are bounded only by drainer-opcode walk;
        // zero-value shapes have no expected token movement.
        checks.push({
            address: burnerPubkey,
            mint: 'native_sol',
            role: 'burner-system',
            expectedDeltaAtomic: 0n,
            existencePolicy: { mustExistBefore: true, allowCreate: false, allowClose: false },
            deltaTolerance: { mode: 'zero_within_headroom', headroom: ZERO_VALUE_SOL_HEADROOM_LAMPORTS },
        });
        return checks;
    }

    const debit = expectedDelta.burnerDebit;
    if (debit) {
        checks.push({
            address: debit.account,
            mint: debit.mint,
            role: 'debit',
            expectedDeltaAtomic: -BigInt(debit.atomicAmount),
            existencePolicy: { mustExistBefore: true, allowCreate: false, allowClose: false },
            deltaTolerance: debitTolerance(debit.mint),
        });
    }

    if (kind === 'jupiter_swap_immediate') {
        const credit = expectedDelta.burnerCreditMin;
        if (credit) {
            checks.push({
                address: credit.account,
                mint: credit.mint,
                role: 'credit',
                expectedDeltaAtomic: BigInt(credit.atomicAmount), // positive
                // burnerCreditMin's ATA may be created inside the swap tx
                // (Jupiter inserts CreateAssociatedTokenAccount when needed).
                existencePolicy: { mustExistBefore: false, allowCreate: true, allowClose: false },
                deltaTolerance: { mode: 'gte_min_minus_bps', minRequired: BigInt(credit.atomicAmount), bps: BigInt(expectedDelta.toleranceBps || 0) },
            });
        }
    } else if (kind === 'solana_send' || kind === 'agent_pay_x402') {
        const recipient = expectedDelta.recipient;
        if (recipient) {
            const expectedReceived = BigInt(debit.atomicAmount);
            checks.push({
                address: recipient.account,
                mint: recipient.mint,
                role: 'recipient',
                expectedDeltaAtomic: expectedReceived,
                // Recipient ATA may be created inside the transfer tx
                // (Jupiter / x402 / solana_send all may insert ATA create).
                existencePolicy: { mustExistBefore: false, allowCreate: true, allowClose: false },
                deltaTolerance: (recipient.mint !== 'native_sol' && expectedDelta.tokenStandard !== 'token_2022')
                    ? { mode: 'exact' }
                    // Token-2022 with possible transfer-fee, or native SOL fees:
                    // accept >= 50% of declared. Caller-declared transferFeeBps
                    // can tighten this in a future amendment.
                    : { mode: 'gte_min_minus_bps', minRequired: expectedReceived, bps: 5000n },
            });
        }
    } else if (kind === 'jupiter_trigger_create_deposit' || kind === 'jupiter_dca_create_deposit') {
        // No burner credit at deposit time; output happens at fill time
        // in a separate tx the burner doesn't sign. depositVault is
        // REQUIRED for deposit kinds (contract v8.3): we verify a positive
        // credit on the named vault >= burnerDebit.atomicAmount minus a
        // 50 bps headroom for any internal Jupiter fee/slippage. The shape
        // validator above rejects with expected_delta_invalid_shape if
        // depositVault is absent, so callers that cannot provide it must
        // route to main wallet (forceRouting='main') instead.
        const vault = expectedDelta.depositVault;
        if (vault) {
            checks.push({
                address: vault.pubkey,
                mint: expectedDelta.burnerDebit ? expectedDelta.burnerDebit.mint : 'native_sol',
                role: 'vault',
                expectedDeltaAtomic: BigInt(expectedDelta.burnerDebit ? expectedDelta.burnerDebit.atomicAmount : 0),
                // Vault MAY be created at deposit time (Jupiter Trigger V2
                // registers vaults lazily).
                existencePolicy: { mustExistBefore: false, allowCreate: true, allowClose: false },
                deltaTolerance: { mode: 'gte_min_minus_bps', minRequired: BigInt(expectedDelta.burnerDebit ? expectedDelta.burnerDebit.atomicAmount : 0), bps: 50n },
            });
        }
    }

    return checks;
}

/**
 * Apply tolerance band to compare observed vs expected delta. Returns:
 *   null if within tolerance, OR { reason, ctx } reject info if out-of-band.
 */
function applyTolerance(observedDelta, expectedDelta, deltaTolerance, mint) {
    const { mode } = deltaTolerance;
    if (mode === 'exact') {
        if (observedDelta !== expectedDelta) {
            return {
                reason: `delta does not match exactly (mint=${mint})`,
                ctx: { expected: expectedDelta.toString(), observed: observedDelta.toString() },
            };
        }
        return null;
    }
    if (mode === 'sol_fee_headroom') {
        // observed should be in [expected - headroom, expected] — burner can
        // pay UP TO `headroom` more (network fees + rent) but NEVER less.
        const headroom = deltaTolerance.headroom;
        if (observedDelta > expectedDelta) {
            return {
                reason: 'burner spent less SOL than declared (delta higher than expected)',
                ctx: { expected: expectedDelta.toString(), observed: observedDelta.toString() },
            };
        }
        if (observedDelta < expectedDelta - headroom) {
            return {
                reason: 'burner spent more SOL than declared + fee headroom',
                ctx: { expected: expectedDelta.toString(), observed: observedDelta.toString(), headroom: headroom.toString() },
            };
        }
        return null;
    }
    if (mode === 'gte_min_minus_bps') {
        const { minRequired, bps } = deltaTolerance;
        const floor = (minRequired * (10000n - bps)) / 10000n;
        if (observedDelta < floor) {
            return {
                reason: `delta ${observedDelta} below floor ${floor} (min=${minRequired}, bps=${bps})`,
                ctx: { minRequired: minRequired.toString(), floor: floor.toString(), observed: observedDelta.toString(), bps: bps.toString() },
            };
        }
        return null;
    }
    if (mode === 'zero_within_headroom') {
        const headroom = deltaTolerance.headroom;
        // observed should be in [-headroom, +headroom] — net zero ± fees.
        if (observedDelta < -headroom) {
            return {
                reason: 'burner drained more than zero-value headroom',
                ctx: { observed: observedDelta.toString(), headroom: headroom.toString() },
            };
        }
        return null;
    }
    if (mode === 'nonneg') {
        if (observedDelta < 0n) {
            return { reason: 'expected non-negative delta', ctx: { observed: observedDelta.toString() } };
        }
        return null;
    }
    return { reason: `unknown tolerance mode "${mode}"`, ctx: {} };
}

/**
 * Validate burner balance changes from a dual-source simulation against the
 * caller's declared `expectedDelta`. Per Codex amendment #8.1:
 *   - PRIMARY: accounts-config + getMultipleAccounts pre-snapshot.
 *     `sim.value.accounts[i]` (post-state, base64-decoded) + `preSnapshot[i]`
 *     (pre-state, also base64-decoded via spl-token-layout helpers).
 *     Address order is the order declared in `requestedAddresses`.
 *   - AUXILIARY: `sim.value.preTokenBalances` / `postTokenBalances` /
 *     `preBalances` / `postBalances`. Cross-check ONLY when present;
 *     disagreement → simulation_delta_mismatch (security-class).
 *
 * Per-account existence policy (Codex amendment #2) applied at primary
 * resolution time: undeclared null transition fails closed.
 *
 * @param {object} sim                  - { value: {...} } shape from simulateTransaction
 * @param {Array<object|null>} preSnapshot - getMultipleAccounts response array, same order as requestedAddresses
 * @param {string[]} requestedAddresses - addresses passed in accounts.config.addresses
 * @param {string[]} combinedAccountKeys - static + loadedAddresses (for aux index lookup)
 * @param {string} burnerPubkey
 * @param {object} expectedDelta
 * @returns {{ ok: boolean, error?: string, reason?: string, class?: string }}
 */
function validateSimDelta(sim, preSnapshot, requestedAddresses, combinedAccountKeys, burnerPubkey, expectedDelta) {
    const checks = buildAccountChecks(expectedDelta, burnerPubkey);
    const simValue = sim && sim.value;
    if (!simValue) {
        return reject('simulation_failed', 'sim.value missing from simulator response');
    }
    const postAccounts = Array.isArray(simValue.accounts) ? simValue.accounts : null;

    for (const check of checks) {
        // ── Resolve primary pre + post ──
        const reqIdx = requestedAddresses.indexOf(check.address);
        if (reqIdx < 0) {
            return reject('simulation_metadata_missing',
                `address ${check.address} (role=${check.role}) was not requested in accounts.config — caller bug`);
        }
        if (!postAccounts || postAccounts.length <= reqIdx) {
            return reject('simulation_metadata_missing',
                `value.accounts[${reqIdx}] missing for ${check.address} (role=${check.role})`);
        }
        const preAI = readAccountInfo(preSnapshot[reqIdx]);
        const postAI = readAccountInfo(postAccounts[reqIdx]);

        // ── Existence-policy gate (Codex amendment #2) ──
        if (!preAI.exists && !check.existencePolicy.allowCreate && check.existencePolicy.mustExistBefore) {
            return reject('simulation_metadata_missing',
                `pre-snapshot for ${check.address} (role=${check.role}) is null and mustExistBefore=true`);
        }
        if (!postAI.exists && !check.existencePolicy.allowClose) {
            return reject('simulation_delta_mismatch',
                `post-state for ${check.address} (role=${check.role}) is null but allowClose=false — unexpected account closure`);
        }
        if (!preAI.exists && postAI.exists && !check.existencePolicy.allowCreate && !check.existencePolicy.mustExistBefore) {
            return reject('simulation_delta_mismatch',
                `account ${check.address} (role=${check.role}) was created in tx but neither allowCreate nor mustExistBefore declared`);
        }

        // ── Compute primary delta ──
        let primaryDelta;
        if (check.mint === 'native_sol') {
            primaryDelta = lamportsDelta(preAI, postAI).delta;
        } else {
            // SPL token: both pre and post must decode as SPL Token accounts.
            // If pre is missing data but post has it (allowCreate), pre side
            // contributes 0 to the delta.
            const td = tokenDelta(preAI, postAI);
            primaryDelta = td.delta;
            // Optional sanity: declared mint should match the decoded mint
            // (when both sides have splToken metadata).
            if (preAI.exists && preAI.splToken && preAI.splToken.mint !== check.mint) {
                return reject('simulation_mint_mismatch',
                    `pre ${check.address} mint ${preAI.splToken.mint} != declared ${check.mint}`);
            }
            if (postAI.exists && postAI.splToken && postAI.splToken.mint !== check.mint) {
                return reject('simulation_mint_mismatch',
                    `post ${check.address} mint ${postAI.splToken.mint} != declared ${check.mint}`);
            }
        }

        // ── Apply tolerance ──
        const toleranceErr = applyTolerance(primaryDelta, check.expectedDeltaAtomic, check.deltaTolerance, check.mint);
        if (toleranceErr) {
            return rejectDeltaMismatch(`primary delta out of band for ${check.address} (role=${check.role}): ${toleranceErr.reason}`, toleranceErr.ctx);
        }

        // ── Auxiliary cross-check (Codex amendment #6: OPTIONAL when present) ──
        const combinedIdx = indexOfPubkey(combinedAccountKeys, check.address);
        let auxDelta = null;
        if (combinedIdx >= 0) {
            if (check.mint === 'native_sol') {
                auxDelta = auxiliarySolDelta(simValue, combinedIdx);
            } else {
                auxDelta = auxiliaryTokenDelta(simValue, combinedIdx, check.mint);
            }
        }
        if (auxDelta !== null && auxDelta !== primaryDelta) {
            return rejectDeltaMismatch(
                `primary vs auxiliary delta disagreement for ${check.address} (role=${check.role})`,
                {
                    primary: primaryDelta.toString(),
                    auxiliary: auxDelta.toString(),
                    mint: check.mint,
                }
            );
        }
    }

    return accept();
}

// ─── Public entry point ───────────────────────────────────────────────────

/**
 * Validate an autonomous burner tx against the per-tool expectedDelta
 * contract. Returns a structured `{ ok, error?, reason?, class? }`
 * object — callers (`BurnerSigner.signTransaction()` and
 * `signAndSend()`) MUST NOT call the bridge if `ok === false`.
 *
 * SIMULATOR INTERFACE (v8.1, Codex amendment #1 + dual-source contract):
 *   The simulator is an async fn:
 *     `simulator(txBase64, { addresses }) → { sim, preSnapshot, slot }`
 *   - `addresses`: array of base58 pubkeys the policy declares interest in
 *     (built from `expectedDelta` via `buildAccountChecks` + burnerPubkey +
 *     burnerOwnedAccounts).
 *   - Returns:
 *     - `sim`: result of `solanaRpc('simulateTransaction', [tx, { sigVerify:
 *       false, replaceRecentBlockhash: true, encoding: 'base64',
 *       innerInstructions: true, accounts: { addresses, encoding: 'base64' } }])`.
 *       Shape: `{ value: { err, logs, loadedAddresses, accounts, ... } }`
 *       Optional auxiliary fields: `value.preTokenBalances` /
 *       `value.postTokenBalances` / `value.preBalances` / `value.postBalances`.
 *     - `preSnapshot`: array of `accountInfo|null`, same order as `addresses`,
 *       fetched via `getMultipleAccounts(addresses, { encoding: 'base64',
 *       commitment: 'processed' })` IMMEDIATELY before `simulateTransaction`.
 *     - `slot` (optional, for diagnostics).
 *   - The simulator MUST use the same RPC URL/source AND the same commitment
 *     for both calls (Codex amendment #8.1 §3).
 *
 * @param {string} txBase64
 * @param {object} expectedDelta - caller-declared per-tx contract.
 * @param {object} options
 * @param {string} options.burnerPubkey - REQUIRED.
 * @param {Function} [options.simulator] - REQUIRED in production. See above.
 * @param {boolean} [options.allowStructuralOnly] - When true AND no simulator
 *   is provided, returns `{ ok: true, structuralOnly: true }` after the
 *   structural + signer + drainer checks. Defaults to `false`. In production
 *   (`BurnerSigner`) this option is hard-disabled — unit tests opt in.
 * @returns {Promise<{ ok: boolean, error?: string, reason?: string,
 *   class?: 'security'|'availability'|'contract_gap',
 *   programs?: number[], structuralOnly?: boolean, simulated?: boolean }>}
 */
async function validateBurnerTx(txBase64, expectedDelta, options) {
    options = options || {};

    // (A3) Burner pubkey must be supplied. Caller (`BurnerSigner`) fetches
    // from `/burner/status`.
    if (!isNonEmptyBase58(options.burnerPubkey)) {
        return reject('payer_missing', 'options.burnerPubkey is required and must be a base58 pubkey');
    }

    // ── 1. expectedDelta shape ──
    const deltaCheck = validateExpectedDeltaShape(expectedDelta);
    if (!deltaCheck.ok) return deltaCheck;

    // ── 2. Parse tx ──
    let parsed;
    try {
        parsed = parseTransaction(txBase64);
    } catch (e) {
        if (e instanceof TxParseError) {
            return reject('tx_unparseable', e.message);
        }
        return reject('policy_parse_uncertainty', `unexpected parse error: ${e.message}`);
    }

    // ── 3. Signer mode ──
    const signerCheck = validateSignerMode(parsed, options.burnerPubkey, expectedDelta);
    if (!signerCheck.ok) return signerCheck;

    // ── 4. Drainer opcodes (static-key only; ALT-resolved instructions
    //       are re-walked after simulation with combined keys) ──
    const declaredOwned = Array.isArray(expectedDelta.burnerOwnedAccounts)
        ? expectedDelta.burnerOwnedAccounts.filter(isNonEmptyBase58)
        : [];
    const drainerCheck = validateDrainerOpcodes(parsed, declaredOwned, expectedDelta);
    if (!drainerCheck.ok) return drainerCheck;

    // ── 5. Structural-only short-circuit (test mode only) ──
    if (typeof options.simulator !== 'function') {
        if (options.allowStructuralOnly === true) {
            return accept({
                structuralOnly: true,
                programs: parsed.instructions.map(i => i.programIdIdx),
            });
        }
        // Production default: missing simulator is fail-closed (Codex amendment
        // #8.1 §7 — no structural-only production path).
        return reject('simulation_failed', 'simulator is required (allowStructuralOnly=false in production)');
    }

    // ── 6. Build requested-addresses list (Codex amendment #8.1 §1) ──
    //     The simulator MUST request post-state for every address whose
    //     delta we'll validate. Order is the order we'll index into
    //     sim.value.accounts[] and preSnapshot[].
    const checks = buildAccountChecks(expectedDelta, options.burnerPubkey);
    const addressSet = new Set();
    for (const c of checks) addressSet.add(c.address);
    // Also include declared burner-owned accounts so the simulation-derived
    // ownership detection (step 9 below) can use the preSnapshot owner field.
    for (const a of declaredOwned) addressSet.add(a);
    const requestedAddresses = [...addressSet];

    // ── 7. Simulation (v8.1 dual-source) ──
    let simResult;
    try {
        simResult = await options.simulator(txBase64, { addresses: requestedAddresses });
    } catch (e) {
        return reject('simulation_failed', e && e.message ? e.message : String(e));
    }
    if (!simResult || typeof simResult !== 'object') {
        return reject('simulation_failed', 'simulator returned non-object result');
    }
    const sim = simResult.sim;
    const preSnapshot = Array.isArray(simResult.preSnapshot) ? simResult.preSnapshot : null;
    if (!sim || typeof sim !== 'object' || !sim.value || typeof sim.value !== 'object') {
        return reject('simulation_failed', 'simulator returned no sim.value object');
    }
    if (!preSnapshot || preSnapshot.length !== requestedAddresses.length) {
        return reject('simulation_metadata_missing',
            `preSnapshot missing or wrong length (expected ${requestedAddresses.length}, got ${preSnapshot ? preSnapshot.length : 'null'})`);
    }
    if (sim.value.err !== null && sim.value.err !== undefined) {
        const errStr = typeof sim.value.err === 'string' ? sim.value.err : JSON.stringify(sim.value.err);
        return reject('simulation_returned_error', `simulation failed on-chain: ${errStr}`);
    }

    // ── 8. Build combined account keys (static + loadedAddresses) ──
    const loaded = sim.value.loadedAddresses || {};
    const writableALT = Array.isArray(loaded.writable) ? loaded.writable.filter(isNonEmptyBase58) : [];
    const readonlyALT = Array.isArray(loaded.readonly) ? loaded.readonly.filter(isNonEmptyBase58) : [];
    const combinedAccountKeys = [
        ...parsed.staticAccountKeys,
        ...writableALT,
        ...readonlyALT,
    ];

    // ── 9. ALT resolution check (Codex amendment #2) ──
    for (let i = 0; i < parsed.instructions.length; i++) {
        const idx = parsed.instructions[i].programIdIdx;
        if (idx >= combinedAccountKeys.length) {
            return reject('alt_unresolved',
                `instruction[${i}] programIdIdx ${idx} not resolved via static (${parsed.staticAccountKeys.length}) + loadedAddresses (${writableALT.length + readonlyALT.length})`);
        }
    }

    // ── 10. Simulation-derived burner-owned set (Codex amendment #4) ──
    //      Layer 2 ownership: preSnapshot SPL token accounts whose
    //      decoded `owner` == burnerPubkey, plus auxiliary
    //      preTokenBalances/postTokenBalances when present.
    const simOwned = new Set();
    simOwned.add(options.burnerPubkey);
    // From preSnapshot (primary)
    for (let i = 0; i < preSnapshot.length; i++) {
        const ai = readAccountInfo(preSnapshot[i]);
        if (ai.exists && ai.splToken && ai.splToken.owner === options.burnerPubkey) {
            simOwned.add(requestedAddresses[i]);
        }
    }
    // From auxiliary pre/post token balance arrays (when present)
    const addOwnedFromBalances = (balances) => {
        if (!Array.isArray(balances)) return;
        for (const b of balances) {
            if (!b || b.owner !== options.burnerPubkey) continue;
            if (!Number.isInteger(b.accountIndex)) continue;
            if (b.accountIndex >= 0 && b.accountIndex < combinedAccountKeys.length) {
                simOwned.add(combinedAccountKeys[b.accountIndex]);
            }
        }
    };
    addOwnedFromBalances(sim.value.preTokenBalances);
    addOwnedFromBalances(sim.value.postTokenBalances);

    // ── 11. Drainer re-walk with combined keys + full ownership union ──
    const ownedUnion = [...new Set([...declaredOwned, ...simOwned])];
    const combinedParsed = {
        staticAccountKeys: combinedAccountKeys,
        numRequiredSignatures: parsed.numRequiredSignatures,
        instructions: parsed.instructions,
    };
    const drainerCheck2 = validateDrainerOpcodes(combinedParsed, ownedUnion, expectedDelta);
    if (!drainerCheck2.ok) return drainerCheck2;

    // ── 12. Per-shape delta validation (v8.1 dual-source) ──
    const deltaResult = validateSimDelta(sim, preSnapshot, requestedAddresses, combinedAccountKeys, options.burnerPubkey, expectedDelta);
    if (!deltaResult.ok) return deltaResult;

    return accept({
        simulated: true,
        programs: parsed.instructions.map(i => i.programIdIdx),
    });
}

module.exports = {
    REJECT_CODES,
    REJECT_CLASS,
    DELTA_KINDS,
    SIGNER_MODES,
    validateBurnerTx,
    // Internal helpers exported for testing only.
    _validateSignerMode: validateSignerMode,
    _validateDrainerOpcodes: validateDrainerOpcodes,
    _validateExpectedDeltaShape: validateExpectedDeltaShape,
    _validateSimDelta: validateSimDelta,
    _buildAccountChecks: buildAccountChecks,
    _applyTolerance: applyTolerance,
    _indexOfPubkey: indexOfPubkey,
};
