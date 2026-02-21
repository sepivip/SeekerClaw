# P2 Implementation Plan: Reliable Multi-Turn Task Execution

> **Status:** Draft | **Author:** Claude | **Date:** 2026-02-21
> **Prerequisite:** P1 timeout reliability (BAT-243–247, BAT-253) — shipped

## Baseline

`claude.js:chat()` runs a tool loop capped at `MAX_TOOL_USES=5`. On exhaustion, sends "Send 'continue'" and waits (BAT-161). No task IDs, no persistent state, no auto-resume. Conversation history is in-memory only (max 20 messages, lost on restart).

## Execution Order (Strict Sequential)

```
P2.4  manual resume — taskId + continue
  │
  ▼
P2.2  disk checkpoints — survive crashes
  │
  ▼
P2.4b auto-resume — checkpoints + startup scan
  │
  ▼
P2.1  segmentation engine — steps + bounded budgets
  │
  ▼
P2.3  async execution — background tasks + progress
  │
  ▼
P2.5  benchmark — validates everything above
```

No parallel work. No reordering. Each phase builds exclusively on the prior.

---

## P2.4 — Resume Interrupted Task Flow (Manual)

### Scope

Give every multi-tool turn a persistent `taskId`. When the budget exhausts or the process crashes, the user can send `continue` or `/resume` and the agent picks up with full context. Manual-only — user triggers the resume.

### Files Touched

| File | Change |
|------|--------|
| `claude.js` | Generate `taskId` at start of `chat()`, attach to trace logs, store in per-chat `activeTask` slot, expose `getActiveTask(chatId)` |
| `tools.js` | Add `task_status` tool — agent reports current step and progress |
| `main.js` | Detect `continue` / `/resume` in `handleMessage()`, call `chat()` with active task context |
| `config.js` | Add `taskResumeEnabled` flag (default `true`) |

### Risks

- **History truncation:** 20-message cap may lose early task context on long tasks → mitigate by summarizing completed steps into a compact context block
- **Cross-chat collision:** Multiple chats could have overlapping active tasks → scope `activeTask` strictly per `chatId`

### Acceptance Tests

1. Start a task requiring >5 tool calls → agent hits budget, sends fallback → user sends `continue` → agent resumes with correct context and finishes
2. Kill Node.js mid-task → restart → user sends `/resume` → agent acknowledges prior task and continues (graceful degradation — in-memory history only)
3. `task_status` tool returns correct step count, tool history, and elapsed time

### Rollback

Remove `taskId` generation and `activeTask` slot. Revert `handleMessage()` continue detection to pre-P2.4 behavior. Existing BAT-161 fallback message remains functional.

---

## P2.2 — Persistent Task Checkpoints (Disk-Backed State)

### Scope

Write task state to disk after each tool execution so tasks survive Node.js crashes and device reboots. Uses the same JSON-file + atomic-write pattern as `cron.js`.

### Files Touched

| File | Change |
|------|--------|
| **New:** `task-store.js` | `saveCheckpoint()`, `loadCheckpoint()`, `listCheckpoints()`, `deleteCheckpoint()` — atomic write (`.tmp` → rename) + `.bak` backup |
| `claude.js` | After each tool result, call `saveCheckpoint()` with: `taskId`, `chatId`, `stepIndex`, `conversationSlice` (last N messages), `toolResults`, `systemPromptHash`, `timestamp` |
| `config.js` | `checkpointDir` (default `workspace/tasks/`), `maxCheckpointAgeDays` (default 7) |
| `cron.js` | Add daily cleanup job for expired checkpoints (or piggyback on existing memory cleanup) |

### Risks

- **I/O latency:** Disk write on every tool call → mitigate with async fire-and-forget writes (don't await, log errors)
- **Checkpoint bloat:** Large conversation slices → cap at 8 messages + summary of prior context
- **Corrupt files after power loss:** Atomic write + `.bak` fallback (same pattern as cron)
- **Stale checkpoints:** Abandoned tasks accumulate → TTL-based cleanup

### Acceptance Tests

1. Start a 7-tool task → kill Node.js after tool #3 → restart → verify `workspace/tasks/<taskId>.json` exists with 3 tool results
2. `loadCheckpoint()` returns valid state → conversation can be reconstructed
3. Checkpoint older than `maxCheckpointAgeDays` is auto-deleted
4. Corrupt `.json` → falls back to `.bak` → if both corrupt, returns `null` (no crash)

### Rollback

Delete `task-store.js`. Remove `saveCheckpoint()` calls from `claude.js`. Checkpoint files in `workspace/tasks/` are inert JSON — delete or leave.

---

## P2.4b — Auto-Resume on Restart

> **Depends on:** P2.4 (taskId + manual resume) + P2.2 (disk checkpoints)

### Scope

On Node.js startup, scan for incomplete checkpoints and automatically resume them without user intervention.

### Files Touched

| File | Change |
|------|--------|
| `claude.js` | New `resumeFromCheckpoint(checkpoint)` — reconstruct conversation history, re-enter tool loop at saved `stepIndex`, send "Resuming task..." to user |
| `main.js` | On startup (after Telegram polling begins), call `task-store.listCheckpoints()`, filter incomplete tasks, queue into `chatQueues` |
| `task-store.js` | Add `markComplete(taskId)`, `isComplete(state)` helpers |
| `telegram.js` | Send "Resuming interrupted task..." notification to owner |

### Risks

- **Stale auto-resume:** Resumes a task the user no longer wants → only auto-resume checkpoints < 1 hour old; older require manual `/resume`
- **System prompt drift:** Prompt may change between crash and restart (app update) → compare `systemPromptHash`; if mismatch, warn user instead of auto-resuming
- **Race condition:** Auto-resume fires while user sends new message → serialize through `chatQueues` (existing mechanism)
- **Infinite crash loop:** Task causes crash → auto-resume → crash → mitigate: track `resumeAttempts` in checkpoint, cap at 2

### Acceptance Tests

1. Start 8-tool task → kill Node.js after tool #4 → restart → within 30s, user receives "Resuming interrupted task..." → task completes
2. Checkpoint > 1 hour old → not auto-resumed → user sends `/resume` → resumes correctly
3. System prompt hash mismatch → user notified, not auto-resumed
4. Task crashes 3 times → after 2nd auto-resume attempt, marked as failed, user notified

### Rollback

Remove startup checkpoint scan from `main.js`. Remove `resumeFromCheckpoint()`. P2.4 manual resume still works. P2.2 checkpoints remain on disk but are never auto-loaded.

---

## P2.1 — Task Segmentation Engine (Bounded Tool Budget Per Step)

> **Depends on:** P2.4b (auto-resume with checkpoints)

### Scope

Replace the flat `MAX_TOOL_USES` counter with a step-based engine. The agent declares a plan (list of steps) upfront; each step gets its own bounded tool budget. Prevents a single step from consuming the entire budget and enables smarter progress reporting.

### Files Touched

| File | Change |
|------|--------|
| `claude.js` | Refactor `chat()` tool loop into `TaskEngine` class: `plan(steps[])`, `executeStep(stepIndex)`, `onStepComplete(callback)`. Each step gets `maxTools` (default 3). Engine calls Claude once to generate plan, then executes steps sequentially. Keep flat mode as default. |
| `tools.js` | Add `task_plan` (agent declares steps), `task_step_done` (agent signals completion), `task_abort` (agent bails out) |
| `task-store.js` | Extend checkpoint schema: `steps[]` with per-step status (pending/running/done/failed), `currentStep` index |
| `claude.js:buildSystemBlocks()` | Add "Task Planning" section — when/how to use step-based execution |

### Risks

- **Bad plans:** Agent generates too many/too few steps → cap at 10 steps, allow dynamic re-planning on failure
- **Extra API calls:** Plan generation = extra Claude call → only activate for tasks estimated to need >5 tools (heuristic: first Claude response has >3 tool_use blocks → switch to segmented mode)
- **Breaking `chat()` flow:** Refactoring the tool loop is high-risk → keep flat mode as default, segmented is opt-in
- **Step budget too small:** Agent can't finish a step → grant +2 bonus tools if agent signals need (soft limit)

### Acceptance Tests

1. User requests a 12-tool task → agent generates 4-step plan → each step completes within budget → task finishes without "Send continue"
2. Agent generates plan with >10 steps → capped to 10 with warning
3. Step fails (tool error) → engine re-plans remaining steps → task completes
4. Simple 2-tool task → flat mode used (no plan overhead)
5. Checkpoint contains per-step status → crash mid-step-3 → resume picks up at step 3

### Rollback

Remove `TaskEngine` class. Revert `chat()` to flat loop. Remove `task_plan`/`task_step_done`/`task_abort` tools. Remove system prompt section. Checkpoint schema change is backward-compatible (old checkpoints just lack `steps[]`).

---

## P2.3 — Async Task Execution Mode with Progress Updates

> **Depends on:** P2.1 (segmentation engine)

### Scope

Allow long-running tasks to execute in the background while the agent remains responsive to new messages. User receives periodic Telegram progress updates after each step.

### Files Touched

| File | Change |
|------|--------|
| **New:** `task-runner.js` | Background task executor. Pulls from task queue, runs `TaskEngine`, sends progress updates via Telegram after each step. |
| `claude.js` | Add `executeAsync(chatId, taskId)` — enqueues task, returns immediately with "Task started, I'll update you as I go." |
| `tools.js` | Add `task_background` (move task to background), `task_list` (show active background tasks), `task_cancel` |
| `main.js` | Modify `handleMessage()` — if chat has active background task, handle new message in parallel (separate conversation context) |
| `telegram.js` | Add `sendProgressUpdate(chatId, taskId, stepN, totalSteps, summary)` helper |

### Risks

- **Concurrent API calls:** Background task + new user message hit Claude simultaneously → background tasks use separate conversation context, labeled in system prompt
- **Rate limits:** Parallel Claude calls → background tasks use lower priority (delay between steps), yield to foreground
- **User confusion:** Agent doing two things at once → progress messages include task name, step X/Y, cancel command
- **Memory pressure:** Multiple active conversations → limit: 1 background task per chat, 3 total across all chats

### Acceptance Tests

1. User sends complex task → agent responds "Running in background" → user sends unrelated question → agent answers → background task sends progress → task completes with summary
2. User sends `/cancel <taskId>` → background task stops, checkpoint saved, user notified
3. Two background tasks active → third rejected with "Too many background tasks"
4. Background task crashes → checkpoint saved → auto-resume (P2.4b) picks it up
5. Progress messages arrive at ≤1 per step (no spam)

### Rollback

Delete `task-runner.js`. Remove `executeAsync()` from `claude.js`. Remove background tools. All tasks revert to synchronous inline execution. Active background tasks complete or timeout naturally.

---

## P2.5 — End-to-End Reliability Benchmark for Big Tasks

> **Depends on:** All prior P2 phases

### Scope

Automated test harness that sends predefined multi-step tasks to the agent and measures: completion rate, step accuracy, resume reliability, crash recovery time, progress update correctness. Produces a report.

### Files Touched

| File | Change |
|------|--------|
| **New:** `scripts/benchmark-p2.js` | Standalone Node.js script — connects to agent, sends benchmark prompts, monitors responses, simulates crashes, verifies checkpoints, collects metrics |
| **New:** `scripts/benchmark-tasks.json` | Predefined task definitions with expected outcomes (e.g., "create 3 files" → verify 3 files exist) |
| **New:** `P2-VALIDATION.md` | Manual + automated test plan (modeled on P1-VALIDATION.md), gate checklist for P2 sign-off |
| `task-store.js` | Add `getMetrics()` — total tasks, completed, failed, avg steps, avg resume count, avg completion time |

### Risks

- **Non-deterministic:** Claude API responses vary → use deterministic tool-only tasks (file ops), run 5x and report averages
- **Environment dependency:** Benchmark needs workspace access → run on-device or emulator with adb
- **Network flakiness:** Separate network failures from logic failures in the report

### Acceptance Tests

1. `node scripts/benchmark-p2.js` completes without errors on a clean workspace
2. Report: ≥90% completion rate for 5-step tasks, ≥80% for 10-step tasks
3. Crash-recovery benchmark: kill mid-task 3x → all 3 resume successfully
4. Async benchmark: 2 concurrent background tasks complete without interference
5. Report includes per-step timing, total duration, checkpoint sizes

### Rollback

Delete `scripts/benchmark-p2.js`, `scripts/benchmark-tasks.json`, `P2-VALIDATION.md`. No production code affected — benchmark is observational only.

---

## Summary Table

| Phase | New Files | Modified Files | New Tools | Risk Level |
|-------|-----------|----------------|-----------|------------|
| P2.4 | — | claude, tools, main, config | `task_status` | Low |
| P2.2 | `task-store.js` | claude, config, cron | — | Medium |
| P2.4b | — | claude, main, task-store, telegram | — | Medium |
| P2.1 | — | claude, tools, task-store | `task_plan`, `task_step_done`, `task_abort` | High |
| P2.3 | `task-runner.js` | claude, tools, main, telegram | `task_background`, `task_list`, `task_cancel` | High |
| P2.5 | `benchmark-p2.js`, `benchmark-tasks.json`, `P2-VALIDATION.md` | task-store | — | Low |
