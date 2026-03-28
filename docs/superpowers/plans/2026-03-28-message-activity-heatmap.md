# Message Activity Heatmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GitHub-style message activity heatmap to the System screen showing messages per day over 6 months, with DarkOps red color scale.

**Architecture:** Node.js queries `api_request_log` for daily message counts, appends to existing `db_summary_state` JSON. Android parses the new field and renders a Compose heatmap grid. No new IPC files, no new dependencies.

**Tech Stack:** SQL.js (Node.js), Jetpack Compose (Android), existing file-based IPC

**Spec:** `docs/superpowers/specs/2026-03-28-message-activity-heatmap-design.md`

---

## File Structure

### Modified Files (Node.js)

| File | Changes |
|------|---------|
| `app/src/main/assets/nodejs-project/database.js` | Add `getDailyActivity()` function, include result in `getDbSummary()` return |

### Modified Files (Kotlin)

| File | Changes |
|------|---------|
| `app/src/main/java/com/seekerclaw/app/util/StatsClient.kt` | Add `DayActivity` data class, extend `DbSummary` with `dailyActivity` field, parse from JSON |
| `app/src/main/java/com/seekerclaw/app/ui/system/SystemScreen.kt` | Add `MessageActivityHeatmap` composable, insert below Status section |

---

## Task 1: Add daily activity query to database.js

**Files:**
- Modify: `app/src/main/assets/nodejs-project/database.js`

- [ ] **Step 1: Add `getDailyActivity()` function**

Add this function before `getDbSummary()` (before line 480):

```javascript
// Daily message counts for heatmap (last 6 months)
function getDailyActivity() {
    if (!db) return [];
    try {
        const rows = db.exec(
            `SELECT DATE(timestamp) AS day, COUNT(*) AS count
             FROM api_request_log
             WHERE timestamp >= date('now', '-6 months')
             GROUP BY DATE(timestamp)
             ORDER BY day ASC`
        );
        if (rows.length === 0 || rows[0].values.length === 0) return [];
        return rows[0].values.map(([day, count]) => ({ day, count }));
    } catch (e) {
        return [];
    }
}
```

- [ ] **Step 2: Include daily activity in getDbSummary() return**

In `getDbSummary()`, change line 481 from:

```javascript
const summary = { today: null, month: null, memory: null };
```

to:

```javascript
const summary = { today: null, month: null, memory: null, dailyActivity: [] };
```

And add before the `return summary;` line (before line 555):

```javascript
summary.dailyActivity = getDailyActivity();
```

- [ ] **Step 3: Syntax check**

```bash
node --check app/src/main/assets/nodejs-project/database.js
```

Expected: Pass.

- [ ] **Step 4: Smoke test the query**

```bash
node -e "
// Simulate the SQL pattern
const days = [];
for (let i = 180; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    days.push({ day: d.toISOString().slice(0, 10), count: Math.floor(Math.random() * 20) });
}
console.log('Days:', days.length);
console.log('First:', days[0]);
console.log('Last:', days[days.length - 1]);
console.log('JSON size:', JSON.stringify(days).length, 'bytes');
console.log(JSON.stringify(days).length < 10000 ? 'PASS: under 10KB' : 'FAIL: too large');
"
```

Expected: ~180 days, under 10KB JSON.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/assets/nodejs-project/database.js
git commit -m "feat: add daily activity query for message heatmap

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 2: Extend DbSummary with daily activity data

**Files:**
- Modify: `app/src/main/java/com/seekerclaw/app/util/StatsClient.kt`

- [ ] **Step 1: Add DayActivity data class**

Add before the `DbSummary` data class (before line 18):

```kotlin
data class DayActivity(val day: String, val count: Int)
```

- [ ] **Step 2: Add dailyActivity field to DbSummary**

Add a new field at the end of the `DbSummary` data class (after `memoryLastIndexed`):

```kotlin
val dailyActivity: List<DayActivity> = emptyList(),
```

- [ ] **Step 3: Parse dailyActivity from JSON in fetchDbSummary()**

In the `fetchDbSummary()` function, after parsing `memory` (after line 46), add:

```kotlin
val dailyActivityList = mutableListOf<DayActivity>()
if (json.has("dailyActivity") && !json.isNull("dailyActivity")) {
    val arr = json.getJSONArray("dailyActivity")
    for (i in 0 until arr.length()) {
        val item = arr.getJSONObject(i)
        dailyActivityList.add(DayActivity(
            day = item.optString("day", ""),
            count = item.optInt("count", 0)
        ))
    }
}
```

And add to the `DbSummary(...)` constructor call (after `memoryLastIndexed`):

```kotlin
dailyActivity = dailyActivityList,
```

- [ ] **Step 4: Commit**

```bash
git add app/src/main/java/com/seekerclaw/app/util/StatsClient.kt
git commit -m "feat: extend DbSummary with daily activity data

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 3: Build MessageActivityHeatmap composable + add to SystemScreen

**Files:**
- Modify: `app/src/main/java/com/seekerclaw/app/ui/system/SystemScreen.kt`

- [ ] **Step 1: Add heatmap color constants and helper**

Add these constants and helper function inside the file (before the `SystemScreen` composable, near other helpers):

```kotlin
// Heatmap color scale — DarkOps Red (5 levels)
private val HeatmapColors = listOf(
    Color(0xFF1A1A24), // Level 0: empty
    Color(0xFF3D1117), // Level 1
    Color(0xFF6B1D2A), // Level 2
    Color(0xFF8B2232), // Level 3
    Color(0xFFE41F28), // Level 4: max
)

private fun heatmapColorForCount(count: Int, thresholds: List<Int>): Color {
    if (count == 0) return HeatmapColors[0]
    if (thresholds.isEmpty()) return HeatmapColors[4]
    return when {
        count <= thresholds.getOrElse(0) { 1 } -> HeatmapColors[1]
        count <= thresholds.getOrElse(1) { 2 } -> HeatmapColors[2]
        count <= thresholds.getOrElse(2) { 5 } -> HeatmapColors[3]
        else -> HeatmapColors[4]
    }
}
```

- [ ] **Step 2: Add the MessageActivityHeatmap composable**

Add this composable function:

```kotlin
@Composable
private fun MessageActivityHeatmap(dailyActivity: List<DayActivity>) {
    val shape = RoundedCornerShape(12.dp)

    // Build date->count lookup
    val countMap = dailyActivity.associate { it.day to it.count }

    // Calculate 6-month date range ending today
    val today = java.time.LocalDate.now()
    val startDate = today.minusMonths(6)
    // Align to Monday of that week
    val startMonday = startDate.with(java.time.DayOfWeek.MONDAY)

    // Build weeks grid: list of weeks, each week is list of (date, count) for Mon-Sun
    val weeks = mutableListOf<List<Pair<java.time.LocalDate, Int>>>()
    var weekStart = startMonday
    while (weekStart <= today) {
        val week = (0 until 7).map { dayOffset ->
            val date = weekStart.plusDays(dayOffset.toLong())
            val count = if (date in startDate..today) {
                countMap[date.toString()] ?: 0
            } else 0
            date to count
        }
        weeks.add(week)
        weekStart = weekStart.plusWeeks(1)
    }

    // Calculate percentile thresholds from non-zero days
    val nonZeroCounts = dailyActivity.map { it.count }.filter { it > 0 }.sorted()
    val thresholds = if (nonZeroCounts.isNotEmpty()) {
        listOf(
            nonZeroCounts[nonZeroCounts.size / 4],
            nonZeroCounts[nonZeroCounts.size / 2],
            nonZeroCounts[(nonZeroCounts.size * 3) / 4],
        )
    } else emptyList()

    val totalMessages = dailyActivity.sumOf { it.count }
    val earliestDate = if (dailyActivity.isNotEmpty()) {
        try {
            val d = java.time.LocalDate.parse(dailyActivity.first().day)
            d.month.getDisplayName(java.time.format.TextStyle.SHORT, java.util.Locale.ENGLISH) + " " + d.year
        } catch (_: Exception) { "" }
    } else ""

    val cellSize = 10.dp
    val cellGap = 2.dp

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(SeekerClawColors.Surface, shape)
            .padding(16.dp),
    ) {
        // Month labels row
        Row(modifier = Modifier.fillMaxWidth().padding(start = 0.dp, bottom = 4.dp)) {
            var lastMonth = -1
            weeks.forEachIndexed { index, week ->
                val month = week[0].first.monthValue
                if (month != lastMonth) {
                    lastMonth = month
                    val label = week[0].first.month.getDisplayName(
                        java.time.format.TextStyle.SHORT, java.util.Locale.ENGLISH
                    )
                    Text(
                        text = label,
                        color = SeekerClawColors.TextDim,
                        fontSize = 9.sp,
                        modifier = Modifier.padding(end = 4.dp)
                    )
                }
            }
        }

        // Grid: 7 rows (Mon-Sun), weeks as columns
        // Use horizontal scroll if needed
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState()),
        ) {
            Column {
                for (dayIndex in 0 until 7) {
                    Row {
                        weeks.forEach { week ->
                            val (date, count) = week[dayIndex]
                            val color = if (date in startDate..today) {
                                heatmapColorForCount(count, thresholds)
                            } else HeatmapColors[0]
                            Box(
                                modifier = Modifier
                                    .size(cellSize)
                                    .padding(cellGap / 2)
                                    .background(color, RoundedCornerShape(2.dp))
                            )
                        }
                    }
                }
            }
        }

        Spacer(modifier = Modifier.height(8.dp))

        // Footer: total count + legend
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Total count
            Text(
                text = if (totalMessages > 0 && earliestDate.isNotEmpty()) {
                    "${"%,d".format(totalMessages)} messages since $earliestDate"
                } else "No message data yet",
                color = SeekerClawColors.TextDim,
                fontSize = 11.sp,
            )

            // Legend: Less ▪▪▪▪▪ More
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Less", color = SeekerClawColors.TextDim, fontSize = 10.sp)
                Spacer(modifier = Modifier.width(3.dp))
                HeatmapColors.forEach { color ->
                    Box(
                        modifier = Modifier
                            .size(8.dp)
                            .padding(0.5.dp)
                            .background(color, RoundedCornerShape(1.dp))
                    )
                }
                Spacer(modifier = Modifier.width(3.dp))
                Text("More", color = SeekerClawColors.TextDim, fontSize = 10.sp)
            }
        }
    }
}
```

- [ ] **Step 3: Insert heatmap into SystemScreen layout**

In the `SystemScreen` composable, find the Spacer after the Status section (line 171):

```kotlin
        Spacer(modifier = Modifier.height(24.dp))

        // ==================== DEVICE ====================
```

Insert the heatmap section between the Spacer and Device:

```kotlin
        Spacer(modifier = Modifier.height(24.dp))

        // ==================== MESSAGE ACTIVITY ====================
        SectionLabel("Message Activity")

        val dbSummary = remember { mutableStateOf<DbSummary?>(null) }
        LaunchedEffect(Unit) {
            dbSummary.value = fetchDbSummary()
        }
        // Also refresh on the existing 30s interval if already fetched elsewhere
        MessageActivityHeatmap(
            dailyActivity = dbSummary.value?.dailyActivity ?: emptyList()
        )

        Spacer(modifier = Modifier.height(24.dp))

        // ==================== DEVICE ====================
```

**Wait** — check if SystemScreen already fetches `dbSummary`. If it does, reuse that state instead of creating a new one.

Look for existing `fetchDbSummary()` calls in SystemScreen. The exploration found the screen already has `dbSummary` state and a `LaunchedEffect` that fetches it every 30s. If so, just reference the existing `dbSummary` variable:

```kotlin
        // ==================== MESSAGE ACTIVITY ====================
        SectionLabel("Message Activity")

        MessageActivityHeatmap(
            dailyActivity = dbSummary?.dailyActivity ?: emptyList()
        )

        Spacer(modifier = Modifier.height(24.dp))
```

- [ ] **Step 4: Add required imports**

Add these imports at the top of SystemScreen.kt if not already present:

```kotlin
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.ui.unit.sp
import com.seekerclaw.app.util.DayActivity
```

- [ ] **Step 5: Commit**

```bash
git add app/src/main/java/com/seekerclaw/app/ui/system/SystemScreen.kt
git commit -m "feat: add MessageActivityHeatmap to System screen

GitHub-style contribution heatmap showing messages per day over 6 months.
DarkOps red color scale, percentile-based thresholds, total count label.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 4: Smoke test + verification

**Files:** None (verification only)

- [ ] **Step 1: Syntax check JS**

```bash
node --check app/src/main/assets/nodejs-project/database.js
```

Expected: Pass.

- [ ] **Step 2: Verify JSON size is reasonable**

```bash
node -e "
// Simulate 6 months of daily data
const days = [];
for (let i = 180; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    if (Math.random() > 0.3) { // 70% of days have activity
        days.push({ day: d.toISOString().slice(0, 10), count: Math.floor(Math.random() * 50) + 1 });
    }
}
const json = JSON.stringify({ today: null, month: null, memory: null, dailyActivity: days });
console.log('Daily entries:', days.length);
console.log('Total JSON size:', json.length, 'bytes');
console.log(json.length < 15000 ? 'PASS' : 'FAIL: JSON too large');
"
```

Expected: ~126 entries, under 15KB total JSON.

- [ ] **Step 3: Review Kotlin for obvious issues**

Check `SystemScreen.kt` for:
- Missing imports
- Unclosed brackets
- Type mismatches (DayActivity vs DbSummary fields)

- [ ] **Step 4: Commit if fixes needed**

```bash
git add -A
git commit -m "fix: address smoke test findings

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```
