# BAT-1124 — xAI Grok "Sign in with Grok" OAuth — Integration Contract

> **Status:** Conditional sign-off received (Codex/PM, 2026-07-07) — two required amendments applied (both-flavors device test + GATE-0 OAuth proof spike). Implementation unblocked in the staged order in §9; **step 1 = live OAuth proof spike** before any broad integration.
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
The registry is **static JSON bundled in the APK** (no runtime `/v1/models` discovery). With `freeform:false`, `models:[]` is **not shippable** (unlike `openrouter`, which is `freeform:true`). At impl time, enumerate `GET https://api.x.ai/v1/models` with a live token, seed `model-registry.json`, and set a valid `defaultModel` **in the model list**. Also add the `xai` branch to the hardcoded `config.js:320-323` default-model chain — its `else` returns `claude-opus-4-8`, which `api.x.ai` would **404**. Confirm whether oauth vs api_key expose different model sets → add `modelsByAuth` if so. **CONFIRMED via live SuperGrok `/v1/models` (2026-07-07, 9 models):** text/chat = `grok-4.3` (**default** — tested 200), `grok-4.20-0309-reasoning`, `grok-4.20-0309-non-reasoning`, `grok-4.20-multi-agent-0309`, `grok-build-0.1`; image/video (**OUT** of v1 text scope) = `grok-imagine-image`, `grok-imagine-image-quality`, `grok-imagine-video`, `grok-imagine-video-1.5`. Registry seeds the **5 text models, default `grok-4.3`**. (This is the OAuth token's view; api-key parity unconfirmed — add `modelsByAuth` only if a console key differs.) **Post-GATE-0 update (2026-07-09) — registry trimmed to `grok-4.3` + `grok-4.5`:** per product call the registry ships ONLY these two (anything else = user-typed Custom model); the `grok-4.20-*` + `grok-build-0.1` entries were dropped, and `grok-4.20-multi-agent-0309` was in fact **broken on chat/completions** anyway (live test: *"Multi Agent requests are not allowed on chat completions"*). **grok-4.5 device-test found two failures, both root-caused via `tests/xai-models` (live OAuth harness) + `node_debug.log`:** (1) **first-touch 403** — a brand-new model provisions lazily and 403s the first message, then works (same 403→200 pattern grok-4.3 showed on a fresh account); (2) **unbounded reasoning** — the app sent NO reasoning param, and xAI honors the OpenAI-style **`reasoning_effort` string** (NOT OpenRouter's `reasoning:{effort}` object), so grok-4.5 reasoned silently >60s on the big agent request → the 60s socket-idle timeout fired (grok-4.3 answered in ~3s). **Fix:** `providers/xai.js formatRequest` now always sends `reasoning_effort` (`minimal` heartbeats / `high` user-enabled / else `low`); pinned by `xai.test.js` + reproduced by `--diagnose`. **Default stays `grok-4.3` until the grok-4.5 reasoning fix is device-verified**, then flip to grok-4.5. Mobile context cap 200000 for all.

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

**GATE-0 evidence (2026-07-07 — headless probes PASS + live-login on a real SuperGrok account PASS):**
- **All headlessly-provable elements CONFIRMED, zero refutations** (OIDC discovery, device-code POST, authorize-loopback GET, token error-shape, inference reachability), each adversarially re-verified. Client `b1a00492-…` is live (public, discovery advertises `token_endpoint_auth_methods … "none"`); our **exact 6-scope string is accepted**; the **loopback `127.0.0.1:56121` redirect is registered** (authorize → 302 to `accounts.x.ai/sign-in` → `/oauth2/consent`, carrying our `redirect_uri`+PKCE, **no** `invalid_client`/redirect-mismatch); token body shapes accepted (both grants → `400 invalid_grant`); `api.x.ai/v1/{models,chat/completions}` live + Bearer-gated (`401 unauthenticated:no-credentials`).
- **Codex's earlier 403 is resolved:** it was a **Cloudflare bot-block on a bare/curl User-Agent** (generic "you have been blocked", no OAuth error param), NOT a client/redirect rejection — a normal browser UA gets a clean 302. Implication: the on-device Chrome Custom Tab is fine; only non-browser probes of `/oauth2/authorize` need a browser-like UA.
- **Verification hosts:** device-code approval at `https://accounts.x.ai/oauth2/device`; authorize sign-in/consent at `accounts.x.ai/sign-in` → `/oauth2/consent`.
- **Port `56121` is a hard runtime dependency** of the loopback flow (redirect must match exactly) → device-code is the fallback where the port is unavailable.
- `api.x.ai` emits **no `WWW-Authenticate`** header — send `Authorization: Bearer` proactively (already our design); CORS `*`; `id_token` **ES256**, `jwks_uri=https://auth.x.ai/.well-known/jwks.json`.
- **D1 = GO loopback+PKCE** (device-code proven as fallback). **Live-login PASS on a real SuperGrok account:** full authorization_code+PKCE round-trip → tokens issued (`access_token` JWT, `expires_in=21600`=6h, all 6 scopes granted); **refresh grant ROTATED the refresh_token** (confirmed on two runs — validates the single-flight + await-persist requirement in §5.4); **both `/v1/chat/completions` and `/v1/responses` returned 200** with `grok-4.3` (chat replied "pong 👋"); `/v1/models` → 200 with **9 models**. So SuperGrok-via-OAuth grants real Grok inference on `api.x.ai/v1`.
- **Transient-403 finding (important for §5.4/§6):** on the *first* login the initial `/v1/models` call returned `403 permission-denied` ("update permissions at console.x.ai"), then `200` on the next login/run — **API access provisions lazily on first touch**. So a 403 must get **one retry after a short delay** before being treated as a permanent tier-gate + API-key fallback; do NOT lock the user out on a single 403.

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
- **`classifyError` — full matrix (not just 401/403):** `401` → retryable only when `isOAuth && _currentRefreshToken` (→ refresh; **ai.js then rebuilds the request headers from `buildHeaders` so the retry carries the rotated bearer — the pre-loop `headers` still hold the expired token, and since this loop is xAI's ONLY refresh path, re-sending the stale bearer would 401 again and burn a single-use rotation on every attempt**); `403` (incl. `xai_oauth_tier_denied`/`permission-denied`) → **MUST classify as a non-`auth` type** (e.g. `provisioning`/`server`) so `ai.js:1738` never calls `handleUnauthorized` on a 403. **⚠️ Stage-2 C1 correction — the earlier "`ai.js:1736` gates refresh on `retryable` so no loop" reasoning was WRONG:** ai.js gates the *retry* on `retryable` but the *refresh* on `type==='auth'`, and `openai.js` lumps 401+403 both into `auth` — so a naively-cloned 403 would fire a refresh and **burn xAI's single-use refresh rotations** (up to `MAX_RETRIES=3`). True **retry-once** — **OAuth first-touch only** (an `api_key` 403 is a real credit/tier gate, terminal on the *first* hit with no retry and no "provisioning" copy) — via a module one-shot flag (NOT `MAX_RETRIES`); the second OAuth 403 → `retryable:false` + terminal tier-gate "Your Grok subscription tier doesn't include API access — add an xAI API key instead". Only `401` (`isOAuth && refresh present`) may be `type:'auth'`; `429` → retryable/backoff; `5xx` → retryable; `402`/quota → surfaced; refresh `400 invalid_grant` → re-login (non-retryable).
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
Loopback: redirect mismatch / port-in-use → surface, retry. Device-code (if chosen): pending/slow_down/expired/denied per §D1. Inference: 401→single-flight refresh→retry; refresh `invalid_grant`→re-login; **403→OAuth first-touch retry-once (access provisions lazily), then terminal; an api_key 403 is terminal at once → tier-gate + API-key fallback (no loop)**; 429/5xx→backoff. Sign-out clears all four fields + bumps configVersion. Network loss → bounded poll deadline, no crash.

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

## 9. Implementation staging + test plan

**Staging order (Codex-mandated 2026-07-07) — implementation is unblocked ONLY in this order:**
1. **OAuth proof spike — GATE 0, before any broad Kotlin/Node/UI work.** A tiny live proof of the loopback flow against the real xAI public client, proving: the exact authorize URL (`client_id`, `scope`, PKCE `S256`, `redirect_uri=http://127.0.0.1:56121/callback`) opens a real xAI login/consent screen; the callback reaches the local `127.0.0.1:56121` server; code exchange returns **both** access + refresh tokens; a `refresh_token` grant returns **rotated** credentials; and the failure mode is documented if port `56121` is fixed and unavailable. **If the spike fails, pivot to the device-code fallback (D1) BEFORE touching the rest of the app.** (An earlier unauthenticated authorize probe returned 403 — not definitive, but enough to keep this a hard proof gate.)
2. **Security review** of the proven auth shape (adversarial + CodeRabbit/Copilot) — BEFORE writing tests (security-critical policy).
3. **Core provider/config/runtime plumbing + Node tests.**
4. **Kotlin UI / storage / bridge.**
5. **Full pre-push + SAB + Seeker device test before merge.**

**Concrete tests (executed within the stages above):**
- **Node smoke** (`node tests/nodejs-project/smoke.js`) — mandatory for any `nodejs-project/**` change.
- **Node unit** — `providers/xai.js`: header build (api_key vs oauth), refresh (rotation persist + **await** + **single-flight**), 401→refresh, **403→terminal**, full classifyError matrix; `config.js`/`model-catalog.js` xai matrix + default-model; client_id Kotlin↔Node equality assertion.
- **Update existing tests** (they break otherwise): `model-catalog.test.js:136,142` (length 4→5) and `ModelRegistryTest.kt:268-274` (append preserves `[0]==openai`).
- **Kotlin compile** + targeted units (`ConfigManager` persist/clear/writeConfigJson downgrade; `RuntimeStateStore.isValidPair` xai; registry-decode).
- **`scripts/pre-push-check.sh`** green.
- **SAB audit** (`/sab-audit`) BEFORE merge — target 100%, cite the SAB version in the PR (mandatory: new provider + `buildSystemBlocks()` change).
- **Device test on Seeker** (real SuperGrok / X Premium+): loopback sign-in end-to-end (one-tap), Grok message via Telegram, token refresh after expiry, sign-out, API-key fallback, 403 path if a low-tier account is available, and (per D5) confirm the **OAuth tab is visible and works on both `dappStore` and `googlePlay` builds** (device end-to-end on Seeker via the `dappStore` build if that is the only hardware path). Verify System-screen SHA first.

## 10. Change-point checklist (~22, up from 15)
> **Do NOT start any change below until GATE 0 (the OAuth proof spike, §9) passes.** If the spike forces the device-code fallback, revisit D1/§5.1 first.

**Node:** (1) `model-registry.json` [append + required fields] (2) `providers/xai.js` NEW (3) `providers/index.js` register (4) `config.js` [providers, keys, default model, generic AUTH_TYPE] (5) `model-catalog.js` `hasCredentialsFor` (6) `runtime-state.js` (7) **`ai.js`** [getProviderApiKey+import, billing/apiHost, `## Provider` block, playbook, `/provider` help] (8) **`security.js`/`main.js`** [redaction] (9) **`DIAGNOSTICS.md`** [xai OAuth + 403 tier-gate].
**Kotlin:** (10) `oauth/XaiOAuthActivity.kt` NEW (11) `AndroidManifest.xml` (12) `config/ConfigManager.kt` (13) `state/RuntimeStateStore.kt` (14) `bridge/AndroidBridge.kt` [save-tokens + **handleConfigCredentials**] (15) `ui/components/XaiOAuth.kt` NEW (16) `ui/settings/ProviderConfigScreen.kt` (17) `ui/setup/SetupScreen.kt` (18) `ui/dashboard/DashboardScreen.kt` (19) `config/ConfigClaimImporter.kt` + SetupScreen QR handler [api-key] (20) `config/Providers.kt` [only if oauth-specific models].
**Tests/docs:** (21) update `model-catalog.test.js` + `ModelRegistryTest.kt`; add `providers/xai.test.js`. (22) `RuntimeState.kt` KDoc matrix.

## 11. Open questions for Codex
- D1 (loopback+PKCE vs device-code) — confirm loopback.
- D2 (chat/completions) — confirm.
- D3 (client_id reuse ToS) — confirm same accepted posture as our OpenAI OAuth (both flavors, own UA).
- D5 — OAuth on both flavors (parity with OpenAI).
- Duplicate `OpenAIOAuth*` for xai now vs generalize a shared OAuth base (recommend duplicate-then-refactor to limit blast radius on a proven flow).

## 11b. Stage-2 security review — MUST-FIX before/at implementation (2026-07-07)
Verdict: **GO** — auth shape is sound; residual risk is entirely in *cloning OpenAI verbatim*. Build every item below in the FIRST pass with the named tests; do not defer. (Full review posted to Linear.)

- **C1 (critical)** — `xai.js classifyError`: 403 is NOT `type:'auth'`; the retry-once grace (module one-shot flag, not `MAX_RETRIES`) is **OAuth-only** — an `api_key` 403 is a real credit/tier gate, **terminal on the first hit** (no retry, no "provisioning" copy). *Test: 403 never triggers refresh; OAuth retry bounded to one; api_key 403 terminal immediately.* (See §5.4 correction.)
- **H1** — Redaction is NET-NEW: `registerRedactedSecret(XAI_OAUTH_TOKEN/REFRESH)` at startup (`main.js:50-52`) **and** re-register the rotated pair inside `refreshOAuthToken` **before any `log()`/persist**. *Test: an `eyJ…` token does not survive `redactSecrets`.* Optional: add a generic JWT pattern as defense-in-depth.
- **H2** — Refresh durability: single-flight memoize (`_refreshInFlight`) + **await** `/xai/oauth/save-tokens` + treat persist-failure as a HARD error (never `resolve(true)` on unpersisted rotation); bounded persist retry; keep in-memory rotated token for the session and warn "re-login may be required after restart" only if all retries fail. *Test: persist-failure propagates.*
- **H3** — `getProviderApiKey` xai branch → `XAI_KEY`, never `ANTHROPIC_KEY` (else the Anthropic key is Bearer'd to api.x.ai). Also xai `billingUrl`/`apiHost` maps. *Test: Bearer==XAI_KEY.*
- **H4 (new)** — Cloudflare UA-gating: set explicit **`SeekerClaw/<ver>` User-Agent on ALL `auth.x.ai` calls** — the Kotlin token-exchange POST (`HttpURLConnection`) AND the Node `refreshOAuthToken` (`https.request`), which otherwise send no/Dalvik UA (GATE-0 proved the flow with `fetch`'s `UA: node`, a *different* transport). **Re-prove with the shipped transport in the §9 device test.** (authorize URL is browser-opened → safe.)
- **H5 (new)** — Cross-process boot-loop: `runtime_state.json` is read before `config.json`, and `isValidPair` accepts `(xai,oauth)` with a blank token → `process.exit(1)` restart loop (config.json downgrade is shadowed). Fix: gate `RuntimeStateStore` persistence of `(xai,oauth)` on a **non-blank token** (or apply the downgrade to runtime_state too). *Test: select xai+oauth, no token, no api key → no boot-loop.*
- **M1** — `handleXaiOAuthSaveTokens` = **targeted editor write** of only `xai_oauth_{token,refresh,expires_at}` + version bump (NOT full `saveConfig`) + keep-old-if-blank; add `/xai/oauth/save-tokens` to the bridge rate-limit map (5/60s); Node treats a **bridge 429** as retryable, distinct from an api.x.ai 429.
- **M2** — Preserve verbatim in `XaiOAuthActivity`: `isLoopback()` 403 guard, 32-byte `state` validation, PKCE S256 with a never-logged verifier; prefer explicit `127.0.0.1` bind. *Test: non-loopback IP rejected.*
- **M3** — Port 56121 `EADDRINUSE` → loud terminal error + API-key fallback (no hang). §9 device-test port-in-use.
- **M4** — id_token email is **display/PII only** — code-comment invariant; no authorization/owner-binding may read it.
- **M5** — Connection test uses a `POST /v1/chat/completions` 1-token ping (200 on first touch), NOT `GET /v1/models` (403 on first login → would falsely report a signed-in user "not connected"). Device-test connection immediately after first sign-in.
- **M6** — Revocation blast radius: distinct actionable "add an xAI API key" messaging; assert failure is a **per-turn error, never a config-load `process.exit`**; keep api_key path always selectable while `authType=oauth`.
- **L3 / L5 (cheap, do now)** — client_id byte-equality smoke test (Kotlin↔Node); registry entry has `keyHint`/`consoleUrl`/`keysUrl` + `ModelRegistryTest` (`providerById("unknown").id=="openai"`).

## 12. Sources
- xAI announcement — https://x.ai/news/grok-hermes
- Hermes guide — https://hermes-agent.nousresearch.com/docs/guides/xai-grok-oauth
- xAI OIDC discovery — https://auth.x.ai/.well-known/openid-configuration
- Hermes source — https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/auth.py
- client_id corroboration — https://github.com/search?q=b1a00492-073a-47ea-816f-4c329264a828&type=code

---
*Revised after adversarial 3-lens validation (security/auth, codebase-fidelity, product/ToS/self-awareness). All file:line citations verified against the repo at `main` (955991f8).*
