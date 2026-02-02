# SeekerClaw — Deep Research Document

> **Product spec:** See `MVP.md` | **Build instructions:** See `PROMPT.md`

**Date:** February 2, 2026  
**Author:** Research compiled for Beka  
**Scope:** Feasibility of turning Android phones (Solana Mobile Seeker first, then any Android) into headless OpenClaw AI agent nodes

---

## Table of Contents

1. [Node.js on Android](#1-nodejs-on-android)
2. [Android Background Services](#2-android-background-services)
3. [Solana Mobile Specifics](#3-solana-mobile-specifics)
4. [App Architecture](#4-app-architecture)
5. [Reliability & Keep-Alive](#5-reliability--keep-alive)
6. [Security](#6-security)
7. [Competitive Landscape](#7-competitive-landscape)
8. [MVP Scope](#8-mvp-scope)
9. [Business Model Ideas](#9-business-model-ideas)
10. [Solana-Specific Opportunities](#10-solana-specific-opportunities)
11. [Final Assessment](#11-final-assessment)

---

## 1. Node.js on Android

### 1.1 nodejs-mobile (Primary Option)

**Project:** `nodejs-mobile` — a full port of Node.js to mobile platforms (Android + iOS).

- **Community fork (recommended):** https://github.com/niccolobocook/nodejs-mobile — pin to latest stable release at development start
- **npm:** `nodejs-mobile-react-native` — React Native plugin that embeds a Node.js runtime

**Node.js Version Support:**
- Community forks have updated to Node.js 18.x and some experimental Node.js 20.x builds
- **OpenClaw requires Node 18+.** The community-maintained forks do support Node 18 LTS for Android arm64, but the project's maintenance cadence is inconsistent.
- The most active fork has Node 18.17.x builds for `android-arm64`

**How it works:**
- Compiles V8 + Node.js as a shared library (`.so`) for `arm64-v8a` (and optionally `armeabi-v7a`)
- Embedded inside the Android app's native libraries
- Node.js runs in a separate thread within the app's process
- Communication between Java/Kotlin and Node.js via a bridge (events/messages passed through JNI)

**Performance characteristics:**
- **Memory:** Node.js process typically uses 50–120MB RSS on ARM64. With OpenClaw loaded (including dependencies), expect 150–300MB.
- **CPU:** Idle polling (Telegram long-poll) is very light — <2% CPU. Spikes during API calls/response processing.
- **Startup time:** Cold start of Node.js runtime: 2–5 seconds. OpenClaw initialization: additional 3–8 seconds.
- **APK size increase:** ~25–35MB for the Node.js runtime + V8 engine (arm64 only)

**Native addons support:**
- Pure JS npm packages: ✅ work perfectly
- Packages with native addons (N-API/node-addon-api): ⚠️ Need to be cross-compiled for Android ARM64
- Common OpenClaw deps assessment:
  - `better-sqlite3`: ✅ Can be cross-compiled, well-supported on ARM64
  - `sharp` (image processing): ⚠️ Heavy, would need custom build with Android NDK
  - `puppeteer`/`playwright`: ❌ Won't work (no Chrome/headless browser on Android)
  - `node-fetch`/`undici`: ✅ Pure JS or built-in
  - `ws` (WebSocket): ✅ Pure JS
  - `grammy`/`telegraf` (Telegram bots): ✅ Pure JS

### 1.2 Alternatives

**Termux:**
- Full Linux terminal emulator with package manager
- Can install Node.js 20+ via `pkg install nodejs`
- Supports native addons via its own build system
- **Problem:** Not app-store friendly. Requires user to manually install and configure. Not embeddable in another app. Google Play has restrictions on terminal apps.
- **Use case:** Great for development/testing, not for end-user product

**Deno:**
- Can be compiled for Android ARM64 (it's a Rust binary)
- But: OpenClaw is written for Node.js, would require significant rewrite
- Runtime is ~40MB binary
- **Verdict:** Not viable without rewriting OpenClaw

**QuickJS / Hermes:**
- Lightweight JS engines, but NOT Node.js compatible
- No `fs`, `net`, `http`, `child_process`, etc.
- **Verdict:** Not viable — OpenClaw needs full Node.js APIs

**WebAssembly (via wasm):**
- Could compile Node.js to WASM, but performance is 3–10x slower
- WASI doesn't support full networking
- **Verdict:** Not viable for a server/daemon workload

### 1.3 Real-World Examples of Node.js on Android

- **Manyverse** (Scuttlebutt client) — successfully runs Node.js on Android for P2P social networking
- Several crypto wallet apps embed Node.js for transaction signing and blockchain interaction
- The Holochain/Holo ecosystem maintains an active fork used in their mobile apps

### 1.4 Recommendation

**Use `nodejs-mobile` (community fork with Node 18 support) embedded in a native Kotlin app.** This is the proven path. The key risk is maintenance of the nodejs-mobile fork — consider maintaining your own fork pinned to Node 18 LTS.

---

## 2. Android Background Services

### 2.1 Service Types Comparison

| Feature | Foreground Service | WorkManager | AlarmManager |
|---------|-------------------|-------------|--------------|
| Always running | ✅ Yes | ❌ Periodic only | ❌ Periodic only |
| Shows notification | ✅ Required | ❌ No | ❌ No |
| Survives Doze | ✅ Yes | ⚠️ Deferred | ⚠️ Deferred |
| Survives app kill | ✅ If START_STICKY | ❌ Re-enqueues | ⚠️ Maybe |
| Best for | 24/7 daemon ✅ | Periodic tasks | Alarms/reminders |

**Winner for SeekerClaw: Foreground Service** — this is the only option for a 24/7 running daemon.

### 2.2 Foreground Service Requirements (Android 12–15)

**Android 12 (API 31):**
- Must declare `foregroundServiceType` in manifest
- Types: `dataSync`, `mediaPlayback`, `location`, `connectedDevice`, `specialUse`, etc.
- For SeekerClaw: Use `specialUse` — justified as continuous AI agent service

**Android 13 (API 33):**
- Runtime permission required: `POST_NOTIFICATIONS` — must ask user to allow the persistent notification
- Foreground service restrictions tightened — but `specialUse` type still works for justified cases

**Android 14 (API 34):**
- New `foregroundServiceType` must be declared for ALL foreground services
- `dataSync` services have a 6-hour time limit! ⚠️
- **Solution:** Use `specialUse` type with justification, or combine with `connectedDevice` type
- Must provide justification to Google Play during review

**Android 15 (API 35):**
- Further restrictions on `dataSync` (24-hour limit with mandatory termination)
- `specialUse` still available but requires Google Play review justification
- **Key insight:** Solana dApp Store does NOT enforce these Google Play policies! This is a major advantage.

**Distribution note:** `specialUse` is dApp Store friendly — no justification needed. For Google Play, you'll need a written justification explaining the continuous AI agent service use case.

### 2.3 Battery Optimization & Doze Mode

**Doze Mode (screen off, stationary):**
- Network access is restricted to maintenance windows
- Foreground services ARE exempt from Doze — they continue running
- But: need `FOREGROUND_SERVICE` permission (auto-granted) and persistent notification

**App Standby Buckets (Android 9+):**
- Apps are bucketed: Active → Working Set → Frequent → Rare → Restricted
- Foreground services keep the app in "Active" bucket
- No concerns here if foreground service is running

**Battery optimization exclusion:**
- Can request `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` — shows system dialog
- **Critical for reliability** — prevents Android from killing the service aggressively
- Solana Seeker: Since it's a crypto-focused device, users will expect always-on apps

### 2.4 Auto-Start on Boot

- Works reliably on all Android versions with `BOOT_COMPLETED` receiver
- Some OEMs (Xiaomi, Huawei, Samsung) have additional "auto-start" permissions — need to guide users
- **Solana Seeker runs stock-ish Android** — no OEM bloatware restrictions! ✅
- **Note:** Consider `directBootAware` for the boot receiver if you want it to fire before the user unlocks the device. For v1, standard boot (after unlock) is fine.

### 2.5 How Other Apps Stay Running

**Termux:**
- Uses Foreground Service with `wakelock`
- Shows persistent notification "Termux session is running"
- Has `WAKE_LOCK` permission to prevent CPU sleep
- Works well on stock Android, struggles on OEM-modified ROMs

**Crypto mining apps:**
- Same pattern: Foreground Service + WakeLock + battery optimization exclusion
- Some use `mediaPlayback` foreground service type (plays silent audio) — hacky but effective

**Telegram (background message checking):**
- Uses FCM (Firebase Cloud Messaging) for push notifications
- Falls back to persistent connection when FCM is unreliable
- Lesson: For SeekerClaw, since it IS a Telegram bot, we can use both approaches

### 2.6 Screen Off / Phone Locked Behavior

- **Foreground Service continues running** regardless of screen state
- CPU stays awake if `WakeLock` is acquired (important for Node.js event loop)
- Network remains available for foreground services
- **No changes needed** when screen turns off — service keeps running
- Battery drain: ~2–5% per hour (estimate for Node.js idle with occasional API calls)

---

## 3. Solana Mobile Specifics

### 3.1 Seeker Specifications

| Spec | Details |
|------|---------|
| **Processor** | Qualcomm Snapdragon 6 Gen 1 (SM6450) |
| **RAM** | 8GB LPDDR5 |
| **Storage** | 128GB UFS 3.1 |
| **Display** | 6.36" AMOLED, 120Hz |
| **Android Version** | Android 14 (at launch) |
| **Battery** | 4,500 mAh |
| **Price** | $450 |
| **Crypto Hardware** | Seed Vault (secure element integration) |
| **Pre-orders** | 140,000+ units |

**For SeekerClaw purposes:**
- 8GB RAM is generous — Node.js + OpenClaw needs ~300MB, leaving plenty for the OS and other apps
- Snapdragon 6 Gen 1 is mid-range but very capable for Node.js workloads
- UFS 3.1 storage is fast enough for sqlite/file I/O
- Android 14 means we need to handle the new foreground service restrictions

### 3.2 Solana Mobile Stack (SMS) SDK

From the official docs (https://docs.solanamobile.com):

**Components:**
1. **Mobile Wallet Adapter (MWA)** — protocol for dApps to connect to wallet apps for signing
2. **Seed Vault** — hardware-backed secure key storage
3. **Solana dApp Store** — alternative app distribution (no Google Play 30% fee!)
4. **Solana Pay for Android** — payment protocol integration

**MWA SDK availability:**
- React Native ✅
- Kotlin/Java ✅
- Flutter ✅
- Unity / Unreal Engine ✅

### 3.3 Mobile Wallet Adapter — Can OpenClaw Sign Transactions?

**YES, with caveats.**

The Mobile Wallet Adapter protocol works like this:
1. dApp (SeekerClaw) sends a signing request
2. MWA routes it to the user's wallet app (e.g., Phantom, Solflare on Seeker)
3. Wallet app shows a confirmation dialog
4. User approves → signed transaction returned to dApp

**The problem for headless/autonomous operation:**
- MWA requires user interaction (approve/reject) for EACH transaction
- This is by design — security feature
- For a headless agent that needs to trade autonomously, **MWA won't work directly**

**Solutions:**
1. **Use a keypair directly in the app** — store private key in Android Keystore or Seed Vault, sign transactions programmatically without MWA. This bypasses MWA but gives full autonomy.
2. **Pre-approve patterns** — some wallets support "auto-approve" for trusted dApps (limited)
3. **Hybrid approach** — use MWA for high-value transactions (user approves), direct signing for small/automated ones

**Recommendation:** For DeFi trading, store a dedicated trading keypair in the app (funded with a limited amount). Use MWA only for initial setup and high-value operations.

### 3.4 Seed Vault — Can We Use It for API Keys?

**Seed Vault overview:**
- Hardware-backed secure storage integrated into Seeker
- Designed for cryptocurrency seed phrases and private keys
- Uses ARM TrustZone / secure enclave on the processor
- Keys never leave the secure execution environment

**For API keys (Anthropic, OpenAI, Telegram bot tokens):**
- Seed Vault SDK is designed for wallet apps, not general secret storage
- It's focused on Ed25519/secp256k1 key operations
- **Not ideal for arbitrary secret storage** like API key strings
- **Better option:** Android Keystore System — designed for exactly this use case
  - Hardware-backed on devices with secure elements
  - Supports arbitrary secret storage (symmetric keys, credentials)
  - Available on all Android devices, not just Seeker
  - Can encrypt/decrypt API keys with hardware-backed keys

**Recommendation:** Use Android Keystore for API keys. Use Seed Vault only if integrating Solana wallet functionality.

### 3.5 dApp Store: Submission Process

From official docs (https://docs.solanamobile.com/dapp-publishing/overview):

**Process:**
1. Create NFTs on-chain describing the publisher, dApp, and release
2. Submit review request via the publisher portal
3. Solana Mobile team reviews the submission
4. Approved apps appear in the Solana dApp Store

**Key advantages over Google Play:**
- **No 30% revenue cut** — Solana dApp Store takes 0%
- **No restrictions on crypto functionality** — Google Play restricts crypto mining, certain DeFi features
- **NFT-based publishing** — publisher identity is on-chain
- **CI/CD friendly** — publishing tool designed for automation
- **No restrictions on background services or "special use" justifications**

**Requirements:**
- Must comply with Publisher Policy (no illegal/harmful content)
- Must sign Developer Agreement
- App must be a legitimate Solana ecosystem application
- Review typically takes 1–2 weeks

**Fees:**
- Small SOL transaction fee for creating the on-chain NFTs (< $1)
- No ongoing listing fees
- No revenue share

### 3.6 dApp Store Landscape

**Current state (as of early 2026):**
- Hundreds of apps listed in Solana dApp Store 2.0
- Categories: DeFi, NFT, Gaming, Social, Tools, AI
- Major apps: Jupiter, Phantom, Marinade, Tensor, Magic Eden
- Growing "AI" category with agent-type apps emerging
- User base: ~140,000+ Seeker holders + Saga (original) users
- The store is exclusive to Solana Mobile devices

**AI/Agent apps on dApp Store:**
- Emerging category — several AI chatbot and agent apps appearing
- No direct competitor doing "headless AI agent node" concept yet
- **SeekerClaw would be first-of-kind** on the dApp Store ✅

---

## 4. App Architecture

### 4.1 React Native vs Kotlin Native

| Factor | React Native | Kotlin Native |
|--------|-------------|---------------|
| Node.js integration | ✅ `nodejs-mobile-react-native` plugin exists | ⚠️ Need manual JNI bridge |
| Solana MWA SDK | ✅ Official React Native SDK | ✅ Official Kotlin SDK |
| UI development speed | ✅ Fast (JSX, hot reload) | ⚠️ Slower (Jetpack Compose) |
| Background service | ⚠️ Need native module | ✅ Native Kotlin, full control |
| Performance | ⚠️ JS bridge overhead | ✅ Native performance |
| APK size | ⚠️ Larger (RN + Node.js) | ✅ Smaller |
| Maintenance burden | ⚠️ RN version upgrades painful | ✅ Stable Android APIs |
| Developer pool | ✅ More JS/RN devs available | ⚠️ Fewer Kotlin mobile devs |

**Recommendation: Kotlin Native** — for this specific use case (minimal UI, heavy background service), Kotlin gives better control over the service lifecycle, lower overhead, and more reliable background execution. The UI is minimal (QR scanner, status screen, start/stop), so React Native's UI advantages don't matter much.

However, if you want faster prototyping and already have a JS-heavy team: **React Native** with `nodejs-mobile-react-native` is the pragmatic choice.

### 4.2 Embedding Node.js in a Native Android App

**Architecture:**

```
┌─────────────────────────────────────┐
│      Android App (SeekerClaw)        │
│  ┌─────────────────────────────────┐ │
│  │     Foreground Service          │ │
│  │  ┌───────────────────────────┐  │ │
│  │  │   Node.js Runtime Thread  │  │ │
│  │  │   (libnodejs.so)         │  │ │
│  │  │                           │  │ │
│  │  │   ┌───────────────────┐   │  │ │
│  │  │   │   OpenClaw Gateway │   │  │ │
│  │  │   │   - Telegram Bot   │   │  │ │
│  │  │   │   - Claude API     │   │  │ │
│  │  │   │   - Memory/Config  │   │  │ │
│  │  │   └───────────────────┘   │  │ │
│  │  └───────────────────────────┘  │ │
│  └──────────────┬──────────────────┘ │
│                 │ IPC (stdin/stdout   │
│                 │  or TCP localhost)  │
│  ┌──────────────┴──────────────────┐ │
│  │     UI Activity (minimal)       │ │
│  │   - Status dashboard            │ │
│  │   - QR config scanner           │ │
│  │   - Start/Stop toggle           │ │
│  │   - Logs viewer                 │ │
│  └─────────────────────────────────┘ │
│                                       │
│  ┌─────────────────────────────────┐ │
│  │   Optional: Solana MWA Client   │ │
│  │   (for DeFi signing — v2+)     │ │
│  └─────────────────────────────────┘ │
└─────────────────────────────────────┘
```

### 4.3 IPC Between Android and Node.js

**Options:**

1. **Bridge messages (nodejs-mobile approach):**
   - Node.js ↔ Java/Kotlin via event-based messaging
   - `nodejs-mobile` provides `channel.send()` / `channel.on()` API
   - Good for: status updates, start/stop commands, config passing
   - Latency: <1ms per message

2. **TCP localhost:**
   - Node.js starts HTTP server on `127.0.0.1:PORT`
   - Kotlin connects via HTTP/WebSocket
   - Good for: rich API, debugging (can curl from adb)
   - OpenClaw already has HTTP endpoints — **reuse existing architecture**

3. **Unix domain socket:**
   - File-based socket in app's private directory
   - Lower overhead than TCP
   - Good for: high-throughput IPC

**Recommendation:** Use the nodejs-mobile bridge for lifecycle control (start/stop/status) + TCP localhost for any rich API interaction. This keeps it simple and reuses OpenClaw's existing HTTP server.

### 4.4 File System Access

**OpenClaw storage locations on Android:**

```
/data/data/com.seekerclaw.app/          # App's private storage (no root needed)
├── files/
│   ├── nodejs/                          # Node.js runtime + OpenClaw package
│   │   ├── node_modules/
│   │   ├── package.json
│   │   └── ...
│   ├── workspace/                       # OpenClaw working directory
│   │   ├── config.yaml                  # Main config
│   │   ├── SOUL.md                      # Agent personality
│   │   ├── MEMORY.md                    # Long-term memory
│   │   ├── memory/                      # Daily memory files
│   │   │   └── 2026-02-02.md
│   │   └── HEARTBEAT.md
│   ├── logs/                            # Runtime logs
│   └── ...
├── databases/
│   └── seekerclaw.db                    # SQLite database
└── shared_prefs/
    └── seekerclaw_prefs.xml             # Android preferences
```

- App's private storage is fully accessible without root
- No special permissions needed for internal storage
- Survives app updates (if using `files/` not `cache/`)
- **Encrypted with Android's file-based encryption (FBE)** when device is locked

### 4.5 Network Access

**Can Node.js make outbound HTTPS requests?** **YES, fully.**

- Node.js embedded via nodejs-mobile has full network stack access
- HTTPS, WebSocket, TCP, UDP all work
- Android's `INTERNET` permission (declared in manifest, auto-granted) is sufficient
- No proxy/VPN interference unless user has one configured

**Specific services OpenClaw needs:**
- Telegram Bot API (`api.telegram.org`) ✅
- Anthropic Claude API (`api.anthropic.com`) ✅
- OpenAI API (`api.openai.com`) ✅
- Any other HTTPS endpoint ✅

**Note:** Android 9+ enforces cleartext (HTTP) restrictions by default. All traffic must be HTTPS. OpenClaw already uses HTTPS everywhere, so no issue.

### 4.6 QR Code Config Flow

**Data to encode in QR:**

```json
{
  "v": 1,
  "telegram_bot_token": "123456:ABC-DEF...",
  "telegram_owner_id": "123456789",
  "anthropic_api_key": "sk-ant-...",
  "model": "claude-sonnet-4-20250514",
  "agent_name": "MyAgent"
}
```

**Flow:**
1. User generates QR via web tool (seekerclaw.dev/setup)
2. Opens SeekerClaw app → scans QR
3. App decrypts/stores config in Android Keystore
4. Starts the Node.js service with this config
5. Agent comes online in Telegram — done!

**QR size consideration:**
- API keys are long (~100 chars each)
- Total payload: ~400–500 bytes
- Within QR code capacity (Version 10 QR: ~652 alphanumeric chars)

### 4.7 Handling OpenClaw Updates

**v1 Strategy:** New OpenClaw version = new app version. Bundle updated JS in APK.

**v2+ Strategy: OTA (Over-The-Air) package updates**

The Node.js runtime stays the same (rarely changes), but the OpenClaw JavaScript code can be updated independently:

1. **Check for updates** on app launch and periodically
2. **Download** new `openclaw-package.tar.gz` from server
3. **Extract** to a staging directory
4. **Restart** the Node.js service with the new package
5. **Rollback** if the new version crashes on startup

This avoids full app store updates for JavaScript-only changes. Only native code changes (Node.js runtime, Kotlin code) require an app update through the dApp Store.

---

## 5. Reliability & Keep-Alive

### 5.1 Preventing Android from Killing the Service

**Multi-layer approach:**

1. **Foreground Service with persistent notification** — highest priority process
2. **`START_STICKY` return from `onStartCommand()`** — system restarts service if killed
3. **Battery optimization exclusion** — user grants exception
4. **`WAKE_LOCK`** — prevents CPU from sleeping
5. **Boot receiver** — auto-start on device reboot

### 5.2 Watchdog Patterns

**SeekerClaw watchdog timing (standardized):**
- **Check interval:** Every 30 seconds
- **Response timeout:** 10 seconds per ping
- **Dead declaration:** 60 seconds of no response (2 consecutive missed checks) → restart Node.js

**Node.js side heartbeat:**
```javascript
// In OpenClaw's main loop or bootstrap.js
setInterval(() => {
    bridge.send({ type: 'heartbeat', uptime: process.uptime() });
}, 15000); // Send heartbeat every 15s (well within 30s check window)
```

### 5.3 Firebase FCM as Backup Keep-Alive

**Strategy:** Register for FCM, send periodic silent push notifications as a "wake-up" signal.

- If the service somehow gets killed and `START_STICKY` doesn't restart it fast enough
- FCM high-priority message triggers the app to restart
- Can be sent from your own server on a 15-minute schedule
- **Effectively zero cost** (FCM is free)

**Note:** On Seeker (stock Android), this is less necessary since foreground services are very stable. More relevant for OEM-modified Android (Samsung, Xiaomi).

### 5.4 Battery Usage Estimates (24/7 on Charger)

| Scenario | Estimated Battery Draw |
|----------|----------------------|
| Idle (Telegram long-poll, no activity) | ~1–2% per hour |
| Light usage (few messages/hour) | ~2–3% per hour |
| Heavy usage (active conversation, API calls) | ~4–6% per hour |
| With DeFi monitoring (periodic price checks) | ~3–4% per hour |

**On charger (recommended setup):**
- Phone plugged in 24/7 with slow charger (5W)
- Android's Adaptive Charging protects battery (caps at 80%)
- Thermal: phone will be warm but within safe range
- **Seeker's 4,500mAh battery** means even off-charger, idle operation lasts ~24–48 hours

### 5.5 Thermal Throttling Concerns

- **Idle/light load:** No throttling concerns. Node.js idle loop is negligible.
- **During API responses:** Brief CPU spikes (<2 seconds) — well within thermal budget
- **Continuous load (e.g., processing many messages):** Could trigger throttling after ~10 min of sustained use
- **Mitigation:** OpenClaw's workload is inherently bursty (wait for message → process → wait). Not a sustained compute workload.
- **Recommendation:** If deploying as always-on device, use a phone stand with airflow. Don't put it under a pillow.

---

## 6. Security

### 6.1 API Key Storage

**Android Keystore System (recommended):**

- Keys are stored in hardware secure element (TEE/StrongBox)
- Even with root access, keys cannot be extracted
- App uninstall destroys the keys
- On Seeker: enhanced by Qualcomm's TrustZone implementation
- `userAuthenticationRequired = false` — service needs access without user interaction

See `PROMPT.md` for implementation details (KeystoreHelper.kt).

### 6.2 Network Security

- All OpenClaw traffic is already HTTPS ✅
- Certificate pinning could be added for Telegram/Claude APIs (optional, adds brittleness)
- Android's Network Security Config can enforce HTTPS-only
- VPN detection: warn user if untrusted VPN is active

### 6.3 Stolen Phone Scenarios

**Built-in Android protections:**
- File-Based Encryption (FBE) — data encrypted at rest
- Screen lock required — data inaccessible without PIN/biometric
- Google Find My Device — remote wipe capability
- Factory reset protection (FRP) — prevents reuse without Google account

**SeekerClaw-specific protections:**
1. **Inactivity timeout:** If no heartbeat from owner in 48 hours, auto-wipe config
2. **Remote kill command:** Send Telegram command from another device to wipe the agent
3. **API key rotation:** If phone is lost, rotate API keys from the provider dashboards
4. **No seed phrases on device:** Keep crypto keys separate from API keys. Use limited-fund trading wallet only.

### 6.4 Config File Protection

- Config stored in app's private directory (`/data/data/com.seekerclaw.app/`) — other apps cannot access
- Sensitive fields (API keys, tokens) encrypted via Android Keystore
- Non-sensitive fields (model preference, agent name) stored as plaintext for easier debugging
- **Full-disk encryption** on Android 14+ is mandatory and always-on

---

## 7. Competitive Landscape

### 7.1 AI Agent Hardware/Devices

| Product | Type | Status | Similarity to SeekerClaw |
|---------|------|--------|--------------------------|
| **Rabbit R1** | Dedicated AI device | Shipped, disappointing reviews | Different — cloud-based, limited, proprietary |
| **Humane AI Pin** | Wearable AI device | Shipped, mostly failed | Different — wearable, camera-focused, proprietary |
| **Tab** | AI companion device | Pre-order | Different — conversational device, not agent |
| **Friend** | AI wearable | Shipped 2024 | Different — always-listening pendant |
| **Rewind Pendant** (Limitless) | Memory capture device | Shipped | Different — recording/transcription focus |

**Key insight:** All these products are **purpose-built hardware**. None of them repurpose existing phones as agent nodes. SeekerClaw's approach of using commodity Android phones is fundamentally different and cheaper.

### 7.2 AI Agents on Phones

| Project | Description | Platform |
|---------|-------------|----------|
| **Open Interpreter** | Open-source code interpreter | Desktop only (Python) |
| **AutoGPT** | Autonomous AI agent | Server-based |
| **BabyAGI** | Task-driven AI agent | Server-based |
| **CrewAI** | Multi-agent framework | Server-based |
| **LangChain agents** | Agent framework | Mostly server-based |

**No one is running AI agents as persistent background services on phones.** This is genuinely novel.

### 7.3 Pre-Configured AI Agent Devices

- **No products exist** selling pre-configured phones as "AI agent devices"
- Closest concept: crypto mining phones (HTC Exodus, some obscure Chinese brands) — but those mine crypto, not run AI agents
- **Custom Raspberry Pi setups** exist for self-hosted AI, but that's hobbyist territory
- **This is a blue ocean opportunity** ✅

### 7.4 Open Source Projects

- **Home Assistant** runs on phones (sort of) but is for home automation
- **Termux + Node.js** can technically run anything, but it's DIY
- **KDE Connect** — phone as remote node, but for desktop integration
- **No open-source project** combines: phone + AI agent + crypto wallet + background service

---

## 8. MVP Scope

See `MVP.md` for the full product spec and feature priority list.

### 8.1 Summary

**Must have for v1:**
1. ✅ Android app with foreground service
2. ✅ Embedded Node.js runtime running OpenClaw gateway
3. ✅ QR code setup flow (scan config)
4. ✅ Status screen (running/stopped, uptime, message count)
5. ✅ Start/Stop toggle
6. ✅ Auto-start on boot
7. ✅ Persistent notification showing agent status
8. ✅ Telegram bot channel working
9. ✅ Watchdog with auto-restart (30s check / 10s timeout / 60s dead)
10. ✅ Notification permission request (API 33+)

**Development phases:**
- **Phase 1 (PoC):** Mock OpenClaw with a simple Node.js script that responds to a hardcoded Telegram message
- **Phase 2 (App Shell):** Real OpenClaw gateway bundled and running

### 8.2 What to Strip from OpenClaw for Mobile

**Keep:**
- Core agent loop (message → think → respond)
- Telegram channel
- Claude/OpenAI API integration
- Memory system (files-based)
- Config system
- Heartbeat system

**Remove/disable:**
- Browser automation skill
- Screen capture/control
- Desktop-specific tools (clipboard, file system browsing of desktop)
- Any Electron/desktop UI code
- Heavy media processing (sharp, ffmpeg)

### 8.3 Estimated Development Time

| Phase | Duration | Description |
|-------|----------|-------------|
| **Phase 1: PoC** | 1 week | Kotlin app + nodejs-mobile + mock Telegram bot running in foreground service |
| **Phase 2: App Shell** | 2–3 weeks | Real OpenClaw, QR setup, status UI, auto-start, battery optimization |
| **Phase 3: Polish** | 1 week | Edge cases, crash recovery, watchdog, logging, UX polish |
| **Phase 4: dApp Store** | 1 week | Submission, listing, review |

**Total to MVP: ~5 weeks** (one experienced developer)

### 8.4 Skills/Tools Needed

- **Kotlin/Android development** — foreground services, lifecycle management
- **Node.js** — understanding of OpenClaw internals, nodejs-mobile integration
- **Android NDK** — for cross-compiling native Node.js addons (if any)
- **Solana SDK (Kotlin)** — for dApp Store NFT publishing
- **Android Studio** — primary IDE
- **Physical Solana Seeker device** — for testing (or Android emulator for initial dev)

---

## 9. Business Model Ideas

### 9.1 Free App + BYOK (Bring Your Own Key)

- App is free on Solana dApp Store
- User provides their own Anthropic/OpenAI API key
- **No revenue** but maximum adoption
- **Best for:** building user base, proving concept

### 9.2 Pre-Configured "Agent Phones"

- Buy Solana Seeker wholesale
- Pre-install SeekerClaw app
- Pre-configure with curated personality/skills
- Sell as "AI Agent in a Box" for $599–799
- **Revenue:** hardware margin (~$150–350 per unit)
- **Target:** non-technical users who want AI agent but don't want to set up anything

### 9.3 Managed Cloud Relay Subscription

- Free tier: direct Telegram bot (user manages their own)
- Pro tier ($9.99/mo): managed relay with:
  - Cloud backup of agent memory
  - Remote monitoring dashboard
  - Automatic updates
  - Priority support
  - Multi-device sync

### 9.4 dApp Store Distribution Advantages

- **No 30% Google tax** — any in-app purchases go directly to you
- **Crypto-native users** — higher willingness to pay, used to paying for tools
- **SKR token integration** — could accept SKR for premium features
- **First-mover advantage** — AI agent category is new on dApp Store

### 9.5 Revenue Model Comparison

| Model | Revenue/User | Scalability | Effort |
|-------|-------------|-------------|--------|
| BYOK (free) | $0 | ∞ | Low |
| Pre-configured phones | $150–350 one-time | Limited by hardware | High |
| Cloud relay subscription | $120/year recurring | High | Medium |
| Token-based premium | Variable | High | High |

**Recommendation:** Start with BYOK (free) to prove the concept and build user base. Add subscription tier for managed relay. Explore pre-configured phones as a premium offering once demand is validated.

---

## 10. Solana-Specific Opportunities

### 10.1 Agent + Wallet on Same Device = DeFi Automation

This is the **killer feature** that makes Solana Mobile the ideal target:

- Agent can monitor DeFi positions 24/7
- Direct access to wallet for signing transactions
- No cloud server needed — everything runs locally
- Private keys never leave the device
- **User trusts their phone** more than a cloud server with their keys

### 10.2 Jupiter DEX Integration

**Jupiter Aggregator** (largest Solana DEX aggregator):
- API endpoint: `https://quote-api.jup.ag/v6/`
- Can get quotes and build swap transactions
- Agent can execute trades programmatically
- Use cases:
  - "Buy $50 of SOL when price drops below $X"
  - "DCA $10 into JUP every day"
  - "Swap my USDC to SOL if SOL/USDC drops 5%"
  - "Sell my NFT floor price sweeps"

### 10.3 Other DeFi Opportunities

- **Lending/Borrowing (Marginfi, Kamino):** Monitor health factor, auto-repay to avoid liquidation
- **Liquid Staking (Marinade, Jito):** Auto-stake SOL for yield
- **Yield Farming:** Auto-compound rewards
- **NFT Operations:** Auto-accept offers above threshold, list/delist based on floor
- **Token Launches:** Snipe new token launches on Raydium/Orca (high-risk but demanded)

### 10.4 SKR Token Integration

Solana Mobile's SKR token is the ecosystem token for Seeker:
- Could require SKR for premium agent features
- Could earn SKR by running the agent (proof-of-agent?)
- Align with Solana Mobile's ecosystem incentives

---

## 11. Final Assessment

### Feasibility Score: **7.5 / 10**

**Why not higher:**
- nodejs-mobile maintenance is the biggest technical risk (community-maintained, could stagnate)
- Android background service restrictions keep tightening (but Solana dApp Store bypasses Google Play restrictions)
- Cross-compiling native Node.js addons for ARM64 can be painful
- Battery/thermal management needs careful tuning

**Why it's solidly feasible:**
- All core technologies exist and are proven
- Solana Seeker hardware is more than capable
- The workload (poll Telegram → call API → respond) is lightweight
- Foreground services work reliably for 24/7 operation on stock Android
- No one else is doing this — first mover advantage
- Solana dApp Store removes Google Play restrictions

### Recommended Tech Stack

| Layer | Technology |
|-------|-----------|
| **App Framework** | Kotlin + Jetpack Compose (UI) |
| **Node.js Runtime** | nodejs-mobile community fork (Node 18 LTS) — pin version |
| **IPC** | nodejs-mobile bridge + localhost HTTP for rich API |
| **Background Service** | Android Foreground Service (`specialUse` type) |
| **Key Storage** | Android Keystore (API keys) + optional Seed Vault (crypto keys) |
| **Database** | SQLite via better-sqlite3 (cross-compiled for ARM64) |
| **Solana SDK** | `@solana/web3.js` (inside Node.js) + MWA SDK (Kotlin) |
| **DeFi** | Jupiter API (REST) + Solana web3.js for transaction building |
| **Distribution** | Solana dApp Store (primary) + direct APK download (fallback) |

### Key Risks and Mitigations

| Risk | Severity | Likelihood | Mitigation |
|------|----------|-----------|------------|
| nodejs-mobile fork becomes unmaintained | High | Medium | Maintain own fork, pin to stable release |
| Android 16+ kills foreground services entirely | High | Low | dApp Store doesn't enforce Google Play policies; fallback to WorkManager with FCM wake-ups |
| OpenClaw native deps don't cross-compile | Medium | Medium | Audit all deps before starting; replace problematic ones with pure JS alternatives |
| Thermal throttling on always-on operation | Medium | Medium | Optimize idle power; recommend users keep phone on charger with airflow |
| Solana Mobile/Seeker hardware discontinuation | Medium | Low | Build for generic Android from day 1; Solana integration is additive |
| dApp Store rejection | Low | Low | App is legitimate; comply with publisher policy; have direct APK as fallback |
| User crypto funds at risk via agent | High | Medium | Limit trading wallet funds; require confirmation for large transactions; audit trail |
| API key exposure on compromised device | High | Low | Android Keystore hardware protection; auto-wipe on suspicious activity |

---

## Appendix: Key Links and Resources

- **Solana Mobile Stack Docs:** https://docs.solanamobile.com
- **Mobile Wallet Adapter:** https://github.com/solana-mobile/mobile-wallet-adapter
- **Seed Vault SDK:** https://github.com/solana-mobile/seed-vault-sdk
- **dApp Store Publishing:** https://docs.solanamobile.com/dapp-publishing/overview
- **Jupiter API Docs:** https://station.jup.ag/docs
- **Android Foreground Services:** https://developer.android.com/develop/background-work/services/foreground-services
- **Android Keystore:** https://developer.android.com/training/articles/keystore
- **nodejs-mobile (community fork):** https://github.com/niccolobocook/nodejs-mobile
- **Solana Mobile Discord:** https://discord.gg/solanamobile

---

*This document represents research compiled February 2, 2026. Technology landscape changes rapidly — verify current status of key dependencies before committing to development.*
