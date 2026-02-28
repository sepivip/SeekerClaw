# SAB-AUDIT-v7 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-02-28
> **Scope:** Re-audit after BAT-277 (OpenClaw parity 2026.2.26), BAT-278 (formatting fix), BAT-279 (HEARTBEAT_OK), BAT-280 (OpenClaw parity 2026.2.28), BAT-289 (API error reasons), BAT-291 (markdown-it parser)
> **Method:** Full read of buildSystemBlocks() + constants verification + diagnostic coverage map
> **Baseline:** SAB-AUDIT-v6.md (111/111, 100%)

---

## Overall Scorecard

| Section | Score | Max | Percentage | Delta |
|---------|-------|-----|-----------|-------|
| A: Knowledge & Doors | 63 | 63 | 100% | — (held) |
| B: Diagnostic Coverage | 48 | 48 | 100% | — (held after fix) |
| **Combined** | **111** | **111** | **100%** | — |

Scoring: ✅ = 3 pts, ⚠️ = 1 pt, ❌ = 0 pts.

---

## Constants Verification

| Constant | Code Value | Prompt Claim | Match |
|----------|-----------|-------------|-------|
| MAX_TOOL_USES | 25 (claude.js:1484) | "Up to 25 tool-call rounds" (line 802) | ✅ |
| MAX_HISTORY | 35 (claude.js:174) | "35 messages per chat" (line 801) | ✅ |
| max_tokens | 4096 (claude.js:1505) | "4096 tokens per response" (line 803) | ✅ |
| SHELL_ALLOWLIST | 34 commands (config.js:234-241) | 34 commands listed (line 637) | ✅ |
| SECRETS_BLOCKED | config.json, config.yaml, seekerclaw.db (config.js:225) | seekerclaw.db listed as BLOCKED (line 555) | ✅ |

No changes to constants since v6.

---

## Section A: Knowledge & Doors (21 items)

All 21 items from v6 held at ✅. No regressions.

### Changes Since v6

6 PRs shipped since the v6 audit (2026-02-25). Each evaluated against the 3-part door test:

| PR | Change | New Door? | Reason |
|----|--------|-----------|--------|
| #193 (BAT-277) | OpenClaw parity 2026.2.26 — 5 internal bug fixes | No | Internal fixes; no new agent-facing capability |
| #194 (BAT-278) | Telegram italic/bold regex fix | No | Superseded by BAT-291; internal rendering |
| #196 (BAT-279) | HEARTBEAT_OK protocol improvement | No (already covered) | Prompt already updated with examples (lines 700-713) |
| #197 (BAT-289) | API error reasons in user-facing messages | No | Internal error classification; agent doesn't need to know format |
| #198 (BAT-280) | Tool-first guidance + OpenClaw parity 2026.2.28 | No (already covered) | Line added to prompt (line 429) |
| #199 (BAT-291) | Replace regex with markdown-it parser | No | Transparent rendering change; agent uses same markdown syntax |

**No new doors needed.** Item count remains at 21.

### Full Item Scores

**Identity (5/5)**

| # | Item | v5 | v6 | v7 | Notes |
|---|------|----|----|-----|-------|
| 1 | Own name/version | ✅ | ✅ | ✅ | Lines 375-376 |
| 2 | Model | ✅ | ✅ | ✅ | PLATFORM.md (auto-generated) |
| 3 | Device/hardware | ✅ | ✅ | ✅ | PLATFORM.md |
| 4 | Who built it | ✅ | ✅ | ✅ | Line 377 (OpenClaw) |
| 5 | Official channels | — | ✅ | ✅ | Line 378 (seekerclaw.xyz, @SeekerClaw, t.me/seekerclaw, GitHub) |

**Architecture (4/4)**

| # | Item | v5 | v6 | v7 | Notes |
|---|------|----|----|-----|-------|
| 6 | Node↔Kotlin bridge | ✅ | ✅ | ✅ | Lines 382-387 |
| 7 | UI vs :node process | ✅ | ✅ | ✅ | Lines 384-385 |
| 8 | Health monitoring | ✅ | ✅ | ✅ | Lines 577-582 |
| 9 | Telegram polling | ✅ | ✅ | ✅ | Lines 441-446 |

**Capabilities (4/4)**

| # | Item | v5 | v6 | v7 | Notes |
|---|------|----|----|-----|-------|
| 10 | Full tool list | ✅ | ✅ | ✅ | Lines 397-421 |
| 11 | Sandboxed tools | ✅ | ✅ | ✅ | Lines 415-416 |
| 12 | What it cannot do | ✅ | ✅ | ✅ | Lines 782-787 |
| 13 | Skills load/trigger | ✅ | ✅ | ✅ | Lines 459-477 |

**Configuration (4/4)**

| # | Item | v5 | v6 | v7 | Notes |
|---|------|----|----|-----|-------|
| 14 | Config files | ✅ | ✅ | ✅ | Lines 544-556 |
| 15 | Settings agent can change | ✅ | ✅ | ✅ | Lines 558-574 |
| 16 | API keys needed | ✅ | ✅ | ✅ | Lines 560-562 |
| 17 | Model/heartbeat change | ✅ | ✅ | ✅ | Line 547 |

**Self-Diagnosis (4/4)**

| # | Item | v5 | v6 | v7 | Notes |
|---|------|----|----|-----|-------|
| 18 | Health stale | ✅ | ✅ | ✅ | Lines 625-630 |
| 19 | Telegram disconnects | ✅ | ✅ | ✅ | Lines 612-618 |
| 20 | Skill fails | ✅ | ✅ | ✅ | Lines 619-624 |
| 21 | Conversation corruption | ✅ | ✅ | ✅ | Lines 631-635 |

**Section A Total: 63/63 (100%)**

---

## Section B: Diagnostic Coverage (16 failure modes)

### Pre-Fix Finding

**MCP Rate Limit Exceeded** (DIAGNOSTICS.md line 177): Stated "30 calls/minute per server, 100 calls/minute global" but actual code values are `DEFAULT_RATE_LIMIT = 10` and `GLOBAL_RATE_LIMIT = 50` (mcp-client.js:14-15). Scored ⚠️ (1 pt) pre-fix.

**Fix applied:** Updated DIAGNOSTICS.md to "10 calls/minute per server (configurable), 50 calls/minute global".

### Post-Fix Scores

| # | Subsystem | Failure Mode | v5 | v6 | v7 | Coverage Location |
|---|-----------|-------------|----|----|-----|-------------------|
| 1 | Telegram | Bot token invalid/revoked | ✅ | ✅ | ✅ | DIAGNOSTICS.md §Telegram |
| 2 | Telegram | Rate limited (429) | ✅ | ✅ | ✅ | DIAGNOSTICS.md §Telegram |
| 3 | Claude API | Transport timeout | ✅ | ✅ | ✅ | DIAGNOSTICS.md §Claude API |
| 4 | Claude API | Context overflow | ✅ | ✅ | ✅ | DIAGNOSTICS.md §Claude API |
| 5 | Tools | Confirmation gate timeout | ✅ | ✅ | ✅ | System prompt lines 498-503 |
| 6 | Tools | Tool result truncated | ✅ | ✅ | ✅ | DIAGNOSTICS.md §Tools |
| 7 | Memory | memory_save fails (fs full) | ✅ | ✅ | ✅ | DIAGNOSTICS.md §Memory |
| 8 | Memory | memory_search returns nothing | ✅ | ✅ | ✅ | System prompt lines 506-512 |
| 9 | Cron | Job fails to send reminder | ✅ | ✅ | ✅ | DIAGNOSTICS.md §Cron |
| 10 | Cron | Jobs lost after restart | ✅ | ✅ | ✅ | DIAGNOSTICS.md §Cron |
| 11 | Bridge | Service down (ECONNREFUSED) | ✅ | ✅ | ✅ | DIAGNOSTICS.md §Bridge |
| 12 | Bridge | Permission-specific errors | ✅ | ✅ | ✅ | DIAGNOSTICS.md §Bridge |
| 13 | MCP | Server unreachable | ✅ | ✅ | ✅ | DIAGNOSTICS.md §MCP |
| 14 | MCP | Tool definition changed (rug-pull) | ✅ | ✅ | ✅ | DIAGNOSTICS.md §MCP |
| 15 | MCP | Rate limit exceeded | ✅ | ✅ | ✅ | DIAGNOSTICS.md §MCP (values fixed) |
| 16 | Skills | Requirements not met | ✅ | ✅ | ✅ | DIAGNOSTICS.md §Skills |

**Section B Total: 48/48 (100%)**

### New Failure Modes Check

| PR | Potential Failure Mode | Assessment |
|----|----------------------|------------|
| BAT-291 (markdown-it) | Parser error on malformed input | markdown-it is battle-tested, never throws on valid string input. `stripMarkdown()` fallback provides defense-in-depth. No new failure mode. |
| BAT-289 (API error reasons) | Markdown injection via error message | Sanitized with `.replace(/[*_\`\[\]()~>#+\-=\|{}.!]/g, '')` and truncated to 200 chars. No new failure mode. |

No new failure modes to add.

---

## Gaps Fixed

| File | Line | Issue | Fix |
|------|------|-------|-----|
| DIAGNOSTICS.md | 177 | MCP rate limit values wrong (30/100 → should be 10/50) | Updated to "10 calls/minute per server (configurable), 50 calls/minute global" |

---

## Code Issues Found

None.

---

## Remaining Gaps

**None.** All 21 knowledge items and all 16 diagnostic failure modes score ✅.

---

## Observations

1. **BAT-291 (markdown-it)** is the largest change since v6 but requires no system prompt update. The agent writes markdown (`**bold**`, `*italic*`, etc.) and the rendering pipeline is transparent. The Telegram Formatting section (lines 449-456) correctly instructs the agent to use markdown syntax.

2. **BAT-279 (HEARTBEAT_OK)** improved the prompt with explicit examples of correct/incorrect heartbeat replies. This directly addresses a real-world issue where the agent was mixing alert text with the HEARTBEAT_OK token, causing alerts to be silently discarded.

3. **BAT-280** added tool-first guidance — "When a first-class tool exists for an action, use the tool directly instead of asking the user to run equivalent CLI or slash commands." This is OpenClaw parity (2026.2.28).

4. **Minor note:** The Telegram Formatting section (line 454) lists `**bold**, _italic_, \`code\`, \`\`\`code blocks\`\`\` and blockquotes` but does not mention `~~strikethrough~~` or `[links](url)`, both of which are supported. This is not scored as a gap (agent uses these naturally, users won't ask about them), but could be added for completeness in a future pass.

---

## Score Progression

```
        Knowledge (Section A)               Diagnostics (Section B)
v1  ████████████████████░░░░░░░░░░  42/60  (70%)    (not audited)
v2  ████████████████████████████░░  56/60  (93%)    (not audited)
v3  ██████████████████████████████  60/60 (100%)    (not audited)
v4  ██████████████████████████████  60/60 (100%)    ██████████████████████████████  48/48 (100%)
v5  ██████████████████████████████  60/60 (100%)    ██████████████████████████████  48/48 (100%)
v6  ██████████████████████████████  63/63 (100%)    ██████████████████████████████  48/48 (100%)
v7  ██████████████████████████████  63/63 (100%)    ██████████████████████████████  48/48 (100%)

Combined SAB Score:
v1  ██████████████████████████████░░░░░░░░░░░░░░░░░░░░  42/60   (70%)
v2  ██████████████████████████████████████████████░░░░  56/60   (93%)
v3  ██████████████████████████████████████████████████  60/60  (100%)
v4  ██████████████████████████████████████████████████ 108/108 (100%)
v5  ██████████████████████████████████████████████████ 108/108 (100%)  [SHELL_ALLOWLIST 22→34]
v6  ██████████████████████████████████████████████████ 111/111 (100%)  [+Official channels]
v7  ██████████████████████████████████████████████████ 111/111 (100%)  [DIAGNOSTICS.md MCP rate fix]
```

---

## Methodology

- **Source-only audit** — all scores derived from code reads, no runtime testing
- **Files read:** claude.js buildSystemBlocks() (lines 335-860), config.js (SHELL_ALLOWLIST line 234, SECRETS_BLOCKED line 225), mcp-client.js (rate limits lines 14-15), telegram.js (formatting pipeline), DIAGNOSTICS.md (full), SAB-AUDIT-v6.md (baseline)
- **Constants verified:** MAX_TOOL_USES=25, MAX_HISTORY=35, max_tokens=4096, SHELL_ALLOWLIST=34 commands, SECRETS_BLOCKED=3 files
- **Git diff reviewed:** 6 PRs (#193, #194, #196, #197, #198, #199) since v6 baseline
- **DIAGNOSTICS.md fix:** MCP rate limit values corrected (30/100 → 10/50)
