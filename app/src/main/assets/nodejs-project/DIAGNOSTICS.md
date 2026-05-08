# DIAGNOSTICS.md — SeekerClaw Agent Troubleshooting Guide

> **Purpose:** Deep troubleshooting for failure modes not covered by the quick playbook in your system prompt.
> Read this file on demand when you need detailed diagnosis steps.

---

## Channel Connection

### Which Channel Am I On?
The agent runs on one of two channels, configured by the `CHANNEL` setting (`telegram` or `discord`). The `channel.js` abstraction routes all messaging calls to the active channel module. Check `CHANNEL` in config to determine which channel-specific diagnostics apply.

---

## Telegram

### Bot Token Invalid/Revoked
**Symptoms:** No messages received, grammy throws 401 Unauthorized in logs.
**Check:**
```
grep -i "401\|Unauthorized\|FORBIDDEN" node_debug.log | tail -10
```
**Diagnosis:** If you see `401 Unauthorized` from api.telegram.org (not api.anthropic.com), the Telegram bot token is invalid or revoked.
**Fix:** Tell the user: "Your Telegram bot token appears invalid. Go to @BotFather on Telegram, regenerate the token, then update it in SeekerClaw Settings > Telegram Token." This requires an app restart.

### Telegram Rate Limited (429)
**Symptoms:** Messages delayed or dropped, 429 responses from Telegram API in logs.
**Check:**
```
grep -i "429\|Too Many Requests\|rate.limit" node_debug.log | tail -10
```
**Diagnosis:** Telegram rate limits: ~30 messages/second to different chats, ~20 messages/minute to same chat, ~1 message/second for same chat. Bulk sending or rapid tool status updates can trigger this.
**Fix:** Reduce message frequency. Batch status updates into single messages. If persistent, wait 30-60 seconds before retrying. This is transient — no config change needed.

### Network Prolonged Outage
**Symptoms:** No messages arrive for extended periods. Logs show many consecutive poll or WebSocket failures.
**Check:**
```
grep -i "Prolonged outage\|consecutive.*poll\|consecutive.*fail" node_debug.log | tail -10
```
**Diagnosis:** After 20+ consecutive poll failures (Telegram) or sustained WebSocket disconnects (Discord), the system logs a "Prolonged outage" warning. This indicates persistent network loss — not a bot or API issue.
**Fix:**
1. Check device network: WiFi connected? Mobile data active?
2. Check DNS: `grep -i ENOTFOUND node_debug.log | tail -5`
3. The polling/WebSocket system auto-recovers when network returns — no manual intervention needed
4. If the user reports this: "Your phone lost network connectivity for a while. Messages during the outage may have been missed. Check your WiFi/mobile data connection."

---

## Discord

### Bot Token Invalid or Missing Intents
**Symptoms:** Bot never connects, logs show 4004 (Authentication failed) or 4014 (Disallowed intents).
**Check:**
```
grep -i "4004\|4014\|Authentication\|Disallowed intent\|DISCORD" node_debug.log | tail -10
```
**Diagnosis:**
- **4004 Authentication failed:** The Discord bot token is invalid, revoked, or malformed.
- **4014 Disallowed intents:** The bot requires Message Content Intent enabled in Discord Developer Portal (discord.com/developers → Bot → Privileged Gateway Intents).
**Fix:**
- For invalid token: "Go to discord.com/developers, select your application, copy the bot token, and update it in SeekerClaw Settings > Discord Token." Requires restart.
- For missing intents: "Enable 'Message Content Intent' in Discord Developer Portal > Bot > Privileged Gateway Intents, then restart SeekerClaw."

### WebSocket Disconnect / Reconnection
**Symptoms:** Messages stop arriving, then resume after a delay. Logs show "Gateway disconnected" or "Reconnecting".
**Check:**
```
grep -i "gateway.*disconnect\|reconnect\|resume\|heartbeat.*ack" node_debug.log | tail -10
```
**Diagnosis:** Discord Gateway uses WebSocket with heartbeat/ACK keepalive. If the server doesn't ACK a heartbeat, the client reconnects automatically. This is normal and self-healing. Frequent disconnects indicate network instability.
**Fix:** Transient — no action needed. If persistent:
1. Check network stability (WiFi vs mobile data)
2. Check logs for repeated close codes (4000=unknown error, 4007=invalid seq, 4009=session timed out — all trigger automatic reconnect)
3. The bot resumes the session when possible (no message loss), or starts a new session if resume fails

### Discord Rate Limited (429)
**Symptoms:** Messages delayed, 429 responses in logs.
**Check:**
```
grep -i "429\|rate.limit\|Retry-After" node_debug.log | tail -10
```
**Diagnosis:** Discord rate limits: 5 messages/5s per channel, 50 requests/second global. Bulk sending or rapid tool status updates can trigger this.
**Fix:** Reduce message frequency. The Discord client automatically waits for Retry-After headers. If persistent, batch status updates into single messages.

---

## LLM API (Claude / OpenAI / OpenRouter / Custom)

### Transport Timeout (Stream Drops)
**Symptoms:** Responses cut off mid-stream, `[Trace]` entries in logs showing high latency, user sees partial or no response.
**Check:**
```
grep "\[Trace\]" node_debug.log | tail -10
```
**Diagnosis:** Look at the `elapsed` field in trace entries. Values over 60s indicate transport timeouts. Common on unstable mobile networks. Since BAT-259, responses use streaming which reduces but doesn't eliminate this.
**Fix:**
1. Check network stability: `grep -i "ETIMEDOUT\|ECONNRESET\|socket hang up" node_debug.log`
2. If frequent: suggest the user switch to WiFi or a more stable connection
3. The system automatically retries with backoff — no manual intervention usually needed
4. API timeout is configurable in agent_settings.json (`apiTimeoutMs`, default 120000)

### Context Overflow (400 Error)
**Symptoms:** API returns 400 error, message mentions "maximum context length" or "too many tokens".
**Check:**
```
grep -i "400\|context.*length\|too many tokens" node_debug.log | tail -5
```
**Diagnosis:** The conversation + system prompt exceeded the model's context window. This can happen with very long tool results or accumulated conversation history.
**Fix:**
1. Use `/new` to archive and clear conversation history
2. If a specific tool result was too large, note that tool results are auto-truncated at ~50K characters (HARD_MAX_TOOL_RESULT_CHARS) but the conversation can still accumulate
3. MAX_HISTORY (35 messages) should prevent this in normal use — if it happens, it's likely a single very large message or tool result

### Custom Provider — Connection or Format Errors
**Symptoms:** All API calls fail immediately. Logs show connection refused, SSL errors, or unexpected response format (e.g., "Unexpected token" JSON parse errors).
**Check:**
```
grep -i "custom provider\|ECONNREFUSED\|UNABLE_TO_VERIFY\|Unexpected token" node_debug.log | tail -10
```
**Diagnosis:** The user configured a custom OpenAI-compatible endpoint in Settings > AI Provider > Custom. Common issues:
- **Wrong base URL:** URL must include the path up to (but not including) `/v1/chat/completions` — e.g., `https://my-gateway.example.com` not `https://my-gateway.example.com/v1/chat/completions`
- **Self-signed SSL:** If the endpoint uses a self-signed certificate, Node.js rejects it by default (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`)
- **Auth header mismatch:** Some gateways use custom auth headers instead of `Authorization: Bearer`. The user can set custom headers in Settings.
- **Unsupported format:** Custom provider defaults to Chat Completions (`/v1/chat/completions`). If the gateway only supports OpenAI Responses API, the user must set format to `responses` in Settings.
- **Model ID mismatch:** The model string must exactly match what the custom gateway expects.
**Fix:**
1. Verify the base URL is reachable: `curl -s <base_url>/v1/models` (or equivalent health endpoint)
2. Check auth: API key and/or custom headers must match what the gateway expects
3. Guide the user to Settings > AI Provider > Custom to review URL, key, headers, format, and model ID
4. For SSL issues: suggest the user switch to an endpoint with a valid certificate, or use HTTP (if local/trusted)

### OpenAI Codex OAuth — Token Refresh Failure
**Symptoms:** Agent stops responding on OpenAI OAuth. Log shows `[OpenAI] OAuth refresh failed` or `OAuth token refresh failed`. Subsequent API calls return 401.
**Check:**
```
grep -i "OAuth refresh\|oauth_refresh\|invalid_grant" node_debug.log | tail -20
```
**Diagnosis:** The OAuth refresh token is rejected by `auth.openai.com/oauth/token`. Causes:
- **User changed ChatGPT password** — invalidates all refresh tokens
- **User signed out of ChatGPT on another device** — may invalidate the SeekerClaw session
- **Refresh token revoked** — manual revocation in OpenAI account settings
- **OpenAI rotated client secret** — rare, would affect all users
**Fix:**
1. Check the exact refresh error: `grep "OAuth refresh failed" node_debug.log | tail -5` — look for `error_description`
2. Tell the user to re-sign-in: Settings > AI Provider > OpenAI > Sign in with ChatGPT
3. Sign-out is NOT required first — re-signing-in overwrites the stored tokens
4. If the user can't re-sign-in (e.g., lost access to ChatGPT account), suggest switching auth type to "API Key" in the picker and providing a platform API key as a fallback

### OpenAI Codex OAuth — Sign-In Flow Failures
**Symptoms:** User taps "Sign in with ChatGPT", browser opens, but sign-in never completes. UI shows "Sign-in canceled" or hangs.
**Check:** `grep -i "OpenAIOAuth" node_debug.log | tail -30` (note: this is Logcat, not node_debug.log — Logcat lives in Android logs, not the Node-side log)
**Diagnosis:** The PKCE flow has several failure modes:
- **State mismatch:** A stray request hit `127.0.0.1:1455/auth/callback` with the wrong state (CSRF defense). The legitimate redirect should still work — tell the user to retry.
- **Browser closed before completion:** Custom Tab dismissed before consent. Tokens not exchanged. Retry from Settings.
- **Local callback server failed to start (port 1455 in use):** Rare. App restart resolves it.
- **Network failure during token exchange:** The browser redirect succeeded but `auth.openai.com/oauth/token` was unreachable. Check WiFi, retry.
- **10-minute safety timeout:** If the user took too long, the activity self-cancels.
- **Invalid_state from auth.openai.com:** Browser submitted the consent twice (slow network, double-tap). The first submission is the real one — the user is actually signed in despite the error page. Have them close the tab and check Settings.
**Fix:**
1. The OAuth section in Settings stays visible after a failed sign-in — the user just taps "Sign in with ChatGPT" again. They do NOT need to re-pick the auth type.
2. If the auth picker shows "Sign in first" disabled state, that means authType=oauth is selected but no token. Tap "Sign in with ChatGPT" in the OAuth section directly.
3. For persistent failures: check Logcat (`adb logcat | grep OpenAIOAuth`) for the exact error code. State mismatches and double-submission errors are usually benign.
4. As a last resort, the user can sign out (clears tokens, keeps OAuth as the chosen auth type) and sign back in.

---

## Tools

### Tool Result Truncation (>50K chars)
**Symptoms:** Tool results seem incomplete or cut off. No error message — truncation is silent.
**How it works:** Any tool result exceeding ~50K characters (HARD_MAX_TOOL_RESULT_CHARS in config.js) is silently truncated with a `...(truncated)` suffix. The agent receives the truncated version without explicit notification.
**Check:** If a tool result seems incomplete:
1. Check if the original output would have been large (e.g., `web_fetch` on a huge page, `shell_exec` with lots of output)
2. Re-run with more targeted parameters (e.g., `grep` instead of `cat`, smaller page ranges)
**Fix:** Use more targeted queries. For large files, use `head`/`tail`/`grep` instead of reading the whole file. For web content, extract specific sections.

---

## Web Search

### Search Provider Not Configured (Fallback Mode)
**Symptoms:** web_search returns a structured fallback response (`{ fallback: true, message: "No API key configured for ..." }`) instead of search results. The agent is guided to use web_fetch as an alternative. Log shows `[WebSearch] <provider>: no API key configured — suggesting web_fetch fallback` at WARN level.
**Diagnosis:** The active search provider has no API key set. By default, `searchProvider` is `"brave"` — if the user never added a Brave key, web_search gracefully falls back instead of failing with an error. The agent can still retrieve information via web_fetch from known URLs.
**Fix:** Guide the user to Settings > Search Provider. They need to:
1. Select a provider (Brave, Perplexity, Exa, Tavily, or Firecrawl)
2. Enter the API key for that provider
3. Accept the restart prompt
**Note:** Even without a search provider key, the agent can use web_fetch to retrieve information from specific URLs (Wikipedia, official docs, news APIs). The fallback is functional, not broken — but setting up a search provider gives better results.

### Search Provider API Error
**Symptoms:** web_search returns error with HTTP status code (e.g., "Tavily search error (401)").
**Check:**
```
grep -i "WebSearch.*failed\|search error" node_debug.log | tail -5
```
**Diagnosis:**
- 401/403: API key invalid, expired, or revoked
- 429: Rate limited — wait and retry
- 500+: Provider service issue — transient, retry later
**Fix:** For auth errors, guide the user to verify their key in Settings > Search Provider. For rate limits, reduce search frequency. For server errors, suggest trying again later or switching providers.

### Provider-Specific Notes
- **Brave:** GET-based, key via `X-Subscription-Token` header. Free tier at brave.com/search/api.
- **Perplexity:** POST-based, returns synthesized answer (not result list). Supports direct keys (`pplx-`) and OpenRouter keys (`sk-or-`).
- **Exa:** POST-based, semantic search. Key from dashboard.exa.ai.
- **Tavily:** POST-based, key sent in request body (not header). Key from app.tavily.com.
- **Firecrawl:** POST-based, returns markdown-enriched results. Key from firecrawl.dev.

---

## Memory

### memory_save Fails (Filesystem Full)
**Symptoms:** Memory save silently fails or throws uncaught error. Agent believes it saved but data is lost.
**Check:**
```
grep -i "memory_save\|ENOSPC\|disk.*full\|write.*fail" node_debug.log | tail -10
df -h
```
**Diagnosis:** If `df` shows low disk space (>95% used), the filesystem is full.
**Fix:**
1. Check storage: use `android_storage` tool or `df -h`
2. Clean up: delete old files in `media/inbound/` (downloaded Telegram files accumulate)
3. Check `node_debug.log.old` size — large debug logs consume space
4. Tell user: "Your device storage is nearly full. Clear some space in the SeekerClaw app or your phone's storage settings."

### memory_search Returns Nothing
**Symptoms:** memory_search returns empty results even when the user insists they discussed something before.
**Diagnosis:** Several possible causes:
- **Memory not yet indexed:** On startup, memory files are indexed into SQL.js chunks. If the agent just restarted, indexing may not be complete.
- **Keywords too specific:** The search uses keyword matching with recency weighting. Try broader terms or synonyms.
- **Memory was never saved:** The conversation may not have been saved to a memory file (e.g., agent crashed before auto-save, or user used /reset instead of /new).
- **Database corruption:** If SQL.js failed to initialize (check startup logs for `[DB] Failed to initialize`), search falls back to file-based grep which is less capable.
**Fix:**
1. Try broader search terms or related keywords
2. Check if the memory file exists: `ls memory/` and `read MEMORY.md`
3. If the DB didn't initialize: restart the agent (DB re-initializes on startup)
4. Tell the user: "I searched my memory but couldn't find that. Could you remind me of the key details?"

---

## Cron

### Job Fails to Send Reminder
**Symptoms:** Scheduled reminder doesn't fire. No notification to user or agent.
**Check:**
```
grep -i "cron\|job.*fail\|job.*error" node_debug.log | tail -20
ls cron/
```
**Diagnosis:** Check the job file in `cron/` directory. Each job has a `state.lastError` field if it failed. Common causes:
- Telegram send failed (network issue at fire time)
- Job handler threw an exception
- Zombie detection triggered (job missed 2+ hour window)
**Fix:**
1. Read the specific job file to see `state.lastError`
2. If the job exists but didn't fire: check if cron service is running (`grep "cron" node_debug.log | tail -5`)
3. Re-create the job if it's in a bad state: delete the old job file, create a new one

### Jobs Persist Across Restarts
**How it works:** Cron jobs are persisted as JSON files in the `cron/` directory. On restart, all jobs are reloaded and timers recreated from their saved state. One-shot jobs that already fired are skipped. Recurring jobs resume on their next scheduled time.
**If jobs seem lost after restart:**
1. Check `ls cron/` — the job files should still exist
2. Check `grep "cron.*load\|cron.*restore" node_debug.log | tail -10` for reload logs
3. If files exist but jobs don't fire: the cron service may have failed to start (check startup logs)

---

## Android Bridge

### Service Down (ECONNREFUSED)
**Symptoms:** All `android_*` tools fail with "Android Bridge unavailable" or ECONNREFUSED on localhost:8765.
**Check:**
```
grep -i "bridge\|ECONNREFUSED\|8765" node_debug.log | tail -10
```
**Diagnosis:** The Android main process bridge server is not running. This can happen if:
- The app's main Activity was killed by the OS (but the :node process survived)
- The bridge server crashed or failed to start
- Port 8765 is blocked or in use
**Fix:**
1. Tell the user: "The Android bridge is down — I can't access device features right now. Try opening the SeekerClaw app to restart the bridge."
2. Non-bridge tools (Telegram, Claude API, memory, web, cron) still work normally
3. The bridge auto-recovers when the app's Activity is reopened

### Permission-Specific Errors
**Symptoms:** An `android_*` tool returns a generic error without specifying which permission is missing.
**Common permission mappings:**
- `android_sms` → SEND_SMS permission
- `android_call` → CALL_PHONE permission
- `android_location` → ACCESS_FINE_LOCATION permission
- `android_camera_check` → CAMERA permission
- `android_contacts` → READ_CONTACTS permission
**Check:** Read PLATFORM.md — it lists all granted permissions under the "Permissions" section.
**Fix:** Tell the user which specific permission is needed: "To use [feature], grant [permission] in SeekerClaw Settings > Permissions."

---

## MCP (Model Context Protocol)

### Server Unreachable
**Symptoms:** MCP tools from a specific server are unavailable. Logs show "Failed to connect to [server]".
**Check:**
```
grep -i "mcp\|Failed to connect" node_debug.log | tail -10
```
**Diagnosis:** The MCP server URL is unreachable. Could be: server is down, URL changed, network issue, or auth token expired.
**Fix:**
1. Tell the user: "The MCP server [name] is unreachable. Check if it's online and the URL is correct in Settings > MCP Servers."
2. Other MCP servers and built-in tools are unaffected
3. MCP servers are reconnected on restart — suggest restarting the agent

### Tool Definition Changed (Rug-Pull Detection)
**Symptoms:** An MCP tool that previously worked now silently fails or is blocked. WARN log entry about tool hash mismatch.
**Check:**
```
grep -i "rug.pull\|hash.*mismatch\|tool.*blocked\|sha.256" node_debug.log | tail -10
```
**Diagnosis:** SeekerClaw computes SHA-256 hashes of MCP tool definitions on first connect. If a server changes a tool's definition (parameters, description) without the agent's knowledge, the tool is blocked as a security measure. This prevents a compromised MCP server from changing what a tool does.
**Fix:**
1. Tell the user: "An MCP tool's definition changed since it was first loaded. This is a security measure. To accept the new definition, remove and re-add the MCP server in Settings."
2. This is a security feature, not a bug — explain that it protects against tool definition tampering

### MCP Rate Limit Exceeded
**Symptoms:** MCP tool calls return "Rate limit exceeded for [server]".
**Check:**
```
grep -i "rate limit.*mcp\|rate limit.*exceeded" node_debug.log | tail -10
```
**Diagnosis:** Per-server and global MCP rate limits are enforced to prevent abuse. Default: 10 calls/minute per server (configurable), 50 calls/minute global.
**Fix:**
1. Reduce the frequency of MCP tool calls
2. Space out requests — the rate limit resets each minute
3. If the server itself returns 429, that's the server's own rate limit (separate from SeekerClaw's)

---

## Skills

### Requirements Not Met
**Symptoms:** Skill doesn't trigger even when keywords match. May be silently skipped.
**Check:**
1. Read the skill file: `ls skills/` then `read skills/[name]/SKILL.md`
2. Check YAML frontmatter for `requires:` section
3. Look for `requires.bins` (external binaries) or `requires.env` (env var names)
4. Use `env_list` to see which env vars are currently set; compare to the skill's `requires.env` list
**Diagnosis:** Skills with unmet requirements are silently gated at load time. The node startup log records: `[Skills] Skipping '<name>' — missing: env:VAR_NAME`. Skills requiring unset env vars won't appear in the active skills list even when their trigger keywords match.
**Fix:**
1. **Missing env vars (`requires.env`):** Call `env_list` to confirm which vars are set. For each missing var, tell the user to add it in **Settings → Env Vars** (single add, or use the **Raw editor** button for bulk). Once added, the service must restart to apply the new vars — the skill will then become available.
2. **Missing binaries (`requires.bins`):** Explain the requirement and suggest alternatives (e.g., use `js_eval` instead of a shell binary).
3. **Config keys (`requires.config`):** The skill needs a built-in config value (e.g., Jupiter API key, Helius API key). Guide the user to the relevant Settings page.
4. Use the `shell_exec` tool to run `grep 'Skipping' node_debug.log | tail -10` — shows which skills were gated and why at last startup.

## Activity Heatmap

### Heatmap Shows "No message data yet" or Looks Blank
**Symptoms:** User says "my Activity heatmap is empty" or "I don't see any cells on the System → Activity screen" even though they've used the agent.
**Check:**
1. `read` the file `db_summary_state` in the workspace — look for the `dailyActivity` array
2. If the array is empty or missing: `shell_exec` with `grep -i "getDailyActivity" node_debug.log` — any WARN entries mean the SQL query threw
3. If the array has data but the UI doesn't render it: the heatmap's fallback reads the file directly, so the UI should show it even when the service is stopped. If it doesn't, the app may need a full close + reopen.
**Diagnosis:** `dailyActivity` is populated every ~30 seconds by `getDbSummary()` via `getDailyActivity()` in `database.js`. The query reads `api_request_log` rows (one per API call) grouped by local date, capped at the last 13 months. Common causes of an empty array: the service has never run long enough to log API requests; the SQL.js DB failed to open at startup (check for `[DB] ... error` in logs); timezone edge on very fresh installs.
**Fix:**
1. If the service just started: wait ~30 seconds and reload the System screen
2. If logs show `[DB] getDailyActivity error`: the SQLite index or WASM loader failed — restart the app and check startup logs
3. The heatmap persists between service runs (reads `db_summary_state` from disk), so a stopped service alone shouldn't empty it

### Heatmap Right Column Looks Cut Off or Today Missing
**Symptoms:** User reports the rightmost column is clipped, or today's cell is not visible.
**Diagnosis:** The grid is a fixed 26-week window ending with the current week. Today's cell sits at whatever row corresponds to today's weekday (Mon=row 0, Sun=row 6). Future days in the current week are intentionally blank (Color.Transparent) — not a bug. Clipping on the actual right edge was fixed in PR #304 by switching to weight-based cells (BAT-500). If clipping reappears, it's likely a regression in `MessageActivityHeatmap` in `SystemScreen.kt`.
**Fix:** This is a UI bug path, not a data bug. Ask the user for a screenshot and the device model + app version, then file a bug.

## Reasoning (Extended Thinking)

BAT-549 introduced reasoning content preservation across all 4 providers, plus a user-facing "Extended thinking" toggle and a "Show thinking status" indicator. Reasoning content itself is never rendered in chat — the indicator is a temporary "Thinking..." Telegram bubble that appears during extended-thinking turns and is deleted when the response arrives. The reasoning subsystem has several moving pieces — this section is the playbook for diagnosing each.

### `/think on` Toggled But Model Doesn't Think Differently
**Symptoms:** User toggled `/think on` (or Settings > AI Provider > Reasoning > Extended thinking ON) but responses look the same as before.
**Diagnosis:** The toggle is a no-op for models the registry doesn't list as supporting reasoning (Haiku 4.5; any freeform / unregistered model id). Run `/think` (no args) — it surfaces a user-facing hint when the active model isn't supported, e.g. "This model does not support extended thinking..." or "This model is not in SeekerClaw's known model list...". The agent's system prompt also exposes this state — the agent itself can tell the user.
**Fix:**
- "does not support" hint: switch to a yes-supporting model (Opus 4.7, Sonnet 4.6, GPT-5.4/5.5, Codex models) via `/model` or Settings.
- "not in known model list" hint: this is the safe default for models not in the registry. If the user is on Custom and knows their gateway supports thinking, ask them to confirm — the request param genuinely isn't sent because the registry is the source of truth (a "thinking" status that lies about whether thinking is happening would be worse than no status).

### Custom + DeepSeek V4: 400 Loop on `/resume` After Tool Calls
**Symptoms:** User on Custom provider with a DeepSeek V4 model gets `400` errors after tool calls, often in a loop after `/resume`.
**Diagnosis:** Pre-BAT-549 the Custom adapter stripped V4's `reasoning_content` field from the next request, but V4 REQUIRES it echoed back after a tool call. Commit 1 added model-gating: V4 now echoes, R1 strips, unknown captures-only. The 400-loop should be impossible on the current build for V4 ids matching `deepseek-v4*` (case-insensitive, with or without `deepseek/` OR-prefix).
**Fix:**
- Confirm the model id matches the V4 regex (the agent can grep `reasoning-gating.js` for the exact pattern).
- If the user is on a V4 fork with a non-matching id (e.g., `my-deepseek-v4-fork`): toggle `/think echo on` (Custom-only, force echo on tool-loop) OR enable in Settings > AI Provider > Custom > Advanced (Reasoning) > "Echo reasoning to gateway".
- If still failing: the 400 message likely contains "reasoning_content must be passed back" — the adaptive 3-step quarantine recovery (last-user → earliest-tool-call → full reset) auto-runs and saves a forensic dump under `<workDir>/recovery/` (file pattern: `<chatId>-<timestamp>-step<N>[-task<id>].json`).

### Custom + R1 (DeepSeek-Reasoner): 400 With "Reasoning Content Echoed"
**Symptoms:** User on Custom provider with DeepSeek-R1 / DeepSeek-Reasoner gets `400` with a message about reasoning_content being unexpected.
**Diagnosis:** OPPOSITE of V4 — R1 REJECTS echoed reasoning_content. Commit 1's gating returns `'strip'` for R1 ids; the strip should run pre-delegation.
**Fix:**
- Verify the model id matches the R1 regex (`/(?:^|\/)deepseek-(?:reasoner|r1)(?:-|$)/i`).
- Check the user has NOT enabled the per-Custom echo override (`/think echo on` flips it from chat; Settings > AI Provider > Custom > Advanced (Reasoning) flips it from the UI). The override resets automatically when the user edits any signed Custom config field (model | baseUrl | format | header keys), so if they recently swapped from V4 to R1 the override should already be off — but confirm with `/think` (no args) which surfaces the current value.

### "Show Thinking Status" Toggled But No "Thinking..." Bubble Appears
**Symptoms:** User toggled "Show thinking status" on (Settings > AI Provider > Reasoning, or `/think show`) but the temporary "Thinking..." Telegram bubble never appears during turns.
**Diagnosis:** The bubble requires ALL THREE gates: `reasoningEnabled === true`, `reasoningDisplayInChat === true`, AND `reasoningSupport === 'yes'` for the active model. If any are missing, the bubble is suppressed by design (a "Thinking..." status that lies about whether thinking is happening would be worse than no status). Common gaps:
- `reasoningEnabled` is off → toggle on Settings > Reasoning > Extended thinking, OR `/think on`
- Active model is `Haiku 4.5` → `reasoningSupport=no` → toggle is a true no-op for that model; switch model
- Active model is on Custom (any model) or OpenRouter (any model) → freeform registry → `reasoningSupport=unknown` → bubble stays suppressed because "thinking" can't be reliably promised
- The bubble has a 500ms debounce — if the model responds in under 500ms, the bubble never shows even when all gates align (by design — fast turns shouldn't flash)
**Fix:** Confirm via `/think` (no-args) which surfaces the current toggle states and a "not in known model list" / "does not support" hint when applicable. The contract is "status is shown when extended thinking IS happening AND the user opted in" — anything else is silenced.

### Reasoning Content Doesn't Render in Chat (Why "Show Thinking Status" Doesn't Show Reasoning Text)
**Symptoms:** User toggled "Show thinking status" expecting to see the model's reasoning summary in chat (like Claude.ai's expandable thinking blocks), but only sees a temporary "Thinking..." bubble.
**Diagnosis:** This is by design per the BAT-549 v4 contract. The toggle controls a status indicator only — reasoning content (summaries, encrypted_content, raw thinking text) is NEVER displayed in chat. Reasoning IS preserved in checkpoint state for tool-loop replay (that's what BAT-549's provider-preservation work is for) but it's not surfaced to the user. PM call: reasoning content rendering has streaming/lifecycle/privacy implications that warrant a separate ticket if/when revisited.
**Fix:** Tell the user "Reasoning details are never shown" (matches the Settings helper text). The thinking-status bubble is the visible signal that extended thinking happened.

### `customConfigSignature` Reset The Echo Override After A Spurious Edit
**Symptoms:** User reports that the "Echo reasoning to gateway" toggle reset to OFF after they "barely changed anything" in the Custom config.
**Diagnosis:** The signature hashes the trimmed values of customModel | customBaseUrl | customFormat | sortedLowercaseHeaderKeys. Any visible character change (including trailing slash, scheme case, header key add/remove) resets the override. ApiKey changes do NOT (key rotation is common). Header VALUE changes do NOT (would persist a leakable digest).
**Fix:** Confirm the user's expectation matches the contract — "any visible edit resets the override" is intentional defense-in-depth (gateway-A's echo contract may not match gateway-B's). If they want to reduce reset-frequency, recommend keeping all whitespace consistent in their Settings entries.

### Reasoning Logs Show `len=N fp=XXXXXXXX` Instead of Raw Text
**Symptoms:** User looking at logs (or sending a bug report screenshot) doesn't see any reasoning content — just length + 8-char hex fingerprints.
**Diagnosis:** This is BY DESIGN. `reasoning-redact.js` is the centralized redaction helper for reasoning logs. Mobile logs end up in bug-report screenshots — raw thinking text, signatures, and encrypted_content MUST never leak there. The fingerprint is enough for ops to confirm "the same reasoning block was seen / replayed across turns" without revealing content.
**Fix:** No fix needed — log redaction is intentional. The "Show thinking status" toggle (Settings > AI Provider > Reasoning) gives the user a visible indicator that thinking is happening, but it does NOT reveal reasoning content. Reasoning text is never displayed to the user in this build (v4 contract).

---

## Service Lifecycle

### Shutdown Flush Timed Out or Failed (BAT-525)
**Symptoms:** User taps Stop Agent on the dashboard. Logs show `[Shutdown] Node flush timed out or failed; continuing process kill` instead of the success path `[Shutdown] Node flush acknowledged`. Some `api_request_log` rows or session summaries from the last ~60s before Stop are missing after restart.
**Check:**
```
grep -i "Shutdown.*flush\|/shutdown/flush" node_debug.log | tail -20
adb logcat -d 2>/dev/null | grep -i "NodeControlClient\|Cleartext"
```
**Diagnosis:** The graceful-shutdown handshake (POST /shutdown/flush over 127.0.0.1:8766) failed before the killProcess() fallback. Possible causes:
- **Cleartext blocked (pre-`ee29727` builds):** `IOException: Cleartext HTTP traffic to 127.0.0.1 not permitted` — fixed by `network_security_config.xml` scoped to loopback. If still seen, the manifest is missing `android:networkSecurityConfig`.
- **Bridge token rotated mid-shutdown:** 401 from the endpoint. Rare — would require the token to have been cleared between flush call and process kill.
- **Node-side flush threw or timed out:** Endpoint returned 500 with `{ok: false, summaryFailed?, dbFailed?}`. Look for `[ControlServer] /shutdown/flush partial` (WARN) or `[ControlServer] /shutdown/flush threw` (ERROR) in node_debug.log.
- **Real timeout:** SQL.js write or session-summary HTTP took >1.75s wall time. Check `[Trace]` entries for the relevant turn — payloadSize or tool count abnormal?
**Fix:**
1. If `Cleartext HTTP traffic to 127.0.0.1 not permitted` appears: rebuild from a commit including `app/src/main/res/xml/network_security_config.xml` and reinstall.
2. If `[ControlServer] /shutdown/flush partial` shows `dbFailed`: device storage or filesystem error — check `df -h` and free space.
3. If `summaryFailed`: a session-summary API call exceeded the 1.2s Node-side budget. Usually transient; Stop again later or restart the service so summaries finish in background.
4. If timeouts persist: the next service start auto-resumes via AutoResume; no manual intervention typically needed.

### /model or /provider Switch Didn't Take Effect (BAT-504)
**Symptoms:** User runs `/model <name>` or `/provider <name>` in Telegram, the bot acknowledges, but the next response uses the OLD model/provider. UI may show the new one while the agent runs on the old one.
**Check:**
```
grep -i "/model\|/provider\|runtime_state" node_debug.log | tail -20
read runtime_state.json
```
**Diagnosis:** `/model` and `/provider` write to `runtime_state.json` (live overlay) and require either an in-place update (model) or a service restart (provider). Common failure log lines:
- `[/model] runtime_state.json write threw: <err>` (ERROR) — disk write failed
- `[/model] runtime_state.json write returned false` (WARN) — write returned a soft-fail; UI may show stale model
- `[/provider] runtime_state.json write returned false / write threw` (ERROR) — provider switch couldn't persist; overlay reverted
- `[/provider] runtime_state revert failed` (WARN) — UI may show stale state
- `[Config] runtime_state.json has invalid content` / `decode failed` (WARN) — fallback to config.json on next read
**Fix:**
1. If write failed: check device storage (`android_storage` tool or `df -h`); a full filesystem prevents `runtime_state.json` writes.
2. If `/provider` is stuck mid-switch: the overlay auto-reverts on write failure. Re-issue `/provider <name>` once storage is healthy.
3. For provider switches, the service restarts to pick up new credentials — give it 5-10s before sending the next message.
4. If UI keeps showing stale state after a successful write: kill and reopen the SeekerClaw app (the dashboard reads `runtime_state.json` independently).

### MCP Reconcile Silently Failed (BAT-514)
**Symptoms:** User edits an MCP server in Settings (toggle enable, edit token, add/remove). UI updates but the agent still has the OLD active tool set — or no MCP tools at all when there should be some.
**Check:**
```
grep -i "MCP.*reconcile\|MCP.*Failed to" node_debug.log | tail -20
```
**Diagnosis:** Settings → MCP servers writes `mcp_servers.json` and POSTs `/mcp/reconcile` to the loopback control server. If the POST fails, the file write still landed but the running :node process didn't pick up the change until next service restart. Common failure log lines:
- `[MCP] reconcile drain error` (ERROR) — request body couldn't drain
- `[MCP] configsProvider threw during reconcile` (ERROR) — `mcp_servers.json` couldn't be re-read
- `[MCP] Failed to (re)connect <name>` (ERROR) — the new/edited server URL is unreachable or auth-rejected
- `[MCP] Skipping server with missing id` / `Duplicate server id` (WARN) — config validation rejected an entry
**Fix:**
1. The cleartext loopback fix (`ee29727`) repaired this path — pre-fix, `[NodeControlClient] reconcile failed: Cleartext HTTP not permitted` was silent and fell through to "next service start picks up the change."
2. If reconcile is still failing post-`ee29727`: stop and restart the agent — the next service start reads `mcp_servers.json` fresh and connects all enabled servers via the normal startup path.
3. If a specific server keeps failing in `[MCP] Failed to (re)connect`: verify the URL and auth in Settings → MCP Servers. Test reachability with `curl -I <server-url>` if it has a public health endpoint.

---

## Burner Wallet (BAT-582)

### `burner: invalid key format`
**Symptoms:** Burner setup screen rejects the pasted key with "invalid key format."
**Diagnosis:** `KeyImporter` could not parse the input as base58 OR a JSON byte array of length 32 or 64 bytes. Common causes: trailing whitespace, extra characters, wrong format (e.g., a hex string), wrong length (the wallet exported a 33-byte compressed key instead of a 32-byte seed).
**Fix:**
1. Re-export the key from the source wallet (Phantom: Settings → Security → Reveal Secret Recovery Phrase → derive specific account).
2. Strip whitespace; ensure the value is base58 OR a `[1, 2, …, 64]` JSON array.
3. If the source provides only a seed phrase (12/24 words), use a wallet's "export private key" feature — SeekerClaw does not derive from mnemonics in V1.

### `burner: invalid keypair (pubkey/seed mismatch)`
**Symptoms:** Burner setup rejects a 64-byte expanded key with "pubkey mismatch."
**Diagnosis:** The trailing 32 bytes of the expanded key don't match the public key derived from the leading 32-byte seed. The key is corrupted or was assembled incorrectly.
**Fix:** Re-export from the source wallet. If the issue persists, switch to importing only the 32-byte seed (SeekerClaw will derive the public half itself).

### `burner: storage_failure (Failed to persist key)`
**Symptoms:** Burner setup parses + validates the key, but the Save step returns `storage_failure`. Bridge endpoints / Settings UI report "Failed to persist key" or `error: "storage_failure"`.
**Diagnosis:** `KeyImporter` accepted the bytes (format + pubkey check passed), but writing to encrypted storage failed AFTER validation. This is NOT an invalid-key error — the key itself is fine. Likely causes:
- Device storage is full or near full (atomic move + ciphertext write fails on ENOSPC).
- Android Keystore initialization failure (rare on Solana Seeker, more common on heavily customized OEM ROMs).
- Filesystem permissions / SELinux denial under `filesDir/burner_keys/` (also rare).
**Fix:**
1. Tell the user: "The burner key looked valid but couldn't be saved to encrypted storage." Do NOT tell them to re-paste — the key wasn't the problem.
2. Check device storage: `android_storage` tool or Settings → Storage. Free space if under ~100 MB.
3. Restart the app — Keystore alias may re-initialize cleanly on next start.
4. If persistent across restarts: collect logcat (`adb logcat | grep KeystoreHelper\|EncryptedPrefsKeyVault`) and file a bug.

### `burner: cap exceeded (per-tx)`
**Symptoms:** Tool result includes `error: "burner_cap_exceeded"` or `over_per_tx_cap`. Agent tells the user "this is over your burner per-tx cap."
**Diagnosis:** The principal (lamports for SOL, microunits for USDC) of the tx exceeds the configured `capPerTxSol` / `capPerTxUsdc`.
**Fix:**
1. Use `wallet_set_caps` to raise the per-tx cap (confirmation popup shows old → new diff).
2. Or pass `_allowMainFallback: true` in the tool args to retry through the main MWA wallet (popup required).
3. Or split the spend into smaller chunks if appropriate.

### `burner: cap exceeded (daily, X remaining, resets at HH:MM UTC)`
**Symptoms:** Tool result includes `over_daily_cap`. Agent should report remaining daily allowance.
**Diagnosis:** `spentTodaySol + atomicAmount > capDailySol` (or USDC equivalent). The 24-hour window resets at 00:00 UTC.
**Fix:**
1. Wait for the daily reset (00:00 UTC).
2. Raise the daily cap via `wallet_set_caps`.
3. Use the main wallet (popup) for the over-cap portion.

### `burner: no burner configured`
**Symptoms:** `wallet_status` returns `burner: null`. Tools route to main MWA path with confirmation popup. Bridge calls return `burner_not_configured`.
**Diagnosis:** No private key has been imported yet; the burner is in the "single-wallet" baseline mode.
**Fix:** Open SeekerClaw → Settings → Burner Wallet → import a key. Until then, every tool routes through MWA exactly like v1.0.

### `burner: tx unsupported`
**Symptoms:** `/burner/sign-transaction` returns one of:
- `unsupported_tx_format` — the bytes aren't a recognizable Solana legacy or v0 tx
- `burner_not_required_signer` — the burner pubkey is not in the required-signers list
- `additional_signers_required` — there are other required signers who haven't signed yet (V1 only supports single-signer or pre-signed-by-others)
- `bogus_shortvec` — compact-u16 length encoding is malformed
**Diagnosis:** The Jupiter Ultra / Trigger / Recurring API returned an unexpected tx shape, OR the tool built a tx with the wrong signer. Most common in development when adding a new flow.
**Fix:**
1. Check `node_debug.log` for `[Jupiter ...] Tx verified` lines preceding the failure.
2. Verify the tool is passing the correct signer pubkey to the Jupiter API (`maker` / `payer` / `user` field).
3. Re-fetch the order — Jupiter Ultra payloads have ~2 min TTL; an expired payload re-served from cache could mismatch.

### `burner: reservation expired (tx took longer than 60s)`
**Symptoms:** `/burner/sign-transaction` returns `reservation_expired`. The reservation TTL elapsed before signing happened.
**Diagnosis:** Default reservation TTL is 60s. Signing should be near-instant; if it took longer, something blocked the sign path (heavy GC, bridge stall).
**Fix:**
1. Retry the operation — the agent's tool-use loop will request a fresh reservation.
2. If recurrent, check device load — is another foreground app starving the :node process?
3. Android's periodic sweep auto-releases stale reservations every 30s, so daily spend isn't burned.

### `burner: reservation not found`
**Symptoms:** `/burner/sign-transaction` or `/burner/commit` returns `reservation_not_found`. Caller passed a reservationId that the cap state machine has never seen (or that aged out of the in-memory disposed-id ring).
**Diagnosis:** Most common cause is a code bug: a caller forged a reservationId or held one across a process restart (the disposed-id ring is process-local). Could also happen if a very old id was retried after the ring evicted it (bound: 1024 most recent ids).
**Fix:**
1. Always go through `/burner/reserve` to mint an id, then immediately use it for sign + commit/release. Never reuse ids across operations.
2. If the bug is in a tool: trace the lifecycle of the reservationId through your code path. Per contract, the issuer of `/burner/reserve` is the same caller that does `/burner/sign-transaction` + commit/release.
3. BAT-582 R2 added this validation. Pre-R2, sign-transaction would silently sign without verifying the id — that was a security gap, not a feature.

### `burner: reservation not pending`
**Symptoms:** `/burner/sign-transaction` returns `reservation_not_pending`. The reservationId was previously committed or released; re-using a finalized id is a state-machine violation.
**Diagnosis:** Caller is double-spending a reservation OR retrying after a transient error without re-reserving. The cap state machine refuses because either:
- the id was already committed (the reservation already counted toward daily spend), or
- the id was already released (the caller already abandoned it).
**Fix:**
1. Don't retry sign-transaction with the same id after a successful commit. Reserve a new one.
2. If you need to retry after a transient error: `/burner/release` the old id (idempotent), then `/burner/reserve` for a fresh attempt.
3. `/burner/commit` is idempotent in the OTHER direction: a second commit with the same id returns ok=true (no-op). Sign-transaction is intentionally stricter.

### `burner: bridge unreachable (Node ↔ Android)`
**Symptoms:** Tool result `error: "bridge_unreachable"` or `Android Bridge unavailable`. /burner/* calls fail at the HTTP transport.
**Diagnosis:** AndroidBridge HTTP server (localhost:8765) isn't responding. Either the foreground service isn't running, the bridge port is blocked, or the auth token is wrong.
**Fix:**
1. Check `grep -i "Android Bridge" node_debug.log | tail -20`.
2. Open the Dashboard in SeekerClaw — is the agent showing GREEN? If RED/yellow, restart the agent from Settings → Service Control.
3. If persistent: stop and start the SeekerClawService. The bridge initializes on service start.

### Jupiter ownership map missed a write
**Symptoms:** Cancel-tool returns `creatorRole: "unknown"` for an order created via SeekerClaw on this device.
**Diagnosis:** `/jupiter/order-owner/set` failed AFTER the create succeeded. Per contract, the create is not unwound — the order is real on-chain — but the cancel falls back to the "unknown → main + confirm + diagnostic" path.
**Fix:**
1. Confirm the user wants to cancel via main wallet (MWA popup).
2. If the order was actually created from the burner: the cancel still works through main if the main wallet is the same authority (it isn't, in V1 — burner ≠ main pubkey). For now, this means the cancel will fail to authorize at Jupiter; the user must wait for the order to expire OR contact Jupiter support.
3. Long-term fix: enable the Jupiter ownership write retry queue (Phase 6+ scope).

---

## agent_pay (BAT-582 — x402 client)

### `agent_pay: rejected (non-HTTPS / private IP / non-Solana / non-USDC / demand > max_usdc)`
**Symptoms:** Tool result `error: "non_https" | "private_ip" | "non_solana_network" | "non_usdc_asset" | "demand_exceeds_max_usdc" | "method_not_get"`.
**Diagnosis:** Pre-flight or 402-body validation refused the call before any payment was attempted. Each error is a hard V1 boundary:
- `non_https` — URL must be `https://` (debug builds also accept `http://localhost`)
- `private_ip` — DNS resolved to a private/loopback IP (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, ::1, fc00::/7, fe80::/10) — SSRF defense
- `non_solana_network` — pay.sh requirement `network` field was not `solana`
- `non_usdc_asset` — pay.sh requirement `asset` was not USDC (mint `EPjFWdd5...`)
- `demand_exceeds_max_usdc` — server demanded more than the agent's `max_usdc` cap
- `method_not_get` — V1 only supports GET (no POST/PUT)

**Fix:**
1. For `demand_exceeds_max_usdc`: re-invoke with a higher `max_usdc` if the user agrees, OR accept the rejection (this is the cap working as designed).
2. For `non_https` / `private_ip`: this is a security boundary — do not bypass. If the user genuinely wants to call a localhost service from a debug build, ensure NODE_ENV=development is set.
3. For `non_solana_network` / `non_usdc_asset`: the endpoint isn't compatible with V1. Tell the user "this endpoint requires <network>/<asset>, which agent_pay doesn't support yet (V1 = Solana mainnet USDC only)."

### `agent_pay: response too large` / `agent_pay: timeout`
**Symptoms:** Tool result `error: "response_too_large"` or `error: "timeout"`.
**Diagnosis:** V1 caps response body at 1 MB and total request time at 30 s. Either the endpoint streams more than 1 MB or it's slow.
**Fix:**
1. For large responses: the endpoint isn't a fit for agent_pay V1. Suggest the user fetch directly via web browser, or escalate to a follow-up ticket if the use case is common.
2. For timeouts: retry once. If persistent, the endpoint is degraded — wait, OR check connectivity (`grep -i ENOTFOUND node_debug.log | tail -5`).

### `agent_pay: burner not configured`
**Symptoms:** Tool result `error: "burner_not_configured"`. NO HTTP request to the URL was made.
**Diagnosis:** agent_pay refuses to fetch when there's no burner wallet; it would have nothing to pay with. /burner/status returned `configured: false`.
**Fix:** Open SeekerClaw → Settings → Burner Wallet → import a key. Fund the burner with USDC (mainnet). Re-invoke agent_pay.

### `agent_pay: no x402 protocol detected for this response`
**Symptoms:** Tool result `error: "no_protocol_match"` after a 402 response.
**Diagnosis:** The endpoint returned 402 but the JSON body didn't match any registered payment-protocol shape (V1 supports pay.sh-style x402 only). Possibilities: a non-x402 paywall (Stripe, custom), an unknown x402 dialect, or a malformed body.
**Fix:**
1. Check the response body shape — does it have `accepts: [...]` or `paymentRequirements: [...]` with `scheme: "exact"` and `network: "solana"`?
2. If it's a different x402 dialect (e.g., Coinbase's variant), V1 doesn't support it — track as a follow-up to commit a fixture for that variant.
3. If it's a non-x402 paywall, agent_pay can't handle it. Tell the user "this endpoint uses a paywall format I don't support."

### `agent_pay: cap exceeded` (per-tx or daily USDC)
**Symptoms:** Tool result `error: "burner_cap_exceeded"` mentioning USDC. The 402 demand was within `max_usdc` but exceeded the burner's per-tx or daily USDC cap.
**Diagnosis:** Two different ceilings: `max_usdc` is the agent-side cap (per-call), `burner.pertx.usdc` and `burner.daily.usdc` are user-controlled caps (per-burner). Both must allow the demand.
**Fix:**
1. Run `wallet_status` to show the current caps + remaining daily.
2. Suggest `wallet_set_caps({per_tx_usdc: "..."})` (always with user confirmation) OR wait for daily reset at 00:00 UTC.

