# Tripadvisor Nearby Search (paysponge)

Search nearby travel locations (hotels, restaurants, attractions) by latitude/longitude.

## Endpoint

- **URL pattern:** `https://tripadvisor.x402.paysponge.com/api/v1/location/nearby_search?latLong=<lat>,<long>&category=<hotels|restaurants|attractions>`
- **Method:** GET
- **Cost:** $0.01 USDC per call (Solana mainnet)
- **Suggested max_usdc:** `"0.05"` (decimal STRING)

## Query construction

Required:
- `latLong=<lat>,<long>` — decimal degrees, comma-separated. Example: `41.8902,12.4922` (Rome Colosseum).

Optional:
- `category=hotels` | `restaurants` | `attractions` (default: attractions)
- `radius=<meters>` — search radius (default ~1000m)
- `language=en` | other ISO codes

If the user gives a place name ("Rome"), look up its lat/long from your training data or `web_search` first, then call agent_pay with the resolved coordinates.

## Example flow

User: *"Find hotels near the Eiffel Tower"*

1. Eiffel Tower ≈ `48.8584,2.2945`
2. Call `agent_pay({ url: "https://tripadvisor.x402.paysponge.com/api/v1/location/nearby_search?latLong=48.8584,2.2945&category=hotels", max_usdc: "0.05" })` — object args, `max_usdc` as decimal STRING
3. Return top results from the response.

## Response shape

JSON list of location entries with name, address, rating, ranking. Pick the top 3–5 and present them as a clean bulleted list.
