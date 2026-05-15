# Purch Marketplace (purch)

General marketplace product/listing search — querying the Purch catalog of items, sellers, prices.

## Endpoint

- **URL pattern:** `https://api.purch.xyz/x402/search?<query>`
- **Method:** GET
- **Cost:** $0.01 USDC per call (Solana mainnet — Solana-only, no Base/EVM leg)
- **Suggested max_usdc:** 0.05

## Query construction

Pass a free-form search string in `q`:

```
?q=mechanical+keyboard
?q=hiking+boots+size+10
?q=raspberry+pi
```

URL-encode spaces as `+` or `%20`.

## When to use vs free alternatives

- **Use Purch** when the user wants a marketplace catalog scan (compare listings across sellers in the Purch network).
- **Don't use Purch** for a specific retailer (use that retailer's own site/API), or for crushrewards-style "find the lowest price across major US retailers" — that's `crushrewards.md`.

## Response shape

JSON listing of products with name, price, seller, link. Return the top 3–5 matches concisely.

## Notes

- One of the two Solana-native services in the catalog (the other is `crushrewards`). Pays directly to a Solana payTo without an EVM hop.
