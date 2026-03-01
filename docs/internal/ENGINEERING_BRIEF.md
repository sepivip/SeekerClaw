# SeekerClaw — Full Engineering Brief

> **Audience:** Software engineer(s) taking over development or onboarding to the project.
> **Date:** 2026-03-01
> **Status:** Production (v1.4.2, live on Solana dApp Store)

---

## 1. Executive Summary

### What SeekerClaw Is

SeekerClaw is a **production Android application** that turns a Solana Seeker phone (or any Android 14+ device) into a **24/7 personal AI agent**. The agent runs as a foreground service on the phone itself — no cloud server required. Users interact with their agent exclusively through Telegram.

### The Core Idea in One Sentence

**An Android app that embeds a Node.js runtime running an AI gateway as a background service, connecting the user's Telegram to Claude's API, with full tool execution, memory, scheduling, web intelligence, and Solana wallet integration — all running locally on the phone.**

### Why This Exists

1. **No server costs** — The phone IS the server. Users bring their own API key (BYOK model).
2. **Privacy** — All data stays on-device. No telemetry, no analytics servers.
3. **Always-on** — Foreground service with watchdog ensures 24/7 uptime.
4. **Solana-native** — First AI agent app on the Solana dApp Store. Direct wallet integration via Mobile Wallet Adapter (MWA).
5. **OpenClaw compatible** — Based on the OpenClaw AI gateway, ported to mobile constraints.

### Current Scale

| Metric | Value |
|--------|-------|
| App version | 1.4.2 (code 8) |
| Total commits | 311 |
| PRs merged | 191 |
| Tools | 56 + dynamic MCP tools |
| Skills | 35 (20 bundled + 13 workspace + 2 user-created) |
| Lines of JavaScript | ~12,600 (main.js + 15 modules) |
| Lines of Kotlin | ~12,500 |
| Distribution | Solana dApp Store (live), Google Play (pending), direct APK |

---

## 2. Architecture Overview

### System Diagram

```
                        ┌─────────────────────────────┐
                        │      EXTERNAL SERVICES       │
                        │                              │
  User ◄──Telegram──►   │  api.telegram.org  (polling) │
                        │  api.anthropic.com (Claude)  │
                        │  api.jup.ag        (Jupiter) │
                        │  api.search.brave.com        │
                        └──────────┬──────────────────┘
                                   │ HTTPS
                                   ▼
┌──────────────────────────────────────────────────────────────┐
│                 ANDROID DEVICE (Solana Seeker)                │
│                                                              │
│  ┌─────────────────────┐    ┌──────────────────────────────┐ │
│  │   UI PROCESS         │    │   :node PROCESS               │ │
│  │   (MainActivity)     │    │   (OpenClawService)           │ │
│  │                      │    │                              │ │
│  │  Jetpack Compose     │    │  ┌────────────────────────┐  │ │
│  │  ┌────────────────┐  │    │  │   Node.js 18 LTS       │  │ │
│  │  │ Dashboard      │  │    │  │   (libnode.so via JNI)  │  │ │
│  │  │ Logs           │  │    │  │                        │  │ │
│  │  │ Settings       │  │    │  │  ┌──────────────────┐  │  │ │
│  │  │ Skills         │  │    │  │  │  AI Agent Core   │  │  │ │
│  │  │ System         │  │    │  │  │  (main.js + 14   │  │  │ │
│  │  │ Setup          │  │    │  │  │   modules)       │  │  │ │
│  │  └────────────────┘  │    │  │  │                  │  │  │ │
│  │                      │    │  │  │  56 Tools        │  │  │ │
│  │  ServiceState ◄──────┼────┤  │  │  SQL.js DB       │  │  │ │
│  │  (cross-process      │    │  │  │  Memory System   │  │  │ │
│  │   file bridge)       │    │  │  │  Cron Scheduler  │  │  │ │
│  │                      │    │  │  │  MCP Client      │  │  │ │
│  │  StatsClient ◄───────┼─┐ │  │  └──────────────────┘  │  │ │
│  │  (HTTP :8766)        │ │ │  │                        │  │ │
│  └─────────────────────┘ │ │  └────────────────────────┘  │ │
│                          │ │                              │ │
│  ┌─────────────────────┐ │ │  ┌────────────────────────┐  │ │
│  │  Boot Receiver      │ │ │  │  Android Bridge        │  │ │
│  │  → auto-start svc   │ │ └──┤  (NanoHTTPD :8765)     │  │ │
│  ├─────────────────────┤ │    │  18 endpoints           │  │ │
│  │  Watchdog           │ │    │  Battery, SMS, GPS,     │  │ │
│  │  30s health check   │ │    │  Camera, Contacts,      │  │ │
│  └─────────────────────┘ │    │  Apps, TTS, Clipboard   │  │ │
│                          │    └────────────────────────┘  │ │
│  ┌─────────────────────┐ │                              │ │
│  │  Solana MWA          │ │    ┌────────────────────────┐  │ │
│  │  Wallet Adapter      │─┼───►│  Stats Server (:8766)  │  │ │
│  │  (sign-only mode)    │ │    │  DB summary endpoint   │  │ │
│  └─────────────────────┘ │    └────────────────────────┘  │ │
│                          │                              │ │
│                          └──────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### Two-Process Architecture

The app runs in **two Android processes**:

| Process | Contains | Why |
|---------|----------|-----|
| **Main** (`:app`) | UI Activity, ServiceState observer, StatsClient, Solana MWA, Watchdog | Standard Android UI process |
| **Node** (`:node`) | OpenClawService, Node.js runtime, Android Bridge, Stats Server | Isolated so Node.js crashes don't kill the UI |

**IPC between processes:**
- **ServiceState** — File-based bridge (SharedPreferences with `MODE_MULTI_PROCESS` + file writes). The `:node` process writes status, uptime, and message count to files; the main process reads them via polling.
- **StatsClient** — HTTP client connecting to `localhost:8766` for rich stats (API usage, memory index status).
- **Watchdog** — The main process sends heartbeat pings via localhost HTTP; Node.js responds with pongs.

### Why Node.js on Android?

The AI agent core (OpenClaw) is a Node.js application. Rather than rewriting ~12,600 lines of JavaScript in Kotlin, we embed Node.js directly using `nodejs-mobile` (community fork). This provides:

- **Full Node.js 18 LTS API** — `fs`, `http`, `crypto`, `path`, `os`, etc.
- **npm ecosystem** — grammy (Telegram), sql.js (SQLite), etc.
- **OpenClaw compatibility** — Direct port with minimal changes from the desktop version.

**How it works technically:**
- `nodejs-mobile` compiles V8 + Node.js as `libnode.so` (shared library, ~30MB for arm64-v8a)
- Loaded via JNI (`System.loadLibrary("node")`) in the `:node` process
- Node.js runs on a separate thread within the service process
- There is **NO standalone `node` binary** — `process.execPath` points to Android's app_process
- All JavaScript execution happens inside this embedded runtime

---

## 3. Tech Stack Deep Dive

### Android Layer (Kotlin)

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Language** | Kotlin | All Android code |
| **UI** | Jetpack Compose + Material 3 | Single-activity, 6 screens |
| **Theme** | `Theme.SeekerClaw` (DarkOps) | Dark-only, navy + crimson + green |
| **Min SDK** | 34 (Android 14) | Required for foreground service `specialUse` |
| **Target SDK** | 35 (Android 15) | Latest platform features |
| **Build** | Gradle Kotlin DSL | Two product flavors (dappStore / googlePlay) |
| **HTTP Server** | NanoHTTPD | Android Bridge (port 8765) |
| **QR Scanning** | CameraX + ML Kit Barcode | Setup flow |
| **Encryption** | Android Keystore (AES-256-GCM) | API keys, bot tokens |
| **Wallet** | Solana MWA SDK + sol4k | Transaction signing |
| **Camera** | CameraX | Photo capture for vision analysis |
| **Analytics** | Firebase (build-optional) | Only in `full` flavor, no-op in `foss` |

### Node.js Layer (JavaScript)

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Runtime** | Node.js 18 LTS (nodejs-mobile) | Embedded via JNI |
| **AI** | Anthropic Claude API (streaming) | Agent intelligence |
| **Messaging** | Telegram Bot API (long polling) | User communication |
| **Database** | SQL.js v1.12.0 (WASM SQLite) | API logs, memory index, stats |
| **Memory** | File-based (SOUL.md, MEMORY.md, daily/) | Agent personality + recall |
| **Scheduling** | Custom cron service | One-shot + recurring jobs |
| **Web** | Brave Search, DuckDuckGo, Perplexity | Search + fetch |
| **MCP** | Custom Streamable HTTP client | Remote tool servers |
| **Security** | Content wrapping, injection detection | Prompt injection defense |

### Module Architecture (Node.js)

The agent JavaScript is split into **14 CommonJS modules** with explicit dependency injection:

```
main.js (orchestrator — entry point, wires everything)
├── config.js      — Config loading, constants, structured logging
├── security.js    — Secret redaction, prompt injection patterns
├── bridge.js      — Android bridge HTTP client helper
├── telegram.js    — Telegram Bot API, HTML formatting, file handling
├── claude.js      — Claude API (streaming), conversation management
├── tools.js       — 56 tool definitions + executeTool() dispatch
├── memory.js      — SOUL.md, MEMORY.md, daily notes, heartbeat
├── skills.js      — Skill file loading, YAML frontmatter, matching
├── cron.js        — Scheduling service (ported from OpenClaw)
├── database.js    — SQL.js init, memory indexing, stats
├── solana.js      — Solana RPC, Jupiter DEX, wallet operations
├── web.js         — HTTP helpers, search providers, web fetch
├── mcp-client.js  — MCP Streamable HTTP client (standalone)
└── task-store.js  — Task persistence
```

**Dependency injection points** (to break circular deps):
1. `setSendMessage(fn)` — cron.js needs telegram's sendMessage
2. `setShutdownDeps(obj)` — database.js needs conversation state for shutdown
3. `setChatDeps(obj)` — claude.js needs tool execution functions
4. `setMcpExecuteTool(fn)` — tools.js needs MCP manager
5. `setRedactFn(fn)` — config.js needs security's redaction function
6. `setDb(fn)` — memory.js needs database getter

---

## 4. Key Subsystems

### 4.1 Foreground Service & Lifecycle

**File:** `OpenClawService.kt`

The service is the core of the app. It:
1. Starts as a foreground service with persistent notification
2. Acquires a partial wake lock (CPU stays on)
3. Optionally acquires full wake lock for "server mode" (screen-on for camera automation)
4. Extracts bundled Node.js assets to internal storage (first launch only)
5. Generates `config.yaml` from encrypted settings
6. Starts the Node.js runtime via JNI
7. Starts the Android Bridge HTTP server (port 8765)
8. Writes platform info (PLATFORM.md) to workspace

**Service flags:**
- `START_STICKY` — Android restarts the service if killed
- `foregroundServiceType="specialUse"` — Required for 24/7 operation on Android 14+
- Runs in separate process (`:node`) for crash isolation

### 4.2 Android Bridge

**Files:** `AndroidBridge.kt` (Kotlin), `bridge.js` (Node.js client)

A local HTTP server (NanoHTTPD on port 8765) that exposes Android-native capabilities to the Node.js agent. All requests are authenticated with a per-boot token.

**18 endpoints:**

| Category | Endpoints | Permissions |
|----------|-----------|-------------|
| Device | `/battery`, `/storage`, `/network`, `/ping` | None |
| Clipboard | `/clipboard/get`, `/clipboard/set` | None |
| Contacts | `/contacts/search`, `/contacts/add` | READ/WRITE_CONTACTS |
| Communication | `/sms`, `/call` | SEND_SMS, CALL_PHONE |
| Location | `/location` | ACCESS_FINE_LOCATION |
| Media | `/tts`, `/camera` | None / CAMERA |
| Apps | `/apps/list`, `/apps/launch` | None |
| Stats | `/stats/message` | None |
| Config | `/config/save-owner` | None |

**Security model:**
- Every request must include `Authorization: Bearer <bridge_token>`
- Token is generated fresh on each service start (UUID)
- Bridge only listens on `localhost` — not accessible from network

### 4.3 Memory System

The agent has a multi-layered memory system:

```
workspace/
├── SOUL.md          — Agent personality (user/agent editable)
├── IDENTITY.md      — Agent identity (created during bootstrap ritual)
├── USER.md          — Owner profile (created during bootstrap)
├── MEMORY.md        — Long-term memory (append-only via memory_save tool)
├── HEARTBEAT.md     — Last heartbeat probe result
├── BOOTSTRAP.md     — First-run trigger (deleted after bootstrap ritual)
├── PLATFORM.md      — Device state (auto-generated each service start)
└── memory/
    └── YYYY-MM-DD.md — Daily memory files (via daily_note tool)
```

**Memory preservation is sacred** — app updates, code changes, and config resets must NEVER delete user memory files. Only explicit "WIPE MEMORY" in Settings or device uninstall destroys memory.

**SQL.js memory index:**
- All memory files are indexed into searchable chunks
- TF + recency ranked keyword search via `memory_search` tool
- Stored in `seekerclaw.db` (WASM-compiled SQLite)

### 4.4 Cron/Scheduling

**File:** `cron.js` (ported from OpenClaw's TypeScript implementation)

Features:
- One-shot reminders ("in 30 minutes", "tomorrow at 9am")
- Recurring jobs ("every 2 hours", "every day at noon")
- Natural language time parsing (no cron expressions needed)
- JSON file persistence with atomic writes + .bak backup
- JSONL execution history per job
- Timer-based delivery (no polling)
- Zombie detection (2-hour threshold)
- HEARTBEAT_OK protocol for cron health

### 4.5 Solana/Jupiter Integration

**Files:** `solana.js` (Node.js), `SolanaWalletManager.kt`, `SolanaTransactionBuilder.kt`, `SolanaAuthActivity.kt` (Kotlin)

The agent can interact with the Solana blockchain via Mobile Wallet Adapter:

**16 Solana tools:**
- Wallet: connect, balance, holdings, transaction history
- Trading: Jupiter Ultra quotes, gasless swaps, limit orders, DCA orders
- Tokens: search, price lookup, security checks
- Transfers: SOL and SPL token sends

**Security layers (all production-tested with real funds):**
1. Two-step confirmation gate (quote → YES/NO prompt → 60s auto-cancel)
2. Balance pre-check blocks insufficient-funds swaps
3. Rate limiting (15s cooldown on swap/send)
4. MWA sign-only mode (no private keys in app memory)
5. ALT-safe swap verification (rejects Address Lookup Table drainer attacks)
6. Trusted program allowlist validation

### 4.6 Watchdog

**File:** `Watchdog.kt`

Monitors Node.js health and auto-restarts on failure:

| Parameter | Value |
|-----------|-------|
| Check interval | 30 seconds |
| Response timeout | 10 seconds per ping |
| Dead declaration | 60 seconds (2 consecutive missed checks) |
| Action on death | Restart Node.js process |

### 4.7 Skills System

**Files:** `skills.js` (Node.js), `ConfigManager.kt` (skill seeding)

Skills are markdown files with YAML frontmatter that extend the agent's capabilities:

```yaml
---
name: weather
description: "Get weather forecasts and current conditions"
version: "1.0.0"
metadata:
  openclaw:
    emoji: "🌤"
    requires:
      bins: []
      env: []
---

# Weather

## Use when
- User asks about weather, forecast, temperature, rain, etc.

## Don't use when
- User is speaking metaphorically about weather

## Instructions
...
```

**Skill loading flow:**
1. `ConfigManager.kt` seeds 20 bundled skills from APK assets on install (SHA-256 integrity, version-aware — won't overwrite user modifications)
2. `skills.js` loads all `.md` files from `workspace/skills/` at startup
3. On each message, `findMatchingSkills()` checks trigger keywords + semantic matching
4. Matched skills are injected into the system prompt for that turn

### 4.8 MCP (Model Context Protocol)

**File:** `mcp-client.js`

Users can add remote MCP servers that provide additional tools via Streamable HTTP transport (JSON-RPC 2.0).

**Security hardening:**
- Tool descriptions sanitized (injection patterns removed)
- SHA-256 hash of tool definitions stored; rug-pull detection on subsequent connections
- Tool results wrapped as untrusted content with `<<<EXTERNAL_UNTRUSTED_CONTENT>>>` markers
- Rate limiting: 10 calls/min per server, 50/min global ceiling

### 4.9 Security Model

**Multi-layer defense:**

| Layer | Protection |
|-------|-----------|
| **API Keys** | AES-256-GCM via Android Keystore (hardware-backed TEE) |
| **Bridge Auth** | Per-boot UUID token, localhost-only |
| **Prompt Injection** | Content Trust Policy, boundary markers, 10-pattern detection, Unicode homoglyph sanitization |
| **File Access** | Workspace sandboxing, path traversal prevention, secrets blocklist (config.json, config.yaml, seekerclaw.db) |
| **Shell Execution** | 33 allowlisted commands only, workspace-restricted |
| **JS Eval** | Blocked modules (child_process, vm, etc.), restricted fs, shadowed process/global |
| **Skill Protection** | Injection pattern detection blocks writes to skills/ directory |
| **Telegram** | Owner gate (unauthorized users get reaction + warning), owner ID validation |
| **Solana** | Confirmation gates on all destructive actions, rate limiting, transaction verification |
| **MCP** | Description sanitization, rug-pull detection, untrusted content wrapping |
| **Logs** | API key redaction before any output |

---

## 5. Build System & Distribution

### Product Flavors

| Flavor | Output | Store | Notes |
|--------|--------|-------|-------|
| `dappStore` | APK | Solana dApp Store + sideload | No Google Play restrictions |
| `googlePlay` | AAB | Google Play Store | Requires `specialUse` justification |

### Build Variants

```
dappStoreDebug      — Development (default)
dappStoreRelease    — Signed APK for dApp Store
googlePlayDebug     — Development
googlePlayRelease   — Signed AAB for Google Play
```

### Build Commands

```bash
# Development
./gradlew assembleDappStoreDebug
adb install -r app/build/outputs/apk/dappStore/debug/app-dappStore-debug.apk

# Release (requires signing keys)
./gradlew assembleDappStoreRelease    # → APK
./gradlew bundleGooglePlayRelease     # → AAB
```

### CI/CD (GitHub Actions)

**`.github/workflows/build.yml`** — Runs on push/PR to main, builds both flavors for validation.

**`.github/workflows/release.yml`** — Triggered by `v*` tags:
1. Build signed dApp Store APK
2. Build signed Google Play AAB
3. Create GitHub Release with both artifacts + changelog

### Signing

Two separate keystores (never committed to repo):
- **dApp Store:** `SEEKERCLAW_*` keys in `local.properties` or environment variables
- **Google Play:** `PLAY_*` keys in `local.properties` or environment variables

The `signingProp()` helper checks `local.properties` first (local dev), then `System.getenv()` (CI).

### Native Dependencies

- `libnode.so` — Downloaded automatically by `DownloadNodejsTask` in `build.gradle.kts` from nodejs-mobile releases
- `libnode_bridge.so` — Built from `app/src/main/cpp/` via CMake (JNI bridge between Kotlin and Node.js)
- `sql-wasm.wasm` — WASM-compiled SQLite, bundled in assets

---

## 6. Data Flow — Message Lifecycle

When a user sends a Telegram message, here's what happens:

```
1. User sends message in Telegram
        │
2. Telegram API delivers via long-polling to Node.js
        │
3. telegram.js: handleMessage()
   ├── Owner gate check (reject unauthorized users)
   ├── Set "thinking" reaction (👀)
   ├── File attachment? → download + vision analysis
   ├── Slash command? → handle directly (/status, /help, etc.)
   └── Pass to Claude
        │
4. claude.js: chat()
   ├── Build system prompt (buildSystemBlocks())
   │   ├── Identity, tooling, safety sections
   │   ├── Matched skills injected
   │   ├── Memory context (SOUL.md, MEMORY.md snippets)
   │   ├── Runtime info (date, platform, uptime)
   │   └── Android bridge capabilities
   ├── Stream request to Claude API
   ├── Parse response (text + tool_use blocks)
   └── For each tool_use:
        │
5. tools.js: executeTool()
   ├── Route to handler (56 built-in + MCP dynamic)
   ├── Execute tool (may call Android Bridge, Solana, web, etc.)
   ├── Return result to Claude
   └── Claude may request more tools (multi-turn loop, max 25 per turn)
        │
6. telegram.js: sendMessage()
   ├── Format response (HTML, no markdown headers)
   ├── Chunk if > 4000 chars
   ├── Set completion reaction (✓ or relevant emoji)
   └── Send via Telegram Bot API
        │
7. Post-processing
   ├── Log API usage to SQL.js (tokens, latency, cache hits)
   ├── Update message count stats
   ├── Check idle timer for auto-session-summary
   └── Report stats to Android Bridge (/stats/message)
```

---

## 7. File System Layout (On Device)

```
/data/data/com.seekerclaw.app/
├── files/
│   ├── nodejs-project/          # Extracted from APK assets (first launch)
│   │   ├── main.js              # Agent entry point
│   │   ├── *.js                 # 14 agent modules
│   │   ├── sql-wasm.js          # SQL.js WASM bundle
│   │   ├── sql-wasm.wasm        # WASM binary
│   │   ├── package.json
│   │   └── node_modules/        # npm dependencies (grammy, etc.)
│   │
│   ├── workspace/               # Agent working directory (PRESERVED across updates)
│   │   ├── config.yaml          # Generated from encrypted settings each start
│   │   ├── SOUL.md              # Agent personality
│   │   ├── IDENTITY.md          # Agent identity (bootstrap ritual)
│   │   ├── USER.md              # Owner profile (bootstrap ritual)
│   │   ├── MEMORY.md            # Long-term memory
│   │   ├── HEARTBEAT.md         # Heartbeat probe
│   │   ├── PLATFORM.md          # Device state (auto-generated)
│   │   ├── memory/              # Daily memory files
│   │   │   └── YYYY-MM-DD.md
│   │   ├── skills/              # Installed skills (20 bundled + user)
│   │   │   ├── weather/SKILL.md
│   │   │   ├── todo/SKILL.md
│   │   │   └── ...
│   │   ├── cron-jobs.json       # Scheduled jobs
│   │   └── debug.log            # Debug log (5MB rotation)
│   │
│   └── seekerclaw.db            # SQL.js database (API logs, memory index)
│
├── shared_prefs/
│   └── seekerclaw_prefs.xml     # Non-sensitive settings
│
└── (no databases/ — SQL.js uses file-based persistence)
```

---

## 8. Configuration

### Encrypted (Android Keystore)

| Field | Example | Storage |
|-------|---------|---------|
| `anthropic_api_key` | `sk-ant-api03-...` | AES-256-GCM |
| `telegram_bot_token` | `123456789:ABCdefGHI...` | AES-256-GCM |

### SharedPreferences (Plaintext)

| Field | Example | Purpose |
|-------|---------|---------|
| `telegram_owner_id` | `987654321` | Owner gate |
| `model` | `claude-sonnet-4-6` | AI model selection |
| `agent_name` | `MyAgent` | Agent display name |
| `auto_start` | `true` | Start on boot |
| `keep_screen_on` | `false` | Server mode |
| `brave_api_key` | `BSA...` | Web search |
| `perplexity_api_key` | `pplx-...` | AI search |
| `jupiter_api_key` | `...` | DEX API |
| `mcp_servers` | JSON array | MCP server configs |

### QR Config Payload

Base64-encoded JSON scanned during setup:

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

### Generated config.yaml

Written to `workspace/config.yaml` on each service start:

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

---

## 9. UI Screens

### Screen Map

```
App Launch
    │
    ▼
 [Setup Complete?]
    │ No                │ Yes
    ▼                   ▼
 SetupScreen         Main App
 (QR / Manual)       ┌─────────────────┐
                     │ Bottom Nav Bar   │
                     │                  │
                     │ Dashboard | Logs │
                     │ Skills | System  │
                     │ Settings         │
                     └─────────────────┘
```

| Screen | Purpose | Key Components |
|--------|---------|----------------|
| **Setup** | First-launch config | QR scanner, manual entry fields, notification permission request |
| **Dashboard** | Agent status at a glance | Status indicator (green/red/yellow with pulse), uptime, message count, active uplinks, mini terminal, API health, error banners, start/stop button |
| **Logs** | Debug output | Monospace auto-scrolling, color-coded by level (white=info, yellow=warn, red=error), filter by level |
| **Skills** | Installed skills browser | Search, skill detail view, marketplace teaser |
| **System** | Technical stats | API usage, memory index status, colored accent borders on stat cards |
| **Settings** | Configuration | Collapsible sections, Anthropic/Telegram config, model dropdown, MCP servers, auto-start toggle, battery optimization, export/import, danger zone (reset/wipe) |

### Theme (DarkOps — Dark Only)

| Token | Hex Value |
|-------|-----------|
| Background | `#0D0D0D` |
| Surface / Card | `#1A1A1A` |
| Card border | `#FFFFFF0F` |
| Primary (green) | `#00C805` |
| Error | `#FF4444` |
| Warning | `#FBBF24` |
| Accent (purple) | `#A78BFA` |
| Text primary | `#FFFFFF` at 87% opacity |
| Text secondary | `#FFFFFF` at 50% opacity |

---

## 10. OpenClaw Compatibility

SeekerClaw is derived from OpenClaw (open-source AI gateway). The relationship:

### What's Ported (1:1)
- System prompt structure (`buildSystemBlocks()` mirrors OpenClaw's `system-prompt.ts`)
- Memory system (SOUL.md, MEMORY.md, daily notes, HEARTBEAT.md)
- Skills system (YAML frontmatter, trigger matching, routing blocks)
- Cron service (full port from TypeScript to JavaScript)
- SILENT_REPLY protocol
- Reply tags (`[[reply_to_current]]`)
- Safety section (exact copy)
- SOUL.md template (exact copy)

### What's Different
- **Language:** TypeScript → JavaScript (CommonJS, no transpilation)
- **SQLite:** `node:sqlite` (Node 22+) → SQL.js (WASM, Node 18 compatible)
- **Vector search:** Not available (requires native bindings)
- **FTS5:** Not yet implemented (SQL.js supports it)
- **Channel:** Telegram only (no Discord, WhatsApp, IRC, etc.)
- **Skills:** No browser, screen, canvas, nodes skills (desktop-only)
- **Additions:** Android Bridge (13 tools), Solana/Jupiter (16 tools), camera, MWA

### Staying in Sync

OpenClaw is actively developed. SeekerClaw tracks upstream changes via `docs/internal/OPENCLAW_TRACKING.md`:

1. Pull OpenClaw reference: `cd openclaw-reference && git pull`
2. Review critical files (system prompt, memory, cron, skills)
3. Port relevant changes to main.js and modules
4. Skip server-only features (sub-agents, Docker, webhooks, multi-channel)

Current OpenClaw reference: **2026.2.28** (652+ commits reviewed)

---

## 11. Known Limitations

| Limitation | Root Cause | Workaround |
|-----------|-----------|------------|
| Node 18 only | nodejs-mobile doesn't support Node 22+ | SQL.js replaces node:sqlite |
| No vector embeddings | Requires native bindings | Keyword search only |
| OEM battery killers | MIUI, OneUI aggressively kill services | Seeker uses stock Android |
| No browser skills | No headless browser on Android | web_fetch for content extraction |
| Ephemeral context | Conversation resets on restart | Auto session summaries on idle/shutdown |
| Single channel | Only Telegram | By design for v1 |
| No light theme | Design decision | DarkOps only |

---

## 12. Development Workflow

### Prerequisites

- Android Studio (latest stable)
- JDK 17
- Android SDK 35 + NDK
- Physical Solana Seeker or Android 14+ device (emulator works for UI but not Node.js)
- Telegram Bot token (from @BotFather)
- Anthropic API key

### First Setup

```bash
git clone <repo>
cd SeekerClaw

# Node.js binary downloads automatically on first build
./gradlew assembleDappStoreDebug

# Install to device (preserves data with -r)
adb install -r app/build/outputs/apk/dappStore/debug/app-dappStore-debug.apk
```

### Key Development Rules

1. **Memory is sacred** — Never delete `workspace/` during updates. Seed files only if they don't exist (`if (!file.exists())`).
2. **Agent self-awareness** — When adding tools or capabilities, update the system prompt in `main.js:buildSystemBlocks()` AND tool descriptions in `tools.js`.
3. **Timer cleanup** — Always track `setTimeout` IDs and clear them. No fire-and-forget timers.
4. **Early return cleanup** — Every early `return` in async handlers must clean up state (reactions, locks).
5. **Defensive JSON** — Guard every field from persisted JSON (NaN, null, wrong type). Use `?? null` for optional tool result fields.
6. **Use `adb install -r`** — The `-r` flag preserves app data (memory, config). Without it, user data is lost.

### Testing on Device

```bash
# Build and install
./gradlew assembleDappStoreDebug && adb install -r app/build/outputs/apk/dappStore/debug/app-dappStore-debug.apk

# View logs
adb logcat -s SeekerClaw:* nodejs-mobile:*

# Access Node.js logs
adb shell cat /data/data/com.seekerclaw.app/files/workspace/debug.log
```

---

## 13. Claude Code Prompt for Engineering

Use this prompt when starting a new Claude Code session for SeekerClaw development:

```
You are working on SeekerClaw, an Android app that turns a Solana Seeker phone
into a 24/7 personal AI agent. The app embeds Node.js 18 via nodejs-mobile and
runs an OpenClaw-compatible AI gateway as a foreground service. Users interact
through Telegram.

CRITICAL RULES:
1. Read CLAUDE.md and PROJECT.md before any work
2. NEVER delete or overwrite workspace/ memory files (SOUL.md, MEMORY.md, IDENTITY.md, USER.md, memory/*)
3. When adding/changing agent capabilities, ALWAYS update:
   - Tool descriptions in tools.js
   - System prompt in main.js:buildSystemBlocks()
4. After shipping any feature, update PROJECT.md (Shipped section + Changelog)
5. UX first — always think from the user's perspective
6. Dark theme only (DarkOps). No light theme.
7. All timer setTimeouts must be tracked and cleaned up
8. Every early return in async handlers must clean up reactions/state
9. Use ?? null for optional fields in tool results (not undefined)
10. Guard persisted JSON fields defensively (type check + isFinite)

ARCHITECTURE:
- Two Android processes: main (UI) and :node (service + Node.js)
- Node.js modules: main.js orchestrator + 14 CommonJS modules
- IPC: File-based ServiceState + localhost HTTP (bridge:8765, stats:8766)
- 56 tools, 35 skills, SQL.js database, cron scheduler
- Solana wallet via MWA (sign-only, no private keys in app)

WHEN MAKING CHANGES:
- Test on physical device (emulator doesn't run Node.js)
- Use adb install -r to preserve user data
- Check OpenClaw tracking doc for upstream compatibility
- Run ./gradlew assembleDappStoreDebug for build validation
```

---

## 14. Glossary

| Term | Definition |
|------|-----------|
| **OpenClaw** | Open-source AI gateway that SeekerClaw is based on |
| **MWA** | Mobile Wallet Adapter — Solana's protocol for dApp-wallet communication |
| **SOUL.md** | Agent personality file (like a system prompt the user can edit) |
| **Bootstrap ritual** | First-run sequence where agent creates IDENTITY.md and USER.md |
| **SILENT_REPLY** | Protocol token — agent returns this to silently drop a message |
| **Bridge** | Local HTTP server (port 8765) exposing Android APIs to Node.js |
| **nodejs-mobile** | Community fork that compiles Node.js as a shared library for Android |
| **SQL.js** | WASM-compiled SQLite — replaces node:sqlite (which needs Node 22+) |
| **DarkOps** | The app's dark theme name (dark navy + crimson + green) |
| **Seeker** | Solana Mobile's second-generation crypto phone |
| **dApp Store** | Solana's alternative app store (no 30% Google tax, no service restrictions) |
| **Skills** | Markdown files with YAML frontmatter that extend agent capabilities |
| **Cron** | Built-in scheduling service for reminders and recurring tasks |
| **MCP** | Model Context Protocol — standard for AI tool servers |
| **BYOK** | Bring Your Own Key — users provide their own Anthropic API key |

---

## 15. Risk Register

| Risk | Severity | Likelihood | Mitigation |
|------|----------|-----------|------------|
| nodejs-mobile fork unmaintained | High | Medium | Maintain own fork, pin to stable Node 18 |
| Android 16+ kills foreground services | High | Low | dApp Store bypasses Google Play policies; fallback to WorkManager + FCM |
| OpenClaw breaking changes | Medium | High | Version tracking doc, review every upstream release |
| API key exposure on compromised device | High | Low | Android Keystore hardware protection, per-boot bridge tokens |
| Thermal throttling on 24/7 operation | Medium | Medium | Bursty workload by design, recommend charger + airflow |
| Solana wallet fund loss | High | Medium | Confirmation gates, balance pre-checks, rate limiting, transaction verification |
| Prompt injection via web content | Medium | Medium | Content wrapping, boundary markers, pattern detection |
| OEM ROM killing service | Medium | High | Target Seeker (stock Android), document workarounds for other devices |

---

*This document is the single engineering reference for SeekerClaw. Keep it updated as the project evolves.*
