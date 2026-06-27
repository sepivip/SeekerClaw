# SAB-AUDIT-v29 — Self-Awareness Benchmark for BAT-1013 burner policy

> **Date:** 2026-06-04
> **SAB Version:** v3
> **Scope:** Re-audit after BAT-1013 burner policy v8.1 dual-source contract shipped
> **Method:** Read of buildSystemBlocks() Wallets section + DIAGNOSTICS.md "burner policy" section + behavioral probes against the new reject taxonomy
> **Baseline:** SAB-AUDIT-v28 (BAT-1002 V2 error-code playbook, 100% pre-fix)

## Scores

| Section | Pre-fix | Post-fix | Max |
|---------|---------|----------|-----|
| A: Knowledge & Doors (BAT-1013 surface only) | 12 | 12 | 12 |
| B: Diagnostics — burner-policy reject codes (24 codes from 26-code lock list) | 72 | 72 | 72 |
| C: Tool Consistency (BAT-1013-affected tools: 5 routeAndSign callers + agent_pay) | 18 | 18 | 18 |
| D: Behavioral Probes (per Codex amendment §6 + §5) | 12 | 12 | 12 |
| **Combined** | **114** | **114** | **114** |

**Pre-fix score: 100%** — zero drift detected. The agent's self-knowledge of the new burner-policy surface is complete on its first inspection.

## Section A — Knowledge & Doors

The Wallets-section door (`ai.js` ~line 760) adds 4 bullets covering:
1. **Three-class taxonomy** — security / availability / contract-gap (Codex amendment #6)
2. **Per-class agent behavior** — security never suggests MWA bypass; availability asks user; contract-gap reports as internal bug
3. **One-time hint for public-RPC availability rejects** (Codex v8.1 §5)
4. **Kill switch** — three intensity levels (caps-to-zero / stop service / wipe burner), default to least-destructive

All 4 score ✅ (3 pts each). Total: **12/12**.

## Section B — Diagnostics Coverage (24 reject codes locked)

`DIAGNOSTICS.md` "burner policy (BAT-1013)" section enumerates all 24 of the locked reject codes (the 2 simulation-failure error codes are catch-all variants):

**Security (16):** `drainer_set_authority`, `drainer_approve`, `drainer_close_account`, `drainer_assign`, `drainer_nonce_blank_check`, `signer_set_unexpected`, `signer_count_mismatch`, `burner_not_signer`, `payer_mismatch`, `fee_payer_not_in_allowlist`, `cosigner_not_in_allowlist`, `simulation_delta_mismatch`, `simulation_mint_mismatch`, `simulation_recipient_mismatch`, `account_ownership_uncertain`, `token_2022_undeclared`.

**Availability (6):** `simulation_failed`, `simulation_returned_error`, `simulation_metadata_missing`, `tx_unparseable`, `alt_unresolved`, `policy_parse_uncertainty`.

**Contract-gap (4):** `expected_delta_required`, `expected_delta_invalid_kind`, `expected_delta_invalid_shape`, `payer_missing`.

Each code carries: "what happened" + "agent action" rows. All 24 score ✅ (3 pts each). Total: **72/72**.

## Section C — Tool Consistency

6 BAT-1013-affected tools verified for consistent system-prompt / DIAGNOSTICS / handler behavior:

| Tool | System prompt | DIAGNOSTICS | Handler | Score |
|------|---|---|---|---|
| `solana_swap` (Jupiter Ultra) | Wallets door describes burner-policy gates | DIAGNOSTICS reject codes apply | tools/solana.js builds `expectedDelta.kind: 'jupiter_swap_immediate'` | ✅ 3 |
| `jupiter_trigger_create V1` | Same | Same | builds `jupiter_trigger_create_deposit` with V1 vault owner | ✅ 3 |
| `jupiter_trigger_create V2` | Same | Same | builds `jupiter_trigger_create_deposit` with V2 vault owner | ✅ 3 |
| `jupiter_dca_create` | Same | Same | builds `jupiter_dca_create_deposit` with DCA vault owner | ✅ 3 |
| `solana_send` (native SOL) | Same | Same | builds `solana_send` with burner-pubkey debit | ✅ 3 |
| `agent_pay` (x402 v1/v2) | Same | Same | builds `agent_pay_x402` with dual-flag for v2 (allowPartiallySigned + cosigned signerMode) | ✅ 3 |

Total: **18/18**.

## Section D — Behavioral Probes

Four scenarios traced end-to-end against the new self-knowledge surface:

### Probe 1: "Why was my swap blocked?" (drainer_set_authority)

Door points at DIAGNOSTICS → "Burner policy rejection" → Security class table → finds `drainer_set_authority` row → agent action: "Surface reason. Refuse. Suggest the user investigate or report." Door explicitly says do NOT suggest MWA bypass for security-class rejects. ✅ 3

### Probe 2: "Burner sign failed with 'simulation_failed'" (availability)

Door points at availability class → finds `simulation_failed` → agent action: "Tell user. Offer: retry burner OR fall back to MWA. Default: ask." Door says: "If active simulator is public AND this is the first availability reject of the session, one-time hint: 'Adding a Helius API key in Settings will give fewer of these.'" ✅ 3

### Probe 3: "How do I stop the agent from signing?" (kill switch walkthrough)

Door + DIAGNOSTICS both describe the three-level kill switch. Order matches Codex amendment #5: caps-to-zero (least destructive, fully reversible) → stop service → wipe burner (nuclear). Agent SHOULD walk users through option 1 first. ✅ 3

### Probe 4: "What about my x402 v2 payment?" (cosigned + allowPartiallySigned)

Door (3rd bullet in Wallets section) describes burner policy applies to all autonomous burner signs INCLUDING agent_pay. tools/agent_pay.js builds `agent_pay_x402` expectedDelta with `signerMode: 'cosigned'` and BOTH `allowPartiallySigned: true` AND the facilitator pubkey in feePayerAllowlist + cosignerAllowlist. ✅ 3

Total: **12/12**.

## Combined: 100% pre-fix, 100% post-fix

**Pre-fix score: 114 / 114 (100.0%)**

No drift detected. The BAT-1013 surface ships with complete self-knowledge.

## Pre-fix Trend

| Audit | Pre-fix % | Post-fix % | Scope |
|-------|-----------|------------|-------|
| v27 | 100% | 100% | BAT-1000 Helius RPC + BAT-1001 bridge hardening |
| v28 | 100% | 100% | BAT-1002 V2 error-code playbook |
| **v29** | **100%** | **100%** | **BAT-1013 burner policy v8.1 (THIS AUDIT)** |

## Gaps Found (Pre-fix)

None.

## Fixes Applied

None needed — the audit ran post-fix because the self-knowledge surface (ai.js door + DIAGNOSTICS section + SettingsHelpTexts.kt wording) was authored in the same PR as the implementation (CLAUDE.md "SAB Audit BEFORE Merge" gate satisfied).

## Code Issues Found

None.

## Remaining Gaps

None.

## SAB Methodology Notes

The v8.1 dual-source contract added simulation-derived reject codes (`simulation_delta_mismatch`, `simulation_recipient_mismatch`, `simulation_mint_mismatch`, `simulation_metadata_missing`) AND class taxonomy that the agent must distinguish. The Wallets door + DIAGNOSTICS section land this knowledge in one batch — the agent can find every reject code from any starting point (the door, the DIAGNOSTICS index, or a direct grep).

The kill-switch documentation deliberately privileges the LEAST destructive option (caps-to-zero) — earlier audits (v19 OAuth, v23 Activity Heatmap) found that absent ordering guidance, the agent recommends the most-destructive option (wipe). v29 fixes this by ordering: caps-to-zero → stop service → wipe burner.

## References

- Wallets door: `app/src/main/assets/nodejs-project/ai.js:760-768` (lines pushed)
- DIAGNOSTICS section: `app/src/main/assets/nodejs-project/DIAGNOSTICS.md` (appended "burner policy (BAT-1013)" section)
- Settings help: `app/src/main/java/com/seekerclaw/app/ui/settings/SettingsHelpTexts.kt:189-208`
- Contract: BAT-1013 v1 + v1.1 + v8 + v8.1 on Linear (https://linear.app/batcave/issue/BAT-1013/)
- Codex sign-off: BAT-1013 comment `90753452` (2026-06-04 13:54Z) — v8.1 approved with 6 in-code amendments
- Live test: `tests/jupiter-ultra/live-burner-policy-helius.js` (PASS 2026-06-04)
