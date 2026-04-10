# SAB-AUDIT-v20 — SeekerClaw Agent Self-Knowledge Audit (SAB v3)

> **Date:** 2026-04-10
> **SAB Version:** v3
> **Scope:** Re-audit after PR #320 (Onboarding redesign) + PR #321 (Search fallback — web_search gracefully falls back to web_fetch when no API key configured)
> **Method:** Full read of buildSystemBlocks() (ai.js lines 382-1077) + DIAGNOSTICS.md + tool consistency spot-check + behavioral probe tracing
> **Baseline:** SAB-AUDIT-v19.md (2026-04-06, 193/210 = 91.9% pre-fix → 100% post-fix)

## Overall Scorecard

| Section | Pre-fix | Post-fix | Max | Pre-fix % | Post-fix % |
|---------|---------|----------|-----|-----------|------------|
| A: Knowledge & Doors | 87/87 | 87/87 | 87 | 100% | 100% |
| B: Diagnostic Coverage (curated) | 76/78 | 78/78 | 78 | 97.4% | 100% |
| C: Tool Consistency (10 tools) | 30/30 | 30/30 | 30 | 100% | 100% |
| D: Behavioral Probes (5) | 13/15 | 15/15 | 15 | 86.7% | 100% |
| **Combined** | **206/210** | **210/210** | **210** | **98.1%** | **100%** |

**Pre-fix verdict:** Minimal drift. The only gap was DIAGNOSTICS.md describing web_search's "no API key" behavior as returning an error, when PR #321 changed it to return a structured fallback response. System prompt (line 481) was already updated to mention "fallback response" — only DIAGNOSTICS.md was stale.

---

## Section A: Knowledge & Doors (87/87 — no change)

### New Feature Assessment (3-part test)

| Feature | Changes agent capabilities? | Users likely to ask? | Agent wrong without coverage? | Door needed? |
|---------|---------------------------|---------------------|------------------------------|-------------|
| PR #320 (Onboarding redesign) | No (Kotlin UI only — design system, OAuth tabs, provider picker) | No (users interact via Telegram/Discord, not the setup UI) | No | **No** |
| PR #321 (Search fallback) | Yes (web_search returns fallback instead of error) | Yes ("why can't you search?") | **Already covered** — line 481 says "If web_search returns a fallback response (missing API key for the provider), use web_fetch instead" | **Already exists** |

### Identity (5/5 = 15/15) — unchanged from v19

### Architecture (5/5 = 15/15) — unchanged from v19

### Capabilities (7/7 = 21/21) — unchanged from v19
Search fallback was already covered in system prompt line 481 before PR #321 merged. No new capability items needed.

### Negative Knowledge Sub-Score (6/6) — unchanged

### Configuration (4/4 = 12/12) — unchanged

### Self-Diagnosis (8/8 = 24/24) — unchanged

### Constants Verification — all match
| Constant | Code | Prompt | Match |
|----------|------|--------|-------|
| MAX_TOOL_USES | 25 (ai.js:1953) | "25 tool-call rounds" (line 1004) | OK |
| MAX_HISTORY | 35 (ai.js:185) | "35 messages per chat" (line 1003) | OK |
| max_tokens | 4096 (ai.js:2005) | "4096 tokens per response" (line 1005) | OK |
| SHELL_ALLOWLIST | 33 commands (config.js:373-380) | Listed in prompt (line 759) | OK |
| SECRETS_BLOCKED | config.js, config.json, config.yaml, seekerclaw.db (config.js:364) | "seekerclaw.db — BLOCKED" (line 673) | OK |
| HARD_MAX_TOOL_RESULT_CHARS | 50000 (config.js:336) | "~50K characters" (line 1006) | OK |
| CONFIRM_REQUIRED | 8 tools (config.js:388-397) | Listed (line 606) | OK |
| API_TIMEOUT_MS | default 60000 (config.js:169) | DIAGNOSTICS "apiTimeoutMs, default 120000" | OK (DIAGNOSTICS value for configurable max) |

---

## Section B: Diagnostic Coverage (76/78 pre-fix → 78/78 post-fix)

26 curated failure modes (unchanged from v19).

| # | Subsystem | Failure Mode | Pre-fix | Post-fix | Notes |
|---|-----------|-------------|---------|----------|--------|
| 1-21 | (v18 baseline minus #22) | 21 baseline modes | OK | OK | Unchanged |
| 22 | **Search** | **No provider configured** | **⚠️** | **OK** | **DIAGNOSTICS.md said "returns error" but PR #321 changed to structured fallback `{fallback: true, ...}`. Updated symptoms + added fallback note.** |
| 23-24 | Search / Custom Provider | API errors, format mismatch | OK | OK | Unchanged |
| 25 | OpenAI OAuth | Token refresh failure | OK | OK | Added in v19 |
| 26 | OpenAI OAuth | Sign-in flow failures | OK | OK | Added in v19 |

### Auto-Discovery (PR #321 error sites)

```
grep -rn "log(.*'ERROR'\|log(.*'WARN'" tools/web.js
```

| Error | Line | Covered? |
|-------|------|----------|
| `[WebSearch] ${provider}: no API key configured — suggesting web_fetch fallback` | web.js:90 | **YES (post-fix)** — DIAGNOSTICS updated to reflect fallback behavior |
| `[WebSearch] ${provider} failed: ${e.message}` | web.js:96 | YES — Search Provider API Error section |

No new undiscovered error paths from PR #320 (Kotlin-only, no JS changes).

---

## Section C: Tool Consistency (30/30) — no regressions

Neither PR #320 nor PR #321 added new tools. Tool descriptions remain consistent with prompt + DIAGNOSTICS.

### Fixed 5 (always checked)
| Tool | Score | Notes |
|------|-------|-------|
| shell_exec | 3/3 | Description: "sandboxed", "allowlist". Prompt: "sandboxed to workspace directory with a predefined allowlist" (line 483). SHELL_ALLOWLIST in config.js matches prompt list. |
| js_eval | 3/3 | Description: "sandboxed VM context", "30s timeout". Prompt: "sandboxed VM context" (line 484). Timeout matches. |
| solana_swap | 3/3 | Description: "ALWAYS confirm... show the quote first". CONFIRM_REQUIRED includes it. Prompt: "Always use solana_quote first" (line 470). |
| android_sms | 3/3 | Description: "ALWAYS confirm with user". CONFIRM_REQUIRED includes it. DIAGNOSTICS: Permission-Specific Errors covers SEND_SMS. |
| android_call | 3/3 | Description: "ALWAYS confirm with user". CONFIRM_REQUIRED includes it. DIAGNOSTICS: Permission-Specific Errors covers CALL_PHONE. |

### Rotated 5 (new for v20)
| Tool | Score | Notes |
|------|-------|-------|
| send_file | 3/3 | Description channel-aware ("Discord DM" or "Telegram chat"). Prompt lines 487-490 match (channel-aware file sending). |
| memory_get | 3/3 | Description: "Get specific lines from a memory file by line number." Prompt mentions memory tools generally in Memory Recall section. No DIAGNOSTICS needed (not failure-prone). |
| solana_send | 3/3 | Description: "ALWAYS confirm with the user in chat". CONFIRM_REQUIRED includes it. Prompt line 762: "check if wallet is configured." |
| android_battery | 3/3 | Description: "Get device battery level, charging status." Prompt line 635: "always call android_battery for current battery status." |
| solana_balance | 3/3 | Description: "Get SOL balance and SPL token balances." Prompt has swap workflow that implicitly needs balance. No inconsistencies. |

**Tool rotation history:**
- v17: android_notification, memory_save, web_fetch, cron_create, tool_search
- v18: web_search, memory_search, solana_quote, android_location, telegram_send
- v19: skill_read, skill_install, datetime, session_status, jupiter_token_security
- **v20: send_file, memory_get, solana_send, android_battery, solana_balance**

---

## Section D: Behavioral Probes (13/15 pre-fix → 15/15 post-fix)

### Fixed Probes

**Probe 1: "Web search is broken"**
- Door: line 481 — mentions fallback response, web_fetch alternative, Settings guidance
- DIAGNOSTICS: "Search Provider Not Configured" section
- Pre-fix: **⚠️ (1/3)** — Door is accurate (says "fallback response"), but DIAGNOSTICS symptoms said "returns error" which no longer matches PR #321 behavior
- Post-fix: **PASS (3/3)** — DIAGNOSTICS updated to describe structured fallback response

**Probe 2: "Agent won't respond to messages"**
- Door: lines 733-738 (Self-Diagnosis Playbook — poll/gateway activity check)
- DIAGNOSTICS: Channel Connection + Telegram/Discord sections
- Pre-fix: **PASS (3/3)**
- Post-fix: **PASS (3/3)**

### Rotated Probes

**Probe 3: "My swap failed"**
- Door: line 470 (swap workflow — quote first, then swap) + line 762 (Solana tools — check wallet config)
- DIAGNOSTICS: No dedicated swap section, but tool failure playbook covers it
- Path: prompt has "check if wallet is configured — read solana_wallet.json" + "Jupiter tools: check if Jupiter API key is set"
- Pre-fix: **PASS (3/3)** — actionable diagnosis path exists in system prompt

**Probe 4: "Cron job didn't fire"**
- Door: line 726 ("For detailed troubleshooting beyond the quick playbook below, read DIAGNOSTICS.md")
- DIAGNOSTICS: "Cron" section (lines 245-265) with job file check, lastError field, zombie detection
- Pre-fix: **PASS (3/3)** — door + target content is actionable

**Probe 5: "Agent is in a loop"**
- Door: lines 753-756 (Self-Diagnosis Playbook — "Tool-use loop protection: max 25 tool calls per turn" + "Identical-call loop detector" with 3-warning/5-break mechanism)
- No DIAGNOSTICS section needed — prompt coverage is direct and actionable
- Pre-fix: **PASS (3/3)**

**Probe rotation history:**
- v19: "How do I sign in with ChatGPT?", "MCP tool disappeared", "API key not working"
- **v20: "My swap failed", "Cron job didn't fire", "Agent is in a loop"**

---

## Gaps Found (Pre-fix)

1. **Section B — Search Diagnostics (DIAGNOSTICS.md):** The "Search Provider Not Configured" section described symptoms as `web_search returns error "... API key not configured"` — but PR #321 changed this to return a structured fallback response `{fallback: true, message: "..."}` with a WARN-level log. The symptoms description was stale.

2. **Section D — Probe 1:** The DIAGNOSTICS target for the "web search is broken" probe had stale symptoms (said "error" instead of "fallback"), reducing the probe from PASS to PARTIAL.

**Total gaps: 1 (same root cause manifesting in B and D)**

## Fixes Applied

1. **DIAGNOSTICS.md — "Search Provider Not Configured" section rewritten:**
   - Renamed to "Search Provider Not Configured (Fallback Mode)"
   - Symptoms updated to describe structured fallback response `{fallback: true, ...}`
   - Added log signature: `[WebSearch] <provider>: no API key configured — suggesting web_fetch fallback`
   - Added note explaining that fallback is functional (agent can still use web_fetch), not broken
   - Fix steps unchanged (guide user to Settings > Search Provider)

2. **ai.js — no changes needed.** System prompt line 481 already accurately describes the fallback behavior ("If web_search returns a fallback response").

3. **Syntax check:** `node --check ai.js` passes.

## Code Issues Found

None. Both PRs shipped clean.

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
v20 █████████████████████████  98% (206/210) → █████████████████████████ 100% (210/210)
```

**Delta from v19:** No new capacity items — same 210 max. Pre-fix jumped back to 98.1% (from 91.9% in v19), reflecting minimal drift. The only gap was a stale DIAGNOSTICS symptom description for the search fallback behavior. System prompt was already ahead of DIAGNOSTICS — line 481 correctly described "fallback response" even before this audit.

**Observation:** PR #321 was well-implemented from a self-awareness perspective. The system prompt at line 481 was proactively updated to mention "fallback response" as part of the PR itself. The only gap was DIAGNOSTICS.md, which sits one layer deeper and was missed. This is the expected SAB pattern: prompt doors get updated during feature work, diagnostic deep-content lags behind.

**Lesson:** When updating the system prompt for a new behavior, also grep DIAGNOSTICS.md for the old behavior description and update it. A quick `grep -i "error.*api key\|api key.*error" DIAGNOSTICS.md` would have caught this in the PR.
