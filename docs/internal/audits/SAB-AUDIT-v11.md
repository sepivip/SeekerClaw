# SAB-AUDIT-v11 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-03-07
> **Scope:** Re-audit after BAT-322 (temporal context awareness — sessions table, Recent Sessions prompt block, backfill migration)
> **Method:** Full read of buildSystemBlocks() + constants verification + diagnostic coverage map
> **Baseline:** SAB-AUDIT-v10.md (111/111, 100%)

---

## Overall Scorecard

| Section | Pre-fix | Post-fix | Max | Percentage | Delta |
|---------|---------|----------|-----|-----------|-------|
| A: Knowledge & Doors | 63 | 63 | 63 | 100% | — (held) |
| B: Diagnostic Coverage | 48 | 48 | 48 | 100% | — (held) |
| **Combined** | **111** | **111** | **111** | **100%** | — |

Scoring: ✅ = 3 pts, ⚠️ = 1 pt, ❌ = 0 pts.

---

## Constants Verification

| Constant | Code Value | Prompt Claim | Match |
|----------|-----------|-------------|-------|
| MAX_TOOL_USES | 25 (claude.js:1500) | "Up to 25 tool-call rounds" (line 855) | ✅ |
| MAX_HISTORY | 35 (claude.js:172) | "35 messages per chat" (line 854) | ✅ |
| max_tokens | 4096 (claude.js:~1515) | "4096 tokens per response" (line 856) | ✅ |
| SHELL_ALLOWLIST | 34 commands (config.js:241-248) | 34 commands listed (line 649) | ✅ |
| SECRETS_BLOCKED | config.json, config.yaml, seekerclaw.db (config.js:232) | seekerclaw.db listed as BLOCKED (line 565) | ✅ |
| BLOCKED_MODULES | 7 modules (tools.js) | Lists all 7 (line 422) | ✅ |
| js_eval code limit | 10,000 chars (tools.js) | "10,000-character code limit" (line 650) | ✅ |

---

## Section A: Knowledge & Doors (21 items)

### Changes Since v10

BAT-322 adds temporal context awareness. Evaluated against the 3-part door test:

| Change | What Shipped | New Door? | Reason |
|--------|-------------|-----------|--------|
| Sessions table in SQL.js | Persists session timing metadata | No | Infrastructure — agent doesn't need to know about the table directly |
| Recent Sessions prompt block | Injected into system prompt (lines 732-750) | No | Self-documenting — the block IS the door; agent reads it automatically |
| Backfill migration | One-time upgrade path for existing users | No | Transparent migration, agent never interacts with it |
| Summary excerpt in DB | Avoids per-turn file I/O | No | Performance optimization, transparent to agent |
| relativeTimeLabel() | Human-readable time formatting | No | Infrastructure — output visible in prompt block |

**0 new doors added.** The "Recent Sessions" block (lines 732-750) is self-documenting — it contains behavioral guidance ("Use this to: pick up where you left off...") directly in the prompt. The existing "Session Memory" section (lines 842-849) remains accurate for describing how summaries are saved.

Item count remains at 21.

### Full Item Scores

**Identity (5/5)**

| # | Item | v8 | v9 | v10 | v11 | Notes |
|---|------|----|----|-----|------|-------|
| 1 | Own name/version | ✅ | ✅ | ✅ | ✅ | Lines 381-382 |
| 2 | Model | ✅ | ✅ | ✅ | ✅ | PLATFORM.md + line 570 |
| 3 | Device/hardware | ✅ | ✅ | ✅ | ✅ | PLATFORM.md |
| 4 | Who built it | ✅ | ✅ | ✅ | ✅ | Line 383 (OpenClaw) |
| 5 | Official channels | ✅ | ✅ | ✅ | ✅ | Line 384 |

**Architecture (4/4)**

| # | Item | v8 | v9 | v10 | v11 | Notes |
|---|------|----|----|-----|------|-------|
| 6 | Node-Kotlin bridge | ✅ | ✅ | ✅ | ✅ | Lines 388-393 |
| 7 | UI vs :node process | ✅ | ✅ | ✅ | ✅ | Lines 389-391 |
| 8 | Health monitoring | ✅ | ✅ | ✅ | ✅ | Lines 588-593 |
| 9 | Telegram polling | ✅ | ✅ | ✅ | ✅ | Lines 447-451 |

**Capabilities (4/4)**

| # | Item | v8 | v9 | v10 | v11 | Notes |
|---|------|----|----|-----|------|-------|
| 10 | Full tool list | ✅ | ✅ | ✅ | ✅ | Lines 405-426 |
| 11 | Sandboxed tools | ✅ | ✅ | ✅ | ✅ | Line 422 (7 blocked modules) |
| 12 | What it cannot do | ✅ | ✅ | ✅ | ✅ | Lines 835-840 |
| 13 | Skills load/trigger | ✅ | ✅ | ✅ | ✅ | Lines 465-478 |

**Configuration (4/4)**

| # | Item | v8 | v9 | v10 | v11 | Notes |
|---|------|----|----|-----|------|-------|
| 14 | Config files | ✅ | ✅ | ✅ | ✅ | Lines 554-566 |
| 15 | Settings agent can change | ✅ | ✅ | ✅ | ✅ | Lines 568-585 |
| 16 | API keys needed | ✅ | ✅ | ✅ | ✅ | Lines 570-572 |
| 17 | Model/heartbeat change | ✅ | ✅ | ✅ | ✅ | Line 570 |

**Self-Diagnosis (4/4)**

| # | Item | v8 | v9 | v10 | v11 | Notes |
|---|------|----|----|-----|------|-------|
| 18 | Health stale | ✅ | ✅ | ✅ | ✅ | Lines 637-641 |
| 19 | Telegram disconnects | ✅ | ✅ | ✅ | ✅ | Lines 624-629 |
| 20 | Skill fails | ✅ | ✅ | ✅ | ✅ | Lines 631-635 |
| 21 | Conversation corruption | ✅ | ✅ | ✅ | ✅ | Lines 643-647 |

**Section A Total: 63/63 (100%)**

---

## Section B: Diagnostic Coverage (16 failure modes)

All 16 failure modes from v10 held at ✅. No regressions.

| # | Subsystem | Failure Mode | v8 | v9 | v10 | v11 | Coverage Location |
|---|-----------|-------------|----|----|-----|------|-------------------|
| 1 | Telegram | Bot token invalid/revoked | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md |
| 2 | Telegram | Rate limited (429) | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md |
| 3 | LLM API | Transport timeout | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md |
| 4 | LLM API | Context overflow | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md |
| 5 | Tools | Confirmation gate timeout | ✅ | ✅ | ✅ | ✅ | System prompt lines 507-511 |
| 6 | Tools | Tool result truncated | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md |
| 7 | Memory | memory_save fails (fs full) | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md |
| 8 | Memory | memory_search returns nothing | ✅ | ✅ | ✅ | ✅ | System prompt lines 515-521 |
| 9 | Cron | Job fails to send reminder | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md |
| 10 | Cron | Jobs lost after restart | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md |
| 11 | Bridge | Service down (ECONNREFUSED) | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md |
| 12 | Bridge | Permission-specific errors | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md |
| 13 | MCP | Server unreachable | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md |
| 14 | MCP | Tool definition changed (rug-pull) | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md |
| 15 | MCP | Rate limit exceeded | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md |
| 16 | Skills | Requirements not met | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md |

**Section B Total: 48/48 (100%)**

### New Failure Modes Check

| Change | Potential Failure Mode | Assessment |
|--------|----------------------|------------|
| Sessions table | DB init fails | Already covered — `CREATE TABLE IF NOT EXISTS` inside existing `initDatabase()` which has full error handling + corruption recovery. Non-fatal if SQL.js unavailable |
| getRecentSessions() | DB query fails | Returns `[]` (graceful fallback) — prompt block simply doesn't render. Not a diagnosable failure |
| backfillSessionsFromFiles() | Malformed summary files | Each file wrapped in try/catch with `continue`. Non-fatal, logged as WARN |
| saveSession() | DB write fails | Non-fatal, logged as WARN. Summaries still saved to files — only DB metadata lost |

No new failure modes to add. All BAT-322 code paths have non-fatal error handling with graceful degradation.

---

## Gaps Fixed

None. No changes to system prompt or DIAGNOSTICS.md were needed.

---

## Code Issues Found

None.

---

## Remaining Gaps

**None.** All 21 knowledge items and all 16 diagnostic failure modes score ✅. The "Recent Sessions" block (lines 732-750) is self-documenting and requires no additional door — it contains its own behavioral guidance.

---

## Observations

1. **Self-documenting feature.** BAT-322 is a rare case where the feature IS the system prompt change. The "Recent Sessions" block injects both the data and the behavioral guidance directly into the prompt. No separate door needed.

2. **Graceful degradation.** Every new code path (`saveSession`, `getRecentSessions`, `backfillSessionsFromFiles`) returns silently on failure. If SQL.js is unavailable, the agent simply doesn't see the "Recent Sessions" block — no error, no confusion.

3. **No prompt bloat.** The block only renders when sessions exist (~100-150 tokens for 5 sessions). New installs see zero additional tokens until their first session summary fires.

4. **Session Memory section accuracy.** Lines 842-849 ("Session Memory") describe how summaries are saved. Lines 732-750 ("Recent Sessions") describe what the agent sees. The two sections are complementary, not redundant.

5. **8 consecutive 100% audits** (v4-v11 post-fix).

---

## Score Progression

```
        Knowledge (Section A)               Diagnostics (Section B)
v1  ████████████████████░░░░░░░░░░  42/60  (70%)    (not audited)
v2  ████████████████████████████░░  56/60  (93%)    (not audited)
v3  ██████████████████████████████  60/60 (100%)    (not audited)
v4  ██████████████████████████████  60/60 (100%)    ██████████████████████████████  48/48 (100%)
v5  ██████████████████████████████  60/60 (100%)    ██████████████████████████████  48/48 (100%)
v6  ██████████████████████████████  63/63 (100%)    ██████████████████████████████  48/48 (100%)
v7  ██████████████████████████████  63/63 (100%)    ██████████████████████████████  48/48 (100%)
v8  ██████████████████████████████  63/63 (100%)    ██████████████████████████████  48/48 (100%)
v9  ██████████████████████████████  63/63 (100%)    ██████████████████████████████  48/48 (100%)
v10 ██████████████████████████████  63/63 (100%)    ██████████████████████████████  48/48 (100%)
v11 ██████████████████████████████  63/63 (100%)    ██████████████████████████████  48/48 (100%)

Combined SAB Score:
v1  ██████████████████████████████░░░░░░░░░░░░░░░░░░░░  42/60   (70%)
v2  ██████████████████████████████████████████████░░░░  56/60   (93%)
v3  ██████████████████████████████████████████████████  60/60  (100%)
v4  ██████████████████████████████████████████████████ 108/108 (100%)
v5  ██████████████████████████████████████████████████ 108/108 (100%)  [SHELL_ALLOWLIST 22->34]
v6  ██████████████████████████████████████████████████ 111/111 (100%)  [+Official channels]
v7  ██████████████████████████████████████████████████ 111/111 (100%)  [DIAGNOSTICS.md MCP rate fix]
v8  ██████████████████████████████████████████████████ 111/111 (100%)  [enriched restart flushing door]
v9  ██████████████████████████████████████████████████ 111/111 (100%)  [fixed stale js_eval sandbox desc]
v10 ██████████████████████████████████████████████████ 111/111 (100%)  [DIAGNOSTICS.md provider-agnostic header]
v11 ██████████████████████████████████████████████████ 111/111 (100%)  [BAT-322 self-documenting, no fixes needed]
```

---

## Methodology

- **Source-only audit** — all scores derived from code reads, no runtime testing
- **Files read:** claude.js buildSystemBlocks() (lines 335-900), database.js (BAT-322 changes: lines 122-460), SAB-AUDIT-v10.md (baseline)
- **Constants verified:** MAX_TOOL_USES=25, MAX_HISTORY=35, max_tokens=4096, SHELL_ALLOWLIST=34 commands, SECRETS_BLOCKED=3 files, BLOCKED_MODULES=7 modules, js_eval code limit=10,000 chars
- **Syntax verified:** `node -c claude.js` — pass, `node -c database.js` — pass
