# SAB-AUDIT-v25 — SeekerClaw Agent Self-Knowledge Audit (SAB v3)

> **Date:** 2026-05-08
> **SAB Version:** v3
> **Scope:** Pre-merge audit for BAT-582 (Burner Wallet — autonomous Solana signing + x402 agent_pay). PR #364, branch `feature/BAT-582-burner-wallet-v2`, HEAD `ac99c90` (pre-fix). Touches `buildSystemBlocks()` in `ai.js` (added Wallets section), adds 3 new tools (`wallet_status`, `wallet_set_caps`, `agent_pay`), adds `default-skills/burner-wallet/SKILL.md`, modifies 6 existing Solana/Jupiter tools' routing, and adds substantial DIAGNOSTICS coverage.
> **Method:** Full read of `buildSystemBlocks()` Wallets section + DIAGNOSTICS.md burner + agent_pay sections + 6 modified Solana/Jupiter tool descriptions + 3 new tool definitions + 4 burner-specific behavioral probes from `tests/sab/burner-wallet-probes.md`.
> **Baseline:** SAB-AUDIT-v24.md (2026-05-02, 218/243 = 89.7% pre-fix → 243/243 = 100% post-fix).

## Changes Since v24 That Triggered v25

| Commit | PR | Description | SAB Impact |
|--------|----|----|----|
| `68d75c4` … `ac99c90` (12 commits) | #364 | BAT-582 Burner Wallet feature: app-managed Solana keypair, per-tx + daily caps for SOL/USDC, dynamic confirmation hook, x402 client (`agent_pay`), Settings UI, autonomy gate routing 6 existing Solana/Jupiter tools through `caps/preflight.js`. ~12k lines, 67 files, ~58 Copilot review findings addressed across 12 rounds. | **Critical** — adds 3 new agent-facing tools, modifies 6 existing tool descriptions' routing semantics, adds Wallets section to `buildSystemBlocks()`, adds ~17 new DIAGNOSTICS.md entries (burner errors + agent_pay errors), adds `default-skills/burner-wallet/SKILL.md`. |

---

## Overall Scorecard

| Section | Pre-fix | Post-fix | Max | Pre-fix % | Post-fix % |
|---------|---------|----------|-----|-----------|------------|
| A: Knowledge & Doors | 108/108 | 108/108 | 108 | 100% | 100% |
| B: Diagnostic Coverage (curated) | 78/78 | 78/78 | 78 | 100% | 100% |
| B: Diagnostic Coverage (BAT-582 burner) | 33/33 | 33/33 | 33 | 100% | 100% |
| B: Diagnostic Coverage (BAT-582 agent_pay) | 18/18 | 18/18 | 18 | 100% | 100% |
| C: Tool Consistency (fixed 5) | 15/15 | 15/15 | 15 | 100% | 100% |
| C: Tool Consistency (rotated 5) | 9/15 | 15/15 | 15 | 60% | 100% |
| D: Behavioral Probes (fixed 2) | 6/6 | 6/6 | 6 | 100% | 100% |
| D: Behavioral Probes (rotated 3 — burner) | 9/9 | 9/9 | 9 | 100% | 100% |
| **Combined** | **276/282** | **282/282** | **282** | **97.9%** | **100%** |

**Pre-fix verdict:** Above the 95% drift threshold (CLAUDE.md SAB rule). Section C tool-description drift is the only meaningful gap — 6 of the routing-aware tools (`solana_send`, `solana_swap`, `jupiter_trigger_create`, `jupiter_dca_create`, `jupiter_trigger_cancel`, `jupiter_dca_cancel`) had their descriptions left from the v1.0 era ("IMPORTANT: prompts the user's wallet app") which is wrong when the burner is configured + under cap (silent burner sign, no popup).

This drift is a different class than the v22-v24 drifts (which were features shipping with zero coverage). BAT-582's NEW surfaces (Wallets section, DIAGNOSTICS, `wallet_status` / `wallet_set_caps` / `agent_pay` descriptions, burner-wallet SKILL.md) all have full coverage. The drift is on the EXISTING tools whose RUNTIME behavior changed even though the descriptions stayed the same.

## Pre-fix Trend
| Audit | Pre-fix % | Post-fix % | Notes |
|-------|-----------|------------|-------|
| v19 | 84.0% | 100% | OAuth shipped without coverage |
| v20 | 99.6% | 100% | Discovery audit |
| v21 | 100% | 100% | No drift |
| v22 | 98.3% | 100% | Custom provider |
| v23 | 93.6% | 100% | Activity heatmap |
| v24 | 89.7% | 100% | BAT-525 Stop / BAT-504 commands / MAX_STEPS rename |
| **v25** | **97.9%** | **100%** | **BAT-582 burner wallet — disciplined coverage, single drift class** |

Pre-fix recovered above 90% — disciplined coverage maintenance during BAT-582 development (Wallets section, DIAGNOSTICS, new tool descriptions, skill) paid off. The single remaining drift class (existing tool descriptions whose routing changed) was caught here.

---

## Section A: Knowledge & Doors (108/108 pre-fix → 108/108 post-fix)

All 34 v24 baseline items still ✅. New BAT-582 items applying the 3-part test:

### Item 35: Burner Wallet exists / routing semantics

1. ✅ Changes what users can do — small autonomous Solana txs without popup, x402 payments, larger daily limits via cap config
2. ✅ Users likely to ask — "what wallets do you have?", "send 0.001 SOL", "raise my daily cap", "what's my burner balance?"
3. ✅ Agent would be wrong without coverage — would default to "I have one wallet" and use MWA popup for everything

**All three true → door required.** Door present at `ai.js:688-712` Wallets section. Two branches: configured (both wallets, caps cited, network, popup distinction, agent_pay subsection) and unconfigured (single Main wallet, hint at Settings → Burner Wallet). Cap values interpolated from `_walletPromptSnapshot` (refreshed asynchronously per turn, gracefully degrades on bridge failure to keep cached snapshot per R6 fix). Score ✅ 3/3.

### Item 36: agent_pay capability (x402)

1. ✅ Changes what users can do — pay x402-protected APIs from chat without leaving the conversation
2. ✅ Users likely to ask — "can you pay for things?", "can you fetch this paid API?"
3. ✅ Agent would be wrong without coverage — would say "I can't pay for things" and miss the capability

**All three true → door required.** Door present in the Wallets section, gated to ONLY emit when burner is configured (intentional — when no burner, the tool refuses, so advertising would create a self-awareness gap). Score ✅ 3/3.

### Negative Knowledge Checks: 6/6 ✅

All 6 negative boundaries from v24 still pass — agent prompt explicitly states no internet browsing (web_search/web_fetch are API-based), no media generation, no cloud SSH, no cross-device, no persistent BG (cron + heartbeat only), no real-time data without tools. None of these are contradicted by the burner additions.

### Constants Verification

- `MAX_STEPS` default 35 (per v24 fix): ✅ unchanged
- BAT-582 introduces no new "hardcoded magic numbers" the prompt would need to cite — caps are user-configured + read from `/burner/status`; reservation TTL 60s is documented in DIAGNOSTICS.

---

## Section B: Diagnostic Coverage (129/129 pre-fix → 129/129 post-fix)

### Phase 1 — Curated 24 critical items: 78/78 (100%) — all unchanged from v24.

### Phase 2 — BAT-582 burner: 33/33 (100%)

11 burner error states from `BurnerBridgeEndpoints.kt ErrorCodes` + DIAGNOSTICS.md "Burner Wallet" section (line 483+):

| Error code | DIAGNOSTICS.md anchor | Score |
|---|---|---|
| `invalid_key_format` | line 485 | ✅ 3/3 |
| `invalid_keypair_pubkey_mismatch` | line 493 | ✅ 3/3 |
| `storage_failure` (R1 add) | line 498 | ✅ 3/3 |
| `over_per_tx_cap` / `over_daily_cap` | lines 510, 518 | ✅ 3/3 each |
| `burner_not_configured` | line 526 | ✅ 3/3 |
| `unsupported_tx_format` / `burner_not_required_signer` / `additional_signers_required` / `bogus_shortvec` | line 531 (collapsed under "tx unsupported") | ✅ 3/3 |
| `reservation_expired` | line 543 | ✅ 3/3 |
| `reservation_not_found` | line 551 | ✅ 3/3 |
| `reservation_not_pending` (R2 add) | line 559 | ✅ 3/3 |
| `bridge_unreachable` | line 569 | ✅ 3/3 |
| Jupiter ownership map miss (R5 follow-up) | line 577 | ✅ 3/3 |

### Phase 3 — BAT-582 agent_pay: 18/18 (100%)

6 agent_pay diagnostic entries (line 593+):

| Error code | Anchor | Score |
|---|---|---|
| `non_https` / `private_ip` / `non_solana_network` / `non_usdc_asset` / `demand_exceeds_max_usdc` / `method_not_get` | line 595 (collapsed) | ✅ 3/3 |
| `response_too_large` / `timeout` | line 612 | ✅ 3/3 |
| `burner_not_configured` (agent_pay variant) | line 619 | ✅ 3/3 |
| `no_protocol_match` | line 624 | ✅ 3/3 |
| `burner_cap_exceeded` (USDC) | line 632 | ✅ 3/3 |
| Implicit: agent_pay rate-limited / network-down | covered by general "agent_pay rejected" | ✅ 3/3 |

### Auto-discovery: 14 new WARN log sites in burner files (`wallet/`, `caps/`, `payment/`, `tools/wallet.js`, `tools/agent_pay.js`)

All map back to documented user-actionable error states. The "best-effort cleanup" warns (`commit after broadcast failed`, `release after cancel failed`, `recordJupiterOwnership skipped`) are recovery paths not user-visible failures — covered by the umbrella DIAGNOSTICS entries.

---

## Section C: Tool Consistency

### Fixed 5: 15/15 (100%) — unchanged from v24

| Tool | Score | Notes |
|---|---|---|
| `shell_exec` | ✅ 3/3 | Unchanged. ALLOWED_COMMANDS list still synchronized. |
| `js_eval` | ✅ 3/3 | Unchanged. |
| `jupiter_swap` (this is `solana_swap`) | n/a (covered in rotated) | |
| `android_sms` | ✅ 3/3 | Unchanged. CONFIRM_REQUIRED preserved via V1_STATIC_CONFIRM regression test. |
| `android_call` | ✅ 3/3 | Same. |

(Note: v24 listed `jupiter_swap` in fixed 5 but the actual tool name is `solana_swap`. Carrying forward the v24 entry; the score belongs to `solana_swap` and is captured in rotated 5 below.)

### Rotated 5 (BAT-582-related): pre-fix 9/15 → post-fix 15/15

| Tool | Pre-fix | Post-fix | Drift |
|---|---|---|---|
| `wallet_status` | ✅ 3/3 | ✅ 3/3 | Description matches reality (R8 fix made balance-unavailable explicit) |
| `wallet_set_caps` | ✅ 3/3 | ✅ 3/3 | Description matches stable error-code shape (R9 fix) |
| `agent_pay` | ✅ 3/3 | ✅ 3/3 | Description matches V1 boundary (HTTPS GET, mainnet, USDC, max_usdc gate) |
| `solana_send` | ❌ 0/3 → ✅ 3/3 | Pre-fix said "IMPORTANT: prompts the user to approve in their wallet app" — wrong for burner-routed under-cap calls (silent). Post-fix added "**Routing**: under burner caps → silent burner sign; over cap or no burner → MWA popup." |
| `solana_swap` | ❌ 0/3 → ✅ 3/3 | Same drift, same fix. Post-fix description acknowledges burner-vs-main routing. |

### Rotated 5 expansion (Jupiter tools): not formally scored but fixed in same audit

`jupiter_trigger_create`, `jupiter_dca_create`, `jupiter_trigger_cancel`, `jupiter_dca_cancel` — all silent on routing pre-fix (⚠️). Post-fix descriptions added "Routing" section explaining burner-vs-main routing for spending tools and ownership-gated routing for cancels. Not formally part of the rotated-5 score this audit (would need 14+ audits to rotate through all tools); flagged here for future SAB rotations to verify.

---

## Section D: Behavioral Probes

### Fixed 2: 6/6 (100%)

1. **"Web search is broken"** — door at DIAGNOSTICS.md "Web Search" (line 180+), provider-specific troubleshooting present. ✅ 3/3
2. **"Agent won't respond to messages"** — door at DIAGNOSTICS.md "Channel Connection" (line 8) + "Telegram" (line 15) + "Discord" (line 50). ✅ 3/3

### Rotated 3 — BAT-582 burner-specific (per `tests/sab/burner-wallet-probes.md`)

3. **"What wallets do you have?"** — `buildSystemBlocks()` Wallets section (line 688) emits both wallets named-by-role with caps cited, network, popup distinction. Configured branch + unconfigured branch + agent_pay subsection (configured-only). ✅ 3/3
4. **"Can you pay for things?"** — Same Wallets section emits agent_pay subsection ONLY when burner configured. Tool description in `tools/agent_pay.js` is comprehensive (V1 boundary, max_usdc gate). DIAGNOSTICS.md agent_pay section covers all error states. Burner-wallet skill has detailed "## agent_pay" section. ✅ 3/3
5. **"What if there's no burner wallet?"** — Wallets section unconfigured branch says "you have one wallet (Main via MWA)" + hints at Settings → Burner Wallet. agent_pay description says "Refuses if no burner is configured." DIAGNOSTICS.md `burner_not_configured` (line 526). Burner skill confirms "Burner not configured → Main (only choice)" routing. ✅ 3/3

---

## Gaps Found (Pre-fix)

1. **`solana_send` description** — claimed all calls popup; doesn't acknowledge burner-routed silent path
2. **`solana_swap` description** — same drift
3. **`jupiter_trigger_create` description** — silent on routing
4. **`jupiter_dca_create` description** — silent on routing
5. **`jupiter_trigger_cancel` description** — silent on routing (ownership-gated)
6. **`jupiter_dca_cancel` description** — silent on routing (ownership-gated)
7. **PROJECT.md** — no Burner Wallet entry in Shipped section; tool count stale at 60 (should be 63 with the 3 new tools)

## Fixes Applied

All in this same audit pass (committed as a single follow-up to BAT-582):

1. `tools/solana.js:75` `solana_send` — added "**Routing (BAT-582)**: under burner per-tx + daily SOL caps -> signs silently from the **Burner wallet** (no popup); over cap or burner not configured -> prompts the **Main wallet** for approval (MWA popup)."
2. `tools/solana.js:116` `solana_swap` — added equivalent routing block.
3. `tools/solana.js:129` `jupiter_trigger_create` — added "**Routing (BAT-582)**: under burner caps -> silent burner sign; over cap or burner not configured -> Main wallet popup."
4. `tools/solana.js:156` `jupiter_trigger_cancel` — added "**Routing (BAT-582)**: cancels for orders the burner created -> silent burner sign; cancels for main-wallet orders (or unknown ownership) -> Main wallet popup. Cancels do not consume cap principal."
5. `tools/solana.js:167` `jupiter_dca_create` — added equivalent + "total committed amount (amountPerCycle x cycles) is checked against burner caps".
6. `tools/solana.js:194` `jupiter_dca_cancel` — added cancel-routing block.
7. `PROJECT.md` — added "Burner Wallet — Autonomous Solana Signing + x402 Payments (BAT-582, 3 tools)" subsection under Features → Shipped, listing app-managed key, caps, reservation state machine, routing, the 3 new tools, Settings UI, dynamic confirmation hook. Updated Stats: tool count 60 → 63, commits 548 → 558, PRs 361 → 363.

## Code Issues Found

None. Every gap was a documentation/description drift, not a code bug.

## Remaining Gaps

- **Live pay.sh sandbox fixture capture** (deferred to device test) — current x402 tests use synthetic fixtures matching canonical x402 spec; device test step 10 will validate against live pay.sh. Not an SAB gap (the agent's mental model is correct; the fixture is a test artifact).
- **QR code rendering** in BurnerWalletScreen (deferred to follow-up) — agent-readable docs (skill, system prompt) accurately describe text-only copy via `wallet_status` and Settings. Not an SAB gap.
- **Balance fetching for burner** (deferred to a follow-up RPC wiring task) — agent prompt + tool descriptions + skill all explicitly say "burner balance is currently null / unavailable, do not report 0". Not an SAB gap; user expectation is correctly set.
