// SeekerClaw — providers/openrouter.js
// OpenRouter provider adapter. Translates between neutral internal
// message format and OpenAI Chat Completions format (/api/v1/chat/completions).
// OpenRouter provides access to 100+ models through a single endpoint.
// Uses top-level cache_control for automatic prompt caching across providers.

const { log, OPENROUTER_FALLBACK_MODEL } = require('../config');

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
function toApiMessages(messages) {
    const out = [];

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
 */
function fromApiResponse(raw) {
    const choice = raw.choices?.[0];
    if (!choice) return { text: null, toolCalls: [], stopReason: 'end_turn', usage: raw.usage || {} };

    const message = choice.message || {};
    const text = message.content || null;

    const toolCalls = (message.tool_calls || []).map(tc => {
        let input = {};
        try {
            input = typeof tc.function?.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : (tc.function?.arguments || {});
        } catch (e) {
            log(`[OpenRouter] Failed to parse tool arguments for ${tc.function?.name}: ${e.message}`, 'WARN');
        }
        return { id: tc.id, name: tc.function?.name || 'unknown', input };
    });

    // Map finish_reason → neutral stopReason
    const fr = choice.finish_reason;
    let stopReason = 'end_turn';
    if (toolCalls.length > 0 || fr === 'tool_calls') stopReason = 'tool_use';
    else if (fr === 'length') stopReason = 'max_tokens';
    else if (fr === 'content_filter') stopReason = 'content_filter';

    return { text, toolCalls, stopReason, usage: raw.usage || {} };
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
function formatRequest(model, maxTokens, systemPrompt, messages, tools) {
    const body = {
        model,
        stream: true,
        max_tokens: maxTokens,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        cache_control: { type: 'ephemeral' },
    };
    if (tools && tools.length > 0) body.tools = tools;

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
        'HTTP-Referer': 'https://seekerclaw.xyz',
        'X-OpenRouter-Title': 'SeekerClaw',
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
        return {
            type: 'model_not_found', retryable: false,
            userMessage: 'Model not found on OpenRouter. Check the model ID in Settings.'
        };
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
