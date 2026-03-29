# UI Component Consolidation Audit

**Date:** 2026-03-29
**Purpose:** Track all duplicated UI patterns across screens. Consolidate into shared components over time.

---

## Status Legend

- **DONE** — Shared component exists, all screens migrated
- **IN PROGRESS** — Shared component exists, some screens still using local copy
- **TODO (B)** — Included in current consolidation scope (Phase B)
- **TODO (C)** — Deferred to Phase C (future)

---

## 1. TopAppBar with Back Arrow

**Status:** TODO (B)

| Screen | File | Approach | Title Style |
|--------|------|----------|-------------|
| System | `ui/system/SystemScreen.kt:119` | M3 TopAppBar | RethinkSans 18sp Bold |
| AI Provider | `ui/settings/ProviderConfigScreen.kt:135` | M3 TopAppBar | RethinkSans 18sp Bold |
| Search Provider | `ui/settings/SearchProviderConfigScreen.kt:82` | M3 TopAppBar | RethinkSans 18sp Bold |
| Telegram Config | `ui/settings/TelegramConfigScreen.kt:77` | M3 TopAppBar | RethinkSans 18sp Bold |
| Skill Detail | `ui/skills/SkillDetailScreen.kt:49` | Custom Row ("← Skills") | Different pattern |

**Target:** `SeekerClawTopAppBar(title, onBack)` in `ui/components/`

---

## 2. SectionLabel / SectionHeader

**Status:** TODO (B)

| Screen | File | Font | Size | Color | Extras |
|--------|------|------|------|-------|--------|
| System | `SystemScreen.kt:501` | Monospace | 11sp | TextDim | letterSpacing 1sp |
| Settings | `SettingsScreen.kt:1688` | RethinkSans | 11sp | TextSecondary | letterSpacing 1sp |
| Setup | `SetupScreen.kt:1425` | Default | 11sp | TextDim | letterSpacing 1sp |
| Skills | `SkillsScreen.kt:274` | RethinkSans | 13sp Bold | TextDim | 0.5sp, has action button |
| Provider | `ProviderComponents.kt:40` | RethinkSans | 11sp | TextSecondary | letterSpacing 1sp |

**Target:** `SectionLabel(title, action?)` in `ui/components/` — standardize on RethinkSans 11sp, TextDim, 1sp letterSpacing. Optional trailing action.

---

## 3. Card Surface Wrapper

**Status:** TODO (B)

**Pattern:** `Modifier.fillMaxWidth().background(SeekerClawColors.Surface, RoundedCornerShape(CornerRadius)).padding(16.dp)`

**Occurrences:** 20+ instances across 10 files:
- DashboardScreen.kt (4x)
- SystemScreen.kt (7x)
- SettingsScreen.kt (4x)
- SkillsScreen.kt (2x)
- SkillDetailScreen.kt (1x)
- ProviderConfigScreen.kt (1x)
- SearchProviderConfigScreen.kt (1x)
- TelegramConfigScreen.kt (1x)
- SetupScreen.kt (1x)
- LogsScreen.kt (1x)

**Target:** `CardSurface(modifier, content)` in `ui/components/`

---

## 4. InfoRow

**Status:** TODO (B)

| Screen | File | Font | Features |
|--------|------|------|----------|
| System | `SystemScreen.kt:514` | Monospace | dotColor, isLast, divider |
| Settings | `SettingsScreen.kt:1883` | RethinkSans | Simple, no divider |

**Target:** `InfoRow(label, value, dotColor?, isLast?, fontFamily?)` in `ui/components/` — superset of both versions.

---

## 5. ConfigField / EditDialog

**Status:** TODO (B)

| Location | File | Notes |
|----------|------|-------|
| Provider | `ProviderComponents.kt:52` | `ProviderConfigField` — shared within settings |
| Settings | `SettingsScreen.kt:1744` | `ConfigField` — local to settings |

**Target:** Unify into `ConfigField` in `ui/components/` or extend `ProviderComponents` for all config screens.

---

## 6. StatCard

**Status:** TODO (B)

| Screen | File | Pattern |
|--------|------|---------|
| Dashboard | `DashboardScreen.kt:786` | `StatMini` — label, value, unit |
| System | `SystemScreen.kt:616` | `StatCard` — label, value, unit |

**Target:** `StatCard(label, value, unit, modifier)` in `ui/components/`

---

## 7. Status Dots

**Status:** TODO (C)

| Location | Size | Pattern |
|----------|------|---------|
| InfoRow (System) | 10dp | CircleShape, optional color |
| DashboardScreen | 8dp | Pulsing animation |
| SkillDetailScreen | 6dp | Trigger indicator |

**Target:** `StatusDot(color, size, pulsing?)` — defer to Phase C.

---

## 8. Progress Bars (ResourceBar / UsageLimitBar)

**Status:** TODO (C)

| Component | File | Notes |
|-----------|------|-------|
| ResourceBar | `SystemScreen.kt:563` | Label + value + LinearProgressIndicator |
| UsageLimitBar | `SystemScreen.kt:677` | Similar with color-coded thresholds |

**Target:** `LabeledProgressBar(label, value, progress, color)` — defer to Phase C.

---

## 9. Scaffold + TopAppBar Pattern

**Status:** TODO (C)

Every detail screen uses the same Scaffold wrapper:
```kotlin
Scaffold(
    topBar = { SeekerClawTopAppBar(...) },
    containerColor = SeekerClawColors.Background,
) { innerPadding -> ... }
```

**Target:** `SeekerClawScaffold(title, onBack, content)` — wraps Scaffold + TopAppBar + padding. Defer to Phase C (depends on TopAppBar being shared first).

---

## Phase Summary

| Phase | Components | Status |
|-------|-----------|--------|
| **B (current)** | TopAppBar, SectionLabel, CardSurface, InfoRow, ConfigField, StatCard | TODO |
| **C (future)** | StatusDot, LabeledProgressBar, SeekerClawScaffold | TODO |

---

## Migration Tracking

When migrating a screen, check off each component it used to define locally:

### Per-Screen Checklist

- [ ] **SystemScreen.kt** — TopAppBar, SectionLabel, CardSurface, InfoRow, StatCard, ResourceBar, UsageLimitBar
- [ ] **SettingsScreen.kt** — SectionLabel, CardSurface, InfoRow, ConfigField
- [ ] **DashboardScreen.kt** — CardSurface, StatMini
- [ ] **ProviderConfigScreen.kt** — TopAppBar, CardSurface
- [ ] **SearchProviderConfigScreen.kt** — TopAppBar, CardSurface
- [ ] **TelegramConfigScreen.kt** — TopAppBar, CardSurface
- [ ] **SkillsScreen.kt** — SectionHeader, CardSurface
- [ ] **SkillDetailScreen.kt** — CardSurface (custom back arrow — Phase C)
- [ ] **SetupScreen.kt** — SectionLabel, CardSurface
- [ ] **LogsScreen.kt** — CardSurface
