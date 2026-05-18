# Wolfram Alpha (paysponge)

Computational knowledge engine — math, science, factual lookups, unit conversions, etc. Two catalogued endpoints:

- **[`v1-result`](#v1-result)** — simple plain-text answer ($0.01)
- **[`v2-query`](#v2-query)** — structured JSON output with pods/subpods ($0.02)

Service URL base: `https://wolframalpha.x402.paysponge.com`

## When to use vs free alternatives

- **Use Wolfram** for computation, current data Wolfram updates (population, GDP), unit conversion, formula evaluation, symbolic math.
- **Don't use Wolfram** for general trivia your training data already knows ("what is the capital of France"), live web events (use `web_search`), or chemistry/biology beyond what Wolfram models well.
- Pick `v1-result` for simple "give me one answer" queries (cheaper at $0.01, plain text). Pick `v2-query` when the user wants step-by-step solutions, multiple representations, or structured data ($0.02, JSON pods).

<a id="v1-result"></a>
## `v1-result` — short plain-text answer

`GET https://wolframalpha.x402.paysponge.com/v1/result?i=<URL-encoded-query>`

### Query construction

The `i=` parameter takes a natural-language Wolfram Alpha query. URL-encode it with `encodeURIComponent`. Spaces become `%20`; chars like `&`, `=`, `+`, `^`, `#`, `/` get percent-encoded; chars `A-Z a-z 0-9 - _ . ~ ! * ' ( )` are NOT encoded by `encodeURIComponent` (per the JS spec) — leave them unchanged. Do NOT use `+` for spaces.

| Intent | `encodeURIComponent(query)` → `i=` value |
|---|---|
| Mass of the sun | `i=mass%20of%20the%20sun` |
| Integral of sin(x)*ln(x) | `i=integral%20of%20sin(x)*ln(x)` |
| Convert 100 km to miles | `i=100%20km%20in%20miles` |
| GDP of Japan 2024 | `i=GDP%20of%20Japan%202024` |
| Solve x^2+3x-4=0 | `i=solve%20x%5E2%2B3x-4%3D0` |

### Response shape

Plain text result from Wolfram. Return the answer concisely.

<a id="v2-query"></a>
## `v2-query` — structured pods/subpods (JSON)

`GET https://wolframalpha.x402.paysponge.com/v2/query?input=<URL-encoded-query>&output=json`

**Note on bazaar schema:** the committed 402 capture's bazaar `info.input.queryParams` is empty (`{}` with `additionalProperties: false`) — but Wolfram's real `/v2/query` API REQUIRES `input` and accepts `output` (json/xml). The bazaar schema is incomplete; the agent must construct the URL with these params or Wolfram returns a 422-style error AFTER payment.

### When to pick v2-query over v1-result

- User asks "show your work" / "step by step" — v2 returns intermediate pods (Solution / Steps / Alternative forms)
- User asks for multiple representations (decimal + fraction, polar + rectangular, time + units)
- User wants raw data the agent can post-process (extract specific pod text)

$0.02 (2x v1-result) — only use when v1's plain text is insufficient.

### Query construction

`input=` takes the same natural-language query as v1's `i=` parameter (encode the same way). The `output=json` query param requests JSON; without it Wolfram returns XML.

### Response shape

JSON with `queryresult.pods[]` — each pod has `title` and `subpods[].plaintext`. Most useful pods are usually `Result`, `Solution`, `Steps`, `Decimal approximation`, `Alternative forms`. Surface the pods the user actually asked about; don't dump every pod.

## Other Wolfram endpoints on pay.sh (not catalogued)

- `GET /v1/simple` — plain-text-only alternative to v1/result; functionally similar, no advantage for our use. Not added.

If users want the simple endpoint specifically, it's deferred — no async-fetch or special-case need yet.
