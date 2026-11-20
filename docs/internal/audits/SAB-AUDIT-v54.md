# SAB-AUDIT-v54 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-11-19
> **SAB Version:** v4
> **Mode:** Delta
> **Scope:** BAT-1661 (PR #465), the uncommitted Q16 retry-record round on top of `7de1e77c` (contract v2.12, Codex sign-off `2c3b07c1` with five binding folds). Code: the new `config/ReconcileRecord.kt` (the durable retry record `model_reconcile_record.json`, its resolver and the fold-5 controlled restart), plus `ConfigManager.kt` (record written before the reconcile's prefs commit; resolve first in the locked load; xAI sync hold), `RuntimeStateStore.kt` (resolve in the collector mirror, first-launch seed and toggle seed; the new `TOGGLE_HELD_REASON`), `MainPrefs.kt` (the per-process "a prefs commit failed" taint; the `apply()` guard) and `ModelRepair.kt` (the `:node` read-only start `BOOT_HELD`). Agent-visible text: 15 new or changed DIAGNOSTICS bullets in "/model or /provider Switch Didn't Take Effect" and one cross-reference in "OpenAI Model Changed On Its Own After An Update". No `ai.js` change in the diff.
> **Diff range:** `7de1e77c`..working tree (`git diff HEAD`, plus the untracked `ReconcileRecord.kt` / `ReconcileRecordTest.kt`).
> **Method:**
> - Read all of `ReconcileRecord.kt` and every hunk of the main-source diff. Read the call sites of `resolve`, `write`, `clearSuperseded`, `AgentRestart.note/flush`, `BOOT_HELD`, `XAI_SYNC_HELD`, `APPLY_MODEL_KEYS` and `TOGGLE_HELD_REASON` in context.
> - Grepped the diff for added `LogLevel.(ERROR|WARN)`, `LogCollector.append` and `Log.(w|e|i)` lines. Each hit was read in context. No JS log site is in the diff.
> - Grepped every DIAGNOSTICS quote of a new or changed line with `grep -F` against `app/src/main/java`. Interpolated lines were checked as their fixed prefix and suffix. Every quote matches.
> - Traced the restart path (`AgentRestart.run` → `SeekerClawService.restart` → `stopWithDurability`), the taint (`MainPrefs.GuardedEditor.commit` and `commitOrRestoreLocked` both set it, and only `ReconcileRecord.resolveLocked` reads it), and the process layout (`AndroidManifest.xml`: the service runs in `:node`). Correction (CodeRabbit 4628273876): removing the task from Recents does NOT guarantee that Android ends MAIN; if MAIN survives, reopening the app keeps the failed-commit flag and the reconcile stays Deferred. Only a new MAIN process clears it, so the guidance is: force stop the app (Settings > Apps > SeekerClaw > Force stop) or restart the phone, reopen it, and start the agent again if needed.
> - Traced 4 probes from door to target. No AI was invoked.
> **Baseline:** SAB-AUDIT-v53.md (Delta). It is the highest number on any branch or open PR: `git log --all` over `docs/internal/audits/SAB-AUDIT-v*` and every `origin/*` tree top out at v53, and none of the open PRs carries a v54. Last full audit: SAB-AUDIT-v48.md (2026-10-19).
> **Gate status:** On time. This audit ran before the merge of PR #465, and the fixes are in the same working tree (uncommitted). v53 recorded that v54 must be full. v54 is a delta anyway: it is a same-PR audit of one unpushed round whose surface a delta covers completely. **The full audit is still owed and moves to v55. It must be full and must run before the RC of the release that ships PR #465 is tagged.** This is the sixth delta in a row (v49–v54).
> **Next full audit due:** v55, before the RC of the release that contains PR #465. Both the release rule and the five-delta rule require it.

## Scores

Delta: every percentage below is against the **audited surface only**.

| Section | Pre-fix | Post-fix | Max |
|---------|---------|----------|-----|
| A: Knowledge & Doors (1 item touched + door decision) | 3 | 3 | 3 |
| B: Diagnostics — curated (3 rows touched) | 5 | 9 | 9 |
| B: Diagnostics — discovered (18 sites/behaviours) | 42 | 54 | 54 |
| C: Tool Consistency | N/A (no tool description changed) | — | — |
| D: Behavioral Probes (4) | 4 | 12 | 12 |
| **Combined (audited surface)** | **54 (69.2%)** | **78 (100%)** | **78** |

## Pre-fix Trend
| Audit | Mode | Pre-fix % | Post-fix % | Drift or correction |
|-------|------|-----------|------------|---------------------|
| v48 (v2.3.2) | Full (v4) | 68.8 | 87.4 | both |
| v49 (BAT-1661, first part) | Delta (v4) | 62.7 (surface) | 100 (surface) | 8 drift, 2 corrections |
| v52 (BAT-1661, handoff + v2.11) | Delta (v4) | 86.2 (surface) | 100 (surface) | 6 drift, 1 correction |
| v53 (BAT-1661, CodeRabbit fix round) | Delta (v4) | 65.1 (surface) | 100 (surface) | 6 drift, 2 corrections |
| **v54 (BAT-1661, Q16 retry record)** | **Delta (v4)** | **69.2 (surface)** | **100 (surface)** | 7 drift, 0 corrections |

## Section A — Knowledge & Doors: 3 → 3

| Item | Pre | Post | Note |
|---|---|---|---|
| Configuration — model/provider change from chat (`ai.js` ~1129, BAT-504 door) | ✅ | ✅ | "Both write to runtime_state.json (live overlay) and survive restart" is still true. The retry record only makes the app's own settings converge on what the agent already uses. |

**Door decision — `BOOT_HELD` ("a model selection change is not finished yet … opening the app finishes it"): no new door.** The 3-part test fails on two parts:
1. *Meaningfully changes what the agent can do:* marginal. It is a recovery path after a storage failure followed by the app process dying.
2. *Users likely to ask:* no. It needs a failed runtime_state write **and** a failed rollback (or a lost process) before it can appear.
3. *Wrong answer without a door:* no. The line names its own remedy ("opening the app finishes it"). The existing Diagnostics door ("read DIAGNOSTICS.md") leads to two verbatim quotes of it: one in "/model or /provider Switch Didn't Take Effect", one cross-referenced from the ModelRepair entry. `ai.js` was not changed.

## Section B — Diagnostics

### Curated rows touched

| Row | Pre | Post | Note |
|---|---|---|---|
| Service — `/model` or `/provider` switch didn't take effect (Service Lifecycle) | ⚠️ | ✅ | All 15 new or changed bullets quote the code verbatim. The section's Symptoms covered only "UI new, agent old", not "the app shows something else after a restart". The Fix steps had no path for a pending change: close the app fully, or re-select in Settings, which supersedes the record (H5, `ConfigManager.kt:1212`). (Superseded: "close the app fully" is now force stop the app or restart the phone, and re-selecting must pick a different model first — see the Correction in the Method notes and Addendum 1.) |
| Model selection (BAT-1661) — "Couldn't save" entry | ⚠️ | ✅ | The silent toggle flip-back listed the repair and busy-lock causes only. The new `TOGGLE_HELD_REASON` hold was missing (probe 4). |
| OpenAI model repair (BAT-1661) — the `BOOT_HELD` cross-reference | ✅ | ✅ | "The other read-only start … no repair runs this start" matches `ModelRepair.boot`. A Present or Unavailable record returns `readOnly()` before `plan()`. |

### Discovered sites and behaviours (18)

Every row reaches the Logs screen (`LogCollector.append`), except #18, which is a user-visible behaviour. "Exact" means the DIAGNOSTICS quote is a verbatim copy of the code string (`<…>`/`…` only for an interpolation).

| # | Site (level) | Exact | Pre | Post | Note |
|---|---|---|---|---|---|
| 1 | `recordWriteFailed` (ERROR) | ✅ | ✅ | ✅ | No mutation, and the next load retries. Correct. |
| 2 | `RUNTIME_UNCONFIRMED` (WARN) | ✅ | ✅ | ✅ | Post-fix it also notes that a successful confirm is silent but can be followed by the restart line. |
| 3 | `recordClearFailed` (WARN) | ✅ | ✅ | ✅ | |
| 4 | `recordUnreadable` (WARN) | ✅ | ✅ | ✅ | "Or one from another app version" matches `invalidReason` (`version`). |
| 5 | `RECORD_DEFERRED` (INFO, once per process) | ✅ | ✅ | ✅ | "Reopening the app screen does NOT clear this — only a new app process does" matches `MainPrefs.commitFailedThisProcess` (sticky, process-scoped). "Settings still save" is true: only `resolveLocked` reads the flag. |
| 6 | `recordDropped` + 5 reasons (INFO) | ✅ | ✅ | ✅ | All 5 reason constants are quoted. |
| 7 | `recovered` (INFO) | ✅ | ✅ | ✅ | |
| 8 | `agentRestarting` (INFO) | ✅ | ⚠️ | ✅ | "Restarts it once" was right per process (`requested` set keyed on the record's SHA-256). It did not say that a Completed outcome (after `not confirmed on disk`) restarts with no `finished after a restart` line before it, or that a leftover record (`retry record not cleared`) can restart once more at a later app start. Post-fix both are stated, and the line is named as the answer to "restarted by itself". |
| 9 | `agentNotRunning` (INFO) | ✅ | ✅ | ✅ | "A stopped agent is never started" matches `AgentRestart.run` (STARTING counts as running). |
| 10 | `agentRestartFailed` (WARN) | ✅ | ✅ | ✅ | |
| 11 | `recoverFailed` (WARN) | ✅ | ✅ | ✅ | |
| 12 | `BOOT_HELD` (WARN, `:node`) | ✅ | ⚠️ | ✅ | "Open the app" does not finish it while a tainted MAIN process is still alive (Deferred). The silent holds (record Unavailable, `runtime_state` confirm failed) had no explanation. Post-fix: force stop the app (or restart the phone) first — removing it from Recents does not guarantee a new process — the no-line case is named, and a new selection in Settings is offered (a different model first: re-saving the shown selection is not a selection). |
| 13 | `XAI_SYNC_HELD` (WARN) | ✅ | ⚠️ | ✅ | The hold returns false, so `sync failed: runtime_state.json not written` and `xAI sign-in saved, agent not restarted: runtime_state.json not saved — free storage, …` follow it. Those lines and the Settings message blame storage. Also, "once `Reconcile finished after a restart` appears" is not always logged (the Completed path is silent). |
| 14 | `Reconcile produced invalid RuntimeState …` (WARN, meaning changed: record kept) | ✅ | ✅ | ✅ | The prefs commit succeeded, so the process is not tainted, and the next load recovers. Correct. |
| 15 | `APPLY_MODEL_KEYS` (ERROR) | ✅ | ✅ | ✅ | "Unproven until the next app start" matches `GuardedEditor.apply` → `noteCommitFailed()`. |
| 16 | `Reconcile: prefs commit failed …` (ERROR, meaning changed) | ✅ | ✅ | ✅ | "Retry at the next app START, not when the app screen is reopened" matches `commitOrRestoreLocked` → taint. |
| 17 | `Reconcile: runtime_state.json not saved — model selection rolled back …` (WARN, meaning changed) | ✅ | ⚠️ | ✅ | **Wrong for `commit_ok=false`.** The failed rollback commit goes through `GuardedEditor.commit`, which taints the process. So "the next load (reopening the app) tries both again" is false: the next load is Deferred. The `commit_ok=true` path also logs `retry record dropped — the change never reached the app's settings` before the ordinary reconcile. |
| 18 | Toggle hold `TOGGLE_HELD_REASON` (logcat only; the switch flips back silently) | n/a | ⚠️ | ✅ | `updateOrSeedLocked` → `seedInTx` → `out.holds` → refused. This happens only when `runtime_state.json` is missing or incomplete. Not covered pre-fix. |

Logcat-only lines (`Log.i`/`Log.w`, excluded from scoring; they never reach the Logs screen):
- `reconcile held: a model selection change is being finished`;
- `first-launch seed held: …`;
- `prefs mirror held: …`;
- `toggle not saved: a model selection change is being finished`;
- `reconcile retry record completed: runtime_state.json already holds the change`;
- `OpenAI key check failed (…)` (`RuntimeStateStore.deriveKeyFlagAtInit`).

## Section C — Tool Consistency: N/A

No file under `tools/` is in the diff.

## Section D — Behavioral Probes: 4 → 12

| Probe | Door → target | Pre | Post |
|---|---|---|---|
| "I changed provider in chat, the app shows something else after a restart" | BAT-504 door + the Diagnostics door → "/model or /provider Switch Didn't Take Effect". The Symptoms described only "UI new, agent old after an ack", and the Fix steps had no action for a pending change, so the agent would stop at "kill and reopen". Post-fix: the Symptoms name this case and point to the `[Config] Reconcile …` lines. Fix step 5 gives the actions: free storage, force stop the app (Settings > Apps > SeekerClaw > Force stop) or restart the phone and reopen it (removing it from Recents does not guarantee a new process), or make a new selection in Settings (a different model first). Then trust the "Model:" line. | ⚠️ | ✅ |
| "The Logs screen says a model selection change is not finished yet" | The Diagnostics door → two verbatim quotes. Pre-fix the advice was "open the app". That is wrong when the app process is still alive and tainted, and nothing explained a repeat with no other line. | ⚠️ | ✅ |
| "The agent restarted by itself" | The Diagnostics door → the "expected on the Logs screen" list (Service Lifecycle). Pre-fix it explained only the Watchdog and crash-loop restarts. The reconcile restart line existed only inside the `/model` section, so an agent without the exact line would answer "Watchdog". Post-fix the list has the reconcile restart line, the `/model` bullet calls it the "restarted by itself" answer, and it gives the at-most-once rule. | ⚠️ | ✅ |
| "The Extended Thinking switch flips back" | Reasoning block → "/think on Toggled…" → "Couldn't save" entry. The diagnosis covered the repair, the incomplete record and the busy lock, not an interrupted model change. Post-fix it names that cause, what the Logs screen usually shows, and the two actions. | ⚠️ | ✅ |

## Provider-aware check

The record and the restart are provider-neutral (`RuntimeStateStore.isValidPair`). The only provider-specific path is the xAI sign-in hold (row 13), which is covered. No prompt text assumes a provider.

## Gaps Found (pre-fix), drift (D) or correction (C)

1. **D:** The `rolled back` bullet said reopening the app retries for `commit_ok=false`. The failed rollback taints the process, so only a new app process finishes it. The bullet also omitted the `commit_ok=true` drop line.
2. **D:** `BOOT_HELD` advised "open the app", which fails while a tainted app process is still alive. The silent-hold cases were not explained.
3. **D:** The restart bullet did not cover the Completed path (no `finished after a restart` line before it), the at-most-once scope (per record, per app process), or the "restarted by itself" question.
4. **D:** `XAI_SYNC_HELD` did not warn that the storage-worded xAI lines and Settings message after it are the hold, and it waited on a line that the Completed path never logs.
5. **D:** The `TOGGLE_HELD_REASON` flip-back cause was missing from the "Couldn't save" diagnosis.
6. **D:** The `/model`/`/provider` Symptoms and Fix had no "app differs after a restart / change not finished" path, and no re-select-in-Settings remedy (H5).
7. **D:** The "expected on the Logs screen" list had no entry for the reconcile restart, so "it restarted by itself" was diagnosed as the Watchdog.

## Fixes Applied

`app/src/main/assets/nodejs-project/DIAGNOSTICS.md` only (+21/−4 cumulative on this round's diff). No `ai.js` change: the door test fails, see Section A.
- "/model or /provider Switch Didn't Take Effect":
  - Symptoms add the "app shows something else after a restart" case.
  - Rewrote the `commit_ok` sentence of the `rolled back` bullet.
  - `not confirmed on disk` gains the silent-confirm + restart note.
  - The restart bullet gains the Completed path, the at-most-once scope and the "restarted by itself" note.
  - `BOOT_HELD`: force stop the app (or restart the phone) when the app was already open — removing it from Recents does not guarantee a new process — the no-line case, and a new selection in Settings (a different model first).
  - `XAI_SYNC_HELD`: the following storage-worded lines are this hold, and the "finished" condition is restated.
  - New Fix step 5 for a change that is not finished.
- "Couldn't save" entry: the interrupted-change cause of the silent toggle flip-back, with what the Logs screen shows and the two actions.
- Service Lifecycle, "Also on the Logs screen, and expected": a bullet for `[Config] Reconcile finished: restarting the agent …`.
- Every quote added in this round was re-checked with `grep -F` against `app/src/main/java`, including `xAI OAuth runtime_state sync failed: runtime_state.json not written`, `xAI sign-in saved, agent not restarted: runtime_state.json not saved — free storage, ` and `Reconciled from agent_settings.json`. All match.
- Validation:
  - `node tests/nodejs-project/smoke.js`: PASS (92/92 files parse, 39/39 modules load). The "neither loaded nor skipped" notice for `quiesce.js` / `rich-markdown.js` was there before this change.
  - CI Node suite list (`ci_node.py`): 82 suites, 0 failures.

## Code Issues Found

None that block. Two UX notes for the PR owner. They are not self-knowledge gaps, and both are now explained in DIAGNOSTICS:
- **xAI sign-in during a pending change.** `syncXaiRuntimeAuthType` returns `false` on `out.held`. The caller then logs `sync failed: runtime_state.json not written`, and the activity shows the storage message ("Free up storage, then sign out and sign in with Grok again"), although storage is not the cause. A distinct `XaiAuthSync` outcome for the hold would let the UI say "a model change is being finished".
- **Silent holds in MAIN.** `Read.Unavailable` and a failed confirm rewrite return `Outcome.Failed` with no Logs-screen line in MAIN (only the logcat `… held` lines). The user sees only `BOOT_HELD` at the next agent start, and an Extended Thinking switch can flip back with nothing on the Logs screen.

No Linear issue was filed: these are UX notes, not defects, and the PR owner decides.

## Remaining Gaps

- **The full audit is owed as v55**, before the RC of the release that ships PR #465 (sixth delta in a row). It should sweep the whole BAT-1661 surface (v49–v54) and the pre-existing save-path lines v53 found.
- The sab-audit skill (seekerclaw-skills) still has to gain the "Model selection (BAT-1661)" curated row from v49. It should also gain a row for "interrupted model/provider change (retry record, `BOOT_HELD`, controlled restart)".

## Addendum: follow-up quote updates (BAT-1661 Q16, same round)

The code changed after the fixes above, so the DIAGNOSTICS quotes were brought in line. `DIAGNOSTICS.md` only; no `ai.js` change.

Code changes covered:
- The restart after a recovered model or provider change now runs only when the agent is proven live (a live `:node` process, `service_state` RUNNING, `agent_health_state` within 120 s) AND the app is in the foreground. Otherwise the agent is not stopped and uses the change at its next start.
- At most one restart per retry record, ever (durable `restartRequested` marker), not per app process.
- A held xAI sync is its own result (`XaiAuthSync.HELD`), with its own WARN and Settings messages. It is no longer reported as "not written" / "free storage".
- `Read.Unavailable` and a failed confirm rewrite now log their own WARN, once per app process (closes the "Silent holds in MAIN" note above).

Quote updates in "/model or /provider Switch Didn't Take Effect":
- New: `Reconcile finished: the agent switches to provider=<p>, authType=<a> at its next start — not restarted now because the app is not in the foreground` (INFO).
- New: `[Service] restart: the agent was stopped but could not be started again (<ExceptionName>) — start it from the dashboard` (ERROR). Also listed under Service Lifecycle as "needs action", because it can follow any app restart (Settings "Restart Now", xAI sign-in, reconcile).
- New: `Reconcile: retry record not readable (<reason>) — …` and `Reconcile: runtime_state.json not confirmed on disk (<reason>) — …` (WARN, once per process).
- Changed: the `restarting the agent` bullet now states the liveness + foreground conditions and "at most once per change, ever". The old "once per app process / again after `retry record not cleared`" text is gone.
- Changed: `the agent is not running` is now its own bullet and covers a liveness doubt (stale RUNNING after a reboot or crash). `agent was not restarted (<reason>)` is scoped to a throwing restart request. `finished after a restart` and `not confirmed on disk` point at the restart lines instead of promising a restart.
- Changed: `BOOT_HELD` names the two new WARNs instead of "no line of its own", and the restart is conditional. Fix step 5 says the same.
- Changed: `XAI_SYNC_HELD` no longer says it is followed by `sync failed: runtime_state.json not written` or the storage message. It names the new `xAI sign-in saved, agent not restarted: a model selection change is not finished yet — …` WARN.

Quote updates in "Settings Says Couldn't save":
- New bullet for `sync held` with the new sign-in WARN and the two new Settings messages (sign-in and sign-out). "In all four cases" is now six (busy, storage or held, after a sign-in or a sign-out).
- The silent flip-back sentence lists the two new hold WARNs. The Fix adds: after `sync held`, force stop the app (or restart the phone) and reopen it first; if the warning persists, force stop again, reopen, and start the agent if needed.

Verification: every new or changed quote was checked with `grep -F` on its fixed parts against `app/src/main/java`. All match: `ReconcileRecord.kt` (agentRestarting, agentNotRunning, agentRestartFailed, agentRestartDeferred, recordUnavailable, runtimeConfirmFailed, XAI_SYNC_HELD), `SeekerClawService.kt` (startFromRestart), `XaiOAuthActivity.kt` (HELD WARN), `XaiOAuth.kt` (XAI_RESTART_NEEDED_HELD, XAI_SIGN_OUT_HELD).
- `node tests/nodejs-project/smoke.js`: PASS (92/92 files parse, 39/39 modules load; the `quiesce.js` / `rich-markdown.js` notice was there before).
- CI Node suite list (`ci_node.py`): 82 suites, 0 failures.

The v55 full audit is still owed (see Remaining Gaps).

## Addendum 2: fold 5′ — restart notice replaces the automatic restart (BAT-1661, Codex 90fed4d6, same PR)

The contract reviewer replaced Q16's automatic agent restart with a user-initiated notice. Recovered/Completed now save a durable "restart to apply" notice (`filesDir/model_restart_notice.json`) inside the model-selection transaction, before the retry record is cleared; the dashboard shows it while the agent is running (health fresh) and the user restarts with the existing Restart action. A start that reaches RUNNING on the notice's selection clears it (`:node`); a newer Settings selection or a completed Reset invalidates it. `DIAGNOSTICS.md` only; no `ai.js` change (Section A not touched).

Log sites, Section B (all on the Logs screen via `LogCollector.append`):

| Site | Level | Change | Covered | Accurate |
|---|---|---|---|---|
| `agentRestarting`, `agentNotRunning`, `agentRestartDeferred`, `agentStoppedMeanwhile` | INFO | Removed (rows 8, 9 above and the Addendum 1 lines are superseded) | — | Entries removed from DIAGNOSTICS |
| `agentRestartFailed` | WARN | Removed (row 10 superseded) | — | Entry removed |
| `RestartNotice.noticeSaved` — `Reconcile finished: the new selection is saved (…) — restart the agent to apply it` | INFO | New | ✅ | ✅ says saved + restart needed, never "switched" |
| `noticeWriteFailed` — `Reconcile: restart notice not saved (<reason>) — checked again on the next load` | WARN, once/process | New | ✅ | ✅ record and runtime kept |
| `noticeCleared` — `restart notice cleared: the agent started with …` | INFO, `:node` | New | ✅ | ✅ only a RUNNING start on that selection |
| `noticeClearFailed` — `restart notice not cleared at start (<reason>) — checked again at the next start` | WARN, `:node` | New; also `(busy)` after three lock tries (review round) | ✅ | ✅ the notice still matches the running selection, so the next start on it retries |
| `noticeInvalidateFailed` — `restart notice not cleared (<reason>) — hidden now, removed the next time the app loads` | WARN | New; text corrected in the review round (the old "cleared at the agent's next start" could not happen: the next start consumes the newer selection) | ✅ | ✅ `visible` hides a notice no store holds; the next unheld load's `invalidateIfOrphaned` removes it |
| `RECOVERED` (`Reconcile finished after a restart …`) | INFO | Meaning narrowed | ✅ | ✅ now says it is about the files, not the running agent, and that the app never stops/starts the agent |
| `BOOT_HELD`, `startFromRestart` (ERROR), "not a crash" bullet | — | Reworded to point at the notice | ✅ | ✅ |

Probe (Section D, re-traced): "I switched provider from chat but the agent still answers on the old one" → system prompt door → DIAGNOSTICS "/model or /provider Switch Didn't Take Effect" → `Reconcile finished: the new selection is saved …` bullet → dashboard notice + Restart. Actionable ✅.

Verification: each new quote was checked with `grep -F` on its fixed prefix and suffix against `app/src/main/java` (one source hit each) and against DIAGNOSTICS; the UI title `Restart the agent to apply the change` matches `DashboardScreen.kt`. No DIAGNOSTICS text still refers to the removed restart lines (grep for `restarting the agent`, `not in the foreground`, `the agent is not running`, `switches to provider=`, `restartRequested`: only unrelated hits — OpenAI token persistence, MCP reconnect, xAI sign-out). Gaps found: 0 (drift 0, correction 0) — the DIAGNOSTICS update shipped with the code change.

The v55 full audit is still owed before the RC of the release that ships PR #465.
