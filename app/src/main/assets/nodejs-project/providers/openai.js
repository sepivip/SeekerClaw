// SeekerClaw — providers/openai.js
// OpenAI provider adapter. Translates between neutral internal
// message format and OpenAI Responses API format (/v1/responses).
// All OpenAI models route through the Responses API — future-proof
// as OpenAI transitions away from Chat Completions.

const { log, OPENAI_OAUTH_TOKEN, OPENAI_OAUTH_REFRESH, OPENAI_AUTH_TYPE } = require('../config');
const { androidBridgeCall } = require('../bridge');

// Codex CLI public OAuth client id. Must stay in sync with
// app/src/main/java/com/seekerclaw/app/oauth/OpenAIOAuthActivity.kt:CLIENT_ID
// (the Node side never initiates an OAuth flow — only refreshes — so duplication
// is preferable to plumbing the value through the Android bridge.)
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

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
            // Handle Claude-native format: content is array with text/tool_use blocks
            if (Array.isArray(msg.content)) {
                const textParts = msg.content
                    .filter(b => b.type === 'text' && b.text)
                    .map(b => b.text);
                if (textParts.length > 0) {
                    input.push({ role: 'assistant', content: textParts.join('') });
                }
                // Convert Claude-native tool_use blocks → function_call items
                for (const b of msg.content) {
                    if (b.type === 'tool_use') {
                        input.push({
                            type: 'function_call',
                            call_id: b.id,
                            name: b.name,
                            arguments: JSON.stringify(b.input || {}),
                        });
                    }
                }
            } else if (msg.content) {
                // Neutral format: content is a string
                input.push({ role: 'assistant', content: msg.content });
            }
            // Neutral format: tool calls as separate array
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
                // Handle Claude-native tool_result blocks in user messages
                const toolResults = msg.content.filter(b => b.type === 'tool_result');
                const otherBlocks = msg.content.filter(b => b.type !== 'tool_result');

                // Convert tool_result blocks → function_call_output items
                for (const tr of toolResults) {
                    const output = typeof tr.content === 'string'
                        ? tr.content
                        : Array.isArray(tr.content)
                            ? tr.content.filter(b => b.type === 'text').map(b => b.text).join('')
                            : JSON.stringify(tr.content || '');
                    input.push({
                        type: 'function_call_output',
                        call_id: tr.tool_use_id,
                        output,
                    });
                }

                // Vision or multi-part content (non-tool blocks)
                if (otherBlocks.length > 0) {
                    const parts = otherBlocks.map(block => {
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
                }
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
        instructions: typeof instructions === 'string' ? instructions : (instructions?.content || String(instructions)),
        input,
    };

    // Codex endpoint rejects max_output_tokens — subscription manages limits
    if (!isOAuth) {
        body.max_output_tokens = maxTokens;
    }

    if (tools && tools.length > 0) {
        body.tools = tools;
    }

    // OAuth (Codex endpoint) requires store: false — conversations cannot be stored
    if (isOAuth) {
        body.store = false;
    }

    // Codex models are reasoning models — they need the reasoning parameter for tool calling.
    if (model && model.includes('codex')) {
        body.reasoning = { effort: 'medium', summary: 'auto' };
    }

    return JSON.stringify(body);
}

// ── Connection details ──────────────────────────────────────────────────────

const isOAuth = OPENAI_AUTH_TYPE === 'oauth';
const CODEX_API_HOST = 'chatgpt.com';
const CODEX_API_PATH = '/backend-api/codex/responses';

const endpoint = {
    hostname: isOAuth ? CODEX_API_HOST : 'api.openai.com',
    path: isOAuth ? CODEX_API_PATH : '/v1/responses',
};

let _currentOAuthToken = OPENAI_OAUTH_TOKEN;
let _currentRefreshToken = OPENAI_OAUTH_REFRESH;

function buildHeaders(apiKey) {
    const token = isOAuth ? _currentOAuthToken : apiKey;
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
    };
    // Codex backend needs Accept header for SSE streaming
    if (isOAuth) {
        headers['Accept'] = 'text/event-stream';
    }
    return headers;
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
        // OAuth 401s may be retryable after token refresh — caller must call handleUnauthorized()
        return {
            type: 'auth', retryable: isOAuth && status === 401 && !!_currentRefreshToken,
            userMessage: isOAuth
                ? '🔐 Can\'t reach the AI — your OpenAI sign-in may have expired. Please reconnect OpenAI in Settings and try again.'
                : '🔑 Can\'t reach the AI — OpenAI API key might be wrong. Check Settings?'
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

/**
 * Handle OAuth 401: attempt token refresh and signal retryable.
 * Call this when classifyError returns { retryable: true } on a 401.
 * Throws an error with retryable=true on success (caller retries),
 * or rethrows non-retryable error on refresh failure.
 */
async function handleUnauthorized() {
    if (!(isOAuth && _currentRefreshToken)) return;
    log('[OpenAI] OAuth 401 — attempting token refresh...', 'INFO');
    try {
        await refreshOAuthToken();
        log('[OpenAI] Token refreshed — caller should retry', 'INFO');
        const retryError = new Error('OAuth token refreshed — retry');
        retryError.retryable = true;
        throw retryError;
    } catch (e) {
        if (e.retryable) throw e;
        // Refresh failed — make sure caller stops retrying with the dead token.
        log('[OpenAI] OAuth refresh failed: ' + e.message, 'ERROR');
        const fatal = new Error('OAuth token refresh failed: ' + e.message);
        fatal.retryable = false;
        throw fatal;
    }
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

// ── OAuth token refresh ─────────────────────────────────────────────────────

async function refreshOAuthToken() {
    const https = require('https');
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: OAUTH_CLIENT_ID,
        refresh_token: _currentRefreshToken,
    }).toString();

    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'auth.openai.com',
            path: '/oauth/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
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
                    _currentOAuthToken = parsed.access_token;
                    if (parsed.refresh_token) _currentRefreshToken = parsed.refresh_token;
                    // Persist via bridge. androidBridgeCall always resolves — even on
                    // error — so check the resolved value rather than relying on .catch.
                    androidBridgeCall('/openai/oauth/save-tokens', {
                        accessToken: parsed.access_token,
                        refreshToken: parsed.refresh_token || _currentRefreshToken,
                        expiresAt: new Date(Date.now() + (parsed.expires_in || 28800) * 1000).toISOString(),
                    }).then(result => {
                        if (result && result.error) {
                            log('[OpenAI] Failed to persist refreshed tokens: ' + result.error, 'WARN');
                        }
                    });
                    resolve(true);
                    return;
                }

                if (parsed) {
                    // JSON error response — surface error_description/error verbatim.
                    reject(new Error(`Token refresh failed (HTTP ${status}): ${parsed.error_description || parsed.error || 'unknown'}`));
                } else {
                    // Non-JSON body (HTML/empty/5xx page). Truncate to avoid log spam and
                    // never include credentials — refresh request body is not echoed back.
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
    handleUnauthorized,
    normalizeUsage,
    parseRateLimitHeaders,

    // OAuth
    refreshOAuthToken,
    isOAuth,

    // Capabilities
    supportsCache: false,
    authTypes: ['api_key', 'oauth'],
};
