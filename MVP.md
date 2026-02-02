# SeekerClaw â€" MVP Specification

> **Build instructions:** See `PROMPT.md` | **Background research:** See `RESEARCH.md`

**Version:** 1.0
**Date:** February 2, 2026
**Author:** Beka Kazhiashvili
**Status:** Draft

---

## 1. Product Vision

**SeekerClaw** is an Android app that turns a Solana Seeker phone into a 24/7 personal AI agent by running the OpenClaw gateway as a background service.

### The Problem

Running an always-on AI agent today requires a server, a VPS, or a desktop machine that never sleeps. Most people don't have â€" or don't want to manage â€" any of those. But everyone has a phone. A phone that's plugged in on a nightstand is a perfectly capable always-on computer, yet no one treats it that way.

### Why Solana Seeker First

| Reason | Detail |
|--------|--------|
| **dApp Store** | No Google Play 30% tax, no background service restrictions, no "specialUse" justifications needed |
| **Stock Android** | No OEM bloatware (Xiaomi/Samsung kill services aggressively) â€" foreground services just work |
| **Hardware** | Snapdragon 6 Gen 1, 8GB RAM, 128GB storage â€" more than enough for Node.js |
| **Audience** | 140,000+ Seeker holders are crypto-native, tech-forward early adopters who get "always-on agent" |
| **Blue ocean** | No AI agent apps in the dApp Store yet â€" first-mover advantage |

### Supported Devices

- **Primary:** Solana Seeker (Android 14, Snapdragon 6 Gen 1, 8GB RAM)
- **Secondary:** Any Android 14+ with 4GB+ RAM
- **Note:** OEM-modified ROMs (Xiaomi MIUI, Samsung OneUI) may aggressively kill background services â€" Seeker's stock Android avoids this.

### Scope Boundaries

| In Scope (v1) | Explicitly Out of Scope (v2+) |
|----------------|-------------------------------|
| Vanilla OpenClaw gateway | Solana wallet integration |
| Telegram channel | DeFi / trading features |
| QR code setup | MWA / Seed Vault integration |
| Background service | Multi-channel (Signal, Discord) |
| Memory, cron, web search | OTA OpenClaw updates |

---

## 2. MVP Feature List

### User Flow
```
Install app → Scan QR code → OpenClaw starts → Chat via Telegram
```
That's it. The entire v1 experience.

### Screens (4 total)

1. **Welcome / Setup** â€" QR scan or manual config entry + notification permission
2. **Dashboard** â€" status, uptime, start/stop, activity stats
3. **Logs** â€" scrollable log output
4. **Settings** â€" edit config, reset, about

### Feature Priority

| Feature | Priority | Notes |
|---------|----------|-------|
| Foreground service running OpenClaw | **Must Have** | Core product |
| QR code config scanning | **Must Have** | Primary setup flow |
| Start / Stop / Restart controls | **Must Have** | Basic control |
| Persistent notification with status | **Must Have** | Android requires this for foreground services |
| Auto-start on boot | **Must Have** | "Set and forget" promise |
| Battery optimization exclusion request | **Must Have** | Prevents Android from killing service |
| Encrypted API key storage (Android Keystore) | **Must Have** | Security baseline |
| Status dashboard (running/stopped, uptime) | **Must Have** | User confidence |
| Log viewer | **Must Have** | Debugging, transparency |
| Watchdog with auto-restart on crash | **Must Have** | Reliability |
| Manual config entry (fallback for QR) | **Must Have** | Accessibility |
| Notification permission request (API 33+) | **Must Have** | Required for foreground service |
| Message count / activity stats | Nice to Have | Dashboard enhancement |
| Memory usage display | Nice to Have | Dashboard enhancement |
| Export logs to file | Nice to Have | Support/debugging |
| Dark/light theme | Cut | Ship one theme (dark) |
| Multi-agent support | Cut | v2 |
| In-app Telegram chat preview | Cut | Use Telegram app |
| OTA OpenClaw updates | Cut | Update via app update |

---

## 3. QR Code Config Flow

### QR Payload

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

**Size:** ~400-500 bytes → fits in a Version 10 QR code (capacity: 652 alphanumeric chars). Base64-encoded JSON.

### Model List

Available models:
- `claude-sonnet-4-20250514` â€" default, balanced (cost/quality)
- `claude-opus-4-5` â€" smartest, most expensive
- `claude-haiku-3-5` â€" fast, cheapest

Model list can be updated via app update or future remote config.

### QR Generation

| Method | Description |
|--------|-------------|
| **Web tool** (primary) | Static HTML page hosted on GitHub Pages. User pastes their keys, QR is generated client-side (no server). Keys never leave the browser. |
| **Manual entry** (fallback) | In-app form with fields for each config value. For users who can't scan or prefer typing. |

### On-Device Security

1. QR is scanned → JSON parsed in memory
2. Sensitive fields (`anthropic_api_key`, `telegram_bot_token`) encrypted using **Android Keystore** (hardware-backed AES-256-GCM)
3. Encrypted blobs stored in app's private directory (`/data/data/com.seekerclaw.app/`)
4. Non-sensitive fields (`agent_name`, `model`) stored as plaintext in SharedPreferences
5. On device lock, Android's File-Based Encryption (FBE) adds another layer
6. App uninstall destroys Keystore keys → all secrets are irrecoverable

**Key design decision:** `userAuthenticationRequired = false` on the Keystore key â€" the background service must decrypt keys without user interaction. The tradeoff is that any code running as our app UID can decrypt. This is acceptable because the app's private storage is already sandboxed.

---

## 4. Technical Architecture

### High-Level Diagram

```
â"Œâ"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"
â"'          Android App (SeekerClaw)             â"'
â"'                                               â"'
â"'  â"Œâ"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"    â"Œâ"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â" â"'
â"'  â"'  UI Activity â"'    â"'  Foreground Service   â"' â"'
â"'  â"'  (Compose)   â"'â-"â"€â"€â-ºâ"'                      â"' â"'
â"'  â"'              â"' IPCâ"'  â"Œâ"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â" â"' â"'
â"'  â"' • Dashboard  â"'    â"'  â"' Node.js Runtime  â"' â"' â"'
â"'  â"' • Setup      â"'    â"'  â"' (nodejs-mobile)  â"' â"' â"'
â"'  â"' • Logs       â"'    â"'  â"'                  â"' â"' â"'
â"'  â"' • Settings   â"'    â"'  â"' â"Œâ"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â" â"' â"' â"'
â"'  â""â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"˜    â"'  â"' â"'  OpenClaw     â"' â"' â"' â"'
â"'                      â"'  â"' â"'  Gateway      â"' â"' â"' â"'
â"'  â"Œâ"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"    â"'  â"' â"'  â"€â"€â"€â"€â"€â"€â"€â"€â"€    â"' â"' â"' â"'
â"'  â"' Boot         â"'    â"'  â"' â"' • Telegram   â"' â"' â"' â"'
â"'  â"' Receiver     â"'â"€â"€â"€â"€â-º  â"' â"' • Claude API â"' â"' â"' â"'
â"'  â""â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"˜    â"'  â"' â"' • Memory     â"' â"' â"' â"'
â"'                      â"'  â"' â"' • Cron       â"' â"' â"' â"'
â"'  â"Œâ"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"    â"'  â"' â"' • Web Search â"' â"' â"' â"'
â"'  â"' Watchdog     â"'â"€â"€â"€â"€â-º  â"' â""â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"˜ â"' â"' â"'
â"'  â"' (30s check)  â"'    â"'  â""â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"˜ â"' â"'
â"'  â""â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"˜    â""â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"˜ â"'
â""â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"˜
         â"'                      â"'
         â"' Outbound HTTPS only  â"'
         â-¼                      â-¼
   api.anthropic.com    api.telegram.org
```

### App Structure

- **Package:** `com.seekerclaw.app`
- **Language:** Kotlin with Jetpack Compose for UI
- **Theme:** `Theme.SeekerClaw` (dark only)
- **Node.js runtime:** nodejs-mobile community fork (Node 18 LTS for android-arm64)
- **Min SDK:** Android 14 (API 34) â€" Seeker ships with Android 14
- **Target SDK:** Android 14 (API 34)

See `PROMPT.md` for full project structure, code snippets, and implementation details.

### Watchdog / Heartbeat Timing

- **Check interval:** Every 30 seconds, Kotlin sends heartbeat ping to Node.js
- **Response timeout:** Expects pong within 10 seconds
- **Dead declaration:** After 60 seconds of no response (2 consecutive missed checks), declares Node.js dead → auto-restart

### File System Layout

```
/data/data/com.seekerclaw.app/
â"œâ"€â"€ files/
â"'   â"œâ"€â"€ nodejs/                    # Node.js runtime (bundled in APK)
â"'   â"'   â""â"€â"€ libnodejs.so
â"'   â"œâ"€â"€ openclaw/                  # OpenClaw package (bundled in APK)
â"'   â"'   â"œâ"€â"€ node_modules/
â"'   â"'   â"œâ"€â"€ package.json
â"'   â"'   â"œâ"€â"€ index.js
â"'   â"'   â""â"€â"€ ...
â"'   â"œâ"€â"€ workspace/                 # OpenClaw working directory
â"'   â"'   â"œâ"€â"€ config.yaml            # Generated from QR config
â"'   â"'   â"œâ"€â"€ SOUL.md                # Agent personality (default seeded on first launch)
â"'   â"'   â"œâ"€â"€ MEMORY.md              # Long-term memory (empty on first launch)
â"'   â"'   â"œâ"€â"€ memory/                # Daily memory files
â"'   â"'   â"'   â""â"€â"€ 2026-02-02.md
â"'   â"'   â""â"€â"€ HEARTBEAT.md
â"'   â""â"€â"€ logs/                      # Rotated log files
â"'       â"œâ"€â"€ openclaw.log           # Current
â"'       â""â"€â"€ openclaw.log.1         # Previous
â"œâ"€â"€ databases/
â"'   â""â"€â"€ seekerclaw.db              # SQLite (if used)
â""â"€â"€ shared_prefs/
    â""â"€â"€ seekerclaw_prefs.xml       # Non-sensitive settings
```

### OpenClaw Installation & Updates

- OpenClaw JavaScript code is **bundled inside the APK** in `assets/openclaw/`
- On first launch, extracted to `files/openclaw/`
- **Updates:** New OpenClaw version = new app version. No OTA in v1.
- On app update, the `files/openclaw/` directory is replaced with the new bundle
- `files/workspace/` is **preserved** across updates (memory, config, personality)

### Network Requirements

| Endpoint | Protocol | Direction | Purpose |
|----------|----------|-----------|---------|
| `api.anthropic.com` | HTTPS | Outbound | Claude API calls |
| `api.telegram.org` | HTTPS | Outbound | Telegram Bot API (long polling) |
| `api.openai.com` | HTTPS | Outbound | Optional: OpenAI models |
| `api.search.brave.com` | HTTPS | Outbound | Web search skill |

**Outbound HTTPS only.** No inbound connections. No ports to open. No firewall config. Works on any Wi-Fi or cellular connection.

---

## 5. UI/UX Spec

Design philosophy: **"Set it and forget it."** The app exists to get OpenClaw running. Once it's running, the user never opens the app again â€" they interact with their agent via Telegram.

### Screen 1: Welcome / Setup

**Purpose:** First-run configuration

**Layout:**
- SeekerClaw logo + "Turn your Seeker into an AI agent" tagline
- **Notification permission:** On API 33+, request `POST_NOTIFICATIONS` before proceeding
- Large "Scan QR Code" button (opens camera)
- Small "Enter manually" text link below
- Brief explanation: "Generate a QR code at seekerclaw.dev/setup with your API keys"

**QR scan flow:**
1. Camera opens → user scans QR
2. Config is validated (check API key format, bot token format)
3. If valid: "Configuration saved âœ"" → auto-navigate to Dashboard
4. If invalid: show specific error ("Invalid Telegram bot token format")

**Manual entry flow:**
1. Form with labeled fields: Anthropic API Key, Telegram Bot Token, Telegram Owner ID, Model (dropdown), Agent Name
2. "Save & Start" button
3. Same validation as QR

### Screen 2: Dashboard

**Purpose:** At-a-glance status. The main screen after setup.

**Layout:**
- **Status indicator:** Large colored circle
  - ðŸŸ¢ Green + "Running"
  - ðŸ"´ Red + "Stopped"
  - ðŸŸ¡ Yellow + "Starting..."
- **Uptime:** "Running for 3d 14h 22m"
- **Start / Stop** button (toggles)
- **Quick stats row:** Messages today â€" Total messages â€" Last activity
- **Agent name** at the top

**Behavior:**
- Status updates in real-time via IPC from the foreground service
- Start button → starts service → status goes yellow → green
- Stop button → graceful shutdown → status goes red

**Metrics:** All metrics tracked locally on-device only. No analytics servers, no telemetry. Users can view stats in Dashboard screen.

### Screen 3: Logs

**Purpose:** See what OpenClaw is doing. Debugging tool.

**Layout:**
- Scrollable monospace text view (auto-scrolls to bottom)
- Logs are color-coded: info (white), warning (yellow), error (red)
- "Clear" button in top bar
- "Share" button (export log file)
- "Auto-scroll" toggle

**Source:** Captures stdout/stderr from the Node.js process + OpenClaw's own log output.

### Screen 4: Settings

**Purpose:** Edit config, manage the app

**Layout:**
- **Configuration section:**
  - Anthropic API Key (masked, tap to reveal/edit)
  - Telegram Bot Token (masked)
  - Owner Telegram ID
  - Model selection (dropdown â€" see Model List in section 3)
  - Agent Name
- **Service section:**
  - Auto-start on boot (toggle, default: ON)
  - Battery optimization (button → opens Android settings)
- **Danger zone:**
  - "Reset Configuration" → wipes config, returns to Setup screen
  - "Clear Memory" → deletes workspace/memory/ and MEMORY.md
- **About:**
  - App version, OpenClaw version, Node.js version
  - Link to docs

### Navigation

Bottom bar with 3 items: **Dashboard** | **Logs** | **Settings**

Setup screen is shown only on first launch (or after config reset). No bottom bar on Setup.

---

## 6. OpenClaw Compatibility

### What Works on Mobile

| Feature | Status | Notes |
|---------|--------|-------|
| Telegram channel | ✅ Works | Primary and only channel for v1 |
| Claude / OpenAI API | ✅ Works | Pure HTTPS calls |
| Memory system (files) | ✅ Works | Reads/writes to local filesystem |
| Cron / scheduled tasks | ✅ Works | Node.js timers work fine |
| Web search (Brave) | ✅ Works | HTTPS API calls |
| Web fetch (URL reading) | ✅ Works | HTTPS fetching |
| Heartbeat system | ✅ Works | Timers + file I/O |
| SQLite database | ✅ Works | `better-sqlite3` cross-compiled for ARM64 |
| Signal channel | ⚠️ Untested | Likely works but not in v1 scope |
| Image analysis | ⚠️ Partial | Receiving images works; `sharp` for processing needs ARM64 build |

### What Doesn't Work

| Feature | Status | Why |
|---------|--------|-----|
| Browser automation (Puppeteer/Playwright) | ❌ | No headless Chrome on Android |
| Desktop screen capture | ❌ | No desktop |
| Clipboard access | ❌ | Android sandboxing |
| File system browsing (desktop paths) | ❌ | Different filesystem |
| Windows/macOS scripts | ❌ | Not Windows |
| Canvas / UI presentation | ❌ | No desktop browser to present to |
| Node pairing (desktop) | ❌ | No desktop to pair with |
| TTS (ElevenLabs) | ⚠️ | API works, but no local speaker output |

### Mobile-Specific Config

OpenClaw config overrides for mobile environment (set in `config.yaml` or applied programmatically):

- Heartbeat interval: 5 min (save battery vs desktop default)
- Memory max daily files: 30 (limit disk usage)
- Log max size: 10MB (rotate)
- Log retention: 7 days
- Max context tokens: 100,000 (limit memory usage)
- Web fetch timeout: 15s (shorter for mobile networks)
- Disabled skills: browser, canvas, nodes, screen

### OpenClaw Updates Strategy

| Approach | v1 | v2+ |
|----------|-----|-----|
| New OpenClaw version | Ship new app version with updated bundle | OTA JS bundle update (no app store needed) |
| New Node.js runtime | Ship new app version | Same |
| Config changes | User edits in Settings screen | Same |

---

## 7. Development Plan

### Phase 1: Proof of Concept (Week 1)

**Goal:** Node.js running on Seeker, a mock Node.js script responds to a hardcoded Telegram message.

- [ ] Set up Android Studio project (Kotlin, min SDK 34, package `com.seekerclaw.app`)
- [ ] Integrate nodejs-mobile community fork (Node 18 ARM64)
- [ ] Create mock `index.js`: simple Telegram bot (grammy/telegraf) that responds to a hardcoded message
- [ ] Run mock in foreground service
- [ ] **Milestone:** Screenshot of Telegram conversation with mock bot running on Seeker

### Phase 2: App Shell (Weeks 2-3)

**Goal:** Full setup flow, real OpenClaw gateway bundled and running, foreground service with UI.

- [ ] Integrate real OpenClaw entry (CLI or programmatic) and verify on-device
- [ ] Bundle mock assets/openclaw + recursive asset extraction (common failure point!)
- [ ] Implement QR code scanner (CameraX + ZXing)
- [ ] Build config encryption with Android Keystore
- [ ] Create Foreground Service with persistent notification
- [ ] Implement all 4 screens (Setup, Dashboard, Logs, Settings)
- [ ] Request POST_NOTIFICATIONS permission in Setup flow
- [ ] IPC bridge: Node.js → Kotlin status updates
- [ ] Start/Stop/Restart controls
- [ ] Boot receiver for auto-start + verify works after reboot (note: `directBootAware=false` — encrypted storage needed, acceptable since user must unlock phone first)
- [ ] Battery optimization exclusion dialog
- [ ] Seed workspace with default SOUL.md and empty MEMORY.md
- [ ] **Milestone:** End-to-end flow: install → scan QR → agent running → survives reboot

### Phase 3: Reliability & Polish (Week 4)

**Goal:** Production-grade reliability.

- [ ] Watchdog: 30s check interval, 10s response timeout, 60s dead → auto-restart
- [ ] `START_STICKY` behavior testing
- [ ] WakeLock management (acquire/release properly)
- [ ] Log rotation and retention
- [ ] Crash reporting (write crash logs to file)
- [ ] Handle edge cases: no internet, invalid API key, config corruption
- [ ] 24-hour soak test on Seeker hardware
- [ ] Battery drain measurement and optimization
- [ ] **Milestone:** 24h unattended run with zero restarts needed

### Phase 4: dApp Store Submission (Week 5)

**Goal:** Published on Solana dApp Store.

- [ ] Create publisher NFTs on Solana
- [ ] Prepare store listing (description, screenshots, icon)
- [ ] Build QR generation web tool (GitHub Pages)
- [ ] Sign and submit APK
- [ ] Address review feedback
- [ ] **Milestone:** App live on Solana dApp Store

### Total: ~5 weeks

### Required Skills

| Skill | Level | For |
|-------|-------|-----|
| Kotlin / Android | Intermediate+ | App shell, services, Keystore |
| Jetpack Compose | Basic | 4 simple screens |
| Node.js | Basic | Understanding OpenClaw config/startup |
| Android NDK | Basic | nodejs-mobile integration, native addon compilation |
| Solana (basics) | Basic | dApp Store NFT publishing |

One experienced Android developer can build this. Node.js/OpenClaw knowledge is a plus but not deep expertise required.

---

## 8. Testing Plan

### Hardware Testing

- **Primary device:** Solana Seeker (Snapdragon 6 Gen 1, 8GB RAM, Android 14)
- **Secondary:** Any Android 14+ device with 4GB+ RAM for early development
- **Android Emulator:** Useful for UI development, but must validate on real hardware for service reliability and battery

### Reliability Tests

| Test | Procedure | Pass Criteria |
|------|-----------|---------------|
| **24h soak test** | Start agent, leave on charger, send messages periodically | Agent responds to all messages, zero crashes, zero restarts |
| **48h idle test** | Start agent, no interaction for 48h, then send message | Agent responds immediately |
| **Battery drain (on charger)** | Monitor battery level over 24h while on 5W charger | Battery stays at 80%+ (adaptive charging), phone stays cool |
| **Battery drain (off charger)** | Unplug, measure drain over 8h idle | <3% per hour idle drain |
| **Kill recovery** | Force-stop app from Android settings | Service auto-restarts within 30 seconds |
| **Boot recovery** | Restart phone | Agent auto-starts and responds within 60 seconds of boot |
| **OOM recovery** | Open many other apps to trigger memory pressure | Service restarts if killed, with START_STICKY |
| **Network loss** | Toggle airplane mode for 5 minutes, then restore | Agent reconnects to Telegram within 30 seconds |
| **Rapid messages** | Send 50 messages in quick succession | All processed, no crashes, reasonable queue behavior |

### Edge Case Tests

| Scenario | Expected Behavior |
|----------|-------------------|
| Invalid API key in QR | Setup screen shows "Invalid API key" error |
| Revoked API key (mid-operation) | Agent logs error, dashboard shows warning, keeps running for when key is fixed |
| Malformed QR code | "Could not read configuration" error |
| No internet at startup | Service starts, retries connection every 30s, dashboard shows "No internet" |
| Storage full | Agent logs error, stops writing memory, continues responding |
| Phone overheating | Android throttles CPU â€" agent slows down but doesn't crash |
| Config reset while running | Service stops gracefully, returns to Setup screen |

---

## 9. Distribution

### Solana dApp Store (Primary)

| Aspect | Details |
|--------|---------|
| **Process** | Mint publisher + app + release NFTs on Solana → submit for review |
| **Review time** | 1-2 weeks |
| **Fee** | ~$1 in SOL for NFT minting (no listing fee, no revenue share) |
| **Audience** | 140,000+ Seeker holders |
| **Restrictions** | Must comply with publisher policy (no harmful content) |
| **Advantages** | No background service restrictions, no 30% cut, crypto-native audience |
| **Category** | AI / Tools |

### Google Play (Future / Optional)

| Aspect | Details |
|--------|---------|
| **Challenge** | Must justify `specialUse` foreground service type to Google |
| **Risk** | Google may reject or restrict background execution |
| **Workaround** | Use `dataSync` type with clear explanation of cloud AI synchronization |
| **When** | Consider after dApp Store proves demand â€" not for v1 |

**Note:** `specialUse` is dApp Store friendly with no justification needed. For Play Store, you'll need a written justification explaining the continuous AI agent service use case.

### Direct APK Sideload (Fallback)

- Host signed APK on GitHub Releases and project website
- Users enable "Install from unknown sources" → install APK
- No review process, instant distribution
- Good for: beta testing, users without dApp Store access
- Auto-update: app checks GitHub releases API on launch, prompts user to download new APK

---

## 10. Success Metrics

### "Working" Means

1. **User installs app and scans QR in under 2 minutes**
2. **Agent responds to Telegram messages within 10 seconds**
3. **Agent runs for 7+ days without manual intervention**
4. **Agent survives phone restart and comes back online automatically**
5. **Battery drain is under 3% per hour when idle on charger**

### Reliability Metrics

All metrics tracked locally on-device only. No analytics servers, no telemetry. Users can view stats in Dashboard screen.

| Metric | Target | How to Measure |
|--------|--------|----------------|
| Uptime | >99% over 30 days | Track service start/stop events in local log |
| Auto-recovery rate | >95% of crashes auto-recovered | Count watchdog restarts vs manual restarts |
| Message response rate | >99% messages answered | Compare Telegram messages received vs responded |
| Boot-to-online time | <60 seconds | Measure from BOOT_COMPLETED to first Telegram poll |
| Setup completion rate | >80% of installs complete setup | Track QR scan success vs app open (local only) |

### v1 Launch Targets

| Metric | Target | Timeframe |
|--------|--------|-----------|
| dApp Store installs | 500+ | First month |
| Active agents (running >24h) | 200+ | First month |
| Avg uptime per agent | >72 hours continuous | First month |
| User-reported crashes | <10 | First month |
| dApp Store rating | ≥4.0 / 5.0 | First 3 months |

---

## Appendix A: QR Generation Web Tool

Simple static HTML page (hosted on GitHub Pages):

- Fields: Anthropic API Key, Telegram Bot Token, Owner Telegram ID, Model (dropdown), Agent Name
- "Generate QR" button → renders QR code on screen using client-side JS library
- **All processing happens in the browser. No data sent to any server.**
- User screenshots or scans from another device
- URL: `seekerclaw.dev/setup` or GitHub Pages equivalent

## Appendix B: Why Not Just Use Termux?

| | SeekerClaw App | Termux + Manual Setup |
|---|---|---|
| Setup time | 2 minutes (scan QR) | 30+ minutes (install packages, clone repo, configure) |
| Auto-start on boot | ✅ Built-in | ❌ Requires Termux:Boot addon + scripting |
| Crash recovery | ✅ Watchdog auto-restarts | ❌ Manual restart |
| Non-technical users | ✅ Accessible | ❌ Requires terminal knowledge |
| dApp Store distribution | ✅ One-tap install | ❌ Not distributable |
| Battery optimization | ✅ Handled by app | ❌ User must configure manually |

The app exists to make OpenClaw on Android accessible to anyone, not just developers.

## Appendix C: Future Roadmap (v2+)

These are **explicitly out of scope for v1** but inform architecture decisions:

- **v2:** Signal channel support, OTA OpenClaw updates
- **v3:** Solana wallet integration (MWA), basic DeFi monitoring
- **v4:** Jupiter DEX trading, DCA automation, portfolio tracking
- **v5:** Multi-agent support, agent marketplace, SKR token integration

---

*This document describes the minimum viable product. Every feature not listed here is cut. Ship small, learn fast, iterate.*

