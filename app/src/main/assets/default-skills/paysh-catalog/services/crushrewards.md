# Crushrewards Shopper (crushrewards)

Find the best price for a product across major US retailers — Amazon, Walmart, Costco, Home Depot, Target, etc.

## Endpoint

- **URL pattern:** `https://api.crushrewards.dev/v1/shopper/best-price?<query>`
- **Method:** GET
- **Cost:** $0.01 USDC per call (Solana mainnet — Solana-native, multi-chain offer with both sol+sol+base)
- **Suggested max_usdc:** 0.05

## Query construction

Pass the product name or query string in `q`:

```
?q=PlayStation+5+slim
?q=Dyson+V11+vacuum
?q=Nespresso+Vertuo+pods
```

URL-encode spaces.

## When to use vs free alternatives

- **Use Crushrewards** when the user wants to compare prices across multiple major US retailers in one call — typical "where can I buy X cheapest" question.
- **Don't use Crushrewards** for non-US shoppers, niche/specialty retailers outside its index, or when the user already knows where they want to buy.

## Response shape

JSON listing prices across the retailer network with retailer name, price, in-stock status, link. Return the top 3 cheapest with retailer name + price.

## Notes

- Solana-native — one of two services in the catalog without an EVM-only fallback path. Cheap and fast.
