# SAB-AUDIT-v40 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-06-29
> **SAB Version:** v3
> **Scope:** **Holistic release audit for v2.1.0** (flagship release; 129 commits since v2.0.0). A fresh full-surface pass over the CUMULATIVE `buildSystemBlocks()` + DIAGNOSTICS state covering: the autonomous burner-wallet / Token-2022 signing system (BAT-1013 foundation + 1024/1025/1027/1035–1039/1055/1056/1057/1060/1061/1062/1066/1067), the cap-asset confirmation model (BAT-1067), and Telegram Rich Messages (BAT-1050). Each feature already had a focused per-PR audit (v34–v39); this holistic sweep checks for **cross-feature drift** the focused audits would miss.
> **Method:** Four parallel section auditors reading the real code (no AI invoked for probes — door→target tracing). Combined pre/post scores below. Gaps fixed in the same pass.
> **Baseline:** SAB-AUDIT-v39.md

## Scores

| Section | Pre-fix | Post-fix | Max |
|---------|---------|----------|-----|
| A: Knowledge & Doors (30 items) | 86 | 90 | 90 |
| B: Diagnostics (24 curated + 11 release = 35 modes) | 103 | 105 | 105 |
| C: Tool Consistency (7 fixed + 5 rotated) | 36 | 36 | 36 |
| D: Behavioral Probes (2 fixed + 3 rotated) | 15 | 15 | 15 |
| **Combined** | **240 (97.6%)** | **246 (100%)** | **246** |

Pre-fix **97.6% is above the 95% drift threshold** → no drift incident; self-awareness was well-maintained across 129 commits. Sections C and D (tool consistency + behavioral) were already perfect, including the key cross-feature coherence probe.

## Pre-fix Trend
| Audit | Pre-fix % | Post-fix % |
|-------|-----------|------------|
| v37 (BAT-1066) | 100 | 100 |
| v38 (BAT-1067) | ~ | 100 |
| v39 (BAT-1050) | ~ | 100 |
| **v40 (holistic v2.1.0)** | **97.6** | **100** |

## Section A — Knowledge & Doors: 86→90
- 28/30 ✅; negative-knowledge **6/6**; constants verified (`MAX_HISTORY=35`, `maxStepsPerTurn` default 35 range 10–100 — note: there is **no** `MAX_TOOL_USES` constant; the prompt is correct at 35; `SHELL_ALLOWLIST` matches the prompt's two listings exactly).
- **Cross-feature wallet coherence: PASS** — burner signing + caps + silent-under-cap (Wallets §, ai.js ~707), held-token conversions (ai.js:754), and the confirmation asymmetry (Confirmation Gates §, ai.js ~946) are described consistently with no contradiction.
- 2 ⚠️ → fixed:
  - **A-D5** (search-provider live-error self-diagnosis): no playbook for a configured provider failing live (401/429/timeout). **Fixed:** added bullet to the "If a tool fails" playbook.
  - **A-D7** (rich-message delivery fallback): the prompt said rich "degrades on older clients" but had no door for the server-side rich→classic fallback / no-double-delivery. **Fixed:** added a self-diagnosis line in the Rich-ON formatting block pointing at the DIAGNOSTICS rich-fallback sections.

## Section B — Diagnostics: 103→105
- Curated critical list **24/24 perfect**. Release-specific paths 10/11 (burner-policy 3-class taxonomy, `fee_payer_mismatch`, `expected_delta_unbuildable`, `conversion_quote_unverifiable`, slippage/0x1771, the cap-asset rule, Token-2022 limits, rich-fallback — all ✅).
- 1 medium → fixed:
  - **B-R8** (`confirmation_buttons_not_allowed`): the BAT-1067 error code was returned in code + behavior was taught in the prompt, but **not catalogued in DIAGNOSTICS by name**. **Fixed:** added an `### Error: confirmation_buttons_not_allowed (BAT-1067)` subsection (symptoms/cause/fix).

## Section C — Tool Consistency: 36/36 (zero gaps)
- All 12 tools (shell_exec, js_eval, solana_swap, agent_pay, wallet_set_caps, android_sms, android_call + rotated: solana_send, solana_send_token, telegram_send, jupiter_trigger_create, jupiter_dca_create) have 3-source agreement. BAT-1067 invariants confirmed: fund-tool descriptions tell the agent NOT to self-confirm; `telegram_send` buttons are navigation-only + the guard is consistent with the prompt; the prompt's gated-tool list exactly matches `confirmation/policy.js`.

## Section D — Behavioral Probes: 15/15 (all pass)
- Fixed probes (web-search-broken, agent-won't-respond): ✅. Rotated: **"what can you do with my wallet now?"** (the key release coherence probe) ✅ — coherent across Wallets / swap-conversion / Confirmation-Gates / the BAT-1067 DIAGNOSTICS table; rich/plain rendering ✅; conversion-retry (BAT-1062) ✅.
- 2 low discoverability nits (named pointers) folded into the A/B fixes above (the BAT-1067 table + rich-fallback sections now have named prompt pointers).

## Gaps Found (pre-fix) & Fixes Applied (same pass)
1. **A-D5** search live-error playbook → ai.js "If a tool fails" bullet. ✅
2. **A-D7 / D-G4** rich-message fallback self-diagnosis door + named DIAGNOSTICS pointer → ai.js Rich-ON block. ✅
3. **D-G3** named pointer to the BAT-1067 confirmation table → ai.js Confirmation Gates §. ✅
4. **B-R8** `confirmation_buttons_not_allowed` DIAGNOSTICS entry → new subsection. ✅

Post-fix: **246/246 = 100%.**

## Remaining Gaps (low, deferred — not release blockers)
These are auto-discovered, prompt-covered-but-no-DIAGNOSTICS-deep-dive items; they did NOT reduce the score and are filed for a future doc pass:
- `solana_send_token` reject family (`unsupported_cap_asset`, `source_ata_missing_or_insufficient`, `usdc_decimals_mismatch`, `unsupported_mint`, `mint_not_found`, `solana_send_sol_only`) — covered in the prompt (ai.js ~806), no dedicated DIAGNOSTICS table.
- Jupiter Trigger V2 ambiguous-create recovery ("entering recovery") — no DIAGNOSTICS entry; verify via `jupiter_trigger_list` before re-creating.
- Token-2022 partial balance read (`balanceIncomplete`) and classic-pipeline (Rich OFF) HTML-send rejection — prompt-covered, no DIAGNOSTICS door.

## Code Issues Found
None. (No behavioral / safety / consistency drift. All fixes were doc/door-only — no change to `confirmation/policy.js`, `caps/preflight.js`, tool logic, or signing.)
