# Jupiter Test Checklist — SeekerClaw

**Ref:** JUPITER-AUDIT.md (2026-02-22), PR #175 (BAT-255)
**Scope:** Validate all swap/trade paths before live-funds testing.

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
| PF-1 | Open SeekerClaw Settings > Solana Wallet. Tap "Connect Wallet". Approve in wallet app. | Wallet address appears in Settings. `solana_wallet.json` created in workspace. | Address is valid base58 (32-44 chars) |
| PF-2 | Send message: "what's my wallet address" | Agent calls `solana_address`, returns the connected address | Address matches PF-1 |
| PF-3 | Check `node_debug.log` for `[Jupiter] Refreshed program labels` | Program label refresh ran on service start | Log line present within 60 s of service start |
| PF-4 | Check Settings > Configuration > Jupiter API Key | Key is set (or empty for Ultra-only testing) | Non-empty if testing trigger/DCA; empty OK for swap/quote |
| PF-5 | Run `node scripts/test-bat255-audit-fixes.js` on dev machine | 66/66 pass | Zero failures |

---

## 2. Read-Only Checks (no funds at risk)

| ID | Steps | Expected | Pass/Fail Rule |
|----|-------|----------|----------------|
| RO-1 | "check my balance" | Agent calls `solana_balance`. Returns SOL amount + any SPL tokens with balances. | `sol` field is a number >= 0. No RPC error. |
| RO-2 | "quote 0.01 SOL to USDC" | Agent calls `solana_quote`. Returns: inputAmount, expectedOutputAmount, priceImpactPct, route array. | outputAmount > 0. priceImpact < 5%. Route has >= 1 hop. |
| RO-3 | "quote 0.01 SOL to USDC with 50 bps slippage" | Agent calls `solana_quote` with slippageBps=50. | Response shows slippage applied. otherAmountThreshold lower than RO-2. |
| RO-4 | "price of SOL, USDC, BONK" | Agent calls `solana_price`. Returns USD prices with confidence levels. | All 3 return prices. SOL confidence = "high". |
| RO-5 | "search token JUP" | Agent calls `jupiter_token_search`. Returns token list with symbol, mint, verified status. | At least 1 result. `verified: true` for official JUP token. |
| RO-6 | "check if BONK is safe" | Agent calls `jupiter_token_security`. Returns freeze/mint authority flags. | `isSafe: true` for BONK. No freeze authority. |
| RO-7 | "show my holdings" | Agent calls `jupiter_wallet_holdings`. Returns all tokens with USD values. | Holdings match RO-1 balance. totalValueUsd > 0 if funded. |

---

## 3. Simulated Swap Checks (confirmation gate blocks execution)

These tests verify the confirmation + safety flow. **Reply NO to all confirmations.**

| ID | Steps | Expected | Pass/Fail Rule |
|----|-------|----------|----------------|
| SIM-1 | "swap 0.001 SOL for USDC" | Agent calls `solana_quote` first (shows quote), then calls `solana_swap`. **Telegram sends confirmation message** with amount + tokens. | Confirmation message appears: "Swap Tokens / Sell: 0.001 SOL / Buy: USDC / Reply YES..." |
| SIM-2 | Reply **NO** to SIM-1 confirmation | Swap canceled. Agent reports "Action canceled: user did not confirm". No wallet popup. | No MWA activity. No transaction signature. |
| SIM-3 | Wait 60 s without replying to a new swap confirmation | Auto-cancels after timeout. Agent reports timeout cancellation. | Log shows `[Confirm] Timeout for solana_swap`. No wallet popup. |
| SIM-4 | "send 0.001 SOL to [own address]" | **Telegram sends confirmation message** with recipient + amount. | Confirmation message appears: "Send SOL / To: [address] / Amount: 0.001 SOL" |
| SIM-5 | Reply **NO** to SIM-4 | Send canceled. No wallet popup. | No MWA activity. Agent confirms cancellation. |
| SIM-6 | Trigger two `solana_swap` calls within 15 s (say "swap 0.001 SOL for USDC" twice rapidly) | Second call rate-limited. | Error: "Rate limited: solana_swap can only be used once per 15s" |

---

## 4. Live Micro-Swap Checks (tiny real funds)

**Prerequisite:** Wallet has >= 0.005 SOL. Use 0.001 SOL per test.

| ID | Steps | Expected | Pass/Fail Rule |
|----|-------|----------|----------------|
| LIVE-1 | "swap 0.001 SOL for USDC". Reply **YES** to confirmation. Approve in wallet app. | Swap executes via Jupiter Ultra (gasless). Returns signature + output amount. | `success: true`. Signature is valid base58 (64+ chars). `gasless: true`. |
| LIVE-2 | Verify LIVE-1 on-chain | Check signature on solscan.io or via `solana_history` | Transaction confirmed. SOL decreased by ~0.001. USDC increased. |
| LIVE-3 | "swap all my USDC back to SOL". Reply **YES**. Approve in wallet. | Round-trip swap. Returns signature. | `success: true`. SOL balance roughly restored (minus slippage). |
| LIVE-4 | "send 0.001 SOL to [own address]". Reply **YES**. Approve in wallet. | Self-transfer via `solana_send`. Returns base58 signature. | `success: true`. Balance unchanged (minus fee ~0.000005 SOL). |
| LIVE-5 | Check `node_debug.log` after LIVE-1 | Log shows full flow: order → verify → sign-only → execute. No errors. | All `[Jupiter Ultra]` log entries present. No leaked keys/secrets. |

---

## 5. Failure Checks

| ID | Steps | Expected | Pass/Fail Rule |
|----|-------|----------|----------------|
| FAIL-1 | "swap 1000 SOL for USDC" (insufficient funds) | Balance pre-check catches it. Returns "Insufficient SOL balance: you have X SOL but tried to swap 1000 SOL." **No wallet popup.** | Error returned immediately. No MWA activity. No Jupiter order created. |
| FAIL-2 | "swap 1000000 USDC for SOL" (no USDC or insufficient) | SPL balance check catches it. Returns "Insufficient USDC balance". | Error message includes token symbol and both amounts. |
| FAIL-3 | Toggle airplane mode briefly, then "check my balance" | First RPC call fails (timeout). Retry fires after ~1.5 s. Second attempt succeeds (if network restored). | Log shows `[Solana RPC] getBalance transient failure (attempt 1/2)` then success. |
| FAIL-4 | "swap 0.001 SOL for USDC" with airplane mode ON for full duration | Both RPC + Jupiter calls fail. Error returned to user. | Clean error message (not raw stack trace). No hung state. Agent recoverable. |
| FAIL-5 | "quote 0.001 SOL for [unknown_mint_address_here]" | Token resolution fails or returns unverified warning. | Error: "Unknown output token" or unverified token warning with null decimals blocking swap. |
| FAIL-6 | "swap 0.001 SOL for USDC", reply YES, but **reject in wallet app** | MWA returns error. Clean error to user. | Error message mentions wallet rejection. No Jupiter execute call made. |
| FAIL-7 | "swap 0.001 SOL for USDC", reply YES, approve in wallet, but **kill network before Jupiter execute** | Jupiter Ultra execute fails. Error returned. | Error: "Jupiter Ultra execute failed". Transaction NOT broadcast (no on-chain change). Funds safe. |

---

## Go / No-Go Criteria

### Must-Pass for Production Testing (all required)

- [ ] PF-1 through PF-5: All preflight green
- [ ] RO-1 through RO-4: Read-only queries return valid data
- [ ] SIM-1 through SIM-5: Confirmation gates block all execution, no wallet popups on NO/timeout
- [ ] SIM-6: Rate limiting works
- [ ] FAIL-1, FAIL-2: Balance pre-check catches insufficient funds before wallet popup
- [ ] FAIL-6: Wallet rejection handled cleanly

### Must-Pass for Live Swap Authorization

- [ ] All "Must-Pass for Production Testing" above
- [ ] LIVE-1: Forward swap succeeds with valid signature
- [ ] LIVE-2: On-chain verification matches
- [ ] LIVE-5: Logs clean, no secrets leaked

### Advisory (should-pass, not blocking)

- [ ] FAIL-3: RPC retry observable in logs
- [ ] FAIL-4: Graceful degradation under no network
- [ ] FAIL-7: Network drop during execute handled

---

## Minimum Safe Test Amounts

| Token | Amount | USD Value (~) | Purpose |
|-------|--------|---------------|---------|
| SOL | 0.001 | ~$0.15 | Swap, send, round-trip |
| SOL | 0.005 | ~$0.75 | Full test suite budget (5 micro-swaps) |
| USDC | 0.10 | $0.10 | Reverse swap target |

**Total test budget: ~$1.00 in SOL.** Losses from slippage on micro amounts are negligible.
