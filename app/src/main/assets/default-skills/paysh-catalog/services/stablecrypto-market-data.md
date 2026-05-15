# StableCrypto Market Data (merit-systems)

CoinGecko-backed on-chain pool data — get **new pools across DEXes**, filterable by network. This is the only stablecrypto endpoint our probe has captured and verified payable; other CoinGecko-proxy paths (price lookup etc.) may exist but aren't in our verified set.

## Endpoint

- **URL:** `https://stablecrypto.dev/api/coingecko/onchain/new-pools`
- **Method:** POST (JSON body)
- **Cost:** $0.01 USDC per call (Solana mainnet)
- **Suggested max_usdc:** 0.05
- **Description (per the payment-required header):** "Get new pools across all networks"

## Body construction

**Verified schema (from the x402 payment-required header):**

```json
{
  "include": "string (optional)",
  "page": "number (optional)"
}
```

Both fields are optional; `additionalProperties: false` so no extras. Example calls:

| Intent | Body |
|---|---|
| First page of new pools (default) | `{}` |
| Second page | `{ "page": 2 }` |
| Include extra fields (refer to CoinGecko `/onchain/networks/new_pools` docs for valid `include` strings — typically `base_token`, `quote_token`, `dex`) | `{ "include": "base_token,quote_token,dex" }` |

## When to use vs free alternatives

- **Use this service** when the user wants a fresh list of new on-chain pools (newly-deployed token pairs across DEXes). Useful for tracking new liquidity events.
- **Don't use this service** for:
  - Generic crypto price lookups ("price of BTC") — this endpoint doesn't return prices. Fall back to `web_search`.
  - Historical pool data — this endpoint returns NEW pools, not history.
  - Solana-specific queries — pass `include` carefully; this is a CoinGecko proxy so its data model spans all chains.

## Response shape

JSON matching CoinGecko's `/onchain/networks/new_pools` response shape (this is a paid proxy). Return the top 3–5 pools with name, network, address, pool age — don't dump full pool arrays.
