# X (Twitter) API Integration — Design Spec

> **Date:** 2026-04-07
> **Status:** Draft — blocked on open questions (see §10)
> **Target release:** v1.10.0 (Phase 1A+1B), v1.11.0 (Phase 2)
> **Related:** `docs/internal/audits/SAB-AUDIT-v19.md` (OAuth pattern precedent), `BAT-485` (Codex OAuth, merged as PR #316)

## 1. Context & Motivation

X (Twitter) is the social graph most SeekerClaw users already live on — crypto natives, indie founders, researchers, Solana ecosystem folks. Integrating the X API turns the agent from "chat with me on Telegram" into "chat with me on Telegram, and post/read/monitor X for me."

The unlock is **X API Pay-Per-Use**, launched February 2026. Previously the Basic tier's $200/mo floor made X integration a non-starter for individual users. PPU removes that — realistic personal usage is ~$3–10/mo.

This spec covers a phased integration that mirrors SeekerClaw's existing patterns (Solana tools, OpenAI Codex OAuth, Discord channel) so there's nothing architecturally novel to review.

## 2. Goals

1. Users can **ask the agent to post, search, summarize, and monitor X** via Telegram/Discord.
2. Ship the lowest-friction entry point first (Bearer-only read tools) so users can try it with just an API key.
3. Offer the full-fledged experience (OAuth user context for posting/DMs/mentions) as an upgrade without requiring reinstall.
4. Hard cost ceiling — the user can never accidentally burn more than $X/day on X API calls.
5. Zero new architectural risk — reuse existing patterns (tool dispatch, confirmation gates, cron, OAuth flow).

## 3. Non-Goals

- **Full-archive search** (Pro tier only, $5k/mo).
- **Real-time filtered stream** (battery cost + PPU per-delivered-tweet pricing + nodejs-mobile keeps long-lived sockets alive poorly under Doze). Simulated via cron polling instead.
- **Account Activity / webhooks** (requires public HTTPS endpoint; SeekerClaw is behind NAT on a phone).
- **Multi-account support.** One X account per SeekerClaw install.
- **Engagement farming / automation at scale.** Owner-initiated only. Mass DMs, bulk follows, auto-likes on keyword → never.

## 4. Two auth modes

Mirrors the "OpenAI API Key vs ChatGPT OAuth" split users already understand.

### 4.1 Bearer mode (App-only)
- User pastes a **Bearer token** from `developer.x.com`.
- Zero OAuth dance. Low friction. Low risk.
- Unlocks: public search, public user lookups, public user tweets, trending.
- **Cannot** post, read mentions/home, DM, follow, like.
- Target user: "I just want to ask the agent what's trending about Solana."

### 4.2 OAuth mode (user context)
- User taps **"Connect X account"** → Custom Tab → authorize → token comes back.
- Reuses the **exact PKCE flow** from `OpenAIOAuthActivity.kt` (Custom Tab → `http://127.0.0.1:1455/x/callback` → token exchange → `ConfigManager.saveConfig`).
- Unlocks everything Bearer does + post, reply, quote, delete, like, RT, follow, mentions, home_timeline, DMs.
- Required scopes: `tweet.read tweet.write users.read follows.read follows.write like.write bookmark.read bookmark.write offline.access`.
- DM scopes (`dm.read`, `dm.write`) requested separately in Phase 2 (gating uncertain — see §10).

Both modes can be configured simultaneously. The agent picks the right credential per tool automatically (read tools prefer Bearer if available since it's simpler; writes always use OAuth).

## 5. Pricing & cost controls

### 5.1 Confirmed PPU prices
| Action | Cost |
|---|---|
| Post read | $0.005 |
| User lookup | $0.010 |
| Post create | $0.010 |
| DM read | $0.010 |
| Post interaction (like/RT/follow) | $0.015 |
| DM send | $0.015 |
| 24h dedup | same resource in same UTC day = one charge |

### 5.2 Prices NOT yet confirmed (open question §10.1)
- Recent search endpoint
- Filtered stream (if even available on PPU)
- Mentions endpoint
- Home timeline endpoint
- Media upload (v1.1 — likely not on PPU anyway)

### 5.3 Cost controls (defense in depth)

1. **Hard daily spend cap** — `X_SPEND_CAP_USD_PER_DAY`, default **$3.00**. Hit the cap → all X tools return a spend-cap-exceeded error until next UTC midnight. Counter persists in `config` so restarts don't reset it.
2. **Per-turn call cap** — `MAX_X_CALLS_PER_TURN = 5`. The agent can't accidentally loop through 50 user lookups in one turn.
3. **Loop detector** — our existing loop detector already catches repeated identical calls. No changes needed.
4. **24h dedup awareness** — the local cost tracker tracks resources fetched per UTC day and only charges once, matching X's billing. No point hitting the real endpoint twice the same day for the same tweet anyway (we cache it).
5. **Spend display** — running daily total + monthly estimate shown in `/quick` and on the dashboard near the AI Provider pill.
6. **Conservative defaults for new users** — first-run spend cap is $1/day until the user explicitly raises it.

## 6. Phased rollout

### Phase 1A — Bearer-only reads (v1.10.0, ~300 LOC, ~2 days)

**Files:**
- `app/src/main/assets/nodejs-project/x.js` (~150 LOC) — config load, Bearer token, HTTP wrapper, cost tracker, dedup cache, core `xRequest()` function.
- `app/src/main/assets/nodejs-project/tools/x.js` (~120 LOC) — 4 tools wired into `tools/index.js`.
- `app/src/main/java/com/seekerclaw/app/ui/settings/XConfigScreen.kt` (~150 LOC) — Bearer token field, "Test Connection" button, spend cap editor, daily spend display.
- Minor edits: `config.js` (read `xBearerToken`, `xSpendCapUsdPerDay`), `ConfigManager.kt` (fields + getters, Keystore-encrypted), `NavGraph.kt` (+ route).

**Tools:**
- `x_search_recent(query, max_results)` — 7-day search.
- `x_user_lookup(username)` — profile + follower count + bio.
- `x_user_tweets(username, max_results)` — recent posts from a public account.
- `x_trending(location_id?)` — trending topics (if endpoint still available on PPU; see §10.3).

**User flows enabled:**
- "What's trending about Solana?" → search_recent + summary
- "What did @aeyakovenko tweet this week?" → user_tweets
- "Who is @foobar?" → user_lookup
- "Any news about the SEC and crypto on X?" → search_recent + summary

### Phase 1B — OAuth user context (v1.10.0, same release or v1.10.1, ~500 LOC, ~1 week)

**Additional files:**
- `app/src/main/java/com/seekerclaw/app/oauth/XOAuthActivity.kt` (~400 LOC) — port of `OpenAIOAuthActivity.kt` nearly verbatim. Same state machine, same `WriteState` pattern, same companion-scope exchange function, same `@Volatile callbackReceived`, same idempotency guard. Different auth/token URLs and scopes.
- `AndroidBridge.kt` (+40 LOC) — `/x/oauth/save-tokens` endpoint (Node → Kotlin) for refresh token persistence.

**Additional tools (8):**
- `x_post(text, reply_to?, quote_tweet_id?)` — confirmation-gated
- `x_reply(tweet_id, text)` — confirmation-gated
- `x_quote(tweet_id, text)` — confirmation-gated
- `x_delete(tweet_id)` — confirmation-gated
- `x_like(tweet_id)` — confirmation-gated
- `x_retweet(tweet_id)` — confirmation-gated
- `x_mentions(max_results)` — read mentions of the signed-in user
- `x_home_timeline(max_results)` — reverse-chronological home feed

**User flows enabled:**
- "Post to X: [content]" → draft → confirm → post
- "Post this thread: [lines]" → chained replies, single confirmation on first tweet
- "Reply to https://x.com/foo/status/123 with 'thanks'" → parse ID, confirm, reply
- "Delete my last tweet" → lookup + confirm + delete
- "What are my mentions today?" → mentions + AI summary
- "Summarize my home timeline" → home_timeline + AI summary
- "Schedule a tweet for 9am tomorrow" → `cron_create` wrapping `x_post`
- "Monitor @vitalik for 'Solana'" → `cron_create` agentTurn running `x_search_recent`

### Phase 2 — DMs + media + skills (v1.11.0, ~400 LOC, future)

**Additional tools:**
- `x_dm_send(recipient_username, text)` — heavy confirmation: recipient + full text shown, rate-limited to 3 DMs/hour.
- `x_dm_list(max_results)` — read recent DMs (scope gating TBD, §10.4).
- `x_follow(username)`, `x_unfollow(username)` — confirmation-gated.
- `x_bookmark(tweet_id)`, `x_bookmark_list(max_results)` — no confirmation needed.

**Media upload:**
- v1.1 `POST media/upload` endpoint requires OAuth 1.0a HMAC-SHA1 signing. ~100 LOC of pure-JS HMAC-SHA1 (Node's `crypto` module works in nodejs-mobile). Hand-rolled to avoid pulling in `oauth-1.0a` npm package.
- Enables "post this photo from the camera" + tweets with images.

**Skills:**
- `x-monitor` — cron-driven keyword/account monitoring.
- `x-schedule` — convenient scheduled posting wrapper.
- `x-digest` — daily timeline summary via heartbeat.

## 7. Integration shape — mirrors Solana pattern

```
app/src/main/assets/nodejs-project/
├── x.js                    # ~400 LOC (OAuth2 PKCE token store, refresh, signed fetch,
│                             endpoint wrappers, dedup cache, cost tracker)
└── tools/
    └── x.js                # ~500 LOC across Phase 1A + 1B + 2, 14 tools total,
                              wired into tools/index.js dispatcher

app/src/main/java/com/seekerclaw/app/
├── ui/settings/
│   └── XConfigScreen.kt    # ~300 LOC (Bearer token field, OAuth connect button,
│                             spend cap editor, daily/monthly spend display,
│                             disconnect, test connection)
├── oauth/
│   └── XOAuthActivity.kt   # ~400 LOC (port of OpenAIOAuthActivity)
├── config/
│   └── ConfigManager.kt    # +50 LOC (xBearerToken, xOAuthToken, xOAuthRefresh,
│                             xUserId, xUsername, xSpendCapUsdPerDay, xSpendDailyUsd,
│                             xSpendResetAtUtc, all Keystore-encrypted)
└── bridge/
    └── AndroidBridge.kt    # +60 LOC (/x/oauth/save-tokens, /x/oauth/start)
```

**Total across all phases: ~1,700 LOC.** Comparable to Telegram or Discord channel additions.

## 8. System prompt updates (mandatory — see CLAUDE.md SAB rule)

Per the SAB-before-merge rule added to CLAUDE.md yesterday, each phase MUST update:

1. **`buildSystemBlocks()` in ai.js:**
   - Capabilities section: "X (Twitter) integration — search, read, post, reply, DM"
   - Config Awareness section: X auth mode (bearer/oauth/both), spend cap, daily spend
   - Self-Diagnosis Playbook: "If X tool fails" block (rate limit, auth, spend cap hit, suspended)
   - Content Trust Policy: extend to cover X data (treat tweet content as UNTRUSTED)

2. **`DIAGNOSTICS.md`:**
   - X section with failure modes: invalid bearer token, OAuth expired, spend cap hit, 429 rate limit, 403 suspended/forbidden, 400 tweet too long / invalid reply ID.

3. **Tool descriptions** — each `x_*` tool needs a specific, detailed description that tells the agent:
   - What it does
   - Which auth mode it requires (bearer or oauth)
   - Which confirmation gate applies (if any)
   - Cost per call

4. **Negative knowledge update:**
   - "You cannot push-notify on X events. Real-time monitoring is polling-based via cron."
   - "You cannot post to X without user OAuth (Bearer mode is read-only)."

An SAB audit (v20) runs **before** each phase's PR merges, not after.

## 9. Security & risk mitigations

1. **Confirmation gates on ALL writes** — no exceptions, not even cron-scheduled tweets. Cron runs that hit `x_post` get confirmation via Telegram/Discord before firing, or operate in "draft-only" mode that prepares a tweet and waits for user approval.
2. **Content Trust Policy extension** — tweet content from search/timeline/DMs wrapped in `<<<EXTERNAL_UNTRUSTED>>>` markers just like `web_fetch` results. Prompt injection via tweet body is a realistic attack vector.
3. **Hard spend cap** — $3/day default, $1/day for first-run, configurable up to $30/day max.
4. **No bulk actions** — max 3 DMs/hour, max 10 posts/hour, max 20 follows/day. Configurable but capped.
5. **Suspension watchdog** — if X returns 403 with suspended/account_locked, persistently surface the error and disable X tools for 24h to prevent feedback loop.
6. **Tokens encrypted at rest** — Bearer, OAuth access, OAuth refresh all via `KeystoreHelper.encrypt` (same as OpenAI OAuth).
7. **Result file pattern** — OAuth callback result never contains tokens, only status. Same two-layer pattern as Codex OAuth (SharedPreferences = intent, tokens persisted via ConfigManager directly).
8. **Client ID in APK** — X PKCE confidential client vs public client gating affects whether we can ship the client ID safely. See §10.6.
9. **DM consent gate** — DM send always shows "Send DM to @recipient: '[body]'? Reply YES to confirm." even for owner-initiated messages.
10. **No automated engagement** — no auto-like, auto-follow, auto-RT based on keywords. User must explicitly say "like that tweet."

## 10. Open questions (BLOCK START)

These MUST be answered before Phase 1A PR can open. Most require logging into `console.x.com` or testing a throwaway dev account.

### 10.1 — Full PPU price sheet (CRITICAL — affects Phase 1A cost estimates)

**What is confirmed (from X devcommunity PPU launch post Feb 2026, corroborated by 3 independent sources):**
- Post read: $0.005
- User lookup: $0.010
- Post create: $0.010
- DM read: $0.010
- DM send: $0.015
- Post interaction (like/RT/follow): $0.015
- 24h dedup rule (same resource same UTC day = 1 charge)

**What is NOT confirmed (even for Phase 1A's main tools!):**
- `GET /2/tweets/search/recent` (recent search) — used by `x_search_recent`. Could be flat per query, per-result, or with a search premium. Estimating "$0.05/query @ 10 results" is a guess based on "post read = $0.005" — could be 0.5x or 5x off.
- `GET /2/users/:id/tweets` (user timeline) — used by `x_user_tweets`. Same uncertainty.
- `GET /2/users/:id/mentions` (mentions) — Phase 1B
- `GET /2/users/:id/timelines/reverse_chronological` (home) — Phase 1B
- Media upload (v1.1) — Phase 2
- Filtered stream (if supported on PPU at all)
- `x_trending` — Phase 1A optional, drop if unclear

**Implication for Phase 1A:** all cost estimates in §6 and the user-feature matrix (§13) are **modeled, not measured**. The hard daily spend cap (default $1/day for first-run, configurable) is what protects users from estimate error.

**Action:** Log into `console.x.com` and screenshot the full price list. Until that happens, ship Phase 1A with **$1/day default spend cap** and the dashboard pill showing live spend so users can calibrate their own ceiling on day 2.

### 10.2 — Minimum credit purchase
Is PPU truly pay-as-you-go or is there a $10/$25/$100 minimum top-up? Affects friction of first-time setup.

**Action:** Check console.x.com billing page.

### 10.3 — `x_trending` endpoint availability
The trending endpoint was historically v1.1. Is there a v2 equivalent? Is it on PPU? If not, drop `x_trending` from Phase 1A.

**Action:** Check `docs.x.com` + confirm on console.

### 10.4 — DM scope gating
Historically X required separate approval for `dm.read`/`dm.write` scopes (case-by-case review). Does PPU remove this gate or is it still enforced?

**Action:** Try requesting DM scopes on a throwaway dev account. If gated, Phase 2 DMs is blocked until approval.

### 10.5 — v2 media upload endpoint
Is there a v2 media upload as of 2026, or is it still v1.1 only? This decides whether Phase 2 needs OAuth 1.0a HMAC-SHA1 implementation.

**Action:** Check `docs.x.com/x-api/media` (not fetched in research).

### 10.6 — OAuth2 public client vs confidential hybrid
X's OAuth 2.0 PKCE docs describe both "confidential client with PKCE" and "public client" modes. Affects whether we can ship the client ID in the APK without a client secret.
- If **public client** supported → ship client ID in APK, same pattern as Codex OAuth.
- If **confidential only** → need a server-side proxy for the token exchange step (one-shot, stateless, but still a server we don't have).

**Action:** Check `docs.x.com/resources/fundamentals/authentication` + try registering a test app.

### 10.7 — Rate limit headers on PPU
Rate limits are confirmed for tiered plans. Assumption: PPU uses the same `x-rate-limit-*` headers and per-endpoint limits. Not explicitly stated in docs.

**Action:** Test with a real PPU call, inspect headers.

### 10.8 — xAI credit rebate mechanics
Docs mention "up to 20% back as xAI API credits on X API spend." Is this automatic or does it require xAI account linking? If automatic, it could subsidize our Claude/OpenAI spend — worth surfacing as a feature. If manual, too much friction to bother.

**Action:** Check xAI developer portal + X API billing docs.

### 10.9 — Callback URL restrictions
Codex OAuth accepted `http://localhost:1455/auth/callback` as the registered redirect URI. Does X accept `http://127.0.0.1:1455/x/callback` or `http://localhost:1455/x/callback`? Some OAuth servers reject non-HTTPS loopback.

**Action:** Try registering a dev app with loopback URIs.

### 10.10 — Suspension consequences
If a user posts something X finds objectionable and their account gets suspended, does the OAuth token immediately fail, or does it return a specific error code we should handle? We want a clear "your X account is suspended — check x.com" message instead of a generic failure.

**Action:** Read X error code reference.

## 11. Verification plan

### Pre-merge checks
- Each phase runs through `version-tracker` skill for consistent bumps.
- SAB audit (v20 for Phase 1A, v21 for Phase 1B, etc.) with **pre-fix score recorded before any prompt changes**. Per the CLAUDE.md rule added yesterday, drift-below-95 blocks merge.
- Copilot review iterations until zero substantive comments.
- `node --check` passes on every `x.js` and `tools/x.js` edit.

### Device smoke tests per phase

**Phase 1A:**
- T1: Paste bearer token in Settings → Test Connection → green
- T2: "What's trending about Solana?" → search_recent fires → returns results → agent summarizes
- T3: "Who is @aeyakovenko?" → user_lookup → correct profile
- T4: Spend cap: set $0.05/day → make 10 calls → 11th returns spend-cap-exceeded error
- T5: Dashboard shows daily X spend counter
- T6: Existing features (Telegram, OpenAI OAuth, Solana) unaffected

**Phase 1B:**
- T7: Connect X via OAuth → browser → authorize → return to app → "Signed in as @username"
- T8: "Post to X: testing SeekerClaw v1.10" → confirmation gate → YES → posted, URL returned
- T9: Cancel mid-flow (close browser) → settings stay on OAuth, no crash, retry works
- T10: "What are my mentions today?" → fetches + summarizes
- T11: "Delete that last tweet" → confirmation → deleted
- T12: Token refresh: manually expire token → send a command → refresh fires → succeeds
- T13: Sign out → tokens cleared → X tools return auth_required error

**Phase 2:**
- T14-T18: DM send with confirmation, DM list, media upload, follow/unfollow, bookmark

## 12. Rollback plan

Each phase ships behind no feature flag — X integration is an opt-in Settings screen, disabled by default. If a serious bug ships:
1. Users can clear tokens in Settings → X is effectively disabled.
2. If worse: revert the release, tag a hotfix, users update via Play/dApp Store.
3. The `X_SPEND_CAP_USD_PER_DAY` ceiling ensures even a runaway bug can't burn more than $3 of user money before self-limiting.

## 13. Appendix — user feature matrix

| User asks | Phase | Auth | Confirmed? |
|---|---|---|---|
| "What's trending about SOL?" | 1A | bearer | no |
| "Who is @foo?" | 1A | bearer | no |
| "What did @bar tweet this week?" | 1A | bearer | no |
| "Any news on X about topic?" | 1A | bearer | no |
| "Post to X: ..." | 1B | oauth | **yes** |
| "Reply to that tweet with ..." | 1B | oauth | **yes** |
| "Delete my last tweet" | 1B | oauth | **yes** |
| "What are my mentions today?" | 1B | oauth | no |
| "Summarize my home timeline" | 1B | oauth | no |
| "Schedule a tweet for 9am" | 1B | oauth | **yes (at fire time)** |
| "Monitor @user for 'keyword'" | 1B | oauth/bearer | no |
| "Who unfollowed me this week?" | 1B | oauth | no |
| "DM @bob 'hey'" | 2 | oauth + dm scopes | **yes (heavy)** |
| "Post this photo from camera" | 2 | oauth + media (OAuth 1.0a) | **yes** |
| "Like that tweet" | 1B | oauth | **yes** |
| "Follow @someone" | 2 | oauth | **yes** |
| "Bookmark this" | 2 | oauth | no |
| "Read my recent DMs" | 2 | oauth + dm scopes | no |
