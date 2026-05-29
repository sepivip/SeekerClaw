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
 *   3. EVERY instruction's program id is the Memo program. No other
 *      programs (no SystemProgram::Transfer, no Token program, no swap,
 *      no closeAccount — nothing that can move value or state).
 *
 * Returns { ok: true } or { ok: false, error, reason }.
 */
const MEMO_PROGRAM_V2 = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const MEMO_PROGRAM_V1 = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';

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
        return { ok: false, error: 'auth_tx_invalid', reason: 'auth tx must contain at least one Memo instruction' };
    }

    for (let i = 0; i < instrCount.value; i++) {
        if (messageOffset + 1 > txBuf.length) {
            return { ok: false, error: 'auth_tx_invalid', reason: `instruction ${i} truncated at program id index` };
        }
        const programIdx = txBuf[messageOffset]; messageOffset += 1;
        if (programIdx >= accountKeys.length) {
            return { ok: false, error: 'auth_tx_invalid', reason: `instruction ${i} program index ${programIdx} out of range` };
        }
        const programId = accountKeys[programIdx];
        if (programId !== MEMO_PROGRAM_V2 && programId !== MEMO_PROGRAM_V1) {
            return {
                ok: false,
                error: 'auth_tx_invalid',
                reason: `instruction ${i} references non-Memo program ${programId} — auth tx must be Memo-only`,
            };
        }
        // Skip accounts compact-u16 + bytes
        const acctIdx = _readCompactU16(txBuf, messageOffset);
        if (!acctIdx) {
            return { ok: false, error: 'auth_tx_invalid', reason: `instruction ${i} malformed accounts count` };
        }
        messageOffset = acctIdx.offset + acctIdx.value;
        // Skip data compact-u16 + bytes
        const dataLen = _readCompactU16(txBuf, messageOffset);
        if (!dataLen) {
            return { ok: false, error: 'auth_tx_invalid', reason: `instruction ${i} malformed data length` };
        }
        messageOffset = dataLen.offset + dataLen.value;
        if (messageOffset > txBuf.length) {
            return { ok: false, error: 'auth_tx_invalid', reason: `instruction ${i} data truncated` };
        }
    }

    return { ok: true };
}

// Compact-u16 reader. Returns { value, offset } or null if malformed.
function _readCompactU16(buf, offset) {
    if (offset >= buf.length) return null;
    let v = 0, shift = 0, i = offset;
    while (i < buf.length) {
        const b = buf[i]; i += 1;
        v |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) return { value: v, offset: i };
        shift += 7;
        if (shift > 14) return null;
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
 * Ensure the wallet has a Jupiter/Privy vault. GETs vault address; if not
 * registered, POSTs /vault/register. Cached in-memory per pubkey for the
 * Node lifetime — vault registration is one-shot per wallet.
 */
async function ensureVault(pubkey, token) {
    const cached = _vaultCache.get(pubkey);
    if (cached && cached.registered) return { ok: true, vaultAddress: cached.vaultAddress };

    const getRes = await _get(`/trigger/v2/vault?walletPubkey=${encodeURIComponent(pubkey)}`, token);
    if (getRes.status === 200 && getRes.data && getRes.data.registered === true && getRes.data.vaultAddress) {
        _vaultCache.set(pubkey, { vaultAddress: getRes.data.vaultAddress, registered: true });
        return { ok: true, vaultAddress: getRes.data.vaultAddress };
    }

    // Not registered (or vault endpoint returns 404 for unregistered) — POST register.
    const regRes = await _post('/trigger/v2/vault/register', { walletPubkey: pubkey }, token);
    if (regRes.status !== 200 && regRes.status !== 201) {
        return { ok: false, error: 'vault_register_failed', reason: `HTTP ${regRes.status}` };
    }
    if (!regRes.data || !regRes.data.vaultAddress) {
        return { ok: false, error: 'vault_register_failed', reason: 'no vaultAddress in response' };
    }
    _vaultCache.set(pubkey, { vaultAddress: regRes.data.vaultAddress, registered: true });
    return { ok: true, vaultAddress: regRes.data.vaultAddress };
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
 */
async function depositCraft({ pubkey, token, inputMint, inputAmount }) {
    if (!token) return { ok: false, error: 'auth_required', reason: 'no JWT supplied — call authenticate() first' };
    const craftRes = await _post('/trigger/v2/deposit/craft', {
        walletPubkey: pubkey,
        orderType: 'price',
        orderSubType: 'single',
        inputMint,
        inputAmount,
    }, token);
    if (craftRes.status === 401) {
        invalidateJwt(pubkey);
        return { ok: false, error: 'auth_expired', reason: 'JWT rejected by deposit/craft' };
    }
    if (craftRes.status !== 200) {
        return { ok: false, error: 'deposit_craft_failed', reason: `HTTP ${craftRes.status}` };
    }
    if (!craftRes.data || typeof craftRes.data.transaction !== 'string' || !craftRes.data.depositRequestId) {
        return { ok: false, error: 'deposit_craft_failed', reason: 'response missing transaction or depositRequestId' };
    }
    const recoveryContext = {
        walletPubkey: pubkey,
        depositRequestId: craftRes.data.depositRequestId,
        inputMint,
        inputAmount,
        timestamp: Date.now(),
    };
    log(`[trigger-v2] deposit/craft wallet=${_redactPubkey(pubkey)} input=${inputMint} amount=${inputAmount} depositRequestId=${recoveryContext.depositRequestId}`, 'INFO');
    return {
        ok: true,
        transaction: craftRes.data.transaction,
        depositRequestId: craftRes.data.depositRequestId,
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

    // BAT-697 LIVE-SMOKE MUST-VERIFY: the orderType/orderSubType pair on the
    // create POST is unconfirmed against the live API. deposit/craft uses
    // { orderType:'price', orderSubType:'single' }; we mirror that family here
    // for internal consistency rather than the bare orderType:'single' the
    // first draft sent. Commit-3 live smoke MUST confirm the exact wire shape
    // Jupiter expects (it may want only orderType, only orderSubType, or
    // neither since the path already says /orders/price). Adjust here once
    // verified — this is the single most likely create-rejection cause.
    const createBody = {
        orderType: 'price',
        orderSubType: 'single',
        depositRequestId: recoveryContext.depositRequestId,
        depositSignedTx,
        userPubkey: recoveryContext.walletPubkey,
        inputMint: order.inputMint,
        inputAmount: order.inputAmount,
        outputMint: order.outputMint,
        triggerMint: order.triggerMint || order.outputMint,
        expiresAt: Math.floor(order.expiresAtMs / 1000),
        triggerCondition: order.triggerCondition || 'below',
        triggerPriceUsd: order.triggerPriceUsd,
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

    if (createRes.status >= 500 || !createRes.data || (createRes.status === 200 && !createRes.data.id)) {
        log(`[trigger-v2] ambiguous create response (status=${createRes.status}, hasId=${!!(createRes.data && createRes.data.id)}) — entering recovery`, 'WARN');
        return await _recoverFromAmbiguousCreate(recoveryContext, token);
    }

    if (createRes.status !== 200) {
        return { ok: false, error: 'create_failed', reason: `HTTP ${createRes.status}` };
    }

    return {
        ok: true,
        id: createRes.data.id,
        txSignature: createRes.data.txSignature || null,
        depositRequestId: recoveryContext.depositRequestId,
    };
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
// States that mean the order is live (deposit landed / order working). An
// order in any OTHER state — including a terminal failure that still carries
// vaultState:'pending_deposit' — must NOT be reported as a recovered success,
// or we'd commit the burner cap for a dead order and tell the user it worked.
const _RECOVERY_LIVE_STATUSES = new Set(['active', 'pending_deposit', 'open']);
const _RECOVERY_TERMINAL_FAIL = new Set(['failed', 'cancelled', 'canceled', 'expired', 'rejected', 'closed']);

async function _recoverFromAmbiguousCreate(ctx, token) {
    log(`[trigger-v2] recovery: waiting 5s before /orders/history query for depositRequestId=${ctx.depositRequestId}`, 'INFO');
    await new Promise(r => setTimeout(r, 5000));

    const histRes = await _get(`/trigger/v2/orders/history?walletPubkey=${encodeURIComponent(ctx.walletPubkey)}&limit=20`, token);
    if (histRes.status === 200 && histRes.data && Array.isArray(histRes.data.orders)) {
        const orders = histRes.data.orders.filter(Boolean);

        const isLive = (o) =>
            !_RECOVERY_TERMINAL_FAIL.has(o.status)
            && (_RECOVERY_LIVE_STATUSES.has(o.status) || o.vaultState === 'pending_deposit');

        // PRIMARY: depositRequestId correlation. Unique per attempt, so it can
        // never alias a pre-existing same-amount order. Accept whichever field
        // name Jupiter exposes (depositRequestId / requestId).
        let match = orders.find(o =>
            isLive(o)
            && (o.depositRequestId === ctx.depositRequestId || o.requestId === ctx.depositRequestId)
        );

        // FALLBACK (only if no row carried a deposit-request id at all): the
        // mint + amount + tight-time-window heuristic. Bounded on BOTH sides
        // around the attempt so a stale identical order from minutes earlier
        // can't false-match. ctx.timestamp is recorded at deposit/craft (just
        // before the create POST), so our order's createdAt is ≈ctx.timestamp
        // and never earlier; allow a small clock skew either way.
        const anyRowHasReqId = orders.some(o => o.depositRequestId != null || o.requestId != null);
        if (!match && !anyRowHasReqId) {
            const lo = ctx.timestamp - 15_000;   // 15s skew tolerance before the attempt
            const hi = ctx.timestamp + 180_000;  // 3min ceiling after the attempt
            match = orders.find(o => {
                if (!isLive(o)) return false;
                if (o.inputMint !== ctx.inputMint) return false;
                if (String(o.inputAmount) !== String(ctx.inputAmount)) return false;
                if (!o.createdAt) return false; // require a timestamp to bound the heuristic
                const created = new Date(o.createdAt).getTime();
                return Number.isFinite(created) && created >= lo && created <= hi;
            });
        }

        if (match && match.id) {
            log(`[trigger-v2] recovery: matched order id=${match.id} in history`, 'INFO');
            return {
                ok: true,
                id: match.id,
                txSignature: match.txSignature || null,
                depositRequestId: ctx.depositRequestId,
                recovered: true,
                recoveryNote: 'Order found in /orders/history after lost create response.',
            };
        }
    }

    return {
        ok: false,
        error: 'create_ambiguous_no_recovery',
        reason:
            'Create POST response was lost AND /orders/history showed no matching order. ' +
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
    _readCompactU16,
    _base58Encode,
    _resetCachesForTests,
    _redactPubkey,
    // Constants useful to callers/tests.
    MIN_ORDER_USD,
    DEFAULT_SLIPPAGE_BPS,
    MEMO_PROGRAM_V1,
    MEMO_PROGRAM_V2,
};
