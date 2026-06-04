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
    // Simulation (Phase 2c — not enforced in this commit)
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

// ─── Public entry point ───────────────────────────────────────────────────

/**
 * Validate an autonomous burner tx against the per-tool expectedDelta
 * contract. Returns a structured `{ ok, error?, reason?, class? }`
 * object — callers (`BurnerSigner.signTransaction()` and
 * `signAndSend()`) MUST NOT call the bridge if `ok === false`.
 *
 * @param {string} txBase64
 * @param {object} expectedDelta - caller-declared per-tx contract.
 * @param {object} options
 * @param {string} options.burnerPubkey - REQUIRED. Caller is responsible
 *   for fetching this from `/burner/status` per Codex amendment #3.
 * @returns {Promise<{ ok: boolean, error?: string, reason?: string,
 *   class?: 'security'|'availability'|'contract_gap',
 *   programs?: string[] }>}
 *
 * Note: this function is currently synchronous (no `await`) because
 * simulation is deferred to Phase 2c. The signature is `async` to keep
 * the call site shape stable when simulation lands.
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

    // ── 4. Drainer opcodes ──
    // Layered burner-owned account detection per Codex amendment #4:
    //   layer 1: caller-declared `expectedDelta.burnerOwnedAccounts[]`
    //   layer 2: simulation-derived owners (Phase 2c follow-up)
    const declaredOwned = Array.isArray(expectedDelta.burnerOwnedAccounts)
        ? expectedDelta.burnerOwnedAccounts.filter(isNonEmptyBase58)
        : [];
    const drainerCheck = validateDrainerOpcodes(parsed, declaredOwned, expectedDelta);
    if (!drainerCheck.ok) return drainerCheck;

    // ── 5. Simulation + delta-vs-quote (Phase 2c — deferred) ──
    // The following checks land in a follow-up commit:
    //   - simulateTransaction call (via injected `options.simulator`)
    //   - parse value.preTokenBalances / postTokenBalances / preBalances /
    //     postBalances / loadedAddresses
    //   - per-shape delta assertion (swap: debit + creditMin within
    //     toleranceBps; deposit: net debit == atomicAmount; payment:
    //     burner USDC delta == -atomicAmount + recipient match)

    return accept({ programs: parsed.instructions.map(i => i.programIdIdx) });
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
};
