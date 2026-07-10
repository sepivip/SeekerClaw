// SeekerClaw — providers/xai.js (BAT-1124)
// xAI "Grok" provider adapter. Talks to the OpenAI-compatible
// `api.x.ai/v1/chat/completions` endpoint for BOTH auth types:
//   - api_key: a console.x.ai API key (Bearer)
//   - oauth:   a "Sign in with Grok" access token from a SuperGrok /
//              X Premium+ subscription (Bearer, refreshed on 401).
//
// Message translation (neutral ↔ Chat Completions), vision, usage, and
// rate-limit parsing are DELEGATED to openrouter.js — the same clean
// Chat-Completions shaping custom.js reuses. This file owns only the
// xAI-specific bits: endpoint, headers (incl. our own User-Agent),
// a clean request body (NO OpenRouter cache_control / fallback
// decorations, NO openai.js Codex `store:false`/reasoning shaping),
// error classification, and OAuth refresh.
//
// SECURITY (see BAT-1124 contract §5.4 / §11b):
//  - C1: a 403 is NEVER type:'auth' — ai.js gates handleUnauthorized() on
//        type==='auth', and firing a refresh on a 403 would burn xAI's
//        SINGLE-USE refresh-token rotation. 403 = lazy-provisioning /
//        tier-gate; OAuth first-touch retries ONCE (module one-shot flag,
//        not MAX_RETRIES) then terminal — api_key 403s are terminal at once.
//  - H1: rotated access+refresh tokens are registered with the redactor
//        BEFORE any log() so they never leak into node_debug.log.
//  - H2: refreshOAuthToken is single-flight (concurrent 401s share one
//        rotation) and AWAITs the bridge persist — a persist failure is a
//        HARD error, never a silent resolve(true) on an unpersisted
//        (server-rotated) refresh token.
//  - H4: our OWN `SeekerClaw/<ver>` User-Agent on the inference request AND
//        the auth.x.ai refresh POST (Cloudflare gates non-browser UAs).
//  - L3: endpoints are HARDCODED (no OIDC discovery — removes a token-
//        exfiltration MITM surface); the public client_id is duplicated
//        Kotlin↔Node and must stay byte-equal.

const {
    log,
    XAI_KEY,
    XAI_OAUTH_TOKEN,
    XAI_OAUTH_REFRESH,
    XAI_OAUTH_EXPIRES_AT,
    AUTH_TYPE,
} = require('../config');
const { androidBridgeCall } = require('../bridge');
const { registerRedactedSecret } = require('../security');
const openrouter = require('./openrouter');

// Grok public OAuth client id (no secret — the discovery advertises
// token_endpoint_auth_methods "none"). Must stay BYTE-EQUAL with the Kotlin
// side (app/src/main/java/com/seekerclaw/app/oauth/XaiOAuthActivity.kt:CLIENT_ID)
// — drift silently breaks refresh. Exported so a smoke test can assert the
// two literals match. (The Node side never STARTS an OAuth flow — only
// refreshes — so duplication is preferable to plumbing it through the bridge.)
const OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';

// L3: hardcoded auth endpoints — no runtime OIDC discovery in v1.
const OAUTH_HOSTNAME = 'auth.x.ai';
const OAUTH_TOKEN_PATH = '/oauth2/token';

// Access-token TTL fallback (~6h) if the refresh response omits expires_in.
const _DEFAULT_EXPIRES_IN = 21600;

// BAT-1143: refresh the access token this long BEFORE its absolute expiry, on
// BOTH the proactive gate and the reactive-403 gate (Codex Q1 → 5 min).
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
// Bounded convergence for a rotation that succeeded server-side but failed to
// persist (D9): after this many failed re-persist attempts across turns we stop
// hammering the bridge and surface a durable error (re-pair may be needed after a
// restart). The valid in-memory token keeps THIS session working throughout.
const MAX_PERSIST_CONVERGENCE_ATTEMPTS = 5;

// H4: SeekerClaw's OWN User-Agent (never Grok-CLI's). Version from the
// AGENT_VERSION env var Kotlin injects (message-handler.js reads the same),
// else a stable "SeekerClaw" — Cloudflare only needs a non-empty, non-curl UA.
const _AGENT_VER = (typeof process.env.AGENT_VERSION === 'string' && process.env.AGENT_VERSION.trim())
    ? process.env.AGENT_VERSION.trim()
    : '';
const SEEKERCLAW_UA = _AGENT_VER ? `SeekerClaw/${_AGENT_VER}` : 'SeekerClaw';

const isOAuth = AUTH_TYPE === 'oauth';

// ── Connection details ──────────────────────────────────────────────────────

// Same base for api_key AND oauth. XAI_BASE_URL overrides the inference base
// (protocol + host + port) for device tests / self-hosted gateways; the path
// stays chat/completions. Returns all three pieces ai.js/http.js plumb through
// so a gateway on http:// or a non-443 port actually works — parsing only the
// hostname (as this used to) silently dropped protocol/port. Malformed / unset
// → the canonical api.x.ai over https:443.
function _resolveXaiBase() {
    const raw = (typeof process.env.XAI_BASE_URL === 'string' ? process.env.XAI_BASE_URL : '').trim();
    const DEFAULT = { protocol: 'https:', hostname: 'api.x.ai', port: undefined };
    if (!raw) return DEFAULT;
    try {
        const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
        return {
            protocol: u.protocol || 'https:',
            hostname: u.hostname || 'api.x.ai',
            // Explicit port only; undefined lets http.js use the protocol default (443/80).
            port: u.port ? parseInt(u.port, 10) : undefined,
        };
    } catch (_) {
        return DEFAULT;
    }
}

const endpoint = { ..._resolveXaiBase(), path: '/v1/chat/completions' };

// Live in-memory token pair. Seeded from config; rotated by refreshOAuthToken.
let _currentOAuthToken = XAI_OAUTH_TOKEN;
let _currentRefreshToken = XAI_OAUTH_REFRESH;

// ── BAT-1143: proactive-refresh state machine ────────────────────────────────
// Absolute access-token expiry (ms since epoch). Seeded from the persisted
// XAI_OAUTH_EXPIRES_AT (D4). 0 = "expiry unknown" → one opportunistic refresh on
// first use (D5). Advanced SYNCHRONOUSLY on every in-process mint (D3).
let _currentExpiresAtMs = Date.parse(XAI_OAUTH_EXPIRES_AT) || 0;
// D3a: a MONOTONIC mint anchor (process.hrtime, immune to wall-clock/NTP jumps)
// + a validity sentinel. Set ONLY when THIS process mints a token; the age gate
// applies only when valid. A monotonic anchor does NOT survive a restart, so on
// a fresh process we fall back to the absolute expiry above + the D5 one-shot.
let _currentMintedAtMono = 0n;
let _mintedMonoValid = false;
let _currentTtlMs = _DEFAULT_EXPIRES_IN * 1000; // TTL of the last in-process mint (for the age gate)
// D8: monotonic marker bumped on each successful refresh. ai.js tags each request
// with the generation it was built under; a fresh-token 403 whose request shares
// the just-refreshed generation is a genuine tier-gate → trip the breaker.
let _refreshGeneration = 0;
let _tierGated = false;   // circuit-breaker: stop rotating a genuinely tier-gated account
let _refreshDead = false; // invalid_grant → suppress ALL further refresh until re-pair (D9)
// D9: a rotation that succeeded server-side but failed to persist. Keep the pair
// in memory, complete the turn, and re-persist the SAME pair on later calls.
let _persistPending = false;
let _pendingPersistPayload = null;
let _persistAttempts = 0;
let _persistDurableError = false; // convergence exhausted → surface re-pair (D9 step 4)
// D5: one opportunistic refresh when expiry is unknown, at most once.
let _opportunisticRefreshDone = false;

// D3a: ms elapsed since the last IN-PROCESS mint, from the monotonic clock.
// Only meaningful when _mintedMonoValid — callers must gate on that.
function _elapsedMonoMs() {
    return Number(process.hrtime.bigint() - _currentMintedAtMono) / 1e6;
}

// True when the current access token is at/near/ past expiry by EITHER the
// absolute-expiry gate OR the monotonic age gate (D3a — immune to a backward
// wall-clock jump). Shared by the proactive gate (ensureFreshToken) and the
// reactive-403 backstop (classifyError) so both use the same boundary.
function _isTokenExpiredish() {
    const now = Date.now();
    if (_currentExpiresAtMs > 0 && now >= _currentExpiresAtMs - REFRESH_BUFFER_MS) return true;
    if (_mintedMonoValid && _elapsedMonoMs() >= _currentTtlMs - REFRESH_BUFFER_MS) return true;
    return false;
}

function buildHeaders(apiKey) {
    // OAuth uses the (possibly-rotated) access token; api_key uses the key
    // ai.js resolved via getProviderApiKey() (which returns XAI_KEY for xai,
    // NEVER ANTHROPIC_KEY — H3). Never falls back to the Anthropic key here.
    const token = isOAuth ? _currentOAuthToken : apiKey;
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        // H4: our own UA — no impersonation, satisfies Cloudflare's UA gate.
        'User-Agent': SEEKERCLAW_UA,
    };
    // Optional conversation-affinity hint (server ignores it if unset).
    if (typeof process.env.XAI_CONV_ID === 'string' && process.env.XAI_CONV_ID.trim()) {
        headers['x-grok-conv-id'] = process.env.XAI_CONV_ID.trim();
    }
    return headers;
}

// ── Request building ────────────────────────────────────────────────────────
// Clean Chat Completions body — copied from custom.js's chat_completions
// branch. Deliberately NO cache_control / models-fallback (openrouter.js) and
// NO store:false (openai.js Codex).
//
// BAT-1124 reasoning fix (proven live in tests/xai-models `--diagnose`): xAI
// HONORS the OpenAI-style `reasoning_effort` STRING; it does NOT honor
// OpenRouter's `reasoning:{effort}` object. With NO effort bound, a reasoning
// model (grok-4.5) reasons UNBOUNDED — on a large agent request (64 tools + big
// system prompt) that is >60s of SILENT reasoning with no streamed tokens,
// tripping the app's 60s socket-idle timeout; grok-4.3 (lighter) still answers
// in ~3s. Diagnosis: `reasoning_effort:low|minimal` → fast + content; the object
// shape / no field → empty content or timeout. So bound EVERY xAI request:
//   heartbeat/synthetic (reasoningMode==='off')            → 'minimal'
//   user-enabled reasoning on a reasoning-capable model    → 'high'
//   otherwise (responsive interactive default)             → 'low'
function formatRequest(model, maxTokens, systemPrompt, messages, tools, requestOptions) {
    const body = {
        model,
        stream: true,
        max_tokens: maxTokens,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
    };
    if (tools && tools.length > 0) body.tools = tools;
    const ro = requestOptions || {};
    body.reasoning_effort = ro.reasoningMode === 'off'
        ? 'minimal'
        : (ro.reasoningEnabled === true && ro.reasoningSupport === 'yes' ? 'high' : 'low');
    return JSON.stringify(body);
}

// Chat Completions data-only SSE (same protocol http.js drives for openrouter).
const streamProtocol = 'chat-completions';

// ── Error classification ────────────────────────────────────────────────────

// C1: module one-shot flag bounding the OAuth 403 grace-retry to exactly ONE
// across the process. xAI provisions API access LAZILY on the first OAuth touch
// (contract §3), so a signed-in user's first 403 gets a single grace retry; a
// second 403 is a real tier-gate. api_key mode never engages this flag — an
// api_key 403 is terminal on the first hit (a real credit/tier gate, not
// provisioning). This is NOT MAX_RETRIES (which would allow 3 retries and — if
// 403 were ever mis-typed as 'auth' — burn 3 single-use refresh rotations).
let _oauth403RetriedOnce = false;

// Test seam — lets the unit test exercise the first-403 (retry) and
// second-403 (terminal) branches deterministically. Not used in production.
function _resetErrorStateForTests() {
    _oauth403RetriedOnce = false;
    _currentExpiresAtMs = Date.parse(XAI_OAUTH_EXPIRES_AT) || 0;
    _currentMintedAtMono = 0n;
    _mintedMonoValid = false;
    _currentTtlMs = _DEFAULT_EXPIRES_IN * 1000;
    _refreshGeneration = 0;
    _tierGated = false;
    _refreshDead = false;
    _persistPending = false;
    _pendingPersistPayload = null;
    _persistAttempts = 0;
    _persistDurableError = false;
    _opportunisticRefreshDone = false;
    _refreshInFlight = null;
}

// Test seam — drive the BAT-1143 state machine deterministically without real
// timers/tokens. Not used by production code paths.
function _setStateForTests(patch) {
    if (!patch) return;
    if ('expiresAtMs' in patch) _currentExpiresAtMs = patch.expiresAtMs;
    if ('mintedAtMono' in patch) _currentMintedAtMono = patch.mintedAtMono;
    if ('mintedMonoValid' in patch) _mintedMonoValid = patch.mintedMonoValid;
    if ('ttlMs' in patch) _currentTtlMs = patch.ttlMs;
    if ('refreshToken' in patch) _currentRefreshToken = patch.refreshToken;
    if ('refreshDead' in patch) _refreshDead = patch.refreshDead;
    if ('tierGated' in patch) _tierGated = patch.tierGated;
    if ('persistPending' in patch) _persistPending = patch.persistPending;
    if ('oauth403RetriedOnce' in patch) _oauth403RetriedOnce = patch.oauth403RetriedOnce;
    if ('opportunisticRefreshDone' in patch) _opportunisticRefreshDone = patch.opportunisticRefreshDone;
}
function _getStateForTests() {
    return {
        expiresAtMs: _currentExpiresAtMs,
        mintedMonoValid: _mintedMonoValid,
        ttlMs: _currentTtlMs,
        refreshGeneration: _refreshGeneration,
        tierGated: _tierGated,
        refreshDead: _refreshDead,
        persistPending: _persistPending,
        persistDurableError: _persistDurableError,
        opportunisticRefreshDone: _opportunisticRefreshDone,
    };
}

function classifyError(status, data) {
    if (status === 401) {
        // The ONLY branch that may be type:'auth' → ai.js calls
        // handleUnauthorized() → single-flight refresh. Gated on OAuth mode
        // AND a refresh token actually being present; otherwise there is
        // nothing to refresh, so it's a non-retryable credential error.
        // BAT-1143: don't attempt a refresh when the token is known-dead
        // (invalid_grant) or the account is tier-gated — a refresh would just fail
        // again or burn a rotation on a gated account.
        const canRefresh = isOAuth && !!_currentRefreshToken && !_refreshDead && !_tierGated;
        return {
            type: canRefresh ? 'auth' : 'unknown',
            retryable: canRefresh,
            userMessage: isOAuth
                ? '🔐 Can\'t reach Grok — your xAI sign-in may have expired. Reconnect xAI in Settings and try again.'
                : '🔑 Can\'t reach Grok — your xAI API key might be wrong. Check Settings?'
        };
    }
    if (status === 403) {
        // BAT-1143 D7 (reactive backstop) — MUST be the FIRST check inside 403.
        // xAI returns a bare 403 (not 401) when the OAuth access token expires, so
        // a 403 on an at/near-expired token IS refreshable auth, not a tier-gate.
        // This has to precede the provisioning grace below: once _oauth403RetriedOnce
        // latches (after the legitimate first-touch retry), a later 6h-expiry 403
        // would otherwise fall through to the terminal tier-gate and never refresh.
        // Gated on a live refresh token, not-dead, not-already-tier-gated so we never
        // burn a rotation on a genuine tier-gate while the token is still valid.
        if (isOAuth && _currentRefreshToken && !_refreshDead && !_tierGated && _isTokenExpiredish()) {
            return {
                type: 'auth', retryable: true,
                userMessage: '🔐 Refreshing your Grok session…'
            };
        }
        // ⚠️ C1: any OTHER 403 (fresh token) is NEVER type:'auth' — it's
        // provisioning/tier-gate, and firing a refresh here would consume xAI's
        // single-use rotation.
        //
        // The retry-once grace is OAuth-ONLY: xAI provisions API access lazily
        // on the first OAuth touch, so a freshly-signed-in user's first 403 is
        // likely still-provisioning and earns ONE grace retry. An api_key 403 is
        // a real tier/credit gate — terminal on the first hit. D8: once the
        // circuit-breaker has tripped (_tierGated), skip the grace and stay terminal.
        if (isOAuth && !_oauth403RetriedOnce && !_tierGated) {
            _oauth403RetriedOnce = true;
            return {
                type: 'provisioning', retryable: true,
                userMessage: 'Grok API access is provisioning — retrying once...'
            };
        }
        return {
            type: 'provisioning', retryable: false,
            userMessage: isOAuth
                ? 'Your Grok subscription tier doesn\'t include API access — add an xAI API key instead'
                : 'Your xAI API key doesn\'t have access to this model or endpoint. Check your plan at console.x.ai.'
        };
    }
    if (status === 402) {
        // Mode-aware billing surface: an OAuth (Sign in with Grok) user manages
        // billing via their SuperGrok / X Premium+ subscription, NOT console.x.ai
        // (the api-key developer console — they may not even have an account there).
        return {
            type: 'billing', retryable: false,
            userMessage: isOAuth
                ? 'Your Grok access needs attention — check your SuperGrok / X Premium+ subscription'
                : 'Your xAI account needs attention — check billing at console.x.ai'
        };
    }
    if (status === 429) {
        const msg = data?.error?.message || '';
        if (/quota|insufficient|credit/i.test(msg)) {
            // Same mode-aware surface as 402 (console.x.ai is api-key-only).
            return {
                type: 'quota', retryable: false,
                userMessage: isOAuth
                    ? 'Grok usage limit reached — check your SuperGrok / X Premium+ subscription'
                    : 'xAI quota exceeded. Check your usage/billing at console.x.ai'
            };
        }
        return {
            type: 'rate_limit', retryable: true,
            userMessage: '⏳ Got rate limited by xAI. Trying again in a moment...'
        };
    }
    if (status === 404) {
        return {
            type: 'model_not_found', retryable: false,
            userMessage: 'Model not found on xAI. Check the model ID in Settings.'
        };
    }
    if (status >= 500 && status < 600) {
        return {
            type: 'server', retryable: true,
            userMessage: 'xAI API is temporarily unavailable. Retrying...'
        };
    }
    const rawReason = data?.error?.message || '';
    const reason = rawReason.replace(/[*_`\[\]()~>#+\-=|{}.!]/g, '').slice(0, 200);
    return {
        type: 'unknown', retryable: false,
        userMessage: reason.trim()
            ? `API error (${status}): ${reason.trim()}`
            : `Unexpected API error (${status}). Please try again.`
    };
}

function classifyNetworkError(err) {
    const raw = err.message || String(err);
    if (err.timeoutSource === 'transport' || /timeout/i.test(raw)) {
        return { type: 'timeout', userMessage: 'The AI took too long to respond. Please try again.' };
    }
    if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) {
        return { type: 'dns', userMessage: 'Cannot reach xAI — check your internet connection.' };
    }
    if (/ECONNREFUSED|ECONNRESET|EPIPE/i.test(raw)) {
        return { type: 'connection', userMessage: 'Connection to xAI was lost. Please try again.' };
    }
    return { type: 'network', userMessage: 'A network error occurred. Please try again.' };
}

// ── OAuth token refresh ─────────────────────────────────────────────────────

// H2: single-flight guard — concurrent 401 retries must NOT each POST the
// single-use refresh token (the second POST would fail with invalid_grant
// AND the account would be half-rotated). Memoize the in-flight promise and
// clear it when it settles.
let _refreshInFlight = null;

function refreshOAuthToken() {
    _refreshInFlight ??= _performRefresh().finally(() => { _refreshInFlight = null; });
    return _refreshInFlight;
}

async function _performRefresh() {
    const parsed = await _requestRotatedTokens();
    // H1: register the rotated pair with the redactor BEFORE any log/persist
    // so an eyJ… JWT can never surface in node_debug.log.
    if (parsed.access_token) registerRedactedSecret(parsed.access_token);
    if (parsed.refresh_token) registerRedactedSecret(parsed.refresh_token);
    // Keep the rotated tokens in memory for THIS session regardless of whether
    // the persist below succeeds — the new access token is valid server-side.
    _currentOAuthToken = parsed.access_token;
    if (parsed.refresh_token) _currentRefreshToken = parsed.refresh_token;
    // BAT-1143 D3/D3a: advance the in-memory expiry + monotonic mint anchor +
    // generation SYNCHRONOUSLY here, BEFORE the (D9) persist await below. If we
    // advanced them only after the persist, a persist failure would leave the
    // expiry in the past and every subsequent request would re-refresh — a
    // refresh-storm that burns single-use rotations. Setting them now guarantees
    // the next gate sees a future expiry even when persistence fails.
    _currentTtlMs = (parsed.expires_in || _DEFAULT_EXPIRES_IN) * 1000;
    _currentExpiresAtMs = Date.now() + _currentTtlMs;
    _currentMintedAtMono = process.hrtime.bigint();
    _mintedMonoValid = true;
    _refreshGeneration++;   // D8: this successful rotation is a new generation
    _refreshDead = false;   // a successful refresh clears any stale dead flag
    log('[xAI] OAuth token refreshed', 'INFO');
    // D9: persist availability-first — a persist failure sets _persistPending and
    // keeps the valid in-memory token; it does NOT throw the turn away (resolving
    // the old proactive-swallows-vs-reactive-fatal inconsistency).
    await _persistRotatedTokens(parsed);
    return true;
}

// HTTPS POST to the hardcoded token endpoint. Resolves the parsed JSON on a
// rotated token; rejects (non-retryable) on invalid_grant / non-JSON / HTTP
// error — the caller (handleUnauthorized) turns that into a re-login.
function _requestRotatedTokens() {
    const https = require('https');
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: OAUTH_CLIENT_ID,
        refresh_token: _currentRefreshToken,
    }).toString();

    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: OAUTH_HOSTNAME,
            path: OAUTH_TOKEN_PATH,
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
                // H4: our own UA on the refresh POST too (Cloudflare gates
                // curl/empty UAs on auth.x.ai).
                'User-Agent': SEEKERCLAW_UA,
            },
            timeout: 15000,
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const status = res.statusCode || 0;
                let parsed = null;
                try { parsed = JSON.parse(data); } catch (_) { /* non-JSON body */ }

                if (parsed && parsed.access_token) {
                    resolve(parsed);
                    return;
                }
                if (parsed) {
                    // JSON error — surface error_description/error. `invalid_grant`
                    // means the refresh token is dead (revoked / already rotated)
                    // → re-login required. Never include the request body.
                    const err = new Error(`Token refresh failed (HTTP ${status}): ${parsed.error_description || parsed.error || 'unknown'}`);
                    if (parsed.error === 'invalid_grant') err.reLogin = true;
                    reject(err);
                } else {
                    const truncated = (data || '').slice(0, 200).replace(/\s+/g, ' ');
                    reject(new Error(`Token refresh failed (HTTP ${status}): non-JSON response: ${truncated}`));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Refresh timeout')); });
        req.write(body);
        req.end();
    });
}

// BAT-1143 D9: persist the rotated pair via the Android bridge, AVAILABILITY-FIRST.
// The bridge ALWAYS resolves (never rejects) — `{ error }` on failure, `{ success:
// true }` on a persisted write. Unlike the old H2 (which threw a hard error and
// killed the turn), a persist failure now:
//   • keeps the valid in-memory rotated pair (the turn still succeeds);
//   • records the SAME pair as pending so later ensureFreshToken() calls re-persist
//     it (never a second rotation — the pending pair is reused verbatim);
//   • after MAX_PERSIST_CONVERGENCE_ATTEMPTS surfaces a durable error (re-pair may
//     be needed after a restart), but never silently reports "healthy".
async function _persistRotatedTokens(parsed) {
    _pendingPersistPayload = {
        accessToken: parsed.access_token,
        refreshToken: parsed.refresh_token || _currentRefreshToken,
        // Use the same absolute expiry we advanced in _performRefresh (D3), so the
        // persisted expiry matches the in-memory one exactly.
        expiresAt: new Date(_currentExpiresAtMs).toISOString(),
    };
    _persistPending = true;
    await _attemptPersist();
}

// One bounded persist attempt of the current _pendingPersistPayload. Clears the
// pending/durable flags on success; escalates to a durable error once convergence
// is exhausted. Never throws — the caller (refresh or ensureFreshToken) proceeds
// on the valid in-memory token regardless.
async function _attemptPersist() {
    if (!_pendingPersistPayload) { _persistPending = false; return; }
    const result = await androidBridgeCall('/xai/oauth/save-tokens', _pendingPersistPayload);
    if (result && result.success === true && !result.error) {
        _persistPending = false;
        _pendingPersistPayload = null;
        _persistAttempts = 0;
        _persistDurableError = false;
        return;
    }
    const lastErr = (result && result.error) ? String(result.error) : 'no success acknowledgement';
    _persistPending = true;
    _persistAttempts++;
    log(`[xAI] OAuth token persist attempt ${_persistAttempts} failed: ${lastErr}`, 'WARN');
    if (_persistAttempts >= MAX_PERSIST_CONVERGENCE_ATTEMPTS && !_persistDurableError) {
        _persistDurableError = true;
        log('[xAI] OAuth token rotated but could NOT be persisted after '
            + `${_persistAttempts} attempts — re-login may be required after a restart`, 'ERROR');
    }
}

/**
 * Handle a 401 by refreshing the token and signalling a retry. Mirrors
 * openai.js: throws { retryable:true } after a successful refresh (caller
 * retries with the new token), or a fatal { retryable:false } if refresh
 * failed so the caller stops retrying with a dead token.
 */
async function handleUnauthorized() {
    if (!(isOAuth && _currentRefreshToken)) return;
    log('[xAI] OAuth 401 — attempting token refresh...', 'INFO');
    try {
        await refreshOAuthToken();
        log('[xAI] Token refreshed — caller should retry', 'INFO');
        const retryError = new Error('OAuth token refreshed — retry');
        retryError.retryable = true;
        throw retryError;
    } catch (e) {
        if (e.retryable) throw e;
        log('[xAI] OAuth refresh failed: ' + e.message, 'ERROR');
        const fatal = new Error('OAuth token refresh failed: ' + e.message);
        fatal.retryable = false;
        throw fatal;
    }
}

// ── BAT-1143: proactive freshness + circuit-breaker hooks (ai.js drives these) ─

// D1/D5/D6/D9: called by ai.js (centralized in claudeApiCall, before buildHeaders)
// prior to EVERY OAuth request. No-op for api_key. Ordering is load-bearing:
//   1. D9 — if a rotation is unpersisted, re-persist the SAME pair first and return;
//      NEVER refresh while pending (that would rotate again and orphan the pending pair).
//   2. suppressed once the refresh token is dead (invalid_grant) or the account is
//      tier-gated (breaker) — until a re-pair/success clears them.
//   3. refresh if at/near expiry (absolute OR monotonic-age, D2/D3a), or exactly
//      once when the expiry is unknown (D5).
async function ensureFreshToken() {
    if (!isOAuth) return;
    if (_persistPending) { await _attemptPersist(); return; }
    if (_refreshDead || _tierGated) return;
    if (!_currentRefreshToken) return;

    let doRefresh = false;
    if (_currentExpiresAtMs === 0) {
        // D5 expiry-unknown: one opportunistic refresh on first use, at most once
        // (guarded so a transient failure can't storm the endpoint).
        if (!_opportunisticRefreshDone) { _opportunisticRefreshDone = true; doRefresh = true; }
    } else if (_isTokenExpiredish()) {
        doRefresh = true;
    }
    if (!doRefresh) return;

    try {
        await refreshOAuthToken();
    } catch (e) {
        // invalid_grant → the refresh token is dead: suppress further attempts and
        // let the session-expiry path surface re-pair. Other (transient) failures
        // are swallowed — proactive is best-effort; the reactive 403 backstop and
        // the next turn's gate retry.
        if (e && e.reLogin) _refreshDead = true;
        log('[xAI] proactive refresh failed: ' + (e && e.message ? e.message : String(e)), 'WARN');
    }
}

// D8: ai.js calls this when an inference call STILL 403s on the fresh token in the
// SAME retry chain immediately after a successful refresh — a genuine tier-gate,
// not an expiry. Trips the breaker so we stop rotating a gated account every ~6h.
function markTierGated() { _tierGated = true; }

// D8: ai.js calls this on any successful (200) inference — the account CAN reach
// the model, so clear the breaker (the "recovered" signal).
function noteInferenceSuccess() { _tierGated = false; }

// Re-pair / re-login clears ALL breaker + dead-token + pending state (D8/D9) so a
// fresh sign-in starts clean.
function repairReset() {
    _tierGated = false;
    _refreshDead = false;
    _persistPending = false;
    _pendingPersistPayload = null;
    _persistAttempts = 0;
    _persistDurableError = false;
    _opportunisticRefreshDone = false;
}

// D8: ai.js tags each request with the generation it was built under, so a
// post-refresh 403 can be told apart from an unrelated fresh-token 403.
function currentRefreshGeneration() { return _refreshGeneration; }

// D9: a rotated pair still at persistence risk — ai.js reflects this as degraded
// health (never "healthy" while the pair is memory-only) and surfaces the durable
// error once convergence is exhausted.
function isPersistPending() { return _persistPending; }
function hasPersistDurableError() { return _persistDurableError; }

// ── Connection test ─────────────────────────────────────────────────────────
// NOTE (contract M5): the Kotlin-side connection test must use a 1-token
// POST /v1/chat/completions ping — GET /v1/models 403s on first OAuth login
// (lazy provisioning) and would falsely report a signed-in user as "not
// connected". This structural export exists for adapter parity; the Node
// path does not invoke it.
const testEndpoint = { protocol: endpoint.protocol, hostname: endpoint.hostname, port: endpoint.port, path: '/v1/chat/completions', method: 'POST' };

// ── Export adapter ──────────────────────────────────────────────────────────

module.exports = {
    id: 'xai',
    name: 'xAI Grok',

    // Connection
    endpoint,
    testEndpoint,
    buildHeaders,
    streamProtocol,

    // Message translation — delegated to the openrouter Chat Completions
    // shaping (identical to how custom.js reuses it). Reasoning ECHO (the
    // reasoning_content round-trip) is inert for Grok, but reasoning CONTROL is
    // NOT: formatRequest() sends `reasoning_effort` (see there) — required to
    // bound grok-4.5's otherwise-unbounded reasoning (BAT-1124).
    toApiMessages: openrouter.toApiMessages,
    fromApiResponse: openrouter.fromApiResponse,
    formatSystemPrompt: openrouter.formatSystemPrompt,
    formatTools: openrouter.formatTools,
    formatRequest,
    formatVision: openrouter.formatVision,

    // Error & usage
    classifyError,
    classifyNetworkError,
    handleUnauthorized,
    normalizeUsage: openrouter.normalizeUsage,
    parseRateLimitHeaders: openrouter.parseRateLimitHeaders,

    // OAuth
    refreshOAuthToken,
    isOAuth,
    OAUTH_CLIENT_ID,

    // BAT-1143: proactive-refresh state machine + circuit-breaker hooks (ai.js drives these)
    ensureFreshToken,
    markTierGated,
    noteInferenceSuccess,
    repairReset,
    currentRefreshGeneration,
    isPersistPending,
    hasPersistDurableError,

    // Capabilities
    supportsCache: false,
    authTypes: ['api_key', 'oauth'],

    // Test seam (not used by production code paths)
    _resetErrorStateForTests,
    _setStateForTests,
    _getStateForTests,
};
