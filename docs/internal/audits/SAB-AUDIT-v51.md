# SAB-AUDIT-v51 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-11-16
> **SAB Version:** v4
> **Mode:** Delta
> **Scope:** BAT-1664 (Claude preserved-thinking): thinking replayed only within the current turn, verbatim, with prefix binding on flagged models; signature-400 heal and binding-rejection fallback; stable in-turn history for flagged models; a formatted-payload budget gate for all first-party Claude that can end a turn with `context_budget_exceeded`.
> **Diff range:** origin/main 978d108d..feature/BAT-1664-claude-thinking-replay-binding
> **Method:** read the `buildSystemBlocks()` Self-Diagnosis Playbook and Diagnostics block; DIAGNOSTICS.md "## LLM API", "Agent Loses the Task Mid-Turn", "Context Overflow" and "Reasoning" sections; every ERROR/WARN site the branch adds (JS only — no Kotlin change); tool descriptions (none changed); traced two probes.
> **Baseline:** SAB-AUDIT-v48.md (Full, 2026-10-19). v49 (#465) and v50 (#466) are deltas on unmerged branches, so this audit claims v51.
> **Gate status:** On time (before the BAT-1664 PR is merged).
> **Next full audit due:** before the next release that ships code (the v2.3.x/2.4 RC). Deltas since the last full: v49, v50, v51.

## Scores (audited surface only)

| Section | Pre-fix | Post-fix | Max |
|---------|---------|----------|-----|
| A: Knowledge & Doors (1 item touched: conversation/context self-diagnosis) | 1 | 3 | 3 |
| B: Diagnostics (curated: Context Overflow; Agent Loses the Task Mid-Turn; Reasoning-400 Quarantine) | 9 | 9 | 9 |
| B: Diagnostics (discovered: 8 new log sites) | 20 | 24 | 24 |
| C: Tool Consistency | N/A (no tool description changed) | — | — |
| D: Behavioral Probes (2, delta) | 4 | 6 | 6 |
| **Combined (audited surface)** | **34 / 42 (81%)** | **42 / 42 (100%)** | **42** |

## Pre-fix Trend
| Audit | Mode | Pre-fix % | Post-fix % | Drift or correction |
|-------|------|-----------|------------|---------------------|
| v48 | Full | (see v48) | 100% | — |
| v50 | Delta (#466) | 58% (surface) | 100% | Drift, fixed in the same PR |
| v51 | Delta (BAT-1664) | 81% (surface) | 100% | Drift: the new turn-ending state had no playbook door and two internal WARN lines had no entry; fixed in the same PR before merge |

## Section A
| Item | Pre | Post | Note |
|------|-----|------|------|
| Self-diagnosis: conversation / context limits | ⚠️ 1 | ✅ 3 | The playbook covered `/new`, `/reset`, the step limit and the loop detector, but not the new budget exit. Added item 3b: names the message, the log reason `context_budget_exceeded`, the fix (smaller step or `/new`, `/resume` may repeat) and the DIAGNOSTICS section. |

No other Section A item changed. Thinking replay is an internal wire behaviour the user does not ask about directly; the user-visible outcomes (a healed 400, a dropped block, a stopped turn) are covered in Section B.

## Section B — curated rows touched
| Row | Pre | Post | Note |
|-----|-----|------|------|
| AI API: Context overflow | ✅ 3 | ✅ 3 | "Context Overflow (400 Error)" gained a note pointing to the budget gate, which now stops before a 400 on first-party Claude. |
| AI API: Agent loses the task mid-turn | ✅ 3 | ✅ 3 | Updated: stable-history models trim at turn end, not per round. |
| Reasoning: Reasoning-400 quarantine | ✅ 3 | ✅ 3 | The "## Reasoning" text no longer claims Claude replays reasoning across turns. |

New DIAGNOSTICS sections added by the branch (counted under discovered sites below): "Claude: turn stopped at the context limit — `context_budget_exceeded`", "Claude: 'Invalid `signature` in `thinking` block' (400) — auto-healed once per turn", the binding-control rejection fallback, and the `[ThinkingBinding]` dropped-reasoning lines. A curated row for the context-limit stop should be added to the sab-audit skill list (seekerclaw-skills).

## Section B — discovered log sites (JS)
| Log line | Level | Pre | Post |
|----------|-------|-----|------|
| `[ThinkingBinding] status=400 thinking-signature mismatch — retrying turn once …` | WARN | ✅ | ✅ |
| `[ThinkingBinding] status=400 binding control rejected (host=… auth=…) — disabled for this credential until restart …` | WARN | ✅ | ✅ |
| `[ThinkingBinding] capability record failed: …` | WARN | ⚠️ | ✅ (added) |
| `[ContextBudget] request ~N tokens … is over the 90% budget — reducing once …` | WARN | ✅ | ✅ |
| `[ContextBudget] still ~N tokens … after reduction — not sending; ending the turn (context_budget_exceeded)` | WARN | ✅ | ✅ |
| `[ContextBudget] closing-summary request is over the context budget — not sending …` | WARN | ✅ | ✅ |
| `[Trace] {… "reason":"context_budget_exceeded" …}` | WARN | ✅ | ✅ |
| `[History] turnEnd trim failed: …` | WARN | ⚠️ | ✅ (added) |

The `[AnchorGuard]` ERROR in the diff is the existing line, re-indented inside the new emission path; its entry is unchanged and still accurate. INFO/DEBUG lines (`[ContextBudget] reduced … sending`, `[ThinkingBinding] thinking-dropped-prefix-binding-mismatch`, `model_binding_mismatch`) are documented too.

## Section D (delta probes)
| Probe | Pre | Post |
|-------|-----|------|
| "Why did you stop and say the conversation hit the context limit?" | ⚠️ 1 — the agent sees its own fallback message in history, but nothing in the prompt says what it means or what to suggest | ✅ 3 — playbook 3b → DIAGNOSTICS "turn stopped at the context limit" (cause, `/new`, why `/resume` can repeat) |
| "My last request failed with 'Invalid signature in thinking block'" | ✅ 3 — generic "read DIAGNOSTICS.md" door → "## LLM API" section with the heal, the second-400 case and the fix | ✅ 3 |

## Gaps Found (Pre-fix)
1. No playbook door for the `context_budget_exceeded` turn end — drift.
2. Two internal WARN sites without an entry — drift.

## Fixes Applied (same PR)
- `ai.js` `buildSystemBlocks()`: Self-Diagnosis Playbook item 3b (context limit).
- `DIAGNOSTICS.md`: entries for `[ThinkingBinding] capability record failed` and `[History] turnEnd trim failed`.

## Code Issues Found
None in this audit. (The branch's independent review earlier found and fixed an image-turn block in the budget gate and an unescaped `[ContextBudget]` grep.)

## Remaining Gaps
None on the audited surface.
