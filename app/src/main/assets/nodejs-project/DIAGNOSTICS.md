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
3. Look for `requires.bins` (external binaries) or `requires.env` (API keys)
**Diagnosis:** Skills with unmet requirements are reported during skill loading. The agent is told which skills are skipped and why.
**Fix:**
1. For missing API keys: guide the user to configure them in Settings
2. For missing binaries: explain the requirement and suggest alternatives
3. Use `skill_diagnostics` (if available) to see all skill loading status
