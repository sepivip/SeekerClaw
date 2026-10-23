# SAB-AUDIT-v48 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-10-19
> **SAB Version:** v4
> **Mode:** Full
> **Scope:** Release audit for hotfix v2.3.2 (BAT-1409, agent sandbox hardening), audited against the whole cumulative prompt, DIAGNOSTICS and tool set. Since the last full audit (v40) the app has shipped v2.1.x–v2.3.1, which were covered only by deltas v41–v47. v2.3.2 changes:
>   - SMS and calls become notification drafts;
>   - screen-opening bridge actions return `needs_foreground`;
>   - the file tools, `js_eval` and `shell_exec` are confined to the workspace (`shell_exec` without a shell);
>   - agent code can no longer reach the app's internal ports;
>   - burner cap raises are Settings-only;
>   - an owner claim succeeds only while no owner is set;
>   - Kotlin storage hardening and bundle verification run before every start.
> **Diff range:** a9cb0736..e1442083 (16 commits on `feature/BAT-1409-agent-sandbox-hardening`).
> **Method:** Five parallel read-only section auditors read the real code (no AI invoked; probes traced door → target):
>   - A;
>   - B curated + JS discovery;
>   - B Kotlin discovery;
>   - C;
>   - D.
>
>   Every gap they reported was checked against the code before it was fixed. Each shell recipe the agent reads was checked by `tests/nodejs-project/shell-recipes.test.js` against the new `shell_exec` grammar.
> **Baseline:** SAB-AUDIT-v47.md (Delta). Last full audit: SAB-AUDIT-v40.md (2026-06-29).
> **Gate status:** On time. Run before the BAT-1409 PR is opened; every fix is in the same branch.
> **Next full audit due:** before the next release that ships code (SAB v4 rule), or after 5 consecutive deltas, whichever comes first.

## Scores

This is the first full audit under SAB v4. Discovery now also covers WARN-level lines and the Kotlin lines that reach the Logs screen, so the two "discovered" rows are much larger than in v40 and are not comparable with it.

| Section | Pre-fix | Post-fix | Max |
|---------|---------|----------|-----|
| A: Knowledge & Doors (30 items) | 78 | 90 | 90 |
| B: Diagnostics — curated (40 rows) | 114 | 120 | 120 |
| B: Diagnostics — release-specific (8 rows) | 12 | 24 | 24 |
| B: Diagnostics — discovered, JS (53 categories) | 93 | 111 | 159 |
| B: Diagnostics — discovered, Kotlin (23 categories) | 30 | 51 | 69 |
| C: Tool Consistency (fixed 8 + rotated 5) | 17 | 39 | 39 |
| D: Behavioral Probes (fixed 2 + rotated 3 + release 2) | 15 | 21 | 21 |
| **Combined (full set)** | **359 (68.8%)** | **456 (87.4%)** | **522** |
| Combined on the v40-comparable surface (A + B curated/release + C + D) | 236 (80.3%) | 294 (100%) | 294 |

Pre-fix is below the 95% threshold for a full audit, so this is recorded as a **drift incident**. Two things drive it:
1. **Drift from this release.** The refusal surfaces (file tools, `js_eval`, `shell_exec`, internal ports, owner claim) and the new Kotlin start-up lines shipped with code but without DIAGNOSTICS rooms.
2. **Older errors the v41–v47 deltas never re-read.** For example: the bridge-down advice described the wrong process; the over-cap routing was wrong in five places; the Jupiter key and steps-per-turn Settings paths were stale.

Post-fix is 100% on the v40-comparable surface. The 66 points still missing are all pre-existing log categories first surfaced by v4's broader discovery. They are deferred to BAT-1586 (see Remaining Gaps).

## Pre-fix Trend
| Audit | Mode | Pre-fix % | Post-fix % | Drift or correction |
|-------|------|-----------|------------|---------------------|
| v40 (v2.1.0) | Full (v3) | 97.6 | 100 | — |
| v41–v47 | Delta (v3) | surface only | 100 (surface) | — |
| **v48 (v2.3.2)** | **Full (v4)** | **68.8** (80.3 on the v40 surface) | **87.4** (100 on the v40 surface) | both — see Gaps |

## Section A — Knowledge & Doors: 78 → 90

The item set starts from v40's 30 items plus v41's "interim delivery". It is reconciled to 30 by folding interim delivery into R5, agent_pay into C7, and Discord connection issues into D2. **Listed here so the next audit starts from it:**

| # | Item | Pre | Post |
|---|---|---|---|
| I1 | Own name / version | ✅ | ✅ |
| I2 | Model | ✅ | ✅ |
| I3 | Device / hardware | ✅ | ✅ |
| I4 | Who built it | ✅ | ✅ |
| I5 | Official channels | ✅ | ✅ |
| R1 | Node ↔ Kotlin bridge (incl. `needs_foreground`, ports refused to agent code) | ⚠️ | ✅ |
| R2 | UI vs `:node` process | ✅ | ✅ (corrected: the bridge runs in `:node`) |
| R3 | Health monitoring | ⚠️ | ✅ |
| R4 | Channel connection (Telegram polling / Discord gateway) | ✅ | ✅ |
| R5 | Channel abstraction & message delivery (incl. interim narration) | ✅ | ✅ |
| C1 | Full tool list (64) | ✅ | ✅ |
| C2 | Sandboxed tools (`shell_exec`, `js_eval`) | ✅ | ✅ |
| C3 | What it cannot do (negative knowledge 6/6) | ✅ | ✅ |
| C4 | Skills load / trigger | ✅ | ✅ |
| C5 | Search providers | ✅ | ✅ |
| C6 | AI providers (multi + custom) | ✅ | ✅ |
| C7 | Wallets & payments (burner/main, caps, agent_pay, raises in Settings only) | ✅ | ✅ |
| C8 | Confirmation gates & rate limits (incl. message & call drafts) | ⚠️ | ✅ |
| C9 | Telegram rich messages | ✅ | ✅ |
| G1 | Config files | ✅ | ✅ |
| G2 | Settings the agent can change | ✅ | ✅ |
| G3 | API keys needed | ⚠️ | ✅ |
| G4 | Model / heartbeat change | ✅ | ✅ |
| D1 | Health stale | ✅ | ✅ |
| D2 | Channel disconnects (Telegram + Discord) | ⚠️ | ✅ |
| D3 | Skill fails | ✅ | ✅ |
| D4 | Conversation corruption / history trim | ✅ | ✅ |
| D5 | Loop detection | ⚠️ | ✅ |
| D6 | Search provider errors | ✅ | ✅ |
| D7 | Auth / billing (401/403, Pro/Max "out of extra usage") | ✅ | ✅ |

**Negative knowledge: 6/6.** No browsing, no media generation, no cloud/infra access, no cross-device reach, no persistent background tasks, no real-time data without tools (ai.js:1084-1090).

**Constants:**

| Constant | Code | Prompt | |
|---|---|---|---|
| `MAX_HISTORY` | 35 | "~35" | ✅ |
| `SHELL_ALLOWLIST` / `ALLOWED_CMDS` | 34 commands | the playbook lists the same 34 | ✅ |
| `SECRETS_BLOCKED` | root secrets + anywhere-secrets | matches | ✅ |
| `maxStepsPerTurn` | default 35, range 10–100, counts rounds | was "35 tool calls", Settings → Agent | ⚠️ → ✅ |
| js_eval limits | 10,000 chars, 30 s | matches | ✅ |
| `shell_exec` timeout | 30 s | matches | ✅ |
| Confirmation timeout | 60 s | matches | ✅ |
| `TOOL_RATE_LIMITS` | confirm path only, plus drafts | was over-broad | ⚠️ → ✅ |
| Health file read | file watcher + 30 s check | was "polls every 1 second" | ⚠️ → ✅ |

**New-door test for the BAT-1409 changes.** All changes are covered without a 31st item:
- **Drafts:** C8.
- **`needs_foreground` and the ports refusal:** R1.
- **`js_eval` and `shell_exec` rules:** C2.
- **Cap raises:** C7.
- **Owner claim:** no door needed, because the agent never claims an owner. Covered by a DIAGNOSTICS room instead.

## Section B — Diagnostics

**Curated: 114 → 120.** Three ⚠️ rows were fixed:
- **Tool Result Truncation:** the doc said truncation was "silent" with a `...(truncated)` suffix. It now names the real markers.
- **Cron, both rows:** the doc described per-job files, and its fix step "delete the old job file" would wipe every job. It now says jobs live in one `cron/jobs.json` with a `.bak`, and points to `cron_list` / `cron_status` / `cron_cancel`. The restart check now greps lines that exist.

**Release-specific: 12 → 24.**

| Row | Pre | Post | Where |
|---|---|---|---|
| Message & call draft outcomes (incl. `unattended`, `rate_limited`) | ✅ | ✅ | "Message & call drafts", now also with a log check |
| `needs_foreground` | ✅ | ✅ | "`needs_foreground`" |
| `cap_raise_settings_only` | ✅ | ✅ | Burner Wallet, confirmation table |
| File-tool refusals | ⚠️ | ✅ | new "Sandbox refusals" room |
| `js_eval` refusals | ⚠️ | ✅ | new "Sandbox refusals" room |
| `shell_exec` refusals | ⚠️ | ✅ | new "Sandbox refusals" room |
| Internal-port refusal | ❌ | ✅ | "Sandbox refusals"; bridge door in the prompt |
| Owner claim refused | ❌ | ✅ | new room under Channel Connection |

**Discovered, JS: 93 → 111** (53 categories). Fixed:
- cron store;
- owner gating;
- the sandbox log prefixes (`[Security] BLOCKED …`, `shell_exec refused`, `js_eval refused`, `socket refused`);
- `Camera move to workspace failed`.

The 21 categories still without guidance predate this release and go to BAT-1586.

**Discovered, Kotlin: 30 → 51** (23 categories, 148 log sites). All seven categories new in this release now have a room:
- bundle verify/repair;
- `Start failed before Node: <reason>`;
- link hygiene;
- the silent `Failed(LINK_HYGIENE)` at `:node` step 1;
- owner claim;
- refused writes;
- the stop-token fence.

The rooms are "Agent won't start" (Service Lifecycle) and "Red `[Bundle]` / `[LinkHygiene]` lines" (Agent Logs). Also fixed: Node runtime start failures, `[Service] Failed to start AndroidBridge` and the Watchdog lines. The 9 categories still without guidance predate this release and go to BAT-1586.

**Commands for a computer inside agent-facing text.** Five `adb … | grep` / `cd … && node` lines are now labelled as developer commands for a computer. One sat inside a Check block the agent would copy. The dead `grep OpenAIOAuth node_debug.log` recipe is replaced.

## Section C — Tool Consistency: 17 → 39

| Tool | Pre | Post | Gap fixed |
|---|---|---|---|
| shell_exec | ✅ | ✅ | `command` field no longer says "Shell command" |
| js_eval | ✅ | ✅ | internal-port refusal now described |
| solana_swap | ❌ | ✅ | G1 (below) |
| solana_send_token | ❌ | ✅ | G1 |
| agent_pay | ⚠️ | ✅ | over-cap reason said "Lower max_usdc", which never helps: the cap is checked against the endpoint's price |
| wallet_set_caps | ⚠️ | ✅ | "Each call REQUIRES confirmation", although a raise is refused before any prompt |
| android_sms | ⚠️ | ✅ | the Node-side 60 s refusal had no `message`; it now has one (tested) |
| android_call | ⚠️ | ✅ | same |
| read (rotated) | ✅ | ✅ | — |
| send_file (rotated) | ⚠️ | ✅ | "any workspace file", but app secret files are refused |
| memory_get (rotated) | ⚠️ | ✅ | the prompt said "memory_read on specific files", but memory_read takes no arguments |
| android_camera_capture (rotated) | ⚠️ | ✅ | description now says it needs SeekerClaw in front (`needs_foreground`) |
| android_apps_launch (rotated) | ⚠️ | ✅ | same |

The SAB v4 fixed-8 row for android_sms / android_call ("prompt mentions confirmation required") is obsolete under BAT-1409 P1-H. Both tools were scored against the new contract: drafts, no chat confirmation, notifications needed. BAT-1586 updates the skill.

**G1, over-cap routing (correction; predates this release).** Five sources said an over-cap burner action falls back to the main-wallet popup. In code, the gate **blocks** it with `burner_cap_exceeded`. The block message then told every tool to "retry with `_allowMainFallback: true`":
- for swaps, DCA and V1 limit orders, that leads to a YES and then a refusal in `wallet/dispatch.js`;
- for `solana_send` it works only together with `source="main"`.

Fixed:
- the descriptions, prompt and DIAGNOSTICS now say "over cap → refused";
- the block message names the retry that works for each tool, including `_allowMainFallback` for V2 limit orders: the gate now gets the active trigger path from ai.js. confirmation-policy-burner.test.js pins this, and negative controls fail on the old hint and without the V2 branch;
- the defensive dispatch message no longer suggests the flag.

The routing behaviour itself is unchanged and filed as **BAT-1585**.

Other sources made inaccurate by this release and fixed: `env_list` said values reach `shell_exec` (it no longer expands `$VARS`); `telegram_send_file` said "any workspace file". About 20 tool error strings pointed to "Settings > Configuration > Jupiter API Key"; the field is under Settings > Solana Wallet.

## Section D — Behavioral Probes: 15 → 21

Every check command below passes the new `shell_exec` grammar.

| # | Probe | Pre | Post | Door → target |
|---|---|---|---|---|
| 1 | Web search is broken (fixed) | ✅ | ✅ | ai.js search lines → "Web Search" |
| 2 | Agent won't respond (fixed) | ✅ | ✅ | playbook → Channel / Telegram / Discord (the Discord recipe now matches Discord log lines) |
| 3 | Bridge is down (rotated) | ⚠️ | ✅ | playbook step 3 → "Android Bridge" |
| 4 | Payment failed / cap exceeded (rotated) | ✅ | ✅ | Wallets → Burner Wallet / agent_pay |
| 5 | My skill won't trigger (rotated) | ⚠️ | ✅ | new playbook step 5 → Skills → "A skill runs but a step is refused" |
| 6 | "Text my mom — nothing was sent" (release) | ✅ | ✅ | "Messages and calls" → "Message & call drafts" |
| 7 | "Why was my shell / js_eval command refused?" (release) | ⚠️ | ✅ | playbook steps 1–2 → "Sandbox refusals" |

Probe 3 detail. The old room said the bridge lives in the main process and that reopening the app restarts it. In fact it runs inside `:node` and starts only with the agent, so the fix is Stop Agent, then Deploy Agent. The room now also separates `needs_foreground` (bridge up) from bridge down.

## Provider-aware check
Five adapters (`providers/claude.js`, `openai.js`, `openrouter.js`, `xai.js`, `custom.js`) match the SAB table's columns. This release touched no provider or channel code, and no provider-specific gap was found.

## Gaps Found (pre-fix), drift (D) or correction (C)
1. **D.** No DIAGNOSTICS room for file-tool, `js_eval`, `shell_exec` or internal-port refusals, or for skills written for the old shell rules.
2. **D.** No room for a refused owner claim.
3. **D.** None of the 49 new Kotlin start-path log lines documented (bundle, link hygiene, start failure, stop fence, refused writes).
4. **D.** Prompt bridge door didn't say agent code can't reach 8765/8766.
5. **D.** Draft refusal from the Node rate limit had no `message`.
6. **D.** send_file / telegram_send_file / env_list descriptions out of date with the new refusals.
7. **D.** Camera and app-launch descriptions didn't mention `needs_foreground`.
8. **D.** wallet_set_caps said every call is confirmed (a raise is now refused first).
9. **C.** Bridge-down room described the wrong process and a fix that cannot work; the prompt's architecture line said the bridge connects the two processes.
10. **C.** Over-cap routing wrong in descriptions, prompt and DIAGNOSTICS; the block hint led to a YES that is then refused (G1, BAT-1585).
11. **C.** agent_pay over-cap advice "lower max_usdc".
12. **C.** Health file "polled every 1 second"; Watchdog "missed health checks".
13. **C.** Rate-limit line over-broad.
14. **C.** Jupiter key Settings path (prompt + about 20 error strings + DIAGNOSTICS).
15. **C.** Steps-per-turn called "tool calls", with a Settings path that doesn't exist.
16. **C.** Discord check grepped "poll" (no Discord line contains it); DNS check missed `DNS resolution failing`.
17. **C.** Cron rooms described per-job files and a destructive fix.
18. **C.** Tool Result Truncation described a marker that doesn't exist.
19. **C.** Transport-timeout room: wrong field name (`elapsed`) and a timeout setting that isn't in agent_settings.json.
20. **C.** Computer-only `adb` / `cd && node` commands inside agent Check blocks.
21. **C.** memory_read named as reading specific files.

## Fixes Applied
All of the above, in the same branch:
- **ai.js:** the system prompt plus the over-cap comment.
- **DIAGNOSTICS.md:** new rooms for Sandbox refusals, Owner claim refused, "A skill runs but a step is refused", "Agent won't start", and "Red `[Bundle]` / `[LinkHygiene]` lines"; rewritten Android Bridge, Cron and Tool Result Truncation; plus the line fixes listed above.
- **Tool descriptions:** solana, wallet, agent_pay, file, telegram, env, system, android.
- **Agent-facing error text:**
  - confirmation/policy.js `_overCapRetryHint`;
  - wallet/dispatch.js defensive message;
  - the agent_pay over-cap reason;
  - the Jupiter key path in the solana tools and Trigger V2;
  - the draft refusal `message` in tool-rate-limit.js.
- **Tests:** confirmation-policy-burner.test.js (over-cap hint per tool and per trigger path, with negative controls); draft-outcomes.test.js (the refusal message); shell-recipes.js now matches the reworded `shell_exec` field.

Validation:
- `shell-recipes.test.js`: all 77 recipes pass the validator.
- All 73 Node tests in the CI list pass.
- `smoke.js` passes.

## Code Issues Found
1. **Fixed in this branch (`e1442083`).** A refused or failed start-path write (`writeConfigJson`, `seedWorkspace`) was uncaught on the service's main looper. It crashed `:node` with no Logs-screen line, against contract R3 ("never a crash"). It now ends the start through the normal error path with `CONFIG_WRITE` / `WORKSPACE_SEED`. A source-guard test covers it, with a negative control.
2. **BAT-1585.** Over-cap main-wallet fallback is inconsistent across tools (G1). It needs a contract.
3. **BAT-1586, follow-ups:**
   - `shell_exec`'s own truncation note is replaced by the generic marker;
   - Clear memory reports success when the delete is refused;
   - `Failed(LINK_HYGIENE)` at `:node` step 1 has no persistent user signal.

## Remaining Gaps
All are pre-existing and tracked in **BAT-1586**:
- 21 JS log categories still without guidance, among them file sends, Discord REST, `[Auth]`/`[Session]` expiry, provider parsing, `[Context]`, `[SessionSummary]`, `[Sanitize]`, `[AutoResume]`, `[AgentSettings]`, `[Heartbeat] Error`, skills loading, Trigger/DCA verification and wallet dispatch warnings.
- 9 Kotlin categories still without guidance: xAI store/gate/boot reconcile, config save/rollback/import, the agent_settings overlay, decrypt failures, dropped env vars, cap sweep, PLATFORM.md generation, build provenance and keepScreenOn.

They were deferred, not fixed here, so the security hotfix stays reviewable. They don't affect anything v2.3.2 changed.

Also for the seekerclaw-skills repo (BAT-1586):
- add curated rows for the six new DIAGNOSTICS rooms;
- fix the Phase 2 skip example `Pair(…, LogLevel.WARN)`, which matches a real deferred WARN in ServiceState.kt;
- update the android_sms / android_call fixed-8 rows.
