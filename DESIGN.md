# Design System: SeekerClaw

## Theme System

SeekerClaw supports **4 swappable themes** that can be changed at runtime from Settings:

| Theme | Style | Best For |
|-------|-------|----------|
| **DarkOps** (default) | Cyberpunk dark navy + crimson red | Modern tactical aesthetic |
| **Pixel** | 8-bit arcade, dot matrix background | Full retro experience |
| **Terminal** | CRT phosphor green | Classic hacker aesthetic |
| **Clean** | Minimal dark with white text | Readability, OpenClaw parity |

### Switching Themes

```kotlin
// In code
ThemeManager.setTheme(SeekerClawThemeStyle.DARKOPS)

// In Settings screen
// Tap DARKOPS, TERMINAL, PIXEL, or CLEAN buttons
```

---

## 1. Visual Themes & Atmosphere

### DarkOps Theme (Default)
Cyberpunk tactical interface with dark navy backgrounds, crimson red accents, and electric green status indicators. Evokes military command centers, cyberpunk HUDs, and covert ops dashboards.

**Key Characteristics:**
- Deep navy backgrounds (`#0D0F14`)
- Crimson red as primary accent (`#FF1744`)
- Electric green for online/active status (`#00E676`)
- 12dp corner radius (modern, smooth)
- Card-based layout with subtle red-tinted borders
- White text hierarchy (87%/50%/25% opacity)
- Status dots (green=online, amber=starting, gray=offline, orange=error)
- "SEEKER//CLAW" branding
- Active Uplinks section with module status rows
- Mini terminal preview on dashboard

### Pixel Theme
Full 8-bit arcade aesthetic with dot matrix halftone background pattern. Evokes Game Boy, early arcade machines, and DOS-era interfaces.

**Key Characteristics:**
- Dot matrix background pattern (green dots on black)
- Perfect 0dp corner radius (pixel-sharp squares)
- ASCII art logo: `╔═══════════════════════╗ ║ S E E K E R C L A W ║ ╚═══════════════════════╝`
- Square step indicators with connecting lines
- Chunky pixel arrow navigation
- Orange accent color for arcade feel

### Terminal Theme
CRT phosphor green terminal aesthetic. Evokes early Unix terminals, Matrix-style displays, and military HUD interfaces.

**Key Characteristics:**
- Deep black with green phosphor tint
- 2dp corner radius (slightly rounded)
- Double-border effects for CRT depth
- No dot matrix (solid backgrounds)
- Red accent color (`#FF2D2D`)

### Clean Theme
Minimal dark theme matching OpenClaw's style. High contrast white-on-black for readability.

**Key Characteristics:**
- Pure dark backgrounds (`#0D0D0D`)
- 8dp corner radius (modern, soft)
- White text at 87%/50% opacity
- Purple accent (`#A78BFA`) — OpenClaw brand
- No special effects

---

## 2. Color Palettes

### DarkOps Theme Colors
```
Background:     #0D0F14 (deep navy)
Surface:        #161A25 (dark card)
Primary:        #FF1744 (crimson red)
Primary Dim:    #CC1236
Primary Glow:   #FF1744 @ 20%
Error:          #FF6B35 (amber-orange)
Accent:         #00E676 (electric green)
Warning:        #FFB300 (gold)
Text Primary:   #FFFFFF @ 87%
Text Secondary: #FFFFFF @ 50%
Text Dim:       #FFFFFF @ 25%
Corner Radius:  12dp
```

### Pixel Theme Colors
```
Background:     #0A0A0A
Surface:        #141414
Primary:        #00FF41 (phosphor green)
Primary Dim:    #00CC33
Primary Glow:   #00FF41 @ 25%
Error:          #FF2020
Accent:         #FF6B00 (arcade orange)
Text Primary:   #00FF41
Text Secondary: #00CC33
Dot Matrix:     #00FF41 @ 7%
Corner Radius:  0dp
```

### Terminal Theme Colors
```
Background:     #050808 (green-tinted black)
Surface:        #0A1210
Primary:        #00FF41
Primary Dim:    #00AA2A
Primary Glow:   #00FF41 @ 20%
Error:          #FF003C
Accent:         #FF2D2D (neon red)
Text Primary:   #00FF41
Text Secondary: #00AA2A
Corner Radius:  2dp
```

### Clean Theme Colors
```
Background:     #0D0D0D
Surface:        #1A1A1A
Primary:        #00C805 (softer green)
Primary Dim:    #00A004
Error:          #FF4444
Accent:         #A78BFA (purple)
Text Primary:   #FFFFFF @ 87%
Text Secondary: #FFFFFF @ 50%
Corner Radius:  8dp
```

---

## 3. Typography

**Font Family:** `FontFamily.Monospace` — universal across all themes and all text.

### Hierarchy
- **Screen Titles:** Bold, 18sp, 2sp letter-spacing
- **Section Labels:** Bold 12sp, 1sp letter-spacing (e.g., "ACTIVE UPLINKS", "TERMINAL")
- **Body Text:** Normal 13-15sp
- **Field Labels:** 10-11sp, uppercase with underscores
- **Button Text:** Bold 13-16sp, bracket-wrapped `[ ACTION ]`
- **Status Badges:** 11sp, bold, in colored pill background

---

## 4. Component Stylings

### Buttons
- **Shape:** `RoundedCornerShape(CornerRadius)` — 12dp DarkOps, 0dp Pixel, 2dp Terminal, 8dp Clean
- **Primary Action (DarkOps):** Solid fill with `containerColor = Primary`, white text
- **Primary Action (others):** Border with PrimaryGlow background, colored text
- **Danger:** Solid fill with Error color, white text
- **Text:** Bracket-wrapped: `[ DEPLOY AGENT ]`, `[ TERMINATE ]`

### Status Card (DarkOps Dashboard)
- Surface background with subtle primary-tinted border (alpha 0.2)
- Status dot (CircleShape, 10dp) + status text
- HorizontalDivider separator
- Uptime display (22sp bold)
- Mini stats row (TODAY, TOTAL, LAST)

### Active Uplinks (DarkOps Dashboard)
- Card with rows separated by dividers
- Each row: icon label (//TG, //GW, //AI) + name/subtitle + status dot
- Status dots: green=running, yellow=starting, gray=stopped, orange=error

### Mini Terminal (DarkOps Dashboard)
- Background-colored box with subtle border
- Shows last 4 log entries with `$` prefix
- Color-coded: green=info, yellow=warn, red=error

### Step Indicator
- Shape adapts to theme corner radius (circles for DarkOps/Clean, squares for Pixel)
- Connecting lines between steps

### Navigation Arrows (Pixel Theme)
- Chunky pixel arrows drawn with Canvas Path
- `PixelArrowLeft` / `PixelArrowRight` composables

### Dot Matrix Background (Pixel Theme Only)
```kotlin
Modifier.dotMatrix(
    dotColor = SeekerClawColors.DotMatrix,
    dotSpacing = 6.dp,
    dotRadius = 1.dp,
)
```

---

## 5. Layout Principles

### Spacing
- **Screen padding:** 16dp
- **Between sections:** 24dp
- **Between elements:** 8-12dp
- **Card padding:** 12-20dp

### Text Patterns
- Branding: `SEEKER//CLAW`
- Section labels: `ACTIVE UPLINKS`, `TERMINAL`, `CONSOLE`, `CONFIG`
- Buttons: `[ ACTION ]`
- Navigation: `HOME`, `CONSOLE`, `CONFIG`
- Status badges: `ONLINE`, `OFFLINE`, `BOOT`, `FAULT` (in colored pills)
- Uplink icons: `//TG`, `//GW`, `//AI`
- Errors: `ERR: message`

---

## 6. File Structure

```
ui/
├── theme/
│   └── Theme.kt              # ThemeManager, ThemeColors, all 4 palettes
├── components/
│   └── PixelComponents.kt    # dotMatrix, PixelArrow*, StepIndicator, etc.
├── setup/
│   └── SetupScreen.kt        # Multi-step wizard
├── dashboard/
│   └── DashboardScreen.kt    # Status card, uplinks, mini terminal
├── logs/
│   └── LogsScreen.kt         # Terminal-style console viewer
├── settings/
│   └── SettingsScreen.kt     # Config, theme selector, danger zone
└── navigation/
    └── NavGraph.kt            # Scaffold + bottom nav
```

---

## 7. Usage Examples

### Check if dot matrix should be used
```kotlin
if (SeekerClawColors.UseDotMatrix) {
    Modifier.dotMatrix(...)
}
```

### Get current corner radius
```kotlin
shape = RoundedCornerShape(SeekerClawColors.CornerRadius)
```

### Theme-aware conditional content
```kotlin
if (SeekerClawColors.UseDotMatrix) {
    AsciiLogoCompact(color = SeekerClawColors.Primary)
} else {
    Text("SEEKER//CLAW", ...)
}
```

### Status color mapping (Dashboard)
```kotlin
val statusColor = when (status) {
    ServiceStatus.RUNNING -> SeekerClawColors.Accent   // Green
    ServiceStatus.STARTING -> SeekerClawColors.Warning  // Yellow
    ServiceStatus.STOPPED -> SeekerClawColors.TextDim   // Gray
    ServiceStatus.ERROR -> SeekerClawColors.Error        // Orange/Red
}
```
