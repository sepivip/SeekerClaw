# pay.sh catalog audit — multi-endpoint probe per service

Generated: 2026-05-15T19:50:43.417Z
Source: probe-catalog.js --audit --concurrency 4 --filter paysponge --audit-side-effects
**Scope note**: this run was FILTERED to "paysponge" — aggregate counts below are for the filtered subset, NOT the full ~72-service upstream catalog. Re-run without --filter for a full-catalog audit.

## Aggregate

| Metric | Count |
|--------|-------|
| Services audited | 11 |
| Endpoints discovered (across all services) | 68 |
| **Parsed OK** (Solana-USDC parseable 402) | 39 |
| Rejected (402 but parser refused) | 2 |
| Non-402 HTTP response (http_4xx/5xx/3xx/2xx) | 26 |
| Skipped (non-GET, side-effect risk; opt in via --audit-side-effects) | 0 |
| Fetch failed (DNS / TLS / timeout — no HTTP response) | 1 |
| Audit elapsed | 41.2s |

## All parsed_ok endpoints from this audit run

Every endpoint that parsed_ok with a Solana-USDC leg. This includes endpoints already in our standard catalog (`tests/paysh/catalog-summary.md`) AND endpoints we don't currently catalog. Cross-reference manually with catalog-summary.md to identify the audit's new discoveries (multi-endpoint providers like paysponge/perplexity and paysponge/rentcast typically show many endpoints here that catalog-summary records as only one per service).

| Service | Method | Path | Networks | Asset | Amount | Result |
|---------|--------|------|----------|-------|--------|--------|
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

## Audit errors (services where openapi.json was unreachable or empty)

- **paysponge/coingecko**: openapi fetch failed: status 401

## Full per-service breakdown

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

