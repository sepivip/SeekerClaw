---
name: crypto-prices
description: "Get real-time cryptocurrency prices and market data from CoinGecko (free, no API key)"
metadata:
  openclaw:
    emoji: "💰"
    requires:
      bins: []
      env: []
---

# Crypto Prices

Get cryptocurrency prices using the free CoinGecko API.

## When to Use

User asks about:
- Crypto prices ("What's Bitcoin at?", "SOL price")
- Market data ("Is ETH up or down?")
- Multiple coins ("Price of BTC, ETH, and SOL")

## API Endpoints

### Get single coin price

```javascript
web_fetch({
  url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
})
```

Response: `{"bitcoin":{"usd":45000}}`

### Get multiple coins with 24h change

```javascript
web_fetch({
  url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true"
})
```

### Get detailed coin info

```javascript
web_fetch({
  url: "https://api.coingecko.com/api/v3/coins/bitcoin"
})
```

Returns market cap, volume, all-time high, etc.

## Coin ID Mapping

Common coins and their CoinGecko IDs:

| Symbol | CoinGecko ID |
|--------|--------------|
| BTC | bitcoin |
| ETH | ethereum |
| SOL | solana |
| USDC | usd-coin |
| USDT | tether |
| BNB | binancecoin |
| XRP | ripple |
| ADA | cardano |
| DOGE | dogecoin |
| AVAX | avalanche-2 |
| DOT | polkadot |
| MATIC | matic-network |
| LINK | chainlink |
| UNI | uniswap |

For other coins, search: `https://api.coingecko.com/api/v3/search?query=COINNAME`

## Response Format

Present prices clearly to the user:

```
Bitcoin (BTC): $45,123.45 (+2.3% 24h)
Ethereum (ETH): $2,456.78 (-1.2% 24h)
Solana (SOL): $98.76 (+5.4% 24h)
```

## Rate Limits

CoinGecko free tier: 10-30 requests/minute. Don't spam requests.
If rate limited, wait 60 seconds before retrying.

## Examples

**User:** "What's the price of Bitcoin?"
**Action:** Fetch BTC price, format nicely

**User:** "How are BTC and ETH doing?"
**Action:** Fetch both with 24h change, show comparison

**User:** "Give me SOL market cap"
**Action:** Use detailed endpoint for Solana, extract market_cap
