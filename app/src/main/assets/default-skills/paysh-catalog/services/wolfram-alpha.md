# Wolfram Alpha (paysponge)

Computational knowledge engine — math, science, factual lookups, unit conversions, etc.

## Endpoint

- **URL pattern:** `https://wolframalpha.x402.paysponge.com/v1/result?i=<URL-encoded-query>`
- **Method:** GET
- **Cost:** $0.01 USDC per call (Solana mainnet)
- **Suggested max_usdc:** `"0.05"` (decimal STRING)

## Query construction

The `i=` parameter takes a natural-language Wolfram Alpha query. URL-encode it with `encodeURIComponent`. Spaces become `%20`; chars like `&`, `=`, `+`, `^`, `#`, `/` get percent-encoded; chars `A-Z a-z 0-9 - _ . ~ ! * ' ( )` are NOT encoded by `encodeURIComponent` (per the JS spec) — leave them unchanged. Do NOT use `+` for spaces. See SKILL.md's "Examples → Activates → paid call" for the full encoding flow.

| Intent | `encodeURIComponent(query)` → `i=` value |
|---|---|
| Mass of the sun | `i=mass%20of%20the%20sun` |
| Integral of sin(x)*ln(x) | `i=integral%20of%20sin(x)*ln(x)` |
| Convert 100 km to miles | `i=100%20km%20in%20miles` |
| GDP of Japan 2024 | `i=GDP%20of%20Japan%202024` |
| Solve x^2+3x-4=0 | `i=solve%20x%5E2%2B3x-4%3D0` |

## When to use vs free alternatives

- **Use Wolfram** for computation, current data Wolfram updates (population, GDP), unit conversion, formula evaluation, symbolic math.
- **Don't use Wolfram** for general trivia your training data already knows ("what is the capital of France"), live web events (use `web_search`), or chemistry/biology beyond what Wolfram models well.

## Response shape

Plain text result from Wolfram. Return the answer concisely; don't dump the full XML/JSON if Wolfram returns one.
