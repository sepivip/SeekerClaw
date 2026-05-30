// SeekerClaw — providers/usepod.js
// Usepod (inference marketplace) provider adapter — BAT-971.
//
// Wire shape: OpenAI-compatible Chat Completions. Pure wire-format
// translation (messages/tools/vision/system prompt/parse) is delegated to
// openrouter.js. Everything that could leak OpenRouter-specific behavior
// into Usepod requests is OWN here:
//
//   - endpoint / testEndpoint: token spliced into URL path
//     (https://api.usepod.ai/proxy/<TOKEN>/v1/...) with per-request UUID
//     validation. Throws a typed error rather than constructing a malformed
//     URL if the token doesn't pass the validator.
//   - buildHeaders: Content-Type + dummy Authorization only. NO HTTP-Referer,
//     NO X-Title, NO OpenRouter API key. The Authorization value is
//     intentionally a non-secret literal — the real credential is in the path.
//   - formatRequest: clean OpenAI chat-completions body (model, stream,
//     max_tokens, messages, tools). NO provider routing, NO fallback,
//     NO cache_control, NO OpenRouter-only fields. Mirrors custom.js's
//     chat_completions branch.
//   - classifyError: distinguishes 402 unfunded vs price-ceiling, 401
//     unfunded vs invalid-format (per the live-probe characterization in
//     BAT-971 PR description). All user-facing strings say "Usepod", not
//     "OpenRouter".
//   - parseRateLimitHeaders: parses X-Balance-Remaining if Usepod returns
//     it (public docs mention this header on inference responses). Logs
//     once per session for diagnosability.
//
// Security: usepodToken is a UUID secret. It's redacted via security.js
// (literal-value branch in rebuildRedactPatterns + URL-path regex pass in
// redactSecrets). The sentinel-token regression test asserts no raw UUID
// in any log/error/dump across the full adapter exercise.

'use strict';

// Look the token up via property access (NOT destructured-at-require-time) so
// the dynamic endpoint getter sees fresh config values. In production this is
// a const value (config.js exports are frozen at module load), so behavior is
// identical to destructuring. In unit tests, the require.cache stub uses an
// `get USEPOD_TOKEN()` getter so each lookup observes the latest test fixture.
const _config = require('../config');
const { isValidUsepodToken, log } = _config;

const openrouter = require('./openrouter');

// One-shot log gate for X-Balance-Remaining — Usepod returns this header
// per the public docs (Codex flagged it during v2 review). We log the first
// observation each process lifetime so a power user can confirm the gateway
// is reporting balance; subsequent responses don't spam the log.
let _balanceHeaderLoggedThisSession = false;

// ── URL construction with per-request UUID validation ───────────────────────

const USEPOD_HOSTNAME = 'api.usepod.ai';

function _currentToken() {
    return _config.USEPOD_TOKEN;
}

function _requireValidToken() {
    if (!isValidUsepodToken(_currentToken())) {
        // Throwing here is preferred over constructing a malformed URL —
        // a thrown error surfaces a clean user message via the chat error
        // path, where construction would either 404 silently or (worse)
        // hit a path that does match something. Validator rejects path-
        // injection chars (/, ?, #, .., whitespace, full URLs).
        const err = new Error('usepodToken is not a valid UUID — refusing to construct API URL');
        err.code = 'USEPOD_INVALID_TOKEN';
        throw err;
    }
}

// ── Own adapter surface ─────────────────────────────────────────────────────

// Dynamic getters mirror custom.js's pattern. The endpoint changes whenever
// USEPOD_TOKEN changes (which today only happens at restart, but the dynamic
// shape future-proofs for live updates).
const endpoint = {
    get hostname() { return USEPOD_HOSTNAME; },
    get path() {
        _requireValidToken();
        return '/proxy/' + _currentToken().trim() + '/v1/chat/completions';
    },
};

const testEndpoint = {
    get hostname() { return USEPOD_HOSTNAME; },
    get path() {
        _requireValidToken();
        return '/proxy/' + _currentToken().trim() + '/balance';
    },
    method: 'GET',
};

// Minimal headers. The Authorization value is a non-secret literal — Usepod
// accepts any non-empty Authorization (the real credential is in the path).
// NOT delegated to openrouter.buildHeaders, which would add HTTP-Referer /
// X-Title / OpenRouter routing headers that Usepod doesn't need and may
// silently mis-route on.
// eslint-disable-next-line no-unused-vars
function buildHeaders(_apiKey) {
    return {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer UsePod',
    };
}

// Clean OpenAI chat-completions body. `input` is already-translated
// chat-completions messages (handed in by ai.js — Codex v2 fix #2 and
// v2.1 clarification). NO re-translation here. Mirrors custom.js:268-275.
// NO provider routing, NO fallback chain, NO cache_control, NO OpenRouter-
// only fields.
// eslint-disable-next-line no-unused-vars
function formatRequest(model, maxTokens, instructions, input, tools, _requestOptions) {
    const body = {
        model,
        stream: true,
        max_tokens: maxTokens,
        messages: [{ role: 'system', content: instructions }, ...input],
    };
    if (tools && tools.length > 0) body.tools = tools;
    return JSON.stringify(body);
}

// 402 unfunded vs price-ceiling; 401 unfunded vs invalid-format. Live-probe
// (BAT-971 PR description) characterized the 401 message split:
//   - "unauthorized: token not found or not activated" → unfunded OR unknown
//     (Usepod combines them server-side; no caller-side distinction)
//   - "unauthorized: invalid token format" → malformed UUID (also caught
//     by our client-side validator before the request fires)
// 402:
//   - error.type === 'no_provider_at_price' → ceiling exceeded
//   - otherwise → unfunded
function classifyError(status, data) {
    const errType = data && data.error && typeof data.error.type === 'string' ? data.error.type : '';
    const errMessage = data && data.error && typeof data.error.message === 'string' ? data.error.message : '';

    if (status === 402) {
        if (errType === 'no_provider_at_price') {
            const details = data && data.error && data.error.details;
            const minIn = details && typeof details.suggested_min_input_per_1m === 'number'
                ? details.suggested_min_input_per_1m : null;
            const minOut = details && typeof details.suggested_min_output_per_1m === 'number'
                ? details.suggested_min_output_per_1m : null;
            const suffix = (minIn !== null && minOut !== null)
                ? ` Suggested minimums: ${minIn} input / ${minOut} output (microunits per 1M tokens).`
                : '';
            return {
                type: 'price_ceiling',
                retryable: false,
                userMessage: 'No Usepod provider available under your current price ceiling. '
                    + 'Either raise the ceiling or check the dashboard at https://usepod.ai/dashboard.'
                    + suffix,
            };
        }
        return {
            type: 'unfunded',
            retryable: false,
            userMessage: 'Fund your Usepod token at https://usepod.ai/dashboard.',
        };
    }
    if (status === 401) {
        if (/invalid token format/i.test(errMessage)) {
            return {
                type: 'auth',
                retryable: false,
                userMessage: 'Invalid Usepod token format. Re-check the UUID in Settings → AI Provider → Usepod.',
            };
        }
        if (/not found or not activated/i.test(errMessage)) {
            // Per live-probe: this message covers BOTH unfunded-but-registered
            // AND unknown tokens. Surface a combined hint that covers both
            // recovery paths without falsely accusing the user of pasting
            // a bad token.
            return {
                type: 'auth_or_unfunded',
                retryable: false,
                userMessage: 'Usepod token is unfunded or unknown. Fund or re-check the token at https://usepod.ai/dashboard.',
            };
        }
        return {
            type: 'auth',
            retryable: false,
            userMessage: 'Invalid Usepod token. Re-check Settings → AI Provider → Usepod → Token.',
        };
    }
    if (status === 403) {
        return {
            type: 'auth',
            retryable: false,
            userMessage: 'Usepod rejected the request (403). Re-check your token in Settings.',
        };
    }
    if (status === 429) {
        return {
            type: 'rate_limit',
            retryable: true,
            userMessage: 'Usepod rate-limited. Retrying in a moment...',
        };
    }
    if (status >= 500 && status < 600) {
        return {
            type: 'server',
            retryable: true,
            userMessage: 'Usepod is temporarily unavailable. Retrying...',
        };
    }
    const rawReason = (errMessage || '').replace(/[*_`\[\]()~>#+\-=|{}.!]/g, '').slice(0, 200).trim();
    return {
        type: 'unknown',
        retryable: false,
        userMessage: rawReason
            ? `Usepod error (${status}): ${rawReason}`
            : `Unexpected Usepod error (${status}). Please try again.`,
    };
}

// Parse X-Balance-Remaining (public docs flagged by Codex v2). Falls back
// gracefully when the header is absent. Logs the first observation per
// process for diagnosability. Standard rate-limit fields are absent for
// Usepod (no anthropic-ratelimit-* equivalents) — we return Infinity for
// tokensRemaining so the rate-limiter never throttles a session that's
// actually fine.
function parseRateLimitHeaders(headers) {
    const empty = { tokensRemaining: Infinity, tokensReset: '' };
    if (!headers) return empty;
    const balanceRaw = headers['x-balance-remaining'];
    if (typeof balanceRaw === 'string' && balanceRaw.length > 0) {
        const micro = parseInt(balanceRaw, 10);
        if (Number.isFinite(micro) && micro >= 0 && !_balanceHeaderLoggedThisSession) {
            _balanceHeaderLoggedThisSession = true;
            const usdc = (micro / 1_000_000).toFixed(4);
            log(`[Usepod] X-Balance-Remaining observed: ${micro} microunits (~$${usdc} USDC)`, 'INFO');
        }
    }
    return empty;
}

// ── Module export — own surface + pure-translation delegates ────────────────

module.exports = {
    id: 'usepod',
    name: 'Usepod',

    // Own (NOT delegated)
    endpoint,
    testEndpoint,
    buildHeaders,
    formatRequest,
    classifyError,
    parseRateLimitHeaders,
    streamProtocol: 'chat-completions',
    supportsCache: false,
    authTypes: ['api_key'],

    // Delegated to openrouter.js — pure wire-format translation only.
    // No OpenRouter-specific decoration in any of these paths (verified at
    // adapter design time; tests pin the assertion).
    toApiMessages: openrouter.toApiMessages,
    fromApiResponse: openrouter.fromApiResponse,
    formatSystemPrompt: openrouter.formatSystemPrompt,
    formatTools: openrouter.formatTools,
    formatVision: openrouter.formatVision,
    normalizeUsage: openrouter.normalizeUsage,
    classifyNetworkError: openrouter.classifyNetworkError,
};
