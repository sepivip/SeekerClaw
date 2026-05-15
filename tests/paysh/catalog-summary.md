# pay.sh catalog probe — summary

Generated: 2026-05-15T13:11:43.415Z
Source catalog: solana-foundation/pay-skills (72 services)
Probed: 72 (concurrency 8)

## Aggregate

| Metric | Count |
|--------|-------|
| Total probed | 72 |
| **Parser OK** (built x402 tx) | 10 |
| Parser rejected (returned 402 we can't pay) | 41 |
| Non-402 HTTP response | 21 |
| Fetch failed (DNS / TLS / timeout) | 0 |
| Discovery failed (no service_url) | 0 |
| Solana offered | 13 |
| x402 v2 | 18 |
| x402 v1 | 0 |
| Requirements via body | 14 |
| Requirements via `payment-required` header | 4 |

### Rejects by reason

| Reason | Count |
|--------|-------|
| `mpp_protocol` | 33 |
| `siwx_auth_required` | 5 |
| `invalid_demand` | 3 |

## Per-service

| Service | HTTP | x402 | Chains | Asset | Amount | Result |
|---------|------|------|--------|-------|--------|--------|
| agentmail/email | 402 | v2 | base+sol+eip155+eip155 | EVM | $0 | `reject:invalid_demand` |
| crushrewards/pricing | 402 | v2 | sol+sol+base | USDC | $0.01 | `parsed_ok` |
| dtelecom/voice | 401 | — | — | — | — | `http_401` |
| merit-systems/stablecrypto/market-data | 402 | v2 | base+sol | EVM | $0.01 | `parsed_ok` |
| merit-systems/stabledomains/domains | 402 | v2 | — | — | — | `reject:siwx_auth_required` |
| merit-systems/stableemail/email | 402 | v2 | — | — | — | `reject:siwx_auth_required` |
| merit-systems/stableenrich/enrichment | 402 | v2 | base+sol | EVM | $0.02 | `parsed_ok` |
| merit-systems/stablemerch/merchandise | 400 | — | — | — | — | `http_400` |
| merit-systems/stablephone/calls | 402 | v2 | — | — | — | `reject:siwx_auth_required` |
| merit-systems/stablesocial/social-data | 402 | v2 | — | — | — | `reject:siwx_auth_required` |
| merit-systems/stableupload/hosting | 402 | v2 | — | — | — | `reject:siwx_auth_required` |
| paysponge/2captcha | 402 | v2 | base+sol | EVM | $0.01 | `parsed_ok` |
| paysponge/coingecko | 404 | — | — | — | — | `http_404` |
| paysponge/fal | 403 | — | — | — | — | `http_403` |
| paysponge/nyne | 402 | v2 | base+sol | EVM | $0 | `reject:invalid_demand` |
| paysponge/perplexity | 200 | — | — | — | — | `http_200` |
| paysponge/reducto | 402 | v2 | base+sol | EVM | $0.05 | `parsed_ok` |
| paysponge/rentcast | 402 | v2 | base+sol | EVM | $0.01 | `parsed_ok` |
| paysponge/screenshotone | 402 | v2 | base+sol | EVM | $0.02 | `parsed_ok` |
| paysponge/textbelt | 402 | v2 | base+sol | EVM | $0 | `reject:invalid_demand` |
| paysponge/tripadvisor | 402 | v2 | base+sol | EVM | $0.01 | `parsed_ok` |
| paysponge/wolframalpha | 402 | v2 | base+sol | EVM | $0.01 | `parsed_ok` |
| purch/marketplace | 402 | v2 | sol | USDC | $0.01 | `parsed_ok` |
| quicknode/rpc | 401 | — | — | — | — | `http_401` |
| socialintel/influencer-search | 301 | — | — | — | — | `http_301` |
| solana-foundation/alibaba/agentexplorer | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/alibaba/aigen | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/alibaba/anytrans | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/alibaba/captcha | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/alibaba/contactcenterai | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/alibaba/documentparseservice | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/alibaba/edututor | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/alibaba/embeddings | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/alibaba/facebody | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/alibaba/farui | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/alibaba/goodstech | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/alibaba/green | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/alibaba/imageaudit | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/alibaba/imagerecog | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/alibaba/imageseg | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/alibaba/intelligentspeechinteraction | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/alibaba/iqs | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/alibaba/ivpd | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/alibaba/machinetranslation | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/alibaba/objectdet | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/alibaba/ocr-api | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/alibaba/ocr | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/alibaba/paimodelgallery | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/alibaba/rai | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/alibaba/saf | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/alibaba/speech | 200 | — | — | — | — | `http_200` |
| solana-foundation/alibaba/texttospeech | 500 | — | — | — | — | `http_500` |
| solana-foundation/alibaba/translate | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/alibaba/viapi-ocr | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/alibaba/videoenhan | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/alibaba/videorecog | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/alibaba/videoseg | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/google/addressvalidation | 404 | — | — | — | — | `http_404` |
| solana-foundation/google/airquality | 404 | — | — | — | — | `http_404` |
| solana-foundation/google/bigquery | 404 | — | — | — | — | `http_404` |
| solana-foundation/google/civicinfo | 400 | — | — | — | — | `http_400` |
| solana-foundation/google/documentai | 404 | — | — | — | — | `http_404` |
| solana-foundation/google/factchecktools | 400 | — | — | — | — | `http_400` |
| solana-foundation/google/generativelanguage | 404 | — | — | — | — | `http_404` |
| solana-foundation/google/kgsearch | 400 | — | — | — | — | `http_400` |
| solana-foundation/google/language | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/google/places | 400 | — | — | — | — | `http_400` |
| solana-foundation/google/speech | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/google/texttospeech | 200 | — | — | — | — | `http_200` |
| solana-foundation/google/translate | 404 | — | — | — | — | `http_404` |
| solana-foundation/google/videointelligence | 402 | — | — | — | — | `reject:mpp_protocol` |
| solana-foundation/google/vision | 400 | — | — | — | — | `http_400` |

## What "parser OK" means

The service returned a 402 with x402 payment requirements that our `X402Protocol.detect() + build()` accepted: Solana mainnet offer, scheme=exact, USDC asset, valid payTo, amount within max. The script does NOT sign or settle — `parsed_ok` proves only that we *could* construct a payment, not that the upstream facilitator would accept it.

## What rejections mean

| Reject code | Meaning |
|-------------|---------|
| `no_solana_offer` | Service offers only EVM chains (Base) — our wallet is Solana-only |
| `non_usdc_asset` | Service asks for an asset that isn't the canonical USDC mint |
| `unsupported_version` | x402Version is 3+ (forward-compat block) |
| `invalid_demand` | amount = 0 (pay.sh sometimes uses 402 + amount=0 to advertise free) |
| `demand_exceeds_max_usdc` | amount > our 100 USDC probe ceiling |
| `invalid_402_body` | 402 body shape we don't recognize (likely new pay.sh dialect) |
| `mpp_protocol` | non-x402 paywall (Alibaba/Google `gateway-402.com` services use MPP) |
| `siwx_auth_required` | requires Sign-In-With-X auth flow first (merit-systems stable* services) |
| `no_payment_requirements` | 402 with no `accepts` / no `paymentRequirements` and no recognised alt-protocol |

## Refreshing the catalog inventory

The list of PAY.md paths is snapshotted in `PAY_MD_PATHS` inside `probe-catalog.js`. To refresh:

```
curl -s "https://api.github.com/repos/solana-foundation/pay-skills/git/trees/main?recursive=1" | jq -r '.tree[].path | select(endswith("PAY.md"))'
```

Paste the result over `PAY_MD_PATHS` and re-run.
