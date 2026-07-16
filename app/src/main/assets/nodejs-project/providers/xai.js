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
    // BAT-1155: xAI OAuth durability — store-sourced control fields.
    XAI_OAUTH_EPOCH,
    XAI_OAUTH_REAUTH_REQUIRED,
    XAI_OAUTH_REAUTH_NOTIFIED_EPOCH,
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
// BAT-1143 D9/Q4: after a refresh TRANSPORT failure (not invalid_grant), suppress a
// second refresh POST for this long — long enough to outlast the reactive retry loop
// (a few seconds of backoff) so we never consume a SECOND single-use rotation in the
// same turn, short enough that the next real turn/heartbeat can retry.
const REFRESH_FAIL_COOLDOWN_MS = 60 * 1000;

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
// BAT-1155 D4 REAUTH BOOT GATE: seed _refreshDead from the persisted store flag so a
// dead family (revoked refresh token) skips ALL refresh on boot — before the fix, boot
// re-seeded false and re-ran the doomed refresh cycle (the live incident's re-notify loop).
// isOAuth-gated: an xAI api_key user never writes the store, so read() returns the
// FAIL_CLOSED default (reauthRequired=true); without the isOAuth guard that would seed
// _refreshDead=true for an api_key family and make ai.js miscount a genuine tier-gate 403
// toward re-pair (BAT-1155 verify major-1).
let _refreshDead = isOAuth && XAI_OAUTH_REAUTH_REQUIRED === true; // invalid_grant / persisted reauth → suppress ALL refresh until re-pair (D9)
// BAT-1155 D1: the store revision this process last saw. Sent as expectedEpoch on every
// rotation persist (CAS); advanced by adopting the bridge response epoch. Seeded from config.
let _currentEpoch = XAI_OAUTH_EPOCH;
// BAT-1155 D4 notify-once: the epoch for which the single autonomous reconnect notice
// already fired (-1 = none). Reset to -1 by a sign-in/rotate (store side); while it is
// non-(-1) the autonomous notice is suppressed, yet explicit user requests still answer.
let _reauthNotifiedEpoch = XAI_OAUTH_REAUTH_NOTIFIED_EPOCH;
// D9: a rotation that succeeded server-side but failed to persist. Keep the pair
// in memory, complete the turn, and re-persist the SAME pair on later calls.
let _persistPending = false;
let _pendingPersistPayload = null;
let _persistAttempts = 0;
let _persistDurableError = false; // convergence exhausted → surface re-pair (D9 step 4)
// D5: one opportunistic refresh when expiry is unknown, at most once.
let _opportunisticRefreshDone = false;
// D9/Q4: monotonic timestamp of the last refresh TRANSPORT failure — gates a
// same-turn re-POST (0n = no active cooldown).
let _lastRefreshFailMono = 0n;

// D3a: ms elapsed since the last IN-PROCESS mint, from the monotonic clock.
// Only meaningful when _mintedMonoValid — callers must gate on that.
function _elapsedMonoMs() {
    return Number(process.hrtime.bigint() - _currentMintedAtMono) / 1e6;
}

// D9/Q4: true while inside the post-transport-failure cooldown — blocks a second
// refresh POST in the same turn (monotonic, immune to wall-clock jumps).
function _refreshCoolingDown() {
    if (_lastRefreshFailMono === 0n) return false;
    return (Number(process.hrtime.bigint() - _lastRefreshFailMono) / 1e6) < REFRESH_FAIL_COOLDOWN_MS;
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
// BAT-1124 reasoning fix (proven live in tests/live/xai `--diagnose`): xAI
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
    _markReauthPending = false;
    _noteNotifiedPending = false;
    _noteNotifiedPendingEpoch = -1;
    _opportunisticRefreshDone = false;
    _lastRefreshFailMono = 0n;
    _refreshInFlight = null;
    // BAT-1155: reset the durability/notify state so a test starts from a known epoch.
    _currentEpoch = XAI_OAUTH_EPOCH;
    _reauthNotifiedEpoch = XAI_OAUTH_REAUTH_NOTIFIED_EPOCH;
    _persistInFlight = null;
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
    if ('persistDurableError' in patch) _persistDurableError = patch.persistDurableError;
    if ('persistAttempts' in patch) _persistAttempts = patch.persistAttempts;
    if ('markReauthPending' in patch) _markReauthPending = patch.markReauthPending;
    if ('noteNotifiedPending' in patch) _noteNotifiedPending = patch.noteNotifiedPending;
    if ('pendingPersistPayload' in patch) _pendingPersistPayload = patch.pendingPersistPayload;
    if ('oauth403RetriedOnce' in patch) _oauth403RetriedOnce = patch.oauth403RetriedOnce;
    if ('opportunisticRefreshDone' in patch) _opportunisticRefreshDone = patch.opportunisticRefreshDone;
    if ('lastRefreshFailMono' in patch) _lastRefreshFailMono = patch.lastRefreshFailMono;
    // BAT-1155 durability/notify state.
    if ('currentEpoch' in patch) _currentEpoch = patch.currentEpoch;
    if ('reauthNotifiedEpoch' in patch) _reauthNotifiedEpoch = patch.reauthNotifiedEpoch;
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
        markReauthPending: _markReauthPending,
        noteNotifiedPending: _noteNotifiedPending,
        diskUnsafe: isDiskUnsafe(),
        opportunisticRefreshDone: _opportunisticRefreshDone,
        currentEpoch: _currentEpoch,
        reauthNotifiedEpoch: _reauthNotifiedEpoch,
    };
}

function classifyError(status, data) {
    if (status === 401) {
        // BAT-1155 D3: a dead OAuth family (revoked / persisted reauth) never attempts a
        // refresh — with tombstoned tokens the bearer is empty and xAI can 401 (not 403);
        // classify as reauth so the reconnect copy surfaces (not the stale api-key hint).
        if (isOAuth && _refreshDead) {
            _maybeRetryReauthMark(); // Codex blocker-2: retry a failed dead-mark each dead turn
            return {
                type: 'reauth', retryable: false,
                userMessage: 'Your Grok sign-in was revoked — reconnect xAI in Settings.'
            };
        }
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
        // BAT-1155 D7: gate the grace-retry on !_refreshDead. Without it, the FIRST
        // dead-token 403 on a boot burns the one-shot grace (returns provisioning/retry)
        // and only the SECOND 403 reaches the reauth return below — re-showing the wrong
        // copy once per boot in the exact incident scenario. D3 + D7 are interdependent.
        if (isOAuth && !_oauth403RetriedOnce && !_tierGated && !_refreshDead) {
            _oauth403RetriedOnce = true;
            return {
                type: 'provisioning', retryable: true,
                userMessage: 'Grok API access is provisioning — retrying once...'
            };
        }
        // BAT-1155 D3: before the terminal tier-gate copy, a dead OAuth family is a
        // revoked sign-in — surface reconnect, never "add an xAI API key". Keep the
        // tier-gate copy ONLY for a genuine fresh-token tier-gate (_refreshDead === false).
        if (isOAuth && _refreshDead) {
            _maybeRetryReauthMark(); // Codex blocker-2: retry a failed dead-mark each dead turn
            return {
                type: 'reauth', retryable: false,
                userMessage: 'Your Grok sign-in was revoked — reconnect xAI in Settings.'
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
    // BAT-1155 Codex re-review blocker: refuse to ROTATE while the process is quiesced for a
    // controlled Stop. A rotation here would consume the on-disk T0 and mint a T1 that the
    // imminent kill strands → the next boot replays the consumed T0 (the brick). Any in-flight
    // rotation is still awaited/drained by flushPendingPersist; this only blocks NEW ones.
    if (require('../quiesce').isQuiesced()) {
        // Return the in-flight rotation if one is already draining; otherwise a resolved no-op
        // (the caller proceeds on the current in-memory token — the turn is being torn down anyway).
        return _refreshInFlight || Promise.resolve(null);
    }
    _refreshInFlight ??= _performRefresh()
        .catch(async (e) => {
            // BAT-1143: record the failure mode CENTRALLY so BOTH the proactive
            // (ensureFreshToken) and reactive (handleUnauthorized) paths agree:
            //  - invalid_grant → the refresh token is dead → suppress ALL further
            //    refresh until re-pair (Copilot: handleUnauthorized used to miss this,
            //    so a dead token got re-POSTed on every reactive 401/403).
            //  - any OTHER failure (transport/timeout/5xx) → start a same-turn cooldown
            //    so a second caller can't immediately re-POST and consume a SECOND
            //    single-use rotation (D9/Q4 lost-refresh-response protection).
            if (e && e.reLogin) {
                _refreshDead = true;
                // BAT-1155 D5: durably persist the dead flag (token-less) so a restart's
                // boot gate re-derives _refreshDead=true instead of re-running the doomed
                // cycle. Awaited so the marker lands before the rejection propagates.
                await _persistReauthRequired();
            } else {
                _lastRefreshFailMono = process.hrtime.bigint();
            }
            throw e;
        })
        .finally(() => { _refreshInFlight = null; });
    return _refreshInFlight;
}

// BAT-1155 stop-fence protocol — the single atomic pre-POST gate. Arms the durable rotation marker
// under the store sidecar lock (via the AndroidBridge) and reports whether the external refresh POST
// may proceed. Returns:
//   'ok'   → the marker is armed on disk; the POST may proceed.
//   'dead' → the family is tombstone/reauth OR a rotation marker is ALREADY armed (a prior POST may
//            have consumed the on-disk refresh token) → the caller surfaces reconnect, never POSTs.
//   'skip' → a stop is fencing this epoch, the epoch was superseded (a fresh sign-in/out), or the
//            marker could not be armed (bridge/disk) → keep the in-memory token, do NOT POST.
async function _prepareRefreshGate() {
    let r;
    try {
        r = await androidBridgeCall('/xai/oauth/prepare-refresh', { expectedEpoch: _currentEpoch });
    } catch (_) {
        // androidBridgeCall normally RESOLVES {error} (it never rejects), so this is defensive: a
        // throw is treated identically to an ambiguous {error}/absent response below.
        r = null;
    }
    if (r && r.success === true) {
        if (typeof r.epoch === 'number') _currentEpoch = r.epoch;
        return 'ok';
    }
    // RECOGNIZED durable-store outcomes — the store state they reflect is authoritative and must be
    // preserved verbatim (never clear the marker on these):
    if (r) {
        // A superseding sign-in/out advanced the epoch. DO NOT adopt r.currentEpoch (Codex break-fix) —
        // the sign-in-triggered :node restart reloads the fresh family; abort this refresh.
        if (r.code === 'XAI_OAUTH_EPOCH_CONFLICT') return 'skip';
        if (r.dead === true || r.unsafe === true) return 'dead';
        if (r.fenced === true) return 'skip';
    }
    // AMBIGUOUS: an absent response, a bridge {error} shape (timeout/5xx), or an unrecognized body.
    // The arm's fate on disk is unknown, but this call definitively did NOT POST — so if the arm DID
    // land (a lost prepare-refresh RESPONSE, not a lost request), best-effort clear the marker
    // (epoch-CAS'd; no-op if the epoch moved, best-effort if the bridge is still down) so it can't
    // orphan into a false Unsafe→reauth on the next refresh. Then fail-closed (no POST).
    await _clearRotationInFlightMarker();
    return 'skip';
}

// Provably-not-sent classification (Codex decision 1): only a pre-connection DNS / connection-refused
// error proves the refresh-token bytes never reached the endpoint. A timeout or ANY received HTTP
// response (including 5xx / TLS-after-connect) is NOT provable → the marker must be retained.
function _isProvablyNotSent(e) {
    return !!(e && (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN'));
}

// Clear the durable rotation marker after a provably-not-sent refresh (avoids a nuisance reconnect).
// Best-effort: a retained marker only costs one conservative reconnect, never a brick.
async function _clearRotationInFlightMarker() {
    try {
        await androidBridgeCall('/xai/oauth/clear-rotation-in-flight', { expectedEpoch: _currentEpoch });
    } catch (_) { /* best-effort */ }
}

// A dead-family mark that did NOT durably persist. Codex blocker-2: a failed
// mark must stay retryable (not swallowed) — else a restart re-seeds
// _refreshDead=false and re-POSTs the revoked token. Retried on each subsequent
// dead-path turn (classifyError) until it lands.
let _markReauthPending = false;

// Codex re-review major-2: the notify-once latch mark that did NOT durably persist.
// Without a retry the in-memory latch is lost on restart and the same dead epoch is
// re-notified (violating "exactly one autonomous notice per dead epoch"). Retained +
// retried, CAS'd to the epoch it was recorded for; a conflict drops it, a success clears it.
let _noteNotifiedPending = false;
let _noteNotifiedPendingEpoch = -1;

// BAT-1155 D4/D5: token-less durable mark of "this family is dead". POSTs
// /xai/oauth/mark-reauth (SEPARATE rate bucket) CAS'd on expectedEpoch (blocker-2).
async function _persistReauthRequired() {
    try {
        const result = await androidBridgeCall('/xai/oauth/mark-reauth', { expectedEpoch: _currentEpoch });
        if (result && result.code === 'XAI_OAUTH_EPOCH_CONFLICT') {
            // A fresh sign-in/out advanced the epoch — the OLD family's dead-mark is moot
            // and must NOT land on the winning family. Adopt the new revision, drop the
            // pending mark; the sign-in-triggered :node restart reloads the fresh family.
            if (typeof result.currentEpoch === 'number') _currentEpoch = result.currentEpoch;
            _markReauthPending = false;
            return;
        }
        if (result && result.success === true) {
            if (typeof result.epoch === 'number') _currentEpoch = result.epoch;
            _markReauthPending = false;
            return;
        }
        _markReauthPending = true; // Failed → keep retryable (not swallowed)
    } catch (_) {
        _markReauthPending = true;
    }
}

// Fire-and-forget retry of a dead-mark that didn't persist (Codex blocker-2). Called
// from the reauth classify path so a transient bridge/lock failure self-heals within
// the process instead of waiting for a restart to re-derive dead state.
function _maybeRetryReauthMark() {
    if (_refreshDead && _markReauthPending) {
        _persistReauthRequired().catch(() => {});
    }
}

async function _performRefresh() {
    // BAT-1155 stop-fence: durably ARM the rotation marker (atomically checking dead / stop-fence /
    // already-armed) BEFORE presenting the on-disk refresh token to xAI. Every non-'ok' outcome = NO POST.
    const gate = await _prepareRefreshGate();
    if (gate === 'skip') return null; // fenced / superseded / prepare-deferred → keep the in-mem token, no POST
    if (gate === 'dead') {            // dead family OR a rotation POST is already in flight (potentially consumed)
        const e = new Error('xAI OAuth refresh blocked — reconnect required');
        e.reLogin = true;             // → refreshOAuthToken.catch latches _refreshDead + persists reauth
        throw e;
    }
    // gate === 'ok': the rotation marker is durably armed on disk BEFORE the POST below.
    let parsed;
    try {
        parsed = await _requestRotatedTokens();
    } catch (e) {
        // Marker discipline (Codex decision 1 — conservative): clear the marker ONLY when the transport
        // proves no request bytes reached xAI (DNS / connection-refused before the body was written).
        // Timeout / any received response / 5xx retain the marker (the on-disk token may be consumed).
        if (_isProvablyNotSent(e)) await _clearRotationInFlightMarker();
        throw e;
    }
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
    _lastRefreshFailMono = 0n; // and clears any transport-failure cooldown
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
                    // BAT-1155 D5: redacted one-line log of the exact revoke code so
                    // xAI's wording becomes deterministic. parsed.error is an OAuth error
                    // CODE (e.g. "invalid_grant"), never token material — safe to log.
                    log(`[xAI] OAuth refresh failed: error=${JSON.stringify(parsed.error || 'unknown')} (HTTP ${status})`, 'WARN');
                    // JSON error — surface error_description/error. `invalid_grant`
                    // means the refresh token is dead (revoked / already rotated)
                    // → re-login required. Never include the request body.
                    const err = new Error(`Token refresh failed (HTTP ${status}): ${parsed.error_description || parsed.error || 'unknown'}`);
                    // BAT-1155 D5: latch dead-token NARROWLY — invalid_grant (primary) OR a
                    // SPECIFIC description match on an HTTP 400 from the refresh endpoint.
                    // NEVER the bare `refresh_token` substring: it appears in benign transient
                    // 400s ("refresh_token parameter is required"), and a false latch would
                    // persist reauthRequired and permanently brick a working account (D4 then
                    // suppresses the refresh that would self-clear it).
                    const desc = typeof parsed.error_description === 'string' ? parsed.error_description : '';
                    if (parsed.error === 'invalid_grant'
                        || (status === 400 && /revoked|already been used|token expired/i.test(desc))) {
                        err.reLogin = true;
                    }
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

// BAT-1155 D6: single-flight guard so a concurrent flush (flushPendingPersist on
// USER_STOP) cannot double-POST the SAME payload — a second POST of a pair already
// persisted would land as a FALSE CAS conflict under D1. Memoize the in-flight attempt.
let _persistInFlight = null;

// One bounded persist attempt of the current _pendingPersistPayload. Clears the
// pending/durable flags on success; escalates to a durable error once convergence
// is exhausted. Never throws — the caller (refresh or ensureFreshToken) proceeds
// on the valid in-memory token regardless. `timeoutMs` (optional) is passed through
// to androidBridgeCall — the USER_STOP drain passes 300 (bridge default is 10000).
function _attemptPersist(timeoutMs, urgent) {
    // D6 single-flight: coalesce concurrent callers onto one in-flight POST.
    if (_persistInFlight) return _persistInFlight;
    _persistInFlight = _doAttemptPersist(timeoutMs, urgent).finally(() => { _persistInFlight = null; });
    return _persistInFlight;
}

async function _doAttemptPersist(timeoutMs, urgent) {
    if (!_pendingPersistPayload) { _persistPending = false; return; }
    // BAT-1155 D1: carry expectedEpoch (the revision this process last saw) so the
    // Kotlin store can CAS-reject a stale rotation that lost a race to a MAIN sign-in/out.
    const payload = { ..._pendingPersistPayload, expectedEpoch: _currentEpoch };
    // BAT-1155 blocker-1: the USER_STOP drain routes to the dedicated urgent endpoint
    // (own generous rate bucket) so the once-per-shutdown persist of a VALID rotated pair
    // is never throttled by the normal 5/60s save-tokens limit and forced into a re-pair.
    const endpoint = urgent ? '/xai/oauth/save-tokens-urgent' : '/xai/oauth/save-tokens';
    const result = (typeof timeoutMs === 'number')
        ? await androidBridgeCall(endpoint, payload, timeoutMs)
        : await androidBridgeCall(endpoint, payload);
    if (result && result.success === true && !result.error) {
        _persistPending = false;
        _pendingPersistPayload = null;
        _persistAttempts = 0;
        _persistDurableError = false;
        // Adopt the new on-disk revision so the NEXT rotation's expectedEpoch matches.
        if (typeof result.epoch === 'number') _currentEpoch = result.epoch;
        return;
    }
    // BAT-1155 D1 CAS conflict: a MAIN sign-in/out landed first, advancing the epoch.
    // The winning family is already on disk and the sign-in that caused the conflict
    // triggers a :node restart that reloads it — so DISCARD this stale pending pair and
    // NEVER re-POST it (re-POSTing is exactly what would reuse a consumed refresh token).
    if (result && result.code === 'XAI_OAUTH_EPOCH_CONFLICT') {
        log('[xAI] OAuth token persist rejected (epoch conflict) — discarding stale pending pair; a restart will load the winning family', 'WARN');
        _pendingPersistPayload = null;
        _persistPending = false;
        _persistAttempts = 0;
        _persistDurableError = false;
        if (typeof result.currentEpoch === 'number') _currentEpoch = result.currentEpoch;
        return;
    }
    const lastErr = (result && result.error) ? String(result.error) : 'no success acknowledgement';
    _persistPending = true;
    // A bridge RATE-LIMIT (429: "Rate limit exceeded for /xai/oauth/save-tokens") is
    // transient throttling, NOT a convergence failure — do NOT count it toward the
    // durable-error budget (else a burst of turns falsely exhausts it and surfaces the
    // "re-login may be required" error even though the write was merely throttled). Keep
    // pending and retry next turn; the per-turn/heartbeat cadence outlasts the 5/60s limit.
    if (/rate.?limit/i.test(lastErr)) {
        log('[xAI] OAuth token persist throttled by the bridge (rate limit) — retry next turn', 'WARN');
        return;
    }
    _persistAttempts++;
    log(`[xAI] OAuth token persist attempt ${_persistAttempts} failed: ${lastErr}`, 'WARN');
    if (_persistAttempts >= MAX_PERSIST_CONVERGENCE_ATTEMPTS) {
        // Convergence exhausted (D9 step 4). STOP hammering the bridge AND stop blocking proactive
        // refresh: surface a durable error (health stays 'degraded' via hasPersistDurableError) and
        // CLEAR _persistPending so ensureFreshToken resumes. The VALID rotated pair stays in memory
        // and serves requests until it expires.
        //
        // BAT-1155 conservative fail-close: the stop-fence rotation marker (rotationInFlightEpoch==E)
        // stays ARMED on disk because the successor pair never landed there. That is fail-CLOSED and
        // correct — the on-disk T0 IS consumed. At the next expiry, prepareRefresh(E) therefore
        // returns Unsafe → an explicit, RECOVERABLE reconnect (markReauth supersedes the marker; a
        // fresh sign-in mints a new family). It is NOT a family brick (the revoke class BAT-1155
        // prevents), just a rare re-pair (precondition: MAX consecutive durable bridge-write failures
        // AFTER a successful rotation POST, then survival to expiry).
        //
        // NOTE: because the armed marker blocks a fresh rotation, the family can no longer self-heal
        // via a "future rotation" — a retain-and-re-converge variant (keep _pendingPersistPayload and
        // re-persist at a bounded cadence until the bridge recovers, so the pair lands and the marker
        // clears) would avoid the re-pair, but it changes the Codex-signed convergence contract and is
        // deferred to the Codex diff re-review (BAT-1155 M2 in the PR notes), not folded here.
        _persistDurableError = true;
        _persistPending = false;
        _pendingPersistPayload = null;
        log('[xAI] OAuth token persist convergence exhausted after '
            + `${_persistAttempts} attempts — in-memory token valid until expiry, then a reconnect is required`, 'ERROR');
    }
}

// BAT-1155 D6: USER_STOP drain. Called by internal-control-server.js /shutdown/flush
// BEFORE the session-summary flush so a just-rotated pair reaches disk before the kill
// (else the next boot reloads a consumed token). Bounded: await any in-flight attempt
// first (never double-POST), then AT MOST ONE forced retry if still pending, with an
// explicit 300ms bound passed to androidBridgeCall. Never throws.
async function flushPendingPersist() {
    if (!isOAuth) return { pendingPersist: false, diskUnsafe: false, notifyPending: false };
    // ONE 300ms end-to-end deadline across BOTH phases (CodeRabbit): the in-flight
    // await and the single forced retry share the budget, so a stalled 10s-default
    // bridge POST can never make the shutdown drain exceed 300ms total (the pinned D6
    // budget), regardless of whether a persist was already in flight at USER_STOP.
    const deadline = Date.now() + 300;
    const remaining = () => Math.max(0, deadline - Date.now());
    // Await a promise bounded by the remaining budget (never throws; clears its timer).
    const raceRemaining = async (p) => {
        const ms = remaining();
        if (ms <= 0) return;
        let t;
        try {
            await Promise.race([p, new Promise((resolve) => { t = setTimeout(resolve, ms); })]);
        } catch (_) { /* best-effort */ } finally { if (t) clearTimeout(t); }
    };
    // Phase 1: await an already-running attempt (single-flight → never re-POST the same pair).
    if (_persistInFlight) await raceRemaining(_persistInFlight);
    // Phase 2: at most ONE forced retry, only if time remains AND a pair is still pending.
    // _attemptPersist is single-flight, so if phase 1's attempt is still running this just
    // re-awaits it within the remaining budget rather than starting a duplicate POST.
    // urgent=true → dedicated bridge bucket so this shutdown-critical persist isn't throttled.
    if (_persistPending && _pendingPersistPayload && remaining() > 0) {
        await raceRemaining(_attemptPersist(remaining(), /* urgent */ true));
    }
    // NOTE (Codex re-review): the notify-once mark is NOT drained here. Under reserve-before-send
    // (see noteReauthNotified), a still-pending notify simply means the autonomous notice was NOT
    // sent — the reserve+send is retried on a later dead turn / next boot, so a Stop never needs
    // to block on this low-value metadata, and there is no duplicate to prevent. `notifyPending`
    // is reported only for observability.
    // Report BOTH the narrow pending-pair signal AND the authoritative disk-unsafe signal
    // (Codex re-review blocker-2). pendingPersist alone is insufficient: `_persistDurableError`
    // (convergence exhausted → T1 discarded, consumed T0 still on disk) and `_markReauthPending`
    // (a dead-family mark that never landed → disk still says the revoked family is live) BOTH
    // clear/never-set `_persistPending` yet leave the disk in a brick-on-boot state. The
    // controlled-stop gate keys on `diskUnsafe` so a Stop in either state fails closed
    // (CAS-marks reauth) instead of trusting a false-clean and reloading a consumed token.
    return {
        pendingPersist: !!(_persistPending && _pendingPersistPayload),
        diskUnsafe: isDiskUnsafe(),
        notifyPending: _noteNotifiedPending, // major-2 metadata: notify-once mark still unpersisted
    };
}

// BAT-1155 Codex re-review blocker-2 — the single authoritative "the on-disk xAI OAuth
// record is NOT safe to boot from" signal. True whenever a consumed/rotated pair or a
// revoked family is still reflected on disk as usable:
//   - a rotated pair not yet persisted (T1 in memory, consumed T0 on disk);
//   - convergence exhausted (T1 discarded, consumed T0 on disk) — the retained latch;
//   - a dead-family reauth mark that failed to persist (disk still says the family is live).
// Each is resolved by a durable store write: a successful persist, a CAS-winning conflict,
// or a durable reauth mark. isOAuth-gated (api_key families have no rotation hazard).
function isDiskUnsafe() {
    if (!isOAuth) return false;
    return !!(_persistPending && _pendingPersistPayload) || _persistDurableError || _markReauthPending;
}

/**
 * Handle a 401 by refreshing the token and signalling a retry. Mirrors
 * openai.js: throws { retryable:true } after a successful refresh (caller
 * retries with the new token), or a fatal { retryable:false } if refresh
 * failed so the caller stops retrying with a dead token.
 */
async function handleUnauthorized() {
    if (!(isOAuth && _currentRefreshToken)) return;
    // BAT-1143: the reactive path MUST honor the same guards as ensureFreshToken —
    // otherwise it can rotate a token that is already dead / tier-gated, re-POST during
    // a transport-failure cooldown, or rotate AGAIN while a prior rotation is still
    // unpersisted (orphaning the pending pair). classifyError already gates most of
    // these off 'auth', but keep them here so the two refresh entry points can never
    // diverge.
    if (_refreshDead || _tierGated) return; // let the surviving error classify terminal
    if (_refreshCoolingDown()) {
        // D9/Q4: a refresh transport failure just happened — do NOT re-POST this turn.
        const fatal = new Error('OAuth refresh cooling down after a transport failure — retry next turn');
        fatal.retryable = false;
        throw fatal;
    }
    if (_persistPending) {
        // A prior rotation is unpersisted — converge THAT first, never rotate again
        // (D9). Signal a retry so the caller re-sends on the valid in-memory bearer.
        await _attemptPersist();
        const retryError = new Error('OAuth persist retried — retry on current token');
        retryError.retryable = true;
        throw retryError;
    }
    log('[xAI] OAuth 401 — attempting token refresh...', 'INFO');
    try {
        const refreshed = await refreshOAuthToken();
        if (refreshed === null) {
            // BAT-1155: the pre-POST gate returned 'skip' (a stop is fencing this epoch, the epoch
            // was superseded, or the bridge could not arm the marker) → NO rotation happened, the
            // token is UNCHANGED. Retrying against the same 401'ing token would just burn MAX_RETRIES,
            // so surface a NON-retryable fatal — the caller stops; the next turn's ensureFreshToken
            // (after any fence/blip clears) retries the refresh cleanly.
            log('[xAI] OAuth 401 — refresh skipped (fenced/superseded/unavailable); no token change', 'WARN');
            const fatal = new Error('OAuth refresh unavailable — token unchanged, reconnect or retry next turn');
            fatal.retryable = false;
            throw fatal;
        }
        log('[xAI] Token refreshed — caller should retry', 'INFO');
        const retryError = new Error('OAuth token refreshed — retry');
        retryError.retryable = true;
        throw retryError;
    } catch (e) {
        if (e.retryable) throw e;
        // _refreshDead (invalid_grant) and the transport-failure cooldown are already
        // latched centrally in refreshOAuthToken's .catch — just surface a fatal so the
        // caller stops retrying with the dead/failed token.
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
    // D9: converge an unpersisted rotation FIRST (never refresh while pending) — but
    // ONLY while convergence is still viable. Once _persistDurableError latches, we
    // stop hammering the bridge and let proactive refresh resume (a future rotation
    // re-persists a fresh pair if the bridge recovers). Guarding on !_persistDurableError
    // is what prevents the "block refresh forever + POST every turn" trap.
    if (_persistPending && !_persistDurableError) { await _attemptPersist(); return; }
    if (_refreshDead || _tierGated) return;
    if (!_currentRefreshToken) return;
    if (_refreshCoolingDown()) return; // D9/Q4: no re-POST during the post-transport-failure cooldown

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
        // _refreshDead (invalid_grant) and the transport cooldown are latched centrally
        // in refreshOAuthToken's .catch. Proactive is best-effort — swallow here; the
        // reactive 403 backstop and the next turn's gate (after any cooldown) retry.
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
// fresh sign-in starts clean. In production a re-pair goes through a full setup →
// service restart, which reloads this module with fresh state (so this is effectively
// belt-and-suspenders there); it is the explicit contract expression of "re-pair
// clears all state" and the seam the D8 unit test drives. Kept exported so a future
// in-process re-pair signal (no restart) can call it without reintroducing the bug.
function repairReset() {
    _tierGated = false;
    _refreshDead = false;
    _persistPending = false;
    _pendingPersistPayload = null;
    _persistAttempts = 0;
    _persistDurableError = false;
    _markReauthPending = false;
    _noteNotifiedPending = false;
    _noteNotifiedPendingEpoch = -1;
    _opportunisticRefreshDone = false;
    _lastRefreshFailMono = 0n;
    // BAT-1155: a fresh sign-in re-arms the autonomous notice (the store also resets
    // reauthNotifiedEpoch to -1 in the same epoch-advanced snapshot).
    _reauthNotifiedEpoch = -1;
}

// D8: ai.js tags each request with the generation it was built under, so a
// post-refresh 403 can be told apart from an unrelated fresh-token 403.
function currentRefreshGeneration() { return _refreshGeneration; }

// D9: a rotated pair still at persistence risk — ai.js reflects this as degraded
// health (never "healthy" while the pair is memory-only) and surfaces the durable
// error once convergence is exhausted.
function isPersistPending() { return _persistPending; }
// Convergence exhausted — the rotated pair could NOT be persisted after the bounded
// retries. ai.js keeps health 'degraded' on this (never "healthy" while the on-disk
// token is stale) even though _persistPending has been cleared to unblock refresh.
function hasPersistDurableError() { return _persistDurableError; }

// D9/D10: the refresh token is dead (invalid_grant) — ai.js counts this toward the
// re-pair threshold even when the surviving 403 classifies as 'provisioning', so a
// genuinely dead session still surfaces re-pair (a fresh-token tier-gate does not).
function isRefreshDead() { return _refreshDead; }

// BAT-1155 D4 notify-once. ai.js gates the AUTONOMOUS (background) reconnect notice on
// this: true only while the family is dead AND the single notice for the CURRENT dead
// epoch hasn't fired yet. markReauthNotified is epoch-STABLE (Codex blocker-2 — it does
// NOT advance the epoch), and sets `reauthNotifiedEpoch = expectedEpoch`, so
// `reauthNotifiedEpoch === _currentEpoch` durably means "already notified for this dead
// family". A sign-in/rotate resets it to -1 and advances the epoch, so this re-arms
// cleanly after recovery. Explicit user requests are answered via classifyError's reauth
// userMessage regardless of this gate — never silent.
function shouldSurfaceReauthNotice() {
    return isOAuth && _refreshDead && _reauthNotifiedEpoch !== _currentEpoch;
}

// BAT-1155 D4 — RESERVE the single autonomous reconnect notice for this dead epoch. Codex
// re-review: to guarantee "at most one autonomous notice per dead epoch", ai.js RESERVES the
// mark BEFORE sending and sends ONLY if this returns true. Returns:
//   - true  → the epoch is now durably reserved (CAS'd) → ai.js may send the ONE notice; the
//             in-memory suppressor is set so no further autonomous notice fires for this epoch;
//   - false → NOT reserved: either the write failed (retry the reserve+send on a later dead
//             turn / next boot — nothing was sent, so no duplicate) OR a CAS conflict means the
//             dead family was superseded (no notice is due). Either way ai.js does NOT send.
// The suppressor is set ONLY on a durable reserve, so a failed reserve can never silently
// suppress a notice that never went out. Explicit user requests are answered regardless.
// Single-flight (CodeRabbit): two concurrent ai.js turns could otherwise both reserve the same
// epoch and both send the notice. Only the caller that INITIATES the reserve gets the real result
// (true → send); a concurrent caller awaits the in-flight reserve and returns false (do NOT send),
// so at most one autonomous notice goes out per epoch even under concurrency.
let _noteInFlight = null;
async function noteReauthNotified() {
    if (_noteInFlight) { await _noteInFlight.catch(() => {}); return false; }
    _noteInFlight = _persistNotifiedMark(_currentEpoch).finally(() => { _noteInFlight = null; });
    return _noteInFlight;
}

async function _persistNotifiedMark(notifiedFor) {
    try {
        const result = await androidBridgeCall('/xai/oauth/mark-reauth', {
            expectedEpoch: notifiedFor, notified: true,
        });
        if (result && result.code === 'XAI_OAUTH_EPOCH_CONFLICT') {
            // A fresh sign-in/out advanced the epoch — the dead family this notice was for no
            // longer exists. Adopt the new revision, drop any latch; no notice is due → false.
            if (typeof result.currentEpoch === 'number') _currentEpoch = result.currentEpoch;
            _reauthNotifiedEpoch = -1;
            _noteNotifiedPending = false;
            return false;
        }
        if (result && result.success === true) {
            if (typeof result.epoch === 'number') _currentEpoch = result.epoch;
            _reauthNotifiedEpoch = notifiedFor; // reserved → suppress future autonomous notices
            _noteNotifiedPending = false;
            return true; // reserved → ai.js may send the single notice
        }
        _noteNotifiedPending = true; _noteNotifiedPendingEpoch = notifiedFor; // not reserved
        return false;
    } catch (_) {
        _noteNotifiedPending = true; _noteNotifiedPendingEpoch = notifiedFor;
        return false;
    }
}

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
    isRefreshDead,

    // BAT-1155: xAI OAuth durability — shutdown drain + notify-once (ai.js / control server)
    flushPendingPersist,
    shouldSurfaceReauthNotice,
    noteReauthNotified,
    // Codex re-review test seam: drive the dead-mark retry deterministically.
    _maybeRetryReauthMark,

    // Capabilities
    supportsCache: false,
    authTypes: ['api_key', 'oauth'],

    // Test seam (not used by production code paths)
    _resetErrorStateForTests,
    _setStateForTests,
    _getStateForTests,
};
