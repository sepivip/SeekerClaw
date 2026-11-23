# SAB-AUDIT-v53 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-11-18
> **SAB Version:** v4
> **Mode:** Delta
> **Scope:** BAT-1661 (PR #465), the uncommitted fix round on top of `444ba220` (CodeRabbit on 444ba220). Agent-visible changes: two `buildSystemBlocks()` lines in `ai.js` (the OpenAI retired-on-sign-in door and the Reasoning `unknown` line). DIAGNOSTICS.md changes: the OpenAI refresh-token entry (~277), `/think` (~653), the `/provider` re-issue advice (~835, ~867), the model-repair WARN lines (~837–842), and the "Couldn't save" entry. New Kotlin log lines: in `ConfigManager.syncXaiRuntimeAuthType`, `XaiOAuthActivity`, `ModelSelectionLock` and `RuntimeStateStore`. New user-visible text: the xAI sign-in/sign-out errors and the "Couldn't save changes…" toast on Settings, Search Provider and Telegram.
> **Diff range:** `444ba220`..working tree (`git diff HEAD`, plus the untracked `ModelPickerSave.kt`).
> **Method:**
> - Read the full `git diff HEAD` for every main-source file.
> - Grepped the diff for added `'ERROR'|'WARN'` and `LogLevel.(ERROR|WARN)` lines, and for `Toast` and user-facing string constants. Each hit was read in context.
> - Grepped the source for every DIAGNOSTICS quote in the touched entries (Node `providers/openai.js`; Kotlin `AndroidBridge.kt`, `ConfigManager.kt`, `XaiOAuth.kt`, `XaiOAuthActivity.kt` and the settings screens).
> - Checked the two prompt lines against `providers/openai.js:375–382`, `model-registry.json` and the `/provider` handler (`message-handler.js` + registry `authTypes` order).
> - Traced 4 probes from door to target. No AI was invoked.
> **Baseline:** SAB-AUDIT-v52.md (Delta, highest on any branch; no v53 exists elsewhere). Last full audit: SAB-AUDIT-v48.md (2026-10-19).
> **Gate status:** On time. This audit ran before the merge of PR #465, and the fixes are in the same branch (uncommitted). v52 recorded that the next audit (v53) must be full, because it is the fifth delta in a row. v53 is a delta anyway: it is a same-PR follow-up on unpushed fixes that v52 already covered. **The full audit is still owed. It now falls on v54, which must be full and must run before the release that ships PR #465 is tagged.**
> **Next full audit due:** v54, before the RC of the release that contains PR #465. Five deltas in a row (v49–v53) and the release rule both require it.

## Scores

Delta: every percentage below is against the **audited surface only**.

| Section | Pre-fix | Post-fix | Max |
|---------|---------|----------|-----|
| A: Knowledge & Doors (2 items touched) | 6 | 6 | 6 |
| B: Diagnostics — curated (5 rows touched) | 11 | 15 | 15 |
| B: Diagnostics — discovered (10 sites/messages) | 18 | 30 | 30 |
| C: Tool Consistency | N/A (no tool description changed) | — | — |
| D: Behavioral Probes (4) | 6 | 12 | 12 |
| **Combined (audited surface)** | **41 (65.1%)** | **63 (100%)** | **63** |

## Pre-fix Trend
| Audit | Mode | Pre-fix % | Post-fix % | Drift or correction |
|-------|------|-----------|------------|---------------------|
| v48 (v2.3.2) | Full (v4) | 68.8 | 87.4 | both |
| v49 (BAT-1661, first part) | Delta (v4) | 62.7 (surface) | 100 (surface) | 8 drift, 2 corrections |
| v52 (BAT-1661, handoff + v2.11) | Delta (v4) | 86.2 (surface) | 100 (surface) | 6 drift, 1 correction |
| **v53 (BAT-1661, CodeRabbit fix round)** | **Delta (v4)** | **65.1 (surface)** | **100 (surface)** | 6 drift, 2 corrections |

## Section A — Knowledge & Doors: 6 → 6

| Item | Pre | Post | Note |
|---|---|---|---|
| C6 AI providers — OpenAI retired-on-sign-in door (`ai.js` ~1510) | ✅ | ✅ | "…is used instead, and the app updates the saved choice once a startup repair succeeds (until then the saved choice can still name the old model)". This matches the repair flow in DIAGNOSTICS: the service start saves the new model for the agent, and the app converges on its next load. A repair that waits for a sign-in, or fails to write, leaves the saved choice on the old id. It is accurate and still built from the registry. |
| I2 Model / Reasoning `unknown` line (`ai.js` ~1554) | ✅ | ✅ | The line says reasoning is sent "always with a ChatGPT sign-in, and for a model ID containing `codex` on an API key too". That matches `wantReasoning = isOAuth \|\| model.includes('codex') \|\| userToggleEnabled`, and `userToggleEnabled` needs `reasoningSupport === 'yes'` (`openai.js:378–382`). The line also says "a listed model marked `no` (e.g. Claude Haiku 4.5)". That matches `model-registry.json`: `claude-haiku-4-5` has `"reasoningSupport": "no"`. "The adapter" rather than "the OpenAI adapter" is correct, because `custom.js` reuses `openai.js`. |

## Section B — Diagnostics

### Curated rows touched

| Row | Pre | Post | Note |
|---|---|---|---|
| OpenAI OAuth — token refresh / sign-in storage (DIAG ~277, ~304) | ⚠️ | ✅ | All quoted strings exist: `[OpenAI] Failed to persist refreshed tokens — retrying the save, no new refresh until it lands` (openai.js:895), `[OpenAI] Save retry failed: ` (725), `[OpenAI] Refreshed sign-in saved` (723), and `OPENAI_OAUTH_SAVE_FAILED` / `OPENAI_OAUTH_SAVE_UNCONFIRMED` (AndroidBridge.kt; `Log.w` only, so "Logcat only" is right). The old `[Config] Failed to persist rotated OpenAI OAuth tokens` is correctly gone from both. **Wrong:** "(`Save retry failed` (WARN) while it keeps failing)". `_sendSave` turns a 503 refusal into `'pending'`, and `_sendRaw` never rejects. So a save the app keeps refusing retries **silently**, and `Save retry failed` appears only if `_sendSave` throws. An agent that saw no WARN would conclude that the save landed and tell the user a restart is safe, which loses the sign-in. Line ~304 said the same ("one re-send … failed"). |
| xAI — sign-in flow / persist failure | ✅ | ✅ | |
| Model selection (BAT-1661) — "Couldn't save" entry | ⚠️ | ✅ | The toast and the xAI messages were quoted only as truncated prefixes. The most common save failure (storage full: `Failed to persist config (commit=false)`) was not quoted. The toggle condition was incomplete (see below). The xAI timing said "five seconds", but the code now makes 3 tries × 5 s. |
| Reasoning — `/think` entry (~653) | ✅ | ✅ | "With an API key and an unlisted non-codex model it is omitted" matches the code. Post-fix, it also cross-links to the flip-back case (probe 1). |
| Service — `/provider` interrupted (~835, ~867) | ✅ | ✅ | `/provider openai` with no auth argument picks the first credentialed type in `authTypes` order, and the registry lists `["api_key", "oauth"]`. So "picks API Key first when both OpenAI credentials are saved" is correct. `/provider openai oauth` is valid syntax (handler `parts[1]`). |

### Discovered sites and user-visible messages (10)

"Exact" means the DIAGNOSTICS quote is a verbatim copy of the code string (`…` only for an interpolation).

| # | Site / message | Pre | Post |
|---|---|---|---|
| 1 | `[Config] xAI OAuth runtime_state sync failed: ${e.message}` (WARN; moved) | ✅ | ✅ |
| 2 | `[Config] xAI OAuth runtime_state sync failed: runtime_state.json not written` (WARN, new) | ✅ | ✅ |
| 3 | `[Config] xAI OAuth runtime_state sync skipped: lock busy (…)` (WARN; now after 3 tries) | ✅ | ✅ |
| 4 | `[Config] xAI sign-in saved, agent not restarted — sign in with Grok again to finish` (WARN, new) | ✅ | ✅ |
| 5 | `[Config] Failed to persist config (commit=false)` (ERROR). The text is unchanged, but `commitOrRestore` changes what follows it (old values restored), and the new toasts now report it on three more screens. | ⚠️ | ✅ |
| 6 | New `Busy("lock failed")` reason (`ModelSelectionLock`). It surfaces as `…model selection is being updated (lock failed) — nothing saved`, and the entry's diagnosis ("another change holds them") is wrong for it | ⚠️ | ✅ |
| 7 | Toast "Couldn't save changes. Try again or free up storage." (Settings, Search Provider, Telegram; new) | ⚠️ | ✅ |
| 8 | `XAI_RESTART_NEEDED` "Signed in, but the agent's settings were busy, so it was not restarted. Sign in with Grok again to finish." | ⚠️ | ✅ |
| 9 | `XAI_SIGN_OUT_NOT_SYNCED` "Signed out, but the agent's settings could not be updated. Sign in again, or choose API Key for xAI, before restarting the agent." | ⚠️ | ✅ |
| 10 | Extended Thinking / echo switch refused (silent flip-back). Refused when `updateOrSeedLocked` finds no **complete** record and the repair owns the stores, or when the lock is busy | ⚠️ | ✅ |

Logcat-only lines (`Log.w`/`Log.i`, excluded from scoring; they never reach the Logs screen):
- `lock failed: …` (ModelSelectionLock);
- `prefs mirror skipped: runtime_state.json holds no complete model selection`;
- `toggle not saved: no runtime_state.json record, and the model repair owns the stores`;
- `Could not restart :node after xAI sign-in`.

DIAGNOSTICS is correct to say the toggle case has "no line on the Logs screen". No JS log site was added or changed: the `message-handler.js` change is a comment only.

## Section C — Tool Consistency: N/A

No file under `tools/` is in the diff.

## Section D — Behavioral Probes: 6 → 12

| Probe | Door → target | Pre | Post |
|---|---|---|---|
| "I turned Extended Thinking on and it says it couldn't save" | The Reasoning block points to "/think on Toggled…". Pre-fix, that entry had no pointer to the save-failure case. The "Couldn't save" entry (reached through the generic DIAGNOSTICS door) covered the flip-back only for a "missing" `runtime_state.json`. It did not cover an incomplete record, a busy lock, or the fact that no message is shown, so the agent could not correct the user's "it says". Post-fix: `/think` links to the entry, and the entry names all three causes and says the switch flips back silently. | ⚠️ | ✅ |
| "Grok sign-in says sign in again" | Generic door → "Couldn't save" entry. The WARN line and the toast prefix were findable, and the fix was actionable. | ✅ | ✅ (full strings now) |
| "Settings save failed" | Generic door → "Couldn't save" entry. Pre-fix, only the lock-busy and `agent_settings.json` causes were covered. The storage-full ERROR, the `runtime_state` / `AgentPreferences` rollback lines and the new `lock failed` reason were missing or misdiagnosed. | ⚠️ | ✅ |
| "My ChatGPT sign-in was lost after a restart" (target changed at ~277) | OpenAI OAuth playbook item 5 → "Sign-In Storage" → the ~277 bullet. Pre-fix, the bullet led the agent to say a restart was safe with no WARN visible (see the curated row). | ⚠️ | ✅ |

## Provider-aware check

The Reasoning `unknown` line renders on every provider. Its transport clause is phrased per transport (ChatGPT sign-in; `codex` id on an API key), so it does not mislead Claude, OpenRouter or xAI users. OpenRouter sends its own `reasoning: {effort: 'none'|'medium'}` from the toggle and support, and the line makes no claim about it.

## Gaps Found (pre-fix), drift (D) or correction (C)

1. **D:** DIAG ~277 said `Save retry failed` logs "while it keeps failing". Refused re-sends are silent, so the agent could approve an unsafe restart.
2. **C:** DIAG ~304 had the same mis-statement about `Save retry failed` (it predates this round).
3. **D:** The new "Couldn't save changes. Try again or free up storage." toast was quoted only as "Couldn't save".
4. **D:** The two new xAI messages were quoted as truncated prefixes. The sign-out message's own fix ("choose API Key for xAI") was paraphrased.
5. **C:** `[Config] Failed to persist config (commit=false)` (ERROR) and the `RuntimeStateStore.write failed` / `AgentPreferencesStore.update failed` / `Rollback commit() returned false` lines had no DIAGNOSTICS coverage. They predate this round, but the new toasts surface them on three more screens.
6. **D:** The new `lock failed` Busy reason was diagnosed as "another change holds them". It is a file-system refusal.
7. **D:** The toggle flip-back covered only a "missing" record. It now also covers an incomplete record and a busy lock, says no message is shown, and has a cross-link from `/think`.
8. **D:** The xAI step timing said "five seconds". It is now three tries of five seconds.

## Fixes Applied

`app/src/main/assets/nodejs-project/DIAGNOSTICS.md` only. No `ai.js` change was needed.
- Refresh-token bullet (~277): a refused re-send logs nothing, and only `[OpenAI] Refreshed sign-in saved` proves the save landed.
- `Save retry failed` log-line bullet (~304): it is logged only on an unexpected error, and a refused re-send is silent.
- `/think` diagnosis: a one-line pointer for a switch that flips back → the "Couldn't save" entry.
- "Couldn't save" entry:
  - The symptoms quote the full toasts (all three variants) and the silent switch flip-back.
  - The check list adds the `lock failed` / `lock open failed` note, `Failed to persist config (commit=false)` (ERROR), and the `RuntimeStateStore` / `AgentPreferencesStore` rollback WARNs with their `Rollback commit()` ERROR.
  - The xAI bullet quotes both messages in full and notes that the sign-out case has no restart line.
  - The diagnosis covers a missing **or incomplete** record or a busy lock for the switches, and the 3 × 5 s xAI timing.
- Every new quote was checked against the source with `grep -F`. All of them match.
- Validation:
  - `node tests/nodejs-project/smoke.js`: PASS (92/92 files parse). The "neither loaded nor skipped" notice for `quiesce.js` / `rich-markdown.js` was already there before this change.
  - The DIAGNOSTICS-reading suites pass: `xai`, `cap-raise-hints`, `draft-outcomes`, `js-eval-snippets`, `shell-recipes` and `system-prompt-wallets`.

## Code Issues Found

None that block. One UX note (not a self-knowledge gap): the new Settings, Search Provider and Telegram toasts say "free up storage" even when the cause is a busy lock. DIAGNOSTICS now tells the agent to read the Logs-screen line first.

## Remaining Gaps

- **The full audit is owed as v54**, before the RC of the release that ships PR #465. It should include the pre-existing save-path lines found here, which a delta could not sweep.
- The "Model selection (BAT-1661)" curated row (from v49) still has to be added to the sab-audit skill in seekerclaw-skills.
