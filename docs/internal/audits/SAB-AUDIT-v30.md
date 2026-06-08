# SAB-AUDIT-v30 — Self-Awareness Benchmark for BAT-1013 burner-policy followup

> **Date:** 2026-06-05
> **SAB Version:** v3
> **Scope:** Re-audit after BAT-1013 followup added three new security-class reject codes (`drainer_burn`, `token_2022_extension_unsupported`, `token_2022_send_unsupported`), policy-internal fields (`wsolAtaExemption`, `allowedBurnAccounts`, `tokenStandardConfig`), DCA-to-MWA fallback, slot-drift wrap, and burner-pubkey cache invalidation behavior.
> **Method:** Read of `buildSystemBlocks()` Wallets door + DIAGNOSTICS.md "burner policy (BAT-1013)" section + SettingsHelpTexts.kt + 4 behavioral probes against the followup surface.
> **Baseline:** SAB-AUDIT-v29 (BAT-1013 burner policy v8.1, 114/114 = 100% pre-fix → 100% post-fix).

## Changes Since v29 That Triggered v30

| Change | Description | SAB Impact |
|---|---|---|
| `drainer_burn` reject code | New security-class code: SPL Burn / BurnChecked on burner-owned ATA. Accept-path keyed on policy-internal `allowedBurnAccounts`. | **Critical** — new named door + new DIAGNOSTICS row required |
| `token_2022_extension_unsupported` | New security-class code: Token-2022 extension opcode (PermanentDelegate, TransferHook) detected. | **Critical** — new door + row |
| `token_2022_send_unsupported` | New security-class code: Token-2022 send/pay without caller-declared `tokenStandardConfig.transferFeeBps`. Previous 50% tolerance was a skim window, now fail-closed. Agent must recommend MWA fallback. | **Critical** — new door + row + behavioral exception (MWA fallback is OK here, unlike other security-class codes) |
| `wsolAtaExemption` + `allowedBurnAccounts` | Policy-internal forensic fields surfaced in reject reason logs. | **Critical** — agent guidance needed: do NOT surface raw field names to users |
| DCA create → MWA fallback | `jupiter_dca_create` routes to MWA popup instead of burner; burner DCA unsupported pending vault discovery. | Moderate — known-limitation note needed |
| Slot-drift wrap | Slot-drift cases surface as `simulation_failed` in the availability bucket, not as a distinct code. | Moderate — vocabulary precision needed |
| Burner pubkey cache invalidation | Pubkey re-verified against `/burner/status` every sign; wipe + reimport works without restart. | Moderate — explicit behavioral note in DIAGNOSTICS |

---

## Overall Scorecard

| Section | Pre-fix | Post-fix | Max | Pre-fix % | Post-fix % |
|---------|---------|----------|-----|-----------|------------|
| A: Knowledge & Doors (8 followup items) | 1 | 24 | 24 | 4.2% | 100% |
| B: Diagnostics — 3 new reject-code rows | 0 | 9 | 9 | 0% | 100% |
| C: Tool Consistency | N/A | N/A | N/A | N/A | N/A |
| D: Behavioral Probes (4 probes) | 1 | 12 | 12 | 8.3% | 100% |
| **Combined** | **2** | **45** | **45** | **4.4%** | **100%** |

**Pre-fix verdict:** Material drift. The followup BAT-1013 surface shipped reject codes, policy-internal fields, and a Token-2022 fail-closed limitation with **almost zero** self-knowledge coverage. The only partial credit (1/12 in probes, 1/24 in doors) came from the HELIUS_API_KEY tooltip directionally covering the slot-drift case via the umbrella "fails closed under public RPC pressure" phrasing — without naming `simulation_failed` or the slot-drift specifically.

This is a repeat of the BAT-500 / BAT-485 pattern: a critical extension to an already-audited feature surface shipped without re-running SAB. The original v29 audit ran when the feature was complete-as-designed; the followup extension added named codes and behavioral exceptions that need their own door, and that re-audit was missed until v30.

**Pre-fix % at 4.4%** — the lowest in SAB history. Fully attributable to a missed audit re-run, not a deeper drift pattern.

---

## Section A: Knowledge & Doors (1 → 24 pre-fix, 24 post-fix)

Followup added **8 self-knowledge items** at 3 points each = 24 max.

### Pre-fix state

| Item | Pre-fix | Reason |
|---|---|---|
| `drainer_burn` named in security class enumeration | 0 | Only covered by `drainer_*` glob; no named door, no behavioral guidance for the marker-burn accept-path |
| `token_2022_extension_unsupported` named in security class | 0 | Entirely absent; no extension-opcode taxonomy |
| `token_2022_send_unsupported` named in security class + MWA-fallback exception | 0 | Absent; the 50% → fail-closed flip and MWA-fallback recommendation invisible |
| `wsolAtaExemption` marked as policy-internal (do not surface) | 0 | Absent; agent would leak forensic field name to users |
| `allowedBurnAccounts` marked as policy-internal | 0 | Absent; marker-burn accept-path invisible |
| Token-2022 send/pay fail-closed limitation (followup note) | 0 | Undocumented; agent cannot tell user to fall back to MWA for Token-2022 |
| Slot-drift detection vocabulary | 1 | HELIUS_API_KEY tooltip directionally covers via "fails closed under public RPC pressure"; partial credit, slot-drift not named |
| Burner-pubkey cache invalidation behavior | 0 | Absent across all three files |

Total pre-fix: **1 / 24**

### Post-fix state

Applied 4 targeted bullet additions in the Wallets-section door (`ai.js` line 765–768):

1. Three new codes appended to security enumeration with the MWA-fallback exception for `token_2022_send_unsupported`.
2. `simulation_failed` slot-drift wrap explicitly named in the availability bullet.
3. Policy-internal-fields bullet covering `wsolAtaExemption`, `allowedBurnAccounts`, `tokenStandardConfig`, with the rule "do NOT surface raw field names to the end user."
4. Burner-pubkey cache invalidation behavior added to the kill-switch bullet ("After wipe + reimport, the burner pubkey is re-verified against `/burner/status` on the next autonomous sign — no app restart required").

Token budget impact: ~140 tokens added to a Wallets door that was already ~600 tokens. All 8 items now name-grep-discoverable from the door or directly answered in-prompt.

Total post-fix: **24 / 24**

---

## Section B: Diagnostics — 3 new reject-code rows (0 → 9 pre-fix, 9 post-fix)

Three new rows required at 3 points each = 9 max.

### Pre-fix state (0/9)

DIAGNOSTICS.md security-class table covered the original 16 reject codes from v29 but contained no row for `drainer_burn`, `token_2022_extension_unsupported`, or `token_2022_send_unsupported`. The "policy-internal fields" subsection did not exist. The "BAT-1013-followup limitations" subsection did not exist.

### Post-fix state (9/9)

Inserted three new rows in the security-class table (after `token_2022_undeclared`):

| Code | What happened | Agent action |
|---|---|---|
| `drainer_burn` | SPL Burn / BurnChecked on burner-owned ATA; accept-path keyed on `allowedBurnAccounts` | Surface verbatim, refuse, suggest investigate/report |
| `token_2022_extension_unsupported` | Token-2022 extension opcode (PermanentDelegate, TransferHook, etc.) | Refuse, explain extensions need manual MWA approval, do NOT retry autonomously |
| `token_2022_send_unsupported` | solana_send / agent_pay_x402 to Token-2022 mint without `tokenStandardConfig.transferFeeBps`; 50% tolerance removed | Refuse burner path, tell user to retry via MWA for Token-2022 sends |

Also added two new subsections:

- **"Policy-internal fields (do not surface to users)"** — table covering `wsolAtaExemption`, `allowedBurnAccounts`, `tokenStandardConfig.transferFeeBps` with agent guidance to explain in plain language rather than quoting field names.
- **"BAT-1013-followup limitations"** — 4 items: Token-2022 fail-closed default, DCA-to-MWA fallback, slot-drift wrapped as `simulation_failed`, burner-pubkey cache invalidation behavior.

Total post-fix: **9 / 9**

---

## Section C: Tool Consistency (N/A)

No new tools added in this followup. `expectedDelta` policy-shape additions (Token-2022 extension detection, declared `allowedBurnAccounts`) are Android-side / policy-side, not new Node tools. Excluded from scoring per task spec.

---

## Section D: Behavioral Probes (1 → 12 pre-fix, 12 post-fix)

Four scenarios × 3 pts each = 12 max.

### Probe 1: "My swap was blocked with `drainer_close_account` — what happened?"

**Pre-fix:** Agent finds `drainer_close_account` row in DIAGNOSTICS, explains it generically. But it cannot cite the Jupiter Ultra wSOL wrap/unwrap exemption (`wsolAtaExemption`) as the case where this is a false-positive-shaped accept — so it may tell the user it's a legitimate block when the policy actually had the wSOL exemption recorded. Score: 0/3.

**Post-fix:** Wallets door explicitly says policy-internal `wsolAtaExemption` may appear in the reason log and the agent should NOT quote it raw but should explain it in plain language ("this was a Jupiter Ultra unwrap, accepted as legitimate"). DIAGNOSTICS policy-internal-fields subsection gives the field semantics. Agent now traces door → DIAGNOSTICS → correct explanation. Score: 3/3.

### Probe 2: "Can I autonomously burn SPL tokens?"

**Pre-fix:** `drainer_burn` is unnamed. `allowedBurnAccounts` is unnamed. Agent has no vocabulary for the caller-declared marker-burn accept-path vs. the burner-USDC-trade-ATA reject-path. Likely answer: "I think burns are blocked" with no detail on the accept-path. Score: 0/3.

**Post-fix:** Door enumerates `drainer_burn`. DIAGNOSTICS row describes "Legitimate protocol marker burns (e.g., zero-value cancel flows) are accepted only when the target account is listed in policy `allowedBurnAccounts`". Agent can now answer: "Autonomous burns from your burner are refused by default. Protocol marker burns from declared accounts (like zero-value cancel flows in some DEXes) are accepted because they're listed in the policy whitelist." Score: 3/3.

### Probe 3: "Why can't I send Token-2022 tokens autonomously?"

**Pre-fix:** `token_2022_send_unsupported` is absent. `token_2022_undeclared` exists but communicates the wrong semantic (missing declaration vs. fail-closed-pending-config). Agent misdiagnoses: "you need to declare your tokenStandard" — wrong. Correct answer is "autonomous Token-2022 send is fail-closed; retry via MWA." Score: 0/3.

**Post-fix:** Door names `token_2022_send_unsupported` with the MWA-fallback exception explicit. DIAGNOSTICS row + BAT-1013-followup limitations item #1 both describe the 50%-tolerance removal and the MWA-fallback recommendation. Agent now answers correctly: "Autonomous Token-2022 sends are currently refused (the previous tolerance was a known skim window). Use main wallet (MWA) for Token-2022 sends until per-mint fee declaration lands." Score: 3/3.

### Probe 4: "My swap failed with simulation_failed under public RPC"

**Pre-fix:** Agent can pull from HELIUS_API_KEY tooltip that public-RPC fail-closed → recommend Helius. Directionally correct but cannot name slot-drift specifically or explain the simulation_failed wrap. Score: 1/3.

**Post-fix:** Door availability bullet names slot-drift as a sub-case of `simulation_failed`. DIAGNOSTICS BAT-1013-followup limitations item #3 explicitly: "Slot-drift surfaces as `simulation_failed`. There is no separate slot_drift user-visible code today. User-visible fix: add a Helius API key." SettingsHelpTexts.kt HELIUS_API_KEY now also names slot-drift explicitly. Agent can answer with precise vocabulary: "This is the slot-drift case in the availability bucket — public RPC's account snapshots and simulation slots drifted apart. Add a Helius API key in Settings." Score: 3/3.

Total post-fix: **12 / 12**

---

## Combined: 4.4% pre-fix, 100% post-fix

**Pre-fix score: 2 / 45 (4.4%)**
**Post-fix score: 45 / 45 (100.0%)**

---

## Pre-fix Trend

| Audit | Pre-fix % | Post-fix % | Scope |
|-------|-----------|------------|-------|
| v27 | 100% | 100% | BAT-1000 Helius RPC + BAT-1001 bridge hardening |
| v28 | 100% | 100% | BAT-1002 V2 error-code playbook |
| v29 | 100% | 100% | BAT-1013 burner policy v8.1 |
| **v30** | **4.4%** | **100%** | **BAT-1013 followup (3 new reject codes, policy-internal fields, Token-2022 fail-closed, slot-drift wrap, pubkey cache invalidation)** |

---

## Gaps Found (Pre-fix)

11 gaps total (8 door items + 3 DIAGNOSTICS rows; policy-internal-fields and limitations subsections cover multiple gaps each, so the unique-fix count is lower).

1. `drainer_burn` missing from system-prompt security enumeration → fix in `ai.js` line 765.
2. `token_2022_extension_unsupported` missing from system-prompt security enumeration → fix in `ai.js` line 765.
3. `token_2022_send_unsupported` missing from system-prompt security enumeration; MWA-fallback exception undocumented → fix in `ai.js` line 765.
4. `wsolAtaExemption` not flagged as policy-internal in the prompt → fix in `ai.js` (new bullet between contract-gap and kill-switch lines).
5. `allowedBurnAccounts` not flagged as policy-internal → covered by same `ai.js` bullet as gap 4.
6. Token-2022 send/pay fail-closed limitation undocumented in DIAGNOSTICS → fix in DIAGNOSTICS new "BAT-1013-followup limitations" subsection.
7. `drainer_burn` reject row missing from DIAGNOSTICS security-class table → fix in DIAGNOSTICS new row.
8. `token_2022_extension_unsupported` reject row missing → fix in DIAGNOSTICS new row.
9. `token_2022_send_unsupported` reject row missing → fix in DIAGNOSTICS new row.
10. Slot-drift vocabulary not explicit in HELIUS_API_KEY tooltip nor in DIAGNOSTICS → fix in `SettingsHelpTexts.kt` (1-sentence precision add) + DIAGNOSTICS followup limitations item #3 + `ai.js` availability bullet.
11. Burner-pubkey cache invalidation undocumented → fix in `ai.js` kill-switch bullet + DIAGNOSTICS followup limitations item #4.

---

## Fixes Applied

| File | Change | Lines |
|---|---|---|
| `app/src/main/assets/nodejs-project/ai.js` | Appended `drainer_burn`, `token_2022_extension_unsupported`, `token_2022_send_unsupported` to security-class enumeration with MWA-fallback exception for the last; named slot-drift wrap on availability bullet; new bullet flagging `wsolAtaExemption` / `allowedBurnAccounts` / `tokenStandardConfig` as policy-internal (do not surface raw field names); added burner-pubkey cache-invalidation note to kill-switch bullet. | ~765–768 (4 bullets modified, 1 added) |
| `app/src/main/assets/nodejs-project/DIAGNOSTICS.md` | 3 new rows in burner-policy security-class table; new "Policy-internal fields (do not surface to users)" subsection; new "BAT-1013-followup limitations" subsection (4 items). | ~818 + ~820 + ~857 (3 inserts) |
| `app/src/main/java/com/seekerclaw/app/ui/settings/SettingsHelpTexts.kt` | Appended 1-sentence slot-drift precision to HELIUS_API_KEY tooltip ("account snapshots and simulation slots drift … surfaces as `simulation_failed`"). | ~206 (4 lines added) |

Verified `node --check ai.js` after edits — syntax OK.

---

## Code Issues Found

None during this audit. The followup is a pure self-knowledge layer over an already-audited (v29) implementation.

---

## Remaining Gaps

None.

---

## SAB Methodology Notes

**Lesson:** When a feature surface gets a followup extension that adds named codes, behavioral exceptions, or policy-internal fields, the original SAB audit is no longer canonical. The followup needs its own audit pass.

v29 ran when BAT-1013 was complete-as-designed at v8.1. The followup added `drainer_burn` / Token-2022 extension/send taxonomy + the policy-internal-fields concept + Token-2022 fail-closed semantics — all of which are observable in the agent's behavior. The follow-up rule (analogous to BAT-485 OAuth post-merge fix): "any extension to an audited surface re-runs SAB before merge, not after."

**Exception handling in the security class:** v30 introduces the first explicit MWA-fallback exception inside the security class (`token_2022_send_unsupported`). The general rule — "security class never falls back to MWA" — remains, but the agent must distinguish "suspicious tx (don't bypass)" from "known fail-closed limitation (MWA is the supported path)". The door now carries this distinction inline.

**Policy-internal-fields concept:** v30 introduces a new pattern — fields that exist in the reject reason payload but should not be quoted verbatim to users. The agent must explain the underlying meaning in plain language. This is a general design principle going forward: any policy-internal forensic field surfaced in logs should be marked in DIAGNOSTICS with explicit "do not surface" guidance.

---

## References

- Wallets door followup: `app/src/main/assets/nodejs-project/ai.js:765-769`
- DIAGNOSTICS new rows: `app/src/main/assets/nodejs-project/DIAGNOSTICS.md` (security-class table + Policy-internal fields subsection + BAT-1013-followup limitations subsection)
- SettingsHelpTexts.kt slot-drift sentence: `app/src/main/java/com/seekerclaw/app/ui/settings/SettingsHelpTexts.kt:HELIUS_API_KEY constant`
- Baseline: `docs/internal/audits/SAB-AUDIT-v29.md`
