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
// This module is the policy gate. Burner signs go through
// `BurnerSigner.signTransaction()` / `signAndSend()`, which call
// `validateBurnerTx()` before any bridge HTTP call when the caller
// supplies `opts.expectedDelta`. If policy rejects, no signature ever
// leaves the device.
//
// TRANSITIONAL: `wallet/burner-signer.js` retains a warn-pass-through
// path for callers that have NOT yet been migrated to pass
// `expectedDelta`. When the bypass fires, a console warning is logged
// and the tx proceeds without policy gating (this is the v1 behavior
// preserved for backward-compat during the BAT-582 → BAT-1013 caller
// migration). The bypass MUST be removed once every caller in the
// codebase wires `expectedDelta` — tracking this in a follow-up. As of
// BAT-1013 ship, every production caller (solana_swap, solana_send,
// agent_pay, jupiter_trigger_*, jupiter_dca_*) IS migrated; the bypass
// remains only as a defense against an unknown future caller.
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
// 5. (Phase 2c, IMPLEMENTED) Run `simulateTransaction` + same-RPC
//    `getMultipleAccounts` pre-snapshot and assert burner's net delta
//    matches `expectedDelta` within caller-provided tolerance. The
//    structural + drainer + signer-mode checks PLUS this simulation
//    delta validator close the immediate failure modes from the
//    BAT-995 device incident (whitelist DoS) and from the Crypto
//    Copilot drainer class (extra SystemProgram::transfer instructions
//    slipped into a swap — caught here by per-shape delta validation
//    + drainer blocklist + per-burner-owned-account zero-delta guards
//    for zero_value kinds).
//
// CODEX AMENDMENTS RESPONDED TO
// -----------------------------
// (A1) Parser: uses `wallet/tx-parser.js` (extracted, tested). No
//      reference to a nonexistent `_decodeVersionedMessage`.
// (A2) Simulation: IMPLEMENTED. Uses `loadedAddresses` from the
//      simulation response (NOT `value.accountKeys`, which doesn't
//      exist). See `_lazyDefaultSimulator` in `wallet/burner-signer.js`
//      for the dual-source contract (accounts config +
//      getMultipleAccounts pre-snapshot, both same-RPC same-commitment).
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
//      `tests/jupiter-ultra/live-burner-policy-helius.js`, NOT in this module.
// (A8) Foundation/security review class — R10+ Copilot expected.

'use strict';

const { TxParseError, parseTransaction, base58Decode } = require('./tx-parser');

const { readAccountInfo, tokenDelta, lamportsDelta } = require('./spl-token-layout');

// Sentinel for SPL accounts whose mint is unknown at expectedDelta build
// time but whose amount delta MUST equal zero (Copilot PR #398 R7:
// burner-owned SPL token accounts in zero_value flows). Recognized by
// validateSimDelta: skips the declared-vs-decoded mint match check and
// uses tokenDelta for delta computation.
const SPL_MINT_AGNOSTIC = '__spl_mint_agnostic__';

// ─── Reject codes (locked: REJECT_CODES.length must equal 28) ─────────────
//
// BAT-1031: locked length lowered 29 → 28. The `simulation_recipient_mismatch`
// code was the only fire site for the prior `validateSimDelta expectedTokenOwner`
// branch (a depositVault-destination-owner binding that did not work against
// the prod burner — see BAT-1031). The branch is deleted, and the code goes
// with it. If a future BAT revives same-class recipient-owner binding,
// re-introduce the code together with the producer + tests.
//
// BAT-1013-followup amendment: locked length bumped 26 → 29 to accommodate
// three new fail-closed paths shipped with producers:
//   - drainer_burn (B2): SPL Burn / BurnChecked on burner-owned account
//   - token_2022_extension_unsupported (B3): Token-2022 extension opcode
//   - token_2022_send_unsupported (C6/B3): SPL-token-2022 send/pay without
//     caller-declared tokenStandardConfig

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
    'drainer_burn',              // NEW (B2): SPL Burn/BurnChecked on burner-owned account
    // Account ownership
    'account_ownership_uncertain',
    'token_2022_undeclared',
    'token_2022_extension_unsupported', // NEW (B3): Token-2022 extension opcode without declaration
    'token_2022_send_unsupported',      // NEW (C6/B3): solana_send/pay to Token-2022 mint
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
    drainer_burn: 'security',                       // NEW (B2)
    signer_set_unexpected: 'security',
    signer_count_mismatch: 'security',
    burner_not_signer: 'security',
    payer_mismatch: 'security',
    fee_payer_not_in_allowlist: 'security',
    cosigner_not_in_allowlist: 'security',
    simulation_delta_mismatch: 'security',
    simulation_mint_mismatch: 'security',
    account_ownership_uncertain: 'security',
    token_2022_undeclared: 'security',
    token_2022_extension_unsupported: 'security',   // NEW (B3)
    token_2022_send_unsupported: 'security',        // NEW (C6/B3)
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
//
// NOTE (BAT-1013-followup): this object is the per-program opcode registry
// referenced by the architecture's "TokenInstructionRegistry" abstraction.
// Adding a new drainer opcode is a 1-line registry addition + matching
// handler in validateDrainerOpcodes — no new conditional branch needed
// beyond the dispatch table.
const TOKEN_IX = Object.freeze({
    TRANSFER: 3,              // NEW (R11): only drainer-class in zero_value flows
    APPROVE: 4,
    SET_AUTHORITY: 6,
    BURN: 8,                  // NEW (B2): drainer Burn opcode
    CLOSE_ACCOUNT: 9,
    TRANSFER_CHECKED: 12,     // NEW (R11): only drainer-class in zero_value flows
    APPROVE_CHECKED: 13,
    BURN_CHECKED: 15,         // NEW (B2): drainer BurnChecked opcode
});

// Token-2022 extension instruction discriminators (first byte of data when
// programId == TOKEN_2022_PROGRAM_ID). The Token-2022 program reuses
// 0x00..0x1F for the legacy SPL Token opcodes (shared layout with TOKEN_IX
// above), and uses 0x20..0x3F+ for Token-2022 specific extensions. Any
// extension opcode targeting a burner-owned account when the caller has
// NOT declared `tokenStandard: 'token_2022'` is fail-closed under
// `token_2022_extension_unsupported`. The named extensions below are
// documented for clarity; the gate is range-based (any byte >= 0x20).
//
// Source: github.com/solana-program/token-2022 src/instruction.rs
const TOKEN_2022_EXTENSION_MIN_OPCODE = 0x20;
const TOKEN_2022_EXTENSION_NAMES = Object.freeze({
    0x22: 'PermanentDelegate',
    0x2b: 'TransferHook',
    0x32: 'ConfidentialTransfer',
    0x21: 'TransferFee',
    0x23: 'InterestBearingMint',
    0x25: 'CpiGuard',
});

// System Program instruction discriminators (little-endian u32, first 4 bytes).
// Source: github.com/solana-labs/solana/blob/master/runtime/src/system_processor.rs
const SYSTEM_IX = Object.freeze({
    ASSIGN: 1,
    ADVANCE_NONCE_ACCOUNT: 4,
});

// Token-2022 send/pay guard: a list of mints that REQUIRE
// tokenStandardConfig (with transferFeeBps) to be declared before the
// burner will sign a transfer to them. v1 implementation: if the caller
// declares `tokenStandard: 'token_2022'` on solana_send / agent_pay_x402
// but does NOT supply tokenStandardConfig.transferFeeBps, we fail closed
// with token_2022_send_unsupported. Closes C6 — no more hardcoded 50%
// tolerance default for Token-2022 recipients.
const TOKEN_2022_SEND_KINDS = new Set(['solana_send', 'agent_pay_x402']);

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

// ─── BAT-1024: on-chain simulation error decoder ──────────────────────────
//
// When sim.value.err is `{InstructionError: [N, {Custom: M}]}`, Solana's
// json-stringified form is opaque to humans ("Custom:1" tells you nothing).
// To make the agent's reply actionable, we:
//   1. Translate Custom:M against the per-program error enum (table below)
//   2. Name the program even when the code is unknown
//   3. Surface the simulation's `logs[]` tail (the Program log lines that
//      explain what actually failed — most simulators include them)
//
// Sources for each table are upstream program repos. Per the
// `feedback_official_docs_over_memory` rule, every entry MUST be traceable
// to a source URL in the // SOURCE: comment below the table. Do not add
// codes from memory.
//
// Common case (today's BAT-1013 device test, 2026-06-08): Jupiter Trigger V2
// createOrder fails with `{"InstructionError":[3,{"Custom":1}]}`. ix index 3
// is the SPL Token transfer that funds the deposit vault — Custom:1 = SPL
// Token TokenError::InsufficientFunds, which means the burner's source ATA
// didn't have enough lamports (almost always SOL rent for newly-created
// vault/order accounts, NOT the input-token balance — because the SOL math
// for rent must succeed independently of the input transfer).

const PROGRAM_ERROR_TABLES = Object.freeze({
    // SPL Token program (classic SPL token, not Token-2022).
    // SOURCE: github.com/solana-labs/solana-program-library
    //         token/program/src/error.rs  (TokenError enum)
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA': {
        name: 'SPL Token',
        codes: Object.freeze({
            0: { name: 'NotRentExempt', description: 'Lamport balance below rent-exempt threshold.' },
            1: { name: 'InsufficientFunds', description: 'Source account does not have enough tokens (or lamports for rent) to fund the transfer.' },
            2: { name: 'InvalidMint', description: 'Token mint mismatch.' },
            3: { name: 'MintMismatch', description: 'Account mint does not match the operation mint.' },
            4: { name: 'OwnerMismatch', description: 'Owner does not match expected.' },
            5: { name: 'FixedSupply', description: 'Mint is fixed supply; cannot mint more.' },
            6: { name: 'AlreadyInUse', description: 'Account is already initialized.' },
            7: { name: 'InvalidNumberOfProvidedSigners', description: 'Invalid number of provided signers for multisig.' },
            8: { name: 'InvalidNumberOfRequiredSigners', description: 'Invalid number of required signers for multisig.' },
            9: { name: 'UninitializedState', description: 'State is uninitialized.' },
            10: { name: 'NativeNotSupported', description: 'Native mint is not supported by this instruction.' },
            11: { name: 'NonNativeHasBalance', description: 'Non-native account can only be closed if its balance is zero.' },
            12: { name: 'InvalidInstruction', description: 'Invalid instruction.' },
            13: { name: 'InvalidState', description: 'State is invalid for the requested operation.' },
            14: { name: 'Overflow', description: 'Arithmetic overflow during token operation.' },
            15: { name: 'AuthorityTypeNotSupported', description: 'Authority type not supported.' },
            16: { name: 'MintCannotFreeze', description: 'Mint has no freeze authority.' },
            17: { name: 'AccountFrozen', description: 'Token account is frozen.' },
            18: { name: 'MintDecimalsMismatch', description: 'Mint decimals do not match decimals declared in the instruction.' },
            19: { name: 'NonNativeNotSupported', description: 'Non-native account is not supported by this instruction.' },
        }),
    },
    // System Program — base lamport movement + account create.
    // SOURCE: docs.solana.com & solana SDK system_instruction error enum
    '11111111111111111111111111111111': {
        name: 'System Program',
        codes: Object.freeze({
            0: { name: 'AccountAlreadyInUse', description: 'Account is already in use (already created).' },
            1: { name: 'ResultWithNegativeLamports', description: 'Transfer would leave the source account with negative lamports.' },
            2: { name: 'InvalidProgramId', description: 'Invalid program id supplied.' },
            3: { name: 'InvalidAccountDataLength', description: 'Invalid account data length.' },
            4: { name: 'MaxSeedLengthExceeded', description: 'Seed length exceeds limit.' },
            5: { name: 'AddressWithSeedMismatch', description: 'Derived address does not match supplied address.' },
            6: { name: 'NonceNoRecentBlockhashes', description: 'No recent blockhashes available to advance the nonce.' },
            7: { name: 'NonceBlockhashNotExpired', description: 'Nonce blockhash has not yet expired.' },
            8: { name: 'NonceUnexpectedBlockhashValue', description: 'Unexpected blockhash value in nonce account.' },
        }),
    },
    // SPL Associated Token Account program.
    // SOURCE: github.com/solana-labs/solana-program-library
    //         associated-token-account/program/src/error.rs
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL': {
        name: 'SPL Associated Token Account',
        codes: Object.freeze({
            0: { name: 'InvalidOwner', description: 'Account is not owned by the expected program.' },
        }),
    },
    // Token-2022 program (extensions). Shares the SPL Token base codes 0-19;
    // extension codes start higher. Only the base codes are listed here —
    // extension codes can be added as encountered.
    // SOURCE: github.com/solana-labs/solana-program-library
    //         token/program-2022/src/error.rs
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb': {
        name: 'Token-2022',
        codes: Object.freeze({
            0: { name: 'NotRentExempt', description: 'Lamport balance below rent-exempt threshold.' },
            1: { name: 'InsufficientFunds', description: 'Source account does not have enough tokens (or lamports for rent) to fund the transfer.' },
            2: { name: 'InvalidMint', description: 'Token mint mismatch.' },
            3: { name: 'MintMismatch', description: 'Account mint does not match the operation mint.' },
            4: { name: 'OwnerMismatch', description: 'Owner does not match expected.' },
            14: { name: 'Overflow', description: 'Arithmetic overflow during token operation.' },
            17: { name: 'AccountFrozen', description: 'Token account is frozen.' },
        }),
    },
});

function programNameOf(programId) {
    if (!programId || typeof programId !== 'string') return 'unknown program';
    const t = PROGRAM_ERROR_TABLES[programId];
    if (t) return t.name;
    // Friendly truncation: first 4 + last 4 chars so logs stay scannable.
    const head = programId.slice(0, 4);
    const tail = programId.slice(-4);
    return `unknown program (${head}…${tail})`;
}

function decodeCustomError(programId, customCode) {
    if (!programId || typeof customCode !== 'number') return null;
    const t = PROGRAM_ERROR_TABLES[programId];
    if (!t) return null;
    const entry = t.codes[customCode];
    if (!entry) return null;
    return { program: t.name, name: entry.name, description: entry.description };
}

function summarizeSimulationLogs(logs, maxLines = 5, maxLineLen = 160) {
    if (!Array.isArray(logs) || logs.length === 0) return '';
    return logs.slice(-maxLines)
        .map((l) => {
            const s = String(l == null ? '' : l);
            return s.length > maxLineLen ? s.slice(0, maxLineLen - 3) + '...' : s;
        })
        .join('\n  ');
}

/**
 * Build the human-readable reject reason for a simulation_returned_error.
 * Decodes InstructionError[idx, {Custom: code}] against per-program tables;
 * appends `unitsConsumed` + the tail of `sim.value.logs[]` for diagnostics.
 *
 * `combinedAccountKeys` may be null when the err is detected before ALT
 * resolution runs; in that case the program-name lookup falls back to
 * static account keys only (still useful — most failing instructions
 * reference statically-listed programs like SPL Token).
 */
function formatSimulationErrorReason(simValue, parsed, combinedAccountKeys) {
    const err = simValue.err;
    const errStr = typeof err === 'string' ? err : JSON.stringify(err);
    let primary = `simulation failed on-chain: ${errStr}`;

    if (err && typeof err === 'object' && Array.isArray(err.InstructionError)) {
        const ixIdx = err.InstructionError[0];
        const body = err.InstructionError[1];
        if (typeof ixIdx === 'number' && body && typeof body.Custom === 'number'
            && parsed && Array.isArray(parsed.instructions)
            && ixIdx >= 0 && ixIdx < parsed.instructions.length) {
            const instr = parsed.instructions[ixIdx];
            const keys = combinedAccountKeys || parsed.staticAccountKeys || [];
            const programId = (instr && typeof instr.programIdIdx === 'number' && instr.programIdIdx < keys.length)
                ? keys[instr.programIdIdx]
                : null;
            const decoded = programId ? decodeCustomError(programId, body.Custom) : null;
            if (decoded) {
                primary = `${decoded.program} returned ${decoded.name} (code ${body.Custom}): ${decoded.description}`;
                // BAT-1024 Layer 2: SPL Token InsufficientFunds is the
                // most common burner failure mode — almost always SOL
                // rent for newly-created accounts. Append an actionable
                // suggestion so the agent doesn't have to guess.
                if ((programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
                     || programId === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
                    && body.Custom === 1) {
                    primary += ' — burner likely needs SOL top-up for rent (typical: ~0.01-0.02 SOL covers Order PDA + vault ATA). Suggest solana_send(source=main, to=<burner pubkey>, amount=0.02) and retry.';
                }
            } else {
                primary = `${programNameOf(programId)} rejected at instruction ${ixIdx} with Custom:${body.Custom}`;
            }
        }
    }

    const units = (typeof simValue.unitsConsumed === 'number')
        ? ` (unitsConsumed=${simValue.unitsConsumed})`
        : '';
    const logTail = summarizeSimulationLogs(simValue.logs);
    return logTail
        ? `${primary}${units}\n  logs[-5..]:\n  ${logTail}`
        : `${primary}${units}`;
}

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
// Solana protocol cap on signers per tx (per `compact-u16` slot 0 of the
// transaction header — values 0 and >16 are protocol-invalid for any
// reasonable mainnet flow). Used by sponsored mode upper-bound check (C3).
const MAX_SIGNERS_PER_TX = 16;

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
            // C3 (BAT-1013-followup): sponsored mode had NO upper bound on
            // numRequiredSignatures. Solana protocol caps at 16 signers per
            // tx; sponsored mode requires at least 1 (the burner). Enforce
            // both bounds explicitly — without them, a tampered tx claiming
            // 100 signers would be parsed and slip through.
            if (parsed.numRequiredSignatures < 1) {
                return reject('signer_count_mismatch',
                    `sponsored mode requires at least 1 signer, got ${parsed.numRequiredSignatures}`);
            }
            if (parsed.numRequiredSignatures > MAX_SIGNERS_PER_TX) {
                return reject('signer_count_mismatch',
                    `sponsored mode allows at most ${MAX_SIGNERS_PER_TX} signers (Solana protocol cap), got ${parsed.numRequiredSignatures}`);
            }
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
            // C4 (BAT-1013-followup): tighten the documented invariants.
            // In cosigned mode the burner is NOT the fee-payer — the
            // facilitator (or whichever cosigner-allowlist member) pays
            // network fees. Allowing the burner to also appear in
            // feePayerAllowlist would mean a tampered tx could put the
            // burner at slot 0 and slip past the "burner_not_signer"
            // check (the burner IS a signer, just not the expected one).
            // Reject explicitly under fee_payer_not_in_allowlist — the
            // class is security; the agent must not silently retry.
            if (feePayerAllowlist.includes(burnerPubkey)) {
                return reject('fee_payer_not_in_allowlist',
                    `cosigned mode invariant: burner ${burnerPubkey} must NOT appear in feePayerAllowlist (burner is co-signer, not fee-payer)`);
            }
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
/**
 * Resolve account-index in instruction → static-key. Returns null when the
 * index is out of range. Single source of truth for the "subject account"
 * lookup pattern across every drainer opcode.
 *
 * C5 fix (BAT-1013-followup): the legacy walker had inconsistent fail-
 * closed behavior — SetAuthority would correctly reject
 * `account_ownership_uncertain` on out-of-range index, but Approve /
 * CloseAccount / Assign / AdvanceNonce silently CONTINUED past undefined
 * subjects (truthy-check guard). An attacker who could nudge accountIdxs
 * out of range would slip those four opcodes past the policy. Now every
 * call resolves through this helper and rejects identically.
 *
 * Q3 fix: bounds-check uses the combined-keys array length, not the
 * caller-provided slice — the re-walk pass after ALT resolution passes
 * combined keys via parsed.staticAccountKeys; pre-resolution pass uses
 * the actual static keys. Both flows reject the same way.
 */
function resolveSubjectAccount(parsed, instr, subjectIdx, instrIdx, opcodeName) {
    const accountIdxs = instr.accountIdxs;
    if (!accountIdxs || subjectIdx >= accountIdxs.length) {
        return {
            err: reject('account_ownership_uncertain',
                `instruction[${instrIdx}] ${opcodeName} expected account at position ${subjectIdx} but instruction has only ${accountIdxs ? accountIdxs.length : 0} accounts`),
        };
    }
    const acctIdx = accountIdxs[subjectIdx];
    // Bounds-check against the keys we have. If the index points past the
    // end (combinedAccountKeys.length on re-walk, staticAccountKeys.length
    // on first pass), the subject is unresolvable — fail closed.
    if (typeof acctIdx !== 'number' || acctIdx < 0 || acctIdx >= parsed.staticAccountKeys.length) {
        return {
            err: reject('account_ownership_uncertain',
                `instruction[${instrIdx}] ${opcodeName} account index ${acctIdx} out of range (have ${parsed.staticAccountKeys.length} keys)`),
        };
    }
    const acct = parsed.staticAccountKeys[acctIdx];
    if (!acct) {
        return {
            err: reject('account_ownership_uncertain',
                `instruction[${instrIdx}] ${opcodeName} resolved subject is null at index ${acctIdx}`),
        };
    }
    return { acct };
}

function validateDrainerOpcodes(parsed, burnerOwnedAccounts, expectedDelta, burnerPubkey) {
    const ownedSet = new Set(burnerOwnedAccounts);
    // Copilot PR #398 R14 finding #1: burnerPubkey is always implicitly
    // "burner-owned" — it's the system account that holds the burner's
    // native SOL. Without this addition, a System::Assign (or SetAuthority/
    // Approve/CloseAccount/Burn) targeting burnerPubkey directly would
    // escape the drainer-walk because burnerOwnedAccounts only contains
    // SPL-token ATAs supplied by the caller. The most dangerous case is
    // System::Assign(subject=burnerPubkey, new_program_owner=attacker_program):
    // it doesn't move lamports so the delta validator's SOL floor check
    // doesn't catch it, but on-chain the burner's account ownership is
    // reassigned to an attacker-controlled program. Defensive `if (burnerPubkey)`
    // guard so the function is also safe when called directly from tests
    // without the fourth argument.
    if (burnerPubkey) ownedSet.add(burnerPubkey);
    const wsolExemption = (expectedDelta && expectedDelta.kind === 'jupiter_swap_immediate'
        && expectedDelta.wsolAtaExemption
        && isNonEmptyBase58(expectedDelta.wsolAtaExemption.ata)
        && isNonEmptyBase58(expectedDelta.wsolAtaExemption.destination))
        ? expectedDelta.wsolAtaExemption
        : null;
    // Single-fire replay defense (verifier follow-up #4): the wSOL exemption
    // covers EXACTLY ONE CloseAccount in the documented Jupiter Ultra
    // wrapping pattern. A malicious tx with TWO matching CloseAccount
    // instructions would otherwise both fall through the `continue` branch.
    // Track consumption; second matching exemption use rejects.
    let wsolExemptionConsumed = false;

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

            // B3: Token-2022 extension opcode (>= 0x20) is a drainer class
            // unless the caller has explicitly declared tokenStandard +
            // tokenStandardConfig (per-extension config not yet wired).
            // For v1 we fail-closed on ANY Token-2022 extension opcode,
            // even when tokenStandard is declared — extensions like
            // PermanentDelegate/TransferHook/ConfidentialTransfer change
            // the on-chain semantics of the SPL transfer in ways the
            // current delta-validator cannot reason about.
            if (programId === TOKEN_2022_PROGRAM_ID && ix >= TOKEN_2022_EXTENSION_MIN_OPCODE) {
                const name = TOKEN_2022_EXTENSION_NAMES[ix] || `extension_opcode_0x${ix.toString(16)}`;
                return reject('token_2022_extension_unsupported',
                    `instruction[${i}] Token-2022 extension opcode ${name} (0x${ix.toString(16)}) is not allowed for autonomous burner signing in v1`);
            }

            // Drainer instructions on burner-owned accounts:
            // Copilot R11 finding #2 + R-next-8: SPL Token Transfer / TransferChecked
            // is not generally a drainer (it's the WHOLE POINT of swap/send/pay),
            // BUT for zero_value_auth / zero_value_cancel — kinds that mean
            // "no value moves" — a Transfer authorized by the burner drains
            // tokens without being caught by Auth/Close/Approve/Assign/Burn
            // checks.
            //
            // R-next-8 hardening: key the check off the TRANSFER AUTHORITY
            // (chain-enforced semantic) in ADDITION to ownedSet membership
            // (caller-supplied list). The old code only checked
            // ownedSet.has(source) — if a caller forgot to populate
            // burnerOwnedAccounts with the source ATA, a malicious tx
            // could slip through. Authority is at accountIdxs[2] (TRANSFER)
            // or accountIdxs[3] (TRANSFER_CHECKED). Reject unless the
            // caller declares the specific source account via
            // allowedTransferAccounts (parallel to allowedBurnAccounts).
            if ((ix === TOKEN_IX.TRANSFER || ix === TOKEN_IX.TRANSFER_CHECKED)
                && (expectedDelta.kind === 'zero_value_auth' || expectedDelta.kind === 'zero_value_cancel')) {
                const sub = resolveSubjectAccount(parsed, instr, 0, i, 'Transfer');
                if (sub.err) return sub.err;
                const authIdx = (ix === TOKEN_IX.TRANSFER) ? 2 : 3;
                const authority = resolveSubjectAccount(parsed, instr, authIdx, i, 'Transfer.authority');
                if (authority.err) return authority.err;
                const burnerAuthorizes = (burnerPubkey && authority.acct === burnerPubkey);
                const sourceIsBurnerOwned = ownedSet.has(sub.acct);
                if (burnerAuthorizes || sourceIsBurnerOwned) {
                    // Note: burner-as-DELEGATE on a third-party account in a
                    // zero_value flow also lands here (authority=burner but
                    // source not owned). That's the right call — zero_value
                    // kinds mean "no value moves", so a delegate-authorized
                    // transfer is also disallowed. allowedTransferAccounts
                    // is the escape hatch if a legitimate future flow needs it.
                    //
                    // Asymmetry: only zero_value_CANCEL has the allowlist.
                    // zero_value_AUTH (memo-only auth challenges) has no
                    // legitimate token-movement use case so we don't expose
                    // an escape hatch there. This is by design; if a future
                    // auth flow legitimately needs Transfer, add it here AND
                    // file a Codex contract amendment.
                    const allowed = (expectedDelta.kind === 'zero_value_cancel'
                        && Array.isArray(expectedDelta.allowedTransferAccounts))
                        ? expectedDelta.allowedTransferAccounts.filter(isNonEmptyBase58)
                        : [];
                    if (!allowed.includes(sub.acct)) {
                        const reason = burnerAuthorizes
                            ? `burner ${burnerPubkey} is transfer authority`
                            : `source ${sub.acct} is in burnerOwnedAccounts`;
                        return reject('drainer_approve',
                            `instruction[${i}] SPL Transfer in ${expectedDelta.kind}: ${reason}; allowedTransferAccounts does not whitelist source ${sub.acct}`);
                    }
                }
            }
            if (ix === TOKEN_IX.SET_AUTHORITY) {
                const sub = resolveSubjectAccount(parsed, instr, 0, i, 'SetAuthority');
                if (sub.err) return sub.err;
                if (ownedSet.has(sub.acct)) {
                    return reject('drainer_set_authority',
                        `instruction[${i}] SetAuthority targets burner-owned account ${sub.acct}`);
                }
            } else if (ix === TOKEN_IX.APPROVE || ix === TOKEN_IX.APPROVE_CHECKED) {
                // C5: was previously a silent-skip on undefined account; now
                // fails closed via resolveSubjectAccount.
                const sub = resolveSubjectAccount(parsed, instr, 0, i, 'Approve');
                if (sub.err) return sub.err;
                if (ownedSet.has(sub.acct)) {
                    return reject('drainer_approve',
                        `instruction[${i}] Approve on burner-owned account ${sub.acct}`);
                }
            } else if (ix === TOKEN_IX.BURN || ix === TOKEN_IX.BURN_CHECKED) {
                // B2 (BAT-1013-followup): SPL Burn / BurnChecked on a burner-
                // owned ATA destroys tokens — equivalent to a drain from the
                // burner's perspective.
                //
                // Cancel flows legitimately burn the protocol order/position
                // marker token; covered by BAT-1013 cancel test. Accept only when:
                //   (a) expectedDelta.kind === 'zero_value_cancel', AND
                //   (b) target account is in expectedDelta.allowedBurnAccounts
                //       (caller MUST declare the specific order/position
                //       marker accounts that may be burned).
                // Burns on arbitrary burner-owned trade ATAs still reject
                // even in zero_value_cancel. Burns on ownership-uncertain
                // accounts reject via resolveSubjectAccount (C5 fix).
                const sub = resolveSubjectAccount(parsed, instr, 0, i, 'Burn');
                if (sub.err) return sub.err;
                if (ownedSet.has(sub.acct)) {
                    const allowedBurnAccounts = (expectedDelta.kind === 'zero_value_cancel'
                        && Array.isArray(expectedDelta.allowedBurnAccounts))
                        ? expectedDelta.allowedBurnAccounts.filter(isNonEmptyBase58)
                        : [];
                    if (allowedBurnAccounts.includes(sub.acct)) {
                        continue; // declared protocol marker burn in cancel flow
                    }
                    return reject('drainer_burn',
                        `instruction[${i}] Burn on burner-owned account ${sub.acct}` +
                        (expectedDelta.kind === 'zero_value_cancel'
                            ? ' (not in expectedDelta.allowedBurnAccounts)'
                            : ''));
                }
            } else if (ix === TOKEN_IX.CLOSE_ACCOUNT) {
                // C5: fail-closed on undefined subject (was previously silent-skip).
                const sub = resolveSubjectAccount(parsed, instr, 0, i, 'CloseAccount');
                if (sub.err) return sub.err;
                if (ownedSet.has(sub.acct)) {
                    // B1 (BAT-1013-followup): the documented Jupiter Ultra
                    // wrapping pattern for native-SOL swaps is:
                    //   create wSOL ATA → swap → CloseAccount(wSOL ATA, dest=burner)
                    // The CloseAccount unwraps the wSOL back to native SOL at
                    // the burner. We accept this ONLY when the caller has
                    // declared expectedDelta.wsolAtaExemption with both
                    // matching ata + destination. Anything else (different
                    // destination, different ATA, exemption absent) → drain.
                    if (wsolExemption && !wsolExemptionConsumed) {
                        const destIdx = instr.accountIdxs[1];
                        const authIdx = instr.accountIdxs[2];
                        const destAcct = (typeof destIdx === 'number' && destIdx >= 0
                            && destIdx < parsed.staticAccountKeys.length)
                            ? parsed.staticAccountKeys[destIdx] : null;
                        // wSOL-exemption close authority MUST be the burner
                        // (the wSOL ATA was created by the burner; only the
                        // burner can legitimately close it). Without this
                        // check, a tx could declare a wsolExemption with the
                        // right ata + destination but a different authority,
                        // potentially allowing a relayer to redirect rent.
                        const authAcct = (typeof authIdx === 'number' && authIdx >= 0
                            && authIdx < parsed.staticAccountKeys.length)
                            ? parsed.staticAccountKeys[authIdx] : null;
                        if (sub.acct === wsolExemption.ata
                            && destAcct === wsolExemption.destination
                            && authAcct === burnerPubkey) {
                            wsolExemptionConsumed = true; // single-fire
                            continue; // allowed: documented wSOL unwrap
                        }
                    }
                    // Cancel flows legitimately close ATAs.
                    if (expectedDelta.kind === 'zero_value_cancel') continue;
                    return reject('drainer_close_account',
                        `instruction[${i}] CloseAccount on burner-owned account ${sub.acct} (allowed only in zero_value_cancel or declared wsolAtaExemption)`);
                }
            }
        } else if (programId === SYSTEM_PROGRAM_ID) {
            // System Program ix discriminator is u32 little-endian.
            if (dataBytes.length < 4) continue;
            const ix = dataBytes.readUInt32LE(0);
            if (ix === SYSTEM_IX.ASSIGN) {
                // C5: fail-closed on undefined subject.
                const sub = resolveSubjectAccount(parsed, instr, 0, i, 'Assign');
                if (sub.err) return sub.err;
                if (ownedSet.has(sub.acct)) {
                    return reject('drainer_assign',
                        `instruction[${i}] System::Assign reassigns ownership of burner account ${sub.acct}`);
                }
            } else if (ix === SYSTEM_IX.ADVANCE_NONCE_ACCOUNT && i === 0) {
                // Durable nonce blank-check defense: a tx using durable-nonce
                // semantics MUST start with AdvanceNonceAccount as instruction 0.
                // If an autonomous burner tx uses this, the agent is signing a
                // potentially-arbitrary tx — fail closed unless explicitly
                // declared (no current flow declares it).
                // C5: also fail closed if the instruction is malformed
                // (account-index slot missing) so the validator is
                // deterministic across all bytes.
                return reject('drainer_nonce_blank_check',
                    `instruction[0] is AdvanceNonceAccount — durable-nonce blank-check signing not allowed for autonomous burner`);
            }
        }
    }
    return accept();
}

// ─── expectedDelta shape validators ───────────────────────────────────────

function isNonEmptyBase58(s) {
    // Solana pubkeys are exactly 32 bytes; base58 encoding produces strings
    // of length 32–44 (typical 43–44). Copilot PR #398 R15: every call site
    // of this helper expects a Solana pubkey or SPL mint address (both
    // 32-byte values); without the upper bound, arbitrarily long base58-
    // alphabet strings (e.g. 88-char ed25519 signatures, or longer attacker
    // injections) would pass the predicate and propagate into account
    // ownership checks. Cap at 44.
    return typeof s === 'string' && s.length >= 32 && s.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
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
            // C15 (BAT-1013-followup): toleranceBps boundary. 10000 bps =
            // 100% — anything above that is meaningless ("delta below
            // floor of zero"). The on-the-wire upper bound we accept is
            // 200 bps (2%); higher tolerances should route to main wallet
            // for human confirmation.
            if (expectedDelta.toleranceBps > 200) {
                return reject('expected_delta_invalid_shape',
                    `toleranceBps ${expectedDelta.toleranceBps} exceeds maximum 200 (2%); route to main wallet for human confirmation`);
            }
            // B1 (BAT-1013-followup): wSOL ATA exemption is OPTIONAL. When
            // declared, both `ata` and `destination` must be base58. The
            // drainer-walker accepts CloseAccount(target=ata, dest=destination)
            // as the documented Jupiter Ultra wSOL unwrap; any other
            // CloseAccount on a burner-owned account still fails closed.
            if (expectedDelta.wsolAtaExemption !== undefined && expectedDelta.wsolAtaExemption !== null) {
                const ex = expectedDelta.wsolAtaExemption;
                if (typeof ex !== 'object') {
                    return reject('expected_delta_invalid_shape', 'wsolAtaExemption must be an object');
                }
                if (!isNonEmptyBase58(ex.ata)) {
                    return reject('expected_delta_invalid_shape', 'wsolAtaExemption.ata must be a base58 pubkey');
                }
                if (!isNonEmptyBase58(ex.destination)) {
                    return reject('expected_delta_invalid_shape', 'wsolAtaExemption.destination must be a base58 pubkey');
                }
            }
            return accept();
        }
        case 'jupiter_trigger_create_deposit':
        case 'jupiter_dca_create_deposit': {
            // BAT-1031 (Option A, Codex v1.2 sign-off 2026-06-09):
            // trust Jupiter for the deposit destination; validate only
            // burner-side state.
            //
            // Background — why depositVault was removed. The prior
            // implementation attempted to bind `depositVault.pubkey` to
            // Jupiter's `craft.inputTokenAccount` and assert
            // `postAI.splToken.owner === expectedTokenOwner` on the
            // destination. It was device-tested on the PROD BURNER
            // 2026-06-09 and STILL failed with `simulation_mint_mismatch`
            // because Jupiter's prod-burner response routes to an
            // Anchor PDA (data.length=372), not a classic 165-byte SPL
            // Token Account. The SPL decoder reads bytes [0..32] as
            // "mint" and produces a garbage pubkey that can never match
            // the declared USDC mint. That architecture was built against
            // a capture from the wrong wallet (the test wallet at
            // tests/jupiter-ultra/.env.test happens to return a real
            // SPL Token Account; prod burner does not).
            //
            // Option A: same trust class as `jupiter_swap_immediate` /
            // `jupiter_ultra` (shipped since BAT-582 with no
            // destination binding and no incidents). BAT-1031 protects
            // the declared `burnerDebit.account` by exact mint +
            // atomic-amount delta. It does NOT add general zero-delta
            // enforcement for `burnerOwnedAccounts` or sim-discovered
            // burner-owned ATAs in non-zero deposit flows; BAT-1027
            // owns that. Drainer walker is unchanged. No `simOwned`
            // propagation in BAT-1031.
            //
            // Residual risk = the declared atomic amount (bounded).
            // Burner SOL is protected by `wantsBurnerSolFloor` for SPL
            // inputs; native-SOL inputs use `sol_fee_headroom`.
            //
            // DCA-on-burner remains main-wallet-only via the existing
            // `dcaForceRouting` routing decision in tools/solana.js;
            // see tests/nodejs-project/solana-dca-routing.test.js for
            // the regression pin.
            // V1 trigger stays on BAT-1029 (main-wallet routing).
            const dErr = requireBurnerDebit(expectedDelta.burnerDebit);
            if (dErr) return reject('expected_delta_invalid_shape', dErr);
            return accept();
        }
        case 'solana_send': {
            const dErr = requireBurnerDebit(expectedDelta.burnerDebit);
            if (dErr) return reject('expected_delta_invalid_shape', dErr);
            const r = expectedDelta.recipient;
            if (!r || typeof r !== 'object') return reject('expected_delta_invalid_shape', 'recipient required');
            if (!isNonEmptyBase58(r.account)) return reject('expected_delta_invalid_shape', 'recipient.account required');
            if (!validateMint(r.mint)) return reject('expected_delta_invalid_shape', 'recipient.mint required');
            // BAT-1013 foundation patch: defense-in-depth self-send guard.
            // The solana_send tool handler now has its own self-send check
            // (clean error before any RPC call), but if a caller bypasses
            // the handler and builds expectedDelta directly with
            // burnerDebit.account === recipient.account, the burner-policy
            // gate must still reject. Without this, simulation would return
            // AccountLoadedTwice — a cryptic on-chain error.
            if (expectedDelta.burnerDebit.account === r.account) {
                return reject('expected_delta_invalid_shape',
                    'self-send rejected: burnerDebit.account equals recipient.account (same address)');
            }
            // C6 (BAT-1013-followup): Token-2022 send fail-closed until
            // per-mint transfer-fee validation lands. Without
            // tokenStandardConfig.transferFeeBps declared by the caller,
            // we cannot compute the expected recipient credit (transfer
            // fees skim a caller-mint-config-dependent slice). Hardcoded
            // 50% tolerance was a sanctioned drain window in v8.x; v1 of
            // BAT-1013-followup fails closed instead.
            if (expectedDelta.tokenStandard === 'token_2022') {
                const cfg = expectedDelta.tokenStandardConfig;
                if (!cfg || typeof cfg !== 'object'
                    || typeof cfg.transferFeeBps !== 'number'
                    || cfg.transferFeeBps < 0 || cfg.transferFeeBps > 10000) {
                    return reject('token_2022_send_unsupported',
                        'Token-2022 solana_send requires expectedDelta.tokenStandardConfig.transferFeeBps (0..10000). Route to main wallet until per-mint config is wired.');
                }
            }
            return accept();
        }
        case 'agent_pay_x402': {
            const dErr = requireBurnerDebit(expectedDelta.burnerDebit);
            if (dErr) return reject('expected_delta_invalid_shape', dErr);
            const r = expectedDelta.recipient;
            if (!r || typeof r !== 'object') return reject('expected_delta_invalid_shape', 'recipient required');
            if (!isNonEmptyBase58(r.account)) return reject('expected_delta_invalid_shape', 'recipient.account required');
            if (!validateMint(r.mint)) return reject('expected_delta_invalid_shape', 'recipient.mint required');
            // BAT-1013 foundation patch: mirror the solana_send self-send
            // guard for x402. A facilitator-constructed tx with burnerDebit
            // == recipient would also produce AccountLoadedTwice on-chain.
            if (expectedDelta.burnerDebit.account === r.account) {
                return reject('expected_delta_invalid_shape',
                    'self-send rejected: burnerDebit.account equals recipient.account in agent_pay_x402');
            }
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
            // C6 (BAT-1013-followup): same Token-2022 send guard as
            // solana_send. x402 v2 is a USDC-only flow today (legacy SPL),
            // but if a future facilitator advertises a Token-2022 payment
            // mint, the policy must fail closed.
            if (expectedDelta.tokenStandard === 'token_2022') {
                const cfg = expectedDelta.tokenStandardConfig;
                if (!cfg || typeof cfg !== 'object'
                    || typeof cfg.transferFeeBps !== 'number'
                    || cfg.transferFeeBps < 0 || cfg.transferFeeBps > 10000) {
                    return reject('token_2022_send_unsupported',
                        'Token-2022 agent_pay_x402 requires expectedDelta.tokenStandardConfig.transferFeeBps (0..10000).');
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
        // Constrain the burner's native SOL delta (fee-budget tolerance)
        // AND every declared burner-owned SPL token account to zero delta.
        // Without the SPL constraint (Copilot PR #398 R7), a zero-value-
        // labeled tx could quietly move SPL tokens out of a burner-owned
        // token account — drainer-walk catches authority/approve/close
        // but a plain Transfer of tokens out would NOT be flagged.
        checks.push({
            address: burnerPubkey,
            mint: 'native_sol',
            role: 'burner-system',
            expectedDeltaAtomic: 0n,
            existencePolicy: { mustExistBefore: true, allowCreate: false, allowClose: false },
            deltaTolerance: { mode: 'zero_within_headroom', headroom: ZERO_VALUE_SOL_HEADROOM_LAMPORTS },
        });
        const ownedAccounts = Array.isArray(expectedDelta.burnerOwnedAccounts) ? expectedDelta.burnerOwnedAccounts : [];
        for (const acct of ownedAccounts) {
            if (acct === burnerPubkey) continue; // already covered by the SOL check above
            checks.push({
                address: acct,
                mint: SPL_MINT_AGNOSTIC, // see validateSimDelta — skips mint match, checks amount delta only
                role: 'burner-owned-spl',
                expectedDeltaAtomic: 0n,
                // zero_value_cancel allows account close as a documented
                // exception (see drainer-walk for kind === 'zero_value_cancel');
                // zero_value_auth does not.
                existencePolicy: {
                    mustExistBefore: true,
                    allowCreate: false,
                    allowClose: kind === 'zero_value_cancel',
                },
                deltaTolerance: { mode: 'exact' },
            });
        }
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

    // C7 (BAT-1013-followup): when the burnerDebit is SPL (mint != native_sol),
    // the burner is still paying network fees + potential ATA-rent in SOL.
    // Without an explicit burner-SOL constraint, a tampered SPL-input swap
    // could quietly drain native SOL from the burner while passing the SPL
    // debit / credit checks. Add a "burnerSolFloor" check: native SOL delta
    // must be in [-ZERO_VALUE_SOL_HEADROOM_LAMPORTS, 0]. The burner can pay
    // fees + rent (negative delta up to headroom) but cannot lose more nor
    // gain SOL on an SPL-only flow (a SOL gain would indicate Jupiter or
    // the recipient was reimbursing — not the declared shape).
    //
    // Applied to all non-zero-value kinds that have an SPL burnerDebit AND
    // where the burner is NOT also the credit/recipient native_sol holder.
    // For native-SOL debit kinds the existing debit check already constrains
    // the burner native-SOL bound; skip the extra check.
    const splDebit = debit && debit.mint !== 'native_sol';
    const wantsBurnerSolFloor = splDebit && (
        kind === 'jupiter_swap_immediate'
        || kind === 'jupiter_trigger_create_deposit'
        || kind === 'jupiter_dca_create_deposit'
        || kind === 'solana_send'
        || kind === 'agent_pay_x402'
    );

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
        // If burnerCreditMin is native_sol, the credit check already
        // covers the burner's native-SOL lower bound — don't double-add
        // a competing burnerSolFloor entry on the same address.
        const creditIsNativeSolOnBurner = credit && credit.mint === 'native_sol' && credit.account === burnerPubkey;
        if (wantsBurnerSolFloor && !creditIsNativeSolOnBurner) {
            checks.push({
                address: burnerPubkey,
                mint: 'native_sol',
                role: 'burner-system',
                expectedDeltaAtomic: 0n,
                existencePolicy: { mustExistBefore: true, allowCreate: false, allowClose: false },
                deltaTolerance: { mode: 'sol_fee_headroom', headroom: ZERO_VALUE_SOL_HEADROOM_LAMPORTS },
            });
        }
    } else if (kind === 'solana_send' || kind === 'agent_pay_x402') {
        const recipient = expectedDelta.recipient;
        if (recipient) {
            const expectedReceived = BigInt(debit.atomicAmount);
            // C6 (BAT-1013-followup): Token-2022 with caller-declared
            // tokenStandardConfig.transferFeeBps uses the exact declared
            // bps as tolerance ceiling. Without the declared config we'd
            // have rejected at validateExpectedDeltaShape (above) —
            // reaching this point means the caller has declared either
            // legacy SPL or Token-2022 with an explicit fee config.
            let tolerance;
            if (recipient.mint === 'native_sol') {
                // Native SOL transfer — exact (sender bears fee, not recipient).
                tolerance = { mode: 'exact' };
            } else if (expectedDelta.tokenStandard === 'token_2022') {
                const bps = BigInt(expectedDelta.tokenStandardConfig.transferFeeBps);
                tolerance = { mode: 'gte_min_minus_bps', minRequired: expectedReceived, bps };
            } else {
                tolerance = { mode: 'exact' };
            }
            checks.push({
                address: recipient.account,
                mint: recipient.mint,
                role: 'recipient',
                expectedDeltaAtomic: expectedReceived,
                // Recipient ATA may be created inside the transfer tx.
                existencePolicy: { mustExistBefore: false, allowCreate: true, allowClose: false },
                deltaTolerance: tolerance,
            });
        }
        if (wantsBurnerSolFloor) {
            checks.push({
                address: burnerPubkey,
                mint: 'native_sol',
                role: 'burner-system',
                expectedDeltaAtomic: 0n,
                existencePolicy: { mustExistBefore: true, allowCreate: false, allowClose: false },
                deltaTolerance: { mode: 'sol_fee_headroom', headroom: ZERO_VALUE_SOL_HEADROOM_LAMPORTS },
            });
        }
    } else if (kind === 'jupiter_trigger_create_deposit' || kind === 'jupiter_dca_create_deposit') {
        // BAT-1031 (Option A): trust Jupiter for the deposit destination.
        // No vault check is pushed — `burnerDebit` is already encoded
        // upstream in the `if (expectedDelta.burnerDebit) { ... }` block
        // earlier in this function and provides the exact mint +
        // atomic-amount enforcement on the declared burner-source ATA.
        //
        // The previous vault-check push asserted
        // `postAI.splToken.owner === expectedTokenOwner` against the
        // depositVault account. That check rejected on the prod burner
        // because Jupiter's actual destination is an Anchor PDA
        // (data.length=372), not a classic SPL Token Account. See the
        // explainer in validateExpectedDeltaShape's
        // `jupiter_trigger_create_deposit` case for the full background.
        //
        // C7 (BAT-1013-followup, preserved): SPL-input deposits must
        // constrain the burner's native-SOL delta the same way
        // SPL-input swaps do — the burner pays network fees + potential
        // ATA rent in SOL, and without the floor a tampered deposit
        // could quietly drain SOL.
        if (wantsBurnerSolFloor) {
            checks.push({
                address: burnerPubkey,
                mint: 'native_sol',
                role: 'burner-system',
                expectedDeltaAtomic: 0n,
                existencePolicy: { mustExistBefore: true, allowCreate: false, allowClose: false },
                deltaTolerance: { mode: 'sol_fee_headroom', headroom: ZERO_VALUE_SOL_HEADROOM_LAMPORTS },
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
            // SPL token: both pre and post must decode as SPL Token accounts
            // WHEN THEY EXIST. R-next-7 fix: previously the path silently
            // accepted accounts that existed but couldn't be decoded as SPL
            // Token (splToken undefined) — e.g. a Token-2022 account with
            // extensions our decoder doesn't recognize. tokenDelta() would
            // then return a zero/create/close result that doesn't reflect
            // reality, letting an attacker craft a state change we can't see.
            // Fail closed: when account exists but isn't SPL-decodable, we
            // cannot verify the delta — reject as simulation_metadata_missing
            // (availability class) so the agent can offer MWA fallback.
            // This guard runs even for SPL_MINT_AGNOSTIC checks because the
            // amount-delta computation itself needs splToken.amountAtomic.
            if (preAI.exists && !preAI.splToken) {
                return reject('simulation_metadata_missing',
                    `pre ${check.address} (role=${check.role}) exists but is not decodable as SPL Token (declared mint: ${check.mint})`);
            }
            if (postAI.exists && !postAI.splToken) {
                return reject('simulation_metadata_missing',
                    `post ${check.address} (role=${check.role}) exists but is not decodable as SPL Token (declared mint: ${check.mint})`);
            }
            // If pre is missing data but post has it (allowCreate), pre side
            // contributes 0 to the delta — this is fine because pre.exists=false
            // is a legitimate ATA-creation case caught by the existence-policy
            // gate above, not a decode failure.
            const td = tokenDelta(preAI, postAI);
            primaryDelta = td.delta;
            // Optional sanity: declared mint should match the decoded mint
            // (when both sides have splToken metadata). The SPL_MINT_AGNOSTIC
            // sentinel skips this check (used by zero_value kinds where the
            // caller only cares that the amount delta is zero regardless of
            // which mint the burner-owned account holds).
            if (check.mint !== SPL_MINT_AGNOSTIC) {
                if (preAI.exists && preAI.splToken && preAI.splToken.mint !== check.mint) {
                    return reject('simulation_mint_mismatch',
                        `pre ${check.address} mint ${preAI.splToken.mint} != declared ${check.mint}`);
                }
                if (postAI.exists && postAI.splToken && postAI.splToken.mint !== check.mint) {
                    return reject('simulation_mint_mismatch',
                        `post ${check.address} mint ${postAI.splToken.mint} != declared ${check.mint}`);
                }
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
 *   programs?: string[], structuralOnly?: boolean, simulated?: boolean }>}
 *
 *   `programs` contains the resolved program-ID base58 strings for each
 *   instruction's programIdIdx (one entry per instruction). Mirrors the
 *   shape of solana.js verifySwapTransaction's `programs` field for
 *   forensic-log compatibility. Copilot PR #398 R15: previously contained
 *   raw programIdIdx integers (misleading — they're positional indices,
 *   not program identities).
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
    const drainerCheck = validateDrainerOpcodes(parsed, declaredOwned, expectedDelta, options.burnerPubkey);
    if (!drainerCheck.ok) return drainerCheck;

    // ── 5. Structural-only short-circuit (test mode only) ──
    if (typeof options.simulator !== 'function') {
        if (options.allowStructuralOnly === true) {
            // Copilot PR #398 R15: resolve programIdIdx → base58 string so
            // programs[] contains program identities (matching solana.js
            // verifySwapTransaction shape) instead of opaque positional
            // indices. The structural-only path uses staticAccountKeys
            // (ALT-resolved keys aren't available without simulation).
            return accept({
                structuralOnly: true,
                programs: parsed.instructions.map(i =>
                    parsed.staticAccountKeys[i.programIdIdx] || `idx:${i.programIdIdx}`),
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
        // BAT-1024: decode err.InstructionError[idx,{Custom:M}] + append
        // sim.value.logs[] tail so the agent / user see actionable diagnostics
        // instead of raw `{"InstructionError":[3,{"Custom":1}]}` JSON.
        // combinedAccountKeys is built a few lines below; recompute the
        // minimal version here so we can name the failing program. ALT
        // entries may be missing (we don't have loadedAddresses yet) — the
        // decoder gracefully falls back to static keys.
        const _loadedHint = sim.value.loadedAddresses || {};
        const _altWritable = Array.isArray(_loadedHint.writable) ? _loadedHint.writable.filter(isNonEmptyBase58) : [];
        const _altReadonly = Array.isArray(_loadedHint.readonly) ? _loadedHint.readonly.filter(isNonEmptyBase58) : [];
        const _combinedHint = [...parsed.staticAccountKeys, ..._altWritable, ..._altReadonly];
        const reason = formatSimulationErrorReason(sim.value, parsed, _combinedHint);
        return reject('simulation_returned_error', reason);
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
    const drainerCheck2 = validateDrainerOpcodes(combinedParsed, ownedUnion, expectedDelta, options.burnerPubkey);
    if (!drainerCheck2.ok) return drainerCheck2;

    // ── 12. Per-shape delta validation (v8.1 dual-source) ──
    const deltaResult = validateSimDelta(sim, preSnapshot, requestedAddresses, combinedAccountKeys, options.burnerPubkey, expectedDelta);
    if (!deltaResult.ok) return deltaResult;

    // Copilot PR #398 R15: resolve programIdIdx → base58 string using the
    // ALT-resolved combinedAccountKeys (which includes loadedAddresses from
    // the simulation response). Matches verifySwapTransaction's shape;
    // forensic logs now show actual program identities, not opaque indices.
    return accept({
        simulated: true,
        programs: parsed.instructions.map(i =>
            combinedAccountKeys[i.programIdIdx] || `idx:${i.programIdIdx}`),
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
    // BAT-1024 decoder helpers (test surface)
    _decodeCustomError: decodeCustomError,
    _programNameOf: programNameOf,
    _summarizeSimulationLogs: summarizeSimulationLogs,
    _formatSimulationErrorReason: formatSimulationErrorReason,
    _PROGRAM_ERROR_TABLES: PROGRAM_ERROR_TABLES,
};
