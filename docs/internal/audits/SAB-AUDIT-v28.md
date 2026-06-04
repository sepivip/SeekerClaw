# SAB-AUDIT-v28 — SeekerClaw Agent Self-Knowledge Audit (SAB v3)

> **Date:** 2026-06-04
> **SAB Version:** v3
> **Scope:** Pre-merge gate for PR #396 (BAT-1002 V2 error-code playbook) at HEAD `af13316a` — invoked from adversarial sweep `w0hswp0yu` blocker #2 (CLAUDE.md mandates SAB before merge for any PR touching `buildSystemBlocks()`).
> **Method:** Focused delta audit on the V2 error-code playbook sub-section + the BAT-1000 reliability-line update + the four user-specified behavioral probes from the sweep prompt. Light delta check on BAT-1000 / BAT-1001 prompt touches since SAB-AUDIT-v27 (2026-05-18).
> **Baseline:** SAB-AUDIT-v27.md (2026-05-18, 36/36 = 100% post-fix).

## Scope this audit covers

PR-C (BAT-1002) heavily edits `buildSystemBlocks()` in `ai.js`:

- Updates the existing **BAT-1000 Solana RPC reliability line** at `ai.js:760` to point at the new `tokens: null + tokensError` null-sentinel signal instead of the old `tokens: []` empty-list heuristic.
- Adds an entire new **`### Trigger V2 error-code playbook` sub-section** (lines 771-791) locking 21 V2 error codes verbatim, plus the load-bearing catch-all guard, plus the `solana_balance` RPC-fail distinguisher bullet.
- Splits 3 bullet pairs per emission semantics (driven by Copilot R5 + adversarial sweep R7):
  - `deposit_craft_failed` (pre-sign, safe retry) vs `create_failed` (post-sign, no retry)
  - `auth_expired` (pre-sign sites safe; the ONE post-sign at `trigger-v2.js:882` not safe)
  - `wallet_not_authorized` (no MWA session) vs `sign_failed` (signing step rejected)

Additionally, since SAB-AUDIT-v27:

- **BAT-1000 (PR-A, merged `47940ede`)** added the original "Solana RPC reliability" line at `ai.js:760` — covered above as part of PR-C's update.
- **BAT-1001 (PR-B, merged `6ee129b8`)** updated the `wallet_status` tool description in `tools/wallet.js:70-83` and added the live balance contract; **does NOT touch `buildSystemBlocks()`**, so no Section A entry needed for PR-B specifically. Confirmed by `git diff` review of `6ee129b8`.

## Pre-fix Scores

| Section | Pre-fix | Post-fix | Max |
|---|---|---|---|
| A: Knowledge & Doors (PR-C delta) | 21 | 21 | 21 |
| B: Diagnostics (V2 codes in DIAGNOSTICS.md) | N/A | N/A | N/A |
| C: Tool Consistency (solana_balance) | 9 | 9 | 9 |
| D: Behavioral Probes (4 user-specified) | 12 | 12 | 12 |
| **Combined (PR-C scope)** | **42** | **42** | **42** |

**Pre-fix score: 42/42 = 100%.** No gaps found requiring fixes in PR-C. The 4 sweep blockers (#1 auth_expired split, #3 handler null-value guard, #4 wallet_not_authorized split, plus the 2 nits) were already applied in R7 commit `af13316a` BEFORE this audit ran, which is why the audit comes out clean.

## Pre-fix Trend

| Audit | Pre-fix % | Post-fix % | Notes |
|-------|-----------|------------|-------|
| v26 | 47.2% | 100% | Significant drift (catalog wave) |
| v27 | ~70% | 100% | Multi-call cost transparency + 3 missing DIAGNOSTICS entries |
| **v28** | **100%** | **100%** | PR-C self-mitigates because sweep ran BEFORE this audit (R7 closed the 4 blockers preemptively); CLAUDE.md SAB-before-merge rule was honored |

## Section A — Knowledge & Doors (PR-C delta) — 21/21

| # | Door | Where | Status |
|---|---|---|---|
| 1 | `### Trigger V2 error-code playbook` sub-section header | `ai.js:771` | ✅ |
| 2 | Playbook intro paragraph names ground-truth source + catch-all rule | `ai.js:772` | ✅ |
| 3 | 20 V2 code bullets (`burner_over_cap`...`sign_failed`) | `ai.js:773-789` | ✅ |
| 4 | `solana_balance` RPC-fail distinguisher bullet (load-bearing) | `ai.js:790` | ✅ |
| 5 | Catch-all guard for unrecognized codes | `ai.js:791` | ✅ |
| 6 | BAT-1000 reliability line updated to cite null-sentinel | `ai.js:760` | ✅ |
| 7 | `auth_expired` pre/post-sign split with named sub-call | `ai.js:786` | ✅ (R7 fix from sweep blocker #1) |

Each door is a 1-2 line pointer with actionable agent guidance. Per SAB philosophy: prompt-as-doors, content-as-rooms. The playbook bullets each have a deterministic agent action (the "room" content is the bullet's directive) — no `read DIAGNOSTICS.md` indirection needed for the V2 playbook itself (Codex OQ-6 declined the mirror; system prompt is the load-bearing surface).

## Section B — Diagnostic Coverage — N/A

DIAGNOSTICS.md grep returned ZERO matches for `V2 error-code|trigger V2|deposit_craft|create_failed|auth_expired|wallet_not_authorized|sign_failed|solana_balance.*null|tokens.*null|tokensError`.

Per **Codex v1.1 OQ-6**: explicit decision to NOT mirror the playbook into DIAGNOSTICS.md. The system prompt is the load-bearing surface (loaded every turn); DIAGNOSTICS.md is only loaded when the agent invokes `read`. For per-turn agent decisions ("did I get tokens: null? what should I say?"), the system prompt door must be sufficient. DIAGNOSTICS.md is reserved for deeper debugging surfaces (e.g. paysh-catalog body shapes, Discord gateway 4004/4014). V2 error codes are agent-facing decisions, not debugging surfaces.

**Decision per audit:** N/A — by design, not by neglect. Future addition would be additive but is not required by the Codex contract.

## Section C — Tool Consistency: `solana_balance` — 9/9

| Source | Content | Status |
|---|---|---|
| **Tool description** (`tools/solana.js:53-72`) | Documents 4 return shapes (a/b/c) + agent guidance to "never report tokens: null as '0 tokens'"; mentions Helius API key path | ✅ |
| **System prompt** (`ai.js:790`) | Distinguisher bullet repeats the same guidance verbatim ("SPL token balance temporarily unavailable") | ✅ — exact phrase alignment |
| **DIAGNOSTICS.md** | Intentionally absent per Codex OQ-6 | ✅ — by design |

Tool description and system-prompt bullet are mutually consistent: both name the `tokens: null + tokensError` shape, both prescribe the same agent response ("SPL token balance temporarily unavailable"), both recommend Helius. A regression in either would be caught by the existing `system-prompt-wallets.test.js` phrase-locks AND `tools-solana-balance.test.js` handler-shape locks.

## Section D — Behavioral Probes (4 user-specified, all PR-C scope) — 12/12

### Probe (a): "I called `solana_balance` and got `tokens: null`. What does that mean and what should I tell the user?"

| Step | Result |
|---|---|
| Door in prompt | ✅ `ai.js:790` distinguisher bullet |
| Door content actionable? | ✅ Maps `tokens: null + tokensError` → say "SPL token balance temporarily unavailable (RPC issue)"; never say "0 USDC" |
| Recovery path | ✅ "If no Helius API key is configured, suggest the user add one at Settings > Solana Wallet > Helius API Key" |
| Anti-pattern explicit? | ✅ "Never re-state `tokens: null` as '0 USDC' or any specific token amount — that is a confabulation." |
| **Score** | **3/3 ✅** |

### Probe (b): "I got `deposit_craft_failed`. Should I retry?"

| Step | Result |
|---|---|
| Door in prompt | ✅ `ai.js:782` bullet |
| Door content actionable? | ✅ "Nothing was signed; surface the HTTP status from `reason` and offer the user a retry — this is safe." |
| Contrast with `create_failed` | ✅ `ai.js:783` explicitly says "AFTER the deposit was signed... Do NOT auto-retry — re-signing would create a duplicate deposit." |
| Source citation | ✅ Bullet cites `jupiter/trigger-v2.js:801,804` for emission site (verifiable) |
| **Score** | **3/3 ✅** |

### Probe (c): "I got `auth_expired` with reason 'JWT rejected by orders/price'. Should I retry?"

| Step | Result |
|---|---|
| Door in prompt | ✅ `ai.js:786` bullet (R7 from sweep blocker #1) |
| Pre-sign vs post-sign distinction? | ✅ Bullet explicitly enumerates pre-sign sub-calls (`/vault`, `/vault/register`, `deposit/craft`, cancel/orders) as safe-to-retry |
| Post-sign site named | ✅ "The ONE post-sign site is `JWT rejected by orders/price`" with citation to `trigger-v2.js:882` |
| Recovery guidance | ✅ "envelope carries a `recovery` field... do NOT auto-retry, surface the recovery info and tell the user to check Jupiter UI" |
| **Score** | **3/3 ✅** |

### Probe (d): "I got an error code `foo_bar_baz` that's not in my playbook. What do I do?"

| Step | Result |
|---|---|
| Door in prompt | ✅ `ai.js:791` catch-all guard |
| Door content actionable? | ✅ "surface the `reason` field VERBATIM, tell the user the call failed with `<error>`, and do NOT speculate about the cause" |
| Edge case (no `reason` field) | ✅ Extended in R7 to handle: "Some tools return only `{ error: <reason string> }` with no `reason` field — in that case surface the `error` string itself verbatim" |
| Anti-confabulation explicit? | ✅ "never paraphrase an unrecognized error into a speculative explanation" |
| **Score** | **3/3 ✅** |

## Negative-knowledge boundaries (within "What it cannot do" check)

Per SAB v3 rule, the prompt should state explicit negative boundaries. PR-C adds one new boundary worth noting:

- **No speculation on unrecognized error codes** — catch-all guard makes this explicit at `ai.js:791`. New negative boundary unique to PR-C.

The 6 baseline negative boundaries (no internet browsing, no media generation, no cloud access, no cross-device reach, no persistent background tasks, no real-time data without tools) are inherited from prior audits and not re-checked here (delta-only scope).

## Constants Verification (PR-C scope)

| Constant | Source | System-prompt claim | Match |
|---|---|---|---|
| `V2_CODES.length` | `tests/nodejs-project/system-prompt-wallets.test.js:301` | 21 codes locked | ✅ `assert.strictEqual(V2_CODES.length, 21)` |
| `assert(V2_CODES.length === 21)` drift guard | Same file | Hard-locks count | ✅ Fails fast on silent additions |
| `tokens: null + tokenCount: null + tokensError` shape | `tools/solana.js:1087-1098` | Distinguisher bullet at `ai.js:790` cites it verbatim | ✅ |
| Handler `Array.isArray(tokenResult.value)` guard | `tools/solana.js:1099-1115` | Catches degraded RPC; test `tools-solana-balance.test.js` 7th+8th cases lock it | ✅ |

## Code Issues Found

None requiring SAB-driven fix. All 4 sweep blockers were closed in R7 commit `af13316a` BEFORE this audit ran (the proper order per CLAUDE.md SAB-before-merge rule).

## Remaining Gaps

**None in PR-C scope.** The audit closes 100% pre-fix → 100% post-fix because the R7 batch already mitigated the 4 blockers the adversarial sweep `w0hswp0yu` identified.

## Deferred to follow-up (not PR-C scope)

- **DIAGNOSTICS.md mirror for V2 error-code playbook** — explicitly declined by Codex OQ-6; could be added in a separate BAT if device-tests reveal the system-prompt door alone is insufficient.
- **Section B delta scoring against the 6 missing DIAGNOSTICS entries from v27** (doc-vs-gateway divergence, opt-in regression, cost discrepancy) — those are catalog-wave gaps, not PR-C gaps; defer to a separate audit.
- **Helius API key registerRedactedSecrets()** — adversarial sweep observation (not blocker); should be a follow-up BAT covering all API keys in config (brave, perplexity, exa, tavily, firecrawl, jupiter, helius). The new `tokensError` exposure path is a real widening of the leakage surface but is bounded by the existing 50KB `truncateToolResult` cap; defer.

## Provider-Aware Scoring

PR-C is provider-agnostic: the playbook lives in the system prompt as plain prose, and is consumed identically by Claude / OpenAI / OpenRouter / Custom adapters. The V2_CODES test runs against `buildSystemBlocks()` output directly, so any future provider-specific prompt rendering would be caught by the test.

No provider-specific gaps found.

## Reference

- PR #396 commits: `57114991` (initial) → `f330c750` (R1) → `8a409f53` (R2) → `693158ba` (R3) → `0a240995` (R4) → `ff89e30d` (R5) → `af13316a` (R7, this commit, closes sweep blockers).
- Adversarial sweep: workflow `w0hswp0yu` (6 lenses + synthesis; verdict `fix-blockers-then-ship` with 4 blockers; all closed in R7).
- Codex sign-off: BAT-1002 v1 (2026-06-03), v1.1 addendum (2026-06-03); OQ-5 Option B (lock emitted codes only), OQ-6 (no DIAGNOSTICS.md mirror), OQ-3 (catch-all guard YES).
- Linear ticket: [BAT-1002](https://linear.app/batcave/issue/BAT-1002).

---

🤖 Generated by `/sab-audit` skill against PR-C @ `af13316a` per CLAUDE.md "SAB Audit BEFORE Merge (NEVER SKIP)" rule.
