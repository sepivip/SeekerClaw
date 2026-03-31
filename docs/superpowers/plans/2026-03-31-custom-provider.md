# Custom AI Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generic custom AI provider so SeekerClaw works with any OpenAI-compatible gateway (LiteLLM, Ollama, vLLM, Together, Groq, Fireworks, DeepSeek, etc.).

**Architecture:** New `providers/custom.js` delegates to existing adapters (openrouter for Chat Completions, openai for Responses API) but uses its own `formatRequest` to avoid OpenRouter-specific decorations. Kotlin side adds 4 config fields, a provider entry, and UI in ProviderConfigScreen. HTTP support added to `http.js` for local gateways.

**Tech Stack:** Node.js 18 (JS agent), Kotlin/Jetpack Compose (Android UI), HTTPS/HTTP REST APIs

---

## File Map

### JS (Node.js Agent) — `app/src/main/assets/nodejs-project/`

| File | Action | Responsibility |
|------|--------|----------------|
| `http.js` | **Modify** | Add `require('http')` + `getClient()` helper. Update all 4 request functions to use `getClient()`. |
| `config.js` | **Modify** | Add `CUSTOM_KEY`, `CUSTOM_BASE_URL`, `CUSTOM_HEADERS`, `CUSTOM_FORMAT`, `CUSTOM_ENDPOINT`. Add `'custom'` to supported providers. Add validation. Add exports. |
| `providers/custom.js` | **Create** | Custom provider adapter. Own `formatRequest` + `buildHeaders` + `getEndpoint`. Delegates other methods to openrouter/openai. |
| `providers/index.js` | **Modify** | Register custom adapter. |
| `ai.js` | **Modify** | Add `getProviderApiKey()` helper. Replace 2 hardcoded API key ternaries. Update endpoint resolution in 2 call sites. Update system prompt. |

### Kotlin (Android) — `app/src/main/java/com/seekerclaw/app/`

| File | Action | Responsibility |
|------|--------|----------------|
| `config/Providers.kt` | **Modify** | Add custom ProviderInfo. Update `modelsForProvider`. |
| `config/ConfigManager.kt` | **Modify** | Add 4 fields to AppConfig, storage keys, save/load/update/writeConfigJson. |
| `ui/settings/ProviderConfigScreen.kt` | **Modify** | Add custom provider UI section, format picker, HTTP warning, test connection. |
| `ui/dashboard/DashboardScreen.kt` | **Modify** | Add custom credential check. |
| `config/ConfigClaimImporter.kt` | **Modify** | Parse custom fields for future QR v2. |

---

## Task 1: JS — Add HTTP support to `http.js`

**Files:**
- Modify: `app/src/main/assets/nodejs-project/http.js:1-6` (imports), `:12` (httpRequest), `:56` (httpStreamingRequest), `:231` (httpOpenAIStreamingRequest), `:414` (httpChatCompletionsStreamingRequest)

- [ ] **Step 1: Add `http` import and `getClient` helper**

At the top of `http.js`, replace:
```javascript
const https = require('https');
```
with:
```javascript
const http = require('http');
const https = require('https');

function getClient(options) {
    return options?.protocol === 'http:' ? http : https;
}
```

- [ ] **Step 2: Update all 4 `https.request` calls to `getClient(options).request`**

In `httpRequest` (~line 12):
```javascript
// OLD: const req = https.request(options, (res) => {
const req = getClient(options).request(options, (res) => {
```

In `httpStreamingRequest` (~line 56):
```javascript
// OLD: req = https.request(options, (res) => {
req = getClient(options).request(options, (res) => {
```

In `httpOpenAIStreamingRequest` (~line 231):
```javascript
// OLD: req = https.request(options, (res) => {
req = getClient(options).request(options, (res) => {
```

In `httpChatCompletionsStreamingRequest` (~line 414):
```javascript
// OLD: req = https.request(options, (res) => {
req = getClient(options).request(options, (res) => {
```

- [ ] **Step 3: Syntax check**
```bash
node --check http.js && echo "OK"
```

- [ ] **Step 4: Commit**
```bash
git add app/src/main/assets/nodejs-project/http.js
git commit -m "feat: add HTTP protocol support to http.js for local gateways"
```

---

## Task 2: JS — Add custom provider constants to `config.js`

**Files:**
- Modify: `app/src/main/assets/nodejs-project/config.js:103` (_SUPPORTED_PROVIDERS), `:108` (after OPENROUTER_KEY), `:113` (_defaultModel), `:172` (_activeKey), `:176` (keyName), `:189` (authLabel), `:404-474` (exports)

- [ ] **Step 1: Add `'custom'` to `_SUPPORTED_PROVIDERS`**

Replace line ~103:
```javascript
const _SUPPORTED_PROVIDERS = new Set(['claude', 'openai', 'openrouter']);
```
with:
```javascript
const _SUPPORTED_PROVIDERS = new Set(['claude', 'openai', 'openrouter', 'custom']);
```

- [ ] **Step 2: Add custom constants after `OPENROUTER_KEY`**

After line ~108 (`const OPENROUTER_KEY = ...`), add:
```javascript
const CUSTOM_KEY = normalizeSecret(config.customApiKey || '');
const CUSTOM_BASE_URL = (typeof config.customBaseUrl === 'string' ? config.customBaseUrl : '').trim();
const CUSTOM_HEADERS_RAW = (typeof config.customHeaders === 'string' ? config.customHeaders : '').trim();
const CUSTOM_FORMAT = (typeof config.customFormat === 'string' ? config.customFormat : 'chat_completions').trim().toLowerCase();
```

- [ ] **Step 3: Update `_defaultModel` — no default for custom**

Replace lines ~113-115:
```javascript
const _defaultModel = PROVIDER === 'openai' ? 'gpt-5.2'
    : PROVIDER === 'openrouter' ? 'anthropic/claude-sonnet-4-6'
    : 'claude-opus-4-6';
```
with:
```javascript
const _defaultModel = PROVIDER === 'openai' ? 'gpt-5.2'
    : PROVIDER === 'openrouter' ? 'anthropic/claude-sonnet-4-6'
    : PROVIDER === 'custom' ? ''
    : 'claude-opus-4-6';
```

- [ ] **Step 4: Update `_activeKey` validation**

Replace lines ~172-174:
```javascript
const _activeKey = PROVIDER === 'openai' ? OPENAI_KEY
    : PROVIDER === 'openrouter' ? OPENROUTER_KEY
    : ANTHROPIC_KEY;
```
with:
```javascript
const _activeKey = PROVIDER === 'openai' ? OPENAI_KEY
    : PROVIDER === 'openrouter' ? OPENROUTER_KEY
    : PROVIDER === 'custom' ? CUSTOM_KEY
    : ANTHROPIC_KEY;
```

- [ ] **Step 5: Update `keyName` error message**

Replace lines ~176-178:
```javascript
    const keyName = PROVIDER === 'openai' ? 'openaiApiKey'
        : PROVIDER === 'openrouter' ? 'openrouterApiKey'
        : 'anthropicApiKey';
```
with:
```javascript
    const keyName = PROVIDER === 'openai' ? 'openaiApiKey'
        : PROVIDER === 'openrouter' ? 'openrouterApiKey'
        : PROVIDER === 'custom' ? 'customApiKey'
        : 'anthropicApiKey';
```

- [ ] **Step 6: Add `customBaseUrl` required validation**

After the `process.exit(1)` block (~line 181), add:
```javascript
if (PROVIDER === 'custom' && !CUSTOM_BASE_URL) {
    log('ERROR: Missing required config (customBaseUrl) for provider "custom"', 'ERROR');
    process.exit(1);
}
```

- [ ] **Step 7: Update `authLabel`**

Replace line ~189:
```javascript
    const authLabel = PROVIDER === 'openai' ? 'api-key' : (AUTH_TYPE === 'setup_token' ? 'setup-token' : 'api-key');
```
with:
```javascript
    const authLabel = PROVIDER === 'claude' ? (AUTH_TYPE === 'setup_token' ? 'setup-token' : 'api-key') : 'api-key';
```

- [ ] **Step 8: Add `parseCustomHeaders` and `parseCustomEndpoint` functions**

Before the `// FILE PATHS` section (~line 193), add:
```javascript
function parseCustomHeaders(raw) {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out = {};
        for (const [key, value] of Object.entries(parsed)) {
            const headerKey = String(key || '').trim();
            if (!headerKey || headerKey === '__proto__' || headerKey === 'constructor' || headerKey === 'prototype') continue;
            if (value == null) continue;
            out[headerKey] = String(value);
        }
        return out;
    } catch (e) {
        log(`[Config] Failed to parse customHeaders JSON: ${e.message}`, 'WARN');
        return {};
    }
}

function parseCustomEndpoint(raw) {
    const fallback = { protocol: 'https:', hostname: '', port: '', path: '/v1/chat/completions' };
    if (!raw) return fallback;
    try {
        const url = new URL(raw);
        let urlPath = url.pathname || '/';
        if (urlPath.endsWith('/') && urlPath.length > 1) urlPath = urlPath.slice(0, -1);
        if (url.search) urlPath += url.search;
        return {
            protocol: url.protocol || 'https:',
            hostname: url.hostname || '',
            port: url.port || '',
            path: urlPath,
        };
    } catch (e) {
        log(`[Config] Invalid customBaseUrl "${raw}": ${e.message}`, 'WARN');
        return fallback;
    }
}

const CUSTOM_HEADERS = parseCustomHeaders(CUSTOM_HEADERS_RAW);
const CUSTOM_ENDPOINT = parseCustomEndpoint(CUSTOM_BASE_URL);
```

- [ ] **Step 9: Add to exports**

In `module.exports`, after `OPENROUTER_KEY,` add:
```javascript
    CUSTOM_KEY,
    CUSTOM_BASE_URL,
    CUSTOM_HEADERS,
    CUSTOM_FORMAT,
    CUSTOM_ENDPOINT,
```

- [ ] **Step 10: Syntax check**
```bash
node --check config.js && echo "OK"
```

- [ ] **Step 11: Commit**
```bash
git add app/src/main/assets/nodejs-project/config.js
git commit -m "feat: add custom provider constants and validation to config.js"
```

---

## Task 3: JS — Create `providers/custom.js`

**Files:**
- Create: `app/src/main/assets/nodejs-project/providers/custom.js`
- Modify: `app/src/main/assets/nodejs-project/providers/index.js`

- [ ] **Step 1: Create `providers/custom.js`**

```javascript
// SeekerClaw — providers/custom.js
// Generic custom provider for OpenAI-compatible gateways and middlemen.
// Delegates to openrouter.js (Chat Completions) or openai.js (Responses API)
// but uses own formatRequest to avoid OpenRouter-specific decorations.

const {
    CUSTOM_KEY,
    CUSTOM_HEADERS,
    CUSTOM_FORMAT,
    CUSTOM_ENDPOINT,
} = require('../config');

const openai = require('./openai');
const openrouter = require('./openrouter');

function delegate() {
    return CUSTOM_FORMAT === 'responses' ? openai : openrouter;
}

function sanitizeHeaderValue(value) {
    return String(value).replace(/[\r\n]+/g, ' ').trim();
}

function buildHeaders(apiKey) {
    const headers = {
        'Content-Type': 'application/json',
        ...CUSTOM_HEADERS,
    };
    const effectiveKey = apiKey || CUSTOM_KEY;
    const hasAuthHeader = Object.keys(headers).some(k => k.toLowerCase() === 'authorization');
    if (effectiveKey && !hasAuthHeader) {
        headers.Authorization = `Bearer ${effectiveKey}`;
    }
    for (const key of Object.keys(headers)) {
        headers[key] = sanitizeHeaderValue(headers[key]);
    }
    return headers;
}

function getEndpoint() {
    return CUSTOM_ENDPOINT;
}

function classifyError(status, data) {
    const base = delegate().classifyError(status, data);
    if (!base || typeof base !== 'object') {
        return { type: 'unknown', retryable: false, userMessage: `Custom provider error (${status}).` };
    }
    return {
        ...base,
        userMessage: String(base.userMessage || `Custom provider error (${status}).`)
            .replace(/OpenAI/g, 'custom provider')
            .replace(/OpenRouter/g, 'custom provider')
            .replace(/Claude/g, 'custom provider')
            .replace(/Anthropic/g, 'custom provider'),
    };
}

function classifyNetworkError(err) {
    const base = delegate().classifyNetworkError(err);
    return {
        ...base,
        userMessage: String(base?.userMessage || 'A network error occurred. Please try again.')
            .replace(/OpenAI/g, 'custom provider')
            .replace(/OpenRouter/g, 'custom provider')
            .replace(/Claude/g, 'custom provider')
            .replace(/Anthropic/g, 'custom provider'),
    };
}

module.exports = {
    id: 'custom',
    name: 'Custom',

    get endpoint() { return getEndpoint(); },
    getEndpoint,

    get streamProtocol() {
        return CUSTOM_FORMAT === 'responses' ? 'openai-responses' : 'chat-completions';
    },

    buildHeaders,

    toApiMessages(messages) { return delegate().toApiMessages(messages); },
    fromApiResponse(raw) { return delegate().fromApiResponse(raw); },
    formatSystemPrompt(stable, dynamic, authType) { return delegate().formatSystemPrompt(stable, dynamic, authType); },
    formatTools(tools) { return delegate().formatTools(tools); },
    formatVision(base64, mediaType) { return delegate().formatVision(base64, mediaType); },

    // Own formatRequest — clean Chat Completions body without OpenRouter cache_control/fallback
    formatRequest(model, maxTokens, instructions, input, tools) {
        if (CUSTOM_FORMAT === 'responses') {
            return openai.formatRequest(model, maxTokens, instructions, input, tools);
        }
        const body = {
            model,
            stream: true,
            max_tokens: maxTokens,
            messages: [{ role: 'system', content: instructions }, ...input],
        };
        if (tools && tools.length > 0) body.tools = tools;
        return JSON.stringify(body);
    },

    classifyError,
    classifyNetworkError,
    normalizeUsage(usage) { return delegate().normalizeUsage(usage); },
    parseRateLimitHeaders(headers) { return delegate().parseRateLimitHeaders(headers); },

    supportsCache: false,
    authTypes: ['api_key'],
};
```

- [ ] **Step 2: Register in `providers/index.js`**

Add before `module.exports`:
```javascript
register(require('./custom'));
```

- [ ] **Step 3: Syntax check**
```bash
node --check providers/custom.js && node --check providers/index.js && echo "OK"
```

- [ ] **Step 4: Commit**
```bash
git add app/src/main/assets/nodejs-project/providers/custom.js app/src/main/assets/nodejs-project/providers/index.js
git commit -m "feat: add custom provider adapter with own formatRequest"
```

---

## Task 4: JS — Update `ai.js` for custom provider

**Files:**
- Modify: `app/src/main/assets/nodejs-project/ai.js:11` (imports), `:53` (new helper), `:730-731` (system prompt), `:898-906` (provider section), `:1107-1110` (claudeApiCall key), `:1129-1134` (claudeApiCall endpoint), `:1679` (summarize key), `:1701-1706` (summarize endpoint)

- [ ] **Step 1: Add `CUSTOM_KEY`, `CUSTOM_BASE_URL` to imports**

In the config import block (~line 11), add `CUSTOM_KEY, CUSTOM_BASE_URL,` to the destructured imports from `'../config'`.

- [ ] **Step 2: Add `getProviderApiKey()` helper**

After the `setChatDeps` function (~line 53), add:
```javascript
function getProviderApiKey() {
    return PROVIDER === 'openai' ? OPENAI_KEY
        : PROVIDER === 'openrouter' ? OPENROUTER_KEY
        : PROVIDER === 'custom' ? CUSTOM_KEY
        : ANTHROPIC_KEY;
}
```

- [ ] **Step 3: Update `billingUrl` and `apiHost` in `buildSystemBlocks`**

Replace line ~730:
```javascript
    const billingUrl = PROVIDER === 'openai' ? 'platform.openai.com' : PROVIDER === 'openrouter' ? 'openrouter.ai/credits' : 'console.anthropic.com';
    const apiHost = PROVIDER === 'openai' ? 'api.openai.com' : PROVIDER === 'openrouter' ? 'openrouter.ai' : 'api.anthropic.com';
```
with:
```javascript
    const billingUrl = PROVIDER === 'openai' ? 'platform.openai.com'
        : PROVIDER === 'openrouter' ? 'openrouter.ai/credits'
        : PROVIDER === 'custom' ? (CUSTOM_BASE_URL || 'your custom endpoint')
        : 'console.anthropic.com';
    const apiHost = PROVIDER === 'openai' ? 'api.openai.com'
        : PROVIDER === 'openrouter' ? 'openrouter.ai'
        : PROVIDER === 'custom' ? (getAdapter(PROVIDER).getEndpoint().hostname || 'custom endpoint')
        : 'api.anthropic.com';
```

- [ ] **Step 4: Add custom provider section to system prompt**

After the OpenRouter provider section (~line 906, after the closing `}`), add:
```javascript
    } else if (PROVIDER === 'custom') {
        lines.push('## Provider');
        lines.push(`You are running via a custom AI endpoint (model: ${MODEL}).`);
        if (CUSTOM_BASE_URL) lines.push(`Custom endpoint: ${CUSTOM_BASE_URL}`);
        lines.push('');
    }
```

Note: this replaces the existing `}` before `// Runtime limitations` — the structure becomes `} else if (PROVIDER === 'custom') { ... }`.

- [ ] **Step 5: Replace API key lookup in `claudeApiCall`**

Replace lines ~1108-1110:
```javascript
        const apiKey = PROVIDER === 'openai' ? OPENAI_KEY
            : PROVIDER === 'openrouter' ? OPENROUTER_KEY
            : ANTHROPIC_KEY;
```
with:
```javascript
        const endpoint = adapter.getEndpoint ? adapter.getEndpoint() : adapter.endpoint;
        const apiKey = getProviderApiKey();
```

- [ ] **Step 6: Update endpoint resolution in `claudeApiCall`**

Replace lines ~1129-1134:
```javascript
                res = await streamFn({
                    hostname: adapter.endpoint.hostname,
                    path: adapter.endpoint.path,
                    method: 'POST',
                    headers,
                }, body);
```
with:
```javascript
                res = await streamFn({
                    protocol: endpoint.protocol,
                    hostname: endpoint.hostname,
                    port: endpoint.port,
                    path: endpoint.path,
                    method: 'POST',
                    headers,
                }, body);
```

- [ ] **Step 7: Replace API key lookup in `summarizeOldMessages`**

Replace line ~1679:
```javascript
        const apiKey = PROVIDER === 'openai' ? OPENAI_KEY : PROVIDER === 'openrouter' ? OPENROUTER_KEY : ANTHROPIC_KEY;
```
with:
```javascript
        const endpoint = adapter.getEndpoint ? adapter.getEndpoint() : adapter.endpoint;
        const apiKey = getProviderApiKey();
```

- [ ] **Step 8: Update endpoint resolution in `summarizeOldMessages`**

Replace lines ~1701-1706:
```javascript
        const res = await streamFn({
            hostname: adapter.endpoint.hostname,
            path: adapter.endpoint.path,
            method: 'POST',
            headers,
        }, body);
```
with:
```javascript
        const res = await streamFn({
            protocol: endpoint.protocol,
            hostname: endpoint.hostname,
            port: endpoint.port,
            path: endpoint.path,
            method: 'POST',
            headers,
        }, body);
```

- [ ] **Step 9: Syntax check**
```bash
node --check ai.js && echo "OK"
```

- [ ] **Step 10: Commit**
```bash
git add app/src/main/assets/nodejs-project/ai.js
git commit -m "feat: wire custom provider into ai.js — API key helper, endpoint resolution, system prompt"
```

---

## Task 5: JS — Smoke test

- [ ] **Step 1: Syntax check all modified files**
```bash
cd app/src/main/assets/nodejs-project
node --check http.js && node --check config.js && node --check providers/custom.js && node --check providers/index.js && node --check ai.js && echo "ALL OK"
```

- [ ] **Step 2: Verify no DDG/broken references leaked**
```bash
grep -rn "PROVIDER === 'custom'" ai.js config.js providers/custom.js | head -20
grep -rn "CUSTOM_KEY\|CUSTOM_BASE_URL\|CUSTOM_FORMAT\|CUSTOM_ENDPOINT\|CUSTOM_HEADERS" config.js providers/custom.js ai.js | head -30
```

- [ ] **Step 3: Commit** (if any fixes needed)

---

## Task 6: Kotlin — Update `Providers.kt`

**Files:**
- Modify: `app/src/main/java/com/seekerclaw/app/config/Providers.kt`

- [ ] **Step 1: Add custom ProviderInfo**

After the OpenRouter entry (~line 40), add:
```kotlin
    ProviderInfo(
        id = "custom",
        displayName = "Custom",
        authTypes = listOf("api_key"),
        keyHint = "your-api-key",
        consoleUrl = "https://seekerclaw.xyz/docs/custom-provider",
        keysUrl = "https://seekerclaw.xyz/docs/custom-provider",
    ),
```

- [ ] **Step 2: Update `modelsForProvider`**

Replace line ~53:
```kotlin
    "openrouter" -> emptyList() // Freeform: user types model ID (100+ models)
```
with:
```kotlin
    "openrouter", "custom" -> emptyList() // Freeform: user types model ID
```

- [ ] **Step 3: Commit**
```bash
git add app/src/main/java/com/seekerclaw/app/config/Providers.kt
git commit -m "feat: add custom provider to Kotlin registry"
```

---

## Task 7: Kotlin — Update `ConfigManager.kt`

**Files:**
- Modify: `app/src/main/java/com/seekerclaw/app/config/ConfigManager.kt`

- [ ] **Step 1: Add fields to `AppConfig`**

After `openrouterApiKey` (~line 48), add:
```kotlin
    val customApiKey: String = "",
    val customBaseUrl: String = "",
    val customHeaders: String = "",
    val customFormat: String = "chat_completions",
```

- [ ] **Step 2: Add storage keys**

After `KEY_OPENROUTER_API_KEY_ENC` (~line 106), add:
```kotlin
    private const val KEY_CUSTOM_API_KEY_ENC = "custom_api_key_enc"
    private const val KEY_CUSTOM_BASE_URL = "custom_base_url"
    private const val KEY_CUSTOM_HEADERS = "custom_headers"
    private const val KEY_CUSTOM_FORMAT = "custom_format"
```

- [ ] **Step 3: Add to `saveConfig()`**

After the OpenRouter key save block, add:
```kotlin
        if (config.customApiKey.isNotBlank()) {
            val encCustom = KeystoreHelper.encrypt(config.customApiKey)
            editor.putString(KEY_CUSTOM_API_KEY_ENC, Base64.encodeToString(encCustom, Base64.NO_WRAP))
        } else {
            editor.remove(KEY_CUSTOM_API_KEY_ENC)
        }
        editor.putString(KEY_CUSTOM_BASE_URL, config.customBaseUrl)
        editor.putString(KEY_CUSTOM_HEADERS, config.customHeaders)
        editor.putString(KEY_CUSTOM_FORMAT, config.customFormat)
```

- [ ] **Step 4: Add to `loadConfig()`**

After the OpenRouter key decrypt block, add:
```kotlin
        val customApiKey = try {
            val enc = p.getString(KEY_CUSTOM_API_KEY_ENC, null)
            if (enc != null) KeystoreHelper.decrypt(Base64.decode(enc, Base64.NO_WRAP)) else ""
        } catch (e: Exception) {
            Log.w(TAG, "Failed to decrypt custom API key", e)
            LogCollector.append("[Config] Failed to decrypt custom API key: ${e.javaClass.simpleName}", LogLevel.ERROR)
            ""
        }
```

And add to the `return AppConfig(...)` call:
```kotlin
            customApiKey = customApiKey,
            customBaseUrl = p.getString(KEY_CUSTOM_BASE_URL, "") ?: "",
            customHeaders = p.getString(KEY_CUSTOM_HEADERS, "") ?: "",
            customFormat = p.getString(KEY_CUSTOM_FORMAT, "chat_completions") ?: "chat_completions",
```

- [ ] **Step 5: Add to `updateField()`**

After the openrouterApiKey case, add:
```kotlin
            "customApiKey" -> config.copy(customApiKey = value)
            "customBaseUrl" -> config.copy(customBaseUrl = value)
            "customHeaders" -> config.copy(customHeaders = value)
            "customFormat" -> config.copy(customFormat = value)
```

- [ ] **Step 6: Add to `writeConfigJson()`**

After the openrouterApiKey line, add:
```kotlin
            if (config.customApiKey.isNotBlank()) put("customApiKey", config.customApiKey)
            if (config.customBaseUrl.isNotBlank()) put("customBaseUrl", config.customBaseUrl)
            if (config.customHeaders.isNotBlank()) put("customHeaders", config.customHeaders)
            if (config.customFormat.isNotBlank()) put("customFormat", config.customFormat)
```

Also update the `anthropicApiKey` guard to include custom:
```kotlin
            put("anthropicApiKey", if (config.provider in listOf("openai", "openrouter", "custom")) "" else config.activeCredential)
```

- [ ] **Step 7: Update `hasCredential` check**

Add before the `else` case:
```kotlin
            "custom" -> config.customApiKey.isNotBlank() && config.customBaseUrl.isNotBlank()
```

- [ ] **Step 8: Update `redactedSnapshot()`**

Add `customSet=${config.customApiKey.isNotBlank()}` to the debug string.

- [ ] **Step 9: Update `providerLabel`**

Add:
```kotlin
            "custom" -> "Custom"
```

- [ ] **Step 10: Commit**
```bash
git add app/src/main/java/com/seekerclaw/app/config/ConfigManager.kt
git commit -m "feat: add custom provider fields to ConfigManager"
```

---

## Task 8: Kotlin — Update `ProviderConfigScreen.kt`

**Files:**
- Modify: `app/src/main/java/com/seekerclaw/app/ui/settings/ProviderConfigScreen.kt`

- [ ] **Step 1: Add format picker state**

After `showAuthTypePicker` state, add:
```kotlin
    var showCustomFormatPicker by remember { mutableStateOf(false) }
```

Add helper:
```kotlin
    fun customFormatLabel(value: String?): String = when (value) {
        "responses" -> "Responses API"
        else -> "Chat Completions"
    }
```

- [ ] **Step 2: Update `switchProvider` for custom**

In the `switchProvider` function, in the `if (modelsForNew.isEmpty())` block, update the default model:
```kotlin
            val defaultModel = when (newProviderId) {
                "openrouter" -> "anthropic/claude-sonnet-4-6"
                "custom" -> ""
                else -> ""
            }
```

- [ ] **Step 3: Add custom provider UI section**

After the `"openrouter"` case block and before the closing `}` of the provider-specific when, add:
```kotlin
                    "custom" -> {
                        ProviderConfigField(
                            label = "Model",
                            value = config?.model?.ifBlank { "Not set" } ?: "Not set",
                            onClick = {
                                editField = "model"
                                editLabel = "Model ID"
                                editValue = config?.model ?: ""
                            },
                            info = "Model ID expected by your gateway (e.g. gpt-4.1-mini, claude-3-7-sonnet, deepseek-chat).",
                            isRequired = true,
                        )
                        ProviderConfigField(
                            label = "Endpoint URL",
                            value = config?.customBaseUrl?.ifBlank { "Not set" } ?: "Not set",
                            onClick = {
                                editField = "customBaseUrl"
                                editLabel = "Endpoint URL"
                                editValue = config?.customBaseUrl ?: ""
                            },
                            info = "Full inference endpoint URL (e.g. https://your-gateway.example/v1/chat/completions).",
                            isRequired = true,
                        )
                        // HTTP warning
                        if (config?.customBaseUrl?.startsWith("http://") == true) {
                            Text(
                                text = "⚠ Unencrypted connection — API key will be sent in plaintext",
                                color = Color(0xFFFF9800),
                                fontSize = 12.sp,
                                fontFamily = RethinkSans,
                                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                            )
                        }
                        ProviderConfigField(
                            label = "API Format",
                            value = customFormatLabel(config?.customFormat),
                            onClick = { showCustomFormatPicker = true },
                            info = "Wire format your gateway expects.",
                        )
                        ProviderConfigField(
                            label = "Extra Headers (JSON)",
                            value = config?.customHeaders?.ifBlank { "Not set" } ?: "Not set",
                            onClick = {
                                editField = "customHeaders"
                                editLabel = "Extra Headers (JSON)"
                                editValue = config?.customHeaders ?: ""
                            },
                            info = "Optional JSON object merged into request headers. Example: {\"X-API-Key\":\"...\"}",
                        )
                        ProviderConfigField(
                            label = "API Key",
                            value = maskKey(config?.customApiKey),
                            onClick = {
                                editField = "customApiKey"
                                editLabel = "API Key"
                                editValue = config?.customApiKey ?: ""
                            },
                            info = "Used as Bearer auth unless Authorization is set in Extra Headers.",
                            isRequired = true,
                            showDivider = false,
                        )
                    }
```

- [ ] **Step 4: Add `customHeaders` to clearable fields**

Update the clearableFields set:
```kotlin
                val clearableFields = setOf("openrouterFallbackModel", "customHeaders")
```

- [ ] **Step 5: Add Test Connection for custom**

In the Test Connection when block, add before the `else` case:
```kotlin
                                "custom" -> testCustomConnection(
                                    endpointUrl = config?.customBaseUrl ?: "",
                                    apiKey = config?.customApiKey ?: "",
                                    model = config?.model ?: "",
                                    format = config?.customFormat ?: "chat_completions",
                                    extraHeaders = config?.customHeaders ?: "",
                                )
```

- [ ] **Step 6: Add `testCustomConnection` function**

Add after `testOpenAIConnection`:
```kotlin
private suspend fun testCustomConnection(
    endpointUrl: String,
    apiKey: String,
    model: String,
    format: String,
    extraHeaders: String,
): Result<Unit> = withContext(Dispatchers.IO) {
    runCatching {
        val trimmedUrl = endpointUrl.trim()
        if (trimmedUrl.isBlank()) error("Endpoint URL is empty")
        if (apiKey.isBlank()) error("API key is empty")
        if (model.isBlank()) error("Model is empty")

        val headersJson = extraHeaders.trim().takeIf { it.isNotBlank() }?.let {
            try { JSONObject(it) } catch (_: Exception) { error("Extra Headers must be valid JSON") }
        }

        val url = URL(trimmedUrl)
        val conn = url.openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.connectTimeout = 15000
        conn.readTimeout = 15000
        conn.setRequestProperty("Content-Type", "application/json")
        if (headersJson == null || !headersJson.keys().asSequence().any { it.equals("Authorization", ignoreCase = true) }) {
            conn.setRequestProperty("Authorization", "Bearer $apiKey")
        }
        headersJson?.keys()?.forEach { key ->
            val value = headersJson.opt(key)?.toString()?.trim().orEmpty()
            if (key.isNotBlank() && value.isNotBlank()) conn.setRequestProperty(key, value)
        }

        val payload = if (format == "responses") {
            JSONObject().apply {
                put("model", model)
                put("input", "ping")
                put("max_output_tokens", 1)
            }
        } else {
            JSONObject().apply {
                put("model", model)
                put("max_tokens", 1)
                put("messages", org.json.JSONArray().put(JSONObject().apply {
                    put("role", "user")
                    put("content", "ping")
                }))
            }
        }

        try {
            conn.outputStream.bufferedWriter().use { it.write(payload.toString()) }
            val status = conn.responseCode
            if (status in 200..299) return@runCatching
            val errorBody = try {
                (conn.errorStream ?: conn.inputStream)?.bufferedReader()?.use { it.readText() } ?: ""
            } catch (_: Exception) { "" }
            val apiMessage = try {
                JSONObject(errorBody).optJSONObject("error")?.optString("message", "") ?: ""
            } catch (_: Exception) { "" }
            error("Connection failed (${apiMessage.ifBlank { "HTTP $status" }})")
        } catch (_: java.net.SocketTimeoutException) {
            error("Connection timed out")
        } catch (_: java.io.IOException) {
            error("Network unreachable or timeout")
        } finally {
            conn.disconnect()
        }
    }
}
```

- [ ] **Step 7: Add format picker dialog**

After the auth type picker dialog, add:
```kotlin
    if (showCustomFormatPicker) {
        val formatOptions = listOf("chat_completions" to "Chat Completions", "responses" to "Responses API")
        var selectedFormat by remember { mutableStateOf(config?.customFormat ?: "chat_completions") }

        AlertDialog(
            onDismissRequest = { showCustomFormatPicker = false },
            title = { Text("API Format", fontFamily = RethinkSans, fontWeight = FontWeight.Bold, color = SeekerClawColors.TextPrimary) },
            text = {
                Column {
                    formatOptions.forEach { (formatId, label) ->
                        Row(
                            modifier = Modifier.fillMaxWidth().clickable { selectedFormat = formatId }.padding(vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(
                                selected = selectedFormat == formatId,
                                onClick = { selectedFormat = formatId },
                                colors = RadioButtonDefaults.colors(selectedColor = SeekerClawColors.Primary, unselectedColor = SeekerClawColors.TextDim),
                            )
                            Column(modifier = Modifier.padding(start = 8.dp)) {
                                Text(label, fontFamily = RethinkSans, fontSize = 14.sp, color = SeekerClawColors.TextPrimary)
                                Text(
                                    if (formatId == "responses") "OpenAI Responses API format" else "Standard /v1/chat/completions format",
                                    fontFamily = RethinkSans, fontSize = 12.sp, color = SeekerClawColors.TextDim,
                                )
                            }
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    saveField("customFormat", selectedFormat, needsRestart = true)
                    showCustomFormatPicker = false
                }) { Text("Save", fontFamily = RethinkSans, fontWeight = FontWeight.Bold, color = SeekerClawColors.ActionPrimary) }
            },
            dismissButton = {
                TextButton(onClick = { showCustomFormatPicker = false }) {
                    Text("Cancel", fontFamily = RethinkSans, color = SeekerClawColors.TextDim)
                }
            },
            containerColor = SeekerClawColors.Surface,
            shape = RoundedCornerShape(16.dp),
        )
    }
```

- [ ] **Step 8: Commit**
```bash
git add app/src/main/java/com/seekerclaw/app/ui/settings/ProviderConfigScreen.kt
git commit -m "feat: add custom provider UI — settings, format picker, HTTP warning, test connection"
```

---

## Task 9: Kotlin — Update `DashboardScreen.kt` + `ConfigClaimImporter.kt`

**Files:**
- Modify: `app/src/main/java/com/seekerclaw/app/ui/dashboard/DashboardScreen.kt`
- Modify: `app/src/main/java/com/seekerclaw/app/config/ConfigClaimImporter.kt`

- [ ] **Step 1: Update DashboardScreen credential check**

In the `hasApiKey` computation (~line 107), add before `else`:
```kotlin
            "custom" -> config?.customApiKey?.isNotBlank() == true && config.customBaseUrl.isNotBlank()
```

- [ ] **Step 2: Update ConfigClaimImporter for QR v2 future**

Add custom field parsing (after openrouter key parsing):
```kotlin
        val rawCustomKey = firstNonBlank(
            auth?.optString("customApiKey"),
            cfg.optString("customApiKey"),
            root.optString("customApiKey"),
        )
        val rawCustomBaseUrl = firstNonBlank(
            auth?.optString("customBaseUrl"),
            cfg.optString("customBaseUrl"),
            root.optString("customBaseUrl"),
        )
        val rawCustomHeaders = firstNonBlank(
            auth?.optString("customHeaders"),
            cfg.optString("customHeaders"),
            root.optString("customHeaders"),
        )
        val rawCustomFormat = firstNonBlank(
            auth?.optString("customFormat"),
            cfg.optString("customFormat"),
            root.optString("customFormat"),
        )
```

Add custom to `defaultModel`:
```kotlin
            "custom" -> ""
```

Add custom to credential routing:
```kotlin
                "custom" -> rawCustomKey.trim()
```

Add custom AppConfig case:
```kotlin
            "custom" -> AppConfig(
                anthropicApiKey = "",
                customApiKey = trimmedCredential,
                customBaseUrl = rawCustomBaseUrl.trim(),
                customHeaders = rawCustomHeaders.trim(),
                customFormat = rawCustomFormat.trim().ifBlank { "chat_completions" },
                provider = "custom",
                authType = "api_key",
                telegramBotToken = botToken,
                telegramOwnerId = ownerId,
                model = model,
                agentName = agentName,
                braveApiKey = braveApiKey.trim(),
            )
```

Add custom to `hasCredential`:
```kotlin
            "custom" -> appConfig.customApiKey.isNotBlank() && appConfig.customBaseUrl.isNotBlank()
```

- [ ] **Step 3: Commit**
```bash
git add app/src/main/java/com/seekerclaw/app/ui/dashboard/DashboardScreen.kt app/src/main/java/com/seekerclaw/app/config/ConfigClaimImporter.kt
git commit -m "feat: wire custom provider into dashboard + QR importer"
```

---

## Task 10: End-to-end smoke test

- [ ] **Step 1: JS syntax check all files**
```bash
cd app/src/main/assets/nodejs-project
node --check http.js && node --check config.js && node --check providers/custom.js && node --check providers/index.js && node --check ai.js && echo "ALL JS OK"
```

- [ ] **Step 2: Verify custom provider wiring**
```bash
grep -rn "custom" config.js providers/index.js ai.js | grep -v "^Binary" | grep -v node_modules | head -30
```

- [ ] **Step 3: Verify no broken references**
```bash
# Ensure no leftover DDG or broken imports
grep -rn "searchDDG\|duckduckgo\|BRAVE_FRESHNESS" tools/web.js web.js || echo "Clean"
```

- [ ] **Step 4: Device test plan**
1. Build APK, install on device
2. Verify app launches, existing provider (Claude/OpenAI/OpenRouter) still works
3. Go to Settings → AI Configuration → switch to Custom
4. Enter: endpoint URL, model ID, API key
5. Verify HTTP warning shows for `http://` URLs
6. Test Connection button works
7. Restart agent, send a message via Telegram
8. Verify response comes from custom endpoint
9. Switch back to original provider — verify it still works

---

## Summary

| Task | Files | What |
|------|-------|------|
| 1 | `http.js` | HTTP protocol support |
| 2 | `config.js` | Custom provider constants + validation |
| 3 | `providers/custom.js`, `providers/index.js` | Custom adapter |
| 4 | `ai.js` | API key helper, endpoint resolution, system prompt |
| 5 | All JS | JS smoke test |
| 6 | `Providers.kt` | Provider registry |
| 7 | `ConfigManager.kt` | Config fields + storage |
| 8 | `ProviderConfigScreen.kt` | Settings UI |
| 9 | `DashboardScreen.kt`, `ConfigClaimImporter.kt` | Dashboard + QR |
| 10 | All | End-to-end smoke test |
