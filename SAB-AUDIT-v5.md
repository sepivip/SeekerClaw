# SAB-AUDIT-v5 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-02-24
> **Scope:** Re-audit after BAT-261 (app launch awareness, screencap, expanded shell allowlist)
> **Method:** Full read of buildSystemBlocks() + constants verification post-merge
> **Baseline:** SAB-AUDIT-v4.md (108/108, 100%)

---

## Overall Scorecard

| Section | Score | Max | Percentage | Delta |
|---------|-------|-----|-----------|-------|
| A: Knowledge & Doors | 60 | 60 | 100% | — (held) |
| B: Diagnostic Coverage | 48 | 48 | 100% | — (held) |
| **Combined** | **108** | **108** | **100%** | — |

Scoring: ✅ = 3 pts, ⚠️ = 1 pt, ❌ = 0 pts.

---

## Constants Verification (post BAT-261)

| Constant | Code Value | Prompt Claim | Match |
|----------|-----------|-------------|-------|
| MAX_TOOL_USES | 25 (claude.js:1461) | "Up to 25 tool-call rounds" (line 784) | ✅ |
| MAX_HISTORY | 35 (claude.js:174) | "35 messages per chat" (line 783) | ✅ |
| max_tokens | 4096 (claude.js:1481) | "4096 tokens per response" (line 785) | ✅ |
| SHELL_ALLOWLIST | **34 commands** (config.js:234-241) | **34 commands listed** (line 626) | ✅ |
| SECRETS_BLOCKED | config.json, config.yaml, seekerclaw.db (config.js:225) | seekerclaw.db listed as BLOCKED (line 542) | ✅ |

**SHELL_ALLOWLIST change:** 22 → 34 commands. Added: `touch`, `diff`, `sed`, `cut`, `base64`, `stat`, `file`, `sleep`, `getprop`, `md5sum`, `sha256sum`, `screencap`. Both code (config.js:234-241) and prompt (claude.js:626) list all 34.

---

## Section A: Knowledge & Doors (20 items)

All 20 items held at ✅ from v4. No regressions.

### New Doors Evaluation

BAT-261 shipped 3 capability changes. Each tested against the 3-part door test:

| Feature | Changes capability? | Users ask about it? | Wrong answer without door? | Door needed? |
|---------|-------------------|--------------------|-----------------------------|-------------|
| App launch awareness (android_apps_list/launch) | Yes | Yes | No — door added in BAT-261 (line 392) | Already added |
| Screenshots via screencap | Yes | Yes | No — door added in BAT-261 (line 393) | Already added |
| Expanded shell allowlist (12 new commands) | Yes | Maybe | No — allowlist in prompt updated (line 626) | Already added |

**Result:** BAT-261 added both the capability AND the prompt coverage simultaneously. No post-hoc door needed. Total remains 20 items (max 25).

---

## Section B: Diagnostic Coverage (16 failure modes)

All 16 failure modes held at ✅ from v4. No regressions.

BAT-261 does not introduce any new failure modes — app launching and screencap use existing subsystems (Bridge for apps, shell_exec for screencap) which are already covered.

---

## Gaps Fixed

None needed. BAT-261 shipped code + prompt + manifest changes together, keeping everything in sync.

---

## Code Issues Found

None.

---

## Remaining Gaps

**None.** All 20 knowledge items and all 16 diagnostic failure modes score ✅.

---

## Score Progression

```
        Knowledge (Section A)               Diagnostics (Section B)
v1  ████████████████████░░░░░░░░░░  42/60  (70%)    (not audited)
v2  ████████████████████████████░░  56/60  (93%)    (not audited)
v3  ██████████████████████████████  60/60 (100%)    (not audited)
v4  ██████████████████████████████  60/60 (100%)    ██████████████████████████████  48/48 (100%)
v5  ██████████████████████████████  60/60 (100%)    ██████████████████████████████  48/48 (100%)

Combined SAB Score:
v1  ██████████████████████████████░░░░░░░░░░░░░░░░░░░░  42/60   (70%)
v2  ██████████████████████████████████████████████░░░░  56/60   (93%)
v3  ██████████████████████████████████████████████████  60/60  (100%)
v4  ██████████████████████████████████████████████████ 108/108 (100%)
v5  ██████████████████████████████████████████████████ 108/108 (100%)  [SHELL_ALLOWLIST 22→34]
```

---

## Methodology

- **Source-only audit** — all scores derived from code reads, no runtime testing
- **Files read:** claude.js buildSystemBlocks() (lines 335-853), config.js (SHELL_ALLOWLIST updated to 34 commands), AndroidManifest.xml (new `<queries>` block), SAB-AUDIT-v4.md (baseline)
- **Constants verified:** MAX_TOOL_USES=25, MAX_HISTORY=35, max_tokens=4096, SHELL_ALLOWLIST=34 commands, SECRETS_BLOCKED=3 files
- **Key finding:** BAT-261 shipped capability + prompt updates together — no sync gap. SHELL_ALLOWLIST increased from 22 to 34 commands, all reflected in prompt.
