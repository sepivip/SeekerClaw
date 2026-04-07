# Changelog

All notable changes to SeekerClaw are documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/).

## [1.9.0] - 2026-04-07

### Added
- **OpenAI Codex OAuth** — sign in with a ChatGPT Plus/Pro subscription instead of a platform API key. Browser PKCE flow, Keystore-encrypted token storage, automatic token refresh, per-provider auth-type memory across provider switches (BAT-485, #316)
- **Discord channel** — run the agent on Discord as an alternative to Telegram. Gateway v10 WebSocket, full media/reactions/reply threading, channel abstraction layer so future channels plug in cleanly (BAT-483, #310)
- **Custom AI Provider** — connect any OpenAI-compatible gateway (DeepSeek, Ollama, LiteLLM, etc.) via a base URL, API key, custom headers, and a model ID. Supports both Chat Completions and OpenAI Responses formats (BAT-482, #309)

### Fixed
- **Google Play SMS hotfix** — `android_sms` on the googlePlay flavor now uses an intent handoff instead of `SEND_SMS` permission, unblocking Play Store submission (BAT-484, #312) *(also tagged as v1.8.1)*
- **Codex SSE parsing** — handle missing Content-Type header from chatgpt.com
- **Web search provider reporting** — agent now knows which search backend actually ran when called with `provider: "auto"`
- **Dashboard credential check** — OpenAI OAuth users now see a green pill instead of "Credential missing"
- **Sign Out button color** — uses ActionDanger red for consistency with Reset/Wipe

### Changed
- **Settings layout** — Quick Setup moved up, MCP Servers extracted to its own screen (#313)
- **Renamed user-visible "OpenClaw service" → "Claw Engine"** in log messages and Settings/System About rows
- **Provider switching is now atomic** — batched into a single `saveConfig` call instead of 2–3 sequential writes. Noticeably snappier on Seeker flash
- **Agent self-knowledge** — added OpenAI OAuth Provider block, OAuth Self-Diagnosis playbook, and OAuth sections in `DIAGNOSTICS.md` (SAB-AUDIT-v19)

### Security
- **OAuth tokens never touch disk in plaintext** — persisted directly via `ConfigManager` (Android Keystore), result files carry only status flags (RFC 6819 §5.1.4, OWASP MASVS-STORAGE-1)
- **`config.js` strict authType validation** — hard-fails on unsupported values for the OpenAI provider, with legacy-alias migration so older installs don't crash
- **OAuth callback listener** binds to `localhost` only (not all network interfaces)
- **`requestId` Intent extra** validated against a strict UUID regex (path-traversal defense)

## [1.8.0] - 2026-03-30

### Added
- **Search Provider System** — choose from 5 web search providers: Brave, Perplexity, Exa, Tavily, Firecrawl (BAT-481)
- **Quick Actions** — `/quick` command with inline keyboard buttons (#295)
- **Multi-provider setup wizard** — pick provider first, model second, Telegram last (BAT-478)
- **Multi-provider QR import** — supports OpenAI and OpenRouter credentials (BAT-471)
- **Loop detection** — detects repeated tool call patterns, 3 warnings then breaks at 5 (BAT-474)
- **Context summarization** — summarizes oldest messages at 85% context usage instead of dropping them (BAT-475)
- **Memory scrubbing** — strips tool narration, file uploads, temp paths from memory saves (BAT-474)
- **Dashboard animations** — smooth AnimatedVisibility for status banners (BAT-479)
- **Git SHA in debug builds** — System screen shows commit hash for debugging
- **Shared UI components** — 9 reusable composables: TopAppBar, SectionLabel, CardSurface, InfoRow, ConfigField, InfoDialog, Scaffold, Switch (#306, #307, #308)
- **UI/UX audit polish** — onboarding flow, terminology, settings consolidation (BAT-476)
- **Restart prompt** — app prompts restart when provider, model, or API key changes (BAT-468)

### Fixed
- **Heartbeat status leaks** — port ackMaxChars from OpenClaw, suppress filler text alongside HEARTBEAT_OK (#302)
- **Heartbeat conversation isolation** — probes no longer pollute user conversation history (#298)
- **Repetition detector** — catches degenerate model output before Telegram send (#300)
- **Logs toggle color** — was red, now green matching all other toggles
- **System screen back arrow** — standardized to M3 TopAppBar
- **HorizontalDivider colors** — standardized to CardBorder across all screens
- **Setup credential preservation** — switching providers no longer wipes API keys (BAT-478)
- **Banner spacing** — dashboard cards properly spaced from banners (BAT-479)
- **Step indicator labels** — no longer truncate on narrow screens (BAT-478)
- **Poll timeout logs** — downgraded from ERROR to DEBUG (no longer alarming in logs)
- **Dead ProGuard rule** — removed unused rule, fixed incorrect GitHub URLs

### Security
- **js_eval sandbox** — Function constructor shadows, sensitive path blocking, output redaction (BAT-466)
- **Emulator IP gate** — 10.0.2.2 restricted to DEBUG builds only (BAT-467)

### Changed
- `main.js` split into focused modules — `message-handler.js` extracted (#296, #303)
- `claude.js` renamed to `ai.js` (provider-agnostic naming)
- Tools refactored into 12 modular files under `tools/` (BAT-470)
- RestartDialog extracted as shared component (BAT-469)
- Deferred tool loading disabled — free OpenRouter models leak raw XML (BAT-475)
- UI components consolidated: ~500 lines removed across 10 files

## [1.7.0] - 2026-03-19

### Added
- **OpenRouter provider** — access 100+ models through a single endpoint with prompt caching, model fallbacks, and freeform model input (BAT-447)
- **Cron reliability improvements** — ported from OpenClaw: zombie detection, missed job recovery, atomic file writes (BAT-461)

### Fixed
- Setup token now works with Sonnet 4.6 and Opus 4.6 — billing attribution fix (BAT-460)
- Dashboard metrics relabeled as "Device Memory" / "Device Storage" for honesty (BAT-463)
- Added "Last message: Xm ago" to Telegram connection status (BAT-463)
- Added App Storage breakdown: Workspace, Database, Logs, Runtime (BAT-463)
- API Limits no longer shows bogus "100% left" when usage data is unavailable (BAT-464)
- System screen Material Design polish: M3 spacing tokens, removed decorative accent bars (BAT-464)
- Settings screen: merged Preferences + Permissions sections, renamed to "AI Configuration", collapsible state preserved across tabs (BAT-459)
- Removed dead OAuth usage polling that caused repeated 429 errors in logs and confused agent into reporting phantom issues (BAT-465)

## [1.6.1] - 2026-03-14

### Added
- **Button styling** — telegram_send buttons support "destructive" (red) and "primary" (blue) colors via Telegram Bot API 9.4 (BAT-439)
- **Analytics opt-out** — toggle in Settings to disable usage analytics

### Fixed
- **Session auto-save** — never worked since provider system shipped; empty system prompt block caused Claude API 400 on every attempt (BAT-448)
- **Vision analysis** — same empty prompt block bug broke image analysis
- Bridge rate limiting for /contacts/add endpoint

### Security
- JSON injection fix + bridge rate limiting

## [1.6.0] - 2026-03-10

### Added
- **NFT Holdings** — view NFTs (including compressed/cNFTs) in any Solana wallet via Helius DAS API (BAT-319)
- **Cron agent turns** — scheduled jobs can now run full AI turns, not just reminders (BAT-326)
- **Temporal context** — agent session awareness with conversation summaries for continuity (BAT-322)
- **OpenClaw 2026.3.8 parity** — 4 upstream features ported (BAT-359)

### Fixed
- Heartbeat chat pollution suppressed when nothing needs attention
- Background API calls no longer pollute health status display
- Tool confirmation gates enforce proper YES/NO flow for dangerous actions
- Solana address validation strengthened across all wallet tools
- SHA-256 verification + Zip Slip guard for nodejs-mobile asset extraction
- SILENT_REPLY now properly logged in audit trail

### Security
- Gitignore patterns updated to prevent accidental key commits
- R8/ProGuard hardened for release builds

## [1.4.1] - 2026-02-25

**First public release.** Everything below shipped across v1.0.0–v1.4.1 (293 commits, 185 PRs).

### Core
- **On-device AI agent** — Claude (Opus / Sonnet / Haiku) running 24/7 as an Android foreground service via embedded Node.js (nodejs-mobile, Node 18 LTS ARM64)
- **56 tools** — file I/O, shell exec, web search/fetch, device sensors, Solana transactions, MCP remote tools, and more
- **35 skills** — bundled YAML-frontmatter skills with semantic trigger routing, plus install-from-URL and Telegram file attachment
- **Multi-turn tool use** — up to 25 tool-call rounds per conversation turn with per-round checkpoints and crash-safe resume
- **Prompt caching** — reduces cost and latency on repeated context across Claude API calls

### Telegram
- Full bot integration — reactions, inline keyboards, file send/download, blockquote rendering, typing indicators
- 12 slash commands — /help, /version, /logs, /approve, /deny, and more
- File sharing with Claude vision (send an image, agent sees it)
- Owner-gate hardening — blocks service start without valid Telegram owner ID

### Solana
- **Jupiter DEX** — swaps, quotes, limit orders, DCA via Jupiter Ultra API with sign-only MWA flow
- **Mobile Wallet Adapter** (MWA) integration for on-device transaction signing
- Wallet & secrets protection with encrypted credentials store (Android Keystore, AES-256-GCM)

### Device Control
- **Android Bridge** — local HTTP bridge exposing battery, storage, network, GPS, camera, SMS, calls, clipboard, TTS, contacts, app launch/listing
- **Screenshots** — agent captures screen via `screencap -p`
- **34 shell commands** in sandboxed allowlist (ls, cat, grep, find, curl, wget, sed, diff, base64, screencap, and more)
- **Boot receiver** — auto-start agent after device reboot
- **Watchdog** — 30s health checks with auto-restart on unresponsive Node.js

### Intelligence
- **Persistent memory** — daily notes, personality, ranked keyword search across memory files (SQL.js backed)
- **Web search** — Brave, DuckDuckGo, Perplexity with zero-config DDG fallback
- **Web fetch** — markdown conversion, caching, redirect handling
- **Cron/scheduling** — one-shot or recurring jobs with natural language time parsing ("remind me in 30 min")
- **Remote MCP servers** — add external tool providers via Streamable HTTP (JSON-RPC 2.0)
- **Auto session summary** — agent saves memory before session dies
- **Ephemeral session awareness** — agent knows when Node.js restarted mid-conversation

### Security
- Prompt injection defense with content trust scoring
- Tool confirmation gates (YES/NO for dangerous actions)
- Secrets blocked from agent access (config files, database)
- js_eval sandbox for in-process code execution
- Setup-token authentication for initial configuration

### Android App
- **Jetpack Compose + Material 3** — DarkOps theme (dark navy + crimson + green)
- **6 screens** — Setup (QR scan + manual entry), Dashboard (status/uptime/stats), Logs (searchable monospace viewer), Settings (config editor), Skills (browse + diagnostics), System
- **Redesigned onboarding** — branded cards, step indicator, themed QR scanner, success screen
- Haptic feedback, network offline banner, loading states, navigation transitions
- Log viewer with text search/filter, export/share, structured log levels (DEBUG/INFO/WARN/ERROR)
- Agent health dashboard with real heartbeat probes
- WCAG AA text contrast, 48dp touch targets

### Architecture
- **14 focused Node.js modules** — main, claude, tools, solana, telegram, memory, skills, cron, web, database, security, bridge, config, mcp-client (refactored from 6,924-line monolith)
- **API resilience** — retry with exponential backoff on 429/529, rate-limit-aware throttling, centralized API wrapper with mutex
- **Firebase Analytics** build-optional — build succeeds without google-services.json
- **OpenClaw parity** synced to v2026.2.25 (reviewed 936+ upstream commits)

### Open Source
- MIT license
- README with screenshots and architecture diagram
- CONTRIBUTING.md, SECURITY.md, issue/PR templates
- GitHub Actions CI (build on push) + release workflow (tag → signed APK → GitHub Release)
- CHANGELOG, DIAGNOSTICS.md, SAB self-awareness audit (111/111, 100%)

## [1.3.0] - 2026-02-20

### Added
- **Telegram slash commands** — /help, /version, /logs, /approve, /deny for in-chat control
- **Netwatch** bundled skill — network monitoring and security audit
- **Skill requirements gating** — skills with `requires.bins`/`requires.env` checked at runtime, unmet deps reported
- **Permission revoke dialog** — tapping granted permission toggles in Settings shows system revoke dialog
- **Skills tab** — browse installed skills with search and marketplace teaser
- **Skill install tool** — install skills from URL or Telegram file attachment
- **Skills diagnostics** panel for debugging skill loading issues
- **Structured log levels** — DEBUG/INFO/WARN/ERROR pipeline with console filter button
- **Real heartbeat probes** — end-to-end agent health check with configurable interval
- **Owner gate hardening** — block service start without valid Telegram owner ID, reaction-based auth feedback
- **OpenClaw parity** sync to v2026.2.20

### Fixed
- Agent health file now written immediately on startup (was delayed)
- False trigger warning for YAML frontmatter skills suppressed
- Misleading "Heartbeat" debug log label renamed to [Runtime]
- Duplicate [Health] logs from multi-process polling eliminated
- Agent HEARTBEAT.md no longer overwritten every 5 minutes by the app
- Duplicate health transition logs at startup eliminated
- Prompt cache hit rate now uses total tokens as denominator (was under-reporting)
- Skill install race condition where early return skipped YAML trigger parsing
- Setup token session expiry and rate-limit tracking
- Critical P0: conversation corruption + usage poll spam
- Wallet cold-start rejection on first launch
- OOM crash in LogCollector when reading large log files
- Material 3 compatibility (replaced PullToRefreshBox with plain Box)
- Duplicate `version` field in bundled skill frontmatter

### Changed
- **Major architecture refactor** — split monolithic `main.js` into 11 focused modules: config, security, bridge, web, telegram, memory, skills, cron, database, solana, claude, tools
- Pruned 36 dead exports and fixed silent error catches
- Removed cost metrics from all UI surfaces
- Reordered Settings sections, improved Brave search hint text, refined onboarding colors

## [1.2.0] - 2026-02-10

### Added
- **Remote MCP servers** — add external tool providers via Streamable HTTP (JSON-RPC 2.0) with rate limiting and rug-pull detection
- **DuckDuckGo search** — zero-config default web search with DDG Lite fallback (no API key needed)
- **Jupiter DEX integration** — 9 swap/quote/limit-order tools, API key management, Ultra API with sign-only MWA flow
- **Telegram enhancements** — inline keyboard buttons, file send/delete, bidirectional reactions, file download with Claude vision, blockquote rendering
- **New agent tools** — sandboxed shell exec, in-process js_eval, file delete, web fetch with markdown/caching/redirects, multi-provider web search
- **SQL.js database** — request logging, memory file indexing, ranked keyword search across memory
- **Prompt caching** for Claude API calls (reduces cost and latency on repeated context)
- **API resilience** — retry with exponential backoff on 429/529, rate-limit-aware throttling, centralized API call wrapper with mutex
- **Auto session summary** — agent saves memory before session dies
- **Ephemeral session awareness** — agent knows when Node.js restarted mid-conversation
- **User-friendly API errors** — classified error messages instead of raw status codes
- **Cron/scheduling system** — create one-shot or recurring jobs with natural language time parsing
- **Security hardening** — prompt injection defense, tool confirmation gates (YES/NO for dangerous actions), wallet & secrets protection, js_eval sandbox
- **Agent health dashboard** — detects API error states and shows health indicators
- **Contextual status messages** for long-running tool calls
- **CalClaw** bundled skill — AI calorie tracking via Telegram
- **13 bundled agent skills** (git-tracked) with YAML frontmatter, version-aware seeding
- **Sonnet 4.6** model added to model picker
- **Redesigned onboarding** — branded cards, step indicator, themed QR scanner, pre-permission notification explanation, success screen
- **Log viewer improvements** — text search/filter, export/share via system share sheet, increased font size
- **UI polish** — haptic feedback, network offline banner, loading states, navigation fade transitions, semantic color roles, animations, collapsible settings sections
- **Smart /start message** — context-aware welcome with centralized message templates
- **Run Setup Again** option in Settings
- **PLATFORM.md** auto-generated on startup with device info
- **OpenClaw parity** updates v2026.2.12–2026.2.14, full YAML frontmatter parser, skill routing blocks

### Fixed
- Jupiter API endpoints corrected across multiple iterations
- Shell exec PATH resolution on Android (3 rounds of fixes)
- File download race condition on mobile networks
- Silent response handling (SILENT_REPLY protocol)
- Cron job re-fire and duplicate execution prevention
- Timestamps now use local timezone with UTC offset
- Typing indicator stays alive during long Claude API calls
- Removed AD_ID permission leaked from dependencies
- LazyColumn key duplication crash in Logs screen
- Emoji rendering in Telegram (UTF-8 encoding fix)
- Setup token authentication (Bearer auth)
- Config recomposition thrashing (cached reads)
- Touch targets expanded to 48dp minimum (accessibility)
- Text contrast improved to WCAG AA compliance
- Memory WIPE now requires typing confirmation
- Navigation after config reset correctly returns to Setup
- Skill trigger matching uses word boundaries (no partial matches)

### Changed
- **DarkOps is now the only theme** — removed Terminal, Pixel, and Clean themes
- Replaced hardcoded colors with theme tokens throughout
- Upgraded Gradle 8.10.2 → 8.13 and AGP 8.7.3 → 8.13.2
- Model picker uses aliases (`claude-sonnet-4-6`) instead of snapshot IDs
- Settings info texts extracted to centralized constants
- Replaced broken Canvas logo with proper SVG vector drawable
- Solana swap migrated from v6 to Jupiter Ultra API

### Removed
- Firebase Analytics (all metrics are now local-only)
- Dead theme code (Terminal, Pixel, Clean)
- Duplicate tool descriptions from system prompt

## [1.1.0] - 2026-02-08

### Added
- **Jupiter DEX** initial integration with SOUL.md personality template
- **Cron job delivery** system ported from OpenClaw
- **Brave Search** API key support for web search
- **App versioning** centralized in `build.gradle.kts` (BuildConfig fields)
- Claude account rate-limit handling and reply context tracking
- Wallet connection timeout handling
- Separate encrypted credentials store

### Changed
- Ported OpenClaw 2026.2.9 stability fixes

## [1.0.0] - 2026-02-03

### Added
- **Android app shell** — Jetpack Compose with Material 3, dark-only theme
- **4 screens** — Setup (QR scan + manual entry), Dashboard (status/uptime/stats), Logs (monospace viewer), Settings (config editor)
- **Node.js runtime** via nodejs-mobile community fork (Node 18 LTS, ARM64)
- **OpenClaw gateway** running as Android foreground service
- **DarkOps theme** — dark navy + crimson red + green status indicators
- **Solana wallet** MWA (Mobile Wallet Adapter) integration
- **Setup-token authentication** for initial configuration
- **Cron system** ported from OpenClaw with timer-based delivery
- **Editable settings** with encrypted storage (Android Keystore, AES-256-GCM)
- **Owner auto-detect** from Telegram bot token
- **Boot receiver** — auto-start agent after device reboot
- **Watchdog** — 30s health checks with auto-restart on unresponsive Node.js
- **Bottom navigation** — Dashboard, Logs, Settings tabs
- **Android Bridge** — local HTTP bridge exposing device APIs (battery, storage, network, clipboard, SMS, calls, location, TTS, apps) to the Node.js agent
