---
name: crypto-prices
description: "Get real-time cryptocurrency prices and market data from CoinGecko (free, no API key). Use when: user asks about crypto prices, token values, market data, 'what's BTC at?'. Don't use when: user wants to swap/trade tokens (use wallet tools), or wants crypto news (use news skill)."
version: "1.0.0"
metadata:
  openclaw:
    emoji: "💰"
    requires:
      bins: []
      env: []
---

# Crypto Prices

Get cryptocurrency prices using the free CoinGecko API.

## Use when
- Crypto prices ("What's Bitcoin at?", "SOL price")
- Market data ("Is ETH up or down?")
- Multiple coins ("Price of BTC, ETH, and SOL")

## Don't use when
- Swap or trade tokens (use wallet/Jupiter tools)
- Crypto news or analysis (use news or research)
- Wallet balances (use wallet tools)

## API Endpoints

### Get single coin price
```javascript
web_fetch({
  url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
})
```

### Get multiple coins with 24h change
```javascript
web_fetch({
  url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true"
})
```

## Coin ID Mapping

| Symbol | CoinGecko ID |
|--------|--------------|
| BTC | bitcoin |
| ETH | ethereum |
| SOL | solana |
| USDC | usd-coin |
| DOGE | dogecoin |
| ADA | cardano |
| XRP | ripple |

## Response Format

Present prices clearly:
```
Bitcoin (BTC): $45,123.45 (+2.3% 24h)
Ethereum (ETH): $2,456.78 (-1.2% 24h)
```

## Rate Limits

CoinGecko free tier: 10-30 requests/minute.
