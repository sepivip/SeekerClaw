# CLAUDE.md — SeekerClaw Quick Reference

> **Background research:** `RESEARCH.md` | **Source of truth:** `PROJECT.md`

## PROJECT.md — Source of Truth

- Read `PROJECT.md` before any feature work
- After shipping any feature: update **Shipped** section + **Changelog**
- After starting any feature: move it to **In Progress**
- Keep **Limitations** section honest — if it doesn't work, list it
- **One-Liner** and **Elevator Pitch** should always reflect current state
- Update **Stats** periodically (tool count, skill count, lines of code)

## Design Principle: UX First

**Always think about user experience.** Every UI decision, feature implementation, and config flow should be designed from the user's perspective. Ask: "Is this intuitive? Will the user lose data? Is switching between options seamless?" When in doubt, prioritize ease of use over technical elegance.

## What Is This Project

**SeekerClaw** (package: `com.seekerclaw.app`) is an Android app that turns a Solana Seeker phone into a 24/7 personal AI agent. It embeds a Node.js runtime via `nodejs-mobile` and runs the OpenClaw gateway as a foreground service. Users interact with their agent through Telegram — the app itself is minimal (setup, status, logs, settings).

- **Primary device:** Solana Seeker (Android 14, Snapdragon 6 Gen 1, 8GB RAM)
- **Secondary:** Any Android 14+ with 4GB+ RAM

## Version Tracking (KEEP UPDATED)

> Update in **one place:** `app/build.gradle.kts` — all UI reads from `BuildConfig`.

| Version | Current | Location |
|---------|---------|----------|
| **App** | `1.4.0` (code 5) | `app/build.gradle.kts` → `versionName` / `versionCode` |
| **OpenClaw** | `2026.2.22` | `app/build.gradle.kts` → `OPENCLAW_VERSION` buildConfigField |
| **Node.js** | `18 LTS` | `app/build.gradle.kts` → `NODEJS_VERSION` buildConfigField |

## Tech Stack

- **Language:** Kotlin | **UI:** Jetpack Compose (Material 3, dark theme only)
- **Min SDK:** 34 (Android 14) | **Node.js Runtime:** nodejs-mobile community fork (Node 18 LTS, ARM64)
- **QR Scanning:** CameraX + ZXing/ML Kit | **Encryption:** Android Keystore (AES-256-GCM)
- **Background Service:** Foreground Service (`specialUse` type) | **IPC:** nodejs-mobile JNI + localhost HTTP
- **Database:** SQL.js (WASM-compiled SQLite) | **Build:** Gradle (Kotlin DSL)
- **Distribution:** Solana dApp Store (primary), direct APK sideload (fallback)

## Project Structure

```
app/src/main/
├── java/com/seekerclaw/app/
│   ├── MainActivity.kt                    # Single activity, Compose navigation
│   ├── SeekerClawApplication.kt
│   ├── ui/
│   │   ├── theme/Theme.kt                 # DarkOps theme, Material 3
│   │   ├── navigation/NavGraph.kt         # 6 routes: Setup, Dashboard, Logs, Settings, System, Skills
│   │   ├── setup/SetupScreen.kt           # QR scan + manual entry + notification permission
│   │   ├── dashboard/DashboardScreen.kt   # Status, uptime, start/stop, stats
│   │   ├── logs/LogsScreen.kt             # Monospace scrollable log viewer
│   │   ├── settings/SettingsScreen.kt     # Config, model, auto-start, danger zone
│   │   ├── system/SystemScreen.kt         # Device info, versions, diagnostics
│   │   └── skills/SkillsScreen.kt         # Skill list, install, diagnostics
│   ├── service/
│   │   ├── OpenClawService.kt             # Foreground Service — starts/manages Node.js
│   │   ├── NodeBridge.kt                  # IPC wrapper for nodejs-mobile
│   │   └── Watchdog.kt                    # 30s health check, auto-restart
│   ├── receiver/BootReceiver.kt           # BOOT_COMPLETED → start service
│   ├── config/
│   │   ├── ConfigManager.kt               # Encrypted + prefs config
│   │   ├── KeystoreHelper.kt              # Android Keystore encrypt/decrypt
│   │   └── QrParser.kt                    # Parse QR JSON payload
│   └── util/
│       ├── LogCollector.kt                # Captures Node.js stdout/stderr
│       └── ServiceState.kt               # Shared state (StateFlow) for UI
├── assets/nodejs-project/                 # Node.js agent (14 modules)
│   ├── main.js          (906)   — orchestrator, polling, startup, heartbeat
│   ├── tools.js         (3,664) — TOOLS array, executeTool(), confirmations
│   ├── claude.js        (1,297) — Claude API, conversations, system prompt
│   ├── solana.js        (823)   — Solana/Jupiter/Helius blockchain tools
│   ├── cron.js          (588)   — cron service, job scheduling
│   ├── telegram.js      (507)   — Telegram bot, formatting, commands
│   ├── mcp-client.js    (594)   — MCP Streamable HTTP client
│   ├── database.js      (457)   — SQL.js, stats server, shutdown
│   ├── skills.js        (458)   — skill loading, parsing, routing
│   ├── web.js           (367)   — web search, fetch, caching
│   ├── config.js        (321)   — config loading, validation
│   ├── memory.js        (321)   — memory load/save, daily notes, search
│   ├── security.js      (173)   — prompt injection defense, content trust
│   └── bridge.js        (64)    — Android bridge HTTP client
└── res/ + AndroidManifest.xml
```

**Navigation:** Bottom bar with 3 tabs (Home/Dashboard | Console/Logs | Settings). Setup screen has no bottom bar.

## Model List

- `claude-opus-4-6` — smartest, most expensive
- `claude-sonnet-4-6` — balanced, recommended
- `claude-sonnet-4-5` — previous gen, still solid
- `claude-haiku-4-5` — fast, cheapest

Defined in `config/Models.kt`. Uses API aliases (auto-resolve to latest snapshot).

## Theme

Single **DarkOps** theme (dark navy + crimson red + green status). Defined in `Theme.kt` via `DarkOpsThemeColors`, accessed globally through `SeekerClawColors` object.

---

## Agent Self-Awareness (NEVER SKIP)

> **RULE: When adding or changing features that affect what the agent can do, you MUST update the agent's system prompt and tool descriptions so the agent knows about its own capabilities.**

The agent only knows what we tell it. If we add a new tool, database table, bridge endpoint, or capability but don't update the system prompt or tool descriptions, the agent will tell users "I can't do that" — even though it can.

| Change | Update Required |
|--------|----------------|
| New tool added to TOOLS array | Tool `description` must explain what it does and what data it accesses |
| New bridge endpoint | Add to `buildSystemBlocks()` Android Bridge section |
| New database table or query | Mention in relevant tool descriptions + `buildSystemBlocks()` Data & Analytics section |
| Changed tool behavior | Update tool `description` to reflect new behavior |
| New system capability | Add to `buildSystemBlocks()` in the appropriate section |

**Where to update:** Tool descriptions in `tools.js` TOOLS array, system prompt in `claude.js` `buildSystemBlocks()`.

## Tool-Use Loop (claude.js)

- `MAX_TOOL_USES = 15` — limits **rounds** per turn, not individual tools
- Each round = 1 Claude API call; Claude can batch multiple tools per round (so 15 rounds ≈ 30-45+ tool executions)
- When exhausted: saves checkpoint → sends "continue or /resume" fallback → returns early
- Per-round checkpoints make it crash-safe at any limit value
- Tool result truncation: ~120KB per result (config.js)
- System prompt references the limit — keep in sync if changed
- Safe to increase further — all safeguards are limit-agnostic

## Memory Preservation (CRITICAL)

> **RULE: App updates and code changes MUST NEVER affect user memory.**

Files in the workspace directory that must survive all updates:

| File | Purpose |
|------|---------|
| `SOUL.md` | Agent personality |
| `IDENTITY.md` | Agent name/nature |
| `USER.md` | Owner info |
| `MEMORY.md` | Long-term memory |
| `memory/*.md` | Daily memory files |
| `HEARTBEAT.md` | Last heartbeat |
| `skills/*.md` | Custom user skills |
| `config.yaml` | Regenerated from encrypted store on each start |

**Rules:** Never delete `workspace/` during updates. Never overwrite existing personality/memory files. Seed files only if they don't exist (`if (!file.exists())`). Use `adb install -r` to preserve app data during dev.

| Action | Memory Lost? |
|--------|-------------|
| App update (store) | NO |
| `adb install -r` | NO |
| Uninstall + reinstall | YES (use export first!) |
| "WIPE MEMORY" in Settings | YES (intentional) |
| "RESET CONFIG" in Settings | Config only, memory preserved |

## Android Bridge Endpoints

Node.js calls Android APIs via HTTP POST to `localhost:8765` (see `bridge.js` + `AndroidBridge.kt`).

| Endpoint | Purpose | Permission |
|----------|---------|------------|
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

## Node.js Limitations

nodejs-mobile runs **Node 18** (OpenClaw requires Node 22+). Key implications:

- **No `node:sqlite`** — uses **SQL.js** (WASM-compiled, v1.12.0) instead
- **No standalone `node` binary** — runs as `libnode.so` via JNI. `process.execPath` points to Android's app_process, not a Node.js binary. `node`/`npm`/`npx` commands cannot be found or executed via shell.
- **No vector embeddings** for semantic search (needs native bindings)
- `shell_exec` uses Android's `/system/bin/sh` (toybox) — completely separate from Node.js process

## OpenClaw Compatibility

> SeekerClaw should behave as close to OpenClaw as possible. See `OPENCLAW_TRACKING.md` for full details.

Reference source is cloned at `openclaw-reference/`. Key file mappings:

| OpenClaw File | SeekerClaw Equivalent |
|---------------|----------------------|
| `src/agents/system-prompt.ts` | `claude.js:buildSystemBlocks()` |
| `src/agents/skills/workspace.ts` | `skills.js:loadSkills()` |
| `src/memory/manager.ts` | `memory.js` |
| `src/cron/types.ts` | `cron.js` |
| `skills/` | `workspace/skills/` |

## MCP Servers (Remote Tools)

Users add remote MCP servers in Settings > MCP Servers. Each provides tools via Streamable HTTP (JSON-RPC 2.0).

- Config: `McpServerConfig` in `ConfigManager.kt`
- Client: `mcp-client.js` (MCPClient + MCPManager)
- Integration: `main.js` merges MCP tools into TOOLS array, routes `mcp__<server>__<tool>` calls
- Security: descriptions sanitized, SHA-256 rug-pull detection, results wrapped as untrusted
- Rate limiting: 10/min per server (configurable), 50/min global ceiling
