# Design System: SeekerClaw

## 1. Visual Theme & Atmosphere

SeekerClaw's visual identity channels **8-bit retrofuturism** — a CRT terminal that hums with phosphor green on near-black void. The aesthetic evokes early command-line interfaces, military HUD displays, and the raw energy of hacker culture. Every screen feels like staring into a glowing terminal in a dark room.

The mood is **utilitarian, dense, and electric**. There is no softness — corners are sharp, text is monospaced, and every element is clad in hard borders. The UI feels like a control panel for something powerful and slightly dangerous.

**Key Characteristics:**
- Deep black backgrounds with faint green phosphor tint
- Monospace typography everywhere — no exceptions
- Sharp, near-zero border radius (2-4dp) for that pixel-perfect 8-bit feel
- Bracket-wrapped labels: `[ DEPLOY AGENT ]`, `> SETTINGS`, `--- DANGER ZONE ---`
- Terminal prompt prefixes: `>`, `<`, `//`, `---`
- Double-border and inner-glow effects for retro depth
- Color-coded status: green = good, red = bad, amber = caution

## 2. Color Palette & Roles

### Void Black Foundation
- **Deep Terminal Black** (`#050808`) — Primary background. Near-pure black with the barest green cast, like a powered-off CRT still holding charge.
- **Phosphor Surface** (`#0A1210`) — Card/surface background. Slightly lifted from the void with a green-tinted darkness.
- **Highlight Surface** (`#0F1A16`) — Elevated surfaces, dropdown menus, modal backgrounds.

### Phosphor Green (Primary)
- **Phosphor Bright** (`#00FF41`) — Primary color. Text, active states, running indicators. The signature "Matrix green."
- **Phosphor Dim** (`#00AA2A`) — Secondary text, borders, inactive but visible elements.
- **Phosphor Glow** (`#00FF41` at 20% opacity) — Button fills, status box backgrounds, ambient glow effect.
- **Phosphor Dark** (`#006618`) — Tertiary text, very dim labels, structural hints.

### CRT Red (Error / Danger)
- **Hot Red** (`#FF003C`) — Error states, danger zone buttons, fault indicators.
- **Dim Red** (`#AA0028`) — Error borders, muted danger accents.
- **Red Glow** (`#FF003C` at 20% opacity) — Danger button backgrounds, error message containers.

### Signal Colors
- **CRT Amber** (`#FFB000`) — Warning states (STARTING/BOOT status).
- **Neon Red** (`#FF2D2D`) — Secondary accent for navigation links, "enter manually" prompts. Adds warmth against the green.

### Scanline Hint
- **Scanline** (`#00FF41` at 3% opacity) — Subtle overlay effect for depth.

## 3. Typography Rules

**Font Family:** `FontFamily.Monospace` (system monospace) — used universally across all text in the app. No sans-serif, no serif, no variable fonts.

### Hierarchy & Weights
- **Screen Titles:** Bold, 18-22sp, 2-3sp letter-spacing, uppercase. Prefixed with `>` prompt character.
- **Dividers:** `================================` or `////////////////////////////` in PrimaryDim.
- **Section Headers:** Bold 12sp, 1sp letter-spacing, wrapped in `--- TITLE ---`, colored Accent red.
- **Body/Labels:** Normal 13-15sp for readable content. Green primary or dim green for secondary.
- **Field Labels:** 10-11sp, uppercase with underscores (`ANTHROPIC_API_KEY`), dim green.
- **Button Text:** Bold 13-16sp, 1-2sp letter-spacing, wrapped in brackets `[ ACTION ]`.
- **Log Entries:** 11sp, tight 16sp line-height for dense terminal output.

### Text Color Hierarchy
1. **Phosphor Bright** (`#00FF41`) — Primary text, values, active content
2. **Phosphor Dim** (`#00AA2A`) — Secondary text, timestamps, supporting info
3. **Phosphor Dark** (`#006618`) — Tertiary labels, hints, structural text

## 4. Component Stylings

### Buttons
- **Shape:** `RoundedCornerShape(2.dp)` — nearly squared, pixel-sharp
- **Primary CTA:** Phosphor Glow background + 1dp Phosphor Bright border. Green text.
- **Danger CTA:** Red Glow background + 1dp Dim Red border. Hot Red text.
- **Disabled:** Surface background, Phosphor Dark text, Dark border.
- **All text:** Monospace, bold, letter-spaced, bracket-wrapped: `[ INITIALIZE AGENT ]`

### Cards / Containers
- **Corner Radius:** 2dp (config fields, stat cards) to 4dp (status display, dialogs)
- **Background:** Phosphor Surface (`#0A1210`)
- **Border:** 1dp Phosphor Dim at 20-40% opacity
- **Shadow Strategy:** None. Depth conveyed through border hierarchy and color glow, not shadows.
- **Double-border effect:** Status display uses outer 2dp border + inner 1dp drawn border for retro CRT depth.

### Inputs / Forms
- **Shape:** `RoundedCornerShape(2.dp)`
- **Border:** Phosphor Dim at 40% unfocused, Phosphor Bright on focus
- **Background:** Phosphor Surface
- **Label:** Monospace 11sp, uppercase with underscores
- **Cursor:** Phosphor Bright green
- **Text:** Phosphor Bright green (the terminal never shows white text)

### Navigation Bar
- **Container:** Phosphor Surface with 1dp PrimaryDim top border
- **Labels:** Bracket-wrapped abbreviations: `[SYS]`, `[LOG]`, `[CFG]`
- **Selected:** Phosphor Bright icon + text, Phosphor Glow indicator
- **Unselected:** Phosphor Dark icon + text
- **Zero tonal elevation** — flat terminal look

### Dialogs
- **Shape:** `RoundedCornerShape(4.dp)`
- **Background:** Phosphor Surface
- **Title:** Monospace bold, Hot Red, exclamation-wrapped: `!! RESET CONFIG !!`
- **Body:** Monospace 12sp, uppercase, Phosphor Dim, tight line-height
- **Confirm:** `[ CONFIRM ]` in Hot Red
- **Dismiss:** `[ ABORT ]` in Phosphor Dark

### Status Indicator (Dashboard)
- **Shape:** 140dp square box with 4dp corners (not a circle — squares are more 8-bit)
- **Double border:** 2dp outer in status color, 1dp inner at 30% opacity
- **Background:** Status color at 8% opacity
- **Text:** Status word in 22sp bold + animated chevrons `>>>>>>>` or dashes `- - - -`

## 5. Layout Principles

### Spacing
- **Screen padding:** 24dp on all sides
- **Between sections:** 24-32dp
- **Between related elements:** 8-12dp
- **Internal card padding:** 12dp

### Text Patterns (Terminal Language)
- Screen headers: `> TITLE` with `===` divider below
- Section headers: `--- TITLE ---`
- Buttons: `[ ACTION ]`
- Navigation: `[SYS]` `[LOG]` `[CFG]`
- Back links: `< BACK` or `< back to scanner_`
- Status messages: `SYSTEM NOMINAL`, `AWAITING OUTPUT...`
- Error prefixes: `ERR: message`
- Log prefixes: ` ` (info), `!` (warn), `X` (error)
- Uptime format: `00:00:00` (digital clock)
- Empty values: `---` (not em-dash)

### Visual Weight
- Green dominates: headers, values, active UI, running status
- Red appears sparingly: only for errors, danger zone, stop/terminate actions
- Amber is rare: only the STARTING/BOOT transitional state
- The Accent red (`#FF2D2D`) appears as a navigation hint color, adding variety to the green monotone
