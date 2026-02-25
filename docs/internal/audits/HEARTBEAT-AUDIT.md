# HEARTBEAT-AUDIT.md — SeekerClaw Heartbeat Audit

> Audited: 2026-02-20 | Auditor: Claude Code | Device: SM02E4072807319 (connected, runtime verified)

---

## 1. System Overview

SeekerClaw has **four distinct heartbeat mechanisms** operating in parallel. They serve different purposes and are not coupled to each other.

| ID | Name | Layer | Interval | Purpose |
|----|------|-------|----------|---------|
| A | **Android Watchdog** | Kotlin / Android | 30s poll, dead at 60s | Detect Node.js process crash and restart |
| B | **Memory Heartbeat** | Node.js (`memory.js`) | 5 min | Write `HEARTBEAT.md` with uptime + memory stats |
| C | **Agent Health State** | Node.js (`claude.js` / `main.js`) | 60s periodic + on change | Dashboard staleness detection via `agent_health_state` file |
| D | **HEARTBEAT_OK Protocol** | Node.js / Claude agent | Cron-driven (external) | Agent-level task polling; agent replies `HEARTBEAT_OK` if idle |

---

## 2. Config Values & File References

### Mechanism A — Android Watchdog

| Constant | Value | File | Line |
|----------|-------|------|------|
| `CHECK_INTERVAL_MS` | 30,000 ms (30s) | [Watchdog.kt](app/src/main/java/com/seekerclaw/app/service/Watchdog.kt#L14) | 14 |
| `DEAD_AFTER_CHECKS` | 2 | [Watchdog.kt](app/src/main/java/com/seekerclaw/app/service/Watchdog.kt#L15) | 15 |
| Initial startup delay | `CHECK_INTERVAL_MS * 2` = 60s | [Watchdog.kt](app/src/main/java/com/seekerclaw/app/service/Watchdog.kt#L28) | 28 |
| Effective dead time | 60s (2 × 30s checks) | derived | — |

No config file flags — all hardcoded constants.

### Mechanism B — Memory Heartbeat

| Constant | Value | File | Line |
|----------|-------|------|------|
| Write interval | `5 * 60 * 1000` = 300,000 ms (5 min) | [memory.js](app/src/main/assets/nodejs-project/memory.js#L286) | 286 |
| File path | `<workspace>/HEARTBEAT.md` | [config.js](app/src/main/assets/nodejs-project/config.js#L160) | 160 |
| Immediate first write | yes — `updateHeartbeat()` called at module load | [memory.js](app/src/main/assets/nodejs-project/memory.js#L287) | 287 |

### Mechanism C — Agent Health State

| Constant | Value | File | Line |
|----------|-------|------|------|
| Periodic write interval | 60,000 ms (60s) | [main.js](app/src/main/assets/nodejs-project/main.js#L772) | 772 |
| Staleness threshold (Android) | 120,000 ms (120s) | [ServiceState.kt](app/src/main/java/com/seekerclaw/app/util/ServiceState.kt#L294) | 294 |
| UI poll interval | 1,000 ms (1s) | [ServiceState.kt](app/src/main/java/com/seekerclaw/app/util/ServiceState.kt) | ~191 |
| File path | `<workspace>/agent_health_state` (JSON, no ext) | [claude.js](app/src/main/assets/nodejs-project/claude.js#L117) | 117 |
| Write error throttle | once per 60,000 ms | [claude.js](app/src/main/assets/nodejs-project/claude.js) | ~155 |

Also writes immediately on any API status or error change.

### Mechanism D — HEARTBEAT_OK Protocol

| Item | Value | File | Line |
|------|-------|------|------|
| System prompt instruction | `"Heartbeat prompt: (configured)"` | [claude.js](app/src/main/assets/nodejs-project/claude.js#L558) | 558 |
| Response match (discard) | `trim() === 'HEARTBEAT_OK'` or `startsWith('HEARTBEAT_OK')` | [main.js](app/src/main/assets/nodejs-project/main.js#L474) | 474 |
| OpenClaw default interval | `30m` | `openclaw-reference/src/auto-reply/heartbeat.ts:8` | 8 |
| Cron probe setup | **NOT FOUND** | — | — |

---

## 3. Timer/Scheduler Verification

### Watchdog (A)

**Start:** [OpenClawService.kt:155](app/src/main/java/com/seekerclaw/app/service/OpenClawService.kt#L155) — called after Node.js is marked RUNNING.

```kotlin
Watchdog.start(
    onDead = {
        LogCollector.append("[Service] Watchdog detected Node.js death — killing process for restart", LogLevel.ERROR)
        NodeBridge.stop()
        android.os.Process.killProcess(android.os.Process.myPid())
    }
)
```

**Stop:** [OpenClawService.kt:223](app/src/main/java/com/seekerclaw/app/service/OpenClawService.kt#L223) — `onDestroy()`. Cancels the coroutine job.

**Timer pattern:** `delay(CHECK_INTERVAL_MS * 2)` → first check at t+60s. Then `while(isActive) { delay(30s); check }`. Correctly structured — no drift issues with `delay`-based loops (delay measures from previous cycle end, not wall clock).

**Check method:** `NodeBridge.isAlive()` → returns `running.get()` (AtomicBoolean). This is Phase 2a. It does **not** send any ping over IPC or HTTP — it only checks an in-memory flag set when Node.js starts.

### Memory Heartbeat (B)

**Start:** `memory.js` loads at Node.js startup. `setInterval` and immediate call are module-level — always active, no stop mechanism.

**No clearInterval:** Verified. No `clearInterval` call on any heartbeat timer in the codebase.

**Write:** [memory.js:282](app/src/main/assets/nodejs-project/memory.js#L282) — bare `fs.writeFileSync(HEARTBEAT_PATH, content, 'utf8')`. No try/catch.

### Agent Health (C)

**Start:** [main.js:772](app/src/main/assets/nodejs-project/main.js#L772) — `setInterval(() => writeAgentHealthFile(), 60000)` called inside the Telegram bot startup block.

**Atomic write:** Uses tmp file + `fs.renameSync` (atomic). Correct.

**Error handling on write:** Try/catch present with 60s throttled error log. Correct.

### HEARTBEAT_OK Protocol (D)

**Response handler:** Present at [main.js:473–477](app/src/main/assets/nodejs-project/main.js#L473). HEARTBEAT_OK responses are silently discarded before being forwarded to the user.

**Probe sender:** The system prompt at [claude.js:558](app/src/main/assets/nodejs-project/claude.js#L558) says `"Heartbeat prompt: (configured)"`. This is a **placeholder string** — it does not reference an actual configured prompt. No `cron_create` call for a heartbeat probe was found anywhere in the codebase. The protocol handler exists, but nothing sends the probe.

---

## 4. Runtime Log Evidence

> **Note:** No device log files are available in the repository. The following is based on static analysis of log emission points. Runtime verification requires a connected device with `adb logcat` or the in-app Logs screen.

### Expected Log Cadence

| Source | Message | Level | Expected frequency |
|--------|---------|-------|-------------------|
| Watchdog start | `[Watchdog] Started (interval=30s, deadAfter=2 missed checks)` | INFO | Once on service start |
| Watchdog healthy | *(silent — no log when alive and missedChecks=0)* | — | — |
| Watchdog missed | `[Watchdog] Node.js not running (missed=1/2)` | WARN | Only on failure |
| Watchdog dead | `[Watchdog] Node.js unresponsive, triggering restart...` | ERROR | Only on restart |
| Watchdog recovered | `[Watchdog] Node.js recovered after N missed checks` | INFO | Only on recovery |
| Heartbeat log | `Heartbeat - uptime: {s}s, memory: {MB}MB` | DEBUG | Every 5 min |
| HEARTBEAT_OK | `Agent returned HEARTBEAT_OK` | DEBUG | On each ack (if probe sent) |
| Health write error | `[Health] Failed to write agent health file: {msg}` | ERROR | Throttled 1/min |

**Spam assessment:** All heartbeat-related logs are DEBUG or only emitted on state changes. No INFO/WARN spam expected during normal operation. **CONFIRMED on device** — no INFO/WARN heartbeat entries observed in stable session.

### Observed Runtime Evidence (device SM02E4072807319, 2026-02-20T01:54+04:00)

**HEARTBEAT.md** (live read from device):
```
Last updated: 2026-02-20T01:48:30+04:00
Uptime: 0h 30m 0s
Memory: 257 MB
Status: Running
```

**agent_health_state** (live read):
```json
{"apiStatus":"healthy","lastError":null,"consecutiveFailures":0,
 "lastSuccessAt":"2026-02-20T01:43:36+04:00","lastFailureAt":null,
 "updatedAt":"2026-02-20T01:52:31+04:00"}
```
Age at read time: ~2 min — well within 120s staleness threshold. Status: not stale.

**Heartbeat timestamp progression** (last 6 cycles from `service_logs`):

| Android epoch (ms) | Uptime | Memory | Δ from prev |
|-------------------|--------|--------|-------------|
| 1771536210887 | 300s | 254 MB | — (base) |
| 1771536510920 | 600s | 260 MB | +300,033 ms |
| 1771536810829 | 900s | 255 MB | +299,909 ms |
| 1771537110641 | 1200s | 252 MB | +299,812 ms |
| 1771537410916 | 1500s | 260 MB | +300,275 ms |
| 1771537710648 | 1800s | 257 MB | +299,732 ms |

Target interval: 300,000 ms. Max jitter: ±275 ms (0.09%). **PASS.**

**Total Node.js start events in full log history:** 3,614 (111 MB log file). Multiple rapid consecutive restarts visible in historical data — consistent with development iteration and crash-loop recovery cycles. Current session stable for 30+ min at time of audit.

**Watchdog entries in last 1 MB of log:** None. Confirms current session has been running cleanly with no missed checks.

---

## 5. Recovery Behavior

### Network Disconnect/Reconnect

**What happens:**
1. API calls to Anthropic fail → `updateAgentHealth('error', errorInfo)` fires in `claude.js`
2. `agent_health_state` file updated with `consecutiveFailures` count and `lastErrorAt`
3. Android UI reads file within 1s, shows degraded/error indicator on dashboard
4. After 120s with no successful write, `ServiceState.kt:294` marks health as `"stale"`
5. On reconnect, successful API call → `updateAgentHealth('healthy')` → file updated, stale cleared

**Gap:** There is no active reconnect trigger or retry scheduler. Recovery is purely reactive — the agent must receive a message (Telegram polling) for a new API call to happen and health to update.

**Watchdog behavior during network outage:** Unaffected. Watchdog only checks `NodeBridge.isAlive()` (AtomicBoolean). Network outage does not affect this flag — Watchdog stays green even when agent is failing all API calls.

### App Restart (via Android / BootReceiver)

Flow: `BootReceiver` → `OpenClawService.onStartCommand()` → `NodeBridge.start()` → `Watchdog.start()` with 60s initial delay.

The 60s initial delay correctly absorbs Node.js startup time. No race condition observed between service start and first watchdog check.

### Service Crash Recovery

`onDead()` callback: `NodeBridge.stop()` + `Process.killProcess(myPid())` → Android restarts the `:node` process via `START_STICKY`. Node.js cannot be restarted in-process (one-start-per-process constraint in `NodeBridge.kt:19-22`). This is correctly handled by full process death + restart.

---

## 6. Edge Cases

### App Restart
**Verdict: PASS**
Watchdog 60s initial delay absorbs startup. BootReceiver triggers correctly. No state leak between runs — `missedChecks` resets to 0 on `Watchdog.start()`.

### Token / Auth Errors
**Verdict: PASS**
`agentHealth.consecutiveFailures` increments on each error. Error type, HTTP status, and message are all tracked. Written to file on change. Dashboard shows error state within 1s.

### Long Tool Execution Overlap
**Verdict: WARN**

Node.js is single-threaded. `setInterval` callbacks are queued on the event loop and will be delayed by synchronous operations. Specifically:

- `memory.js:282` — `fs.writeFileSync` is synchronous and blocks the event loop during write. On mobile storage, this is typically fast (<10ms) but could be delayed under I/O pressure.
- The 5-minute interval means at most one write is skipped per slow cycle — no accumulation risk.
- The 60s `writeAgentHealthFile()` in `main.js` uses the same pattern — synchronous write, but wrapped in try/catch (via `claude.js`) and uses atomic tmp+rename.
- A very long synchronous `js_eval` call (e.g., heavy computation) could delay timer callbacks by the duration of that call. Not a crash risk, but health file timestamps could lag.

### Heartbeat Overlap (D)
HEARTBEAT_OK probes not being sent (see FAIL #1 below) — overlap scenario not applicable.

---

## 7. PASS/FAIL Summary

| # | Check | Verdict | Evidence |
|---|-------|---------|----------|
| 1 | Config source identified with file/line refs | **PASS** | All constants found: `Watchdog.kt:14-15`, `memory.js:286`, `main.js:772`, `ServiceState.kt:294` |
| 2 | Watchdog timer: correct start/stop lifecycle | **PASS** | Start: `OpenClawService.kt:155`, stop: `OpenClawService.kt:223`. Coroutine correctly cancelled. |
| 3 | Memory Heartbeat timer: no clearInterval | **PASS** | Module-level setInterval, intentionally persistent. No timer leak. |
| 4 | HEARTBEAT_OK cron probe is wired up | **FAIL** | System prompt has placeholder `"(configured)"`. No `cron_create` call found anywhere. Response handler exists but nothing triggers it. |
| 5 | No user-facing spam from heartbeats | **PASS** | All heartbeat logs at DEBUG level. HEARTBEAT_OK responses discarded before Telegram forwarding. |
| 6 | Timestamp progression verifiable | **PASS** | Live device: 6 consecutive cycles at 300,033 / 299,909 / 299,812 / 300,275 / 299,732 ms. Max jitter ±275 ms (0.09%). |
| 7 | Network disconnect detection | **WARN** | Passive only — health goes stale after 120s. No active reconnect. Watchdog unaffected (checks flag, not network). |
| 8 | Network reconnect health recovery | **PASS** | `updateAgentHealth('healthy')` on next successful API call resets failures and staleness. |
| 9 | App restart recovery | **PASS** | 60s Watchdog initial delay, `missedChecks` reset, `START_STICKY` restart chain correct. |
| 10 | Token/auth error tracking | **PASS** | `consecutiveFailures`, `lastErrorAt`, `lastErrorType`/`lastErrorStatus` all tracked in `agentHealth`. |
| 11 | Long tool execution overlap | **WARN** | `memory.js` uses bare `writeFileSync` (no try/catch). Timer callbacks can be delayed by synchronous ops. Low risk given 5-min interval. |
| 12 | Watchdog health check depth | **WARN** | Phase 2a: checks `running` AtomicBoolean only. A zombie Node.js (running but unresponsive) would not be detected. Real IPC ping planned for Phase 2b. |
| 13 | memory.js error handling | **WARN** | `updateHeartbeat()` at `memory.js:282` has no try/catch. Silent failure if workspace dir missing or disk full. |

**Summary: 1 FAIL, 4 WARN, 7 PASS** (runtime verified via adb on device SM02E4072807319)

---

## 8. Concrete Fixes

### FIX-1 (FAIL #1): Wire up HEARTBEAT_OK cron probe
**File:** `main.js`

The system prompt tells the agent to reply `HEARTBEAT_OK` to heartbeat polls, but no cron job is ever created to send those polls. The response handler at `main.js:473-477` is dead code until this is wired up.

**Required change:** After Telegram bot startup succeeds, call `cron_create` (or the internal cron service directly) to schedule a periodic heartbeat probe message to the agent.

Example (OpenClaw reference uses `DEFAULT_HEARTBEAT_EVERY = "30m"`):
```javascript
// After bot starts, schedule heartbeat probe
// Use the same cron infrastructure that handles cron_create tool calls
cronService.createJob({
    id: 'system_heartbeat',
    schedule: 'every 30 min',
    message: HEARTBEAT_PROMPT,  // from openclaw-reference/src/auto-reply/heartbeat.ts
    systemJob: true,            // not user-visible in cron_list
});
```

Also update `claude.js:558` to replace the placeholder:
```javascript
lines.push(`Heartbeat prompt: "${HEARTBEAT_PROMPT}"`);
```

### FIX-2 (WARN #11 + #13): Add try/catch to memory.js updateHeartbeat
**File:** `memory.js:272-283`

```javascript
function updateHeartbeat() {
    const now = new Date();
    const uptime = Math.floor(process.uptime());
    const content = `# Heartbeat\n\nLast updated: ${localTimestamp(now)}\nUptime: ${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s\nMemory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB\nStatus: Running\n`;
    try {
        fs.writeFileSync(HEARTBEAT_PATH, content, 'utf8');
    } catch (err) {
        log(`[Heartbeat] Failed to write HEARTBEAT.md: ${err.message}`, 'WARN');
    }
}
```

### FIX-3 (WARN #12): Document Watchdog Phase 2b upgrade path
**File:** `Watchdog.kt` — this is a known limitation, not a bug. No immediate fix required.

When Phase 2b is ready, replace:
```kotlin
if (!NodeBridge.isAlive()) {
```
with:
```kotlin
if (!NodeBridge.checkHeartbeat(timeoutMs = 10_000)) {
```
`NodeBridge.checkHeartbeat()` already exists at `NodeBridge.kt:161` — just needs the real IPC implementation.

### FIX-4 (WARN #7): Document network reconnect gap
**No immediate code fix needed.** The current passive recovery (stale → error state → recovers on next successful call) is acceptable for v1. For v2, consider:

- Exponential backoff retry for Anthropic API calls
- Explicit Telegram re-polling on network reconnect (listen for `online`/connectivity events)
- Active staleness notification: if `consecutiveFailures > 3`, push a Telegram message to owner

### FIX-5 (WARN #11): Long tool execution jitter
**No immediate fix needed.** The 5-minute write interval gives ample slack for single-cycle delays. If `js_eval` heavy compute becomes common, consider:
- Converting `updateHeartbeat()` to use `fs.writeFile` (async) instead of `writeFileSync`
- Same for the memory.js-level write

---

## Appendix: Heartbeat Architecture Diagram

```
Node.js process (:node)
│
├─ memory.js module load
│   ├── updateHeartbeat() ──────────────────────► HEARTBEAT.md  (immediate + every 5min)
│   └── [no error handling on write]
│
├─ main.js startup
│   ├── setInterval(writeAgentHealthFile, 60s) ─► agent_health_state  (every 60s)
│   └── [MISSING: cron_create for heartbeat probe]
│
├─ claude.js (per API call)
│   └── updateAgentHealth(status, error) ────────► agent_health_state  (on change)
│
└─ main.js Telegram message handler
    └── if HEARTBEAT_OK → discard (DEBUG log)   ◄── [nothing currently sends this]

Android UI process
│
├─ ServiceState.kt
│   ├── readAgentHealthFile() every 1s ◄────────── agent_health_state
│   └── stale if updatedAt > 120s ago
│
└─ Watchdog.kt
    ├── delay 60s (startup)
    └── every 30s: NodeBridge.isAlive() ──────────► AtomicBoolean (Phase 2a)
        └── 2 misses → killProcess() → Android restart
```
