# SAB-AUDIT-v19 — SeekerClaw Agent Self-Knowledge Audit (SAB v3)

> **Date:** 2026-04-06
> **Scope:** Re-audit after PR #316 (BAT-485) — OpenAI Codex OAuth merged. Major new auth flow that touched the system prompt area without updating it.
> **Method:** Full read of buildSystemBlocks() (ai.js lines 382-980) + DIAGNOSTICS.md + tool consistency spot-check + behavioral probe tracing
> **Baseline:** SAB-AUDIT-v18.md (2026-04-03, 195/201 = 97.0% → 100%)

## Overall Scorecard

| Section | Pre-fix | Post-fix | Max | Pre-fix % | Post-fix % |
|---------|---------|----------|-----|-----------|------------|
| A: Knowledge & Doors | 81/87 | 87/87 | 87 | 93.1% | 100% |
| B: Diagnostic Coverage (curated) | 72/78 | 78/78 | 78 | 92.3% | 100% |
| C: Tool Consistency (10 tools) | 30/30 | 30/30 | 30 | 100% | 100% |
| D: Behavioral Probes (5) | 10/15 | 15/15 | 15 | 66.7% | 100% |
| **Combined** | **193/210** | **210/210** | **210** | **91.9%** | **100%** |

**Pre-fix verdict:** ⚠ Significant drift on the OAuth flow specifically. Section D (behavioral probes) caught the smoking gun: the agent had zero knowledge of how to help a user sign in with ChatGPT, despite the feature shipping in PR #316.

---

## Section A: Knowledge & Doors (81/87 → 87/87)

### Identity (5/5 = 15/15) — unchanged from v18

### Architecture (5/5 = 15/15) — unchanged from v18

### Capabilities (6/7 = 18/21 → 21/21)

| Item | Pre-fix | Post-fix | Notes |
|------|---------|----------|-------|
| Full tool list | OK | OK | 59 tools across 11 domain files |
| Sandboxed tools | OK | OK | shell_exec allowlist, js_eval VM |
| What it cannot do | OK | OK | 6/6 negative boundaries |
| Skills load/trigger | OK | OK | Semantic matching + requirements |
| Search provider system | OK | OK | 5 providers, line 481 |
| Custom provider | OK | OK | Line 681 |
| **OpenAI Codex OAuth (NEW)** | **❌** | **OK** | **Added Provider block + auth-mode-aware copy at lines 949-973** |

### Negative Knowledge Sub-Score (6/6) — unchanged

### Configuration (4/4 = 12/12) — unchanged

### Self-Diagnosis (7/8 = 21/24 → 24/24)

| Item | Pre-fix | Post-fix | Notes |
|------|---------|----------|-------|
| Health stale | OK | OK | |
| Telegram disconnects | OK | OK | |
| Skill fails | OK | OK | |
| Conversation corruption | OK | OK | |
| Loop detection | OK | OK | |
| Search provider errors | OK | OK | |
| Discord connection issues | OK | OK | |
| **OAuth refresh / sign-in failures (NEW)** | **❌** | **OK** | **Added "If OpenAI OAuth fails" playbook (4 steps) gated on PROVIDER==='openai' && OPENAI_AUTH_TYPE==='oauth'** |

### Constants Verification (unchanged from v18)
All 10 baseline constants still match between code and prompt.

---

## Section B: Diagnostic Coverage (72/78 → 78/78)

26 curated failure modes (24 from v18 + 2 new for OAuth).

| # | Subsystem | Failure Mode | Pre-fix | Post-fix | Source |
|---|-----------|-------------|---------|----------|--------|
| 1-24 | (v18 baseline) | All 24 v18 modes | OK | OK | Unchanged |
| 25 | **OpenAI OAuth** | **Token refresh failure** | **❌** | **OK** | **DIAGNOSTICS.md added** |
| 26 | **OpenAI OAuth** | **Sign-in flow failures (state mismatch, callback fail, timeout, invalid_state)** | **❌** | **OK** | **DIAGNOSTICS.md added** |

### Auto-Discovered OAuth Error Sites

`grep -rn "log(.*'ERROR'\|log(.*'WARN'" providers/openai.js` after PR #316:

| Error | Line | Covered? |
|-------|------|----------|
| `[OpenAI] OAuth refresh failed` | openai.js:346 | **YES (post-fix)** — Token Refresh Failure section |
| `[OpenAI] Failed to persist refreshed tokens` | openai.js:465 | **YES (post-fix)** — covered in same section, fix step 1 |
| `[OpenAI] Failed to parse tool arguments` | openai.js:153 | Implicit (already covered by tool failure playbook) |

The Activity-side errors (state mismatch, callback server fail, exchange failed, timeout) live in Logcat (not node_debug.log), so the new DIAGNOSTICS section explicitly notes that and points to `adb logcat | grep OpenAIOAuth` for triage.

---

## Section C: Tool Consistency (30/30) — no regressions

PR #316 added no new tools — only auth flow plumbing. Existing tool descriptions still match prompt + DIAGNOSTICS.

### Fixed 5 (always checked)
| Tool | Pre-fix | Post-fix |
|------|---------|----------|
| shell_exec | 3/3 | 3/3 |
| js_eval | 3/3 | 3/3 |
| solana_swap | 3/3 | 3/3 |
| android_sms | 3/3 | 3/3 |
| android_call | 3/3 | 3/3 |

### Rotated 5 (new for v19)
| Tool | Pre-fix | Post-fix | Notes |
|------|---------|----------|-------|
| skill_read | 3/3 | 3/3 | Description matches prompt skill workflow |
| skill_install | 3/3 | 3/3 | Auto-install message matches prompt line 577 |
| datetime | 3/3 | 3/3 | Used in cron + heartbeat playbooks |
| session_status | 3/3 | 3/3 | Listed in Data & Analytics section |
| jupiter_token_security | 3/3 | 3/3 | Prompt line 476 — "ALWAYS check unknown tokens" |

**v17 rotated:** android_notification, memory_save, web_fetch, cron_create, tool_search
**v18 rotated:** web_search, memory_search, solana_quote, android_location, telegram_send
**v19 rotated:** skill_read, skill_install, datetime, session_status, jupiter_token_security

---

## Section D: Behavioral Probes (10/15 → 15/15) — PRE-FIX 66.7%

This is where the OAuth drift was caught.

### Fixed Probes

**Probe 1: "Web search is broken"**
- Door: line 481
- DIAGNOSTICS: Search Provider Not Configured + API Error sections
- Pre-fix: **PASS (3/3)**
- Post-fix: **PASS (3/3)**

**Probe 2: "Agent won't respond to messages"**
- Door: lines 733-738 (Self-Diagnosis Playbook)
- DIAGNOSTICS: Channel Connection + Telegram/Discord sections
- Pre-fix: **PASS (3/3)**
- Post-fix: **PASS (3/3)**

### Rotated Probes

**Probe 3: "How do I sign in with ChatGPT?" / "What is Codex OAuth?"** ⚠ NEW
- Door in pre-fix system prompt: **NONE** — no mention of Codex/OAuth/ChatGPT subscription anywhere
- DIAGNOSTICS pre-fix: **NONE**
- Pre-fix: **FAIL (0/3)** — agent would hallucinate or give a generic LLM answer about OpenAI OAuth instead of pointing to Settings > AI Provider > OpenAI > Sign in with ChatGPT
- **Post-fix:** Provider block at lines 962-973 explicitly mentions "Sign in with ChatGPT" path. DIAGNOSTICS.md has dedicated OAuth Sign-In Flow Failures section. **PASS (3/3)**

**Probe 4: "MCP tool disappeared" (rotated from v17 pool)**
- Door: line 956 (MCP rug-pull mention) + DIAGNOSTICS MCP section
- Pre-fix: **PASS (3/3)**
- Post-fix: **PASS (3/3)**

**Probe 5: "API key not working" (rotated from v18 pool)**
- Door: lines 765-779 ("If API calls keep failing")
- DIAGNOSTICS: LLM API section
- Pre-fix: ⚠ **PARTIAL (1/3)** — covers 401/403/429/402/network for api_key flows, but NOTHING for OAuth refresh failures or "user needs to re-sign-in"
- **Post-fix:** New "If OpenAI OAuth fails" playbook block in Self-Diagnosis covers OAuth-specific failure modes with re-sign-in guidance. DIAGNOSTICS Token Refresh Failure section added. **PASS (3/3)**

---

## Gaps Found (Pre-fix)

1. **Section A — Capabilities:** No "OpenAI Codex OAuth" item. The PROVIDER block in `buildSystemBlocks()` (lines 949-962) had cases for `openrouter` and `custom` but not `openai`. An OAuth user's agent could not introspect that it was running on a ChatGPT subscription via Codex.
2. **Section A — Self-Diagnosis:** No playbook entry for OAuth refresh failures or sign-in flow problems. The two ERROR-level log sites in `providers/openai.js` (lines 346, 465) had no diagnostic coverage.
3. **Section B — Diagnostics:** No DIAGNOSTICS.md section for OpenAI OAuth at all. Two distinct failure modes (token refresh, sign-in flow) needed coverage.
4. **Section D — Probe 3:** Agent has no idea what "Codex OAuth" or "Sign in with ChatGPT" means — would give a generic/wrong answer.
5. **Section D — Probe 5:** "API key not working" playbook only covered platform-key flows, not OAuth-specific paths.

## Fixes Applied

1. **ai.js — Provider block extended** (lines 962-973): Added `else if (PROVIDER === 'openai')` case with auth-mode-aware copy. Tells the agent which auth mode is active, where requests route, and how the user can switch.
2. **ai.js — config import**: Added `OPENAI_AUTH_TYPE` to the destructured require from `./config`.
3. **ai.js — Self-Diagnosis Playbook**: Added "If OpenAI OAuth fails" block (4 steps) gated on `PROVIDER === 'openai' && OPENAI_AUTH_TYPE === 'oauth'`. Covers token expiry, sign-in retry, persistent refresh failure, and grep command for OAuth errors in node_debug.log.
4. **DIAGNOSTICS.md**: Added two new sections under "LLM API":
   - **OpenAI Codex OAuth — Token Refresh Failure** (4 causes, 4 fix steps)
   - **OpenAI Codex OAuth — Sign-In Flow Failures** (6 failure modes including invalid_state benign-double-submit pattern, 4 fix steps)
5. **Syntax check**: `node --check ai.js` passes.

## Code Issues Found

None. PR #316 shipped functionally correct OAuth — the only "issue" was missing self-knowledge coverage, which is exactly what SAB catches.

## Remaining Gaps

None. Post-fix score is 100%.

---

## Score Progression

```
v5  ████████████████████░░░░░  78% (35/45)
v6  ██████████████████████░░░  88% (53/60)
v7  ██████████████████████░░░  88% (53/60)
v8  ████████████████████████░  94% (85/90)
v9  ████████████████████████░  96% (87/90)
v10 █████████████████████████  98% (115/117)
v11 █████████████████████████ 100% (117/117)
v12 █████████████████████████ 100% (129/129)
v13 █████████████████████████ 100% (141/141)
v14 █████████████████████████ 100% (147/147)
v15 █████████████████████████ 100% (156/156)
v16 █████████████████████████ 100% (165/165)
v17 █████████████████████████ 100% (180/180)
v18 ████████████████████████░  97% (195/201) → █████████████████████████ 100% (201/201)
v19 ███████████████████████░░  92% (193/210) → █████████████████████████ 100% (210/210)
```

**Delta from v18:** +9 capacity (1 new Capabilities item, 1 new Self-Diagnosis item, 2 new Diagnostic failure modes, 1 new Behavioral Probe). Pre-fix dropped to 91.9% — first time below 95% since v9 — caught entirely by Sections A/B/D drift on the OAuth feature. Section C (tool consistency) was unaffected because OAuth added no new tools.

**Lesson:** SAB v3's behavioral probe section (Section D) was the smoking gun this audit. The "How do I sign in with ChatGPT?" probe failed at 0/3 pre-fix because there was literally no door anywhere in the system prompt — exactly the failure mode SAB v3 was designed to catch. Without it, the curated Sections A/B might have been argued as borderline-OK ("the auth flow is implementation detail, the agent doesn't need to know"), but the probe forces a user-perspective check that exposes drift unambiguously.

**Action item for future PRs:** When a feature ships that touches `buildSystemBlocks()`, `DIAGNOSTICS.md`, or adds a new error log site in JS, the PR should explicitly call out that an SAB audit is needed before merge — not after. Today's audit caught 5 gaps post-merge that should have been caught pre-merge.
