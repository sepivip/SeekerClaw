# pay.sh catalog audit — multi-endpoint probe per service

Generated: 2026-05-15T18:22:25.583Z
Source: probe-catalog.js --audit --filter paysponge
**Scope note**: this run was FILTERED to "paysponge" — aggregate counts below are for the filtered subset, NOT the full ~72-service upstream catalog. Re-run without --filter for a full-catalog audit.
**Safety note**: non-GET endpoints were SKIPPED to avoid triggering server-side side effects. Use `--audit-side-effects` to include POST/PUT/PATCH/DELETE probes (most pay.sh services check x402 payment before any side effect runs, but it's not universally guaranteed).

## Aggregate

| Metric | Count |
|--------|-------|
| Services audited | 11 |
| Endpoints discovered (across all services) | 68 |
| **Parsed OK** (Solana-USDC parseable 402) | 20 |
| Rejected (402 but parser refused) | 2 |
| Non-402 response | 46 |
| Audit elapsed | 9.8s |

## All parsed_ok endpoints from this audit run

Every endpoint that parsed_ok with a Solana-USDC leg. This includes endpoints already in our standard catalog (`tests/paysh/catalog-summary.md`) AND endpoints we don't currently catalog. Cross-reference manually with catalog-summary.md to identify the audit's new discoveries (multi-endpoint providers like paysponge/perplexity and paysponge/rentcast typically show many endpoints here that catalog-summary records as only one per service).

| Service | Method | Path | Networks | Asset | Amount | Result |
|---------|--------|------|----------|-------|--------|--------|
| paysponge/rentcast | GET | `/markets` | base+sol | EVM | $0.01 | `parsed_ok` |
| paysponge/rentcast | GET | `/avm/value` | base+sol | EVM | $0.01 | `parsed_ok` |
| paysponge/rentcast | GET | `/properties` | base+sol | EVM | $0.01 | `parsed_ok` |
| paysponge/rentcast | GET | `/listings/sale` | base+sol | EVM | $0.01 | `parsed_ok` |
| paysponge/rentcast | GET | `/properties/probe` | base+sol | EVM | $0.01 | `parsed_ok` |
| paysponge/rentcast | GET | `/properties/random` | base+sol | EVM | $0.01 | `parsed_ok` |
| paysponge/rentcast | GET | `/avm/rent/long-term` | base+sol | EVM | $0.01 | `parsed_ok` |
| paysponge/rentcast | GET | `/listings/sale/probe` | base+sol | EVM | $0.01 | `parsed_ok` |
| paysponge/rentcast | GET | `/listings/rental/long-term` | base+sol | EVM | $0.01 | `parsed_ok` |
| paysponge/rentcast | GET | `/listings/rental/long-term/probe` | base+sol | EVM | $0.01 | `parsed_ok` |
| paysponge/screenshotone | GET | `/animate` | base+sol | EVM | $0.02 | `parsed_ok` |
| paysponge/screenshotone | GET | `/take` | base+sol | EVM | $0.02 | `parsed_ok` |
| paysponge/tripadvisor | GET | `/api/v1/location/probe/details` | base+sol | EVM | $0.01 | `parsed_ok` |
| paysponge/tripadvisor | GET | `/api/v1/location/probe/photos` | base+sol | EVM | $0.01 | `parsed_ok` |
| paysponge/tripadvisor | GET | `/api/v1/location/probe/reviews` | base+sol | EVM | $0.01 | `parsed_ok` |
| paysponge/tripadvisor | GET | `/api/v1/location/nearby_search` | base+sol | EVM | $0.01 | `parsed_ok` |
| paysponge/tripadvisor | GET | `/api/v1/location/search` | base+sol | EVM | $0.01 | `parsed_ok` |
| paysponge/wolframalpha | GET | `/v1/result` | base+sol | EVM | $0.01 | `parsed_ok` |
| paysponge/wolframalpha | GET | `/v1/simple` | base+sol | EVM | $0.01 | `parsed_ok` |
| paysponge/wolframalpha | GET | `/v2/query` | base+sol | EVM | $0.02 | `parsed_ok` |

## Audit errors (services where openapi.json was unreachable or empty)

- **paysponge/coingecko**: openapi fetch failed: status 401

## Full per-service breakdown

### paysponge/2captcha

Service URL: `https://2captcha.x402.paysponge.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/createTask` | `skipped:non_get_side_effect_risk` | — | — |
| POST | `/getTaskResult` | `skipped:non_get_side_effect_risk` | — | — |
| POST | `/reportCorrect` | `skipped:non_get_side_effect_risk` | — | — |
| POST | `/reportIncorrect` | `skipped:non_get_side_effect_risk` | — | — |

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
| POST | `/fal-ai/fast-sdxl` | `skipped:non_get_side_effect_risk` | — | — |
| POST | `/fal-ai/flux/dev` | `skipped:non_get_side_effect_risk` | — | — |
| POST | `/fal-ai/flux-pro/v1.1` | `skipped:non_get_side_effect_risk` | — | — |
| POST | `/fal-ai/flux-pro/v1.1-ultra` | `skipped:non_get_side_effect_risk` | — | — |
| POST | `/fal-ai/flux/schnell` | `skipped:non_get_side_effect_risk` | — | — |
| POST | `/fal-ai/minimax/video-01` | `skipped:non_get_side_effect_risk` | — | — |
| POST | `/fal-ai/recraft-v3` | `skipped:non_get_side_effect_risk` | — | — |
| POST | `/fal-ai/stable-diffusion-v35-large` | `skipped:non_get_side_effect_risk` | — | — |
| POST | `/fal-ai/stable-video` | `skipped:non_get_side_effect_risk` | — | — |
| PUT | `/fal-ai/fast-sdxl/requests/probe/cancel` | `skipped:non_get_side_effect_risk` | — | — |
| PUT | `/fal-ai/flux-pro/requests/probe/cancel` | `skipped:non_get_side_effect_risk` | — | — |
| PUT | `/fal-ai/flux/requests/probe/cancel` | `skipped:non_get_side_effect_risk` | — | — |
| PUT | `/fal-ai/minimax/requests/probe/cancel` | `skipped:non_get_side_effect_risk` | — | — |
| PUT | `/fal-ai/recraft-v3/requests/probe/cancel` | `skipped:non_get_side_effect_risk` | — | — |
| PUT | `/fal-ai/stable-diffusion-v35-large/requests/probe/cancel` | `skipped:non_get_side_effect_risk` | — | — |
| PUT | `/fal-ai/stable-video/requests/probe/cancel` | `skipped:non_get_side_effect_risk` | — | — |

### paysponge/nyne

Service URL: `https://api.paysponge.com/x402/purchase/svc_d5ymfernpzeh58gb8`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| GET | `/person/enrichment` | `reject:invalid_demand` | base+sol | $0 |
| POST | `/person/enrichment` | `skipped:non_get_side_effect_risk` | — | — |
| POST | `/person/search` | `skipped:non_get_side_effect_risk` | — | — |

### paysponge/perplexity

Service URL: `https://pplx.x402.paysponge.com`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/search` | `skipped:non_get_side_effect_risk` | — | — |
| POST | `/v1/agent` | `skipped:non_get_side_effect_risk` | — | — |
| POST | `/v1/sonar` | `skipped:non_get_side_effect_risk` | — | — |
| GET | `/v1/models` | `http_200` | — | — |
| POST | `/v1/async/sonar` | `skipped:non_get_side_effect_risk` | — | — |
| GET | `/v1/async/sonar/probe` | `http_403` | — | — |

### paysponge/reducto

Service URL: `https://api.paysponge.com/x402/purchase/svc_d672d90ggvqqygj60`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| POST | `/extract` | `skipped:non_get_side_effect_risk` | — | — |
| POST | `/parse` | `skipped:non_get_side_effect_risk` | — | — |

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
| POST | `/take` | `skipped:non_get_side_effect_risk` | — | — |

### paysponge/textbelt

Service URL: `https://api.paysponge.com/x402/purchase/svc_d6kszbre4qwg5n4n4`

| Method | Path | Result | Networks | Amount |
|--------|------|--------|----------|--------|
| GET | `/status/probe` | `reject:invalid_demand` | base+sol | $0 |
| POST | `/text` | `skipped:non_get_side_effect_risk` | — | — |

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

