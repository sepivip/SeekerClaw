# SAB-AUDIT-v52 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-11-18
> **SAB Version:** v4
> **Mode:** Delta
> **Scope:** BAT-1661 (PR #465), the whole branch against `origin/main`. Two parts were not covered by v49. (1) `e70c45f0`, the durable model-repair handoff (contract v2.7–v2.10): the repair intent moves `pending` → `awaiting_main` → converged, `:node` never writes prefs, an unreadable or foreign `agent_settings.json` is never rewritten at start, and Reset takes the model-selection lock first. This commit rewrote the BAT-1661 section of DIAGNOSTICS.md. (2) The uncommitted v2.11 model lists and defaults. OpenAI moves to GPT-6.2 Astra / GPT-6 Astra / GPT-6.2 Sol / GPT-6.1 Sol / GPT-6.1 Terra / GPT-6 Luna, with `gpt-6.2-sol` as the default. Anthropic moves to the 5.5 line with `claude-opus-5-5` as the default, and Opus 5.5, Sonnet 5.5 and Haiku 5.5 get `thinkingBinding`. Opus 4.8, Sonnet 4.6, GPT-6 Sol and the GPT-5.x entries leave the picker. The v49 items were re-checked against the current text.
> **Diff range:** `774dd531` (merge base = `origin/main`)..`e70c45f0`, plus the working tree (v2.11 and this audit's fixes).
> **Method:** Read `buildSystemBlocks()` in `ai.js`: Config Awareness, the OpenAI provider block and the Reasoning block. Read DIAGNOSTICS.md: the model, `/think`, Service Lifecycle, Reset and BAT-1661 entries. Enumerated every `LogCollector.append` call that is new or changed against `origin/main` by parsing complete calls, not grepping lines. That gives 35 unique Kotlin sites and no new JS log sites. Each site was quoted against DIAGNOSTICS by exact substring. Traced each probe from its door to its target. Rendered the touched prompt lines from the real registry (off-list model `claude-opus-4-8`). No AI was invoked.
> **Baseline:** SAB-AUDIT-v51.md (Delta, highest on `main` and on any branch or open PR). This branch's earlier delta is v49. Last full audit: SAB-AUDIT-v48.md (2026-10-19).
> **Gate status:** On time. This audit ran before the merge of PR #465, and every fix is in the same branch (uncommitted, next to v2.11).
> **Next full audit due:** before the next release that ships code. This PR is in that release, and SAB v4 requires a full audit for every release. A full audit is also due after one more delta: v49, v50, v51 and v52 are four consecutive deltas, so the fifth (v53) must be full. The 60-day limit is not reached (v48 is 30 days old). A full audit is **not** due for this PR.

## Scores

Delta: every percentage below is against the **audited surface only**, not the full v48 item set.

| Section | Pre-fix | Post-fix | Max |
|---------|---------|----------|-----|
| A: Knowledge & Doors (3 items touched) | 5 | 9 | 9 |
| B: Diagnostics — curated (3 rows touched) | 9 | 9 | 9 |
| B: Diagnostics — discovered (35 sites) | 97 | 105 | 105 |
| C: Tool Consistency | N/A (no tool description changed) | — | — |
| D: Behavioral Probes (5) | 8 | 15 | 15 |
| **Combined (audited surface)** | **119 (86.2%)** | **138 (100%)** | **138** |

## Pre-fix Trend
| Audit | Mode | Pre-fix % | Post-fix % | Drift or correction |
|-------|------|-----------|------------|---------------------|
| v48 (v2.3.2) | Full (v4) | 68.8 | 87.4 | both |
| v49 (BAT-1661, first part) | Delta (v4) | 62.7 (surface) | 100 (surface) | 8 drift, 2 corrections |
| v50 (BAT-1157) | Delta (v4) | see v50 | 100 (surface) | — |
| v51 (BAT-1664) | Delta (v4) | see v51 | 100 (surface) | — |
| **v52 (BAT-1661, handoff + v2.11)** | **Delta (v4)** | **86.2 (surface)** | **100 (surface)** | 6 drift, 1 correction |

## Section A — Knowledge & Doors: 5 → 9

| # (v48 id) | Item | Pre | Post | Note |
|---|---|---|---|---|
| I2 | Model (incl. its reasoning support line) | ⚠️ | ✅ | The `Model:` line is still `activeModel`, resolved through the retired-model rule. `MODEL_CONTEXT_LIMITS` has the 5.5 and GPT-6.x ids. Pre-fix, the Reasoning block's `unknown` line said "Whether extended thinking takes effect depends on your gateway/provider — assume it does not unless the user has confirmed otherwise." In v2.11, Opus 4.8, Sonnet 4.6, GPT-6 Sol and the GPT-5.6 line become `unknown`. Every adapter (`claude.js`, `openai.js`, `openrouter.js`, `xai.js`) requests user-toggled thinking only for `reasoningSupport === 'yes'`, so a user who "confirms" that Opus 4.8 can think would get a wrong answer. The line also gave no reason and no fix. It now says the toggle has no effect on an unlisted model (custom ID, or a model that left the picker), says that picking a listed model restores it, and points at the `/think` DIAGNOSTICS entry. |
| G4 | Model / heartbeat change | ⚠️ | ✅ | No door said what the defaults are. "What's the default model?" would be answered from training memory. The only exception was ChatGPT sign-in, where the OAuth line names the default. v2.11 changes both main defaults, and `/provider` switches to the default. New line, built from `KNOWN_PROVIDERS` × `defaultModelForProvider()` so it never drifts from the registry: "Default models (registry): OpenAI `gpt-6.2-sol`, Anthropic `claude-opus-5-5`, xAI `grok-4.6`, OpenRouter `anthropic/claude-sonnet-4-6`; Custom has none…". It also states that an update never moves an existing choice to a new default, except a retired sign-in model. The BAT-1032 "NOT clamped … except" line is still accurate. |
| C6 | AI providers | ✅ | ✅ | The OpenAI OAuth door built from the registry renders "OpenAI no longer serves gpt-5.5, gpt-5.4, gpt-5.4-mini with ChatGPT sign-in: if one is selected, gpt-6.2-sol is used instead…". It is accurate after e70c45f0: the service start saves the target for the agent, and the app converges on its next load. |

Section A stays at 30 items: the new knowledge is folded into I2 and G4.

## Section B — Diagnostics

### Curated rows touched

| Row | Pre | Post |
|---|---|---|
| OpenAI OAuth — token refresh / sign-in failure | ✅ | ✅ |
| Service — `/model` or `/provider` switch didn't take effect | ✅ | ✅ (gained the reconcile ERROR, B-4) |
| Model selection (BAT-1661; row proposed in v49, still missing from the skill) — "OpenAI Model Changed On Its Own After An Update", "Settings Says \"Couldn't save\" …" | ✅ | ✅ |

### Discovered sites (35)

All are Kotlin `LogCollector` lines (Logs screen and `service_logs`). No JS log site was added or changed. `Log.w`/`Log.i` lines go to logcat only and are excluded. "Exact" means the DIAGNOSTICS quote is a verbatim substring of the code string (with `…`/`<model>` for interpolations).

| # | Site (level) | Pre | Post |
|---|---|---|---|
| 1 | `[Config] saveConfig: model selection is being updated (…) — nothing saved` (WARN) | ✅ | ✅ |
| 2 | `[Config] agent_settings.json write failed — rolled back prefs to (…)` (WARN/ERROR) | ✅ | ✅ |
| 3 | `[Config] agent_settings.json unreadable (…) — skipping reconciliation` (WARN) | ⚠️ | ✅ |
| 4 | `[Config] Reconcile: prefs commit failed — model selection not saved this time (…)` (ERROR) | ⚠️ | ✅ |
| 5 | `[Config] xAI OAuth runtime_state sync skipped: lock busy (…)` (WARN) | ✅ | ✅ |
| 6 | `[Config] Reset: model selection busy (…) — nothing reset` (WARN) | ✅ | ✅ (UI text added) |
| 7 | `[ModelRepair] could not confirm the repair record (…)` (WARN) | ✅ | ✅ |
| 8 | `[ModelRepair] could not clear a cancelled repair intent: …` (WARN) | ✅ | ✅ |
| 9 | `[ModelRepair] pending repair cancelled: <reason>` (INFO; all 8 reasons listed and matching `classifyIntent`) | ✅ | ✅ |
| 10 | `[ModelRepair] repair intent no longer proven (…) — ignored` (WARN) | ✅ | ✅ |
| 11 | `[ModelRepair] pending repair cancelled by a new model selection` (INFO) | ⚠️ | ✅ |
| 12 | `[ModelRepair] could not clear the repair intent after a selection (…) — the next start cancels it` (WARN) | ✅ | ✅ |
| 13 | `[ModelRepair] repair intent unreadable (…) — ignored` (WARN, 2 call sites) | ✅ | ✅ |
| 14 | `[ModelRepair] could not persist the repair intent (…) — stores left as they are, retry next start` (WARN) | ✅ | ✅ |
| 15 | `[ModelRepair] runtime_state rebuilt on <model> (<reason>)` (INFO) | ✅ | ✅ |
| 16 | `[ModelRepair] could not rebuild runtime_state (…) — …` (WARN) | ✅ | ✅ |
| 17 | `[ModelRepair] repair waits for a usable ChatGPT sign-in — model settings left as they are this start` (WARN) | ✅ | ✅ |
| 18 | `[ModelRepair] repair record not confirmed on disk — …` (WARN) | ✅ | ✅ |
| 19 | `[ModelRepair] repair write failed (…) — will resume next start` (WARN) | ✅ | ✅ |
| 20 | `[ModelRepair] runtime_state not saved (…) — repair stays pending, retry next start` (WARN) | ✅ | ✅ |
| 21 | `[ModelRepair] the agent's model file is not on <model> — …` (WARN) | ✅ | ✅ |
| 22 | `[ModelRepair] could not confirm <file> on disk (…) — …` (WARN) | ✅ | ✅ |
| 23 | `[ModelRepair] handoff to the app not confirmed (…) — the next start checks again` (WARN) | ✅ | ✅ |
| 24 | `[ModelRepair] could not record the handoff (…) — …` (WARN) | ✅ | ✅ |
| 25 | `[ModelRepair] openai model <old> is not available with ChatGPT sign-in — now <new>` (INFO, `notice()`) | ✅ | ✅ |
| 26 | `[ModelRepair] repair incomplete — model settings left as they are this start, retry next start` (WARN) | ⚠️ | ✅ |
| 27 | `[ModelRepair] model settings not fully saved this start — repair stays pending, retry next start` (WARN) | ✅ | ✅ |
| 28 | `[Config] service start: no config to publish (setup incomplete?)` (WARN) | ✅ | ✅ |
| 29 | `[Config] agent_settings.json names another provider — left as it is this start` (INFO) | ✅ | ✅ |
| 30 | `[Config] agent_settings.json unreadable — left as it is this start` (INFO) | ✅ | ✅ |
| 31 | `[ModelRepair] app settings not yet on <model> — the app retries on its next load` (WARN, 2 call sites) | ✅ | ✅ |
| 32 | `[ModelRepair] could not restore runtime_state (…) — the app retries on its next load` (WARN) | ✅ | ✅ |
| 33 | `[ModelRepair] could not record the finished repair (…) — the app retries on its next load` (WARN) | ✅ | ✅ |
| 34 | `[ModelRepair] settings not saved — the cancelled repair record is kept until the next load` (WARN) | ✅ | ✅ |
| 35 | `[ModelRepair] lock busy at start — read-only boot, repair deferred` (WARN) | ✅ | ✅ |

Pre-fix notes on the four ⚠️:
- **B-3:** the entry said "A corrupt file is rewritten from the app's settings on the next start", and its fix was "Stop Agent, then Deploy Agent". Since e70c45f0, `ModelRepair.serviceStart` logs `UNREADABLE_OVERLAY_KEPT` and skips `writeAgentSettingsJson` for an unreadable overlay (contract Q5/Q14). Only a Settings save (`writeAgentSettingsJson` starts from `{}`) replaces it. The old fix did not fix anything, and the WARN repeats.
- **B-4:** the v49 entry named this ERROR as the companion of `model settings not fully saved`. The e70c45f0 rewrite dropped it, and it appeared nowhere in DIAGNOSTICS. It now fires only on MAIN (`:node` is compute-only), for any reconcile commit: `/model`, `/provider`, or a repair converging.
- **B-11:** only the prefix `pending repair cancelled` matched. The line was not quoted (v49 accepted the prefix).
- **B-26:** `boot()` logs it after **every** `READ_ONLY` plan, including `TRANSPORT_DEFERRED`. Next to "repair waits for a usable ChatGPT sign-in", DIAGNOSTICS told the agent that repetition "usually means storage is full". For a signed-out user the real fix is to sign in again.

## Section C — Tool Consistency: N/A

`git diff origin/main -- app/src/main/assets/nodejs-project/tools/` is empty, so no tool `description` changed and none is force-included.

## Section D — Behavioral Probes: 8 → 15

| Probe | Door → target | Pre | Post |
|---|---|---|---|
| "My model changed on its own" | OpenAI OAuth door (registry-built) → "OpenAI Model Changed On Its Own After An Update". Actionable: the "Model:" line, the Logs-screen lines, the sign-in wait, and API-key users unaffected. The agent could also misread PLATFORM.md's Model line (the saved choice, which can still name the retired id until convergence), so the entry now says to trust the "Model:" line. | ✅ | ✅ |
| "/model claude-opus-4-8 rejected" | BAT-1032 line → "/model Rejects a Model ID That Settings Accepted". Pre-fix, the target only covered a custom ID typed in Settings, so the agent could say "use Custom model" but not why it worked before, that it loses Extended Thinking, or what replaced it. The target now covers models that left the picker, quotes `❌ Unknown model for <provider> (<auth>).`, and notes the ChatGPT sign-in exception. | ⚠️ | ✅ |
| "Why is Extended Thinking off on my model" | Reasoning block → "/think on Toggled…". Pre-fix, the `unknown` line was misleading (see I2) and had no pointer; the target named the removed models but not the fix. Post-fix, the door points to the entry, and the "not in known model list" fix says to pick a listed model. The yes-list matches the registry exactly (Fable 5.1/5, Opus 5.5/5, Sonnet 5.5/5, Haiku 5.5, the six GPT-6.x, Grok 4.6/4.5). | ⚠️ | ✅ |
| "What's the default model" | Pre-fix: no door except for ChatGPT sign-in. Post-fix: the registry-built defaults line (G4). | ❌ | ✅ |
| **New failure mode:** "Reset Config says it didn't run" | Generic DIAGNOSTICS door → "Reset Config — \"Reset not finished\"": names the busy WARN, the cause (a save held the lock over 1 s, `LOCK_TIMEOUT_MS`), and the fix (retry). The UI text "Reset didn't run, so nothing was changed. Try again." was added so the user's words match. | ✅ | ✅ |

## Provider-aware check

The defaults line is provider-independent and is built from the registry on every provider. The `unknown` reasoning line is shown on every provider. For OpenRouter and Custom (freeform), every model is `unknown`, and the line's "the model may still reason at its own default level" covers gateways that reason natively. With ChatGPT sign-in, OpenAI always sends `reasoning` (the Codex transport requires it), which is not "extra" thinking at the user's request, so the line stays true. The OAuth door is still shown only for `openai`/`oauth`.

## Gaps Found (pre-fix), drift (D) or correction (C)

1. **D:** I2: the reasoning `unknown` line was misleading for the models v2.11 removes from the picker (probe 3).
2. **C:** G4: there has never been a defaults door; v2.11's new defaults make memory answers wrong (probe 4).
3. **D:** probe 2: the `/model` rejection entry did not cover models that left the picker in v2.11.
4. **D:** B-3: the "skipping reconciliation" entry contradicted e70c45f0's never-rewrite-at-start rule, and its fix did not work.
5. **D:** B-4: the reconcile prefs-commit ERROR lost its coverage in the e70c45f0 rewrite.
6. **D:** B-26: "repair incomplete" was diagnosed as storage, even when it follows the sign-in wait.
7. **D:** B-11: the cancel-by-selection INFO was not quoted.

## Fixes Applied

- `ai.js`:
  - It imports `KNOWN_PROVIDERS` and adds the registry-built "Default models (registry)" line after the BAT-1032 line (Config Awareness). The line is wrapped in try/catch and omitted when empty, because two prompt suites stub `model-catalog` without `KNOWN_PROVIDERS`.
  - The Reasoning block's `unknown` line is rewritten (see I2) and points at DIAGNOSTICS.
- `DIAGNOSTICS.md`:
  - "/model Rejects…" gets an "Also: a model that has left the picker" paragraph.
  - "OpenAI Model Changed…":
    - The PLATFORM.md note is added to the check.
    - The cancel-by-selection INFO is quoted.
    - "repair incomplete" is rewritten to read the line above it (sign-in wait vs storage).
    - The app-side line points at the reconcile ERROR.
  - "/model or /provider Switch Didn't Take Effect" gets the `[Config] Reconcile: prefs commit failed …` ERROR.
  - "`[Config] agent_settings.json unreadable (…)`" is rewritten:
    - A start never rewrites the file.
    - A Settings save writes a fresh one, and keys saved only in it are lost.
    - For a link, the fix is still Stop → Deploy.
    - It names its INFO companions.
  - Reset gets the UI text.
  - The `/think` "not in known model list" fix covers models that left the picker.
- Validation:
  - `node tests/nodejs-project/smoke.js`: PASS (39/39).
  - `system-prompt-wallets` and `system-prompt-recent-sessions`: PASS. They failed with the first, unguarded version of the defaults line and pass after the guard.
  - All 112 `tests/nodejs-project/*.test.js` were run. The 3 failures are pre-existing and are not in this branch's diff: `runtime-state-reasoning` expects `claude-opus-4-8`, `think-command` uses `claude-opus-4-7`, and `shutdown-flush` makes Kotlin-source assertions. These are the BAT-1706 suites.
  - The rendered prompt was checked against the real registry.

## Code Issues Found (not fixed here: outside docs/prompt scope)

- **`SettingsHelpTexts.MODEL` is stale after v2.11 (user-visible; fix in this PR).** It says "OpenAI examples: GPT-6 Astra (frontier), GPT-6.1 Sol (default), GPT-6 Luna (fast)" and "Anthropic examples: … Opus 4.8 (powerful), Sonnet 4.6 (balanced) …". The default is now GPT-6.2 Sol, and Opus 4.8 and Sonnet 4.6 have left the picker. A user who reads this help text and then asks the agent for the default gets two different answers.
- **PLATFORM.md's Model line uses `config?.model`, not `config?.displayModel`** (`ConfigManager.writePlatformMdInternal`). On a read-only boot (lock busy) or before MAIN converges, it can name a retired sign-in model while Node sends the default. DIAGNOSTICS now tells the agent to trust the "Model:" line. Using `displayModel` here would remove the mismatch (optional, same PR).

No Linear issue was filed: the branch is unpushed, and both items fit in this PR. The caller decides.

## Remaining Gaps

- The "Model selection (BAT-1661)" curated row (from v49) still has to be added to the sab-audit skill in seekerclaw-skills.
- A full audit is due before the release that ships this PR, or as v53, whichever comes first.
