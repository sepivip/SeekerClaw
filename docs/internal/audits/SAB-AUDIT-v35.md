# SAB-AUDIT-v35 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-06-26
> **SAB Version:** v3
> **Scope:** Pre-merge gate for BAT-1061 (burner swap slippage re-quote+retry). Touched `buildSystemBlocks()` (new swap-slippage door) + changed `solana_swap` behavior (auto-retry + `retryable:true`/`next_step` on slippage exhaustion) + a new DIAGNOSTICS section.
> **Method:** Focused audit on the slippage-retry surface (door ↔ tool description ↔ DIAGNOSTICS ↔ behavioral probe). Gap fixes applied in the same change.
> **Baseline:** SAB-AUDIT-v34.md

## Scores

| Section | Pre-fix | Post-fix | Max |
|---------|---------|----------|-----|
| A: Knowledge & Doors (slippage-scoped) | 6 | 6 | 6 |
| B: Diagnostics (slippage-scoped) | 3 | 3 | 3 |
| C: Tool Consistency (`solana_swap`) | 1 | 3 | 3 |
| D: Behavioral Probe ("swap keeps failing with slippage") | 3 | 3 | 3 |
| **Combined** | **13 (87%)** | **15 (100%)** | **15** |

## Section A — Knowledge & Doors (6/6)
- ✅ New door (ai.js ~752): a burner swap that signs but fails on-chain with slippage/`0x1771` is TRANSIENT; the tool auto-re-quotes+retries; `retryable:true` → ask the user to retry, NOT "use the main wallet"/"known issue". Accurate to the code (`MAX_SWAP_RETRIES=2`, `retryable:true`+`next_step` on exhaustion).
- ✅ Correctly distinguishes this from the BAT-1057 **pre-sign refusal** door (fee-bearing Token-2022 / >1% impact → genuinely route to main).

## Section B — Diagnostics (3/3)
- ✅ New DIAGNOSTICS section "Jupiter Swap — slippage / `0x1771` at execution (BAT-1061)": symptoms, diagnosis (transient, atomic-fail, no funds moved), what the tool auto-does (bounded retry, fresh re-gate, no retry on ambiguous), and the "tell the user to retry, never main wallet" fix.

## Section C — Tool Consistency (1/3 → 3/3)
- ❌→✅ **`solana_swap` description omitted the retry behavior.** Fixed: description now states slippage failures are auto-re-quoted+retried, and `retryable:true` means "market moved — ask the user to retry, don't call it a burner/Token-2022 limitation." Now consistent with the door + DIAGNOSTICS.

## Section D — Behavioral Probe (3/3)
- ✅ "My swap keeps failing / market moved / `0x1771`" → door + DIAGNOSTICS reach actionable, correct guidance: the tool already retried; if `retryable:true`, ask the user to retry; do NOT defer to the main wallet or call it a known limitation.

## Gaps Found (Pre-fix)
1. **MED (C):** `solana_swap` tool description didn't mention the auto-retry / `retryable` behavior — agent could under-describe it to the user.

## Fixes Applied (same change — BAT-1061)
- `ai.js` — new swap-slippage door.
- `tools/solana.js` — `solana_swap` description updated with the retry/slippage behavior.
- `DIAGNOSTICS.md` — new slippage section.

## Context note (deferred, NOT this ticket)
The systemic "stale memory outlives the fixed bug" awareness problem (device memory steering users to the main wallet for a now-working feature) is the larger root cause discovered in the BAT-1060 device test. It is intentionally out of scope here (owner deferred touching memory). BAT-1061 makes the live tool + prompt correct so **new** sessions behave right; it does not reconcile existing device-side memory.

## Remaining Gaps
- None for the audited (slippage-retry) surface. Post-fix 100%.
