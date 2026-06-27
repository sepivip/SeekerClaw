# SAB-AUDIT-v36 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-06-26
> **SAB Version:** v3
> **Scope:** Pre-merge gate for BAT-1062 (conversion re-quote on transient unreadable price-impact/minOut). Touched `buildSystemBlocks()` (extended the BAT-1061 slippage door + the BAT-1057 conversion door) + a new tool error `conversion_quote_unverifiable` + `solana_swap` description + a new DIAGNOSTICS subsection.
> **Method:** Focused audit on the conversion-quote-gate retry surface (door ↔ tool description ↔ DIAGNOSTICS ↔ probe). Gap fixes in the same change.
> **Baseline:** SAB-AUDIT-v35.md

## Scores

| Section | Pre-fix | Post-fix | Max |
|---------|---------|----------|-----|
| A: Knowledge & Doors (conversion-quote-scoped) | 6 | 6 | 6 |
| B: Diagnostics | 3 | 3 | 3 |
| C: Tool Consistency (`solana_swap`) | 3 | 3 | 3 |
| D: Behavioral Probe ("conversion can't verify price impact") | 3 | 3 | 3 |
| **Combined** | **15 (100%)** | **15 (100%)** | **15** |

## Section A — Knowledge & Doors (6/6)
- ✅ BAT-1061 slippage door extended: `conversion_quote_unverifiable` (retryable) = Jupiter returned routes without readable price-impact/minOut (intermittent flakiness) → the tool already re-quoted; if still returned, ask the user to retry, NOT the main wallet. Accurate to the code (re-quote inside the shared bounded loop; distinct error; `attempts`/`next_step`).
- ✅ BAT-1057 conversion door clarified: distinguishes a genuine **readable** >1% impact (terminal → main wallet) from an **unreadable** price-impact (retryable → fresh quote). This is the exact distinction Codex required.

## Section B — Diagnostics (3/3)
- ✅ New DIAGNOSTICS subsection: `conversion_quote_unverifiable` symptoms, diagnosis (transient route flakiness, fail-closed, capture evidence 6/6 readable), and the "retry with a fresh quote, never main wallet" fix — explicitly distinct from readable >1% (terminal).

## Section C — Tool Consistency (3/3)
- ✅ `solana_swap` description updated with the `conversion_quote_unverifiable` retryable case, consistent with both doors + DIAGNOSTICS.

## Section D — Behavioral Probe (3/3)
- ✅ "My PYUSD→USDC conversion keeps saying it can't verify the price impact" → door + DIAGNOSTICS reach correct guidance: the tool auto-re-quoted; if it still returns `conversion_quote_unverifiable`, ask the user to retry — do NOT defer to the main wallet or call it a PYUSD/Token-2022 limitation.

## Why pre-fix was already 100%
The fix landed door + description + DIAGNOSTICS together in the same change (no drift window), and the BAT-1061 v35 audit had already established the slippage surface — this extended it consistently. No gaps found on audit.

## Context note (deferred)
The systemic "stale memory steers users to the main wallet for a now-working feature" awareness problem (root cause from the BAT-1060 device test, and observed AGAIN in the BAT-1061 device test for this exact conversion path) remains **deferred per owner**. BAT-1062 makes the live tool + prompt correct so new sessions behave right; it does not reconcile existing device-side memory.
