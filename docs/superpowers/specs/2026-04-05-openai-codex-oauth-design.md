# OpenAI Codex OAuth — Design Spec

**Date:** 2026-04-05
**Status:** Approved
**Issue:** #315
**Risk:** MEDIUM — uses undocumented Codex OAuth endpoints. Labeled "experimental" in UI.

---

## Goal

Let ChatGPT Plus/Pro subscribers use SeekerClaw's OpenAI provider with their subscription instead of buying separate API credits. Adds OAuth as a second auth type alongside API Key.

## Constraints

- Same provider ("OpenAI"), not a new provider
- Two sign-in methods: browser redirect + device code (user chooses)
- Experimental label — clear warning about unofficial API
- Encrypted token storage (Android Keystore, same as all credentials)
- Auto-refresh tokens (8h proactive + 401 reactive)
- Zero impact on existing API Key users
- Reuse existing patterns (ProviderConfigScreen auth type selector, SolanaAuthActivity browser pattern)

## Architecture

### Auth Type Selector (ProviderConfigScreen)

When provider is "OpenAI", show auth type picker (same pattern as Claude's API Key / Setup Token):

```
Auth Type:
  ○ API Key
  ● ChatGPT OAuth (experimental)

┌─────────────────────────────────────────────────┐
│ ⚠️ Experimental: uses Codex OAuth, not          │
│ officially supported for third-party apps.       │
│ Subscription rate limits apply.                  │
└─────────────────────────────────────────────────┘

[Sign in with Browser]     ← primary: Custom Tab
[Sign in with Code]        ← alternative: device code

─── after sign-in ───

Connected as: user@email.com
Subscription: Plus
[Sign out]
```

When "API Key" selected → existing API Key field (unchanged).

### OAuth Endpoints

| Purpose | URL |
|---------|-----|
| Authorization | `https://auth.openai.com/oauth/authorize` |
| Token exchange | `https://auth.openai.com/oauth/token` |
| Token refresh | `https://auth.openai.com/oauth/token` (grant_type=refresh_token) |
| Device code | `https://auth.openai.com/codex/device` |
| API (OAuth) | `https://chatgpt.com/backend-api/codex/responses` |
| API (Key) | `https://api.openai.com/v1/responses` (unchanged) |

### PKCE Parameters

| Param | Value |
|-------|-------|
| Client ID | `app_EMoamEEZ73f0CkXaXp7hrann` |
| PKCE method | S256 |
| Scopes | `openid profile email offline_access` |
| Redirect URI | `http://localhost:1455/auth/callback` |
| Extra params | `id_token_add_organizations=true`, `codex_cli_simplified_flow=true` |

## Sign-in Flow A: Browser Redirect

1. User taps "Sign in with Browser"
2. Android launches `OpenAIOAuthActivity`
3. Activity starts NanoHTTPD server on `localhost:1455`
4. Opens Custom Tab to `auth.openai.com/oauth/authorize` with PKCE params
5. User logs in with ChatGPT account
6. Browser redirects to `localhost:1455/auth/callback?code=...&state=...`
7. NanoHTTPD catches redirect, extracts auth code
8. Activity exchanges code for tokens at `auth.openai.com/oauth/token`
9. Extracts email from JWT access token (accountId claim)
10. Returns result: `{ accessToken, refreshToken, email }` via result file
11. ProviderConfigScreen saves tokens encrypted, shows connected status

### Sign-in Flow B: Device Code

1. User taps "Sign in with Code"
2. App calls device code endpoint → gets `{ device_code, user_code, verification_uri }`
3. UI shows: "Go to `auth.openai.com/codex/device` and enter code: `ABCD-1234`"
4. App polls token endpoint with device_code every 5 seconds
5. When user completes login, poll returns tokens
6. Same result handling as Flow A

## Token Management

### Storage

| Field | Encrypted | SharedPreferences Key |
|-------|-----------|----------------------|
| Access token (JWT) | Yes (Keystore) | `openai_oauth_token_enc` |
| Refresh token | Yes (Keystore) | `openai_oauth_refresh_enc` |
| Email | No | `openai_oauth_email` |
| Expires at | No | `openai_oauth_expires_at` |

Written to config.json (ephemeral, deleted after 5s):
```json
{
    "provider": "openai",
    "authType": "oauth",
    "openaiOAuthToken": "eyJ0eXAi...",
    "openaiOAuthRefresh": "rt_...",
    "openaiOAuthEmail": "user@example.com",
    "model": "gpt-5.4"
}
```

### Refresh Strategy

1. **Proactive:** Before each API call, check if token expires within 10 minutes. If so, refresh.
2. **Reactive:** On 401 response, attempt one refresh + retry.
3. **Endpoint:** POST `auth.openai.com/oauth/token` with `grant_type=refresh_token`, `client_id`, `refresh_token`
4. **Failure:** If refresh fails, mark auth as expired. Agent tells user "OAuth session expired, please re-sign in."
5. **Where:** Token refresh happens in Node.js (`providers/openai.js`). New tokens saved back via bridge endpoint `/openai/oauth/save-tokens`.

## API Routing

`providers/openai.js` checks auth type:

```javascript
const isOAuth = AUTH_TYPE === 'oauth' && PROVIDER === 'openai';
const API_HOST = isOAuth ? 'chatgpt.com' : 'api.openai.com';
const API_PATH = isOAuth ? '/backend-api/codex/responses' : '/v1/responses';
```

Headers:
```javascript
// OAuth
{ 'Authorization': 'Bearer <jwt_access_token>' }

// API Key (unchanged)
{ 'Authorization': 'Bearer <api_key>' }
```

Same header format — just different token and endpoint.

## Model List by Auth Type

| Auth Type | Models |
|-----------|--------|
| API Key | GPT-5.4, GPT-5.2, GPT-5.3 Codex |
| OAuth | GPT-5.4, GPT-5.4-mini, GPT-5.3 Codex, GPT-5.3 Codex Spark |

`Providers.kt` and `ProviderConfigScreen.kt` swap model list based on `authType`.

## Files

### New Files

| File | Responsibility |
|------|----------------|
| `OpenAIOAuthActivity.kt` | Browser redirect flow (NanoHTTPD + Custom Tab) + device code flow |

### Modified Files (Kotlin)

| File | Changes |
|------|---------|
| `Providers.kt` | Add `"oauth"` to OpenAI authTypes, add OAuth model list |
| `ProviderConfigScreen.kt` | Auth type selector for OpenAI, sign-in buttons, connected status, sign-out |
| `ConfigManager.kt` | Store/load OAuth tokens (encrypted), write to config.json, clear on sign-out |
| `AndroidBridge.kt` | New endpoint `/openai/oauth/save-tokens` for Node.js to persist refreshed tokens |

### Modified Files (JS)

| File | Changes |
|------|---------|
| `config.js` | Read OAuth token fields from config.json |
| `providers/openai.js` | Route to Codex endpoint when OAuth, token refresh on 401, save refreshed tokens via bridge |

## What Does NOT Change

- API Key flow — completely untouched
- Other providers (Claude, OpenRouter, Custom) — unchanged
- Channel abstraction — unchanged
- Tools, memory, cron — unchanged
- Existing OpenAI users — zero impact

## Edge Cases

- **Token expired, refresh fails:** Agent sends message "OAuth session expired. Please re-sign in via Settings > AI Provider." User sees error in chat, goes to settings, taps sign-in again.
- **User switches from OAuth to API Key:** Clear OAuth tokens, show API Key field. No restart needed (config.json regenerated on service restart).
- **Rate limited (429):** Same handling as API Key — backoff + retry. But OAuth 429 includes message-based rate info (X messages per 5 hours).
- **OpenAI blocks Codex client_id:** Sign-in fails with auth error. Warning already shown ("experimental"). User falls back to API Key.

## Acceptance Criteria

- [ ] Auth type selector: API Key / ChatGPT OAuth (experimental)
- [ ] Warning card shown when OAuth selected
- [ ] Browser redirect sign-in works (Custom Tab → localhost callback)
- [ ] Device code sign-in works (code + URL → poll for token)
- [ ] Tokens stored encrypted in Android Keystore
- [ ] API calls route to chatgpt.com/backend-api/codex/responses
- [ ] Token auto-refresh works (proactive + reactive)
- [ ] Refreshed tokens saved back via bridge
- [ ] Model list swaps based on auth type
- [ ] Connected status shows email + subscription tier
- [ ] Sign-out clears tokens
- [ ] Existing API Key flow unchanged
- [ ] Device test: sign in → agent responds → token refresh
