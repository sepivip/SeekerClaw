# SAB-AUDIT-v32 — BAT-1031 Delta

> **Date:** 2026-06-09
> **SAB Version:** v3 (delta audit, BAT-1031-focused)
> **Scope:** PR #402 (BAT-1031 Option A) — burner-policy reject-code retirement (`simulation_recipient_mismatch` removed, REJECT_CODES locked length 29 → 28) + Option A "trust Jupiter for V2 trigger / DCA deposit destination" posture.
> **Method:** 4-source consistency check (code / system prompt / DIAGNOSTICS / drift-guard test) + 3 BAT-1031-specific behavioral probes.
> **Baseline:** SAB-AUDIT-v31.md (REJECT_CODES.length === 29).

## Scores

| Section | Pre-fix | Post-fix | Max | Notes |
|---|---|---|---|---|
| A — Knowledge & Doors | 11 | 15 | 15 | Trust-posture door added; reject-code retirement door added |
| B — Diagnostics | 9 | 12 | 12 | V2 trigger / DCA trust subsection + Retired reject codes table added; `simulation_mint_mismatch` row expanded |
| C — Tool Consistency | 12 | 12 | 12 | Already clean — code / prompt / docs / drift-guard test in 4-source sync |
| D — Behavioral Probes | 2 | 9 | 9 | Both ship-blocker probes (V2 deposit acceptance + retired-code surface) now have actionable doors |
| **Combined** | **34** (71%) | **48** (100%) | **48** | Above 90% ship gate post-fix |

## Pre-fix Trend

| Audit | Pre-fix % | Post-fix % | Scope |
|---|---|---|---|
| v29 | 96% | 100% | (baseline) |
| v30 | 95% | 100% | OAuth post-merge sweep |
| v31 | 94% | 100% | BAT-1002 V2 trigger error-code playbook |
| **v32** | **71%** | **100%** | BAT-1031 Option A — delta-only audit, not full |

⚠ **Significant drift pre-fix.** Two ship-blockers in agent-visible surfaces (`ai.js` system prompt + `DIAGNOSTICS.md`) — code was correct and 4-source consistency stayed clean, but the new trust posture introduced by BAT-1031 had no door anywhere user-facing. This is the exact knowledge-vs-capability drift CLAUDE.md flags as ship-blocker class: the policy changed how it treats Jupiter destinations, but the agent had no way to explain that to a user.

This audit is a **delta-only** focused on the BAT-1031 surface (4 sub-items per section instead of 30+). A full v3 audit will run on the next major shipment.

## What Changed Since v31

BAT-1031 PR #402 (HEAD `7afa9c2c`) ships three coupled changes:

1. **`wallet/burner-policy.js`** — deleted `validateSimDelta expectedTokenOwner` branch (sole fire site for `simulation_recipient_mismatch`) + the `depositVault` shape requirement + `_isStrictPubkey` helper. REJECT_CODES locked length 29 → 28.
2. **Option A trust posture** — `jupiter_trigger_create_deposit` + `jupiter_dca_create_deposit` no longer bind a destination; they enforce only `burnerDebit` (mint + atomic amount) + `sol_fee_headroom` / `wantsBurnerSolFloor`. Same trust class as `jupiter_swap_immediate` and `jupiter_ultra` (shipped since BAT-582).
3. **Drift-guard test** — `tests/nodejs-project/burner-policy.test.js` asserts `REJECT_CODES.length === 28` AND `simulation_recipient_mismatch` absent AND `simulation_mint_mismatch` present.

## Findings (pre-fix)

### Ship-Blockers (2, both addressed)

- **D-Probe1 — No door for "why was this V2 deposit accepted with a strange PDA destination?"** Grep for `BAT-1031|depositVault|trust.*jupiter|trigger_v2` across `ai.js` returned ZERO matches. Same grep across `DIAGNOSTICS.md` returned ZERO matches. The agent following documented doors could only say "the policy approved it so it must be fine" — not actionable, and could confabulate the deleted depositVault binding from training memory.
- **D-Probe3 — No retirement notice for `simulation_recipient_mismatch`.** Code retired, but neither `ai.js` nor `DIAGNOSTICS.md` mentioned it. An agent encountering this code in stale logs would treat it as a live security reject by analogy with other `simulation_*` codes.

### Should-Fix (2, both addressed)

- **B-Item3** — DIAGNOSTICS.md burner-policy section had no V2-trigger / trust-Jupiter subsection. The closest neighbor (BAT-1024 SOL-rent gotcha) explains a failure mode, not the acceptance posture.
- **D-Probe2** — `simulation_mint_mismatch` row in DIAGNOSTICS.md was vague on which side mismatched; post-BAT-1031 this fires ONLY on the burner-side debit account (Jupiter destinations no longer mint-validated).

### Clean (Nits — no action)

- C — REJECT_CODES length 28, 4-source consistency holds (12/12).
- A — Security / Availability / Contract-gap enumerations match the code verbatim (11/15 — only the trust posture door was missing).
- B — `simulation_recipient_mismatch` cleanly absent from docs; no stale `depositVault` / `expectedTokenOwner` references survive the BAT-1031 cleanup.

## Fixes Applied (in PR #402)

| Surface | Edit |
|---|---|
| `ai.js` `buildSystemBlocks()` Burner-policy block | Added `**Jupiter deposit-destination trust (BAT-1031):**` paragraph naming the four trusting kinds + the burner-side enforcement set + the v9.1 history note. |
| `ai.js` `buildSystemBlocks()` Burner-policy block | Added `**Retired reject codes (BAT-1031):**` paragraph naming `simulation_recipient_mismatch` removal + stale-APK SHA-verification advice. |
| `DIAGNOSTICS.md` Security reject table — `simulation_mint_mismatch` row | Expanded to note BAT-1031 scoped this check to burner-side debit only + listed likely causes (wrong ATA derivation, wrong mint, bundled-instruction injection). |
| `DIAGNOSTICS.md` burner-policy section — new subsection | `### BAT-1031: Jupiter deposit-destination trust (Option A)` — covers the four trusting kinds, the burner-side enforcement set, the "what this is NOT" disclaimer, the v9.1 history note, and the two user-asks-the-agent flows. |
| `DIAGNOSTICS.md` burner-policy section — new table | `### Retired reject codes (post-BAT-1031)` — `simulation_recipient_mismatch` retirement entry with stale-APK diagnostic. |

All fixes are documentation-only edits to `ai.js` + `DIAGNOSTICS.md`. No code change. No test change.

## Code Issues Found

None. Code behavior matches the BAT-1031 contract; the audit found doc-only drift.

## Post-Fix Verification

- `node --check app/src/main/assets/nodejs-project/ai.js` — PASS
- `node tests/nodejs-project/smoke.js` — 23/23 modules load
- `node tests/nodejs-project/burner-policy.test.js` — 144 passed
- Section A re-scored: 15/15 (Option A trust-posture door + retired-code door both present)
- Section B re-scored: 12/12 (subsection added, table added, mint-mismatch row expanded)
- Section D re-scored: 9/9 (Probe 1 has an actionable door; Probe 3 has an actionable door; Probe 2 row expanded)
- **Post-fix total: 48/48 (100%)**

## Remaining Gaps

None for BAT-1031. The next full v3 SAB audit should re-run all sections (not just the BAT-1031 delta) on the next major feature shipment.

## Sign-Off Posture

**SIGNABLE post-fix.** SAB delta clean at 100%. BAT-1031 PR #402 satisfies CLAUDE.md's "SAB Audit BEFORE Merge" rule because the four fixes ship inside the same PR as the reject-code surface change.
