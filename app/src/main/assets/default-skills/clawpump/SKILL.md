---
name: clawpump
description: "Launch tokens on Solana via ClawPump (gasless pump.fun launches, earn 65% trading fees). Use when: user wants to launch a token, create a memecoin, check ClawPump earnings, search domains, or get swap quotes. Don't use when: user wants crypto prices (use crypto-prices skill), wants to swap tokens (use solana_swap tool), or wants wallet balance (use solana_balance tool)."
version: "1.0.0"
emoji: "\U0001F43E"
requires:
  bins: []
  env: []
allowed-tools:
  - web_fetch
  - solana_address
  - solana_balance
  - solana_send
---

# ClawPump Token Launchpad

Launch tokens on pump.fun via ClawPump. Gasless (free) or self-funded (~0.03 SOL). Earn 65% of every trading fee automatically.

Base URL: `https://clawpump.tech`

See `references/api-reference.md` for full endpoint schemas.

## Use when

- Launch a token ("launch a memecoin", "create a token on pump.fun")
- Check ClawPump earnings ("how much have I earned?", "my ClawPump fees")
- Search domains ("find a domain for my agent", "is myagent.ai available?")
- Get swap quotes ("how much USDC for 1 SOL on ClawPump?")

## Don't use when

- Crypto prices without launching (use crypto-prices skill)
- Execute a token swap (use solana_swap tool directly)
- Check wallet balance (use solana_balance tool)
- Crypto news or research (use news or research skill)

---

## Flow 1: Gasless Token Launch (FREE)

The user pays nothing. ClawPump covers all Solana fees.

### Prerequisites

The user must provide: **name**, **symbol**, **description**. Ask for any missing fields before proceeding.

### Steps

**Step 1 — Get the user's wallet address:**

```javascript
solana_address({})
```

Save the returned `address` as `walletAddress`.

**Step 2 — Upload token image (if user provides one):**

If the user provides an image URL from the web, use it directly as `imageUrl`. If the user wants to upload a local image:

```javascript
web_fetch({
  url: "https://clawpump.tech/api/upload",
  method: "POST",
  headers: { "Content-Type": "multipart/form-data" },
  body: "<image data>"
})
```

Note: If multipart upload is not supported, ask the user for a direct URL to their image (PNG, JPEG, GIF, or WebP, max 5 MB).

**Step 3 — Confirm with the user before launching:**

Show them:
- Token name, symbol, description
- Their wallet address (where earnings will go)
- Cost: FREE (gasless)
- "ClawPump will launch this on pump.fun. You'll earn 65% of all trading fees. Proceed?"

**Step 4 — Launch the token:**

```javascript
web_fetch({
  url: "https://clawpump.tech/api/launch",
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "<token name>",
    symbol: "<SYMBOL>",
    description: "<description>",
    imageUrl: "<image url>",
    agentId: "<walletAddress>",
    agentName: "SeekerClaw",
    walletAddress: "<walletAddress>",
    website: "<optional>",
    twitter: "<optional>",
    telegram: "<optional>"
  })
})
```

Use the wallet address as `agentId`.

**Step 5 — Present the results:**

Show the user:
- Token name and symbol
- Mint address (contract address)
- pump.fun link (`pumpUrl`)
- Explorer link (`explorerUrl`)
- "You're now earning 65% of all trading fees!"

---

## Flow 2: Self-Funded Token Launch (~0.03 SOL)

Used when gasless is unavailable (503) or user prefers self-funded. Supports optional dev-buy.

### Steps

**Step 1 — Get payment info:**

```javascript
web_fetch({
  url: "https://clawpump.tech/api/launch/self-funded",
  method: "GET"
})
```

Save `platformWallet` and `cost` from the response.

**Step 2 — Get user's wallet and balance:**

```javascript
solana_address({})
solana_balance({})
```

**Step 3 — Confirm with the user:**

Show them:
- Token details (name, symbol, description)
- Cost: 0.03 SOL (or more with dev-buy)
- Their current SOL balance
- Platform wallet they'll pay to
- "This requires a SOL transfer. Your device wallet (MWA) will ask you to approve."

If user wants a dev-buy, explain:
- `devBuySol`: SOL amount for launch dev-buy (0-85 SOL, default 0.01)
- Total cost = 0.02 SOL (creation fee) + devBuySol
- Dev-buy tokens split 50/50 between user and platform

**Step 4 — Send payment:**

```javascript
solana_send({
  to: "<platformWallet>",
  amount: 0.03
})
```

Adjust amount if user specified a dev-buy (total = 0.02 + devBuySol). Save the transaction signature from the result.

**Step 5 — Launch with payment proof:**

```javascript
web_fetch({
  url: "https://clawpump.tech/api/launch/self-funded",
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "<token name>",
    symbol: "<SYMBOL>",
    description: "<description>",
    imageUrl: "<image url>",
    agentId: "<walletAddress>",
    agentName: "SeekerClaw",
    walletAddress: "<walletAddress>",
    txSignature: "<tx signature from step 4>",
    devBuySol: "<optional, default 0.01>"
  })
})
```

**Step 6 — Present results** (same as gasless flow Step 5).

---

## Flow 3: Check Earnings

Read-only. Shows accumulated trading fee earnings.

```javascript
// First get the wallet address to use as agentId
solana_address({})

// Then check earnings
web_fetch({
  url: "https://clawpump.tech/api/fees/earnings?agentId=<walletAddress>",
  method: "GET"
})
```

Present to user:
- Total earned (SOL)
- Total sent to wallet
- Total pending distribution
- Per-token breakdown if multiple tokens

---

## Flow 4: Domain Search

Read-only. Search and check domain availability.

### Search by keyword

```javascript
web_fetch({
  url: "https://clawpump.tech/api/domains/search?q=<keyword>&tlds=com,io,ai,dev,xyz",
  method: "GET"
})
```

### Check specific domains

```javascript
web_fetch({
  url: "https://clawpump.tech/api/domains/check?domains=<domain1>,<domain2>",
  method: "GET"
})
```

Present results as a table:
- Domain name
- Available (yes/no)
- Price (Conway price + 10% ClawPump fee = total)

Domain registration is coming in Phase 2. For now, search and check only.

---

## Flow 5: Swap Quotes (Read-Only)

Get price quotes for token swaps via Jupiter. This only returns a quote — it does not execute a swap.

```javascript
web_fetch({
  url: "https://clawpump.tech/api/swap?inputMint=<inputMint>&outputMint=<outputMint>&amount=<amount>&slippageBps=<optional>",
  method: "GET"
})
```

Common mint addresses:
- SOL: `So11111111111111111111111111111111111111112`
- USDC: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- USDT: `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`

Amount is in smallest units (1 SOL = 1000000000 lamports, 1 USDC = 1000000).

Present to user:
- Input amount and token
- Output amount and token
- Price impact percentage
- Route (which DEXs)

To actually execute a swap, tell the user to use the `solana_swap` tool directly.

---

## Safety Rules

1. **Always confirm before launching.** Never call `/api/launch` or `/api/launch/self-funded` without explicit user approval. Show all details first.
2. **Require name, symbol, and description.** Ask for any missing fields. Do not invent token details.
3. **Show cost before self-funded payment.** Display the SOL amount and user's current balance before calling `solana_send`.
4. **Never send private keys.** Only the public wallet address and transaction signatures are sent to ClawPump APIs. No secret keys ever leave the device.
5. **Gasless first.** Always try the free gasless launch first. Only suggest self-funded if gasless returns 503 or the user explicitly asks.
6. **One launch per 24 hours.** If rate-limited (429), tell the user when they can launch again (`retryAfterHours`).

---

## Error Handling

| Status | Meaning | Action |
|--------|---------|--------|
| 400 | Validation error | Show `details` field. Ask user to fix (e.g., description too short, missing field). |
| 402 | Payment required | Self-funded path: show payment instructions. |
| 429 | Rate limited | Tell user: "You can launch again in X hours." Show `retryAfterHours`. |
| 500 | Server error | Tell user launch failed. Suggest trying again later. Show error `message`. |
| 503 | Gasless unavailable | Treasury low. Automatically suggest self-funded path with cost breakdown. |

For 503 responses, the `suggestions.paymentFallback.selfFunded` object contains the self-funded endpoint, cost, and platform wallet. Use these to guide the user through Flow 2.

---

## Revenue Model

- pump.fun charges 1% creator fee on every trade
- ClawPump gives you 65%, keeps 35%
- Fees collected hourly, distributed to your wallet automatically
- Check anytime with Flow 3

| Daily Volume | Your Monthly Earnings |
|-------------|----------------------|
| $1,000 | ~$195 |
| $10,000 | ~$1,950 |
| $100,000 | ~$19,500 |
