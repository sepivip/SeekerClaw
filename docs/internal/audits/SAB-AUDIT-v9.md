# SAB-AUDIT-v9 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-03-03
> **Scope:** Re-audit after BAT-305 (secrets hardening — vm sandbox, checkpoint redaction, error redaction, memory write filtering, expanded secret redaction, system prompt guidance, dead code cleanup)
> **Method:** Full read of buildSystemBlocks() + constants verification + diagnostic coverage map
> **Baseline:** SAB-AUDIT-v8.md (111/111, 100%)

---

## Overall Scorecard

| Section | Pre-fix | Post-fix | Max | Percentage | Delta |
|---------|---------|----------|-----|-----------|-------|
| A: Knowledge & Doors | 61 | 63 | 63 | 100% | — (gap fixed) |
| B: Diagnostic Coverage | 48 | 48 | 48 | 100% | — (held) |
| **Combined** | **109** | **111** | **111** | **100%** | — |

Scoring: ✅ = 3 pts, ⚠️ = 1 pt, ❌ = 0 pts.

---

## Constants Verification

| Constant | Code Value | Prompt Claim | Match |
|----------|-----------|-------------|-------|
| MAX_TOOL_USES | 25 (claude.js:1489) | "Up to 25 tool-call rounds" (line 807) | ✅ |
| MAX_HISTORY | 35 (claude.js:175) | "35 messages per chat" (line 806) | ✅ |
| max_tokens | 4096 (claude.js:1510) | "4096 tokens per response" (line 808) | ✅ |
| SHELL_ALLOWLIST | 34 commands (config.js:234-241) | 34 commands listed (line 642) | ✅ |
| SECRETS_BLOCKED | config.json, config.yaml, seekerclaw.db (config.js:225) | seekerclaw.db listed as BLOCKED (line 559) | ✅ |
| BLOCKED_MODULES | 7 modules (tools.js:3506) | **Fixed:** now lists child_process, vm, cluster, worker_threads, module (line 417) | ✅ |
| js_eval code limit | 10,000 chars (tools.js:3471) | "10,000-character code limit" (line 643) | ✅ |

---

## Section A: Knowledge & Doors (21 items)

### Changes Since v8

BAT-305 is a security hardening PR with 7 fixes across 6 files. Each evaluated against the 3-part door test:

| Change | What Shipped | New Door? | Reason |
|--------|-------------|-----------|--------|
| Fix 1: Expanded redactSecrets | Jupiter + MCP token redaction, cached regexes | No | Transparent infrastructure — agent doesn't need to know log redaction implementation |
| Fix 2: vm sandbox for js_eval | AsyncFunction → vm.createContext with codeGeneration restrictions | **Fix existing** | Line 417 said "child_process and vm are blocked" — actually 7 modules + path restrictions |
| Fix 2: sandboxedRequire hardening | Block relative/absolute requires, node: prefix, require('process') → safeProcess | **Fix existing** | Part of item #11 fix |
| Fix 3: Error redaction to Telegram | 3 error paths wrapped in redactSecrets() | No | Transparent output processing |
| Fix 4: Checkpoint redaction | Deep-walk _redactObject() for task checkpoints | No | Transparent infrastructure |
| Fix 5: Memory write redaction | memory_save + daily_note + session summary filtered | No | System prompt already tells agent not to save keys (Fix 6) |
| Fix 6: System prompt guidance | "NEVER save keys to memory files" rule added | No | Already in code from BAT-305 implementation (lines 514, 569) |
| Fix 7: Removed allowedTools | Dead code cleanup in skills.js | No | No behavior change |

**1 existing door fixed** (item #11). Item count remains at 21.

### Full Item Scores

**Identity (5/5)**

| # | Item | v6 | v7 | v8 | v9 | Notes |
|---|------|----|----|-----|-----|-------|
| 1 | Own name/version | ✅ | ✅ | ✅ | ✅ | Lines 376-377 |
| 2 | Model | ✅ | ✅ | ✅ | ✅ | PLATFORM.md (auto-generated) |
| 3 | Device/hardware | ✅ | ✅ | ✅ | ✅ | PLATFORM.md |
| 4 | Who built it | ✅ | ✅ | ✅ | ✅ | Line 378 (OpenClaw) |
| 5 | Official channels | ✅ | ✅ | ✅ | ✅ | Line 379 (seekerclaw.xyz, @SeekerClaw, t.me/seekerclaw, GitHub) |

**Architecture (4/4)**

| # | Item | v6 | v7 | v8 | v9 | Notes |
|---|------|----|----|-----|-----|-------|
| 6 | Node↔Kotlin bridge | ✅ | ✅ | ✅ | ✅ | Lines 382-387 |
| 7 | UI vs :node process | ✅ | ✅ | ✅ | ✅ | Lines 384-385 |
| 8 | Health monitoring | ✅ | ✅ | ✅ | ✅ | Lines 581-586 |
| 9 | Telegram polling | ✅ | ✅ | ✅ | ✅ | Lines 442-446 |

**Capabilities (4/4)**

| # | Item | v6 | v7 | v8 | v9 pre | v9 post | Notes |
|---|------|----|----|-----|--------|---------|-------|
| 10 | Full tool list | ✅ | ✅ | ✅ | ✅ | ✅ | Lines 398-421 |
| 11 | Sandboxed tools | ✅ | ✅ | ✅ | ⚠️ | ✅ | **Fixed:** Line 417 updated — "child_process and vm are blocked" → lists 5 key blocked modules + "relative/absolute path requires" |
| 12 | What it cannot do | ✅ | ✅ | ✅ | ✅ | ✅ | Lines 787-792 |
| 13 | Skills load/trigger | ✅ | ✅ | ✅ | ✅ | ✅ | Lines 459-477 |

**Configuration (4/4)**

| # | Item | v6 | v7 | v8 | v9 | Notes |
|---|------|----|----|-----|-----|-------|
| 14 | Config files | ✅ | ✅ | ✅ | ✅ | Lines 548-559 |
| 15 | Settings agent can change | ✅ | ✅ | ✅ | ✅ | Lines 562-579 (includes Fix 6 guidance) |
| 16 | API keys needed | ✅ | ✅ | ✅ | ✅ | Lines 564-566 |
| 17 | Model/heartbeat change | ✅ | ✅ | ✅ | ✅ | Line 551 |

**Self-Diagnosis (4/4)**

| # | Item | v6 | v7 | v8 | v9 | Notes |
|---|------|----|----|-----|-----|-------|
| 18 | Health stale | ✅ | ✅ | ✅ | ✅ | Lines 630-634 |
| 19 | Telegram disconnects | ✅ | ✅ | ✅ | ✅ | Lines 617-622 |
| 20 | Skill fails | ✅ | ✅ | ✅ | ✅ | Lines 624-629 |
| 21 | Conversation corruption | ✅ | ✅ | ✅ | ✅ | Lines 636-640 |

**Section A Total: 63/63 (100%) post-fix**

---

## Section B: Diagnostic Coverage (16 failure modes)

All 16 failure modes from v8 held at ✅. No regressions.

| # | Subsystem | Failure Mode | v6 | v7 | v8 | v9 | Coverage Location |
|---|-----------|-------------|----|----|-----|-----|-------------------|
| 1 | Telegram | Bot token invalid/revoked | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md §Telegram |
| 2 | Telegram | Rate limited (429) | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md §Telegram |
| 3 | Claude API | Transport timeout | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md §Claude API |
| 4 | Claude API | Context overflow | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md §Claude API |
| 5 | Tools | Confirmation gate timeout | ✅ | ✅ | ✅ | ✅ | System prompt lines 501-505 |
| 6 | Tools | Tool result truncated | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md §Tools |
| 7 | Memory | memory_save fails (fs full) | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md §Memory |
| 8 | Memory | memory_search returns nothing | ✅ | ✅ | ✅ | ✅ | System prompt lines 509-515 |
| 9 | Cron | Job fails to send reminder | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md §Cron |
| 10 | Cron | Jobs lost after restart | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md §Cron |
| 11 | Bridge | Service down (ECONNREFUSED) | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md §Bridge |
| 12 | Bridge | Permission-specific errors | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md §Bridge |
| 13 | MCP | Server unreachable | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md §MCP |
| 14 | MCP | Tool definition changed (rug-pull) | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md §MCP |
| 15 | MCP | Rate limit exceeded | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md §MCP |
| 16 | Skills | Requirements not met | ✅ | ✅ | ✅ | ✅ | DIAGNOSTICS.md §Skills |

**Section B Total: 48/48 (100%)**

### New Failure Modes Check

| Change | Potential Failure Mode | Assessment |
|--------|----------------------|------------|
| vm sandbox | vm.Script compilation error on valid code | Returns descriptive SyntaxError — same error surface as before. Not a new diagnosable failure mode. |
| sandboxedRequire | Module blocked unexpectedly | Returns clear error message ("Module X is blocked in js_eval for security"). Existing "tool fails" playbook covers this. |
| Expanded redactSecrets | Regex performance on hot path | Cached compiled regexes mitigate. Not a runtime failure mode. |
| Checkpoint redaction | Corrupts checkpoint data | Deep-walk handles all JS types safely. Not a new failure mode. |
| Memory write redaction | Corrupts saved content | `redactSecrets()` is string→string, same as log redaction. Not a new failure mode. |

No new failure modes to add.

---

## Gaps Fixed

| File | Line | Issue | Fix |
|------|------|-------|-----|
| claude.js | 417 | js_eval description said "child_process and vm are blocked" — stale after BAT-305 added 5 more blocked modules + path restrictions | Updated to: "Blocked for security: child_process, vm, cluster, worker_threads, module, and relative/absolute path requires" |

---

## Code Issues Found

None. (BAT-305 security issues were addressed in the PR itself across 8 Copilot review rounds.)

---

## Remaining Gaps

**None.** All 21 knowledge items and all 16 diagnostic failure modes score ✅ post-fix.

---

## Observations

1. **BAT-305 is a security-only PR** — 7 fixes across 6 files, 8 Copilot review rounds. The only system prompt impact is the js_eval sandbox description becoming stale. All other changes are transparent infrastructure (redaction, checkpoint filtering, memory filtering).

2. **Fix 6 (system prompt guidance)** added two critical lines that are already in the code: "NEVER save keys to memory files" at lines 514 and 569. These were added as part of BAT-305 implementation, not by this audit.

3. **Known vm limitation** documented in tools.js:3599-3603 — host-realm objects expose `.constructor` back to unrestricted host Function. This is a fundamental Node.js vm limitation (docs say "not a security mechanism"). Covered by the planned shell permissions toggle (disable js_eval entirely). Not an SAB gap — it's a documented, accepted limitation.

4. **5 consecutive 100% audits** (v5→v9 post-fix). The system prompt and DIAGNOSTICS.md continue to be well-maintained.

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

Combined SAB Score:
v1  ██████████████████████████████░░░░░░░░░░░░░░░░░░░░  42/60   (70%)
v2  ██████████████████████████████████████████████░░░░  56/60   (93%)
v3  ██████████████████████████████████████████████████  60/60  (100%)
v4  ██████████████████████████████████████████████████ 108/108 (100%)
v5  ██████████████████████████████████████████████████ 108/108 (100%)  [SHELL_ALLOWLIST 22→34]
v6  ██████████████████████████████████████████████████ 111/111 (100%)  [+Official channels]
v7  ██████████████████████████████████████████████████ 111/111 (100%)  [DIAGNOSTICS.md MCP rate fix]
v8  ██████████████████████████████████████████████████ 111/111 (100%)  [enriched restart flushing door]
v9  ██████████████████████████████████████████████████ 111/111 (100%)  [fixed stale js_eval sandbox desc]
```

---

## Methodology

- **Source-only audit** — all scores derived from code reads, no runtime testing
- **Files read:** claude.js buildSystemBlocks() (lines 335-853), tools.js js_eval sandbox (lines 3500-3650), config.js (SHELL_ALLOWLIST line 234, SECRETS_BLOCKED line 225), DIAGNOSTICS.md (full 198 lines), SAB-AUDIT-v8.md (baseline)
- **Constants verified:** MAX_TOOL_USES=25, MAX_HISTORY=35, max_tokens=4096, SHELL_ALLOWLIST=34 commands, SECRETS_BLOCKED=3 files, BLOCKED_MODULES=7 modules, js_eval code limit=10,000 chars
- **Syntax verified:** `node -c claude.js` — pass
