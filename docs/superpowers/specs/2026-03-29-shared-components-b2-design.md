# Shared UI Components — Phase B2 Design Spec

**Date:** 2026-03-29
**Risk:** LOW — pure UI refactor, no data/service changes
**Audit:** `docs/internal/UI_COMPONENT_AUDIT.md`

---

## Overview

Add 2 more shared composables to `ui/components/SharedComponents.kt`: CardSurface and InfoRow.

## Components

### 1. CardSurface

```kotlin
@Composable
fun CardSurface(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
)
```

- Column with `fillMaxWidth()`, `background(SeekerClawColors.Surface, RoundedCornerShape(CornerRadius))`, `padding(16.dp)`
- Caller can override padding/width via `modifier` parameter
- Replaces 31 instances of the same 3-line modifier chain across 10 files

### 2. InfoRow

```kotlin
@Composable
fun InfoRow(
    label: String,
    value: String,
    dotColor: Color? = null,
    isLast: Boolean = false,
)
```

- Label (left) + value (right) row with Monospace font
- Optional colored dot next to value (for status indicators)
- Divider below unless `isLast = true`
- Based on SystemScreen's richer version (superset of SettingsScreen's simple version)

## Consumers

### CardSurface (10 files, 31 instances)
- SystemScreen.kt (7x)
- SettingsScreen.kt (6x)
- DashboardScreen.kt (3x)
- SkillsScreen.kt (4x)
- ProviderConfigScreen.kt (3x)
- SearchProviderConfigScreen.kt (3x)
- TelegramConfigScreen.kt (2x)
- SkillDetailScreen.kt (1x)
- SetupScreen.kt (1x)
- LogsScreen.kt (1x)

### InfoRow (2 files)
- SystemScreen.kt — delete private InfoRow (line 502)
- SettingsScreen.kt — delete private InfoRow (line ~1883)

## What Does NOT Change

- No Node.js changes
- No service/bridge changes
- No navigation changes
- CardSurface callers that use non-standard padding pass it via modifier

## Acceptance Criteria

- [ ] CardSurface and InfoRow added to SharedComponents.kt
- [ ] All 31 CardSurface instances migrated
- [ ] Both InfoRow copies deleted, shared version used
- [ ] `./gradlew compileDappStoreDebugKotlin` passes
- [ ] Device test: all screens look identical
