# Plan: OpenRouter Provider Support (BAT-447)

> **Last updated:** 2026-03-15 — Rewritten based on live OpenRouter API docs research.
> **Previous version** was based on assumptions; this version is based on verified docs from openrouter.ai.

## Context

Add OpenRouter as a third provider alongside Claude and OpenAI. OpenRouter is an API gateway that provides access to 100+ models (Claude, GPT, Gemini, Llama, Mistral, DeepSeek, Grok, etc.) through a single **Chat Completions** endpoint. Users bring one API key and can switch models freely — including using Anthropic models at potentially different pricing/routing.

### Why OpenRouter Matters for SeekerClaw

1. **Model freedom** — Users access any model without separate API keys per provider
2. **Model fallbacks** — OpenRouter supports `models: [primary, fallback]` arrays with automatic failover. Critical for a 24/7 agent: if Claude is down, the agent switches to Gemini automatically.
3. **Cost optimization** — `provider: { sort: "price" }` routes to cheapest provider for a given model
4. **Prompt caching** — OpenRouter passes through `cache_control` to Anthropic, DeepSeek, Gemini, and others. Top-level `cache_control` field is the simplest approach.

### Key Technical Difference

OpenRouter uses **Chat Completions** format (`POST /api/v1/chat/completions`), NOT OpenAI Responses API (`/v1/responses`). This means:
- `messages` array with `role: system/user/assistant/tool` (not `input` items)
- Tool calls nested in assistant message as `tool_calls` (not top-level `function_call` items)
- Tool results use `role: 'tool'` with `tool_call_id` (not `function_call_output`)
- System prompt is first message `{role: 'system', content: '...'}` (not `instructions` field)
- SSE streaming uses `data:` lines only (no typed `event:` names)
- Vision uses `image_url` type (same as old Chat Completions, not `input_image`)

---

## Files to Modify

### Node.js (7 files)

| File | Change | Effort |
|------|--------|--------|
| `providers/openrouter.js` | **NEW** — Full Chat Completions adapter | High |
| `providers/index.js` | Register openrouter adapter | Trivial |
| `web.js` | **NEW** `httpChatCompletionsStreamingRequest()` SSE parser | Medium |
| `config.js` | Add `openrouter` to providers, load API key, export OPENROUTER_KEY | Low |
| `claude.js` (API call) | API key selection + streaming fn dispatch for openrouter | Low |
| `claude.js` (system prompt) | OpenRouter-specific runtime info in `buildSystemBlocks()` | Low |
| `claude.js` (token estimation) | Dynamic context limits from OpenRouter model metadata | Low |

### Kotlin (4 files)

| File | Change | Effort |
|------|--------|--------|
| `Providers.kt` | Add OpenRouter provider entry + empty model list | Low |
| `ConfigManager.kt` | Add `openrouterApiKey` + `openrouterFallbackModel` fields | Medium |
| `ProviderConfigScreen.kt` | Freeform model input + optional fallback model + credits display | Medium |
| `Models.kt` | No change (OpenRouter uses freeform model IDs) | — |

---

## Implementation Details

### 1. `providers/openrouter.js` — Chat Completions Adapter

Full adapter following the contract established by `claude.js` and `openai.js`.

**Endpoint:** `openrouter.ai:443/api/v1/chat/completions`
**Test endpoint:** `openrouter.ai:443/api/v1/models` (GET)
**Stream protocol:** `'chat-completions'` (new — needs new parser in web.js)

#### `toApiMessages(messages)`

Converts neutral internal messages to Chat Completions `messages` array:

```javascript
function toApiMessages(messages) {
    const out = [];
    for (const msg of messages) {
        if (msg.role === 'tool') {
            // Tool results → role: 'tool' with tool_call_id
            out.push({
                role: 'tool',
                tool_call_id: msg.toolCallId,
                content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            });
            continue;
        }

        if (msg.role === 'assistant') {
            const entry = { role: 'assistant' };

            // Handle legacy Claude-native arrays
            if (Array.isArray(msg.content)) {
                const textParts = msg.content.filter(b => b.type === 'text' && b.text).map(b => b.text);
                entry.content = textParts.join('') || null;
                const toolUseBlocks = msg.content.filter(b => b.type === 'tool_use');
                if (toolUseBlocks.length > 0) {
                    entry.tool_calls = toolUseBlocks.map(b => ({
                        id: b.id,
                        type: 'function',
                        function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
                    }));
                }
            } else {
                entry.content = msg.content || null;
            }

            // Neutral format: toolCalls as separate array
            if (msg.toolCalls && msg.toolCalls.length > 0) {
                entry.tool_calls = msg.toolCalls.map(tc => ({
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: JSON.stringify(tc.input || {}) },
                }));
            }

            out.push(entry);
            continue;
        }

        if (msg.role === 'user') {
            if (typeof msg.content === 'string') {
                out.push({ role: 'user', content: msg.content });
            } else if (Array.isArray(msg.content)) {
                // Handle Claude-native tool_result blocks in user messages
                const toolResults = msg.content.filter(b => b.type === 'tool_result');
                const otherBlocks = msg.content.filter(b => b.type !== 'tool_result');

                for (const tr of toolResults) {
                    const output = typeof tr.content === 'string' ? tr.content
                        : Array.isArray(tr.content) ? tr.content.filter(b => b.type === 'text').map(b => b.text).join('')
                        : JSON.stringify(tr.content || '');
                    out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: output });
                }

                // Vision or multi-part content
                if (otherBlocks.length > 0) {
                    const parts = otherBlocks.map(block => {
                        if (block.type === 'text') return { type: 'text', text: block.text };
                        if (block.type === 'image') {
                            const mediaType = block.source?.media_type || 'image/jpeg';
                            const data = block.source?.data || '';
                            return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } };
                        }
                        if (block.type === 'image_url') return block;
                        return { type: 'text', text: JSON.stringify(block) };
                    });
                    out.push({ role: 'user', content: parts });
                }
            } else {
                out.push({ role: 'user', content: String(msg.content || '') });
            }
        }
    }
    return out;
}
```

#### `fromApiResponse(raw)`

Parse Chat Completions response (used for both streamed final and non-streamed):

```javascript
function fromApiResponse(raw) {
    const choice = raw.choices?.[0];
    if (!choice) return { text: null, toolCalls: [], stopReason: 'end_turn', usage: raw.usage || {} };

    const message = choice.message || {};
    const text = message.content || null;

    const toolCalls = (message.tool_calls || []).map(tc => {
        let input = {};
        try {
            input = typeof tc.function.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : (tc.function.arguments || {});
        } catch (e) {
            log(`[OpenRouter] Failed to parse tool arguments for ${tc.function?.name}: ${e.message}`, 'WARN');
        }
        return { id: tc.id, name: tc.function?.name || 'unknown', input };
    });

    // Map finish_reason → neutral stopReason
    const fr = choice.finish_reason;
    let stopReason = 'end_turn';
    if (toolCalls.length > 0 || fr === 'tool_calls') stopReason = 'tool_use';
    else if (fr === 'length') stopReason = 'max_tokens';
    else if (fr === 'content_filter') stopReason = 'content_filter';

    return { text, toolCalls, stopReason, usage: raw.usage || {} };
}
```

#### `formatSystemPrompt(stable, dynamic)`

Plain string concatenation. Prompt caching is handled by top-level `cache_control` in `formatRequest` — NOT per-block in the system message.

```javascript
function formatSystemPrompt(stable, dynamic) {
    return stable + '\n\n' + dynamic;
}
```

#### `formatTools(tools)`

Chat Completions uses nested `function` wrapper (unlike Responses API flat format):

```javascript
function formatTools(tools) {
    if (!tools || tools.length === 0) return [];
    return tools.map(tool => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.input_schema || { type: 'object', properties: {} },
        },
    }));
}
```

#### `formatRequest(model, maxTokens, systemPrompt, messages, tools)`

```javascript
// Module-level: loaded from config.js at require() time
const { OPENROUTER_FALLBACK_MODEL } = require('../config');

function formatRequest(model, maxTokens, systemPrompt, messages, tools) {
    const body = {
        model,
        stream: true,
        max_tokens: maxTokens,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        // Top-level prompt caching — OpenRouter handles per-provider routing.
        // Works for Anthropic, DeepSeek, Gemini, Grok, Groq.
        // Providers that don't support caching silently ignore it.
        cache_control: { type: 'ephemeral' },
    };
    if (tools && tools.length > 0) body.tools = tools;

    // If fallback model is configured, use models array for auto-failover
    if (OPENROUTER_FALLBACK_MODEL) {
        body.models = [model, OPENROUTER_FALLBACK_MODEL];
        delete body.model;
        body.route = 'fallback';
    }

    return JSON.stringify(body);
}
```

#### `buildHeaders(apiKey)`

```javascript
function buildHeaders(apiKey) {
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://seekerclaw.xyz',
        'X-OpenRouter-Title': 'SeekerClaw',   // NOT X-Title (old/wrong)
    };
}
```

#### `formatVision(base64, mediaType)`

Same as OpenAI Chat Completions format:

```javascript
function formatVision(base64, mediaType) {
    return {
        type: 'image_url',
        image_url: { url: `data:${mediaType || 'image/jpeg'};base64,${base64}` },
    };
}
```

#### `classifyError(status, data)`

OpenRouter-specific error codes — more granular than OpenAI:

```javascript
function classifyError(status, data) {
    if (status === 401) {
        return { type: 'auth', retryable: false,
            userMessage: '🔑 OpenRouter API key is invalid. Check Settings?' };
    }
    if (status === 402) {
        return { type: 'billing', retryable: false,
            userMessage: 'OpenRouter credits exhausted. Add credits at openrouter.ai/credits' };
    }
    if (status === 403) {
        // Content moderation flag — includes metadata.reasons
        const reasons = data?.error?.metadata?.reasons;
        const detail = Array.isArray(reasons) ? `: ${reasons.join(', ')}` : '';
        return { type: 'moderation', retryable: false,
            userMessage: `Message flagged by content moderation${detail}` };
    }
    if (status === 404) {
        return { type: 'model_not_found', retryable: false,
            userMessage: `Model not found on OpenRouter. Check the model ID in Settings.` };
    }
    if (status === 408) {
        return { type: 'timeout', retryable: true,
            userMessage: 'OpenRouter request timed out. Retrying...' };
    }
    if (status === 413) {
        return { type: 'payload_too_large', retryable: false,
            userMessage: 'Request too large — try shortening the conversation or using a model with a larger context window.' };
    }
    if (status === 429) {
        return { type: 'rate_limit', retryable: true,
            userMessage: '⏳ Rate limited by OpenRouter. Trying again in a moment...' };
    }
    if (status === 502) {
        const provider = data?.error?.metadata?.provider_name || 'upstream provider';
        return { type: 'provider_down', retryable: true,
            userMessage: `${provider} is temporarily down. Retrying...` };
    }
    if (status === 503) {
        return { type: 'no_provider', retryable: true,
            userMessage: 'No provider available for this model right now. Retrying...' };
    }
    if (status >= 500) {
        return { type: 'server', retryable: true,
            userMessage: 'OpenRouter is temporarily unavailable. Retrying...' };
    }
    const rawReason = data?.error?.message || '';
    const reason = rawReason.replace(/[*_`\[\]()~>#+\-=|{}.!]/g, '').slice(0, 200);
    return { type: 'unknown', retryable: false,
        userMessage: reason.trim() ? `API error (${status}): ${reason.trim()}`
            : `Unexpected API error (${status}). Please try again.` };
}
```

#### `classifyNetworkError(err)`

Same pattern as OpenAI adapter — network errors are provider-agnostic:

```javascript
function classifyNetworkError(err) {
    const raw = err.message || String(err);
    if (err.timeoutSource === 'transport' || /timeout/i.test(raw)) {
        return { type: 'timeout', userMessage: 'The AI took too long to respond. Please try again.' };
    }
    if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) {
        return { type: 'dns', userMessage: 'Cannot reach OpenRouter — check your internet connection.' };
    }
    if (/ECONNREFUSED|ECONNRESET|EPIPE/i.test(raw)) {
        return { type: 'connection', userMessage: 'Connection to OpenRouter was lost. Please try again.' };
    }
    return { type: 'network', userMessage: 'A network error occurred. Please try again.' };
}
```

#### `normalizeUsage(usage)`

Chat Completions uses `prompt_tokens`/`completion_tokens` (not `input_tokens`/`output_tokens`):

```javascript
function normalizeUsage(usage) {
    if (!usage) return { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
    return {
        inputTokens: usage.prompt_tokens || 0,
        outputTokens: usage.completion_tokens || 0,
        cacheRead: usage.prompt_tokens_details?.cached_tokens || 0,
        cacheWrite: usage.prompt_tokens_details?.cache_write_tokens || 0,
    };
}
```

#### `parseRateLimitHeaders(headers)`

OpenRouter doesn't document specific rate limit headers. Return safe defaults:

```javascript
function parseRateLimitHeaders(headers) {
    return { tokensRemaining: Infinity, tokensReset: '', requests: {}, tokens: {} };
}
```

#### Full export

```javascript
module.exports = {
    id: 'openrouter',
    name: 'OpenRouter',
    endpoint: { hostname: 'openrouter.ai', path: '/api/v1/chat/completions' },
    testEndpoint: { hostname: 'openrouter.ai', path: '/api/v1/models', method: 'GET' },
    buildHeaders,
    streamProtocol: 'chat-completions',
    toApiMessages,
    fromApiResponse,
    formatSystemPrompt,
    formatTools,
    formatRequest,
    formatVision,
    classifyError,
    classifyNetworkError,  // Defined below (same pattern as OpenAI — DNS/timeout/connection)
    normalizeUsage,
    parseRateLimitHeaders,
    supportsCache: true,    // via top-level cache_control
    authTypes: ['api_key'],
};
```

---

### 2. `web.js` — Chat Completions Streaming Parser

**New function: `httpChatCompletionsStreamingRequest(options, body)`**

Chat Completions SSE is simpler than both Claude and Responses API:
- No `event:` type lines — just `data:` lines
- `data: [DONE]` terminates the stream
- OpenRouter sends `: OPENROUTER PROCESSING` keepalive comments (SSE comment = line starting with `:`)

**Chunk format:**
```
data: {"id":"...","choices":[{"index":0,"delta":{"content":"Hello"}}],"model":"anthropic/claude-sonnet-4-6"}
data: {"id":"...","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":""}}]}}]}
data: {"id":"...","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path\":"}}]}}]}
data: {"id":"...","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":50}}
data: [DONE]
```

**Accumulation strategy:**
1. Text: concatenate `delta.content` strings
2. Tool calls: accumulate by `delta.tool_calls[i].index`. First chunk has `id` + `function.name`; subsequent chunks append to `function.arguments`.
3. Usage: from the final chunk's `usage` field (before `[DONE]`)
4. `finish_reason`: from the chunk where it's non-null
5. Model: from any chunk's `model` field (OpenRouter may switch model via fallback)

**Build accumulated response matching `fromApiResponse()` input shape:**
```javascript
{
    choices: [{ message: { content, tool_calls }, finish_reason }],
    usage: { prompt_tokens, completion_tokens, ... },
    model: actualModel,  // may differ from requested if fallback triggered
}
```

**Mid-stream error handling:**
If a chunk has `finish_reason: "error"` and an `error` object, the stream should resolve with an error status rather than returning partial data. HTTP status is still 200 (headers already sent), so the error is in-band.

**Keepalive handling:**
Lines starting with `:` (SSE comments) should be silently ignored. They reset the connection timeout — our parser must not treat them as errors.

**Estimated LOC:** ~150 (simpler than the ~200 LOC `httpOpenAIStreamingRequest` because no typed events)

**web.js exports update** (line ~712):
```javascript
module.exports = {
    httpRequest,
    httpStreamingRequest,
    httpOpenAIStreamingRequest,
    httpChatCompletionsStreamingRequest,  // NEW
    // ... rest unchanged
};
```

---

### 3. `providers/index.js` — Registration

```javascript
register(require('./openrouter'));
```

---

### 4. `config.js` — Provider Support

**Changes to existing code (not new file):**

```javascript
// Line ~103: Add openrouter to supported providers
const _SUPPORTED_PROVIDERS = new Set(['claude', 'openai', 'openrouter']);

// Line ~107: Add key loading (after OPENAI_KEY)
const OPENROUTER_KEY = normalizeSecret(config.openrouterApiKey || '');
const OPENROUTER_FALLBACK_MODEL = config.openrouterFallbackModel || '';

// Line ~161: Update _activeKey validation (currently only handles claude/openai)
const _activeKey = PROVIDER === 'openai' ? OPENAI_KEY
    : PROVIDER === 'openrouter' ? OPENROUTER_KEY
    : ANTHROPIC_KEY;

// Line ~163: Update missing key error message
if (!BOT_TOKEN || !_activeKey) {
    const keyName = PROVIDER === 'openai' ? 'openaiApiKey'
        : PROVIDER === 'openrouter' ? 'openrouterApiKey'
        : 'anthropicApiKey';
    log(`ERROR: Missing required config (botToken, ${keyName}) for provider "${PROVIDER}"`, 'ERROR');
    process.exit(1);
}

// Line ~397+: Add to module.exports
module.exports = {
    // ... existing exports ...
    OPENROUTER_KEY,
    OPENROUTER_FALLBACK_MODEL,
};
```

**IMPORTANT:** The `_activeKey` validation currently only handles 2 providers. Without updating this, OpenRouter would fall through to `ANTHROPIC_KEY` and fail silently with a wrong key.

---

### 5. `claude.js` — API Key & Streaming Dispatch

**Import update** (line ~22, add to existing require):
```javascript
const { httpStreamingRequest, httpOpenAIStreamingRequest, httpChatCompletionsStreamingRequest } = require('./web');
```

**Import OPENROUTER_KEY** (line ~11, add to existing config require):
```javascript
const {
    // ... existing imports ...
    OPENROUTER_KEY,
} = require('./config');
```

**API key selection** (line ~1080):
```javascript
const apiKey = PROVIDER === 'openai' ? OPENAI_KEY
    : PROVIDER === 'openrouter' ? OPENROUTER_KEY
    : ANTHROPIC_KEY;
```

**Streaming function dispatch** (line ~1084):
```javascript
const streamFn = adapter.streamProtocol === 'chat-completions'
    ? httpChatCompletionsStreamingRequest
    : (adapter.streamProtocol === 'openai' || adapter.streamProtocol === 'openai-responses')
        ? httpOpenAIStreamingRequest
        : httpStreamingRequest;
```

**NOTE:** The ternary chain now has 3 branches. If we add a 4th provider, refactor to a map: `{ 'claude': httpStreamingRequest, 'openai-responses': httpOpenAIStreamingRequest, 'chat-completions': httpChatCompletionsStreamingRequest }`.

---

### 6. `claude.js` — Token Estimation Integration

**Problem:** OpenRouter has 100+ models with different context windows (8K to 1M+). Can't hardcode them all in `MODEL_CONTEXT_LIMITS`.

**Solution:** Fetch context length from OpenRouter at startup:

```javascript
// In config.js or a new openrouter-models.js
async function fetchOpenRouterModelContext(model, apiKey) {
    try {
        const res = await httpRequest({
            hostname: 'openrouter.ai',
            path: `/api/v1/models`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        if (res.status === 200) {
            const models = res.data?.data || [];
            const match = models.find(m => m.id === model);
            if (match?.context_length) {
                MODEL_CONTEXT_LIMITS[model] = match.context_length;
                log(`[OpenRouter] ${model} context: ${match.context_length} tokens`, 'INFO');
            }
        }
    } catch (e) {
        log(`[OpenRouter] Failed to fetch model context length: ${e.message}`, 'WARN');
        // Falls back to DEFAULT_CONTEXT_LIMIT (128K) — conservative and safe
    }
}
```

Called once at startup when provider is `openrouter`. Result cached in `MODEL_CONTEXT_LIMITS` map.

---

### 7. `claude.js` — System Prompt (Agent Awareness)

In `buildSystemBlocks()`:

```javascript
if (PROVIDER === 'openrouter') {
    lines.push('## Provider');
    lines.push(`You are running via OpenRouter (model: ${MODEL}).`);
    if (OPENROUTER_FALLBACK_MODEL) {
        lines.push(`Fallback model configured: ${OPENROUTER_FALLBACK_MODEL} (auto-switches if primary is down).`);
    }
    lines.push('');
}
```

---

### 8. Kotlin — `Providers.kt`

```kotlin
ProviderInfo(
    id = "openrouter",
    displayName = "OpenRouter",
    authTypes = listOf("api_key"),
    keyHint = "sk-or-v1-…",
    consoleUrl = "https://openrouter.ai/keys",
),
```

Models: empty list — freeform text input.

```kotlin
fun modelsForProvider(providerId: String): List<ModelInfo> = when (providerId) {
    "openai" -> openaiModels
    "openrouter" -> emptyList()  // Freeform: user types model ID
    else -> availableModels       // Claude models
}
```

---

### 9. Kotlin — `ConfigManager.kt`

**5 touch points** — follow the exact pattern used for `openaiApiKey`:

**A. AppConfig data class** (line ~42):
```kotlin
val openaiApiKey: String = "",
val openrouterApiKey: String = "",           // NEW
val openrouterFallbackModel: String = "",    // NEW — optional auto-failover
```

**B. saveConfig()** (line ~141, after openaiApiKey block):
```kotlin
if (config.openrouterApiKey.isNotBlank()) {
    val encOpenRouter = KeystoreHelper.encrypt(config.openrouterApiKey)
    editor.putString(KEY_OPENROUTER_API_KEY_ENC, Base64.encodeToString(encOpenRouter, Base64.NO_WRAP))
} else {
    editor.remove(KEY_OPENROUTER_API_KEY_ENC)
}
editor.putString(KEY_OPENROUTER_FALLBACK_MODEL, config.openrouterFallbackModel)
```

**C. loadConfig()** (line ~214, after openaiApiKey block):
```kotlin
val openrouterApiKey = try {
    val enc = p.getString(KEY_OPENROUTER_API_KEY_ENC, null)
    if (enc != null) KeystoreHelper.decrypt(Base64.decode(enc, Base64.NO_WRAP)) else ""
} catch (e: Exception) {
    Log.w(TAG, "Failed to decrypt OpenRouter key", e)
    ""
}
// In the AppConfig constructor:
openrouterApiKey = openrouterApiKey,
openrouterFallbackModel = p.getString(KEY_OPENROUTER_FALLBACK_MODEL, "") ?: "",
```

**D. writeConfigJson()** (line ~320, after openaiApiKey):
```kotlin
if (config.openrouterApiKey.isNotBlank()) put("openrouterApiKey", config.openrouterApiKey)
if (config.openrouterFallbackModel.isNotBlank()) put("openrouterFallbackModel", config.openrouterFallbackModel)
```

**E. runtimeValidationError()** (line ~370):
```kotlin
val hasCredential = when (config.provider) {
    "openai" -> config.openaiApiKey.isNotBlank()
    "openrouter" -> config.openrouterApiKey.isNotBlank()  // NEW
    else -> config.activeCredential.isNotBlank()
}
```

**F. updateField()** (line ~271):
```kotlin
"openrouterApiKey" -> config.copy(openrouterApiKey = value)
"openrouterFallbackModel" -> config.copy(openrouterFallbackModel = value)
```

**G. redactedSnapshot()** (line ~380):
```kotlin
"openrouterSet=${config.openrouterApiKey.isNotBlank()} "
```

**H. New constants:**
```kotlin
private const val KEY_OPENROUTER_API_KEY_ENC = "openrouter_api_key_enc"
private const val KEY_OPENROUTER_FALLBACK_MODEL = "openrouter_fallback_model"
```

**I. CRITICAL — Update `anthropicApiKey` conditional in `writeConfigJson()`:**
Current code (line ~310):
```kotlin
put("anthropicApiKey", if (config.provider == "openai") "" else config.activeCredential)
```
Must update to also exclude openrouter:
```kotlin
put("anthropicApiKey", if (config.provider in listOf("openai", "openrouter")) "" else config.activeCredential)
```
Without this fix, when provider is `openrouter`, the Anthropic API key would be written to config.json needlessly (and Node.js might try to use it as a fallback).

---

### 10. Kotlin — Settings UI (`ProviderConfigScreen.kt`)

```kotlin
"openrouter" -> {
    // Primary model (freeform text)
    ProviderConfigField(
        label = "Model",
        value = config?.model ?: "",
        onSave = { saveField("model", it) },
        placeholder = "anthropic/claude-sonnet-4-6",
        helpText = "Full model ID from openrouter.ai/models"
    )
    // Fallback model (optional)
    ProviderConfigField(
        label = "Fallback Model (optional)",
        value = config?.openrouterFallbackModel ?: "",
        onSave = { saveField("openrouterFallbackModel", it) },
        placeholder = "google/gemini-2.5-pro",
        helpText = "Auto-switches if primary is down"
    )
    // API Key
    ProviderConfigField(
        label = "API Key",
        value = maskKey(config?.openrouterApiKey),
        onSave = { saveField("openrouterApiKey", it) },
        isSensitive = true,
    )
}
```

**Connection test:**
```kotlin
"openrouter" -> testOpenRouterConnection(config?.openrouterApiKey ?: "")
```

`testOpenRouterConnection()` — GET `https://openrouter.ai/api/v1/models` with `Authorization: Bearer KEY`. Returns success if 200, shows error message otherwise.

---

## Prompt Caching — Verified Approach

**Confirmed from docs:** OpenRouter supports prompt caching via a **top-level `cache_control` field** in the request body:

```json
{
    "model": "anthropic/claude-sonnet-4-6",
    "cache_control": { "type": "ephemeral" },
    "messages": [...]
}
```

**How it works:**
- OpenRouter detects the provider and applies caching automatically
- Works for: Anthropic (5min default, optional 1hr TTL), DeepSeek, Gemini (2.5 models), Grok, Groq, OpenAI
- Providers that don't support caching **silently ignore** it — no errors
- **No per-model detection needed** — just always include it
- Usage reports `cached_tokens` and `cache_write_tokens` in `prompt_tokens_details`

**What we do:** Set `cache_control: { type: 'ephemeral' }` in every `formatRequest()` call. That's it.

**What we DON'T do:** No `isAnthropicModel()` detection, no per-block `cache_control` injection, no conditional logic. The old plan's approach was over-engineered.

---

## Model Fallbacks — New Feature

OpenRouter supports `models` array instead of single `model`:

```json
{
    "models": ["anthropic/claude-sonnet-4-6", "google/gemini-2.5-pro"],
    "route": "fallback",
    "messages": [...]
}
```

**Behavior:**
- Tries first model, falls back to second on: context length errors, moderation blocks, rate limits, provider downtime
- Response `model` field shows which model actually served the request
- **Critical for 24/7 agent** — keeps the agent running even when one provider has issues

**Implementation:** If `openrouterFallbackModel` is configured, `formatRequest()` uses `models` array + `route: 'fallback'` instead of single `model` field. The response's `model` field should be logged so we know which model served.

---

## Testing Strategy

### Phase 1: Basic Conversation
- Configure OpenRouter API key in Settings
- Set model to `anthropic/claude-sonnet-4-6`
- Send simple message, verify streaming response
- Check logs for `[OpenRouter]` entries + no errors

### Phase 2: Tool Use
- Ask agent to use tools (`datetime`, `read`, `web_search`)
- Verify tool call JSON parses correctly from Chat Completions format
- Verify multi-round tool use (agent calls tool → gets result → responds)
- Test parallel tool calls if model supports them

### Phase 3: Prompt Caching
- Use Anthropic model via OpenRouter
- Check usage response for `cached_tokens > 0` on second+ messages
- Verify in OpenRouter dashboard that cache is working

### Phase 4: Vision
- Send an image to the agent via Telegram
- Verify `formatVision()` produces correct `image_url` format
- Verify the model analyzes the image correctly

### Phase 5: Model Fallback
- Set primary: `anthropic/claude-sonnet-4-6`, fallback: `google/gemini-2.5-pro`
- Verify normal operation uses primary model (check response `model` field)
- Simulate primary down (use an invalid primary model ID) → verify fallback kicks in

### Phase 6: Cross-Model
- Switch to `google/gemini-2.5-pro` — verify conversation + tool use
- Switch to `meta-llama/llama-4-maverick` — verify basic conversation
- Switch to `deepseek/deepseek-r1` — verify reasoning model works

### Phase 7: Error Handling
- Invalid API key → `401` clear error
- Invalid model → `404` clear error
- Insufficient credits → `402` clear error
- Connection test button works
- Provider switching preserves config for other providers
- Mid-stream error handling (if model fails partway through response)
- Keepalive comments (`: OPENROUTER PROCESSING`) don't break streaming

### Phase 8: Token Estimation
- Verify `MODEL_CONTEXT_LIMITS` is populated from `/api/v1/models` response
- Verify context warnings fire correctly for OpenRouter models
- Verify fallback to 128K default if model fetch fails

---

## Build Guidance

**Gradle sync needed:** No — no new `buildConfigField` entries. Just build & run for JS + Kotlin changes.

**Exception:** If we add `OPENROUTER_FALLBACK_MODEL` as a BuildConfig field (not recommended — it should be runtime config via SharedPreferences/config.json), then Gradle sync would be needed.

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Streaming parser edge cases (different models stream differently via OpenRouter) | Medium | Test with 3+ model families; handle mid-stream errors |
| Prompt caching doesn't work for some models | Low | Top-level `cache_control` is silently ignored by unsupported providers |
| Model fallback changes model mid-conversation (different capabilities) | Medium | Log actual model used; agent self-awareness in system prompt |
| OpenRouter keepalive comments break SSE parser | Low | Handle `:` prefix lines explicitly in parser |
| Token estimation for unknown models | Low | Conservative 128K default; fetch from /api/v1/models at startup |
| Vision format differences across models | Low | Chat Completions `image_url` format is standardized by OpenRouter |

---

## Estimated Effort

| Phase | Tickets | Days |
|-------|---------|------|
| Adapter + streaming parser (JS) | 2 BAT tickets | 2-3 |
| Kotlin config + UI | 1 BAT ticket | 1 |
| Token estimation integration | Part of adapter ticket | — |
| Testing + polish | 1 BAT ticket | 1-2 |
| **Total** | **4 BAT tickets** | **4-6 days** |

---

## Open Questions

1. **Should we expose `provider.sort` (price/latency/throughput) in Settings?** — Nice for power users, but adds UI complexity. Recommendation: defer to Phase 2, default to no provider preference.

2. **Should we fetch the full model list for autocomplete?** — GET `/api/v1/models` returns 100+ models with metadata. Could provide autocomplete in the model text field. Nice UX but significant Kotlin work. Recommendation: defer, freeform is fine for v1.

3. **Should we show OpenRouter credits balance?** — `GET /api/v1/credits` returns balance. Could show in Settings or Dashboard. Low effort, good UX. Recommendation: add to Settings screen.

4. **OpenRouter's built-in tools** (`openrouter:datetime`, `openrouter:web_search`) — we already have both. Should we disable ours when on OpenRouter? Recommendation: no, keep ours — they're more capable and we control them.
