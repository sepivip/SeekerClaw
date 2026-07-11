// SeekerClaw — providers/claude.js
// Claude (Anthropic) provider adapter. Translates between neutral internal
// message format and Claude Messages API format.

const { log } = require('../config');
const { logSuppression, SUPPRESSION_REASONS } = require('../reasoning-gating');

// BAT-1033 — Claude adaptive thinking.
//
// Anthropic REMOVED extended thinking (`thinking.type:'enabled'` +
// `budget_tokens`) from the current models. fable-5, opus-4-8, opus-4-7,
// and sonnet-5 reject it with HTTP 400 ("thinking.type.enabled is not
// supported for this model. Use thinking.type.adaptive"); only the older
// opus-4-6 / sonnet-4-6 still accept it. `thinking.type:'adaptive'` (the
// model auto-sizes its own budget — no `budget_tokens`) is accepted by
// EVERY reasoning model, so we send it uniformly.
//
// This also retires the BAT-558 budget clamp: with no `budget_tokens`
// there is no `budget_tokens < max_tokens` constraint to satisfy, which
// removes that entire 400 class (the reason BAT-558 existed).
//
// Verified live on the RAW api-key path (tests/live/anthropic/test-thinking-matrix.js):
//   extended → fable-5/opus-4-8/opus-4-7/sonnet-5: 400 removed; opus-4-6/sonnet-4-6: 200
//   adaptive → all six: 200
// The 400 only surfaced for users on their own API key — setup_token's
// `cc_version` billing lane still tolerated the deprecated extended shape.
//
// MIN_THINKING_TURN is retained purely as a UX guard: on a sub-2048
// max_tokens turn, reasoning would eat most of the answer budget, so we
// skip it. It is no longer an API constraint (adaptive has no budget floor).
const MIN_THINKING_TURN = 2048;

// ── Neutral ↔ Claude message translation ────────────────────────────────────

/**
 * Convert neutral internal messages to Claude API messages format.
 *
 * Neutral:
 *   { role:'user', content:'text' }
 *   { role:'assistant', content:'text', toolCalls:[{id,name,input}] }
 *   { role:'tool', toolCallId:'tc_1', content:'...' }
 *
 * Claude:
 *   { role:'user', content:[{type:'text', text:'...'}] }
 *   { role:'assistant', content:[{type:'text',text:'...'},{type:'tool_use',id,name,input}] }
 *   { role:'user', content:[{type:'tool_result', tool_use_id, content}] }
 */
// BAT-549 Commit 2: collect Anthropic-stamped thinking/redacted_thinking
// wire blocks from a stored assistant message's reasoningBlocks. These
// must be echoed back UNCHANGED + IN ORDER on tool-use turns or the
// signature fails server-side validation. Returns an array of wire
// objects suitable for splicing into the front of content[].
//
// Activation: only blocks where sourceAdapter === 'claude' (i.e. captured
// by THIS adapter from a previous Anthropic turn). Other-provider blocks
// (custom/openrouter) pass through silently — they don't belong here.
function _collectClaudeWireBlocks(msg) {
    if (!msg || !Array.isArray(msg.reasoningBlocks)) return [];
    const out = [];
    for (const blk of msg.reasoningBlocks) {
        if (!blk || blk.sourceAdapter !== 'claude') continue;
        if (typeof blk.wire !== 'object' || blk.wire === null || Array.isArray(blk.wire)) continue;
        const t = blk.wire.type;
        if (t !== 'thinking' && t !== 'redacted_thinking') continue;
        // Verify the shape minimally so a corrupted checkpoint can't
        // submit nonsense: thinking needs string `thinking` + a NON-EMPTY
        // signature; redacted_thinking needs string `data`.
        //
        // BAT-1033: the signature — not the thinking text — is what Anthropic
        // validates. A thinking block with an empty/whitespace signature is
        // rejected with 400 "each thinking block must contain thinking" (the
        // message is misleading); an empty-TEXT block WITH a valid signature is
        // accepted. Pre-fix builds streamed thinking blocks with an empty
        // signature (http.js dropped signature_delta), so guard on the signature
        // being present. This also recovers already-poisoned v2.1.0 checkpoints
        // after upgrade — skip the bad block rather than 400 the whole request.
        // Do NOT reject on empty thinking text: a signed empty-text block is
        // valid and must still be echoed back unchanged.
        if (t === 'thinking' && (typeof blk.wire.thinking !== 'string'
            || typeof blk.wire.signature !== 'string' || blk.wire.signature.trim() === '')) continue;
        if (t === 'redacted_thinking' && typeof blk.wire.data !== 'string') continue;
        out.push(blk.wire);
    }
    return out;
}

function toApiMessages(messages) {
    const out = [];
    let pendingToolResults = [];

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];

        if (msg.role === 'tool') {
            // Accumulate tool results — they'll be grouped into a single user message
            pendingToolResults.push({
                type: 'tool_result',
                tool_use_id: msg.toolCallId,
                content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            });
            // Flush if next message is not a tool result
            const next = messages[i + 1];
            if (!next || next.role !== 'tool') {
                out.push({ role: 'user', content: pendingToolResults });
                pendingToolResults = [];
            }
            continue;
        }

        // Flush any pending tool results before non-tool messages
        if (pendingToolResults.length > 0) {
            out.push({ role: 'user', content: pendingToolResults });
            pendingToolResults = [];
        }

        if (msg.role === 'assistant') {
            // If content is already a Claude-native array (legacy checkpoint), pass through.
            // Such arrays may already include thinking blocks — don't re-emit from
            // reasoningBlocks here because that would double-up.
            if (Array.isArray(msg.content)) {
                out.push({ role: 'assistant', content: msg.content });
                continue;
            }
            // BAT-549 Commit 2: thinking/redacted_thinking blocks come FIRST
            // in content[]. Echo only on tool-use turns (toolCalls present)
            // — that's the Anthropic contract. For text-only assistant
            // turns the thinking is captured but not replayed.
            const hasToolCalls = Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0;
            const thinkingWire = hasToolCalls ? _collectClaudeWireBlocks(msg) : [];
            const content = [];
            for (const w of thinkingWire) content.push(w);
            if (msg.content) {
                content.push({ type: 'text', text: msg.content });
            }
            if (hasToolCalls) {
                for (const tc of msg.toolCalls) {
                    content.push({
                        type: 'tool_use',
                        id: tc.id,
                        name: tc.name,
                        input: tc.input,
                    });
                }
            }
            out.push({ role: 'assistant', content: content.length > 0 ? content : [{ type: 'text', text: '' }] });
        } else if (msg.role === 'user') {
            // User message — can be string or array of content blocks (vision)
            if (typeof msg.content === 'string') {
                out.push({ role: 'user', content: msg.content });
            } else if (Array.isArray(msg.content)) {
                out.push({ role: 'user', content: msg.content });
            } else {
                out.push({ role: 'user', content: String(msg.content || '') });
            }
        }
    }

    // Flush trailing tool results
    if (pendingToolResults.length > 0) {
        out.push({ role: 'user', content: pendingToolResults });
    }

    return out;
}

/**
 * Parse Claude API response into neutral format.
 * @param {object} raw - Raw Claude response (data field from httpStreamingRequest)
 * @returns {{ text, toolCalls, reasoningBlocks, stopReason, usage }}
 *
 * BAT-549 Commit 2: also captures `thinking` and `redacted_thinking`
 * content blocks verbatim into `reasoningBlocks[]` (raw wire payloads,
 * never re-normalized — Codex v3 finding 1). Required for tool-use
 * loops with extended thinking enabled: Anthropic server-validates
 * the `signature` field on every echoed block, so we MUST preserve
 * them byte-exact + in original order. The `toApiMessages` path on the
 * NEXT request splices these wire blocks back into the assistant
 * message's content[] when the message has tool_calls.
 */
function fromApiResponse(raw) {
    const content = raw.content || [];
    const textParts = content.filter(c => c.type === 'text').map(c => c.text);
    const text = textParts.length > 0 ? textParts.join('\n') : null;

    const toolCalls = content
        .filter(c => c.type === 'tool_use')
        .map(c => ({ id: c.id, name: c.name, input: c.input || {} }));

    // BAT-549 Commit 2: capture thinking + redacted_thinking blocks
    // verbatim — preserves the signature byte-exactly so a future
    // request that echoes them passes Anthropic's server-side
    // validation. raw.id is the message id (turn id from Anthropic).
    const reasoningBlocks = [];
    const turnId = (raw && typeof raw.id === 'string') ? raw.id : null;
    const sourceModel = (raw && typeof raw.model === 'string') ? raw.model : null;
    for (const c of content) {
        if (!c || (c.type !== 'thinking' && c.type !== 'redacted_thinking')) continue;
        // BAT-1033: reject malformed blocks at the CAPTURE boundary too, not
        // just on replay, so a poisoned block never enters a checkpoint in the
        // first place. Mirror _collectClaudeWireBlocks exactly: a `thinking`
        // block needs a string `thinking` + a NON-EMPTY string `signature`
        // (empty TEXT is valid — an empty-signature block is the poison);
        // `redacted_thinking` needs a string `data`. With the http.js delta
        // fix the normal streamed path won't produce these, but a malformed
        // block from any other source (older build, non-streaming edge) is
        // dropped here instead of persisted.
        if (c.type === 'thinking' && (typeof c.thinking !== 'string'
            || typeof c.signature !== 'string' || c.signature.trim() === '')) continue;
        if (c.type === 'redacted_thinking' && typeof c.data !== 'string') continue;
        reasoningBlocks.push({
            schemaVersion: 1,
            provider: 'anthropic',
            sourceAdapter: 'claude',
            sourceModel,
            turnId,
            wire: c, // verbatim block; signature stays unchanged
        });
    }

    return {
        text,
        toolCalls,
        reasoningBlocks,
        stopReason: raw.stop_reason || 'end_turn',
        usage: raw.usage || {},
    };
}

// ── Billing attribution (required for OAuth/setup-token access to non-Haiku models) ─

// BAT-1123: cc_version tracks the Claude Code CLI version we identify as on the
// setup_token billing path. Bumped 2.1.116 → 2.1.195 (verified HTTP 200 on our
// models via tests/live/anthropic/test-cc-version.js). Keep in sync with tests/live/anthropic/lib.js.
const CC_BILLING_HEADER = 'x-anthropic-billing-header: cc_version=2.1.195; cc_entrypoint=cli; cch=00000;';

// ── System prompt ───────────────────────────────────────────────────────────

/**
 * Format system prompt for Claude API (cached stable block + optional dynamic block).
 * @param {string} stable - Stable system prompt text
 * @param {string} dynamic - Dynamic system prompt text
 * @param {string} [authType] - Auth type ('api_key' or 'setup_token')
 */
function formatSystemPrompt(stable, dynamic, authType) {
    const blocks = [];
    // Billing attribution — required for OAuth tokens to access Sonnet/Opus
    if (authType === 'setup_token') {
        blocks.push({ type: 'text', text: CC_BILLING_HEADER });
    }
    blocks.push({ type: 'text', text: stable, cache_control: { type: 'ephemeral' } });
    if (typeof dynamic === 'string' && dynamic.trim()) blocks.push({ type: 'text', text: dynamic });
    return blocks;
}

// ── Tool schema formatting ──────────────────────────────────────────────────

/**
 * Format tools for Claude API. Pass-through (Claude's native format IS JSON Schema)
 * but adds cache_control on last tool for prompt caching.
 */
function formatTools(tools) {
    if (!tools || tools.length === 0) return [];
    // Shallow-clone last tool to avoid mutating shared array
    const out = [...tools];
    out[out.length - 1] = {
        ...out[out.length - 1],
        cache_control: { type: 'ephemeral' },
    };
    return out;
}

// ── API request building ────────────────────────────────────────────────────

/**
 * Build full Claude API request body.
 *
 * BAT-549 Commit 3c gated `body.thinking` emission on the user toggle
 * (`reasoningEnabled === true`) AND registry confirmation
 * (`reasoningSupport === "yes"`). BAT-558 v4 R3 added the
 * `reasoningMode: 'off'` short-circuit so heartbeats / synthetic turns
 * opt out even when the user toggle is on.
 *
 * BAT-1033 replaced the extended-thinking budget clamp with
 * `thinking: { type: 'adaptive' }`. Anthropic removed extended thinking
 * (`type:'enabled'` + `budget_tokens`) from the current models — they 400
 * — while adaptive (model auto-sizes its own budget) is accepted by every
 * reasoning model. Adaptive carries no `budget_tokens`, so the old
 * `budget_tokens < max_tokens` clamp is gone; see the module header for
 * the per-model matrix and the live-probe evidence.
 *
 * The `maxTokens < MIN_THINKING_TURN` (2048) skip is retained as a UX
 * guard so a tiny answer budget isn't consumed by reasoning. Existing
 * call sites (vision/summary) that pass small `maxTokens` (256, 500) or
 * no `requestOptions` continue to emit no `thinking` — additive change.
 */
function formatRequest(model, maxTokens, systemBlocks, messages, tools, requestOptions) {
    const body = {
        model,
        max_tokens: maxTokens,
        stream: true,
        system: systemBlocks,
        messages,
    };
    if (tools && tools.length > 0) body.tools = tools;

    // BAT-558 v4 R3 — synthetic / opt-out short-circuit. Heartbeats
    // pass `reasoningMode: 'off'` explicitly; ai.js also defensively
    // sets it for `chatId === '__heartbeat__'`. Either path skips the
    // thinking block regardless of user-toggle / registry-support state
    // (those gates apply to the OPTIONAL emission below this).
    const reasoningOff = !!(requestOptions && requestOptions.reasoningMode === 'off');
    const userWantsReasoning = !!(requestOptions
        && requestOptions.reasoningEnabled === true
        && requestOptions.reasoningSupport === 'yes');
    if (reasoningOff || !userWantsReasoning) {
        return JSON.stringify(body);
    }

    // Small-turn skip (retained from BAT-558 as a UX guard): a sub-2048
    // max_tokens turn has no headroom for useful reasoning AND a usable
    // answer, so thinking is skipped (rate-limited INFO log so the
    // suppression is discoverable in field reports without flooding Logs).
    if (maxTokens < MIN_THINKING_TURN) {
        logSuppression(
            SUPPRESSION_REASONS.MAX_TOKENS_BELOW_FLOOR,
            `claude maxTokens=${maxTokens}`,
        );
        return JSON.stringify(body);
    }

    // BAT-1033 — adaptive thinking: the model auto-sizes its own budget.
    // No `budget_tokens` (extended thinking was removed from the current
    // models; adaptive is accepted by all). See module header for the matrix.
    body.thinking = { type: 'adaptive' };
    return JSON.stringify(body);
}

// ── Connection details ──────────────────────────────────────────────────────

const endpoint = { hostname: 'api.anthropic.com', path: '/v1/messages' };

function buildHeaders(apiKey, authType) {
    const auth = authType === 'setup_token'
        ? { 'Authorization': `Bearer ${apiKey}` }
        : { 'x-api-key': apiKey };

    // BAT-549 Commit 3c: include the `interleaved-thinking-2025-05-14` beta
    // so the API accepts replayed `thinking` blocks AFTER `tool_use` blocks
    // on the next turn. Without this, a tool-loop turn that splices the
    // captured thinking back into content[] would be rejected. Adding it
    // is a no-op when reasoning is OFF — the beta only activates when the
    // request actually emits thinking blocks. Safe-by-default for both
    // setup_token and api_key auth modes.
    const betaTags = authType === 'setup_token'
        ? 'prompt-caching-2024-07-31,oauth-2025-04-20,interleaved-thinking-2025-05-14'
        : 'prompt-caching-2024-07-31,interleaved-thinking-2025-05-14';
    return {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': betaTags,
        ...auth,
    };
}

// ── Streaming ───────────────────────────────────────────────────────────────
// Claude uses named SSE events: message_start, content_block_start,
// content_block_delta, content_block_stop, message_delta, message_stop.
// The existing httpStreamingRequest in web.js handles this natively.
// We just mark that Claude uses the 'claude' streaming protocol.

const streamProtocol = 'claude';

// ── Error classification ────────────────────────────────────────────────────

function classifyError(status, data) {
    if (status === 401 || status === 403) {
        // BAT-1130: auth-agnostic copy — setup_token users have no "API key", so
        // "API key might be wrong" was misleading. Covers both auth modes.
        return {
            type: 'auth', retryable: false,
            userMessage: '🔑 The AI rejected the credentials. If you use an API key, re-check it in Settings; if you signed in with a Pro/Max token, re-pair in Settings.'
        };
    }
    if (status === 402) {
        return {
            type: 'billing', retryable: false,
            userMessage: 'Your API account needs attention — check billing at console.anthropic.com'
        };
    }
    if (status === 429) {
        const msg = data?.error?.message || '';
        if (/quota|credit/i.test(msg)) {
            return {
                type: 'quota', retryable: false,
                userMessage: 'API usage quota exceeded. Please try again later or upgrade your plan.'
            };
        }
        return {
            type: 'rate_limit', retryable: true,
            userMessage: '⏳ Got rate limited. Trying again in a moment...'
        };
    }
    if (status === 529) {
        return {
            type: 'overloaded', retryable: true,
            userMessage: 'Claude API is temporarily overloaded. Please try again in a moment.'
        };
    }
    if (status >= 520 && status <= 527) {
        return {
            type: 'cloudflare', retryable: true,
            userMessage: 'Claude API is temporarily unreachable. Retrying...'
        };
    }
    if (status >= 500 && status < 600) {
        return {
            type: 'server', retryable: true,
            userMessage: 'Claude API is temporarily unavailable. Retrying...'
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
    if (err.code === 'SESSION_EXPIRED') {
        return { type: 'session_expired', userMessage: 'Your session has expired. Please re-pair with Settings.' };
    }
    if (err.timeoutSource === 'transport' || /timeout/i.test(raw)) {
        return { type: 'timeout', userMessage: 'The AI took too long to respond. Please try again.' };
    }
    if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) {
        return { type: 'dns', userMessage: 'Cannot reach the AI service — check your internet connection.' };
    }
    if (/ECONNREFUSED|ECONNRESET|EPIPE/i.test(raw)) {
        return { type: 'connection', userMessage: 'Connection to the AI service was lost. Please try again.' };
    }
    return { type: 'network', userMessage: 'A network error occurred. Please try again.' };
}

// ── Rate limit headers ──────────────────────────────────────────────────────

function parseRateLimitHeaders(headers) {
    if (!headers) return { tokensRemaining: Infinity, tokensReset: '' };
    const remaining = parseInt(headers['anthropic-ratelimit-tokens-remaining'], 10);
    return {
        tokensRemaining: Number.isFinite(remaining) ? remaining : Infinity,
        tokensReset: headers['anthropic-ratelimit-tokens-reset'] || '',
        // Full breakdown for usage state file
        requests: {
            limit: parseInt(headers['anthropic-ratelimit-requests-limit']) || 0,
            remaining: parseInt(headers['anthropic-ratelimit-requests-remaining']) || 0,
            reset: headers['anthropic-ratelimit-requests-reset'] || '',
        },
        tokens: {
            limit: parseInt(headers['anthropic-ratelimit-tokens-limit']) || 0,
            remaining: parseInt(headers['anthropic-ratelimit-tokens-remaining']) || 0,
            reset: headers['anthropic-ratelimit-tokens-reset'] || '',
        },
    };
}

// ── Usage normalization ─────────────────────────────────────────────────────

function normalizeUsage(usage) {
    if (!usage) return { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
    return {
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        cacheRead: usage.cache_read_input_tokens || 0,
        cacheWrite: usage.cache_creation_input_tokens || 0,
    };
}

// ── Vision ──────────────────────────────────────────────────────────────────

function formatVision(base64, mediaType) {
    return {
        type: 'image',
        source: {
            type: 'base64',
            media_type: mediaType || 'image/jpeg',
            data: base64,
        },
    };
}

// ── Connection test ─────────────────────────────────────────────────────────

const testEndpoint = { hostname: 'api.anthropic.com', path: '/v1/models', method: 'GET' };

// ── Export adapter ──────────────────────────────────────────────────────────

module.exports = {
    id: 'claude',
    name: 'Claude (Anthropic)',

    // Connection
    endpoint,
    testEndpoint,
    buildHeaders,
    streamProtocol,

    // Message translation
    toApiMessages,
    fromApiResponse,
    formatSystemPrompt,
    formatTools,
    formatRequest,
    formatVision,

    // Error & usage
    classifyError,
    classifyNetworkError,
    normalizeUsage,
    parseRateLimitHeaders,

    // Capabilities
    supportsCache: true,
    authTypes: ['api_key', 'setup_token'],
};
