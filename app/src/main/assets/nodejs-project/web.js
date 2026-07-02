// SeekerClaw — web.js
// Web cache, HTML-to-markdown, search providers, web fetch.
// Depends on: config.js, http.js

const net = require('net');
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

// Build the outbound headers for a single hop of a (possibly redirected) web_fetch.
//
// Security (BAT-1086): caller-supplied headers ride along ONLY when this hop is
// same-origin as the ORIGINAL request. On any cross-origin hop we send just the
// framework defaults (User-Agent, Accept), so secret auth headers — Authorization,
// Cookie, x-api-key, a bearer token placed in a custom header, etc. — never follow
// a redirect to a different host. Comparing against the ORIGINAL origin (not the
// previous hop) means that once the chain leaves the trusted origin the headers
// stay stripped, while a hop back to the original origin (A->B->A) re-attaches them.
//
// Content-Type is re-derived here (never carried across origins) and only when a
// body is actually being sent. Pure and deterministic — exported for unit testing.
function computeOutboundHeaders(customHeaders, url, originUrl, options = {}, currentBody = null) {
    const headers = {
        'User-Agent': USER_AGENT,
        'Accept': (options && options.accept) || 'text/markdown, text/html;q=0.9, */*;q=0.1',
    };
    // Caller headers AND a body-derived Content-Type ride along ONLY on same-origin
    // hops. A cross-origin hop gets nothing but the two framework defaults above.
    // (webFetch also blocks cross-origin body-preserving redirects, so a body is
    // only ever sent same-origin anyway.)
    if (url.origin === originUrl.origin) {
        if (customHeaders && typeof customHeaders === 'object') {
            for (const [k, v] of Object.entries(customHeaders)) {
                // Filter prototype-pollution keys — this helper is exported, so a
                // direct caller could pass unsanitized headers (tools/web.js already
                // strips these at the input boundary; mirror it here defensively).
                if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
                headers[k] = v;
            }
        }
        const hasContentType = Object.keys(headers).some(k => k.toLowerCase() === 'content-type');
        if (currentBody != null && typeof currentBody === 'object' && !hasContentType) {
            headers['Content-Type'] = 'application/json';
        }
    }
    return headers;
}

// --- SSRF guard: block private / loopback / link-local literals (BAT-1088) ---
//
// LITERAL / canonical-host screening only — NOT DNS-rebind protection. `new URL()`
// already canonicalizes IPv4 decimal/octal/hex forms to dotted-quad before we see
// url.hostname, so the live gap this closes over the old prefix regex is IPv6
// (loopback/mapped/ULA/link-local). A public hostname that RESOLVES to a private IP
// is out of scope (needs resolve-and-pin — tracked separately as BAT-1093).
//
// V1 blocks: IPv4 loopback 127/8, private 10/8 + 172.16/12 + 192.168/16, link-local
// 169.254/16, unspecified 0/8; IPv6 :: , ::1, ULA fc00::/7, link-local fe80::/10,
// IPv4-mapped ::ffff:0:0/96 (classified by embedded IPv4); localhost / *.localhost.
// Deliberately NOT blocked (per BAT-1088 decision): CGNAT 100.64/10, benchmark
// 198.18/15, multicast, reserved-future — asserted allowed in tests.

function _isBlockedIPv4(ip) {
    const p = ip.split('.');
    if (p.length !== 4) return true; // net.isIPv4 validated the shape; be safe
    const a = Number(p[0]), b = Number(p[1]);
    if (a === 127) return true;                       // loopback 127/8
    if (a === 10) return true;                        // private 10/8
    if (a === 0) return true;                         // "this host" 0/8
    if (a === 169 && b === 254) return true;          // link-local 169.254/16
    if (a === 192 && b === 168) return true;          // private 192.168/16
    if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16/12
    return false;
}

// Parse a (net.isIPv6-validated) IPv6 string into 16 bytes, or null if unparseable.
function _ipv6ToBytes(str) {
    const halves = str.split('::');
    if (halves.length > 2) return null;
    const parseGroups = (part) => {
        if (part === '') return [];
        const out = [];
        for (const t of part.split(':')) {
            if (t.includes('.')) { // embedded IPv4 tail → two 16-bit groups
                const q = t.split('.').map(Number);
                if (q.length !== 4 || q.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
                out.push(((q[0] << 8) | q[1]) & 0xffff, ((q[2] << 8) | q[3]) & 0xffff);
            } else {
                if (!/^[0-9a-f]{1,4}$/i.test(t)) return null;
                out.push(parseInt(t, 16));
            }
        }
        return out;
    };
    const head = parseGroups(halves[0]);
    const tail = halves.length === 2 ? parseGroups(halves[1]) : [];
    if (head === null || tail === null) return null;
    let g;
    if (halves.length === 2) {
        const missing = 8 - head.length - tail.length;
        if (missing < 0) return null;
        g = [...head, ...Array(missing).fill(0), ...tail];
    } else {
        g = head;
    }
    if (g.length !== 8) return null;
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 8; i++) { bytes[2 * i] = (g[i] >> 8) & 0xff; bytes[2 * i + 1] = g[i] & 0xff; }
    return bytes;
}

function _isBlockedIPv6(str) {
    const b = _ipv6ToBytes(str);
    if (!b) return true; // fail closed on anything we can't classify
    if (b.every((x) => x === 0)) return true;                              // :: unspecified
    if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true;  // ::1 loopback
    if ((b[0] & 0xfe) === 0xfc) return true;                               // fc00::/7 ULA
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;              // fe80::/10 link-local
    if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) {
        return _isBlockedIPv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);      // ::ffff:0:0/96 IPv4-mapped
    }
    return false;
}

// Is this host a private/loopback/link-local literal that web_fetch must not reach?
// Pure + exported for unit testing. Called per redirect hop before any socket opens.
function isBlockedAddress(hostname) {
    if (typeof hostname !== 'string') return true; // fail closed on junk
    let host = hostname.trim().toLowerCase();
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // strip IPv6 brackets
    // Strip an IPv6 zone identifier (RFC 6874: fe80::1%eth0). Classify the address
    // itself so a zoned link-local literal is caught as link-local, not treated as a
    // hostname. (new URL() actually rejects zoned IPv6 URLs, so this mainly hardens
    // direct callers of this exported helper.)
    const pct = host.indexOf('%');
    if (pct !== -1) host = host.slice(0, pct);
    // Strip trailing dot(s): the FQDN root form (localhost. / api.localhost.) resolves
    // identically to the un-dotted name, so it must classify the same — otherwise it's
    // a localhost SSRF bypass. (new URL() drops the dot on IP literals but keeps it on
    // names.)
    host = host.replace(/\.+$/, '');
    if (!host) return true; // empty / whitespace-only / "[]" / "." → fail closed
    const v = net.isIP(host);
    if (v === 0) return host === 'localhost' || host.endsWith('.localhost'); // hostname, not an IP literal
    if (v === 4) return _isBlockedIPv4(host);
    return _isBlockedIPv6(host);
}

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

        // SSRF guard: block private/local/link-local literals (BAT-1088).
        // Per-hop + before any socket, so redirect targets are covered too.
        if (isBlockedAddress(url.hostname)) {
            throw new Error('Blocked: private/local address');
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Request timeout (redirect chain)');

        // Build outbound headers: caller headers only on same-origin hops,
        // safe framework defaults otherwise (BAT-1086 — see computeOutboundHeaders).
        const reqHeaders = computeOutboundHeaders(customHeaders, url, originUrl, options, currentBody);

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
            const nextUrl = new URL(res.headers.location, currentUrl);
            if (res.status === 307 || res.status === 308) {
                // 307/308 preserve method + body. Block cross-origin body-preserving
                // redirects (BAT-1086): forwarding a caller POST/PUT body to a
                // different origin is a data-exfil path even after headers are
                // stripped. Same-origin 307/308 keep method + body as before.
                if (nextUrl.origin !== originUrl.origin && currentBody != null) {
                    throw new Error('Blocked: cross-origin redirect with request body');
                }
            } else {
                // 301/302/303 → downgrade to GET, drop body
                currentMethod = 'GET';
                currentBody = null;
            }
            currentUrl = nextUrl.toString();
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
    computeOutboundHeaders,
    isBlockedAddress,
};
