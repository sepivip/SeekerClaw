# pay.sh catalog audit — multi-endpoint probe per service

Generated: 2026-05-16T11:13:50.378Z
Source: probe-catalog.js --audit --concurrency 4 --audit-side-effects

## Aggregate

| Metric | Count |
|--------|-------|
| Services audited | 72 |
| Endpoints discovered (across all services) | 824 |
| **Parsed OK** (Solana-USDC parseable 402) | 384 |
| Rejected (402 but parser refused) | 312 |
| Non-402 HTTP response (http_4xx/5xx/3xx/2xx) | 127 |
| Skipped (non-GET, side-effect risk; opt in via --audit-side-effects) | 0 |
| Fetch failed (DNS / TLS / timeout — no HTTP response) | 1 |
| Audit elapsed | 319.9s |

## All parsed_ok endpoints from this audit run

Every endpoint that parsed_ok with a Solana-USDC leg. This includes endpoints already in our standard catalog (`tests/paysh/catalog-summary.md`) AND endpoints we don't currently catalog. Cross-reference manually with catalog-summary.md to identify the audit's new discoveries (multi-endpoint providers like paysponge/perplexity and paysponge/rentcast typically show many endpoints here that catalog-summary records as only one per service).

| Service | Method | Path | Networks | Asset | Amount | Result |
|---------|--------|------|----------|-------|--------|--------|
| agentmail/email | POST | `/v0/pods` | base+sol+eip155+eip155 | USDC | $0.01 | `parsed_ok` |
| agentmail/email | POST | `/v0/domains` | base+sol+eip155+eip155 | USDC | $10 | `parsed_ok` |
| agentmail/email | POST | `/v0/inboxes` | base+sol+eip155+eip155 | USDC | $2 | `parsed_ok` |
| agentmail/email | POST | `/v0/webhooks` | base+sol+eip155+eip155 | USDC | $0.01 | `parsed_ok` |
| agentmail/email | POST | `/v0/pods/probe/domains` | base+sol+eip155+eip155 | USDC | $10 | `parsed_ok` |
| agentmail/email | POST | `/v0/pods/probe/inboxes` | base+sol+eip155+eip155 | USDC | $2 | `parsed_ok` |
| agentmail/email | POST | `/v0/lists/probe/probe` | base+sol+eip155+eip155 | USDC | $0.01 | `parsed_ok` |
| agentmail/email | POST | `/v0/pods/probe/lists/probe/probe` | base+sol+eip155+eip155 | USDC | $0.01 | `parsed_ok` |
| crushrewards/pricing | GET | `/v1/shopper/best-price` | sol+sol+base | USDC | $0.01 | `parsed_ok` |
| crushrewards/pricing | GET | `/v1/shopper/price-history` | sol+sol+base | USDC | $0.01 | `parsed_ok` |
| crushrewards/pricing | GET | `/v1/shopper/deal-finder` | sol+sol+base | USDC | $0.01 | `parsed_ok` |
| crushrewards/pricing | GET | `/v1/shopper/price-drop-alert` | sol+sol+base | USDC | $0.01 | `parsed_ok` |
| crushrewards/pricing | GET | `/v1/marketing/competitive-landscape` | sol+sol+base | USDC | $0.01 | `parsed_ok` |
| crushrewards/pricing | GET | `/v1/marketing/brand-tracker` | sol+sol+base | USDC | $0.01 | `parsed_ok` |
| crushrewards/pricing | GET | `/v1/marketing/promo-intelligence` | sol+sol+base | USDC | $0.01 | `parsed_ok` |
| crushrewards/pricing | GET | `/v1/marketing/share-of-shelf` | sol+sol+base | USDC | $0.01 | `parsed_ok` |
| crushrewards/pricing | GET | `/v1/marketing/price-positioning` | sol+sol+base | USDC | $0.01 | `parsed_ok` |
| crushrewards/pricing | GET | `/v1/analyst/inflation` | sol+sol+base | USDC | $0.02 | `parsed_ok` |
| crushrewards/pricing | GET | `/v1/analyst/price-dispersion` | sol+sol+base | USDC | $0.02 | `parsed_ok` |
| crushrewards/pricing | GET | `/v1/analyst/retailer-index` | sol+sol+base | USDC | $0.02 | `parsed_ok` |
| crushrewards/pricing | GET | `/v1/analyst/category-summary` | sol+sol+base | USDC | $0.02 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/coingecko/onchain/trending` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/coingecko/price` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/coingecko/markets` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/coingecko/coin` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/coingecko/chart` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/coingecko/ohlc` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/coingecko/history` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/coingecko/trending` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/coingecko/global` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/coingecko/categories` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/coingecko/top-movers` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/coingecko/exchange` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/coingecko/exchange/tickers` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/coingecko/exchange/volume-chart` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/coingecko/onchain/networks` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/coingecko/onchain/search` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/coingecko/onchain/new-pools` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/coingecko/onchain/categories` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/coingecko/onchain/pool` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/coingecko/onchain/pool/info` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/coingecko/onchain/pool/ohlcv` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/coingecko/onchain/pool/trades` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/coingecko/onchain/network/dexes` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/coingecko/onchain/network/trending` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/coingecko/onchain/network/new-pools` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/coingecko/onchain/network/pools` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/coingecko/onchain/category/pools` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/protocols` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/protocol` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/tvl` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/chains` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/chain-tvl` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/coins/prices` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/coins/prices-historical` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/coins/batch-historical` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/coins/chart` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/coins/block` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/stablecoins` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/stablecoin` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/stablecoin-charts` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/stablecoin-chains` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/dex-overview` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/dex-summary` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/options-overview` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/derivatives-overview` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/fees-overview` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/fees-summary` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/yields/pools` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/yields/chart` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/yields/pools-borrow` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/yields/perps` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/yields/lsd-rates` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/emissions` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/emission` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/defi-categories` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/forks` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/oracles` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/hacks` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/raises` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/etfs/overview` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/etfs/history` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/bridges` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/bridge` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/bridge-volume` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/bridge-transactions` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/treasuries` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/defillama/treasury` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/alchemy/token/token-balances` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/alchemy/token/token-metadata` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/alchemy/token/token-allowance` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/alchemy/transfers/asset-transfers` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/alchemy/prices/by-symbol` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/alchemy/prices/by-address` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/alchemy/prices/historical` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/alchemy/portfolio/tokens` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/alchemy/portfolio/token-balances` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/alchemy/portfolio/nfts` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/alchemy/portfolio/nft-collections` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/alchemy/simulation/simulate-asset-changes` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/alchemy/simulation/simulate-execution` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/alchemy/utility/transaction-receipts` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/alchemy/node/rpc` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/etherscan/account/balance` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/etherscan/account/balance-multi` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/etherscan/account/txlist` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/etherscan/account/txlist-internal` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/etherscan/account/tokentx` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/etherscan/account/tokennfttx` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/etherscan/account/token1155tx` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/etherscan/contract/getabi` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/etherscan/contract/getsourcecode` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/etherscan/contract/getcontractcreation` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/etherscan/transaction/getstatus` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/etherscan/transaction/gettxreceiptstatus` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/etherscan/block/getblockreward` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/etherscan/logs/getLogs` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/etherscan/token/tokensupply` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/etherscan/token/tokeninfo` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/etherscan/gas/gasestimate` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/etherscan/gas/gasoracle` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/etherscan/stats/ethprice` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/etherscan/stats/ethsupply` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/etherscan/stats/nodecount` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/etherscan/stats/chainsize` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stablecrypto/market-data | POST | `/api/etherscan/stats/dailytx` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stableemail/email | POST | `/api/inbox/topup/year` | base+sol | USDC | $8 | `parsed_ok` |
| merit-systems/stableemail/email | POST | `/api/inbox/messages` | base+sol | USDC | $0.001 | `parsed_ok` |
| merit-systems/stableemail/email | POST | `/api/send` | base+sol | USDC | $0.02 | `parsed_ok` |
| merit-systems/stableemail/email | POST | `/api/subdomain/send` | base+sol | USDC | $0.005 | `parsed_ok` |
| merit-systems/stableemail/email | POST | `/api/inbox/send` | base+sol | USDC | $0.005 | `parsed_ok` |
| merit-systems/stableemail/email | POST | `/api/inbox/topup` | base+sol | USDC | $1 | `parsed_ok` |
| merit-systems/stableemail/email | POST | `/api/inbox/topup/quarter` | base+sol | USDC | $2.5 | `parsed_ok` |
| merit-systems/stableemail/email | POST | `/api/inbox/messages/read` | base+sol | USDC | $0.001 | `parsed_ok` |
| merit-systems/stableemail/email | POST | `/api/subdomain/inbox/create` | base+sol | USDC | $0.25 | `parsed_ok` |
| merit-systems/stableemail/email | POST | `/api/subdomain/inbox/messages` | base+sol | USDC | $0.001 | `parsed_ok` |
| merit-systems/stableemail/email | POST | `/api/subdomain/inbox/messages/read` | base+sol | USDC | $0.001 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/apollo/org-search` | base+sol | USDC | $0.02 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/exa/search` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/apollo/people-search` | base+sol | USDC | $0.02 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/apollo/people-enrich` | base+sol | USDC | $0.0495 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/apollo/org-enrich` | base+sol | USDC | $0.0495 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/clado/contacts-enrich` | base+sol | USDC | $0.2 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/exa/find-similar` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/exa/contents` | base+sol | USDC | $0.002 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/exa/answer` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/firecrawl/scrape` | base+sol | USDC | $0.0126 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/firecrawl/search` | base+sol | USDC | $0.0252 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/google-maps/text-search/partial` | base+sol | USDC | $0.02 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/google-maps/text-search/full` | base+sol | USDC | $0.08 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/google-maps/nearby-search/partial` | base+sol | USDC | $0.02 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/google-maps/nearby-search/full` | base+sol | USDC | $0.08 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/google-maps/aerial-view/render-video` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/serper/news` | base+sol | USDC | $0.04 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/serper/shopping` | base+sol | USDC | $0.04 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/serper/images` | base+sol | USDC | $0.04 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/serper/people-image-search` | base+sol | USDC | $0.04 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/serper/lens` | base+sol | USDC | $0.2 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/whitepages/person-search` | base+sol | USDC | $0.44 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/whitepages/property-search` | base+sol | USDC | $0.44 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/reddit/search` | base+sol | USDC | $0.02 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/reddit/post-comments` | base+sol | USDC | $0.02 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/hunter/email-verifier` | base+sol | USDC | $0.03 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/influencer/enrich-by-email` | base+sol | USDC | $0.4 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/influencer/enrich-by-social` | base+sol | USDC | $0.4 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/minerva/resolve` | base+sol | USDC | $0.02 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/minerva/enrich` | base+sol | USDC | $0.05 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/minerva/validate-emails` | base+sol | USDC | $0.01 | `parsed_ok` |
| merit-systems/stableenrich/enrichment | POST | `/api/cloudflare/crawl` | base+sol | USDC | $0.1 | `parsed_ok` |
| merit-systems/stablephone/calls | POST | `/api/lookup` | base+sol | USDC | $0.05 | `parsed_ok` |
| merit-systems/stablephone/calls | POST | `/api/number` | base+sol | USDC | $20 | `parsed_ok` |
| merit-systems/stablephone/calls | POST | `/api/number/topup` | base+sol | USDC | $15 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/facebook/post-comments` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/tiktok/profile` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/instagram/comment-replies` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/reddit/search` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/facebook/search-people` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/tiktok/comment-replies` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/facebook/following` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/tiktok/posts` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/tiktok/post-comments` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/tiktok/followers` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/tiktok/following` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/tiktok/search` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/tiktok/search-hashtag` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/tiktok/search-profiles` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/tiktok/search-music` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/instagram/profile` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/instagram/posts` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/instagram/post-comments` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/instagram/followers` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/instagram/following` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/instagram/stories` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/instagram/highlights` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/instagram/search` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/instagram/search-tags` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/facebook/profile` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/facebook/posts` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/facebook/comment-replies` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/facebook/followers` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/facebook/search` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/facebook/search-pages` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/facebook/search-groups` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/reddit/post` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/reddit/post-comments` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/reddit/comment` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/reddit/search-profiles` | base+sol | USDC | $0.06 | `parsed_ok` |
| merit-systems/stablesocial/social-data | POST | `/api/reddit/subreddit` | base+sol | USDC | $0.06 | `parsed_ok` |
| paysponge/2captcha | POST | `/createTask` | base+sol | USDC | $0.01 | `parsed_ok` |
| paysponge/fal | POST | `/fal-ai/fast-sdxl` | base+sol | USDC | $0.01 | `parsed_ok` |
| paysponge/fal | POST | `/fal-ai/flux/dev` | base+sol | USDC | $0.03 | `parsed_ok` |
| paysponge/fal | POST | `/fal-ai/flux-pro/v1.1` | base+sol | USDC | $0.04 | `parsed_ok` |
| paysponge/fal | POST | `/fal-ai/flux-pro/v1.1-ultra` | base+sol | USDC | $0.06 | `parsed_ok` |
| paysponge/fal | POST | `/fal-ai/flux/schnell` | base+sol | USDC | $0.01 | `parsed_ok` |
| paysponge/fal | POST | `/fal-ai/minimax/video-01` | base+sol | USDC | $0.07 | `parsed_ok` |
| paysponge/fal | POST | `/fal-ai/recraft-v3` | base+sol | USDC | $0.04 | `parsed_ok` |
| paysponge/fal | POST | `/fal-ai/stable-diffusion-v35-large` | base+sol | USDC | $0.04 | `parsed_ok` |
| paysponge/fal | POST | `/fal-ai/stable-video` | base+sol | USDC | $0.07 | `parsed_ok` |
| paysponge/nyne | POST | `/person/enrichment` | base+sol | USDC | $0.02 | `parsed_ok` |
| paysponge/nyne | POST | `/person/search` | base+sol | USDC | $0.02 | `parsed_ok` |
| paysponge/perplexity | POST | `/search` | base+sol | USDC | $0.01 | `parsed_ok` |
| paysponge/perplexity | POST | `/v1/agent` | base+sol | USDC | $0.01 | `parsed_ok` |
| paysponge/perplexity | POST | `/v1/async/sonar` | base+sol | USDC | $0.01 | `parsed_ok` |
| paysponge/reducto | POST | `/extract` | base+sol | USDC | $0.05 | `parsed_ok` |
| paysponge/reducto | POST | `/parse` | base+sol | USDC | $0.05 | `parsed_ok` |
| paysponge/rentcast | GET | `/markets` | base+sol | USDC | $0.01 | `parsed_ok` |
| paysponge/rentcast | GET | `/avm/value` | base+sol | USDC | $0.01 | `parsed_ok` |
| paysponge/rentcast | GET | `/properties` | base+sol | USDC | $0.01 | `parsed_ok` |
| paysponge/rentcast | GET | `/listings/sale` | base+sol | USDC | $0.01 | `parsed_ok` |
| paysponge/rentcast | GET | `/properties/probe` | base+sol | USDC | $0.01 | `parsed_ok` |
| paysponge/rentcast | GET | `/properties/random` | base+sol | USDC | $0.01 | `parsed_ok` |
| paysponge/rentcast | GET | `/avm/rent/long-term` | base+sol | USDC | $0.01 | `parsed_ok` |
| paysponge/rentcast | GET | `/listings/sale/probe` | base+sol | USDC | $0.01 | `parsed_ok` |
| paysponge/rentcast | GET | `/listings/rental/long-term` | base+sol | USDC | $0.01 | `parsed_ok` |
| paysponge/rentcast | GET | `/listings/rental/long-term/probe` | base+sol | USDC | $0.01 | `parsed_ok` |
| paysponge/screenshotone | GET | `/animate` | base+sol | USDC | $0.02 | `parsed_ok` |
| paysponge/screenshotone | GET | `/take` | base+sol | USDC | $0.02 | `parsed_ok` |
| paysponge/screenshotone | POST | `/take` | base+sol | USDC | $0.02 | `parsed_ok` |
| paysponge/textbelt | POST | `/text` | base+sol | USDC | $0.02 | `parsed_ok` |
| paysponge/tripadvisor | GET | `/api/v1/location/probe/details` | base+sol | USDC | $0.01 | `parsed_ok` |
| paysponge/tripadvisor | GET | `/api/v1/location/probe/photos` | base+sol | USDC | $0.01 | `parsed_ok` |
| paysponge/tripadvisor | GET | `/api/v1/location/probe/reviews` | base+sol | USDC | $0.01 | `parsed_ok` |
| paysponge/tripadvisor | GET | `/api/v1/location/nearby_search` | base+sol | USDC | $0.01 | `parsed_ok` |
| paysponge/tripadvisor | GET | `/api/v1/location/search` | base+sol | USDC | $0.01 | `parsed_ok` |
| paysponge/wolframalpha | GET | `/v1/result` | base+sol | USDC | $0.01 | `parsed_ok` |
| paysponge/wolframalpha | GET | `/v1/simple` | base+sol | USDC | $0.01 | `parsed_ok` |
| paysponge/wolframalpha | GET | `/v2/query` | base+sol | USDC | $0.02 | `parsed_ok` |
| purch/marketplace | GET | `/x402/search` | sol | USDC | $0.01 | `parsed_ok` |
| purch/marketplace | POST | `/x402/shop` | sol | USDC | $0.1 | `parsed_ok` |
| purch/marketplace | GET | `/x402/vault/search` | sol | USDC | $0.01 | `parsed_ok` |
| purch/marketplace | POST | `/x402/vault/buy` | sol | USDC | $0.01 | `parsed_ok` |
| quicknode/rpc | POST | `/sql/rest/v1/query` | base+base+eip155+eip155+eip155+eip155+eip155+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/0g-galileo/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/0g-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/abstract-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/abstract-testnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/aptos-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/aptos-testnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/arbitrum-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/arbitrum-sepolia/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/arc-testnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/avalanche-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/avalanche-testnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/b3-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/b3-sepolia/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/base-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/base-sepolia/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/bch-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/bch-testnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/bera-bepolia/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/bera-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/blast-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/blast-sepolia/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/bsc-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/bsc-testnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/btc-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/btc-testnet4/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/celestia-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/celestia-mocha/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/celo-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/cosmos-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/cyber-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/cyber-sepolia/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/doge-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/dot-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/ethereum-hoodi/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/ethereum-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/ethereum-sepolia/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/fantom-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/flare-coston2/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/flare-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/flow-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/flow-testnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/fraxtal-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/fuel-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/fuel-sepolia/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/gravity-alpham/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/hedera-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/hedera-testnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/hemi-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/hemi-testnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/hype-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/hype-testnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/imx-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/imx-testnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/injective-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/injective-testnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/ink-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/ink-sepolia/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/joc-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/kaia-kairos/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/kaia-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/lens-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/lens-testnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/linea-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/lisk-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/ltc-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/ltc-testnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/mantle-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/mantle-sepolia/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/matic-amoy/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/matic-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/mode-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/monad-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/monad-testnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/morph-hoodi/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/morph-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/near-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/near-testnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/nova-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/omni-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/omni-omega/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/optimism-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/optimism-sepolia/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/osmosis-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/peaq-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/plasma-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/plasma-testnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/redstone-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/sahara-testnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/scroll-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/scroll-testnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/sei-atlantic/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/sei-pacific/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/solana-devnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/solana-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/solana-testnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/soneium-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/sonic-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/sophon-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/sophon-testnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/stacks-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/stacks-testnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/stellar-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/stellar-testnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/story-aeneid/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/story-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/strk-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/strk-sepolia/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/sui-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/sui-testnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/tempo-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/tempo-testnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/ton-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/tron-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/unichain-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/unichain-sepolia/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/vana-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/vana-moksha/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/worldchain-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/worldchain-sepolia/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/xai-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/xai-testnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/xdai-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/xlayer-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/xlayer-testnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/xrp-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/xrp-testnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/xrplevm-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/xrplevm-testnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/zkevm-cardona/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/zkevm-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/zksync-mainnet/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |
| quicknode/rpc | POST | `/zksync-sepolia/` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | SPL | $1 | `parsed_ok` |

## Audit errors (services where openapi.json was unreachable or empty)

- **paysponge/coingecko**: openapi fetch failed: status 401
- **solana-foundation/google/addressvalidation**: openapi has no endpoints
- **solana-foundation/google/airquality**: openapi has no endpoints
- **solana-foundation/google/bigquery**: openapi fetch failed: status 404
- **solana-foundation/google/documentai**: openapi has no endpoints
- **solana-foundation/google/generativelanguage**: openapi has no endpoints
- **solana-foundation/google/translate**: openapi has no endpoints

## Full per-service breakdown

### agentmail/email

Service URL: `https://x402.api.agentmail.to`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| GET | `/v0/pods` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| POST | `/v0/pods` | `parsed_ok` | base+sol+eip155+eip155 | $0.01 |
| GET | `/v0/drafts` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| GET | `/v0/domains` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| POST | `/v0/domains` | `parsed_ok` | base+sol+eip155+eip155 | $10 |
| GET | `/v0/inboxes` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| POST | `/v0/inboxes` | `parsed_ok` | base+sol+eip155+eip155 | $2 |
| GET | `/v0/metrics` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| GET | `/v0/threads` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| GET | `/v0/webhooks` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| POST | `/v0/webhooks` | `parsed_ok` | base+sol+eip155+eip155 | $0.01 |
| GET | `/v0/pods/probe` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| DELETE | `/v0/pods/probe` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| GET | `/v0/drafts/probe` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| GET | `/v0/inboxes/probe` | `http_403` | — | — |
| PATCH | `/v0/inboxes/probe` | `http_403` | — | — |
| DELETE | `/v0/inboxes/probe` | `http_403` | — | — |
| GET | `/v0/domains/probe` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| PATCH | `/v0/domains/probe` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| DELETE | `/v0/domains/probe` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| GET | `/v0/threads/probe` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| DELETE | `/v0/threads/probe` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| GET | `/v0/pods/probe/drafts` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| GET | `/v0/pods/probe/domains` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| POST | `/v0/pods/probe/domains` | `parsed_ok` | base+sol+eip155+eip155 | $10 |
| GET | `/v0/pods/probe/inboxes` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| POST | `/v0/pods/probe/inboxes` | `parsed_ok` | base+sol+eip155+eip155 | $2 |
| GET | `/v0/pods/probe/metrics` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| GET | `/v0/pods/probe/threads` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| GET | `/v0/webhooks/probe` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| PATCH | `/v0/webhooks/probe` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| DELETE | `/v0/webhooks/probe` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| GET | `/v0/lists/probe/probe` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| POST | `/v0/lists/probe/probe` | `parsed_ok` | base+sol+eip155+eip155 | $0.01 |
| GET | `/v0/inboxes/probe/drafts` | `http_403` | — | — |
| POST | `/v0/inboxes/probe/drafts` | `http_403` | — | — |
| POST | `/v0/domains/probe/verify` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| GET | `/v0/inboxes/probe/metrics` | `http_403` | — | — |
| GET | `/v0/inboxes/probe/threads` | `http_403` | — | — |
| GET | `/v0/inboxes/probe/messages` | `http_403` | — | — |
| GET | `/v0/domains/probe/zone-file` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| GET | `/v0/pods/probe/drafts/probe` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| POST | `/v0/inboxes/probe/messages/send` | `http_403` | — | — |
| GET | `/v0/lists/probe/probe/probe` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| DELETE | `/v0/lists/probe/probe/probe` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| GET | `/v0/pods/probe/inboxes/probe` | `http_403` | — | — |
| PATCH | `/v0/pods/probe/inboxes/probe` | `http_403` | — | — |
| DELETE | `/v0/pods/probe/inboxes/probe` | `http_403` | — | — |
| GET | `/v0/pods/probe/domains/probe` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| PATCH | `/v0/pods/probe/domains/probe` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| DELETE | `/v0/pods/probe/domains/probe` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| GET | `/v0/pods/probe/threads/probe` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| DELETE | `/v0/pods/probe/threads/probe` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| GET | `/v0/inboxes/probe/drafts/probe` | `http_403` | — | — |
| PATCH | `/v0/inboxes/probe/drafts/probe` | `http_403` | — | — |
| DELETE | `/v0/inboxes/probe/drafts/probe` | `http_403` | — | — |
| GET | `/v0/inboxes/probe/threads/probe` | `http_403` | — | — |
| DELETE | `/v0/inboxes/probe/threads/probe` | `http_403` | — | — |
| GET | `/v0/pods/probe/lists/probe/probe` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| POST | `/v0/pods/probe/lists/probe/probe` | `parsed_ok` | base+sol+eip155+eip155 | $0.01 |
| GET | `/v0/inboxes/probe/messages/probe` | `http_403` | — | — |
| PATCH | `/v0/inboxes/probe/messages/probe` | `http_403` | — | — |
| POST | `/v0/pods/probe/domains/probe/verify` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| POST | `/v0/inboxes/probe/drafts/probe/send` | `http_403` | — | — |
| GET | `/v0/inboxes/probe/lists/probe/probe` | `http_403` | — | — |
| POST | `/v0/inboxes/probe/lists/probe/probe` | `http_403` | — | — |
| GET | `/v0/pods/probe/domains/probe/zone-file` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| GET | `/v0/inboxes/probe/messages/probe/raw` | `http_403` | — | — |
| GET | `/v0/drafts/probe/attachments/probe` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| POST | `/v0/inboxes/probe/messages/probe/reply` | `http_403` | — | — |
| GET | `/v0/pods/probe/lists/probe/probe/probe` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| DELETE | `/v0/pods/probe/lists/probe/probe/probe` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| GET | `/v0/threads/probe/attachments/probe` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| POST | `/v0/inboxes/probe/messages/probe/forward` | `http_403` | — | — |
| POST | `/v0/inboxes/probe/messages/probe/reply-all` | `http_403` | — | — |
| GET | `/v0/inboxes/probe/lists/probe/probe/probe` | `http_403` | — | — |
| DELETE | `/v0/inboxes/probe/lists/probe/probe/probe` | `http_403` | — | — |
| GET | `/v0/pods/probe/drafts/probe/attachments/probe` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| GET | `/v0/pods/probe/threads/probe/attachments/probe` | `reject:invalid_demand` | base+sol+eip155+eip155 | $0 |
| GET | `/v0/inboxes/probe/drafts/probe/attachments/probe` | `http_403` | — | — |
| GET | `/v0/inboxes/probe/threads/probe/attachments/probe` | `http_403` | — | — |
| GET | `/v0/inboxes/probe/messages/probe/attachments/probe` | `http_403` | — | — |

### crushrewards/pricing

Service URL: `https://api.crushrewards.dev`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| GET | `/v1/shopper/best-price` | `parsed_ok` | sol+sol+base | $0.01 |
| GET | `/v1/shopper/price-history` | `parsed_ok` | sol+sol+base | $0.01 |
| GET | `/v1/shopper/deal-finder` | `parsed_ok` | sol+sol+base | $0.01 |
| GET | `/v1/shopper/price-drop-alert` | `parsed_ok` | sol+sol+base | $0.01 |
| GET | `/v1/marketing/competitive-landscape` | `parsed_ok` | sol+sol+base | $0.01 |
| GET | `/v1/marketing/brand-tracker` | `parsed_ok` | sol+sol+base | $0.01 |
| GET | `/v1/marketing/promo-intelligence` | `parsed_ok` | sol+sol+base | $0.01 |
| GET | `/v1/marketing/share-of-shelf` | `parsed_ok` | sol+sol+base | $0.01 |
| GET | `/v1/marketing/price-positioning` | `parsed_ok` | sol+sol+base | $0.01 |
| GET | `/v1/analyst/inflation` | `parsed_ok` | sol+sol+base | $0.02 |
| GET | `/v1/analyst/price-dispersion` | `parsed_ok` | sol+sol+base | $0.02 |
| GET | `/v1/analyst/retailer-index` | `parsed_ok` | sol+sol+base | $0.02 |
| GET | `/v1/analyst/category-summary` | `parsed_ok` | sol+sol+base | $0.02 |

### dtelecom/voice

Service URL: `https://x402.dtelecom.org`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/v1/credits/purchase` | `reject:invalid_demand` | base+sol | $0 |
| POST | `/v1/credits/purchase/mpp` | `reject:no_payment_requirements` | — | — |
| POST | `/v1/credits/purchase/tron` | `http_400` | — | — |
| GET | `/v1/account` | `http_401` | — | — |
| GET | `/v1/account/transactions` | `http_401` | — | — |
| GET | `/v1/account/sessions` | `http_401` | — | — |
| POST | `/v1/webrtc/token` | `http_401` | — | — |
| POST | `/v1/webrtc/token/extend` | `http_401` | — | — |
| POST | `/v1/stt/session` | `http_401` | — | — |
| POST | `/v1/stt/session/extend` | `http_401` | — | — |
| POST | `/v1/tts/session` | `http_401` | — | — |
| POST | `/v1/tts/session/extend` | `http_401` | — | — |
| POST | `/v1/agent-session` | `http_401` | — | — |
| POST | `/v1/agent-session/extend` | `http_401` | — | — |
| GET | `/v1/pricing` | `http_200` | — | — |
| GET | `/v1/servers/status` | `http_200` | — | — |

### merit-systems/stablecrypto/market-data

Service URL: `https://stablecrypto.dev`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/api/coingecko/onchain/trending` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/coingecko/price` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/coingecko/markets` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/coingecko/coin` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/coingecko/chart` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/coingecko/ohlc` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/coingecko/history` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/coingecko/trending` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/coingecko/global` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/coingecko/categories` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/coingecko/top-movers` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/coingecko/exchange` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/coingecko/exchange/tickers` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/coingecko/exchange/volume-chart` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/coingecko/onchain/networks` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/coingecko/onchain/search` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/coingecko/onchain/new-pools` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/coingecko/onchain/categories` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/coingecko/onchain/pool` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/coingecko/onchain/pool/info` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/coingecko/onchain/pool/ohlcv` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/coingecko/onchain/pool/trades` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/coingecko/onchain/network/dexes` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/coingecko/onchain/network/trending` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/coingecko/onchain/network/new-pools` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/coingecko/onchain/network/pools` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/coingecko/onchain/category/pools` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/protocols` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/protocol` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/tvl` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/chains` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/chain-tvl` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/coins/prices` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/coins/prices-historical` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/coins/batch-historical` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/coins/chart` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/coins/block` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/stablecoins` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/stablecoin` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/stablecoin-charts` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/stablecoin-chains` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/dex-overview` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/dex-summary` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/options-overview` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/derivatives-overview` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/fees-overview` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/fees-summary` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/yields/pools` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/yields/chart` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/yields/pools-borrow` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/yields/perps` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/yields/lsd-rates` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/emissions` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/emission` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/defi-categories` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/forks` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/oracles` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/hacks` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/raises` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/etfs/overview` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/etfs/history` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/bridges` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/bridge` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/bridge-volume` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/bridge-transactions` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/treasuries` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/defillama/treasury` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/alchemy/token/token-balances` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/alchemy/token/token-metadata` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/alchemy/token/token-allowance` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/alchemy/transfers/asset-transfers` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/alchemy/prices/by-symbol` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/alchemy/prices/by-address` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/alchemy/prices/historical` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/alchemy/portfolio/tokens` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/alchemy/portfolio/token-balances` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/alchemy/portfolio/nfts` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/alchemy/portfolio/nft-collections` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/alchemy/simulation/simulate-asset-changes` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/alchemy/simulation/simulate-execution` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/alchemy/utility/transaction-receipts` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/alchemy/node/rpc` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/etherscan/account/balance` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/etherscan/account/balance-multi` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/etherscan/account/txlist` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/etherscan/account/txlist-internal` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/etherscan/account/tokentx` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/etherscan/account/tokennfttx` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/etherscan/account/token1155tx` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/etherscan/contract/getabi` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/etherscan/contract/getsourcecode` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/etherscan/contract/getcontractcreation` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/etherscan/transaction/getstatus` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/etherscan/transaction/gettxreceiptstatus` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/etherscan/block/getblockreward` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/etherscan/logs/getLogs` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/etherscan/token/tokensupply` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/etherscan/token/tokeninfo` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/etherscan/gas/gasestimate` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/etherscan/gas/gasoracle` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/etherscan/stats/ethprice` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/etherscan/stats/ethsupply` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/etherscan/stats/nodecount` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/etherscan/stats/chainsize` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/etherscan/stats/dailytx` | `parsed_ok` | base+sol | $0.01 |

### merit-systems/stabledomains/domains

Service URL: `https://stabledomains.dev`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| GET | `/api/domain/list` | `reject:siwx_auth_required` | — | — |
| POST | `/api/check` | `http_400` | — | — |
| POST | `/api/register` | `http_400` | — | — |
| POST | `/api/domain/renew` | `http_400` | — | — |
| GET | `/api/domain/status` | `http_400` | — | — |
| GET | `/api/domain/dns` | `http_400` | — | — |
| POST | `/api/domain/dns` | `reject:siwx_auth_required` | — | — |
| POST | `/api/domain/transfer-out` | `reject:siwx_auth_required` | — | — |

### merit-systems/stableemail/email

Service URL: `https://stableemail.dev`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/api/inbox/topup/year` | `parsed_ok` | base+sol | $8 |
| POST | `/api/subdomain/inbox/list` | `reject:siwx_auth_required` | — | — |
| POST | `/api/subdomain/inbox/delete` | `reject:siwx_auth_required` | — | — |
| POST | `/api/subdomain/inbox/update` | `reject:siwx_auth_required` | — | — |
| POST | `/api/subdomain/inbox/messages/delete` | `reject:siwx_auth_required` | — | — |
| POST | `/api/inbox/messages` | `parsed_ok` | base+sol | $0.001 |
| POST | `/api/send` | `parsed_ok` | base+sol | $0.02 |
| POST | `/api/subdomain/buy` | `http_400` | — | — |
| POST | `/api/subdomain/send` | `parsed_ok` | base+sol | $0.005 |
| POST | `/api/inbox/buy` | `http_400` | — | — |
| POST | `/api/inbox/send` | `parsed_ok` | base+sol | $0.005 |
| POST | `/api/inbox/topup` | `parsed_ok` | base+sol | $1 |
| POST | `/api/inbox/topup/quarter` | `parsed_ok` | base+sol | $2.5 |
| POST | `/api/inbox/messages/read` | `parsed_ok` | base+sol | $0.001 |
| POST | `/api/subdomain/inbox/create` | `parsed_ok` | base+sol | $0.25 |
| POST | `/api/subdomain/inbox/messages` | `parsed_ok` | base+sol | $0.001 |
| POST | `/api/subdomain/inbox/messages/read` | `parsed_ok` | base+sol | $0.001 |
| GET | `/api/subdomain/status` | `http_400` | — | — |
| POST | `/api/subdomain/signers` | `reject:siwx_auth_required` | — | — |
| POST | `/api/subdomain/update` | `reject:siwx_auth_required` | — | — |
| GET | `/api/inbox/status` | `http_400` | — | — |
| POST | `/api/inbox/update` | `reject:siwx_auth_required` | — | — |
| POST | `/api/inbox/cancel` | `reject:siwx_auth_required` | — | — |
| POST | `/api/inbox/messages/delete` | `reject:siwx_auth_required` | — | — |

### merit-systems/stableenrich/enrichment

Service URL: `https://stableenrich.dev`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/api/apollo/org-search` | `parsed_ok` | base+sol | $0.02 |
| POST | `/api/exa/search` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/apollo/people-search` | `parsed_ok` | base+sol | $0.02 |
| POST | `/api/apollo/people-enrich` | `parsed_ok` | base+sol | $0.0495 |
| POST | `/api/apollo/org-enrich` | `parsed_ok` | base+sol | $0.0495 |
| POST | `/api/clado/contacts-enrich` | `parsed_ok` | base+sol | $0.2 |
| POST | `/api/exa/find-similar` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/exa/contents` | `parsed_ok` | base+sol | $0.002 |
| POST | `/api/exa/answer` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/firecrawl/scrape` | `parsed_ok` | base+sol | $0.0126 |
| POST | `/api/firecrawl/search` | `parsed_ok` | base+sol | $0.0252 |
| POST | `/api/google-maps/text-search/partial` | `parsed_ok` | base+sol | $0.02 |
| POST | `/api/google-maps/text-search/full` | `parsed_ok` | base+sol | $0.08 |
| POST | `/api/google-maps/nearby-search/partial` | `parsed_ok` | base+sol | $0.02 |
| POST | `/api/google-maps/nearby-search/full` | `parsed_ok` | base+sol | $0.08 |
| GET | `/api/google-maps/place-details/partial` | `http_400` | — | — |
| GET | `/api/google-maps/place-details/full` | `http_400` | — | — |
| GET | `/api/google-maps/solar/building-insights` | `http_400` | — | — |
| GET | `/api/google-maps/solar/data-layers` | `http_400` | — | — |
| GET | `/api/google-maps/solar/rgb-image` | `http_400` | — | — |
| GET | `/api/google-maps/aerial-view/lookup-video` | `http_400` | — | — |
| POST | `/api/google-maps/aerial-view/render-video` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/serper/news` | `parsed_ok` | base+sol | $0.04 |
| POST | `/api/serper/shopping` | `parsed_ok` | base+sol | $0.04 |
| POST | `/api/serper/images` | `parsed_ok` | base+sol | $0.04 |
| POST | `/api/serper/people-image-search` | `parsed_ok` | base+sol | $0.04 |
| POST | `/api/serper/lens` | `parsed_ok` | base+sol | $0.2 |
| POST | `/api/whitepages/person-search` | `parsed_ok` | base+sol | $0.44 |
| POST | `/api/whitepages/property-search` | `parsed_ok` | base+sol | $0.44 |
| POST | `/api/reddit/search` | `parsed_ok` | base+sol | $0.02 |
| POST | `/api/reddit/post-comments` | `parsed_ok` | base+sol | $0.02 |
| POST | `/api/hunter/email-verifier` | `parsed_ok` | base+sol | $0.03 |
| POST | `/api/influencer/enrich-by-email` | `parsed_ok` | base+sol | $0.4 |
| POST | `/api/influencer/enrich-by-social` | `parsed_ok` | base+sol | $0.4 |
| POST | `/api/minerva/resolve` | `parsed_ok` | base+sol | $0.02 |
| POST | `/api/minerva/enrich` | `parsed_ok` | base+sol | $0.05 |
| POST | `/api/minerva/validate-emails` | `parsed_ok` | base+sol | $0.01 |
| POST | `/api/cloudflare/crawl` | `parsed_ok` | base+sol | $0.1 |
| GET | `/api/cloudflare/jobs` | `http_400` | — | — |

### merit-systems/stablemerch/merchandise

Service URL: `https://stablemerch.dev`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/api/heavyweight-shirt` | `http_400` | — | — |
| POST | `/api/shirt` | `http_400` | — | — |
| POST | `/api/mug` | `http_400` | — | — |

### merit-systems/stablephone/calls

Service URL: `https://stablephone.dev`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/api/lookup` | `parsed_ok` | base+sol | $0.05 |
| POST | `/api/call` | `http_400` | — | — |
| GET | `/api/call/probe` | `reject:siwx_auth_required` | — | — |
| GET | `/api/numbers` | `reject:siwx_auth_required` | — | — |
| POST | `/api/number` | `parsed_ok` | base+sol | $20 |
| POST | `/api/number/topup` | `parsed_ok` | base+sol | $15 |
| GET | `/api/lookup/status` | `http_400` | — | — |

### merit-systems/stablesocial/social-data

Service URL: `https://stablesocial.dev`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/api/facebook/post-comments` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/tiktok/profile` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/instagram/comment-replies` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/reddit/search` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/facebook/search-people` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/tiktok/comment-replies` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/facebook/following` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/tiktok/posts` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/tiktok/post-comments` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/tiktok/followers` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/tiktok/following` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/tiktok/search` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/tiktok/search-hashtag` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/tiktok/search-profiles` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/tiktok/search-music` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/instagram/profile` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/instagram/posts` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/instagram/post-comments` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/instagram/followers` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/instagram/following` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/instagram/stories` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/instagram/highlights` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/instagram/search` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/instagram/search-tags` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/facebook/profile` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/facebook/posts` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/facebook/comment-replies` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/facebook/followers` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/facebook/search` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/facebook/search-pages` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/facebook/search-groups` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/reddit/post` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/reddit/post-comments` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/reddit/comment` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/reddit/search-profiles` | `parsed_ok` | base+sol | $0.06 |
| POST | `/api/reddit/subreddit` | `parsed_ok` | base+sol | $0.06 |
| GET | `/api/jobs` | `http_400` | — | — |

### merit-systems/stableupload/hosting

Service URL: `https://stableupload.dev`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/api/site` | `http_400` | — | — |
| PUT | `/api/site` | `reject:siwx_auth_required` | — | — |
| POST | `/api/upload` | `http_400` | — | — |
| GET | `/api/uploads` | `reject:siwx_auth_required` | — | — |
| GET | `/api/download/probe` | `reject:siwx_auth_required` | — | — |
| POST | `/api/site/renew` | `http_400` | — | — |
| POST | `/api/site/activate` | `reject:siwx_auth_required` | — | — |
| POST | `/api/site/domain` | `reject:siwx_auth_required` | — | — |
| DELETE | `/api/site/domain` | `reject:siwx_auth_required` | — | — |
| GET | `/api/site/domain/preview` | `http_400` | — | — |
| GET | `/api/site/domain/status` | `http_400` | — | — |

### paysponge/2captcha

Service URL: `https://2captcha.x402.paysponge.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/createTask` | `parsed_ok` | base+sol | $0.01 |
| POST | `/getTaskResult` | `http_403` | — | — |
| POST | `/reportCorrect` | `http_403` | — | — |
| POST | `/reportIncorrect` | `http_403` | — | — |

### paysponge/fal

Service URL: `https://fal.x402.paysponge.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| GET | `/fal-ai/fast-sdxl/requests/probe` | `http_403` | — | — |
| GET | `/fal-ai/fast-sdxl/requests/probe/status` | `http_403` | — | — |
| GET | `/fal-ai/flux-pro/requests/probe` | `http_403` | — | — |
| GET | `/fal-ai/flux-pro/requests/probe/status` | `http_403` | — | — |
| GET | `/fal-ai/flux/requests/probe` | `http_403` | — | — |
| GET | `/fal-ai/flux/requests/probe/status` | `http_403` | — | — |
| GET | `/fal-ai/minimax/requests/probe` | `http_403` | — | — |
| GET | `/fal-ai/minimax/requests/probe/status` | `http_403` | — | — |
| GET | `/fal-ai/recraft-v3/requests/probe` | `http_403` | — | — |
| GET | `/fal-ai/recraft-v3/requests/probe/status` | `http_403` | — | — |
| GET | `/fal-ai/stable-diffusion-v35-large/requests/probe` | `http_403` | — | — |
| GET | `/fal-ai/stable-diffusion-v35-large/requests/probe/status` | `http_403` | — | — |
| GET | `/fal-ai/stable-video/requests/probe` | `http_403` | — | — |
| GET | `/fal-ai/stable-video/requests/probe/status` | `http_403` | — | — |
| POST | `/fal-ai/fast-sdxl` | `parsed_ok` | base+sol | $0.01 |
| POST | `/fal-ai/flux/dev` | `parsed_ok` | base+sol | $0.03 |
| POST | `/fal-ai/flux-pro/v1.1` | `parsed_ok` | base+sol | $0.04 |
| POST | `/fal-ai/flux-pro/v1.1-ultra` | `parsed_ok` | base+sol | $0.06 |
| POST | `/fal-ai/flux/schnell` | `parsed_ok` | base+sol | $0.01 |
| POST | `/fal-ai/minimax/video-01` | `parsed_ok` | base+sol | $0.07 |
| POST | `/fal-ai/recraft-v3` | `parsed_ok` | base+sol | $0.04 |
| POST | `/fal-ai/stable-diffusion-v35-large` | `parsed_ok` | base+sol | $0.04 |
| POST | `/fal-ai/stable-video` | `parsed_ok` | base+sol | $0.07 |
| PUT | `/fal-ai/fast-sdxl/requests/probe/cancel` | `http_403` | — | — |
| PUT | `/fal-ai/flux-pro/requests/probe/cancel` | `http_403` | — | — |
| PUT | `/fal-ai/flux/requests/probe/cancel` | `http_403` | — | — |
| PUT | `/fal-ai/minimax/requests/probe/cancel` | `http_403` | — | — |
| PUT | `/fal-ai/recraft-v3/requests/probe/cancel` | `http_403` | — | — |
| PUT | `/fal-ai/stable-diffusion-v35-large/requests/probe/cancel` | `http_403` | — | — |
| PUT | `/fal-ai/stable-video/requests/probe/cancel` | `http_403` | — | — |

### paysponge/nyne

Service URL: `https://api.paysponge.com/x402/purchase/svc_d5ymfernpzeh58gb8`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| GET | `/person/enrichment` | `reject:invalid_demand` | base+sol | $0 |
| POST | `/person/enrichment` | `parsed_ok` | base+sol | $0.02 |
| POST | `/person/search` | `parsed_ok` | base+sol | $0.02 |

### paysponge/perplexity

Service URL: `https://pplx.x402.paysponge.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/search` | `parsed_ok` | base+sol | $0.01 |
| POST | `/v1/agent` | `parsed_ok` | base+sol | $0.01 |
| POST | `/v1/sonar` | `fetch_failed` | — | — |
| GET | `/v1/models` | `http_200` | — | — |
| POST | `/v1/async/sonar` | `parsed_ok` | base+sol | $0.01 |
| GET | `/v1/async/sonar/probe` | `http_403` | — | — |

### paysponge/reducto

Service URL: `https://api.paysponge.com/x402/purchase/svc_d672d90ggvqqygj60`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/extract` | `parsed_ok` | base+sol | $0.05 |
| POST | `/parse` | `parsed_ok` | base+sol | $0.05 |

### paysponge/rentcast

Service URL: `https://rentcast.x402.paysponge.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| GET | `/markets` | `parsed_ok` | base+sol | $0.01 |
| GET | `/avm/value` | `parsed_ok` | base+sol | $0.01 |
| GET | `/properties` | `parsed_ok` | base+sol | $0.01 |
| GET | `/listings/sale` | `parsed_ok` | base+sol | $0.01 |
| GET | `/properties/probe` | `parsed_ok` | base+sol | $0.01 |
| GET | `/properties/random` | `parsed_ok` | base+sol | $0.01 |
| GET | `/avm/rent/long-term` | `parsed_ok` | base+sol | $0.01 |
| GET | `/listings/sale/probe` | `parsed_ok` | base+sol | $0.01 |
| GET | `/listings/rental/long-term` | `parsed_ok` | base+sol | $0.01 |
| GET | `/listings/rental/long-term/probe` | `parsed_ok` | base+sol | $0.01 |

### paysponge/screenshotone

Service URL: `https://screenshotone.x402.paysponge.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| GET | `/animate` | `parsed_ok` | base+sol | $0.02 |
| GET | `/take` | `parsed_ok` | base+sol | $0.02 |
| POST | `/take` | `parsed_ok` | base+sol | $0.02 |

### paysponge/textbelt

Service URL: `https://api.paysponge.com/x402/purchase/svc_d6kszbre4qwg5n4n4`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| GET | `/status/probe` | `reject:invalid_demand` | base+sol | $0 |
| POST | `/text` | `parsed_ok` | base+sol | $0.02 |

### paysponge/tripadvisor

Service URL: `https://tripadvisor.x402.paysponge.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| GET | `/api/v1/location/probe/details` | `parsed_ok` | base+sol | $0.01 |
| GET | `/api/v1/location/probe/photos` | `parsed_ok` | base+sol | $0.01 |
| GET | `/api/v1/location/probe/reviews` | `parsed_ok` | base+sol | $0.01 |
| GET | `/api/v1/location/nearby_search` | `parsed_ok` | base+sol | $0.01 |
| GET | `/api/v1/location/search` | `parsed_ok` | base+sol | $0.01 |

### paysponge/wolframalpha

Service URL: `https://wolframalpha.x402.paysponge.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| GET | `/v1/result` | `parsed_ok` | base+sol | $0.01 |
| GET | `/v1/simple` | `parsed_ok` | base+sol | $0.01 |
| GET | `/v2/query` | `parsed_ok` | base+sol | $0.02 |

### purch/marketplace

Service URL: `https://api.purch.xyz`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| GET | `/x402/search` | `parsed_ok` | sol | $0.01 |
| POST | `/x402/shop` | `parsed_ok` | sol | $0.1 |
| POST | `/x402/buy` | `http_400` | — | — |
| GET | `/x402/vault/search` | `parsed_ok` | sol | $0.01 |
| POST | `/x402/vault/buy` | `parsed_ok` | sol | $0.01 |
| GET | `/x402/vault/download/probe` | `reject:missing_facilitator` | sol | $0.01 |

### quicknode/rpc

Service URL: `https://x402.quicknode.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/auth` | `http_400` | — | — |
| GET | `/credits` | `http_401` | — | — |
| POST | `/drip` | `http_401` | — | — |
| GET | `/networks` | `http_200` | — | — |
| GET | `/sql/rest/v1/clusters` | `http_200` | — | — |
| GET | `/sql/rest/v1/schema` | `http_200` | — | — |
| GET | `/sql/rest/v1/schema/probe` | `http_404` | — | — |
| POST | `/sql/rest/v1/query` | `parsed_ok` | base+base+eip155+eip155+eip155+eip155+eip155+sol+sol | $1 |
| GET | `/discovery/resources` | `http_200` | — | — |
| POST | `/0g-galileo/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/0g-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/abstract-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/abstract-testnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/aptos-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/aptos-testnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/arbitrum-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/arbitrum-sepolia/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/arc-testnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/avalanche-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/avalanche-testnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/b3-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/b3-sepolia/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/base-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/base-sepolia/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/bch-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/bch-testnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/bera-bepolia/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/bera-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/blast-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/blast-sepolia/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/bsc-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/bsc-testnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/btc-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/btc-testnet4/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/celestia-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/celestia-mocha/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/celo-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/cosmos-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/cyber-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/cyber-sepolia/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/doge-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/dot-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/ethereum-hoodi/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/ethereum-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/ethereum-sepolia/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/fantom-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/flare-coston2/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/flare-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/flow-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/flow-testnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/fraxtal-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/fuel-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/fuel-sepolia/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/gravity-alpham/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/hedera-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/hedera-testnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/hemi-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/hemi-testnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/hype-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/hype-testnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/imx-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/imx-testnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/injective-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/injective-testnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/ink-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/ink-sepolia/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/joc-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/kaia-kairos/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/kaia-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/lens-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/lens-testnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/linea-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/lisk-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/ltc-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/ltc-testnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/mantle-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/mantle-sepolia/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/matic-amoy/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/matic-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/mode-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/monad-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/monad-testnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/morph-hoodi/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/morph-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/near-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/near-testnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/nova-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/omni-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/omni-omega/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/optimism-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/optimism-sepolia/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/osmosis-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/peaq-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/plasma-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/plasma-testnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/redstone-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/sahara-testnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/scroll-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/scroll-testnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/sei-atlantic/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/sei-pacific/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/solana-devnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/solana-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/solana-testnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/soneium-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/sonic-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/sophon-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/sophon-testnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/stacks-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/stacks-testnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/stellar-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/stellar-testnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/story-aeneid/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/story-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/strk-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/strk-sepolia/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/sui-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/sui-testnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/tempo-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/tempo-testnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/ton-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/tron-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/unichain-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/unichain-sepolia/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/vana-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/vana-moksha/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/worldchain-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/worldchain-sepolia/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/xai-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/xai-testnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/xdai-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/xlayer-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/xlayer-testnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/xrp-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/xrp-testnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/xrplevm-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/xrplevm-testnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/zkevm-cardona/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/zkevm-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/zksync-mainnet/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |
| POST | `/zksync-sepolia/` | `parsed_ok` | base+base+base+base+base+base+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+eip155+sol+sol+sol+sol | $1 |

### socialintel/influencer-search

Service URL: `https://api.socialintel.dev`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| GET | `/api` | `http_301` | — | — |
| GET | `/health` | `http_301` | — | — |
| GET | `/v1/search` | `http_301` | — | — |
| POST | `/v1/search` | `http_301` | — | — |
| GET | `/v1/search/free` | `http_301` | — | — |
| GET | `/v1/search/demo` | `http_301` | — | — |
| GET | `/v1/user/probe` | `http_301` | — | — |
| GET | `/v1/contact` | `http_301` | — | — |
| POST | `/v1/contact` | `http_301` | — | — |

### solana-foundation/alibaba/agentexplorer

Service URL: `https://agentexplorer.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| GET | `/openapi/categories` | `reject:mpp_protocol` | — | — |
| GET | `/openapi/skills` | `reject:mpp_protocol` | — | — |
| GET | `/openapi/skills/probe` | `reject:mpp_protocol` | — | — |

### solana-foundation/alibaba/aigen

Service URL: `https://aigen.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/generate-cosplay-image` | `reject:mpp_protocol` | — | — |
| POST | `/interactive-full-segmentation` | `reject:mpp_protocol` | — | — |
| POST | `/interactive-scribble-segmentation` | `reject:mpp_protocol` | — | — |

### solana-foundation/alibaba/anytrans

Service URL: `https://anytrans.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/anytrans/translate/batch` | `reject:mpp_protocol` | — | — |
| POST | `/anytrans/translate/batchForHtml` | `reject:mpp_protocol` | — | — |
| POST | `/anytrans/translate/text` | `reject:mpp_protocol` | — | — |

### solana-foundation/alibaba/captcha

Service URL: `https://captcha.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/verify-intelligent-captcha` | `reject:mpp_protocol` | — | — |

### solana-foundation/alibaba/contactcenterai

Service URL: `https://contactcenterai.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/probe/ccai/app/probe/analyzeAudioSync` | `reject:mpp_protocol` | — | — |
| POST | `/probe/ccai/app/probe/analyzeImage` | `reject:mpp_protocol` | — | — |
| POST | `/probe/ccai/app/probe/analyze_conversation` | `reject:mpp_protocol` | — | — |
| POST | `/probe/ccai/app/probe/completion` | `reject:mpp_protocol` | — | — |
| POST | `/probe/ccai/app/probe/completion_message` | `reject:mpp_protocol` | — | — |
| POST | `/probe/ccai/app/probe/generalanalyzeImage` | `reject:mpp_protocol` | — | — |

### solana-foundation/alibaba/documentparseservice

Service URL: `https://documentparseservice.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/document-parse-online-api` | `reject:mpp_protocol` | — | — |

### solana-foundation/alibaba/edututor

Service URL: `https://edututor.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/service/cutApi` | `reject:mpp_protocol` | — | — |

### solana-foundation/alibaba/embeddings

Service URL: `https://embeddings.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/compatible-mode/v1/embeddings` | `reject:mpp_protocol` | — | — |

### solana-foundation/alibaba/facebody

Service URL: `https://facebody.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/blur-face` | `reject:mpp_protocol` | — | — |
| POST | `/body-posture` | `reject:mpp_protocol` | — | — |
| POST | `/compare-face` | `reject:mpp_protocol` | — | — |
| POST | `/compare-face-with-mask` | `reject:mpp_protocol` | — | — |
| POST | `/deepfake-face` | `reject:mpp_protocol` | — | — |
| POST | `/detect-body-count` | `reject:mpp_protocol` | — | — |
| POST | `/detect-celebrity` | `reject:mpp_protocol` | — | — |
| POST | `/detect-face` | `reject:mpp_protocol` | — | — |
| POST | `/detect-infrared-living-face` | `reject:mpp_protocol` | — | — |
| POST | `/detect-living-face` | `reject:mpp_protocol` | — | — |
| POST | `/detect-pedestrian` | `reject:mpp_protocol` | — | — |
| POST | `/detect-video-living-face` | `reject:mpp_protocol` | — | — |
| POST | `/enhance-face` | `reject:mpp_protocol` | — | — |
| POST | `/extract-finger-print` | `reject:mpp_protocol` | — | — |
| POST | `/face-beauty` | `reject:mpp_protocol` | — | — |
| POST | `/generate-human-anime-style` | `reject:mpp_protocol` | — | — |
| POST | `/generate-human-sketch-style` | `reject:mpp_protocol` | — | — |
| POST | `/liquify-face` | `reject:mpp_protocol` | — | — |
| POST | `/merge-image-face` | `reject:mpp_protocol` | — | — |
| POST | `/monitor-examination` | `reject:mpp_protocol` | — | — |
| POST | `/pedestrian-detect-attribute` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-action` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-expression` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-face` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-public-face` | `reject:mpp_protocol` | — | — |
| POST | `/retouch-skin` | `reject:mpp_protocol` | — | — |

### solana-foundation/alibaba/farui

Service URL: `https://farui.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/probe/farui/contract/result/genarate` | `reject:mpp_protocol` | — | — |
| POST | `/probe/farui/legalAdvice/consult` | `reject:mpp_protocol` | — | — |
| POST | `/probe/farui/search/case/fulltext` | `reject:mpp_protocol` | — | — |
| POST | `/probe/farui/search/law/query` | `reject:mpp_protocol` | — | — |
| POST | `/probe/pop/contract/extraction` | `reject:mpp_protocol` | — | — |

### solana-foundation/alibaba/goodstech

Service URL: `https://goodstech.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/classify-commodity` | `reject:mpp_protocol` | — | — |

### solana-foundation/alibaba/green

Service URL: `https://green.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/image-batch-moderation` | `reject:mpp_protocol` | — | — |
| POST | `/image-moderation` | `reject:mpp_protocol` | — | — |
| POST | `/multi-modal-agent` | `reject:mpp_protocol` | — | — |
| POST | `/multi-modal-guard` | `reject:mpp_protocol` | — | — |
| POST | `/text-moderation` | `reject:mpp_protocol` | — | — |
| POST | `/text-moderation-plus` | `reject:mpp_protocol` | — | — |

### solana-foundation/alibaba/imageaudit

Service URL: `https://imageaudit.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/scan-image` | `reject:mpp_protocol` | — | — |
| POST | `/scan-text` | `reject:mpp_protocol` | — | — |

### solana-foundation/alibaba/imagerecog

Service URL: `https://imagerecog.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/classifying-rubbish` | `reject:mpp_protocol` | — | — |
| POST | `/detect-image-elements` | `reject:mpp_protocol` | — | — |
| POST | `/evaluate-certificate-quality` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-food` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-image-color` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-image-style` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-scene` | `reject:mpp_protocol` | — | — |
| POST | `/tagging-ad-image` | `reject:mpp_protocol` | — | — |
| POST | `/tagging-image` | `reject:mpp_protocol` | — | — |

### solana-foundation/alibaba/imageseg

Service URL: `https://imageseg.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/change-sky` | `reject:mpp_protocol` | — | — |
| POST | `/parse-face` | `reject:mpp_protocol` | — | — |
| POST | `/refine-mask` | `reject:mpp_protocol` | — | — |
| POST | `/segment-body` | `reject:mpp_protocol` | — | — |
| POST | `/segment-cloth` | `reject:mpp_protocol` | — | — |
| POST | `/segment-commodity` | `reject:mpp_protocol` | — | — |
| POST | `/segment-common-image` | `reject:mpp_protocol` | — | — |
| POST | `/segment-food` | `reject:mpp_protocol` | — | — |
| POST | `/segment-hair` | `reject:mpp_protocol` | — | — |
| POST | `/segment-hdbody` | `reject:mpp_protocol` | — | — |
| POST | `/segment-hdcommon-image` | `reject:mpp_protocol` | — | — |
| POST | `/segment-hdsky` | `reject:mpp_protocol` | — | — |
| POST | `/segment-head` | `reject:mpp_protocol` | — | — |
| POST | `/segment-skin` | `reject:mpp_protocol` | — | — |
| POST | `/segment-sky` | `reject:mpp_protocol` | — | — |

### solana-foundation/alibaba/intelligentspeechinteraction

Service URL: `https://intelligentspeechinteraction.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/stream/v1/asr` | `reject:mpp_protocol` | — | — |
| GET | `/stream/v1/tts` | `reject:mpp_protocol` | — | — |

### solana-foundation/alibaba/iqs

Service URL: `https://iqs.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/linked-retrieval/linked-retrieval-entry/v1/iqs/domain/medical/answer` | `reject:mpp_protocol` | — | — |
| POST | `/linked-retrieval/linked-retrieval-entry/v1/iqs/domain/medical/know` | `reject:mpp_protocol` | — | — |
| POST | `/linked-retrieval/linked-retrieval-entry/v1/iqs/multimodal/unified` | `reject:mpp_protocol` | — | — |
| POST | `/linked-retrieval/linked-retrieval-entry/v1/iqs/readpage/basic` | `reject:mpp_protocol` | — | — |
| POST | `/linked-retrieval/linked-retrieval-entry/v1/iqs/readpage/scrape` | `reject:mpp_protocol` | — | — |
| GET | `/linked-retrieval/linked-retrieval-entry/v1/iqs/search/global` | `reject:mpp_protocol` | — | — |
| POST | `/linked-retrieval/linked-retrieval-entry/v1/iqs/search/unified` | `reject:mpp_protocol` | — | — |
| GET | `/linked-retrieval/linked-retrieval-entry/v2/linkedRetrieval/commands/genericAdvancedSearch` | `reject:mpp_protocol` | — | — |
| GET | `/linked-retrieval/linked-retrieval-entry/v2/linkedRetrieval/commands/genericSearch` | `reject:mpp_protocol` | — | — |

### solana-foundation/alibaba/ivpd

Service URL: `https://ivpd.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/change-image-size` | `reject:mpp_protocol` | — | — |
| POST | `/detect-image-elements` | `reject:mpp_protocol` | — | — |
| POST | `/extend-image-style` | `reject:mpp_protocol` | — | — |
| POST | `/make-super-resolution-image` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-image-color` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-image-style` | `reject:mpp_protocol` | — | — |
| POST | `/recolor-image` | `reject:mpp_protocol` | — | — |
| POST | `/segment-body` | `reject:mpp_protocol` | — | — |
| POST | `/segment-image` | `reject:mpp_protocol` | — | — |

### solana-foundation/alibaba/machinetranslation

Service URL: `https://machinetranslation.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/api/translate/web/ecommerce` | `reject:mpp_protocol` | — | — |
| POST | `/api/translate/web/general` | `reject:mpp_protocol` | — | — |

### solana-foundation/alibaba/objectdet

Service URL: `https://objectdet.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/detect-ipcobject` | `reject:mpp_protocol` | — | — |
| POST | `/detect-kitchen-animals` | `reject:mpp_protocol` | — | — |
| POST | `/detect-main-body` | `reject:mpp_protocol` | — | — |
| POST | `/detect-object` | `reject:mpp_protocol` | — | — |
| POST | `/detect-vehicle-icongestion` | `reject:mpp_protocol` | — | — |
| POST | `/detect-vehicle-illegal-parking` | `reject:mpp_protocol` | — | — |
| POST | `/detect-white-base-image` | `reject:mpp_protocol` | — | — |
| POST | `/detect-workwear` | `reject:mpp_protocol` | — | — |

### solana-foundation/alibaba/ocr-api

Service URL: `https://ocr-api.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/recognize-advanced` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-air-itinerary` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-all-text` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-bank-acceptance` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-bank-account-license` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-bank-card` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-basic` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-birth-certification` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-bus-ship-ticket` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-business-license` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-car-invoice` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-car-number` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-car-vin-code` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-chinese-passport` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-common-printed-invoice` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-cosmetic-produce-license` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-covid-test-report` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-ctwo-medical-device-manage-license` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-document-structure` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-driving-license` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-edu-formula` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-edu-oral-calculation` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-edu-paper-cut` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-edu-paper-ocr` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-edu-paper-structed` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-edu-question-ocr` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-english` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-estate-certification` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-exit-entry-permit-to-hk` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-exit-entry-permit-to-mainland` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-food-manage-license` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-food-produce-license` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-general` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-general-structure` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-handwriting` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-health-code` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-hkidcard` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-hotel-consume` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-household` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-idcard` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-international-business-license` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-international-idcard` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-invoice` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-janpanese` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-korean` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-latin` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-medical-device-manage-license` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-medical-device-produce-license` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-mixed-invoices` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-multi-language` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-non-tax-invoice` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-passport` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-payment-record` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-purchase-record` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-quota-invoice` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-ride-hailing-itinerary` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-roll-ticket` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-russian` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-shopping-receipt` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-social-security-card` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-social-security-card-version-ii` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-table-ocr` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-tax-clearance-certificate` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-taxi-invoice` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-thai` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-toll-invoice` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-trade-mark-certification` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-train-invoice` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-used-car-invoice` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-vehicle-certification` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-vehicle-license` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-vehicle-registration` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-waybill` | `reject:mpp_protocol` | — | — |
| POST | `/verify-business-license` | `reject:mpp_protocol` | — | — |
| POST | `/verify-vatinvoice` | `reject:mpp_protocol` | — | — |

### solana-foundation/alibaba/ocr

Service URL: `https://ocr.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/compatible-mode/v1/chat/completions` | `reject:mpp_protocol` | — | — |

### solana-foundation/alibaba/paimodelgallery

Service URL: `https://paimodelgallery.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| GET | `/api/v1/modelgallery/models` | `reject:mpp_protocol` | — | — |

### solana-foundation/alibaba/rai

Service URL: `https://rai.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/batch-content-sync-detect` | `reject:mpp_protocol` | — | — |
| POST | `/content-sync-detect` | `reject:mpp_protocol` | — | — |
| POST | `/model-input-content-sync-detect` | `reject:mpp_protocol` | — | — |
| POST | `/model-output-content-sync-detect` | `reject:mpp_protocol` | — | — |

### solana-foundation/alibaba/saf

Service URL: `https://saf.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/execute-request` | `reject:mpp_protocol` | — | — |
| POST | `/execute-request-ml` | `reject:mpp_protocol` | — | — |
| POST | `/execute-request-sg` | `reject:mpp_protocol` | — | — |
| POST | `/request-decision` | `reject:mpp_protocol` | — | — |

### solana-foundation/alibaba/speech

Service URL: `https://speech.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/api/v1/services/audio/asr/transcription` | `reject:mpp_protocol` | — | — |
| GET | `/api/v1/tasks/probe` | `http_200` | — | — |

### solana-foundation/alibaba/texttospeech

Service URL: `https://texttospeech.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/api/v1/services/aigc/multimodal-generation/generation` | `http_500` | — | — |

### solana-foundation/alibaba/translate

Service URL: `https://translate.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/compatible-mode/v1/chat/completions` | `reject:mpp_protocol` | — | — |

### solana-foundation/alibaba/viapi-ocr

Service URL: `https://viapi-ocr.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/recognize-bank-card` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-business-license` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-character` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-driver-license` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-driving-license` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-identity-card` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-license-plate` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-qr-code` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-quota-invoice` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-table` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-taxi-invoice` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-ticket-invoice` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-train-ticket` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-vatinvoice` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-vincode` | `reject:mpp_protocol` | — | — |

### solana-foundation/alibaba/videoenhan

Service URL: `https://videoenhan.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/adjust-video-color` | `reject:mpp_protocol` | — | — |
| POST | `/change-video-size` | `reject:mpp_protocol` | — | — |
| POST | `/enhance-portrait-video` | `reject:mpp_protocol` | — | — |
| POST | `/enhance-video-quality` | `reject:mpp_protocol` | — | — |
| POST | `/erase-video-logo` | `reject:mpp_protocol` | — | — |
| POST | `/erase-video-subtitles` | `reject:mpp_protocol` | — | — |
| POST | `/generate-human-anime-style-video` | `reject:mpp_protocol` | — | — |
| POST | `/generate-video` | `reject:mpp_protocol` | — | — |
| POST | `/interpolate-video-frame` | `reject:mpp_protocol` | — | — |
| POST | `/super-resolve-video` | `reject:mpp_protocol` | — | — |

### solana-foundation/alibaba/videorecog

Service URL: `https://videorecog.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/detect-video-shot` | `reject:mpp_protocol` | — | — |
| POST | `/evaluate-video-quality` | `reject:mpp_protocol` | — | — |
| POST | `/generate-video-cover` | `reject:mpp_protocol` | — | — |
| POST | `/recognize-video-cast-crew-list` | `reject:mpp_protocol` | — | — |
| POST | `/split-video-parts` | `reject:mpp_protocol` | — | — |
| POST | `/understand-video-content` | `reject:mpp_protocol` | — | — |

### solana-foundation/alibaba/videoseg

Service URL: `https://videoseg.alibaba.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/segment-video-body` | `reject:mpp_protocol` | — | — |

### solana-foundation/google/civicinfo

Service URL: `https://civicinfo.google.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| GET | `/civicinfo/v2/divisions` | `http_400` | — | — |
| GET | `/civicinfo/v2/elections` | `http_200` | — | — |
| GET | `/civicinfo/v2/voterinfo` | `http_400` | — | — |

### solana-foundation/google/factchecktools

Service URL: `https://factchecktools.google.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| GET | `/v1alpha1/claims:search` | `http_400` | — | — |

### solana-foundation/google/kgsearch

Service URL: `https://kgsearch.google.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| GET | `/v1/entities:search` | `http_400` | — | — |

### solana-foundation/google/language

Service URL: `https://language.google.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/v2/documents:analyzeEntities` | `reject:mpp_protocol` | — | — |
| POST | `/v2/documents:analyzeSentiment` | `reject:mpp_protocol` | — | — |
| POST | `/v2/documents:annotateText` | `reject:mpp_protocol` | — | — |
| POST | `/v2/documents:classifyText` | `reject:mpp_protocol` | — | — |
| POST | `/v2/documents:moderateText` | `reject:mpp_protocol` | — | — |

### solana-foundation/google/places

Service URL: `https://places.google.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/v1/places:autocomplete` | `http_400` | — | — |
| POST | `/v1/places:searchNearby` | `reject:mpp_protocol` | — | — |
| POST | `/v1/places:searchText` | `reject:mpp_protocol` | — | — |

### solana-foundation/google/speech

Service URL: `https://speech.google.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/v1/speech:recognize` | `reject:mpp_protocol` | — | — |

### solana-foundation/google/texttospeech

Service URL: `https://texttospeech.google.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/v1/text:synthesize` | `reject:mpp_protocol` | — | — |
| GET | `/v1/voices` | `http_200` | — | — |

### solana-foundation/google/videointelligence

Service URL: `https://videointelligence.google.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/v1/videos:annotate` | `reject:mpp_protocol` | — | — |

### solana-foundation/google/vision

Service URL: `https://vision.google.gateway-402.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/v1/files:annotate` | `http_400` | — | — |
| POST | `/v1/files:asyncBatchAnnotate` | `http_400` | — | — |
| POST | `/v1/images:annotate` | `reject:mpp_protocol` | — | — |
| POST | `/v1/images:asyncBatchAnnotate` | `reject:mpp_protocol` | — | — |

