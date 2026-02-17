# SeekerClaw — Project Description

> **Living document.** Update after every shipped feature. Read before any feature work.

## One-Liner

SeekerClaw turns a Solana Seeker phone into a 24/7 personal AI agent you control through Telegram.

## Elevator Pitch

SeekerClaw embeds a full Node.js runtime inside an Android app, running an OpenClaw-compatible AI gateway as a foreground service. Users interact with their agent through Telegram — the app itself is minimal (setup, status, logs, settings). The agent has 54 tools, 16 skills, ranked memory search, cron scheduling, Android device control, Solana wallet integration, and web intelligence — all running locally on the phone, 24/7.

## What It Is

SeekerClaw is an Android app built for the Solana Seeker phone (also works on any Android 14+ device with 4GB+ RAM). It packages a Node.js 18 runtime via nodejs-mobile and runs an AI agent gateway derived from OpenClaw. The agent connects to Anthropic's Claude API for intelligence and to Telegram for user communication.

**Who it's for:** Seeker phone owners who want an always-on AI assistant that can manage their crypto wallet, control their phone, search the web, and automate tasks — all from Telegram.

**How it works:**
1. User installs the app, scans a QR code with API credentials
2. The app starts a foreground service running Node.js
3. Node.js runs the AI gateway, connecting to Claude + Telegram
4. User sends messages in Telegram, agent responds with tools

## Tech Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Language (Android) | Kotlin | — |
| UI Framework | Jetpack Compose (Material 3) | — |
| Min SDK | 34 (Android 14) | — |
| Node.js Runtime | nodejs-mobile (community fork) | Node 18 LTS |
| AI Provider | Anthropic Claude API | Sonnet 4.5 default |
| Messaging | Telegram Bot API (grammy) | — |
| Database | SQL.js (WASM SQLite) | 1.12.0 |
| OpenClaw Parity | OpenClaw gateway (ported) | 2026.2.14 |
| Web Search | Brave Search + Perplexity Sonar | — |
| Wallet | Solana Web3.js + Jupiter API | — |
| Build | Gradle (Kotlin DSL) | — |

## Features — Shipped

### AI Agent Core
- **Claude integration** — Sonnet 4.5 (default), Opus 4.6, Haiku 4.5 selectable. Prompt caching, retry with backoff, rate-limit throttling, user-friendly error messages. OAuth/setup token support for Claude Pro/Max users.
- **Telegram bot** — HTML formatting (no markdown headers), native blockquotes, bidirectional reactions, file download with vision, file upload (telegram_send_file tool), long message chunking, quoted replies via `[[reply_to_current]]`, emoji rendering fixed, companion-tone message templates (TEMPLATES.md), context-aware `/start`
- **SILENT_REPLY protocol** — Agent silently drops messages when it has nothing useful to say
- **Ephemeral session awareness** — Agent knows context resets on restart
- **PLATFORM.md auto-generation** — Device state (model, RAM, storage, battery, permissions, wallet) written on every service start

### Memory System
- **SOUL.md** — Agent personality (user-editable)
- **IDENTITY.md / USER.md** — Agent and owner profiles (created during bootstrap)
- **MEMORY.md** — Long-term memory via `memory_save` tool
- **Daily notes** — `memory/YYYY-MM-DD.md` files via `daily_note` tool
- **SQL.js memory search** — Files indexed into chunks with TF + recency ranked search
- **HEARTBEAT.md** — Updated every 5 minutes with status
- **Auto session summaries** — Generated on idle (10min), message checkpoints (50), `/new`, and shutdown

### Scheduling (Cron)
- **One-shot reminders** — "in 30 minutes", "tomorrow at 9am"
- **Recurring jobs** — "every 2 hours", "every day at noon"
- **Natural language parsing** — No cron syntax needed
- **JSON persistence** — Atomic writes with backup, per-job execution history
- **Zombie detection** — 2-hour threshold with error backoff

### Web Intelligence
- **Web search** — Brave Search (default) + DuckDuckGo Lite (zero-config fallback) + Perplexity Sonar (AI-synthesized answers)
- **Web fetch** — HTML-to-markdown, JSON, caching, redirects, custom headers/methods/bodies
- **15-minute cache** — 100 entries max, FIFO eviction

### Android Bridge (13 tools)
- **Device info** — Battery level/charging, storage stats
- **Clipboard** — Read and write
- **Contacts** — Search by name (requires READ_CONTACTS)
- **SMS** — Send messages (requires SEND_SMS, user confirmation)
- **Phone calls** — Dial numbers (requires CALL_PHONE, user confirmation)
- **GPS location** — Current coordinates (requires ACCESS_FINE_LOCATION)
- **Text-to-speech** — Speak text with configurable speed/pitch
- **Camera** — Capture photos (front/back) + Claude vision analysis
- **Apps** — List installed apps, launch by package name

### Solana Wallet (16 tools)
- **Balance check** — SOL + SPL token balances
- **Transaction history** — Recent transactions for any address
- **Connected wallet** — Get address from SeekerClaw app
- **Send SOL** — Transfer with wallet approval on phone
- **Token prices** — Real-time USD prices via Jupiter
- **Swap quotes** — Jupiter Ultra API quotes with price impact
- **Token swaps** — Gasless swaps via Jupiter Ultra API with MWA sign-only flow, v0 transaction validation
- **Limit orders** — Create/list/cancel limit orders and stop-loss orders (Jupiter Trigger API)
- **DCA orders** — Create/list/cancel dollar-cost averaging positions (Jupiter DCA API)
- **Token search** — Search tokens by symbol or name, get mint addresses
- **Token security** — Check token security/legitimacy before trading
- **Wallet holdings** — Full portfolio view with USD values via Jupiter

### Execution
- **Shell exec** — 22 sandboxed Unix commands (cat, ls, curl, grep, find, etc.), workspace-restricted
- **JS eval** — Run JavaScript inside Node.js process, async/await, require() for builtins

### File Management
- **Read/Write/Edit/Delete** — Full workspace file operations
- **Directory listing** — Recursive with sizes and types
- **Protected files** — SOUL.md, MEMORY.md, IDENTITY.md, USER.md, HEARTBEAT.md cannot be deleted

### Analytics
- **API request logging** — Every Claude call logged to SQL.js (tokens, latency, cache hits, errors)
- **Session status** — Uptime, memory usage, model, conversation stats, today's API usage
- **Memory stats** — File sizes, daily file count, database index status
- **Stats bridge endpoint** — `/stats/db-summary` for Android UI

### Telegram Commands
| Command | Action |
|---------|--------|
| `/start` | Welcome message |
| `/status` | System status |
| `/new` | Save summary, clear conversation |
| `/reset` | Clear conversation (no summary) |
| `/soul` | Show personality |
| `/memory` | Show long-term memory |
| `/skills` | List installed skills |

### Skills (16 flat + 18 directory-based, seeded on first launch)
**Flat skills (agent-created format):** crypto-prices, movie-tv, github, recipe, exchange-rates, dictionary, sms, phone-call, device-status, location, speak, openclaw-sync, solana-wallet, solana-mobile, solana-mobile-dev, solana-dapp
**Directory skills (OpenClaw format, seeded by ConfigManager.kt):** weather, research, briefing, reminders, notes, translate, calculator, summarize, timer, define, news, todo, bookmark, joke, quote, crypto-prices, movie-tv, github

### Security
- API key redaction in logs
- Path traversal prevention (workspace sandboxing)
- Shell command allowlist (no rm, kill, etc.)
- js_eval blocks child_process and vm modules
- Bridge token authentication
- Swap transaction verification (checks payer and programs)

### App (Android)
- **Single theme** — DarkOps (dark navy + crimson red + green status), 12dp corners
- **Setup wizard** — QR scan or manual API key entry, OAuth/setup token support, haptic feedback
- **Dashboard** — Status with pulse animation (running) + dimming (stopped), uptime, message stats, active uplinks, mini terminal
- **Logs viewer** — Color-coded, auto-scrolling monospace, stable keys for performance
- **Settings** — Collapsible sections with animation, edit config with masked fields, model dropdown, auto-start, battery optimization, export/import, visual escalation for danger zone, semantic action colors (green positive, red danger)
- **System screen** — API usage stats, memory index status, colored accent borders on stat cards
- **Foreground service** — START_STICKY with wake lock, boot receiver, watchdog (30s health check)

## Features — In Progress

_None currently._

## Features — Planned

| Priority | Feature | Notes |
|----------|---------|-------|
| High | Transaction monitoring & smart alerts | Watch wallet for incoming/outgoing, alert via Telegram |
| High | Vector embeddings for semantic memory | Needs native bindings or WASM solution |
| Medium | FTS5 full-text search | SQL.js supports it, needs implementation |
| Medium | dApp Store listing | Pipeline exists, needs submission |
| Low | Multi-channel (Discord, WhatsApp) | Requires channel abstraction |
| Low | Multi-agent coordination | Future architecture |
| Low | Community skill marketplace | Skill distribution |

## Architecture

```
User (Telegram) <--HTTPS--> Telegram API <--polling--> Node.js Gateway (on phone)
                                                           |
                                                     Claude API (HTTPS)
                                                           |
                                                     Android Bridge (localhost:8765)
                                                           |
                                                     Android APIs (battery, GPS, SMS, camera, wallet...)

┌──────────────────────────────────────────────────┐
│              Android App (SeekerClaw)             │
│                                                    │
│  UI Activity (Compose)  <-->  Foreground Service   │
│   - Dashboard                  - Node.js Runtime   │
│   - Setup                        - OpenClaw Gateway │
│   - Logs                         - AI Agent         │
│   - Settings                     - 54 Tools         │
│                                  - SQL.js DB        │
│  Boot Receiver ──> Auto-start                      │
│  Watchdog ──> 30s health check                     │
│  Android Bridge (port 8765)                        │
│  Stats Server (port 8766)                          │
└──────────────────────────────────────────────────┘
```

## Limitations & Known Issues

- **Node 18 only** — nodejs-mobile doesn't support Node 22+, so `node:sqlite` is unavailable (using SQL.js WASM instead)
- **No vector embeddings** — Semantic memory search not possible yet (keyword search only)
- **OEM battery killers** — Xiaomi MIUI, Samsung OneUI may aggressively kill the background service; Seeker's stock Android avoids this
- **No browser/screen/canvas skills** — Can't be ported from OpenClaw (requires desktop environment)
- **Ephemeral context** — Conversation history resets on Node.js restart (mitigated by session summaries)
- **Single channel** — Telegram only (no Discord, WhatsApp, etc.)
- **dApp Store not live** — Build pipeline exists but app hasn't been submitted yet
- **No light theme** — Dark only (DarkOps single theme)

## Stats

| Metric | Count |
|--------|-------|
| Total commits | ~105 |
| PRs merged | 89+ |
| Tools | 54 (9 Jupiter tools added: limit orders, DCA, token search/security/holdings) |
| Skills | 16 |
| Android Bridge endpoints | 18+ |
| Telegram commands | 7 |
| Lines of JS (main.js) | ~7,200 |
| Lines of Kotlin | ~9,700 |
| SQL.js tables | 4 |
| Themes | 1 (DarkOps only) |

## Links

- **GitHub:** https://github.com/sepivip/SeekerClaw
- **Website:** https://seekerclaw.xyz/

## Website Mismatch Log

> Cross-reference with `SeekerClaw_Web/js/config.js`. Update when fixing mismatches.

| Website Claim | Reality | Action Needed |
|--------------|---------|---------------|
| "NFT tracking" (JSON-LD, llms.txt) | Not implemented | Remove from website |
| "DeFi automation" (OG meta, JSON-LD) | Swap tools exist, no automated DeFi | Tone down claim |
| "Get on dApp Store" button | Link is `href="#"`, not submitted | Fix link or mark "Coming Soon" |
| "OpenClaw v2026.2.12 parity" (roadmap) | Tracking v2026.2.14 | Update website version |
| "150,000+ Seeker Devices" | Market estimate, not users | Fine as-is (addressable market) |
| "Open-source" (privacy page) | Repo is public | Verify license |

## Changelog

| Date | Feature | PR |
|------|---------|-----|
| 2026-02-17 | Full Jupiter API integration — 9 tools (limit orders, DCA, token search/security/holdings) | #89 (BAT-109) |
| 2026-02-17 | Unify Settings screen green colors | #88 (BAT-108) |
| 2026-02-17 | Jupiter API key support in Settings (Wallet section) | #86 (BAT-107) |
| 2026-02-17 | Fix Jupiter quote API endpoints | #84-85 (BAT-106) |
| 2026-02-17 | Companion-tone message templates + TEMPLATES.md | #83 (BAT-105) |
| 2026-02-17 | Context-aware /start message + centralized TEMPLATES.md | #82 (BAT-104) |
| 2026-02-16 | Animations, collapsible sections & layout fixes | #81 (BAT-92) |
| 2026-02-16 | Semantic action colors (green positive, red danger) | #80 (BAT-92) |
| 2026-02-16 | telegram_send_file tool | #79 (BAT-68) |
| 2026-02-16 | Jupiter Ultra API for gasless swaps | #78 (BAT-66) |
| 2026-02-16 | Stable keys for LogsScreen performance | #77 (BAT-100) |
| 2026-02-16 | Auto-generate PLATFORM.md on startup | #76 (BAT-102) |
| 2026-02-15 | Fix emoji rendering (UTF-8 encoding) | #75 (BAT-101) |
| 2026-02-15 | Telegram formatting rules in system prompt | #74 (BAT-97) |
| 2026-02-15 | OAuth/setup token Bearer auth | #73 (BAT-98) |
| 2026-02-15 | DuckDuckGo Lite fallback for web search | #72 (BAT-99) |
| 2026-02-15 | Cache loadConfig to prevent recomposition reads | #69 (BAT-93) |
| 2026-02-15 | Fix isStarting stuck on failure | #70 (BAT-94) |
| 2026-02-14 | Fix info icon touch targets | #68 (BAT-71) |
| 2026-02-14 | Network error indicators on Dashboard | #67 (BAT-85) |
| 2026-02-14 | Haptic feedback on Setup buttons | #66 (BAT-87) |
| 2026-02-14 | Flat .md skill loading fix | #39 (BAT-61) |
| 2026-02-14 | File download race condition fix | #38 (BAT-60) |
| 2026-02-14 | SILENT_REPLY for empty responses | #37 (BAT-60) |
| 2026-02-14 | js_eval tool (in-process JavaScript) | #36 (BAT-59) |
| 2026-02-14 | Auto session summaries (idle/checkpoint/shutdown) | #35 (BAT-57) |
| 2026-02-14 | Remove node/npm/npx from shell_exec | #34 (BAT-58) |
| 2026-02-14 | File delete tool | #30 (BAT-54) |
| 2026-02-14 | Telegram file download + Claude vision | #28 (BAT-53) |
| 2026-02-14 | Sandboxed shell_exec tool | #26 (BAT-50) |
| 2026-02-14 | Bidirectional Telegram reactions | #25 (BAT-41) |
| 2026-02-13 | Web fetch: headers, method, body | #24 (BAT-42) |
| 2026-02-13 | Web fetch: markdown, caching, redirects | #23 (BAT-38) |
| 2026-02-13 | Multi-provider web search | #22 (BAT-37) |
| 2026-02-13 | API analytics + memory index UI | #20 (BAT-32/33) |
| 2026-02-13 | /stats/db-summary bridge endpoint | #19 (BAT-31) |
| 2026-02-13 | 5 missing system prompt sections | #18 (BAT-29) |
| 2026-02-13 | API usage analytics in session_status | #16 (BAT-28) |
| 2026-02-13 | SQL.js ranked memory search | #15 (BAT-27) |
| 2026-02-13 | Memory file indexing into SQL.js | #14 (BAT-26) |
| 2026-02-13 | SQL.js memory tables schema | #13 (BAT-25) |
| 2026-02-12 | Ephemeral session awareness | #12 (BAT-30) |
| 2026-02-12 | Telegram HTML blockquote rendering | #11 (BAT-24) |
| 2026-02-12 | Local timezone for all timestamps | #10 (BAT-23) |
| 2026-02-12 | User-friendly API error messages | #9 (BAT-22) |
| 2026-02-12 | Cron duplicate execution prevention | #8 (BAT-21) |
| 2026-02-12 | Rate-limit-aware throttling | #7 (BAT-18) |
| 2026-02-12 | Retry with exponential backoff | #6 (BAT-17) |
| 2026-02-12 | claudeApiCall wrapper with mutex | #5 (BAT-16) |
| 2026-02-12 | SQL.js database foundation | #4 (BAT-15) |
| 2026-02-12 | Anthropic prompt caching | #3 (BAT-14) |
| 2026-02-12 | Remove duplicate tool descriptions | #2 (BAT-13) |
