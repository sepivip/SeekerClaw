# SeekerClaw — Project Description

> **Living document.** Update after every shipped feature. Read before any feature work.

## One-Liner

SeekerClaw turns a Solana Seeker phone into a 24/7 personal AI agent you control through Telegram.

## Elevator Pitch

SeekerClaw embeds a full Node.js runtime inside an Android app, running an OpenClaw-compatible AI gateway as a foreground service. Users interact with their agent through Telegram — the app itself is minimal (setup, status, logs, settings). The agent has 56 tools, 35 skills (20 bundled + 13 workspace + 2 user-created), ranked memory search, cron scheduling, Android device control, Solana wallet integration, and web intelligence — all running locally on the phone, 24/7.

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
| AI Provider | Anthropic Claude API | Opus 4.6 default, Sonnet 4.6, Sonnet 4.5, Haiku 4.5 |
| Messaging | Telegram Bot API (grammy) | — |
| Database | SQL.js (WASM SQLite) | 1.12.0 |
| OpenClaw Parity | OpenClaw gateway (ported) | 2026.2.25 |
| Web Search | Brave Search + Perplexity Sonar | — |
| Wallet | Solana Web3.js + Jupiter API | — |
| Build | Gradle (Kotlin DSL) | — |

## Features — Shipped

### AI Agent Core
- **Claude integration** — Opus 4.6 (default), Sonnet 4.6, Sonnet 4.5, Haiku 4.5 selectable. Prompt caching, retry with backoff, rate-limit throttling, user-friendly error messages. OAuth/setup token support for Claude Pro/Max users. Conversational API key setup flow.
- **Multi-turn task execution** — Reliable P2 multi-turn: tool budget management with validation-aware restore, silent turn stop prevention on budget exhaustion, MAX_TOOL_USES=25 for complex tasks
- **API timeout hardening** — Configurable timeouts (replacing hardcoded 60s), bounded retry with backoff for timeout paths, turn-level tracing instrumentation, sanitized user-visible error messages, 429 retry jitter
- **Streaming + payload optimization** — Eliminates API transport timeouts via streaming responses, response field whitelisting to prevent payload bloat (_inputJson leak fix), MAX_HISTORY bumped 20→35 for richer context
- **Telegram owner gate** — Service refuses to start without valid TELEGRAM_OWNER_ID; unauthorized users get reaction + comment warning; all gate events logged at WARN level
- **MCP support** — Remote MCP (Model Context Protocol) servers via Streamable HTTP. Users add server URLs in Settings; agent discovers and uses tools at startup. Description sanitization, SHA-256 rug-pull detection, untrusted content wrapping, per-server + global rate limiting.
- **Telegram bot** — HTML formatting (no markdown headers), native blockquotes, bidirectional reactions, file download with vision, file upload (telegram_send_file tool), long message chunking, quoted replies via `[[reply_to_current]]`, emoji rendering fixed, companion-tone message templates (docs/internal/TEMPLATES.md), context-aware `/start`, sent message ID tracking (ring buffer, 24h TTL) + `telegram_send` tool for same-turn delete flows, contextual status messages for long-running tools (🔍 Searching..., ⚙️ Running..., etc.), inline keyboard buttons via `telegram_send` with callback query handling
- **SILENT_REPLY protocol** — Agent silently drops messages when it has nothing useful to say
- **Ephemeral session awareness** — Agent knows context resets on restart
- **PLATFORM.md auto-generation** — Device state (model, RAM, storage, battery, permissions, wallet) written on every service start
- **Self-awareness system prompt** — Self-knowledge doors, architecture blocks, self-diagnosis playbook for troubleshooting tool failures and silent responses. Debug log rotation at 5MB with `.old` archive. DIAGNOSTICS.md deep troubleshooting guide. SAB-AUDIT-v5: 100% score (36/36 audit points)
- **Structured log levels** — DEBUG/INFO/WARN/ERROR pipeline with per-level routing; UI log viewer color-coded by level; LogCollector filters noise from debug output
- **Skill routing** — Routing blocks prevent conflicting skills from firing together; reply tag first-token rule for reliable `[[reply_to_current]]` detection
- **Skill requirements gating** — Skills with `requires.bins` or `requires.env` in YAML frontmatter are checked at runtime; unmet requirements are reported and skill is skipped

### Memory System
- **SOUL.md** — Agent personality (user-editable)
- **IDENTITY.md / USER.md** — Agent and owner profiles (created during bootstrap)
- **MEMORY.md** — Long-term memory via `memory_save` tool
- **Daily notes** — `memory/YYYY-MM-DD.md` files via `daily_note` tool
- **SQL.js memory search** — Files indexed into chunks with TF + recency ranked search
- **HEARTBEAT.md** — Real agent probe heartbeat with configurable interval (not overwritten by app)
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
- **Shell exec** — 33 sandboxed commands including Android tools (cat, ls, curl, grep, find, sed, diff, screencap, getprop, etc.), workspace-restricted
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
| `/help` | List available commands |
| `/status` | System status |
| `/new` | Save summary, clear conversation |
| `/reset` | Clear conversation (no summary) |
| `/soul` | Show personality |
| `/memory` | Show long-term memory |
| `/skills` | List installed skills |
| `/version` | Show app/OpenClaw/Node versions |
| `/logs` | Show recent debug log entries |
| `/approve` | Approve pending confirmation |
| `/deny` | Deny pending confirmation |

### Skills (20 bundled + 13 workspace, version-aware seeding)
**Bundled skills (OpenClaw format, seeded by ConfigManager.kt with SHA-256 integrity + version tracking):** bookmark, briefing, calclaw (AI calorie tracker), calculator, crypto-prices, define, github, joke, movie-tv, netwatch (network monitoring & security audit), news, notes, quote, reminders, research, summarize, timer, todo, translate, weather
**Workspace skills (agent-usable examples):** crypto-prices, device-status, dictionary, exchange-rates, github, location, movie-tv, phone-call, recipe, sms, solana-dapp, solana-wallet, speak
**Skill format:** YAML frontmatter (name, description, version, emoji, requires) — see `SKILL-FORMAT.md`
**Skill install** — `skill_install` tool to install skills from URL or Telegram file attachment, with diagnostics via `/skills` command

### Security
- **Prompt injection defense** — Content Trust Policy in system prompt, `<<<EXTERNAL_UNTRUSTED_CONTENT>>>` boundary markers on all web_fetch/web_search results, 10-pattern suspicious content detection, Unicode homoglyph sanitization, zero-width space normalization
- **Skill file protection** — Writes/edits to `skills/` blocked when suspicious injection patterns detected in content
- **Tool confirmation gates** — `android_sms`, `android_call`, `solana_send`, `solana_swap`, `jupiter_trigger_create`, `jupiter_dca_create` require explicit user YES via Telegram before execution. 60s timeout auto-cancels. Rate limited (SMS/call 1 per 60s, Solana 1 per 15s, Jupiter 1 per 30s)
- **Jupiter API hardening** — 7 fixes from official skill audit (BAT-151-157): no retry for non-idempotent POSTs, amount validation, slippage bounds, error message sanitization
- **Secrets blocklist** — `config.json`, `config.yaml`, `seekerclaw.db` blocked from `read` tool (with symlink resolution) and `js_eval` fs access (proxied `fs`/`fs.promises` modules)
- **ALT-safe swap verification** — `verifySwapTransaction()` rejects instructions referencing programs via Address Lookup Tables (prevents drainer bypass)
- **js_eval sandbox** — blocked modules (child_process, vm, etc.), restricted fs (read/write/copy guards on sensitive files), shadowed `process`/`global`/`globalThis`
- API key redaction in logs
- Path traversal prevention (workspace sandboxing)
- Shell command allowlist (no rm, kill, etc.)
- Bridge token authentication
- Swap transaction verification (checks payer, programs, signers)

### App (Android)
- **Single theme** — DarkOps (dark navy + crimson red + green status), 12dp corners
- **Setup wizard** — QR scan or manual API key entry, OAuth/setup token support, haptic feedback
- **Dashboard** — Status with pulse animation (running) + dimming (stopped), uptime, message stats, active uplinks, mini terminal, API health monitoring (green/amber/red), dismissible error/network banners, deploy button disabled state when config incomplete
- **Logs viewer** — Color-coded, auto-scrolling monospace, stable keys for performance
- **Settings** — Collapsible sections with animation, grouped Anthropic & Telegram settings, edit config with masked fields, required field indicators (*), model dropdown, auto-start, battery optimization, export/import (allowlist-based, size-capped, auto-backup before import), wallet copy button, MCP server management (add/edit/remove/toggle), visual escalation for danger zone, semantic action colors (green positive, red danger), accessibility content descriptions on all icons, permission revoke dialog on granted toggles
- **Skills tab** — Installed skills list with search, skill detail view, marketplace teaser
- **System screen** — API usage stats, memory index status, colored accent borders on stat cards
- **Foreground service** — START_STICKY with wake lock, boot receiver, watchdog (30s health check), heartbeat end-to-end probe
- **Open-source ready** — MIT license, CONTRIBUTING.md, issue/PR templates, GitHub Actions CI + release workflows, Firebase Analytics build-optional, product flavors (full w/ Firebase + FOSS without)

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
│   - Settings                     - 56 Tools         │
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
| Total commits | 311 |
| PRs merged | 191 |
| Tools | 56 (9 Jupiter, 13 Android bridge, web search/fetch, memory, cron, skill_install, etc.) + MCP dynamic |
| Skills | 35 (20 bundled + 13 workspace + 2 user-created) |
| Android Bridge endpoints | 18+ |
| Telegram commands | 12 |
| Lines of JS | ~12,600 (main.js + 15 extracted modules) |
| Lines of Kotlin | ~12,500 |
| SQL.js tables | 4 |
| Themes | 1 (DarkOps only) |

## Links

- **GitHub:** https://github.com/sepivip/SeekerClaw
- **Website:** https://seekerclaw.xyz/
- **X/Twitter:** https://x.com/SeekerClaw
- **Telegram:** https://t.me/seekerclaw

## Website Sync

> **`docs/internal/WEBSITE.md`** is the staging area for website content updates.
> It contains curated, accurate content with editorial review comments.
> Good-morning skill keeps it in sync with PROJECT.md.
>
> **Workflow:** PROJECT.md (source of truth) → `docs/internal/WEBSITE.md` (curated staging) → `config.js` + `index.html` (live website)

### Pending Deployment (docs/internal/WEBSITE.md → config.js)

| WEBSITE.md Content | config.js Status | Action |
|-------------------|-----------------|--------|
| Stats: 56+ tools, 182+ PRs | Shows 43+ tools, 78+ commits | Update config.js stats[] |
| Roadmap: 10 shipped items | Shows 10 items (outdated list) | Update roadmap.columns[0] |
| Feature cards: updated descriptions | Stale descriptions | Update features.items[] + index.html |
| "NFT tracking" in JSON-LD | Not implemented | Remove from index.html |
| "DeFi automation" in OG meta | Swap tools only, no automation | Tone down in index.html |
| dApp Store button href="#" | Not submitted yet | Fix link or mark "Coming Soon" |
| "Open-source" (privacy page) | Repo is public | Verify license |

## Changelog

| Date | Feature | PR |
|------|---------|-----|
| 2026-02-27 | Chore: add Ko-fi funding option | direct |
| 2026-02-26 | Feat: add Google Play AAB build with product flavors (full/foss) | direct |
| 2026-02-26 | Docs: add safety disclaimer to README, document product flavors in CLAUDE.md | direct |
| 2026-02-25 | Fix: persist owner ID across restarts — .apply() → .commit() (BAT-270) | #191 |
| 2026-02-25 | Chore: update setup URL from /quick-setup to /setup | #190 |
| 2026-02-25 | Fix: set MWA blockchain to Solana.Mainnet instead of default Devnet (BAT-269) | #189 |
| 2026-02-25 | Fix: bootstrap ritual stops after 2 questions (BAT-268) | #188 |
| 2026-02-25 | Fix: restore owner ID auto-detect (BAT-267) | #187 |
| 2026-02-25 | Fix: bootstrap ritual not triggering on first run (BAT-266) | #186 |
| 2026-02-25 | Feat: add official SeekerClaw socials to agent identity (BAT-263) | #185 |
| 2026-02-25 | Chore: bump OpenClaw reference to 2026.2.25 | direct |
| 2026-02-25 | Docs: create README.md + screenshots for open-source launch (BAT-265) | #184 |
| 2026-02-25 | Chore: move internal docs to docs/internal/ for open-source prep (BAT-264) | #183 |
| 2026-02-25 | Docs: update PROJECT.md with recent changes and commit count | direct |
| 2026-02-25 | Fix: replace seekerclaw.dev with seekerclaw.xyz everywhere | direct |
| 2026-02-25 | CI: add GOOGLE_SERVICES_JSON secret for Firebase in CI builds | direct |
| 2026-02-25 | Chore: remove unused publishing/, scripts/, web-prototype/ directories | direct |
| 2026-02-25 | CI: fix release workflow signing + changelog extraction, bump v1.4.1 | direct |
| 2026-02-25 | Docs: add SKILL-CREATOR.md spec + update project docs | direct |
| 2026-02-24 | Docs: SAB-AUDIT-v5 report (100% score, 36/36 audit points) | direct |
| 2026-02-24 | Fix: remove stale battery info from PLATFORM.md (BAT-262) | #182 |
| 2026-02-24 | Feat: expand agent capabilities — app launch, screencap, shell tools (BAT-261) | #181 |
| 2026-02-24 | Fix: move camera captures to workspace for Telegram send (BAT-260) | #180 |
| 2026-02-24 | Feat: bump MAX_TOOL_USES 15→25 + add SAB section to WEBSITE.md | direct |
| 2026-02-24 | Feat: SAB-AUDIT-v4 — diagnostic coverage section + DIAGNOSTICS.md | direct |
| 2026-02-24 | Docs: OpenClaw parity 2026.2.23 — 660 commits reviewed, nothing to port | direct |
| 2026-02-23 | Chore: open-source prep — LICENSE, CONTRIBUTING.md, issue/PR templates, CI/release workflows | direct |
| 2026-02-23 | Feat: eliminate API transport timeouts — streaming + payload optimization (BAT-259) | #179 |
| 2026-02-23 | Feat: make Firebase Analytics build-optional for open-source (BAT-258) | #178 |
| 2026-02-23 | Chore: bump MAX_HISTORY 20→35, fix stale system prompt constants | direct |
| 2026-02-23 | Fix: whitelist streaming response fields to prevent _inputJson leak | direct |
| 2026-02-23 | Docs: slim CLAUDE.md from 627→213 lines — quick-reference only | direct |
| 2026-02-22 | Feat: OpenClaw parity 2026.2.22 — status reactions, cron hardening (BAT-256) | #177 |
| 2026-02-22 | Fix: Console logs intermittently empty — thread safety + filter persistence (BAT-257) | #176 |
| 2026-02-22 | Fix: Jupiter audit top-5 fixes — BigInt precision, balance pre-check, confirmation gates (BAT-255) | #175 |
| 2026-02-22 | Feat: P2 reliable multi-turn task execution | #174 |
| 2026-02-21 | Feat: fix silent turn stops on tool budget exhaustion (BAT-161) | #173 |
| 2026-02-21 | Fix: sanitize user-visible timeout errors + 429 retry jitter (BAT-253) | #172 |
| 2026-02-21 | Docs: P1 timeout reliability validation guide (BAT-247) | #171 |
| 2026-02-21 | Feat: harden tool_use/tool_result integrity + sanitizer diagnostics (BAT-246) | #170 |
| 2026-02-21 | Feat: add bounded retry/backoff for Claude API timeout path (BAT-245) | #169 |
| 2026-02-21 | Feat: make API timeout configurable — replace hardcoded 60s (BAT-244) | #168 |
| 2026-02-21 | Feat: add runtime timeout instrumentation with turn-level tracing (BAT-243) | #167 |
| 2026-02-21 | Fix: NetWatch dns probe crash in js_eval sandbox (BAT-241) | #166 |
| 2026-02-21 | Feat: compact TL;DR default for NetWatch reports (BAT-240) | #165 |
| 2026-02-21 | Fix: NetWatch deep-scan — remove banner grab, enforce 8s timeout (BAT-239) | #164 |
| 2026-02-21 | Fix: replace shell_exec ping/curl with js_eval probes in NetWatch (BAT-238) | #163 |
| 2026-02-21 | Feat: polish NetWatch for Android sandbox + Telegram-first UX (BAT-237) | #162 |
| 2026-02-21 | Feat: conversational API key support (BAT-236) | #161 |
| 2026-02-21 | Fix: remove config.json/config.yaml mentions from agent prompt (BAT-235) | #160 |
| 2026-02-21 | Feat: close final SAB gaps — PLATFORM.md door and Telegram polling (BAT-234) | #159 |
| 2026-02-21 | Feat: add self-diagnosis playbook to system prompt (BAT-233) | #158 |
| 2026-02-21 | Feat: add self-knowledge doors and architecture to system prompt (BAT-232) | #156 |
| 2026-02-20 | Feat: enforce skill requirements gating at runtime (BAT-230) | #155 |
| 2026-02-20 | Fix: suppress false trigger warning for YAML frontmatter skills | #154 |
| 2026-02-20 | Feat: add netwatch skill — network monitoring and security audit | #153 |
| 2026-02-20 | Feat: show revoke dialog when tapping granted permission toggles (BAT-223) | #152 |
| 2026-02-20 | Fix: write agent health file immediately on startup (BAT-222) | #151 |
| 2026-02-20 | Fix: rename misleading Heartbeat debug log to [Runtime] (BAT-221) | #150 |
| 2026-02-20 | Fix: prevent duplicate [Health] logs from multi-process polling (BAT-217) | #149 |
| 2026-02-20 | Feat: Telegram slash commands — /help, /status, /skill, /version, /logs, /approve, /deny (BAT-211) | #148 |
| 2026-02-20 | Fix: remove updateHeartbeat() — was overwriting agent HEARTBEAT.md every 5 min (BAT-220) | #147 |
| 2026-02-20 | Fix: owner gate hardening — block service start, reaction comment, WARN log (BAT-219) | #146 |
| 2026-02-20 | Fix: cache hit rate denominator uses total tokens not just non-cached (BAT-218) | #145 |
| 2026-02-20 | Fix: deduplicate health transition logs at startup (BAT-217) | #144 |
| 2026-02-20 | Fix: remove cost metrics from all UI surfaces (BAT-216) | #143 |
| 2026-02-20 | Feat: heartbeat end-to-end — real agent probe + configurable interval (BAT-215) | #142 |
| 2026-02-20 | Polish: settings order, brave hint text, onboarding color (BAT-214) | #141 |
| 2026-02-20 | Feat: skills diagnostics + console filter button fix (BAT-213) | #140 |
| 2026-02-20 | Fix: remove duplicate version field from bundled skill frontmatter (BAT-212) | #139 |
| 2026-02-20 | Feat: Skills tab — installed skills list with search and marketplace teaser (BAT-205) | #138 |
| 2026-02-20 | Fix: skill_install early-return race and YAML triggers not parsed (BAT-210) | #137 |
| 2026-02-20 | Feat: skill_install tool — install skills from URL or Telegram attachment (BAT-209) | #136 |
| 2026-02-19 | Fix: setup token session expiry + rate-limit tracking | #135 |
| 2026-02-19 | Fix (P0): loadSkills import crash, conversation corruption, usage poll spam | #134 |
| 2026-02-19 | Feat: structured log levels — DEBUG/INFO/WARN/ERROR pipeline with per-level routing (BAT-206) | #133 |
| 2026-02-19 | Chore: prune 36 dead exports, fix silent catches, add ARCHITECTURE.md (BAT-205) | #132 |
| 2026-02-19 | Refactor: extract tools.js from main.js (BAT-204) | #131 |
| 2026-02-19 | Refactor: extract claude.js from main.js (BAT-203) | #130 |
| 2026-02-19 | Refactor: extract solana.js from main.js (BAT-201) | #129 |
| 2026-02-19 | Refactor: extract database.js from main.js (BAT-202) | #128 |
| 2026-02-19 | Refactor: extract cron.js from main.js (BAT-200) | #127 |
| 2026-02-19 | Refactor: extract 7 modules from main.js (config, security, bridge, telegram, web, memory, skills) (BAT-193–199) | #120–126 |
| 2026-02-19 | Fix wallet cold-start rejection + expand Jupiter trusted programs | direct |
| 2026-02-19 | Fix OOM crash in LogCollector — tail-only file reading | direct |
| 2026-02-19 | Fix Jupiter API v2 field mismatches + silent response edge cases | direct |
| 2026-02-18 | Inline keyboard buttons for Telegram messaging (BAT-191) | #119 |
| 2026-02-18 | Debug log self-diagnosis + log rotation (BAT-190) | #118 |
| 2026-02-18 | Skill routing blocks + reply tag first-token rule (BAT-189) | #117 |
| 2026-02-18 | Harden memory export/import — allowlist, size cap, auto-backup, path traversal prevention (BAT-188) | #116 |
| 2026-02-18 | Remote MCP server support — Streamable HTTP client, Settings UI, security hardening (BAT-168) | #115 |
| 2026-02-18 | Add Sonnet 4.6 model + refresh settings info texts | direct |
| 2026-02-18 | Keep typing indicator alive during Claude API calls | #114 |
| 2026-02-18 | Align tool status messages with spec (BAT-150) | #113 |
| 2026-02-18 | Remove AD_ID permission merged from dependencies (BAT-166) | #112 |
| 2026-02-18 | Add CalClaw AI calorie tracking skill (BAT-167) | #111 |
| 2026-02-18 | Unify skill seeding from asset files (BAT-165) | #110 |
| 2026-02-18 | Version-aware skill seeding with manifest tracking (BAT-162) | #109 |
| 2026-02-18 | Standardize skill format spec with version field (BAT-164) | #108 |
| 2026-02-18 | skill_read returns dir and files for bundled resources (BAT-163) | #107 |
| 2026-02-18 | Fix word boundary matching for skill triggers (BAT-161) | #106 |
| 2026-02-18 | Rewrite YAML frontmatter parser for full OpenClaw compatibility (BAT-160) | #105 |
| 2026-02-18 | Update agent self-awareness for Jupiter hardening changes | #104 |
| 2026-02-18 | Jupiter API hardening — 7 fixes from official skill audit (BAT-151-157) | #103 |
| 2026-02-18 | Git-track 13 bundled agent skills (BAT-159) | #102 |
| 2026-02-18 | Dismissible banners + deploy button disabled state (BAT-138) | #101 |
| 2026-02-18 | Required field indicators + wallet copy button (BAT-137) | #100 |
| 2026-02-18 | Accessibility — content descriptions, touch targets, animation scale (BAT-136) | #99 |
| 2026-02-18 | Replace hardcoded colors with theme tokens (BAT-135) | #98 |
| 2026-02-17 | Extract settings info texts to centralized SettingsHelpTexts.kt constants | #97 (BAT-139) |
| 2026-02-17 | Agent health dashboard — API error state detection, visual indicators (green/amber/red), error banners | #96 (BAT-134) |
| 2026-02-17 | Fix 6 broken Jupiter tools — correct API fields, MWA signing, BigInt precision, query params | #95 (BAT-113) |
| 2026-02-17 | Wallet & secrets hardening — ALT bypass fix, read blocklist, js_eval sandbox | #94 (BAT-115) |
| 2026-02-17 | Tool confirmation gates — YES/NO for SMS, call, Jupiter orders + rate limiting | #93 (BAT-114) |
| 2026-02-17 | Prompt injection defense — content wrapping, trust policy, pattern detection, skill protection | #92 (BAT-112) |
| 2026-02-17 | Contextual status messages for long-running tool calls (Layer 2 typing indicator) | #91 (BAT-110) |
| 2026-02-17 | Sent message ID tracking + telegram_send tool for reliable deletion | #90 (BAT-111) |
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
