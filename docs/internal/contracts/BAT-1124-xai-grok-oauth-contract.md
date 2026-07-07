# BAT-1124 — xAI Grok "Sign in with Grok" OAuth — Integration Contract

> **Status:** DRAFT for Codex sign-off (revised after adversarial 3-lens validation). **No implementation until signed off.**
> **Analog:** mirrors the existing OpenAI "Sign in with ChatGPT" OAuth (`OpenAIOAuthActivity.kt` / `providers/openai.js`) — **but three "mirror OpenAI" premises in the first draft were false and are corrected below** (redaction, endpoint-pinning, and fire-and-forget refresh persistence).

---

## 1. Goal & scope

Add provider **`xai`** ("xAI Grok") with a **"Sign in with Grok"** OAuth option so a **SuperGrok** or **X Premium+** subscriber can use Grok **without an `XAI_API_KEY`**, plus a normal **API-key** path (key from `console.x.ai`). Direct analog of our OpenAI OAuth.

**v1 scope:** `xai` provider in onboarding + Settings; auth types `oauth` + `api_key`; text inference over OpenAI-compatible `api.x.ai`; secure token storage + refresh; agent self-awareness updated; device-tested on Seeker.

**Non-goals (v1):** xAI-only surfaces (TTS/image/video/transcription); the `/v1/responses` transport + encrypted-reasoning + prompt caching (D2); registering our own xAI OAuth client (none available — D3); OAuth via QR/claim import (api-key only there, same as OpenAI today).

---

## 2. Key decisions (Codex: please rule)

### D1 — OAuth flow: **loopback + PKCE (recommended)** vs device-code  *(reversed from draft after UX/security review)*
xAI's public client supports both. **Recommendation: loopback + PKCE**, cloning our proven `OpenAIOAuthActivity` (NanoHTTPD callback server + Chrome Custom Tab + PKCE S256 + `OAuthKeepAliveService`).
- **Why (UX):** the OpenAI flow is *one-tap auto-capture* — the browser 302s to `http://127.0.0.1:<port>/callback`, the on-device server captures the code, the user never sees or types anything. Device-code is strictly *more* steps on a same-device phone (show `user_code`, user confirms it matches) → a UX regression against the baseline we're matching (CLAUDE.md "UX First").
- **Why (robustness):** device-code must POST-poll `auth.x.ai/oauth2/token` from the **backgrounded app process while Chrome is foreground** — exactly the BAT-494 condition (`OpenAIOAuthActivity.kt:680-685`) where the app's network is restricted. Loopback does its network work in the foregrounded activity. Reusing the loopback path also inherits the BAT-489 (IPv6) / BAT-494 (network) fixes already battle-tested.
- **Loopback specifics for xAI:** redirect **`http://127.0.0.1:56121/callback`** (xAI's registered value — NOT OpenAI's `localhost:1455`); PKCE S256; authorize `https://auth.x.ai/oauth2/authorize`; scope per §3. **Drop** OpenAI-only authorize params (`id_token_add_organizations`, `codex_cli_simplified_flow`) and do **not** add `plan`/`referrer` (community ports warn these misroute to the API-console SSO instead of the Grok consent screen).
- **Open impl risk to verify:** does xAI allow a dynamic loopback port (RFC 8252) or require exactly `:56121`? If fixed-port-only, handle "port 56121 in use" as a failure mode (our OpenAI code's random-`:0` fallback may not be accepted by xAI). **Verify against a live authorize call during impl.**
- **Device-code remains the documented fallback** (headless/remote, or if loopback port-binding proves unreliable). If Codex picks device-code instead, then v1 MUST include: keep `OAuthKeepAliveService` around the poll window; parse `authorization_pending`/`slow_down`/`expired_token` from **HTTP 400 bodies** (do NOT reuse `httpPostStatic`'s throw-on-non-2xx, `OpenAIOAuthActivity.kt:201-231`); define process-death-mid-poll behavior; and make "poll succeeds while Chrome foreground during onboarding" an explicit device-test gate.

### D2 — Inference transport: **`/v1/chat/completions` (recommended)** vs `/v1/responses`
Both accept the OAuth bearer. Use **chat/completions** — same host+endpoint for api_key and oauth, reuses `providers/openrouter.js`/`custom.js` request shaping. Do **NOT** copy `openai.js`'s Codex-only shaping (`store:false`, forced `reasoning`, `include:['reasoning.encrypted_content']`). Responses-API/prompt-caching deferred.

### D3 — `client_id` reuse / ToS — **same accepted posture as our shipped OpenAI OAuth**  *(corrected)*
Reusing the Grok-CLI public client_id `b1a00492-073a-47ea-816f-4c329264a828` is **the same pattern SeekerClaw already ships for OpenAI**: `OpenAIOAuthActivity.kt:57` uses OpenAI's **Codex CLI public client_id** `app_EMoamEEZ73f0CkXaXp7hrann` (authorize URL carries `codex_cli_simplified_flow=true`) to ride the ChatGPT subscription — on **both** flavors, ungated, today. xAI is materially identical (public client, no self-serve registration, consumer-subscription OAuth). We therefore accept it on the **same basis** already accepted for OpenAI — this is not a new or elevated risk, and not a blocker.
- **Mitigation (keep it clean):** send SeekerClaw's **own `User-Agent`** (e.g. `SeekerClaw/<ver>`), NOT Grok-CLI's — zero impersonation (matches how upstream OpenClaw sends `openclaw/<ver>`). Verify our UA is accepted by `api.x.ai/v1` during device test (no evidence xAI requires the Grok-CLI UA on `/v1`).
- xAI enforces entitlement server-side (the 403 tier-gate), so a subscription lacking API access fails gracefully to the API-key path — same fallback story as any provider. Optional/non-blocking: ask xAI dev-support for explicit third-party sanction.

### D4 — Model list — **concrete IDs are a pre-device-test gate (blocker), registry stays static**
The registry is **static JSON bundled in the APK** (no runtime `/v1/models` discovery). With `freeform:false`, `models:[]` is **not shippable** (unlike `openrouter`, which is `freeform:true`). At impl time, enumerate `GET https://api.x.ai/v1/models` with a live token, seed `model-registry.json`, and set a valid `defaultModel` **in the model list**. Also add the `xai` branch to the hardcoded `config.js:320-323` default-model chain — its `else` returns `claude-opus-4-8`, which `api.x.ai` would **404**. Confirm whether oauth vs api_key expose different model sets → add `modelsByAuth` if so. Provisional IDs only: `grok-4.3`, `grok-code-fast-1`, `grok-build-0.1`.

### D5 — Flavor parity with OpenAI OAuth (both flavors)
Ship the `oauth` path on **both flavors** (`dappStore` + `googlePlay`), exactly as the OpenAI OAuth ships today (no `BuildConfig.DISTRIBUTION` gate) — for consistency with our existing treatment. Payments policy isn't implicated (externally-purchased subscription, same shape as the shipped ChatGPT OAuth). If xAI ever objects, we can flavor-gate later; no gating for v1.

---

## 3. Captured OAuth contract (verified: xAI live OIDC discovery + Hermes source + 541 GitHub repos)

**Endpoints are hardcoded for v1 (no OIDC discovery — see §7 rationale):**

| Field | Value |
|---|---|
| Authorize (loopback flow) | `https://auth.x.ai/oauth2/authorize` |
| Device endpoint (fallback flow) | `https://auth.x.ai/oauth2/device/code` |
| Token endpoint | `https://auth.x.ai/oauth2/token` |
| client_id (public, no secret) | `b1a00492-073a-47ea-816f-4c329264a828` |
| Redirect (loopback) | `http://127.0.0.1:56121/callback` |
| scope | `openid profile email offline_access grok-cli:access api:access` |
| PKCE | S256 (loopback); n/a (device-code) |
| Inference | `POST https://api.x.ai/v1/chat/completions`, `Authorization: Bearer <access_token>`, stable `User-Agent`; optional `x-grok-conv-id` |
| Refresh | `POST token endpoint` `grant_type=refresh_token`+`client_id`+`refresh_token`. **Refresh token is single-use / rotates — the new one MUST be persisted or the account is locked out (§5.4).** `invalid_grant` on refresh → re-login required. |
| Access-token TTL | ~6h; refresh proactively ~1h early and/or on 401 |

---

## 4. Architecture (mirror of OpenAI OAuth; note the two cross-process files)

Kotlin performs initial sign-in + owns secret storage; **Node performs refresh-on-401 and calls back to Kotlin to persist rotated tokens.** Provider/authType resolve from **`runtime_state.json` FIRST, then `config.json`** (`config.js:249-282`) — the xai switch must pass both `RuntimeStateStore.isValidPair` (Kotlin) and `runtime-state.js validateMatrix` (Node) to persist cross-process.

```
[Kotlin XaiOAuthActivity] --loopback+PKCE--> auth.x.ai   (OAuthKeepAliveService for network during Custom Tab)
        │ persist (Keystore-encrypted): xaiOAuthToken/Refresh/Email/ExpiresAt
        ▼
[ConfigManager] --writeConfigJson--> workspace/config.json      [RuntimeStateStore] --> workspace/runtime_state.json
        ▼                                     │                          │ (provider/authType, gated by isValidPair)
[Node config.js: XAI_OAUTH_TOKEN / XAI_KEY / AUTH_TYPE] ──> [providers/xai.js]
        ▲                                                          │ Bearer → api.x.ai/v1/chat/completions
        │ AWAIT /xai/oauth/save-tokens (rotated tokens)            │ 401 → single-flight refresh → persist → retry
[AndroidBridge.handleXaiOAuthSaveTokens] <──────────────────────── refreshOAuthToken()
```

---

## 5. Behavioral contract

### 5.1 Kotlin — `XaiOAuthActivity` (new; clone `OpenAIOAuthActivity.kt`)
- Loopback+PKCE: bind NanoHTTPD `CallbackServer` on `127.0.0.1:56121` serving `GET /callback` (keep the non-loopback 403 guard + BAT-489 IPv6 handling); Custom Tab to the authorize URL; **keep `OAuthKeepAliveService`** for the flow (BAT-494).
- On code: exchange `grant_type=authorization_code`+`code`+`redirect_uri`+`client_id`+`code_verifier`; derive `expiresAt=now+expires_in`; email from `id_token` JWT **best-effort, unverified — display/PII only, never used for authorization** (see §7). Call `ConfigManager.persistXaiOAuthTokens(...)`; write result file `{status:"success"}` to a **dedicated `xai_oauth_results` dir** (avoid colliding with the OpenAI poller). Failure → `{status:"error",message}`.
- Manifest: register `exported="false"`, translucent theme (analog `AndroidManifest.xml:75-78`).

### 5.2 Kotlin — `ConfigManager` (fields L73-76, keys L253-289, persist L1638-1685)
- Add `xaiOAuthToken/Refresh/Email/ExpiresAt` (default `""`); keys `xai_oauth_{token,refresh,email}_enc` (**Keystore-encrypted+Base64**) + `xai_oauth_expires_at` (plaintext).
- `persistXaiOAuthTokens(...)` (encrypt, bump `configVersion`, do NOT set `KEY_SETUP_COMPLETE`); `clearXaiOAuth`; `updateConfigField` cases; decrypt in `loadConfigUnchecked`; `resolveAuthType` xai normalization.
- **`writeConfigJson` (L1869-1904):** write `xaiOAuthToken`/`xaiOAuthRefresh` only when non-blank; replicate the oauth-blank **downgrade** guard. *Correction:* Node does **not crash** without it — `authType:"oauth"` is a valid value; the downgrade's real purpose is to let the **api-key fallback** path engage. If oauth is blank AND no `xaiApiKey`, Node cleanly `process.exit(1)` (fail-loud) — acceptable.
- **Also (from validation):** `xaiApiKey` field — the plain api-key path — must exist and be read; it is auto-covered by the config-key redaction heuristic (ends in `apiKey`), but the OAuth tokens are NOT (§7).

### 5.3 Kotlin — `AndroidBridge`
- Add `/xai/oauth/save-tokens` route + rate-limit + `handleXaiOAuthSaveTokens` (mirror L923-950; "keep old if blank").
- **Add `xai` to `handleConfigCredentials` (L273-289)** — else Node's `/provider xai` gate (`message-handler.js:492-503,727-733`) rejects a validly-signed-in user. Add `xaiApiKey` + `xaiOAuthToken` presence entries.

### 5.4 Node — `providers/xai.js` (new; openrouter/custom request shaping + openai-style OAuth mgmt)
- `id:'xai'`, `authTypes:['api_key','oauth']`; `endpoint={hostname:'api.x.ai', path:'/v1/chat/completions'}` for both auth types (`XAI_BASE_URL` override).
- `buildHeaders`: `Authorization: Bearer ${isOAuth ? _currentOAuthToken : apiKey}`; **SeekerClaw's own `User-Agent`** (e.g. `SeekerClaw/<ver>` — not Grok-CLI's; D3); optional `x-grok-conv-id`. Standard Chat Completions `formatRequest`.
- **`refreshOAuthToken()` — corrected vs OpenAI's latent bug:**
  - Single-flight guard: memoize the in-flight refresh (`_refreshInFlight ??= doRefresh().finally(...)`) so concurrent 401s don't consume the single-use token twice.
  - **`await` the `/xai/oauth/save-tokens` persist and treat persist-failure as a hard error** (surface / retry) — do NOT `resolve(true)` before the rotated token is persisted. (openai.js:612-627 fires-and-forgets; benign for OpenAI, **account-locking for xAI's single-use rotation**.)
  - Register the newly rotated access+refresh tokens with the redactor **before** any `log()` (§7).
- **`classifyError` — full matrix (not just 401/403):** `401` → retryable only when `isOAuth && _currentRefreshToken` (→ refresh); `403` (incl. `xai_oauth_tier_denied`) → **terminal, non-retryable**, user message "Your Grok subscription tier doesn't include API access — add an xAI API key instead" (verified safe: `ai.js:1736` gates refresh on `retryable`, so 403 won't loop); `429` → retryable/backoff; `5xx` → retryable; `402`/quota → surfaced; refresh `400 invalid_grant` → re-login (non-retryable).
- client_id duplicated Kotlin↔Node — **add a smoke-test asserting the two literals are byte-equal** (drift silently breaks refresh).

### 5.5 Node — `ai.js` / `config.js` / `model-catalog.js` / `runtime-state.js`
- **`ai.js` (NEW change point — was missing; causes a secret leak):**
  - `getProviderApiKey()` (L151-156) falls through to `ANTHROPIC_KEY` for `xai` → for `xai`+api_key it would put the **Anthropic key** in a Bearer header to `api.x.ai` (auth fail + secret exfiltration). Add `PROVIDER==='xai' ? XAI_KEY` and import `XAI_KEY` at L11.
  - `billingUrl`/`apiHost` maps (L1140-1147): add `xai` → `console.x.ai` / `api.x.ai` (else → Anthropic URLs today).
  - `## Provider` self-description block (L1377-1399): add `xai` branch (OAuth = "uses your SuperGrok/X Premium+ subscription"; api-key = console.x.ai). Add an xai-OAuth failure playbook incl. the 403 tier-gate (analog L1153-1161).
  - `/provider <…>` help string (L1036): add `xai`.
- `config.js`: add `xai` to `_SUPPORTED_PROVIDERS` (L246); read+export `XAI_KEY`/`XAI_OAUTH_TOKEN`/`XAI_OAUTH_REFRESH`; **reuse the generic `AUTH_TYPE`** (like claude/openrouter/custom — do **not** add a separate `XAI_AUTH_TYPE`; only `openai` needs its own, `ai.js:1411`); extend startup `_activeKey`/`keyName` validation (L598-618); add `xai` default model (L320-323 — else→`claude-opus-4-8` 404s).
- `model-catalog.js`: add `xai` to `hasCredentialsFor` (L236-272; oauth reads `config.xaiOAuthToken`, api_key reads `config.xaiApiKey`). Leave `REQUIRED_PROVIDER_IDS` unchanged.
- `runtime-state.js`: `_VALID_AUTH_TYPES.xai = new Set(['api_key','oauth'])` (L84-88).
- **`security.js` (NEW change point):** redaction does **not** cover OAuth tokens today. In `main.js` (alongside L50-52) `registerRedactedSecret(XAI_OAUTH_TOKEN)` + `registerRedactedSecret(XAI_OAUTH_REFRESH)`; and register rotated tokens inside `xai.js.refreshOAuthToken`. (auth.x.ai JWTs match no existing prefix pattern and the field names don't end in `ApiKey`, so without this they leak into `node_debug.log`, which is readable via the shell/read tools.)

### 5.6 Kotlin — model registry + UI
- **`model-registry.json`: APPEND (not prepend) the `xai` entry** and include the **required** fields `keyHint`, `consoleUrl` (`https://console.x.ai`), `keysUrl` — `ProviderInfo` has no defaults for these, so omitting them throws `MissingFieldException` in `ModelRegistry.init()` and **crashes the app at launch for every user** (`Providers.kt:33-35,300`). Appending preserves the `providers[0]==openai` unknown-id fallback invariant.
- `Providers.kt`: generic `modelsByAuth[authType] ?: models` path handles `xai`+oauth with no `== "openai"` extension needed (validation-confirmed). Only extend the openai special-cases (L197-201, L229-242) if xai needs oauth-specific model lists.
- `state/RuntimeStateStore.kt` (L295-301): add `"xai" -> authType in ("api_key","oauth")`.
- `ui/components/XaiOAuth.kt` (new; clone `OpenAIOAuth.kt`): controller + `XaiOAuthSection` ("Sign in with Grok", "Uses your Grok subscription.").
- `ui/settings/ProviderConfigScreen.kt`: `"xai"` branch (L367-549) incl. OAuth section; auth-picker option (L927); `switchProvider` default (L263-273); connection-test case + `testXaiOAuthConnection` (~L1186) = authorized `GET /v1/models`.
- `ui/setup/SetupScreen.kt`: mirror Settings (L319-395 auth/config build, L1174-1178 tabs, L1218-1225 OAuth render, L1113-1124 key-test host). OAuth ships on both flavors (parity with OpenAI; no flavor gate — D5).
- `ui/dashboard/DashboardScreen.kt` (L137-147): add `"xai" -> xaiOAuthToken/xaiApiKey non-blank` (else-branch uses Anthropic `activeCredential` → misreports configured xai user as unconfigured).
- `config/ConfigClaimImporter.kt` (L171-261) + `SetupScreen` QR handler (L264-286, 320-340): add `xai` **api-key** routing (else→claude downgrade today). OAuth-via-QR is out of scope (OpenAI OAuth isn't in QR either).
- **No change:** `ProviderPicker.kt`, `ui/settings/ProviderComponents.kt`.

## 6. Failure behavior
Loopback: redirect mismatch / port-in-use → surface, retry. Device-code (if chosen): pending/slow_down/expired/denied per §D1. Inference: 401→single-flight refresh→retry; refresh `invalid_grant`→re-login; **403→terminal tier-gate + API-key fallback (no loop)**; 429/5xx→backoff. Sign-out clears all four fields + bumps configVersion. Network loss → bounded poll deadline, no crash.

## 7. Security posture
- Tokens Keystore-encrypted at rest; `expiresAt` plaintext; email encrypted (PII).
- **Redaction is NET-NEW (not a mirror):** register OAuth access+refresh with the redactor (§5.5) — verify they never appear in `node_debug.log`.
- **Endpoints hardcoded, no OIDC discovery in v1** — the endpoint-validation guard the draft claimed to "mirror" does not exist in `openai.js`, and discovery would add a token-exfiltration MITM surface (poisoned discovery → bearer/refresh POSTed to attacker host) with no analog. Hardcoding the §3 endpoints removes the surface entirely. (If discovery is ever added: pin host to `auth.x.ai`, require `https:`, exact-suffix host check `host==="x.ai" || host.endsWith(".x.ai")`.)
- Loopback: PKCE S256; on-device callback server rejects non-loopback (keep guard); no client secret.
- `id_token` email is unverified — display only.
- Rotated refresh token persisted synchronously (§5.4) — no lockout window.
- ToS: same accepted posture as the shipped OpenAI OAuth (D3); SeekerClaw-own User-Agent (no impersonation); both flavors (D5); API-key fallback always available.

## 8. Upgrade safety (existing users)
- New `xai*`/`xaiApiKey` fields default `""`; `writeConfigJson` writes only when non-blank → old configs untouched.
- Registry/matrix additions are additive; `REQUIRED_PROVIDER_IDS` unchanged (old registry still validates).
- **MUST verify:** the appended registry entry decodes without `MissingFieldException` (include `keyHint`/`consoleUrl`/`keysUrl`) — otherwise **every** user crashes at launch (§5.6). Add a `ModelRegistryTest` that decodes the shipped registry and asserts `providerById("unknown").id=="openai"` still holds.
- No migration, no memory/workspace impact. Device-check: an existing pre-upgrade config still starts on its old provider.

## 9. Test plan
1. **Security review (adversarial + CodeRabbit/Copilot) BEFORE writing tests** (security-critical policy).
2. **Node smoke** (`node tests/nodejs-project/smoke.js`) — mandatory.
3. **Node unit** — `providers/xai.js`: header build (api_key vs oauth), refresh (rotation persist + **await** + **single-flight**), 401→refresh, **403→terminal**, full classifyError matrix; `config.js`/`model-catalog.js` xai matrix + default-model; client_id Kotlin↔Node equality assertion.
4. **Update existing tests** (they break otherwise): `model-catalog.test.js:136,142` (length 4→5) and `ModelRegistryTest.kt:268-274` (append preserves `[0]==openai`).
5. **Kotlin compile** + targeted units (`ConfigManager` persist/clear/writeConfigJson downgrade; `RuntimeStateStore.isValidPair` xai; registry-decode).
6. **`scripts/pre-push-check.sh`** green.
7. **SAB audit** (`/sab-audit`) BEFORE merge — target 100%, cite the SAB version in the PR (mandatory: new provider + `buildSystemBlocks()` change).
8. **Device test on Seeker** (real SuperGrok / X Premium+): loopback sign-in end-to-end (one-tap), Grok message via Telegram, token refresh after expiry, sign-out, API-key fallback, 403 path if a low-tier account is available, and (per D5) confirm OAuth tab hidden on a `googlePlay` build. Verify System-screen SHA first.

## 10. Change-point checklist (~22, up from 15)
**Node:** (1) `model-registry.json` [append + required fields] (2) `providers/xai.js` NEW (3) `providers/index.js` register (4) `config.js` [providers, keys, default model, generic AUTH_TYPE] (5) `model-catalog.js` `hasCredentialsFor` (6) `runtime-state.js` (7) **`ai.js`** [getProviderApiKey+import, billing/apiHost, `## Provider` block, playbook, `/provider` help] (8) **`security.js`/`main.js`** [redaction] (9) **`DIAGNOSTICS.md`** [xai OAuth + 403 tier-gate].
**Kotlin:** (10) `oauth/XaiOAuthActivity.kt` NEW (11) `AndroidManifest.xml` (12) `config/ConfigManager.kt` (13) `state/RuntimeStateStore.kt` (14) `bridge/AndroidBridge.kt` [save-tokens + **handleConfigCredentials**] (15) `ui/components/XaiOAuth.kt` NEW (16) `ui/settings/ProviderConfigScreen.kt` (17) `ui/setup/SetupScreen.kt` (18) `ui/dashboard/DashboardScreen.kt` (19) `config/ConfigClaimImporter.kt` + SetupScreen QR handler [api-key] (20) `config/Providers.kt` [only if oauth-specific models].
**Tests/docs:** (21) update `model-catalog.test.js` + `ModelRegistryTest.kt`; add `providers/xai.test.js`. (22) `RuntimeState.kt` KDoc matrix.

## 11. Open questions for Codex
- D1 (loopback+PKCE vs device-code) — confirm loopback.
- D2 (chat/completions) — confirm.
- D3 (client_id reuse ToS) — confirm same accepted posture as our OpenAI OAuth (both flavors, own UA).
- D5 — OAuth on both flavors (parity with OpenAI).
- Duplicate `OpenAIOAuth*` for xai now vs generalize a shared OAuth base (recommend duplicate-then-refactor to limit blast radius on a proven flow).

## 12. Sources
- xAI announcement — https://x.ai/news/grok-hermes
- Hermes guide — https://hermes-agent.nousresearch.com/docs/guides/xai-grok-oauth
- xAI OIDC discovery — https://auth.x.ai/.well-known/openid-configuration
- Hermes source — https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/auth.py
- client_id corroboration — https://github.com/search?q=b1a00492-073a-47ea-816f-4c329264a828&type=code

---
*Revised after adversarial 3-lens validation (security/auth, codebase-fidelity, product/ToS/self-awareness). All file:line citations verified against the repo at `main` (955991f8).*
