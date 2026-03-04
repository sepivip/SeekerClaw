// SeekerClaw — providers/openai.js
// OpenAI provider adapter. Translates between neutral internal
// message format and OpenAI Responses API format (/v1/responses).
// All OpenAI models route through the Responses API — future-proof
// as OpenAI transitions away from Chat Completions.

const { log } = require('../config');

// ── Neutral ↔ OpenAI Responses API message translation ──────────────────────

/**
 * Convert neutral internal messages to OpenAI Responses API `input` array.
 *
 * Key differences from Chat Completions:
 * - No `messages` array — uses `input` items
 * - Tool calls are top-level `function_call` items (not nested in assistant message)
 * - Tool results are `function_call_output` items (not role:'tool' messages)
 * - Vision uses `input_image` type (not `image_url`)
 */
function toApiMessages(messages) {
    const input = [];

    for (const msg of messages) {
        if (msg.role === 'tool') {
            // Tool results → function_call_output items
            input.push({
                type: 'function_call_output',
                call_id: msg.toolCallId,
                output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            });
            continue;
        }

        if (msg.role === 'assistant') {
            // Assistant text → message item
            if (msg.content) {
                input.push({ role: 'assistant', content: msg.content });
            }
            // Tool calls → function_call items
            if (msg.toolCalls && msg.toolCalls.length > 0) {
                for (const tc of msg.toolCalls) {
                    input.push({
                        type: 'function_call',
                        call_id: tc.id,
                        name: tc.name,
                        arguments: JSON.stringify(tc.input || {}),
                    });
                }
            }
            continue;
        }

        if (msg.role === 'user') {
            if (typeof msg.content === 'string') {
                input.push({ role: 'user', content: msg.content });
            } else if (Array.isArray(msg.content)) {
                // Vision or multi-part content
                const parts = msg.content.map(block => {
                    if (block.type === 'text') return { type: 'input_text', text: block.text };
                    if (block.type === 'image') {
                        const mediaType = block.source?.media_type || 'image/jpeg';
                        const data = block.source?.data || '';
                        return { type: 'input_image', image_url: `data:${mediaType};base64,${data}` };
                    }
                    if (block.type === 'image_url') {
                        return { type: 'input_image', image_url: block.image_url?.url || '' };
                    }
                    return { type: 'input_text', text: JSON.stringify(block) };
                });
                input.push({ role: 'user', content: parts });
            } else {
                input.push({ role: 'user', content: String(msg.content || '') });
            }
        }
    }

    return input;
}

/**
 * Parse OpenAI Responses API response into neutral format.
 * The response comes from `response.completed` SSE event or non-streaming response.
 * Shape: { id, output: [...], status, usage, ... }
 */
function fromApiResponse(raw) {
    // Handle nested response object (from response.completed event)
    const resp = raw.response || raw;

    const textParts = [];
    const toolCalls = [];

    for (const item of (resp.output || [])) {
        // Text output items
        if (item.type === 'message' && item.content) {
            for (const part of item.content) {
                if (part.type === 'output_text' && part.text) textParts.push(part.text);
            }
        }
        // Function call output items
        if (item.type === 'function_call') {
            let input = {};
            try {
                input = typeof item.arguments === 'string'
                    ? JSON.parse(item.arguments)
                    : (item.arguments || {});
            } catch (e) {
                log(`[OpenAI] Failed to parse tool arguments for ${item.name}: ${e.message}`, 'WARN');
            }
            toolCalls.push({
                id: item.call_id,
                name: item.name || 'unknown',
                input,
            });
        }
    }

    const text = textParts.length > 0 ? textParts.join('') : null;

    // Map Responses API status → neutral stopReason
    const status = resp.status || 'completed';
    let stopReason = 'end_turn';
    if (toolCalls.length > 0) {
        stopReason = 'tool_use';
    } else if (status === 'incomplete') {
        const reason = resp.incomplete_details?.reason || '';
        if (reason === 'max_output_tokens') stopReason = 'max_tokens';
        else stopReason = 'max_tokens'; // any incomplete = truncation
    }

    return { text, toolCalls, stopReason, usage: resp.usage || {} };
}

// ── System prompt ───────────────────────────────────────────────────────────

/**
 * Format system prompt for OpenAI Responses API.
 * Returns a plain string — the `instructions` field in the request body.
 * No prompt caching support — combine stable + dynamic.
 */
function formatSystemPrompt(stable, dynamic) {
    return stable + '\n\n' + dynamic;
}

// ── Tool schema formatting ──────────────────────────────────────────────────

/**
 * Format tools for OpenAI Responses API.
 * Responses API uses a FLAT format (name/description/parameters at top level),
 * NOT the nested {function: {name, ...}} format used by Chat Completions.
 */
function formatTools(tools) {
    if (!tools || tools.length === 0) return [];
    return tools.map(tool => ({
        type: 'function',
        name: tool.name,
        description: tool.description || '',
        parameters: tool.input_schema || { type: 'object', properties: {} },
        strict: false, // Responses API defaults to strict:true which requires additionalProperties:false on all schemas
    }));
}

// ── API request building ────────────────────────────────────────────────────

/**
 * Build OpenAI Responses API request body.
 * Uses `instructions` (system prompt) + `input` (messages) instead of
 * Chat Completions' `messages` array.
 */
function formatRequest(model, maxTokens, instructions, input, tools) {
    const body = {
        model,
        stream: true,
        max_output_tokens: maxTokens,
        instructions: typeof instructions === 'string' ? instructions : (instructions?.content || String(instructions)),
        input,
    };

    if (tools && tools.length > 0) {
        body.tools = tools;
    }

    // GPT-5 family models support reasoning — Codex/Pro require it for tool calling.
    // effort:'low' is the lightest setting; 'medium'/'high'/'xhigh' for deeper reasoning.
    if (model && (model.includes('codex') || model.includes('pro'))) {
        body.reasoning = { effort: 'medium', summary: 'auto' };
    }

    return JSON.stringify(body);
}

// ── Connection details ──────────────────────────────────────────────────────

const endpoint = { hostname: 'api.openai.com', path: '/v1/responses' };

function buildHeaders(apiKey) {
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
    };
}

// ── Streaming ───────────────────────────────────────────────────────────────
// Responses API uses typed SSE events:
//   event: response.output_text.delta         → text chunks
//   event: response.function_call_arguments.delta → tool arg chunks
//   event: response.completed                 → final full response
//   event: response.incomplete                → truncated response

const streamProtocol = 'openai-responses';

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
        // Responses API: input_tokens/output_tokens
        inputTokens: usage.input_tokens || usage.prompt_tokens || 0,
        outputTokens: usage.output_tokens || usage.completion_tokens || 0,
        cacheRead: usage.input_tokens_details?.cached_tokens || usage.prompt_tokens_details?.cached_tokens || 0,
        cacheWrite: 0,
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
