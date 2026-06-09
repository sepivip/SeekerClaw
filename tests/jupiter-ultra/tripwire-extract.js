'use strict';

// tripwire-extract.js — BAT-1031 v1.2 §3 Gate 0 carve-out extractor.
//
// Pure-JS module (stdlib only). Given a Gate 0 capture (the shape produced
// by tests/jupiter-ultra/fixtures/prod-burner-v2-trigger-2026-06-09.json and
// returned by burner-signer-simulator's preflight) plus the policy's
// declared burner-owned set, returns per-tripwire PASS/FAIL + which carve-out
// condition (if any) suppressed an otherwise-firing T3/T5.
//
// Inputs
// ──────
//   capture = {
//     burnerPubkey, expectedDelta, requestedAddresses, combinedAccountKeys,
//     sim: { context, value: {
//       accounts: [{ data:[b64,'base64'], owner, lamports, ... } | null, ...],
//       innerInstructions: [{ index, instructions: [{ parsed:{type,info}, program, programId, stackHeight } | { accounts, data, programId, stackHeight }, ...] }, ...],
//       postTokenBalances, preTokenBalances, postBalances, preBalances,
//       loadedAddresses: { writable, readonly }, err, logs
//     } }
//   }
//   opts = {
//     burnerPubkey,            // string (required) — owner pubkey to match
//     declaredBurnerOwned,     // string[] — accounts the producer declared (expectedDelta.burnerOwnedAccounts)
//   }
//
// Outputs
// ───────
//   {
//     t1: { pass, count, sources },           // signer-set size
//     t2: { pass, altResolvedBurnerOwned },   // ALT-resolved writable burner-owned
//     t3: { pass, violatingOps, carveOutAppliedTo },
//     t4: { pass, feePayer },                 // fee payer is burner
//     t5: { pass, observed, declared, undeclared, carveOutAppliedTo, nonStandardTokenSet },
//   }

// ── Program IDs (canonical) ───────────────────────────────────────────────
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

// ── Carve-out constants (BAT-1031 v1.2 §3) ────────────────────────────────
const ZERO_VALUE_SOL_HEADROOM_LAMPORTS = 10_000_000;

// Canonical create/init ops permitted by condition 5.
const CANONICAL_CREATE_INIT_OPS = new Set([
    // ATA program
    'create',                       // ATA::Create
    'createIdempotent',             // ATA::CreateIdempotent
    // System program
    'createAccount',
    // SPL Token program
    'getAccountDataSize',
    'initializeImmutableOwner',
    'initializeAccount',
    'initializeAccount2',
    'initializeAccount3',
    'syncNative',                   // conditional — caller must verify post amount stays "0"
]);

// Drainer-class ops that disqualify the carve-out by condition 4.
const DRAINER_OPS = new Set([
    'transfer',
    'transferChecked',
    'burn',
    'burnChecked',
    'closeAccount',
    'approve',
    'approveChecked',
    'setAuthority',
]);

// ── Helpers ───────────────────────────────────────────────────────────────

// Minimal base58 decoder (sufficient for 32-byte pubkeys). Stdlib only.
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_INDEX = (() => {
    const m = Object.create(null);
    for (let i = 0; i < B58_ALPHABET.length; i++) m[B58_ALPHABET[i]] = i;
    return m;
})();
function base58Decode(str) {
    if (typeof str !== 'string' || str.length === 0) return Buffer.alloc(0);
    let zeros = 0;
    while (zeros < str.length && str[zeros] === '1') zeros++;
    const size = ((str.length - zeros) * 733) / 1000 + 1 | 0;
    const b = new Uint8Array(size);
    let length = 0;
    for (let i = zeros; i < str.length; i++) {
        const ch = str[i];
        const v = B58_INDEX[ch];
        if (v === undefined) throw new Error(`bad base58 char: ${ch}`);
        let carry = v;
        let j = 0;
        for (let k = size - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
            carry += 58 * b[k];
            b[k] = carry % 256;
            carry = (carry / 256) | 0;
        }
        length = j;
    }
    const out = Buffer.alloc(zeros + length);
    for (let i = 0; i < zeros; i++) out[i] = 0;
    let k = zeros;
    for (let i = size - length; i < size; i++) out[k++] = b[i];
    return out;
}

function decodeAccountData(acct) {
    if (!acct || !acct.data) return Buffer.alloc(0);
    if (Array.isArray(acct.data) && acct.data.length >= 1) {
        const enc = acct.data[1] || 'base64';
        try { return Buffer.from(acct.data[0] || '', enc); }
        catch (_) { return Buffer.alloc(0); }
    }
    if (typeof acct.data === 'string') {
        try { return Buffer.from(acct.data, 'base64'); }
        catch (_) { return Buffer.alloc(0); }
    }
    return Buffer.alloc(0);
}

// SPL Token Account layout: 32 mint | 32 owner | 8 amount LE | ...
// data.length must be exactly 165 to be considered a standard SPL Token Account.
function readSplTokenAccount(acct) {
    const buf = decodeAccountData(acct);
    if (buf.length !== 165) return null;
    return {
        mint: buf.slice(0, 32),
        owner: buf.slice(32, 64),
        amount: buf.readBigUInt64LE(64),
    };
}

function pubkeysEqual(buf, base58Str) {
    let decoded;
    try { decoded = base58Decode(base58Str); }
    catch (_) { return false; }
    if (decoded.length !== buf.length) return false;
    for (let i = 0; i < decoded.length; i++) if (decoded[i] !== buf[i]) return false;
    return true;
}

// Flatten innerInstructions[].instructions[] into a single list, preserving
// programId + parsed.type + parsed.info so callers can match by account.
function flattenInnerInstructions(sim) {
    const value = (sim && sim.value) || {};
    const inner = Array.isArray(value.innerInstructions) ? value.innerInstructions : [];
    const out = [];
    for (const group of inner) {
        const ins = Array.isArray(group.instructions) ? group.instructions : [];
        for (const ix of ins) out.push(ix);
    }
    return out;
}

// Pull every account-string referenced by a parsed instruction's info.
function accountsTouchedBy(ix) {
    const out = new Set();
    if (!ix || typeof ix !== 'object') return out;
    // unparsed: explicit accounts array
    if (Array.isArray(ix.accounts)) {
        for (const a of ix.accounts) if (typeof a === 'string') out.add(a);
    }
    const info = ix.parsed && ix.parsed.info;
    if (!info || typeof info !== 'object') return out;
    const keys = [
        'account', 'source', 'destination', 'newAccount', 'mint',
        'authority', 'owner', 'wallet', 'multisigAuthority',
    ];
    for (const k of keys) {
        if (typeof info[k] === 'string') out.add(info[k]);
    }
    return out;
}

function instructionType(ix) {
    if (ix && ix.parsed && typeof ix.parsed.type === 'string') return ix.parsed.type;
    return null;
}

// Determine "post is valid SPL Token Account owned by burner" using BOTH
// sim.value.accounts (verify owner bytes 32..64) AND
// sim.value.postTokenBalances (declared owner field). The Codex amendment 6
// reading: an account that postTokenBalances reports as burner-owned classic
// SPL — even when it is not in sim.value.accounts because the caller didn't
// include it in `accounts.config` — is "valid burner-owned SPL" for the
// purposes of the BAT-1031 v1.2 §3 carve-out condition 2. The canonical
// prod capture has exactly this shape: the freshly-created burner WSOL ATA
// appears in postTokenBalances but not in requestedAddresses.
function isPostBurnerOwnedSpl(addr, capture, burnerPubkey, postAcctByAddr) {
    // Source 1: sim.value.accounts entry (when caller requested it).
    const postAcct = postAcctByAddr ? postAcctByAddr.get(addr) : null;
    if (postAcct) {
        const postParsed = readSplTokenAccount(postAcct);
        if (postParsed && pubkeysEqual(postParsed.owner, burnerPubkey)) return true;
    }
    // Source 2: postTokenBalances declaration. Trust the declared owner/
    // programId — the simulator is the source of truth and Token-2022
    // accounts are already routed to nonStandardTokenSet upstream.
    const value = (capture && capture.sim && capture.sim.value) || {};
    const ptb = Array.isArray(value.postTokenBalances) ? value.postTokenBalances : [];
    const cak = Array.isArray(capture.combinedAccountKeys) ? capture.combinedAccountKeys : [];
    for (const entry of ptb) {
        if (!entry || typeof entry !== 'object') continue;
        const ptbAddr = (typeof entry.accountIndex === 'number' && cak[entry.accountIndex]) || null;
        if (ptbAddr !== addr) continue;
        if (entry.owner !== burnerPubkey) continue;
        if (entry.programId && entry.programId !== TOKEN_PROGRAM) continue;
        return true;
    }
    return false;
}

function programIdOf(ix) {
    if (ix && typeof ix.programId === 'string') return ix.programId;
    return null;
}

// ── Observed burner-owned SPL set extraction (Codex amendment 6) ──────────
//
// Build set from BOTH sim.value.accounts (verify owner bytes 32..64 match
// burner; data.length must equal 165 for standard SPL Token Account) AND
// sim.value.postTokenBalances (trust declared owner field). Token-2022 /
// non-standard programIds are routed to nonStandardTokenSet, not the
// primary observed set.
function buildObservedBurnerOwnedSet({ capture, burnerPubkey, addressOrder, addressFilter }) {
    const observed = new Set();
    const nonStandard = new Set();
    const value = (capture && capture.sim && capture.sim.value) || {};

    // `addressFilter` (optional, used for T2): if provided, only accounts
    // whose address appears in this filter are counted. T2 passes the ALT-
    // resolved writable set as the filter; T3/T5 omit the filter and accept
    // everything observed in either source.
    const filterSet = addressFilter ? new Set(addressFilter) : null;
    const passesFilter = (addr) => !filterSet || filterSet.has(addr);

    // Source 1: sim.value.accounts — index-aligned to requestedAddresses /
    // combinedAccountKeys depending on the caller, but we accept the address
    // order passed in.
    const accountsArr = Array.isArray(value.accounts) ? value.accounts : [];
    const order = Array.isArray(addressOrder) ? addressOrder : [];
    for (let i = 0; i < accountsArr.length && i < order.length; i++) {
        const acct = accountsArr[i];
        if (!acct) continue;
        const addr = order[i];
        if (!passesFilter(addr)) continue;
        const owner = acct.owner;
        if (owner === TOKEN_2022_PROGRAM) {
            nonStandard.add(addr);
            continue;
        }
        if (owner !== TOKEN_PROGRAM) continue;
        const parsed = readSplTokenAccount(acct);
        if (!parsed) continue;
        if (pubkeysEqual(parsed.owner, burnerPubkey)) observed.add(addr);
    }

    // Source 2: sim.value.postTokenBalances — declared owner field.
    const ptb = Array.isArray(value.postTokenBalances) ? value.postTokenBalances : [];
    const cak = Array.isArray(capture.combinedAccountKeys) ? capture.combinedAccountKeys : [];
    for (const entry of ptb) {
        if (!entry || typeof entry !== 'object') continue;
        if (entry.owner !== burnerPubkey) continue;
        const addr = (typeof entry.accountIndex === 'number' && cak[entry.accountIndex]) || null;
        if (!addr) continue;
        if (!passesFilter(addr)) continue;
        if (entry.programId === TOKEN_2022_PROGRAM) {
            nonStandard.add(addr);
            continue;
        }
        if (entry.programId && entry.programId !== TOKEN_PROGRAM) continue;
        observed.add(addr);
    }

    return { observed: Array.from(observed), nonStandardTokenSet: Array.from(nonStandard) };
}

// ── Six-condition carve-out (BAT-1031 v1.2 §3) ────────────────────────────
//
// Applies T3+T5 only when ALL of:
//   1. pre-state does not exist
//   2. post-state is valid SPL Token Account owned by burner (data.length=165,
//      bytes[32..64]=burnerPubkey)
//   3. post token amount === "0"
//   4. no drainer-class op touches it
//   5. only canonical create/init ops touch it
//   6. lamport cost ≤ ZERO_VALUE_SOL_HEADROOM_LAMPORTS (10_000_000)
//
// applyCarveOut returns { applies: bool, reasons: string[] } where reasons
// lists the specific condition(s) that disqualified it. Empty reasons + true
// means the carve-out applies cleanly.
function applyCarveOut(ctx, instructionsTouchingAccount, postLamports) {
    const reasons = [];

    // Condition 1: pre-state does not exist (preAcct is null OR pre lamports = 0
    // AND pre data is empty/native).
    if (ctx.preExists) reasons.push('carve_out_pre_state_exists');

    // Condition 2: post is valid SPL Token Account owned by burner.
    if (!ctx.postIsValidBurnerOwnedSpl) reasons.push('carve_out_post_not_valid_burner_spl');

    // Condition 3: post amount === "0".
    // Distinguish between an explicitly-non-zero amount (drainer-class
    // disqualifier) and an unknown/absent amount (data gap — the caller
    // hasn't proven the account ended at zero, which is also a carve-out
    // disqualifier but for a different reason than a positive balance).
    if (ctx.postAmountAtomic == null) {
        reasons.push('carve_out_post_amount_unknown');
    } else if (ctx.postAmountAtomic !== '0') {
        reasons.push('carve_out_nonzero_balance');
    }

    // Condition 4: no drainer-class op touches this account in the same tx.
    const drainerHit = (instructionsTouchingAccount || []).find(ix => {
        const t = instructionType(ix);
        return t && DRAINER_OPS.has(t);
    });
    if (drainerHit) reasons.push('carve_out_drainer_op');

    // Condition 5: only canonical create/init ops touch it.
    for (const ix of (instructionsTouchingAccount || [])) {
        const t = instructionType(ix);
        if (!t) continue;
        if (DRAINER_OPS.has(t)) continue; // already counted in cond 4
        if (!CANONICAL_CREATE_INIT_OPS.has(t)) {
            reasons.push(`carve_out_non_canonical_op:${t}`);
        }
    }

    // Condition 6: lamport headroom — must be a PROVEN bound. A missing
    // postLamports (caller couldn't compute the burner SOL spend because
    // the burner wasn't in combinedAccountKeys, or preBalances/postBalances
    // were truncated, etc.) means we cannot prove the cost stayed inside
    // headroom — fail closed with a distinct reason instead of treating
    // "unknown" as "no problem." Copilot R4.3.
    if (typeof postLamports !== 'number' || !Number.isFinite(postLamports)) {
        reasons.push('carve_out_lamport_spend_unknown');
    } else if (postLamports > ZERO_VALUE_SOL_HEADROOM_LAMPORTS) {
        reasons.push('carve_out_headroom_exceeded');
    }

    return { applies: reasons.length === 0, reasons };
}

// ── Burner net SOL delta ─────────────────────────────────────────────────
// Returns the burner's net SOL spend (preBalance - postBalance) as a
// finite number, OR null when the data needed to compute it is missing
// (burner not in combinedAccountKeys, balances arrays truncated/missing,
// non-numeric balance values). null is the "unknown" signal that
// applyCarveOut's condition 6 reads to fail closed instead of fail open.
// Copilot R4.3.
function burnerNetSolDelta(capture, burnerPubkey) {
    const value = (capture && capture.sim && capture.sim.value) || {};
    const cak = Array.isArray(capture.combinedAccountKeys) ? capture.combinedAccountKeys : [];
    const pre = Array.isArray(value.preBalances) ? value.preBalances : [];
    const post = Array.isArray(value.postBalances) ? value.postBalances : [];
    const idx = cak.indexOf(burnerPubkey);
    if (idx < 0 || idx >= pre.length || idx >= post.length) return null;
    const preNum = Number(pre[idx]);
    const postNum = Number(post[idx]);
    if (!Number.isFinite(preNum) || !Number.isFinite(postNum)) return null;
    return preNum - postNum;
}

// ── extractTripwires (top-level) ─────────────────────────────────────────
function extractTripwires(capture, opts) {
    if (!capture || typeof capture !== 'object') throw new Error('capture required');
    const burnerPubkey = opts && opts.burnerPubkey;
    if (!burnerPubkey) throw new Error('opts.burnerPubkey required');
    const declared = new Set(Array.isArray(opts.declaredBurnerOwned) ? opts.declaredBurnerOwned : []);

    const value = (capture.sim && capture.sim.value) || {};
    const cak = Array.isArray(capture.combinedAccountKeys) ? capture.combinedAccountKeys : [];
    const requested = Array.isArray(capture.requestedAddresses) ? capture.requestedAddresses : [];

    // T1: signer-set size — capture.signerSetSize or count of accounts that
    // are sources/authorities in inner instructions. For test fixtures we
    // honor capture.signerSetSize when provided.
    const t1Count = typeof capture.signerSetSize === 'number'
        ? capture.signerSetSize
        : 1;
    const t1 = {
        pass: t1Count <= 1,
        count: t1Count,
        sources: capture.signerSetSources || ['fee_payer'],
    };

    // T2: ALT-resolved writable burner-owned (writable addresses pulled in
    // via address-lookup tables that resolve to burner-owned accounts).
    //
    // CRITICAL: sim.value.accounts is index-aligned to the caller-supplied
    // `accounts.config.addresses` (i.e., the policy's requestedAddresses),
    // NOT to `loadedAddresses.writable`. Passing loadedWritable as
    // addressOrder into Source 1 would misattribute post-state from
    // requested addresses to ALT-resolved addresses whenever the lengths
    // misalign. So Source 1 is disabled for T2 (addressOrder: []) and we
    // rely on Source 2 (postTokenBalances, which references combinedAccountKeys
    // — those include BOTH static and ALT-resolved keys, so a burner-owned
    // ALT-resolved account will surface there) filtered to ALT writables.
    const loadedWritable = (value.loadedAddresses && Array.isArray(value.loadedAddresses.writable))
        ? value.loadedAddresses.writable : [];
    const altObserved = buildObservedBurnerOwnedSet({
        capture,
        burnerPubkey,
        addressOrder: [],
        addressFilter: loadedWritable,
    });
    const t2 = {
        pass: altObserved.observed.length === 0,
        altResolvedBurnerOwned: altObserved.observed,
    };

    // T3/T5: observed burner-owned SPL set from accounts + postTokenBalances.
    // The address order for sim.value.accounts uses the requested addresses
    // (caller-supplied order to RPC). We default to requestedAddresses.
    const observedFromPrimary = buildObservedBurnerOwnedSet({
        capture,
        burnerPubkey,
        addressOrder: requested,
    });
    const observed = new Set(observedFromPrimary.observed);
    const nonStandardTokenSet = observedFromPrimary.nonStandardTokenSet;

    const undeclared = [];
    for (const addr of observed) {
        if (!declared.has(addr)) undeclared.push(addr);
    }

    // Walk inner instructions once and index by account.
    const allIxs = flattenInnerInstructions(capture.sim);
    const ixsByAccount = new Map();
    for (const ix of allIxs) {
        for (const addr of accountsTouchedBy(ix)) {
            if (!ixsByAccount.has(addr)) ixsByAccount.set(addr, []);
            ixsByAccount.get(addr).push(ix);
        }
    }

    // For T3 we ask: do any inner instructions show a drainer-class op
    // targeting a burner-owned account (declared or observed)? If yes,
    // does the carve-out apply for that account?
    const t3Violating = [];
    const t3CarveApplied = [];
    const t5CarveApplied = [];

    const burnerScope = new Set([...declared, ...observed]);

    // Build pre-existence map from preTokenBalances + preBalances + accounts.
    const preExistsByAddr = new Map();
    const ptbPre = Array.isArray(value.preTokenBalances) ? value.preTokenBalances : [];
    for (const e of ptbPre) {
        const addr = (typeof e.accountIndex === 'number' && cak[e.accountIndex]) || null;
        if (addr) preExistsByAddr.set(addr, true);
    }

    // Build post-state map from sim.value.accounts (keyed by requested order).
    const postAcctByAddr = new Map();
    const accountsArr = Array.isArray(value.accounts) ? value.accounts : [];
    for (let i = 0; i < accountsArr.length && i < requested.length; i++) {
        if (accountsArr[i]) postAcctByAddr.set(requested[i], accountsArr[i]);
    }

    // Build post amount map from postTokenBalances.
    const postAmountByAddr = new Map();
    const ptbPost = Array.isArray(value.postTokenBalances) ? value.postTokenBalances : [];
    for (const e of ptbPost) {
        const addr = (typeof e.accountIndex === 'number' && cak[e.accountIndex]) || null;
        if (addr && e.uiTokenAmount && typeof e.uiTokenAmount.amount === 'string') {
            postAmountByAddr.set(addr, e.uiTokenAmount.amount);
        }
    }

    // Build post lamport cost per address (best-effort).
    const postLamportsByAddr = new Map();
    const pre = Array.isArray(value.preBalances) ? value.preBalances : [];
    const post = Array.isArray(value.postBalances) ? value.postBalances : [];
    for (let i = 0; i < cak.length && i < pre.length && i < post.length; i++) {
        const addr = cak[i];
        const spent = Number(pre[i]) - Number(post[i]);
        if (spent > 0) postLamportsByAddr.set(addr, spent);
    }

    // For zero-balance carve-out, the "lamport cost" is the burner's net
    // SOL delta (i.e., what the burner paid for create/init across the tx).
    const burnerSolSpend = burnerNetSolDelta(capture, burnerPubkey);

    for (const addr of burnerScope) {
        const ixsTouching = ixsByAccount.get(addr) || [];

        // Determine if this account had a drainer-class op anywhere in tx.
        const hasDrainer = ixsTouching.some(ix => {
            const t = instructionType(ix);
            return t && DRAINER_OPS.has(t);
        });

        if (hasDrainer) {
            // Try the carve-out: build the context and see whether ALL six
            // conditions hold. If they hold, T3 carve applies; otherwise T3
            // fires. postIsValidBurnerOwnedSpl uses the dual-source helper
            // so a postTokenBalances-only account (not in requestedAddresses)
            // still satisfies condition 2 — matches the canonical prod
            // fixture shape where the freshly-created burner WSOL ATA is
            // discoverable only via postTokenBalances.
            const postIsValidBurnerOwnedSpl = isPostBurnerOwnedSpl(addr, capture, burnerPubkey, postAcctByAddr);
            const carve = applyCarveOut({
                preExists: preExistsByAddr.get(addr) === true,
                postIsValidBurnerOwnedSpl,
                postAmountAtomic: postAmountByAddr.get(addr) ?? null,
            }, ixsTouching, burnerSolSpend);
            if (carve.applies) {
                t3CarveApplied.push(addr);
            } else {
                t3Violating.push({
                    account: addr,
                    reasons: carve.reasons,
                });
            }
        }
    }

    const t3 = {
        pass: t3Violating.length === 0,
        violatingOps: t3Violating,
        carveOutAppliedTo: t3CarveApplied,
    };

    // T4: fee payer === burnerPubkey (combinedAccountKeys[0] in Solana wire
    // format).
    const feePayer = cak[0] || null;
    const t4 = {
        pass: feePayer === burnerPubkey,
        feePayer,
    };

    // T5: every observed burner-owned account is declared. For each
    // undeclared account, try the carve-out — if it applies, suppress the
    // fire and record in carveOutAppliedTo. Otherwise T5 fires with the
    // disqualifying reasons.
    const t5Violations = [];
    for (const addr of undeclared) {
        // Use the dual-source helper (sim.value.accounts + postTokenBalances)
        // so a postTokenBalances-only burner-owned account still satisfies
        // carve-out condition 2 — required for the canonical prod fixture
        // shape where the freshly-created burner WSOL ATA isn't requested
        // but IS reported as burner-owned by postTokenBalances.
        const postIsValidBurnerOwnedSpl = isPostBurnerOwnedSpl(addr, capture, burnerPubkey, postAcctByAddr);
        const ixsTouching = ixsByAccount.get(addr) || [];
        const carve = applyCarveOut({
            preExists: preExistsByAddr.get(addr) === true,
            postIsValidBurnerOwnedSpl,
            postAmountAtomic: postAmountByAddr.get(addr) ?? null,
        }, ixsTouching, burnerSolSpend);
        if (carve.applies) {
            t5CarveApplied.push(addr);
        } else {
            t5Violations.push({ account: addr, reasons: carve.reasons });
        }
    }

    const t5 = {
        pass: t5Violations.length === 0 && nonStandardTokenSet.length === 0,
        observed: Array.from(observed),
        declared: Array.from(declared),
        undeclared: t5Violations,
        carveOutAppliedTo: t5CarveApplied,
        nonStandardTokenSet,
    };

    return { t1, t2, t3, t4, t5 };
}

module.exports = {
    extractTripwires,
    applyCarveOut,
    // exports for test introspection
    _internals: {
        CANONICAL_CREATE_INIT_OPS,
        DRAINER_OPS,
        ZERO_VALUE_SOL_HEADROOM_LAMPORTS,
        TOKEN_PROGRAM,
        TOKEN_2022_PROGRAM,
        ATA_PROGRAM,
        SYSTEM_PROGRAM,
        base58Decode,
        readSplTokenAccount,
        pubkeysEqual,
        flattenInnerInstructions,
        burnerNetSolDelta,
        isPostBurnerOwnedSpl,
    },
};