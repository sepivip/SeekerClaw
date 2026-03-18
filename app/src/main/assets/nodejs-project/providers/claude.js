// SeekerClaw — providers/claude.js
// Claude (Anthropic) provider adapter. Translates between neutral internal
// message format and Claude Messages API format.

const { log } = require('../config');

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
            // If content is already a Claude-native array (legacy checkpoint), pass through
            if (Array.isArray(msg.content)) {
                out.push({ role: 'assistant', content: msg.content });
                continue;
            }
            const content = [];
            if (msg.content) {
                content.push({ type: 'text', text: msg.content });
            }
            if (msg.toolCalls && msg.toolCalls.length > 0) {
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
 * @returns {{ text: string|null, toolCalls: Array, stopReason: string, usage: object }}
 */
function fromApiResponse(raw) {
    const content = raw.content || [];
    const textParts = content.filter(c => c.type === 'text').map(c => c.text);
    const text = textParts.length > 0 ? textParts.join('\n') : null;

    const toolCalls = content
        .filter(c => c.type === 'tool_use')
        .map(c => ({ id: c.id, name: c.name, input: c.input || {} }));

    return {
        text,
        toolCalls,
        stopReason: raw.stop_reason || 'end_turn',
        usage: raw.usage || {},
    };
}

// ── Billing attribution (required for OAuth/setup-token access to non-Haiku models) ─

const CC_BILLING_HEADER = 'x-anthropic-billing-header: cc_version=2.1.78; cc_entrypoint=cli; cch=00000;';

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
 */
function formatRequest(model, maxTokens, systemBlocks, messages, tools) {
    const body = {
        model,
        max_tokens: maxTokens,
        stream: true,
        system: systemBlocks,
        messages,
    };
    if (tools && tools.length > 0) body.tools = tools;
    return JSON.stringify(body);
}

// ── Connection details ──────────────────────────────────────────────────────

const endpoint = { hostname: 'api.anthropic.com', path: '/v1/messages' };

function buildHeaders(apiKey, authType) {
    const auth = authType === 'setup_token'
        ? { 'Authorization': `Bearer ${apiKey}` }
        : { 'x-api-key': apiKey };

    return {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': authType === 'setup_token'
            ? 'prompt-caching-2024-07-31,oauth-2025-04-20'
            : 'prompt-caching-2024-07-31',
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
