---
name: calculator
description: "Perform calculations, unit conversions, and math operations. Use when: user asks to calculate, convert units, do math, percentages, tip calculations, or date arithmetic. Don't use when: user asks about crypto prices (use crypto-prices skill) or nutrition math (use calclaw skill)."
version: "1.0.0"
---

# Calculator

## Use when
- "what's 15% of 80?", "convert 5km to miles"
- Math expressions, tip calculations
- Date differences, unit conversions

## Don't use when
- Crypto prices (use crypto-prices)
- Calorie/macro calculations (use calclaw)
- Financial analysis

## Instructions
For calculations:

1. Parse the mathematical expression

2. Show work for complex calculations (step by step)
   Just the answer for simple arithmetic

3. Unit conversions supported:
   - Temperature: C/F/K
   - Length: m/ft/in/cm/km/mi
   - Weight: kg/lb/g/oz
   - Volume: L/gal/ml
   - Currency: Use web_search for current rates

4. Percentages: X% of Y, tip calculations

5. Date math: days between dates, X days from now

Format results clearly with units.
