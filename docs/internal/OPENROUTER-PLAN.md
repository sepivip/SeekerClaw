# Plan: OpenRouter Provider Support (BAT-447)

## Context

Add OpenRouter as a third provider alongside Claude and OpenAI. OpenRouter is an API gateway providing access to 100+ models (Claude, GPT, Gemini, Llama, Mistral, etc.) through a single OpenAI-compatible Chat Completions endpoint. Users bring one API key and can switch models freely.

**Key technical difference:** OpenRouter uses **Chat Completions** format (`/v1/chat/completions`), NOT OpenAI Responses API (`/v1/responses`). This means different message format, tool format, and streaming protocol from our existing OpenAI adapter. Needs a clean new adapter + streaming parser.

**Caching:** Detect Anthropic models via OpenRouter and inject `cache_control` for prompt caching (saves money).

## Files to Modify

### Node.js (6 files)

| File | Change | Effort |
|------|--------|--------|
| `providers/openrouter.js` | **NEW** — Chat Completions adapter | High |
| `providers/index.js` | Register openrouter adapter | Low |
| `web.js` | **NEW** `httpChatCompletionsStreamingRequest()` parser | Medium |
| `config.js` | Add `openrouter` to supported providers, load API key | Low |
| `claude.js` | API key selection for openrouter, streaming fn dispatch | Low |
| `claude.js` (system prompt) | Document OpenRouter in system prompt if relevant | Low |

### Kotlin (4 files)

| File | Change | Effort |
|------|--------|--------|
| `Providers.kt` | Add OpenRouter provider entry + empty model list | Low |
| `ConfigManager.kt` | Add `openrouterApiKey` field, encrypt/decrypt, config.json | Medium |
| `SettingsScreen.kt` / `ProviderConfigScreen.kt` | Freeform model text input for OpenRouter | Medium |
| `SETTINGS_INFO.md` | Document OpenRouter API Key field | Low |

---

## Implementation Details

### 1. `providers/openrouter.js` — Chat Completions Adapter

**Endpoint:** `openrouter.ai:443/api/v1/chat/completions`
**Test endpoint:** `openrouter.ai:443/api/v1/models` (GET)
**Stream protocol:** `'chat-completions'` (new)

**`toApiMessages(messages)`:**
Chat Completions format — different from both Claude and Responses API:
```javascript
// User → {role: 'user', content: 'text'}
// Assistant → {role: 'assistant', content: 'text', tool_calls: [{id, type: 'function', function: {name, arguments}}]}
// Tool result → {role: 'tool', tool_call_id: 'tc_1', content: 'result'}
// System → {role: 'system', content: 'text'}
```

Key differences from our OpenAI Responses API adapter:
- Uses `messages` array (not `input`)
- Tool calls are nested in assistant message as `tool_calls` array (not top-level `function_call` items)
- Tool results use `role: 'tool'` with `tool_call_id` (not `function_call_output`)
- System prompt is first message with `role: 'system'` (not `instructions` field)

**`fromApiResponse(raw)`:**
Parse Chat Completions response:
```javascript
// raw.choices[0].message.content → text
// raw.choices[0].message.tool_calls → [{id, function: {name, arguments}}]
// raw.usage → {prompt_tokens, completion_tokens}
```

**`formatSystemPrompt(stable, dynamic)`:**
Returns plain string (concatenated). Goes into system message, not separate field.

**`formatTools(tools)`:**
Chat Completions tool format (nested `function` wrapper):
```javascript
tools.map(t => ({
    type: 'function',
    function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
    }
}))
```

**`formatRequest(model, maxTokens, systemPrompt, messages, tools)`:**
```javascript
{
    model,
    messages: [{role: 'system', content: systemPrompt}, ...messages],
    max_tokens: maxTokens,
    stream: true,
    tools: tools.length > 0 ? tools : undefined,
}
```

**`buildHeaders(apiKey)`:**
```javascript
{
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'HTTP-Referer': 'https://seekerclaw.xyz',
    'X-Title': 'SeekerClaw',
}
```
Note: OpenRouter recommends `HTTP-Referer` and `X-Title` for app identification.

**Prompt caching for Anthropic models:**
```javascript
formatSystemPrompt(stable, dynamic) {
    if (isAnthropicModel(currentModel)) {
        // Return array with cache_control (like Claude adapter)
        return [
            {type: 'text', text: stable, cache_control: {type: 'ephemeral'}},
            {type: 'text', text: dynamic}
        ];
    }
    return stable + '\n\n' + dynamic;
}
```
Actually — need to check if OpenRouter passes through `cache_control` in system messages for Anthropic models. OpenClaw does this. The system message content becomes an array instead of string when caching.

**`supportsCache`:** Dynamic — `true` if model contains `anthropic/`, else `false`.

**Error classification:** Similar to OpenAI (401=auth, 429=rate_limit, 5xx=server). OpenRouter adds `402` for insufficient credits.

### 2. `web.js` — Chat Completions Streaming Parser

**New function: `httpChatCompletionsStreamingRequest()`**

Chat Completions SSE format is simpler than Responses API:
```
data: {"id":"...","choices":[{"delta":{"role":"assistant","content":"Hello"},"index":0}]}
data: {"id":"...","choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc_1","function":{"name":"read","arguments":""}}]},"index":0}]}
data: {"id":"...","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path\":"}}]},"index":0}]}
data: [DONE]
```

Accumulate:
- Text deltas from `choices[0].delta.content`
- Tool call names + arguments from `choices[0].delta.tool_calls[i]`
- Usage from final chunk or `[DONE]` preceding chunk

Build response in neutral format matching what `fromApiResponse()` expects.

### 3. `providers/index.js` — Registration

```javascript
register(require('./openrouter'));
```

### 4. `config.js` — Provider Support

```javascript
const _SUPPORTED_PROVIDERS = new Set(['claude', 'openai', 'openrouter']);
// ...
const OPENROUTER_KEY = normalizeSecret(config.openrouterApiKey || '');
// ...
// API key selection
const _activeKey = PROVIDER === 'openai' ? OPENAI_KEY
    : PROVIDER === 'openrouter' ? OPENROUTER_KEY
    : ANTHROPIC_KEY;
```

### 5. `claude.js` — API Key & Streaming Dispatch

Line ~1080: API key selection needs openrouter case:
```javascript
const apiKey = PROVIDER === 'openai' ? OPENAI_KEY
    : PROVIDER === 'openrouter' ? OPENROUTER_KEY
    : ANTHROPIC_KEY;
```

Line ~1084: Streaming function dispatch:
```javascript
const streamFn = adapter.streamProtocol === 'chat-completions'
    ? httpChatCompletionsStreamingRequest
    : (adapter.streamProtocol === 'openai' || adapter.streamProtocol === 'openai-responses')
        ? httpOpenAIStreamingRequest
        : httpStreamingRequest;
```

### 6. Kotlin — `Providers.kt`

```kotlin
ProviderInfo(
    id = "openrouter",
    displayName = "OpenRouter",
    authTypes = listOf("api_key"),
    keyHint = "sk-or-v1-…",
    consoleUrl = "https://openrouter.ai/keys",
),
```

Models: empty list — freeform text input instead of dropdown.

```kotlin
fun modelsForProvider(providerId: String): List<ModelInfo> = when (providerId) {
    "openai" -> openaiModels
    "openrouter" -> emptyList()  // Freeform input
    else -> availableModels
}
```

### 7. Kotlin — `ConfigManager.kt`

Add to `AppConfig`:
```kotlin
val openrouterApiKey: String = "",
```

Add encryption/decryption for `openrouterApiKey` (same pattern as `openaiApiKey`).

Add to `writeConfigJson()`:
```kotlin
if (config.openrouterApiKey.isNotBlank()) put("openrouterApiKey", config.openrouterApiKey)
```

Add to `runtimeValidationError()`:
```kotlin
"openrouter" -> config.openrouterApiKey.isNotBlank()
```

### 8. Kotlin — Settings UI (`ProviderConfigScreen.kt`)

Add `"openrouter"` case in the `when (activeProvider)` block:
```kotlin
"openrouter" -> {
    // Freeform model text input (not dropdown)
    ProviderConfigField(
        label = "Model",
        value = config?.model ?: "",
        onSave = { saveField("model", it) },
        placeholder = "anthropic/claude-sonnet-4-5",
    )
    ProviderConfigField(
        label = "API Key",
        value = maskKey(config?.openrouterApiKey),
        onSave = { saveField("openrouterApiKey", it) },
        isSensitive = true,
    )
}
```

Connection test:
```kotlin
"openrouter" -> testOpenRouterConnection(config?.openrouterApiKey ?: "")
```

Add `testOpenRouterConnection()` function — GET `https://openrouter.ai/api/v1/models` with Bearer auth.

### 9. System Prompt — Agent Awareness

In `claude.js buildSystemBlocks()`, add guidance for OpenRouter:
```javascript
if (PROVIDER === 'openrouter') {
    lines.push('You are running via OpenRouter. Your current model is ' + MODEL + '.');
}
```

---

## Testing Strategy

### Phase 1: Local Smoke Test
- Build APK, install on device
- Configure OpenRouter API key in Settings
- Set model to `anthropic/claude-sonnet-4-5`
- Send a simple message, verify response
- Verify streaming works (typing indicator + response arrives)

### Phase 2: Tool Use Test
- Ask agent to use a tool (e.g., `datetime`, `read`, `web_search`)
- Verify tool calls parse correctly from Chat Completions format
- Verify multi-turn tool use (agent calls tool, gets result, responds)

### Phase 3: Anthropic Cache Test
- Use an Anthropic model via OpenRouter
- Check API logs for `cache_read_input_tokens` in usage
- Verify cost savings from cached system prompt

### Phase 4: Cross-Model Test
- Switch to `google/gemini-2.5-pro` or `meta-llama/llama-4-maverick`
- Verify basic conversation works
- Verify tool use works (may vary by model capability)

### Phase 5: Edge Cases
- Invalid API key → clear error message
- Invalid model ID → clear error from OpenRouter
- Connection test button works
- Provider switching preserves config for other providers
- App restart reconnects with OpenRouter

---

## Build Guidance
**Gradle sync needed:** Yes — if we add new `buildConfigField` entries. Otherwise just build & run for JS + Kotlin changes.

## Risk Assessment
- **Medium risk:** New streaming parser could have edge cases with different model providers' streaming behavior via OpenRouter
- **Low risk:** Provider adapter pattern is well-established, just following the template
- **Mitigation:** Test with at least 2 different model families (Anthropic + non-Anthropic) via OpenRouter
