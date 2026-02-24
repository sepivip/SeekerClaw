# DIAGNOSTICS.md — SeekerClaw Agent Troubleshooting Guide

> **Purpose:** Deep troubleshooting for failure modes not covered by the quick playbook in your system prompt.
> Read this file on demand when you need detailed diagnosis steps.

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

---

## Claude API

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
2. If a specific tool result was too large, note that tool results are auto-truncated at ~120KB but the conversation can still accumulate
3. MAX_HISTORY (35 messages) should prevent this in normal use — if it happens, it's likely a single very large message or tool result

---

## Tools

### Tool Result Truncation (>120KB)
**Symptoms:** Tool results seem incomplete or cut off. No error message — truncation is silent.
**How it works:** Any tool result exceeding ~120KB (configurable via `maxToolResultSize` in config.js) is silently truncated with a `...(truncated)` suffix. The agent receives the truncated version without explicit notification.
**Check:** If a tool result seems incomplete:
1. Check if the original output would have been large (e.g., `web_fetch` on a huge page, `shell_exec` with lots of output)
2. Re-run with more targeted parameters (e.g., `grep` instead of `cat`, smaller page ranges)
**Fix:** Use more targeted queries. For large files, use `head`/`tail`/`grep` instead of reading the whole file. For web content, extract specific sections.

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
**Diagnosis:** Per-server and global MCP rate limits are enforced to prevent abuse. Default: 30 calls/minute per server, 100 calls/minute global.
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
