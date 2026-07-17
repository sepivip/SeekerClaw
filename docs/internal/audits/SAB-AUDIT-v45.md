# SAB-AUDIT-v45 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-07-17
> **SAB Version:** v3
> **Scope:** Delta-audit for BAT-1161 P1A (logging substrate). Touches `buildSystemBlocks()` in `ai.js` (the node_debug.log format/rotation claims), adds new WARN log sites in `SeekerClawService.kt` (rotation gap ×2, out-of-range epoch, `.old` drain error) plus new INFO markers in `config.js` (`=== SESSION …`, `=== ROTATED …`), and rewrites log claims in `CLAUDE.md` + the Logs-screen UI — so the pre-merge gate applies.
> **Method:** Full read of the log surface in `buildSystemBlocks()` + diagnostic coverage map for every new log site + a behavioral probe on the "logs stopped updating" path + a format-sensitivity sweep of existing DIAGNOSTICS greps.
> **Baseline:** SAB-AUDIT-v44.md (BAT-1172 delta; full-suite baseline v41 = 252/252 = 100% post-fix).

## Scores

| Section | Pre-fix | Post-fix | Max |
|---------|---------|----------|-----|
| A: Knowledge & Doors (3 log items) | 1 | 9 | 9 |
| B: Diagnostics (2 log-substrate failure modes) | 0 | 6 | 6 |
| C: Tool Consistency (no tools changed) | N/A | N/A | — |
| D: Behavioral Probes ("logs stopped updating") | 0 | 3 | 3 |
| **Combined (delta)** | **1 (5.6%)** | **18 (100%)** | **18** |

> **The very low delta pre-fix is what BAT-1161 P1A exists to fix, not new drift.** The agent's logging self-knowledge was materially FALSE (it claimed "timestamped entries" when the format carried no timestamp, and described 5 MB rotation as automatic when it only ran once at module load) and the log substrate had **zero** diagnostic coverage. P1A corrects the code and the self-knowledge in lockstep → post-fix 100%. No tools changed; negative-knowledge boundaries unchanged (6/6).

## Pre-fix Trend

| Audit | Pre-fix % | Post-fix % |
|-------|-----------|------------|
| v41 | 98.4% | 100% |
| v42 (delta) | 83.3% (delta only) | 100% |
| v43 (delta) | 95.2% (delta only) | 100% |
| v44 (delta) | 33.3% (delta only — corrected a fabrication) | 100% |
| v45 (delta) | 5.6% (delta only — corrected false + absent log self-knowledge) | 100% |

## Section A — Knowledge & Doors (delta) — 1/9 pre, 9/9 post

| Item | Pre | Post | Evidence |
|------|-----|------|----------|
| node_debug.log **line format** | ❌ | ✅ | Pre (pre-fix `ai.js:1117`): "It records **timestamped** entries for: startup, API calls, …" — **false**; the format was `LEVEL\|message` with no time component, so an agent reading its own log found no timestamps. Post (`ai.js:1055`): the claim is now TRUE and the format is stated explicitly — "New lines are `LEVEL\|epochMs\|message` … lines written before this version was installed may still use the older `LEVEL\|message` shape". (The legacy qualifier was added in review: `node_debug.log` survives `install -r`, so a retained file holds pre-upgrade lines until the first rotation ages them out — an unqualified "every line" would have been a new false claim.) |
| **Continuous** rotation + `.old` | ⚠️ | ✅ | Pre (pre-fix `ai.js:1039`, `:1124`): "Auto-rotated at 5MB" / "The log is auto-rotated at 5 MB (old entries archived to node_debug.log.old)" — misleading: rotation ran **only once at module load**, so a long-running session grew past 5 MB unbounded until the next restart. Post (`ai.js:1055`, `:1140`): "Continuously rotated at ~5 MB — the whole current file becomes node_debug.log.old and a fresh one starts (no carryover)". |
| **SESSION banner** (session boundary) | ❌ | ✅ | Pre: did not exist — nothing delimited one `:node` session's lines from another's. Post: `=== SESSION boot=… build=… ver=… logfmt=1 pid=… ===` emitted after config parse, described in `ai.js:1140` and DIAGNOSTICS. |

Also corrected (not separately scored): `CLAUDE.md` claimed a fictional `files/logs/openclaw.log` sink with a **1000-line** ring and **10 MB / 7-day retention** — none of which existed; now describes the real `node_debug.log` (~5 MB continuous rotation + `.old`) and the `service_logs` mirror (300-line ring + 1 MB→512 KB compaction), and that the mirror is **not** an authoritative replica.

## Section B — Diagnostics (delta) — 0/6 pre, 6/6 post

| Failure mode | New log site(s) | Pre | Post | DIAGNOSTICS |
|--------------|-----------------|-----|------|-------------|
| Forwarding/rotation gaps (mirror missing lines) | `SeekerClawService` — `rotation gap — a log generation was evicted…`, `rotation gap — previous generation unavailable`, `node_debug.log.old drain error: <Class>`, `node_debug.log forward error: <Class>` | ❌ | ✅ | **GAP → FILLED**: new "**Agent Logs (node_debug.log ⇄ Logs screen)**" section — each WARN's meaning, per-WARN recoverability, where to actually look, and that a restart's apparent gap is the startup watermark by design. Corrected in review: recoverability is **not** uniform ("the lines still exist on disk" was false for an **evicted** generation — with one archive slot the second rotation overwrites it, so it is gone from `node_debug.log` and `.old` too), and these WARNs are **Kotlin**-emitted, so they land in `service_logs` / the Logs screen and grepping `node_debug.log` for them finds nothing. |
| Event-time vs receipt-time / corrupt epoch | `SeekerClawService` — `out-of-range epoch token in a forwarded line (using receipt time)` | ❌ | ✅ | **GAP → FILLED**: "Timestamps look wrong in the Logs screen" — event-time for new-format lines, receipt-time for legacy/raw, and that the WARN fires **only** on epoch-shaped-but-out-of-range tokens (real corruption / version skew), not ordinary legacy lines. |

Pre-fix, DIAGNOSTICS had **zero** entries for log forwarding, rotation, or the mirror — the only mention of `node_debug.log.old` was a storage-space note (`:321`). Every new WARN would have been undiagnosable. The new section also documents the **two surfaces** (authoritative `node_debug.log` vs the bounded `service_logs` mirror) and that "Clear console" clears only the mirror.

**Format-sensitivity sweep (no drift introduced):** the wire format gained a field (`LEVEL|epochMs|message`). Every existing DIAGNOSTICS playbook greps by **content** (e.g. `grep -i "xai\|grok" node_debug.log`) or by level prefix — none hardcodes the `LEVEL|message` shape — so no existing playbook breaks. Verified by sweeping for `grep "<LEVEL>|` patterns: zero matches.

## Section C — Tool Consistency (spot-check) — N/A

BAT-1161 P1A adds/changes **no tools** (`tools/*.js` untouched). Fixed-7 + rotated-5 consistency unchanged from the v41 full-suite / v44 baseline. Not re-scored.

## Section D — Behavioral Probes (delta) — 0/3 pre, 3/3 post

1. **"My logs stopped updating" / "the Logs screen is missing entries."** **Pre: ❌** — the prompt mentioned `node_debug.log` and a misleading "auto-rotated at 5MB", and DIAGNOSTICS had no forwarding/rotation/mirror section at all; the agent had nothing actionable and no way to know the mirror is bounded. **Post: ✅** — the prompt states the format + continuous rotation + the SESSION banner, and DIAGNOSTICS gives the grep, each WARN class's meaning, the "read `node_debug.log` directly — the mirror is best-effort" rule, and that a restart-boundary gap is the watermark by design.

Fixed probes ("Web search is broken", "Agent won't respond") unaffected by this PR — unchanged from baseline.

## Gaps Found (Pre-fix)
1. `ai.js:1117` — "timestamped entries" was **false** (no timestamps existed).
2. `ai.js:1039`/`:1124` — "auto-rotated at 5 MB" described **boot-only** rotation as automatic/continuous.
3. `CLAUDE.md:275/285/434` — fictional `files/logs/openclaw.log`, 1000-line ring, 10 MB + 7-day retention.
4. **DIAGNOSTICS had zero log-substrate coverage** — the new forwarder WARNs would be undiagnosable.
5. Logs screen: "Clear" + "This will delete all log entries" overstated (it only clears the mirror).
6. `DeviceInfoProvider` under-reported log storage (didn't count `node_debug.log.old`).

## Fixes Applied (all in THIS PR — same-PR rule)
- `buildSystemBlocks()` log claims rewritten (real format, continuous rotation, no-carryover, SESSION banner).
- `CLAUDE.md` log architecture corrected to the shipped reality.
- **DIAGNOSTICS: new "Agent Logs (node_debug.log ⇄ Logs screen)" section** covering format, session boundary, rotation, the two surfaces, all four forwarder WARN classes, and the event-time/receipt-time fallback.
- Logs screen → "Clear console" + an honest dialog; `DeviceInfoProvider` counts `.old`.

## Code Issues Found
None beyond what P1A fixes.

## Remaining Gaps
**One coupling to watch (gate 8) — RESOLVED 2026-07-17.** The "~5 MB" figure stated in the prompt (`ai.js:1039`, `:1124`), `CLAUDE.md`, and DIAGNOSTICS is tied to `LOG_MAX_BYTES`. Gate 8 ran on device `d9fc86bb` and **did not change the constant** (5 MiB validated against 46 days of real history: 1,350 B/agent-turn, a measured 3,566 B/h idle floor, max physical line 437 B, the 64 KiB per-record cap hit 0 times in 37,280 lines) — so every one of those surfaces stays as written and no lockstep move is required.

Gate 8 did, however, add one constant those surfaces do **not** mention and do not need to: `LOG_MAX_CALL_BYTES` (128 KiB), a per-`log()`-call output ceiling. It exists because the per-record cap alone did not bound a *call* — a multiline message frames one record per physical line and appends the whole batch before the next size check, so the permitted overshoot was one call's total output, not one record (the code comment asserting otherwise was false and is fixed). The user- and agent-facing "~5 MB" story is unchanged; only the internal worst-case bound moved, from a conditional 10.125 MiB to a structurally-enforced **10.25 MiB** = `2 × (LOG_MAX_BYTES + LOG_MAX_CALL_BYTES)`. Section A does not regress.

**Bound wording lock (Codex, comment c48bf5ef):** the 10.25 MiB figure is a **steady-state bound for generations this build writes and rotates**, not a claim about historical files. Explicit upgrade exception — a log inherited from a pre-BAT-1161 build was trimmed only at module load, so it can be arbitrarily large; the first post-upgrade rotation renames that whole file to `.old`, so `current + .old` may exceed the bound **once**. P1A deliberately preserves the user's existing diagnostic log rather than truncate or drop it (a worse product tradeoff for finite, self-healing legacy state); the next rotation retires the oversized `.old` and the bound holds thereafter. `DeviceInfoProvider` reports the **actual** current + `.old` byte sizes on disk — it does not imply the bound has already normalized an inherited file.

**Redaction guarantee lock (Codex, comment c48bf5ef):** P1A redaction covers **new Kotlin writes, forwarded Node records, the in-memory display ring, the persisted-log restore path, and Share/export**. Explicit non-guarantee — P1A does **not** retroactively scrub raw bytes already present in a `service_logs` file written by a pre-BAT-1161 build (Kotlin had no redaction then). Closing the read/share/restore paths is the P1A scope; historical at-rest lifecycle (scrub/delete/redact of already-written bytes) is tracked under P2's relocation/access model, not bolted into this substrate PR.

## Validation
- `node tests/nodejs-project/smoke.js` — PASS
- `node tests/nodejs-project/logging-substrate.test.js` — PASS
- `bash scripts/pre-push-check.sh` — Node smoke + tool schemas + wallet regression + Kotlin compile — PASS
- Kotlin unit tests: `NodeLogParserTest` (parser matrix) + `NodeLogRotationDecisionTest` (gate-3 decision matrix) + `LogRedactorTest` — PASS
