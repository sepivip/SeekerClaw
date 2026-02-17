---
name: recipe
version: "1.0.0"
description: "Search recipes, get ingredients and cooking instructions from TheMealDB (free, no API key)"
metadata:
  openclaw:
    emoji: "🍳"
    requires:
      bins: []
      env: []
---

# Recipe

Search for recipes using the free TheMealDB API.

## When to Use

User asks about:
- Recipes ("How do I make pasta carbonara?")
- Cooking instructions ("Recipe for chicken curry")
- Meal ideas ("What can I make with chicken?")
- Ingredients ("What's in a margarita?")

## API Endpoints

Base URL: `https://www.themealdb.com/api/json/v1/1`

### Search by name

```javascript
web_fetch({
  url: "https://www.themealdb.com/api/json/v1/1/search.php?s=carbonara"
})
```

### Search by first letter

```javascript
web_fetch({
  url: "https://www.themealdb.com/api/json/v1/1/search.php?f=c"
})
```

### Get random recipe

```javascript
web_fetch({
  url: "https://www.themealdb.com/api/json/v1/1/random.php"
})
```

### Filter by main ingredient

```javascript
web_fetch({
  url: "https://www.themealdb.com/api/json/v1/1/filter.php?i=chicken"
})
```

### Filter by category

```javascript
web_fetch({
  url: "https://www.themealdb.com/api/json/v1/1/filter.php?c=Seafood"
})
```

Categories: Beef, Chicken, Dessert, Lamb, Miscellaneous, Pasta, Pork, Seafood, Side, Starter, Vegan, Vegetarian, Breakfast, Goat

### Filter by area/cuisine

```javascript
web_fetch({
  url: "https://www.themealdb.com/api/json/v1/1/filter.php?a=Italian"
})
```

Areas: American, British, Canadian, Chinese, Dutch, Egyptian, Filipino, French, Greek, Indian, Irish, Italian, Jamaican, Japanese, Kenyan, Malaysian, Mexican, Moroccan, Polish, Portuguese, Russian, Spanish, Thai, Tunisian, Turkish, Vietnamese

### Get full recipe by ID

```javascript
web_fetch({
  url: "https://www.themealdb.com/api/json/v1/1/lookup.php?i=52772"
})
```

## Response Format

Present recipes clearly:

```
🍳 **Pasta Carbonara**
🌍 Italian | 🍽️ Pasta

**Ingredients:**
- 320g Spaghetti
- 150g Guanciale
- 4 Egg Yolks
- 100g Pecorino Romano
- Black Pepper

**Instructions:**
1. Cook pasta in salted water
2. Fry guanciale until crispy
3. Mix egg yolks with cheese
4. Combine hot pasta with egg mixture
5. Add guanciale, season with pepper

⏱️ Prep: 10 min | Cook: 20 min
```

## Parsing Response

The API returns meals with ingredients in separate fields:
- `strIngredient1` through `strIngredient20`
- `strMeasure1` through `strMeasure20`

Combine non-empty pairs into ingredient list.

## Examples

**User:** "How do I make tiramisu?"
**Action:** Search for "tiramisu", format recipe nicely

**User:** "Give me a random recipe"
**Action:** Use random endpoint, present the result

**User:** "What can I cook with salmon?"
**Action:** Filter by ingredient "salmon", list options

**User:** "I want something Italian"
**Action:** Filter by area "Italian", suggest top results
