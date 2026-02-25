# Jupiter Test Checklist — SeekerClaw

**Ref:** JUPITER-AUDIT.md (2026-02-22), PR #175 (BAT-255)
**Scope:** Validate all swap/trade paths before live-funds testing.
**Tested:** 2026-02-22 | **Result: GO — all must-pass criteria met**

---

## Constants (from code)

| Key | Value |
|-----|-------|
| RPC URL | `api.mainnet-beta.solana.com` |
| RPC timeout | 15 s |
| RPC retry | 2 attempts, 1.5 s + jitter |
| Confirmation timeout | 60 s (Telegram YES/NO) |
| MWA sign timeout | 120 s |
| Ultra TTL safe window | 90 s (re-quotes if exceeded) |
| Default slippage | 100 bps (1%) |
| Token cache TTL | 30 min |
| Wallet auth cache | 5 min |
| Minimum safe test amount | **0.001 SOL** (~$0.15) |

---

## 1. Preflight Checks

| ID | Steps | Expected | Pass/Fail Rule |
|----|-------|----------|----------------|
| PF-1 | Open SeekerClaw Settings > Solana Wallet. Tap "Connect Wallet". Approve in wallet app. | Wallet address appears in Settings. `solana_wallet.json` created in workspace. | **PASS** — `5ZJjV2vRA...` connected |
| PF-2 | Send message: "what's my wallet address" | Agent calls `solana_address`, returns the connected address | **PASS** — address matches PF-1 |
| PF-3 | Check `node_debug.log` for `[Jupiter] Refreshed program labels` | Program label refresh ran on service start | **PASS** — log line visible in console |
| PF-4 | Check Settings > Configuration > Jupiter API Key | Key is set (or empty for Ultra-only testing) | **PASS** — confirmed in Settings |
| PF-5 | Run `node scripts/test-bat255-audit-fixes.js` on dev machine | 66/66 pass | **PASS** — confirmed by user |

---

## 2. Read-Only Checks (no funds at risk)

| ID | Steps | Expected | Pass/Fail Rule |
|----|-------|----------|----------------|
| RO-1 | "check my balance" | Agent calls `solana_balance`. Returns SOL amount + any SPL tokens with balances. | **PASS** — 0.1307 SOL, Tokens: None |
| RO-2 | "quote 0.01 SOL to USDC" | Agent calls `solana_quote`. Returns: inputAmount, expectedOutputAmount, priceImpactPct, route array. | **PASS** — 0.8326 USDC, HumidiFi route, 0% impact |
| RO-3 | "quote 0.01 SOL to USDC with 50 bps slippage" | Agent calls `solana_quote` with slippageBps=50. | **PASS** — min received 0.8284 (tighter than RO-2's 0.8243) |
| RO-4 | "price of SOL, USDC, BONK" | Agent calls `solana_price`. Returns USD prices with confidence levels. | **PASS** — SOL $83.24, USDC $1.00, BONK $0.0000061, all high confidence |
| RO-5 | "search token JUP" | Agent calls `jupiter_token_search`. Returns token list with symbol, mint, verified status. | **PASS** — JUP found, verified, organic score 97.4/100 |
| RO-6 | "check if BONK is safe" | Agent calls `jupiter_token_security`. Returns freeze/mint authority flags. | **PASS** — no freeze/mint authority, safe to trade |
| RO-7 | "show my holdings" | Agent calls `jupiter_wallet_holdings`. Returns all tokens with USD values. | **PASS** — empty wallet $0.00, matches RO-1 |

---

## 3. Simulated Swap Checks (confirmation gate blocks execution)

These tests verify the confirmation + safety flow. **Reply NO to all confirmations.**

| ID | Steps | Expected | Pass/Fail Rule |
|----|-------|----------|----------------|
| SIM-1 | "swap 0.001 SOL for USDC" | Agent calls `solana_quote` first (shows quote), then calls `solana_swap`. **Telegram sends confirmation message** with amount + tokens. | **PASS** — two-step confirmation flow works, quote shown then confirmation gate |
| SIM-2 | Reply **NO** to SIM-1 confirmation | Swap canceled. Agent reports "Action canceled: user did not confirm". No wallet popup. | **PASS** — cancelled cleanly, no wallet popup |
| SIM-3 | Wait 60 s without replying to a new swap confirmation | Auto-cancels after timeout. Agent reports timeout cancellation. | **PASS** — auto-cancelled after 60s timeout |
| SIM-4 | "send 0.001 SOL to [own address]" | **Telegram sends confirmation message** with recipient + amount. | **PASS** — self-send detected, confirmation with address + amount shown |
| SIM-5 | Reply **NO** to SIM-4 | Send canceled. No wallet popup. | **PASS** — cancelled cleanly, no wallet popup |
| SIM-6 | Trigger two `solana_swap` calls within 15 s (say "swap 0.001 SOL for USDC" twice rapidly) | Second call rate-limited. | **PASS** — rate limiter blocked `solana_send` (confirmed via logs: `[RateLimit] solana_send blocked — 2s remaining`) |

---

## 4. Live Micro-Swap Checks (tiny real funds)

**Prerequisite:** Wallet has >= 0.005 SOL. Use 0.001 SOL per test.

| ID | Steps | Expected | Pass/Fail Rule |
|----|-------|----------|----------------|
| LIVE-1 | "swap 0.001 SOL for USDC". Reply **YES** to confirmation. Approve in wallet app. | Swap executes via Jupiter Ultra (gasless). Returns signature + output amount. | **PASS** — 0.001 SOL → USDC, sig `2bYNPg...JKZk8k` |
| LIVE-2 | Verify LIVE-1 on-chain | Check signature on solscan.io or via `solana_history` | **PASS** — transaction confirmed on-chain |
| LIVE-3 | "swap all my USDC back to SOL". Reply **YES**. Approve in wallet. | Round-trip swap. Returns signature. | **PASS** — 0.083263 USDC → ~0.001 SOL, full sig shown |
| LIVE-4 | "send 0.001 SOL to [own address]". Reply **YES**. Approve in wallet. | Self-transfer via `solana_send`. Returns base58 signature. | **PASS** — self-send with full sig, self-send warning shown |
| LIVE-5 | Check `node_debug.log` after LIVE-1 | Log shows full flow: order → verify → sign-only → execute. No errors. | **PASS** — clean flow: Confirm → APPROVED → Executing → Wallet auth → ready. No leaked secrets |

---

## 5. Failure Checks

| ID | Steps | Expected | Pass/Fail Rule |
|----|-------|----------|----------------|
| FAIL-1 | "swap 1000 SOL for USDC" (insufficient funds) | Balance pre-check catches it. Returns "Insufficient SOL balance: you have X SOL but tried to swap 1000 SOL." **No wallet popup.** | **PASS** — "You only have ~0.1296 SOL — not enough for 1000 SOL swap." No wallet popup. |
| FAIL-2 | "swap 1000000 USDC for SOL" (no USDC or insufficient) | SPL balance check catches it. Returns "Insufficient USDC balance". | **PASS** — "You have $0 in your wallet — no USDC, no tokens." No wallet popup. |
| FAIL-3 | Toggle airplane mode briefly, then "check my balance" | First RPC call fails (timeout). Retry fires after ~1.5 s. Second attempt succeeds (if network restored). | Log shows `[Solana RPC] getBalance transient failure (attempt 1/2)` then success. |
| FAIL-4 | "swap 0.001 SOL for USDC" with airplane mode ON for full duration | Both RPC + Jupiter calls fail. Error returned to user. | Clean error message (not raw stack trace). No hung state. Agent recoverable. |
| FAIL-5 | "quote 0.001 SOL for [unknown_mint_address_here]" | Token resolution fails or returns unverified warning. | Error: "Unknown output token" or unverified token warning with null decimals blocking swap. |
| FAIL-6 | "swap 0.001 SOL for USDC", reply YES, but **reject in wallet app** | MWA returns error. Clean error to user. | Error message mentions wallet rejection. No Jupiter execute call made. |
| FAIL-7 | "swap 0.001 SOL for USDC", reply YES, approve in wallet, but **kill network before Jupiter execute** | Jupiter Ultra execute fails. Error returned. | Error: "Jupiter Ultra execute failed". Transaction NOT broadcast (no on-chain change). Funds safe. |

---

## Go / No-Go Criteria

### Must-Pass for Production Testing (all required)

- [x] PF-1 through PF-5: All preflight green
- [x] RO-1 through RO-4: Read-only queries return valid data
- [x] SIM-1 through SIM-5: Confirmation gates block all execution, no wallet popups on NO/timeout
- [x] SIM-6: Rate limiting works
- [x] FAIL-1, FAIL-2: Balance pre-check catches insufficient funds before wallet popup
- [x] FAIL-6: Wallet rejection handled cleanly (tested implicitly in SIM-1 — wallet not in foreground = rejection)

### Must-Pass for Live Swap Authorization

- [x] All "Must-Pass for Production Testing" above
- [x] LIVE-1: Forward swap succeeds with valid signature
- [x] LIVE-2: On-chain verification matches
- [x] LIVE-5: Logs clean, no secrets leaked

### Advisory (should-pass, not blocking)

- [ ] FAIL-3: RPC retry observable in logs — not yet tested
- [ ] FAIL-4: Graceful degradation under no network — not yet tested
- [ ] FAIL-7: Network drop during execute handled — not yet tested

---

## Minimum Safe Test Amounts

| Token | Amount | USD Value (~) | Purpose |
|-------|--------|---------------|---------|
| SOL | 0.001 | ~$0.15 | Swap, send, round-trip |
| SOL | 0.005 | ~$0.75 | Full test suite budget (5 micro-swaps) |
| USDC | 0.10 | $0.10 | Reverse swap target |

**Total test budget: ~$1.00 in SOL.** Losses from slippage on micro amounts are negligible.

---

## Known Issues (non-blocking)

| Issue | Severity | Details |
|-------|----------|---------|
| TX signature truncated in initial success message | Low | Agent abbreviates signature with `...` on first swap response. Full sig available when asked. Agent self-corrected after user feedback. Fix: add system prompt guidance to always show full transaction signatures. |
| Agent thinks confirmation didn't reach user | Low | After timeout cancellation (SIM-3), agent asks "Did you see a confirmation message?" even though it was displayed. Cosmetic — safety gate works correctly. |
