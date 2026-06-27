# SAB-AUDIT-v34 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-06-26
> **SAB Version:** v3
> **Scope:** Pre-merge gate for PR #412 (BAT-1056 — `jupiter_wallet_holdings` real-shape parse). Touched `buildSystemBlocks()` (Holdings door) and shipped a new tool error code `unexpected_jupiter_holdings_shape`.
> **Method:** 4 sections scored in parallel (Explore agents), focused on the holdings change; synthesis + gap fixes applied in the same PR.
> **Baseline:** SAB-AUDIT-v33.md

## Scores

| Section | Pre-fix | Post-fix | Max |
|---------|---------|----------|-----|
| A: Knowledge & Doors (holdings-scoped) | 12 | 15 | 15 |
| B: Diagnostics (holdings-scoped) | 1 | 9 | 9 |
| C: Tool Consistency (holdings + 4 rotated) | 14 | 15 | 15 |
| D: Behavioral Probes (3 holdings + 2 rotated) | 7 | 15 | 15 |
| **Combined** | **34 (63.0%)** | **54 (100%)** | **54** |

> **Note on the 63% pre-fix:** this was a *scoped* audit (holdings-only items, not the full ~30-item knowledge map / full diagnostics list), so the percentage is not comparable to a full-surface audit. The signal that matters: **one convergent gap** surfaced independently in all four sections — the new `unexpected_jupiter_holdings_shape` error code shipped with zero self-awareness coverage. Core doors (best-effort USD, N/A, never-$0.00, tokenStandard tagging, solana_balance positioning) and tool-consistency all passed pre-fix.

## Pre-fix Trend
| Audit | Pre-fix % | Post-fix % | Note |
|-------|-----------|------------|------|
| v33 | — | 100% | (prior) |
| v34 | 63.0% (scoped) | 100% | scoped to PR #412; not full-surface |

## Section A — Knowledge & Doors (12/15 → 15/15)
- ✅ Holdings door states best-effort USD / "N/A" / never-$0.00 (ai.js:759).
- ✅ tokenStandard tagging present (was `classic / Token-2022`; **fixed** to add `native_sol`).
- ✅ Holdings vs `solana_balance` positioning (door + tool description both name `solana_balance` as authoritative).
- ✅ Tool description (tools/solana.js:378) consistent with the door.
- ❌→✅ **`unexpected_jupiter_holdings_shape` had no door.** Fixed: door now tells the agent it's an API-drift guard, NOT an empty wallet, and to fall back to `solana_balance`.

## Section B — Diagnostic Coverage (1/9 → 9/9)
- ❌→✅ No DIAGNOSTICS entry for `unexpected_jupiter_holdings_shape`. Fixed: new "## Jupiter Holdings & Balance Reads (BAT-1056)" section with symptoms → diagnosis (fail-loud drift guard) → check command → fix steps.
- ❌→✅ No "N/A valuations are intentional" explanation. Fixed: dedicated subsection (N/A = price unavailable, not worth-zero; `valuationPartial`/`pricedCount`/`unpricedCount`; total never $0.00 from missing prices).
- ⚠️→✅ Holdings-vs-`solana_balance` triage now documented (incl. the BAT-1000 Helius-timeout-looks-empty caveat cross-ref).

## Section C — Tool Consistency (14/15 → 15/15)
- ✅ `jupiter_wallet_holdings` — description ↔ door ↔ return shape all agree; no longer promises guaranteed USD/metadata.
- ✅ `solana_balance` — Token-2022-aware (BAT-1055) + authoritative claim intact, no contradiction with holdings.
- ✅ Rotated: `jupiter_token_search`, `solana_price`, `solana_nft_holdings` — consistent.
- ⚠️→✅ The lone MED gap (no DIAGNOSTICS holdings section) is closed by the Section B fix.

## Section D — Behavioral Probes (7/15 → 15/15)
- ✅ Probe 1 "holdings show $0.00/empty but I have tokens" — reaches the fixed-bug + best-effort + solana_balance guidance.
- ❌→✅ Probe 2 "holdings returned `unexpected_jupiter_holdings_shape`" — now traces door → DIAGNOSTICS section explaining it's an API-drift guard, not empty wallet.
- ✅ Probe 3 "why are some values N/A" — best-effort/batched pricing; N/A ≠ zero.
- ✅ Probe 4 "my swap failed" (rotated) — jupiter/solana path intact.
- ✅ Probe 5 "bridge is down" (rotated) — android bridge path intact.

## Gaps Found (Pre-fix)
1. **HIGH (A/B/C/D convergent):** `unexpected_jupiter_holdings_shape` shipped with no door and no DIAGNOSTICS entry — agent would misread it as an empty wallet.
2. **MED (B):** No "N/A valuations are intentional" guidance.
3. **LOW (A):** Holdings door enum omitted `native_sol`.

## Fixes Applied (same PR — #412)
- `ai.js:759` — added `native_sol` to the enum + a pointer clause for the error code (drift guard → fall back to `solana_balance` → see DIAGNOSTICS).
- `DIAGNOSTICS.md` — new "## Jupiter Holdings & Balance Reads (BAT-1056)" section (error code, N/A semantics, holdings-vs-`solana_balance` triage).

## Code Issues Found
- None. (BAT-1056 implementation + CodeRabbit-fixed edges already covered by 12 hermetic tests + live verification.)

## Remaining Gaps
- None for the audited (holdings) surface. Post-fix 100%.

## Negative Knowledge / Provider Notes
- Not re-scored (out of this PR's scope; unchanged from v33). PR #412 introduces no provider/channel-specific assumptions.
