# SAB-AUDIT-v42 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-07-07
> **SAB Version:** v3
> **Scope:** Delta-audit for BAT-1130 (PR #435) — content-filter deadlock fix. Touches `buildSystemBlocks()` in `ai.js` and `DIAGNOSTICS.md`, so the pre-merge gate applies.
> **Method:** Focused read of the `buildSystemBlocks()` sections the diff touches + a new-failure-mode diagnostic check + the auth/billing behavioral probe. Unchanged sections carry forward from v41.
> **Baseline:** SAB-AUDIT-v41.md (2026-07-03, 98.4% → 100%)

## What changed in this PR (self-awareness surface)

1. **Recent Sessions** block moved from the cached *stable* block to the uncached *dynamic* block — **same content**, different block (verified by `system-prompt-recent-sessions.test.js`). The agent still sees "## Recent Sessions" every turn.
2. **`leanMemory`** option added to `buildSystemBlocks()` — omits Recent Sessions + MEMORY.md + daily memory. Used **only** by the tool-loop self-heal retry; the normal turn is unaffected.
3. **Heartbeat sessions are no longer summarized** → they no longer appear in Recent Sessions (they carried no continuity value). The **Heartbeats section** of the prompt (poll → `HEARTBEAT_OK` protocol) is **untouched** — the agent's knowledge of the heartbeat protocol is unchanged.
4. **`getRecentSessions()`** filters legacy `HEARTBEAT_OK` rows in SQL.
5. New failure mode + auto-recovery: a setup_token `400 "out of extra usage"` is now recognized as a likely content-filter false-positive and auto-retried lean (`[SelfHeal]` WARN).
6. `cc_version` 2.1.116 → 2.1.195 (billing header — **not** agent-facing; no prompt/DIAGNOSTICS surface).

## Scores

| Section | Pre-fix | Post-fix | Max |
|---------|---------|----------|-----|
| A: Knowledge & Doors (delta items) | 15 | 15 | 15 |
| B: Diagnostics — new failure mode ("out of extra usage") | 0 | 3 | 3 |
| C: Tool Consistency (spot-check, unchanged) | 6 | 6 | 6 |
| D: Behavioral Probes (auth/billing + channel) | 4 | 6 | 6 |
| **Combined (delta)** | **25 (83.3%)** | **30 (100%)** | **30** |

> This is a **delta-audit**: only the surface the PR touches is re-scored. The full-suite baseline (v41: 252/252 = 100% post-fix) is otherwise unchanged — no tool added/removed, no capability added, no identity/architecture/config drift. The single pre-fix gap is the new failure mode this PR introduces, filled in the **same PR** per the same-PR rule.

## Pre-fix Trend
| Audit | Pre-fix % | Post-fix % |
|-------|-----------|------------|
| v40 | 100% | 100% |
| v41 | 98.4% | 100% |
| v42 (delta) | 83.3% (delta only) | 100% |

## Section details

**A — Knowledge & Doors (no drift).**
- Recent Sessions: still presented (dynamic block) — the agent's temporal-continuity awareness is intact. ✅
- Heartbeats: protocol section unchanged; agent still knows to read `HEARTBEAT.md` and reply `HEARTBEAT_OK`. ✅
- Auth-error guidance (in-prompt "If API calls keep failing" playbook): softened line 2 to be auth-agnostic (setup_token users have no API key). ✅ (was slightly misleading, now accurate)
- `leanMemory` is an internal recovery mechanism, not a user-visible capability — no door needed (agent doesn't advertise it; DIAGNOSTICS documents the observable `[SelfHeal]` behavior). ✅
- cc_version: billing header, no agent-facing surface — correctly absent from the prompt. ✅

**B — Diagnostics (1 gap, fixed).**
- **GAP (pre-fix):** no DIAGNOSTICS entry for the setup_token `400 "out of extra usage"` content-filter false-positive — a user asking "why out of extra usage?" would get the wrong answer ("you're out of credits"). ❌→✅
- **FIX:** added `DIAGNOSTICS.md → "Pro/Max Sign-in: 'You're out of extra usage' (400, often misleading)"` (symptoms, `node_debug.log` check, content-vs-usage diagnosis, the auto-`[SelfHeal]` behavior, and the persist-past-retry fix) + a one-line in-prompt door (playbook item 5b) pointing to it.
- New WARN log site `[SelfHeal]` is now covered by that DIAGNOSTICS entry (the `grep` check surfaces it). ✅

**C — Tool Consistency (spot-check, unchanged).** No tool descriptions, schemas, or confirmation gates changed in this PR. Spot-checked `solana_swap` / `agent_pay` prompt-vs-policy agreement — unchanged and consistent. ✅

**D — Behavioral Probes.**
- Fixed probe "Agent won't respond to messages" → channel-connection door → DIAGNOSTICS channel section: unchanged, ✅.
- Rotated probe **"API key not working" / auth-billing**: pre-fix the "out of extra usage" variant hit no door (⚠, 1/3 — 401 door existed but the 400 case didn't); post-fix the new door + DIAGNOSTICS room make it actionable (✅ 3/3).
- Rotated probe **"Agent shows 'out of extra usage'"** (new, this PR): pre-fix ❌ (no coverage) → post-fix ✅ (door + room + auto-recovery description).

## Gaps Found (Pre-fix)
1. No DIAGNOSTICS/prompt coverage for the setup_token `400 "out of extra usage"` content-filter false-positive (the failure mode this PR fixes).

## Fixes Applied (same PR)
1. `DIAGNOSTICS.md`: new "out of extra usage" troubleshooting room (self-contained; on-device readable).
2. `ai.js buildSystemBlocks()`: in-prompt playbook door (item 5b) + auth-agnostic 401/403 line.

## Code Issues Found
None (the code correctness issues in this PR were caught in the Copilot review cycle, not the SAB audit).

## Remaining Gaps
None. Post-fix delta score 100%; the full-suite baseline is unchanged from v41.
