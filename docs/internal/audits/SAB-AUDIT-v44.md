# SAB-AUDIT-v44 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-07-16
> **SAB Version:** v3
> **Scope:** Delta-audit for BAT-1172 (xAI error-shape mis-parse fix). Touches `buildSystemBlocks()` in `ai.js` (xAI OAuth failure playbook item 1 + xAI OAuth Provider block), adds a new WARN log site in `providers/xai.js` (`[xAI] 403 forbidden: code=<...> reason=<...>`), and rewrites the `DIAGNOSTICS.md` xAI-403 section — so the pre-merge gate applies. Also fixes Node classifyError + two `ai.js` loggers + the vision path + the Kotlin Settings connection test, but those are code-only (no self-knowledge surface).
> **Method:** Full read of the xAI-403 surface in `buildSystemBlocks()` + diagnostic coverage map for the rewritten 403 section and the new WARN site + behavioral probe on the "signed-in-but-Grok-fails" path.
> **Baseline:** SAB-AUDIT-v43.md (BAT-1124 delta; full-suite baseline v41 = 252/252 = 100% post-fix).

## Scores

| Section | Pre-fix | Post-fix | Max |
|---------|---------|----------|-----|
| A: Knowledge & Doors (2 changed xAI-403 items) | 2 | 6 | 6 |
| B: Diagnostics (xAI-403 section + new WARN line) | 1 | 3 | 3 |
| C: Tool Consistency (no tools changed) | N/A | N/A | — |
| D: Behavioral Probes ("signed in but Grok fails") | 1 | 3 | 3 |
| **Combined (delta)** | **4 (33.3%)** | **12 (100%)** | **12** |

> **The low delta pre-fix is the whole point of BAT-1172, not new drift.** The xAI-403 self-knowledge (prompt + diagnostics) was a *fabrication* — "your Grok subscription tier doesn't include API access — add an xAI API key" — presented as fact. v43 scored these items ✅ because the prompt *matched the code*; but the code itself was fabricating, which was only proven afterward by the BAT-1155 incident + the live probe (`xai_403_probe.js`) + context7 `/websites/x_ai_developers` (403 = permissions/entitlement, NOT tier/API-key). With that ground truth, the pre-fix state is correctly re-scored ⚠️. This PR corrects prompt + code + diagnostics + Kotlin in lockstep → post-fix 100%, no leftover gaps, no new drift. Negative-knowledge boundaries unchanged (6/6); no identity/architecture/config drift.

## Pre-fix Trend

| Audit | Pre-fix % | Post-fix % |
|-------|-----------|------------|
| v40 | 100% | 100% |
| v41 | 98.4% | 100% |
| v42 (delta) | 83.3% (delta only) | 100% |
| v43 (delta) | 95.2% (delta only) | 100% |
| v44 (delta) | 33.3% (delta only — corrects a pre-existing fabrication) | 100% |

## Section A — Knowledge & Doors (delta) — 2/6 pre, 6/6 post

| Item | Pre | Post | Evidence |
|------|-----|------|----------|
| xAI OAuth playbook item 1 (403) | ⚠️ | ✅ | Pre (`ai.js` ~1199, old): "a persistent 403 means your Grok subscription tier does NOT include API access… the fix is to add an xAI API key" — **fabricated**; would make the agent give wrong advice (add-a-key) for what is often an auth/reconnect issue. Post (`ai.js:1211`): "a 403 is NOT automatically a subscription-tier gate… surfaces xAI's REAL error code + message… read THAT actual reason… auth-ish → reconnect; genuine limit → plan/key. Do NOT tell an OAuth user their 'subscription tier doesn't include API access' unless xAI's message actually says so." |
| xAI OAuth Provider block (403 sentence) | ⚠️ | ✅ | Pre (`ai.js` ~1432, old): "If the tier does not include API access you will get a 403 tier-gate — the fix is to add an xAI API key, NOT to re-sign-in." Post (`ai.js:1444`): "A 403 means Grok denied the request — the system retries once… then surfaces xAI's real reason; treat it per that message (a genuine access limit vs. an auth problem), NOT as an automatic 'add an API key' tier-gate." |

Unchanged xAI items (Provider self-description, "Sign in with Grok" capability, `grok-4.5` via dynamic `${activeModel}`, DIAGNOSTICS door, config surface) remain ✅ — not re-scored. Internal BAT-1143 breaker comments referencing "tier-gate" (`ai.js` ~1736/1844/1968/2481) are correct and out of scope: the breaker's narrow "fresh-token-still-403s" case genuinely IS an entitlement situation (not an expiry) and produces no user-facing copy — the user message comes from `classifyError`, now fixed.

## Section B — Diagnostics (delta) — 1/3 pre, 3/3 post

| Failure mode | Log site | Pre | Post | DIAGNOSTICS |
|--------------|----------|-----|------|-------------|
| xAI OAuth 403 (terminal) | `providers/xai.js:448` **new** `[xAI] 403 forbidden: code=<...> reason=<...>` (WARN) | ⚠️ | ✅ | Pre: "xAI Grok — 403 API access / Tier-Gate (add API key, do NOT re-login)" diagnosed the fabricated tier-gate and told operators to grep for the now-deleted "subscription tier doesn't include API access" string. Post (`DIAGNOSTICS.md:219`): "xAI Grok — 403 (read the REAL reason — not automatically a tier-gate)"; grep target = the new `[xAI] 403 forbidden: code=` WARN line (verified present in both code and doc); fix steps split auth-ish (reconnect) vs genuine access/entitlement (real reason → model/plan/key). |

Doc↔log coupling is now pinned by a source assertion in `xai.test.js` (both the emitter and the DIAGNOSTICS grep target contain the literal `[xAI] 403 forbidden: code=`). The two `ai.js` diagnostic loggers + the vision path now read the flat `{code, error:string}` shape — also source-pinned — so xAI failures stop logging `type=unknown code=- msgLen=0` (the blindness that hid the original 403 body). Curated "AI API — Auth error (401/403)" item remains covered.

## Section C — Tool Consistency (spot-check) — N/A

BAT-1172 adds/changes **no tools** (`tools/*.js` untouched). Fixed-7 + rotated-5 consistency unchanged from the v41 full-suite / v43 baseline. Not re-scored.

## Section D — Behavioral Probes (delta) — 1/3 pre, 3/3 post

1. **"I'm signed in with Grok but it fails" / "my API key isn't working" (403)** → prompt OAuth playbook item 1 + DIAGNOSTICS "xAI Grok — 403". **Pre: ⚠️** — the path led to the fabricated "add an xAI API key" fix (v43's probe 1 literally described the expected answer as "gives the add-API-key / model-switch fix" — that was the wrong ground truth). **Post: ✅** — the agent now finds "read xAI's real reason; auth-ish → reconnect via Settings; genuine access/entitlement → the real message, then model/plan/key," and is explicitly told not to assert a tier-gate unless xAI says so. Actionable and truthful.

Fixed probes ("Web search is broken", "Agent won't respond") unaffected by this PR — unchanged from baseline.

## Gaps Found (Pre-fix)
- The entire xAI-403 self-knowledge surface (prompt playbook item 1, Provider block, DIAGNOSTICS section, behavioral-probe answer) taught a **fabricated tier-gate** as fact. Root cause: the copy was invented from the HTTP status alone because every parse site read the nested `error.message` (undefined for xAI's flat `{code, error}` body).

## Fixes Applied (all in THIS PR — same-PR rule)
- `buildSystemBlocks()` playbook item 1 + Provider block rewritten (truthful; read the real reason; never assert a tier-gate unless xAI says so; keep room for genuine plan gates).
- `DIAGNOSTICS.md` xAI-403 section rewritten; grep target = the new WARN line.
- Node `classifyError` + both `ai.js` loggers + vision path read the flat shape; new `[xAI] 403 forbidden` WARN capture line.
- Kotlin `ProviderConfigScreen.kt` `xaiChatPing` (the Settings connection test — the most user-visible instance) parses the flat shape + truthful copy.
- Regression pins added (source-level logger pins + doc↔log coupling + no-fabrication + narrowed-regex negative pin).

## Code Issues Found
None beyond the fabrication this PR fixes. No separate Linear task needed.

## Remaining Gaps
None. Post-fix 100%. The 403/429 wire shapes remain INFERRED from the captured 400/401 (the fix degrades safely to truthful generic copy on any unrecognized shape); capturing a real 403 + quota-429 is a device-test acceptance step, not a self-knowledge gap.

## Validation
- `node tests/nodejs-project/smoke.js` — PASS
- `node tests/nodejs-project/xai.test.js` — 189 PASS / 0 FAIL
- `bash scripts/pre-push-check.sh` — Node smoke + 64 tool schemas + wallet regression + Kotlin compile (dappStoreDebug) BUILD SUCCESSFUL
