# SAB-AUDIT-v46 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-07-23
> **SAB Version:** v3
> **Scope:** Delta-audit for **BAT-1186 Stage 1** (PR #446) — anchor-preserving history trim. Touches `buildSystemBlocks()` in `ai.js` (the "History window" self-description), adds two new log sites (`[History]` WARN/DEBUG, `[AnchorGuard]` ERROR/DEBUG), a new pure module `history-trim.js`, and a new `DIAGNOSTICS.md` section. Pre-merge gate applies (new WARN/ERROR sites + `buildSystemBlocks()` + `DIAGNOSTICS.md`).
> **Method:** Delta read of the changed `buildSystemBlocks()` line + the new log sites + the new DIAGNOSTICS section; field-name cross-check against the emitters.
> **Baseline:** SAB-AUDIT-v45.md (BAT-1161 P1A delta; full-suite baseline v41 = 252/252 = 100% post-fix).

## Scores

| Section | Pre-fix | Post-fix | Max |
|---------|---------|----------|-----|
| A: Knowledge & Doors (delta) | 1 | 3 | 3 |
| B: Diagnostics — new failure mode + log sites (delta) | 0 | 6 | 6 |
| C: Tool Consistency | N/A | N/A | — |
| D: Behavioral Probes (delta) | 0 | 3 | 3 |
| **Combined (delta)** | **1 (8.3%)** | **12 (100%)** | **12** |

> **The low pre-fix is what BAT-1186 exists to fix, not new drift.** The anchor-eviction bug was **silent** — no log line, no diagnosis path — and the prompt's "History window" line accurately described the *old, buggy* behavior ("older messages are dropped from context"). This PR changes the behavior (the current turn's instruction is now exempt) and must update the self-knowledge in lockstep. Post-fix 100%. No tools changed; negative-knowledge boundaries unchanged (6/6).

## Pre-fix Trend
| Audit | Pre-fix % | Post-fix % |
|-------|-----------|------------|
| v41 | 98.4% | 100% |
| v42 (delta) | 83.3% | 100% |
| v43 (delta) | 95.2% | 100% |
| v44 (delta) | 33.3% | 100% |
| v45 (delta) | 5.6% | 100% |
| v46 (delta) | 8.3% | 100% |

## Section A — Knowledge & Doors (delta) — 1/3 pre, 3/3 post

| Item | Pre | Post | Notes |
|------|-----|------|-------|
| **History window** self-description | ⚠️ | ✅ | Pre (`ai.js:1543`): "35 messages per chat. **Older messages are dropped from context.**" — accurate to the pre-fix (buggy) behavior, but after the additive-exempt fix it is stale: the current turn's own instruction is now **never** dropped, so an agent reading this line could wrongly tell a user "I only keep the last 35 messages so I may lose your instruction on a long task." Post: the line now states the current turn's instruction is always kept even on a long multi-tool turn (BAT-1186), and adds a door → `DIAGNOSTICS.md → "Agent Loses the Task Mid-Turn"`. |

Negative-knowledge boundaries: **6/6** (unchanged — no change to "what it cannot do"). Constants: `MAX_HISTORY = 35` unchanged and still accurately referenced in the prompt and `DIAGNOSTICS.md:144`.

## Section B — Diagnostics (delta) — 0/6 pre, 6/6 post

| Item | Pre | Post | Notes |
|------|-----|------|-------|
| **Failure mode:** agent loses the task mid-turn / confabulates on a long turn | ❌ | ✅ | Pre: zero coverage — the bug produced model-generated confabulation ("I didn't receive any text") with **no** log line and **no** DIAGNOSTICS entry, so a user (or the agent) had no diagnosis path. Post: new `DIAGNOSTICS.md` section "Agent Loses the Task Mid-Turn / Confabulates on a Long Turn (BAT-1186)" — symptoms, `grep` check, diagnosis, fix, and the historic-build note. |
| **New log site `[History]`** (WARN once per turn+site via `warnOnce`, else DEBUG) | ❌ | ✅ | Documented: fields `{turnId, site, removed, anchorSkipped, anchorExempt, nonAnchorLen, len, cap}` — verified against the emitter in `history-trim.js`/`ai.js`. `anchorSkipped:1` explained as normal-on-long-turns (the fix working), not an error. |
| **New log site `[AnchorGuard]`** (ERROR first 3/process, else DEBUG) | ❌ | ✅ | Documented: fields `{turnId, taskId, step, adapter, event, len, cumulative}` — verified against the emitter. Explained as "should NEVER fire in a healthy build; if it does, a trimming path is not anchor-aware → file a bug." |

Auto-discovery: the only other touched log line is the pre-existing `[Context] Adaptive trim` WARN, whose message was amended (`(turn anchor preserved)` suffix) — already covered under Context Overflow; no new coverage needed.

## Section C — Tool Consistency

**N/A for this delta.** No tools added, removed, or changed; no confirmation-gate or schema changes. Carry v45 (fixed-7 + rotated-5 all ✅). Spot-check: `shell_exec` / `agent_pay` / `solana_swap` descriptions unchanged by this PR.

## Section D — Behavioral Probes (delta) — 0/3 pre, 3/3 post

| Probe | Pre | Post | Notes |
|-------|-----|------|-------|
| "I lost track of my task mid-way / you forgot what I asked" | ❌ | ✅ | Door: `buildSystemBlocks()` History-window line now points to `DIAGNOSTICS.md → "Agent Loses the Task Mid-Turn"`. Target: the new DIAGNOSTICS section has symptoms + `grep -E "\[History\]\|\[AnchorGuard\]"` check + diagnosis + fix. Full path actionable. |

Fixed probes ("web search broken", "agent won't respond") unchanged from v45 → carry ✅.

## Gaps Found (Pre-fix)
1. **A** — stale "History window" self-description (described the pre-fix drop-the-instruction behavior).
2. **B** — no diagnosis path for the long-turn confabulation failure mode; two new log sites undocumented.
3. **D** — no door/probe path for "lost the task mid-turn".

## Fixes Applied (same PR)
- `ai.js` `buildSystemBlocks()` History-window line rewritten + DIAGNOSTICS door added.
- `DIAGNOSTICS.md` "Agent Loses the Task Mid-Turn" section (added in the main PR commit); `[History]` / `[AnchorGuard]` fields documented and cross-checked against emitters.

## Code Issues Found
None (the audit found only self-knowledge/diagnostics gaps, all fixed here). The two review-round code bugs (`slice(-0)`, orphan-cleanup paths) were already fixed under Copilot/CodeRabbit review before this audit.

## Remaining Gaps
None. Post-fix 100% on the delta. Validation: `node tests/nodejs-project/smoke.js` PASS.
