# StableCrypto Market Data (merit-systems)

Crypto + DeFi data wrapper exposing CoinGecko (markets/coins/prices) + DefiLlama (TVL/yields/stablecoins/protocols) through a single x402 paid gateway. All endpoints are POST with $0.01 USDC per call (Solana mainnet), multi-chain offer with both `solana:` and `base:` legs (we always pick the Solana leg).

Service URL base: `https://stablecrypto.dev`

21 catalogued endpoints across CoinGecko + DefiLlama sub-APIs:

### CoinGecko endpoints (10)
- [`coingecko-price`](#coingecko-price) — current spot price for a coin
- [`coingecko-markets`](#coingecko-markets) — top coins by market cap
- [`coingecko-chart`](#coingecko-chart) — historical price chart
- [`coingecko-ohlc`](#coingecko-ohlc) — OHLC candles
- [`coingecko-top-movers`](#coingecko-top-movers) — 24h gainers/losers
- [`coingecko-trending`](#coingecko-trending) — top-searched coins
- [`coingecko-categories`](#coingecko-categories) — coin categories with market caps
- [`coingecko-onchain-pool`](#coingecko-onchain-pool) — specific DEX pool data
- [`coingecko-onchain-trending`](#coingecko-onchain-trending) — trending on-chain pools
- [`coingecko-onchain-new-pools`](#coingecko-onchain-new-pools) — newly-created DEX pools _(pre-existing entry, kept)_

### DefiLlama endpoints (11)
- [`defillama-protocols`](#defillama-protocols) — full DeFi protocol list with TVL
- [`defillama-protocol`](#defillama-protocol) — single protocol detail
- [`defillama-chains`](#defillama-chains) — TVL per chain
- [`defillama-chain-tvl`](#defillama-chain-tvl) — single chain TVL history
- [`defillama-yields-pools`](#defillama-yields-pools) — yield-farming pools (APY)
- [`defillama-yields-perps`](#defillama-yields-perps) — perps funding-rate yields
- [`defillama-stablecoins`](#defillama-stablecoins) — stablecoin market caps + peg health
- [`defillama-dex-overview`](#defillama-dex-overview) — aggregate DEX volume
- [`defillama-fees-overview`](#defillama-fees-overview) — protocol fees + revenue
- [`defillama-derivatives-overview`](#defillama-derivatives-overview) — derivatives volume
- [`defillama-coins-prices-historical`](#defillama-coins-prices-historical) — historical prices by timestamp

## Body construction (universal pattern)

All endpoints take a JSON body. The body shape mirrors the underlying CoinGecko/DefiLlama API: pass upstream API query params as JSON object fields. For example, CoinGecko's `/simple/price` API accepts `?ids=bitcoin&vs_currencies=usd`; through stablecrypto's `/api/coingecko/price` you pass:

```json
{ "ids": "bitcoin", "vs_currencies": "usd" }
```

The gateway forwards these as upstream query params. Refer to:
- CoinGecko v3 docs: https://docs.coingecko.com/reference/introduction
- DefiLlama docs: https://defillama.com/docs/api

Per-endpoint notes below cover the minimum + most-useful params. **Empty body `{}` returns 422** after payment for endpoints with required params — always include the upstream-required params.

## When to use vs free alternatives

- **Use stablecrypto** when the user wants live crypto/DeFi data and the free `solana_*` / `jupiter_*` tools don't cover it (those are Solana-native + Jupiter-routed; stablecrypto covers cross-chain CoinGecko/DefiLlama).
- **Don't use stablecrypto** for trivia ("what is Bitcoin"), historical narratives, or anything in training data. Use it for CURRENT numbers.

---

<a id="coingecko-price"></a>
## `coingecko-price` — current spot price

`POST /api/coingecko/price`

Body: `{ "ids": "<coin-id-or-comma-list>", "vs_currencies": "usd" }`

Examples:
- `{ "ids": "bitcoin", "vs_currencies": "usd" }` → BTC in USD
- `{ "ids": "solana,ethereum,bitcoin", "vs_currencies": "usd,eur" }` → multi-coin multi-currency

Returns: `{ <coin-id>: { <currency>: <price> } }`.

<a id="coingecko-markets"></a>
## `coingecko-markets` — top coins by market cap

`POST /api/coingecko/markets` — body params include `vs_currency`, `order`, `per_page`, `page`, `sparkline`.

Default `{ "vs_currency": "usd", "per_page": 10 }` returns top 10 by market cap. Surface the top N with name + price + market-cap + 24h-change. Don't dump full sparkline arrays.

<a id="coingecko-chart"></a>
## `coingecko-chart` — historical price chart

`POST /api/coingecko/chart` — body: `{ "id": "<coin>", "vs_currency": "usd", "days": <N> }`.

Returns price points over the requested window. For Telegram replies, summarize: "BTC: opened at $X, closed at $Y, ranged from $low to $high over N days, +/-Z% change."

<a id="coingecko-ohlc"></a>
## `coingecko-ohlc` — OHLC candles

`POST /api/coingecko/ohlc` — body: `{ "id": "<coin>", "vs_currency": "usd", "days": 1|7|14|30|90|180|365 }`. Returns candle data (open/high/low/close arrays). Use only when user asks for candle data specifically.

<a id="coingecko-top-movers"></a>
## `coingecko-top-movers` — 24h gainers/losers

`POST /api/coingecko/top-movers` — body: `{ "vs_currency": "usd" }`. Returns top gainers + top losers in 24h. Surface as two short lists.

<a id="coingecko-trending"></a>
## `coingecko-trending` — top-searched coins

`POST /api/coingecko/trending` — empty body `{}` is fine. Returns top-7 trending coins on CoinGecko (by search volume). Surface as a name + symbol + market-cap-rank list.

<a id="coingecko-categories"></a>
## `coingecko-categories` — coin categories

`POST /api/coingecko/categories` — body: `{ "order": "market_cap_desc" }` (default). Returns categories (DeFi, Memes, Layer-1, AI, etc.) with aggregated market cap. Surface top 10.

<a id="coingecko-onchain-pool"></a>
## `coingecko-onchain-pool` — specific DEX pool

`POST /api/coingecko/onchain/pool` — body: `{ "network": "<chain>", "pool_address": "<addr>" }`.

`network` = `solana`, `eth`, `base`, etc. Returns pool TVL, volume, recent trades, reserves. Use when user asks about a specific pool by address.

<a id="coingecko-onchain-trending"></a>
## `coingecko-onchain-trending` — trending on-chain pools

`POST /api/coingecko/onchain/trending` — body: `{ "network": "<chain-or-omit>" }`. Returns trending DEX pools across chains (or filtered to one chain).

<a id="coingecko-onchain-new-pools"></a>
## `coingecko-onchain-new-pools` — newly-created DEX pools

`POST /api/coingecko/onchain/new-pools` — body: `{ "include": "<comma-list-or-omit>", "page": <N-or-omit> }`. Recently-deployed token pairs across DEXes. This endpoint is the legacy "StableCrypto New Pools" intent from BAT-699 — kept for users who learned about it then. Optional `include` examples (refer to CoinGecko `/onchain/networks/new_pools` docs): `base_token`, `quote_token`, `dex`.

---

<a id="defillama-protocols"></a>
## `defillama-protocols` — full protocol list

`POST /api/defillama/protocols` — empty body `{}`. Returns ~2000 DeFi protocols with TVL, 1d/7d change, chains. Surface the top N by TVL or filtered to user's chain interest.

<a id="defillama-protocol"></a>
## `defillama-protocol` — single protocol detail

`POST /api/defillama/protocol` — body: `{ "protocol": "<slug>" }`.

Slug examples: `raydium`, `marinade-finance`, `jito-liquid-staking`, `uniswap-v3`. Returns TVL history, chain breakdown, token addresses.

<a id="defillama-chains"></a>
## `defillama-chains` — TVL per chain

`POST /api/defillama/chains` — empty body. Returns TVL for every chain DefiLlama tracks. Surface top 10-15 by TVL or filtered to chain the user named.

<a id="defillama-chain-tvl"></a>
## `defillama-chain-tvl` — single chain TVL history

`POST /api/defillama/chain-tvl` — body: `{ "chain": "<chain-name>" }`. Common: `Solana`, `Ethereum`, `Base`, `Arbitrum`. Returns daily TVL history. Surface current, change vs N days ago, ATH.

<a id="defillama-yields-pools"></a>
## `defillama-yields-pools` — yield-farming pools

`POST /api/defillama/yields/pools` — empty body. Returns ALL yield pools — large response. For better UX the user usually wants top-N filtered (by chain, project, APY range, stablecoin-only, etc.) — describe the filter in your reply since the raw API doesn't support it server-side, so filter client-side after fetching.

<a id="defillama-yields-perps"></a>
## `defillama-yields-perps` — perps funding rates

`POST /api/defillama/yields/perps` — empty body. Funding rates across perp protocols. Use for delta-neutral / funding-rate-arbitrage queries.

<a id="defillama-stablecoins"></a>
## `defillama-stablecoins` — stablecoin market caps

`POST /api/defillama/stablecoins` — empty body. Returns all stablecoins with circulating supply per chain, peg health, market cap. Surface top 5 by market cap + flag any with > 1% peg deviation.

<a id="defillama-dex-overview"></a>
## `defillama-dex-overview` — aggregate DEX volume

`POST /api/defillama/dex-overview` — empty body. 24h/7d/30d DEX volume across chains. Surface totals + top chains by volume.

<a id="defillama-fees-overview"></a>
## `defillama-fees-overview` — protocol fees / revenue

`POST /api/defillama/fees-overview` — empty body. Daily fees + revenue per protocol. Surface top N by 24h revenue.

<a id="defillama-derivatives-overview"></a>
## `defillama-derivatives-overview` — derivatives volume

`POST /api/defillama/derivatives-overview` — empty body. Perp DEX + centralized derivatives volume. Surface aggregate + top venues.

<a id="defillama-coins-prices-historical"></a>
## `defillama-coins-prices-historical` — historical price snapshot

`POST /api/defillama/coins/prices-historical` — body: `{ "coins": "<chain:address-or-coingecko-id>", "timestamp": <unix-seconds> }`.

Examples: `{ "coins": "coingecko:bitcoin", "timestamp": 1640995200 }` (BTC on 2022-01-01). Returns price at exactly that timestamp. Useful for backtesting or "what was X worth on date Y" queries.

## Other stablecrypto endpoints on pay.sh (not catalogued)

The BAT-706 audit confirmed 105 total endpoints. The 21 catalogued here cover the highest-intent slice for SeekerClaw users. Additional endpoints exist (e.g. `/api/coingecko/coin`, `/api/coingecko/history`, `/api/coingecko/global`, `/api/coingecko/exchange*`, additional `/api/coingecko/onchain/*` and `/api/defillama/*` variants) — most are niche, redundant with what we catalog, or specialized analytics. Deferred; future BAT can promote any specific endpoint users actually need.
