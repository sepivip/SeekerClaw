# StableCrypto Market Data (merit-systems)

CoinGecko-backed crypto market data — token prices, market caps, new on-chain pools, etc.

## Endpoint

- **URL pattern:** `https://stablecrypto.dev/api/coingecko/onchain/new-pools` (and other CoinGecko-proxied paths under `/api/coingecko/...`)
- **Method:** POST (JSON body — CoinGecko query forwarded server-side)
- **Cost:** $0.01 USDC per call (Solana mainnet)
- **Suggested max_usdc:** 0.05

## Body construction

The body shape mirrors CoinGecko's own API parameters. For new-pools example:

```json
{
  "network": "solana",
  "page": 1,
  "limit": 20
}
```

For token price lookup (different sub-endpoint — path may vary): pass the CoinGecko `ids` or `contract_addresses` list.

## When to use vs free alternatives

- **Use StableCrypto** when you need authoritative live market data — current prices, market caps, ranking, trending pools.
- **Don't use StableCrypto** for prices the user already mentioned in conversation, historical prices your training data covers, or simple "what's the price of BTC" where a `web_search` is fine.

## Response shape

JSON matching CoinGecko's native response shape (this is a paid CoinGecko proxy). Return the requested fields concisely — don't dump full pool/token arrays.

## Notes

- Replaces the older `paysponge/coingecko` endpoint which is no longer in pay.sh's catalog (caught in 2026-05-14 probe).
