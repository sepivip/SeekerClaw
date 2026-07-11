# SAB-AUDIT-v43 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-07-09
> **SAB Version:** v3
> **Scope:** Delta-audit for BAT-1124 (PR #434) — xAI Grok OAuth ("Sign in with Grok") provider + `grok-4.5` as the new default model. Touches `buildSystemBlocks()` in `ai.js` (xai `## Provider` block + OAuth failure playbook) and `DIAGNOSTICS.md` (3 xAI sections), and adds new ERROR/WARN log sites in `providers/xai.js` and `ai.js` — so the pre-merge gate applies.
> **Method:** Full read of the xAI surface in `buildSystemBlocks()` + diagnostic coverage map for every new error site + behavioral probes on the auth/refresh paths.
> **Baseline:** SAB-AUDIT-v42.md (BAT-1130 delta; full-suite baseline v41 = 252/252 = 100% post-fix).

## Scores

| Section | Pre-fix | Post-fix | Max |
|---------|---------|----------|-----|
| A: Knowledge & Doors (delta items) | 15 | 15 | 15 |
| B: Diagnostics (delta failure modes) | 13 | 15 | 15 |
| C: Tool Consistency (spot-check, unchanged — no new tools) | 6 | 6 | 6 |
| D: Behavioral Probes (auth + refresh) | 6 | 6 | 6 |
| **Combined (delta)** | **40 (95.2%)** | **42 (100%)** | **42** |

> Delta-audit: only the surface PR #434 touches is re-scored. No tool added/removed, no identity/architecture/config drift, negative-knowledge boundaries unchanged (6/6). The single pre-fix gap is a diagnostic hole, filled in the **same PR** per the same-PR rule.

## Pre-fix Trend
| Audit | Pre-fix % | Post-fix % |
|-------|-----------|------------|
| v40 | 100% | 100% |
| v41 | 98.4% | 100% |
| v42 (delta) | 83.3% (delta only) | 100% |
| v43 (delta) | 95.2% (delta only) | 100% |

## Section A — Knowledge & Doors (delta) — 15/15 pre, 15/15 post

| Item | State | Evidence |
|------|-------|----------|
| xAI `## Provider` self-description (both auth modes) | ✅ | `ai.js` ~1429–1434: `You are running on xAI Grok (model: ${activeModel}, auth: ${AUTH_TYPE})` + per-mode OAuth vs API-key copy |
| "Sign in with Grok" OAuth capability (subscription, no API key) | ✅ | Provider block + OAuth playbook (`ai.js` ~1198–1203, injected only in OAuth mode) |
| `grok-4.5` new default model | ✅ | Model referenced via **dynamic** `${activeModel}` — no hardcoded default in the prompt; registry/config default updated in lockstep. **No drift.** |
| DIAGNOSTICS door for xAI troubleshooting | ✅ | `ai.js` ~1125 "read DIAGNOSTICS.md in your workspace" → 3 xAI sections |
| Config surface (XAI_KEY / OAuth token / auth type) | ✅ | Provider block distinguishes api_key (console.x.ai) vs OAuth (SuperGrok/X) |

Verified my review-round changes introduce **no** drift: OAuth playbook item 1 ("403 retries ONCE") is OAuth-scoped so the api_key-403-terminal change doesn't touch it; item 2 ("401 auto-refresh") now *actually works* after the header-rebuild fix; the `[Retry] OAuth refresh failed` ERROR message matches the grep string in both the playbook and DIAGNOSTICS.

## Section B — Diagnostics (delta) — 13/15 pre, 15/15 post

| Failure mode | New log site | Pre | Post | DIAGNOSTICS |
|--------------|-------------|-----|------|-------------|
| OAuth sign-in flow fails (port 56121 / browser / 10-min timeout) | Kotlin (Logcat) | ✅ | ✅ | "xAI Grok OAuth — Sign-In Flow" |
| OAuth 403 tier-gate (persistent) | classifyError 403 | ✅ | ✅ | "xAI Grok — 403 API access / Tier-Gate" |
| **api_key 403 + 402 / 429-quota** | classifyError | **⚠️** | ✅ | **GAP → FILLED**: added api_key-403 (terminal, no grace) + mode-aware 402/429 billing note to the 403 section |
| OAuth refresh failed (`invalid_grant`) | `providers/xai.js:392` ERROR + `ai.js:1823` `[Retry] OAuth refresh failed` ERROR | ✅ | ✅ | "Token Refresh / Persist Failure" |
| OAuth token rotated but not persisted | `providers/xai.js:369` ERROR, `:364` WARN | ✅ | ✅ | "Token Refresh / Persist Failure" (`XAI_OAUTH_SAVE_FAILED`) |

Pre-fix gap (the only one): the DIAGNOSTICS 403 section documented only the **OAuth** 403; the **api_key** 403 (now terminal-on-first-hit) and the mode-aware 402/429 billing/quota paths (OAuth → SuperGrok subscription vs api_key → console.x.ai) had no xAI-specific entry — only the generic "AI API auth 401/403" curated item. **Filled in this PR.**

## Section C — Tool Consistency (spot-check) — 6/6 pre, 6/6 post

BAT-1124 adds **no tools**. Fixed-7 + rotated-5 consistency unchanged from v41/v42 baseline (no `tools/*.js` change in this PR). Spot-checked `shell_exec` sandbox wording and `agent_pay` ceilings — unchanged and consistent. N/A for the delta.

## Section D — Behavioral Probes (delta) — 6/6 pre, 6/6 post

1. **"My Grok API key isn't working" / "signed in but Grok fails"** → prompt OAuth playbook + DIAGNOSTICS "403 Tier-Gate" (now incl. api_key + billing) → **actionable** (distinguishes tier-gate vs auth-expiry, gives the add-API-key / model-switch fix). ✅
2. **"Grok stopped responding after a few hours"** → prompt playbook item 2/3 + DIAGNOSTICS "Token Refresh / Persist Failure" → **actionable** (single-use rotation, `invalid_grant` vs persist-fail, re-sign-in fix). ✅ Note: the header-rebuild fix means a *healthy* token now refreshes silently — this symptom now only appears on genuine refresh failure, matching the doc.

## Negative Knowledge — 6/6 (unchanged)
No change to the "what it cannot do" boundaries; BAT-1124 adds a provider, not a new capability class.

## Gaps Found (Pre-fix)
- **B/api_key-403 + 402/429:** no xAI-specific diagnostic for api_key-mode 403 or billing/quota. (⚠️)

## Fixes Applied (same PR)
- `DIAGNOSTICS.md` → "xAI Grok — 403 Tier-Gate" section: added an **api_key mode 403** bullet (terminal on first hit; retry-once grace is OAuth-only; check plan / pick grok-4.3; grok-4.5 may be tier-gated) and a **mode-aware 402/429 billing** bullet (OAuth → SuperGrok/X subscription; api_key → console.x.ai; plain 429 = transient).

## Code Issues Found
None. (The OAuth-refresh header-rebuild and api_key-403-terminal behaviours were fixed during the PR's own Copilot review rounds, not by this audit.)

## Remaining Gaps
None. Post-fix delta = 42/42 (100%). Full-suite baseline unchanged from v41 (no tool/identity/architecture drift).
