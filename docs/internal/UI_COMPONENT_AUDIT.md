# UI Component Consolidation Audit

**Date:** 2026-03-29
**Purpose:** Track all duplicated UI patterns across screens. Consolidate into shared components over time.

---

## Status Legend

- **DONE** — Shared component exists, all screens migrated
- **IN PROGRESS** — Shared component exists, some screens still using local copy
- **TODO (B1)** — Phase B1: safe, mechanical consolidation (ship first)
- **TODO (B2)** — Phase B2: needs design decisions (ship second)
- **TODO (C)** — Deferred to Phase C (future)

---

## 1. TopAppBar with Back Arrow

**Status:** TODO (B1)

| Screen | File | Approach | Title Style |
|--------|------|----------|-------------|
| System | `ui/system/SystemScreen.kt:119` | M3 TopAppBar | RethinkSans 18sp Bold |
| AI Provider | `ui/settings/ProviderConfigScreen.kt:135` | M3 TopAppBar | RethinkSans 18sp Bold |
| Search Provider | `ui/settings/SearchProviderConfigScreen.kt:82` | M3 TopAppBar | RethinkSans 18sp Bold |
| Telegram Config | `ui/settings/TelegramConfigScreen.kt:77` | M3 TopAppBar | RethinkSans 18sp Bold |
| Skill Detail | `ui/skills/SkillDetailScreen.kt:49` | Custom Row ("← Skills") | Different pattern (Phase C) |

**Target:** `SeekerClawTopAppBar(title, onBack)` in `ui/components/`

---

## 2. SectionLabel / SectionHeader

**Status:** TODO (B1)

| Screen | File | Font | Size | Color | Extras |
|--------|------|------|------|-------|--------|
| System | `SystemScreen.kt:501` | Monospace | 11sp | TextDim | letterSpacing 1sp |
| Settings | `SettingsScreen.kt:1688` | RethinkSans | 11sp | TextSecondary | letterSpacing 1sp |
| Setup | `SetupScreen.kt:1425` | Default | 11sp | TextDim | letterSpacing 1sp |
| Skills | `SkillsScreen.kt:274` | RethinkSans | 13sp Bold | TextDim | 0.5sp, has action button |
| Provider | `ProviderComponents.kt:40` | RethinkSans | 11sp | TextSecondary | letterSpacing 1sp |
| Settings (CollapsibleSection) | `SettingsScreen.kt:1715` | RethinkSans | 11sp | TextDim | Inline duplicate inside CollapsibleSection |

**Target:** `SectionLabel(title, action?)` in `ui/components/` — standardize on RethinkSans 11sp, TextDim, 1sp letterSpacing. Optional trailing action for SkillsScreen use case.

---

## 3. ConfigField + InfoDialog

**Status:** TODO (B1)

### ConfigField

| Location | File | Notes |
|----------|------|-------|
| Provider | `ProviderComponents.kt:52` | `ProviderConfigField` — shared within settings |
| Settings | `SettingsScreen.kt:1744` | `ConfigField` — local to settings |

### InfoDialog (MISSED IN ORIGINAL AUDIT)

| Location | File | Notes |
|----------|------|-------|
| Provider | `ProviderComponents.kt:136` | `ProviderInfoDialog` — AlertDialog with "Got it" |
| Settings | `SettingsScreen.kt:2056` | `InfoDialog` — structurally identical |

**Target:** Unify into `ConfigField` + `InfoDialog` in `ui/components/`. Both pairs are copy-paste identical.

---

## 4. Card Surface Wrapper

**Status:** TODO (B2)

**Pattern:** `Modifier.fillMaxWidth().background(SeekerClawColors.Surface, RoundedCornerShape(CornerRadius)).padding(16.dp)`

**Occurrences:** 31 instances across 10 files:
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

**Warning:** Padding varies across instances (16.dp, horizontal-only, none). Do NOT internalize padding — just enforce shape + surface color. Callers pass their own padding via modifier.

**Target:** `CardSurface(modifier, content)` in `ui/components/`

---

## 5. InfoRow

**Status:** TODO (B2)

| Screen | File | Font | Features |
|--------|------|------|----------|
| System | `SystemScreen.kt:514` | Monospace | dotColor, isLast, divider |
| Settings | `SettingsScreen.kt:1883` | RethinkSans | Simple, no divider |

**Target:** `InfoRow(label, value, dotColor?, isLast?, fontFamily?)` in `ui/components/` — superset of both versions.

---

## 6. SettingRow / Switch Colors

**Status:** TODO (C)

| Location | File | Track Color | Notes |
|----------|------|-------------|-------|
| SettingsScreen | `SettingsScreen.kt:1827` | ActionPrimary | `SettingRow` composable |
| SettingsScreen | `SettingsScreen.kt:836` | ActionPrimary | MCP server toggle (inline) |
| SettingsScreen | `SettingsScreen.kt:1950` | ActionPrimary | `PermissionRow` |
| LogsScreen | `LogsScreen.kt:373` | **Primary** | Auto-scroll toggle |

**Bug:** LogsScreen uses `Primary` (red) while SettingsScreen uses `ActionPrimary` (green). Inconsistent toggle colors.

**Target:** `SettingRow(label, checked, onChange, info?)` in `ui/components/` with standardized Switch colors.

---

## 7. StatCard

**Status:** TODO (C)

| Screen | File | Pattern |
|--------|------|---------|
| Dashboard | `DashboardScreen.kt:786` | `StatMini` — center-aligned, monospace, 13-20sp, no background |
| System | `SystemScreen.kt:616` | `StatCard` — left-aligned, RethinkSans, 26sp, own background |

**Note:** These are structurally too different for a clean shared API. A unified component would be a "god composable" with too many flags. Keep separate unless a clear unifying pattern emerges.

---

## 8. Status Dots

**Status:** TODO (C)

| Location | Size | Pattern |
|----------|------|---------|
| InfoRow (System) | 10dp | CircleShape, optional color |
| DashboardScreen | 8dp | Pulsing animation |
| SkillDetailScreen | 6dp | Trigger indicator |

**Target:** `StatusDot(color, size, pulsing?)` — defer to Phase C.

---

## 9. Progress Bars (ResourceBar / UsageLimitBar)

**Status:** TODO (C)

| Component | File | Notes |
|-----------|------|-------|
| ResourceBar | `SystemScreen.kt:563` | Label + value + LinearProgressIndicator |
| UsageLimitBar | `SystemScreen.kt:677` | Similar with color-coded thresholds |

**Target:** `LabeledProgressBar(label, value, progress, color)` — defer to Phase C.

---

## 10. Scaffold + TopAppBar Pattern

**Status:** TODO (C) — depends on Item 1

Every detail screen uses the same Scaffold wrapper:
```kotlin
Scaffold(
    topBar = { SeekerClawTopAppBar(...) },
    containerColor = SeekerClawColors.Background,
) { innerPadding -> ... }
```

**Target:** `SeekerClawScaffold(title, onBack, content)` — wraps Scaffold + TopAppBar + padding.

---

## 11. HorizontalDivider Color Inconsistency

**Status:** TODO (C)

| Convention | Files |
|-----------|-------|
| `SeekerClawColors.CardBorder` | SetupScreen, NavGraph, SkillDetailScreen |
| `SeekerClawColors.TextDim.copy(alpha = 0.1f)` | ProviderComponents, SettingsScreen, ProviderConfigScreen, SearchProviderConfigScreen |

**Target:** Standardize on one divider color across all screens.

---

## Phase Summary

| Phase | Components | Risk | Status |
|-------|-----------|------|--------|
| **B1 (first)** | TopAppBar, SectionLabel, ConfigField+InfoDialog | Low | TODO |
| **B2 (second)** | CardSurface, InfoRow | Medium | TODO |
| **C (future)** | SettingRow, StatCard, StatusDot, ProgressBar, Scaffold, Divider colors | Low-Med | TODO |

---

## Migration Tracking

When migrating a screen, check off each component it used to define locally:

### Per-Screen Checklist

- [ ] **SystemScreen.kt** — TopAppBar, SectionLabel, CardSurface, InfoRow, StatCard, ResourceBar, UsageLimitBar
- [ ] **SettingsScreen.kt** — SectionLabel, CollapsibleSection, CardSurface, InfoRow, ConfigField, InfoDialog, SettingRow, PermissionRow
- [ ] **DashboardScreen.kt** — CardSurface, StatMini
- [ ] **ProviderConfigScreen.kt** — TopAppBar, CardSurface
- [ ] **SearchProviderConfigScreen.kt** — TopAppBar, CardSurface
- [ ] **TelegramConfigScreen.kt** — TopAppBar, CardSurface
- [ ] **SkillsScreen.kt** — SectionHeader, CardSurface
- [ ] **SkillDetailScreen.kt** — CardSurface (custom back arrow — Phase C)
- [ ] **SetupScreen.kt** — SectionLabel, CardSurface
- [ ] **LogsScreen.kt** — CardSurface, Switch colors
- [ ] **NavGraph.kt** — CardSurface, HorizontalDivider
- [ ] **RestartDialog.kt** — Already consolidated (reference example)
