# BAT-1143 — xAI OAuth: auto-refresh the access token on expiry — Integration Contract

> **Status:** DRAFT v3.1 — **Codex FINAL sign-off** granted on v3 conditional on two tightenings (D3a monotonic-age + D9 explicit ordering), both folded in here. Per Codex: *"With those two clarifications, I'm comfortable giving the contract final sign-off for the staged implementation and tests inside PR #434."* Blocks BAT-1124 merge.
> **Severity:** critical. Device soak: the always-on agent dies every ~6h on xAI OAuth and demands a manual re-pair.
> **Parent:** BAT-1124 (ships in the **same PR #434**). Fixes a lifecycle bug in that feature.
> **Lineage:** v1 draft → in-house adversarial 3-lens self-review (caught the D4 fix-defeating bug + lockout vectors) → v2 → Codex review (4 amendments + Q1–Q6) → v3 → Codex re-review (D3a/D9 tightenings) → **v3.1 (this) = final**.

---

## 1. Problem & root cause (device-confirmed)

xAI OAuth (grok-4.5): last `200` at **00:12**, then HTTP **`403`** on every request from **06:42** (~6.5h ≈ the access token's 6h TTL, `expires_in=21600`) for ~14h, never recovering. Telegram: *"⚠️ Your session has expired. Please re-pair your device."*

**Access-token expiry after 6h is correct OAuth.** The bug: **we never auto-refresh it**, and then we **mislabel the resulting failures as a dead session**:
1. Refresh fires only via `handleUnauthorized`, called only when `classifyError` returns `type:'auth'` — gated on **`status === 401`**.
2. xAI returns a bare **`403`** (empty body) for an expired token, not `401`.
3. C1 classifies every `403` as a terminal `provisioning`/tier-gate (`retryable:false`) to protect single-use rotation.
4. → the hardened refresh machinery is **never invoked on the real expiry event**.
5. **ai.js:1912 ticks `_consecutiveAuthFailures` on _every_ `401||403` regardless of classification** (source-verified — the increment ignores the `classifyApiError` result computed at :1908). After **3** (`AUTH_FAIL_THRESHOLD`) it latches `_sessionExpired` and emits the misleading *"session expired, re-pair"* — even for a genuine tier-gate that a refresh could never fix. This is a **second, independent defect** (Codex amendment 4).

**OpenAI parity:** `openai.js` `classifyError` is the same 401-only design; it survives only because ChatGPT returns `401` on expiry. Out of scope here (separate soak-verify).

---

## 2. Decisions (D1–D10)

### D1 — Strategy: **proactive refresh + reactive `403` backstop**, both status-code-agnostic *(Codex: approved)*
- **Proactive (primary):** before every OAuth request (centralized — D6), if `now >= expiresAt - REFRESH_BUFFER_MS`, refresh first, then build headers.
- **Reactive backstop:** a `403` when `isOAuth && refreshTokenPresent && now >= expiresAt - REFRESH_BUFFER_MS` (see D3a token-age fallback) → `type:'auth'`/retryable → existing refresh→rebuild→retry loop.
- **C1 preserved for the fresh-token case:** a `403` on a token that is NOT near expiry stays the terminal tier-gate — never burn a rotation on a genuine tier-gate while the token is valid. Post-expiry tier-gate → D8.

### D2 — `REFRESH_BUFFER_MS` = **5 min**, both gates *(Codex Q1: ruled — 5 min)*

### D3 — Ordering is load-bearing: advance in-memory expiry **synchronously, before persist**
In `_performRefresh`, set `_currentExpiresAtMs = Date.now() + (parsed.expires_in || _DEFAULT_EXPIRES_IN)*1000` on the **same line region as `_currentOAuthToken = parsed.access_token` (xai.js:293-294), BEFORE `await _persistRotatedTokens`** (which throws on persist-failure). Guarantees no refresh-storm / double-rotation even if persist fails.

### D3a — Token-age fallback for backward clock skew *(Codex Q3 + re-review: monotonic source + validity sentinel)*
Both primary gates compare device `Date.now()` to the absolute `_currentExpiresAtMs`. A device clock **behind** real time (NTP backward-correction / slow RTC) makes a truly-expired token look fresh → 403 misclassified as tier-gate → false re-pair, **forever**. The fix must satisfy two constraints Codex flagged on v3:
- **Monotonic source, not `Date.now()` arithmetic.** `Date.now() - mintedAtMs` is *still* wall-clock and is NOT immune to a backward jump between mint and check (the v3 claim was wrong). Track a **monotonic** in-process anchor `_currentMintedAtMono` (e.g. `process.hrtime.bigint()`, unaffected by NTP/wall-clock jumps) set at the D3 site — but **only when this process actually mints the token** (a successful `_performRefresh`).
- **Validity sentinel — no uninitialized age.** A bare `_currentMintedAtMs = 0` makes `now - mintedAt >= TTL` true on the very first request → refresh-storm / burned rotations. Guard with `_mintedMonoValid` (default **false**); the reactive age predicate `elapsedMonoMs() >= (expiresInMs - BUFFER)` applies **only when `_mintedMonoValid === true`**.
- **Do not survive restart.** A monotonic anchor resets per process. On start (seed from disk) `_mintedMonoValid = false` → the age predicate is inert; we rely on the persisted absolute `_currentExpiresAtMs` (best-effort), and a **missing/invalid** persisted expiry falls through to the D5 one-time expiry-unknown opportunistic refresh.

So the age fallback protects the **intra-process** backward-jump case (the common NTP correction). The cross-restart skew residual (a present-but-wrong persisted expiry) is bounded — D10 prevents a false re-pair, D8 prevents rotation churn — and documented as a known narrow residual. Accepted trade-off (Codex): ≤1 extra rotation on a skewed genuine tier-gate.

### D4 — Persist `expiresAt` to Node **and prove restart-visibility of the full rotated credential** *(Codex amendment 1 — expanded)*
Source-verified mechanics: `writeConfigJson` runs at **service boot** (SeekerClawService.kt:361) → `loadConfig` (reads SharedPrefs) → regenerates the **ephemeral** config.json (deleted after Node reads it, :2035). Rotated **token+refresh already survive a service restart** (emitted at :2101-2102 from SharedPrefs, which `persistXaiOAuthTokens` updates on rotation). **BUT:** (a) `writeConfigJson` **excludes `expiresAt`** (verified comment at :2095 *"email/expiresAt are Android-only metadata"*) → Node's `_currentExpiresAtMs` stays `0` → fix inert; and (b) the rotation bridge path `handleXaiOAuthSaveTokens` (AndroidBridge.kt:969) writes **SharedPrefs + bumps config version only — it does NOT rewrite config.json** (M1 comment :961-964), so a Node-only restart (no service restart) between a rotation and the next `writeConfigJson` could read a stale ephemeral config.

Required (and each **tested against the actual generated config.json**, not just the Kotlin pref write):
- **Kotlin:** add `xaiOAuthExpiresAt` (+ `openaiOAuthExpiresAt` for symmetry, D-Q6) to `writeConfigJson`'s JSON.
- **Invariant (must hold + be tested):** after a rotation, **any** subsequent restart (service OR Node-only) must load the **rotated access token + refresh token + expiry** — never a stale/consumed credential. Implementation resolves the mechanism (e.g. the save-tokens handler also rewrites config.json, or the config-version bump/reload regenerates it) gated by the acceptance test below. **Never claim the session healthy while the rotated pair is still only in memory** (ties to D9).
- **Node:** `config.js` exports `XAI_OAUTH_EXPIRES_AT`; `xai.js` seeds `_currentExpiresAtMs = Date.parse(XAI_OAUTH_EXPIRES_AT) || 0`.
- **Acceptance test:** initial pairing → assert config.json contains `xaiOAuthExpiresAt`; simulate a rotation → assert the next generated config.json carries the rotated token+refresh+expiry; assert a restart-immediately-after-rotation cannot reload stale creds.

### D5 — Expiry-unknown fallback (defensive, not a migration)
Fix ships in the same PR #434 (unmerged) → every OAuth user pairs with D4 plumbing present from day one; no already-paired population, no migration. `_currentExpiresAtMs == 0` is only a defensive fallback: `isOAuth && refreshTokenPresent && ==0` → one opportunistic refresh on first use, fires at most once, suppressed once `_refreshDead`.

### D6 — Centralize the hook in `claudeApiCall` (not the tool loop)
`await adapter.ensureFreshToken?.()` before `buildHeaders` at **ai.js:1720** (verified: `claudeApiCall` at :1652, primary `buildHeaders` at :1720) — one site covers the main loop (:2827), **vision (:190)**, and the session-summary background call (:481). The standalone **context-summarizer (:2333-2369) bypasses `claudeApiCall`** (streamFn direct at :2362) → add the same before its `buildHeaders` (:2338). One line each.

### D7 — `classifyError(403)` branch ordering
The expired-token check MUST be the **first** statement inside `if (status === 403)`, before the `if (isOAuth && !_oauth403RetriedOnce)` block — else once `_oauth403RetriedOnce` latches, a later 6h-expiry `403` hits the terminal return and never refreshes. Unit-tested with `_oauth403RetriedOnce` pre-set.

### D8 — Tier-gate circuit-breaker, gated by an explicit **refresh-generation marker** *(Codex amendment 3 + Q2)*
A `403` becomes `_tierGated` **only when it is the inference response immediately following a successful refresh/retry — NOT merely because "expiry is now in the future."** Mechanism: a monotonic `_refreshGeneration` counter, incremented on each successful refresh; each outbound request is tagged with the generation it was built under. On a `403`:
- if the request's generation **==** the current generation **AND** a refresh occurred in this turn's retry chain (i.e. this is the post-refresh retry) → **tier-gate breaker** (`_tierGated = true`), terminal;
- an unrelated fresh-token `403` (no preceding refresh this chain) → terminal tier-gate via C1, but does **not** set the post-refresh breaker (so it can't be confused with a refreshed-then-still-403 case);
- **any** later successful inference (`200`) clears `_tierGated`;
- **re-pair clears all breaker + dead-token state** (`_tierGated`, `_refreshDead`).

Bounds a genuine tier-gate to **one** post-expiry rotation.

### D9 — Persist-failure convergence & dead-token suppression — explicit state machine *(Codex amendment 2 + Q4)*
On a rotation that succeeds server-side but fails to persist (`XAI_OAUTH_SAVE_FAILED`), keep the rotated pair in memory, set `_persistPending = true`, and complete the current turn with the valid in-memory access token (availability-first). Convergence is an **explicit ordered** state machine, driven from `ensureFreshToken()` on each subsequent call *(Codex re-review — ordering made explicit)*:
1. **Persist-first, never re-refresh while pending:** if `_persistPending`, the FIRST action is a bounded re-attempt to persist the *exact same* in-memory rotated pair — **NOT** a token refresh. (This resolves the v3 ambiguity: "retry on subsequent calls" = a persist-retry; "no refresh while pending" holds because we never rotate again while `_persistPending`.)
2. **On persist success:** clear `_persistPending`; health may return to `healthy` only on the **next successful inference**, not immediately.
3. **On persist failure:** continue the turn with the in-memory access token **without rotating again**; retain `_persistPending`; health stays `degraded`.
4. **On convergence exhausted** (bounded retries used up): surface a **durable error** and require re-pair/recovery; never silently treat a memory-only pair as healthy.

**Dead refresh token:** `refreshOAuthToken` → `invalid_grant` → `_refreshDead = true` → suppress all further proactive/probe refresh until re-pair (else the 5-min `_sessionExpired` probe POSTs the dead token every 5 min). Surface re-pair.

**Lost refresh RESPONSE (Codex Q4 — codified):** on a refresh **transport error** (timeout / ECONNRESET / socket close before body), the server may have rotated (consuming our token) or not — we cannot know. Rule: **do NOT immediately re-POST a refresh in the same turn** (avoid burning a second single-use rotation); keep the single-flight in-flight-failure state and let the **next turn's** proactive gate retry under the bounded policy. If the server did rotate, the next refresh gets `invalid_grant` → re-pair (the one unavoidable path). D3's synchronous-expiry ordering already prevents a same-turn second refresh.

### D10 — Fix session-expiry accounting (not only `classifyError`) *(Codex amendment 4 + Q5)*
The `_consecutiveAuthFailures` counter at **ai.js:1912** currently increments on **every** `401||403`, ignoring classification, so a genuine tier-gate reaches the 3-threshold and emits the false re-pair message. Require:
- a **fresh-token xAI provisioning/tier-gate `403`** does **not** count as OAuth session expiry;
- a **reactive near-expiry `403` that self-heals after refresh** does **not** count;
- **only** an auth failure that **remains after** refresh/dead-refresh handling contributes to re-pair detection.

Implementation: gate the increment on the *final* classification of the request after the retry/refresh chain (the surviving error), not the raw HTTP status. Covered by an **integration/source guard**, not just adapter unit tests.

---

## 3. Implementation sketch (staged — see §8)

**Kotlin (`ConfigManager.kt` / `AndroidBridge.kt`):** add `xaiOAuthExpiresAt` (+ `openaiOAuthExpiresAt`) to `writeConfigJson`; ensure the D4 restart-visibility invariant (config.json carries the rotated token+refresh+expiry after a rotation, before any restart re-read).
**`config.js`:** export `XAI_OAUTH_EXPIRES_AT`.
**`providers/xai.js`:**
- `let _currentExpiresAtMs = Date.parse(XAI_OAUTH_EXPIRES_AT) || 0; let _currentMintedAtMono = 0n; let _mintedMonoValid = false; let _refreshGeneration = 0; let _refreshDead = false; let _tierGated = false; let _persistPending = false;`
- `_performRefresh`: set `_currentExpiresAtMs` **and** `_currentMintedAtMono = process.hrtime.bigint()` + `_mintedMonoValid = true` synchronously at :293-294 (D3/D3a); `_refreshGeneration++` on success; on `invalid_grant` → `_refreshDead`; on persist-failure → `_persistPending = true` (D9 state machine, do not throw the turn away).
- `ensureFreshToken()` (exported, async; no-op for api_key / `_refreshDead` / `_tierGated`): **if `_persistPending`, bounded persist-retry of the same pair FIRST and return — never refresh while pending** (D9); otherwise refresh if near/past absolute expiry OR (`_mintedMonoValid` AND monotonic age-exceeded, D3a) OR expiry-unknown-first-use (D5).
- `classifyError(403)`: **first** — near/past absolute expiry OR (`_mintedMonoValid` AND monotonic age-exceeded, D3a) → `{type:'auth',retryable:true}`; else C1 tier-gate; honor `_tierGated`; set the D8 breaker only on the generation-marked post-refresh retry.
- expose `_repairReset()` clearing `_tierGated`/`_refreshDead`/`_persistPending` (called on re-pair).
**`ai.js`:** `await adapter.ensureFreshToken?.()` before `buildHeaders` in `claudeApiCall` (:1720) and the summarizer (:2338); tag requests with `_refreshGeneration` for D8; **gate the `_consecutiveAuthFailures` increment (:1912) on the surviving classification (D10)** — exclude tier-gate/provisioning and self-healed near-expiry 403s.

---

## 4. Edge cases
Dead token → suppress + re-pair (D9). Persist-failure → in-memory + bounded re-persist + degraded health (D9). Lost rotation response → no same-turn re-POST; next-turn retry; else re-pair (D9/Q4). Genuine tier-gate → one rotation then generation-marked breaker (D8). Expiry-unknown → one opportunistic refresh (D5). Refresh-storm → prevented by D3. Backward clock skew → token-age fallback (D3a). Vision/summarizer-first turn → D6. False re-pair on tier-gate → fixed by D10.

## 5. Test plan
- **Unit (`xai.test.js`):** `ensureFreshToken` refreshes when near/past expiry; no-op when fresh / api_key / `_refreshDead` / `_tierGated`; one opportunistic refresh on expiry-unknown; `_currentExpiresAtMs` + `_currentMintedAtMono` + `_mintedMonoValid` advance synchronously on refresh (expiry future even when `_persistRotatedTokens` throws). **D3a (monotonic age):** with `_mintedMonoValid === false` (uninitialized / seeded-from-disk) the age predicate does NOT fire on the first request (guards the `_currentMintedAtMs=0` refresh-storm); after an in-process refresh (`_mintedMonoValid === true`) it fires at `expiresIn - BUFFER`; a **backward `Date.now()` jump** neither suppresses the monotonic age gate nor makes the absolute gate fire early. `classifyError(403)` → auth when near/past expiry **even after `_oauth403RetriedOnce` set**, terminal when fresh, terminal when `_tierGated`. **D8:** expired 403 → refresh → fresh-retry 403 → breaker; unrelated fresh 403 → terminal but NOT post-refresh-breaker; a later 200 clears the breaker; `_repairReset` clears all state. **D9 (explicit convergence):** *"first persist fails → the current call still succeeds but health = `degraded` → next same-pair persist succeeds → **no second refresh POST** occurred → health recovers only on the next 200"*; while `_persistPending` a subsequent `ensureFreshToken` does a persist-retry (not a refresh); refresh transport-error → no same-turn re-POST; `invalid_grant` → `_refreshDead` + suppression.
- **Kotlin unit:** `writeConfigJson` output includes `xaiOAuthExpiresAt` (+ `openaiOAuthExpiresAt` serialization test, Q6).
- **Config-persistence proof (D4):** read the **actual generated config.json** — after pairing it carries `xaiOAuthExpiresAt`; after a simulated rotation the next config.json carries the rotated token+refresh+expiry; a restart-immediately-after-rotation cannot load stale creds.
- **Session-expiry accounting integration/source guard (D10):** a fresh-token tier-gate 403 does NOT tick toward re-pair; a self-healed near-expiry 403 does NOT tick; only a post-refresh surviving auth failure does.
- **Source/behavior guard (ai.js):** `ensureFreshToken` awaited before `buildHeaders` in both `claudeApiCall` and the summarizer.
- **Device soak (ACCEPTANCE):** xAI OAuth across the 6h boundary → one proactive refresh (or one reactive 403→refresh→200) at ~6h, **zero** re-pair, zero user-visible interruption; config.json asserted to contain `xaiOAuthExpiresAt`.

## 6. Security
No new secret surface; rotated tokens registered with the redactor before any log (H1); only the non-secret `expiresAt`/`mintedAt` drive decisions. Rotation cadence ~1/6h — guarded against churn by D3 (storm), D8 (tier-gate, generation-marked), D9 (persist/dead-token/lost-response), D3a (one bounded skew rotation). Re-pair surfaced only when the refresh token is genuinely dead — and D10 stops the false re-pair on a tier-gate.

## 7. Q1–Q6 — Codex rulings (RESOLVED)
- **Q1 → D2:** 5-min buffer, both gates.
- **Q2 → D8:** breaker only for the immediate post-refresh 403 path, via the explicit generation marker; cleared on any 200 or re-pair.
- **Q3 → D3a:** add the token-age fallback for backward clock skew; accept ≤1 extra rotation.
- **Q4 → D9:** codify "refresh transport error ⇒ no immediate second POST; retry next turn under bounded policy."
- **Q5 → D10:** exclude self-healing expiry 403s AND terminal tier-gate/provisioning classifications from the re-pair counter.
- **Q6 → D4:** adding `openaiOAuthExpiresAt` now is fine (data-plumbing only, no OpenAI behavior change) + a serialization test.

## 8. Staging gate (Codex-specified implementation order)
1. **Kotlin/config bridge persistence proof**, incl. restart visibility (D4).
2. **xAI refresh state machine** + unit tests (D3/D3a/D8/D9).
3. **Centralized proactive hook** + context-summarizer hook (D6).
4. **Session-expiry accounting** integration tests (D10).
5. **Full BAT-1124 regression suite** + a **real device soak** across the ~6h boundary.

## 9. Validation audit trail
- **In-house adversarial 3-lens self-review** (correctness / security-rotation / edge-race): caught the D4 fix-defeating premise (v1 claimed the wire existed; it didn't) + the lockout vectors (lost-rotation-response, persist-failure-then-restart, dead-token probe hammering, tier-gate churn).
- **Codex external review (v2 → v3) — conditional sign-off:** direction approved; 4 required amendments folded in — D4 (actual persistence + restart-visibility proof), D9 (persist-failure state machine), D8 (explicit refresh-generation marker), **D10 (session-expiry accounting — a second user-facing defect)** — plus Q1–Q6 rulings.
- **Codex re-review (v3 → v3.1) — FINAL sign-off:** two tightenings required and folded in — **D3a** (monotonic mint anchor + validity sentinel; corrected the false "immune to clock jump" claim and the `_currentMintedAtMs=0` refresh-storm) and **D9** (explicit persist-first-never-refresh ordering + health-convergence). Codex: *"comfortable giving the contract final sign-off for the staged implementation and tests inside PR #434."* Cleared to implement §8 in order.
