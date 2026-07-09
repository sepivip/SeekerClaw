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

// H4: SeekerClaw's OWN User-Agent (never Grok-CLI's). Version from the
// AGENT_VERSION env var Kotlin injects (message-handler.js reads the same),
// else a stable "SeekerClaw" — Cloudflare only needs a non-empty, non-curl UA.
const _AGENT_VER = (typeof process.env.AGENT_VERSION === 'string' && process.env.AGENT_VERSION.trim())
    ? process.env.AGENT_VERSION.trim()
    : '';
const SEEKERCLAW_UA = _AGENT_VER ? `SeekerClaw/${_AGENT_VER}` : 'SeekerClaw';

const isOAuth = AUTH_TYPE === 'oauth';

// ── Connection details ──────────────────────────────────────────────────────

// Same host + endpoint for api_key AND oauth. XAI_BASE_URL overrides the host
// for device tests / self-hosted gateways; the path stays chat/completions.
function _resolveXaiHost() {
    const raw = (typeof process.env.XAI_BASE_URL === 'string' ? process.env.XAI_BASE_URL : '').trim();
    if (!raw) return 'api.x.ai';
    try {
        const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
        return u.hostname || 'api.x.ai';
    } catch (_) {
        return 'api.x.ai';
    }
}

const endpoint = { hostname: _resolveXaiHost(), path: '/v1/chat/completions' };

// Live in-memory token pair. Seeded from config; rotated by refreshOAuthToken.
let _currentOAuthToken = XAI_OAUTH_TOKEN;
let _currentRefreshToken = XAI_OAUTH_REFRESH;

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
// branch. Deliberately NO cache_control / models-fallback (openrouter.js)
// and NO store:false / reasoning shaping (openai.js Codex). xAI ignores
// unknown fields, but we keep the body minimal to avoid surprise 400s.
function formatRequest(model, maxTokens, systemPrompt, messages, tools) {
    const body = {
        model,
        stream: true,
        max_tokens: maxTokens,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
    };
    if (tools && tools.length > 0) body.tools = tools;
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
}

function classifyError(status, data) {
    if (status === 401) {
        // The ONLY branch that may be type:'auth' → ai.js calls
        // handleUnauthorized() → single-flight refresh. Gated on OAuth mode
        // AND a refresh token actually being present; otherwise there is
        // nothing to refresh, so it's a non-retryable credential error.
        const canRefresh = isOAuth && !!_currentRefreshToken;
        return {
            type: canRefresh ? 'auth' : 'unknown',
            retryable: canRefresh,
            userMessage: isOAuth
                ? '🔐 Can\'t reach Grok — your xAI sign-in may have expired. Reconnect xAI in Settings and try again.'
                : '🔑 Can\'t reach Grok — your xAI API key might be wrong. Check Settings?'
        };
    }
    if (status === 403) {
        // ⚠️ C1: NEVER type:'auth'. A 403 is provisioning/tier-gate, not an
        // expired token — firing a refresh here would consume xAI's single-use
        // refresh rotation.
        //
        // The retry-once grace is OAuth-ONLY: xAI provisions API access lazily
        // on the first OAuth touch, so a freshly-signed-in user's first 403 is
        // likely still-provisioning and earns ONE grace retry. An api_key 403 is
        // a real tier/credit gate — terminal on the first hit, with no retry and
        // no misleading "provisioning" copy.
        if (isOAuth && !_oauth403RetriedOnce) {
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
    log('[xAI] OAuth token refreshed', 'INFO');
    // H2: AWAIT the persist and treat failure as a HARD error.
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

// H2: persist the rotated pair via the Android bridge with a bounded retry.
// The bridge ALWAYS resolves (never rejects) — resolving `{ error }` on
// failure and `{ success: true }` on a persisted write (mirrors the OpenAI
// handler). A persist failure is a HARD error: we must NOT report the refresh
// as succeeded when the server has rotated but disk hasn't — that would lock
// the account out on the next restart with a stale refresh token.
async function _persistRotatedTokens(parsed) {
    const payload = {
        accessToken: parsed.access_token,
        refreshToken: parsed.refresh_token || _currentRefreshToken,
        expiresAt: new Date(Date.now() + (parsed.expires_in || _DEFAULT_EXPIRES_IN) * 1000).toISOString(),
    };
    const PERSIST_ATTEMPTS = 2;
    let lastErr = '';
    for (let attempt = 1; attempt <= PERSIST_ATTEMPTS; attempt++) {
        const result = await androidBridgeCall('/xai/oauth/save-tokens', payload);
        if (result && result.success === true && !result.error) {
            return; // persisted
        }
        lastErr = (result && result.error) ? String(result.error) : 'no success acknowledgement';
        // A bridge-level failure (incl. a bridge 429 — distinct from an
        // api.x.ai 429) is retried once, then surfaced.
        log(`[xAI] OAuth token persist attempt ${attempt}/${PERSIST_ATTEMPTS} failed: ${lastErr}`, 'WARN');
    }
    // All attempts failed. Keep the in-memory rotated token so THIS session
    // keeps working, but fail loud so the turn surfaces the problem and the
    // user is warned a re-login may be needed after a restart.
    log('[xAI] OAuth token rotated but could NOT be persisted — re-login may be required after restart', 'ERROR');
    const fatal = new Error('xAI OAuth token persist failed: ' + lastErr);
    fatal.persistFailed = true;
    throw fatal;
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

// ── Connection test ─────────────────────────────────────────────────────────
// NOTE (contract M5): the Kotlin-side connection test must use a 1-token
// POST /v1/chat/completions ping — GET /v1/models 403s on first OAuth login
// (lazy provisioning) and would falsely report a signed-in user as "not
// connected". This structural export exists for adapter parity; the Node
// path does not invoke it.
const testEndpoint = { hostname: endpoint.hostname, path: '/v1/chat/completions', method: 'POST' };

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
    // shaping (identical to how custom.js reuses it). Reasoning round-trip is
    // inert for Grok (captured but not echoed — Grok isn't a DeepSeek-gated
    // model), so no reasoning fields reach api.x.ai.
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

    // Capabilities
    supportsCache: false,
    authTypes: ['api_key', 'oauth'],

    // Test seam (not used by production code paths)
    _resetErrorStateForTests,
};
