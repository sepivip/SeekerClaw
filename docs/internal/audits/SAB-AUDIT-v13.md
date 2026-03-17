# SAB-AUDIT-v13 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-03-17
> **Scope:** Re-audit after BAT-447 (OpenRouter provider), BAT-449 (context trimming), BAT-448 (session summary fix), BAT-439 (button styling), v1.6.1 release.
> **Method:** Full read of buildSystemBlocks() + constants verification + diagnostic coverage map + high-risk tool consistency spot-check
> **Baseline:** SAB-AUDIT-v12.md (138/138, 100%)
> **SAB Version:** v2

---

## Overall Scorecard

| Section | Pre-fix | Post-fix | Max | Percentage | Delta from v12 |
|---------|---------|----------|-----|-----------|----------------|
| A: Knowledge & Doors | 63 | 66 | 66 | 100% | +3 (1 new door) |
| A: Negative Knowledge (sub) | 6/6 | 6/6 | 6 | 100% | — (held) |
| B: Diagnostic Coverage | 46 | 48 | 48 | 100% | — (held after fix) |
| C: Tool Consistency | 27 | 27 | 27 | 100% | — (held) |
| **Combined** | **136** | **141** | **141** | **100%** | +3 (new door + fix) |

Scoring: ✅ = 3 pts, ⚠️ = 1 pt, ❌ = 0 pts.

---

## Constants Verification

| Constant | Code Value | Prompt Claim | Match |
|----------|-----------|-------------|-------|
| MAX_TOOL_USES | 25 (claude.js:1711) | "Up to 25 tool-call rounds" (line 912) | ✅ |
| MAX_HISTORY | 35 (claude.js:172) | "35 messages per chat" (line 911) | ✅ |
| max_tokens | 4096 (claude.js:~1527) | "4096 tokens per response" (line 913) | ✅ |
| SHELL_ALLOWLIST | 34 commands (config.js:253-260) | 34 commands listed (line 705) | ✅ |
| SECRETS_BLOCKED | config.json, config.yaml, seekerclaw.db (config.js:244) | seekerclaw.db listed as BLOCKED (line 621) | ✅ |
| BLOCKED_MODULES | 7 modules (tools.js) | Lists all 7 (line 467) | ✅ |
| js_eval code limit | 10,000 chars (tools.js) | "10,000-character code limit" (line 706) | ✅ |
| CONFIRM_REQUIRED | 8 tools (config.js:268-277) | 8 tools listed (line 554) | ✅ |

---

## Section A: Knowledge & Doors (22 items)

### Changes Since v12

| Commit | Feature | New Door? | Reason |
|--------|---------|-----------|--------|
| BAT-447 OpenRouter provider | 3rd provider (Chat Completions adapter, SSE streaming, Kotlin UI) | **Yes** | Agent needs to know it may be running via OpenRouter; billing/connectivity URLs differ |
| BAT-449 Context trimming | Adaptive context estimation | No | Transparent — agent already knows about context limits (line 914) |
| BAT-448 Session summary fix | Empty system prompt block fix | No | Infrastructure bug fix |
| BAT-439 Button styling | Telegram destructive/primary colors | No | Already documented in line 471 |
| v1.6.0 + v1.6.1 releases | Version bumps | No | PLATFORM.md auto-generates version info |

**1 new door added** — OpenRouter provider info (lines 882-889). Item count: 21 → 22.

### Full Item Scores

**Identity (5/5)**

| # | Item | v11 | v12 | v13 | Notes |
|---|------|-----|------|------|-------|
| 1 | Own name/version | ✅ | ✅ | ✅ | Lines 424-425 |
| 2 | Model | ✅ | ✅ | ✅ | PLATFORM.md + line 626 |
| 3 | Device/hardware | ✅ | ✅ | ✅ | PLATFORM.md |
| 4 | Who built it | ✅ | ✅ | ✅ | Line 426 (OpenClaw) |
| 5 | Official channels | ✅ | ✅ | ✅ | Line 427 |

**Architecture (4/4)**

| # | Item | v11 | v12 | v13 | Notes |
|---|------|-----|------|------|-------|
| 6 | Node-Kotlin bridge | ✅ | ✅ | ✅ | Lines 431-436 |
| 7 | UI vs :node process | ✅ | ✅ | ✅ | Lines 432-434 |
| 8 | Health monitoring | ✅ | ✅ | ✅ | Lines 645-650 |
| 9 | Telegram polling | ✅ | ✅ | ✅ | Lines 493-497 |

**Capabilities (5/5)**

| # | Item | v11 | v12 | v13 | Notes |
|---|------|-----|------|------|-------|
| 10 | Full tool list | ✅ | ✅ | ✅ | Lines 448-471 |
| 11 | Sandboxed tools | ✅ | ✅ | ✅ | Line 467 (7 blocked modules) |
| 12 | What it cannot do | ✅ | ✅ | ✅ | Lines 601-608 (6 boundaries) |
| 13 | Skills load/trigger | ✅ | ✅ | ✅ | Lines 510-527 |
| **22** | **OpenRouter provider (NEW)** | — | — | ✅ | Lines 882-889: model, fallback info. Billing/connectivity URLs fixed (lines 715-716) |

**Configuration (4/4)**

| # | Item | v11 | v12 | v13 | Notes |
|---|------|-----|------|------|-------|
| 14 | Config files | ✅ | ✅ | ✅ | Lines 610-622 |
| 15 | Settings agent can change | ✅ | ✅ | ✅ | Lines 624-641 |
| 16 | API keys needed | ✅ | ✅ | ✅ | Lines 626-628 |
| 17 | Model/heartbeat change | ✅ | ✅ | ✅ | Line 626 |

**Self-Diagnosis (4/4)**

| # | Item | v11 | v12 | v13 | Notes |
|---|------|-----|------|------|-------|
| 18 | Health stale | ✅ | ✅ | ✅ | Lines 693-698 |
| 19 | Telegram disconnects | ✅ | ✅ | ✅ | Lines 680-685 |
| 20 | Skill fails | ✅ | ✅ | ✅ | Lines 687-691 |
| 21 | Conversation corruption | ✅ | ✅ | ✅ | Lines 699-703 |

**Section A Total: 66/66 (100%)**

### Negative Knowledge Sub-Check

| # | Boundary | v12 | v13 | Notes |
|---|----------|------|------|-------|
| 1 | No internet browsing | ✅ | ✅ | Line 602 |
| 2 | No image/audio/video generation | ✅ | ✅ | Line 603 |
| 3 | No direct cloud/infra access | ✅ | ✅ | Line 604 |
| 4 | No cross-device reach | ✅ | ✅ | Line 605 |
| 5 | No persistent background execution | ✅ | ✅ | Line 606 |
| 6 | No real-time data without tools | ✅ | ✅ | Line 607 |

**Negative Knowledge: 6/6 (held)**

---

## Section B: Diagnostic Coverage (16 failure modes)

| # | Subsystem | Failure Mode | v12 | v13 | Coverage Location |
|---|-----------|-------------|------|------|-------------------|
| 1 | Telegram | Bot token invalid/revoked | ✅ | ✅ | DIAGNOSTICS.md |
| 2 | Telegram | Rate limited (429) | ✅ | ✅ | DIAGNOSTICS.md |
| 3 | LLM API | Transport timeout | ✅ | ✅ | DIAGNOSTICS.md |
| 4 | LLM API | Context overflow | ✅ | ✅ | DIAGNOSTICS.md |
| 5 | Tools | Confirmation gate timeout | ✅ | ✅ | System prompt lines 553-557 |
| 6 | Tools | Tool result truncated | ✅ | ✅ | DIAGNOSTICS.md |
| 7 | Memory | memory_save fails (fs full) | ✅ | ✅ | DIAGNOSTICS.md |
| 8 | Memory | memory_search returns nothing | ✅ | ✅ | System prompt lines 561-567 |
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

## Section C: High-Risk Tool Consistency (9 tools)

| # | Tool | Risk | tools.js | Prompt | DIAG | v13 | Issue Found |
|---|------|------|----------|--------|------|------|-------------|
| 1 | `shell_exec` | Command execution | "sandboxed...allowlist" | Line 466: matching | Playbook line 705 | ✅ | — |
| 2 | `js_eval` | Code execution | "sandboxed VM...30s" | Line 467: matching | Playbook line 706 | ✅ | — |
| 3 | `solana_swap` | Financial | "ALWAYS confirm...show quote" | Line 554: in confirmation list | N/A | ✅ | — |
| 4 | `android_sms` | Sends SMS | "ALWAYS confirm" | Line 554: listed | DIAGNOSTICS.md | ✅ | — |
| 5 | `android_call` | Phone calls | "ALWAYS confirm" | Line 554: listed | DIAGNOSTICS.md | ✅ | — |
| 6 | `memory_save` | State change | "Save to MEMORY.md" | Line 562: file-based | DIAGNOSTICS.md | ✅ | — |
| 7 | `web_fetch` | Network | "up to 50K chars" | Line 465: "Up to 50K chars" | Truncation covered | ✅ | — |
| 8 | `cron_create` | Scheduled jobs | "Two kinds...persistence...15-min" | Lines 805-813 | DIAGNOSTICS.md | ✅ | — |
| 9 | MCP tools | Dynamic external | Sanitized, SHA-256 | Lines 921-929: trust model | DIAGNOSTICS.md | ✅ | — |

**Section C Total: 27/27 (100%)**

---

## Provider-Aware Scoring

| Aspect | Status | Notes |
|--------|--------|-------|
| Billing URL | ⚠️→✅ | **Fixed:** was openai/anthropic ternary; now includes `openrouter.ai/credits` |
| Connectivity check | ⚠️→✅ | **Fixed:** was openai/anthropic ternary; now includes `openrouter.ai` |
| Config display | ✅ Dynamic | `Provider: ${PROVIDER}, Model: ${MODEL}` (line 626) |
| OpenRouter provider block | ✅ NEW | Lines 882-889: model name, fallback info |
| DIAGNOSTICS.md header | ⚠️→✅ | **Fixed:** was "Claude / OpenAI"; now "Claude / OpenAI / OpenRouter" |
| Streaming protocol | ✅ No assumptions | No provider-specific streaming refs in prompt |
| Error codes | ✅ Generic | Uses HTTP codes (401, 429, 402) not provider-specific |

**Provider-specific gaps: 0 (3 fixed)**

---

## Gaps Fixed

### 1. Provider-Aware Billing/Connectivity URLs (claude.js lines 715-716)
**Pre-fix:** `PROVIDER === 'openai' ? ... : 'console.anthropic.com'` — OpenRouter fell through to Anthropic's billing URL.
**Post-fix:** Three-way ternary: `openai → platform.openai.com`, `openrouter → openrouter.ai/credits`, `else → console.anthropic.com`. Same for connectivity check hostname.

### 2. DIAGNOSTICS.md Header (line 30)
**Pre-fix:** "LLM API (Claude / OpenAI)"
**Post-fix:** "LLM API (Claude / OpenAI / OpenRouter)"

### 3. New Door: OpenRouter Provider (claude.js lines 882-889)
Already present from BAT-447 merge — agent knows when it's running via OpenRouter, shows model and fallback info. No new code needed; just validated and scored.

---

## Code Issues Found

None.

---

## Remaining Gaps

**None.** All 22 knowledge items, 6 negative knowledge boundaries, 16 diagnostic failure modes, and 9 high-risk tool consistency checks score ✅ post-fix.

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
```

---

## Methodology

- **SAB version:** v2
- **Source-only audit** — all scores derived from code reads, no runtime testing
- **Files read:** claude.js buildSystemBlocks() (lines 369-932), tools.js (tool descriptions), config.js (CONFIRM_REQUIRED, SECRETS_BLOCKED, SHELL_ALLOWLIST), DIAGNOSTICS.md, SAB-AUDIT-v12.md (baseline)
- **Constants verified:** MAX_TOOL_USES=25, MAX_HISTORY=35, max_tokens=4096, SHELL_ALLOWLIST=34, SECRETS_BLOCKED=3, BLOCKED_MODULES=7, js_eval limit=10,000, CONFIRM_REQUIRED=8
- **Syntax verified:** `node -c claude.js` — pass
- **Provider-aware check:** 3 provider-specific gaps found and fixed (billing URL, connectivity URL, DIAGNOSTICS header)
