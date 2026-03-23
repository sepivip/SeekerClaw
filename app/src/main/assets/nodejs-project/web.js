// SeekerClaw — web.js
// Web cache, HTML-to-markdown, search providers, web fetch.
// Depends on: config.js, http.js

const { config, log, USER_AGENT } = require('./config');
const { httpRequest } = require('./http');

// ============================================================================
// WEB TOOL UTILITIES
// ============================================================================

// --- In-memory TTL cache (ported from OpenClaw web-shared.ts) ---
const WEB_CACHE_MAX = 100;
const WEB_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

const webCache = new Map(); // key → { value, expiresAt }

function cacheGet(key) {
    if (typeof key !== 'string' || !key) return null;
    const normKey = key.trim().toLowerCase();
    const entry = webCache.get(normKey);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { webCache.delete(normKey); return null; }
    return entry.value;
}

function cacheSet(key, value, ttlMs = WEB_CACHE_TTL_MS) {
    if (typeof key !== 'string' || !key || ttlMs <= 0) return;
    const normKey = key.trim().toLowerCase();
    if (webCache.size >= WEB_CACHE_MAX) {
        webCache.delete(webCache.keys().next().value); // evict oldest (FIFO)
    }
    webCache.set(normKey, { value, expiresAt: Date.now() + ttlMs });
}

// --- HTML to Markdown converter (ported from OpenClaw web-fetch-utils.ts) ---

function decodeEntities(s) {
    return s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
        .replace(/&#x([0-9a-f]+);/gi, (match, h) => {
            const code = parseInt(h, 16);
            return (code >= 0 && code <= 0x10FFFF) ? String.fromCodePoint(code) : match;
        })
        .replace(/&#(\d+);/gi, (match, d) => {
            const code = parseInt(d, 10);
            return (code >= 0 && code <= 0x10FFFF) ? String.fromCodePoint(code) : match;
        });
}

function stripTags(s) {
    return decodeEntities(s.replace(/<[^>]+>/g, ''));
}

function htmlToMarkdown(html) {
    if (typeof html !== 'string') return { text: '', title: undefined };
    // Extract title
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? stripTags(titleMatch[1]).trim() : undefined;

    let text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

    // Convert links, headings, list items to markdown
    text = text.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
        (_, href, body) => { const l = stripTags(body).trim(); return l ? `[${l}](${href})` : href; });
    text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
        (_, level, body) => `\n${'#'.repeat(Number(level))} ${stripTags(body).trim()}\n`);
    text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi,
        (_, body) => { const l = stripTags(body).trim(); return l ? `\n- ${l}` : ''; });

    // Block elements → newlines, strip remaining tags, decode entities, normalize whitespace
    text = text.replace(/<(br|hr)\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|section|article|header|footer|table|tr|ul|ol)>/gi, '\n');
    text = stripTags(text);
    text = text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();

    return { text, title };
}

// --- Web search providers ---

const BRAVE_FRESHNESS_VALUES = new Set(['day', 'week', 'month']);
const PERPLEXITY_RECENCY_MAP = { day: 'day', week: 'week', month: 'month' };

async function searchBrave(query, count = 5, freshness) {
    if (!config.braveApiKey) throw new Error('Brave API key not configured. Add it in Android Settings, or tell me the key and I\'ll save it to agent_settings.json.');
    const safeCount = Math.min(Math.max(Number(count) || 5, 1), 10);
    let searchPath = `/res/v1/web/search?q=${encodeURIComponent(query)}&count=${safeCount}`;
    if (freshness && BRAVE_FRESHNESS_VALUES.has(freshness)) searchPath += `&freshness=${freshness}`;

    const res = await httpRequest({
        hostname: 'api.search.brave.com',
        path: searchPath,
        method: 'GET',
        headers: { 'X-Subscription-Token': config.braveApiKey }
    });

    if (res.status !== 200) {
        const detail = res.data?.error?.message || (typeof res.data === 'string' ? res.data : '');
        throw new Error(`Brave Search API error (${res.status})${detail ? ': ' + detail : ''}`);
    }
    if (!res.data?.web?.results) return { provider: 'brave', results: [], message: 'No results found' };
    return {
        provider: 'brave',
        results: res.data.web.results.map(r => ({
            title: r.title, url: r.url, snippet: r.description
        }))
    };
}

async function searchPerplexity(query, freshness) {
    const apiKey = config.perplexityApiKey;
    if (!apiKey) throw new Error('Perplexity API key not configured. Tell me the key and I\'ll save it to agent_settings.json.');

    // Auto-detect: pplx- prefix → direct API, sk-or- → OpenRouter
    const isDirect = apiKey.startsWith('pplx-');
    const isOpenRouter = apiKey.startsWith('sk-or-');
    if (!isDirect && !isOpenRouter) throw new Error('Perplexity API key must start with pplx- (direct) or sk-or- (OpenRouter)');
    const baseUrl = isDirect ? 'api.perplexity.ai' : 'openrouter.ai';
    const urlPath = isDirect ? '/chat/completions' : '/api/v1/chat/completions';
    const model = isDirect ? 'sonar-pro' : 'perplexity/sonar-pro';

    const body = { model, messages: [{ role: 'user', content: query }] };
    const recencyFilter = freshness && PERPLEXITY_RECENCY_MAP[freshness];
    if (recencyFilter) body.search_recency_filter = recencyFilter;

    const res = await httpRequest({
        hostname: baseUrl,
        path: urlPath,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://seekerclaw.com',
            'X-Title': 'SeekerClaw Web Search'
        }
    }, body);

    if (res.status !== 200) {
        const detail = res.data?.error?.message || res.data?.message || '';
        throw new Error(`Perplexity API error via ${isDirect ? 'direct' : 'OpenRouter'} (${res.status})${detail ? ': ' + detail : ''}`);
    }
    const content = res.data?.choices?.[0]?.message?.content || 'No response';
    const citations = res.data?.citations || [];
    return { provider: 'perplexity', answer: content, citations };
}

async function searchExa(query, count = 5) {
    if (!config.exaApiKey) throw new Error('Exa API key not configured');
    const body = JSON.stringify({
        query,
        numResults: count,
        type: 'auto',
        contents: { text: { maxCharacters: 500 } },
    });
    const res = await httpRequest({
        hostname: 'api.exa.ai',
        path: '/search',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.exaApiKey,
        },
    }, body);
    if (res.status !== 200) throw new Error(`Exa search error (${res.status})`);
    const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    return {
        provider: 'exa',
        results: (data.results || []).slice(0, count).map(r => ({
            title: r.title || '',
            url: r.url || '',
            snippet: r.text || '',
        })),
    };
}

async function searchTavily(query, count = 5) {
    if (!config.tavilyApiKey) throw new Error('Tavily API key not configured');
    const body = JSON.stringify({
        api_key: config.tavilyApiKey,
        query,
        search_depth: 'basic',
        max_results: count,
        include_answer: true,
    });
    const res = await httpRequest({
        hostname: 'api.tavily.com',
        path: '/search',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
    }, body);
    if (res.status !== 200) throw new Error(`Tavily search error (${res.status})`);
    const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    return {
        provider: 'tavily',
        answer: data.answer || null,
        results: (data.results || []).slice(0, count).map(r => ({
            title: r.title || '',
            url: r.url || '',
            snippet: r.content || '',
        })),
    };
}

async function searchFirecrawl(query, count = 5) {
    if (!config.firecrawlApiKey) throw new Error('Firecrawl API key not configured');
    const body = JSON.stringify({
        query,
        limit: count,
        scrapeOptions: { formats: ['markdown'] },
    });
    const res = await httpRequest({
        hostname: 'api.firecrawl.dev',
        path: '/v1/search',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.firecrawlApiKey}`,
        },
    }, body);
    if (res.status !== 200) throw new Error(`Firecrawl search error (${res.status})`);
    const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    return {
        provider: 'firecrawl',
        results: (data.data || []).slice(0, count).map(r => ({
            title: r.title || r.metadata?.title || '',
            url: r.url || '',
            snippet: r.description || (r.markdown || '').slice(0, 500),
        })),
    };
}

// --- Enhanced HTTP fetch with redirects + SSRF protection ---

async function webFetch(urlString, options = {}) {
    const maxRedirects = options.maxRedirects || 5;
    const timeout = options.timeout || 30000;
    const deadline = Date.now() + timeout; // cumulative timeout for entire redirect chain
    let currentUrl = urlString;
    let currentMethod = options.method || 'GET';
    let currentBody = options.body !== undefined ? options.body : null;
    const customHeaders = options.headers ? { ...options.headers } : {};
    const originUrl = new URL(urlString);

    for (let i = 0; i <= maxRedirects; i++) {
        const url = new URL(currentUrl);

        // Protocol validation: only allow HTTPS
        if (url.protocol !== 'https:') {
            throw new Error('Unsupported URL protocol: ' + url.protocol);
        }

        // SSRF guard: block private/local/reserved addresses
        if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|localhost)/i.test(url.hostname)) {
            throw new Error('Blocked: private/local address');
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Request timeout (redirect chain)');

        // Strip sensitive headers on cross-origin redirect
        const reqHeaders = {
            'User-Agent': USER_AGENT,
            'Accept': options.accept || 'text/markdown, text/html;q=0.9, */*;q=0.1'
        };
        for (const [k, v] of Object.entries(customHeaders)) {
            const lower = k.toLowerCase();
            // Strip auth headers on cross-origin redirects
            if (url.origin !== originUrl.origin && (lower === 'authorization' || lower === 'cookie')) continue;
            reqHeaders[k] = v;
        }
        const hasContentType = Object.keys(reqHeaders).some(k => k.toLowerCase() === 'content-type');
        if (currentBody && typeof currentBody === 'object' && !hasContentType) {
            reqHeaders['Content-Type'] = 'application/json';
        }

        const res = await httpRequest({
            hostname: url.hostname,
            port: url.port || 443,
            path: url.pathname + url.search,
            method: currentMethod,
            headers: reqHeaders,
            timeout: Math.min(remaining, timeout)
        }, currentBody);

        // Follow redirects
        if ([301, 302, 303, 307, 308].includes(res.status) && res.headers?.location) {
            currentUrl = new URL(res.headers.location, currentUrl).toString();
            if (res.status === 307 || res.status === 308) {
                // Preserve method + body
            } else {
                // 301/302/303 → downgrade to GET, drop body
                currentMethod = 'GET';
                currentBody = null;
            }
            continue;
        }

        return { ...res, finalUrl: currentUrl };
    }
    throw new Error('Too many redirects');
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    httpRequest,
    cacheGet,
    cacheSet,
    htmlToMarkdown,
    searchBrave,
    searchPerplexity,
    searchExa,
    searchTavily,
    searchFirecrawl,
    webFetch,
};
