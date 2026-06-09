# SAB-AUDIT-v31 — Foundation patch self-knowledge audit

> **Date:** 2026-06-05
> **SAB Version:** v3
> **Scope:** Foundation patch on PR #398 — adds `source` param to solana_send, main-wallet-connected awareness, Helius-configured awareness, AccountLoadedTwice translation, self-send guards (handler + policy).
> **Method:** Read of `buildSystemBlocks()` Wallets + Tooling sections + DIAGNOSTICS.md updates + 3 behavioral probes covering the new doors.
> **Baseline:** SAB-AUDIT-v30 (BAT-1013 followup, 45/45 = 100%)
> **Trigger:** PR #398 touches `buildSystemBlocks()`, `DIAGNOSTICS.md`, adds new error codes (`main_wallet_not_connected`, `self_send_rejected`, `over_burner_cap`), and ships new user-visible capability (the `source` param). All three CLAUDE.md SAB-trigger conditions met.

## Changes Since v30 That Triggered v31

| Change | Description | SAB Impact |
|---|---|---|
| `source` param on `solana_send` | New schema enum: 'burner'/'main'/'auto'. Lets agent honor user's "from main" intent instead of cap-only routing. | **Critical** — new tool-schema door; agent must know when to use it |
| Pre-flight: `main_wallet_not_connected` tool error | Fires when source='main' (explicit) and main not connected, OR auto+main-not-connected+burner-not-configured. Replaces cryptic AccountLoadedTwice | **Critical** — new error code, distinct from REJECT_CODES |
| Self-send guard (handler + policy) | Handler returns `self_send_rejected`; policy returns `expected_delta_invalid_shape` for both solana_send and agent_pay_x402 | **Critical** — new error class; agent must distinguish self-send from other shape errors |
| `heliusConfigured` snapshot field | /burner/status now exposes `heliusConfigured` + `activeRpc`. Wallets section conditionalizes Helius recommendation on this. | Moderate — agent no longer falsely recommends Helius when configured |
| AccountLoadedTwice translation | DIAGNOSTICS row for `simulation_returned_error` now translates `AccountLoadedTwice` to plain language | Low — extends existing pattern (InsufficientFundsForFee translation) |

---

## Overall Scorecard

| Section | Pre-fix | Post-fix | Max | Pre-fix % | Post-fix % |
|---------|---------|----------|-----|-----------|------------|
| A: Knowledge & Doors (4 new items) | 0 | 12 | 12 | 0% | 100% |
| B: Diagnostics (1 new tool-error class with 3 codes) | 0 | 9 | 9 | 0% | 100% |
| C: Tool Consistency (`source` param on solana_send) | 0 | 3 | 3 | 0% | 100% |
| D: Behavioral Probes (3 probes) | 1 | 9 | 9 | 11.1% | 100% |
| **Combined** | **1** | **33** | **33** | **3.0%** | **100%** |

**Pre-fix verdict:** Material drift. The foundation patch introduced 4 new self-knowledge items, 3 new error codes, and 1 new tool-schema parameter with **zero** self-awareness coverage at the prompt level. This is the same pattern as v30 (which scored 4.4% pre-fix on the BAT-1013-followup surface) — features ship with code and tests, but the prompt/DIAGNOSTICS layer needs explicit catch-up.

**Pre-fix 3.0%** — second-lowest in SAB history (after v30's 4.4%). Both v30 and v31 were caught and fixed in the SAME PR per CLAUDE.md "SAB Audit BEFORE Merge" rule.

---

## Section A: Knowledge & Doors (0 → 12 pre-fix, 12 post-fix)

### Items audited (4)

| Item | Pre-fix | Post-fix | Evidence |
|---|---|---|---|
| `source` param on solana_send tool schema | 0 (no schema mention; agent had no way to express user's "from main" intent) | 3 (tool description explicitly documents the param; system prompt at line 776 tells agent when to use it: "When user says 'from main' → `source=\"main\"`") | tools/solana.js:151-160 + ai.js:776 |
| `mainWalletConnected` / main-not-connected awareness | 0 (no surface state about main wallet's connection status) | 3 (door in Wallets section + DIAGNOSTICS tool-handler error row + translation rule) | DIAGNOSTICS.md "Tool-handler errors" table |
| `heliusConfigured` snapshot field | 0 (prompt unconditionally recommended Helius even when configured) | 3 (conditional in ai.js: lines 759-763 — when `heliusConfigured` true, says "Active RPC is Helius (configured). Do NOT recommend adding a Helius key") | ai.js:759-763 |
| Self-send guard error class | 0 (cryptic AccountLoadedTwice surfaced raw to user) | 3 (DIAGNOSTICS translation rule + tool-handler error row for `self_send_rejected`) | DIAGNOSTICS.md `simulation_returned_error` row + "Tool-handler errors" table |

---

## Section B: Diagnostics (0 → 9 pre-fix, 9 post-fix)

### New tool-handler error class (3 codes at 3 pts each)

| Code | Pre-fix | Post-fix | Evidence |
|---|---|---|---|
| `main_wallet_not_connected` | 0 (didn't exist; generic error string surfaced) | 3 (DIAGNOSTICS row with translation + action) | DIAGNOSTICS.md tool-handler table |
| `self_send_rejected` | 0 (cryptic AccountLoadedTwice surfaced raw) | 3 (DIAGNOSTICS row + translation + suggest source="main") | DIAGNOSTICS.md tool-handler table |
| `over_burner_cap` | 0 (no explicit code for source='burner' over-cap path) | 3 (DIAGNOSTICS row + guidance: lower amount or omit source) | DIAGNOSTICS.md tool-handler table |

**Important distinction documented:** these are tool-handler errors, NOT in `REJECT_CODES` (the locked enum for `validateBurnerTx` rejects only). `REJECT_CODES.length` was 29 at v31 audit time and is lowered to 28 in BAT-1031 (the `simulation_recipient_mismatch` code was removed when the v9.1 `validateSimDelta expectedTokenOwner` branch was deleted alongside the depositVault destination-binding architecture — see Linear BAT-1031 v1.2). Drift guard test now asserts `REJECT_CODES.length === 28`.

---

## Section C: Tool Consistency (0 → 3 pre-fix, 3 post-fix)

### `source` param on solana_send (1 item at 3 pts)

| Aspect | Pre-fix | Post-fix |
|---|---|---|
| Schema present | 0 (no param) | 3 (enum: burner/main/auto + description) |
| Description tells agent when to use | 0 | 3 (tool description: "Use `source=\"main\"` when the user EXPLICITLY says 'from main'") |
| System prompt cross-reference | 0 | 3 (ai.js: "**solana_send `source` param:** when the user says 'from main' → use `source=\"main\"`") |

**Verified:** description + prompt + schema all agree. No drift.

---

## Section D: Behavioral Probes (1 → 9 pre-fix, 9 post-fix)

### Probe 1: "Send 0.001 SOL to ABC from my main wallet specifically"

| | Pre-fix | Post-fix |
|---|---|---|
| Path | Agent has no mechanism to specify source; routing is cap-based only. Likely routes to burner if under cap, ignoring user's explicit intent. | Agent reads system-prompt guidance → uses `source="main"` parameter → MWA popup |
| Score | 0 | 3 |

### Probe 2: "Why am I getting AccountLoadedTwice when I try to send 0.02 SOL from main to burner?"

| | Pre-fix | Post-fix |
|---|---|---|
| Path | Agent quotes raw JSON: `simulation failed on-chain: AccountLoadedTwice`. No translation; recommends checking RPC or adding Helius (wrong cause). | Agent reads DIAGNOSTICS translation rule → "The transaction references the same account as both sender and recipient. Pick a different recipient address. (If you wanted to fund the burner FROM main, ask: send X SOL from main to burner — I'll use source='main'.)" |
| Score | 0 | 3 |

### Probe 3: "Should I add a Helius API key?"

| | Pre-fix | Post-fix |
|---|---|---|
| Path | Agent always recommends adding (static text); when Helius IS configured, this confuses the user ("but I already have one set"). | Agent checks `snap.heliusConfigured` from snapshot. If configured: "Helius is already set; all RPC reads go through your private endpoint." If not: existing recommendation. |
| Score | 1 (partial: agent would respond about Helius but with wrong direction) | 3 |

---

## Combined Pre-fix Trend

| Audit | Pre-fix % | Post-fix % | Scope |
|-------|-----------|------------|-------|
| v29 | 100% | 100% | BAT-1013 burner-policy baseline |
| v30 | 4.4% | 100% | BAT-1013-followup (new reject codes + expectedDelta fields) |
| **v31** | **3.0%** | **100%** | Foundation patch (source param + self-awareness + translation rules) |

---

## Gaps Found (Pre-fix)

1. **No mechanism for user-directed routing**: `solana_send` schema had no `source` param. Agent could not express "from main" intent → forced through cap-based routing → with low-amount burner-routable sends to the burner address, produced AccountLoadedTwice.
2. **No awareness of main wallet connection state**: agent had no snapshot field for `mainWalletConnected`; pre-flight check was absent in the handler.
3. **No awareness of Helius configuration state**: static recommendation text in prompt; never conditioned on actual configured state.
4. **AccountLoadedTwice surfaced raw**: DIAGNOSTICS row for `simulation_returned_error` only translated `InsufficientFundsForFee`; AccountLoadedTwice fell through to raw quote.
5. **Self-send pattern not documented**: no error code for "you tried to send to yourself"; cryptic on-chain error was the only signal.

---

## Fixes Applied (in this PR)

1. **tools/solana.js**: added `source` param to schema + handler that respects it via `forceRouting` + main-not-connected pre-flight + self-send handler-level guard.
2. **wallet/burner-policy.js**: defense-in-depth self-send shape check in both `solana_send` and `agent_pay_x402` cases — rejects as `expected_delta_invalid_shape`.
3. **ai.js**: conditional Helius prompt text (heliusConfigured-aware) + AccountLoadedTwice + self-send + main-wallet-not-connected guidance in Wallets/Tooling sections + new "Tool-handler errors" section.
4. **app/.../BurnerBridgeEndpoints.kt**: `isHeliusConfigured` lambda constructor param + wired in production constructor via `ConfigManager.getSolanaRpcUrl(...).contains("helius")` + populated `heliusConfigured` + `activeRpc` in `/burner/status` response body + added both fields to `responseAllowlist`.
5. **DIAGNOSTICS.md**: extended `simulation_returned_error` row with AccountLoadedTwice translation; added new "Tool-handler errors (distinct from burner-policy rejects)" section with 3 codes.

---

## Code Issues Found

None — all 4 findings are pre-existing UX gaps, not new bugs introduced by BAT-1013.

---

## Remaining Gaps

**None for v31 scope.** Follow-up items (filed as BAT-XXX where applicable):

1. `tools/wallet.js` `wallet_status` tool result should also surface `heliusConfigured` (currently only surfaced via system-prompt snapshot path). Low-priority quality follow-up.
2. tools/solana.js could refactor to call `solana.getConnectedWalletAddress()` via namespace instead of destructuring, to enable cleaner stub-based test of the main-not-connected pre-flight. Cosmetic test-infra cleanup.

---

## Test Coverage

| Test | Status |
|---|---|
| burner-policy.test.js: self-send REJECT for solana_send | ✅ 120/120 PASS |
| burner-policy.test.js: self-send REJECT for agent_pay_x402 | ✅ Included in 120 |
| burner-policy.test.js: distinct addresses ACCEPT (regression guard) | ✅ Included in 120 |
| tools-solana-routing.test.js: source="main" forces main routing | ✅ |
| tools-solana-routing.test.js: source="auto" (default) routes by cap | ✅ |
| tools-solana-routing.test.js: self-send returns clean error no bridge call | ✅ 27/27 PASS |
| Pre-push (Node smoke + Kotlin compile) | ✅ ALL PASS |

---

**Verdict: v31 100% post-fix. Foundation patch ready for Copilot review + merge.**
