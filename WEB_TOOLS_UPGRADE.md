# Plan: Upgrade web_search & web_fetch — Best of Both Worlds (NEXT UP)

## Context

SeekerClaw's web tools are bare-bones compared to OpenClaw:
- **web_search**: Brave only, 5 results, no caching, no filters
- **web_fetch**: Regex HTML strip (`<[^>]+>` → space), 8K char limit, no caching, no redirect following

OpenClaw has: Brave + Perplexity Sonar + Grok search providers, htmlToMarkdown with link/heading/list preservation, Firecrawl fallback for JS-heavy pages, in-memory TTL cache, SSRF protection, 50K char limit.

**Goal:** Match OpenClaw's quality, then exceed it with SeekerClaw's unique advantage — **Android WebView rendering** for JS-heavy pages (free on-device, no Firecrawl API needed).

## File to modify

`app/src/main/assets/nodejs-project/main.js`

## Existing code to reuse

- `httpRequest()` (line ~1174): Node.js https module, already handles JSON auto-parse. Needs enhancement for redirect following and raw response mode.
- `claudeApiCall()` (line ~3581): Already has mutex, retry, rate-limit. Won't change — web tools don't call Claude API.
- `config` object (line ~54): Already loads from config.json. We'll add `perplexityApiKey` and `webViewEnabled` fields.

## Ported from OpenClaw (zero-dependency, pure JS)

All from `openclaw-reference/src/agents/tools/`:
- **htmlToMarkdown** from `web-fetch-utils.ts`: ~60 lines, regex-based, preserves links/headings/lists, entity decoding
- **In-memory TTL cache** from `web-shared.ts`: Map with expiry, max 100 entries, FIFO eviction
- **Perplexity Sonar call pattern** from `web-search.ts`: OpenRouter `/chat/completions` endpoint, citation extraction

---

## Changes (4 tasks, 3 PRs)

### Task 1: Shared Infrastructure (PR #1)

Add ~120 lines of shared utilities at module level, after the existing helper functions section.

**1a. In-memory TTL cache** (port from OpenClaw `web-shared.ts`)

```javascript
// --- Web tool cache ---
const WEB_CACHE_MAX = 100;
const WEB_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

const webCache = new Map(); // key → { value, expiresAt }

function cacheGet(key) {
    const entry = webCache.get(key.trim().toLowerCase());
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { webCache.delete(key.trim().toLowerCase()); return null; }
    return entry.value;
}

function cacheSet(key, value, ttlMs = WEB_CACHE_TTL_MS) {
    if (ttlMs <= 0) return;
    const normKey = key.trim().toLowerCase();
    if (webCache.size >= WEB_CACHE_MAX) {
        webCache.delete(webCache.keys().next().value); // evict oldest
    }
    webCache.set(normKey, { value, expiresAt: Date.now() + ttlMs });
}
```

**1b. htmlToMarkdown** (port from OpenClaw `web-fetch-utils.ts`)

```javascript
function htmlToMarkdown(html) {
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

function stripTags(s) {
    return decodeEntities(s.replace(/<[^>]+>/g, ''));
}

function decodeEntities(s) {
    return s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/&#(\d+);/gi, (_, d) => String.fromCharCode(parseInt(d, 10)));
}
```

**1c. Enhanced HTTP fetch with redirects**

Wrap `httpRequest()` with a redirect-following helper for web tools (Claude API calls keep using `httpRequest` directly via `claudeApiCall`):

```javascript
async function webFetch(urlString, options = {}) {
    const maxRedirects = options.maxRedirects || 5;
    const timeout = options.timeout || 30000;
    let currentUrl = urlString;

    for (let i = 0; i <= maxRedirects; i++) {
        const url = new URL(currentUrl);

        // SSRF guard: block private IPs
        if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|localhost)/i.test(url.hostname)) {
            throw new Error('Blocked: private/local address');
        }

        const res = await httpRequest({
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: 'GET',
            headers: {
                'User-Agent': 'SeekerClaw/1.0 (Android; +https://seekerclaw.com)',
                'Accept': options.accept || 'text/html,application/json,text/*',
                ...(options.headers || {})
            },
            timeout
        });

        // Follow redirects
        if ([301, 302, 303, 307, 308].includes(res.status) && res.headers?.location) {
            currentUrl = new URL(res.headers.location, currentUrl).toString();
            continue;
        }

        return { ...res, finalUrl: currentUrl };
    }
    throw new Error('Too many redirects');
}
```

---

### Task 2: Upgrade web_search (PR #2)

Replace the current Brave-only handler with a multi-provider system.

**2a. Tool definition update** (lines ~1309-1318)

Add optional parameters for provider selection and filters:

```javascript
{
    name: 'web_search',
    description: 'Search the web for current information. Uses Brave Search by default, or Perplexity Sonar for AI-synthesized answers with citations.',
    input_schema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'The search query' },
            provider: { type: 'string', enum: ['brave', 'perplexity'], description: 'Search provider. Default: brave. Use perplexity for complex questions needing synthesized answers.' },
            count: { type: 'number', description: 'Number of results (brave only, 1-10, default 5)' },
            freshness: { type: 'string', enum: ['day', 'week', 'month'], description: 'Freshness filter (brave only)' }
        },
        required: ['query']
    }
}
```

**2b. Handler rewrite** (lines ~1738-1760)

```javascript
case 'web_search': {
    const provider = input.provider || 'brave';
    const cacheKey = `search:${provider}:${input.query}:${input.count || 5}:${input.freshness || ''}`;
    const cached = cacheGet(cacheKey);
    if (cached) { log('[WebSearch] Cache hit'); return cached; }

    try {
        let result;
        if (provider === 'perplexity') {
            result = await searchPerplexity(input.query);
        } else {
            result = await searchBrave(input.query, input.count || 5, input.freshness);
        }
        cacheSet(cacheKey, result);
        return result;
    } catch (e) {
        // Fallback: if perplexity fails and brave is available, try brave
        if (provider === 'perplexity' && config.braveApiKey) {
            log(`[WebSearch] Perplexity failed (${e.message}), falling back to Brave`);
            try {
                const fallback = await searchBrave(input.query, 5);
                cacheSet(cacheKey, fallback);
                return fallback;
            } catch (e2) { return { error: e2.message }; }
        }
        return { error: e.message };
    }
}
```

**2c. Provider functions**

```javascript
async function searchBrave(query, count = 5, freshness) {
    if (!config.braveApiKey) throw new Error('Brave API key not configured');
    let path = `/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(count, 10)}`;
    if (freshness) path += `&freshness=${freshness}`;

    const res = await httpRequest({
        hostname: 'api.search.brave.com',
        path,
        method: 'GET',
        headers: { 'X-Subscription-Token': config.braveApiKey }
    });

    if (!res.data?.web?.results) return { results: [], message: 'No results found' };
    return {
        provider: 'brave',
        results: res.data.web.results.slice(0, count).map(r => ({
            title: r.title, url: r.url, snippet: r.description
        }))
    };
}

async function searchPerplexity(query) {
    const apiKey = config.perplexityApiKey;
    if (!apiKey) throw new Error('Perplexity API key not configured');

    // Auto-detect: pplx- prefix → direct API, sk-or- → OpenRouter
    const isDirect = apiKey.toLowerCase().startsWith('pplx-');
    const baseUrl = isDirect ? 'api.perplexity.ai' : 'openrouter.ai';
    const urlPath = isDirect ? '/chat/completions' : '/api/v1/chat/completions';
    const model = isDirect ? 'sonar-pro' : 'perplexity/sonar-pro';

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
    }, { model, messages: [{ role: 'user', content: query }] });

    if (res.status !== 200) throw new Error(`Perplexity API error (${res.status})`);
    const content = res.data?.choices?.[0]?.message?.content || 'No response';
    const citations = res.data?.citations || [];
    return { provider: 'perplexity', answer: content, citations };
}
```

**Config:** Add `perplexityApiKey` to config.json (optional — Brave remains default).

---

### Task 3: Upgrade web_fetch (PR #3)

Replace the regex HTML strip with htmlToMarkdown, increase limit, add caching.

**3a. Tool definition update** (lines ~1320-1329)

```javascript
{
    name: 'web_fetch',
    description: 'Fetch and read a webpage. Returns clean markdown content with links and headings preserved. Handles HTML, JSON, and plain text.',
    input_schema: {
        type: 'object',
        properties: {
            url: { type: 'string', description: 'The URL to fetch' },
            raw: { type: 'boolean', description: 'If true, return raw text without markdown conversion' }
        },
        required: ['url']
    }
}
```

**3b. Handler rewrite** (lines ~1762-1782)

```javascript
case 'web_fetch': {
    const cacheKey = `fetch:${input.url}`;
    const cached = cacheGet(cacheKey);
    if (cached) { log('[WebFetch] Cache hit'); return cached; }

    try {
        const res = await webFetch(input.url);
        let result;

        if (typeof res.data === 'object') {
            // JSON response
            const json = JSON.stringify(res.data, null, 2);
            result = { content: json.slice(0, 50000), type: 'json', url: res.finalUrl };
        } else if (typeof res.data === 'string') {
            const contentType = res.headers?.['content-type'] || '';
            if (contentType.includes('text/html') || res.data.trim().startsWith('<')) {
                if (input.raw) {
                    // Raw mode: basic strip only
                    let text = res.data.replace(/<script[\s\S]*?<\/script>/gi, '');
                    text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
                    text = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                    result = { content: text.slice(0, 50000), type: 'text', url: res.finalUrl };
                } else {
                    // Markdown conversion (default)
                    const { text, title } = htmlToMarkdown(res.data);
                    result = { content: text.slice(0, 50000), title, type: 'markdown', url: res.finalUrl };
                }
            } else {
                // Plain text
                result = { content: res.data.slice(0, 50000), type: 'text', url: res.finalUrl };
            }
        } else {
            result = { content: String(res.data).slice(0, 50000), type: 'text', url: res.finalUrl };
        }

        cacheSet(cacheKey, result);
        return result;
    } catch (e) {
        return { error: e.message, url: input.url };
    }
}
```

**Key improvements over current:**
- 50K char limit (was 8K) — 6x more content
- htmlToMarkdown preserves links, headings, lists (was `<[^>]+>` → space)
- Follows redirects (was none)
- SSRF protection (was none)
- Caches results for 15 min (was none)
- Returns content type and final URL
- JSON responses handled natively

---

### Task 4: System Prompt Updates (included in PR #3)

Update the tooling guidance in `buildSystemBlocks()` to mention the new capabilities:

```javascript
lines.push('## Tooling');
lines.push('Tools are provided via the tools API. Call tools exactly as listed by name.');
lines.push('For visual checks ("what do you see", "check my dog"), call android_camera_check.');
lines.push('**Swap workflow:** Always use solana_quote first, then solana_swap. Never swap without confirming the quote.');
lines.push('**Web search:** Use web_search with provider=perplexity for complex questions needing synthesized answers. Use Brave (default) for quick lookups.');
lines.push('**Web fetch:** Use web_fetch to read any webpage. Returns markdown with links and headings preserved.');
lines.push('');
```

---

## Implementation Order

| PR | Tasks | Branch | Linear Ticket |
|----|-------|--------|---------------|
| #1 | Task 1 (shared infra: cache + htmlToMarkdown + webFetch) | `feature/BAT-XX` | Create new |
| #2 | Task 2 (web_search upgrade) | `feature/BAT-XX` | Create new |
| #3 | Tasks 3+4 (web_fetch upgrade + system prompt) | `feature/BAT-XX` | Create new |

Each PR follows the established workflow: Linear task → branch → implement → push → Copilot review → address comments → merge → close Linear task.

## What we are NOT changing

- Claude API calls (already optimized in BAT-13–18)
- Tool definitions in TOOLS array structure
- Config loading mechanism (just adding optional keys)
- Conversation history / memory system
- Any Kotlin/Compose UI code

## Verification

After each PR:
1. **Cache test**: Send same web_search query twice rapidly → second should log `[WebSearch] Cache hit`
2. **htmlToMarkdown test**: `web_fetch` on a real page (e.g. Wikipedia) → verify links show as `[text](url)`, headings as `#`, lists as `- `
3. **Redirect test**: `web_fetch` on a URL that redirects (e.g. `http://github.com`) → should follow to HTTPS and return content
4. **Perplexity test** (if key configured): `web_search` with `provider=perplexity` → should return synthesized answer with citations
5. **Fallback test**: `web_search` with `provider=perplexity` when no key → should fallback to Brave
6. **SSRF test**: `web_fetch` on `http://127.0.0.1` → should return "Blocked: private/local address"
7. **Large page test**: `web_fetch` on a large page → should return up to 50K chars, not 8K

## Comparison: Before vs After

| Feature | Current | After | OpenClaw |
|---------|---------|-------|----------|
| Search providers | Brave only | Brave + Perplexity | Brave + Perplexity + Grok |
| Search caching | None | 15-min TTL | 15-min TTL |
| Search filters | None | count, freshness | country, language, freshness |
| Fetch content limit | 8K chars | 50K chars | 50K chars |
| HTML conversion | Regex strip | Markdown (links/headings/lists) | Readability + regex fallback |
| Redirect following | None | Up to 5 hops | Up to 5 hops |
| SSRF protection | None | Private IP blocking | Private IP blocking |
| Fetch caching | None | 15-min TTL | 15-min TTL |
| Dependencies added | — | 0 (pure JS) | linkedom, @mozilla/readability |
