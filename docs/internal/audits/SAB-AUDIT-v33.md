# SAB-AUDIT-v33 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-06-10
> **SAB Version:** v3
> **Scope:** Pre-merge audit for PR #403 (BAT-1032) — custom model survives config reconcile + Claude model bump (Fable 5 + Opus 4.8 added, Opus 4.8 new Anthropic default, Opus 4.6 retained). DIAGNOSTICS.md reasoning hint touched → mandatory gate.
> **Method:** Full read of buildSystemBlocks() + diagnostic coverage map + tool consistency spot-check + behavioral probes (4 parallel audit agents).
> **Baseline:** SAB-AUDIT-v27.md (main). Note: v28–v32 exist on the v2.1 train branches (release/integration) — this audit is numbered v33 to avoid collision at merge-down.

## Scores

| Section | Pre-fix | Post-fix | Max | Pre-fix % | Post-fix % |
|---------|---------|----------|-----|-----------|------------|
| A: Knowledge & Doors (28 items) | 79 | 84 | 84 | 94.0% | 100% |
| B: Diagnostics (curated 24) | 72 | 72 | 72 | 100% | 100% |
| B: Diagnostics (discovered/PR-scope 6) | 4 | 18 | 18 | 22.2% | 100% |
| C: Tool Consistency (fixed 7) | 21 | 21 | 21 | 100% | 100% |
| C: Tool Consistency (rotated 5) | 15 | 15 | 15 | 100% | 100% |
| D: Behavioral Probes (fixed 2) | 6 | 6 | 6 | 100% | 100% |
| D: Behavioral Probes (rotated 3) | 7 | 9 | 9 | 77.8% | 100% |
| **Combined** | **204** | **225** | **225** | **90.7%** | **100%** |

## Pre-fix Trend

| Audit | Pre-fix % | Post-fix % |
|-------|-----------|------------|
| v26 | 47.2% | 100% |
| v27 | 65.1% | 100% |
| v33 (this) | 90.7% | 100% |

⚠ **90.7% is below the 95% drift threshold** — but unlike v19/v23/v27, this audit ran PRE-merge and the gaps were fixed in the same PR, which is exactly the process working as designed. The dominant gap was BAT-1032's own feature shipping (initially) without self-knowledge coverage.

## Gaps Found (Pre-fix)

### Section A (2 gaps)
1. **Custom model IDs — zero coverage (❌ 0/3).** The PR's headline feature (Settings picker Custom entry, survives reconcile/restart) had no door. `/model` rejects off-list IDs (message-handler.js → model-catalog.js `validateModelForProvider`) while Settings accepts them — a user asking about the asymmetry would be told their working model is "invalid".
2. **Tool rounds stale (⚠ 1/3).** ai.js Conversation Limits said "Up to 25 tool-call rounds" while the code default is 35 (clamped 10–100, Settings-configurable) and the playbook line correctly said 35 — internal contradiction.

### Section B (6 discovered/PR-scope items, 4 gapped)
3. `/think` "not in known model list" hint didn't mention custom IDs on Anthropic/OpenAI (only Custom provider).
4. **No room for the /model-vs-Settings asymmetry** (❌).
5. **No coverage for API 404 model-not-found** from a bad custom ID (❌) — newly user-reachable via this PR.
6. Media download failures (`Media download failed` ERROR) — no DIAGNOSTICS entry.
7. Task checkpoint / `/resume` failures (`[TaskStore]`/`[Resume] FAIL` ERRORs) — no DIAGNOSTICS entry.
8. `[/think] runtime_state.json write threw` ERROR missing from the BAT-504 failure-line list.

### Section C — clean (12/12)
Rotated 5 this audit: `web_fetch`, `android_camera_capture`, `session_status`, `memory_search`, `telegram_react` (none overlap v27's rotation or the fixed 7). All three sources agree for all 12.

### Section D (1 gap)
9. **Probe 3 (custom-model asymmetry): ⚠ 1/3** — agent could see the custom ID as active (Runtime line) but had no door explaining the `/model` rejection. Probes 1 (web search), 2 (won't respond), 4 (Fable 5 thinking — registry `reasoningSupport=yes`, traces cleanly), 5 (API key) all pass.

## Fixes Applied (same PR — #403)

| # | File | Fix |
|---|------|-----|
| 1 | ai.js (Config Awareness) | New door: Custom model IDs — Settings freeform vs `/model` registry-only, persistence, DIAGNOSTICS pointer |
| 2 | ai.js (Conversation Limits) | 25 → 35 default, "configurable 10–100 in Settings → Agent" |
| 3 | DIAGNOSTICS.md:397 | `/think` hint covers custom IDs on Anthropic/OpenAI |
| 4 | DIAGNOSTICS.md:419 | reasoningSupport=unknown bullet covers custom/unregistered IDs on Anthropic/OpenAI |
| 5 | ai.js (API-fail playbook) | New step 4: 404 model-not-found → likely custom-ID typo, recovery via /model or Settings (renumbered 402→5, network→6) |
| 6 | DIAGNOSTICS.md | New room: "/model Rejects a Model ID That Settings Accepted (BAT-1032)" |
| 7 | DIAGNOSTICS.md | New room: "Custom Model ID Returns API 404" |
| 8 | DIAGNOSTICS.md | New rooms: "Sent Media Never Reached the Agent", "/resume Fails or Finds No Task"; `[/think]` write-failure bullet in BAT-504 list |

## Code Issues Found

None requiring separate tickets — BAT-1033 (Extended Thinking `budget_tokens` on Opus 4.7+/Fable 5) was already filed before this audit.

## Remaining Gaps

None. Post-fix 225/225 = 100%.
