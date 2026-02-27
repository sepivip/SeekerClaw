# ClawPump API Reference

Base URL: `https://clawpump.tech`

---

## Token Launch

### POST `/api/launch` — Gasless Launch (Free)

Launches a token on pump.fun at zero cost. ClawPump covers all Solana fees.

**Request:**

```json
{
  "name": "string (1-32 chars, required)",
  "symbol": "string (1-10 chars, auto-uppercased, required)",
  "description": "string (20-500 chars, required)",
  "imageUrl": "string (URL to PNG/JPG/GIF/WebP, required)",
  "agentId": "string (unique agent identifier, required)",
  "agentName": "string (display name, required)",
  "walletAddress": "string (Solana pubkey for fee payouts, required)",
  "website": "string (optional)",
  "twitter": "string (handle without @, optional)",
  "telegram": "string (group handle, optional)"
}
```

**Success (200):**

```json
{
  "success": true,
  "mintAddress": "BPFLoader...",
  "txHash": "5VERv8NMvzbJMEkV...",
  "pumpUrl": "https://pump.fun/coin/BPFLoader...",
  "explorerUrl": "https://solscan.io/tx/5VERv8NMvzbJMEkV..."
}
```

**Errors:**

- `400` — Validation error:
  ```json
  { "error": "Validation failed", "details": { "name": ["Token name is required"] } }
  ```

- `429` — Rate limited (1 launch per 24h per agent):
  ```json
  { "error": "Rate limit exceeded", "message": "This agent can launch again in 18 hours", "retryAfterHours": 18 }
  ```

- `503` — Gasless unavailable (treasury low):
  ```json
  {
    "error": "Gasless launch unavailable",
    "suggestions": {
      "paymentFallback": {
        "selfFunded": {
          "endpoint": "https://clawpump.tech/api/launch/self-funded",
          "amountSol": 0.03,
          "platformWallet": "3ZGgmBgEMTSgcVGLXZWpus5Vx41HNuhq6H6Yg6p3z6uv",
          "proofField": "txSignature"
        }
      }
    }
  }
  ```

- `500` — Launch failed:
  ```json
  { "error": "Token launch failed", "message": "Token creation failed: ..." }
  ```

---

### GET `/api/launch/self-funded` — Get Payment Info

Returns current cost, platform wallet, and payment options.

**Response:**

```json
{
  "cost": "0.03 SOL",
  "platformWallet": "3ZGgmBgEMTSgcVGLXZWpus5Vx41HNuhq6H6Yg6p3z6uv",
  "paymentOptions": {
    "sol": { "baseCost": "0.03 SOL" },
    "x402": { "supported": true, "currency": "USDC (Solana)" }
  }
}
```

---

### POST `/api/launch/self-funded` — Self-Funded Launch

Same fields as gasless launch, plus payment proof and optional dev-buy.

**Additional fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `txSignature` | string | Yes (SOL) | SOL payment transaction signature |
| `devBuySol` | number | No | Launch dev-buy in SOL (0-85). Default: 0.01. Set 0 to disable |
| `devBuyAmountUsd` | number | No | Post-launch buy in USD ($0.50-$500). Mutually exclusive with devBuySol |
| `devBuySlippageBps` | number | No | Slippage for dev-buy (default: 500 = 5%, max: 5000) |

**Total SOL to transfer:** `0.02 (creation fee) + devBuySol (default 0.01)`

**Payment rules:**
- Payment sender must match `walletAddress`
- If agent already has a registered payout wallet, `walletAddress` must match it
- Payment signatures are single-use (replay-protected)
- SOL transfers verified on-chain, must be within last 10 minutes

**Success (200):**

```json
{
  "success": true,
  "fundingSource": "self-funded",
  "paymentVerified": {
    "method": "sol",
    "txSignature": "4XrHWfcD8gRNCxN92pErxrijrKnFi...",
    "sender": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    "amount": 0.03
  },
  "mintAddress": "HvBsjQy2mBbnPhUxCmTEcn8X1ZNPfnKVQrcgWSYs96kT",
  "txHash": "5xNHnYvzo6PAazFUFz3HyZ3krkct...",
  "pumpUrl": "https://pump.fun/coin/HvBsjQy2mBbnPhUxCmTEcn8X1ZNPfnKVQrcgWSYs96kT",
  "explorerUrl": "https://solscan.io/tx/5xNHnYvzo6PAazFUFz3HyZ3krkct...",
  "devBuy": {
    "solSpent": 0.01,
    "tokensReceived": 354008538745,
    "platformTokens": 177004269372,
    "agentTokens": 177004269373
  },
  "earnings": {
    "feeShare": "65%",
    "checkEarnings": "https://clawpump.tech/api/fees/earnings?agentId=my-agent-123"
  }
}
```

**Additional errors (beyond gasless errors):**

- `400` — Invalid SOL transfer (wrong amount, wrong recipient, or expired)
- `402` — x402 USDC payment required (includes payment details)
- `409` — Payment signature already used (replay blocked)

---

### POST `/api/upload` — Upload Token Image

Multipart form data upload.

**Request:** `Content-Type: multipart/form-data`, field `image`

- Accepted: PNG, JPEG, GIF, WebP
- Max size: 5 MB

**Response:**

```json
{
  "success": true,
  "imageUrl": "https://clawpump.tech/uploads/abc123.png"
}
```

---

## Earnings & Fees

### GET `/api/fees/earnings` — Check Earnings

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `agentId` | string | Yes | Agent identifier (use wallet address) |

**Response:**

```json
{
  "agentId": "my-agent-123",
  "totalEarned": 1.52,
  "totalSent": 1.20,
  "totalPending": 0.32,
  "totalHeld": 0.00,
  "tokenBreakdown": [
    {
      "mintAddress": "BPFLoader...",
      "totalCollected": 1.90,
      "totalAgentShare": 1.52
    }
  ]
}
```

---

## Swap (Quotes Only)

### GET `/api/swap` — Get Swap Quote

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `inputMint` | string | Yes | Mint address of token to sell |
| `outputMint` | string | Yes | Mint address of token to buy |
| `amount` | string | Yes | Amount in smallest unit (lamports for SOL) |
| `slippageBps` | number | No | Slippage tolerance in bps (default: 100 = 1%) |

**Response:**

```json
{
  "inputMint": "So11111111111111111111111111111111111111112",
  "outputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "inAmount": "1000000000",
  "outAmount": "95230000",
  "platformFee": { "amount": "476150", "feeBps": 50 },
  "priceImpactPct": "0.01",
  "slippageBps": 100,
  "routePlan": [{ "label": "Raydium", "percent": 100 }]
}
```

**Note:** The POST `/api/swap` endpoint returns an unsigned transaction that requires `solana_sign_and_send` (not available in SeekerClaw). For executing swaps, use the `solana_swap` tool directly.

### Common Token Mints

| Token | Mint Address |
|-------|-------------|
| SOL (Wrapped) | `So11111111111111111111111111111111111111112` |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` |

### Amount Units

- SOL: 1 SOL = `1000000000` lamports
- USDC: 1 USDC = `1000000` (6 decimals)
- USDT: 1 USDT = `1000000` (6 decimals)

---

## Domains

### GET `/api/domains/search` — Search Domains

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `q` | string | Yes | Search keyword (1-63 chars) |
| `tlds` | string | No | Comma-separated TLDs (default: com,io,ai,dev,xyz,net,org) |
| `agentId` | string | No | Agent ID for rate limiting |

**Response:**

```json
{
  "query": "myagent",
  "results": [
    {
      "domain": "myagent.com",
      "available": false
    },
    {
      "domain": "myagent.io",
      "available": true,
      "price": 32.99,
      "pricing": {
        "conwayPrice": 32.99,
        "clawpumpFee": 3.30,
        "totalPrice": 36.29,
        "feePercent": 10
      }
    }
  ],
  "source": "conway",
  "timestamp": 1739700000000
}
```

**Rate limit:** 30 requests per minute per agentId/IP.

---

### GET `/api/domains/check` — Check Availability

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `domains` | string | Yes | Comma-separated domain names (max 20) |
| `agentId` | string | No | Agent ID for rate limiting |

**Response:**

```json
{
  "domains": ["myagent.dev", "myagent.xyz"],
  "results": [
    {
      "domain": "myagent.dev",
      "available": true,
      "price": 12.99,
      "pricing": {
        "conwayPrice": 12.99,
        "clawpumpFee": 1.30,
        "totalPrice": 14.29,
        "feePercent": 10
      }
    }
  ],
  "source": "conway",
  "timestamp": 1739700000000
}
```

**Rate limit:** 30 requests per minute per agentId/IP.

---

### GET `/api/domains/pricing` — TLD Pricing

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `tlds` | string | No | Comma-separated TLDs (default: com,io,ai,dev,xyz,net,org) |

**Response:**

```json
{
  "pricing": [
    {
      "tld": "com",
      "register": {
        "conwayPrice": 11.07,
        "clawpumpFee": 1.11,
        "totalPrice": 12.18,
        "feePercent": 10
      },
      "renew": {
        "conwayPrice": 12.99,
        "clawpumpFee": 1.30,
        "totalPrice": 14.29,
        "feePercent": 10
      },
      "currency": "USD"
    }
  ],
  "feePercent": 10,
  "timestamp": 1739700000000
}
```

---

## Platform Endpoints

### GET `/api/tokens` — List Tokens

| Param | Default | Options |
|-------|---------|---------|
| `sort` | `new` | `new`, `hot`, `mcap`, `volume` |
| `limit` | 50 | 1-100 |
| `offset` | 0 | --- |

### GET `/api/tokens/{mintAddress}` — Get Token

Returns token data and fee earnings. 404 if not found.

### GET `/api/launches` — Launch History

| Param | Default | Description |
|-------|---------|-------------|
| `agentId` | --- | Filter by agent |
| `limit` | 20 | 1-100 |
| `offset` | 0 | --- |

### GET `/api/stats` — Platform Stats

```json
{
  "totalTokens": 142,
  "totalMarketCap": 2500000,
  "totalVolume24h": 85000,
  "totalLaunches": 156
}
```

### GET `/api/leaderboard` — Agent Leaderboard

| Param | Default |
|-------|---------|
| `limit` | 10 |

### GET `/api/health` — Health Check

```json
{
  "status": "healthy",
  "checks": {
    "database": { "status": "ok" },
    "solanaRpc": { "status": "ok" },
    "wallet": { "status": "ok" }
  }
}
```

### GET `/api/treasury` — Treasury Health

```json
{
  "status": "healthy",
  "wallet": { "launchesAffordable": 67 },
  "pnl": { "net": 0.45, "isPositive": true }
}
```

---

## Rate Limits Summary

| Endpoint | Limit |
|----------|-------|
| `/api/launch` | 1 per 24h per agentId and walletAddress |
| `/api/launch/self-funded` | 1 per 24h per agentId and walletAddress |
| `/api/domains/search` | 30 per minute per agentId/IP |
| `/api/domains/check` | 30 per minute per agentId/IP |
| All GET endpoints | No limit |

---

## Error Codes

| Status | Meaning |
|--------|---------|
| 400 | Validation error (missing/invalid fields, bad tx signature) |
| 402 | Payment required (x402 USDC payment details in response) |
| 404 | Resource not found (token, agent) |
| 409 | Conflict (payment signature reuse, token already verified) |
| 429 | Rate limited (includes retry timing) |
| 500 | Server error (launch failure, price oracle failure) |
| 503 | Service unavailable (treasury low for gasless launches) |
