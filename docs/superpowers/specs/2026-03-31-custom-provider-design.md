# Custom AI Provider — Design Spec

**Date:** 2026-03-31
**Status:** Approved (v2 — post quality review)
**Reference:** PR #305 by @Tofu-killer (closed, used as design reference)

## Goal

Allow users to connect any OpenAI-compatible gateway or middleman API (LiteLLM, Ollama, vLLM, Together, Groq, Fireworks, DeepSeek, etc.) as an AI provider. Supports both HTTPS (cloud) and HTTP (local LLMs).

## Constraints

- No new dependencies
- Post-setup only (not in setup wizard — this is for geeks)
- Model field uses existing `model` config field (freeform, required — no default for custom)
- HTTP allowed with warning label
- Safe for 5,000+ existing users (no breaking changes)
- Both Chat Completions and Responses API formats supported

## Config Fields (4 new + existing `model`)

| Field | Type | Required | Encrypted | Default |
|-------|------|----------|-----------|---------|
| `customApiKey` | string | yes | yes (Keystore) | `""` |
| `customBaseUrl` | string | yes | no | `""` |
| `customHeaders` | string (JSON) | no | no | `""` |
| `customFormat` | string | no | no | `"chat_completions"` |
| `provider: "custom"` | existing field | — | — | `"claude"` (unchanged) |
| `model` | existing field | yes (required for custom) | no | `""` (no default for custom) |

**Note:** No separate `customModel` field. The existing `model` field handles this — same pattern as OpenRouter's freeform model ID.

## JS Side

### `providers/custom.js` (new file)

Delegates to existing adapters based on `customFormat` — **except `formatRequest`** which is custom-built to avoid OpenRouter-specific decorations (`cache_control`, fallback routing, `route: 'fallback'`).

**Delegation strategy:**
- `"chat_completions"` format:
  - `toApiMessages`, `fromApiResponse`, `formatSystemPrompt`, `formatTools`, `formatVision`, `normalizeUsage`, `parseRateLimitHeaders` → delegate to `openrouter.js`
  - `formatRequest` → **OWN implementation** (clean Chat Completions body, no `cache_control`, no `models[]` array, no `route` field)
- `"responses"` format:
  - All methods → delegate to `openai.js` (Responses API is OpenAI-native, no customization needed)

**Own `formatRequest` for Chat Completions:**
```javascript
formatRequest(model, maxTokens, instructions, input, tools) {
    const body = {
        model,
        stream: true,
        max_tokens: maxTokens,
        messages: [{ role: 'system', content: instructions }, ...input],
    };
    if (tools && tools.length > 0) body.tools = tools;
    return JSON.stringify(body);
}
```
This produces a clean, standard Chat Completions request body with zero provider-specific fields.

**Own `classifyError` and `classifyNetworkError`:**
Delegate to format adapter but replace provider names ("OpenAI", "OpenRouter", "Claude") with "custom provider" in all user-facing error messages.

Other exports:
- `id: 'custom'`
- `buildHeaders(apiKey)` — Bearer auth by default, skipped if custom headers include `Authorization`. All values sanitized (strip `\r\n`).
- `getEndpoint()` — returns parsed `CUSTOM_ENDPOINT` from config
- `streamProtocol` — `'chat-completions'` or `'openai-responses'` based on format
- `supportsCache: false`
- `authTypes: ['api_key']`

### `providers/index.js`

Add `register(require('./custom'))`.

### `config.js`

**Constants:**
- `CUSTOM_KEY = normalizeSecret(config.customApiKey || '')`
- `CUSTOM_BASE_URL = (typeof config.customBaseUrl === 'string' ? config.customBaseUrl : '').trim()`
- `CUSTOM_HEADERS_RAW = (typeof config.customHeaders === 'string' ? config.customHeaders : '').trim()`
- `CUSTOM_FORMAT = (typeof config.customFormat === 'string' ? config.customFormat : 'chat_completions').trim().toLowerCase()`

**Functions:**
- `parseCustomHeaders(raw)` — JSON.parse with validation: reject non-objects, arrays, prototype pollution keys. Returns `{}` on error with WARN log.
- `parseCustomEndpoint(raw)` — `new URL(raw)` → `{protocol, hostname, port, path}`. Strip trailing slash from path. Returns fallback `{protocol: 'https:', hostname: '', port: '', path: '/v1/chat/completions'}` on error.

**Critical wiring:**
- Add `'custom'` to `_SUPPORTED_PROVIDERS` Set (line ~103) — **without this, custom silently falls back to claude**
- Add `PROVIDER === 'custom' ? CUSTOM_KEY` to `_activeKey` ternary chain — **without this, Node.js process.exit(1) on startup**
- Add `customBaseUrl` required validation: `if (PROVIDER === 'custom' && !CUSTOM_BASE_URL) process.exit(1)`
- Add `CUSTOM_KEY` to `keyName` error message chain
- Export: `CUSTOM_KEY`, `CUSTOM_BASE_URL`, `CUSTOM_HEADERS`, `CUSTOM_FORMAT`, `CUSTOM_ENDPOINT`

### `ai.js`

**New helper (replaces 2 hardcoded ternaries):**
```javascript
function getProviderApiKey() {
    return PROVIDER === 'openai' ? OPENAI_KEY
        : PROVIDER === 'openrouter' ? OPENROUTER_KEY
        : PROVIDER === 'custom' ? CUSTOM_KEY
        : ANTHROPIC_KEY;
}
```

**Critical: replace BOTH existing hardcoded API key lookups:**
1. `claudeApiCall()` (~line 1108) — replace ternary with `getProviderApiKey()`
2. `summarizeOldMessages()` (~line 1679) — replace ternary with `getProviderApiKey()`

**Endpoint resolution (both call sites):**
Replace `adapter.endpoint.hostname` / `adapter.endpoint.path` with:
```javascript
const endpoint = adapter.getEndpoint ? adapter.getEndpoint() : adapter.endpoint;
// Pass protocol + port to streaming function
{ protocol: endpoint.protocol, hostname: endpoint.hostname, port: endpoint.port, path: endpoint.path }
```

**System prompt updates (`buildSystemBlocks`):**
- Add `PROVIDER === 'custom'` case to `billingUrl` ternary → `CUSTOM_BASE_URL || 'your custom endpoint'`
- Add `PROVIDER === 'custom'` case to `apiHost` ternary → resolve from endpoint hostname
- Add custom provider section:
  ```
  ## Provider
  You are running via a custom AI endpoint (model: ${MODEL}).
  Custom endpoint: ${CUSTOM_BASE_URL}
  ```

### `http.js`

**All 4 functions must be updated** — not just `httpRequest`:

```javascript
const http = require('http');
const https = require('https');

function getClient(options) {
    return options?.protocol === 'http:' ? http : https;
}
```

Replace in:
1. `httpRequest` — `https.request(options, ...)` → `getClient(options).request(options, ...)`
2. `httpStreamingRequest` — same
3. `httpOpenAIStreamingRequest` — same
4. `httpChatCompletionsStreamingRequest` — same

**Backward compatible:** existing callers don't pass `protocol`, so `getClient()` returns `https` by default (undefined !== 'http:').

## Kotlin Side

### `Providers.kt`

Add to `availableProviders`:
```kotlin
ProviderInfo(
    id = "custom",
    displayName = "Custom",
    authTypes = listOf("api_key"),
    keyHint = "your-api-key",
    consoleUrl = "https://seekerclaw.xyz/docs/custom-provider",
    keysUrl = "https://seekerclaw.xyz/docs/custom-provider",
)
```

Update `modelsForProvider`:
```kotlin
"openrouter", "custom" -> emptyList() // Freeform model ID
```

### `ConfigManager.kt`

**AppConfig** — add 4 fields:
- `customApiKey: String = ""`
- `customBaseUrl: String = ""`
- `customHeaders: String = ""`
- `customFormat: String = "chat_completions"`

**Storage keys:**
- `KEY_CUSTOM_API_KEY_ENC = "custom_api_key_enc"`
- `KEY_CUSTOM_BASE_URL = "custom_base_url"`
- `KEY_CUSTOM_HEADERS = "custom_headers"`
- `KEY_CUSTOM_FORMAT = "custom_format"`

**saveConfig():** Encrypted save for `customApiKey` (same pattern as other keys), plain putString for others.

**loadConfig():** Encrypted load for `customApiKey` with try/catch fallback to `""`, plain getString for others.

**updateField():** Add dispatch cases for `customApiKey`, `customBaseUrl`, `customHeaders`, `customFormat`.

**writeConfigJson():** Write all custom fields when non-blank.

**hasCredential check:** `"custom" -> customApiKey.isNotBlank() && customBaseUrl.isNotBlank()`

**redactedSnapshot():** Include `customSet=${config.customApiKey.isNotBlank()}` for diagnostics.

**providerLabel:** Add `"custom" -> "Custom"`.

### `ProviderConfigScreen.kt`

**`switchProvider()` function** — add custom case for freeform model default:
```kotlin
if (newProviderId == "custom") {
    val savedModel = prefs.getString("lastModel_custom", null)
    saveField("model", savedModel?.takeIf { it.isNotBlank() } ?: "")
}
```
Empty default forces user to set a model (required field).

**Custom provider section** (when `activeProvider == "custom"`):
- **Model** (required) — freeform text field
- **Endpoint URL** (required) — freeform text field
- **API Key** (required) — masked field with edit dialog
- **API Format** — picker dialog: "Chat Completions" (default) / "Responses API"
- **Extra Headers** — optional JSON field, clearable. Validate JSON on save, show error for malformed input.
- **HTTP Warning** — when URL starts with `http://` (not `https://`), show orange text below URL field: "⚠ Unencrypted connection — API key will be sent in plaintext"
- **Test Connection** — sends minimal Chat Completions or Responses API request to the endpoint with `max_tokens: 1`

### `DashboardScreen.kt`

Update credential check:
```kotlin
"custom" -> config?.customApiKey?.isNotBlank() == true && config.customBaseUrl.isNotBlank()
```

### `SetupScreen.kt`

NO changes. Custom provider is post-setup only.

### `ConfigClaimImporter.kt`

Parse custom fields from QR payload for future QR v2 support. Route credential by provider.

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Trailing slash in URL | `parseCustomEndpoint` strips trailing slash from path |
| Malformed JSON in headers | `parseCustomHeaders` returns `{}` with WARN log; UI validates on save |
| Gateway returns non-standard errors | `classifyError` delegates to format adapter, falls back to generic message |
| Empty model field | Config validation blocks save; system prompt warns agent |
| `http://` URL | Allowed; orange warning in UI |
| Existing users (claude/openai/openrouter) | Zero impact — custom fields default to empty, never auto-selected |
| Custom provider with no `customBaseUrl` | `config.js` exits with clear error message on startup |

## What Stays Unchanged

- Setup wizard — no custom provider option
- Existing providers — zero changes to claude/openai/openrouter behavior
- QR v1 format — untouched
- Tool count — 71 (unchanged)
- Existing user configs — `"custom"` provider is never auto-selected

## Contributor Credit

After shipping and device verification, add @Tofu-killer to README contributors section for proposing and prototyping custom provider support.
