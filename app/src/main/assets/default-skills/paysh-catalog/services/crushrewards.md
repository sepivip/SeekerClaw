# Crushrewards (crushrewards)

US retail / shopping / pricing data. Four catalogued endpoints:

- **[`shopper-best-price`](#shopper-best-price)** — find cheapest retailer for a product ($0.01)
- **[`shopper-price-history`](#shopper-price-history)** — historical price chart for a product across retailers ($0.01)
- **[`shopper-deal-finder`](#shopper-deal-finder)** — active deals/discounts on a product ($0.01)
- **[`analyst-inflation`](#analyst-inflation)** — live US consumer-price inflation index ($0.02)

Service URL base: `https://api.crushrewards.dev`. All GET; URL-encode query strings with `encodeURIComponent` (spaces → `%20`, never `+`).

## When to use vs free alternatives

- **Use Crushrewards** when the user wants live US retail pricing, price history, or deal alerts — typical "where can I buy X cheapest" / "is X a good deal" / "has X gone up in price" questions.
- **Don't use Crushrewards** for non-US shoppers, niche/specialty retailers outside its index, or when the user already knows where they want to buy.

<a id="shopper-best-price"></a>
## `shopper-best-price` — cheapest retailer

`GET /v1/shopper/best-price?q=<URL-encoded-product>`

Examples: `?q=PlayStation%205%20slim` / `?q=Dyson%20V11%20vacuum` / `?q=Nespresso%20Vertuo%20pods`

Returns JSON listing prices across retailers (Amazon, Walmart, Costco, Home Depot, Target, etc.) with retailer name, price, in-stock status, link. Return the top 3 cheapest with retailer + price.

<a id="shopper-price-history"></a>
## `shopper-price-history` — historical chart

`GET /v1/shopper/price-history?q=<URL-encoded-product>&from=<ISO-date>&to=<ISO-date>`

| Param | Example | Notes |
|---|---|---|
| `q` | `q=airpods` | Product query string (required, per bazaar schema) |
| `from` | `from=2026-04-01` | ISO date (start of window) |
| `to` | `to=2026-05-01` | ISO date (end of window) |
| `country` | `country=us` | Optional country filter |
| `retailer` | `retailer=amazon` | Optional retailer filter |

Returns price points over the date window across retailers. Surface: current price, lowest in window + when, "down 12% from peak", etc.

<a id="shopper-deal-finder"></a>
## `shopper-deal-finder` — active deals

`GET /v1/shopper/deal-finder?category=<cat>&min_discount_pct=<N>&limit=<N>`

| Param | Example | Notes |
|---|---|---|
| `category` | `category=electronics` | Product category (required, per bazaar schema) |
| `min_discount_pct` | `min_discount_pct=10` | Minimum discount % filter |
| `limit` | `limit=20` | Cap returned deals |
| `country` | `country=us` | Optional country filter |
| `retailer` | `retailer=amazon` | Optional retailer filter |

Returns active discounts / promo codes / sale prices in the category. Surface the top 3-5 deals with retailer + discount % + final price + expiry.

<a id="analyst-inflation"></a>
## `analyst-inflation` — US consumer-price inflation index

`GET /v1/analyst/inflation?<query-string>`

| Param | Example | Notes |
|---|---|---|
| `category` | `category=electronics` | High-level category name |
| `category_id` | `category_id=1` | Numeric category id (alternative to `category`) |
| `department` | `department=Electronics` | Retail department |
| `country` | `country=us` | Country filter |
| `from` | `from=2026-04-01` | ISO date (window start) |
| `to` | `to=2026-05-01` | ISO date (window end) |
| `granularity` | `granularity=weekly` | Time bucket: `daily` / `weekly` / `monthly` |

Per bazaar schema, all params are optional but at least one filter combination (category OR department + date window) gives meaningful results. Returns live US CPI-style inflation index built from Crushrewards' retail-price scraping. Useful when training-data CPI numbers are stale and the user asks "what's current US inflation" or "are prices going up in electronics".

$0.02 (2x the shopper endpoints) — slightly pricier because of the analysis layer.

## Other Crushrewards endpoints on pay.sh (not catalogued)

BAT-706 audit found 9 additional sibling endpoints (`/marketing/competitive-landscape`, `/marketing/brand-tracker`, `/marketing/promo-intelligence`, `/marketing/share-of-shelf`, `/marketing/price-positioning`, `/shopper/price-drop-alert`, `/analyst/price-dispersion`, `/analyst/retailer-index`, `/analyst/category-summary`). Most target marketing/analytics professionals — not surfaced as user-facing intents yet. Deferred.

## Notes

- Solana-native multi-chain offer (sol+sol+base) — same low-cost path as Wolfram.
