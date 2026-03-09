# SAB-AUDIT-v12 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-03-09
> **Scope:** First SAB v2 audit — adds Section C (tool consistency) + negative knowledge checks. Re-audit after BAT-359 (OpenClaw 2026.3.8 parity), BAT-319 (NFT holdings), BAT-326 (cron agentTurn), v1.5.4 fixes.
> **Method:** Full read of buildSystemBlocks() + constants verification + diagnostic coverage map + high-risk tool consistency spot-check
> **Baseline:** SAB-AUDIT-v11.md (111/111, 100%)
> **SAB Version:** v2 (adds Section C: Tool Consistency, negative knowledge checks, provider-aware scoring)

---

## Overall Scorecard

| Section | Pre-fix | Post-fix | Max | Percentage | Delta from v11 |
|---------|---------|----------|-----|-----------|----------------|
| A: Knowledge & Doors | 63 | 63 | 63 | 100% | — (held) |
| A: Negative Knowledge (sub) | 1/6 | 6/6 | 6 | 100% | NEW |
| B: Diagnostic Coverage | 48 | 48 | 48 | 100% | — (held) |
| C: Tool Consistency (NEW) | 20 | 27 | 27 | 100% | NEW |
| **Combined** | **131** | **138** | **138** | **100%** | +27 (new section) |

Scoring: ✅ = 3 pts, ⚠️ = 1 pt, ❌ = 0 pts.

---

## Constants Verification

| Constant | Code Value | Prompt Claim | Match |
|----------|-----------|-------------|-------|
| MAX_TOOL_USES | 25 (claude.js:1539) | "Up to 25 tool-call rounds" (line 900) | ✅ |
| MAX_HISTORY | 35 (claude.js:172) | "35 messages per chat" (line 899) | ✅ |
| max_tokens | 4096 (claude.js:~1515) | "4096 tokens per response" (line 901) | ✅ |
| SHELL_ALLOWLIST | 34 commands (config.js:241-248) | 34 commands listed (line 703) | ✅ |
| SECRETS_BLOCKED | config.json, config.yaml, seekerclaw.db (config.js:233) | seekerclaw.db listed as BLOCKED (line 619) | ✅ |
| BLOCKED_MODULES | 7 modules (tools.js) | Lists all 7 (line 467) | ✅ |
| js_eval code limit | 10,000 chars (tools.js) | "10,000-character code limit" (line 704) | ✅ |
| CONFIRM_REQUIRED | 8 tools (config.js:257-266) | 8 tools listed (line 562, post-fix) | ✅ (was 4, fixed) |

---

## Section A: Knowledge & Doors (21 items)

### Changes Since v11

| Commit | Feature | New Door? | Reason |
|--------|---------|-----------|--------|
| BAT-359 OpenClaw 2026.3.8 | Rate-limit skill guidance, cron error classification, symlink protection, markdown chunking | No | Infrastructure — transparent to agent |
| BAT-319 NFT holdings | solana_nft_holdings tool | No | Already has tool description + line 461 guidance |
| BAT-326 cron agentTurn | Full AI turns on cron jobs | No | Already covered at lines 795-803 |
| heartbeat pollution fix | Suppress empty heartbeat messages | No | Behavioral fix, transparent |
| v1.5.4 R8 ProGuard fix | Build system fix | No | Not agent-relevant |

**0 new doors added.** Item count remains at 21.

### Full Item Scores

**Identity (5/5)**

| # | Item | v9 | v10 | v11 | v12 | Notes |
|---|------|----|----|-----|------|-------|
| 1 | Own name/version | ✅ | ✅ | ✅ | ✅ | Lines 424-425 |
| 2 | Model | ✅ | ✅ | ✅ | ✅ | PLATFORM.md + line 624 |
| 3 | Device/hardware | ✅ | ✅ | ✅ | ✅ | PLATFORM.md |
| 4 | Who built it | ✅ | ✅ | ✅ | ✅ | Line 426 (OpenClaw) |
| 5 | Official channels | ✅ | ✅ | ✅ | ✅ | Line 427 |

**Architecture (4/4)**

| # | Item | v9 | v10 | v11 | v12 | Notes |
|---|------|----|----|-----|------|-------|
| 6 | Node-Kotlin bridge | ✅ | ✅ | ✅ | ✅ | Lines 431-436 |
| 7 | UI vs :node process | ✅ | ✅ | ✅ | ✅ | Lines 432-434 |
| 8 | Health monitoring | ✅ | ✅ | ✅ | ✅ | Lines 643-648 |
| 9 | Telegram polling | ✅ | ✅ | ✅ | ✅ | Lines 493-497 |

**Capabilities (4/4)**

| # | Item | v9 | v10 | v11 | v12 | Notes |
|---|------|----|----|-----|------|-------|
| 10 | Full tool list | ✅ | ✅ | ✅ | ✅ | Lines 448-471 |
| 11 | Sandboxed tools | ✅ | ✅ | ✅ | ✅ | Line 467 (7 blocked modules) |
| 12 | What it cannot do | ✅ | ✅ | ✅ | ✅ | Lines 601-608 (NEW section, post-fix) |
| 13 | Skills load/trigger | ✅ | ✅ | ✅ | ✅ | Lines 510-527 |

**Configuration (4/4)**

| # | Item | v9 | v10 | v11 | v12 | Notes |
|---|------|----|----|-----|------|-------|
| 14 | Config files | ✅ | ✅ | ✅ | ✅ | Lines 608-620 |
| 15 | Settings agent can change | ✅ | ✅ | ✅ | ✅ | Lines 622-639 |
| 16 | API keys needed | ✅ | ✅ | ✅ | ✅ | Lines 624-626 |
| 17 | Model/heartbeat change | ✅ | ✅ | ✅ | ✅ | Line 624 |

**Self-Diagnosis (4/4)**

| # | Item | v9 | v10 | v11 | v12 | Notes |
|---|------|----|----|-----|------|-------|
| 18 | Health stale | ✅ | ✅ | ✅ | ✅ | Lines 691-696 |
| 19 | Telegram disconnects | ✅ | ✅ | ✅ | ✅ | Lines 678-683 |
| 20 | Skill fails | ✅ | ✅ | ✅ | ✅ | Lines 685-689 |
| 21 | Conversation corruption | ✅ | ✅ | ✅ | ✅ | Lines 697-701 |

**Section A Total: 63/63 (100%)**

### Negative Knowledge Sub-Check (NEW in SAB v2)

| # | Boundary | Pre-fix | Post-fix | Notes |
|---|----------|---------|----------|-------|
| 1 | No internet browsing | ⚠️ | ✅ | Was "No browser or GUI" (vague); now explicit "cannot browse" |
| 2 | No image/audio/video generation | ❌ | ✅ | Added to new "What You Cannot Do" section |
| 3 | No direct cloud/infra access | ❌ | ✅ | Added |
| 4 | No cross-device reach | ❌ | ✅ | Added |
| 5 | No persistent background execution | ❌ | ✅ | Added |
| 6 | No real-time data without tools | ❌ | ✅ | Added |

**Negative Knowledge: 1/6 → 6/6 (fixed)**

---

## Section B: Diagnostic Coverage (16 failure modes)

All 16 failure modes from v11 held at ✅. No regressions. No new failure modes from recent commits.

| # | Subsystem | Failure Mode | v9 | v10 | v11 | v12 | Coverage Location |
|---|-----------|-------------|----|----|-----|------|-------------------|
| 1 | Telegram | Bot token invalid/revoked | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md |
| 2 | Telegram | Rate limited (429) | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md |
| 3 | LLM API | Transport timeout | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md |
| 4 | LLM API | Context overflow | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md |
| 5 | Tools | Confirmation gate timeout | ✅ | ✅ | ✅ | ✅ | System prompt lines 561-565 |
| 6 | Tools | Tool result truncated | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md |
| 7 | Memory | memory_save fails (fs full) | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md |
| 8 | Memory | memory_search returns nothing | ✅ | ✅ | ✅ | ✅ | System prompt lines 569-575 |
| 9 | Cron | Job fails to send reminder | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md |
| 10 | Cron | Jobs lost after restart | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md |
| 11 | Bridge | Service down (ECONNREFUSED) | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md |
| 12 | Bridge | Permission-specific errors | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md |
| 13 | MCP | Server unreachable | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md |
| 14 | MCP | Tool definition changed (rug-pull) | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md |
| 15 | MCP | Rate limit exceeded | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md |
| 16 | Skills | Requirements not met | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md |

**Section B Total: 48/48 (100%)**

---

## Section C: High-Risk Tool Consistency (NEW in SAB v2)

Cross-checking tool descriptions (tools.js), system prompt (claude.js), and DIAGNOSTICS.md for agreement on 9 high-risk tools.

| # | Tool | Risk | tools.js | Prompt | DIAG | Pre-fix | Post-fix | Issue Found |
|---|------|------|----------|--------|------|---------|----------|-------------|
| 1 | `shell_exec` | Command execution | "sandboxed...allowlist" | Line 466: matching | Playbook line 703 | ✅ | ✅ | — |
| 2 | `js_eval` | Code execution | "sandboxed VM...30s...child_process blocked" | Line 467: matching | Playbook line 704 | ✅ | ✅ | — |
| 3 | `solana_swap` | Financial | "ALWAYS confirm...show quote" | Line 562: in confirmation list (post-fix) | N/A | ⚠️ | ✅ | Was missing from prompt's confirmation list |
| 4 | `android_sms` | Sends SMS | "ALWAYS confirm" | Line 562: listed | DIAGNOSTICS.md | ✅ | ✅ | — |
| 5 | `android_call` | Phone calls | "ALWAYS confirm" | Line 562: listed | DIAGNOSTICS.md | ✅ | ✅ | — |
| 6 | `memory_save` | State change | "Save to MEMORY.md" | Line 569: file-based | DIAGNOSTICS.md | ✅ | ✅ | — |
| 7 | `web_fetch` | Network | "up to 50K chars" (post-fix) | Line 465: "Up to 50K chars" | Truncation covered | ⚠️ | ✅ | Size limit was missing from tool desc |
| 8 | `cron_create` | Scheduled jobs | "Two kinds...persistence...15-min" | Lines 803-811 | DIAGNOSTICS.md | ✅ | ✅ | — |
| 9 | MCP tools | Dynamic external | Sanitized, SHA-256 | Lines 909-916: trust model | DIAGNOSTICS.md | ✅ | ✅ | — |

Note: `android_notification` does not exist as a tool — skipped. `solana_swap` used instead as it's a higher-risk tool.

**Section C Total: 23/27 pre-fix → 27/27 post-fix (100%)**

### Confirmation Gate Discrepancy (Fixed)

**Pre-fix:** System prompt (line 554) listed 4 tools: `android_sms, android_call, jupiter_trigger_create, jupiter_dca_create`

**Code (config.js CONFIRM_REQUIRED):** 8 tools: `android_sms, android_call, android_camera_capture, android_location, solana_send, solana_swap, jupiter_trigger_create, jupiter_dca_create`

**Fix:** Updated line 562 to list all 8 tools. The agent now knows the full set of confirmation-gated tools.

---

## Provider-Aware Scoring

| Aspect | Status | Notes |
|--------|--------|-------|
| Billing URL | ✅ Provider-aware | `${PROVIDER === 'openai' ? 'platform.openai.com' : 'console.anthropic.com'}` (line 713) |
| Connectivity check | ✅ Provider-aware | Dynamic API URL per provider (line 714) |
| Config display | ✅ Dynamic | `Provider: ${PROVIDER}, Model: ${MODEL}` (line 624) |
| DIAGNOSTICS.md header | ✅ Provider-agnostic | "LLM API (Claude / OpenAI)" |
| Streaming protocol | ✅ No assumptions | No mentions of `content_block_delta` or `budget_tokens` in prompt |
| Error codes | ✅ Generic | Uses HTTP codes (401, 429, 402) not provider-specific |

**Provider-specific gaps: 0.** System prompt and DIAGNOSTICS.md are already provider-agnostic.

---

## Gaps Fixed

### 1. Negative Knowledge Section (claude.js)
Added new "What You Cannot Do" section after Environment Constraints with 6 explicit boundaries:
- No internet browsing
- No image/audio/video generation
- No direct cloud/infra access
- No cross-device reach
- No persistent background execution
- No real-time data without tools

### 2. Confirmation Gate List (claude.js)
Updated Tool Confirmation Gates from 4 tools to 8 tools to match `CONFIRM_REQUIRED` in config.js. Added: `android_camera_capture`, `android_location`, `solana_send`, `solana_swap`.

### 3. web_fetch Size Limit (tools.js)
Added "(up to 50K chars)" to web_fetch tool description to match prompt claim.

---

## Code Issues Found

None.

---

## Remaining Gaps

**None.** All 21 knowledge items, 6 negative knowledge boundaries, 16 diagnostic failure modes, and 9 high-risk tool consistency checks score ✅ post-fix.

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
```

---

## Methodology

- **SAB version:** v2 (first audit with Section C + negative knowledge checks + provider-aware scoring)
- **Source-only audit** — all scores derived from code reads, no runtime testing
- **Files read:** claude.js buildSystemBlocks() (lines 335-930), tools.js (tool descriptions), config.js (CONFIRM_REQUIRED, SECRETS_BLOCKED), DIAGNOSTICS.md, SAB-AUDIT-v11.md (baseline)
- **Constants verified:** MAX_TOOL_USES=25, MAX_HISTORY=35, max_tokens=4096, SHELL_ALLOWLIST=34, SECRETS_BLOCKED=3, BLOCKED_MODULES=7, js_eval limit=10,000, CONFIRM_REQUIRED=8
- **Syntax verified:** `node -c claude.js` — pass, `node -c tools.js` — pass
- **Provider-aware check:** 0 provider-specific gaps found
