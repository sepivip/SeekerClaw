# CLAUDE.md — SeekerClaw Project Guide

> **Product spec:** See `MVP.md` | **Build instructions:** See `PROMPT.md` | **Background research:** See `RESEARCH.md`

## Design Principle: UX First

**Always think about user experience.** This is the top priority when building SeekerClaw. Every UI decision, feature implementation, and config flow should be designed from the user's perspective. Ask: "Is this intuitive? Will the user lose data? Is switching between options seamless?" When in doubt, prioritize ease of use over technical elegance.

## What Is This Project

**SeekerClaw** (package: `com.seekerclaw.app`) is an Android app that turns a Solana Seeker phone into a 24/7 personal AI agent. It embeds a Node.js runtime via `nodejs-mobile` and runs the OpenClaw gateway as a foreground service. Users interact with their agent through Telegram — the app itself is minimal (setup, status, logs, settings).

### Supported Devices

- **Primary:** Solana Seeker (Android 14, Snapdragon 6 Gen 1, 8GB RAM)
- **Secondary:** Any Android 14+ with 4GB+ RAM
- **Note:** OEM-modified ROMs (Xiaomi MIUI, Samsung OneUI) may aggressively kill background services — Seeker's stock Android avoids this.

### Development Phases

- **Phase 1 (PoC):** ✅ Mock OpenClaw with a simple Node.js Telegram bot (`grammy`/`telegraf`) that responds to a hardcoded message. Proves Node.js runs on device, Telegram round-trip works.
- **Phase 2 (App Shell):** ✅ Replace mock with real OpenClaw gateway bundle. Full setup flow, all screens, watchdog, boot receiver.
- **Phase 3 (OpenClaw Parity):** ✅ Port OpenClaw core features (memory, skills, cron) to mobile
- **Phase 4 (Android Superpowers):** ✅ Android Bridge, Camera Vision, Solana integration
- **Phase 5 (Polish):** 🔜 Multi-theme support, advanced settings, optimization

## Quick Start (New Developers)

```bash
# 1. Clone and setup
git clone <repo-url>
cd SeekerClaw

# 2. Build (Node.js binaries downloaded automatically)
./gradlew assembleDebug

# 3. Install to device
adb install -r app/build/outputs/apk/debug/app-debug.apk

# 4. View logs
adb logcat | grep SeekerClaw
```

### First Launch Setup
1. Open app on device
2. Allow notification permission
3. Enter config manually:
   - Anthropic API key (from console.anthropic.com)
   - Telegram bot token (from @BotFather)
   - Telegram owner ID (your user ID)
   - Model (default: claude-sonnet-4-20250514)
   - Agent name
4. Service auto-starts after setup
5. Chat with your agent via Telegram

### Key Files to Know
- `MainActivity.kt` — Single activity, Compose navigation
- `OpenClawService.kt` — Foreground service, Node.js lifecycle
- `main.js` — OpenClaw gateway (bundled in assets/)
- `AndroidBridge.kt` — HTTP server for Node.js ↔ Android IPC
- `Theme.kt` — Theme system and colors
- `CLAUDE.md` — You are here

## Tech Stack

- **Language:** Kotlin
- **UI:** Jetpack Compose (Material 3, dark theme only)
- **Theme:** `Theme.SeekerClaw`
- **Min SDK:** 34 (Android 14)
- **Node.js Runtime:** nodejs-mobile community fork (https://github.com/niccolobocook/nodejs-mobile) — pin to latest stable release at dev start (Node 18 LTS, ARM64)
- **QR Scanning:** CameraX + ZXing/ML Kit
- **Encryption:** Android Keystore (AES-256-GCM, `userAuthenticationRequired = false`)
- **Background Service:** Foreground Service with `specialUse` type
- **IPC:** nodejs-mobile JNI bridge + localhost HTTP
- **Database:** SQLite via better-sqlite3 (cross-compiled for ARM64)
- **Build:** Gradle (Kotlin DSL)
- **Distribution:** Solana dApp Store (primary), direct APK sideload (fallback)

## Project Structure

```
seekerclaw/
├── app/
│   ├── src/main/
│   │   ├── java/com/seekerclaw/app/
│   │   │   ├── MainActivity.kt              # Single activity, Compose navigation
│   │   │   ├── SeekerClawApplication.kt     # App class
│   │   │   ├── ui/
│   │   │   │   ├── theme/Theme.kt            # Theme system with ThemeManager
│   │   │   │   ├── navigation/NavGraph.kt    # Setup → Main (Dashboard/Logs/Settings/System)
│   │   │   │   ├── components/PixelComponents.kt  # Reusable UI components
│   │   │   │   ├── setup/SetupScreen.kt      # QR scan + manual entry + notification permission
│   │   │   │   ├── dashboard/DashboardScreen.kt
│   │   │   │   ├── logs/LogsScreen.kt        # Monospace scrollable log viewer
│   │   │   │   ├── settings/SettingsScreen.kt
│   │   │   │   └── system/SystemScreen.kt    # Debug/system info screen
│   │   │   ├── service/
│   │   │   │   ├── OpenClawService.kt        # Foreground Service — starts/manages Node.js
│   │   │   │   ├── NodeBridge.kt             # IPC wrapper for nodejs-mobile
│   │   │   │   └── Watchdog.kt               # Monitors Node.js health, auto-restarts
│   │   │   ├── bridge/
│   │   │   │   └── AndroidBridge.kt          # HTTP server for Node.js ↔ Android IPC (port 8765)
│   │   │   ├── camera/
│   │   │   │   └── CameraCaptureActivity.kt  # Seeker Camera vision capture
│   │   │   ├── solana/
│   │   │   │   ├── SolanaAuthActivity.kt     # Mobile Wallet Adapter integration
│   │   │   │   ├── SolanaTransactionBuilder.kt
│   │   │   │   └── SolanaWalletManager.kt
│   │   │   ├── receiver/
│   │   │   │   └── BootReceiver.kt           # BOOT_COMPLETED → start service
│   │   │   ├── config/
│   │   │   │   ├── ConfigManager.kt          # Read/write config (encrypted + prefs)
│   │   │   │   ├── KeystoreHelper.kt         # Android Keystore encrypt/decrypt
│   │   │   │   ├── Models.kt                 # Model definitions and data classes
│   │   │   │   └── QrParser.kt               # Parse QR JSON payload (TODO)
│   │   │   └── util/
│   │   │       ├── LogCollector.kt           # Captures Node.js stdout/stderr
│   │   │       ├── ServiceState.kt           # Shared state (StateFlow) for UI
│   │   │       └── DeviceInfoProvider.kt     # Device capabilities detection
│   │   ├── assets/
│   │   │   └── nodejs-project/
│   │   │       └── main.js                   # Single bundled OpenClaw gateway file
│   │   ├── cpp/                              # CMake build for nodejs-mobile
│   │   │   └── CMakeLists.txt
│   │   ├── res/
│   │   └── AndroidManifest.xml
│   └── build.gradle.kts
├── build.gradle.kts                          # Root build file
├── settings.gradle.kts
├── CLAUDE.md
├── PROMPT.md
├── MVP.md
├── RESEARCH.md
├── OPENCLAW_TRACKING.md
├── PHASE3.md
└── PHASE4_SUPERPOWERS.md
```

## Architecture

```
┌──────────────────────────────────────────────┐
│          Android App (SeekerClaw)             │
│  ┌─────────────┐    ┌──────────────────────┐ │
│  │  UI Activity │    │  Foreground Service   │ │
│  │  (Compose)   │◄──►│                      │ │
│  │              │ IPC│  ┌──────────────────┐ │ │
│  │ • Dashboard  │    │  │ Node.js Runtime  │ │ │
│  │ • Setup      │    │  │ (nodejs-mobile)  │ │ │
│  │ • Logs       │    │  │ ┌──────────────┐ │ │ │
│  │ • Settings   │    │  │ │  OpenClaw     │ │ │ │
│  └─────────────┘    │  │ │  Gateway      │ │ │ │
│                      │  │ └──────────────┘ │ │ │
│  ┌─────────────┐    │  └──────────────────┘ │ │
│  │ Boot Receiver│────►                       │ │
│  ├─────────────┤    │                        │ │
│  │ Watchdog     │────►  (30s health check)   │ │
│  └─────────────┘    └──────────────────────┘ │
└──────────────────────────────────────────────┘
         │ HTTPS              │ HTTPS
         ▼                    ▼
   api.anthropic.com    api.telegram.org
```

- **Foreground Service** keeps Node.js alive 24/7 with `START_STICKY` and partial wake lock
- **Watchdog** checks heartbeat every 30s, expects pong within 10s, restarts Node.js if unresponsive >60s (2 missed checks)
- **Boot Receiver** auto-starts the service after device reboot (`directBootAware=false` for v1 — starts after first unlock)
- **IPC** uses nodejs-mobile JNI bridge for lifecycle + localhost HTTP for rich API

## Screens (5 total)

1. **Setup** (first launch only) — notification permission request (API 33+), QR scan or manual entry of API key, Telegram bot token, owner ID, model, agent name
2. **Dashboard** (main) — status indicator (green/red/yellow), uptime, start/stop toggle, message stats (all local, no telemetry)
3. **Logs** — monospace auto-scrolling view, color-coded (white=info, yellow=warn, red=error)
4. **Settings** — edit config (masked fields), model dropdown, auto-start toggle, battery optimization, danger zone (reset/clear memory), about
5. **System** (debug) — Device info, capabilities, system diagnostics (accessible via Settings)

**Navigation:** Bottom bar with 3 tabs (Dashboard | Logs | Settings). Setup screen has no bottom bar. System screen accessible from Settings.

## Design Theme (Dark Only)

Theme name: `Theme.SeekerClaw`

| Token | Value |
|-------|-------|
| Background | `#0D0D0D` |
| Surface / Card | `#1A1A1A` |
| Card border | `#FFFFFF0F` |
| Primary (green) | `#00C805` |
| Error | `#FF4444` |
| Warning | `#FBBF24` |
| Accent (purple) | `#A78BFA` |
| Text primary | `#FFFFFF` at 87% opacity |
| Text secondary | `#FFFFFF` at 50% opacity |

## Key Permissions (AndroidManifest)

```xml
FOREGROUND_SERVICE, FOREGROUND_SERVICE_SPECIAL_USE,
RECEIVE_BOOT_COMPLETED, INTERNET, WAKE_LOCK, CAMERA,
REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, POST_NOTIFICATIONS
```

- **`POST_NOTIFICATIONS`:** Required on API 33+. Request at runtime during Setup flow before starting the service.
- **`specialUse` service type:** dApp Store friendly — no justification needed. For Google Play, must provide written justification. Consider `dataSync` as alternative for Play Store (but note 6-hour time limit on Android 14+).

## Model List

Available models for the dropdown:
- `claude-sonnet-4-20250514` — default, balanced (cost/quality)
- `claude-opus-4-5` — smartest, most expensive
- `claude-haiku-3-5` — fast, cheapest

Model list can be updated via app update or future remote config.

## QR Config Payload

Base64-encoded JSON:
```json
{
  "v": 1,
  "anthropic_api_key": "sk-ant-api03-...",
  "telegram_bot_token": "123456789:ABCdefGHI...",
  "telegram_owner_id": "987654321",
  "model": "claude-sonnet-4-20250514",
  "agent_name": "MyAgent"
}
```

Sensitive fields encrypted via Android Keystore (AES-256-GCM). Non-sensitive fields (model, agent_name) in SharedPreferences. QR generation web tool at `seekerclaw.dev/setup` (client-side only, keys never leave the browser).

## OpenClaw Config Generation

On setup completion, generate `config.yaml` in the workspace directory:

```yaml
version: 1
providers:
  anthropic:
    apiKey: "{anthropic_api_key}"
agents:
  main:
    model: "{model}"
    channel: telegram
channels:
  telegram:
    botToken: "{telegram_bot_token}"
    ownerIds:
      - "{telegram_owner_id}"
    polling: true
```

## Workspace Seeding

On first launch, seed the workspace directory with:
- **`SOUL.md`** — a default personality template (basic, friendly agent personality)
- **`MEMORY.md`** — empty file

These are standard OpenClaw workspace files — the agent creates and manages them automatically after first launch.

## Watchdog Timing

- **Check interval:** Every 30 seconds, send heartbeat ping to Node.js
- **Response timeout:** Expect pong within 10 seconds
- **Dead declaration:** After 60 seconds of no response (2 consecutive missed checks), declare Node.js dead and restart
- These values are constants in `Watchdog.kt` — easy to tune later

## Project Status

### ✅ Completed
1. ✅ Project setup (Gradle, dependencies, theme)
2. ✅ Navigation (5 screens with bottom bar)
3. ✅ Setup screen (manual entry + notification permission)
4. ✅ Config encryption (KeystoreHelper + ConfigManager)
5. ✅ Dashboard screen (status UI with real data)
6. ✅ Settings screen (config display/edit)
7. ✅ Foreground Service (OpenClawService)
8. ✅ nodejs-mobile integration (Node.js v18.20.4 running)
9. ✅ **Phase 1:** Mock Telegram bot
10. ✅ **Phase 2:** Real OpenClaw gateway (main.js)
11. ✅ Boot receiver + auto-start
12. ✅ Watchdog + crash recovery (30s check / 10s timeout / 60s dead)
13. ✅ Logs screen (real Node.js output)
14. ✅ Android Bridge (HTTP IPC on port 8765)
15. ✅ Camera Vision (Seeker camera button integration)
16. ✅ Solana MWA (Mobile Wallet Adapter basics)
17. ✅ System screen (debug/diagnostics)
18. ✅ Theme system (ThemeManager with DARKOPS)

### 🔜 TODO
- QR scanning for setup (currently manual entry only)
- Multi-theme UI (Terminal, Pixel, Clean themes)
- Theme persistence (SharedPreferences)
- Advanced Solana features (trading, DeFi)
- Additional Android Bridge endpoints
- Performance optimization
- Release build signing automation

## File System Layout (On Device)

```
/data/data/com.seekerclaw.app/
├── files/
│   ├── nodejs/              # Node.js runtime (bundled in APK)
│   ├── openclaw/            # OpenClaw JS package (bundled, extracted on first launch)
│   ├── workspace/           # OpenClaw working directory (preserved across updates)
│   │   ├── config.yaml
│   │   ├── SOUL.md          # Agent personality (seeded on first launch)
│   │   ├── MEMORY.md        # Long-term memory (empty on first launch)
│   │   ├── memory/          # Daily memory files
│   │   └── HEARTBEAT.md
│   └── logs/                # Rotated logs (10MB max, 7-day retention)
├── databases/seekerclaw.db
└── shared_prefs/seekerclaw_prefs.xml
```

## Mobile-Specific Config

OpenClaw config overrides for mobile environment:
- Heartbeat interval: 5 min (save battery vs desktop default)
- Memory max daily files: 30 (limit disk usage)
- Log max size: 10MB (rotate), 7-day retention
- Max context tokens: 100,000 (limit memory usage)
- Web fetch timeout: 15s (shorter for mobile networks)
- Disabled skills: browser, canvas, nodes, screen

## Memory Preservation (CRITICAL)

> **RULE: App updates and code changes MUST NEVER affect user memory.**

The agent's memory is sacred. These files live in the workspace directory and must survive all updates:

| File | Purpose | MUST Preserve |
|------|---------|---------------|
| `SOUL.md` | Agent personality | YES |
| `IDENTITY.md` | Agent name/nature | YES |
| `USER.md` | Owner info | YES |
| `MEMORY.md` | Long-term memory | YES |
| `memory/*.md` | Daily memory files | YES |
| `HEARTBEAT.md` | Last heartbeat | YES |
| `config.yaml` | Config (regenerated) | Regenerated from encrypted store |
| `skills/*.md` | Custom user skills | YES |

### Rules for Developers

1. **Never delete workspace/** during app updates
2. **Never overwrite** existing SOUL.md, MEMORY.md, IDENTITY.md, USER.md
3. **Seed files only if they don't exist** (`if (!file.exists())`)
4. **BOOTSTRAP.md** is the only file the agent itself deletes (after first-run ritual)
5. **Config.yaml** is regenerated from encrypted storage on each service start — this is fine
6. **Use `adb install -r`** (replace) to preserve app data during development
7. **Export/Import** feature exists in Settings for backup/restore

### What Gets Lost and When

| Action | Memory Lost? |
|--------|-------------|
| App update (store) | NO |
| `adb install -r` | NO |
| Uninstall + reinstall | YES (use export first!) |
| "WIPE MEMORY" in Settings | YES (intentional) |
| "RESET CONFIG" in Settings | Config only, memory preserved |
| Factory reset | YES (use export first!) |

---

## Key Implementation Details

- **nodejs-mobile:** Community fork at https://github.com/niccolobocook/nodejs-mobile — pin to latest stable release at dev start. Adapt their React Native integration guide for pure Kotlin (no React Native).
- **Phase 1 mock:** Create `assets/openclaw/` with `package.json` and `index.js` that starts a Telegram bot (`grammy`/`telegraf`), responds to a hardcoded message from the owner, and sends heartbeat pings back to the Android bridge.
- **Phase 2 real:** Replace mock with actual OpenClaw gateway bundle. Config, workspace, and all features work as documented.
- **Logs:** Capture Node.js stdout/stderr via nodejs-mobile event bridge. Ring buffer of last 1000 lines in memory. Write to `logs/openclaw.log` with rotation at 10MB.
- **Battery:** On first launch after setup, show dialog explaining battery optimization exemption, then call `Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`.
- **ServiceState:** Singleton with `StateFlow<ServiceStatus>` (STOPPED, STARTING, RUNNING, ERROR), uptime, and message count. UI observes these flows.
- **Metrics:** All metrics (message count, uptime, response times) tracked locally on-device only. No analytics servers, no telemetry.

## What NOT to Build (v1) — Status Update

- ~~No Solana/wallet/MWA/Seed Vault integration~~ **✅ IMPLEMENTED:** Basic Solana Mobile Wallet Adapter integration now exists for future features
- No trading/DeFi features (still applies)
- No in-app chat (users use Telegram)
- ~~No light theme~~ **PARTIAL:** Theme system exists but only DARKOPS theme is implemented
- No multi-agent support
- No OTA updates (update via app store)
- No multi-channel (Telegram only)

## Build & Run

### Development Builds
```bash
# Build debug APK
./gradlew assembleDebug

# Install to connected device (preserves data)
adb install -r app/build/outputs/apk/debug/app-debug.apk

# Build and install in one command
./gradlew installDebug
```

### Release Builds
```bash
# Requires local.properties with signing config:
# SEEKERCLAW_KEYSTORE_PATH=/path/to/keystore
# SEEKERCLAW_STORE_PASSWORD=***
# SEEKERCLAW_KEY_ALIAS=***
# SEEKERCLAW_KEY_PASSWORD=***

./gradlew assembleRelease
```

### Clean Build
```bash
./gradlew clean
./gradlew assembleDebug
```

### Testing & Debugging
```bash
# View logs
adb logcat | grep SeekerClaw

# Clear app data (WARNING: Deletes all memory!)
adb shell pm clear com.seekerclaw.app

# List installed packages
adb shell pm list packages | grep seekerclaw
```

## Key Dependencies

From `app/build.gradle.kts`:

```kotlin
// Core Android
implementation(libs.androidx.core.ktx)
implementation(libs.androidx.lifecycle.runtime.compose)
implementation(libs.androidx.activity.compose)
implementation(libs.androidx.compose.material3)
implementation(libs.androidx.navigation.compose)
implementation(libs.kotlinx.serialization.json)

// Node.js IPC Bridge
implementation("org.nanohttpd:nanohttpd:2.3.1")  // AndroidBridge HTTP server

// Solana Mobile
implementation("com.solanamobile:mobile-wallet-adapter-clientlib-ktx:2.0.3")
implementation("org.sol4k:sol4k:0.4.2")          // Pure Kotlin Solana SDK

// CameraX (Seeker Camera vision)
implementation("androidx.camera:camera-core:1.4.1")
implementation("androidx.camera:camera-camera2:1.4.1")
implementation("androidx.camera:camera-lifecycle:1.4.1")
implementation("androidx.camera:camera-view:1.4.1")
```

**Node.js Runtime:** v18.20.4 (nodejs-mobile) — Downloaded automatically during build via `downloadNodejs` Gradle task

## Reference Documents

- `PROMPT.md` — Full coding agent prompt with code snippets, implementation specs, and build priority
- `MVP.md` — Complete MVP specification with features, testing plan, and success metrics
- `RESEARCH.md` — Deep feasibility research on Node.js on Android, background services, Solana Mobile, competitive landscape
- `OPENCLAW_TRACKING.md` — **Critical:** Version tracking, change detection, and update process
- `PHASE3.md` — Phase 3 implementation plan for OpenClaw parity
- `PHASE4_SUPERPOWERS.md` — Android superpowers and API integration via skills

---

## OpenClaw Version Tracking

> **IMPORTANT:** SeekerClaw must stay in sync with OpenClaw updates. See `OPENCLAW_TRACKING.md` for full details.

### Current Versions
- **OpenClaw Reference:** 2026.2.2 (commit 1c4db91)
- **Last Sync Review:** 2026-02-05

### Quick Update Check
```bash
# Check for new OpenClaw versions
cd openclaw-reference && git fetch origin
git log --oneline HEAD..origin/main

# If updates exist, pull and review
git pull origin main
# Then review OPENCLAW_TRACKING.md for what to check
```

### When OpenClaw Updates

1. **Pull the update:** `cd openclaw-reference && git pull`
2. **Check critical files:** See priority list in `OPENCLAW_TRACKING.md`
3. **Compare changes:** `git diff <old>..<new> -- <file>`
4. **Port relevant changes** to `main.js` and skills
5. **Update tracking docs** with new version info

### Files That Require Immediate Review
- `src/agents/system-prompt.ts` — System prompt changes
- `src/memory/` — Memory system changes
- `src/cron/` — Scheduling changes
- `skills/` — New or updated skills

---

## OpenClaw Compatibility

> **Goal:** SeekerClaw should behave as close to OpenClaw as possible.

### Reference Repository

OpenClaw source is cloned at `openclaw-reference/` for direct comparison.

```bash
# Update OpenClaw reference
cd openclaw-reference && git pull
```

### Key OpenClaw Files to Monitor

| OpenClaw File | Purpose | SeekerClaw Equivalent |
|---------------|---------|----------------------|
| `src/agents/system-prompt.ts` | System prompt builder | `main.js:buildSystemPrompt()` |
| `src/agents/skills/workspace.ts` | Skills loading | `main.js:loadSkills()` |
| `src/memory/manager.ts` | Memory management | `main.js` (simplified) |
| `src/cron/types.ts` | Cron/scheduling | `main.js:cronService` (ported) |
| `skills/` | 76 bundled skills | `workspace/skills/` (3 examples) |

### OpenClaw Compatibility Checklist

**System Prompt Sections:**
- [x] Identity line
- [x] Tooling section
- [x] Tool Call Style
- [x] Safety section (exact copy)
- [x] Skills section
- [x] Memory Recall
- [x] Workspace
- [x] Project Context (SOUL.md, MEMORY.md)
- [x] Heartbeats
- [x] Runtime info
- [x] Silent Replies (SILENT_REPLY token)
- [x] Reply Tags ([[reply_to_current]])
- [x] User Identity

**Memory System:**
- [x] MEMORY.md
- [x] Daily memory files (memory/*.md)
- [x] HEARTBEAT.md
- [ ] Vector search (requires Node 22+)
- [ ] FTS search
- [ ] Line citations

**Skills System:**
- [x] SKILL.md loading
- [x] Trigger keywords
- [x] YAML frontmatter format
- [x] Semantic triggering (AI picks skills)
- [ ] Requirements gating (bins, env, config)

**Cron/Scheduling (ported from OpenClaw):**
- [x] cron_create tool (one-shot + recurring)
- [x] cron_list, cron_cancel, cron_status tools
- [x] Natural language time parsing ("in X min", "every X hours", "tomorrow at 9am")
- [x] JSON file persistence with atomic writes + .bak backup
- [x] JSONL execution history per job
- [x] Timer-based delivery (no polling)
- [x] Zombie detection (2hr threshold)
- [x] Recurring intervals ("every" schedule)
- [x] HEARTBEAT_OK protocol

### SKILL.md Format

**OpenClaw Format (target):**
```yaml
---
name: skill-name
description: "What the skill does - AI reads this to decide when to use"
metadata:
  openclaw:
    emoji: "🔧"
    requires:
      bins: ["curl"]
---

# Skill Name

Instructions...
```

**Current SeekerClaw Format:**
```markdown
# Skill Name

Trigger: keyword1, keyword2

## Description
...

## Instructions
...
```

### SOUL.md Template

SeekerClaw uses the **exact same SOUL.md template** as OpenClaw:

```markdown
# SOUL.md - Who You Are

_You're not a chatbot. You're becoming someone._

## Core Truths
- Be genuinely helpful, not performatively helpful
- Have opinions
- Be resourceful before asking
- Earn trust through competence
- Remember you're a guest
...
```

### Node.js Limitations

OpenClaw requires **Node 22+** for `node:sqlite`. SeekerClaw runs on **Node 18** (nodejs-mobile limitation).

**Cannot implement:**
- SQLite-based memory (uses `node:sqlite`)
- Vector embeddings for semantic search
- FTS5 full-text search

**Workarounds:**
- File-based memory (MEMORY.md, daily files)
- Keyword matching for skills
- Full file reads for memory recall

---

## Android Bridge (Phase 4)

SeekerClaw extends OpenClaw with Android-native capabilities via a local HTTP bridge.

### Architecture
```
Node.js (main.js)  ──HTTP POST──►  AndroidBridge.kt (port 8765)  ──►  Android APIs
```

### Available Endpoints

| Endpoint | Purpose | Permission Required |
|----------|---------|---------------------|
| `/battery` | Battery level, charging status | None |
| `/storage` | Storage stats | None |
| `/network` | Network connectivity | None |
| `/clipboard/get` | Read clipboard | None |
| `/clipboard/set` | Write clipboard | None |
| `/contacts/search` | Search contacts | READ_CONTACTS |
| `/contacts/add` | Add contact | WRITE_CONTACTS |
| `/sms` | Send SMS | SEND_SMS |
| `/call` | Make phone call | CALL_PHONE |
| `/location` | Get GPS location | ACCESS_FINE_LOCATION |
| `/tts` | Text-to-speech | None |
| `/apps/list` | List installed apps | None |
| `/apps/launch` | Launch app | None |
| `/stats/message` | Report message for stats | None |
| `/ping` | Health check | None |

### Using from Node.js
```javascript
async function androidBridgeCall(endpoint, data = {}) {
    const http = require('http');
    return new Promise((resolve) => {
        const req = http.request({
            hostname: 'localhost',
            port: 8765,
            path: endpoint,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve(JSON.parse(body)));
        });
        req.write(JSON.stringify(data));
        req.end();
    });
}

// Example: Get battery level
const battery = await androidBridgeCall('/battery');
// Returns: { level: 85, isCharging: true, chargeType: "usb" }
```

---

## Seeker Camera Vision

SeekerClaw leverages the Solana Seeker's dedicated camera button for AI vision capabilities.

### Implementation

**File:** `app/src/main/java/com/seekerclaw/app/camera/CameraCaptureActivity.kt`

- **CameraX** — Camera lifecycle management and capture
- **Hardware Integration** — Responds to Seeker camera button press
- **Bridge Integration** — Sends captured images to Node.js via AndroidBridge
- **Claude Vision** — Images analyzed via Anthropic API in Node.js
- **Telegram Delivery** — Results sent via Telegram with context

### Usage Flow

1. User presses Seeker camera button
2. `CameraCaptureActivity` captures image
3. Image encoded and sent to Node.js via bridge endpoint
4. Agent analyzes image with Claude vision API
5. Response delivered via Telegram chat with full context

### Configuration

Camera vision is integrated into the main agent loop:
- No separate configuration needed
- Automatically available when service is running
- Images stored temporarily and cleaned up after processing
- Privacy-first: images not persisted long-term

See `PHASE4_SUPERPOWERS.md` for full camera integration specification.

---

## Theme System

SeekerClaw implements a theme system via `ThemeManager` singleton with runtime theme switching:

```kotlin
// Current implementation (Theme.kt)
object ThemeManager {
    var currentStyle by mutableStateOf(SeekerClawThemeStyle.DARKOPS)
        private set

    fun setTheme(style: SeekerClawThemeStyle) {
        currentStyle = style
    }
}
```

| Theme | Style | Status |
|-------|-------|--------|
| **DARKOPS** | Default dark theme | ✅ Implemented (current default) |
| **Terminal** | CRT phosphor green | 🔜 Planned |
| **Pixel** | 8-bit arcade | 🔜 Planned |
| **Clean** | OpenClaw style | 🔜 Planned |

**TODO:** Theme selection persistence via SharedPreferences
