# SAB-AUDIT-v39 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-06-29
> **SAB Version:** v3
> **Scope:** Pre-merge gate for BAT-1050 (PR #415) — Telegram **Rich Messages** (Bot API 10.1) + a **Settings toggle**, default ON. Touches `buildSystemBlocks()` (new Telegram formatting block, both rich-ON and rich-OFF branches) and `DIAGNOSTICS.md` (Rich fallback + systemPlain sections), and ships a user-visible AI capability — all three SAB triggers.
> **Method:** Focused audit on the Rich-Messages surface (doors ↔ DIAGNOSTICS ↔ behavioral probes), plus standing-sanity on constants. Branch `feature/BAT-1050-telegram-rich-messages` @ `a65a6fed`.
> **Baseline:** SAB-AUDIT-v38.md (BAT-1067, 100%).

## Scores

| Section | Pre-fix | Post-fix | Max |
|---------|---------|----------|-----|
| A: Knowledge & Doors (rich capability + toggle config door + safety boundary) | 9 | 9 | 9 |
| B: Diagnostics (Rich fallback + systemPlain expected-behavior) | 6 | 6 | 6 |
| C: Tool Consistency (telegram_send — rich path is internal/transparent) | 3 | 3 | 3 |
| D: Behavioral Probes (turn-off, why-plain, why-notices-plain) | 9 | 9 | 9 |
| **Combined** | **27 (100%)** | **27 (100%)** | **27** |

**Pre-fix is 100% — no drift, and notably no SAB-stage fixes were required.** This is the SAB gate working as intended: the one self-awareness gap this feature would otherwise have shipped — *the agent not knowing where the on/off control lives* — was caught by the **pre-merge adversarial review** (4-lens, self-awareness lens) and fixed **in this same PR** at commit `a65a6fed` (the toggle-location door was added to both prompt branches) **before** this audit ran. SAB confirms there is nothing left to fix.

## Section A — Knowledge & Doors (9/9)
- ✅ **Rich-formatting capability door** (`ai.js` rich-ON branch): the agent is told Rich Messages are ON and exactly which constructs render — `##` headings, tables, task lists, `>` blockquotes, `==marked==`, `||spoiler||`, `$…$`/`$$…$$` math, fenced code **with a language tag**. Accurate to the on-device behavior verified in device testing.
- ✅ **Safety boundary** (`ai.js`): "Do NOT use raw HTML tags (`<details>`, `<sub>`, `<sup>`, `<tg-*>`) — shown as literal text." Matches the posture-A sanitizer (raw HTML escaped; only `https`/`mailto` links render; `send_file` for media since `![](…)` is neutered). The agent won't promise HTML-only constructs it can't deliver.
- ✅ **Toggle config door (both branches):** rich-ON branch tells the agent the user can **turn Rich Messages off** in *Settings → Channel → Telegram → Rich Messages (restart applies)*; rich-OFF branch tells it the user can **enable** it there. This is the gap the adversarial review caught — the agent can now answer "how do I stop the tables / make replies plain?".
- ✅ No stale values introduced; constants sane (`MAX_HISTORY = 35`, `SHELL_ALLOWLIST` present).

## Section B — Diagnostics (6/6)
- ✅ **"Rich Messages Falling Back to Classic Formatting (BAT-1050)"** — symptoms, a `grep` check command, and a diagnosis of every fallback log line (`unsupported`, `failed (fallback/transient)`, `transport error → no-double-delivery`), plus the fix (none needed; or toggle off + restart). Correctly states default-ON + precedence (toggle > env > default).
- ✅ **"System Notices Render Plain Even With Rich On (expected)"** — explains heartbeat / back-online / status-bubble / auto-resume notices stay plain by design (systemPlain), so a user/agent doesn't mistake it for a bug.

## Section C — Tool Consistency (3/3)
- ✅ `telegram_send` — the rich-vs-classic decision is **internal** (driven by `RICH_MESSAGES_ENABLED` in the send path), transparent to the agent: it writes markdown, the system renders it. No rich-specific claim in the tool description to drift against; the formatting guidance correctly lives in `buildSystemBlocks()`, not the tool schema. Redaction parity (`redactSecrets`) preserved. The BAT-1067 navigation-only `buttons` guard is unchanged.

## Section D — Behavioral Probes (9/9)
- ✅ **"How do I turn off the tables / rich formatting?"** → door at the rich-ON branch names *Settings → Channel → Telegram → Rich Messages* + the restart requirement. Actionable.
- ✅ **"Why are my replies plain / not rich?"** → DIAGNOSTICS "Rich Messages Falling Back to Classic" gives symptoms + `grep` + per-line diagnosis + fix.
- ✅ **"Why do heartbeat / status notices look plain even with Rich on?"** → DIAGNOSTICS "System Notices Render Plain (expected)" answers it as intended behavior.

## Regression coverage
`tests/nodejs-project/rich-markdown.test.js` (posture-A sanitizer incl. paren-URL cases), `rich-messages-default.test.js` (default-ON + precedence truth-table + drift guard on the `config.js` expression and the no-stale-`default-OFF`-comment invariant), `telegram-rich-send.test.js`, `telegram-no-double-delivery.test.js`, `telegram-systemplain.test.js` — all wired into `build.yml` + `ci-coverage-manifest`. Full Node suite 72/72.

## Upgrade safety
Default-ON resolves for existing users without persisting `false` (ConfigManager defaults true end-to-end; SetupScreen carries `richMessages` forward on Run-Setup-Again — device-verified). No state/schema migration.

## Code issues found
None. (The adversarial review's findings — SetupScreen round-trip + the two stale "default-OFF" comments — were already fixed in this PR at `a65a6fed`.)

## Remaining gaps
None. Post-fix 100%.

## Pre-fix Trend
| Audit | Pre-fix % | Post-fix % |
|-------|-----------|------------|
| v36 (BAT-1062) | — | 100% |
| v37 | — | 100% |
| v38 (BAT-1067) | 25% | 100% |
| **v39 (BAT-1050)** | **100%** | **100%** |
