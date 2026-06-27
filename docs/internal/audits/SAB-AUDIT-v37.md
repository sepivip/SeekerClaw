# SAB-AUDIT-v37 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-06-27
> **SAB Version:** v3
> **Scope:** Pre-merge gate for BAT-1066 (CodeRabbit #413 + #419). The `solana_swap` `expectedDelta`-build `catch` previously flipped a **burner** route to `main` and signed via MWA — handing a burner-taker order to the main wallet (the BAT-1038 Amendment 1 risk class). Fix fails closed on a burner route with a new `expected_delta_unbuildable` error (retryable); main routes are unchanged. CodeRabbit #419 follow-up: the remediation is **route-aware** — a held-token BAT-1057 conversion's input lives only in the burner, so "use the main wallet" is not a valid fallback (retry only); ordinary burner swaps still offer the main wallet. Same-class sweep applied the route-aware hint to the sibling `fee_payer_mismatch` too. Touched `buildSystemBlocks()` (extended the burner tool-handler-errors door), `DIAGNOSTICS.md` (new tool-handler-errors row + route-aware note), a new tool error code + new WARN log site in `tools/solana.js`.
> **Method:** Focused audit on the `expected_delta_unbuildable` surface (door ↔ tool error ↔ DIAGNOSTICS ↔ probe), consistency with the sibling `fee_payer_mismatch` guard. Gap fixes in the same change.
> **Baseline:** SAB-AUDIT-v36.md

## Scores

| Section | Pre-fix | Post-fix | Max |
|---------|---------|----------|-----|
| A: Knowledge & Doors (expected_delta scoped) | 3 | 3 | 3 |
| B: Diagnostics | 3 | 3 | 3 |
| C: Tool Consistency (`solana_swap`) | 3 | 3 | 3 |
| D: Behavioral Probe ("burner swap can't build its safety check") | 3 | 3 | 3 |
| **Combined** | **12 (100%)** | **12 (100%)** | **12** |

## Section A — Knowledge & Doors (3/3)
- ✅ Burner tool-handler-errors door (ai.js ~797) extended: `expected_delta_unbuildable` (BAT-1066, `solana_swap` only) = burner safety-check unbuildable (transient RPC / unverifiable mint owner); **same family as `fee_payer_mismatch`** — retryable, fails closed, never re-routes the burner order to main. Accurate to the code: distinct error, `retryable: true`, terminal `return` BEFORE `routeAndSign` (no reserve/sign/broadcast), main route unaffected.
- ✅ **Route-aware remediation (CodeRabbit #419):** the door instructs the agent to relay the tool's `reason` verbatim and explicitly NOT to suggest the main wallet for a held-token **conversion** (input lives only in the burner → retry only); ordinary burner swaps still offer the main wallet. Matches the code's `_burnerSignFallbackHint` ternary (`isConversion ? retry-only : retry-or-main`) used by both `fee_payer_mismatch` and `expected_delta_unbuildable`.
- ✅ Does not contradict the BAT-1061/1062 slippage/quote-flakiness door (ai.js ~752): that door is for SIGNED-but-failed-on-chain (auto-re-quote loop); `expected_delta_unbuildable` is a pre-sign fail-closed (no auto-loop), correctly grouped with `fee_payer_mismatch` instead.

## Section B — Diagnostics (3/3)
- ✅ New row in the **Tool-handler errors** table (DIAGNOSTICS.md ~945): `expected_delta_unbuildable` → `solana_swap` → "burner safety check couldn't be built (transient RPC / unrecognized mint owner)" → retryable, NOT a security reject, same risk class as `fee_payer_mismatch`; fails closed before reserve/sign/broadcast; main-routed swaps unaffected. Distinguishes from the burner-policy security code family explicitly (sits in the tool-handler-layer table, not REJECT_CODES).

## Section C — Tool Consistency (`solana_swap`) (3/3)
- ✅ Tool description (solana.js ~226) enumerates the **retry** behaviors (slippage BAT-1061, conversion_quote_unverifiable BAT-1062) and the conversion/routing model. The rare pre-sign **fail-closed** edges (`fee_payer_mismatch`, now `expected_delta_unbuildable`) are documented in the door + DIAGNOSTICS, NOT the description — consistent with the existing `fee_payer_mismatch` precedent (also absent from the description). No material disagreement across the three sources.

## Section D — Behavioral Probe (3/3)
- ✅ "My burner swap says it couldn't build the safety check / `expected_delta_unbuildable`" → door (ai.js ~797) + DIAGNOSTICS row reach correct guidance: retryable, ask the user to retry or run it from their main wallet app; do NOT treat it as a security reject, and do NOT (the agent can't) re-route the burner-taker order to the main wallet — the tool already fails closed for exactly that reason.

## Why pre-fix was already 100%
The fix landed code + door + DIAGNOSTICS together in the same change (no drift window), modeled 1:1 on the established `fee_payer_mismatch` guard (BAT-1038 Amendment 1), which the v-series audits already validated. No gaps found on audit.

## Regression coverage
`tests/nodejs-project/tools-solana-routing.test.js`: the prior BAT-1038 test that asserted the **unsafe** "unknown mint → force main, MWA signs" behavior was replaced with a pair — (1) burner route → `expected_delta_unbuildable`, no reserve/sign/broadcast, no MWA fallback; (2) main route → proceeds via MWA (order built for main taker). A third test pins the **route-aware remediation** (CodeRabbit #419): a PYUSD→USDC **conversion** that hits `expected_delta_unbuildable` returns a `reason` that says retry + "held in the burner" and does NOT suggest running it from the main wallet, while the non-conversion case does. 80 routing scenarios pass.

## Context note (deferred)
The systemic "stale device memory steers users to the main wallet for a now-working feature" awareness problem remains **deferred per owner** (carried from v35/v36). BAT-1066 makes the live tool + prompt correct; it does not reconcile existing device-side memory.
