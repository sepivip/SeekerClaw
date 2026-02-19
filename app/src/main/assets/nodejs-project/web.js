// SeekerClaw — web.js
// HTTP helpers, web cache, HTML-to-markdown, search providers, web fetch.
// Depends on: config.js

const https = require('https');

const { config, log, USER_AGENT } = require('./config');

// ============================================================================
// HTTP HELPERS
// ============================================================================

function httpRequest(options, body = null) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            res.setEncoding('utf8'); // Handle multi-byte chars (emoji) split across chunks
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data), headers: res.headers });
                } catch (e) {
                    resolve({ status: res.statusCode, data: data, headers: res.headers });
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')); });
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}

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
    if (!config.braveApiKey) throw new Error('Brave API key not configured (set braveApiKey in Settings)');
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
    if (!apiKey) throw new Error('Perplexity API key not configured (set perplexityApiKey in Settings)');

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

async function searchDDG(query, count = 5) {
    const safePath = `/html/?q=${encodeURIComponent(query)}`;
    const res = await httpRequest({
        hostname: 'html.duckduckgo.com',
        path: safePath,
        method: 'GET',
        headers: {
            'User-Agent': USER_AGENT,
            'Accept': 'text/html'
        }
    });

    if (res.status !== 200) {
        throw new Error(`DuckDuckGo search error (${res.status})`);
    }
    const html = typeof res.data === 'string' ? res.data : String(res.data);

    // Parse DDG HTML results — patterns match DDG's current HTML format (double-quoted attributes).
    // May need updating if DDG changes their markup.
    const results = [];
    const resultBlocks = html.split(/<div[^>]*class="(?:result\b|results_links\b)[^"]*"[^>]*>/i);
    for (let i = 1; i < resultBlocks.length && results.length < count; i++) {
        const block = resultBlocks[i];
        // Extract URL from <a class="result__a" href="...">
        const urlMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>/i);
        // Extract title text from that same <a> tag
        const titleMatch = block.match(/<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
        // Extract snippet from <a class="result__snippet" ...>
        const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);

        if (urlMatch && titleMatch) {
            let url = decodeEntities(urlMatch[1]).trim();
            // DDG wraps URLs through a redirect — extract actual URL
            const uddgMatch = url.match(/[?&]uddg=([^&]+)/);
            if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);
            const title = stripTags(titleMatch[1]).trim();
            const snippet = snippetMatch ? stripTags(snippetMatch[1]).trim() : '';
            if (title && (url.startsWith('http://') || url.startsWith('https://'))) {
                results.push({ title, url, snippet });
            }
        }
    }

    if (results.length === 0) {
        // Distinguish parse failure from genuine empty results
        if (html.length > 500) {
            log(`[DDG] HTML received (${html.length} chars) but no results parsed — markup may have changed`, 'WARN');
            return { provider: 'duckduckgo', results: [], message: 'Results could not be parsed — DuckDuckGo markup may have changed' };
        }
        return { provider: 'duckduckgo', results: [], message: 'No results found' };
    }
    return { provider: 'duckduckgo', results };
}

// DDG Lite fallback — lite.duckduckgo.com bypasses CAPTCHAs that block html.duckduckgo.com on phone IPs
async function searchDDGLite(query, count = 5) {
    const safePath = `/lite?q=${encodeURIComponent(query)}`;
    const res = await httpRequest({
        hostname: 'lite.duckduckgo.com',
        path: safePath,
        method: 'GET',
        headers: {
            'User-Agent': USER_AGENT,
            'Accept': 'text/html'
        }
    });

    if (res.status !== 200) {
        throw new Error(`DuckDuckGo Lite search error (${res.status})`);
    }
    const html = typeof res.data === 'string' ? res.data : String(res.data);

    // DDG Lite uses table-based layout — split by result-link anchors and find snippets within each block
    const results = [];
    const blocks = html.split(/<a[^>]*class="result-link"/i);
    for (let i = 1; i < blocks.length && results.length < count; i++) {
        const block = blocks[i];
        // Extract URL and title from the result-link anchor
        const urlMatch = block.match(/href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!urlMatch) continue;
        let url = decodeEntities(urlMatch[1]).trim();
        // DDG Lite also wraps URLs through redirects
        const uddgMatch = url.match(/[?&]uddg=([^&]+)/);
        if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);
        const title = stripTags(urlMatch[2]).trim();
        // Extract snippet from the same block (co-located, no index alignment needed)
        const snippetMatch = block.match(/<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/i);
        const snippet = snippetMatch ? stripTags(snippetMatch[1]).trim() : '';
        if (title && (url.startsWith('http://') || url.startsWith('https://'))) {
            results.push({ title, url, snippet });
        }
    }

    if (results.length === 0) {
        if (html.length > 500) {
            log(`[DDG Lite] HTML received (${html.length} chars) but no results parsed — markup may have changed`, 'WARN');
            return { provider: 'duckduckgo-lite', results: [], message: 'Results could not be parsed — DuckDuckGo Lite markup may have changed' };
        }
        return { provider: 'duckduckgo-lite', results: [], message: 'No results found' };
    }
    return { provider: 'duckduckgo-lite', results };
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
    BRAVE_FRESHNESS_VALUES,
    searchBrave,
    searchPerplexity,
    searchDDG,
    searchDDGLite,
    webFetch,
};
