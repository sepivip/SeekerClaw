# Go to School — Design Spec

- **Date:** 2026-04-19
- **Status:** Design v3 — revised after codebase verification pass
- **Linear:** TBD (create epic + sub-tasks after spec review)
- **GitHub:** TBD (feature-request issue after spec review)
- **Target version:** v1.10.0
- **Branch:** `feature/go-to-school`
- **Ships in:** 2 PRs (PR-A: log infrastructure, PR-B: school feature)

## Revision log

**v3 (2026-04-19)** — after codebase verification pass + proportionality check:

- **Dropped the killswitch layer entirely.** `/school` is strictly opt-in via a command the user has to type; no background execution, no auto-trigger, two approval gates before any file write. The threat model doesn't warrant a software killswitch — "don't type the command" is the killswitch. Verified no remote-config mechanism exists in the codebase (no Firebase Remote Config, `ConfigClaimImporter` is QR/URL setup-only), so v2's "flip via config push" was fiction regardless.
- **Dropped migration ceremony.** No `schema_version` field, no forward/back-compat reader, no `api_request_log.turn_id` migration. Tool-call log is 30-day rolling — any shape-builder evolution self-heals in 30 days. Log.jsonl is simple append-only; if future us ever needs to change shape, future us writes a one-off migration then. Pre-paying this cost was defensive engineering for a problem that self-heals.
- **No `reloadSkills()` function needed.** Verified [skills.js:408-542](app/src/main/assets/nodejs-project/skills.js#L408) reads the filesystem on every `loadSkills()` call — no cache. New skills surface on the next message automatically. v2's "one-time prompt-cache miss cost" is structurally identical to any existing skill edit — not a new cost introduced by school.
- **Dropped `api_request_log` correlation in `school_scan`.** Verified [database.js:82-93](app/src/main/assets/nodejs-project/database.js#L82) has no `turn_id` column. Adding one is out of scope. School works purely on `tool_call_log` + `skill_trigger_log`.
- **Simplified `match_type` enum to `"keyword"` only.** Verified [skills.js:548-568](app/src/main/assets/nodejs-project/skills.js#L548) `findMatchingSkills()` only does keyword matching today. Single clean hook point.

**v2 (2026-04-19)** — carried forward from v2, validated by codebase check:

1. `call_shape` (structural classifier) in place of exact hash — pattern-mining fires on repeated *classes* of calls.
2. Buffered async logger — tool-call writes off the hot path. `onDestroy()` in [OpenClawService.kt:238](app/src/main/java/com/seekerclaw/app/service/OpenClawService.kt#L238) is the graceful-shutdown flush hook. Accept SIGKILL data loss as known limitation.
3. `skill_trigger_log` table — required for `unused_skills` detection; one-line instrumentation at [skills.js:548-568](app/src/main/assets/nodejs-project/skills.js#L548).
4. Rubric rewritten: "Context budget" gate removed (LLM can't do its fake arithmetic); replaced with "Utility" (honest yes/no) + coverage-artifact requirement for "Gap".
5. Stale-session auto-end (48h threshold) — crashed sessions never block `/school` indefinitely.
6. HTML escaping for `<pre>` blocks in Telegram payloads.
7. Rate limit on `/school` (1 per 5min, 10 per 24h) — same pattern as `solana_swap` / `android_sms` gates.
8. Log-re-read injection wrapping — prior sessions' free-text fields wrapped as untrusted on re-read.
9. Frontmatter marker policy: patches **preserve** existing `source` field, add `last_patched_by` (never overwrite user provenance).
10. SAB-AUDIT-v23 attached via CI status check, not honor system.
11. Expanded test matrix: perf, empty-log, happy-path integration, red-team `call_shape`, rate limit.

---

## 1. Summary

A self-improvement feature that lets the agent analyze its own recent activity and propose concrete changes to its skill set: new skills to create, existing skills to patch, and unused skills to retire. Every proposal passes a fixed five-gate rubric, and proposals the rubric rejects are surfaced to the user with reasons — so the user audits not just the suggestions but the critical thinking behind them. Two-gate approval (list → drafted `.md` → write) keeps the user in control; no skill file is created or changed without explicit YES. Triggered on-demand via `/school`, recurring via the agent's own `cron_create` tool when the user asks for it.

## 2. Motivation

SeekerClaw's agent already has 71 tools, 35 skills, and a rich memory system — but nothing that closes the loop between *what the agent actually does* and *what skills it has to do it better*. Over time, three quiet pathologies accumulate:

1. **Repetition without codification** — the agent burns 8-12 tool calls on the same task three weeks in a row because there's no skill that encodes the workflow.
2. **Dead weight** — bundled skills the user never triggers sit in the system prompt forever, paying token cost on every turn.
3. **Silent failures** — a skill breaks in an edge case, the user works around it, the skill stays broken.

Go to School is the scheduled reflection pass that catches all three. It's *not* magic self-programming — it's a structured ritual that converts recent behavior into concrete proposals the user can audit.

## 3. Locked design decisions

| # | Decision | Rationale |
|---|---|---|
| Q1 | **Two-gate approval** (list → drafted SKILL.md → write). Self-critique is first-class. | User stays in control. The critique layer is what makes this "school" not "brainstorm." |
| Q2 | **Data sources = memory files + chat history + tool-call log**. Tool-call log is a prerequisite (no log exists today → new SQL.js table). | Memory alone is self-serving — the agent only sees what it already thought was important. Tool-call log exposes actual behavior. |
| Q3 | **On-demand `/school` command.** Recurrence is user-directed via existing `cron_create` tool. No separate cadence config. | Reuses existing infrastructure. User owns the cadence. |
| Q4 | **Fixed 5-gate rubric + visible rejections.** Hardcoded in skill prompt v1. | User asked for rigor. Rubric gives a legible, auditable bar. Visible rejections prove the bar is working. |
| Q5 | **Create + patch + retire.** Every school-generated skill gets a mandatory `source: school` frontmatter marker. | Patch and retire are nearly-free once the analysis exists; both are higher-leverage than pure creation. Marker enables self-audit and bulk cleanup. |
| Q6 | **Persistent `log.jsonl` + `SCHOOL.md` trigger file for crash recovery.** Reuses the BOOTSTRAP.md ritual pattern. | Without persistent state, school re-proposes the same rejected ideas every week. Trigger-file pattern already trusted. |

## 4. Non-goals (v1)

- **No SOUL.md / IDENTITY.md / USER.md edits.** Identity-file changes deserve a separate, higher-bar flow.
- **No autonomous skill creation** (no "skip the draft gate" path). Two gates always.
- **No autonomous skill writes.** Two approval gates always. Hot-reload of newly-written skills happens automatically via the existing `loadSkills()` live-read pattern — no new `reloadSkills()` function needed (see §12).
- **No user-editable rubric file.** Rubric is hardcoded v1; editable `rubric.md` parked as v1.1 follow-up.
- **No cross-device sync** of school log. Workspace-local only.
- **No UI screen** in the app. All interaction via Telegram (and Discord, for free, via channel abstraction).

## 5. Architecture

### 5.1 File layout

```
app/src/main/assets/nodejs-project/
├── school.js                       ← NEW — pattern mining, log I/O, pure functions
├── tools/school.js                 ← NEW — 5 tool handlers
└── database.js                     ← MODIFIED — +tool_call_log table migration

app/src/main/assets/default-skills/
└── go-to-school/                   ← NEW — bundled skill, seeded on install
    └── SKILL.md                    ← the teacher: rubric, format, protocol

app/src/main/assets/nodejs-project/tools/
└── index.js                        ← MODIFIED — wrap executeTool() with logger

app/src/main/assets/nodejs-project/
└── ai.js                           ← MODIFIED — +Self-Improvement block in buildSystemBlocks()

workspace/                          (user-side, preserved across updates)
├── SCHOOL.md                       ← transient — created/deleted per session
├── school/
│   ├── log.jsonl                   ← permanent, rolling 90-day retention
│   ├── drafts/                     ← transient — draft SKILL.md awaiting YES/NO
│   └── retired/                    ← archive of retired skills (reversible)
└── skills/
    └── <school-generated>.md       ← school-created workspace skills
```

### 5.2 Boundaries

- **`school.js`** — pure functions over SQL.js + filesystem. Zero prompt text. Unit-testable.
- **`tools/school.js`** — thin wrappers exposing the module as agent tools. Structured JSON in/out, no prompt generation.
- **`default-skills/go-to-school/SKILL.md`** — the entire judgment layer. Hardcoded rubric, proposal format, approval protocol, dedup rules. This is what gets tuned over time.
- **`workspace/school/`** — user-owned persistent state. Never touched by app updates.

### 5.3 Why hybrid (tool + skill) not pure-skill or pure-tool

- **Pure skill:** every rubric check / log query becomes an LLM tool call. Burns through `MAX_TOOL_USES=25` on analysis alone. SQL.js queries awkward without direct access.
- **Pure tool:** rubric hardcoded in JS means every tune requires a service restart. "Is this actually self-improvement?" is exactly the judgment call LLMs do well and deterministic code does badly.
- **Hybrid:** SQL queries and file I/O are one tool call each (cheap, deterministic). Rubric + proposal authoring live in markdown, iterable in 30 seconds. Matches the existing pattern (skills carry intent, tools carry side-effects — like how `cron_create` is a tool but skills orchestrate its use).

## 6. Prerequisite: tool-call log

**Ships as PR-A, independent of school.** Let it accumulate data for 1–2 weeks before PR-B merges.

### 6.1 Schema

```sql
CREATE TABLE tool_call_log (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id              TEXT    NOT NULL,       -- groups tool calls from one agent turn
  message_id           TEXT,                   -- Telegram msg that triggered the turn (null for cron)
  tool_name            TEXT    NOT NULL,       -- e.g. "web_fetch", "solana_swap"
  triggered_by_skill   TEXT,                   -- skill name if a skill was active for this turn (null otherwise)
  call_shape           TEXT    NOT NULL,       -- structural classifier, see §6.2
  result_status        TEXT    NOT NULL,       -- "ok" | "error" | "timeout" | "blocked_by_policy" | "blocked_by_confirmation"
  error_kind           TEXT,                   -- e.g. "bridge_unreachable", "rate_limited"
  latency_ms           INTEGER,
  created_at           INTEGER NOT NULL        -- unix ms
);

CREATE INDEX idx_tcl_created ON tool_call_log(created_at);
CREATE INDEX idx_tcl_tool    ON tool_call_log(tool_name, created_at);
CREATE INDEX idx_tcl_shape   ON tool_call_log(call_shape, created_at);
CREATE INDEX idx_tcl_turn    ON tool_call_log(turn_id);
CREATE INDEX idx_tcl_skill   ON tool_call_log(triggered_by_skill, created_at);
```

### 6.2 `call_shape` — structural classifier (not a hash)

Earlier drafts used `args_fingerprint = sha256(canonicalized_args)`. That broke the feature's own core signal: a user querying balances for 3 different wallets produces 3 unique fingerprints, so "repetition ≥ 3" never fires even though the behavior is clearly repeated. Pattern-mining needs **shape, not identity.**

`call_shape` is a short, per-tool-defined string that captures the *class* of the call without sensitive values. Each tool defines a shape-builder in `tools/<tool>.js`. Examples:

| Tool | `call_shape` |
|---|---|
| `web_fetch` | `web_fetch:{hostname}:{method}` → `web_fetch:api.anthropic.com:POST` |
| `solana_swap` | `solana_swap:{input_mint_short}:{output_mint_short}` → `solana_swap:SOL:USDC` |
| `solana_balance` | `solana_balance:self` vs `solana_balance:other` |
| `file_read` | `file_read:{path_pattern}` → `file_read:memory/*.md`, `file_read:skills/*.md` |
| `shell_exec` | `shell_exec:{first_token}` → `shell_exec:ls`, `shell_exec:cat` |
| `android_sms` | `android_sms` (no shape needed — one use case) |
| default | `{tool_name}` (just the tool name, for tools without custom shape) |

**Privacy rules for shape-builders:**
- Hostnames, well-known public token mints, workspace path patterns, and tool-name first tokens are allowed.
- Wallet addresses (even public), user text, API keys, phone numbers, full URLs with query strings — **never** included.
- Shape strings are capped at 64 chars. If a builder produces longer, truncate with a `…` suffix.

**Why this works:**
- Three balance queries of three wallets → all produce `solana_balance:other` → count = 3 → "Repetition" gate fires correctly.
- Pattern-mining SQL groups on `call_shape`, not on raw args.
- Zero sensitive data in the log (stronger guarantee than fingerprints, which were deterministic and could still cluster by identity).
- Shape-builder is one function per tool; defaults to tool name only so the log works from day one even without custom shapes.

### 6.3 Instrumentation + async batching

Single wrap point in `tools/index.js:executeTool()`. Wrap with try/finally, measure `latency_ms`, classify `result_status`, derive `error_kind` from thrown errors, call `tool.shape(args)` to get `call_shape`, and push to an in-memory buffer. **Writes are NOT synchronous with tool execution.**

**Buffer flush rules:**
- Buffer flushes to SQL.js every **5 seconds** OR when buffer length ≥ **100 entries** (whichever first).
- Flush is a single multi-row `INSERT` statement (SQL.js handles this efficiently — one WASM roundtrip).
- On graceful shutdown (`SIGTERM` / app teardown), flush immediately.
- **Lossiness on crash:** up to 5 seconds of tool-call history can be lost on abrupt kill. Acceptable tradeoff — the feature is about *patterns*, and 5s of loss doesn't distort pattern detection.

**Perf target:** adds ≤ 50µs per tool call (in-memory push). Flush amortized; expected < 2ms at p99 for a 100-row batch on a Seeker. No per-call DB roundtrip — this was the big miss in the first draft.

Skill-trigger capture for `triggered_by_skill`: when the skill matcher identifies an active skill for a turn, the turn's active skill name is set in a turn-local context and read by the `executeTool` wrap. Empty for direct tool calls and for turns where no skill triggered.

### 6.4 Retention

- Rolling 30-day window. Auto-purge on service start.
- Hard cap: 50,000 rows OR 10 MB file size (whichever first). Purges oldest first.
- Both limits tunable via config.

### 6.5 Integration with `api_request_log`

`api_request_log` tracks Claude API calls (tokens, cache hits, latency). Tool calls are one level deeper — each API turn spawns 0–25 tool calls. Different grain, separate table. Tool-call log references the API turn via `turn_id` so joins are possible for analytics.

### 6.6 Ship behavior (PR-A scope)

- New table migration in `database.js` — both `tool_call_log` and `skill_trigger_log` (§6.7).
- Wrap `executeTool()` with buffered async logger.
- Wire `triggered_by_skill` via turn-local context from the skill matcher.
- Wire skill-match events to `skill_trigger_log`.
- Retention purge task (runs on service start).
- Unit tests (`tests/nodejs-project/tool-call-log.test.js`, `skill-trigger-log.test.js`).
- Perf test: 1,000-tool-call burst should not regress p99 tool latency by > 5%.
- **No UI.** Logs are infrastructure; only school reads them.

### 6.7 `skill_trigger_log` — required for `unused_skills` detection

The first draft claimed school could detect "unused skills" from `tool_call_log` alone. It can't — skills don't literally wrap tool calls, they influence the LLM's behavior. Without a skill-trigger event, school has no data for the "unused" retire path.

```sql
CREATE TABLE skill_trigger_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_name  TEXT    NOT NULL,          -- matches SKILL.md frontmatter `name`
  message_id  TEXT,                      -- Telegram msg that triggered the match
  match_type  TEXT    NOT NULL,          -- "keyword" (only value in v1 — see §6.7 note)
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_stl_skill_created ON skill_trigger_log(skill_name, created_at);
CREATE INDEX idx_stl_created       ON skill_trigger_log(created_at);
```

**Instrumentation point:** [skills.js:548-568](app/src/main/assets/nodejs-project/skills.js#L548) `findMatchingSkills(message)` is the single skill-matching function. One-line append to `skill_trigger_log` after the `matched.push(skill)` call. Buffered the same way as tool-call log. Verified: no semantic or separate manual-invocation path currently exists — `match_type` is always `"keyword"` in v1.

**Retention:** same 30-day window + same caps as tool-call log.

**What school asks this for:** `SELECT skill_name FROM skill_trigger_log WHERE created_at > ? GROUP BY skill_name` → subtract from full workspace+bundled skill list → `unused_skills` candidates for retire proposals.

## 7. School tools API (5 tools)

All live in `tools/school.js`. Structured JSON in/out. Zero prompt generation.

### 7.1 `school_begin` — start or resume a session

- **Args:** `{ reason: "on_demand" | "cron" | "resumed" }`
- **Behavior:** if `workspace/SCHOOL.md` exists → return its content as `resumed_state`; else create it with initial plan, return new `session_id`.
- **Returns:**
  ```json
  {
    "session_id": "uuid",
    "started_at": 1713614400000,
    "resumed": false,
    "prior_sessions": [ /* last 10 log entries, for dedup input */ ],
    "resumed_state": null
  }
  ```

### 7.2 `school_scan` — pattern-mine the tool-call log

- **Args:** `{ window_days: 1-30 (default 7), min_repetition: int (default 3), caps?: { patterns?: int, sequences?: int, turns?: int, unused?: int } }`
- **Behavior:** runs pre-baked SQL against `tool_call_log` + `skill_trigger_log`. Groups on `call_shape`, not raw args. *(Earlier drafts proposed correlating with `api_request_log`; dropped after verifying that table has no `turn_id` column. Per-turn token metadata is not required for the rubric.)*
- **Hard output caps** (prevents context blow-up on busy weeks; defaults can be tightened by caller):
  - `repeated_patterns`: max **5** entries (top by count, ties broken by most-recent)
  - `failed_sequences`: max **10**
  - `expensive_turns`: max **5**
  - `unused_tools` and `unused_skills`: max **20** each
  - Overall JSON payload cap: **32 KB**. If the payload would exceed, entries are truncated starting with the largest-count group.
- **Empty-log behavior:** if `total_tool_calls < 20` in window, returns `{ empty: true, reason: "insufficient_signal", suggested_window_days: N }` — agent uses this to trigger the silent-exit path (§8.6).
- **Returns:**
  ```json
  {
    "window_days": 7,
    "empty": false,
    "total_turns": 142,
    "total_tool_calls": 387,
    "repeated_patterns": [
      {
        "call_shape_chain": ["web_fetch:docs.example.com:GET", "file_write:memory/*.md"],
        "count": 5,
        "sample_turn_ids": ["..."],
        "sample_message_ids": ["..."],
        "spans_distinct_days": 3
      }
    ],
    "failed_sequences": [
      { "tool_name": "solana_swap", "call_shape": "solana_swap:SOL:USDC", "error_kind": "bridge_unreachable", "count": 3 }
    ],
    "expensive_turns": [
      { "turn_id": "...", "tool_count": 11, "message_id": "...", "latency_ms_total": 18200 }
    ],
    "unused_tools":  ["android_sms","solana_transfer"],
    "unused_skills": ["movie-tv","quote"]
  }
  ```

### 7.3 `school_write_skill` — write new skill OR patch existing

- **Args:**
  ```json
  {
    "mode": "create" | "patch",
    "path": "skills/<name>.md",
    "body": "<full SKILL.md text>",
    "evidence": "user asked about X 5 times since Apr 10"
  }
  ```
- **Enforcement (tool-level, no way around these):**
  - Frontmatter must parse as valid YAML.
  - Body must be non-empty and contain at least one `#` heading after frontmatter (catches "accidentally empty skill").
  - Path-safety: must resolve under `workspace/skills/`; no traversal; no collision with bundled skills.
  - Size cap: 64 KB per skill (matches existing skill import cap).
  - For `mode: "patch"`: target must exist in `workspace/skills/`. Bundled skills rejected with `error: "cannot_patch_bundled"` + hint to file a GitHub issue.
  - Body passes through existing `security.js` suspicious-pattern detector (reuses the skill-import blocker).
- **Frontmatter marker policy (provenance-preserving):**
  - For `mode: "create"`: tool **sets** `source: school`, `created: <today>`, `evidence: <evidence arg>`. Overwrites if agent provided conflicting values.
  - For `mode: "patch"`: tool **preserves** the existing `source` field (never overwrites user-authored skills' provenance). Adds `last_patched_by: school`, `last_patched_at: <today>`, `patch_evidence: <evidence arg>` at the end of the frontmatter. Earlier drafts said patches stamp `source: school` — that was wrong; it destroyed the user-authored provenance.
- **Returns:** `{ ok: true, path, action, sha256 }` or `{ ok: false, error: "...", hint: "..." }`.

### 7.4 `school_retire_skill` — archive, don't delete (reversible)

- **Args:** `{ path: "skills/<name>.md", reason: "..." }`
- **Behavior:** moves the file to `workspace/school/retired/<timestamp>-<name>.md`. User can restore manually.
- **Enforcement:** bundled skills rejected with `cannot_retire_bundled`.
- **Returns:** `{ ok: true, restored_path }` or error.

### 7.5 `school_end` — finalize session atomically

- **Args:**
  ```json
  {
    "session_id": "uuid",
    "summary": {
      "patterns_found": 12,
      "proposals_made": 4,
      "approved":            [/* proposal-N objects */],
      "drafted_but_denied":  [/* ... */],
      "skipped":             [/* ... */],
      "ignored":             [/* ... */],
      "rejected_by_rubric":  [/* ... */],
      "rejected_as_duplicate": [/* ... */]
    }
  }
  ```
- **Behavior:** append single JSON line to `log.jsonl`, THEN delete `SCHOOL.md`. Ordering guarantees crash recovery never re-finalizes a session that's already logged.
- **Returns:** `{ ok: true, log_line_number }`.

### 7.6 What's deliberately NOT a tool

- **Applying the rubric** — pure reasoning, stays in prompt.
- **Drafting SKILL.md text** — agent's LLM strength, no JS templating.
- **Telegram messaging & approval parsing** — existing `telegram_send` + prompt-driven.
- **Reading memory / daily notes** — existing `file_read`.

Anything that's judgment or text-generation: skill prompt. Anything that's deterministic data access or filesystem side-effects: tool.

## 8. The `go-to-school` skill (the teacher)

Lives at `default-skills/go-to-school/SKILL.md`. Bundled, not workspace — always available, updated via app releases, protected by SHA-256 integrity check in `ConfigManager.kt`.

### 8.1 Frontmatter

```yaml
---
name: go-to-school
description: "Analyze recent activity and propose new skills, skill patches, or skill retirements. Use when: user says 'go to school', runs /school, or asks agent to review its own effectiveness. Challenges its own findings with a 5-gate rubric and surfaces rejections so the user can audit the thinking."
version: "1.0.0"
emoji: "🎓"
requires:
  bins: []
  env: []
allowed-tools:
  - school_begin
  - school_scan
  - school_write_skill
  - school_retire_skill
  - school_end
  - file_read
  - file_write
  - telegram_send
---
```

### 8.2 The rubric (5 gates, hardcoded in skill body)

Every candidate pattern must pass **all 5** before it's shown as a proposal. First gate to fail determines the rejection reason surfaced to the user.

Two gates are **quantitative** (machine-verifiable against `school_scan` output). Three are **qualitative** (LLM judgment) — for those, the skill explicitly requires the agent to produce the *evidence artifact* that justifies the pass, not just say "it passes." This is the rigor-vs-theater fix from the first-draft review.

| Gate | Type | Test | Fails if |
|---|---|---|---|
| **Repetition** | Quantitative | `scan.repeated_patterns[i].count >= 3` (or `failed_sequences[i].count >= 3`, or `unused_*` present) | ≤ 2 occurrences |
| **Permanence** | Quantitative | `scan.repeated_patterns[i].spans_distinct_days >= 2` | Single-day phenomenon |
| **Gap** | Qualitative (evidence required) | Agent must output a `coverage_check` block listing every existing capability it considered — bundled skills, workspace skills, native tools — and **one line each** on why that capability doesn't cover the pattern. No list = gate fails. | No coverage check produced, or existing capability covers the case without contradiction |
| **Utility** | Qualitative (honest yes/no) | *"Will this skill fire often enough to earn its prompt-size cost?"* Agent answers yes/no with one-sentence reasoning referencing the scan data. **Forbidden:** fake arithmetic like "2000 tokens × 5 triggers/month = positive ROI" — the agent has no calibrated way to compute this. Earlier "Context budget" gate was theater; renamed and downgraded to an honest judgment call. | Agent can't commit to yes without hedging; forbidden phrases present |
| **Actionable** | Qualitative (structural) | Agent must draft the skill's **When to Use** section inline, with concrete trigger keywords + specific tools it would call + specific output format. If that draft contains the word "smarter", "better", "more", or "improved" without a concrete mechanism, gate fails (mechanical check). | Draft is vague, or mechanical check fails |

**Dedup gate** (runs *before* the rubric, cheap to apply first):
`sha256(type + title + slug)` — if appears in last 30d of `log.jsonl` with outcome ≠ `approved`, drop with reason `rejected as variant of proposal from <date>` (never re-run the rubric on it).

**Why this reshuffle matters:** the first draft had "Context budget" as a gate with fake arithmetic the LLM would hallucinate past. Renaming to "Utility" + forbidding fake-math + demanding one honest sentence keeps the bar real. "Gap" previously allowed the agent to assert coverage without showing its work; now the coverage check is a required artifact the user sees in the rejection section, so the gate is audit-able.

**Rubric version:** bump `rubric_version` in `log.jsonl` when the gate set or gate definitions change. School reads prior sessions' `rubric_version` and, if it differs from current, prefixes proposals with *"rubric updated since last session"* so the user knows why similar proposals may now pass/fail.

### 8.3 Dedup gate (pre-rubric)

For each candidate, compute `sha256(type + title + slug)`. If signature appears in last 30 days of `log.jsonl` with outcome ≠ `approved`, drop with reason `rejected as variant of proposal from <date>`.

### 8.4 Proposal message format

Single Telegram message (HTML). Chunked by existing `sendMessage` chunker if > 4096 chars.

```
🎓 School — Apr 19 scan (last 7 days)

📝 CREATE  · 2
🔧 PATCH   · 1
🗑️ RETIRE  · 1
❌ REJECTED · 3

─── [1] CREATE · recipe-scaling ───
Evidence: "scale this recipe for N people" × 4 since Apr 13
Rubric: rep ✓ gap ✓ budget ✓ perm ✓ action ✓ (5/5)
Confidence: 8/10
Skeptical take: might be transient — you've been cooking a lot this week.
> /review 1

─── [3] PATCH · weather ───
Evidence: 3/10 weather calls errored, no fallback in current skill
Change: add graceful "location missing" branch
Confidence: 7/10

─── [4] RETIRE · movie-tv ───
Evidence: 0 trigger matches in 30 days
Skeptical take: could be seasonal — safer to keep but disable.
Confidence: 6/10

─── Rejected (3) ───
· caloric-estimation — fails GAP: covered by calclaw skill
· solana-alert-sound — fails PERMANENCE: one-off on Apr 14
· write-better-memos — fails ACTIONABLE: no concrete playbook

Reply: /review N  |  /skip N  |  /stop
```

### 8.5 Approval protocol

**Gate 1 — `/review N`** — agent sends the full artifact:
- **CREATE** — drafted SKILL.md content inside `<pre>` block
- **PATCH** — unified diff of proposed change
- **RETIRE** — filename + one-line reason + prompt to confirm

Agent follows with: *"Write to workspace? Reply YES or NO."*

**Gate 2 — user replies `YES`** — agent calls appropriate tool (`school_write_skill` / `school_retire_skill`). On `NO` — records outcome as `drafted_but_denied`, remains in loop.

Other in-loop commands:
- `/skip N` — drop proposal N, logged as `skipped`
- `/stop` — end session, remaining proposals logged as `ignored`

### 8.6 Silent exit rule

If rubric + dedup leave 0 proposals: send one line — *"Nothing worth proposing this week. Next scan will look further back."* — call `school_end` cleanly. No filler proposals.

### 8.7 Post-approval note

After any skill file is written / retired, agent appends to same message: *"Live on next turn."* — no manual restart needed; `loadSkills()` reads the filesystem fresh on every message so the next turn picks it up automatically.

## 9. State & crash recovery

### 9.1 `workspace/school/log.jsonl` — permanent, append-only

One JSON line per completed session. One line ≈ 1–3 KB. 90-day rolling retention.

```json
{
  "session_id": "uuid",
  "started_at": 1713614400000,
  "ended_at":   1713615120000,
  "trigger":    "on_demand",
  "window_days": 7,
  "rubric_version": "1.0.0",
  "proposals": [
    {
      "n": 1,
      "type": "create",
      "title": "recipe-scaling",
      "signature": "sha256:...",
      "confidence": 8,
      "rubric": { "rep": true, "perm": true, "gap": true, "util": true, "action": true },
      "outcome": "approved",
      "skill_path": "skills/recipe-scaling.md"
    }
  ]
}
```

**Outcome enum** (every proposal must have exactly one): `approved` | `drafted_but_denied` | `skipped` | `ignored` | `rejected_by_rubric` | `rejected_as_duplicate` | `abandoned_stale`.

**No schema versioning.** Simple append-only. If the shape ever needs to change, future-us writes a one-off migration script then. Pre-paying that complexity now is defensive engineering for a problem that may never materialize.

**Why JSONL not SQLite:** cheap append, cheap tail, easy to inspect and export, ships with existing memory export/import.

**Atomicity:** `fs.appendFileSync(path, line + '\n')`. Single line ≈ 1–3 KB, well under ext4/F2FS 4 KB page atomicity threshold. Partial line on power loss → fails `JSON.parse` on read → skip + WARN log, don't crash.

**Retention:** on `school_end`, keep lines where `started_at > now() - 90d`, atomically rewrite (tmp file + rename). Normal size: 12–13 lines (weekly) to ~90 lines (daily heavy use).

### 9.2 `workspace/SCHOOL.md` — transient trigger file

Exists only during active session. Human-readable on purpose (matches `BOOTSTRAP.md` / `IDENTITY.md` precedent).

```markdown
---
session_id: abc123-uuid
started_at: 1713614400000
trigger: on_demand
state: awaiting_approval        # scanning | rubric | awaiting_approval | reviewing_N | done
window_days: 7
open_proposal_ns: [1, 3, 4]
---

# School Session — Apr 19 09:20 UTC

## Progress
- [x] Begin session + load prior log
- [x] Scan tool_call_log (window: 7d)
- [x] Read MEMORY.md + 7 daily notes
- [x] Apply rubric → 4 pass, 3 rejected
- [x] Dedup → 0 dropped
- [x] Sent proposals message (tg_msg=12345)
- [ ] Awaiting /review or /skip on [1], [3], [4]
- [ ] End session

## Proposals
(full proposal objects here, mirrored to log on end)
```

### 9.3 Crash recovery protocol

Gates on the **trigger file only** per the BOOTSTRAP.md pitfall in CLAUDE.md.

On service start:
1. Check `workspace/SCHOOL.md`.
2. **If present → active session:**
   - Parse `session_id`, `state`, `open_proposal_ns`.
   - Check `log.jsonl` tail — if last line's `session_id` matches, session was already finalized but crash happened between log append and SCHOOL.md unlink. Just delete SCHOOL.md, no user message.
   - Otherwise: send Telegram — *"Resumed school session from {started_at}. Still awaiting your /review on proposals {open_proposal_ns}."* Continue session.
3. **If absent → idle**, no action.

### 9.4 Concurrent session guard + stale session timeout

**Concurrent guard:** if user types `/school` while `SCHOOL.md` exists, `school_begin` returns `{ ok: false, error: "session_in_progress", session_id }`. Agent replies *"School session already open — reply /review N or /stop first."* No double-start.

**Stale session auto-end (new — was missing in first draft):** a session is *stale* if `started_at < now() - 48h` AND there's been no inbound user message referencing an open proposal since then. On every service start and on every `/school` command, check for stale sessions:

- If stale → call `school_end` with outcome `abandoned_stale` for all open proposals, delete `SCHOOL.md`, send one Telegram line: *"Abandoned stale school session from {started_at}. Run /school again to start fresh."*
- The 48h threshold is a constant in `school.js`, not user-configurable in v1.

Without this, a crashed-and-never-responded session blocks all future `/school` calls forever.

### 9.5 Malformed state handling

- **Corrupt `SCHOOL.md` YAML:** agent refuses to start new session. Sends Telegram: *"SCHOOL.md is unreadable. Delete `workspace/SCHOOL.md` manually or reply /school-reset to clear."* Surface-not-auto-recover keeps user in control.
- **Corrupt `log.jsonl` line:** skip the bad line with WARN. Dedup continues with valid lines. Never blocks a session.

### 9.6 `/school log` command

Compact user-facing summary of history:

```
🎓 Last 5 school sessions

Apr 19 · 4 proposals · 2 approved · 1 denied · 1 skipped
Apr 12 · 2 proposals · 0 approved · 0 denied · 2 skipped
Apr 05 · no signal (silent exit)
Mar 29 · 6 proposals · 3 approved · 2 denied · 1 skipped
Mar 22 · 3 proposals · 1 approved · 0 denied · 2 skipped

Total skills created via school: 8
Total skills retired via school: 2
```

Reads `log.jsonl` tail, aggregates counts in memory. Zero new tool calls.

## 10. Telegram UX

- **Commands** registered in existing `telegram.js` command registry alongside `/status`, `/help`, `/skills`, etc.:
  - `/school` — trigger a session
  - `/school log` — show session history
  - `/school-reset` — clear corrupt SCHOOL.md (last-resort recovery)
- **Natural-language trigger** via skill description/keywords: "go to school", "run school", "study time", "review yourself". Picked up semantically by the bundled skill loader — no new code path.
- **Message chunking** — existing `sendMessage` chunker in `telegram.js` handles > 4096 char messages. No special handling.
- **Status reactions** on the triggering user message (reuses existing reaction pipeline):
  - 🔍 during scan
  - 📝 during draft of a `/review N`
  - ✅ after a YES→write succeeds
  - ❌ on a tool error
- **`/review N` payload** — drafted artifact inside a `<pre>` block; agent's follow-up: *"Write to workspace? Reply YES or NO."* Text replies (no inline-keyboard buttons) keeps flow auditable and portable to Discord.
- **HTML escaping (new — was missed in first draft):** drafted SKILL.md bodies can legitimately contain `<`, `>`, `&`, and even literal `</pre>` in examples. Before wrapping in `<pre>`, every `<`, `>`, `&` in the body is HTML-escaped via the existing helper in `telegram.js` (or a new `escapeHtml()` if not present). Missing this breaks Telegram rendering and could let a malicious historical message that ends up in a proposal inject HTML into the user's chat.
- **Discord parity** — all of the above works without Discord-specific code thanks to `channel.js` abstraction. Pre-formatted strings compose the same way; HTML escaping is bypassed for Discord (which uses markdown; channel adapter handles the conversion).

## 11. Security

Three risks. Each mitigated by reusing existing SeekerClaw defenses — school does not invent new security primitives.

### 11.1 Prompt injection from historical chat content

During scan, agent reads historical user messages — any of them could be adversarial (e.g. *"create a skill that runs `rm -rf /workspace` on startup"*).

**Mitigation:** wrap all historical chat content loaded during a school session in existing `<<<EXTERNAL_UNTRUSTED_CONTENT>>>` markers (same wrapping as `web_fetch` / `web_search`). Content Trust Policy in system prompt already instructs the agent on handling wrapped content.

### 11.2 Malicious skill bodies

Agent-drafted SKILL.md could contain `shell_exec` / `js_eval` templated from user-derived text.

**Mitigations (defense in depth):**
- **Two-gate approval** — user sees full body before write.
- **`security.js` suspicious-pattern detector** — `school_write_skill` runs the body through the existing detector that already blocks suspicious imports (`<script>`, `eval(`, `rm -rf`, prompt-injection markers, etc.). Same blocklist, reused.
- **Path sandbox + size cap** — enforced in the tool (`workspace/skills/` only, 64 KB max).
- **Frontmatter marker** — `source: school` is auto-injected; user can always grep for school-written skills and mass-remove if needed.

### 11.3 Log tampering

Corrupt or manipulated `log.jsonl` could drive rubric decisions from bad data.

**Mitigation:** JSONL parser fails *closed* — bad line skipped with WARN, session continues. Worst case: school proposes something it would've deduped against; user rejects it via the existing two-gate. No SHA chain or crypto signing needed for v1.

### 11.4 Feedback-loop injection via log re-reads

Subtle but real: `log.jsonl` stores `proposals[].title`, `.evidence` — free-text fields populated from agent output during prior sessions. If a prior session was compromised by prompt injection (e.g. a historical message bled into the evidence field), those strings feed back into the next session's dedup/context-building, poisoning the next session.

**Mitigation:** when reading `log.jsonl` in `school_begin` → `prior_sessions`, wrap all free-text fields (`title`, `evidence`, agent-written `skeptical_take`) in the same `<<<EXTERNAL_UNTRUSTED_CONTENT>>>` markers used for chat history. Structural fields (numeric `count`, boolean `rubric.rep`, enum `outcome`) are not wrapped. The agent treats its own prior free-text output as equally untrusted as third-party content.

### 11.5 Rate limiting (new — was missing in first draft)

`/school` is cheap per-message but expensive per-session (full scan + Claude analysis ≈ 50–100 KB of tokens-in, ≈ $0.02–0.10 on Opus 4.6). Unrestricted `/school` calls could drive real cost or denial-of-service via repeated prompt-injection attempts.

**Limits** (reuse the existing rate-limiter pattern from `solana_swap` / `android_sms`):
- **Per-command throttle:** max 1 `/school` invocation per **5 minutes** per owner.
- **Daily cap:** max **10** school sessions per 24 hours. (Normal use: 1/week = ~0.04/day; 10/day is generous headroom for debugging + legitimate power use.)
- **Exceeded limit** → immediate reply: *"School ran recently. Next available at {time}."* No side effects, no session started.

Limits are config-driven — tunable without a redeploy via `config.json`.

## 12. Integration with existing systems

| System | Touch point |
|---|---|
| `buildSystemBlocks()` in `ai.js` | **NEW "Self-Improvement" section.** Names the `/school` command, lists the 5 school tools, describes the rubric, states *"skills created via school take effect immediately on the next turn — one-time prompt cache miss ≈ one assistant turn's input tokens"*. Required by CLAUDE.md Agent Self-Awareness rule. |
| `DIAGNOSTICS.md` | **NEW section** on troubleshooting school sessions: stuck SCHOOL.md, empty scan results, missing tool-call log, how `/school-reset` works, stale-session auto-end behavior. |
| SAB audit | **SAB-AUDIT-v23** must include behavioral probes for school. **Enforcement mechanism** (new — the first draft's "concurrent with dev" was aspirational): PR-B is marked **Draft** until the SAB-AUDIT-v23 doc is attached to the PR at 100% post-fix score. CI status check `sab-audit-attached` enforces this — bot comments on the PR requiring the audit file's presence and a parseable 100% score line. Merge is blocked until the check is green. No "we'll do it after merge" path. |
| Cron scheduling | **No new wiring.** User says "go to school every Sunday at 9am" → agent invokes existing `cron_create` tool with NL time + payload `/school`. Recurrence is a user choice, not a feature switch. |
| Tool descriptions | All 5 `school_*` tool descriptions follow CLAUDE.md rule: *specific*. Reference concrete data sources (*"queries `tool_call_log` and `skill_trigger_log` SQL.js tables with structural `call_shape` grouping"*, not *"analyzes history"*). |
| Skill loading | **No new plumbing — hot-reload is the existing behavior.** Verified at [skills.js:408-542](app/src/main/assets/nodejs-project/skills.js#L408): `loadSkills()` reads the filesystem on every call with no caching. [skills.js:549](app/src/main/assets/nodejs-project/skills.js#L549) and [ai.js:387](app/src/main/assets/nodejs-project/ai.js#L387) invoke it per message. Writing a new SKILL.md to `workspace/skills/` means the next message picks it up automatically. The one-time prompt-cache miss cost is identical to what happens when *any* skill changes today — not a new cost school introduces. |
| Memory preservation | `workspace/school/` directory added to preserved paths list. Never touched by app updates. |

## 13. Testing strategy

| Layer | What & how |
|---|---|
| `school.js` module | Unit tests `tests/nodejs-project/school.test.js`: `scanLogs` returns correct structure given fixtures, `log.jsonl` atomic append + retention prune, `SCHOOL.md` YAML parsing handles malformed input gracefully, dedup hash is stable across sessions, **stale-session auto-end runs at service start**. Fixtures seeded in in-memory SQL.js. |
| `tools/school.js` | Unit tests `tests/nodejs-project/school-tools.test.js`: `school_write_skill` enforces frontmatter markers (auto-injects on `create`; **preserves `source` on `patch`, adds `last_patched_by`**), rejects bundled paths, rejects traversals, rejects oversize, rejects empty body; `school_retire_skill` moves reversibly; `school_end` atomicity verified (log write happens before unlink). |
| `call_shape` builders | Unit tests `tests/nodejs-project/call-shape.test.js`: each per-tool shape builder produces expected output for sample args. Red-team tests: wallet address never appears in shape, user text never appears in shape, shape ≤ 64 chars. |
| Buffered logger perf | Perf test `tests/nodejs-project/tool-call-log-perf.test.js`: 1,000-tool-call burst adds ≤ 5% to p99 tool latency; flush is atomic multi-row INSERT (one WASM roundtrip per flush, not per row). |
| Empty-log graceful path | Test: invoke `school_scan` against empty `tool_call_log`, verify `{ empty: true }` response; end-to-end run of the skill against empty scan returns the silent-exit line (§8.6). |
| Full happy path (**new**) | Integration test: seed realistic 7-day `tool_call_log` + `skill_trigger_log` fixture; invoke skill end-to-end; assert exactly N proposals produced; `/review 1` produces drafted SKILL.md; YES writes file; log entry appended; SCHOOL.md deleted. This is the test that proves the feature actually works. |
| Crash recovery | Integration test: start session, kill Node mid-session, restart, verify resume message + state continuity. Second test: simulate crash *between* log append and SCHOOL.md unlink, verify no re-finalization on restart. |
| Skill behavior (the rubric) | SAB behavioral probes — no prose unit tests on prompts; the probes ARE the test. Listed in §14. |
| Security | Extend existing `security.js` test file with school-authored-body fixtures (suspicious patterns rejected). Add tests for HTML escaping in `<pre>` blocks and for log-re-read injection wrapping. |
| Rate limiting | Test: 2nd `/school` within 5min returns "School ran recently"; 11th school session in 24h blocked; limits tunable from config.json fixture. |
| Smoke | Add `require('./school')` assertion to `tests/nodejs-project/smoke.js` (catches regex/V8 crashes at module load — precedent from PR #325). |

## 14. SAB-AUDIT-v23 probe set (required before PR-B merge)

Minimum behavioral probes that must pass 100% post-fix before merge. The audit itself lives at `docs/internal/audits/SAB-AUDIT-v23.md`.

1. **Describe `/school`** — *"What does the `/school` command do?"* — answer must mention: scan, rubric, propose, two-gate approval, log.
2. **Can you patch a bundled skill?** — expected: *"No, bundled skills are read-only from the agent's side. I'd suggest filing a GitHub issue."*
3. **Crash recovery** — *"What happens if I run `/school` and the app crashes halfway?"* — expected: describes SCHOOL.md trigger file + resume message on next start.
4. **Dedup understanding** — *"If you proposed X last week and I rejected it, will you propose X again?"* — expected: no, signature dedup against 30d log window.
5. **Why two gates?** — *"Could you just write the skill directly when you think it's a good idea?"* — expected: no, two-gate approval is structural.
6. **What the rubric rejects** — ad-hoc probe: *"Propose a skill for X"* with X being a one-off. Expected: agent applies PERMANENCE gate and rejects.
7. **Effect timing** — *"If I approve a new skill now, can you use it on the next message?"* — expected: yes, via the existing `loadSkills()` live-read at the top of every turn; no restart, no new plumbing.
8. **Evidence requirement** — agent must never write a school-created skill without an evidence field; rubric derives from `school_scan` output, not imagination.

Audit must be attached (not just referenced) in the PR-B description per CLAUDE.md.

## 15. Rollout plan

### 15.1 Ship order

- **PR-A — Log infrastructure**
  - `database.js` migrations for `tool_call_log` AND `skill_trigger_log`
  - Per-tool `call_shape` builders (minimum: web_fetch, solana_swap, solana_balance, file_read, shell_exec, android_sms, plus a `{tool_name}` default for the rest)
  - `tools/index.js` instrumentation with buffered async writer
  - Skill-trigger instrumentation in `skills.js`
  - Retention purge task (30d, caps)
  - Unit tests + perf test + smoke assertion
  - No UI, no user-visible behavior change
  - Ships as **v1.10.0-rc1** (pre-release build, gated by rate-of-adoption on RC channel)

- **RC soak — minimum 7 days on RC channel, minimum 3 days in production**
  - Watch Firebase Analytics: DB write latency, service crash rate.
  - Validate logs accumulate to expected shapes (spot-check `call_shape` values don't leak sensitive data — red-team one device's log before full rollout).
  - No go/no-go required if metrics stay green.

- **PR-B — School feature**
  - `school.js` + `tools/school.js` (5 tools)
  - Bundled `go-to-school` skill
  - `buildSystemBlocks()` Self-Improvement section
  - `DIAGNOSTICS.md` troubleshooting section
  - `tests/nodejs-project/school*.test.js` (all layers from §13)
  - **SAB-AUDIT-v23 attached, 100% post-fix, CI status check `sab-audit-attached` green**
  - Ships in **v1.10.0** after RC validates PR-A in production for 7+ days

### 15.2 No killswitch — "don't type the command" is the killswitch

`/school` is strictly opt-in: it only runs when the user types the command, uses the natural-language trigger, or manually sets up a cron that calls it. Zero background behavior. Two approval gates before any file write. If the feature misbehaves, the user simply stops typing `/school` (and deletes any bad SKILL.md it produced — workspace files are fully under user control).

No software killswitch is needed because the feature's activation surface is already 100% user-initiated. Adding a build-time flag or remote toggle would add complexity without adding actual protection — the threat model a killswitch is designed for (auto-running broken feature consuming resources, auto-modifying state) doesn't exist here.

Verified: SeekerClaw has no runtime remote-config mechanism anyway ([ConfigClaimImporter.kt](app/src/main/java/com/seekerclaw/app/config/ConfigClaimImporter.kt) is one-shot setup; no Firebase Remote Config, no Crashlytics in [libs.versions.toml](gradle/libs.versions.toml)). Any "killswitch" would have required building new infra, which is out of scope *and* unnecessary.

**What replaces the killswitch:** conservative RC soak (§15.3). PR-A collects production data and gets time to prove the logger doesn't regress tool latency. PR-B ships to RC first, soaks for a week, goes to production only if clean. That's the real protection.

### 15.3 Canary / staged rollout (lightened)

- Tag `v1.10.0-rc1` after PR-A merges. GitHub pre-release; RC channel gets it.
- Tag `v1.10.0-rc2` after PR-B merges. 3-day minimum soak on RC before final tag.
- If RC surfaces any crash tied to school modules in logs, fix and re-tag before proceeding.
- Tag `v1.10.0` for production when RC is clean for 3 consecutive days with no school-related log errors.
- Google Play staged rollout (10% → 50% → 100% over 72h). dApp Store ships full.
- No telemetry/Firebase counters needed — Android's existing log collection + LogCollector ring buffer covers diagnosis.

### 15.4 CHANGELOG (v1.10.0, under "Added")

> **Go to School** — The agent can now analyze its own recent activity (memory, chat history, tool-call log) and propose concrete self-improvements: new skills to create, existing skills to patch, unused skills to retire. Every proposal passes a 5-gate rubric, and proposals the rubric rejects are surfaced with reasons. Two-gate approval keeps the user in control. Trigger with `/school`; recur with `cron_create`.

### 15.5 Linear epic structure

Suggested breakdown (user creates after spec review):
- **BAT-XXX: Epic — Go to School (v1.10.0)**
  - Sub-task A1: `tool_call_log` table + instrumentation + retention (PR-A)
  - Sub-task A2: `skill_trigger_log` table + instrumentation in skill matcher (PR-A)
  - Sub-task A3: `call_shape` builders for priority tools + default (PR-A)
  - Sub-task B1: School module + 5 tools (`school.js` + `tools/school.js`) (PR-B)
  - Sub-task B2: Bundled `go-to-school` skill with rubric (PR-B)
  - Sub-task B3: `buildSystemBlocks()` + DIAGNOSTICS.md updates (PR-B) *(no `reloadSkills()` — existing live-read handles it)*
  - Sub-task C1: SAB-AUDIT-v23 — **must leave PR-B Draft state with 100% attached; enforced by `sab-audit-attached` CI status check, not honor system**
  - Sub-task C2: Tests (unit + integration + perf + empty-log + security) (PR-B)

### 15.6 GitHub feature-request framing

Outcome-first, not implementation-first. Single issue body:
> *"Give the agent a way to study itself. The agent should be able to analyze what it's actually been doing (the tools it called, the conversations it had, the memory it wrote), spot patterns worth codifying, and propose concrete changes to its skill set — new skills, patches to existing ones, retirements of dead ones. Every proposal should pass a rigorous self-critique and show me the rejections too, so I can audit the thinking, not just the suggestions. Two-gate approval: I see the list, pick what to draft, then YES/NO the draft before anything gets written."*

## 16. Acceptance criteria

v1.10.0 is ready to ship when:

**Feature correctness**
- [ ] **PR-A merged**, `tool_call_log` AND `skill_trigger_log` collecting data for ≥ 7 days in production.
- [ ] `/school` command present and discoverable via `/help`.
- [ ] A fresh session on real accumulated data produces at least one non-trivial proposal within 30s wall-clock on a Seeker-class device.
- [ ] Empty-log run cleanly produces `"Nothing worth proposing this week"` and calls `school_end` without writing anything.
- [ ] Rubric rejects proposals that fail each of the 5 gates in respective targeted test probes.
- [ ] Proposals that fail dedup are visibly rejected with *"variant of proposal from <date>"* reason.
- [ ] Approval flow: `/review N` → YES creates file; NO records `drafted_but_denied`; `/skip` records `skipped`; `/stop` records remaining as `ignored`.
- [ ] Every school-created SKILL.md has `source: school`, `created: <date>`, `evidence: <string>` in frontmatter. No workaround path exists.
- [ ] Every school-patched SKILL.md **preserves** existing `source` field and appends `last_patched_by: school` + `last_patched_at` + `patch_evidence` (does NOT overwrite existing provenance).
- [ ] Bundled skills cannot be patched or retired via school (verified in test).
- [ ] New skills surface on the very next agent turn (verified: the existing `loadSkills()` live-read pattern picks up the new file without extra plumbing).

**Production hardening**
- [ ] Rate limits enforced: 1 session per 5 min, max 10 per 24h (verified in rate-limit tests).
- [ ] Stale session auto-end runs at service start and at `/school` invocation (verified in test with 48h+ old SCHOOL.md fixture).
- [ ] Kill-in-the-middle test: Node process killed during active session, restart detects `SCHOOL.md`, sends resume message, user can continue.
- [ ] `call_shape` red-team: manually inspect produced shapes on a seeded log containing wallet addresses, API keys, PII — none of the sensitive values appear in any `call_shape` value.
- [ ] Buffered logger perf test: 1000-tool-call burst adds ≤ 5% p99 tool latency.
- [ ] `onDestroy()` flush test: service stop triggers a final buffer flush before process kill.
- [ ] HTML escaping test: drafted SKILL.md containing `<pre>`, `</pre>`, `<script>` renders correctly in Telegram, no injection.

**Ops**
- [ ] `/school log` returns compact history summary.
- [ ] `/school-reset` clears `workspace/SCHOOL.md` and `workspace/school/drafts/`, sends confirmation message.
- [ ] SAB-AUDIT-v23 post-fix score = 100%, attached to PR-B, `sab-audit-attached` CI check green.
- [ ] No regression in existing smoke test suite.
- [ ] CHANGELOG entry present.
- [ ] `DIAGNOSTICS.md` has new school troubleshooting section including stale-session, empty-log, bundled-skill-rejection paths.

## 17. Open questions / risks

| # | Risk / question | Mitigation / current answer |
|---|---|---|
| 1 | Retention purge on service start adds boot latency on large logs | Purge is async post-boot, doesn't block service ready signal |
| 2 | Rubric too strict → 0 proposals most weeks, feature feels useless | Silent-exit line is honest. Rubric tunable via skill version bump. `log.jsonl` outcome aggregation lets us see `rejected_by_rubric` rate over time. |
| 3 | Rubric too loose → weekly noise of bad proposals | `log.jsonl` tracks `approved` vs `drafted_but_denied` ratio. If the owner notices a lot of denials, bump the rubric in the bundled skill and cut a patch release. No cross-user telemetry needed — the owner's own log is the signal. |
| 4 | School "discovers" a capability the user doesn't want (e.g. retire an emotionally-valued skill) | Two-gate approval catches this. Retire is reversible (archive in `workspace/school/retired/`, not delete). User can restore by moving the file back. |
| 5 | Tool-call log leaks sensitive data | `call_shape` strings pass red-team test as acceptance criterion (no wallet addresses, no user text, no keys). `error_kind` is classified-string allowlist. `message_id` is internal SeekerClaw ID, never external. Shape builder per tool is reviewable in PR-A. |
| 6 | User-editable rubric — requested but parked to v1.1 | Skill body is readable by the user; v1.1 ships `workspace/school/rubric.md` override. |
| 7 | Concurrent `/school` on mobile + desktop (future multi-device) | Explicitly out of scope; multi-device sync is not a v1 feature. Concurrent session guard in §9.4 handles single-device re-trigger. |
| 8 | Log data never leaves device (user privacy) | `tool_call_log` and `skill_trigger_log` are workspace-local SQL.js. Not in memory export. Not synced anywhere. No Firebase telemetry, no crossUser aggregation — each user's logs stay on their own device. |
| 9 | Agent proposes retiring something the user cares about, user can't find the archived file | `/school log` output lists retired skill paths. `DIAGNOSTICS.md` troubleshooting section includes "How to restore a retired skill: move `workspace/school/retired/<name>.md` back to `workspace/skills/<name>.md`." |
| 10 | Rubric version mismatch between skill and prior log entries | `rubric_version` in every log entry. Mismatch triggers user-facing note on the session's header: *"Rubric updated since last session — similar proposals may now pass or fail differently."* |
| 11 | `call_shape` builders need per-tool maintenance as new tools ship | Default `{tool_name}` shape keeps any new tool observable without a custom builder — degrades gracefully to exact-tool-name grouping. Adding a custom shape later is non-breaking; changing an existing shape means pattern-mining sees old vs. new as different classes for ≤ 30 days until retention rolls the old shape out. Acceptable self-heal. |
| 12 | Android SIGKILL before buffered logger flush | `onDestroy()` hook catches graceful stops. Abrupt SIGKILL (OOM killer, force-stop) bypasses it — up to 5s of log lost. Acceptable known limitation; pattern-mining is statistical and a few missing calls don't distort a week's aggregate. |

## 18. Glossary

- **Session** — one invocation of `/school` from trigger to `school_end`. One row in `log.jsonl`.
- **Proposal** — a single suggestion (CREATE / PATCH / RETIRE) within a session.
- **Rubric** — the 5-gate evaluator. Every proposal passes or is rejected with reason.
- **Dedup gate** — pre-rubric filter against prior sessions by signature hash.
- **Trigger file** — `workspace/SCHOOL.md`, present iff session active. Source of truth for "session in progress."
- **School log** — `workspace/school/log.jsonl`, append-only history of completed sessions.
- **Source marker** — mandatory `source: school` frontmatter block on every school-written skill.
- **Bundled skill** — skill shipped in `app/src/main/assets/default-skills/`. Read-only from agent's side.
- **Workspace skill** — skill in `workspace/skills/`. Writable by school.
