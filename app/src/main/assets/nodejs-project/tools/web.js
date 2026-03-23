// tools/web.js — web_search, web_fetch handlers

const {
    log, config,
} = require('../config');

const {
    wrapExternalContent, wrapSearchResults,
} = require('../security');

const {
    cacheGet, cacheSet,
    htmlToMarkdown,
    searchBrave, searchPerplexity, searchExa, searchTavily, searchFirecrawl,
    webFetch,
} = require('../web');

const tools = [
    {
        name: 'web_search',
        description: 'Search the web for current information. Uses the search provider configured in Settings. Override with the provider parameter if needed.',
        input_schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'The search query' },
                provider: {
                    type: 'string',
                    enum: ['auto', 'brave', 'perplexity', 'exa', 'tavily', 'firecrawl'],
                    description: 'Search provider. "auto" uses the configured default (config.searchProvider).',
                    default: 'auto',
                },
                count: { type: 'number', description: 'Number of results (1-10, default 5). Applies to Brave, Exa, Tavily, Firecrawl. Perplexity returns a single synthesized answer.' },
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
        // Resolve provider: explicit override or configured default
        const rawProvider = (typeof input.provider === 'string' ? input.provider.trim().toLowerCase() : 'auto');
        const provider = rawProvider === 'auto'
            ? (config.searchProvider || 'brave')
            : rawProvider;
        const safeCount = Math.min(Math.max(Number(input.count) || 5, 1), 10);

        const cacheKey = `search:${provider}:${input.query}:${safeCount}`;
        const cached = cacheGet(cacheKey);
        if (cached) { log('[WebSearch] Cache hit', 'DEBUG'); return cached; }

        let result;
        try {
            switch (provider) {
                case 'brave':      result = await searchBrave(input.query, safeCount); break;
                case 'perplexity': result = await searchPerplexity(input.query); break;
                case 'exa':        result = await searchExa(input.query, safeCount); break;
                case 'tavily':     result = await searchTavily(input.query, safeCount); break;
                case 'firecrawl':  result = await searchFirecrawl(input.query, safeCount); break;
                default:
                    return { error: `Unknown search provider "${provider}". Configure a provider in Settings > Search Provider.` };
            }
        } catch (e) {
            log(`[WebSearch] ${provider} failed: ${e.message}`, 'ERROR');
            return { error: `Search failed (${provider}): ${e.message}. Check your API key in Settings > Search Provider.` };
        }

        const wrapped = wrapSearchResults(result, provider);
        cacheSet(cacheKey, wrapped);
        return wrapped;
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
