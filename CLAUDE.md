# CLAUDE.md — SeekerClaw Project Guide

> **Background research:** See `RESEARCH.md` | **Source of truth:** See `PROJECT.md`

## PROJECT.md — Source of Truth

- Read `PROJECT.md` before any feature work
- After shipping any feature: update **Shipped** section + **Changelog**
- After starting any feature: move it to **In Progress**
- Keep **Limitations** section honest — if it doesn't work, list it
- **One-Liner** and **Elevator Pitch** should always reflect current state
- Update **Stats** periodically (tool count, skill count, lines of code)

## Design Principle: UX First

**Always think about user experience.** This is the top priority when building SeekerClaw. Every UI decision, feature implementation, and config flow should be designed from the user's perspective. Ask: "Is this intuitive? Will the user lose data? Is switching between options seamless?" When in doubt, prioritize ease of use over technical elegance.

## What Is This Project

**SeekerClaw** (package: `com.seekerclaw.app`) is an Android app that turns a Solana Seeker phone into a 24/7 personal AI agent. It embeds a Node.js runtime via `nodejs-mobile` and runs the OpenClaw gateway as a foreground service. Users interact with their agent through Telegram — the app itself is minimal (setup, status, logs, settings).

### Supported Devices

- **Primary:** Solana Seeker (Android 14, Snapdragon 6 Gen 1, 8GB RAM)
- **Secondary:** Any Android 14+ with 4GB+ RAM
- **Note:** OEM-modified ROMs (Xiaomi MIUI, Samsung OneUI) may aggressively kill background services — Seeker's stock Android avoids this.

### Development Phases

- **Phase 1 (PoC):** Mock OpenClaw with a simple Node.js Telegram bot (`grammy`/`telegraf`) that responds to a hardcoded message. Proves Node.js runs on device, Telegram round-trip works.
- **Phase 2 (App Shell):** Replace mock with real OpenClaw gateway bundle. Full setup flow, all screens, watchdog, boot receiver.

## Version Tracking (KEEP UPDATED)

> **When updating OpenClaw or nodejs-mobile, update these version strings in ONE place:**
> **`app/build.gradle.kts`** → `buildConfigField` for `OPENCLAW_VERSION` and `NODEJS_VERSION`
>
> The app version (`versionName` / `versionCode`) is also in `app/build.gradle.kts`.
> All UI screens read versions from `BuildConfig` — no hardcoded strings in Kotlin code.

| Version | Current | Location |
|---------|---------|----------|
| **App** | `1.4.0` (code 5) | `app/build.gradle.kts` → `versionName` / `versionCode` |
| **OpenClaw** | `2026.2.22` | `app/build.gradle.kts` → `OPENCLAW_VERSION` buildConfigField |
| **Node.js** | `18 LTS` | `app/build.gradle.kts` → `NODEJS_VERSION` buildConfigField |

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
- **Database:** SQL.js (WASM-compiled SQLite) — no native bindings needed
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

**Navigation:** Bottom bar with 4 tabs (Home | Console | Skills | Settings). Setup screen has no bottom bar.

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

Available models for the dropdown (using API aliases — auto-resolve to latest snapshot):
- `claude-opus-4-6` — smartest, most expensive (Opus 4.6)
- `claude-sonnet-4-6` — balanced, recommended (Sonnet 4.6)
- `claude-sonnet-4-5` — previous gen, still solid (Sonnet 4.5)
- `claude-haiku-4-5` — fast, cheapest (Haiku 4.5)

Defined in `app/src/main/java/com/seekerclaw/app/config/Models.kt`.

Model list can be updated via app update or future remote config.

## MCP Servers (Remote Tools)

Users can add remote MCP (Model Context Protocol) servers in Settings > MCP Servers.
Each server provides additional tools via Streamable HTTP transport (JSON-RPC 2.0).

- Config: `McpServerConfig` in `ConfigManager.kt` (id, name, url, authToken, enabled, rateLimit)
- Client: `app/src/main/assets/nodejs-project/mcp-client.js` (MCPClient + MCPManager)
- Integration: `main.js` merges MCP tools into TOOLS array, routes `mcp__<server>__<tool>` calls
- Security: descriptions sanitized, SHA-256 rug-pull detection, results wrapped as untrusted content
- Rate limiting: 10/min per server (configurable), 50/min global ceiling

## QR Config Payload

Base64-encoded JSON:
```json
{
  "v": 1,
  "anthropic_api_key": "sk-ant-api03-...",
  "telegram_bot_token": "123456789:ABCdefGHI...",
  "telegram_owner_id": "987654321",
  "model": "claude-sonnet-4-5",
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

## Agent Self-Awareness (NEVER SKIP)

> **RULE: When adding or changing features that affect what the agent can do, you MUST update the agent's system prompt and tool descriptions so the agent knows about its own capabilities.**

The agent only knows what we tell it. If we add a new tool, database table, bridge endpoint, or capability but don't update the system prompt or tool descriptions, the agent will tell users "I can't do that" — even though it can.

### What to Update

| Change | Update Required |
|--------|----------------|
| New tool added to TOOLS array | Tool `description` must explain what it does and what data it accesses |
| New bridge endpoint | Add to `buildSystemBlocks()` Android Bridge section |
| New database table or query | Mention in relevant tool descriptions + `buildSystemBlocks()` Data & Analytics section |
| Changed tool behavior | Update tool `description` to reflect new behavior |
| New system capability | Add to `buildSystemBlocks()` in the appropriate section |

### Where to Update (in `main.js`)

1. **Tool descriptions** — `TOOLS` array (each tool has a `description` field). Be specific: say "SQL.js database" not "search files", say "API usage analytics" not "stats".
2. **System prompt** — `buildSystemBlocks()` function. Sections include: Identity, Tooling, Skills, Memory Recall, Data & Analytics, Android Bridge, Runtime info, etc.

### Example

Bad: Adding `memory_search` tool with description "Search memory files"
Good: Adding `memory_search` tool with description "Search your SQL.js database (seekerclaw.db) for memory content. All memory files are indexed into searchable chunks — this performs ranked keyword search with recency weighting, returning top matches with file paths and line numbers."

---

## Key Implementation Details

- **nodejs-mobile:** Community fork at https://github.com/niccolobocook/nodejs-mobile — pin to latest stable release at dev start. Adapt their React Native integration guide for pure Kotlin (no React Native).
- **nodejs-mobile JNI architecture (IMPORTANT):** Node.js runs as `libnode.so` loaded via `System.loadLibrary("node")` through JNI — there is **NO standalone `node` binary** on the device. Key implications:
  - `process.execPath` typically points to Android's app process launcher (e.g., `/system/bin/app_process` or `/system/bin/app_process64`), **not** a Node.js binary path
  - `process.env.PATH` primarily contains Android system directories (e.g., `/system/bin`, `/vendor/bin`)
  - `node`, `npm`, `npx` commands **cannot** be found or executed via `shell_exec` / `child_process`
  - `shell_exec` uses Android's `/system/bin/sh` (toybox) — completely separate from the Node.js process
  - To run JavaScript code, tools must use `eval()`/`require()` inside the existing Node.js process (see BAT-59: `js_eval` tool)
  - All existing tools (read, write, web_fetch, etc.) already work within the Node.js process — they don't shell out
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

- `RESEARCH.md` — Deep feasibility research on Node.js on Android, background services, Solana Mobile, competitive landscape
- `OPENCLAW_TRACKING.md` — **Critical:** Version tracking, change detection, and update process

---

## OpenClaw Version Tracking

> **IMPORTANT:** SeekerClaw must stay in sync with OpenClaw updates. See `OPENCLAW_TRACKING.md` for full details.

### Current Versions
- **OpenClaw Reference:** 2026.2.22
- **Last Sync Review:** 2026-02-22

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
| `src/agents/system-prompt.ts` | System prompt builder | `main.js:buildSystemBlocks()` |
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

**Solved:**
- SQLite — uses **SQL.js** (WASM-compiled SQLite, v1.12.0) instead of `node:sqlite`. Bundled as `sql-wasm.js` + `sql-wasm.wasm` in assets. Currently used for API request logging (`api_request_log` table); future: conversation storage, FTS5 memory search.

**Cannot implement (yet):**
- Vector embeddings for semantic search (needs native bindings)

**Current workarounds:**
- File-based memory (MEMORY.md, daily files) — future: migrate to SQL.js
- Keyword matching for skills
- Full file reads for memory recall — future: FTS5 via SQL.js

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

## Theme

SeekerClaw uses a single **DarkOps** theme (dark navy + crimson red + green status). Colors are defined in `Theme.kt` via `DarkOpsThemeColors` and accessed globally through the `SeekerClawColors` object.
