---
name: exchange-rates
description: "Get currency exchange rates and convert between currencies (free API)"
metadata:
  openclaw:
    emoji: "💱"
    requires:
      bins: []
      env: []
---

# Exchange Rates

Get currency exchange rates using free APIs.

## When to Use

User asks about:
- Exchange rates ("USD to EUR rate")
- Currency conversion ("Convert 100 USD to JPY")
- Multiple currencies ("How much is 50 euros in dollars?")

## API Endpoints

### ExchangeRate-API (Free tier)

```javascript
web_fetch({
  url: "https://open.er-api.com/v6/latest/USD"
})
```

Returns rates for all currencies relative to USD.

### Get specific conversion

```javascript
web_fetch({
  url: "https://open.er-api.com/v6/latest/EUR"
})
```

Then calculate: `amount * rates[target_currency]`

### Alternative: Frankfurter API (Free, no key)

```javascript
web_fetch({
  url: "https://api.frankfurter.app/latest?from=USD&to=EUR,GBP,JPY"
})
```

### Historical rates

```javascript
web_fetch({
  url: "https://api.frankfurter.app/2024-01-15?from=USD&to=EUR"
})
```

## Common Currency Codes

| Code | Currency |
|------|----------|
| USD | US Dollar |
| EUR | Euro |
| GBP | British Pound |
| JPY | Japanese Yen |
| CNY | Chinese Yuan |
| KRW | Korean Won |
| INR | Indian Rupee |
| CAD | Canadian Dollar |
| AUD | Australian Dollar |
| CHF | Swiss Franc |
| MXN | Mexican Peso |
| BRL | Brazilian Real |
| SGD | Singapore Dollar |
| HKD | Hong Kong Dollar |
| THB | Thai Baht |

## Response Format

Present conversions clearly:

```
💱 **USD → EUR**
Rate: 1 USD = 0.92 EUR

💰 100 USD = 92.00 EUR

Last updated: 2024-02-04
```

For multiple currencies:
```
💱 **100 USD converts to:**
- 92.00 EUR (Euro)
- 78.50 GBP (British Pound)
- 14,850 JPY (Japanese Yen)
```

## Conversion Logic

```javascript
// To convert amount from currency A to B:
// 1. Get rates with base = A
// 2. Multiply: amount * rates[B]

// Example: 100 EUR to USD
// GET /latest/EUR → rates.USD = 1.09
// Result: 100 * 1.09 = 109 USD
```

## Examples

**User:** "What's the dollar to euro rate?"
**Action:** Get USD rates, show EUR rate

**User:** "Convert 500 yen to dollars"
**Action:** Get JPY rates, calculate USD amount

**User:** "How much is 1000 pesos in euros?"
**Action:** Get MXN rates, show EUR conversion

**User:** "Exchange rates for USD"
**Action:** Show rates for major currencies vs USD
