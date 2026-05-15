# StableEnrich (merit-systems)

Data enrichment — turn emails, domains, or place names into structured profiles via Google Maps and other backing sources.

## Endpoint

- **URL pattern:** `https://stableenrich.dev/api/google-maps/place-details/partial` (and other enrichment sub-paths)
- **Method:** POST (JSON body)
- **Cost:** $0.02 USDC per call (Solana mainnet)
- **Suggested max_usdc:** `"0.10"` (decimal STRING)

## Body construction

For place-details (the most common enrichment path):

```json
{
  "place_id": "ChIJN1t_tDeuEmsRUsoyG83frY4"
}
```

Or for a partial-name lookup:

```json
{
  "query": "Blue Bottle Coffee Brooklyn"
}
```

Other sub-paths under `/api/...` cover different enrichment sources (people lookup, company lookup) — full path inventory not yet captured.

## When to use vs free alternatives

- **Use StableEnrich** for structured Google Maps Place details, company/person enrichment beyond what `web_search` returns, or when the user explicitly asks "look up this place / person."
- **Don't use StableEnrich** for casual location questions (`web_search` is free), or for places already in your training data.

## Response shape

JSON with the enriched profile fields. Return the most useful 3–5 fields (name, address, hours, rating, etc. for places) — don't dump everything.
