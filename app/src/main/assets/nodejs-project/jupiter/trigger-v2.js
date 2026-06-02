// SeekerClaw — jupiter/trigger-v2.js
// BAT-697 PR B: Jupiter Trigger API V2 adapter.
//
// Pure module — tool handlers pass in signer callbacks. No direct wallet
// or dispatch coupling. This makes the auth/vault/deposit/create/cancel/
// recovery flows testable without spinning the bridge.
//
// SCOPE OF THIS FILE
// ------------------
// 1. Auth challenge → verify → 24h JWT (in-memory per-pubkey cache).
// 2. Blind-sign guards (parse memo-only auth tx, reject value-moving instrs).
// 3. Vault register (lazy — only on first trigger create per wallet).
// 4. Deposit craft → wallet signs → orders/price create.
// 5. Two-step cancel: cancel/{id} → wallet signs → confirm-cancel/{id}.
// 6. Ambiguous-create recovery via /orders/history.
// 7. Order history list (GET).
// 8. V2 semantic validation (min $10, required expiresAt, USD trigger,
//    explicit slippage).
//
// AUTH CHALLENGE TYPE — TRANSACTION ONLY IN PR B
// ----------------------------------------------
// V2 contract specifies message-first with transaction fallback "on a
// clearly unsupported-method/capability error" (per Codex round-2 #3).
// PR B has no `/burner/sign-message` or `/solana/sign-message` bridge
// endpoint, so both wallets fall directly to transaction-challenge —
// the spec-allowed path. The adapter still accepts `signers.signMessage`
// as an optional callback; a follow-up BAT can add the bridge endpoints
// and pass a non-null signMessage, and the adapter will prefer the
// message path automatically.
//
// JWT CACHE
// ---------
// In-memory only, per-pubkey, NOT persisted across Node restart. 24h JWT
// TTL minus a 60s skew. Refresh-on-401: any V2 call that returns 401
// invalidates the cache for that pubkey and the caller can retry once.
// The retry is the caller's responsibility (the adapter exposes
// `invalidateJwt(pubkey)`).
//
// NEVER LOG: signatures, JWTs, raw challenge text. All log lines redact
// signature/token-shaped fields. Caller-side logs in tools/solana.js also
// route through the existing redactSecrets pattern.

'use strict';

const { httpRequest } = require('../http');
const { log, config } = require('../config');

// ── Module-level state ──────────────────────────────────────────────────────

// JWT cache: pubkey → { token, expiresAt }. Token is opaque (Jupiter Bearer).
// expiresAt is a JS millisecond timestamp; we refresh anything within 60s.
const _jwtCache = new Map();

// Vault cache: pubkey → { vaultAddress, registered: true }. Lazy — populated
// at first trigger_create per wallet.
const _vaultCache = new Map();

// 60s skew before JWT expiry to avoid a refresh race on the wire.
const JWT_SKEW_MS = 60_000;
// Jupiter docs: 24h JWT TTL. We don't trust the server-returned expiry
// (Jupiter only returns the token, not an expires-at), so we anchor on
// our own clock.
const JWT_TTL_MS = 24 * 60 * 60 * 1000;

const JUPITER_HOST = 'api.jup.ag';

// V2 semantic validation bounds (per contract v2 §6).
const MIN_ORDER_USD = 10;
const MIN_EXPIRY_SKEW_MS = 60_000; // expiresAt must be ≥ now+1min
const DEFAULT_SLIPPAGE_BPS = 100;  // 1% — matches solana_swap default
const MIN_SLIPPAGE_BPS = 1;
const MAX_SLIPPAGE_BPS = 10_000;

// ── HTTP helpers ────────────────────────────────────────────────────────────

function _ensureApiKey() {
    if (!config.jupiterApiKey) {
        return {
            error: 'jupiter_api_key_required',
            reason: 'Get a free key at portal.jup.ag and add it in Settings > Configuration > Jupiter API Key',
        };
    }
    return null;
}

function _authHeaders(token) {
    const h = { 'x-api-key': config.jupiterApiKey, 'Accept': 'application/json' };
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
}

async function _post(path, body, token) {
    const headers = { ..._authHeaders(token), 'Content-Type': 'application/json' };
    const res = await httpRequest({ hostname: JUPITER_HOST, path, method: 'POST', headers }, body);
    return _parseResponse(res);
}

async function _get(path, token) {
    const res = await httpRequest({ hostname: JUPITER_HOST, path, method: 'GET', headers: _authHeaders(token) });
    return _parseResponse(res);
}

function _parseResponse(res) {
    const data = typeof res.data === 'string' ? _safeJsonParse(res.data) : res.data;
    return { status: res.status, data, raw: res };
}

function _safeJsonParse(s) {
    try { return JSON.parse(s); } catch (_) { return s; }
}

// ── Blind-sign guards (contract v2 §4) ──────────────────────────────────────

/**
 * Validate a JSON auth challenge payload before passing it to the signer.
 * Refuses anything that isn't shaped like a Jupiter Trigger V2 auth challenge
 * for the requested wallet.
 *
 * Returns { ok: true } or { ok: false, error, reason }.
 */
function _validateChallengePayload(payload, expectedPubkey) {
    if (!payload || typeof payload !== 'object') {
        return { ok: false, error: 'auth_challenge_invalid', reason: 'challenge payload is not an object' };
    }
    if (payload.type !== 'message' && payload.type !== 'transaction') {
        return { ok: false, error: 'auth_challenge_invalid', reason: `challenge type must be "message" or "transaction" (got ${payload.type})` };
    }
    if (payload.type === 'message') {
        if (typeof payload.challenge !== 'string' || payload.challenge.length === 0) {
            return { ok: false, error: 'auth_challenge_invalid', reason: 'message challenge body is empty' };
        }
    } else {
        if (typeof payload.transaction !== 'string' || payload.transaction.length === 0) {
            return { ok: false, error: 'auth_challenge_invalid', reason: 'transaction challenge body is empty' };
        }
    }
    // Pubkey echo check — Jupiter may include `walletPubkey` in the response.
    // If present, it MUST match the one we asked for. If absent, we can't
    // verify here but the verify endpoint will reject any mismatch downstream.
    if (payload.walletPubkey && payload.walletPubkey !== expectedPubkey) {
        return { ok: false, error: 'auth_challenge_invalid', reason: 'walletPubkey echoed by Jupiter does not match the active wallet' };
    }
    return { ok: true };
}

/**
 * Parse a transaction-challenge tx (base64) and validate that it's a
 * memo-only Jupiter auth transaction (no Transfer, swap, closeAccount, or
 * any value-moving instruction). Memo program ID is the well-known SPL
 * Memo v2: `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`.
 *
 * Constraints checked:
 *   1. Buffer decodes to a plausible Solana tx (signatures + message).
 *   2. Fee payer (first account) equals expectedPubkey.
 *   3. EVERY instruction's program id is in the auth allowlist — Memo
 *      (v1/v2) or ComputeBudget. No other programs (no SystemProgram::
 *      Transfer, no Token program, no swap, no closeAccount — nothing that
 *      can move value or state). ComputeBudget is allowed because Jupiter's
 *      real challenge bundles it and it cannot move value; see the constant
 *      block below for the full rationale + residual fee-grief note.
 *
 * Returns { ok: true } or { ok: false, error, reason }.
 */
const MEMO_PROGRAM_V2 = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const MEMO_PROGRAM_V1 = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';
// ComputeBudget — sets CU limit / priority fee. Moves NO value (cannot
// transfer SOL or tokens to any party; only affects the fee the payer pays
// to validators). Jupiter's REAL auth challenge (verified against the live
// API on 2026-05-29) bundles a ComputeBudget instruction alongside the Memo,
// so a Memo-only guard rejects the legitimate challenge. Whitelisting it is
// safe: the value-moving programs we actually defend against (SystemProgram
// Transfer, SPL-Token transfer/approve/closeAccount, swap/DEX programs) are
// still rejected by the allowlist below.
// PR #388 R10: previously this comment noted a RESIDUAL fee-grief risk —
// "a malicious challenge could set an absurd SetComputeUnitPrice to grief
// the payer on priority fees". That risk is now closed: ComputeBudget
// instructions are decoded and capped (see _validateComputeBudgetInstr
// below). The burner path silently zero-cap-signs auth challenges, so a
// SOL-draining priority fee in an unbounded auth tx WAS a real attack
// surface even with TLS to Jupiter (compromised endpoint, MITM, etc.).
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
// Programs an auth challenge may reference. Everything else → reject.
const _AUTH_ALLOWED_PROGRAMS = new Set([MEMO_PROGRAM_V1, MEMO_PROGRAM_V2, COMPUTE_BUDGET_PROGRAM]);

// PR #388 R10: ComputeBudget caps for auth challenges. Auth txs only need
// to commit to a Memo payload + maybe set a modest CU price — they should
// never need anything close to mainnet ceilings. Tight caps mean a
// compromised or MITM'd Jupiter endpoint can't sneak a high-fee draining
// tx past the blind-sign guard.
//   - Max CU limit: 200_000 (memo + budget ix fit comfortably under this;
//     Solana default per-tx limit is 200K)
//   - Max CU price: 2_000_000 micro_lamports/CU (combined with the 200K CU
//     ceiling → priority fee worst case = 200_000 * 2_000_000 / 1_000_000
//     = 400_000 lamports ≈ 0.0004 SOL per auth tx — still trivial. Pre-cap
//     threat model: SetComputeUnitPrice is a u64 micro_lamports/CU field,
//     so the unbounded priority fee at u64::MAX would be
//     200_000 * (1.8e19) / 1_000_000 ≈ 3.6e18 lamports ≈ 3.6e9 SOL —
//     astronomically larger than any payer's actual balance. In practice
//     the drain is bounded only by the payer's SOL — a hostile auth tx
//     would drain whatever the burner has (or fail with insufficient-funds)
//     on every signed challenge. PR #393 R8 update — the original comment
//     said "~4.29 SOL per auth tx" which was wrong: ~4.29 SOL corresponds
//     to u32::MAX in the DEPRECATED additional_fee path below, not to the
//     u64 SetComputeUnitPrice path. R9 follow-up: corrected the magnitude
//     from 3.7e21 to 3.6e18 lamports (extra 10^3 factor came from mistakenly
//     applying the lamports→micro_lamports scale twice).)
//   - Max additional_fee (deprecated tag 0x00): 5_000 lamports ≈ 0.000005
//     SOL — same trivial ceiling, accommodates any real-world priority bump.
//     Pre-cap worst case at u32::MAX for this u32-lamports field = ~4.29 SOL
//     per auth tx (this is the field where the 4.29 SOL figure actually
//     applies, not SetComputeUnitPrice above).
//
// PR #393 / BAT-995 device test 2026-06-02: original CU price cap of
// 10_000 micro_lamports/CU was 100× too tight. Jupiter's real auth
// challenge txs on mainnet use SetComputeUnitPrice=1_000_000 (legitimate
// priority fee under mainnet congestion). The blind-sign guard correctly
// rejected those (working as designed) but the cap was empirically
// uncalibrated — bumped to 2_000_000 (2× Jupiter's observed value for
// headroom). The defense against unbounded-fee drain attacks is retained;
// only the conservatism vs Jupiter's legitimate operating range is fixed.
const _AUTH_MAX_CU_LIMIT = 200_000;
const _AUTH_MAX_CU_PRICE_MICROLAMPORTS = 2_000_000n; // BigInt — instr field is u64
const _AUTH_MAX_ADDITIONAL_FEE_LAMPORTS = 5_000;

// Decode + validate a single ComputeBudget instruction's data bytes.
// Returns { ok: true } or { ok: false, reason }.
//
// Fee-affecting tags (capped):
//   0x00 RequestUnitsDeprecated (u32 units, u32 additional_fee LAMPORTS)
//   0x02 SetComputeUnitLimit    (u32 units)
//   0x03 SetComputeUnitPrice    (u64 micro_lamports/CU)
// Non-fee-affecting tags (accepted silently):
//   0x01 RequestHeapFrame                (u32 bytes — only changes heap, no fee)
//   0x04 SetLoadedAccountsDataSizeLimit  (u32 bytes — limit, no direct fee)
//
// PR #388 R11: tag 0x00's `additional_fee` field was previously treated as
// "unknown safe" and accepted unconditionally — that left a fee-drain path
// the same magnitude as the unbounded SetComputeUnitPrice path. Now decoded
// and capped.
function _validateComputeBudgetInstr(data) {
    if (data.length === 0) return { ok: true };
    const tag = data[0];
    // 0x00 = RequestUnitsDeprecated (u32 LE units, u32 LE additional_fee LAMPORTS)
    if (tag === 0x00) {
        if (data.length < 9) return { ok: false, reason: 'ComputeBudget RequestUnitsDeprecated data truncated' };
        const units = data.readUInt32LE(1);
        const additionalFee = data.readUInt32LE(5);
        if (units > _AUTH_MAX_CU_LIMIT) {
            return { ok: false, reason: `ComputeBudget RequestUnitsDeprecated units=${units} exceeds auth-tx cap ${_AUTH_MAX_CU_LIMIT}` };
        }
        if (additionalFee > _AUTH_MAX_ADDITIONAL_FEE_LAMPORTS) {
            return { ok: false, reason: `ComputeBudget RequestUnitsDeprecated additional_fee=${additionalFee} lamports exceeds auth-tx cap ${_AUTH_MAX_ADDITIONAL_FEE_LAMPORTS}` };
        }
    }
    // 0x02 = SetComputeUnitLimit (u32 LE units)
    else if (tag === 0x02) {
        if (data.length < 5) return { ok: false, reason: 'ComputeBudget SetComputeUnitLimit data truncated' };
        const limit = data.readUInt32LE(1);
        if (limit > _AUTH_MAX_CU_LIMIT) {
            return { ok: false, reason: `ComputeBudget SetComputeUnitLimit=${limit} exceeds auth-tx cap ${_AUTH_MAX_CU_LIMIT}` };
        }
    }
    // 0x03 = SetComputeUnitPrice (u64 LE micro_lamports/CU)
    else if (tag === 0x03) {
        if (data.length < 9) return { ok: false, reason: 'ComputeBudget SetComputeUnitPrice data truncated' };
        const priceLo = BigInt(data.readUInt32LE(1));
        const priceHi = BigInt(data.readUInt32LE(5));
        const price = (priceHi << 32n) | priceLo;
        if (price > _AUTH_MAX_CU_PRICE_MICROLAMPORTS) {
            return { ok: false, reason: `ComputeBudget SetComputeUnitPrice=${price.toString()} exceeds auth-tx cap ${_AUTH_MAX_CU_PRICE_MICROLAMPORTS.toString()} micro_lamports/CU` };
        }
    }
    // 0x01 RequestHeapFrame, 0x04 SetLoadedAccountsDataSizeLimit → no direct
    // SOL drain (heap frame doesn't add fee; loaded-accounts cap just limits
    // what can be loaded). CU spent on those is bounded by 0x02 above.
    return { ok: true };
}

function _validateAuthTransaction(txBase64, expectedPubkey) {
    if (typeof txBase64 !== 'string' || txBase64.length === 0) {
        return { ok: false, error: 'auth_tx_invalid', reason: 'empty transaction payload' };
    }
    let txBuf;
    try {
        txBuf = Buffer.from(txBase64, 'base64');
    } catch (_) {
        return { ok: false, error: 'auth_tx_invalid', reason: 'transaction is not valid base64' };
    }
    if (txBuf.length < 64) {
        return { ok: false, error: 'auth_tx_invalid', reason: 'transaction shorter than one signature slot' };
    }

    let offset = 0;
    const sigCount = _readCompactU16(txBuf, offset);
    if (!sigCount) {
        return { ok: false, error: 'auth_tx_invalid', reason: 'malformed signature count' };
    }
    offset = sigCount.offset + sigCount.value * 64;
    if (offset >= txBuf.length) {
        return { ok: false, error: 'auth_tx_invalid', reason: 'transaction truncated before message header' };
    }

    // v0 prefix (0x80) means versioned message; otherwise legacy. We accept
    // both — auth memos are typically legacy.
    let messageOffset = offset;
    const versionByte = txBuf[messageOffset];
    if (versionByte === 0x80) {
        messageOffset += 1; // skip v0 byte
    }

    // Message header: 3 bytes
    if (messageOffset + 3 > txBuf.length) {
        return { ok: false, error: 'auth_tx_invalid', reason: 'message header truncated' };
    }
    messageOffset += 3; // numRequired, numReadonlySigned, numReadonlyUnsigned

    const acctCount = _readCompactU16(txBuf, messageOffset);
    if (!acctCount) {
        return { ok: false, error: 'auth_tx_invalid', reason: 'malformed account count' };
    }
    messageOffset = acctCount.offset;
    const accountKeys = [];
    for (let i = 0; i < acctCount.value; i++) {
        if (messageOffset + 32 > txBuf.length) {
            return { ok: false, error: 'auth_tx_invalid', reason: 'account key array truncated' };
        }
        accountKeys.push(_base58Encode(txBuf.slice(messageOffset, messageOffset + 32)));
        messageOffset += 32;
    }
    if (accountKeys.length === 0) {
        return { ok: false, error: 'auth_tx_invalid', reason: 'no account keys' };
    }

    // First account is the fee payer.
    if (accountKeys[0] !== expectedPubkey) {
        return {
            ok: false,
            error: 'auth_tx_invalid',
            reason: `fee payer mismatch: tx pays from ${accountKeys[0]}, expected ${expectedPubkey}`,
        };
    }

    // Skip recent blockhash (32 bytes).
    messageOffset += 32;
    if (messageOffset > txBuf.length) {
        return { ok: false, error: 'auth_tx_invalid', reason: 'message truncated before instructions' };
    }

    const instrCount = _readCompactU16(txBuf, messageOffset);
    if (!instrCount) {
        return { ok: false, error: 'auth_tx_invalid', reason: 'malformed instruction count' };
    }
    messageOffset = instrCount.offset;
    if (instrCount.value === 0) {
        return { ok: false, error: 'auth_tx_invalid', reason: 'auth tx must contain at least one instruction' };
    }

    // Count Memo instructions as we walk — auth challenges MUST carry the
    // actual challenge payload in a Memo. A ComputeBudget-only tx is in the
    // program allowlist but contains no challenge text to commit to, so
    // signing it would be signing nothing meaningful (PR #388 R2 finding).
    // PR #388 R7: also track whether ANY Memo instruction carries non-empty
    // data — an empty Memo (data length 0) commits to no payload, defeating
    // the purpose of the blind-sign guard the same way a missing Memo does.
    let memoCount = 0;
    let memoWithDataCount = 0;
    for (let i = 0; i < instrCount.value; i++) {
        if (messageOffset + 1 > txBuf.length) {
            return { ok: false, error: 'auth_tx_invalid', reason: `instruction ${i} truncated at program id index` };
        }
        const programIdx = txBuf[messageOffset]; messageOffset += 1;
        if (programIdx >= accountKeys.length) {
            return { ok: false, error: 'auth_tx_invalid', reason: `instruction ${i} program index ${programIdx} out of range` };
        }
        const programId = accountKeys[programIdx];
        if (!_AUTH_ALLOWED_PROGRAMS.has(programId)) {
            return {
                ok: false,
                error: 'auth_tx_invalid',
                reason: `instruction ${i} references disallowed program ${programId} — auth tx may only use Memo or ComputeBudget`,
            };
        }
        const isMemo = programId === MEMO_PROGRAM_V1 || programId === MEMO_PROGRAM_V2;
        const isComputeBudget = programId === COMPUTE_BUDGET_PROGRAM;
        if (isMemo) memoCount += 1;
        // Skip accounts compact-u16 + bytes
        const acctIdx = _readCompactU16(txBuf, messageOffset);
        if (!acctIdx) {
            return { ok: false, error: 'auth_tx_invalid', reason: `instruction ${i} malformed accounts count` };
        }
        messageOffset = acctIdx.offset + acctIdx.value;
        // Read data compact-u16 + bytes
        const dataLen = _readCompactU16(txBuf, messageOffset);
        if (!dataLen) {
            return { ok: false, error: 'auth_tx_invalid', reason: `instruction ${i} malformed data length` };
        }
        if (isMemo && dataLen.value > 0) memoWithDataCount += 1;
        const dataStart = dataLen.offset;
        const dataEnd = dataStart + dataLen.value;
        if (dataEnd > txBuf.length) {
            return { ok: false, error: 'auth_tx_invalid', reason: `instruction ${i} data truncated` };
        }
        // PR #388 R10: decode + cap ComputeBudget payloads. Without this,
        // a hostile or compromised challenge endpoint could set absurd
        // CU price / CU limit values and drain the fee payer's SOL when
        // the signed auth tx is later broadcast — the blind-sign guard
        // would have happily approved the empty value-transfer surface
        // but missed the fee-grief vector.
        if (isComputeBudget) {
            const cbCheck = _validateComputeBudgetInstr(txBuf.slice(dataStart, dataEnd));
            if (!cbCheck.ok) {
                return { ok: false, error: 'auth_tx_invalid', reason: `instruction ${i} ${cbCheck.reason}` };
            }
        }
        messageOffset = dataEnd;
    }

    if (memoCount === 0) {
        return {
            ok: false,
            error: 'auth_tx_invalid',
            reason: 'auth tx must contain at least one Memo (v1 or v2) instruction — a ComputeBudget-only tx carries no challenge payload to commit to',
        };
    }
    if (memoWithDataCount === 0) {
        return {
            ok: false,
            error: 'auth_tx_invalid',
            reason: 'auth tx contains Memo instruction(s) but all are empty (zero-byte data) — Memo must carry the challenge payload bytes for the blind-sign guard to be meaningful',
        };
    }

    return { ok: true };
}

// Compact-u16 reader. Returns { value, offset } or null if malformed.
// Strict 2-byte cap (max value 16383). Solana spec technically allows a
// 3-byte short_vec (up to 0xFFFF, with byte 3 contributing only 2 bits),
// but auth-challenge txs in our context never need more than a 2-byte count
// (Memo + ComputeBudget — small instruction/account counts). The stricter
// cap also avoids the byte-3 u16-overflow ambiguity that the earlier reader
// allowed (byte 3 high bits left unmasked silently producing values > 65535).
// The gate is at the TOP of the loop so a 3rd byte is never read.
function _readCompactU16(buf, offset) {
    if (offset >= buf.length) return null;
    let v = 0, shift = 0, i = offset;
    while (i < buf.length) {
        if (shift > 7) return null;
        const b = buf[i]; i += 1;
        v |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) return { value: v, offset: i };
        shift += 7;
    }
    return null;
}

// Minimal base58 encoder for account keys. Mirrors solana.js::base58Encode
// (avoids requiring it to keep this module dependency-free / testable).
const _BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function _base58Encode(buf) {
    if (!buf || buf.length === 0) return '';
    let zeros = 0;
    while (zeros < buf.length && buf[zeros] === 0) zeros += 1;
    const digits = [0];
    for (let i = zeros; i < buf.length; i++) {
        let carry = buf[i];
        for (let j = 0; j < digits.length; j++) {
            carry += digits[j] << 8;
            digits[j] = carry % 58;
            carry = (carry / 58) | 0;
        }
        while (carry) {
            digits.push(carry % 58);
            carry = (carry / 58) | 0;
        }
    }
    let str = '1'.repeat(zeros);
    for (let i = digits.length - 1; i >= 0; i--) str += _BASE58_ALPHABET[digits[i]];
    return str;
}

// ── Auth ────────────────────────────────────────────────────────────────────

/**
 * Cached JWT lookup. Returns { token } or null when miss/expired.
 */
function _getCachedJwt(pubkey) {
    const entry = _jwtCache.get(pubkey);
    if (!entry) return null;
    if (Date.now() + JWT_SKEW_MS >= entry.expiresAt) {
        _jwtCache.delete(pubkey);
        return null;
    }
    return { token: entry.token };
}

function invalidateJwt(pubkey) {
    _jwtCache.delete(pubkey);
}

/**
 * Authenticate a wallet and return a Bearer token. Cached for 24h - 60s.
 *
 * @param {string} pubkey  - base58 wallet pubkey to authenticate
 * @param {object} signers - { signTransaction(b64) → b64signed, signMessage?(bytes) → b58sig }
 *                           signMessage is OPTIONAL. When null/undefined, transaction-challenge is used.
 * @returns {Promise<{ok: true, token, cached?: boolean} | {ok: false, error, reason}>}
 */
async function authenticate(pubkey, signers) {
    if (typeof pubkey !== 'string' || pubkey.length === 0) {
        return { ok: false, error: 'invalid_input', reason: 'pubkey required' };
    }
    if (!signers || typeof signers.signTransaction !== 'function') {
        return { ok: false, error: 'invalid_input', reason: 'signers.signTransaction required' };
    }
    const keyErr = _ensureApiKey();
    if (keyErr) return { ok: false, ...keyErr };

    // Cache hit?
    const cached = _getCachedJwt(pubkey);
    if (cached) {
        return { ok: true, token: cached.token, cached: true };
    }

    // Prefer message challenge when the wallet supports it. Per Codex round-2
    // #3: fallback to transaction ONLY on an unsupported-capability error,
    // never on user rejection. The adapter encodes this as: if signMessage
    // is provided, try it; if it returns `{ error: 'unsupported_capability' }`
    // (or any error shape with `unsupported: true`), fall back. Any OTHER
    // error (user_rejected, timeout, etc.) is surfaced WITHOUT fallback so
    // a denial can't be parlayed into a second consent prompt.
    if (typeof signers.signMessage === 'function') {
        const msgResult = await _authenticateMessage(pubkey, signers);
        if (msgResult.ok) {
            _cacheJwt(pubkey, msgResult.token);
            return { ok: true, token: msgResult.token };
        }
        const isUnsupported = msgResult.unsupported === true
            || msgResult.error === 'unsupported_capability';
        if (!isUnsupported) {
            // Surface message-path failure WITHOUT falling back. A user
            // rejection or timeout must not be silently re-prompted as a
            // tx-challenge — that would convert a no into a second yes/no.
            return { ok: false, error: msgResult.error || 'auth_failed', reason: msgResult.reason };
        }
        log(`[trigger-v2] message-challenge unsupported, falling back to transaction-challenge for ${_redactPubkey(pubkey)}`, 'INFO');
    }

    const txResult = await _authenticateTransaction(pubkey, signers);
    if (!txResult.ok) return txResult;
    _cacheJwt(pubkey, txResult.token);
    return { ok: true, token: txResult.token };
}

async function _authenticateMessage(pubkey, signers) {
    const challengeRes = await _post(
        '/trigger/v2/auth/challenge',
        { walletPubkey: pubkey, type: 'message' },
    );
    if (challengeRes.status !== 200) {
        return { ok: false, error: 'auth_challenge_failed', reason: `HTTP ${challengeRes.status}` };
    }
    const validation = _validateChallengePayload(challengeRes.data, pubkey);
    if (!validation.ok) return { ok: false, error: validation.error, reason: validation.reason };
    if (challengeRes.data.type !== 'message') {
        return { ok: false, error: 'auth_challenge_invalid', reason: `expected message challenge, got ${challengeRes.data.type}` };
    }

    const signature = await signers.signMessage(Buffer.from(challengeRes.data.challenge, 'utf8'));
    if (!signature || typeof signature !== 'object' && typeof signature !== 'string') {
        return { ok: false, error: 'auth_sign_failed', reason: 'signMessage returned no result' };
    }
    if (typeof signature === 'object' && signature.error) {
        return {
            ok: false,
            error: signature.error,
            reason: signature.reason,
            unsupported: signature.unsupported === true || signature.error === 'unsupported_capability',
        };
    }
    const sigB58 = typeof signature === 'string' ? signature : signature.signatureBase58;
    if (!sigB58) {
        return { ok: false, error: 'auth_sign_failed', reason: 'signMessage returned no signatureBase58' };
    }

    const verifyRes = await _post(
        '/trigger/v2/auth/verify',
        { type: 'message', walletPubkey: pubkey, signature: sigB58 },
    );
    if (verifyRes.status !== 200) {
        return { ok: false, error: 'auth_verify_failed', reason: `HTTP ${verifyRes.status}` };
    }
    if (!verifyRes.data || typeof verifyRes.data.token !== 'string') {
        return { ok: false, error: 'auth_verify_failed', reason: 'no token in verify response' };
    }
    return { ok: true, token: verifyRes.data.token };
}

async function _authenticateTransaction(pubkey, signers) {
    const challengeRes = await _post(
        '/trigger/v2/auth/challenge',
        { walletPubkey: pubkey, type: 'transaction' },
    );
    if (challengeRes.status !== 200) {
        return { ok: false, error: 'auth_challenge_failed', reason: `HTTP ${challengeRes.status}` };
    }
    const validation = _validateChallengePayload(challengeRes.data, pubkey);
    if (!validation.ok) return { ok: false, error: validation.error, reason: validation.reason };
    if (challengeRes.data.type !== 'transaction') {
        return { ok: false, error: 'auth_challenge_invalid', reason: `expected transaction challenge, got ${challengeRes.data.type}` };
    }
    const txValidation = _validateAuthTransaction(challengeRes.data.transaction, pubkey);
    if (!txValidation.ok) {
        log(`[trigger-v2] BLIND-SIGN GUARD blocked auth tx for ${_redactPubkey(pubkey)}: ${txValidation.reason}`, 'WARN');
        return { ok: false, error: txValidation.error, reason: txValidation.reason };
    }

    const signed = await signers.signTransaction(challengeRes.data.transaction);
    if (!signed || (typeof signed === 'object' && signed.error)) {
        return {
            ok: false,
            error: (signed && signed.error) || 'auth_sign_failed',
            reason: (signed && signed.reason) || 'signTransaction returned no result',
        };
    }
    const signedB64 = typeof signed === 'string' ? signed : (signed.signedTxBase64 || signed.signedTransaction);
    if (!signedB64) {
        return { ok: false, error: 'auth_sign_failed', reason: 'signTransaction returned no signedTxBase64' };
    }

    const verifyRes = await _post(
        '/trigger/v2/auth/verify',
        { type: 'transaction', walletPubkey: pubkey, signedTransaction: signedB64 },
    );
    if (verifyRes.status !== 200) {
        return { ok: false, error: 'auth_verify_failed', reason: `HTTP ${verifyRes.status}` };
    }
    if (!verifyRes.data || typeof verifyRes.data.token !== 'string') {
        return { ok: false, error: 'auth_verify_failed', reason: 'no token in verify response' };
    }
    return { ok: true, token: verifyRes.data.token };
}

function _cacheJwt(pubkey, token) {
    _jwtCache.set(pubkey, { token, expiresAt: Date.now() + JWT_TTL_MS });
}

function _redactPubkey(pubkey) {
    if (typeof pubkey !== 'string' || pubkey.length < 8) return '<pubkey>';
    return `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`;
}

// ── Vault registration (lazy per Codex round-2 #4) ──────────────────────────

/**
 * Ensure the wallet has a Jupiter/Privy vault, returning its vaultPubkey.
 *
 * Contract (Jupiter V2 openapi, verified live 2026-05-29):
 *   • GET /trigger/v2/vault          → 200 {userPubkey, vaultPubkey, privyVaultId, privyUserId?}
 *                                       (JWT identifies the wallet; 404 when no vault yet)
 *   • GET /trigger/v2/vault/register → 200/201 {userPubkey, vaultPubkey, privyVaultId}
 *                                       IDEMPOTENT — registration is a GET; the Privy
 *                                       custodial vault is created server-side (no funds,
 *                                       no on-chain action). Subsequent calls return the
 *                                       existing vault.
 * (Both are GET + JWT-only — there is NO POST register endpoint; the first
 * draft's POST /vault/register 404'd in the live probe.)
 *
 * Cached in-memory per pubkey for the Node lifetime — vault is one-shot.
 */
async function ensureVault(pubkey, token) {
    const cached = _vaultCache.get(pubkey);
    if (cached && cached.vaultPubkey) return { ok: true, vaultPubkey: cached.vaultPubkey };

    // 1) Try the existing vault.
    const getRes = await _get('/trigger/v2/vault', token);
    if (getRes.status === 401) {
        invalidateJwt(pubkey);
        return { ok: false, error: 'auth_expired', reason: 'JWT rejected by /vault' };
    }
    if (getRes.status === 200 && getRes.data && getRes.data.vaultPubkey) {
        _vaultCache.set(pubkey, { vaultPubkey: getRes.data.vaultPubkey });
        return { ok: true, vaultPubkey: getRes.data.vaultPubkey };
    }

    // 2) PR #388 R3: only register on the DOCUMENTED "no vault yet" signal
    // (HTTP 404). Any other non-2xx — 429, 5xx, malformed JSON, etc. — must
    // surface the original failure unchanged. Pre-fix, any non-success fell
    // through to /vault/register, which (a) hid transient errors behind a
    // confusing register attempt, and (b) on a 429 could trigger a second
    // rate-limited call instead of letting the caller back off.
    if (getRes.status !== 404) {
        return {
            ok: false,
            error: 'vault_unavailable',
            reason: `GET /vault returned HTTP ${getRes.status} (expected 200 with vaultPubkey, or 404 "Vault not found"). Not registering — failing closed.`,
        };
    }

    // 3) 404 confirmed → register (idempotent GET). Privy creates the vault
    // server-side; no on-chain action, no funds.
    const regRes = await _get('/trigger/v2/vault/register', token);
    if (regRes.status === 401) {
        invalidateJwt(pubkey);
        return { ok: false, error: 'auth_expired', reason: 'JWT rejected by /vault/register' };
    }
    if (regRes.status >= 200 && regRes.status < 300 && regRes.data && regRes.data.vaultPubkey) {
        _vaultCache.set(pubkey, { vaultPubkey: regRes.data.vaultPubkey });
        return { ok: true, vaultPubkey: regRes.data.vaultPubkey };
    }
    return {
        ok: false,
        error: 'vault_unavailable',
        reason: `GET /vault/register returned HTTP ${regRes.status} without a vaultPubkey`,
    };
}

// ── V2 semantic validation (contract v2 §6) ─────────────────────────────────

/**
 * Validate the user-supplied order args BEFORE any auth/deposit work. Pure —
 * no I/O — so the agent gets an immediate, deterministic rejection on bad
 * input rather than burning a deposit signing on a doomed order.
 *
 * inputUsdValue is the caller-computed USD value of `inputAmount`. The
 * adapter doesn't fetch prices itself to keep the module pure and testable;
 * the tool handler resolves the price via the existing `jupiterPrice()` call
 * and passes the result in.
 */
function validateOrderArgs({ inputUsdValue, expiresAtMs, triggerPriceUsd, slippageBps }) {
    if (!Number.isFinite(inputUsdValue) || inputUsdValue <= 0) {
        return { ok: false, error: 'input_usd_value_invalid', reason: 'caller must supply inputUsdValue as a positive number' };
    }
    if (inputUsdValue < MIN_ORDER_USD) {
        return {
            ok: false,
            error: 'min_order_size_below_10_usd',
            reason: `Order size $${inputUsdValue.toFixed(2)} is below Jupiter Trigger V2's $${MIN_ORDER_USD} minimum.`,
        };
    }
    if (!Number.isFinite(expiresAtMs) || expiresAtMs < Date.now() + MIN_EXPIRY_SKEW_MS) {
        return {
            ok: false,
            error: 'expires_at_too_soon',
            reason: 'expiresAt must be at least 1 minute in the future.',
        };
    }
    if (!Number.isFinite(triggerPriceUsd) || triggerPriceUsd <= 0) {
        return {
            ok: false,
            error: 'trigger_price_required',
            reason: 'triggerPriceUsd is required and must be a positive number (USD, e.g., 80.50 for $80.50).',
        };
    }
    if (slippageBps != null) {
        if (!Number.isInteger(slippageBps) || slippageBps < MIN_SLIPPAGE_BPS || slippageBps > MAX_SLIPPAGE_BPS) {
            return {
                ok: false,
                error: 'slippage_out_of_range',
                reason: `slippageBps must be an integer between ${MIN_SLIPPAGE_BPS} and ${MAX_SLIPPAGE_BPS} (0.01% to 100%).`,
            };
        }
    }
    return { ok: true };
}

// ── Low-level create primitives ─────────────────────────────────────────────
//
// The tool handler composes these with the existing wallet/dispatch helpers
// (routeAndSign) so the burner reservation lifecycle (reserve → sign-with-
// reservation → commit/release) wraps the deposit signing step.
//
// Sequence:
//   1. tool handler calls depositCraft(...) → { transaction, depositRequestId, recoveryContext }
//   2. tool handler calls routeAndSign(unsignedTx=transaction, broadcast: async signedDepositTx => {
//          return submitCreateOrder({ recoveryContext, depositSignedTx: signedDepositTx, order, ... });
//      })
//   3. routeAndSign handles burner reserve/sign/commit-or-release (or main MWA sign-only)
//   4. submitCreateOrder runs ambiguous-recovery on lost responses
//
// Why two primitives instead of one high-level fn: routeAndSign's reservation
// spans sign + broadcast (= POST to /orders/price), and commit/release fires
// based on the broadcast result. To get that lifecycle right, the tool handler
// has to drive both halves explicitly.

/**
 * POST /trigger/v2/deposit/craft. Returns the unsigned deposit tx + the
 * depositRequestId that must accompany the eventual /orders/price POST.
 *
 * Caller is responsible for signing the returned transaction and passing
 * both the signed tx AND the recoveryContext to submitCreateOrder.
 *
 * recoveryContext is opaque to the caller — it carries the metadata
 * needed to find the order in /orders/history if the create POST is lost
 * after deposit signing. Caller must NOT persist or log it.
 *
 * Contract (Jupiter V2 openapi, verified live 2026-05-29):
 *   POST /trigger/v2/deposit/craft
 *   body: { inputMint, outputMint, userAddress, amount (smallest-unit string),
 *           orderType:'price', orderSubType:'single' }
 *   resp: { transaction (base64 unsigned), requestId, receiverAddress, mint,
 *           amount, tokenDecimals, ... }
 * Note the cross-endpoint naming quirk: craft uses `userAddress`/`amount`,
 * while /orders/price (submitCreateOrder) uses `userPubkey`/`inputAmount`.
 * The craft response's `requestId` becomes /orders/price's `depositRequestId`.
 */
async function depositCraft({ pubkey, token, inputMint, outputMint, inputAmount }) {
    if (!token) return { ok: false, error: 'auth_required', reason: 'no JWT supplied — call authenticate() first' };
    if (!outputMint) return { ok: false, error: 'invalid_input', reason: 'outputMint required for deposit/craft' };
    const craftRes = await _post('/trigger/v2/deposit/craft', {
        inputMint,
        outputMint,
        userAddress: pubkey,
        amount: inputAmount,
        orderType: 'price',
        orderSubType: 'single',
    }, token);
    if (craftRes.status === 401) {
        invalidateJwt(pubkey);
        return { ok: false, error: 'auth_expired', reason: 'JWT rejected by deposit/craft' };
    }
    if (craftRes.status !== 200) {
        return { ok: false, error: 'deposit_craft_failed', reason: `HTTP ${craftRes.status}` };
    }
    if (!craftRes.data || typeof craftRes.data.transaction !== 'string' || !craftRes.data.requestId) {
        return { ok: false, error: 'deposit_craft_failed', reason: 'response missing transaction or requestId' };
    }
    const recoveryContext = {
        walletPubkey: pubkey,
        depositRequestId: craftRes.data.requestId,
        inputMint,
        outputMint, // PR #388 R2: needed for the recovery heuristic to discriminate two same-mint+amount orders.
        inputAmount,
        timestamp: Date.now(),
    };
    // PR #388 R5: depositRequestId is the ambiguous-create correlation token
    // — keeping it OUT of persistent logs limits how an attacker who reads
    // node_debug.log could correlate a wallet's deposit attempts. The token
    // is still surfaced in the returned recoveryContext + the user-facing
    // ambiguous-recovery advisory, which is where consumers actually need it.
    log(`[trigger-v2] deposit/craft wallet=${_redactPubkey(pubkey)} input=${inputMint} amount=${inputAmount}`, 'INFO');
    return {
        ok: true,
        transaction: craftRes.data.transaction,
        depositRequestId: craftRes.data.requestId,
        recoveryContext,
    };
}

/**
 * POST /trigger/v2/orders/price. Runs ambiguous-create recovery on lost or
 * incomplete responses (status >= 500, status 200 but missing id, network
 * exceptions). Never auto-retries a non-idempotent create POST.
 *
 * @param {object} params
 * @param {string} params.token
 * @param {object} params.recoveryContext - from depositCraft()
 * @param {string} params.depositSignedTx - caller-signed deposit tx
 * @param {object} params.order - { inputMint, inputAmount, outputMint, triggerMint?, triggerPriceUsd, triggerCondition?, slippageBps?, expiresAtMs }
 */
async function submitCreateOrder({ token, recoveryContext, depositSignedTx, order }) {
    if (!token) return { ok: false, error: 'auth_required', reason: 'no JWT supplied — call authenticate() first' };
    if (!recoveryContext || !recoveryContext.walletPubkey || !recoveryContext.depositRequestId) {
        return { ok: false, error: 'invalid_input', reason: 'recoveryContext required (from depositCraft)' };
    }
    if (typeof depositSignedTx !== 'string' || depositSignedTx.length === 0) {
        return { ok: false, error: 'invalid_input', reason: 'depositSignedTx required' };
    }

    // Contract (Jupiter V2 openapi, verified live 2026-05-29):
    //   POST /trigger/v2/orders/price
    //   { orderType:'single', depositRequestId, depositSignedTx, userPubkey,
    //     inputMint, inputAmount, outputMint, triggerMint, triggerCondition,
    //     triggerPriceUsd, slippageBps?, expiresAt }
    // For a single price order, orderType IS 'single' (the sub-type value) —
    // distinct from deposit/craft which uses orderType:'price'+orderSubType.
    // expiresAt is MILLISECONDS (not seconds). userPubkey/inputAmount here
    // (vs userAddress/amount on craft).
    const createBody = {
        orderType: 'single',
        depositRequestId: recoveryContext.depositRequestId,
        depositSignedTx,
        userPubkey: recoveryContext.walletPubkey,
        inputMint: order.inputMint,
        inputAmount: order.inputAmount,
        outputMint: order.outputMint,
        triggerMint: order.triggerMint || order.outputMint,
        triggerCondition: order.triggerCondition || 'below',
        triggerPriceUsd: order.triggerPriceUsd,
        expiresAt: order.expiresAtMs,
    };
    if (order.slippageBps != null) createBody.slippageBps = order.slippageBps;

    let createRes;
    try {
        createRes = await _post('/trigger/v2/orders/price', createBody, token);
    } catch (e) {
        log(`[trigger-v2] create POST threw after signed deposit: ${e.message} — entering recovery`, 'WARN');
        return await _recoverFromAmbiguousCreate(recoveryContext, token);
    }

    if (createRes.status === 401) {
        invalidateJwt(recoveryContext.walletPubkey);
        return { ok: false, error: 'auth_expired', reason: 'JWT rejected by orders/price', recovery: recoveryContext };
    }

    // Ambiguous: 5xx OR no body at all. Deposit may or may not have landed —
    // recover via /orders/history.
    if (createRes.status >= 500 || !createRes.data) {
        log(`[trigger-v2] ambiguous create response (status=${createRes.status}, hasData=${!!createRes.data}) — entering recovery`, 'WARN');
        return await _recoverFromAmbiguousCreate(recoveryContext, token);
    }

    // Accept ANY 2xx with id as success. The original `status === 200` gate
    // dropped a 201/202 + id into the create_failed branch — silent
    // funds-on-chain-but-error-to-user inconsistency. Jupiter is consistent
    // with 200 today, but defending against legitimate alternate 2xx codes
    // is the safe shape.
    if (createRes.status >= 200 && createRes.status < 300) {
        if (createRes.data.id) {
            return {
                ok: true,
                id: createRes.data.id,
                txSignature: createRes.data.txSignature || null,
                depositRequestId: recoveryContext.depositRequestId,
            };
        }
        // 2xx but no id — ambiguous (Jupiter accepted-but-pending?). Recover.
        log(`[trigger-v2] 2xx without id (status=${createRes.status}) — entering recovery`, 'WARN');
        return await _recoverFromAmbiguousCreate(recoveryContext, token);
    }

    // Non-2xx, non-5xx (3xx redirect, 4xx hard error) — fail outright. The
    // deposit signature went to Jupiter but the server rejected the order
    // params or auth — there's nothing useful to recover.
    return { ok: false, error: 'create_failed', reason: `HTTP ${createRes.status}` };
}

/**
 * Ambiguous-create recovery (contract v2 §5).
 *
 * Sequence:
 *   1. Wait 5s for any in-flight settle on Jupiter's side.
 *   2. Query /orders/history filtered by walletPubkey.
 *   3. Match PRIMARILY on depositRequestId (unique to this attempt) when the
 *      history row carries it — the only definitive correlation. Fall back to
 *      a heuristic (inputMint + inputAmount + non-terminal status + tight
 *      time window) ONLY when no row exposes depositRequestId.
 *   4. If found → success, with `recovered: true` flag.
 *   5. If not found → return orphan-deposit advisory with the
 *      depositRequestId so the user can check Jupiter UI manually.
 *
 * NEVER auto-retries the create POST — non-idempotent + funds-moving.
 */
// Terminal states for /orders/history rows — orders in any of these are DEAD
// and MUST NOT be reported as a recovered success. Verified live 2026-05-30:
// history rows use `orderState` (NOT `status`); a cancelled order surfaces
// as `orderState:"cancelled"`. The deny-list shape is safer than an allow-list
// of live states because Jupiter may add new in-flight states we'd miss.
const _RECOVERY_TERMINAL_STATES = new Set([
    'cancelled', 'canceled', 'expired', 'filled', 'failed', 'rejected', 'closed',
]);

async function _recoverFromAmbiguousCreate(ctx, token) {
    // PR #388 R5: don't persist the depositRequestId correlation token to
    // node_debug.log (see depositCraft logging note above). The token is
    // still in `ctx` and the returned recoveryNote/reason for callers.
    log(`[trigger-v2] recovery: waiting 5s before /orders/history query for wallet=${_redactPubkey(ctx.walletPubkey)}`, 'INFO');
    await new Promise(r => setTimeout(r, 5000));

    // PR #388 R4: recovery is the LAST chance to surface "the deposit may
    // have landed" — every failure mode here MUST stay in the ambiguous
    // bucket so the upstream broadcast callback commits the burner cap
    // conservatively (over-count is safer than under-count). Pre-fix:
    //   - A transport throw bubbled up to routeAndSign, which treated it
    //     as broadcast failure and RELEASED the reservation.
    //   - The 401 branch returned `auth_expired`, which the broadcast
    //     callback returned as `{error: ...}` → also release.
    // Both cases freed the cap while funds may have been sitting in the
    // Privy vault. We now wrap the history call in try/catch and route
    // ALL failure modes (transport throw, 401, 5xx, malformed JSON)
    // through the same `create_ambiguous_no_recovery` exit so the cap
    // commits and the user gets a manual-recovery advisory.
    let histRes;
    try {
        histRes = await _get(`/trigger/v2/orders/history?walletPubkey=${encodeURIComponent(ctx.walletPubkey)}&limit=20`, token);
    } catch (e) {
        log(`[trigger-v2] recovery: /orders/history threw: ${e.message} — ambiguous bucket`, 'WARN');
        return _ambiguousNoRecovery(ctx, `history lookup threw during recovery (${e.message})`);
    }
    if (histRes.status === 401) {
        // Still invalidate the cached JWT so a follow-up call re-auths
        // cleanly, but route this through the ambiguous bucket rather than
        // auth_expired — the deposit may have landed and we lost our only
        // way to confirm it.
        invalidateJwt(ctx.walletPubkey);
        return _ambiguousNoRecovery(ctx, 'JWT rejected by /orders/history during recovery (cached JWT invalidated; re-auth and retry the original create from scratch if you want to verify)');
    }
    if (histRes.status === 200 && histRes.data && Array.isArray(histRes.data.orders)) {
        const orders = histRes.data.orders.filter(Boolean);

        // Real-API field-name correction (verified live 2026-05-30 via
        // tests/jupiter-ultra/v2-contract-probe.js --verify-onchain):
        //   row keys: id, orderState, rawState, initialInputAmount,
        //             remainingInputAmount, inputMint, outputMint, createdAt,
        //             events, ...  — NO depositRequestId / requestId on rows.
        // Implication: correlation MUST be heuristic (mint + initial amount +
        // tight time window around the attempt). The depositRequestId-primary
        // correlation the first draft used is IMPOSSIBLE — that field does
        // not exist on the history surface. The tight bounded window keeps
        // false-match risk small even without a unique correlator.
        //
        // initialInputAmount = deposit at creation; remainingInputAmount shrinks
        // as the order fills. We match on initial to find OUR create attempt.
        const lo = ctx.timestamp - 15_000;   // 15s skew tolerance before the attempt
        const hi = ctx.timestamp + 180_000;  // 3min ceiling after the attempt
        const isLive = (o) => !_RECOVERY_TERMINAL_STATES.has(o.orderState);
        const match = orders.find((o) => {
            if (!isLive(o)) return false;
            if (o.inputMint !== ctx.inputMint) return false;
            // PR #388 R2: discriminate two same-mint+amount orders by also
            // requiring outputMint to match. A wallet running multiple limit
            // orders on the same input token could otherwise false-match.
            if (ctx.outputMint && o.outputMint !== ctx.outputMint) return false;
            if (String(o.initialInputAmount) !== String(ctx.inputAmount)) return false;
            if (!o.createdAt) return false;
            const created = new Date(o.createdAt).getTime();
            return Number.isFinite(created) && created >= lo && created <= hi;
        });

        if (match && match.id) {
            // events[] carries per-event txSignatures; surface the deposit
            // signature if present so the caller can stamp the broadcast.
            let depositSig = null;
            if (Array.isArray(match.events)) {
                const dep = match.events.find((e) => e && e.type === 'deposit' && e.txSignature);
                if (dep) depositSig = dep.txSignature;
            }
            log(`[trigger-v2] recovery: matched order id=${match.id} in history (orderState=${match.orderState})`, 'INFO');
            return {
                ok: true,
                id: match.id,
                txSignature: depositSig,
                depositRequestId: ctx.depositRequestId,
                recovered: true,
                recoveryNote: 'Order matched in /orders/history (inputMint + outputMint + initialInputAmount + tight time window) after lost create response.',
            };
        }
    }

    return _ambiguousNoRecovery(ctx, 'history query returned no matching order');
}

// PR #388 R4: single exit shape for "deposit was signed + sent but we
// couldn't confirm the order id." All recovery failure modes (transport
// throw, 401, 5xx, malformed response, history-miss) MUST route through
// here so the upstream broadcast callback in _jupiterTriggerCreateV2 sees
// `create_ambiguous_no_recovery` and commits the burner cap conservatively.
// Releasing the cap on any of these failure modes would risk under-counting
// spend if the deposit actually landed in the Privy vault.
function _ambiguousNoRecovery(ctx, detail) {
    return {
        ok: false,
        error: 'create_ambiguous_no_recovery',
        reason:
            `Create POST response was lost AND recovery could not confirm the order (${detail}). ` +
            `Deposit may still be in flight or stuck. Check Jupiter UI for depositRequestId=${ctx.depositRequestId}. ` +
            'Funds will appear in the Jupiter vault if the deposit landed; cancel or use Jupiter UI to recover.',
        recovery: ctx,
    };
}

// ── Two-step cancel primitives ──────────────────────────────────────────────
//
// Same composability rationale as create: tool handler drives the signing
// step explicitly so burner-owned cancels can flow through signCancelViaBurner
// (zero-cap reservation, ownership-gated) and main-owned cancels through
// /solana/sign-only.

/**
 * POST /trigger/v2/orders/price/cancel/{id}. Returns unsigned cancel tx +
 * the cancelRequestId that must accompany confirmCancel.
 */
async function cancelStep1({ orderId, pubkey, token }) {
    if (!orderId) return { ok: false, error: 'invalid_input', reason: 'orderId required' };
    if (!token) return { ok: false, error: 'auth_required', reason: 'no JWT supplied — call authenticate() first' };
    const res = await _post(`/trigger/v2/orders/price/cancel/${encodeURIComponent(orderId)}`, {}, token);
    if (res.status === 401) {
        invalidateJwt(pubkey);
        return { ok: false, error: 'auth_expired', reason: 'JWT rejected by cancel step 1' };
    }
    if (res.status !== 200) {
        return { ok: false, error: 'cancel_step1_failed', reason: `HTTP ${res.status}` };
    }
    if (!res.data || typeof res.data.transaction !== 'string' || !res.data.requestId) {
        return { ok: false, error: 'cancel_step1_failed', reason: 'response missing transaction or requestId' };
    }
    return { ok: true, transaction: res.data.transaction, cancelRequestId: res.data.requestId };
}

/**
 * POST /trigger/v2/orders/price/confirm-cancel/{id}. Takes the signed cancel
 * tx + the cancelRequestId from cancelStep1. Returns the executed signature
 * on success.
 */
async function confirmCancel({ orderId, pubkey, token, signedTransaction, cancelRequestId }) {
    if (!orderId) return { ok: false, error: 'invalid_input', reason: 'orderId required' };
    if (!token) return { ok: false, error: 'auth_required', reason: 'no JWT supplied — call authenticate() first' };
    if (typeof signedTransaction !== 'string' || !signedTransaction) {
        return { ok: false, error: 'invalid_input', reason: 'signedTransaction required' };
    }
    if (!cancelRequestId) return { ok: false, error: 'invalid_input', reason: 'cancelRequestId required (from cancelStep1)' };
    const res = await _post(
        `/trigger/v2/orders/price/confirm-cancel/${encodeURIComponent(orderId)}`,
        { signedTransaction, cancelRequestId },
        token,
    );
    if (res.status === 401) {
        invalidateJwt(pubkey);
        return { ok: false, error: 'auth_expired', reason: 'JWT rejected by confirm-cancel' };
    }
    if (res.status !== 200) {
        return { ok: false, error: 'confirm_cancel_failed', reason: `HTTP ${res.status}` };
    }
    return { ok: true, id: orderId, txSignature: (res.data && res.data.txSignature) || null };
}

// ── List orders ─────────────────────────────────────────────────────────────

/**
 * List orders from /orders/history. Optional status filter ("active" / "history"
 * mirrors V1 UX; V2 history endpoint covers both via filter).
 */
async function listOrders({ pubkey, token, status, page, limit }) {
    if (!token) return { ok: false, error: 'auth_required', reason: 'no JWT supplied — call authenticate() first' };
    const params = new URLSearchParams({ walletPubkey: pubkey });
    if (status) params.set('status', status);
    if (page != null) params.set('page', String(page));
    if (limit != null) params.set('limit', String(limit));
    const res = await _get(`/trigger/v2/orders/history?${params.toString()}`, token);
    if (res.status === 401) {
        invalidateJwt(pubkey);
        return { ok: false, error: 'auth_expired', reason: 'JWT rejected by orders/history' };
    }
    if (res.status !== 200) {
        return { ok: false, error: 'list_failed', reason: `HTTP ${res.status}` };
    }
    const orders = (res.data && Array.isArray(res.data.orders)) ? res.data.orders : [];
    return { ok: true, orders };
}

// NOTE: a PATCH /orders/price/{orderId} "update order" primitive (and its
// _patch HTTP helper) were considered but deliberately NOT shipped in PR B —
// there is no V1 tool to migrate and no handler would call it, so it would be
// dead, untested, funds-adjacent code. Add both in a dedicated follow-up BAT
// alongside a `jupiter_trigger_update` tool + tests when the product needs
// edit-in-place.

// ── Test-only ───────────────────────────────────────────────────────────────

function _resetCachesForTests() {
    _jwtCache.clear();
    _vaultCache.clear();
}

module.exports = {
    // High-level (single-shot, no signing-step composition needed).
    authenticate,
    invalidateJwt,
    ensureVault,
    listOrders,
    validateOrderArgs,
    // Low-level (caller drives signing between primitives so reservation
    // lifecycles can wrap the deposit/cancel sign step).
    depositCraft,
    submitCreateOrder,
    cancelStep1,
    confirmCancel,
    // Exported for tests + cross-module use of the guards.
    _validateChallengePayload,
    _validateAuthTransaction,
    _validateComputeBudgetInstr,
    _readCompactU16,
    _base58Encode,
    _resetCachesForTests,
    _redactPubkey,
    // Constants useful to callers/tests.
    MIN_ORDER_USD,
    DEFAULT_SLIPPAGE_BPS,
    MEMO_PROGRAM_V1,
    MEMO_PROGRAM_V2,
    _AUTH_MAX_CU_LIMIT,
    _AUTH_MAX_CU_PRICE_MICROLAMPORTS,
    _AUTH_MAX_ADDITIONAL_FEE_LAMPORTS,
};
