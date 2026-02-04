# CLAUDE.md — SeekerClaw Project Guide

> **Product spec:** See `MVP.md` | **Build instructions:** See `PROMPT.md` | **Background research:** See `RESEARCH.md`

## What Is This Project

**SeekerClaw** (package: `com.seekerclaw.app`) is an Android app that turns a Solana Seeker phone into a 24/7 personal AI agent. It embeds a Node.js runtime via `nodejs-mobile` and runs the OpenClaw gateway as a foreground service. Users interact with their agent through Telegram — the app itself is minimal (setup, status, logs, settings).

### Supported Devices

- **Primary:** Solana Seeker (Android 14, Snapdragon 6 Gen 1, 8GB RAM)
- **Secondary:** Any Android 14+ with 4GB+ RAM
- **Note:** OEM-modified ROMs (Xiaomi MIUI, Samsung OneUI) may aggressively kill background services — Seeker's stock Android avoids this.

### Development Phases

- **Phase 1 (PoC):** Mock OpenClaw with a simple Node.js Telegram bot (`grammy`/`telegraf`) that responds to a hardcoded message. Proves Node.js runs on device, Telegram round-trip works.
- **Phase 2 (App Shell):** Replace mock with real OpenClaw gateway bundle. Full setup flow, all screens, watchdog, boot receiver.

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
│   │   │   │   ├── theme/Theme.kt            # Dark theme (Theme.SeekerClaw), Material 3
│   │   │   │   ├── navigation/NavGraph.kt    # Setup → Main (Dashboard/Logs/Settings)
│   │   │   │   ├── setup/SetupScreen.kt      # QR scan + manual entry + notification permission
│   │   │   │   ├── dashboard/DashboardScreen.kt
│   │   │   │   ├── logs/LogsScreen.kt        # Monospace scrollable log viewer
│   │   │   │   └── settings/SettingsScreen.kt
│   │   │   ├── service/
│   │   │   │   ├── OpenClawService.kt        # Foreground Service — starts/manages Node.js
│   │   │   │   ├── NodeBridge.kt             # IPC wrapper for nodejs-mobile
│   │   │   │   └── Watchdog.kt               # Monitors Node.js health, auto-restarts
│   │   │   ├── receiver/
│   │   │   │   └── BootReceiver.kt           # BOOT_COMPLETED → start service
│   │   │   ├── config/
│   │   │   │   ├── ConfigManager.kt          # Read/write config (encrypted + prefs)
│   │   │   │   ├── KeystoreHelper.kt         # Android Keystore encrypt/decrypt
│   │   │   │   └── QrParser.kt               # Parse QR JSON payload
│   │   │   └── util/
│   │   │       ├── LogCollector.kt           # Captures Node.js stdout/stderr
│   │   │       └── ServiceState.kt           # Shared state (StateFlow) for UI
│   │   ├── assets/openclaw/                  # Bundled OpenClaw JS (extracted on first launch)
│   │   ├── res/
│   │   └── AndroidManifest.xml
│   └── build.gradle.kts
├── build.gradle.kts                          # Root build file
├── settings.gradle.kts
├── CLAUDE.md
├── PROMPT.md
├── MVP.md
└── RESEARCH.md
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

## Screens (4 total)

1. **Setup** (first launch only) — notification permission request (API 33+), QR scan or manual entry of API key, Telegram bot token, owner ID, model, agent name
2. **Dashboard** (main) — status indicator (green/red/yellow), uptime, start/stop toggle, message stats (all local, no telemetry)
3. **Logs** — monospace auto-scrolling view, color-coded (white=info, yellow=warn, red=error)
4. **Settings** — edit config (masked fields), model dropdown, auto-start toggle, battery optimization, danger zone (reset/clear memory), about

**Navigation:** Bottom bar with 3 tabs (Dashboard | Logs | Settings). Setup screen has no bottom bar.

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

## Build Priority Order

1. Project setup (Gradle, dependencies, theme)
2. Navigation (4 screens with bottom bar)
3. Setup screen (QR scan + manual entry + notification permission request)
4. Config encryption (KeystoreHelper + ConfigManager)
5. Dashboard screen (status UI with mock data)
6. Settings screen (config display/edit)
7. Foreground Service (basic, without Node.js first)
8. nodejs-mobile integration (get Node.js running)
9. **Phase 1 mock:** Simple Node.js Telegram bot responding to hardcoded message
10. **Phase 2:** Replace mock with real OpenClaw gateway bundle
11. Boot receiver + auto-start
12. Watchdog + crash recovery (30s check / 10s timeout / 60s dead)
13. Logs screen (connect to real Node.js output)
14. Polish & testing

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

## Key Implementation Details

- **nodejs-mobile:** Community fork at https://github.com/niccolobocook/nodejs-mobile — pin to latest stable release at dev start. Adapt their React Native integration guide for pure Kotlin (no React Native).
- **Phase 1 mock:** Create `assets/openclaw/` with `package.json` and `index.js` that starts a Telegram bot (`grammy`/`telegraf`), responds to a hardcoded message from the owner, and sends heartbeat pings back to the Android bridge.
- **Phase 2 real:** Replace mock with actual OpenClaw gateway bundle. Config, workspace, and all features work as documented.
- **Logs:** Capture Node.js stdout/stderr via nodejs-mobile event bridge. Ring buffer of last 1000 lines in memory. Write to `logs/openclaw.log` with rotation at 10MB.
- **Battery:** On first launch after setup, show dialog explaining battery optimization exemption, then call `Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`.
- **ServiceState:** Singleton with `StateFlow<ServiceStatus>` (STOPPED, STARTING, RUNNING, ERROR), uptime, and message count. UI observes these flows.
- **Metrics:** All metrics (message count, uptime, response times) tracked locally on-device only. No analytics servers, no telemetry.

## What NOT to Build (v1)

- No Solana/wallet/MWA/Seed Vault integration
- No trading/DeFi features
- No in-app chat (users use Telegram)
- No light theme
- No multi-agent support
- No OTA updates (update via app store)
- No multi-channel (Telegram only)

## Build & Run

```bash
./gradlew assembleDebug
adb install app/build/outputs/apk/debug/app-debug.apk
```

## Reference Documents

- `PROMPT.md` — Full coding agent prompt with code snippets, implementation specs, and build priority
- `MVP.md` — Complete MVP specification with features, testing plan, and success metrics
- `RESEARCH.md` — Deep feasibility research on Node.js on Android, background services, Solana Mobile, competitive landscape
- `OPENCLAW_MAPPING.md` — **Critical:** Feature mapping between OpenClaw and SeekerClaw
- `PHASE3.md` — **Current:** Phase 3 implementation plan for OpenClaw parity

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
| `src/cron/types.ts` | Cron/reminders | Not implemented yet |
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

**Cron/Scheduling:**
- [x] Reminder tools (set/list/cancel)
- [x] Natural language time parsing
- [x] Periodic reminder delivery (30s)
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
