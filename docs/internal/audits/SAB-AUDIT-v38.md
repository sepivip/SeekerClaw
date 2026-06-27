# SAB-AUDIT-v38 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-06-27
> **SAB Version:** v3
> **Scope:** Pre-merge gate for BAT-1067 (confirmation-UX cleanup, Option A, Codex-approved). Device test of the v2.1 cluster surfaced a confusing **double-confirm** on the burner wallet path: the agent asked for confirmation in chat (and added its own ✅/❌ buttons) AND the system gate then asked "Reply YES". Root cause = a system-prompt contradiction (ai.js:751/753 "confirm with the user first" vs ai.js:933 "you do NOT need to ask"). Fix is **prompt + docs + tool-description** only — no gate/cap/signing code. Also documents the (intended) cap-confirmation asymmetry, and adds a deterministic backstop that rejects fund-confirm inline buttons.
> **Method:** Focused audit on the confirmation surface (doors ↔ tool descriptions ↔ DIAGNOSTICS ↔ probe). Gap fixes in the same change.
> **Baseline:** SAB-AUDIT-v37.md

## Scores

| Section | Pre-fix | Post-fix | Max |
|---------|---------|----------|-----|
| A: Knowledge & Doors (confirmation-scoped) | 1 | 3 | 3 |
| B: Diagnostics | 0 | 3 | 3 |
| C: Tool Consistency (solana_send/_token/_swap, telegram_send) | 1 | 3 | 3 |
| D: Behavioral Probe ("double-confirm" + "buy silent / sell prompts") | 1 | 3 | 3 |
| **Combined** | **3 (25%)** | **12 (100%)** | **12** |

Pre-fix was LOW because the live prompt was self-contradictory on the single most safety-adjacent UX (fund confirmation) — exactly the drift SAB exists to catch. This is the intended signal, not a regression in maintenance: the contradiction predates this work (ai.js:751 + the stale ai.js:932 list).

## Section A — Knowledge & Doors (1→3)
- ❌→✅ **Contradiction removed.** ai.js:751 (swap workflow) and ai.js:753 (conversion door) no longer tell the agent to "confirm the quote with the user first / user confirmation before signing"; they now say *preview the quote, call the tool, the gate confirms*. Consistent with the canonical ai.js:931-936 section.
- ❌→✅ **Canonical section repaired + made outcome-based.** ai.js:932 stale list (omitted solana_send_token / agent_pay POST / jupiter cancels / wallet_set_caps) replaced with a policy-outcome description + a non-exhaustive example list, plus the explicit *no self yes/no, no own Confirm/Cancel/Retry buttons* rule, plus the "some gated tools execute silently by policy (under-cap USDC/SOL)" note.
- ❌→✅ **Inline-keyboard door (ai.js:818)** no longer demonstrates a ✅Confirm/❌Cancel pair; example is now navigation (Show more / Refresh) and the door states buttons are navigation-only / never authorization.

## Section B — Diagnostics (0→3)
- ❌→✅ New DIAGNOSTICS subsection "When does a burner action need confirmation? (BAT-1067)" with the cap-asset table (silent iff spending USDC/SOL under cap & burner-routed; confirm for non-cap spends incl. conversions, over-cap, main; agent_pay GET / wallet_status silent; agent_pay POST / wallet_set_caps confirm) + the maintainer root-cause note. Explicitly frames the asymmetry as intended, never a bug/Token-2022 limitation.

## Section C — Tool Consistency (1→3)
- ❌→✅ `tools/solana.js` `solana_send`, `solana_send_token`, `solana_swap` descriptions: removed "ALWAYS confirm with the user … before calling"; now "show recipient/amount/quote; do NOT run your own confirmation or Confirm/Cancel buttons — the gate asks for YES." `solana_swap` keeps "show the quote first."
- ❌→✅ `tools/telegram.js` `telegram_send` `buttons` description: navigation-only, taps never authorize gated actions; example is non-fund. New deterministic guard returns `confirmation_buttons_not_allowed` for confirm/approve/cancel-of-a-fund-action buttons (callback_data or label), consistent with the door + DIAGNOSTICS.

## Section D — Behavioral Probe (1→3)
- ❌→✅ "Why did the agent ask twice (tap Confirm AND type Yes)?" → doors + the new DIAGNOSTICS section + the deterministic guard now make the agent preview-then-call (one gate confirmation); a fund-confirm button is rejected at the tool.
- ❌→✅ "Why did selling PYUSD prompt but buying didn't?" → DIAGNOSTICS cap-asset table gives the correct answer (spending USDC under cap = silent; spending a non-cap held token = confirm), as intended design.

## Regression coverage
`tests/nodejs-project/confirmation-buttons-guard.test.js` (15 checks): static drift-guard (no "ALWAYS confirm" / "confirm in chat before calling" / "confirming the quote with the user"; no Confirm/Cancel example in the inline door; gates section carries the no-self-confirm + no-own-buttons rule) + the telegram_send guard (rejects the observed confirm_swap / confirm_usdc_send / cancel_order etc.; allows navigation buttons). Wired into build.yml + ci-coverage-manifest. Policy matrix remains pinned by confirmation-policy-burner.test.js (unchanged — gate logic untouched).

## Upgrade safety
Prompt + docs + tool descriptions + a tool-input guard only. `git diff` of `confirmation/policy.js`, `caps/preflight.js`, `wallet/index.js`, ai.js gate-dispatch (2954-3012) is EMPTY — the gate/cap/signing model is unchanged. No state/schema migration.

## Code issues found
None new. (Caught one bug in the guard's own regex during testing — `\b` doesn't span `_`, so `cancel_order` slipped; fixed with a separator-aware boundary before commit.)
