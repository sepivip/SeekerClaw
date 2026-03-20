// tools/web.js — web_search, web_fetch handlers

const {
    log, config,
} = require('../config');

const {
    wrapExternalContent, wrapSearchResults,
} = require('../security');

const {
    cacheGet, cacheSet,
    htmlToMarkdown, BRAVE_FRESHNESS_VALUES,
    searchBrave, searchPerplexity, searchDDG, searchDDGLite,
    webFetch,
} = require('../web');

const tools = [
    {
        name: 'web_search',
        description: 'Search the web for current information. Works out of the box with DuckDuckGo (no API key). Automatically uses Brave if its API key is configured (better quality). Perplexity Sonar available for AI-synthesized answers with citations.',
        input_schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'The search query' },
                provider: { type: 'string', enum: ['auto', 'brave', 'duckduckgo', 'perplexity'], description: 'Search provider. Default: auto (Brave if key configured, else DuckDuckGo). Use perplexity for complex questions needing synthesized answers.' },
                count: { type: 'number', description: 'Number of results (brave/duckduckgo, 1-10, default 5)' },
                freshness: { type: 'string', enum: ['day', 'week', 'month'], description: 'Freshness filter. Brave: filters by discovery time. Perplexity: sets search_recency_filter. Not supported by DuckDuckGo.' }
            },
            required: ['query']
        }
    },
    {
        name: 'web_fetch',
        description: 'Fetch a URL with full HTTP support. Returns markdown (HTML), JSON, or text (up to 50K chars). Supports custom headers (Bearer auth), methods (POST/PUT/DELETE), and request bodies for authenticated API calls.',
        input_schema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'The URL to fetch' },
                method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], description: 'HTTP method (default: GET)' },
                headers: { type: 'object', description: 'Custom HTTP headers (e.g. {"Authorization": "Bearer sk-..."})' },
                body: { type: ['string', 'object'], description: 'Request body for POST/PUT. String or JSON object.' },
                raw: { type: 'boolean', description: 'If true, return raw text without markdown conversion' }
            },
            required: ['url']
        }
    },
];

const handlers = {
    async web_search(input, chatId) {
        const rawProvider = (typeof input.provider === 'string' ? input.provider.toLowerCase() : 'auto');
        const VALID_PROVIDERS = new Set(['auto', 'brave', 'duckduckgo', 'perplexity']);
        if (!VALID_PROVIDERS.has(rawProvider)) {
            return { error: `Unknown search provider "${rawProvider}". Use "auto", "brave", "duckduckgo", or "perplexity".` };
        }
        // Resolve 'auto': Brave if key configured, else DuckDuckGo
        const provider = rawProvider === 'auto'
            ? (config.braveApiKey ? 'brave' : 'duckduckgo')
            : rawProvider;
        const safeCount = Math.min(Math.max(Number(input.count) || 5, 1), 10);
        const rawFreshness = (typeof input.freshness === 'string' ? input.freshness.trim().toLowerCase() : '');
        const safeFreshness = BRAVE_FRESHNESS_VALUES.has(rawFreshness) ? rawFreshness : '';
        const cacheKey = provider === 'perplexity'
            ? `search:perplexity:${input.query}:${safeFreshness || 'default'}`
            : provider === 'brave'
                ? `search:brave:${input.query}:${safeCount}:${safeFreshness}`
                : `search:duckduckgo:${input.query}:${safeCount}`;
        const cached = cacheGet(cacheKey);
        if (cached) { log('[WebSearch] Cache hit', 'DEBUG'); return cached; }

        try {
            let result;
            if (provider === 'perplexity') {
                result = await searchPerplexity(input.query, safeFreshness);
            } else if (provider === 'brave') {
                result = await searchBrave(input.query, safeCount, safeFreshness);
            } else {
                result = await searchDDG(input.query, safeCount);
            }
            // Treat empty DDG results as failure to trigger fallback (CAPTCHA returns 200 but no parseable results)
            if (result.results && result.results.length === 0 && result.message && provider === 'duckduckgo') {
                throw new Error(result.message);
            }
            const wrappedResult = wrapSearchResults(result, provider);
            cacheSet(cacheKey, wrappedResult);
            return wrappedResult;
        } catch (e) {
            // Fallback chain: perplexity -> brave -> ddg -> ddg-lite, brave -> ddg -> ddg-lite, ddg -> ddg-lite
            log(`[WebSearch] ${provider} failed (${e.message}), trying fallback`, 'WARN');
            const fallbacks = [];
            if (provider === 'perplexity') {
                if (config.braveApiKey) fallbacks.push('brave');
                fallbacks.push('duckduckgo');
                fallbacks.push('duckduckgo-lite');
            } else if (provider === 'brave') {
                fallbacks.push('duckduckgo');
                fallbacks.push('duckduckgo-lite');
            } else if (provider === 'duckduckgo') {
                fallbacks.push('duckduckgo-lite');
            }
            for (const fb of fallbacks) {
                try {
                    log(`[WebSearch] Falling back to ${fb}`, 'DEBUG');
                    let fallback;
                    if (fb === 'brave') fallback = await searchBrave(input.query, safeCount, safeFreshness);
                    else if (fb === 'duckduckgo-lite') fallback = await searchDDGLite(input.query, safeCount);
                    else fallback = await searchDDG(input.query, safeCount);
                    // Treat empty DDG results (CAPTCHA) as failure to continue fallback chain
                    if (fb === 'duckduckgo' && fallback.results && fallback.results.length === 0 && fallback.message) {
                        throw new Error(fallback.message);
                    }
                    const fbCacheKey = fb === 'brave'
                        ? `search:brave:${input.query}:${safeCount}:${safeFreshness}`
                        : `search:${fb}:${input.query}:${safeCount}`;
                    const wrappedFallback = wrapSearchResults(fallback, fb);
                    cacheSet(fbCacheKey, wrappedFallback);
                    // Also cache under original key so subsequent queries don't re-hit the failing provider
                    cacheSet(cacheKey, wrappedFallback);
                    return wrappedFallback;
                } catch (fbErr) {
                    log(`[WebSearch] ${fb} fallback also failed: ${fbErr.message}`, 'ERROR');
                }
            }
            const displayName = { brave: 'Brave', duckduckgo: 'DuckDuckGo', 'duckduckgo-lite': 'DuckDuckGo Lite', perplexity: 'Perplexity' }[provider] || provider;
            return { error: fallbacks.length > 0
                ? `Search failed: ${displayName} (${e.message}), fallback providers also failed`
                : `${displayName} search failed: ${e.message}. No fallback providers available.` };
        }
    },

    async web_fetch(input, chatId) {
        const rawMode = input.raw === true;
        const fetchMethod = (typeof input.method === 'string' ? input.method.toUpperCase() : 'GET');
        const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);
        if (!ALLOWED_METHODS.has(fetchMethod)) {
            return { error: `Unsupported HTTP method "${fetchMethod}". Use GET, POST, PUT, or DELETE.` };
        }
        const isGet = fetchMethod === 'GET';
        const hasBody = input.body !== undefined && input.body !== null;

        // Build safe headers (filter prototype pollution + stringify values)
        const safeHeaders = {};
        if (input.headers && typeof input.headers === 'object' && !Array.isArray(input.headers)) {
            for (const [k, v] of Object.entries(input.headers)) {
                if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
                if (v === undefined || v === null) continue;
                safeHeaders[k] = String(v);
            }
        }
        const hasCustomHeaders = Object.keys(safeHeaders).length > 0;
        const useCache = isGet && !hasCustomHeaders && !hasBody;
        const fetchCacheKey = `fetch:${input.url}:${rawMode ? 'raw' : 'md'}`;
        if (useCache) {
            const fetchCached = cacheGet(fetchCacheKey);
            if (fetchCached) { log('[WebFetch] Cache hit', 'DEBUG'); return fetchCached; }
        }

        try {
            const fetchOptions = {};
            if (input.method) fetchOptions.method = fetchMethod;
            if (hasCustomHeaders) fetchOptions.headers = safeHeaders;
            if (input.body !== undefined) fetchOptions.body = input.body;
            const res = await webFetch(input.url, fetchOptions);
            if (res.status < 200 || res.status >= 300) {
                let detail = '';
                if (typeof res.data === 'string') {
                    detail = res.data.slice(0, 200);
                } else if (res.data && typeof res.data === 'object') {
                    detail = (res.data.error && res.data.error.message) || res.data.message || '';
                }
                throw new Error(`HTTP error (${res.status})${detail ? ': ' + detail : ''}`);
            }
            let result;

            if (typeof res.data === 'object') {
                // JSON response
                const json = JSON.stringify(res.data, null, 2);
                result = { content: json.slice(0, 50000), type: 'json', url: res.finalUrl };
            } else if (typeof res.data === 'string') {
                const contentType = (res.headers && res.headers['content-type']) || '';
                if (contentType.includes('text/markdown')) {
                    // Cloudflare Markdown for Agents: server returned pre-rendered markdown
                    if (rawMode) {
                        result = { content: res.data.slice(0, 50000), type: 'text', url: res.finalUrl };
                    } else {
                        result = { content: res.data.slice(0, 50000), type: 'markdown', extractor: 'cf-markdown', url: res.finalUrl };
                    }
                } else if (contentType.includes('text/html') || /^\s*(?:<!DOCTYPE html|<html\b)/i.test(res.data)) {
                    if (rawMode) {
                        // Raw mode: basic strip only
                        let text = res.data.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
                        text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
                        text = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                        result = { content: text.slice(0, 50000), type: 'text', url: res.finalUrl };
                    } else {
                        // Markdown conversion (default)
                        const { text, title } = htmlToMarkdown(res.data);
                        result = { content: text.slice(0, 50000), ...(title && { title }), type: 'markdown', url: res.finalUrl };
                    }
                } else {
                    // Plain text
                    result = { content: res.data.slice(0, 50000), type: 'text', url: res.finalUrl };
                }
            } else {
                result = { content: String(res.data).slice(0, 50000), type: 'text', url: res.finalUrl };
            }

            // Wrap content with untrusted content markers for prompt injection defense
            if (result.content) {
                result.content = wrapExternalContent(result.content, `web_fetch: ${res.finalUrl || input.url}`);
            }

            if (useCache) cacheSet(fetchCacheKey, result);
            return result;
        } catch (e) {
            return { error: e.message, url: input.url };
        }
    },
};

module.exports = { tools, handlers };
