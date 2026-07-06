# SAB-AUDIT-v41 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-07-03
> **SAB Version:** v3
> **Scope:** Delta audit for PR #432 / BAT-1109 — interim (pre-tool) assistant text delivery. Text emitted alongside a `tool_use` block is now delivered to the interactive user in real time (was silently dropped). Adds two new `[Interim]` WARN log sites.
> **Method:** Delta audit — score only the items this PR affects; carry forward the v40 post-fix baseline (100%) for untouched subsystems (tools, providers, channels, search, memory, cron, MCP, skills, reasoning). This PR adds no tools/providers/channels, so Sections C and D are unchanged by construction.
> **Baseline:** SAB-AUDIT-v40.md (240/246 = 97.6% pre-fix, 246/246 = 100% post-fix)

## Scores

| Section | Pre-fix | Post-fix | Max |
|---------|---------|----------|-----|
| A: Knowledge & Doors (30 baseline + 1 new: interim delivery) | 91 | 93 | 93 |
| B: Diagnostics (35 baseline + 1 new: interim delivery) | 106 | 108 | 108 |
| C: Tool Consistency (7 fixed + 5 rotated) — unchanged, no tools added | 36 | 36 | 36 |
| D: Behavioral Probes (2 fixed + 3 rotated) — unchanged | 15 | 15 | 15 |
| **Combined** | **248 (98.4%)** | **252 (100%)** | **252** |

Pre-fix **98.4% is above the 95% drift threshold** → no drift incident. The feature shipped with most self-awareness already in place (the existing "Tool Call Style" narration guidance in `buildSystemBlocks()` already instructs the agent to narrate alongside tool calls — this fix makes that narration actually reach the user, aligning delivery with the prompt's existing assumption). Two small delta items needed filling and were fixed in this same PR.

## Pre-fix Trend
| Audit | Pre-fix % | Post-fix % |
|-------|-----------|------------|
| v38 (BAT-1067) | ~ | 100 |
| v39 (BAT-1050) | ~ | 100 |
| v40 (holistic v2.1.0) | 97.6 | 100 |
| **v41 (BAT-1109 interim delivery)** | **98.4** | **100** |

## Section A — Knowledge & Doors (delta)

**New item: "Interim / pre-tool text delivery."**
Apply the 3-part new-door test:
1. Meaningfully changes how it works? **Yes** — narration written alongside a tool call now reaches the user live (previously dropped).
2. Users likely to ask / notice? **Yes** — they now see a pre-tool "let me check…" bubble, and could ask "why two messages?" or "I didn't get your first message."
3. Wrong/incomplete answer without coverage? **Yes (pre-fix ⚠️)** — the "Tool Call Style" section told the agent to narrate but never stated that pre-tool narration is delivered in real time, so the agent couldn't narrate intentionally and might repeat the same text verbatim in its final reply.

- **Pre-fix:** ⚠️ (1/3) — narration guidance present but silent on live delivery.
- **Fix:** one door line added to the "Tool Call Style" section of `buildSystemBlocks()` (ai.js): *"Text you write alongside a tool call is delivered to the user in real time (as its own message)… Narrate intentionally, and don't repeat that same text verbatim in your final reply."* The "don't repeat verbatim" clause also steers the agent away from the one known limitation (the final reply is not deduped against interim text — see PR #432).
- **Post-fix:** ✅ (3/3).

All 30 baseline items carry forward from v40 post-fix (90/90) unchanged — this PR touches none of them.

## Section B — Diagnostic Coverage (delta)

**New diagnostic mode: interim / pre-tool narration delivery.** Two new WARN log sites:
- `[Interim] send failed (continuing): …` — `message-handler.js` sendInterim wrapper (interactive channel send error).
- `[Interim] sendInterim threw (continuing tool turn): …` — `ai.js` tool-loop defensive guard.
- (plus `[Interim] Duplicate interim text suppressed` at DEBUG — recovery-replay dedup, not an error.)

- **Pre-fix:** ⚠️ (1/3) — the WARN sites are visible in `node_debug.log` but had no `DIAGNOSTICS.md` diagnosis path; a user reporting "your first message never arrived" had no guided answer.
- **Fix:** new `DIAGNOSTICS.md` entry under **Tools** → *"Interim / Pre-Tool Narration Not Delivered (BAT-1109)"* — symptoms, `grep "[Interim]"` check, per-line diagnosis (transient send error vs. dedup suppression vs. nothing-to-deliver), and fix (transient/self-recovering; final reply unaffected; interactive-channel-only by design).
- **Post-fix:** ✅ (3/3).

All 35 baseline modes carry forward from v40 post-fix (105/105) unchanged.

## Section C — Tool Consistency

Unchanged. This PR adds no tools and changes no tool descriptions, confirmation gates, or safety semantics. v40 result (36/36) carries forward.

## Section D — Behavioral Probes

Unchanged. No new user-facing troubleshooting scenario is introduced beyond the Section B entry above (which is itself the door→target path for "my pre-tool narration didn't arrive"). v40 result (15/15) carries forward.

## Negative Knowledge

Unchanged (6/6) — this PR introduces no new capability boundary.

## Gaps Found (Pre-fix)
1. **Section A** — no door stating pre-tool narration is delivered live (⚠️).
2. **Section B** — two new `[Interim]` WARN sites without a `DIAGNOSTICS.md` diagnosis path (⚠️).

## Fixes Applied (same PR)
1. `ai.js` `buildSystemBlocks()` — one door line in "Tool Call Style".
2. `DIAGNOSTICS.md` — "Interim / Pre-Tool Narration Not Delivered (BAT-1109)" entry.

## Code Issues Found
None (the delivery-correctness findings from Copilot/CodeRabbit were fixed in the same PR before this audit; see PR #432).

## Remaining Gaps
None. Post-fix 252/252 = 100%.
