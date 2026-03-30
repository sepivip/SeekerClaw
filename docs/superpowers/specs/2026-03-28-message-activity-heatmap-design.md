# Message Activity Heatmap — Design Spec

**Date:** 2026-03-28
**Risk:** LOW — new UI component, no changes to existing code paths

---

## Overview

GitHub-style contribution heatmap showing messages per day on the System screen. 6 months of history, DarkOps red color scale, total message count label.

## Location

System screen, directly below the **Status** section (version/uptime info). Second section on the screen — high visibility without cluttering the dashboard.

## Visual Spec

### Grid Layout
- **Rows:** 7 (Monday at top, Sunday at bottom)
- **Columns:** ~26 (one per week, covering 6 months)
- **Square size:** ~10dp with 2dp gap
- **Square corner radius:** 2dp
- **Scrolling:** None — grid fits on screen (26 cols x 10dp + gaps ≈ 310dp width, fits in card padding)
- **Month labels:** Abbreviated (Oct, Nov, Dec, etc.) along the top, aligned to the first week of each month

### Color Scale (5 levels, DarkOps Red)

| Level | Color | Condition |
|-------|-------|-----------|
| 0 (empty) | `#1A1A24` | 0 messages |
| 1 | `#3D1117` | 1-25th percentile |
| 2 | `#6B1D2A` | 25-50th percentile |
| 3 | `#B22234` | 50-75th percentile |
| 4 (max) | `#E41F28` | 75-100th percentile |

Percentile thresholds are calculated from the non-zero days in the dataset. This ensures the color distribution adapts to the user's actual activity level (a user averaging 5 messages/day gets the same visual spread as one averaging 500).

### Labels
- **Bottom left:** "X,XXX messages since [Month YYYY]" — total count and start date
- **Bottom right:** "Less ▪▪▪▪▪ More" legend with the 5 color levels
- **Text style:** `TextDim` color (#9CA3AF), small font (11sp)

### Card Container
- Standard Surface card with `SeekerClawColors.surface` background
- 16dp padding
- 12dp corner radius (matches existing cards)
- Section header: "Message Activity" in standard section header style

## Data Flow

### 1. Node.js — SQL Query (database.js)

New function `getDailyActivity()` in `database.js`:

```sql
SELECT DATE(timestamp) AS day, COUNT(*) AS count
FROM api_request_log
WHERE timestamp >= date('now', '-6 months')
GROUP BY DATE(timestamp)
ORDER BY day ASC
```

Returns array of `{ day: "2026-01-15", count: 12 }` objects.

### 2. IPC — Extend db_summary_state

Add `dailyActivity` field to the existing `db_summary_state` JSON file. No new IPC file needed.

```json
{
  "today": { ... },
  "month": { ... },
  "memory": { ... },
  "dailyActivity": [
    { "day": "2025-09-28", "count": 5 },
    { "day": "2025-09-29", "count": 12 },
    ...
  ]
}
```

This data changes at most once per day (new day starts), so the existing 30s write interval is more than sufficient. The array will have at most ~180 entries (6 months) — well under 10KB added to the JSON.

### 3. Android — Extend DbSummary (StatsClient.kt)

Add to `DbSummary` data class:

```kotlin
data class DayActivity(val day: String, val count: Int)

// Add to DbSummary:
val dailyActivity: List<DayActivity> = emptyList()
```

Parse from the `dailyActivity` array in the JSON.

### 4. Compose — MessageActivityHeatmap composable

New composable rendered in `SystemScreen.kt` after the Status section.

Renders the grid using a `Column` of `Row`s (7 rows x ~26 cols), each cell a `Box` with the appropriate background color.

Month labels rendered as a `Row` of `Text` elements above the grid, positioned at week boundaries.

## What Does NOT Change

- `DashboardScreen.kt` — untouched
- `api_request_log` schema — no changes, read-only query
- Existing `db_summary_state` fields — all preserved, only `dailyActivity` added
- ServiceState polling interval — stays at 1s
- Database write interval — stays at 30s

## Edge Cases

- **New user (no data):** Show empty grid (all level 0 squares) with "0 messages" label
- **Sparse data:** Percentile calculation only considers non-zero days, so even 3 active days get color spread
- **Service not running:** Show last known data from `db_summary_state` file (same as existing stats behavior)

## Acceptance Criteria

- [ ] Heatmap visible on System screen below Status section
- [ ] Shows 6 months of daily message counts
- [ ] DarkOps red color scale with 5 levels
- [ ] Month labels along the top
- [ ] "X messages since [month]" total at bottom left
- [ ] "Less/More" legend at bottom right
- [ ] Empty state works (new user, no data)
- [ ] Data loads from existing db_summary_state polling (no new IPC)
- [ ] No performance impact on System screen scrolling
