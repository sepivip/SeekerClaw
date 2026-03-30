# Shared UI Components — Phase B1 Design Spec

**Date:** 2026-03-29
**Risk:** LOW — pure UI refactor, no data/service changes, zero behavior changes
**Audit:** `docs/internal/UI_COMPONENT_AUDIT.md`

---

## Overview

Extract 4 duplicated UI patterns into shared composables in `ui/components/SharedComponents.kt`. Then migrate all screens to use them, deleting local copies.

## Why one file?

These are small composables (10-30 lines each). A single `SharedComponents.kt` keeps them discoverable without creating a file-per-component explosion. If it grows beyond ~200 lines in Phase B2/C, split then.

## Components

### 1. SeekerClawTopAppBar

```kotlin
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SeekerClawTopAppBar(title: String, onBack: () -> Unit)
```

- M3 `TopAppBar` with `Icons.AutoMirrored.Filled.ArrowBack`
- Title: RethinkSans, 18sp, Bold, TextPrimary
- Back icon tint: TextPrimary
- Container color: Background
- Matches existing pattern in ProviderConfigScreen, TelegramConfigScreen, SearchProviderConfigScreen, SystemScreen

**Consumers (4 screens):**
- SystemScreen.kt — remove TopAppBar block (lines 119-141)
- ProviderConfigScreen.kt — remove TopAppBar block (lines 135-157)
- SearchProviderConfigScreen.kt — remove TopAppBar block (lines 82-103)
- TelegramConfigScreen.kt — remove TopAppBar block (lines 77-98)

### 2. SectionLabel

```kotlin
@Composable
fun SectionLabel(title: String)
```

- Text: RethinkSans, 11sp, Medium weight
- Color: TextDim
- Letter spacing: 1sp
- Uppercase transformation: `.uppercase()`
- Bottom padding: 8dp

**Consumers (5 screens + ProviderComponents):**
- SystemScreen.kt — delete private `SectionLabel` (line 501)
- SettingsScreen.kt — delete private `SectionLabel` (line 1688)
- SetupScreen.kt — delete private `SectionLabel` (line 1425)
- ProviderComponents.kt — delete `ProviderSectionLabel` (line 40)
- SkillsScreen.kt — `SectionHeader` stays (has action button, different style — Phase C)

**Note:** SystemScreen currently uses Monospace font for SectionLabel. Standardizing to RethinkSans is intentional — it was the only outlier.

### 3. ConfigField

```kotlin
@Composable
fun ConfigField(
    label: String,
    value: String,
    masked: Boolean = false,
    onClick: (() -> Unit)? = null,
)
```

- Displays a label + value row, optionally masked (shows "••••••••")
- Clickable if `onClick` provided (shows edit icon)
- Uses RethinkSans, Surface background, standard card styling

**Consumers (2 files):**
- SettingsScreen.kt — delete private `ConfigField` (line 1744)
- ProviderComponents.kt — delete `ProviderConfigField` (line 52), update callers

### 4. InfoDialog

```kotlin
@Composable
fun InfoDialog(
    title: String,
    message: String,
    onDismiss: () -> Unit,
)
```

- AlertDialog with title, message, "Got it" dismiss button
- Container: Surface color
- Text: RethinkSans, TextPrimary/TextDim

**Consumers (2 files):**
- SettingsScreen.kt — delete private `InfoDialog` (line 2056)
- ProviderComponents.kt — delete `ProviderInfoDialog` (line 136), update callers

## File Structure

### New file
| File | Contents |
|------|---------|
| `ui/components/SharedComponents.kt` | SeekerClawTopAppBar, SectionLabel, ConfigField, InfoDialog |

### Modified files (migration)
| File | Changes |
|------|---------|
| SystemScreen.kt | Import + use shared TopAppBar, SectionLabel. Delete local copies. |
| SettingsScreen.kt | Import + use shared SectionLabel, ConfigField, InfoDialog. Delete local copies. |
| ProviderConfigScreen.kt | Import + use shared TopAppBar. Delete local copy. |
| SearchProviderConfigScreen.kt | Import + use shared TopAppBar. Delete local copy. |
| TelegramConfigScreen.kt | Import + use shared TopAppBar. Delete local copy. |
| SetupScreen.kt | Import + use shared SectionLabel. Delete local copy. |
| ProviderComponents.kt | Import + use shared SectionLabel, ConfigField, InfoDialog. Delete ProviderSectionLabel, ProviderConfigField, ProviderInfoDialog. |

## What Does NOT Change

- No Node.js changes
- No service/bridge changes
- No database changes
- No navigation changes
- No config/settings changes
- SkillsScreen `SectionHeader` stays (different pattern — Phase C)
- SkillDetailScreen custom back arrow stays (Phase C)

## Acceptance Criteria

- [ ] `SharedComponents.kt` exists with 4 composables
- [ ] All 7 consumer files migrated to shared components
- [ ] All local copies deleted (no duplicate definitions)
- [ ] `./gradlew compileDappStoreDebugKotlin` passes
- [ ] Visual regression check: every migrated screen looks identical before/after
- [ ] Device test confirms no visual differences
