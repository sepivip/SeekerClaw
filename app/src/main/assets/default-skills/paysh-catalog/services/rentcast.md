# Rentcast Markets (paysponge)

US rental real-estate market data — average rent, median price, vacancy rates, year-over-year trends, etc.

## Endpoint

- **URL pattern:** `https://rentcast.x402.paysponge.com/markets?<query-string>`
- **Method:** GET
- **Cost:** $0.01 USDC per call (Solana mainnet)
- **Suggested max_usdc:** 0.05

## Query construction

Standard Rentcast `/markets` query params. Most useful:

| Param | Example | Notes |
|---|---|---|
| `zipCode` | `zipCode=90210` | 5-digit US ZIP |
| `city` | `city=Austin` | URL-encode `+` for spaces |
| `state` | `state=TX` | 2-letter |
| `historyRange` | `historyRange=6` | Months of trend |
| `bedrooms` | `bedrooms=2` | 1-5 |

Combine as needed: `?zipCode=78701&bedrooms=2&historyRange=12`

## When to use vs free alternatives

- **Use Rentcast** for current rental data, market trends, or specific-property statistics that your training data can't have.
- **Don't use Rentcast** for property listings on a specific site (use the site's own search), or for non-US markets — Rentcast is US-only.

## Response shape

JSON with the requested market stats. Return the key numbers (median rent, YoY %, sample size) — don't dump the full payload.
