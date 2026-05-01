// SeekerClaw — providers/openrouter.js
// OpenRouter provider adapter. Translates between neutral internal
// message format and OpenAI Chat Completions format (/api/v1/chat/completions).
// OpenRouter provides access to 100+ models through a single endpoint.
// Uses top-level cache_control for automatic prompt caching across providers.

const { log, OPENROUTER_FALLBACK_MODEL } = require('../config');
const { logSuppression, SUPPRESSION_REASONS } = require('../reasoning-gating');

// ── Neutral ↔ Chat Completions message translation ─────────────────────────

/**
 * Convert neutral internal messages to Chat Completions `messages` array.
 *
 * Neutral:
 *   { role:'user', content:'text' }
 *   { role:'assistant', content:'text', toolCalls:[{id,name,input}] }
 *   { role:'tool', toolCallId:'tc_1', content:'...' }
 *
 * Chat Completions:
 *   { role:'user', content:'text' }
 *   { role:'assistant', content:'text', tool_calls:[{id, type:'function', function:{name,arguments}}] }
 *   { role:'tool', tool_call_id:'tc_1', content:'...' }
 */
// BAT-549 R1 of Commit 2a Copilot: gating that the Custom adapter uses
// must also apply to NATIVE OpenRouter when the user configures a
// DeepSeek-flavored model (`deepseek/deepseek-r1-0528` etc.). The
// detect helper recognises both `deepseek/...` OR-prefixed ids and
// bare `deepseek-...` ids.
//
// R2-of-2a Copilot: scope clarified. The gating decision below applies
// ONLY to the bare `reasoning_content` field (DeepSeek-flavored,
// where R1 rejects echo with 400). The `reasoning_details[]` array is
// OpenRouter's NORMALIZED reasoning shape — provider-agnostic, with
// format-discriminator entries that OpenRouter expects to round-trip
// verbatim. We always echo `reasoning_details[]` when present (never
// gated). Per OpenRouter's docs this is the contract regardless of
// underlying model family.
const { detectCustomEchoBehavior } = require('../reasoning-gating');

function toApiMessages(messages, activeModel, requestOptions) {
    const out = [];

    // Per-request echo policy for the bare `reasoning_content` field only.
    // - R1 → 'strip' (server returns 400 if echoed)
    // - V4 → 'echo-on-tool-loop' (server returns 400 if NOT echoed)
    // - unknown → 'unknown' (capture-only — don't risk a 400 by echoing
    //   a bare reasoning_content field on a model whose contract we
    //   haven't tested)
    //
    // Native (non-Custom-delegated) gating uses override=false so a
    // stale `customEchoReasoning=true` flag from a prior Custom session
    // doesn't change behavior on native OpenRouter sessions. The
    // override is per-Custom-config-tuple by design (see
    // CustomConfigSignature).
    const nativeEchoBehavior = detectCustomEchoBehavior(activeModel, false);
    // Per-Custom-delegated gating respects the user's override toggle
    // (R15 Copilot). When Custom delegates to OpenRouter (chat-
    // completions format) AND the user has enabled "Echo reasoning
    // to gateway" for an unknown model id, we promote 'unknown' to
    // 'echo-on-tool-loop' for THAT specific block class only — keyed
    // on `delegateAdapter === 'openrouter'` so we never let a
    // Custom-only flag affect native OpenRouter blocks even within
    // the same conversation history.
    const customOverride = !!(requestOptions
        && requestOptions.customEchoOverride === true);
    const customDelegatedEchoBehavior = detectCustomEchoBehavior(activeModel, customOverride);

    for (const msg of messages) {
        if (msg.role === 'tool') {
            out.push({
                role: 'tool',
                tool_call_id: msg.toolCallId,
                content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            });
            continue;
        }

        if (msg.role === 'assistant') {
            const entry = { role: 'assistant' };

            // Handle legacy Claude-native arrays (from checkpoints)
            if (Array.isArray(msg.content)) {
                const textParts = msg.content
                    .filter(b => b.type === 'text' && b.text)
                    .map(b => b.text);
                entry.content = textParts.join('') || null;
                // Convert Claude-native tool_use blocks → Chat Completions tool_calls
                const toolUseBlocks = msg.content.filter(b => b.type === 'tool_use');
                if (toolUseBlocks.length > 0) {
                    entry.tool_calls = toolUseBlocks.map(b => ({
                        id: b.id,
                        type: 'function',
                        function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
                    }));
                }
            } else {
                entry.content = msg.content || null;
            }

            // Neutral format: toolCalls as separate array
            if (msg.toolCalls && msg.toolCalls.length > 0) {
                entry.tool_calls = msg.toolCalls.map(tc => ({
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: JSON.stringify(tc.input || {}) },
                }));
            }

            // BAT-549 (v4.1 Codex finding 6): reasoning_details[] attaches
            // to the assistant message INSIDE messages[], not request top-
            // level. Echo every block whose source adapter (or delegated
            // adapter, when invoked from Custom) is openrouter — these are
            // the wire payloads OpenRouter expects to round-trip verbatim.
            // Custom's stripReasoningForCustomGating clears reasoningBlocks
            // upstream when DeepSeek R1 / unknown models are configured.
            if (Array.isArray(msg.reasoningBlocks) && msg.reasoningBlocks.length > 0) {
                const details = [];
                let plainReasoningContent = null;
                for (const blk of msg.reasoningBlocks) {
                    if (!blk || !blk.wire) continue;
                    // R11 thread 1: validate wire is a plain object before
                    // dereferencing. A corrupted/older checkpoint (or future
                    // adapter) could store `wire` as a string, number, or
                    // array — pushing those into reasoning_details would
                    // produce an invalid request payload that the upstream
                    // provider would reject. Skip anything that isn't a
                    // plain object.
                    if (typeof blk.wire !== 'object' || Array.isArray(blk.wire)) continue;
                    const srcOk = blk.sourceAdapter === 'openrouter'
                        || blk.delegateAdapter === 'openrouter';
                    if (!srcOk) continue;
                    // R15 Copilot: pick the gating behavior keyed on
                    // whether this is a Custom-delegated block. Custom-
                    // delegated blocks (delegateAdapter==='openrouter')
                    // honor the per-Custom override; native OpenRouter
                    // blocks ignore it (override is per-Custom-config-tuple
                    // by design).
                    const blockEchoBehavior = blk.delegateAdapter === 'openrouter'
                        ? customDelegatedEchoBehavior
                        : nativeEchoBehavior;
                    // OpenRouter native shape — push verbatim
                    if (blk.wire.reasoning_content === undefined) {
                        details.push(blk.wire);
                    } else if (typeof blk.wire.reasoning_content === 'string') {
                        // DeepSeek-via-OpenRouter style — emit the field at message
                        // level (chat-completions DeepSeek expects this on the
                        // assistant turn alongside tool_calls). R1-of-2a Copilot:
                        // gate by model. R1 family rejects echoed reasoning_content
                        // with 400; V4 family requires it; unknown stays
                        // capture-only. Custom is fine here too because
                        // stripReasoningForCustomGating clears reasoningBlocks
                        // upstream when the Custom-side gating says strip — we
                        // only see blocks that survived that filter.
                        if (blockEchoBehavior === 'echo-on-tool-loop') {
                            plainReasoningContent = blk.wire.reasoning_content;
                        }
                        // 'strip' or 'unknown' → silently drop reasoning_content
                        // from this request. The block stays in checkpoint state
                        // for forensics and future re-evaluation.
                    }
                }
                if (details.length > 0) entry.reasoning_details = details;
                if (plainReasoningContent !== null) entry.reasoning_content = plainReasoningContent;
            }

            out.push(entry);
            continue;
        }

        if (msg.role === 'user') {
            if (typeof msg.content === 'string') {
                out.push({ role: 'user', content: msg.content });
            } else if (Array.isArray(msg.content)) {
                // Handle Claude-native tool_result blocks in user messages
                const toolResults = msg.content.filter(b => b.type === 'tool_result');
                const otherBlocks = msg.content.filter(b => b.type !== 'tool_result');

                for (const tr of toolResults) {
                    const output = typeof tr.content === 'string'
                        ? tr.content
                        : Array.isArray(tr.content)
                            ? tr.content.filter(b => b.type === 'text').map(b => b.text).join('')
                            : JSON.stringify(tr.content || '');
                    out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: output });
                }

                // Vision or multi-part content (non-tool blocks)
                if (otherBlocks.length > 0) {
                    const parts = otherBlocks.map(block => {
                        if (block.type === 'text') return { type: 'text', text: block.text };
                        if (block.type === 'image') {
                            const mediaType = block.source?.media_type || 'image/jpeg';
                            const data = block.source?.data || '';
                            return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } };
                        }
                        if (block.type === 'image_url') return block;
                        return { type: 'text', text: JSON.stringify(block) };
                    });
                    out.push({ role: 'user', content: parts });
                }
            } else {
                out.push({ role: 'user', content: String(msg.content || '') });
            }
        }
    }

    return out;
}

/**
 * Parse Chat Completions response into neutral format.
 * Works for both streamed (accumulated) and non-streamed responses.
 *
 * BAT-549: also captures reasoning content from the response message into
 * `reasoningBlocks` (raw wire payloads, never re-normalized — Codex v3
 * finding). Captures both shapes that show up here:
 *  - `message.reasoning_details[]` — native OpenRouter sum-type with `format`
 *    discriminator; echoed verbatim on the next request
 *  - `message.reasoning_content` (string) — DeepSeek-style; surfaces here
 *    when Custom delegates Chat Completions to OpenRouter pointed at DeepSeek
 *
 * Both are stamped with `provider: 'openrouter'`. The Custom adapter wraps
 * this and re-stamps to `provider: 'custom'` per v4.1 finding 5 — this
 * function is the canonical OpenRouter parse path; Custom is responsible for
 * its own re-stamping.
 */
function fromApiResponse(raw) {
    const choice = raw.choices?.[0];
    if (!choice) return { text: null, toolCalls: [], reasoningBlocks: [], stopReason: 'end_turn', usage: raw.usage || {} };

    const message = choice.message || {};
    const text = message.content || null;

    const toolCalls = (message.tool_calls || []).map((tc, idx) => {
        let input = {};
        try {
            const rawArgs = tc.function?.arguments;
            input = typeof rawArgs === 'string'
                ? JSON.parse(rawArgs)
                : (rawArgs || {});
        } catch (e) {
            log(`[OpenRouter] Failed to parse tool arguments for ${tc.function?.name}: ${e.message}`, 'WARN');
        }
        return { id: tc.id || `tc_or_${idx}`, name: tc.function?.name || 'unknown', input };
    });

    // BAT-549: capture reasoning content verbatim into reasoningBlocks.
    // Two shapes show up on this code path:
    //   1. message.reasoning_details[] — native OpenRouter sum-type
    //   2. message.reasoning_content   — DeepSeek (when Custom delegates here)
    // Both stored with raw `wire` preserved; the Custom adapter wraps and
    // re-stamps provider/sourceAdapter on its own pass.
    const reasoningBlocks = [];
    const turnId = raw.id || message.id || null;
    if (Array.isArray(message.reasoning_details) && message.reasoning_details.length > 0) {
        for (const detail of message.reasoning_details) {
            reasoningBlocks.push({
                schemaVersion: 1,
                provider: 'openrouter',
                sourceAdapter: 'openrouter',
                sourceModel: raw.model || null,
                turnId,
                wire: detail,
            });
        }
    }
    if (typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0) {
        // DeepSeek-style reasoning; preserve verbatim — Custom wrapper will
        // re-stamp `provider: 'custom'` and apply model-gating before echo.
        reasoningBlocks.push({
            schemaVersion: 1,
            provider: 'openrouter',
            sourceAdapter: 'openrouter',
            sourceModel: raw.model || null,
            turnId,
            wire: { reasoning_content: message.reasoning_content },
        });
    }

    // Map finish_reason → neutral stopReason
    const fr = choice.finish_reason;
    let stopReason = 'end_turn';
    if (toolCalls.length > 0 || fr === 'tool_calls') stopReason = 'tool_use';
    else if (fr === 'length') stopReason = 'max_tokens';
    else if (fr === 'content_filter') stopReason = 'content_filter';

    return { text, toolCalls, reasoningBlocks, stopReason, usage: raw.usage || {} };
}

// ── System prompt ───────────────────────────────────────────────────────────

/**
 * Format system prompt for Chat Completions.
 * Returns plain string — goes into {role:'system'} message in formatRequest().
 * Prompt caching is handled by top-level cache_control in formatRequest(),
 * NOT per-block in the system message.
 */
function formatSystemPrompt(stable, dynamic) {
    if (typeof dynamic === 'string' && dynamic.trim()) {
        return stable + '\n\n' + dynamic;
    }
    return stable;
}

// ── Tool schema formatting ──────────────────────────────────────────────────

/**
 * Format tools for Chat Completions API.
 * Uses nested {function: {name, description, parameters}} wrapper
 * (different from Responses API flat format).
 */
function formatTools(tools) {
    if (!tools || tools.length === 0) return [];
    return tools.map(tool => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.input_schema || { type: 'object', properties: {} },
        },
    }));
}

// ── API request building ────────────────────────────────────────────────────

/**
 * Build Chat Completions request body.
 * System prompt goes as first message with role:'system'.
 * Top-level cache_control enables automatic prompt caching across
 * supported providers (Anthropic, DeepSeek, Gemini, Grok, Groq).
 * Providers that don't support caching silently ignore it.
 */
function formatRequest(model, maxTokens, systemPrompt, messages, tools, requestOptions) {
    const body = {
        model,
        stream: true,
        max_tokens: maxTokens,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        cache_control: { type: 'ephemeral' },
    };
    if (tools && tools.length > 0) body.tools = tools;

    // BAT-549 Commit 3c: emit `reasoning:{effort:"medium"}` only when both
    // the user toggle is on AND the registry confirms the model supports
    // it. OpenRouter is freeform in the registry resolver — `reasoningSupport`
    // resolves to "unknown" for every OR-prefixed model ID, so the toggle
    // is currently a no-op on OpenRouter. The branch lives here so a future
    // build that learns specific OR model IDs (e.g. registering
    // `openai/gpt-5.4` under the openrouter provider with reasoningSupport:
    // "yes") can flip it on without further adapter changes. Until then
    // OpenRouter relies on the OR-side default behavior of any reasoning
    // models the user picks (most pass through provider defaults).
    //
    // BAT-558 v4 R3 — `reasoningMode: 'off'` (heartbeats / synthetic) emits
    // `body.reasoning = { effort: 'none' }` as an EXPLICIT app-controlled
    // disablement signal per OpenRouter's reasoning docs
    // (https://openrouter.ai/docs/use-cases/reasoning-tokens). This is
    // STRONGER than just omitting the field because some OR reasoning
    // models reason by default — the `reasoning` key IS sent, carrying
    // the disable signal. Beats the "off=omit" naive approach for OR.
    //
    // Take precedence over the user-toggle branch below: if both
    // `reasoningMode==='off'` AND `reasoningEnabled===true` somehow
    // coexist (shouldn't happen at the chat() boundary, defensive),
    // the off signal wins because the caller marked the turn synthetic.
    const reasoningOff = !!(requestOptions && requestOptions.reasoningMode === 'off');
    if (reasoningOff) {
        body.reasoning = { effort: 'none' };
        logSuppression(
            SUPPRESSION_REASONS.OPENROUTER_EFFORT_NONE,
            `model=${model}`,
        );
    } else if (requestOptions
        && requestOptions.reasoningEnabled === true
        && requestOptions.reasoningSupport === 'yes') {
        body.reasoning = { effort: 'medium' };
    }

    // Model fallback: if configured, use models array for auto-failover.
    // OpenRouter tries the first model, falls back on context errors,
    // rate limits, moderation blocks, or provider downtime.
    if (OPENROUTER_FALLBACK_MODEL) {
        body.models = [model, OPENROUTER_FALLBACK_MODEL];
        delete body.model;
        body.route = 'fallback';
    }

    return JSON.stringify(body);
}

// ── Connection details ──────────────────────────────────────────────────────

const endpoint = { hostname: 'openrouter.ai', path: '/api/v1/chat/completions' };

function buildHeaders(apiKey) {
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://seekerclaw.com',
        'X-Title': 'SeekerClaw',
    };
}

// ── Streaming ───────────────────────────────────────────────────────────────
// Chat Completions uses simple data-only SSE (no typed event: lines).
// Chunks: data: {"choices":[{"delta":{"content":"..."}}]}
// Termination: data: [DONE]
// Keepalive: ": OPENROUTER PROCESSING" comment lines (ignored per SSE spec)

const streamProtocol = 'chat-completions';

// ── Error classification ────────────────────────────────────────────────────

function classifyError(status, data) {
    if (status === 401) {
        return {
            type: 'auth', retryable: false,
            userMessage: '🔑 OpenRouter API key is invalid. Check Settings?'
        };
    }
    if (status === 402) {
        return {
            type: 'billing', retryable: false,
            userMessage: 'OpenRouter credits exhausted. Add credits at openrouter.ai/credits'
        };
    }
    if (status === 403) {
        const reasons = data?.error?.metadata?.reasons;
        const detail = Array.isArray(reasons) ? `: ${reasons.join(', ')}` : '';
        return {
            type: 'moderation', retryable: false,
            userMessage: `Message flagged by content moderation${detail}`
        };
    }
    if (status === 404) {
        const msg = data?.error?.message || '';
        const userMessage = /image|vision|multimodal/i.test(msg)
            ? 'This model does not support image/vision input. Try a vision-capable model.'
            : 'Model not found on OpenRouter. Check the model ID in Settings.';
        return { type: 'model_not_found', retryable: false, userMessage };
    }
    if (status === 408) {
        return {
            type: 'timeout', retryable: true,
            userMessage: 'OpenRouter request timed out. Retrying...'
        };
    }
    if (status === 413) {
        return {
            type: 'payload_too_large', retryable: false,
            userMessage: 'Request too large — try shortening the conversation or using a model with a larger context window.'
        };
    }
    if (status === 429) {
        return {
            type: 'rate_limit', retryable: true,
            userMessage: '⏳ Rate limited by OpenRouter. Trying again in a moment...'
        };
    }
    if (status === 502) {
        const provider = data?.error?.metadata?.provider_name || 'upstream provider';
        return {
            type: 'provider_down', retryable: true,
            userMessage: `${provider} is temporarily down. Retrying...`
        };
    }
    if (status === 503) {
        return {
            type: 'no_provider', retryable: true,
            userMessage: 'No provider available for this model right now. Retrying...'
        };
    }
    if (status >= 500 && status < 600) {
        return {
            type: 'server', retryable: true,
            userMessage: 'OpenRouter is temporarily unavailable. Retrying...'
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
        return { type: 'dns', userMessage: 'Cannot reach OpenRouter — check your internet connection.' };
    }
    if (/ECONNREFUSED|ECONNRESET|EPIPE/i.test(raw)) {
        return { type: 'connection', userMessage: 'Connection to OpenRouter was lost. Please try again.' };
    }
    return { type: 'network', userMessage: 'A network error occurred. Please try again.' };
}

// ── Rate limit headers ──────────────────────────────────────────────────────

function parseRateLimitHeaders(headers) {
    // OpenRouter doesn't document specific rate limit headers
    return { tokensRemaining: Infinity, tokensReset: '', requests: {}, tokens: {} };
}

// ── Usage normalization ─────────────────────────────────────────────────────

function normalizeUsage(usage) {
    if (!usage) return { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
    return {
        inputTokens: usage.prompt_tokens || 0,
        outputTokens: usage.completion_tokens || 0,
        cacheRead: usage.prompt_tokens_details?.cached_tokens || 0,
        cacheWrite: usage.prompt_tokens_details?.cache_write_tokens || 0,
    };
}

// ── Vision ──────────────────────────────────────────────────────────────────

function formatVision(base64, mediaType) {
    return {
        type: 'image_url',
        image_url: { url: `data:${mediaType || 'image/jpeg'};base64,${base64}` },
    };
}

// ── Connection test ─────────────────────────────────────────────────────────

// /api/v1/models is public (returns 200 for any key). Use /api/v1/auth/key to validate.
const testEndpoint = { hostname: 'openrouter.ai', path: '/api/v1/auth/key', method: 'GET' };

// ── Export adapter ──────────────────────────────────────────────────────────

module.exports = {
    id: 'openrouter',
    name: 'OpenRouter',

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
    authTypes: ['api_key'],
};
