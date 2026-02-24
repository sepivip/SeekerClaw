# SAB-AUDIT-v4 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-02-24
> **Scope:** Re-audit after 16 features shipped since v3 (Feb 21) + NEW diagnostic coverage section
> **Method:** Full read of buildSystemBlocks() + diagnostic coverage map across 8 subsystems
> **Baseline:** SAB-AUDIT-v3.md (60/60, 100%)

---

## Overall Scorecard

| Section | Score | Max | Percentage | Delta |
|---------|-------|-----|-----------|-------|
| A: Knowledge & Doors | 60 | 60 | 100% | — (held) |
| B: Diagnostic Coverage (pre-fix) | 19 | 48 | 40% | NEW |
| B: Diagnostic Coverage (post-fix) | 48 | 48 | 100% | +29 |
| **Combined (post-fix)** | **108** | **108** | **100%** | — |

Scoring: ✅ = 3 pts, ⚠️ = 1 pt, ❌ = 0 pts.

---

## Section A: Knowledge & Doors (20 items)

### Constants Verification

| Constant | Code Value | Prompt Claim | Match |
|----------|-----------|-------------|-------|
| MAX_TOOL_USES | 25 (claude.js:1461) | "Up to 25 tool-call rounds" (line 784) | ✅ |
| MAX_HISTORY | 35 (claude.js:174) | "35 messages per chat" (line 783) | ✅ |
| max_tokens | 4096 (claude.js:1481) | "4096 tokens per response" (line 785) | ✅ |
| SHELL_ALLOWLIST | 22 commands (config.js:234) | 22 commands listed (line 623) | ✅ |
| SECRETS_BLOCKED | config.json, config.yaml, seekerclaw.db (config.js:225) | seekerclaw.db listed as BLOCKED (line 542) | ✅ |

### 1. Identity (4 items)

| Item | v1 | v2 | v3 | v4 | What changed |
|------|----|----|----|----|-------------|
| Own name/version | ✅ | ✅ | ✅ | ✅ | — |
| Model it's running on | ✅ | ✅ | ✅ | ✅ | — |
| Device/hardware | ⚠️ | ⚠️ | ✅ | ✅ | — |
| Who built it and why | ❌ | ✅ | ✅ | ✅ | — |

**v4: 12/12** (held from v3)

### 2. Architecture (4 items)

| Item | v1 | v2 | v3 | v4 | What changed |
|------|----|----|----|----|-------------|
| How Node.js ↔ Kotlin communicate | ⚠️ | ✅ | ✅ | ✅ | — |
| UI process vs :node process | ❌ | ✅ | ✅ | ✅ | — |
| Health monitoring system | ✅ | ✅ | ✅ | ✅ | — |
| How Telegram polling works | ⚠️ | ⚠️ | ✅ | ✅ | — |

**v4: 12/12** (held from v3)

### 3. Capabilities (4 items)

| Item | v1 | v2 | v3 | v4 | What changed |
|------|----|----|----|----|-------------|
| Full tool list | ✅ | ✅ | ✅ | ✅ | — |
| Which tools sandboxed | ✅ | ✅ | ✅ | ✅ | — |
| What it cannot do | ✅ | ✅ | ✅ | ✅ | — |
| How skills load and trigger | ✅ | ✅ | ✅ | ✅ | — |

**v4: 12/12** (held from v1)

### 4. Configuration (4 items)

| Item | v1 | v2 | v3 | v4 | What changed |
|------|----|----|----|----|-------------|
| Config files — what's in each | ⚠️ | ✅ | ✅ | ✅ | — |
| Which settings agent can change | ✅ | ✅ | ✅ | ✅ | — |
| Which API keys needed | ✅ | ✅ | ✅ | ✅ | — |
| How to change model/heartbeat | ✅ | ✅ | ✅ | ✅ | — |

**v4: 12/12** (held from v2)

### 5. Self-Diagnosis (4 items)

| Item | v1 | v2 | v3 | v4 | What changed |
|------|----|----|----|----|-------------|
| Health goes stale | ✅ | ✅ | ✅ | ✅ | — |
| Telegram disconnects | ⚠️ | ✅ | ✅ | ✅ | — |
| Skill fails | ✅ | ✅ | ✅ | ✅ | — |
| Conversation corruption | ⚠️ | ✅ | ✅ | ✅ | — |

**v4: 12/12** (held from v2)

### New Doors Evaluation

16 features shipped since v3. Each tested against the 3-part door test:

| Feature | Changes capability? | Users ask about it? | Wrong answer without door? | Door needed? |
|---------|-------------------|--------------------|-----------------------------|-------------|
| Streaming + payload optimization (BAT-259) | No (transport) | No | No | No |
| Firebase Analytics build-optional (BAT-258) | No (build) | No | No | No |
| MAX_HISTORY 20→35 | Yes | Maybe | Already updated in prompt | No |
| _inputJson leak fix | No (internal) | No | No | No |
| Open-source prep (LICENSE, CI) | No (repo) | No | No | No |
| P2 multi-turn (PR #174) | Yes (smoother) | No | No | No |
| Silent turn stop fix (BAT-161) | No (bug fix) | No | No | No |
| Timeout error sanitization (BAT-253) | No (better errors) | No | No | No |
| Tool integrity hardening (BAT-246) | No (internal) | No | No | No |
| API timeout configurable (BAT-244) | Yes (setting) | Unlikely | Discoverable via agent_settings.json | No |
| Runtime tracing (BAT-243) | No (logs) | No | No | No |
| NetWatch fixes (BAT-237-241) | No (skill) | No | No | No |
| Conversational API key (BAT-236) | Already covered | — | — | No |
| OpenClaw parity 2026.2.22 (BAT-256) | No (internal) | No | No | No |
| Console logs fix (BAT-257) | No (Kotlin) | No | No | No |
| Jupiter audit fixes (BAT-255) | No (tool) | No | No | No |

**Result:** No new knowledge items needed. Total remains 20 (max 25).

---

## Section B: Diagnostic Coverage (16 failure modes)

### Pre-Fix Scores

| # | Subsystem | Failure Mode | Coverage | Score | Notes |
|---|-----------|-------------|----------|-------|-------|
| 1 | Telegram | Bot token invalid/revoked | ⚠️ | 1 | Playbook covers 401 but for Claude API, not Telegram specifically |
| 2 | Telegram | Rate limited (429) | ⚠️ | 1 | Playbook mentions 429 for Claude API only |
| 3 | Claude API | Transport timeout | ⚠️ | 1 | Agent knows about logs, [Trace] entries exist but no specific timeout guidance |
| 4 | Claude API | Context overflow (400) | ❌ | 0 | No coverage — playbook covers 401, 429, 402 but not 400 |
| 5 | Tools | Confirmation gate timeout | ✅ | 3 | Line 488: explicit description of timeout behavior |
| 6 | Tools | Tool result truncated (>120KB) | ❌ | 0 | Silent truncation — agent has no idea results are cut |
| 7 | Memory | memory_save fails (fs full) | ⚠️ | 1 | Error surfaces in logs but no guidance |
| 8 | Memory | memory_search returns nothing | ✅ | 3 | Line 496: explicit guidance for empty results |
| 9 | Cron | Job fails to send | ⚠️ | 1 | Error in job state but no notification or guidance |
| 10 | Cron | Jobs lost after restart | ❌ | 0 | Agent doesn't know cron persistence mechanism |
| 11 | Bridge | Service down (ECONNREFUSED) | ⚠️ | 1 | Error visible but no guidance distinguishing bridge down from other issues |
| 12 | Bridge | Permission-specific errors | ⚠️ | 1 | Line 625 has examples but errors are generic |
| 13 | MCP | Server unreachable | ⚠️ | 1 | Error in logs but no diagnosis guidance |
| 14 | MCP | Tool definition changed (rug-pull) | ❌ | 0 | Silently blocked, agent unaware of SHA-256 mechanism |
| 15 | MCP | Rate limit exceeded | ⚠️ | 1 | Error visible but no guidance |
| 16 | Skills | Requirements not met | ✅ | 3 | Lines 605-609: playbook with 3-step diagnosis |

**Pre-fix total: 19/48 (40%)**

### Post-Fix Scores

All 13 non-✅ items now have diagnosis paths via DIAGNOSTICS.md:

| # | Subsystem | Failure Mode | Pre | Post | Fix |
|---|-----------|-------------|-----|------|-----|
| 1 | Telegram | Bot token invalid | ⚠️ | ✅ | DIAGNOSTICS.md: Telegram > Bot Token Invalid/Revoked |
| 2 | Telegram | Rate limited | ⚠️ | ✅ | DIAGNOSTICS.md: Telegram > Telegram Rate Limited |
| 3 | Claude API | Transport timeout | ⚠️ | ✅ | DIAGNOSTICS.md: Claude API > Transport Timeout |
| 4 | Claude API | Context overflow | ❌ | ✅ | DIAGNOSTICS.md: Claude API > Context Overflow |
| 5 | Tools | Confirmation gate timeout | ✅ | ✅ | Already covered in prompt |
| 6 | Tools | Tool result truncated | ❌ | ✅ | DIAGNOSTICS.md: Tools > Tool Result Truncation |
| 7 | Memory | memory_save fails | ⚠️ | ✅ | DIAGNOSTICS.md: Memory > memory_save Fails |
| 8 | Memory | memory_search nothing | ✅ | ✅ | Already covered in prompt |
| 9 | Cron | Job fails to send | ⚠️ | ✅ | DIAGNOSTICS.md: Cron > Job Fails to Send |
| 10 | Cron | Jobs lost after restart | ❌ | ✅ | DIAGNOSTICS.md: Cron > Jobs Persist Across Restarts |
| 11 | Bridge | Service down | ⚠️ | ✅ | DIAGNOSTICS.md: Bridge > Service Down |
| 12 | Bridge | Permission errors | ⚠️ | ✅ | DIAGNOSTICS.md: Bridge > Permission-Specific Errors |
| 13 | MCP | Server unreachable | ⚠️ | ✅ | DIAGNOSTICS.md: MCP > Server Unreachable |
| 14 | MCP | Tool definition changed | ❌ | ✅ | DIAGNOSTICS.md: MCP > Tool Definition Changed |
| 15 | MCP | Rate limit exceeded | ⚠️ | ✅ | DIAGNOSTICS.md: MCP > MCP Rate Limit Exceeded |
| 16 | Skills | Requirements not met | ✅ | ✅ | Already covered in prompt |

**Post-fix total: 48/48 (100%)**

---

## Gaps Fixed

### 1. claude.js — DIAGNOSTICS.md Door (1 line)
Added after Diagnostics section (line 592):
```
For detailed troubleshooting beyond the quick playbook below, read DIAGNOSTICS.md in your workspace.
```
This is a door, not content — the agent enters and explores on its own. Zero tokens until accessed.

### 2. DIAGNOSTICS.md — Created (NEW)
Path: `app/src/main/assets/nodejs-project/DIAGNOSTICS.md`
- 8 subsystems covered: Telegram, Claude API, Tools, Memory, Cron, Bridge, MCP, Skills
- 13 failure modes with: symptoms, check commands, diagnosis, fix steps
- Ships with APK, lives in workspace alongside agent code
- Agent reads via `read` tool on demand — zero prompt token cost

### 3. ConfigManager.kt — Seeding Added
Added DIAGNOSTICS.md seeding in `seedWorkspace()` (after USER.md, before skills):
```kotlin
val diagFile = File(workspaceDir, "DIAGNOSTICS.md")
if (!diagFile.exists()) {
    context.assets.open("nodejs-project/DIAGNOSTICS.md").use { input ->
        diagFile.writeText(input.bufferedReader().readText())
    }
}
```
Copies from APK assets to workspace on first run. Existing installations get it on next clean install or manual copy.

### Verification
- `node -c claude.js` — syntax check passed
- Prompt token delta: +1 line (~15 tokens). Cached via `cache_control: ephemeral`.
- DIAGNOSTICS.md: 150 lines, read on demand only (0 prompt tokens until agent needs it)

---

## Code Issues Found

None. No bugs discovered during this audit.

---

## Remaining Gaps

**None.** All 20 knowledge items and all 16 diagnostic failure modes score ✅.

---

## Score Progression

```
        Knowledge (Section A)               Diagnostics (Section B)
v1  ████████████████████░░░░░░░░░░  42/60  (70%)    (not audited)
v2  ████████████████████████████░░  56/60  (93%)    (not audited)
v3  ██████████████████████████████  60/60 (100%)    (not audited)
v4  ██████████████████████████████  60/60 (100%)    ██████████████████████████████  48/48 (100%)

Combined SAB Score:
v1  ██████████████████████████████░░░░░░░░░░░░░░░░░░░░  42/60   (70%)
v2  ██████████████████████████████████████████████░░░░  56/60   (93%)
v3  ██████████████████████████████████████████████████  60/60  (100%)
v4  ██████████████████████████████████████████████████ 108/108 (100%)  [+48 max from Section B]
```

---

## Methodology

- **Source-only audit** — all scores derived from code reads, no runtime testing
- **Files read:** claude.js buildSystemBlocks() (lines 335-853), config.js (SHELL_ALLOWLIST, SECRETS_BLOCKED), tools.js (ALLOWED_COMMANDS reference), PROJECT.md (changelog), SAB-AUDIT-v3.md (baseline)
- **Constants verified:** MAX_TOOL_USES, MAX_HISTORY, max_tokens, SHELL_ALLOWLIST (22 commands), SECRETS_BLOCKED (3 files)
- **New in v4:** Section B (Diagnostic Coverage) — 16 failure modes across 8 subsystems, scored against both the system prompt playbook and workspace files
- **Philosophy applied:** Doors (1-line pointers in prompt) → Rooms (deep content in DIAGNOSTICS.md). Agent enters and explores on demand. Minimal prompt growth.
