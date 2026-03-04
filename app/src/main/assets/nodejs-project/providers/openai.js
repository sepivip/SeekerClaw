// SeekerClaw — providers/openai.js
// OpenAI provider adapter. Translates between neutral internal
// message format and OpenAI Chat Completions API format.

const { log } = require('../config');

// ── Neutral ↔ OpenAI message translation ────────────────────────────────────

/**
 * Convert neutral internal messages to OpenAI API messages format.
 *
 * Key differences from Claude:
 * - System prompt goes as role:'developer' message (prepended by caller)
 * - Tool calls use { tool_calls: [{type:'function', function:{name, arguments: JSON_STRING}}] }
 * - Tool results are individual messages with role:'tool', NOT grouped in user message
 * - Text content is a plain string, not content block array
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
            const apiMsg = { role: 'assistant' };
            apiMsg.content = msg.content || null;

            if (msg.toolCalls && msg.toolCalls.length > 0) {
                apiMsg.tool_calls = msg.toolCalls.map(tc => ({
                    id: tc.id,
                    type: 'function',
                    function: {
                        name: tc.name,
                        arguments: JSON.stringify(tc.input || {}),
                    },
                }));
            }
            out.push(apiMsg);
            continue;
        }

        if (msg.role === 'user') {
            if (typeof msg.content === 'string') {
                out.push({ role: 'user', content: msg.content });
            } else if (Array.isArray(msg.content)) {
                // Vision or multi-part content — translate content blocks
                const parts = msg.content.map(block => {
                    if (block.type === 'text') return { type: 'text', text: block.text };
                    if (block.type === 'image') {
                        // Convert from Claude vision format to OpenAI format
                        const mediaType = block.source?.media_type || 'image/jpeg';
                        const data = block.source?.data || '';
                        return {
                            type: 'image_url',
                            image_url: { url: `data:${mediaType};base64,${data}` },
                        };
                    }
                    if (block.type === 'image_url') return block; // already OpenAI format
                    return { type: 'text', text: JSON.stringify(block) };
                });
                out.push({ role: 'user', content: parts });
            } else {
                out.push({ role: 'user', content: String(msg.content || '') });
            }
        }
    }

    return out;
}

/**
 * Parse OpenAI API response into neutral format.
 * Works with both streaming-accumulated and non-streaming responses.
 */
function fromApiResponse(raw) {
    const choice = raw.choices?.[0];
    if (!choice) {
        return { text: null, toolCalls: [], stopReason: 'end_turn', usage: raw.usage || {} };
    }

    const message = choice.message || choice.delta || {};
    const text = message.content || null;

    const toolCalls = (message.tool_calls || []).map(tc => {
        let input = {};
        try {
            input = typeof tc.function?.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : (tc.function?.arguments || {});
        } catch (e) {
            log(`[OpenAI] Failed to parse tool arguments for ${tc.function?.name}: ${e.message}`, 'WARN');
        }
        return {
            id: tc.id,
            name: tc.function?.name || 'unknown',
            input,
        };
    });

    // Map OpenAI finish_reason → neutral stopReason
    const finishReason = choice.finish_reason || '';
    let stopReason = 'end_turn';
    if (finishReason === 'tool_calls') stopReason = 'tool_use';
    else if (finishReason === 'length') stopReason = 'max_tokens';
    else if (finishReason === 'stop') stopReason = 'end_turn';

    return { text, toolCalls, stopReason, usage: raw.usage || {} };
}

// ── System prompt ───────────────────────────────────────────────────────────

/**
 * Format system prompt for OpenAI API.
 * OpenAI uses a 'developer' role message (preferred over 'system' for newer models).
 * No prompt caching support — combine stable + dynamic into one message.
 */
function formatSystemPrompt(stable, dynamic) {
    return { role: 'developer', content: stable + '\n\n' + dynamic };
}

// ── Tool schema formatting ──────────────────────────────────────────────────

/**
 * Format tools for OpenAI API.
 * Claude format: { name, description, input_schema }
 * OpenAI format: { type:'function', function:{ name, description, parameters } }
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
 * Build full OpenAI API request body.
 * All current OpenAI models (GPT-5.x, o-series, codex) use max_completion_tokens.
 */
function formatRequest(model, maxTokens, systemPromptMsg, messages, tools) {
    const body = {
        model,
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: maxTokens,
        messages: [systemPromptMsg, ...messages],
    };

    if (tools && tools.length > 0) {
        body.tools = tools;
    }

    return JSON.stringify(body);
}

// ── Connection details ──────────────────────────────────────────────────────

const endpoint = { hostname: 'api.openai.com', path: '/v1/chat/completions' };

function buildHeaders(apiKey) {
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
    };
}

// ── Streaming ───────────────────────────────────────────────────────────────
// OpenAI uses a simpler SSE format:
//   data: {"choices":[{"delta":{"content":"..."}}]}
//   data: {"choices":[{"delta":{"tool_calls":[...]}}]}
//   data: [DONE]
// Tool call arguments stream incrementally — we must accumulate them.

const streamProtocol = 'openai';

// ── Error classification ────────────────────────────────────────────────────

function classifyError(status, data) {
    if (status === 401 || status === 403) {
        return {
            type: 'auth', retryable: false,
            userMessage: '🔑 Can\'t reach the AI — OpenAI API key might be wrong. Check Settings?'
        };
    }
    if (status === 402) {
        return {
            type: 'billing', retryable: false,
            userMessage: 'Your OpenAI account needs attention — check billing at platform.openai.com'
        };
    }
    if (status === 429) {
        const msg = data?.error?.message || '';
        if (/quota|insufficient_quota/i.test(msg)) {
            return {
                type: 'quota', retryable: false,
                userMessage: 'OpenAI quota exceeded. Check your billing at platform.openai.com'
            };
        }
        return {
            type: 'rate_limit', retryable: true,
            userMessage: '⏳ Got rate limited. Trying again in a moment...'
        };
    }
    if (status >= 500 && status < 600) {
        return {
            type: 'server', retryable: true,
            userMessage: 'OpenAI API is temporarily unavailable. Retrying...'
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
        return { type: 'dns', userMessage: 'Cannot reach OpenAI — check your internet connection.' };
    }
    if (/ECONNREFUSED|ECONNRESET|EPIPE/i.test(raw)) {
        return { type: 'connection', userMessage: 'Connection to OpenAI was lost. Please try again.' };
    }
    return { type: 'network', userMessage: 'A network error occurred. Please try again.' };
}

// ── Rate limit headers ──────────────────────────────────────────────────────

function parseRateLimitHeaders(headers) {
    if (!headers) return { tokensRemaining: Infinity, tokensReset: '' };
    const remaining = parseInt(headers['x-ratelimit-remaining-tokens'], 10);
    // OpenAI reset is a duration like "120ms" or "6s" — convert to absolute ISO timestamp
    // so claude.js rate-limit pre-check (which uses new Date(tokensReset)) works uniformly
    const resetStr = headers['x-ratelimit-reset-tokens'] || '';
    let tokensReset = '';
    if (resetStr) {
        let ms = 0;
        const secMatch = resetStr.match(/([\d.]+)s/);
        const msMatch = resetStr.match(/([\d.]+)ms/);
        if (secMatch) ms += parseFloat(secMatch[1]) * 1000;
        if (msMatch) ms += parseFloat(msMatch[1]);
        if (ms > 0) tokensReset = new Date(Date.now() + ms).toISOString();
    }
    return {
        tokensRemaining: Number.isFinite(remaining) ? remaining : Infinity,
        tokensReset,
        requests: {
            limit: parseInt(headers['x-ratelimit-limit-requests']) || 0,
            remaining: parseInt(headers['x-ratelimit-remaining-requests']) || 0,
            reset: headers['x-ratelimit-reset-requests'] || '',
        },
        tokens: {
            limit: parseInt(headers['x-ratelimit-limit-tokens']) || 0,
            remaining: parseInt(headers['x-ratelimit-remaining-tokens']) || 0,
            reset: resetStr,
        },
    };
}

// ── Usage normalization ─────────────────────────────────────────────────────

function normalizeUsage(usage) {
    if (!usage) return { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
    return {
        inputTokens: usage.prompt_tokens || 0,
        outputTokens: usage.completion_tokens || 0,
        cacheRead: usage.prompt_tokens_details?.cached_tokens || 0,
        cacheWrite: 0, // OpenAI doesn't report cache write separately
    };
}

// ── Vision ──────────────────────────────────────────────────────────────────

function formatVision(base64, mediaType) {
    return {
        type: 'image_url',
        image_url: {
            url: `data:${mediaType || 'image/jpeg'};base64,${base64}`,
        },
    };
}

// ── Connection test ─────────────────────────────────────────────────────────

const testEndpoint = { hostname: 'api.openai.com', path: '/v1/models', method: 'GET' };

// ── Export adapter ──────────────────────────────────────────────────────────

module.exports = {
    id: 'openai',
    name: 'OpenAI',

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
    supportsCache: false,
    authTypes: ['api_key'],
};
