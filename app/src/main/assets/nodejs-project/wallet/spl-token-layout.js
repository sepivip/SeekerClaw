// SeekerClaw — wallet/spl-token-layout.js
//
// BAT-1013 v8.1: SPL Token (Token + Token-2022) account data deserializer.
//
// Both the legacy SPL Token Program and Token-2022 share the first 165 bytes
// of account layout — same field offsets for mint / owner / amount. The
// burner-policy delta validator only reads those three fields, so a single
// decoder works for both. Token-2022's extensions live at offset 165+ and
// are out of scope for delta validation (they don't change the amount field).
//
// Layout (source: solana-program/token-2022 account.rs):
//   offset 0..32   = mint (32-byte pubkey, base58-encodable)
//   offset 32..64  = owner (32-byte pubkey)
//   offset 64..72  = amount (u64, little-endian)
//   offset 72..73  = delegate option discriminator
//   ...
//
// All BigInt math. Atomic units only (microunits for USDC, lamports-style for
// other tokens). Number/Math is never used for amounts.

'use strict';

const { base58Encode } = require('./tx-parser');

const SPL_TOKEN_ACCOUNT_MIN_BYTES = 72;

/**
 * Decode an `AccountInfo.data` base64 string from Solana RPC into the three
 * fields the burner-policy delta validator cares about. Returns null if the
 * data is too short to contain a valid token account, or null if input is
 * not a string.
 *
 * @param {string|null} base64Data - base64-encoded account data; null if
 *   the account does not exist
 * @returns {{ mint: string, owner: string, amountAtomic: bigint } | null}
 */
function decodeSplTokenAccount(base64Data) {
    if (typeof base64Data !== 'string' || base64Data.length === 0) return null;
    // Copilot R11: Buffer.from('base64') silently ignores invalid chars and
    // returns garbage. For a security-sensitive decoder this is fail-open.
    // Validate the input is well-formed base64 (charset + length-mod-4)
    // BEFORE decoding so malformed RPC responses fail closed.
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64Data) || base64Data.length % 4 !== 0) {
        return null;
    }
    let buf;
    try {
        buf = Buffer.from(base64Data, 'base64');
    } catch (_) {
        return null;
    }
    if (buf.length < SPL_TOKEN_ACCOUNT_MIN_BYTES) return null;
    const mint = base58Encode(buf.slice(0, 32));
    const owner = base58Encode(buf.slice(32, 64));
    // u64 little-endian. Buffer.readBigUInt64LE is Node 12+; nodejs-mobile
    // runs Node 18 so it's available.
    const amountAtomic = buf.readBigUInt64LE(64);
    return { mint, owner, amountAtomic };
}

/**
 * Wrapper for Solana RPC `accountInfo` response (the shape returned by
 * `getMultipleAccounts` per-address and by `simulateTransaction.value.accounts[i]`).
 * The shape is:
 *   {
 *     lamports: number,
 *     owner: <program ID base58>,
 *     data: [base64Str, "base64"] | null,
 *     executable: boolean,
 *     rentEpoch: number,
 *   }
 * OR null if the account does not exist on-chain (typical for an ATA that
 * is created within the simulated tx).
 *
 * Returns:
 *   - `{ exists: false }` when accountInfo is null
 *   - `{ exists: true, lamports: bigint, splToken?: {...} }` when present;
 *     `splToken` populated if the data parses as an SPL token account
 *     (mint + owner + amountAtomic), undefined otherwise.
 */
function readAccountInfo(accountInfo) {
    if (accountInfo === null || accountInfo === undefined) return { exists: false };
    if (typeof accountInfo !== 'object') return { exists: false };
    const out = { exists: true };
    // The on-chain program that OWNS this account — NOT the token-account
    // `owner` field embedded in the data (that one is the wallet that owns the
    // tokens, decoded into `splToken.owner` below). A real SPL token account
    // is always program-owned by the SPL Token or Token-2022 program. BAT-1027
    // uses `programOwner` to confirm an account is actually managed by the
    // token runtime before trusting the decoded `splToken.owner`; otherwise a
    // non-token Anchor PDA whose raw bytes happen to embed a wallet pubkey at
    // data offset 32 would be misread as a token account.
    out.programOwner = (typeof accountInfo.owner === 'string') ? accountInfo.owner : null;
    if (typeof accountInfo.lamports === 'number' || typeof accountInfo.lamports === 'bigint') {
        try { out.lamports = BigInt(accountInfo.lamports); }
        catch (_) { out.lamports = 0n; }
    } else {
        out.lamports = 0n;
    }
    // Data shape per Solana RPC docs: when encoding requested is base64,
    // data is `[base64Str, "base64"]`. Other encodings (jsonParsed, base58)
    // aren't used in our simulator config; we ignore them.
    if (Array.isArray(accountInfo.data) && accountInfo.data.length >= 1 && typeof accountInfo.data[0] === 'string') {
        const decoded = decodeSplTokenAccount(accountInfo.data[0]);
        if (decoded) out.splToken = decoded;
    }
    return out;
}

/**
 * Compute the net SPL-token amount delta between a pre- and post-snapshot
 * for the same address. Both snapshots come through `readAccountInfo()`.
 *
 * Existence transitions:
 *   - pre.exists=true,  post.exists=true  → BigInt(post.amount - pre.amount)
 *   - pre.exists=false, post.exists=true  → +BigInt(post.amount) (newly created)
 *   - pre.exists=true,  post.exists=false → -BigInt(pre.amount) (closed)
 *   - pre.exists=false, post.exists=false → 0n
 *
 * For non-existent pre or post, returns `nullSemantics` indicating which
 * transition occurred — callers use this to enforce per-account existence
 * policy (Codex amendment §2): `allowCreate`, `allowClose`, `mustExistBefore`.
 *
 * @returns {{
 *   delta: bigint,
 *   nullSemantics: 'pre_to_post' | 'create' | 'close' | 'both_null'
 * }}
 */
function tokenDelta(pre, post) {
    const preHas = pre && pre.exists && pre.splToken;
    const postHas = post && post.exists && post.splToken;
    if (preHas && postHas) {
        return { delta: post.splToken.amountAtomic - pre.splToken.amountAtomic, nullSemantics: 'pre_to_post' };
    }
    if (!preHas && postHas) {
        return { delta: post.splToken.amountAtomic, nullSemantics: 'create' };
    }
    if (preHas && !postHas) {
        return { delta: -pre.splToken.amountAtomic, nullSemantics: 'close' };
    }
    return { delta: 0n, nullSemantics: 'both_null' };
}

/**
 * Same shape as `tokenDelta` but for native SOL (lamports). Uses
 * `readAccountInfo().lamports`. SOL accounts always exist if the burner
 * is configured (rent-exempt), so create/close semantics are atypical
 * but supported for completeness.
 */
function lamportsDelta(pre, post) {
    const preHas = pre && pre.exists;
    const postHas = post && post.exists;
    if (preHas && postHas) {
        return { delta: post.lamports - pre.lamports, nullSemantics: 'pre_to_post' };
    }
    if (!preHas && postHas) {
        return { delta: post.lamports, nullSemantics: 'create' };
    }
    if (preHas && !postHas) {
        return { delta: -pre.lamports, nullSemantics: 'close' };
    }
    return { delta: 0n, nullSemantics: 'both_null' };
}

module.exports = {
    SPL_TOKEN_ACCOUNT_MIN_BYTES,
    decodeSplTokenAccount,
    readAccountInfo,
    tokenDelta,
    lamportsDelta,
};
