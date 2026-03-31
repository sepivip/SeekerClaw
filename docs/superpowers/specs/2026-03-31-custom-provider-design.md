# Custom AI Provider — Design Spec

**Date:** 2026-03-31
**Status:** Approved
**Reference:** PR #305 by @Tofu-killer (closed, used as design reference)

## Goal

Allow users to connect any OpenAI-compatible gateway or middleman API (LiteLLM, Ollama, vLLM, Together, Groq, Fireworks, DeepSeek, etc.) as an AI provider. Supports both HTTPS (cloud) and HTTP (local LLMs).

## Constraints

- No new dependencies
- Post-setup only (not in setup wizard — this is for geeks)
- Empty model field, required (no default)
- HTTP allowed with warning label
- Safe for 5,000+ existing users (no breaking changes)
- Both Chat Completions and Responses API formats supported

## Config Fields (6 new)

| Field | Type | Required | Encrypted | Default |
|-------|------|----------|-----------|---------|
| `customApiKey` | string | yes | yes (Keystore) | `""` |
| `customBaseUrl` | string | yes | no | `""` |
| `customModel` | string | yes | no | `""` |
| `customHeaders` | string (JSON) | no | no | `""` |
| `customFormat` | string | no | no | `"chat_completions"` |
| `provider` | existing | — | — | `"claude"` (unchanged) |

## JS Side

### `providers/custom.js` (new file)

Delegates to existing adapters based on `customFormat`:
- `"chat_completions"` → delegates to `openrouter.js` (Chat Completions wire format)
- `"responses"` → delegates to `openai.js` (Responses API wire format)

Exports:
- `id: 'custom'`
- `buildHeaders(apiKey)` — Bearer auth by default, skipped if custom headers include `Authorization`
- `getEndpoint()` — parses `customBaseUrl` into `{protocol, hostname, port, path}`
- `sanitizeHeaderValue(value)` — strips `\r\n` from header values (CRLF injection defense)
- `streamProtocol` — `'chat-completions'` or `'openai-responses'` based on format
- All format methods delegated: `toApiMessages`, `fromApiResponse`, `formatSystemPrompt`, `formatTools`, `formatRequest`, `formatVision`, `classifyError`, `classifyNetworkError`, `normalizeUsage`, `parseRateLimitHeaders`
- `supportsCache: false`
- `authTypes: ['api_key']`

### `providers/index.js`

Add `register(require('./custom'))`.

### `config.js`

- Add `CUSTOM_KEY`, `CUSTOM_BASE_URL`, `CUSTOM_HEADERS_RAW`, `CUSTOM_FORMAT`, `CUSTOM_ENDPOINT` constants
- Add `parseCustomHeaders(raw)` — JSON parse with validation, returns `{}` on error
- Add `parseCustomEndpoint(raw)` — URL parse into `{protocol, hostname, port, path}`, returns fallback on error
- Add `'custom'` to `_SUPPORTED_PROVIDERS` set
- Add custom key to `_activeKey` validation
- Add `customBaseUrl` required validation when provider is custom
- Export all new constants

### `ai.js`

- Import `CUSTOM_KEY`, `CUSTOM_BASE_URL` from config
- Add `getProviderApiKey()` helper — centralizes key lookup by provider
- Update `claudeApiCall()` — use `adapter.getEndpoint()` for endpoint resolution, pass `protocol` and `port` to streaming functions
- Update `summarizeOldMessages()` — same endpoint resolution pattern
- Update `buildSystemBlocks()` — add custom provider section to system prompt, update billing/API host references

### `http.js`

- Add `require('http')` alongside existing `require('https')`
- Add `getClient(options)` — returns `http` or `https` based on `options.protocol`
- Update all 4 request functions to use `getClient()`: `httpRequest`, `httpStreamingRequest`, `httpOpenAIStreamingRequest`, `httpChatCompletionsStreamingRequest`

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

Add to `modelsForProvider`:
```kotlin
"openrouter", "custom" -> emptyList() // Freeform model ID
```

### `ConfigManager.kt`

- Add to `AppConfig`: `customApiKey`, `customBaseUrl`, `customHeaders`, `customFormat` (all String, defaults `""` except format `"chat_completions"`)
- Add storage keys: `KEY_CUSTOM_API_KEY_ENC`, `KEY_CUSTOM_BASE_URL`, `KEY_CUSTOM_HEADERS`, `KEY_CUSTOM_FORMAT`
- Add encrypted save/load for `customApiKey`
- Add plain save/load for `customBaseUrl`, `customHeaders`, `customFormat`
- Add to `updateField()` dispatch
- Add to `writeConfigJson()` — write all custom fields when non-blank
- Add to `hasCredential` check: `customApiKey.isNotBlank() && customBaseUrl.isNotBlank()`
- Add to debug status string

### `ProviderConfigScreen.kt`

Custom provider section (when `activeProvider == "custom"`):
- **Model** (required) — freeform text field
- **Endpoint URL** (required) — freeform text field, e.g. `https://your-gateway.example/v1/chat/completions`
- **API Key** (required) — masked field with edit dialog
- **API Format** — picker dialog: "Chat Completions" (default) / "Responses API"
- **Extra Headers** — optional JSON field, clearable
- **HTTP Warning** — when URL starts with `http://`, show orange text: "⚠ Unencrypted connection — API key will be sent in plaintext"
- **Test Connection** — sends minimal request to endpoint

### `DashboardScreen.kt`

Update credential check:
```kotlin
"custom" -> config?.customApiKey?.isNotBlank() == true && config.customBaseUrl.isNotBlank()
```

### `SetupScreen.kt`

NO changes. Custom provider is post-setup only.

### `ConfigClaimImporter.kt`

Parse custom fields from QR payload for future QR v2 support. Route credential by provider.

## What Stays Unchanged

- Setup wizard — no custom provider option
- Existing providers — zero changes to claude/openai/openrouter behavior
- QR v1 format — untouched
- Tool count — 71 (unchanged)
- Existing user configs — `"custom"` provider is never auto-selected

## Contributor Credit

After shipping and device verification, add @Tofu-killer to README contributors section for proposing and prototyping custom provider support.
