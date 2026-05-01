// SeekerClaw — providers/claude.js
// Claude (Anthropic) provider adapter. Translates between neutral internal
// message format and Claude Messages API format.

const { log } = require('../config');
const { logSuppression, SUPPRESSION_REASONS } = require('../reasoning-gating');

// BAT-558 R1 — Claude extended-thinking clamp constants.
//
// Anthropic Messages API requires `thinking.budget_tokens < max_tokens`,
// AND the thinking budget itself has a 1024-token floor. A naive
// `min(DEFAULT, max_tokens - 1)` formula satisfies the validator but
// can leave only single-digit tokens for the actual response on small
// turns — useless. The `* 0.5` rule below splits the budget so every
// emitted thinking turn has at least `ANTHROPIC_MIN_BUDGET` tokens for
// thinking AND at least `MIN_THINKING_TURN - ANTHROPIC_MIN_BUDGET`
// tokens left over for the final answer.
//
// The `MIN_THINKING_TURN < 2048 → omit thinking` short-circuit is the
// load-bearing piece. Without it, a `max_tokens=1100` turn would emit
// `budget_tokens=1024` and have 76 tokens for the answer — technically
// valid Anthropic API, useless to the user. Skipping thinking entirely
// for these small turns is the contract Codex signed off on (v3
// amendment 1, ratified into v4).
//
// Practical sizing examples (max_tokens × 0.5, clamped to [1024, 16000]):
//   1024 → omit (below MIN_THINKING_TURN floor)
//   1536 → omit (below MIN_THINKING_TURN floor; v3 gap-case)
//   2048 → 1024 budget, 1024 answer room
//   4096 → 2048 budget, 2048 answer room (the heartbeat case)
//   32000 → 16000 budget (DEFAULT_THINKING_BUDGET cap kicks in)
const ANTHROPIC_MIN_BUDGET = 1024;
const DEFAULT_THINKING_BUDGET = 16000;
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
        // submit nonsense: thinking needs string `thinking` + signature;
        // redacted_thinking needs string `data`.
        if (t === 'thinking' && (typeof blk.wire.thinking !== 'string' || typeof blk.wire.signature !== 'string')) continue;
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

const CC_BILLING_HEADER = 'x-anthropic-billing-header: cc_version=2.1.116; cc_entrypoint=cli; cch=00000;';

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
 * (`reasoningSupport === "yes"`). BAT-558 v4 R1 layered a request-level
 * BUDGET CLAMP on top of that: the budget must be `< max_tokens` per
 * Anthropic, and `>= 1024` per Anthropic's thinking-budget floor — so
 * the budget is sized as `floor(maxTokens * 0.5)` clamped to
 * `[ANTHROPIC_MIN_BUDGET, DEFAULT_THINKING_BUDGET]`, and turns with
 * `maxTokens < MIN_THINKING_TURN` (2048) skip thinking entirely so the
 * answer always has at least `ANTHROPIC_MIN_BUDGET` tokens of room.
 *
 * Pre-clamp, this code emitted `budget_tokens=16000` regardless of
 * `max_tokens`. ai.js calls `formatRequest(..., 4096, ...)` for normal
 * chat, which Anthropic rejects with HTTP 400 ("max_tokens must be
 * greater than thinking.budget_tokens"). The heartbeat path hit it
 * first because the watchdog made the 400s visible; real user chats
 * with Extended thinking on were silently failing too.
 *
 * BAT-558 v4 R3 also adds `reasoningMode: 'off'` short-circuit — when
 * the caller (heartbeat / future synthetic turns) marks the request
 * as opted out of app-controlled reasoning, skip thinking even when
 * the user toggle is on. R2 documents this contract at the chat()
 * boundary; ai.js threads it through `requestOptions` per BAT-549's
 * existing pattern.
 *
 * Existing call sites (vision/summary) that pass small `maxTokens`
 * (256, 500) or no `requestOptions` continue to emit no `thinking` —
 * additive change.
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

    // BAT-558 v4 R1 — small-turn skip. `max_tokens < 2048` doesn't have
    // headroom for both the 1024-floor budget AND a usable answer, so
    // thinking is skipped (rate-limited INFO log so the suppression is
    // discoverable in field reports without flooding the Logs screen).
    if (maxTokens < MIN_THINKING_TURN) {
        logSuppression(
            SUPPRESSION_REASONS.MAX_TOKENS_BELOW_FLOOR,
            `claude maxTokens=${maxTokens}`,
        );
        return JSON.stringify(body);
    }

    // BAT-558 v4 R1 — clamp budget to [ANTHROPIC_MIN_BUDGET,
    // DEFAULT_THINKING_BUDGET], scaled at half of `maxTokens` so the
    // final answer always has the other half. See module-level constant
    // block for the worked-examples table.
    const cap = Math.min(DEFAULT_THINKING_BUDGET, Math.floor(maxTokens * 0.5));
    const budget = Math.max(ANTHROPIC_MIN_BUDGET, cap);
    body.thinking = { type: 'enabled', budget_tokens: budget };
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
        return {
            type: 'auth', retryable: false,
            userMessage: '🔑 Can\'t reach the AI — API key might be wrong. Check Settings?'
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
