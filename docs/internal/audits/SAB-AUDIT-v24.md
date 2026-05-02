# SAB-AUDIT-v24 — SeekerClaw Agent Self-Knowledge Audit (SAB v3)

> **Date:** 2026-05-02
> **SAB Version:** v3
> **Scope:** Re-audit after ~11 days of activity since v23 — BAT-525 graceful Node shutdown (just merged), BAT-558/559 cross-provider reasoning hotfix, BAT-515 cross-process state migration, BAT-514 MCP store migration, BAT-513 runtime config migration, BAT-512 CrossProcessStore abstraction, BAT-517 shared model registry, BAT-549 reasoning preservation, BAT-509 SeekerClawService rename, BAT-518 FileObserver, BAT-522/523/524 perf, BAT-504 /model + /provider commands, BAT-503 SAB pre-merge gate, BAT-502 pre-push-check, max-tool-uses configurable.
> **Method:** Full read of `buildSystemBlocks()` (ai.js line 515–end of function) + DIAGNOSTICS.md + git log delta vs v23 + targeted probes on new user-visible surface.
> **Baseline:** SAB-AUDIT-v23.md (2026-04-21, 219/234 = 93.6% pre-fix → 234/234 = 100% post-fix)

## Changes Since v23 That Triggered v24

| Commit | PR | Description | SAB Impact |
|--------|----|----|----|
| `d30ce46` | #349 | BAT-525 Graceful Node shutdown on user-Stop + cleartext loopback fix | **Critical** — new user-visible behavior ("what happens when I tap Stop?") + new error log sites + cleartext config |
| `d01def5` | #356 | BAT-558/559 cross-provider reasoning hotfix + provider label cleanup | Minor — internal reasoning gating; new `[Retry]` and `[/provider]` log sites |
| `a08ef90` | #355 | BAT-515 migrate searchProvider + agentName to CrossProcessStore | Internal — no agent surface |
| `4998e37` | #354 | BAT-549 reasoning content preservation across providers (Commit 1 of 5) | Already covered — DIAGNOSTICS.md has full Reasoning section + ai.js has self-knowledge block at lines 1188-1213 |
| `d9302ab` | #353 | BAT-517 shared model-registry.json | Internal |
| `8a2251e` | #352 | BAT-514 MCP server config to CrossProcessStore | **Significant** — internal, but introduced `internal-control-server.js` with `/mcp/reconcile`, `/healthz`, `/shutdown/flush` loopback endpoints. New `[MCP] reconcile drain error` log sites. |
| `ac4b15b` | #351 | BAT-513 migrate runtime config (provider/authType/model) to CrossProcessStore | Internal — new `[Config] runtime_state.json invalid/decode failed` log sites |
| `591fdaa` | #350 | BAT-512 generic CrossProcessStore<T> abstraction | Internal — foundation work |
| `c754a68` | #348 | BAT-524 per-chat idle-summary timers | Internal perf |
| `35d50f8` | #347 | BAT-523 dirty-flag + debounced DB autosave | Internal perf — created the data-integrity gap that BAT-525 closes |
| `30f50d5` | #346 | BAT-522 derive uptime locally | Internal perf |
| `3edea90` | #343 | BAT-518 FileObserver replaces 1s/500ms polling | Internal perf |
| `ecd4604` | #341 | BAT-509 rename OpenClawService → SeekerClawService | Kotlin internal |
| `bf1c409` | #339 | BAT-504 /model and /provider Telegram commands | **Critical** — new user-visible slash commands. Agent must know these exist. |
| `895f31a` | #338 | GPT-5.5 added, GPT-5.2 dropped | Minor — `${activeModel}` substitution auto-reflects |
| `7474a6d` | #337 | User-configurable max tool uses per turn (default **35**) | **Significant** — `MAX_TOOL_USES` (was 25) → `MAX_STEPS` (default 35). Stale value in prompt at line 913. |
| `9103e86` | #336 | BAT-502 pre-push-check.sh | Dev tooling — no agent surface |
| `c449ac9` | #335 | BAT-503 SAB pre-merge checklist in PR template | Process — should have caught this drift earlier (and didn't, since no PR explicitly invoked the SAB rule) |

---

## Overall Scorecard

| Section | Pre-fix | Post-fix | Max | Pre-fix % | Post-fix % |
|---------|---------|----------|-----|-----------|------------|
| A: Knowledge & Doors | 94/102 | 102/102 | 102 | 92.2% | 100% |
| B: Diagnostic Coverage (curated) | 78/78 | 78/78 | 78 | 100% | 100% |
| B: Diagnostic Coverage (discovered, carried) | 9/9 | 9/9 | 9 | 100% | 100% |
| B: Diagnostic Coverage (new BAT-525) | 0/6 | 6/6 | 6 | 0% | 100% |
| B: Diagnostic Coverage (new BAT-504) | 0/3 | 3/3 | 3 | 0% | 100% |
| C: Tool Consistency (fixed 5) | 15/15 | 15/15 | 15 | 100% | 100% |
| C: Tool Consistency (rotated 5) | 15/15 | 15/15 | 15 | 100% | 100% |
| D: Behavioral Probes (fixed 2) | 6/6 | 6/6 | 6 | 100% | 100% |
| D: Behavioral Probes (rotated 3) | 1/9 | 9/9 | 9 | 11.1% | 100% |
| **Combined** | **218/243** | **243/243** | **243** | **89.7%** | **100%** |

**Pre-fix verdict:** Three drifts. ⚠️ **Pre-fix dropped below 90% — third repeat of v19 anti-pattern** (after v22 = 98.3%, v23 = 93.6%, v24 = 89.7%). Three notable user-visible features shipped without prompt or DIAGNOSTICS coverage:
1. **BAT-525 (Stop Agent flush)** — agent had zero awareness of the graceful-flush handshake or its data-preservation guarantee
2. **BAT-504 (/model + /provider Telegram commands)** — agent didn't know these commands exist; would point users at Settings instead of the faster chat path
3. **MAX_TOOL_USES → MAX_STEPS drift** — prompt still claimed "max 25 tool calls per turn" after the constant was renamed and default raised to 35 (PR #337)

The BAT-503 PR-template gate (added in v23 retro) did not catch any of these because each PR's author skipped or N/A'd the Self-Awareness Checklist. The BAT-503 honor-system gate has a discipline failure mode the v23 retro flagged as a possibility.

---

## Section A: Knowledge & Doors (94 → 102)

### Existing Items (32 from v23) — 31 ✅ + 1 ⚠️ = 94/96

All 32 v23 items verified. One drift:

- **Self-Diagnosis → Conversation corruption / loops** (line 913) — ⚠️ 1/3
  - Pre-fix: prompt said "max 25 tool calls per turn"
  - Code reality: `MAX_STEPS` defaults to 35 in `agent_settings.json` (with 35 fallback in code at ai.js:2257-2271)
  - Post-fix: updated to "max 35 tool calls per turn (configurable in Settings → Agent → Max tool uses per turn)" — 3/3

### New Items (2)

Applying the 3-part test:

#### Item 33: `/model` and `/provider` Telegram commands (BAT-504)

1. ✅ Changes what users can do — switch model/provider live from Telegram, no Settings round-trip
2. ✅ Users likely to ask — "how do I switch to GPT-5.5?", "can I change provider without opening the app?"
3. ✅ Agent would be wrong without coverage — would point at Settings UI; users wouldn't discover the chat-side commands

**All three true → door required.**

- **Pre-fix:** No mention of `/model` or `/provider` commands anywhere in `buildSystemBlocks()`. The prompt has detail on `/quick`, `/new`, `/reset`, `/think`, `/resume` — but BAT-504's commands had no door.
- **Post-fix (3/3):** Added one line at the end of the Config Awareness section (ai.js after line 826):

> **Quick model/provider switch from chat (BAT-504):** Users can run `/model <name>` and `/provider <claude|openai|openrouter|custom>` directly in Telegram instead of opening Settings → AI Provider. Both write to runtime_state.json (live overlay) and survive restart. If the user asks how to switch model or provider, point them at these commands first.

One line, ~280 chars. Door, not a room.

#### Item 34: Stop Agent semantics — BAT-525 graceful flush

1. ✅ Changes what happens when user stops — flush handshake + data preservation guarantee, replacing the previous "killProcess could lose last 60s of activity" reality
2. ✅ Users likely to ask — "what happens when I tap Stop?", "do I lose my conversation?", "is it safe to stop the agent?"
3. ✅ Agent would be wrong without coverage — would speculate or worry about data loss; the actual answer is "no, the last 60s is preserved"

**All three true → door required.**

- **Pre-fix:** Zero mentions of Stop Agent, flush, graceful shutdown, BAT-525, or `/shutdown/flush` anywhere in the system prompt. Even the existing Session Memory section's "On shutdown/restart" bullet was generic and didn't capture the user-Stop guarantee.
- **Post-fix (3/3):** Added one paragraph to the Session Memory section (ai.js after line 1234):

> **User-initiated Stop (BAT-525):** When the user taps Stop Agent on the dashboard, SeekerClaw triggers a graceful flush handshake (POST /shutdown/flush over loopback) that gives you a brief window (~1.5s) to persist pending session summaries and SQL.js writes before the :node process is killed. The last ~60s of api_request_log activity and any in-flight summary survives across user-Stop. If a user worries about losing data when stopping the agent, this is the guarantee.

### Negative Knowledge — 6/6 unchanged

All 6 boundaries verified at lines 786-792:
1. No internet browsing ✓
2. No image/audio/video generation ✓
3. No direct cloud/infra access ✓
4. No cross-device reach ✓
5. No persistent background execution ✓
6. No real-time data without tools ✓

### Constants Verification

| Constant | Code | Prompt | Match |
|----------|------|--------|-------|
| MAX_HISTORY | 35 (ai.js:205) | "35 messages per chat" (line 1239) | ✓ OK |
| MAX_STEPS (was MAX_TOOL_USES) | 35 default (ai.js:2257-2271) | "max **25** tool calls per turn" (line 913) | ❌ **STALE** — fixed post-fix |
| HARD_MAX_TOOL_RESULT_CHARS | 50000 (config.js:629) | "~50K characters" (line 112 of DIAGNOSTICS) | ✓ OK |
| max_tokens | 4096 | (referenced in v22/v23 baseline; current build still uses 4096 default) | ✓ OK |

### Section A Score
- Existing: 31 ✅ + 1 ⚠️ = 31×3 + 1 = 94
- New (2): 0/3 + 0/3 = 0
- **Pre-fix: 94/102** (was 96/96 in v23 baseline; net +6 max from new items)
- **Post-fix: 102/102**

---

## Section B: Diagnostic Coverage

### Curated (78/78 — no change from v23)

All 28 curated failure modes still hold. No new curated entries needed for this audit cycle (the new BAT-525 / BAT-504 surfaces are covered in feature-specific subsections below).

### Auto-Discovery (Phase 2) — 9/9 carried

Re-ran the scan over post-v23 commits:

```bash
git log --since="2026-04-21" -p -G"log\(.*'(ERROR|WARN)'" -- "app/src/main/assets/nodejs-project/"
```

New error log sites since v23 (~30 sites scanned). Categorized:

**Already covered by existing DIAGNOSTICS:**
- `[Retry] ${displayNameForProvider} API ...` (BAT-558/559) — covered by LLM API → Transport Timeout / API errors
- `[SessionSummary] API ${status}` — covered by LLM API
- `[ReasoningRecovery] Step ...` (BAT-549) — covered by Reasoning section
- `[/think] runtime_state.json write` — covered by Reasoning section
- `[MCP] tokenFetcher failed` — covered by MCP → Server Unreachable
- `[AgentSettings] existing file unreadable` — internal recovery, low user-visibility

**NOT covered — required new sections:**
- `[Shutdown] flush completed with errors` / `[Shutdown] HTTP flush failed` / `[ControlServer] /shutdown/flush partial|threw` (BAT-525) — **3 sub-paths × 3 = 6 max, 0/6 pre, 6/6 post**
- `[/model] runtime_state.json write threw|returned false` / `[/provider] runtime_state.json write|revert|unlink` / `[Config] runtime_state.json invalid|decode failed` (BAT-504, BAT-513, BAT-558/559) — **1 path × 3 = 3 max, 0/3 pre, 3/3 post**
- `[MCP] reconcile drain error` / `[MCP] configsProvider threw during reconcile` / `[MCP] Failed to (re)connect` (BAT-514 reconcile pipeline) — folded into the new BAT-525 section's third subsection (overlaps with the cleartext loopback story; user-Stop tested it end-to-end)

### Section B Score
- Curated: 78/78 → 78/78
- Discovered (carry): 9/9 → 9/9
- New BAT-525 (Service Lifecycle subsections): 0/6 → 6/6
- New BAT-504 (Service Lifecycle subsection): 0/3 → 3/3
- **Pre-fix: 87/96** (78 + 9 + 0 + 0)
- **Post-fix: 96/96**

---

## Section C: Tool Consistency

### Fixed 5 (always checked) — 15/15 pre, 15/15 post

| Tool | Score | Notes |
|------|-------|-------|
| `shell_exec` | 3/3 | Allowlist (line 917) matches ALLOWED_COMMANDS reference. Description says "Sandboxed". 30s timeout. ✅ |
| `js_eval` | 3/3 | "30s timeout, 10000-char code limit" matches code. Sandboxed VM context. ✅ |
| `solana_swap` | 3/3 | Confirmation gate listed at line 739. Quote-first workflow at line 603. ✅ |
| `android_sms` | 3/3 | Confirmation gate listed at line 739. Permission noted in DIAGNOSTICS Permissions. ✅ |
| `android_call` | 3/3 | Confirmation gate listed at line 739. Permission noted. ✅ |

### Rotated 5 (new for v24)

Excluded pool: v17–v23 rotations + Fixed 5. Selected for v24: `tool_search`, `web_search`, `web_fetch`, `read`, `solana_quote`.

| Tool | Score | Notes |
|------|-------|-------|
| `tool_search` | 3/3 | Description: "Search for available tools by keyword … Common tools (read, write, web_search, web_fetch, datetime) are always available." Prompt at line 648 (Tool Discovery, non-Claude provider only) matches: "Not all tools are loaded by default. If you need a tool that's not available, use `tool_search` to find and load it first. Common tools (read, write, web_search, web_fetch, datetime) are always available." Three-source agreement (no DIAGNOSTICS needed for a discovery tool). ✅ |
| `web_search` | 3/3 | Description references provider param. Prompt at line 614 has detailed multi-provider guidance (Brave/Perplexity/Exa/Tavily/Firecrawl). DIAGNOSTICS has full Web Search section. ✅ |
| `web_fetch` | 3/3 | Description: "Fetch a URL with full HTTP support … up to 50K chars … POST/PUT/DELETE … Bearer auth." Prompt at line 615 matches. DIAGNOSTICS covers fallback path under Web Search. ✅ |
| `read` | 3/3 | Description: "Read a file from the workspace directory. Only files within workspace/ can be read." Prompt mentions read tool throughout (file system doors line 796-806, heatmap data path line 870). ✅ |
| `solana_quote` | 3/3 | Description: "Get a swap quote from Jupiter … without executing." Prompt at line 603 says "Always use solana_quote first to show the user what they'll get, then solana_swap to execute." DIAGNOSTICS covers Jupiter under Provider-Specific notes. ✅ |

**Section C: 30/30 pre-fix, 30/30 post-fix** — no drift.

---

## Section D: Behavioral Probes

### Fixed Probes (6/6 unchanged)

**Probe 1: "Web search is broken"** — PASS 3/3 (door at line 614, DIAGNOSTICS Web Search section with provider-specific troubleshooting)

**Probe 2: "Agent won't respond to messages"** — PASS 3/3 (Self-Diagnosis Playbook lines 891-896 + DIAGNOSTICS Telegram + Discord channel sections)

### Rotated Probes (v24)

**Probe P1: "What happens when I tap Stop Agent?"** (BAT-525 surface)
- **Pre-fix: FAIL (0/3)** — no door anywhere in prompt about Stop, flush, graceful shutdown, or the data-preservation guarantee. Agent would speculate or give a vague "your conversation history clears, memory persists" answer (which is wrong for the last 60s of api_request_log).
- **Post-fix: PASS (3/3)** — Session Memory section now has the BAT-525 paragraph; DIAGNOSTICS has "Shutdown Flush Timed Out or Failed" subsection. Agent can explain: "When you tap Stop, SeekerClaw asks me to flush pending writes (about 1.5 seconds) before killing the process. The last 60 seconds of activity and any in-flight session summary are preserved across the cycle."

**Probe P2: "How do I switch model from Telegram?"** (BAT-504 surface)
- **Pre-fix: FAIL (0/3)** — prompt mentioned `/quick`, `/new`, `/reset`, `/think`, `/resume` but had zero mention of `/model` or `/provider`. Agent would say "Open the app → Settings → AI Provider" — accurate but not the faster path. Half-correct answers in this category are worse than full-correct answers because they hide newer functionality.
- **Post-fix: PASS (3/3)** — Config Awareness section has the new line: agent knows `/model <name>` and `/provider <name>` work from Telegram and what they do.

**Probe P3: "How many tool calls can you do per turn?"** (MAX_STEPS drift)
- **Pre-fix: ⚠️ PARTIAL (1/3)** — prompt at line 913 said "max 25 tool calls per turn." Door exists but value is stale (actual default 35; user-configurable). User asking this question would get a wrong number off-by-10 plus wouldn't learn it's configurable.
- **Post-fix: PASS (3/3)** — line 913 now reads "max 35 tool calls per turn (configurable in Settings → Agent → Max tool uses per turn)".

### Section D Score
- Fixed (6/6): unchanged
- Rotated (1/9 pre, 9/9 post): P1 0→3, P2 0→3, P3 1→3
- **Pre-fix: 7/15**
- **Post-fix: 15/15**

### Probe Rotation History
- v19: ChatGPT sign-in, MCP rug-pull, API key
- v20: Swap failed, Cron miss, Loop
- v21: GitHub-ops skill, Discord disconnect, API key
- v22: GITHUB_TOKEN read, env var leak, env var list, github-ops skill, ElevenLabs STT
- v23: Activity heatmap show, history count, blank heatmap
- **v24: Stop Agent semantics, /model from Telegram, tool budget value**

---

## Gaps Found (Pre-fix)

### Gap 1 — BAT-525 Stop Agent: zero prompt + zero DIAGNOSTICS coverage

**Root cause:** PR #349 merged with no SAB audit checkbox in the PR description. CLAUDE.md's Self-Awareness Checklist gate (BAT-503 introduced this in v23) was N/A'd or unchecked. PR #349 ships a new user-visible behavior ("what happens when I tap Stop?") and new error log sites — both gates fire but neither was applied.

**Impact:**
- Probe P1 fail (0/3, 3 points)
- Section A new item 0/3 (3 points)
- Section B new diagnostic 0/6 (6 points)
- **Total: 12 points of drift**

### Gap 2 — BAT-504 /model and /provider: no slash-command awareness

**Root cause:** PR #339 (2026-04-XX) introduced `/model` and `/provider` Telegram commands. Self-Awareness Checklist not applied (predates BAT-503's PR-template gate, but the rule from CLAUDE.md was in force since at least PR #316).

**Impact:**
- Probe P2 fail (0/3, 3 points)
- Section A new item 0/3 (3 points)
- Section B new diagnostic 0/3 (3 points)
- **Total: 9 points of drift**

### Gap 3 — MAX_STEPS value drift

**Root cause:** PR #337 renamed `MAX_TOOL_USES` (constant 25) to `MAX_STEPS` (default 35, user-configurable via `agent_settings.json`). The prompt's hard-coded "max 25 tool calls per turn" never got updated.

**Impact:**
- Probe P3 partial (1/3, lost 2 points)
- Section A existing item ⚠️ (1/3 instead of 3/3, lost 2 points)
- **Total: 4 points of drift**

---

## Fixes Applied

1. **`ai.js` line 913** — "max 25 tool calls per turn" → "max 35 tool calls per turn (configurable in Settings → Agent → Max tool uses per turn)"
2. **`ai.js` Config Awareness section** (after line 826) — added one-line door for `/model` and `/provider` Telegram commands with file path (runtime_state.json) and behavioral summary
3. **`ai.js` Session Memory section** (after line 1234) — added BAT-525 graceful-flush paragraph with the data-preservation guarantee
4. **`DIAGNOSTICS.md`** — added new top-level section `## Service Lifecycle` with three subsections:
   - "Shutdown Flush Timed Out or Failed" (BAT-525 — symptoms, check commands, diagnosis with cleartext + token-rotation + Node-side failure modes, fix steps)
   - "/model or /provider Switch Didn't Take Effect" (BAT-504/513/558/559 — symptoms, check commands, diagnosis with write-failure + revert + decode-failure modes, fix steps)
   - "MCP Reconcile Silently Failed" (BAT-514 — covers the cleartext loopback story explicitly, since it was the root cause of pre-`ee29727` silent reconcile failures, and the agent should know to suggest a service restart as the fallback)
5. **Syntax verified:** `node --check ai.js` PASS. `tests/nodejs-project/smoke.js` 11/11 modules loaded cleanly. PASS — safe to commit.

---

## Code Issues Found

None. The BAT-525 graceful-shutdown implementation is correct (R7 Copilot clean + Codex PM-approved + device-tested on Solana Seeker). Only the self-awareness layer was missing.

---

## Remaining Gaps

None post-fix.

---

## Process Note — Third Repeat of the v19 Anti-Pattern

This is now the **third consecutive audit** flagging "feature shipped without prompt/diagnostics coverage":

> v19 (BAT-485 OAuth): "the feature shipped functionally correct but with zero self-knowledge coverage. SAB-AUDIT-v19 caught 5 gaps after merge — they should have been caught before. Don't repeat."

> v23 (BAT-500 Heatmap): "ship feature, then run SAB anti-pattern. Pre-fix 93.6% — the lowest since v19."

> v24 (BAT-525 + BAT-504 + MAX_STEPS): pre-fix 89.7% — **lowest ever**. Three feature batches in this audit window, all skipped the Self-Awareness Checklist.

BAT-503 introduced the PR-template "Self-Awareness Checklist" in v23 retro. **It is not working as a discipline gate.** PRs in this window were either checked-N/A without honest review or shipped without invoking it. The honor system is not preventing the failure mode.

**Stronger gate proposed (file as BAT-XXX follow-up):**
- GitHub Actions check that fails PR if it touches `ai.js` `buildSystemBlocks()`, adds new `log(..., 'ERROR'|'WARN')` sites in `app/src/main/assets/nodejs-project/`, or modifies `DIAGNOSTICS.md` WITHOUT a corresponding SAB audit reference (`SAB-AUDIT-vN.md`) in the commit trailer or PR description.
- This would have caught all three v24 gaps at the PR stage. Honor system → CI gate.

---

## Score Trend

| Audit | Pre-fix % | Post-fix % | Notes |
|-------|-----------|------------|-------|
| v17 | 94.0% | 100% | Custom provider + diagnostics |
| v18 | 97.0% | 100% | First v3 (behavioral probes) |
| v19 | 95.0% | 100% | OAuth (BAT-485) post-merge — "don't repeat" |
| v20 | 98.1% | 100% | Stabilization, SAB v3 rotation |
| v21 | 96.9% | 100% | Env vars BAT-495 |
| v22 | 98.3% | 100% | Env vars follow-ups |
| v23 | 93.6% | 100% | Activity heatmap BAT-500 post-merge |
| **v24** | **89.7%** | **100%** | **BAT-525 + BAT-504 + MAX_STEPS — third v19 repeat** |

Trend line: 94→97→95→98→97→98→94→**90**. The pre-fix scores are not stable; they rebound to 95-98 after audit but drift back below 95 on the next feature wave. The structural fix (CI gate, not honor system) is overdue.
