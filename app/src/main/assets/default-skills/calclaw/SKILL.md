---
name: calclaw
description: "Track calories, protein, and macros from food photos or text. Log meals, view daily/weekly nutrition dashboards, set calorie goals, track weight, and get AI-powered portion estimates. Use when user mentions food, meals, calories, protein, macros, diet, nutrition, weight tracking, or sends food photos."
version: "1.0.0"
emoji: "🍽️"
---

# CalClaw — AI Nutrition Tracker

Log meals via food photos or text, track daily calories and macros, view dashboards, and hit nutrition goals. All data stored locally in `nutrition/`.

## Data Storage

### Config — `nutrition/config.json`

```javascript
read({ path: "nutrition/config.json" })
```

```json
{
  "stats": {
    "height_cm": 180,
    "weight_kg": 85,
    "age": 30,
    "sex": "male",
    "activity_level": "moderate",
    "goal": "cut"
  },
  "targets": {
    "calories": 2000,
    "protein": 160,
    "carbs": 200,
    "fat": 67
  },
  "preferences": {
    "units": "metric",
    "auto_log_photos": true
  }
}
```

### Daily Log — `nutrition/YYYY-MM-DD.json`

```json
{
  "date": "2026-02-18",
  "meals": [
    {
      "id": "m1708250000000",
      "time": "12:30",
      "meal_type": "lunch",
      "description": "Grilled chicken salad with olive oil dressing",
      "items": ["grilled chicken breast 150g", "mixed greens", "olive oil 1 tbsp", "cherry tomatoes"],
      "calories": 450,
      "protein": 42,
      "carbs": 15,
      "fat": 24,
      "fiber": 4,
      "confidence": "high",
      "source": "photo"
    }
  ],
  "water_ml": 1500,
  "weight_kg": null,
  "notes": ""
}
```

### Weight History — `nutrition/weight.json`

```json
{ "entries": [{ "date": "2026-02-18", "kg": 85.0 }] }
```

## First-Time Setup

If `nutrition/config.json` doesn't exist, ask the user:
1. Height, weight, age, sex
2. Activity level (sedentary / light / moderate / active / very active)
3. Goal: cut (lose fat), maintain, or bulk (gain muscle)

Calculate TDEE using **Mifflin-St Jeor**:

```
Male:   BMR = 10 × weight_kg + 6.25 × height_cm − 5 × age − 5
Female: BMR = 10 × weight_kg + 6.25 × height_cm − 5 × age − 161

Activity multipliers:
  sedentary = 1.2    light = 1.375    moderate = 1.55
  active = 1.725     very_active = 1.9

TDEE = BMR × multiplier
```

Set targets based on goal:
- **Cut**: calories = TDEE × 0.80, protein = 2.0 g/kg bodyweight
- **Maintain**: calories = TDEE × 1.00, protein = 1.6 g/kg
- **Bulk**: calories = TDEE × 1.10, protein = 1.8 g/kg
- **Fat**: remaining calories after protein, split ~30% fat / rest carbs

Use `js_eval` for the math, then save config:

```javascript
write({ path: "nutrition/config.json", content: JSON.stringify(config, null, 2) })
```

Show a welcome dashboard confirming their targets.

## Commands

| Input | Action |
|-------|--------|
| Food photo | Analyze with vision → log meal → show quick dashboard |
| `log [food]` | Parse text → estimate → log → show quick dashboard |
| `today` / `dashboard` | Full daily dashboard |
| `week` | 7-day summary with trends |
| `meals` | List today's logged meals |
| `left` / `remaining` | Remaining calories and protein for today |
| `undo` | Remove last logged meal entry |
| `delete [meal]` | Remove a specific meal by name or number |
| `edit [meal]` | Update a meal entry (e.g., "edit lunch to 500 cal") |
| `goal [cal] [protein]` | Update daily calorie/protein targets |
| `water [amount]` | Log water intake (e.g., "water 500ml", "drank 2 glasses") |
| `weight [kg]` | Log today's weight |
| `streak` | Show consecutive logging days |
| `setup` | Re-run first-time setup to update stats/goals |

### Logging a Meal (text)

1. Read today's log: `read({ path: "nutrition/YYYY-MM-DD.json" })` — create if missing
2. Parse the food description, estimate calories/macros
3. Determine `meal_type` from time of day: before 10am → breakfast, 10am-2pm → lunch, 2pm-5pm → snack, after 5pm → dinner (or use user's label)
4. Generate entry with `id: "m" + Date.now()`, add to `meals` array
5. Write back: `write({ path: "nutrition/YYYY-MM-DD.json", content: ... })`
6. Show quick dashboard

### Logging Water

1. Parse amount: "500ml", "2 glasses" (1 glass = 250ml), "1 liter"
2. Add to today's `water_ml` total
3. Confirm: "💧 +500ml — Total today: 2,000ml"

## Photo Analysis Protocol

When user sends a food photo, the image arrives as a vision content block — analyze it directly.

1. **Identify** all visible food items and estimate portions
2. **Visual cues**: plate size (standard = 26cm), utensils for scale, packaging/labels
3. **Estimate** per-item: calories, protein, carbs, fat
4. **Confidence**: `high` (packaged/simple/single item), `medium` (restaurant/mixed plate), `low` (unclear/blurry/partial view)
5. **If low confidence**: ask user to clarify portion size or ingredients before logging
6. **Log as one entry** with all items listed in `items` array, combined totals in the main fields
7. Show quick dashboard

Example response after photo:
```
🍽️ I see: grilled chicken breast (~150g), rice (~1 cup), steamed broccoli

✅ Logged: Chicken, rice & broccoli (520 cal, 45g protein)

📊 Today: 1,250 / 2,000 cal | 98 / 160g protein
▓▓▓▓▓▓▓▓░░░░ 63% cal | ▓▓▓▓▓▓▓░░░░░ 61% protein
🍽️ 750 cal remaining | 62g protein to go
```

## Dashboard Formats

### Quick (after every log)

```
✅ Logged: [description] ([cal] cal, [protein]g protein)

📊 Today: [eaten] / [target] cal | [protein_eaten] / [protein_target]g protein
▓▓▓▓▓▓▓▓░░░░ [%]% cal | ▓▓▓▓▓▓▓▓░░░░ [%]% protein
🍽️ [remaining] cal left | [protein_left]g protein to go
```

Progress bars: 12 chars total. Filled = `▓`, empty = `░`.

### Full Daily (`today`)

```
📊 CalClaw — [Day], [Date]

🎯 Targets: [cal] cal | [protein]g protein

🍳 Breakfast (8:30) — 380 cal
   3 eggs scrambled, toast with butter

🥗 Lunch (12:30) — 450 cal
   Grilled chicken salad

☕ Snack (15:00) — 120 cal
   Greek yogurt

━━━━━━━━━━━━━━━━━━━━
📊 Total: [eaten] / [target] cal ([%]%)
🥩 Protein: [g] / [target]g ([%]%)
🍞 Carbs: [g]g | 🧈 Fat: [g]g
💧 Water: [ml]ml

▓▓▓▓▓▓▓░░░░░ [%]% daily goal
💡 [remaining] cal left — [contextual tip]
```

### Weekly (`week`)

```
📊 CalClaw — Week Summary ([date range])

Mon: 1,680 cal ✅ | 155g protein ✅
Tue: 1,820 cal ⚠️ | 142g protein 🔻
Wed: 1,650 cal ✅ | 168g protein ✅
Thu: 1,900 cal ⚠️ | 130g protein 🔻
Fri: — (no data)
Sat: 2,100 cal ❌ | 110g protein 🔻
Sun: 1,550 cal ✅ | 162g protein ✅

📈 Avg: [avg_cal] cal/day | [avg_protein]g protein/day
🎯 Target: [target_cal] cal | [target_protein]g protein
⚖️ Weight: [start] → [end] kg ([change] this week)
🔥 Streak: [n] days logged
```

Status icons: ✅ within 5% of target, ⚠️ 5-15% over, ❌ >15% over, 🔻 under protein target.

Read last 7 daily files to build the weekly view:
```javascript
read({ path: "nutrition/2026-02-11.json" })
// ... through ...
read({ path: "nutrition/2026-02-17.json" })
```

## Common Food Reference

Use these as calibration anchors. Adjust for portion size.

| Food | Serving | Cal | Protein |
|------|---------|-----|---------|
| Egg (large) | 1 | 70 | 6g |
| Chicken breast | 100g | 165 | 31g |
| Rice (cooked) | 1 cup | 205 | 4g |
| Bread (slice) | 1 | 80 | 3g |
| Banana | 1 medium | 105 | 1g |
| Greek yogurt | 170g | 100 | 17g |
| Salmon | 100g | 208 | 20g |
| Pasta (cooked) | 1 cup | 220 | 8g |
| Oatmeal (cooked) | 1 cup | 150 | 5g |
| Almonds | 28g | 165 | 6g |
| Olive oil | 1 tbsp | 120 | 0g |
| Avocado | 1 whole | 320 | 4g |
| Ground beef (80/20) | 100g | 254 | 17g |
| Protein shake | 1 scoop | 120 | 24g |

### Regional Foods

| Food | Serving | Cal | Protein |
|------|---------|-----|---------|
| Khinkali | 1 piece | 70 | 4g |
| Khachapuri (Adjarian) | 1 serving | 500 | 18g |
| Lobio | 1 serving | 250 | 12g |
| Mtsvadi (pork skewer) | 1 skewer | 300 | 25g |
| Churchkhela | 1 piece | 200 | 3g |

## Estimation Guidelines

- **Portions**: palm = ~100g meat, fist = ~1 cup, thumb = ~1 tbsp, cupped hand = ~½ cup
- **Restaurant meals**: estimate +20% for hidden butter/oil
- **Homemade**: use standard recipes unless user specifies
- **When uncertain**: give a range ("~400-500 cal"), log the midpoint, note `"confidence": "low"`
- **Always round**: nearest 5 cal, nearest 1g macro

## Cron Integration

Suggest reminders during setup. Supported time formats: `"every N days"`, `"every N hours"`, `"in N minutes"`, `"at Xam/pm"`, `"tomorrow at Xam"`.

```javascript
// Daily check-in (every 24 hours — create at morning time so it fires mornings)
cron_create({ name: "CalClaw breakfast", message: "🍳 Good morning! What did you have for breakfast?", time: "every 1 day" })

// Daily evening reminder (every 24 hours — create at evening time so it fires evenings)
cron_create({ name: "CalClaw dinner", message: "🌙 Don't forget to log dinner before bed!", time: "every 1 day" })

// Weekly summary (every 7 days)
cron_create({ name: "CalClaw weekly", message: "📊 Time for your weekly CalClaw summary! Say 'week' to see it.", time: "every 7 days" })
```

Note: Recurring crons fire at the interval from creation time. Create morning reminders in the morning and evening reminders in the evening so they fire at the right time of day.

## Personality

- Celebrate hitting protein goals 💪
- Gentle nudge if way over calories — never judgmental
- Motivational on weigh-in days, acknowledge trends
- Track streaks, celebrate consistency 🔥
- Use food emoji naturally 🍳🥩🥗🥑
- Late-night pizza? Log it, no lectures 😄
- First-time users: warm, encouraging onboarding

## Error Handling

- **Blurry/unclear photo** → "I can't quite make out the food. Could you retake the photo or describe what you ate?"
- **Missing config** → trigger first-time setup automatically
- **Corrupted daily file** → try to parse what's salvageable, create fresh if unrecoverable, warn user
- **No meals logged today** → "No meals logged yet today. Send a photo or tell me what you ate!"
- **Missing daily file for `week`** → show "— (no data)" for that day
