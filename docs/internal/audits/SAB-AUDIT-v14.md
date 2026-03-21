# SAB-AUDIT-v14 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-03-22
> **Scope:** Re-audit after DeerFlow Phase 1 (BAT-474: loop detection, memory scrubbing), DeerFlow Phase 2 (BAT-475: context summarization, deferred tool loading), js_eval sandbox hardening (BAT-466), emulator IP gate (BAT-467), tools/ refactor (BAT-470), multi-provider QR import (BAT-471), v1.7.0 release.
> **Method:** Full read of buildSystemBlocks() + constants verification + diagnostic coverage map + high-risk tool consistency spot-check
> **Baseline:** SAB-AUDIT-v13.md (141/141, 100%)
> **SAB Version:** v2

---

## Overall Scorecard

| Section | Pre-fix | Post-fix | Max | Percentage | Delta from v13 |
|---------|---------|----------|-----|-----------|----------------|
| A: Knowledge & Doors | 63 | 69 | 69 | 100% | +3 (1 new door) |
| A: Negative Knowledge (sub) | 6/6 | 6/6 | 6 | 100% | — (held) |
| B: Diagnostic Coverage | 48 | 48 | 48 | 100% | — (held) |
| C: Tool Consistency | 27 | 30 | 30 | 100% | +3 (1 new tool) |
| **Combined** | **138** | **147** | **147** | **100%** | +6 (1 new door + 1 new tool + 2 fixes) |

Scoring: ✅ = 3 pts, ⚠️ = 1 pt, ❌ = 0 pts.

---

## Constants Verification

| Constant | Code Value | Prompt Claim | Match |
|----------|-----------|-------------|-------|
| MAX_TOOL_USES | 25 (claude.js:1862) | "Up to 25 tool-call rounds" (line 923) | ✅ |
| MAX_HISTORY | 35 (claude.js:173) | "35 messages per chat" (line 922) | ✅ |
| max_tokens | 4096 (claude.js:1914) | "4096 tokens per response" (line 924) | ✅ |
| SHELL_ALLOWLIST | 34 commands (config.js:253-260) | 34 commands listed (line 714) | ✅ |
| SECRETS_BLOCKED | config.js, config.json, config.yaml, seekerclaw.db (config.js:244) | seekerclaw.db listed as BLOCKED (line 629) | ✅ |
| BLOCKED_MODULES | 7 modules (tools/system.js:261) | Lists all 7 (line 468) | ✅ |
| js_eval code limit | 10,000 chars (tools/system.js) | "10,000-character code limit" (line 715) | ✅ |
| CONFIRM_REQUIRED | 8 tools (config.js:268-277) | 8 tools listed (line 562) | ✅ |
| LOOP_WARN_THRESHOLD | 3 (loop-detector.js:5) | "3 times...warning" (line 711) | ✅ |
| LOOP_BREAK_THRESHOLD | 5 (loop-detector.js:6) | "5 identical calls...broken" (line 711) | ✅ |
| CONTEXT_SUMMARIZE_THRESHOLD | 0.85 (claude.js:1473) | "~85%...summarized" (line 925) | ✅ |

---

## Section A: Knowledge & Doors (23 items)

### Changes Since v13

| Commit | Feature | New Door? | Reason |
|--------|---------|-----------|--------|
| BAT-474 Loop detection | DeerFlow P1: identical tool call detection (warn@3, break@5) | **Yes** | Agent needs to know why tool execution was forcibly stopped |
| BAT-474 Memory scrubbing | Session noise stripped before persist | No | Transparent — happens in memory_save/daily_note pipeline |
| BAT-475 Context summarization | DeerFlow P2: 85% threshold summarization before trim | **Fix** | Agent needs to know messages are summarized, not just dropped |
| BAT-475 Deferred tool loading | tool_search + Tool Discovery section (non-Claude only) | No | Already in prompt (lines 487-491), conditionally shown |
| BAT-466 js_eval sandbox | Function constructor shadows, path blocking, redaction | No | Already covered by existing sandbox description (line 468) |
| BAT-467 Emulator IP gate | Kotlin-side only, blocks 10.0.2.2 in production | No | Not agent-visible |
| BAT-470 tools/ refactor | Split tools.js into 12 modular files | No | Internal refactor, no behavior change |
| BAT-471 QR import | Multi-provider QR support in Android setup | No | Not agent-visible |
| v1.7.0 release | Version bump to 1.7.0 (code 14) | No | PLATFORM.md auto-generates version info |

**1 new door added** — Loop detector (line 711). **1 fix applied** — Context summarization (line 925). Item count: 22 → 23.

### Full Item Scores

**Identity (5/5)**

| # | Item | v12 | v13 | v14 | Notes |
|---|------|------|------|------|-------|
| 1 | Own name/version | ✅ | ✅ | ✅ | Lines 425-426 |
| 2 | Model | ✅ | ✅ | ✅ | PLATFORM.md + line 634 |
| 3 | Device/hardware | ✅ | ✅ | ✅ | PLATFORM.md |
| 4 | Who built it | ✅ | ✅ | ✅ | Line 427 (OpenClaw) |
| 5 | Official channels | ✅ | ✅ | ✅ | Line 428 |

**Architecture (4/4)**

| # | Item | v12 | v13 | v14 | Notes |
|---|------|------|------|------|-------|
| 6 | Node-Kotlin bridge | ✅ | ✅ | ✅ | Lines 432-437 |
| 7 | UI vs :node process | ✅ | ✅ | ✅ | Lines 433-435 |
| 8 | Health monitoring | ✅ | ✅ | ✅ | Lines 653-658 |
| 9 | Telegram polling | ✅ | ✅ | ✅ | Lines 501-505 |

**Capabilities (6/6)**

| # | Item | v12 | v13 | v14 | Notes |
|---|------|------|------|------|-------|
| 10 | Full tool list | ✅ | ✅ | ✅ | Lines 449-472 |
| 11 | Sandboxed tools | ✅ | ✅ | ✅ | Line 468 (7 blocked modules) |
| 12 | What it cannot do | ✅ | ✅ | ✅ | Lines 609-616 (6 boundaries) |
| 13 | Skills load/trigger | ✅ | ✅ | ✅ | Lines 518-535 |
| 22 | OpenRouter provider | — | ✅ | ✅ | Lines 892-899: model, fallback info |
| **23** | **Loop detector (NEW)** | — | — | ✅ | **Line 711:** warn@3, break@5 identical calls. Agent knows why it was stopped. |

**Configuration (4/4)**

| # | Item | v12 | v13 | v14 | Notes |
|---|------|------|------|------|-------|
| 14 | Config files | ✅ | ✅ | ✅ | Lines 618-630 |
| 15 | Settings agent can change | ✅ | ✅ | ✅ | Lines 632-650 |
| 16 | API keys needed | ✅ | ✅ | ✅ | Lines 634-636 |
| 17 | Model/heartbeat change | ✅ | ✅ | ✅ | Line 634 |

**Self-Diagnosis (4/4)**

| # | Item | v12 | v13 | v14 | Notes |
|---|------|------|------|------|-------|
| 18 | Health stale | ✅ | ✅ | ✅ | Lines 701-706 |
| 19 | Telegram disconnects | ✅ | ✅ | ✅ | Lines 688-694 |
| 20 | Skill fails | ✅ | ✅ | ✅ | Lines 695-700 |
| 21 | Conversation corruption | ✅ | ✅ | ✅ | Lines 707-711 (enhanced with loop detector) |

**Section A Total: 69/69 (100%)**

### Negative Knowledge Sub-Check

| # | Boundary | v13 | v14 | Notes |
|---|----------|------|------|-------|
| 1 | No internet browsing | ✅ | ✅ | Line 610 |
| 2 | No image/audio/video generation | ✅ | ✅ | Line 611 |
| 3 | No direct cloud/infra access | ✅ | ✅ | Line 612 |
| 4 | No cross-device reach | ✅ | ✅ | Line 613 |
| 5 | No persistent background execution | ✅ | ✅ | Line 614 |
| 6 | No real-time data without tools | ✅ | ✅ | Line 615 |

**Negative Knowledge: 6/6 (held)**

---

## Section B: Diagnostic Coverage (16 failure modes)

| # | Subsystem | Failure Mode | v13 | v14 | Coverage Location |
|---|-----------|-------------|------|------|-------------------|
| 1 | Telegram | Bot token invalid/revoked | ✅ | ✅ | DIAGNOSTICS.md |
| 2 | Telegram | Rate limited (429) | ✅ | ✅ | DIAGNOSTICS.md |
| 3 | LLM API | Transport timeout | ✅ | ✅ | DIAGNOSTICS.md |
| 4 | LLM API | Context overflow | ✅ | ✅ | DIAGNOSTICS.md |
| 5 | Tools | Confirmation gate timeout | ✅ | ✅ | System prompt lines 561-566 |
| 6 | Tools | Tool result truncated | ✅ | ✅ | DIAGNOSTICS.md |
| 7 | Memory | memory_save fails (fs full) | ✅ | ✅ | DIAGNOSTICS.md |
| 8 | Memory | memory_search returns nothing | ✅ | ✅ | System prompt lines 569-576 |
| 9 | Cron | Job fails to send reminder | ✅ | ✅ | DIAGNOSTICS.md |
| 10 | Cron | Jobs lost after restart | ✅ | ✅ | DIAGNOSTICS.md |
| 11 | Bridge | Service down (ECONNREFUSED) | ✅ | ✅ | DIAGNOSTICS.md |
| 12 | Bridge | Permission-specific errors | ✅ | ✅ | DIAGNOSTICS.md |
| 13 | MCP | Server unreachable | ✅ | ✅ | DIAGNOSTICS.md |
| 14 | MCP | Tool definition changed (rug-pull) | ✅ | ✅ | DIAGNOSTICS.md |
| 15 | MCP | Rate limit exceeded | ✅ | ✅ | DIAGNOSTICS.md |
| 16 | Skills | Requirements not met | ✅ | ✅ | DIAGNOSTICS.md |

**Section B Total: 48/48 (100%)**

---

## Section C: High-Risk Tool Consistency (10 tools)

| # | Tool | Risk | Description | Prompt | DIAG | v14 | Issue Found |
|---|------|------|-------------|--------|------|------|-------------|
| 1 | `shell_exec` | Command execution | "sandboxed...allowlist" (tools/system.js:21) | Line 467: matching | Playbook line 714 | ✅ | — |
| 2 | `js_eval` | Code execution | "sandboxed VM...30s...blocked modules" (tools/system.js:45) | Line 468: matching | Playbook line 715 | ✅ | — |
| 3 | `solana_swap` | Financial | "ALWAYS confirm...show quote" (tools/solana.js:104) | Line 562: in confirmation list | N/A | ✅ | — |
| 4 | `android_sms` | Sends SMS | "ALWAYS confirm" (tools/android.js:64) | Line 562: listed | DIAGNOSTICS.md | ✅ | — |
| 5 | `android_call` | Phone calls | "ALWAYS confirm" (tools/android.js:76) | Line 562: listed | DIAGNOSTICS.md | ✅ | — |
| 6 | `memory_save` | State change | "Save to MEMORY.md" (tools/memory.js:50) | Line 571: file-based | DIAGNOSTICS.md | ✅ | — |
| 7 | `web_fetch` | Network | "up to 50K chars" (tools/web.js:35) | Line 466: "Up to 50K chars" | Truncation covered | ✅ | — |
| 8 | `cron_create` | Scheduled jobs | "Two kinds...persistence...15-min" (tools/cron.js:14) | Lines 816-823 | DIAGNOSTICS.md | ✅ | — |
| 9 | MCP tools | Dynamic external | Sanitized, SHA-256 (mcp-client.js) | Lines 933-939: trust model | DIAGNOSTICS.md | ✅ | — |
| **10** | **`tool_search` (NEW)** | Tool discovery | "Search for available tools by keyword" (tools/system.js:34) | Lines 487-491: Tool Discovery section | N/A | ✅ | — |

**Section C Total: 30/30 (100%)**

---

## New Feature Door Assessment (3-Part Test)

| Feature | Changes capability? | Users likely ask? | Wrong answer without? | Door needed? | Action |
|---------|-------------------|-------------------|----------------------|-------------|--------|
| Loop detection (BAT-474) | Yes — forcibly stops tool use | Yes — "why did you stop?" | Yes — agent would blame budget, not loop | **YES** | Added line 711 |
| Memory scrubbing (BAT-474) | No — transparent pipeline | No | No | No | — |
| Context summarization (BAT-475) | Yes — messages replaced with summary | Yes — "where did our earlier chat go?" | Yes — agent would say "dropped" not "summarized" | **FIX** | Updated line 925 |
| Deferred tool loading (BAT-475) | Yes, but only for non-Claude | Already covered | Already covered | No | Lines 487-491 |
| js_eval sandbox (BAT-466) | No — hardening, not new capability | No | No | No | — |
| Dashboard metrics (BAT-463/464) | No — Android UI only | No | No | No | — |
| Emulator IP gate (BAT-467) | No — Kotlin-side only | No | No | No | — |
| tools/ refactor (BAT-470) | No — internal refactor | No | No | No | — |
| Multi-provider QR (BAT-471) | No — Android setup flow | No | No | No | — |

---

## Gaps Fixed

### 1. Loop Detector Door (claude.js line 711) — NEW
**Pre-fix:** System prompt only mentioned "max 25 tool calls per turn" as loop protection. The new DeerFlow P1 identical-call loop detector (warn@3, break@5) was completely invisible to the agent.
**Post-fix:** Added line 711: "**Identical-call loop detector:** If you call the exact same tool with the same arguments 3 times in a turn, you get a warning injected. At 5 identical calls, the loop is broken and you must respond with text only. This is automatic — if you see a loop-break message, explain what you were trying to do and ask the user for guidance."

### 2. Context Summarization Update (claude.js line 925) — FIX
**Pre-fix:** "When approaching limits (~90%), older messages are aggressively trimmed." — Implied messages are simply dropped.
**Post-fix:** "At ~85%, older messages are automatically summarized into a compact recap before being trimmed (you will see a '[Session context summary]' message replacing them). At ~90%, remaining old messages are aggressively trimmed without summary." — Agent now knows summarization happens before trimming and can explain this to users.

---

## Code Issues Found

None. All changes are documentation/prompt-only.

---

## Remaining Gaps

**None.** All 23 knowledge items, 6 negative knowledge boundaries, 16 diagnostic failure modes, and 10 high-risk tool consistency checks score ✅ post-fix.

---

## Score Progression

```
        Knowledge (Section A)               Diagnostics (Section B)          Tool Consistency (Section C)
v1  ████████████████████░░░░░░░░░░  42/60  (70%)    (not audited)                 (not audited)
v2  ████████████████████████████░░  56/60  (93%)    (not audited)                 (not audited)
v3  ██████████████████████████████  60/60 (100%)    (not audited)                 (not audited)
v4  ██████████████████████████████  60/60 (100%)    ██████████████████████████████  48/48 (100%)    (not audited)
v5  ██████████████████████████████  60/60 (100%)    ██████████████████████████████  48/48 (100%)    (not audited)
v6  ██████████████████████████████  63/63 (100%)    ██████████████████████████████  48/48 (100%)    (not audited)
v7  ██████████████████████████████  63/63 (100%)    ██████████████████████████████  48/48 (100%)    (not audited)
v8  ██████████████████████████████  63/63 (100%)    ██████████████████████████████  48/48 (100%)    (not audited)
v9  ██████████████████████████████  63/63 (100%)    ██████████████████████████████  48/48 (100%)    (not audited)
v10 ██████████████████████████████  63/63 (100%)    ██████████████████████████████  48/48 (100%)    (not audited)
v11 ██████████████████████████████  63/63 (100%)    ██████████████████████████████  48/48 (100%)    (not audited)
v12 ██████████████████████████████  63/63 (100%)    ██████████████████████████████  48/48 (100%)    ██████████████████████████████  27/27 (100%)
v13 ██████████████████████████████  66/66 (100%)    ██████████████████████████████  48/48 (100%)    ██████████████████████████████  27/27 (100%)
v14 ██████████████████████████████  69/69 (100%)    ██████████████████████████████  48/48 (100%)    ██████████████████████████████  30/30 (100%)

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
v11 ██████████████████████████████████████████████████ 111/111 (100%)  [BAT-322 self-documenting]
v12 ██████████████████████████████████████████████████ 138/138 (100%)  [SAB v2: +Section C, negative knowledge, confirm list fix]
v13 ██████████████████████████████████████████████████ 141/141 (100%)  [+OpenRouter door, provider-aware playbook fix]
v14 ██████████████████████████████████████████████████ 147/147 (100%)  [+loop detector door, context summarization fix, +tool_search]
```

---

## Methodology

- **SAB version:** v2
- **Source-only audit** — all scores derived from code reads, no runtime testing
- **Files read:** claude.js buildSystemBlocks() (lines 370-992), tools/system.js (shell_exec, js_eval, tool_search), tools/solana.js (solana_swap), tools/android.js (android_sms, android_call), tools/memory.js (memory_save + scrubbing), tools/web.js (web_fetch), tools/cron.js (cron_create), config.js (CONFIRM_REQUIRED, SECRETS_BLOCKED, SHELL_ALLOWLIST), loop-detector.js, DIAGNOSTICS.md, SAB-AUDIT-v13.md (baseline)
- **Constants verified:** MAX_TOOL_USES=25, MAX_HISTORY=35, max_tokens=4096, SHELL_ALLOWLIST=34, SECRETS_BLOCKED=4, BLOCKED_MODULES=7, js_eval limit=10,000, CONFIRM_REQUIRED=8, LOOP_WARN_THRESHOLD=3, LOOP_BREAK_THRESHOLD=5, CONTEXT_SUMMARIZE_THRESHOLD=0.85
- **Provider-aware check:** All 3 providers still correctly covered (billing URLs, connectivity, DIAGNOSTICS header)
- **New modules audited:** loop-detector.js, tools/system.js (tool_search), tools/memory.js (scrubSessionContent)
