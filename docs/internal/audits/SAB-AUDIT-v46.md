# SAB-AUDIT-v46 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-07-12
> **SAB Version:** v3
> **Scope:** Pre-merge gate for PR #440 (BAT-1148 / BAT-1091) — Jupiter **Trigger V2 becomes the default** order engine; new DIAGNOSTICS entry for the V2 ambiguous-create recovery path. `buildSystemBlocks()` self-awareness delta only (the rest of the surface is unchanged since v45).
> **Method:** Targeted delta-audit over the v45 baseline — the change touches one capability (V2 default) + one DIAGNOSTICS room, adds no new ERROR/WARN log sites, and (pre-fix) did not touch `buildSystemBlocks()`.
> **Baseline:** SAB-AUDIT-v45.md (100% post-fix)
>
> **Renumbered v44 → v46 (2026-07-15):** while PR #440 was open, main merged its own **SAB-AUDIT-v44** (BAT-1172, xAI error-shape) and **v45** (BAT-1161, logging substrate). This Trigger V2 audit — run 2026-07-12, originally numbered v44 — is renumbered to v46 to avoid the collision; findings unchanged, baseline advanced to v45.

## Scores

| Section | Pre-fix | Post-fix | Max |
|---------|---------|----------|-----|
| A: Knowledge & Doors (delta: limit-order door) | 3 | 3 | 3 |
| B: Diagnostics (new: `create_ambiguous_no_recovery`) | 1 | 3 | 3 |
| C: Tool Consistency (`jupiter_trigger_create`) | 3 | 3 | 3 |
| D: Behavioral Probe ("did my limit order go through?") | 0 | 3 | 3 |
| **Combined (change surface)** | **7/12 (58%)** | **12/12 (100%)** | 12 |

*Change-surface score only. The unchanged v45 baseline (Identity / Architecture / other tools / other diagnostics) remains at its last-audited 100%; combined project score post-fix = 100%.*

## Pre-fix Trend

| Audit | Pre-fix % | Post-fix % |
|-------|-----------|------------|
| v43 | 100% | 100% |
| v44 — BAT-1172 (xAI error-shape) | 33.3% | 100% |
| v45 — BAT-1161 (logging substrate) | 5.6% | 100% |
| v46 — this PR (Trigger V2, change surface) | 58% | 100% |

The 58% pre-fix is a genuine drift signal **caught before merge** (per the CLAUDE.md gate) — a new user-facing failure mode shipped with a DIAGNOSTICS room but no system-prompt door. Fixed in the same PR; nothing shipped uncovered.

## Section details

### A — Knowledge & Doors ✅ (no drift; consistency improved)
- **Limit-order self-knowledge** (`ai.js` ~L786): *"buy SOL if it drops to $80 … sell when it hits $100"*. With V2 now the default, trigger prices are **USD-denominated** (`triggerPriceUsd`) — the "$80/$100" examples now MATCH the active tool. (Under the old V1 default the tool spoke of an output/input *ratio* while the prompt implied USD — a latent minor inconsistency this change removes.) Token-2022-not-supported note still accurate for V2.
- No identity / architecture / configuration items affected.

### B — Diagnostics ⚠️→✅ (the gap)
- **NEW** `create_ambiguous_no_recovery` (V2 deposit→create lost-response). DIAGNOSTICS.md room added in this PR (symptoms, `/orders/history` recovery, conservative cap commit, `jupiter_trigger_list` verification). **Pre-fix: room present but no door** → scored ⚠️(1).
- No new ERROR/WARN log sites introduced (`git diff` confirms) → no Phase-2 auto-discovery additions.

### C — Tool Consistency ✅ (`jupiter_trigger_create`)
- Tool description (V2, `tools/solana.js` L287) ↔ system prompt (Limit Orders L786) ↔ confirmation gate (listed in `ai.js` L976 mandatory-gate tools) all agree. V2 `triggerPriceUsd` + `anyOf` expiry match the inverted `tool-schemas.test.js`. Routing (burner-cap silent / main popup) consistent.

### D — Behavioral Probe ❌→✅ ("I created a limit order but I'm not sure it worked")
- **Pre-fix (0):** the agent, seeing `create_ambiguous_no_recovery`, had **no door** telling it the state is genuinely ambiguous. Likely wrong answer: *"your order failed, retrying"* → **a duplicate order** (the deposit may have landed). This is the high-severity, fund-affecting failure the probe is designed to catch.
- **Post-fix (3):** added a door in `buildSystemBlocks()` (`ai.js`, in the Solana/Jupiter section): ambiguous ≠ failed → check `jupiter_trigger_list` first → don't blindly re-create → points to the DIAGNOSTICS room.

## Gaps Found (Pre-fix)
1. **No system-prompt door for `create_ambiguous_no_recovery`** (V2 ambiguous-create). Severity: high (duplicate-order / fund risk from a wrong agent answer).

## Fixes Applied (same PR)
1. Added the ambiguous-create door to `buildSystemBlocks()` (`ai.js`) — 1-line pointer to `DIAGNOSTICS.md → "Jupiter Trigger V2 create is ambiguous"`. Validated: `node tests/nodejs-project/smoke.js` PASS.

## Code Issues Found
None.

## Remaining Gaps
None on the change surface. Post-fix 100%.
