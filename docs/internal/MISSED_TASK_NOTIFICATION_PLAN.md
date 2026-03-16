# Missed Task Notification — Implementation Plan

**Issue:** GitHub #254 — "Reliability: missed task recovery on restart"
**Date:** 2026-03-17
**Status:** Planning

---

## Overview

When SeekerClaw restarts after downtime, detect cron jobs that were missed and send ONE Telegram notification to the owner, merged into the existing "Back online" message. The user can then reply `/catchup` to execute missed recurring tasks on demand. No auto-execution — the user decides.

---

## 1. Detection Logic

### New method: `cronService.detectMissedJobs()`

Add to `cronService` in `cron.js` (after `status()`, before internal methods at ~line 425).

**CRITICAL:** This method must be called AFTER `_recomputeNextRuns()` (which runs inside `start()`). One-shot skipped detection relies on `_newlySkippedIds` which is populated during `_recomputeNextRuns()`.

```javascript
detectMissedJobs() {
    if (!this.store) this.store = loadCronStore();

    const now = Date.now();
    const MAX_CATCHUP_WINDOW_MS = 12 * 60 * 60 * 1000; // 12 hours
    const MAX_MISSED_REPORT = 5;
    const cutoff = now - MAX_CATCHUP_WINDOW_MS;

    // --- Real downtime (uncapped) for display ---
    // Use lastShutdownAtMs (clean shutdown), else lastSaveAtMs (crash — written
    // on every saveCronStore), else fall back to max lastRunAtMs across all jobs.
    let realLastAlive = 0;
    if (typeof this.store.lastShutdownAtMs === 'number' && isFinite(this.store.lastShutdownAtMs)) {
        realLastAlive = this.store.lastShutdownAtMs;
    }
    if (!realLastAlive && typeof this.store.lastSaveAtMs === 'number' && isFinite(this.store.lastSaveAtMs)) {
        realLastAlive = this.store.lastSaveAtMs;
    }
    // Fallback: scan jobs for the most recent lastRunAtMs
    if (!realLastAlive) {
        for (const job of this.store.jobs) {
            const lr = (typeof job.state?.lastRunAtMs === 'number' && isFinite(job.state.lastRunAtMs))
                ? job.state.lastRunAtMs : 0;
            if (lr > realLastAlive) realLastAlive = lr;
        }
    }
    const realDowntimeMs = realLastAlive > 0 ? (now - realLastAlive) : 0;

    // --- Capped lookback for detection (12h max) ---
    const lastKnownAlive = Math.max(realLastAlive, cutoff);

    const missedJobs = [];
    const skippedOneShots = [];

    for (const job of this.store.jobs) {
        // --- Recurring jobs (kind === 'every') ---
        if (job.schedule?.kind === 'every' && job.enabled) {
            const everyMs = job.schedule.everyMs;
            if (typeof everyMs !== 'number' || !isFinite(everyMs) || everyMs <= 0) continue;

            const lastRunAtMs = (typeof job.state?.lastRunAtMs === 'number' && isFinite(job.state.lastRunAtMs))
                ? job.state.lastRunAtMs : 0;

            // Use lastRunAtMs if available, else createdAtMs as reference point.
            // This catches jobs that were created but never ran before the crash.
            const referenceTime = lastRunAtMs > 0 ? lastRunAtMs :
                (typeof job.createdAtMs === 'number' && isFinite(job.createdAtMs) ? job.createdAtMs : 0);

            // If time since reference exceeds the interval + 10% grace (for clock
            // jitter), at least one cycle was missed. 1.1x not 1.5x — a daily job
            // missed by a 2h outage must be detected, not ignored for 36h.
            if (referenceTime > 0 && (now - referenceTime) > everyMs * 1.1) {
                const missedCount = Math.floor((now - referenceTime) / everyMs);
                const dueAtMs = referenceTime + everyMs; // When the first missed run was due
                // Only report if the due time falls within the 12h catchup window
                if (dueAtMs >= cutoff && dueAtMs < now) {
                    missedJobs.push({
                        id: job.id,
                        name: job.name || 'Unnamed',
                        dueAtMs,
                        missedCount: Math.min(missedCount, 99),
                        payload: job.payload ? { kind: job.payload.kind, message: job.payload.message } : null,
                    });
                }
            }
        }

        // --- One-shot jobs (kind === 'at') that were NEWLY skipped THIS restart ---
        // _recomputeNextRuns() populates _newlySkippedIds with job IDs that were
        // marked skipped during THIS start() call. Old one-shots from previous
        // restarts that already have lastStatus='skipped' are NOT included.
        if (job.schedule?.kind === 'at'
            && !job.enabled
            && job.state?.lastStatus === 'skipped'
            && this._newlySkippedIds.has(job.id)
            && typeof job.schedule.atMs === 'number'
            && job.schedule.atMs >= cutoff
            && job.schedule.atMs < now) {
            skippedOneShots.push({
                id: job.id,
                name: job.name || 'Unnamed',
                dueAtMs: job.schedule.atMs,
            });
        }
    }

    // Done reading _newlySkippedIds — clear to avoid minor memory leak.
    // It's only needed once per restart (here), never read again.
    this._newlySkippedIds.clear();

    // Sort by dueAtMs, cap at MAX_MISSED_REPORT
    missedJobs.sort((a, b) => a.dueAtMs - b.dueAtMs);
    skippedOneShots.sort((a, b) => a.dueAtMs - b.dueAtMs);

    return {
        downtimeMs: realDowntimeMs,
        missedJobs: missedJobs.slice(0, MAX_MISSED_REPORT),
        skippedOneShots: skippedOneShots.slice(0, MAX_MISSED_REPORT),
        totalMissed: missedJobs.length,
        totalSkipped: skippedOneShots.length,
    };
}
```

### Key design decisions

- **Called once after `start()` completes** — `_recomputeNextRuns()` has already run, so `_newlySkippedIds` is populated and skipped one-shots are already marked.
- **Does not mutate state** (except clearing `_newlySkippedIds`) — safe to call.
- **Simplified recurring detection** — uses `(now - referenceTime) > everyMs * 1.1` (10% grace for clock jitter) instead of complex anchor-based `firstMissedMs` calculation. `referenceTime` is `lastRunAtMs` if the job ran at least once, else `createdAtMs` (catching jobs that were created but never ran before the crash). Display due time = `referenceTime + everyMs`. Missed count = `Math.floor((now - referenceTime) / everyMs)`.
- **`_newlySkippedIds` prevents false positives** — old one-shot jobs from previous restarts already have `lastStatus: 'skipped'`. Only jobs skipped during THIS `_recomputeNextRuns()` call are reported. Cleared after reading to avoid minor memory leak.
- **Uncapped downtime for display, capped lookback for detection** — `realDowntimeMs` shows the real offline duration (e.g., "3d 2h" for a 3-day outage). Detection only looks at jobs due within the last 12h (`cutoff`) — anything older is too stale.
- **Max 5 per category** — keeps notification concise.
- **Defensive field validation** — every field read from `job.state` and `job.schedule` is guarded with `typeof` + `isFinite` checks (per CLAUDE.md coding patterns).

### New constants

```javascript
const MAX_CATCHUP_WINDOW_MS = 12 * 60 * 60 * 1000; // 12h lookback cap
const MAX_MISSED_REPORT = 5; // Max jobs in notification
```

Add at ~line 47 in `cron.js`, after `MIN_AGENT_TURN_INTERVAL_MS`.

---

## 2. Notification Message — Merged with "Back Online"

### CRITICAL: Merge with existing "Back online" message

The existing startup code (main.js ~line 1200-1215) already sends:
```
"Back online — resend anything important."
```
when there are flushed updates. We MUST NOT send two separate messages (noisy UX).
Instead, **replace the existing back-online message** with a combined one that includes
missed task info when available.

### Approach: detection runs INLINE in the existing flush block

There is NO separate `checkAndNotifyMissedTasks()` function, NO `setTimeout` at +5s,
NO `_missedTasksNotified` flag. Everything happens synchronously in the existing flush
block at ~line 1200.

The flow within the flush block:
```
cronService.detectMissedJobs()       // sync, reads in-memory store
    ↓
cache result in _cachedMissedResult  // for /catchup command later
    ↓
flush old Telegram updates           // existing code
    ↓
send buildBackOnlineMessage()        // combined message (replaces old hardcoded string)
```

### New function in `main.js`: `buildBackOnlineMessage(missedResult)`

**Note on formatting:** This function returns a string sent directly via `telegram('sendMessage', { parse_mode: 'HTML' })`, NOT through `sendMessage()`. Therefore it uses raw HTML tags (`<b>`, `<i>`), not Markdown (`**bold**`). The `/catchup` command (Section 3) returns its response through `sendMessage()` which runs `toTelegramHtml()`, so it uses Markdown.

**Note on time formatting:** Uses `localTimestamp` from `config.js` instead of `toLocaleTimeString()`. `toLocaleTimeString()` output varies by device locale/ROM (some Android devices return 24h, some 12h, some localized). `localTimestamp` returns a consistent ISO-style format (`2026-03-17T15:32:00+05:00`). We extract the time portion (`HH:MM:SS`) for concise display.

```javascript
// Module-level state for /catchup command
let _cachedMissedResult = null;
let _cachedMissedAt = 0;           // timestamp when cache was populated
let _catchupUsed = false;
const CATCHUP_TTL_MS = 30 * 60 * 1000; // 30 min — after this, missed tasks are stale

function buildBackOnlineMessage(result) {
    // No missed tasks — simple back-online message (existing behavior)
    if (!result || (result.missedJobs.length === 0 && result.skippedOneShots.length === 0)) {
        return 'Back online — resend anything important.';
    }

    // Strip trailing "0s" for cleaner display at hour scale (e.g., "3h 12m" not "3h 12m 0s")
    const downtimeStr = formatDuration(result.downtimeMs).replace(/\s*0s$/, '');
    let msg = `Back online (was offline ~${downtimeStr}).\n\n`;

    if (result.missedJobs.length > 0) {
        msg += `<b>Missed tasks:</b>\n`;
        for (const job of result.missedJobs) {
            // Extract HH:MM:SS from localTimestamp (device-independent formatting)
            const dueStr = localTimestamp(new Date(job.dueAtMs)).split('T')[1].split(/[+-Z]/)[0];
            const countNote = job.missedCount > 1 ? ` (${job.missedCount}x)` : '';
            msg += `\u2014 ${job.name} (due ${dueStr})${countNote}\n`;
        }
        if (result.totalMissed > result.missedJobs.length) {
            msg += `<i>...and ${result.totalMissed - result.missedJobs.length} more</i>\n`;
        }
        msg += '\n';
    }

    if (result.skippedOneShots.length > 0) {
        msg += `<b>Skipped one-shots:</b>\n`;
        for (const job of result.skippedOneShots) {
            const dueStr = localTimestamp(new Date(job.dueAtMs)).split('T')[1].split(/[+-Z]/)[0];
            msg += `\u2014 ${job.name} (was due ${dueStr})\n`;
        }
        if (result.totalSkipped > result.skippedOneShots.length) {
            msg += `<i>...and ${result.totalSkipped - result.skippedOneShots.length} more</i>\n`;
        }
        msg += '\n';
    }

    // Only offer /catchup when there are missed recurring jobs to re-execute.
    // Skipped one-shots are info-only — they were time-sensitive and can't be re-run.
    if (result.missedJobs.length > 0) {
        msg += `Reply /catchup to run them, or resend anything important.`;
    } else {
        msg += `Skipped one-shots were time-sensitive and are not re-executed.\nResend anything important.`;
    }
    return msg;
}
```

### `formatDuration` and `localTimestamp` imports

`buildBackOnlineMessage` uses `formatDuration` from `cron.js` and `localTimestamp` from `config.js`.

`formatDuration` — add to the existing cron import in `main.js` at ~line 65:

```javascript
const {
    setSendMessage, setRunAgentTurn, cronService,
    formatDuration,
} = require('./cron');
```

**Verified:** `formatDuration` is exported from `cron.js` at line 691 (`module.exports = { ... formatDuration, ... }`).

`localTimestamp` — already imported from `config.js` at the top of `main.js`:

```javascript
const { ..., localTimestamp, ... } = require('./config');
```

**Verified:** `localTimestamp` is exported from `config.js` at line 448 (`module.exports = { ... localTimestamp, ... }`).

### `formatDuration` at hour scale

The existing `formatDuration` in `cron.js` (line 56-67) returns:
- `"3d 2h"` for 3 days 2 hours
- `"3h 12m"` for 3 hours 12 minutes
- `"45m"` for 45 minutes
- `"30s"` for 30 seconds

It never produces trailing `0s` when hours > 0 (the function returns at the first
non-zero unit and includes one sub-unit). The `replace(/\s*0s$/, '')` in
`buildBackOnlineMessage` is a safety net for edge cases where seconds appear at minute
scale (e.g., `"1m 0s"` → `"1m"`).

### Replacing the existing back-online code (main.js ~line 1200)

**Before (existing, lines 1200-1218):**
```javascript
// Flush old updates to avoid re-processing stale messages after restart,
// and notify owner if any messages arrived while offline.
try {
    const flush = await telegram('getUpdates', { offset: -1, timeout: 0 });
    if (flush.ok && flush.result.length > 0) {
        offset = flush.result[flush.result.length - 1].update_id + 1;
        log(`Flushed old update(s), offset now ${offset}`, 'DEBUG');
        const ownerChat = parseInt(OWNER_ID, 10);
        if (!isNaN(ownerChat)) {
            telegram('sendMessage', {
                chat_id: ownerChat,
                text: 'Back online — resend anything important.',
                disable_notification: true,
            }).catch(e => log(`Back-online notify failed: ${e.message}`, 'WARN'));
        }
    }
} catch (e) {
    log(`Warning: Could not flush old updates: ${e.message}`, 'WARN');
}
```

**After (new):**
```javascript
// Flush old updates and send combined back-online + missed tasks notification.
try {
    // Detect missed cron tasks BEFORE flushing (sync, fast — reads in-memory store)
    const missedResult = cronService.detectMissedJobs();
    _cachedMissedResult = (missedResult.missedJobs.length > 0 || missedResult.skippedOneShots.length > 0)
        ? missedResult : null;
    _cachedMissedAt = _cachedMissedResult ? Date.now() : 0;
    _catchupUsed = false;

    const flush = await telegram('getUpdates', { offset: -1, timeout: 0 });
    if (flush.ok && (flush.result.length > 0 || _cachedMissedResult)) {
        if (flush.result.length > 0) {
            offset = flush.result[flush.result.length - 1].update_id + 1;
            log(`Flushed old update(s), offset now ${offset}`, 'DEBUG');
        }
        const ownerChat = parseInt(OWNER_ID, 10);
        if (!isNaN(ownerChat)) {
            const msg = buildBackOnlineMessage(missedResult);
            // Use HTML parse_mode when message contains HTML tags (missed tasks present).
            // Plain back-online message has no formatting — parse_mode is omitted for safety.
            const parseMode = _cachedMissedResult ? 'HTML' : undefined;
            telegram('sendMessage', {
                chat_id: ownerChat,
                text: msg,
                parse_mode: parseMode,
                disable_notification: true,
            }).catch(e => log(`Back-online notify failed: ${e.message}`, 'WARN'));
        }
    }

    if (_cachedMissedResult) {
        log(`[MissedTasks] ${missedResult.missedJobs.length} recurring missed, ${missedResult.skippedOneShots.length} one-shots skipped — notified in back-online message`, 'INFO');
    }
} catch (e) {
    log(`Warning: Could not flush old updates: ${e.message}`, 'WARN');
}
```

### What the user sees

**Clean restart (no missed tasks):**
```
Back online — resend anything important.
```
(identical to current behavior)

**Restart with missed recurring tasks:**
```
Back online (was offline ~3h 12m).

Missed tasks:
— Daily Report (due 07:43:00) (2x)
— Price Check (due 09:00:00)

Reply /catchup to run them, or resend anything important.
```

**Restart with only skipped one-shots (no recurring missed):**
```
Back online (was offline ~45m).

Skipped one-shots:
— Call mom (was due 15:30:00)

Skipped one-shots were time-sensitive and are not re-executed.
Resend anything important.
```
Note: no /catchup CTA — one-shots cannot be re-executed.

**Restart with both missed recurring + skipped one-shots:**
```
Back online (was offline ~2h 15m).

Missed tasks:
— Price Check (due 14:00:00)

Skipped one-shots:
— Call mom (was due 13:45:00)

Reply /catchup to run them, or resend anything important.
```

**Restart with NO flushed updates but missed tasks:**
The condition is `flush.result.length > 0 || _cachedMissedResult`, so the combined
message is sent even when no user messages arrived while offline. The message includes
the back-online text plus missed task info.

**Restart with NO flushed updates AND no missed tasks:**
No message sent — same as current behavior when `flush.result.length === 0`.

---

## 3. /catchup Command

### Add to `handleCommand()` in `main.js` (~line 481, before `default:`)

**Note on formatting:** `handleCommand` returns a string that is sent via `sendMessage()` (line 572 in main.js), which converts Markdown to HTML via `toTelegramHtml()`. All existing commands use Markdown (`**bold**`, `_italic_`). The `/catchup` handler follows the same pattern.

```javascript
case '/catchup': {
    // Guard: no missed tasks cached
    if (!_cachedMissedResult || _cachedMissedResult.missedJobs.length === 0) {
        return 'No missed tasks to catch up on.';
    }

    // Guard: already used this restart
    if (_catchupUsed) {
        return 'Already caught up this session. Missed tasks were processed.';
    }

    // Guard: cache expired — missed tasks are stale, normal scheduling has taken over
    if (_cachedMissedAt && (Date.now() - _cachedMissedAt) > CATCHUP_TTL_MS) {
        _cachedMissedResult = null;
        return 'Catch-up window expired (30 min). Missed tasks have since been handled by normal scheduling.';
    }

    _catchupUsed = true;

    const MAX_CATCHUP_EXECUTIONS = 3;
    const jobs = _cachedMissedResult.missedJobs.slice(0, MAX_CATCHUP_EXECUTIONS);

    // Save totalMissed BEFORE clearing cache (fix: null reference bug)
    const totalMissed = _cachedMissedResult.totalMissed;
    _cachedMissedResult = null;

    const results = [];

    for (const missed of jobs) {
        try {
            if (!missed.payload) {
                results.push(`• ${missed.name} — skipped (no payload)`);
                continue;
            }

            if (missed.payload.kind === 'reminder') {
                // Send the reminder message directly
                const ownerId = getOwnerId();
                if (ownerId) {
                    await sendMessage(ownerId, `**Catch-up Reminder**\n\n${missed.payload.message}`);
                    results.push(`• ${missed.name} — delivered`);
                } else {
                    results.push(`• ${missed.name} — failed (no owner ID)`);
                }
            } else if (missed.payload.kind === 'agentTurn') {
                // Trigger a full agent turn
                const result = await runCronAgentTurn(missed.payload.message, missed.id);
                if (result) {
                    const ownerId = getOwnerId();
                    if (ownerId) {
                        await sendMessage(ownerId, `**[Catch-up: ${missed.name}]**\n\n${result}`);
                    }
                    results.push(`• ${missed.name} — completed`);
                } else {
                    results.push(`• ${missed.name} — completed (silent)`);
                }
            } else {
                results.push(`• ${missed.name} — skipped (unknown payload kind: ${missed.payload.kind})`);
            }
        } catch (e) {
            log(`[Catchup] Error executing ${missed.id}: ${e.message}`, 'ERROR');
            results.push(`• ${missed.name} — failed: ${e.message}`);
        }
    }

    const extra = totalMissed > MAX_CATCHUP_EXECUTIONS
        ? `\n\n_${totalMissed - MAX_CATCHUP_EXECUTIONS} additional missed tasks were not executed._`
        : '';

    return `**Catch-up complete**\n\n${results.join('\n')}${extra}`;
}
```

### Key fix: null reference bug

The old plan cleared `_cachedMissedResult = null` and then read
`_cachedMissedResult?.totalMissed`. This always returns `undefined`
because the cache was just nulled. The fix saves `totalMissed` to a local variable
BEFORE clearing:

```javascript
const totalMissed = _cachedMissedResult.totalMissed;
_cachedMissedResult = null;
// ... execute jobs ...
const extra = totalMissed > MAX_CATCHUP_EXECUTIONS ? ... : '';
```

### Constraints

| Constraint | Value | Rationale |
|---|---|---|
| Max executions per /catchup | 3 | Avoid API cost spike on restart |
| Max /catchup per restart | 1 | Prevent duplicate execution |
| Cache TTL | 30 minutes | After 30 min, normal scheduling has taken over — stale catch-ups confuse users |
| One-shot skipped jobs | Not re-executed | Already marked `skipped` by `_recomputeNextRuns`, window passed |
| Detection grace | 1.1x interval | 10% buffer for clock jitter — catches daily jobs missed by 2h outages |

### Note on `runCronAgentTurn`

The `/catchup` handler reuses the existing `runCronAgentTurn` function (already defined
in `main.js` at ~line 1070 area, injected into cron.js via `setRunAgentTurn`). This
ensures agent turns from catchup go through the same code path as normal cron agent
turns — same timeout, same mutex, same session isolation.

---

## 4. Integration Points

### Startup sequence in `main.js` (lines 1190-1270)

Current order:
```
1. MCP init, DB summary, stats server, health heartbeat
2. Flush old Telegram updates + "Back online" message (~1202)
3. Register slash commands via setMyCommands (~1220)
4. poll() starts (~1252)
5. autoResumeOnStartup() at 3s delay (~1257)
6. MCP server init (~1260)
```

**Key change:** Step 2 is modified, NOT a new step. The missed task detection runs
INLINE in the existing flush/back-online block. No separate function, no setTimeout.

### Why inline (no setTimeout)?

- `cronService.start()` runs at ~line 1080 — store is already loaded, `_recomputeNextRuns()` already ran, `_newlySkippedIds` is populated
- `detectMissedJobs()` is synchronous (reads from in-memory store)
- The back-online message is the natural place — one message, not two
- No timing race between back-online and missed-tasks notification

### Execution flow

```
cronService.start()            // Line 1080 — loads store, recomputes (populates _newlySkippedIds), arms timers
    ↓ (sync, ~100 lines of other init)
flush block (~line 1200)       // MODIFIED — detect missed, flush, send combined message
    ↓
setMyCommands (~line 1220)     // Existing — now includes /catchup
    ↓
poll() (~line 1252)            // Existing — Telegram polling starts
    ↓ +3s
autoResumeOnStartup()          // Existing — resume interrupted tasks
    ↓ (user replies /catchup)
handleCommand('/catchup')      // NEW — execute cached missed recurring tasks
```

---

## 5. Cron Store Changes

### New property: `cronService._newlySkippedIds`

A `Set<string>` on the `cronService` object that tracks one-shot job IDs skipped
during THIS restart's `_recomputeNextRuns()` call. This prevents false positives
where old one-shot jobs from previous restarts already have `lastStatus: 'skipped'`.

**Add to `cronService` object initialization (~line 296):**

```javascript
const cronService = {
    store: null,
    timer: null,
    running: false,
    _started: false,
    _newlySkippedIds: new Set(), // One-shot IDs skipped THIS restart

    start() {
        this._newlySkippedIds = new Set(); // Reset on each start
        this.store = loadCronStore();
        this._recomputeNextRuns();
        this._armTimer();
        this._started = true;
        log(`[Cron] Service started with ${this.store.jobs.length} jobs`, 'DEBUG');
    },
    // ...
```

**Modify `_recomputeNextRuns()` to populate it (~line 457):**

```javascript
// Fix 1 (BAT-21): One-shot 'at' jobs whose time has passed but
// never ran — mark as skipped so they don't re-fire on next restart.
if (job.schedule.kind === 'at' && !nextRun && !job.state.lastStatus) {
    log(`[Cron] Skipping missed one-shot job: ${job.id} "${job.name}"`, 'DEBUG');
    job.enabled = false;
    job.state.lastStatus = 'skipped';
    job.state.nextRunAtMs = undefined;
    this._newlySkippedIds.add(job.id); // Track for detectMissedJobs()
    continue;
}
```

### New store field: `lastShutdownAtMs`

Added to the top-level cron store object (alongside `version` and `jobs`).

**Written on clean shutdown** via `cronService.stop()`:

```javascript
stop() {
    // Record shutdown time for missed task detection on next startup
    if (this.store) {
        this.store.lastShutdownAtMs = Date.now();
        saveCronStore(this.store);
    }
    if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
    }
    this.running = false;
    this._started = false;
}
```

### New store field: `lastSaveAtMs`

Updated every time `saveCronStore()` is called — acts as a fallback timestamp when
`lastShutdownAtMs` is unavailable (crash, force kill, OOM).

```javascript
function saveCronStore(store) {
    store.lastSaveAtMs = Date.now(); // Track last persist time for missed task detection
    try {
        // ... existing atomic write logic unchanged ...
    }
}
```

### Graceful shutdown handler in `main.js`

Add near the top of `main.js` (after the uncaughtException handlers at line 24-25):

```javascript
// Graceful shutdown: persist cron state so missed task detection works
function gracefulShutdown(signal) {
    log(`Received ${signal}, shutting down...`, 'INFO');
    cronService.stop(); // Writes lastShutdownAtMs
    process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
```

**Note:** On Android, the Node.js process running under nodejs-mobile may be killed
without signals (OOM killer, force stop). That's why `lastSaveAtMs` exists as a
fallback — it's written on every `saveCronStore()` call, which happens after every
job execution and timer arm.

### Store shape after changes

```json
{
  "version": 1,
  "lastShutdownAtMs": 1710700000000,
  "lastSaveAtMs": 1710699500000,
  "jobs": [...]
}
```

---

## 6. Edge Cases

### 6.1 Partially executed tasks

**Scenario:** A recurring job's `lastStatus` is `'ok'` and `lastRunAtMs` is recent — it ran successfully right before shutdown.

**Handling:** `detectMissedJobs()` checks `(now - referenceTime) > everyMs * 1.1`. If the job ran successfully within the last interval, the time delta will be less than `everyMs * 1.1`, so it won't be reported as missed.

### 6.2 Multiple rapid restarts

**Scenario:** App crashes in a loop — 3 restarts in 30 seconds.

**Handling:** Detection runs inline in the flush block (synchronous, fast). If the app crashes BEFORE the flush block runs, no notification is sent — the detection never happened. If it crashes AFTER, the notification was already sent to Telegram — done. No flag needed. Each process gets one shot at the flush block. The existing crash loop protection in `OpenClawService.kt` (>3 restarts in 30s → ERROR + stop) also prevents spam.

### 6.3 Timezone drift

**Scenario:** Device timezone changes while offline.

**Handling:** All timestamps use `Date.now()` (Unix epoch milliseconds). No local time math is used for detection. The notification message uses `localTimestamp()` for display only (extracted time portion `HH:MM:SS`) — detection logic is timezone-agnostic.

### 6.4 Agent offline for >12 hours

**Scenario:** User turns off phone for 3 days.

**Handling:** `MAX_CATCHUP_WINDOW_MS = 12h` caps the **detection lookback**. Only jobs whose first missed due time falls within the last 12h are reported — anything older is too stale to be useful. However, the **downtime display** uses uncapped `realDowntimeMs`, so the notification correctly shows the real duration (e.g., "Back online (was offline ~3d 2h)"). Example: user offline for 3 days with a 30-minute recurring job — notification shows "was offline ~3d 2h" but only lists the most recent missed cycles from the last 12h.

### 6.5 No owner ID yet (fresh install)

**Scenario:** App starts for the first time, no owner ID configured.

**Handling:** The flush block already guards with `if (!isNaN(ownerChat))` — no message is sent if there's no valid owner ID. Also: a fresh install has no cron jobs, so `detectMissedJobs()` returns empty arrays anyway.

### 6.6 Cron service has no jobs

**Scenario:** Clean restart with zero cron jobs.

**Handling:** `detectMissedJobs()` iterates an empty `jobs` array, returns `{ missedJobs: [], skippedOneShots: [] }`. `_cachedMissedResult` is set to null (no missed tasks). The condition `flush.result.length > 0 || _cachedMissedResult` only passes if there are flushed updates, in which case the plain "Back online" message is sent. No change from current behavior.

### 6.7 Corrupt cron store

**Scenario:** `jobs.json` is malformed, missing fields, or has NaN values.

**Handling:** `loadCronStore()` already handles invalid shape (returns `{ version: 1, jobs: [] }`). `detectMissedJobs()` guards every field access with `typeof` + `isFinite()` checks. A corrupt `schedule` object (missing `everyMs`, NaN `lastRunAtMs`) causes the job to be skipped silently.

### 6.8 /catchup called with no prior notification

**Scenario:** User sends `/catchup` on a clean restart (no missed tasks).

**Handling:** `_cachedMissedResult` is null, command returns "No missed tasks to catch up on."

### 6.9 /catchup called twice

**Scenario:** User sends `/catchup` twice in one session.

**Handling:** First call sets `_catchupUsed = true` and clears `_cachedMissedResult = null`. Second call hits the `_catchupUsed` guard and returns "Already caught up this session. Missed tasks were processed."

### 6.10 agentTurn catchup fails mid-execution

**Scenario:** First catchup job succeeds, second fails (API error).

**Handling:** Each job is wrapped in try/catch. Failures are logged and reported in the response (`"failed: <error>"`). The remaining jobs still execute. The cached result was already cleared at the top — no partial retry.

### 6.11 Old one-shot jobs with `lastStatus: 'skipped'` from prior restarts

**Scenario:** A one-shot job was skipped 3 days ago. On today's restart, it still has `lastStatus: 'skipped'` in the store.

**Handling:** `detectMissedJobs()` checks `this._newlySkippedIds.has(job.id)`. Since `_newlySkippedIds` is populated fresh during each `_recomputeNextRuns()` call, only jobs that were NEWLY skipped during THIS restart appear. Old one-shots with pre-existing `lastStatus: 'skipped'` are not in the Set and are correctly excluded.

### 6.12 Never-ran recurring job (created but crashed before first execution)

**Scenario:** User creates a recurring job ("every 10 minutes"), app crashes immediately, restarts 30 minutes later. `lastRunAtMs` is 0 (never ran).

**Handling:** `detectMissedJobs()` uses `referenceTime` which falls back to `job.createdAtMs` when `lastRunAtMs` is 0. If `(now - createdAtMs) > everyMs * 1.1`, the job is reported as missed. `dueAtMs = createdAtMs + everyMs` — the time the first run should have fired. If `createdAtMs` is also missing/corrupt (0), `referenceTime` is 0, and the `referenceTime > 0` guard prevents false positives.

### 6.13 /catchup with only skipped one-shots in cache

**Scenario:** Restart finds only skipped one-shots (no missed recurring jobs). User sends `/catchup`.

**Handling:** The `/catchup` guard checks `_cachedMissedResult.missedJobs.length === 0`. Since there are no missed recurring jobs, it returns "No missed tasks to catch up on." This is correct — one-shots are time-sensitive and not re-executable. The back-online message already told the user "Skipped one-shots were time-sensitive and are not re-executed."

### 6.14 /catchup called after 30 minutes (TTL expiry)

**Scenario:** User sees the missed task notification but doesn't reply `/catchup` for 45 minutes.

**Handling:** The `/catchup` handler checks `(Date.now() - _cachedMissedAt) > CATCHUP_TTL_MS` (30 min). If expired, clears the cache and returns "Catch-up window expired (30 min). Missed tasks have since been handled by normal scheduling." This prevents confusion from running stale catch-ups — by 30 min, recurring jobs have self-healed via normal cron execution.

---

## 7. System Prompt / Agent Awareness

### 7.1 Register `/catchup` in setMyCommands

In `main.js`, add to the commands array at ~line 1221:

```javascript
{ command: 'catchup', description: 'Run missed scheduled tasks' },
```

Add it after the `/resume` entry (line 1230) to keep commands logically grouped.

### 7.2 Add to /help response

In `handleCommand` `/help` case (~line 186-200), add:

```
/catchup — run missed tasks from downtime
```

### 7.3 Update buildSystemBlocks()

In `claude.js` `buildSystemBlocks()`, in the section that describes scheduling/cron, add a one-liner:

```javascript
lines.push('- **Missed task recovery** — on restart, missed cron tasks are reported to the user via Telegram. The /catchup command lets them run missed tasks on demand.');
```

---

## 8. Files Changed

### `app/src/main/assets/nodejs-project/cron.js`

| Location | Change |
|---|---|
| ~line 47 (constants) | Add `MAX_CATCHUP_WINDOW_MS` and `MAX_MISSED_REPORT` constants |
| ~line 104 (`saveCronStore`) | Add `store.lastSaveAtMs = Date.now()` at top of function body |
| ~line 296 (`cronService` init) | Add `_newlySkippedIds: new Set()` property |
| ~line 303 (`start()`) | Add `this._newlySkippedIds = new Set()` reset at top |
| ~line 313 (`stop()`) | Add `lastShutdownAtMs` write + `saveCronStore()` before clearing timer |
| ~line 425 (new method) | Add `detectMissedJobs()` method to `cronService` |
| ~line 457 (`_recomputeNextRuns`) | Add `this._newlySkippedIds.add(job.id)` when marking one-shot as skipped |

**Verified exports:** `formatDuration` is already exported at line 691. No new exports needed from `cron.js` — `detectMissedJobs` is a method on the already-exported `cronService` object.

### `app/src/main/assets/nodejs-project/main.js`

| Location | Change |
|---|---|
| ~line 25 (after uncaught handlers) | Add `SIGTERM`/`SIGINT` graceful shutdown handlers |
| ~line 65 (cron imports) | Add `formatDuration` to destructured import from `./cron` |
| ~line 148 (module-level) | Add `_cachedMissedResult`, `_cachedMissedAt`, `_catchupUsed`, `CATCHUP_TTL_MS` |
| ~line 149 (module-level) | Add `buildBackOnlineMessage(result)` function |
| ~line 186 (`/help` case) | Add `/catchup` to help text |
| ~line 481 (before `default:`) | Add `case '/catchup':` handler in `handleCommand()` |
| ~line 1200 (flush block) | Replace hardcoded back-online message with combined detect+flush+notify block |
| ~line 1230 (`setMyCommands`) | Add `{ command: 'catchup', description: 'Run missed scheduled tasks' }` |

**Verified imports:** `localTimestamp` is already imported from `config.js` in main.js. `getOwnerId` is already imported from `config.js`.

### `app/src/main/assets/nodejs-project/claude.js`

| Location | Change |
|---|---|
| ~line 606 (system prompt) | Add one line about missed task recovery |

### Summary: 3 files, ~120 lines of new code

---

## 9. Testing Strategy

### Prerequisites

- SeekerClaw running on device (Seeker or S24)
- Telegram bot connected to owner

### Test 1: Basic missed task notification

1. Create a recurring reminder: "remind me every 2 minutes to drink water"
2. Verify it fires 2-3 times successfully
3. **Force stop** the app (Settings > Apps > SeekerClaw > Force Stop)
4. Wait **5 minutes**
5. Re-launch the app
6. **Expected:** Receive combined back-online + missed tasks notification:
   ```
   Back online (was offline ~5m).

   Missed tasks:
   — Drink water (due 15:32:00) (2x)

   Reply /catchup to run them, or resend anything important.
   ```
7. **Expected log line:** `[MissedTasks] 1 recurring missed, 0 one-shots skipped — notified in back-online message`

### Test 2: /catchup execution

1. After receiving the missed task notification from Test 1
2. Reply `/catchup`
3. **Expected:** Receive the reminder message with "Catch-up Reminder" prefix
4. **Expected:** Confirmation message: "Catch-up complete" with delivery status (plain bullet list)

### Test 3: Double /catchup blocked

1. Reply `/catchup` again
2. **Expected:** "Already caught up this session. Missed tasks were processed."

### Test 4: Clean restart (no missed jobs)

1. Cancel all cron jobs (or ensure none are due)
2. Restart the app
3. **Expected:** If flushed updates exist: "Back online — resend anything important." (unchanged). If no flushed updates: no message at all.
4. Reply `/catchup`
5. **Expected:** "No missed tasks to catch up on."

### Test 5: One-shot skipped job (new vs old)

1. Create a one-shot reminder: "remind me in 5 minutes to call mom"
2. Force stop the app
3. Wait 6 minutes
4. Restart
5. **Expected:** Notification includes "Skipped one-shots" section with "call mom" and the text "Skipped one-shots were time-sensitive and are not re-executed."
6. **Expected:** No `/catchup` CTA in the message (only skipped one-shots, no missed recurring)
7. Force stop and restart AGAIN (without creating new one-shots)
8. **Expected log line:** `[Cron] Service started with N jobs` — and NO `[MissedTasks]` log line (the old one-shot is not in `_newlySkippedIds` on second restart, so no missed tasks are detected)
9. **Expected:** `/catchup` returns "No missed tasks to catch up on."

### Test 6: >12h offline cap

1. Create a recurring reminder (every 30 minutes)
2. Force stop app
3. Mock by editing `lastShutdownAtMs` in `jobs.json` to 3 days ago (e.g., `Date.now() - 259200000`)
4. Restart
5. **Expected:** Notification shows real downtime ("was offline ~3d 0h") but only lists tasks from last 12h. The detection uses the 12h cutoff for filtering, while the display uses uncapped `realDowntimeMs`.

### Test 7: No owner ID

1. Clear owner ID from config (or use a fresh install with no setup)
2. Create cron jobs manually in `jobs.json`
3. Restart
4. **Expected:** No crash. No Telegram message (the `!isNaN(ownerChat)` guard prevents it)

### Test 8: agentTurn catchup

1. Create a recurring agentTurn job: "every 5 minutes, check BTC price"
2. Force stop, wait 6 minutes, restart
3. Reply `/catchup`
4. **Expected:** Agent executes a turn, sends result with "[Catch-up: ...]" prefix

### Test 9: Never-ran job recovery

1. Create a recurring job ("every 2 minutes, check weather")
2. **Immediately** force stop the app (before the first execution)
3. Wait 5 minutes, restart
4. **Expected:** Notification reports the job as missed (referenceTime falls back to `createdAtMs`)

### Automated (future)

- Unit test `detectMissedJobs()` with mock store data (various combinations of recurring/one-shot, old/new skipped, never-ran jobs)
- Unit test `_newlySkippedIds` population in `_recomputeNextRuns()`
- Integration test: start → stop → mutate time → start → verify notification

---

## 10. Effort Estimate

| Ticket | Description | Effort |
|---|---|---|
| **BAT-254a** | `detectMissedJobs()` in cron.js + `_newlySkippedIds` + store changes (`lastShutdownAtMs`, `lastSaveAtMs`) | S (1-2h) |
| **BAT-254b** | `buildBackOnlineMessage()` in main.js + modified flush block (inline detection) | S (1-2h) |
| **BAT-254c** | `/catchup` command handler + /help + setMyCommands | S (1h) |
| **BAT-254d** | Graceful shutdown handler (`SIGTERM`/`SIGINT`) | XS (30min) |
| **BAT-254e** | System prompt update in claude.js | XS (15min) |
| **BAT-254f** | Device testing (all 9 test scenarios) | M (2-3h) |
| **Total** | | **~6-8h** |

### Recommended approach

Ship as a single PR with all changes. The feature is self-contained and low-risk:
- No existing behavior changes (detection is read-only, notification is additive)
- `/catchup` is opt-in (user must explicitly invoke)
- Graceful shutdown is additive (currently no shutdown handler exists)
- All new code paths have early returns and error handling

### Risk assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| Notification spam on crash loop | Very Low | Detection runs inline — no separate timer. Crash loop protection in Kotlin stops restarts after 3 in 30s. |
| Stale catchup causes confusion | None | 30 min TTL auto-expires cache + 12h detection cap + max 3 executions |
| API cost from catchup agentTurns | Low | Max 3 per /catchup, max 1 per restart |
| False positive one-shot detection | None | `_newlySkippedIds` Set ensures only THIS restart's skipped jobs are reported |
| `lastSaveAtMs` inaccurate after crash | Medium | Acceptable — it's a lower bound, not exact. Always >= actual crash time. |
| Downtime display exceeds 12h cap | None | `realDowntimeMs` is computed from uncapped `realLastAlive`, separate from the 12h detection cutoff |
