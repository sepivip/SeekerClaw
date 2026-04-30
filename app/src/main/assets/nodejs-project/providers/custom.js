// SeekerClaw — providers/custom.js
// Generic custom provider for OpenAI-compatible gateways and middlemen.
// Delegates to openrouter.js (Chat Completions) or openai.js (Responses API)
// but uses own formatRequest to avoid OpenRouter-specific decorations.
//
// BAT-549: this adapter explicitly wraps the delegate's reasoning round-trip
// (Codex v4.1 finding 5). Reasoning blocks captured under delegation are
// re-stamped `provider: 'custom'` / `sourceAdapter: 'custom'` (with
// `delegateAdapter` recorded for forensics), and DeepSeek V4/R1 model-gating
// is applied BEFORE delegation so the delegate's emit path never bypasses
// gating. See `reasoning-gating.js` for the gating function.

const {
    CUSTOM_KEY,
    CUSTOM_HEADERS,
    CUSTOM_FORMAT,
    CUSTOM_ENDPOINT,
    resolveActiveModel,
    log,
} = require('../config');

const openai = require('./openai');
const openrouter = require('./openrouter');
const {
    detectCustomEchoBehavior,
    stripReasoningForCustomGating,
} = require('../reasoning-gating');

// One-time-per-(model,session) log gate: avoid spamming when an "unknown"
// gateway returns reasoning_content on every turn. R10 fix: bounded LRU
// (Map preserves insertion order; we drop the oldest entry when we hit
// the cap) so a long-lived 24/7 agent process doesn't accumulate
// per-model entries indefinitely as users experiment with gateways.
const _UNKNOWN_ECHO_LOG_LRU_MAX = 64;
const _unknownEchoLogged = new Map();
function _markEchoLogged(key) {
    // Refresh insertion order on re-touch so recent keys stay warm
    if (_unknownEchoLogged.has(key)) _unknownEchoLogged.delete(key);
    _unknownEchoLogged.set(key, true);
    while (_unknownEchoLogged.size > _UNKNOWN_ECHO_LOG_LRU_MAX) {
        // Drop the oldest key (Map iteration order = insertion order)
        const oldest = _unknownEchoLogged.keys().next().value;
        _unknownEchoLogged.delete(oldest);
    }
}

function delegate() {
    return CUSTOM_FORMAT === 'responses' ? openai : openrouter;
}

function delegateName() {
    return CUSTOM_FORMAT === 'responses' ? 'openai' : 'openrouter';
}

function sanitizeHeaderValue(value) {
    return String(value).replace(/[\r\n]+/g, ' ').trim();
}

function buildHeaders(apiKey) {
    const headers = {
        'Content-Type': 'application/json',
        ...CUSTOM_HEADERS,
    };
    const effectiveKey = apiKey || CUSTOM_KEY;
    const hasAuthHeader = Object.keys(headers).some(k => k.toLowerCase() === 'authorization');
    if (effectiveKey && !hasAuthHeader) {
        headers.Authorization = `Bearer ${effectiveKey}`;
    }
    for (const key of Object.keys(headers)) {
        // Validate header name: must be valid HTTP token (no spaces, control chars)
        if (/[^\x21-\x7E]/.test(key) || key.includes(' ')) {
            delete headers[key];
            continue;
        }
        const sanitized = sanitizeHeaderValue(headers[key]);
        if (sanitized === '') {
            delete headers[key];
        } else {
            headers[key] = sanitized;
        }
    }
    return headers;
}

function getEndpoint() {
    return CUSTOM_ENDPOINT;
}

function classifyError(status, data) {
    const base = delegate().classifyError(status, data);
    if (!base || typeof base !== 'object') {
        return { type: 'unknown', retryable: false, userMessage: `Custom provider error (${status}).` };
    }
    return {
        ...base,
        userMessage: String(base.userMessage || `Custom provider error (${status}).`)
            .replace(/OpenAI/g, 'custom provider')
            .replace(/OpenRouter/g, 'custom provider')
            .replace(/Claude/g, 'custom provider')
            .replace(/Anthropic/g, 'custom provider'),
    };
}

function classifyNetworkError(err) {
    const base = delegate().classifyNetworkError(err);
    return {
        ...base,
        userMessage: String(base?.userMessage || 'A network error occurred. Please try again.')
            .replace(/OpenAI/g, 'custom provider')
            .replace(/OpenRouter/g, 'custom provider')
            .replace(/Claude/g, 'custom provider')
            .replace(/Anthropic/g, 'custom provider'),
    };
}

/**
 * BAT-549: wrap delegate's parse and re-stamp every reasoningBlock the
 * delegate captured. Custom is the source-of-truth here — DeepSeek (and
 * any future OpenAI-compatible reasoning model) returns content under the
 * delegate's wire shape, but the user is on Custom and gating decisions
 * apply to Custom. Re-stamping keeps gating decisions (R1-strip vs
 * V4-echo vs unknown-capture-only) consistent.
 *
 * `delegateAdapter` is recorded for forensics (so a checkpoint dump shows
 * which path the data came from) AND is used by the delegate's own replay
 * filter on the next tool-use turn: openai.js's `_collectOpenAIReasoningItems`
 * and openrouter.js's emit path both accept blocks where
 * `sourceAdapter === <self>` OR `delegateAdapter === <self>`. Without that
 * symmetry, the Custom-stamped blocks would be dropped on replay even
 * though the wire bytes are byte-exact for the delegate's API.
 */
function fromApiResponse(raw) {
    const parsed = delegate().fromApiResponse(raw);
    if (Array.isArray(parsed.reasoningBlocks) && parsed.reasoningBlocks.length > 0) {
        const dn = delegateName();
        // R2 thread 4: prefer the model the response ACTUALLY came from
        // (raw.model from the delegate's parse, or blk.sourceModel which
        // openrouter.js sets to raw.model). Fall back to resolveActiveModel
        // ONLY when the response didn't include a model id. This keeps
        // persisted provenance accurate even when an `agent_settings.json`
        // overlay has switched the model since the request was sent.
        parsed.reasoningBlocks = parsed.reasoningBlocks.map((blk) => ({
            ...blk,
            provider: 'custom',
            sourceAdapter: 'custom',
            delegateAdapter: dn,
            sourceModel: raw && typeof raw.model === 'string' && raw.model
                ? raw.model
                : (blk.sourceModel || resolveActiveModel() || null),
        }));
    } else if (!parsed.reasoningBlocks) {
        parsed.reasoningBlocks = [];
    }
    return parsed;
}

/**
 * BAT-549: gate Custom-stamped reasoningBlocks BEFORE delegation. Per
 * v4.1 Codex finding 5: gating must apply EVEN WHEN delegating to
 * OpenAI/OpenRouter — otherwise R1 (which 400s on echo) would always
 * route through the delegate's echo path.
 *
 * For native delegate adapters (the openrouter or openai modules invoked
 * outside Custom), gating doesn't apply — those adapters are called
 * directly by the providers/index.js registry without Custom in front.
 */
function toApiMessages(messages, activeModel, requestOptions) {
    // R2 thread 3: accept the resolved active model as a parameter so
    // gating uses the SAME model that ai.js's chat() built the request
    // with. Re-reading resolveActiveModel() here would race with a mid-
    // turn agent_settings.json overlay flip and could send a V4 request
    // while gating decided "strip" (or vice versa) — reintroducing the
    // 400 loop. Other adapters' toApiMessages signatures are unchanged
    // (they ignore the extra arg). Fall back to resolveActiveModel only
    // if the caller didn't pass one, for backward compatibility with any
    // older callsites in this branch.
    const customModel = (typeof activeModel === 'string' && activeModel)
        ? activeModel
        : resolveActiveModel();
    // BAT-549 Commit 3c: read the user's per-Custom override toggle from
    // requestOptions (built fresh by ai.js from RuntimeState each turn).
    // When `true`, detectCustomEchoBehavior promotes "unknown" gateways
    // to "echo-on-tool-loop" — for power users who know their gateway
    // requires echoing reasoning_content but the model id doesn't match
    // the known DeepSeek-V4 regex. The override is single-flag, scoped
    // to the active Custom config tuple via Commit 3d's signature
    // mechanism (which resets the override when the user switches
    // gateways). Older callsites that don't pass requestOptions get
    // the conservative default (false) — same as Commit 1 behavior.
    const customEchoOverride = !!(requestOptions
        && requestOptions.customEchoOverride === true);
    const behavior = detectCustomEchoBehavior(customModel, customEchoOverride);

    // One-shot warning when reasoning is captured but gating won't echo it.
    // 3c update: now that the override IS wired (Commit 3c), the actionable
    // advice is real — the Settings UI ships with the per-Custom toggle in
    // Commit 3e. Until 3e merges, the toggle is settable only via the
    // RuntimeState file directly; the log line still helps power users see
    // why their gateway isn't echoing.
    if (behavior === 'unknown') {
        const hasReasoning = Array.isArray(messages) && messages.some(
            (m) => m && m.role === 'assistant'
                && Array.isArray(m.reasoningBlocks) && m.reasoningBlocks.length > 0
        );
        if (hasReasoning) {
            const key = `${customModel || ''}|${process.pid || 'p'}`;
            if (!_unknownEchoLogged.has(key)) {
                _markEchoLogged(key);
                log(
                    `[Custom] Reasoning content detected on model ${customModel || '<unset>'} but the gateway's echo contract is unknown to SeekerClaw. Capturing for forensics; not echoing on next turn (would risk a 400 if the gateway is R1-shaped).`,
                    'INFO',
                );
            }
        }
    }

    const gatedMessages = stripReasoningForCustomGating(messages, behavior);
    // BAT-549 R1-of-2a Copilot: pass activeModel through to the delegate's
    // toApiMessages so its own gating (added in Commit 2a for native OpenRouter
    // R1/V4 protection) sees the same model Custom resolved. Without this,
    // openrouter's gating would receive activeModel=undefined and default to
    // 'unknown' / strip — contradicting Custom's V4 'echo-on-tool-loop'
    // decision. With it, openrouter agrees with Custom (V4 → echo, R1 → strip)
    // and the gated messages survive intact.
    // 3c: also forward requestOptions so the delegate's own formatRequest
    // (called separately) receives the SAME options object — keeps gating
    // and request body decisions in lock-step. The delegate's toApiMessages
    // ignores the 3rd arg today; future delegate-side request-shape
    // decisions will read it.
    return delegate().toApiMessages(gatedMessages, customModel, requestOptions);
}

module.exports = {
    id: 'custom',
    name: 'Custom',

    get endpoint() { return getEndpoint(); },
    getEndpoint,

    get streamProtocol() {
        return CUSTOM_FORMAT === 'responses' ? 'openai-responses' : 'chat-completions';
    },

    buildHeaders,

    toApiMessages,
    fromApiResponse,
    formatSystemPrompt(stable, dynamic, authType) { return delegate().formatSystemPrompt(stable, dynamic, authType); },
    formatTools(tools) { return delegate().formatTools(tools); },
    formatVision(base64, mediaType) { return delegate().formatVision(base64, mediaType); },

    // Own formatRequest — clean Chat Completions body without OpenRouter cache_control/fallback.
    // BAT-549 Commit 3c: forward requestOptions to the openai delegate when
    // CUSTOM_FORMAT==='responses' (so user-toggled reasoning gating reaches
    // the delegate's body builder for non-codex Responses-shaped gateways).
    // The chat-completions branch deliberately does NOT emit body.reasoning
    // — Custom defines its own clean body shape (no OpenRouter decorations,
    // no Anthropic-only fields), and OpenAI-compatible gateways vary too
    // widely in how they handle a `reasoning` field for the `chat/completions`
    // endpoint to send it blindly. Power users who know their gateway
    // accepts it can set the per-Custom echo override (which controls
    // toApiMessages' echo path); request-side reasoning enablement on
    // chat-completions Custom is intentionally left to the gateway's default.
    formatRequest(model, maxTokens, instructions, input, tools, requestOptions) {
        if (CUSTOM_FORMAT === 'responses') {
            return openai.formatRequest(model, maxTokens, instructions, input, tools, requestOptions);
        }
        const body = {
            model,
            stream: true,
            max_tokens: maxTokens,
            messages: [{ role: 'system', content: instructions }, ...input],
        };
        if (tools && tools.length > 0) body.tools = tools;
        return JSON.stringify(body);
    },

    classifyError,
    classifyNetworkError,
    normalizeUsage(usage) { return delegate().normalizeUsage(usage); },
    parseRateLimitHeaders(headers) { return delegate().parseRateLimitHeaders(headers); },

    // Test seam — exposes the echo gating decision so unit tests can pin
    // R1-strip vs V4-echo vs unknown-capture-only without going through the
    // full request path. Not used by production code paths.
    _detectEchoBehaviorForTest: detectCustomEchoBehavior,

    supportsCache: false,
    authTypes: ['api_key'],
};
