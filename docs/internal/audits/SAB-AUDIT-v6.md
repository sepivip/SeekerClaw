# SAB-AUDIT-v6 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-02-25
> **Scope:** Re-audit after BAT-263 (official SeekerClaw socials added to identity)
> **Method:** Full read of buildSystemBlocks() + constants verification
> **Baseline:** SAB-AUDIT-v5.md (108/108, 100%)

---

## Overall Scorecard

| Section | Score | Max | Percentage | Delta |
|---------|-------|-----|-----------|-------|
| A: Knowledge & Doors | 63 | 63 | 100% | +3 (new item) |
| B: Diagnostic Coverage | 48 | 48 | 100% | — (held) |
| **Combined** | **111** | **111** | **100%** | +3 |

Scoring: ✅ = 3 pts, ⚠️ = 1 pt, ❌ = 0 pts.

---

## Constants Verification

| Constant | Code Value | Prompt Claim | Match |
|----------|-----------|-------------|-------|
| MAX_TOOL_USES | 25 (claude.js:1464) | "Up to 25 tool-call rounds" (line 788) | ✅ |
| MAX_HISTORY | 35 (claude.js:174) | "35 messages per chat" (line 787) | ✅ |
| max_tokens | 4096 (claude.js:1485) | "4096 tokens per response" (line 789) | ✅ |
| SHELL_ALLOWLIST | **34 commands** (config.js:234-241) | **34 commands listed** (line 627) | ✅ |
| SECRETS_BLOCKED | config.json, config.yaml, seekerclaw.db (config.js:225) | seekerclaw.db listed as BLOCKED (line 545) | ✅ |

No changes to constants since v5.

---

## Section A: Knowledge & Doors (21 items)

Previous 20 items held at ✅ from v5. No regressions.

### New Door: Official Channels (Identity)

BAT-263 added 1 line to the identity section (claude.js:369):

```
Official channels — Website: seekerclaw.xyz · X: @SeekerClaw · Telegram: t.me/seekerclaw · GitHub: github.com/sepivip/SeekerClaw
```

**3-part door test:**

| Test | Result |
|------|--------|
| Changes what the agent can do? | Yes — can now direct users to official channels |
| Users likely to ask about it? | Yes — "where do I follow SeekerClaw?" |
| Wrong answer without it? | Yes — would hallucinate or say "I don't know" |

**Score:** ✅ (3 pts) — all 4 links verified against README.md and PROJECT.md

**Identity category:** 4 → 5 items (Own name/version, Model, Device/hardware, Who built it, **Official channels**)

**SAB audit skill updated:** `sab-audit/skill.md` baseline changed from 20→21 items, Identity (4)→(5). Note: skill file lives in `.claude/skills/` (project-level, outside git tree) — updated separately.

---

## Section B: Diagnostic Coverage (16 failure modes)

All 16 failure modes held at ✅ from v5. No regressions.

BAT-263 does not introduce any new failure modes — official channels are static strings in the system prompt with no runtime dependencies.

---

## Gaps Fixed

None needed beyond the new door addition.

---

## Code Issues Found

None.

---

## Remaining Gaps

**None.** All 21 knowledge items and all 16 diagnostic failure modes score ✅.

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

Combined SAB Score:
v1  ██████████████████████████████░░░░░░░░░░░░░░░░░░░░  42/60   (70%)
v2  ██████████████████████████████████████████████░░░░  56/60   (93%)
v3  ██████████████████████████████████████████████████  60/60  (100%)
v4  ██████████████████████████████████████████████████ 108/108 (100%)
v5  ██████████████████████████████████████████████████ 108/108 (100%)  [SHELL_ALLOWLIST 22→34]
v6  ██████████████████████████████████████████████████ 111/111 (100%)  [+Official channels]
```

---

## Methodology

- **Source-only audit** — all scores derived from code reads, no runtime testing
- **Files read:** claude.js buildSystemBlocks() (lines 335-853), config.js (SHELL_ALLOWLIST, line 234), SAB-AUDIT-v5.md (baseline)
- **Constants verified:** MAX_TOOL_USES=25, MAX_HISTORY=35, max_tokens=4096, SHELL_ALLOWLIST=34 commands, SECRETS_BLOCKED=3 files
- **Links verified against:** README.md (line 100), PROJECT.md (lines 236-241)
- **Audit skill updated:** sab-audit/skill.md baseline 20→21 items, Identity (4)→(5) — skill file is in `.claude/skills/` (outside git tree), updated separately
