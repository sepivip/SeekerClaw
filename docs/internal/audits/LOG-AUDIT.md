# Log Audit — SeekerClaw Node.js Agent

**Date:** 2026-02-19
**Scope:** All 14 JS modules + Android log pipeline (LogCollector, OpenClawService, LogsScreen)

---

## 1. How Logging Works Today

### Node.js side

```js
// config.js:70-75
function log(msg) {
    const safe = _redactFn ? _redactFn(msg) : msg;
    const line = `[${localTimestamp()}] ${safe}\n`;       // → node_debug.log
    try { fs.appendFileSync(debugLog, line); } catch (_) {}
    console.log('[SeekerClaw] ' + safe);                  // → stdout (unused)
}
```

- **One level** — everything is flat `log()`. No DEBUG/INFO/WARN/ERROR distinction.
- **Dual output** — writes to `node_debug.log` (with ISO timestamp) AND stdout (with `[SeekerClaw]` prefix).
- `stdout` goes nowhere useful — Android reads the file, not stdout.

### Android side

```
node_debug.log
    ↓ polled every 500ms (OpenClawService.kt:164-188)
    ↓ level = contains("ERROR"|"UNCAUGHT") → ERROR
    ↓         contains("WARN") → WARN
    ↓         else → INFO
    ↓ prepends "[Node] " prefix
LogCollector.append("[Node] $line", level)
    ↓ adds System.currentTimeMillis() timestamp
    ↓ polled every 1000ms (LogCollector.kt:73)
LogsScreen.kt
    ↓ renders as "[HH:mm:ss] [Node] [2026-02-19T10:30:00+03:00] message"
    ↓ color: blue=INFO, yellow=WARN, red=ERROR
    ↓ filter: toggle buttons per level + text search
```

### The Double Timestamp Bug

Every log line displays **two timestamps**:

```
[10:30:00] [Node] [2026-02-19T10:30:00+03:00] Starting SeekerClaw AI Agent...
 ↑ Android UI          ↑ Already in node_debug.log from localTimestamp()
```

The Android UI prepends `[HH:mm:ss]` (from `LogEntry.timestamp`), but the raw line from
`node_debug.log` already contains `[2026-02-19T10:30:00+03:00]`. Result: double timestamp.

### Level Classification Is Fragile

Android uses **case-sensitive substring matching**:
- `"ERROR"` in message → ERROR (red)
- `"WARN"` in message → WARN (yellow)
- Everything else → INFO (blue)

This means:
- `log('Error: something')` → classified as INFO (lowercase "Error", not "ERROR")
- `log('[DB] WARNING: ...')` → classified as WARN (contains "WARN")
- `log('[Jupiter] Rate limited (429)...')` → classified as INFO (no keyword)
- Many actual errors show as blue INFO because they use lowercase "Error"

---

## 2. Full Log Catalog

**209 `log()` calls** across 14 modules. Classified by actual importance, not current behavior.

### Legend

- **Freq**: `1` = once at startup, `R` = recurring/periodic, `P` = per-request/per-event, `E` = on error only
- **Android Level**: What the Android UI currently shows (based on substring matching)
- **Proposed Level**: What it should be

### config.js (8 calls)

| Line | Android | Proposed | Freq | Message Pattern |
|------|---------|----------|------|-----------------|
| 74 | INFO | — | R | `[SeekerClaw] ...` (stdout, unused — remove) |
| 77 | INFO | INFO | 1 | `Starting SeekerClaw AI Agent...` |
| 78 | INFO | INFO | 1 | `Node.js ${version} on ${platform} ${arch}` |
| 79 | INFO | INFO | 1 | `Workspace: ${workDir}` |
| 87 | **ERROR** | ERROR | 1 | `ERROR: config.json not found` |
| 119 | **WARN** | WARN | 1 | `WARNING: Invalid reactionNotifications...` |
| 121 | **WARN** | WARN | 1 | `WARNING: Invalid reactionGuidance...` |
| 144 | **ERROR** | ERROR | 1 | `ERROR: Missing required config...` |
| 149 | INFO | INFO | 1 | `Owner ID not set — will auto-detect...` |
| 152 | INFO | INFO | 1 | `Agent: ${name} | Model: ${model} | Auth: ...` |

### main.js (30 calls)

| Line | Android | Proposed | Freq | Message Pattern |
|------|---------|----------|------|-----------------|
| 23 | **ERROR** | ERROR | E | `UNCAUGHT: ${stack}` |
| 24 | INFO | ERROR | E | `UNHANDLED: ${reason}` (**BUG**: no ERROR/UNCAUGHT keyword) |
| 320 | INFO | INFO | 1 | `Owner claimed by ${id} (auto-detect)` |
| 330 | INFO | WARN | P | `Ignoring message from ${id} (not owner)` |
| 334 | INFO | DEBUG | P | `Message: ${text.slice(0,100)}...` |
| 360 | INFO | DEBUG | P | `Media file_size unknown (0)...` |
| 380 | INFO | WARN | E | `Media download failed (transient)...` |
| 418 | INFO | DEBUG | P | `Media processed: ${type} → ${path}` |
| 421 | INFO | ERROR | E | `Media download failed: ${e.message}` |
| 433 | INFO | DEBUG | P | `Agent returned SILENT_REPLY...` |
| 439 | INFO | DEBUG | R | `Agent returned HEARTBEAT_OK` |
| 456 | INFO | ERROR | E | `Error: ${error.message}` (**BUG**: lowercase "Error") |
| 497 | INFO | DEBUG | P | `Reaction: ${eventText}` |
| 504 | INFO | ERROR | E | `Reaction queue error: ${e.message}` |
| 530 | INFO | ERROR | E | `Message handler error: ${e.message}` |
| 552 | INFO | WARN | E | `Telegram rate limited — waiting ${s}s` |
| 571 | INFO | INFO | P | `[Confirm] User replied... → APPROVED/REJECTED` |
| 582 | INFO | WARN | E | `[Callback] answerCallbackQuery failed...` |
| 587 | INFO | WARN | P | `[Callback] Ignoring callback from ${id}...` |
| 592 | INFO | DEBUG | P | `[Callback] Button tapped: "${data}"...` |
| 610 | **ERROR** | ERROR | E | `Poll error (${n}): ${message}` |
| 633 | INFO | DEBUG | 1 | `Starting Claude usage polling (60s interval)` |
| 664 | INFO | DEBUG | R | `Claude usage poll: HTTP ${status}` |
| 672 | INFO | ERROR | E | `Claude usage poll error: ${e.message}` |
| 684 | INFO | INFO | 1 | `Connecting to Telegram...` |
| 688 | INFO | INFO | 1 | `Bot connected: @${username}` |
| 721 | INFO | DEBUG | 1 | `Flushed ${n} old update(s)...` |
| 724 | **WARN** | WARN | E | `Warning: Could not flush old updates...` |
| 734 | INFO | INFO | 1 | `[MCP] ${n} server(s) connected...` |
| 735 | INFO | WARN | 1 | `[MCP] ${n} server(s) failed to connect` |
| 737 | INFO | ERROR | E | `[MCP] Initialization error: ${e.message}` |
| 749 | INFO | DEBUG | P | `[SessionSummary] ${e.message}` |
| 755 | **ERROR** | ERROR | E | `ERROR: ${JSON.stringify(result)}` |
| 760 | **ERROR** | ERROR | E | `ERROR: ${err.message}` |
| 766 | INFO | DEBUG | R | `Heartbeat - uptime: ${s}s, memory: ${mb}MB` |

### claude.js (24 calls)

| Line | Android | Proposed | Freq | Message Pattern |
|------|---------|----------|------|-----------------|
| 46 | INFO | WARN | E | `[claude] setChatDeps: unknown key "${key}"` |
| 107 | INFO | WARN | E | `Failed to write claude usage state: ...` |
| 141 | INFO | ERROR | E | `[Health] Failed to write agent health file: ...` |
| 251 | **ERROR** | ERROR | E | `[SessionSummary] API error: ${status}` |
| 297 | INFO | DEBUG | P | `[SessionSummary] Saved: ${filename}...` |
| 306 | **ERROR** | ERROR | E | `[SessionSummary] Error: ${err.message}` |
| 725 | INFO | DEBUG | P | `[Cache] hit: ${tokens} tokens read from cache` |
| 728 | INFO | DEBUG | P | `[Cache] miss: ${tokens} tokens written to cache` |
| 794 | INFO | WARN | E | `[RateLimit] Only ${n} tokens remaining, waiting ${ms}ms` |
| 845 | INFO | WARN | E | `[Claude] Failed to log network error to DB: ...` |
| 861 | INFO | WARN | E | `[Retry] Claude API ${status}... retry ${n}/${max}` |
| 888 | INFO | WARN | E | `[DB] Log error: ${err.message}` |
| 948 | INFO | DEBUG | P | `Matched skills: ${names}` |
| 980 | **ERROR** | ERROR | E | `Claude API error: ${status}...` |
| 1004 | INFO | DEBUG | P | `Tool use: ${name}` |
| 1015 | INFO | WARN | E | `[RateLimit] ${name} blocked — ${s}s remaining` |
| 1029 | INFO | INFO | P | `[Confirm] ${name} rejected by user` |
| 1059 | INFO | DEBUG | P | `No text in final tool response, requesting summary...` |
| 1081 | INFO | DEBUG | P | `Summary returned SILENT_REPLY token...` |
| 1089 | INFO | DEBUG | P | `Summary call also produced no text...` |
| 1109 | INFO | DEBUG | P | `No text content in response... returning SILENT_REPLY` |
| 1124 | INFO | DEBUG | P | `[SessionSummary] ${e.message}` |

### tools.js (63 calls)

| Line | Android | Proposed | Freq | Message Pattern |
|------|---------|----------|------|-----------------|
| 102 | INFO | INFO | P | `[Confirm] Timeout for ${name}...` |
| 115 | INFO | DEBUG | P | `[Confirm] Awaiting confirmation for ${name}...` |
| 123 | INFO | WARN | E | `[Confirm] Telegram rejected confirmation message...` |
| 131 | INFO | ERROR | E | `[Confirm] Failed to send confirmation message...` |
| 789 | INFO | DEBUG | P | `Executing tool: ${name}` |
| 810 | INFO | DEBUG | P | `[WebSearch] Cache hit` |
| 830 | INFO | WARN | E | `[WebSearch] ${provider} failed, trying fallback` |
| 844 | INFO | DEBUG | P | `[WebSearch] Falling back to ${fb}` |
| 862 | INFO | ERROR | E | `[WebSearch] ${fb} fallback also failed...` |
| 896 | INFO | DEBUG | P | `[WebFetch] Cache hit` |
| 1013 | INFO | WARN | E | `[Security] BLOCKED read of sensitive file: ...` |
| 1023 | INFO | WARN | E | `[Security] BLOCKED read via symlink...` |
| 1052 | INFO | WARN | E | `[Security] BLOCKED skill write...` |
| 1055 | INFO | DEBUG | P | `[Security] Skill write to ${path} — allowed` |
| 1104 | INFO | WARN | E | `[Security] BLOCKED skill edit...` |
| 1633 | INFO | DEBUG | E | `[Tools] Failed to parse token account: ...` |
| 1873 | INFO | DEBUG | E | `[Jupiter Ultra] Pre-swap price check skipped: ...` |
| 1886 | INFO | INFO | P | `[Jupiter Ultra] Getting order: ...` |
| 1894 | INFO | DEBUG | P | `[Jupiter Ultra] Order tx verified — programs OK` |
| 1909 | INFO | INFO | P | `[Jupiter Ultra] Sending to wallet for approval...` |
| 1923 | **WARN** | WARN | E | `[Jupiter Ultra] MWA approval took ${s}s...` |
| 1929 | INFO | INFO | P | `[Jupiter Ultra] Re-signing with fresh order...` |
| 1939 | INFO | DEBUG | P | `[Jupiter Ultra] Re-quote successful...` |
| 1941 | INFO | WARN | E | `[Jupiter Ultra] Re-quote failed...` |
| 1947 | INFO | INFO | P | `[Jupiter Ultra] Executing signed transaction...` |
| 2052 | INFO | DEBUG | E | `[Jupiter Trigger] Token-2022 check skipped: ...` |
| 2120 | INFO | INFO | P | `[Jupiter Trigger] Creating order: ...` |
| 2158 | INFO | ERROR | E | `[Jupiter Trigger] Tx verification FAILED: ...` |
| 2161 | INFO | DEBUG | P | `[Jupiter Trigger] Tx verified — programs OK` |
| 2163 | INFO | WARN | E | `[Jupiter Trigger] Tx verification error: ...` |
| 2169 | INFO | INFO | P | `[Jupiter Trigger] Sending to wallet for approval...` |
| 2177 | INFO | INFO | P | `[Jupiter Trigger] Executing signed transaction...` |
| 2310 | INFO | INFO | P | `[Jupiter Trigger] Cancelling order: ${id}` |
| 2343 | INFO | INFO | P | `[Jupiter Trigger] Sending cancel tx to wallet...` |
| 2351 | INFO | INFO | P | `[Jupiter Trigger] Executing cancel transaction...` |
| 2434 | INFO | DEBUG | E | `[Jupiter DCA] Token-2022 check skipped: ...` |
| 2499 | INFO | DEBUG | E | `[Jupiter DCA] Price check skipped (non-fatal): ...` |
| 2509 | INFO | INFO | P | `[Jupiter DCA] Creating: ${amount}...` |
| 2546 | INFO | ERROR | E | `[Jupiter DCA] Tx verification FAILED: ...` |
| 2549 | INFO | DEBUG | P | `[Jupiter DCA] Tx verified — programs OK` |
| 2551 | INFO | WARN | E | `[Jupiter DCA] Tx verification error: ...` |
| 2557 | INFO | INFO | P | `[Jupiter DCA] Sending to wallet for approval...` |
| 2565 | INFO | INFO | P | `[Jupiter DCA] Executing signed transaction...` |
| 2710 | INFO | INFO | P | `[Jupiter DCA] Cancelling order: ${id}` |
| 2743 | INFO | INFO | P | `[Jupiter DCA] Sending cancel tx to wallet...` |
| 2751 | INFO | INFO | P | `[Jupiter DCA] Executing cancel transaction...` |
| 2914 | INFO | DEBUG | E | `[Jupiter Security] Tokens v2 lookup skipped: ...` |
| 3022 | INFO | DEBUG | P | `Reaction ${action} on msg ${id}...` |
| 3048 | INFO | DEBUG | P | `Deleted message ${id} in chat ${chatId}` |
| 3112 | INFO | DEBUG | P | `telegram_send: sent message ${id}` |
| 3213 | INFO | WARN | E | `shell_exec TIMEOUT: ${cmd}` |
| 3222 | INFO | WARN | E | `shell_exec FAIL (exit ${code}): ${cmd}` |
| 3232 | INFO | DEBUG | P | `shell_exec OK: ${cmd}` |
| 3352 | INFO | DEBUG | P | `js_eval OK (${n} chars)` |
| 3361 | INFO | WARN | E | `js_eval FAIL: ${err.message}` |
| 3408 | INFO | DEBUG | P | `[TgSendFile] Photo... downgrading to document` |
| 3417 | INFO | DEBUG | P | `[TgSendFile] ${method}: ${name} (${size}) → chat` |
| 3421 | INFO | DEBUG | P | `[TgSendFile] Sent successfully` |
| 3425 | INFO | WARN | E | `[TgSendFile] Failed: ${desc}` |
| 3429 | INFO | ERROR | E | `[TgSendFile] Error: ${message}` |
| 3465 | INFO | DEBUG | P | `File deleted: ${path}` |
| 3468 | INFO | ERROR | E | `Error deleting file: ${err}` |

### cron.js (18 calls)

| Line | Android | Proposed | Freq | Message Pattern |
|------|---------|----------|------|-----------------|
| 19 | **WARN** | WARN | E | `[Cron] WARNING: setSendMessage called with ${type}...` |
| 60 | **WARN** | WARN | E | `[Cron] WARNING: jobs.json has invalid shape...` |
| 80 | INFO | ERROR | E | `Error loading cron store: ${e.message}` |
| 99 | INFO | WARN | E | `[Cron] Backup before save failed: ...` |
| 103 | INFO | ERROR | E | `Error saving cron store: ${e.message}` |
| 128 | INFO | WARN | E | `[Cron] Run log prune failed: ...` |
| 130 | INFO | ERROR | E | `Error writing run log: ${e.message}` |
| 282 | INFO | INFO | 1 | `[Cron] Service started with ${n} jobs` |
| 330 | INFO | INFO | P | `[Cron] Created job ${id}: "${name}"...` |
| 366 | INFO | INFO | P | `[Cron] Removed job ${id}: "${name}"` |
| 408 | INFO | DEBUG | 1 | `[Cron] Clearing interrupted job marker: ${id}` |
| 431 | INFO | DEBUG | 1 | `[Cron] Skipping missed one-shot job: ${id}...` |
| 476 | INFO | ERROR | E | `[Cron] Timer error: ${e.message}` |
| 498 | INFO | DEBUG | P | `[Cron] Executing job ${id}: "${name}"` |
| 516 | **WARN** | ERROR | E | `[Cron] WARNING: sendMessage not injected...` |
| 519 | INFO | DEBUG | P | `[Cron] Delivered reminder: ${id}` |
| 524 | INFO | ERROR | E | `[Cron] Job error ${id}: ${e.message}` |
| 571 | INFO | WARN | E | `[Cron] Job ${id} error #${n}, backing off...` |

### database.js (14 calls)

| Line | Android | Proposed | Freq | Message Pattern |
|------|---------|----------|------|-----------------|
| 43 | **WARN** | WARN | E | `[DB] WARNING: setShutdownDeps called with invalid...` |
| 68 | INFO | INFO | 1 | `[DB] Loaded existing database` |
| 70 | INFO | WARN | E | `[DB] Corrupted database, backing up and recreating...` |
| 74 | INFO | INFO | E | `[DB] Created fresh database after corruption recovery` |
| 78 | INFO | INFO | 1 | `[DB] Created new database` |
| 125 | INFO | INFO | 1 | `[DB] SQL.js database initialized` |
| 131 | INFO | ERROR | E | `[DB] Failed to initialize SQL.js (non-fatal): ...` |
| 146 | **ERROR** | ERROR | E | `[DB] Save error: ${err.message}` |
| 226 | INFO | DEBUG | R | `[Memory] Indexed ${n} files, skipped ${n} unchanged` |
| 228 | INFO | WARN | E | `[Memory] Indexing error (non-fatal): ...` |
| 291 | INFO | INFO | E | `[Shutdown] ${signal} received, saving session summary...` |
| 308 | INFO | ERROR | E | `[Shutdown] Summary failed: ${err.message}` |
| 402 | INFO | WARN | E | `[DB] Summary file write failed: ...` |
| 430 | **ERROR** | ERROR | E | `[Stats] Internal stats server error...` |
| 434 | INFO | INFO | 1 | `[Stats] Internal stats server listening on port ${p}` |

### solana.js (11 calls)

| Line | Android | Proposed | Freq | Message Pattern |
|------|---------|----------|------|-----------------|
| 270 | INFO | WARN | E | `[Jupiter] Program label fetch failed: HTTP ${s}` |
| 282 | INFO | INFO | 1 | `[Jupiter] Program labels refreshed: ${n} total...` |
| 284 | INFO | WARN | E | `[Jupiter] Program label fetch error...` |
| 303 | INFO | WARN | E | `[Jupiter] Rate limited (429), retrying in ${ms}ms...` |
| 319 | INFO | DEBUG | 1 | `[Jupiter] Fetching verified token list...` |
| 353 | INFO | INFO | 1 | `[Jupiter] Loaded ${n} verified tokens` |
| 355 | INFO | WARN | E | `[Jupiter] Token list fetch failed: ${status}` |
| 358 | INFO | ERROR | E | `[Jupiter] Token list error: ${e.message}` |
| 414 | INFO | DEBUG | 1 | `[Wallet] Pre-authorizing wallet (cold start)...` |
| 420 | INFO | INFO | 1 | `[Wallet] Wallet authorized and ready` |

### skills.js (6 calls)

| Line | Android | Proposed | Freq | Message Pattern |
|------|---------|----------|------|-----------------|
| 313 | **WARN** | WARN | 1 | `Skill format warning (${file}): ${warnings}` |
| 339 | INFO | DEBUG | 1 | `Loaded skill: ${name} (triggers: ${list})` |
| 342 | **ERROR** | ERROR | 1 | `Error loading skill ${name}: ${e.message}` |
| 355 | INFO | DEBUG | 1 | `Loaded skill: ${name} (triggers: ${list})` |
| 358 | INFO | ERROR | 1 | `Error loading skill ${name}: ${e.message}` (**BUG**: lowercase "Error") |
| 363 | INFO | ERROR | 1 | `Error reading skills directory: ${e.message}` (**BUG**: lowercase) |

### mcp-client.js (16 calls)

| Line | Android | Proposed | Freq | Message Pattern |
|------|---------|----------|------|-----------------|
| 290 | INFO | DEBUG | 1 | `[MCP] Connecting to ${name} at ${url}` |
| 304 | INFO | INFO | 1 | `[MCP] Connected to ${name} v${version}` |
| 334 | INFO | WARN | E | `[MCP] Skipping tool with invalid/missing name...` |
| 345 | INFO | WARN | E | `[MCP] Tool name too long... — skipping` |
| 351 | INFO | WARN | E | `[MCP] Duplicate sanitized tool name... — skipping` |
| 361 | **WARN** | ERROR | E | `[MCP] WARNING: Tool definition changed... — blocking (rug pull)` |
| 378 | INFO | DEBUG | 1 | `[MCP] ${name}: ${n} tools discovered` |
| 436 | INFO | INFO | E | `[MCP] Disconnected from ${name}` |
| 454 | INFO | INFO | 1 | `[MCP] No MCP servers configured` |
| 461 | INFO | DEBUG | 1 | `[MCP] Skipping disabled server: ${name}` |
| 468 | INFO | WARN | E | `[MCP] Skipping server with missing id...` |
| 474 | INFO | WARN | E | `[MCP] Duplicate server id... — skipping` |
| 486 | INFO | ERROR | E | `[MCP] Failed to connect to ${name}: ...` |
| 492 | INFO | INFO | 1 | `[MCP] Initialization complete: ${n} servers, ${n} tools` |
| 541 | INFO | WARN | E | `[MCP] Session expired for ${name}, reconnecting...` |
| 575 | INFO | INFO | E | `[MCP] All servers disconnected` |

### telegram.js (2 calls)

| Line | Android | Proposed | Freq | Message Pattern |
|------|---------|----------|------|-----------------|
| 292 | INFO | DEBUG | P | `File saved: ${name} (${bytes} bytes)` |
| 436 | INFO | ERROR | E | `Failed to send message: ${e.message}` |

### web.js (2 calls)

| Line | Android | Proposed | Freq | Message Pattern |
|------|---------|----------|------|-----------------|
| 224 | INFO | WARN | E | `[DDG] HTML received but no results parsed...` |
| 273 | INFO | WARN | E | `[DDG Lite] HTML received but no results parsed...` |

### memory.js (5 calls)

| Line | Android | Proposed | Freq | Message Pattern |
|------|---------|----------|------|-----------------|
| 100 | INFO | INFO | 1 | `Seeded default SOUL.md to workspace` |
| 102 | **WARN** | WARN | E | `Warning: Could not seed SOUL.md: ...` |
| 141 | INFO | DEBUG | P | `Memory updated` |
| 162 | INFO | DEBUG | P | `Daily memory updated` |
| 234 | INFO | WARN | E | `[Memory] Search error, falling back to file scan: ...` |

### security.js (1 call)

| Line | Android | Proposed | Freq | Message Pattern |
|------|---------|----------|------|-----------------|
| 120 | INFO | WARN | P | `[Security] Suspicious patterns in ${source}: ...` |

### bridge.js (1 call)

| Line | Android | Proposed | Freq | Message Pattern |
|------|---------|----------|------|-----------------|
| 44 | INFO | ERROR | E | `Android Bridge error: ${e.message}` |

---

## 3. Top 10 Noise Reduction Wins

Ranked by frequency × low value. These are the biggest contributors to console spam.

| # | File:Line | Message | Freq | Why it's noise | Fix |
|---|-----------|---------|------|----------------|-----|
| 1 | main.js:334 | `Message: ${text.slice(0,100)}...` | **Every message** | Logs every incoming message body. User already sees it in Telegram. | → DEBUG |
| 2 | main.js:766 | `Heartbeat - uptime: Xs, memory: YMB` | **Every 5 min** | 12 lines/hour, 288/day. No actionable info. | → DEBUG |
| 3 | main.js:664 | `Claude usage poll: HTTP ${status}` | **Every 60s** | Logs success (HTTP 200) every poll cycle. | → DEBUG (only log non-200) |
| 4 | claude.js:725-728 | `[Cache] hit/miss: ${tokens} tokens` | **Every API call** | Internal cache stats visible nowhere. | → DEBUG |
| 5 | claude.js:1004 | `Tool use: ${name}` | **Every tool call** | Redundant with `Executing tool: ${name}` at tools.js:789 | → Remove (keep tools.js:789) |
| 6 | tools.js:789 | `Executing tool: ${name}` | **Every tool call** | Useful but verbose when chained (5+ tools per turn). | → DEBUG |
| 7 | claude.js:948 | `Matched skills: ${names}` | **Every API call** | Lists all matched skills on every chat(). | → DEBUG |
| 8 | main.js:439 | `Agent returned HEARTBEAT_OK` | **Every heartbeat** | Logs success of a heartbeat response. | → DEBUG |
| 9 | database.js:226 | `[Memory] Indexed ${n} files, skipped ${n}` | **On indexing** | Usually `Indexed 0 files, skipped 5 unchanged`. | → DEBUG |
| 10 | skills.js:339,355 | `Loaded skill: ${name} (triggers: ...)` | **Per skill at startup** | 34 skills = 34 lines on every boot. | → DEBUG (log count only) |

**Estimated noise reduction**: Removing these from INFO would cut console output by ~60% during normal operation.

---

## 4. Classification Bugs

Messages that are misclassified by the Android substring-matching system:

| File:Line | Message | Android Shows | Should Be | Why |
|-----------|---------|---------------|-----------|-----|
| main.js:24 | `UNHANDLED: ${reason}` | INFO | ERROR | No "ERROR" or "UNCAUGHT" keyword |
| main.js:456 | `Error: ${message}` | INFO | ERROR | Lowercase "Error" not matched |
| main.js:421 | `Media download failed: ${e}` | INFO | ERROR | No keyword |
| main.js:530 | `Message handler error: ${e}` | INFO | ERROR | Lowercase "error" |
| skills.js:358 | `Error loading skill...` | INFO | ERROR | Lowercase "Error" |
| skills.js:363 | `Error reading skills dir...` | INFO | ERROR | Lowercase "Error" |
| cron.js:80 | `Error loading cron store...` | INFO | ERROR | Lowercase "Error" |
| cron.js:103 | `Error saving cron store...` | INFO | ERROR | Lowercase "Error" |
| cron.js:130 | `Error writing run log...` | INFO | ERROR | Lowercase "Error" |
| bridge.js:44 | `Android Bridge error: ${e}` | INFO | ERROR | Lowercase "error" |
| telegram.js:436 | `Failed to send message...` | INFO | ERROR | No keyword at all |
| claude.js:107 | `Failed to write claude usage...` | INFO | WARN | No keyword |
| database.js:131 | `[DB] Failed to initialize...` | INFO | ERROR | No keyword |

**13 misclassified logs**, most of which are actual errors showing as blue INFO.

---

## 5. Proposed Log Level System

### Node.js: Add a `logLevel()` function

```js
// config.js — replace flat log() with leveled logging
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
let logThreshold = LOG_LEVELS.INFO; // configurable

function log(msg, level = 'INFO') {
    if (LOG_LEVELS[level] < logThreshold) return;
    const safe = _redactFn ? _redactFn(msg) : msg;
    const line = `${level}|${safe}\n`;        // structured: LEVEL|message
    try { fs.appendFileSync(debugLog, line); } catch (_) {}
}
```

### Wire format change: `node_debug.log`

**Before:** `[2026-02-19T10:30:00+03:00] Starting SeekerClaw AI Agent...\n`
**After:** `INFO|Starting SeekerClaw AI Agent...\n`

- **Drop the timestamp from the Node side** — Android already adds one. Fixes the double-timestamp bug.
- **Prefix with level** — Android can parse `LEVEL|message` instead of using fragile substring matching.

### Android: Parse structured levels

```kotlin
// OpenClawService.kt — replace substring matching
for (line in lines) {
    val (level, message) = if ('|' in line) {
        val idx = line.indexOf('|')
        val lvl = line.substring(0, idx)
        val msg = line.substring(idx + 1)
        val parsed = when (lvl) {
            "ERROR" -> LogLevel.ERROR
            "WARN"  -> LogLevel.WARN
            "DEBUG" -> LogLevel.DEBUG   // new level
            else    -> LogLevel.INFO
        }
        parsed to msg
    } else {
        LogLevel.INFO to line  // fallback for unparsed lines
    }
    if (level != LogLevel.DEBUG) {  // suppress DEBUG in UI by default
        LogCollector.append("[Node] $message", level)
    }
}
```

### UI: Add DEBUG toggle (hidden by default)

- Keep existing Info/Warn/Error filter buttons
- Add a "Debug" toggle (off by default, tap 3x on title to reveal)
- DEBUG entries shown in gray (`#6B7280`)

---

## 6. Recommended Changes (Specific, Actionable)

### Phase 1: Fix the double timestamp (high impact, low risk)

1. **config.js:72** — Remove the `[${localTimestamp()}]` wrapper from the debug log line:
   ```js
   // Before: const line = `[${localTimestamp()}] ${safe}\n`;
   // After:  const line = `${safe}\n`;
   ```
2. **config.js:74** — Remove the `console.log()` call entirely (stdout goes nowhere).

### Phase 2: Add structured log levels (medium risk)

1. **config.js** — Add `log(msg, level)` with `LEVEL|message` wire format.
2. **OpenClawService.kt** — Parse `LEVEL|message` instead of substring matching.
3. **LogCollector.kt** — Add `LogLevel.DEBUG` enum value.
4. **LogsScreen.kt** — Add optional DEBUG filter toggle.

### Phase 3: Reclassify all 209 log calls (low risk, tedious)

Apply the "Proposed" level from the catalog tables above. Key changes:
- ~70 calls stay INFO → DEBUG (noise reduction)
- ~25 calls that are errors get explicit ERROR level (fixes misclassification)
- ~20 calls that are warnings get explicit WARN level

### Phase 4: Consolidate startup noise

Replace 34 individual "Loaded skill: X" lines with one summary:
```
[Skills] 34 skills loaded (12 from workspace, 22 from assets)
```

Replace 10+ startup config lines with a condensed banner:
```
SeekerClaw v1.3.0 | Claude sonnet | @botname | 34 skills | 2 MCP servers | 3 cron jobs
```

---

## 7. Summary Statistics

| Metric | Current | After Proposed Changes |
|--------|---------|----------------------|
| Total `log()` calls | 209 | 209 (unchanged) |
| Shown as INFO (default view) | ~186 (89%) | ~70 (33%) |
| Shown as WARN | ~10 (5%) | ~42 (20%) |
| Shown as ERROR | ~13 (6%) | ~30 (14%) |
| Hidden (DEBUG) | 0 (0%) | ~67 (32%) |
| Misclassified errors | 13 | 0 |
| Double timestamps | Every line | None |
| Startup lines | 10+ | ~5 (condensed banner) |
| Recurring noise lines/hour | ~24+ | ~2 (errors only) |

---

*Generated 2026-02-19. Audit only — no code changes made.*
