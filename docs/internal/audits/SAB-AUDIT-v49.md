# SAB-AUDIT-v49 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-11-10
> **SAB Version:** v4
> **Mode:** Delta
> **Scope:** BAT-1661 (PR #465). OpenAI's picker becomes GPT-6.1 / GPT-6 with `gpt-6.1-sol` as the default. GPT-5.5, GPT-5.4 and GPT-5.4 Mini are retired for ChatGPT sign-in: a read rule replaces them with the default at use, and a durable repair moves the stored choice in prefs, `runtime_state.json` and `agent_settings.json` at service start, under a new model-selection lock. The OpenAI OAuth token save over the bridge now reports a failed save. The two other commits in the range (#462 README, #463 CLAUDE.md split) touch nothing under `app/src/main` and are out of scope.
> **Diff range:** 2d547379..9cdd840c, plus the audit fixes in this branch.
> **Method:** Read `buildSystemBlocks()` in `ai.js` (Config Awareness, the OpenAI provider block and the OAuth playbook) and DIAGNOSTICS.md (the model, OAuth, xAI, Agent Logs and Service Lifecycle sections). Enumerated every ERROR/WARN/INFO site the range added in JS and in Kotlin `LogCollector`; Kotlin `Log.w`/`Log.e` lines go to logcat only and are excluded, because neither the user nor the agent can see them. Traced each probe from door to target. No AI was invoked.
> **Baseline:** SAB-AUDIT-v48.md (Full, 2026-10-19). Last full audit: v48.
> **Gate status:** On time. Run before the merge of PR #465; every fix is in the same branch.
> **Next full audit due:** before the next release that ships code, which includes this PR (SAB v4: a release always gets a full audit), or after 4 more deltas, whichever comes first.

## Scores

Delta: every percentage below is against the **audited surface only**, not the full v48 item set.

| Section | Pre-fix | Post-fix | Max |
|---------|---------|----------|-----|
| A: Knowledge & Doors (3 items touched) | 5 | 9 | 9 |
| B: Diagnostics — curated (2 rows touched) | 6 | 6 | 6 |
| B: Diagnostics — discovered (16 sites) | 30 | 48 | 48 |
| C: Tool Consistency | N/A (no tool description changed) | — | — |
| D: Behavioral Probes (4) | 6 | 12 | 12 |
| **Combined (audited surface)** | **47 (62.7%)** | **75 (100%)** | **75** |

## Pre-fix Trend
| Audit | Mode | Pre-fix % | Post-fix % | Drift or correction |
|-------|------|-----------|------------|---------------------|
| v48 (v2.3.2) | Full (v4) | 68.8 | 87.4 | both |
| **v49 (BAT-1661)** | **Delta (v4)** | **62.7 (surface)** | **100 (surface)** | 8 drift caught pre-merge, 2 corrections |

## Section A — Knowledge & Doors: 5 → 9

| # (v48 id) | Item | Pre | Post | Note |
|---|---|---|---|---|
| I2 | Model | ✅ | ✅ | The `Model:` line is `activeModel`, which Node resolves through `applyRetiredModelRule`, so it always shows the model actually sent. |
| G4 | Model / heartbeat change | ⚠️ | ✅ | The BAT-1032 line said a custom model ID "is NOT clamped". On ChatGPT sign-in a retired ID typed as a custom model is now replaced by the default. The line now names that exception and points at the new DIAGNOSTICS entry. |
| C6 | AI providers | ⚠️ | ✅ | No door told the agent that its model can be replaced after an update. The BAT-1083 line ("most likely switched between turns") would have given a wrong answer to "why did my model change?". The OpenAI OAuth auth-mode block now has one line, built from `retiredModelsFor('openai','oauth')` and the default, so it cannot drift from the registry. It is shown only on ChatGPT sign-in. |

Section A stays at 30 items: the new knowledge is folded into G4 and C6.

## Section B — Diagnostics

### Curated rows touched

| Row | Pre | Post |
|---|---|---|
| OpenAI OAuth — token refresh / sign-in failure ("OpenAI Codex OAuth — …") | ✅ | ✅ (new cause added, see B-16) |
| Service — `/model` or `/provider` switch didn't take effect | ✅ | ✅ |

**New curated row (to add to the sab-audit skill in seekerclaw-skills):** "Model selection (BAT-1661) | Model changed on its own after an update; `Couldn't save` while the selection is busy | 'OpenAI Model Changed On Its Own After An Update', 'Settings Says \"Couldn't save\" Right After A Start Or A Model Change'".

### Discovered sites (16)

All are Kotlin `LogCollector` lines (Logs screen and `service_logs`) except B-16.

| # | Site | Pre | Post |
|---|---|---|---|
| 1 | `[ModelRepair] openai model <old> is not available with ChatGPT sign-in — now <new>` (INFO) | ✅ | ✅ |
| 2 | `[ModelRepair] pending repair cancelled: <reason>` (INFO) | ✅ | ✅ |
| 3 | `[ModelRepair] pending repair cancelled by a new model selection` (INFO) | ✅ | ✅ |
| 4 | `[ModelRepair] could not persist the repair intent` (WARN) | ✅ | ✅ |
| 5 | `[ModelRepair] repair write failed` (WARN) | ✅ | ✅ |
| 6 | `[ModelRepair] stores not yet on <model>` (WARN) | ✅ | ✅ |
| 7 | `[ModelRepair] lock busy at start — read-only boot, repair deferred` (WARN) | ✅ | ✅ |
| 8 | `[ModelRepair] repair intent unreadable … — ignored` (WARN) | ⚠️ | ✅ |
| 9 | `[ModelRepair] could not clear a cancelled repair intent` (WARN) | ⚠️ | ✅ |
| 10 | `[ModelRepair] could not clear the repair intent after a selection` (WARN) | ⚠️ | ✅ |
| 11 | `[ModelRepair] stores repaired but the intent could not be cleared` (WARN) | ⚠️ | ✅ |
| 12 | `[Config] saveConfig: model selection is being updated (…) — nothing saved` (WARN; the user sees "Couldn't save") | ⚠️ | ✅ |
| 13 | `[Config] xAI OAuth runtime_state sync skipped: lock busy (…)` (WARN) | ⚠️ | ✅ |
| 14 | `[Config] service start: no config to publish (setup incomplete?)` (WARN; renamed from the old `writeConfigJson: loadConfig returned null`, which was also uncovered) | ⚠️ | ✅ |
| 15 | `[Config] agent_settings.json unreadable (…) — skipping reconciliation` (WARN; text unchanged, line rewritten) | ⚠️ | ✅ |
| 16 | `[OpenAI] Failed to persist refreshed tokens: …` (Node WARN; existing site, now reached when the bridge returns 503 `OPENAI_OAUTH_SAVE_FAILED` instead of a false success) | ⚠️ | ✅ |

## Section C — Tool Consistency: N/A

No tool `description` changed in the range (`git diff 2d547379..HEAD -- app/src/main/assets/nodejs-project/tools/` is empty), so no tool is force-included.

## Section D — Behavioral Probes: 6 → 12

| Probe | Door → target | Pre | Post |
|---|---|---|---|
| "I switched the model but nothing changed" | Config Awareness (BAT-504/1083) → "/model or /provider Switch Didn't Take Effect" | ✅ | ✅ |
| **New failure mode:** "My OpenAI model changed to GPT-6.1 Sol by itself" | Pre-fix: only the generic DIAGNOSTICS pointer, the BAT-1083 line pointed to the wrong cause, and the entry's check grepped `node_debug.log` for Kotlin-only lines (finds nothing). Post-fix: an OAuth-block door plus an entry that says to read the `Model:` line and ask the user for the Logs-screen lines. | ⚠️ | ✅ |
| "`/think on` doesn't change anything" | `/think` hint → "/think on Toggled But…". This PR updated the OpenAI names, but the list still named Opus 4.7/4.6 (no longer in the registry, so the toggle is a no-op for them) and omitted Fable 5.1, Opus 5, Sonnet 5 and Grok 4.6/4.5. Found by CodeRabbit on PR #465 after this audit first scored it ✅; the list now matches `model-registry.json`. API-key users on a removed id get the "not in known model list" path, which is accurate (D4). | ⚠️ | ✅ |
| "Sign in with ChatGPT keeps asking me to sign in again" | OAuth playbook → "OpenAI Codex OAuth — Token Refresh Failure". Pre-fix this did not list a refreshed token that was never saved as a cause. | ⚠️ | ✅ |

## Provider-aware check

The new prompt line is injected only for `PROVIDER === 'openai' && OPENAI_AUTH_TYPE === 'oauth'`. `retiredModelsFor` returns `[]` for every other provider/auth pair (checked: `openai`/`api_key` → `[]`), so the line is absent there. Claude, OpenRouter, xAI and Custom prompts are unchanged.

## Gaps Found (pre-fix), drift (D) or correction (C)

1. **D:** the G4 custom-model line overstated "NOT clamped" for retired IDs on ChatGPT sign-in.
2. **D:** C6 had no door for "my model changed after an update", and the BAT-1083 line pointed to the wrong cause.
3. **C:** the new DIAGNOSTICS entry's check command grepped `node_debug.log` for Kotlin-only `[ModelRepair]` lines. It was written in this PR before the audit, but it repeats a known trap that "Logs screen missing lines" already warns about.
4. **D:** four repair housekeeping WARNs (sites 8–11) had no guidance.
5. **D:** "Couldn't save" while the selection lock is busy (site 12) had no guidance.
6. **D:** the xAI sync skipped under a busy lock (site 13) had no guidance, and the 1 s bound made the skip too easy to hit; see Code Issues.
7. **D:** sites 14–15 had no guidance (both were already uncovered before this PR under their old wording).
8. **D:** the OpenAI token-persist failure (site 16) was missing from the refresh-failure causes.
9. **D:** probes 2 and 4 failed for the reasons above.
10. **C:** the `/think` model list (probe 3) was stale from earlier registry updates (Opus 4.7/4.6 removed; Fable 5.1, Opus 5, Sonnet 5, Grok missing). Missed by this audit, caught by CodeRabbit; fixed in this branch.

## Fixes Applied

- `ai.js`: imports `retiredModelsFor` and `defaultModelForProvider` from `model-catalog`. The G4 line names the retired-for-sign-in exception. The OpenAI OAuth auth-mode block gets one registry-built line with a DIAGNOSTICS pointer.
- `DIAGNOSTICS.md`:
  - "OpenAI Model Changed On Its Own After An Update": the check now uses the `Model:` line and the Logs screen, and it covers sites 8–11.
  - New "Settings Says \"Couldn't save\" Right After A Start Or A Model Change": covers sites 12–13. For the xAI case, the fix is to sign in again, because a restart alone does not re-run the sync.
  - New "Deploy Agent Stops With `[Service] Config not available …`" (site 14 and the ERROR that follows it) and a separate "`[Config] agent_settings.json unreadable …`" entry (site 15: corrupt vs link, and agent-stored keys lost on rewrite). Both were rewritten after the pre-push review found the first draft wrong (it said the agent starts, and it mixed site 15 into site 14).
  - "OpenAI Codex OAuth — Token Refresh Failure": adds the unsaved-refresh-token cause (site 16).
- Validation:
  - `node tests/nodejs-project/smoke.js` passed.
  - `ModelSelectionSourceGuardTest` and `XaiProviderContractTest` passed.
  - The door line renders from the registry: "OpenAI no longer serves gpt-5.5, gpt-5.4, gpt-5.4-mini with ChatGPT sign-in: if one is selected, gpt-6.1-sol is used instead…".

## Code Issues Found

- **xAI runtime auth sync could be skipped under a 1 s lock bound (fixed here, same PR).** `ConfigManager.syncXaiRuntimeAuthType` runs only on `Dispatchers.IO`, after an xAI sign-in or sign-out. With the default 1 s bound, a concurrent settings change could skip it and leave `runtime_state.json`, which Node reads first, on the old xai auth mode: the boot split that BAT-1155 H5 exists to prevent. It now waits up to 5 s (`XAI_SYNC_LOCK_TIMEOUT_MS`, the same order as the collector mirror). It stays bounded and logs the WARN if it still cannot get the lock.

## Remaining Gaps

- The new curated row above must be added to the sab-audit skill in the seekerclaw-skills repo.
- A full audit is due before the release that ships this PR.
