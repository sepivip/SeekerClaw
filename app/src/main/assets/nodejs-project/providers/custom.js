// SeekerClaw — providers/custom.js
// Generic custom provider for OpenAI-compatible gateways and middlemen.
// Delegates to openrouter.js (Chat Completions) or openai.js (Responses API)
// but uses own formatRequest to avoid OpenRouter-specific decorations.

const {
    CUSTOM_KEY,
    CUSTOM_HEADERS,
    CUSTOM_FORMAT,
    CUSTOM_ENDPOINT,
} = require('../config');

const openai = require('./openai');
const openrouter = require('./openrouter');

function delegate() {
    return CUSTOM_FORMAT === 'responses' ? openai : openrouter;
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

module.exports = {
    id: 'custom',
    name: 'Custom',

    get endpoint() { return getEndpoint(); },
    getEndpoint,

    get streamProtocol() {
        return CUSTOM_FORMAT === 'responses' ? 'openai-responses' : 'chat-completions';
    },

    buildHeaders,

    toApiMessages(messages) { return delegate().toApiMessages(messages); },
    fromApiResponse(raw) { return delegate().fromApiResponse(raw); },
    formatSystemPrompt(stable, dynamic, authType) { return delegate().formatSystemPrompt(stable, dynamic, authType); },
    formatTools(tools) { return delegate().formatTools(tools); },
    formatVision(base64, mediaType) { return delegate().formatVision(base64, mediaType); },

    // Own formatRequest — clean Chat Completions body without OpenRouter cache_control/fallback
    formatRequest(model, maxTokens, instructions, input, tools) {
        if (CUSTOM_FORMAT === 'responses') {
            return openai.formatRequest(model, maxTokens, instructions, input, tools);
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

    supportsCache: false,
    authTypes: ['api_key'],
};
