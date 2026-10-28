# SeekerClaw Architecture Reference

> Moved out of `CLAUDE.md` on 2026-10-28 so that file can stay focused on rules. While moving it, each section was re-checked against the code; where the old text had drifted, this file follows the code. The Node.js agent's own module map is in `app/src/main/assets/nodejs-project/ARCHITECTURE.md`.

## Project Structure

```
seekerclaw/
├── app/
│   ├── build.gradle.kts                    # Version vals, flavors, signing
│   └── src/
│       ├── main/
│       │   ├── AndroidManifest.xml
│       │   ├── java/com/seekerclaw/app/
│       │   │   ├── MainActivity.kt         # Single activity, Compose navigation
│       │   │   ├── SeekerClawApplication.kt
│       │   │   ├── bridge/                 # AndroidBridge (localhost:8765), SMS/call draft notifications, owner claim, burner/ endpoints
│       │   │   ├── camera/                 # CameraCaptureActivity (agent photo capture)
│       │   │   ├── config/                 # ConfigManager, KeystoreHelper, ConfigClaimImporter (QR import), Providers (ModelRegistry), BuildProvenance
│       │   │   ├── data/                   # wallet/ (burner key vault, signer), caps/ (spend caps)
│       │   │   ├── oauth/                  # OpenAI and xAI OAuth activities
│       │   │   ├── qr/                     # QrScannerActivity, ScannerOverlay
│       │   │   ├── receiver/               # BootReceiver (BOOT_COMPLETED → start service)
│       │   │   ├── service/                # SeekerClawService, NodeBridge, Watchdog, StartCoordinator, OAuthKeepAliveService
│       │   │   ├── solana/                 # MWA wallet manager, transaction builder, auth activity
│       │   │   ├── state/                  # Persistent stores: runtime state, agent prefs, MCP servers/tokens, xAI OAuth tokens
│       │   │   ├── ui/                     # components, dashboard, logs, navigation, settings, setup, skills, system, theme
│       │   │   └── util/                   # LogCollector, ServiceState, SafeFs, BundleIntegrity, LogRedactor, Analytics, …
│       │   ├── assets/
│       │   │   ├── nodejs-project/         # The Node.js agent (main.js, ai.js, tools/, providers/, …)
│       │   │   └── default-skills/         # Bundled skills
│       │   ├── cpp/                        # JNI glue for nodejs-mobile (native-lib.cpp)
│       │   └── res/
│       └── test/                           # JVM unit tests
├── tests/                                  # nodejs-project/ (CI), live/ (opt-in provider probes), sab/, payment/, jupiter-ultra/, …
├── scripts/pre-push-check.sh
├── docs/internal/                          # Internal docs (architecture, audits, contracts, plans, tracking)
├── PROJECT.md · CHANGELOG.md · CONTRIBUTING.md · SKILL-FORMAT.md · SECURITY.md
├── build.gradle.kts · settings.gradle.kts
└── CLAUDE.md
```

## Runtime Architecture

```
┌──────────────────────────────────────────────┐
│          Android App (SeekerClaw)             │
│  ┌─────────────┐    ┌──────────────────────┐ │
│  │  UI Activity │    │  Foreground Service   │ │
│  │  (Compose)   │◄──►│                      │ │
│  │              │ IPC│  ┌──────────────────┐ │ │
│  │ • Setup      │    │  │ Node.js Runtime  │ │ │
│  │ • Home       │    │  │ (nodejs-mobile)  │ │ │
│  │ • Logs/Skills│    │  │ ┌──────────────┐ │ │ │
│  │ • Settings   │    │  │ │  Agent        │ │ │ │
│  └─────────────┘    │  │ │  (main.js)    │ │ │ │
│                      │  │ └──────────────┘ │ │ │
│  ┌─────────────┐    │  └──────────────────┘ │ │
│  │ Boot Receiver│────►                       │ │
│  ├─────────────┤    │                        │ │
│  │ Watchdog     │────►  (30s health check)   │ │
│  └─────────────┘    └──────────────────────┘ │
└──────────────────────────────────────────────┘
         │ HTTPS              │ HTTPS
         ▼                    ▼
   AI provider APIs     Telegram / Discord
```

- **Foreground Service** keeps Node.js alive 24/7 with `START_STICKY` and partial wake lock
- **Watchdog** checks that Node.js is alive every 30s (after a 60s start-up grace) and restarts it after 2 consecutive missed checks — see *Watchdog Timing*
- **Boot Receiver** auto-starts the service after device reboot (`directBootAware=false` for v1 — starts after first unlock)
- **IPC** uses nodejs-mobile JNI bridge for lifecycle + localhost HTTP for rich API

## Screens

Navigation lives in `ui/navigation/NavGraph.kt`. The bottom bar has four tabs: **Home | Logs | Skills | Settings**. Setup has no bottom bar.

1. **Setup** (first launch only) — notification permission request, QR scan or manual entry of provider credentials, Telegram bot token, owner ID, model and agent name
2. **Home** (`DashboardRoute`) — status indicator, uptime, start/stop toggle, message stats; links to **System** (`SystemRoute`) for runtime details
3. **Logs** — monospace auto-scrolling view, color-coded by level
4. **Skills** — installed skills, with a detail screen per skill
5. **Settings** — config (masked fields) and config import, auto-start on boot, battery unrestricted, memory and skills export/import, Danger Zone (Reset Config, Wipe Memory), version. Sub-screens: Provider (model picker), Channel, Telegram, Discord, Search provider, MCP servers, Environment variables, Burner wallet

## Theme (Dark Only)

One theme, **DarkOps** (dark navy + crimson red + green status), registered as `Theme.SeekerClaw` (`res/values/themes.xml`). Colors are defined in `ui/theme/Theme.kt` via `DarkOpsThemeColors` and read everywhere through the `SeekerClawColors` object; spacing is in `ui/theme/Dimens.kt`. Main tokens (from `Theme.kt`):

| Token | Value |
|-------|-------|
| Background | `#0A0A0F` |
| Surface / Card | `#16161F` |
| Surface highlight | `#1E1E2E` |
| Card border | `#40374151` |
| Primary (crimson) | `#E41F28` |
| Accent / primary action (green) | `#00C805` |
| Danger action | `#8B0000` |
| Error | `#F87171` |
| Warning | `#FBBF24` |
| Log info | `#60A5FA` |
| Text primary | `#F0FFFFFF` (white at ~94%) |
| Text secondary | `#9CA3AF` |

## Key Permissions (AndroidManifest)

```xml
FOREGROUND_SERVICE, FOREGROUND_SERVICE_SPECIAL_USE,
RECEIVE_BOOT_COMPLETED, INTERNET, ACCESS_NETWORK_STATE, WAKE_LOCK, CAMERA,
REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, POST_NOTIFICATIONS,
ACCESS_FINE_LOCATION, ACCESS_COARSE_LOCATION,
READ_CONTACTS, WRITE_CONTACTS
```

- **`SEND_SMS` / `CALL_PHONE`** are stripped with `tools:node="remove"` (BAT-1409). The agent can only post a draft notification; the user taps it to open their SMS app or dialer.
- **`POST_NOTIFICATIONS`:** Required on API 33+. Requested at runtime during Setup, before the service starts.
- **`specialUse` service type:** dApp Store friendly — no justification needed. Google Play requires written justification for `specialUse`. Consider `dataSync` as alternative for Play Store (but note 6-hour time limit on Android 14+). Can be flavor-gated if needed.

## Android Bridge

SeekerClaw extends the agent with Android-native capabilities via a local HTTP bridge.

```
Node.js (bridge.js)  ──HTTP POST──►  AndroidBridge.kt (127.0.0.1:8765)  ──►  Android APIs
```

Every request carries an `X-Bridge-Token` header; a mismatch returns 403. From Node, always go through `androidBridgeCall(endpoint, data)` in `bridge.js` — it reads the current token, retries once on 403, and is the one caller `net-guard.js` lets connect to the bridge port (BAT-1409). Don't hand-roll an `http.request` to it.

```javascript
const { androidBridgeCall } = require('./bridge');
const battery = await androidBridgeCall('/battery');
// { level: 85, isCharging: true, chargeType: "usb" }
```

### Endpoints (route table in `AndroidBridge.kt`)

| Endpoint | Purpose | Needs |
|----------|---------|-------|
| `/ping` | Health check | — |
| `/battery`, `/storage`, `/network` | Device status | — |
| `/clipboard/get`, `/clipboard/set` | Read / write clipboard | — |
| `/contacts/search`, `/contacts/add` | Search / add contacts | READ_CONTACTS / WRITE_CONTACTS |
| `/sms`, `/call` | Message / call draft: a notification the user taps to open their SMS app or dialer | Notifications |
| `/location` | GPS location | Location permission |
| `/tts` | Text-to-speech | — |
| `/camera/capture` | Take a photo | CAMERA |
| `/apps/list`, `/apps/launch` | List / launch installed apps | — |
| `/stats/message`, `/stats/tokens`, `/stats/db-summary` | Usage stats (`db-summary` proxies to Node) | — |
| `/solana/authorize`, `/solana/address`, `/solana/sign`, `/solana/sign-only`, `/solana/send` | Wallet via Mobile Wallet Adapter; the user approves in the wallet app | Wallet app |
| `/burner/*`, `/jupiter/order-owner/*`, `/config/burner-caps` | Burner wallet, spend caps, Jupiter order ownership (BAT-582) | — |
| `/config/save-owner`, `/config/credentials`, `/config/mcp-token` | Owner claim and credential handoff to Node | Internal |
| `/openai/oauth/save-tokens`, `/xai/oauth/*` | OAuth token persistence and xAI refresh fencing (BAT-1155) | Internal |
| `/service/restart` | Restart the service | Internal |

## MCP Servers (Remote Tools)

Users can add remote MCP (Model Context Protocol) servers in Settings > MCP Servers.
Each server provides additional tools via Streamable HTTP transport (JSON-RPC 2.0).

- Config: `McpServerConfig` in `ConfigManager.kt` (id, name, url, authToken, enabled, rateLimit)
- Client: `app/src/main/assets/nodejs-project/mcp-client.js` (MCPClient + MCPManager)
- Integration: `main.js` merges MCP tools into TOOLS array, routes `mcp__<server>__<tool>` calls
- Security: descriptions sanitized, SHA-256 rug-pull detection, results wrapped as untrusted content
- Rate limiting: 10/min per server (configurable), 50/min global ceiling

## Setup and Config

### QR Config Payload

`ConfigClaimImporter.kt` accepts four QR / link formats:

- raw JSON (text starting with `{`)
- `seekerclaw://config?payload=<base64url JSON>` (also `data` / `p`), or `?json=` / `?config=` with plain JSON
- `seekerclaw://claim?url=…`, or `?base=…&id=…` (optional `sig`, `token`), which fetches the JSON from `<base>/api/mobile/config-claims/<id>`
- an `https://` URL that serves the JSON (plain HTTP only for localhost during development)

The JSON is a versioned envelope. Keys are camelCase; the importer also reads the same keys flat at the top level or inside `config`.

```json
{
  "v": 1,
  "config": {
    "auth": { "type": "api_key", "credential": "sk-ant-api03-..." },
    "telegram": { "botToken": "123456789:ABCdefGHI...", "ownerId": "987654321" },
    "agent": { "model": "claude-opus-5", "name": "MyAgent" },
    "integrations": { "braveApiKey": "" },
    "extensions": {}
  }
}
```

Sensitive fields are encrypted via Android Keystore (AES-256-GCM). Non-sensitive fields (model, agent name) live in SharedPreferences. QR generation web tool at `seekerclaw.xyz/setup` (client-side only, keys never leave the browser).

### Config Generation

On every service start, Kotlin (`ConfigManager.writeConfigJson`, called from `SeekerClawService`) regenerates `workspace/config.json` from the encrypted store, and Node reads it in `config.js`. It is safe to regenerate; nothing user-owned lives in it. Settings the user changes at runtime (for example the heartbeat interval) are also written to `workspace/agent_settings.json`, which Node re-reads without a restart.

### Workspace Seeding

`ConfigManager.seedWorkspace` creates each of these only if it is missing, and never overwrites one (see *Memory Preservation* in `CLAUDE.md`):
- **`SOUL.md`** — default personality template (same template as OpenClaw)
- **`MEMORY.md`** — empty long-term memory
- **`memory/`** — directory for daily memory files
- **`BOOTSTRAP.md`** — the first-run ritual; the agent deletes it when done
- **`IDENTITY.md`**, **`USER.md`** — agent identity and owner profile templates, filled in during the ritual

These are standard OpenClaw workspace files — the agent manages them after first launch.

## File System Layout (On Device)

```
/data/data/com.seekerclaw.app/
├── files/
│   ├── nodejs-project/        # Agent JS bundle, copied from APK assets and verified byte-for-byte on start (BundleIntegrity, BAT-1409)
│   ├── workspace/             # Agent working directory (preserved across updates)
│   │   ├── config.json        # Regenerated from encrypted storage on each service start
│   │   ├── agent_settings.json
│   │   ├── SOUL.md · IDENTITY.md · USER.md · MEMORY.md · HEARTBEAT.md
│   │   ├── BOOTSTRAP.md       # First-run ritual; the agent deletes it when done
│   │   ├── memory/            # Daily memory files
│   │   ├── skills/            # User-installed skills
│   │   ├── cron/jobs.json     # Scheduled jobs
│   │   ├── seekerclaw.db      # SQL.js database (not included in export)
│   │   └── node_debug.log     # Node runtime debug log (LEVEL|epochMs|message; ~5MB continuous rotation → node_debug.log.old)
│   └── service_logs           # Kotlin service-log mirror (300-line in-memory ring + 1MB→512KB file compaction)
└── shared_prefs/seekerclaw_prefs.xml
```

Node.js itself is not on disk as a binary: it is `libnode.so` inside the APK, loaded through JNI (see *Key Implementation Details* in `CLAUDE.md`).

## Watchdog Timing

- **Start-up grace:** 60s (two intervals) before the first check
- **Check interval:** every 30s, `Watchdog` asks `NodeBridge.isAlive()`
- **Dead declaration:** after 2 consecutive missed checks, it restarts Node.js
- Constants `CHECK_INTERVAL_MS` and `DEAD_AFTER_CHECKS` in `service/Watchdog.kt` — easy to tune

## Mobile-Specific Config

Mobile overrides compared with desktop OpenClaw:
- **Heartbeat interval:** 30 min by default, user-adjustable from 5 to 120 min (`getHeartbeatIntervalMs` in `main.js`)
- **Context budget:** `MODEL_CONTEXT_CHARS` = 200,000 characters (BAT-259), with one tool result capped at 30% of it (`config.js`); conversation history trimmed at 35 messages (`MAX_HISTORY` in `ai.js`)
- **HTTP requests:** 30s default timeout (`web.js`)
- **Logs:** `node_debug.log` ~5MB continuous rotation, previous generation kept as `.old` (size-based, no time retention); `service_logs` mirror: 300-line ring + 1MB→512KB compaction

## Jupiter / Solana Integration (Live-tested 2026-02-22)

Full Jupiter DEX integration via MWA (Mobile Wallet Adapter). Tested on Solana Seeker with real funds.

**Capabilities:** wallet connect, balance, quotes, swaps (Jupiter Ultra — gasless), SOL/SPL transfers, token search, price lookup, security checks, holdings

**Safety layers (all verified):**
- Two-step confirmation gate (quote → YES/NO prompt → 60s auto-cancel)
- Balance pre-check blocks insufficient-funds swaps before wallet popup
- Rate limiting (15s cooldown on swap/send)
- MWA sign-only mode (no private keys in app)
- Clean error handling on wallet rejection, timeout, network loss

**Test docs:** `docs/internal/audits/JUPITER-AUDIT.md` (code audit), `docs/internal/audits/JUPITER-TEST-CHECKLIST.md` (29 tests, all must-pass green)

## CI/CD (GitHub Actions)

**`.github/workflows/build.yml`** — runs on push/PR to main: Node tests (tool schemas, bundle smoke, financial-flow and confirmation-gate tests), JVM unit tests, and both flavor debug APKs.

**`.github/workflows/release.yml`** — triggered by `v*` tags, 3 parallel jobs:
1. `build-dappstore` — signed APK (`assembleDappStoreRelease`), renamed to `SeekerClaw-{tag}.apk`
2. `build-googleplay` — signed AAB (`bundleGooglePlayRelease`), renamed to `SeekerClaw-{tag}.aab`
3. `release` — downloads both artifacts, extracts changelog, creates GitHub Release

**GitHub Secrets:**

| Secret | Purpose |
|--------|---------|
| `KEYSTORE_BASE64` | Base64-encoded dApp Store .jks |
| `STORE_PASSWORD` | dApp Store keystore password |
| `KEY_ALIAS` | dApp Store key alias |
| `KEY_PASSWORD` | dApp Store key password |
| `PLAY_KEYSTORE_BASE64` | Base64-encoded Google Play .jks |
| `PLAY_STORE_PASSWORD` | Google Play keystore password |
| `PLAY_KEY_ALIAS` | Google Play key alias |
| `PLAY_KEY_PASSWORD` | Google Play key password |
| `GOOGLE_SERVICES_JSON` | Base64-encoded Firebase config |

**Re-releasing:** To rebuild artifacts for an existing tag, delete and recreate the tag:
```bash
git tag -d v1.x.x && git push origin :refs/tags/v1.x.x
git tag v1.x.x && git push origin v1.x.x
```

**Release Candidate (RC) flow:** Before submitting to dApp Store, always test the signed APK:
1. Tag `v1.x.x-rc1` → triggers release workflow → creates **pre-release** on GitHub
2. Download APK from GitHub Releases, install on Seeker, verify it launches and works
3. If good → tag `v1.x.x` (final release), submit to dApp Store
4. If bad → fix, tag `v1.x.x-rc2`, repeat
