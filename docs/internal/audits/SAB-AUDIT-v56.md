# SAB-AUDIT-v56 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-11-27
> **SAB Version:** v4
> **Mode:** Delta
> **Scope:** BAT-1734. `memory_save`, `daily_note`, `write` and `edit` now replace a file all-or-nothing through the new `atomic-write.js` (`writeFileAtomicSync`: a temp file opened `'wx'` under a random name, fsync, rename). The session-summary file written in `ai.js` uses it too (a code path only, no prompt text). Agent-visible text: the "memory_save Fails (Filesystem Full)" section of DIAGNOSTICS.md. `buildSystemBlocks()` is not touched. No tool description changed.
> **Diff range:** `d15f1779` (main after PR #473)..working tree.
> **Method:**
> - Read every hunk of the diff and all of `atomic-write.js`.
> - Grepped the diff for added `'ERROR'` / `'WARN'` / `LogLevel.(ERROR|WARN)` lines: none. `writeFileAtomicSync` does not log; a failure reaches the tool loop, which logs `[ToolError]` and returns `Tool execution failed: <message>` (`ai.js` tool loop, unchanged).
> - Checked the quoted error string (`Tool execution failed: ENOSPC: no space left on device…`) and the `[ToolError]` prefix against `ai.js`.
> - Checked the tool descriptions of `memory_save`, `daily_note`, `write` and `edit`. None states how the write is done ("Add a note to today's daily memory file", "Overwrites if file exists" stay true), so none changed and none is force-included in Section C.
> - Traced 1 probe from door to target. No AI was invoked.
> **Baseline:** SAB-AUDIT-v55.md (Full, 2026-11-23, merged in PR #473). It is the highest number on any branch or open PR.
> **Gate status:** On time. This audit runs before the BAT-1734 PR merges, and its fix is in the same PR.
> **Next full audit due:** before the RC after next (the release rule), or after 5 consecutive deltas. This is the first delta since the v55 full audit.

## Scores

Delta: every percentage below is against the **audited surface only**.

| Section | Pre-fix | Post-fix | Max |
|---------|---------|----------|-----|
| A: Knowledge & Doors | N/A (not touched) | N/A | — |
| B: Diagnostics — curated (1 row touched) | 1 | 3 | 3 |
| B: Diagnostics — discovered (no new log sites) | N/A | N/A | — |
| C: Tool consistency (no description changed) | N/A (not touched) | N/A | — |
| D: Behavioral probes (1 probe) | 1 | 3 | 3 |
| **Audited surface** | **2 / 6 (33%)** | **6 / 6 (100%)** | 6 |

## Section B — Curated row touched

| Subsystem | Failure mode | Pre-fix | Post-fix | Class |
|-----------|--------------|---------|----------|-------|
| Memory | memory_save fails (fs full) | ⚠️ 1 | ✅ 3 | **Drift** |

**Gap 1 (drift).** The section, as v55 left it, says the write "may be damaged", that `memory_save` "rewrites MEMORY.md in place, so it can be left cut short", that `daily_note` "can leave a partial entry", and to "read the file and repair it before retrying". That was true of the old code. With this change it is false: a failed save leaves the file byte for byte as it was. An agent following it would tell the user their memory may be damaged when it is not, and send them to repair a file that needs nothing.

**Fix (applied):** the Symptoms paragraph now says the four tools write a temporary copy and swap it in only when complete, so the file is unchanged; free storage, then retry. It also explains a leftover `<name>.<id>.tmp` from a crash (never read as memory, safe to delete). The Check / Diagnosis / Fix steps (`df -h`, `android_storage`, clean `media/inbound/`) are unchanged and still accurate.

## Section D — Behavioral probe

| # | Scenario | Door | Target | Pre-fix | Post-fix |
|---|----------|------|--------|---------|----------|
| 1 | "My agent said memory_save failed with no space left. Did I lose my memory?" | `ai.js:1204` "For detailed troubleshooting … read DIAGNOSTICS.md" | "memory_save Fails (Filesystem Full)" | ⚠️ 1 — wrong answer: "it may be damaged, repair it" | ✅ 3 — "nothing was lost; free space and retry" |

## Fixes Applied

1. `DIAGNOSTICS.md` — "memory_save Fails (Filesystem Full)" Symptoms paragraph (Gap 1).

## Code issues

None new. BAT-1735 (a burner cap commit failure goes uncounted) is unchanged and still open.
