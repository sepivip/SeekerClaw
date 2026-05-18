# Tripadvisor (paysponge)

Travel data — search by geo or name, then drill into specific locations for details/reviews/photos. Five catalogued endpoints:

- **[`nearby-search`](#nearby-search)** — search by lat/long ($0.01)
- **[`search`](#search)** — search by query string / place name ($0.01)
- **[`location-details`](#location-details)** — full details for a specific location ID ($0.01)
- **[`location-reviews`](#location-reviews)** — recent reviews for a location ID ($0.01)
- **[`location-photos`](#location-photos)** — photo URLs for a location ID ($0.01)

Service URL base: `https://tripadvisor.x402.paysponge.com`

## Typical query flow

User asks "find restaurants near the Eiffel Tower". Two-step:
1. Use `nearby-search` (geo) or `search` (name) → returns `location_id` per match.
2. Use `location-details`/`reviews`/`photos` with the `location_id` to drill in.

Many user queries only need step 1 (a list of names + ratings + addresses). Step 2 is for "tell me more about <specific place>" follow-ups.

<a id="nearby-search"></a>
## `nearby-search` — by lat/long

`GET /api/v1/location/nearby_search?latLong=<lat>,<long>&category=<hotels|restaurants|attractions>`

| Param | Example | Notes |
|---|---|---|
| `latLong` | `41.8902,12.4922` | Decimal degrees, comma-separated (required) |
| `category` | `hotels` \| `restaurants` \| `attractions` | Default: attractions |
| `radius` | `radius=1000` | Meters; default ~1000 |
| `language` | `language=en` | ISO code |

If user gives a place name, resolve to coords via training data / `web_search` first, then call.

Returns array of locations with `location_id`, name, rating, distance.

<a id="search"></a>
## `search` — by query string

`GET /api/v1/location/search?searchQuery=<URL-encoded-name>&category=<...>`

| Param | Example | Notes |
|---|---|---|
| `searchQuery` | `searchQuery=La%20Tartine%20Paris` | Free-text query (required) |
| `category` | as above | Filters by type |
| `language` | `language=en` | ISO code |

Use when the user names a specific place ("Find La Tartine in Paris") rather than asking for nearby anything.

<a id="location-details"></a>
## `location-details` — full details for a place

`GET /api/v1/location/<locationId>/details?language=en`

Replace `<locationId>` in the path with the integer ID from a prior search/nearby_search response. Returns name, full address, hours, rating, ranking, awards, contact info.

<a id="location-reviews"></a>
## `location-reviews` — recent reviews

`GET /api/v1/location/<locationId>/reviews?language=en&limit=10`

Returns recent reviews (text + rating + reviewer + date). Surface 3-5 representative reviews — don't dump the full list.

<a id="location-photos"></a>
## `location-photos` — photo URLs for a place

`GET /api/v1/location/<locationId>/photos?language=en`

Returns photo metadata + URLs (image URLs, not the image bytes themselves — Tripadvisor's CDN serves them). Send the URLs to the user; the agent can't embed images directly in Telegram/Discord text replies without using `telegram_send_file` after a separate fetch.

## Response surfacing

For all five endpoints — pick the top 3-5 results / most useful fields per the user's intent. Don't dump full JSON. For multi-place results, format as bulleted lists with name + rating + address.
