# Jupiter Integration Audit — SeekerClaw

**Date:** 2026-02-22
**Scope:** All code paths related to Solana wallet, Jupiter swap/quote/orders, transaction signing, error handling, and agent runtime interaction.

---

## 1. Executive Summary

- **16 Solana/Jupiter tools** implemented across 824-line `solana.js` + 3600+ lines in `tools.js`
- **Gasless swaps** via Jupiter Ultra, **limit orders** via Trigger API, **DCA** via Recurring API
- **No private keys** ever touch Node.js — all signing via Android MWA (wallet app)
- **Transaction verification** decodes raw binary, checks program whitelist (100+ DEXes), rejects ALT
- **P0 BUG**: `solana_swap` uses `Math.round(amount * 10^decimals)` (floating-point) while trigger/DCA use safe BigInt parsing — precision loss risk on large amounts
- **P0 GAP**: `solana_swap` and `solana_send` are **NOT** in `CONFIRM_REQUIRED` — agent can initiate wallet popups without Telegram confirmation (MWA is the only gate)
- **P1**: Hardcoded public Solana RPC (`api.mainnet-beta.solana.com`) — rate-limited, no SLA, single point of failure
- **P1**: `MAX_TOOL_USES = 5` tool budget can be exhausted mid-swap-flow (quote → swap = 2 uses minimum, plus token resolution)
- **P1**: No balance pre-check before swap — relies on Jupiter Ultra to fail
- Security posture is **strong** (program whitelist, ALT rejection, confirmation gates on orders), but has operational gaps

---

## 2. Architecture Reality Map

### Modules & Files

| File | Lines | Role |
|------|-------|------|
| `solana.js` | 824 | RPC client, base58, tx builder, Jupiter API wrappers, token cache, tx verification |
| `tools.js` | ~3600 | All 16 tool definitions + implementations |
| `claude.js` | ~1600 | Agent loop, tool execution, confirmation gates, budget enforcement |
| `config.js` | ~380 | `CONFIRM_REQUIRED` set, rate limits, status messages |
| `SolanaWalletManager.kt` | 129 | MWA adapter: authorize, signAndSend, signOnly |
| `SolanaAuthActivity.kt` | 115 | Transparent activity for MWA intents, atomic result files |
| `AndroidBridge.kt` | ~678 | HTTP bridge: `/solana/authorize`, `/sign`, `/sign-only`, `/address` |
| `ConfigManager.kt` | ~460 | Encrypted Jupiter API key storage, wallet address persistence |

### Real Data Flow (Swap)

```
User: "swap 1 SOL for USDC"
  ↓
Agent calls solana_quote (tool use 1)
  → resolveToken("SOL") → token cache (or Jupiter API)
  → resolveToken("USDC") → token cache
  → jupiterRequest() → GET api.jup.ag/swap/v1/quote
  ← quote object returned to agent
  ↓
Agent shows quote to user, calls solana_swap (tool use 2)
  → getConnectedWalletAddress() → reads solana_wallet.json
  → resolveToken() x2
  → jupiterPrice() → GET api.jup.ag/price/v3 (confidence check)
  → jupiterUltraOrder() → GET api.jup.ag/ultra/v1/order (unsigned tx + requestId)
  → verifySwapTransaction() → binary decode, whitelist check
  → ensureWalletAuthorized() → POST localhost:8765/solana/authorize
  → androidBridgeCall('/solana/sign-only') → POST localhost:8765/solana/sign-only
     ↓ Android launches SolanaAuthActivity → MWA → wallet app
     ↓ User approves in wallet (up to 120s)
     ↓ Result written to solana_results/{requestId}.json
  → [if >90s elapsed] re-quote + re-sign
  → jupiterUltraExecute() → POST api.jup.ag/ultra/v1/execute
  ← { signature, outputAmount } → formatted result to agent
  ↓
Agent sends confirmation to user via Telegram
```

### External Dependencies

| Service | Endpoint | Auth | Retry |
|---------|----------|------|-------|
| Solana Mainnet RPC | `api.mainnet-beta.solana.com` | None (public) | None |
| Jupiter Quote/Ultra/Price | `api.jup.ag/*` | Optional API key | Exponential backoff (2-15s, 3 retries on 429) |
| Jupiter Program Labels | `public.jupiterapi.com/program-id-to-label` | None | None (startup only) |
| Jupiter Trigger/DCA | `api.jup.ag/trigger/*`, `api.jup.ag/recurring/*` | Required API key | **None** (non-idempotent POSTs) |
| MWA Wallet | Local intent | User approval | None |

---

## 3. Prioritized Findings

| # | Severity | Finding | Evidence | Impact | Fix |
|---|----------|---------|----------|--------|-----|
| 1 | **P0** | `solana_swap` uses `Math.round(input.amount * Math.pow(10, decimals))` — floating-point arithmetic | `tools.js:2032` | Precision loss: `0.1 + 0.2 ≠ 0.3` in JS. For 9-decimal SOL, `1.100000001 * 1e9` can round wrong. trigger/DCA correctly use `parseInputAmountToLamports()` | Replace line 2032 with `parseInputAmountToLamports(String(input.amount), inputToken.decimals)` |
| 2 | **P0** | `solana_swap` and `solana_send` are **not** in `CONFIRM_REQUIRED` | `config.js:246-251` | A prompt-injected agent can initiate swaps/sends without Telegram YES/NO. MWA wallet popup is the only gate — but user may reflexively approve | Add `'solana_swap'` and `'solana_send'` to `CONFIRM_REQUIRED` |
| 3 | **P1** | Hardcoded public RPC: `api.mainnet-beta.solana.com` | `solana.js:17` | Public RPC is rate-limited (undisclosed), no SLA, single point of failure. `solana_balance`, `solana_history`, `solana_send` all depend on it | Add configurable RPC URL (e.g., Helius/QuickNode free tier) with fallback |
| 4 | **P1** | No retry on Solana RPC calls | `solana.js:19-64` | Any transient RPC failure (timeout, 429, 5xx) = immediate user-facing error. Jupiter API has retry; RPC does not | Add retry wrapper (2 attempts, 3s backoff) around `solanaRpc()` |
| 5 | **P1** | Tool budget `MAX_TOOL_USES = 5` can exhaust during swap flow | `claude.js:1402` | Realistic swap flow: `solana_quote` (1) + `solana_swap` (2) = 2 minimum. But if agent also calls `solana_balance` + `solana_price` + `jupiter_token_security` before quoting, budget hits 5 before swap executes | Either exempt financial tools from budget, or increase budget when swap intent detected |
| 6 | **P1** | No balance pre-check in `solana_swap` | `tools.js:1994-2135` | User tries to swap 10 SOL with 0.5 SOL balance → goes through entire Ultra order + MWA popup → fails at Jupiter execute. Wasted 30s+ of user time | Add `solanaRpc('getBalance')` check at start of swap, fail fast if insufficient |
| 7 | **P1** | `solana_swap` output amount calculation uses `parseInt()` + floating-point division | `tools.js:2119-2124` | `parseInt(execResult.outputAmount) / Math.pow(10, outDecimals)` can lose precision for tokens with many decimals. Display-only but could show wrong amount | Use string-based formatting (insert decimal point at correct position) |
| 8 | **P2** | Token cache refreshes only on startup (30-min TTL but process runs 24/7) | `solana.js:142-148` | After TTL expires, `fetchJupiterTokenList()` is called on next `resolveToken()` — this is fine. But if it fails, stale data persists with no retry until next call | Acceptable for v1, but add periodic refresh (e.g., every 6h) for robustness |
| 9 | **P2** | Legacy tx verification is weaker than v0 | `solana.js:553-573` | Legacy path only checks fee payer, does NOT verify program whitelist (returns `valid: true` after payer check at line 573). Only v0 path checks programs | Add program whitelist check to legacy path too |
| 10 | **P2** | No slippage parameter on `solana_swap` — only on `solana_quote` | `tools.js:577-595` | Ultra API handles slippage internally, but user has no control. If Ultra's default is too loose, user eats the slippage | Document that Ultra manages slippage, or add optional param passed to Ultra order |
| 11 | **P2** | `SolanaTransactionBuilder.kt` is a stub that throws `UnsupportedOperationException` | `SolanaTransactionBuilder.kt` | Dead code. Not harmful but confusing for maintainers | Delete or mark clearly as placeholder |

---

## 4. Failure Scenario Matrix

| Scenario | Handled? | Details |
|----------|----------|---------|
| **RPC timeout/outage** | **PARTIAL** | 15s timeout exists, error returned to user. BUT: no retry, no fallback RPC. Single failure = immediate error message |
| **Jupiter API 429 rate limit** | **YES** | Exponential backoff 2-15s, 3 retries, jitter. Well-implemented in `jupiterRequest()` |
| **Jupiter API 5xx/outage** | **PARTIAL** | HTTP error returned to user. No retry on non-429 errors — a transient 500 causes immediate failure |
| **Stale quote / price movement** | **YES** | Ultra TTL tracking: if MWA approval >90s, auto re-quotes. Transaction is atomic — reverts if slippage exceeded |
| **Insufficient funds** | **NO** | No pre-check. User goes through full flow (order + MWA popup) before Jupiter fails. Wasted time + confusing error |
| **Token account doesn't exist** | **YES** | Jupiter Ultra handles ATA creation. Gasless mode wraps SOL automatically (`wrapAndUnwrapSol: true` on trigger/DCA) |
| **Wallet app not installed/locked** | **PARTIAL** | `ensureWalletAuthorized()` pre-warms. But if wallet app crashes during sign, 120s timeout then generic error |
| **User cancels in wallet** | **YES** | MWA returns error → bridge returns error → clean error message to user |
| **Partial-success ambiguity** | **NO** | If `jupiterUltraExecute()` returns success but signature lookup later fails — no confirmation mechanism. User told "success" based only on Jupiter response |
| **Turn ends before user sees result** | **PARTIAL** | Budget exhaustion (5 tools) sends fallback message. But if swap succeeds on tool use 5, the result text may be lost — only fallback "hit tool limit" shown |
| **Telegram confirmation timeout** | **YES** | 60s timeout, auto-deny, clean message. BUT: only applies to trigger/DCA — swap bypasses confirmation |
| **Network switch mid-swap** | **PARTIAL** | 15s timeouts on HTTP. No reconnect logic. If network drops during MWA sign wait (120s), bridge polling continues until timeout |
| **Duplicate order creation** | **YES** | Trigger/DCA create: no retry on POST (idempotent risk correctly handled). Rate limit 1 per 30s |
| **Jupiter program whitelist stale** | **YES** | Refreshed from API on startup. Falls back to hardcoded 100+ programs. New programs → tx rejected (safe failure) |
| **Unverified/scam token swap** | **YES** | `resolveToken()` warns on unverified. Price confidence check blocks low-confidence. `jupiter_token_security` exists for explicit checks |

---

## 5. Security & Safety Notes

### Positive

- **Private keys never touch Node.js** — all signing via MWA on Android side
- **Transaction verification** decodes raw binary and checks every instruction's program against whitelist
- **ALT rejection** prevents program identity smuggling
- **Confirmation gates** on trigger/DCA creation (Telegram YES/NO + rate limiting)
- **Encrypted storage** for Jupiter API key (Android Keystore AES-256-GCM)
- **Bearer token auth** on Android bridge (per-boot random secret)
- **Bridge is localhost only** (port 8765, not exposed to network)

### Risks

| Risk | Severity | Detail |
|------|----------|--------|
| **No Telegram confirmation on swap/send** | **HIGH** | `solana_swap` and `solana_send` not in `CONFIRM_REQUIRED`. A prompt-injected message could trick the agent into calling swap. MWA popup is the last defense — users may approve without reading details |
| **Wallet popup fatigue** | **MEDIUM** | If agent calls `ensureWalletAuthorized()` frequently (every 5 min), users get habituated to approving wallet popups, reducing security value |
| **Logging safety** | **OK** | Checked: no private keys logged. Public keys, signatures, amounts are logged (appropriate). API keys redacted via `redactSecrets()` |
| **Bridge auth token** | **OK** | Generated per-boot, passed via `X-Bridge-Token` header. Not logged |
| **Config.yaml regenerated** | **OK** | API keys stored encrypted, regenerated on service start. Not persisted as plaintext long-term |
| **Slippage not user-controllable on swap** | **LOW** | Jupiter Ultra manages slippage internally. User cannot set max slippage on `solana_swap` |
| **Public RPC exposes wallet address** | **LOW** | Balance/history queries to public RPC reveal user's address. Not a secret (on-chain public) but worth noting |

---

## 6. Verdict + Top 5 Next Actions

### Current Readiness: AMBER

The integration is architecturally sound and has strong security primitives (tx verification, program whitelist, MWA signing). However, there are P0 bugs (floating-point precision, missing confirmation gate) and P1 operational gaps (no RPC retry, no balance pre-check, tool budget risk) that make live-funds testing risky without fixes.

### Can we test on live funds safely now? NO

**Why:** The floating-point precision bug on `solana_swap` line 2032 could cause incorrect amounts on edge cases. The missing confirmation gate means the agent can initiate wallet popups from prompt injection. These must be fixed first.

### Top 5 Fixes Before Test Phase

| Priority | Fix | Effort | File |
|----------|-----|--------|------|
| **1** | Add `'solana_swap'` and `'solana_send'` to `CONFIRM_REQUIRED` in config.js | 1 line | `config.js:246` |
| **2** | Replace `Math.round(input.amount * Math.pow(10, decimals))` with `parseInputAmountToLamports()` in `solana_swap` | 1 line | `tools.js:2032` |
| **3** | Add balance pre-check at start of `solana_swap` — fail fast if insufficient funds | ~10 lines | `tools.js:1994` |
| **4** | Add basic retry (2 attempts) to `solanaRpc()` for transient failures | ~15 lines | `solana.js:19` |
| **5** | Add program whitelist check to legacy tx verification path (currently only checks fee payer) | ~20 lines | `solana.js:553-573` |
