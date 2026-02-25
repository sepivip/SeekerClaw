# Changelog

All notable changes to SeekerClaw are documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/).

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
