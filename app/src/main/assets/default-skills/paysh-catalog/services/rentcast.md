# Rentcast (paysponge)

US real-estate data — market rent/price stats, property values, property records, active for-sale/rental listings. Five catalogued endpoints:

- **[`markets`](#markets)** — rental market trends by zip/city ($0.01)
- **[`avm-value`](#avm-value)** — property value estimate (Zestimate-style) for an address ($0.01)
- **[`properties`](#properties)** — property record (size, beds, baths, tax history) for an address ($0.01)
- **[`listings-sale`](#listings-sale)** — active for-sale listings in a market ($0.01)
- **[`listings-rental`](#listings-rental)** — active long-term rental listings in a market ($0.01)

Service URL base: `https://rentcast.x402.paysponge.com`

## When to use vs free alternatives

- **Use Rentcast** for current US property/market data, valuations, or listing inventory that training data can't have.
- **Don't use Rentcast** for non-US markets (US-only), or for ad-hoc browsing on a specific listing site (use that site's search).

<a id="markets"></a>
## `markets` — rental market trends

`GET /markets?<query-string>`

| Param | Example | Notes |
|---|---|---|
| `zipCode` | `zipCode=90210` | 5-digit US ZIP |
| `city` | `city=Austin` | URL-encode (spaces → `%20`) |
| `state` | `state=TX` | 2-letter |
| `historyRange` | `historyRange=6` | Months of trend |
| `bedrooms` | `bedrooms=2` | 1-5 |

Combine: `?zipCode=78701&bedrooms=2&historyRange=12`. Returns median rent, YoY %, sample size.

<a id="avm-value"></a>
## `avm-value` — automated valuation (estimated sale price)

`GET /avm/value?<query-string>` — Zillow-Zestimate-style for any US address.

| Param | Example | Notes |
|---|---|---|
| `address` | `address=1600%20Pennsylvania%20Ave%20Washington%20DC` | Full street address, URL-encoded |
| `propertyType` | `propertyType=Single%20Family` | Optional refinement |
| `bedrooms`/`bathrooms`/`squareFootage` | numeric | Optional, improves estimate accuracy |

Returns `{price, priceRangeLow, priceRangeHigh, comparables[]}`. Surface the price + range, not the full comparables list.

<a id="properties"></a>
## `properties` — property record lookup

`GET /properties?<query-string>` — non-valuation data: size, beds, baths, year built, tax records, ownership.

| Param | Example | Notes |
|---|---|---|
| `address` | `address=...` | Same encoding as avm-value |
| `id` | `id=...` | Alternative: known Rentcast property ID |

Returns property record + tax history. Filter to the fields the user asked about.

<a id="listings-sale"></a>
## `listings-sale` — active for-sale listings

`GET /listings/sale?<query-string>`

| Param | Example | Notes |
|---|---|---|
| `city`/`state`/`zipCode` | location filter | Combine at least one |
| `bedrooms`/`bathrooms` | numeric ranges supported | `bedrooms=2` or `bedrooms=2,3,4` |
| `priceMin`/`priceMax` | numeric USD | |
| `limit` | `limit=10` | Default 50, cap for compact replies |

Returns listings array. Don't dump all 50 — surface the top 5-10 with key fields (price, beds/baths, address).

<a id="listings-rental"></a>
## `listings-rental` — active long-term rental listings

`GET /listings/rental/long-term?<query-string>` — same query-param shape as listings-sale (city/state/zip + bedrooms/bathrooms + priceMin/priceMax + limit).

Note the path includes `/long-term`. Short-term (vacation) rentals are a separate Rentcast tier not exposed via this paysponge gateway endpoint.

Returns listings array. Same surfacing guidance as listings-sale.

## Other Rentcast endpoints on pay.sh (not catalogued)

BAT-706 audit found additional sibling endpoints (`/properties/random`, `/avm/rent/long-term`, `/listings/rental/long-term/probe`, etc.) — most are utility/test variants of the catalogued endpoints. Not added; defer unless users ask.
