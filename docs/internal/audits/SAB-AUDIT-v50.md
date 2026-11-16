# SAB-AUDIT-v50 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-11-16
> **SAB Version:** v4
> **Mode:** Delta
> **Scope:** PR #466 (BAT-1157): the OpenAI ChatGPT sign-in pair moves from shared prefs into its own token store; confirm-before-refresh; the OpenAI transport (OPENAI_AUTH_TYPE) is now decided from the selected auth, the sign-in and the saved key (api-key fallback, reconnect-required boot); pre-send reauth messages; Reset Config can finish partially; MAIN-only prefs writer.
> **Diff range:** origin/main 978d108d..PR head (feature/BAT-1157-openai-oauth-token-store)
> **Method:** read `buildSystemBlocks()` OpenAI provider block and OAuth playbook, DIAGNOSTICS.md OpenAI sections, every ERROR/WARN site the PR adds (JS + Kotlin `LogCollector`), tool descriptions (none changed); traced three probes.
> **Baseline:** SAB-AUDIT-v48.md (Full, 2026-10-19). v49 is a delta on the unmerged BAT-1661 branch (#465), so this audit claims v50.
> **Gate status:** On time (before merge of #466).
> **Next full audit due:** before the next release that ships code (the v2.3.x/2.4 RC).

## Scores (audited surface only)

| Section | Pre-fix | Post-fix | Max |
|---------|---------|----------|-----|
| A: Knowledge & Doors (2 items touched) | 2 | 6 | 6 |
| B: Diagnostics (curated: OpenAI OAuth row) | 3 | 3 | 3 |
| B: Diagnostics (discovered: 17 new log sites) | 33 | 51 | 51 |
| C: Tool Consistency | N/A (no tool description changed) | — | — |
| D: Behavioral Probes (3, delta) | 2 | 9 | 9 |
| **Combined (audited surface)** | **40 / 69 (58%)** | **69 / 69 (100%)** | **69** |

## Pre-fix Trend
| Audit | Mode | Pre-fix % | Post-fix % | Drift or correction |
|-------|------|-----------|------------|---------------------|
| v48 | Full | (see v48) | 100% | — |
| v50 | Delta (#466) | 58% (surface) | 100% | Drift: the new transport and storage states shipped in the PR's first commits without prompt doors; fixed in the same PR before merge |

## Section A
| Item | Pre | Post | Note |
|------|-----|------|------|
| OpenAI provider identity (auth mode) | ⚠️ 1 | ✅ 3 | With ChatGPT sign-in selected but no usable sign-in, the transport is now the saved key; the block said "the user configured an OpenAI platform API key" (misleading). Added an "API Key (fallback)" branch with the fix path and a door to DIAGNOSTICS. **Drift.** |
| OpenAI OAuth playbook → storage states | ⚠️ 1 | ✅ 3 | The generic `grep oauth|codex` item finds the new lines but nothing pointed at the new section. Added item 5 → "OpenAI Codex OAuth — Sign-In Storage". **Drift.** |

## Section B
- Curated row "OpenAI OAuth — token refresh / sign-in flow failure": the OpenAI Codex OAuth sections exist and now include "Sign-In Storage" ✅.
- Discovered (17 new sites): 8 covered pre-fix by the new Sign-In Storage section (record unreadable, migration fallback, sign-in unavailable, save rejected, not confirmed, persist retry, reconnect required, blocked settings write). 9 uncovered pre-fix (save-retry failure, summarizer skip, sign-in/sign-out not saved ×2, legacy-sweep commit ×2, reset incomplete, reset lock, Keystore key not deleted) — all added (Sign-In Storage log lines + a new "Reset Config — Reset not finished" section). **Drift.**

## Section D (delta probes)
| Probe | Pre | Post |
|-------|-----|------|
| "Why is my agent on my API key, not ChatGPT?" | ❌ 0 — prompt said the user configured a key | ✅ 3 — fallback branch → DIAGNOSTICS Sign-In Storage |
| "It said my ChatGPT sign-in changed / restart" | ⚠️ 1 — generic grep only | ✅ 3 — playbook item 5 → section with the message table |
| "Reset Config says Reset not finished" | ⚠️ 1 — only a line under Known limits | ✅ 3 — dedicated section, log lines, Retry |

Note: in the reconnect-required and latched states the agent sends no request at all (preflightAuth), so the user sees the fixed message directly; the probes cover the follow-up questions once the agent can answer again.

## Gaps Found (Pre-fix)
1. OpenAI api-key fallback mislabelled as a user-configured key — drift.
2. No door from the OAuth playbook to the storage states — drift.
3. 9 new ERROR/WARN log sites without DIAGNOSTICS coverage — drift.
4. "Reset not finished" not findable — drift.

## Fixes Applied (same PR)
- `ai.js` `buildSystemBlocks()`: OpenAI "API Key (fallback)" auth-mode branch; OAuth playbook item 5.
- `DIAGNOSTICS.md`: 5 more log-line entries under "OpenAI Codex OAuth — Sign-In Storage"; new "Reset Config — Reset not finished" section.

## Code Issues Found
None.

## Remaining Gaps
None on the audited surface. Provider-aware note: the reconnect/latch messages are OpenAI-specific; xAI keeps its own reauth flow (unchanged).

## Addendum: Codex diff review ed09115a (same PR)
Scope: delta on top of this audit, covering only what the review fixes changed.
- **New log sites (2, Kotlin WARN):** `[Config] OpenAI sign-in record missing after migration — legacy copy kept, sign in again` and the xAI twin. Pre-fix ⚠️ 1 each (no entry). Post-fix ✅ 3: entry under "OpenAI Codex OAuth — Sign-In Storage" with the cause and the fix (sign in again); the section's grep now also matches `xAI sign-in`.
- **Changed behaviour:** a delayed 401 while a refreshed pair's save is pending now retries on the new pair (previously ended the turn with the "saving" message). Post-fix ✅ 3: the "saving" symptom line says when it appears and when the agent retries instead.
- **Changed wording:** the legacy-sweep WARN now retries within the process too; the entry says so.
- No `buildSystemBlocks()` change; no tool description change. Remaining gaps: none on this surface.
