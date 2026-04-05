# OpenAI Codex OAuth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ChatGPT subscription auth (Codex OAuth) as a second auth type for the OpenAI provider, with browser redirect and device code sign-in flows.

**Architecture:** Extends existing OpenAI provider with OAuth auth type. New `OpenAIOAuthActivity` handles browser Custom Tab flow (NanoHTTPD on localhost:1455) and device code flow. `providers/openai.js` routes OAuth requests to `chatgpt.com/backend-api/codex/responses`. Token refresh via bridge endpoint.

**Tech Stack:** Kotlin (Android Custom Tabs, NanoHTTPD), Node.js (token refresh, API routing)

**Spec:** `docs/superpowers/specs/2026-04-05-openai-codex-oauth-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|----------------|
| `app/src/main/java/com/seekerclaw/app/oauth/OpenAIOAuthActivity.kt` | Browser redirect + device code OAuth flows |

### Modified Files (Kotlin)

| File | Changes |
|------|---------|
| `app/src/main/java/com/seekerclaw/app/config/Providers.kt` | Add `"oauth"` to OpenAI authTypes, add OAuth model list |
| `app/src/main/java/com/seekerclaw/app/config/ConfigManager.kt` | OAuth token storage (encrypted), write to config.json, clear on sign-out |
| `app/src/main/java/com/seekerclaw/app/ui/settings/ProviderConfigScreen.kt` | Auth type selector for OpenAI, sign-in buttons, connected status |
| `app/src/main/java/com/seekerclaw/app/bridge/AndroidBridge.kt` | New `/openai/oauth/save-tokens` endpoint for Node.js refresh |
| `app/src/main/AndroidManifest.xml` | Register OpenAIOAuthActivity |

### Modified Files (JS)

| File | Changes |
|------|---------|
| `app/src/main/assets/nodejs-project/config.js` | Read OAuth token fields |
| `app/src/main/assets/nodejs-project/providers/openai.js` | Codex endpoint routing, token refresh |

---

## Task 1: Extend Providers.kt with OAuth auth type + models

**Files:**
- Modify: `app/src/main/java/com/seekerclaw/app/config/Providers.kt`

- [ ] **Step 1: Add "oauth" to OpenAI auth types**

Change line 28 from:
```kotlin
authTypes = listOf("api_key"),
```
to:
```kotlin
authTypes = listOf("api_key", "oauth"),
```

- [ ] **Step 2: Add OAuth-specific model list**

After `openaiModels` (line 55), add:

```kotlin
val openaiOAuthModels = listOf(
    ModelInfo("gpt-5.4", "GPT-5.4", "frontier"),
    ModelInfo("gpt-5.4-mini", "GPT-5.4 Mini", "fast"),
    ModelInfo("gpt-5.3-codex", "GPT-5.3 Codex", "code agent"),
    ModelInfo("gpt-5.3-codex-spark", "GPT-5.3 Codex Spark", "research"),
)
```

- [ ] **Step 3: Update modelsForProvider to accept auth type**

Change `modelsForProvider` to:
```kotlin
fun modelsForProvider(providerId: String, authType: String? = null): List<ModelInfo> = when (providerId) {
    "openai" -> if (authType == "oauth") openaiOAuthModels else openaiModels
    "openrouter", "custom" -> emptyList()
    else -> availableModels
}
```

- [ ] **Step 4: Commit**

```bash
git add app/src/main/java/com/seekerclaw/app/config/Providers.kt
git commit -m "feat: add OAuth auth type + model list for OpenAI provider (#315)

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 2: Add OAuth token storage to ConfigManager

**Files:**
- Modify: `app/src/main/java/com/seekerclaw/app/config/ConfigManager.kt`

- [ ] **Step 1: Add OAuth fields to AppConfig data class**

Add after existing OpenAI fields:
```kotlin
val openaiOAuthToken: String = "",
val openaiOAuthRefresh: String = "",
val openaiOAuthEmail: String = "",
val openaiOAuthExpiresAt: String = "",
```

- [ ] **Step 2: Add SharedPreferences keys**

Add constants:
```kotlin
private const val KEY_OPENAI_OAUTH_TOKEN_ENC = "openai_oauth_token_enc"
private const val KEY_OPENAI_OAUTH_REFRESH_ENC = "openai_oauth_refresh_enc"
private const val KEY_OPENAI_OAUTH_EMAIL = "openai_oauth_email"
private const val KEY_OPENAI_OAUTH_EXPIRES_AT = "openai_oauth_expires_at"
```

- [ ] **Step 3: Save OAuth tokens (encrypted) in saveConfig**

In `saveConfig()`, after OpenAI API key handling, add:
```kotlin
// OpenAI OAuth tokens (encrypted like all credentials)
if (config.openaiOAuthToken.isNotBlank()) {
    val enc = KeystoreHelper.encrypt(config.openaiOAuthToken)
    editor.putString(KEY_OPENAI_OAUTH_TOKEN_ENC, Base64.encodeToString(enc, Base64.NO_WRAP))
} else {
    editor.remove(KEY_OPENAI_OAUTH_TOKEN_ENC)
}
if (config.openaiOAuthRefresh.isNotBlank()) {
    val enc = KeystoreHelper.encrypt(config.openaiOAuthRefresh)
    editor.putString(KEY_OPENAI_OAUTH_REFRESH_ENC, Base64.encodeToString(enc, Base64.NO_WRAP))
} else {
    editor.remove(KEY_OPENAI_OAUTH_REFRESH_ENC)
}
editor.putString(KEY_OPENAI_OAUTH_EMAIL, config.openaiOAuthEmail)
editor.putString(KEY_OPENAI_OAUTH_EXPIRES_AT, config.openaiOAuthExpiresAt)
```

- [ ] **Step 4: Load OAuth tokens in loadConfig**

In `loadConfig()`, add decryption (same pattern as openaiApiKey):
```kotlin
val openaiOAuthToken = try {
    val enc = p.getString(KEY_OPENAI_OAUTH_TOKEN_ENC, null)
    if (enc != null) KeystoreHelper.decrypt(Base64.decode(enc, Base64.NO_WRAP)) else ""
} catch (e: Exception) { "" }

val openaiOAuthRefresh = try {
    val enc = p.getString(KEY_OPENAI_OAUTH_REFRESH_ENC, null)
    if (enc != null) KeystoreHelper.decrypt(Base64.decode(enc, Base64.NO_WRAP)) else ""
} catch (e: Exception) { "" }
```

Add to AppConfig constructor:
```kotlin
openaiOAuthToken = openaiOAuthToken,
openaiOAuthRefresh = openaiOAuthRefresh,
openaiOAuthEmail = p.getString(KEY_OPENAI_OAUTH_EMAIL, "") ?: "",
openaiOAuthExpiresAt = p.getString(KEY_OPENAI_OAUTH_EXPIRES_AT, "") ?: "",
```

- [ ] **Step 5: Write OAuth tokens to config.json**

In `writeConfigJson()`, add:
```kotlin
if (config.openaiOAuthToken.isNotBlank()) put("openaiOAuthToken", config.openaiOAuthToken)
if (config.openaiOAuthRefresh.isNotBlank()) put("openaiOAuthRefresh", config.openaiOAuthRefresh)
if (config.openaiOAuthEmail.isNotBlank()) put("openaiOAuthEmail", config.openaiOAuthEmail)
```

- [ ] **Step 6: Add updateConfigField cases**

```kotlin
"openaiOAuthToken" -> config.copy(openaiOAuthToken = value)
"openaiOAuthRefresh" -> config.copy(openaiOAuthRefresh = value)
"openaiOAuthEmail" -> config.copy(openaiOAuthEmail = value)
"openaiOAuthExpiresAt" -> config.copy(openaiOAuthExpiresAt = value)
```

- [ ] **Step 7: Update credential validation**

In `runtimeValidationError()`, update OpenAI check:
```kotlin
"openai" -> config.openaiApiKey.isNotBlank() || config.openaiOAuthToken.isNotBlank()
```

- [ ] **Step 8: Add clearOAuthTokens helper**

```kotlin
fun clearOpenAIOAuth(context: Context) {
    prefs(context).edit()
        .remove(KEY_OPENAI_OAUTH_TOKEN_ENC)
        .remove(KEY_OPENAI_OAUTH_REFRESH_ENC)
        .remove(KEY_OPENAI_OAUTH_EMAIL)
        .remove(KEY_OPENAI_OAUTH_EXPIRES_AT)
        .apply()
    configVersion.intValue++
}
```

- [ ] **Step 9: Compile check + commit**

```bash
./gradlew compileDappStoreDebugKotlin 2>&1 | tail -5
git add app/src/main/java/com/seekerclaw/app/config/ConfigManager.kt
git commit -m "feat: OAuth token storage in ConfigManager (#315)

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 3: Create OpenAIOAuthActivity

**Files:**
- Create: `app/src/main/java/com/seekerclaw/app/oauth/OpenAIOAuthActivity.kt`
- Modify: `app/src/main/AndroidManifest.xml`

- [ ] **Step 1: Create the OAuth Activity**

Create `app/src/main/java/com/seekerclaw/app/oauth/OpenAIOAuthActivity.kt`.

This Activity handles two flows based on intent extra `"method"`:

**Flow A (browser):**
1. Generate PKCE code_verifier (43-128 random chars) + code_challenge (SHA-256 → base64url)
2. Generate random state parameter
3. Start NanoHTTPD server on `127.0.0.1:1455`
4. Build authorize URL with PKCE params
5. Open Custom Tab
6. NanoHTTPD catches redirect at `/auth/callback?code=...&state=...`
7. Verify state matches
8. POST to `auth.openai.com/oauth/token` to exchange code for tokens
9. Extract email from JWT access token (decode base64 middle segment, parse JSON, read `sub` or email field)
10. Write result to `filesDir/oauth_results/{requestId}.json`
11. Stop server, finish activity

**Flow B (device_code):**
1. POST to `auth.openai.com/codex/device` with client_id + scope
2. Get back `{ device_code, user_code, verification_uri, interval }`
3. Write `{ status: "pending", user_code, verification_uri }` to result file
4. Poll `auth.openai.com/oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code` every `interval` seconds
5. On `authorization_pending` response, continue polling
6. On success, write `{ status: "success", accessToken, refreshToken, email }` to result file
7. On timeout/error, write `{ status: "error", message }` to result file
8. Finish activity

Use the SolanaAuthActivity pattern: file-based result communication, requestId for correlation.

**Key constants:**
```kotlin
const val CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const val AUTH_URL = "https://auth.openai.com/oauth/authorize"
const val TOKEN_URL = "https://auth.openai.com/oauth/token"
const val DEVICE_URL = "https://auth.openai.com/codex/device"
const val REDIRECT_URI = "http://localhost:1455/auth/callback"
const val SCOPES = "openid profile email offline_access"
const val RESULTS_DIR = "oauth_results"
```

- [ ] **Step 2: Register in AndroidManifest.xml**

Add inside `<application>`:
```xml
<activity
    android:name=".oauth.OpenAIOAuthActivity"
    android:theme="@android:style/Theme.Translucent.NoTitleBar"
    android:exported="false" />
```

- [ ] **Step 3: Add Custom Tabs dependency if not already present**

Check `app/build.gradle.kts` for `androidx.browser:browser`. If missing, add:
```kotlin
implementation("androidx.browser:browser:1.8.0")
```

- [ ] **Step 4: Compile check + commit**

```bash
./gradlew compileDappStoreDebugKotlin 2>&1 | tail -10
git add -A
git commit -m "feat: OpenAIOAuthActivity — browser redirect + device code flows (#315)

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 4: Update ProviderConfigScreen with OAuth UI

**Files:**
- Modify: `app/src/main/java/com/seekerclaw/app/ui/settings/ProviderConfigScreen.kt`

- [ ] **Step 1: Add OAuth state variables**

Add near existing state variables:
```kotlin
var oauthStatus by remember { mutableStateOf("") } // "", "pending", "success", "error"
var oauthMessage by remember { mutableStateOf("") }
var deviceCode by remember { mutableStateOf("") }
var deviceVerifyUrl by remember { mutableStateOf("") }
```

- [ ] **Step 2: Update OpenAI section with auth type selector**

In the `"openai" ->` branch (line 247), replace the current content with:

1. Model picker (same as before, but use `modelsForProvider("openai", config?.authType)`)
2. Auth type selector (API Key / ChatGPT OAuth)
3. Conditional UI based on auth type:
   - `api_key` → existing API Key field
   - `oauth` → warning card + sign-in buttons OR connected status

**When OAuth selected and NOT connected:**
```
⚠️ Experimental warning card

[Sign in with Browser]
[Sign in with Code]
```

**When OAuth selected and connected:**
```
Connected as: user@email.com
[Sign out]
```

**Auth type radio buttons** (same pattern as Claude's auth type at line 587):
```kotlin
val authOptions = listOf("api_key" to "API Key", "oauth" to "ChatGPT OAuth (experimental)")
```

- [ ] **Step 3: Implement browser sign-in button**

On click:
1. Create requestId UUID
2. Launch OpenAIOAuthActivity with `method = "browser"`, `requestId`
3. Poll for result file at `filesDir/oauth_results/{requestId}.json`
4. On success: save tokens to ConfigManager, update UI, show restart dialog

- [ ] **Step 4: Implement device code sign-in button**

On click:
1. Create requestId UUID
2. Launch OpenAIOAuthActivity with `method = "device_code"`, `requestId`
3. Poll for result file — first poll returns `{ status: "pending", user_code, verification_uri }`
4. Show code + URL in UI
5. Continue polling until `status: "success"` or `status: "error"`
6. On success: save tokens, update UI, show restart dialog

- [ ] **Step 5: Implement sign-out button**

On click:
```kotlin
ConfigManager.clearOpenAIOAuth(context)
config = ConfigManager.loadConfig(context)
showRestartDialog = true
```

- [ ] **Step 6: Compile check + commit**

```bash
./gradlew compileDappStoreDebugKotlin 2>&1 | tail -10
git add app/src/main/java/com/seekerclaw/app/ui/settings/ProviderConfigScreen.kt
git commit -m "feat: OpenAI OAuth UI — auth type selector, sign-in, connected status (#315)

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 5: Add bridge endpoint for token refresh persistence

**Files:**
- Modify: `app/src/main/java/com/seekerclaw/app/bridge/AndroidBridge.kt`

- [ ] **Step 1: Add /openai/oauth/save-tokens endpoint**

In the `when (uri)` block, add:
```kotlin
"/openai/oauth/save-tokens" -> handleOpenAIOAuthSaveTokens(params)
```

Add handler:
```kotlin
private fun handleOpenAIOAuthSaveTokens(params: JSONObject): Response {
    val accessToken = params.optString("accessToken", "")
    val refreshToken = params.optString("refreshToken", "")
    val expiresAt = params.optString("expiresAt", "")
    if (accessToken.isBlank()) {
        return jsonResponse(400, mapOf("error" to "accessToken required"))
    }
    try {
        val config = ConfigManager.loadConfig(context) ?: return jsonResponse(500, mapOf("error" to "config not loaded"))
        ConfigManager.saveConfig(context, config.copy(
            openaiOAuthToken = accessToken,
            openaiOAuthRefresh = if (refreshToken.isNotBlank()) refreshToken else config.openaiOAuthRefresh,
            openaiOAuthExpiresAt = expiresAt,
        ))
        return jsonResponse(200, mapOf("success" to true))
    } catch (e: Exception) {
        return jsonResponse(500, mapOf("error" to e.message))
    }
}
```

- [ ] **Step 2: Compile check + commit**

```bash
./gradlew compileDappStoreDebugKotlin 2>&1 | tail -5
git add app/src/main/java/com/seekerclaw/app/bridge/AndroidBridge.kt
git commit -m "feat: bridge endpoint for OAuth token refresh persistence (#315)

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 6: Extend config.js with OAuth fields

**Files:**
- Modify: `app/src/main/assets/nodejs-project/config.js`

- [ ] **Step 1: Read OAuth fields from config.json**

After `OPENAI_KEY` declaration, add:
```javascript
const OPENAI_OAUTH_TOKEN = normalizeSecret(config.openaiOAuthToken || '');
const OPENAI_OAUTH_REFRESH = normalizeSecret(config.openaiOAuthRefresh || '');
const OPENAI_OAUTH_EMAIL = (config.openaiOAuthEmail || '').trim();
```

- [ ] **Step 2: Determine effective OpenAI auth type**

```javascript
// OpenAI auth type: 'oauth' if OAuth token present and authType matches, else 'api_key'
const OPENAI_AUTH_TYPE = (AUTH_TYPE === 'oauth' && OPENAI_OAUTH_TOKEN) ? 'oauth' : 'api_key';
```

- [ ] **Step 3: Export new constants**

Add to module.exports:
```javascript
OPENAI_OAUTH_TOKEN, OPENAI_OAUTH_REFRESH, OPENAI_OAUTH_EMAIL, OPENAI_AUTH_TYPE,
```

- [ ] **Step 4: Syntax check + commit**

```bash
node --check app/src/main/assets/nodejs-project/config.js
git add app/src/main/assets/nodejs-project/config.js
git commit -m "feat: config.js reads OAuth token fields (#315)

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 7: Extend providers/openai.js with OAuth routing + refresh

**Files:**
- Modify: `app/src/main/assets/nodejs-project/providers/openai.js`

- [ ] **Step 1: Import OAuth config**

At the top, add to the config import:
```javascript
const { OPENAI_OAUTH_TOKEN, OPENAI_OAUTH_REFRESH, OPENAI_AUTH_TYPE } = require('../config');
const { androidBridgeCall } = require('../bridge');
```

- [ ] **Step 2: Add OAuth endpoint routing**

Add constants:
```javascript
const CODEX_API_HOST = 'chatgpt.com';
const CODEX_API_PATH = '/backend-api/codex/responses';
const isOAuth = OPENAI_AUTH_TYPE === 'oauth';
```

Update `buildHeaders` to use OAuth token:
```javascript
function buildHeaders(apiKey) {
    const token = isOAuth ? OPENAI_OAUTH_TOKEN : apiKey;
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
    };
}
```

Update the HTTP request to use the correct host/path:
Find where `api.openai.com` and `/v1/responses` are used in the streaming request function. Add conditional:
```javascript
const apiHost = isOAuth ? CODEX_API_HOST : 'api.openai.com';
const apiPath = isOAuth ? CODEX_API_PATH : '/v1/responses';
```

- [ ] **Step 3: Add token refresh on 401**

In the error handler for 401 responses, add OAuth refresh:
```javascript
if (isOAuth && statusCode === 401 && OPENAI_OAUTH_REFRESH) {
    log('[OpenAI] OAuth token expired, attempting refresh...', 'INFO');
    try {
        const refreshResult = await refreshOAuthToken();
        if (refreshResult) {
            log('[OpenAI] OAuth token refreshed successfully', 'INFO');
            // Retry the request with new token
            // (caller should retry on specific error)
            throw Object.assign(new Error('OAuth token refreshed — retry'), { retryable: true });
        }
    } catch (refreshError) {
        if (refreshError.retryable) throw refreshError;
        log('[OpenAI] OAuth refresh failed: ' + refreshError.message, 'ERROR');
    }
}
```

- [ ] **Step 4: Implement refresh function**

```javascript
let _currentOAuthToken = OPENAI_OAUTH_TOKEN;

async function refreshOAuthToken() {
    const https = require('https');
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
        refresh_token: OPENAI_OAUTH_REFRESH,
    }).toString();

    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'auth.openai.com',
            path: '/oauth/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': body.length,
            },
            timeout: 15000,
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.access_token) {
                        _currentOAuthToken = parsed.access_token;
                        // Persist refreshed tokens via bridge
                        androidBridgeCall('/openai/oauth/save-tokens', {
                            accessToken: parsed.access_token,
                            refreshToken: parsed.refresh_token || OPENAI_OAUTH_REFRESH,
                            expiresAt: new Date(Date.now() + (parsed.expires_in || 28800) * 1000).toISOString(),
                        }).catch(e => log('[OpenAI] Failed to persist refreshed tokens: ' + e.message, 'WARN'));
                        resolve(true);
                    } else {
                        reject(new Error(parsed.error_description || parsed.error || 'Token refresh failed'));
                    }
                } catch (e) {
                    reject(new Error('Failed to parse refresh response'));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Refresh timeout')); });
        req.write(body);
        req.end();
    });
}
```

- [ ] **Step 5: Update buildHeaders to use refreshed token**

```javascript
function buildHeaders(apiKey) {
    const token = isOAuth ? _currentOAuthToken : apiKey;
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
    };
}
```

- [ ] **Step 6: Syntax check + commit**

```bash
node --check app/src/main/assets/nodejs-project/providers/openai.js
git add app/src/main/assets/nodejs-project/providers/openai.js
git commit -m "feat: OpenAI OAuth routing to Codex endpoint + token refresh (#315)

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 8: Full smoke test

**Files:** None (verification only)

- [ ] **Step 1: JS syntax check**

```bash
node --check app/src/main/assets/nodejs-project/config.js
node --check app/src/main/assets/nodejs-project/providers/openai.js
```

- [ ] **Step 2: Kotlin compile check**

```bash
./gradlew compileDappStoreDebugKotlin 2>&1 | tail -10
```

- [ ] **Step 3: Verify no regressions in existing OpenAI API Key path**

Check that `providers/openai.js` still works with `isOAuth = false` (default):
- `buildHeaders` returns correct header with API key
- API host is `api.openai.com`
- No OAuth refresh logic triggered

- [ ] **Step 4: Commit if fixes needed**

```bash
git add -A
git commit -m "fix: address smoke test findings (#315)

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```
