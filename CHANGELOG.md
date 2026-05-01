# Changelog

All notable changes to SeekerClaw are documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- **Migrate searchProvider + agentName to CrossProcessStore (BAT-515)** — both fields move out of process-local SharedPreferences into a shared `agent_preferences.json` file, mirroring the BAT-513/BAT-514 pattern.
  - Settings UI changes are LIVE across processes — provider switch + agent-name edit take effect on the next AI turn / `web_search` / `/status` without a service restart. The `:node` process reads `agent_preferences.json` per call via the new `getAgentName()` / `getSearchProvider()` getters in `config.js`.
  - `saveConfig` now atomically dual-writes prefs + RuntimeStateStore + AgentPreferencesStore. Pre-validation runs before persistence; if the second cross-process write (AgentPreferencesStore) fails, the rollback path restores prefs (5 keys + `setup_complete`) AND undoes the RuntimeStateStore forward update via a captured pre-forward snapshot — keeps all three stores convergent on FS failure.
  - Migration of an existing over-cap `agentName` is preserved verbatim with a single WARN — the 64-char cap applies only to NEW writes, not migration paths (BAT-515 v3 §1, Codex final guard via context-sensitive `validateForWrite`).
  - `tools/session.js` `webSearchProvider` now reports the live provider — replaces the long-stale `'duckduckgo'` fallback (BAT-481 dropped DDG, the report didn't follow).
  - Settings > Search Provider switch follows the BAT-549 R14/R17/R24 pattern (StateFlow `collectAsState` + optimistic local override + `Dispatchers.IO` + clear-on-failure) so taps feel instant and survive concurrent cross-process writes without lost-update-clobber.
- **Reasoning content preservation across all 4 providers (BAT-549)** — captures and (when supported) replays provider-native reasoning artifacts across tool-loop turns so multi-step thinking survives `/resume` and tool calls without re-prompting. Each provider preserves its own wire shape byte-exact:
  - Anthropic: `thinking` / `redacted_thinking` blocks with signature byte-exact, replayed with the `interleaved-thinking-2025-05-14` beta header
  - OpenAI Responses: full reasoning items with `encrypted_content` for `store:false` (OAuth/Codex) and api_key paths via `include:["reasoning.encrypted_content"]`
  - OpenRouter: `reasoning_details[]` echoed verbatim, plus `reasoning_content` echo gated by R1/V4 model regex
  - Custom: wraps the delegate (OpenAI Responses or OpenRouter Chat Completions) with model-gated echo policy (DeepSeek R1 strip, V4 echo-on-tool-loop, unknown capture-only) — fixes the `/resume` 400 loop on Custom + DeepSeek-V4 gateways
- **Adaptive 3-step quarantine recovery** — when a provider returns "reasoning_content must be passed back" 400, the chat loop runs progressive recovery: cut at last user-message boundary → cut at earliest provider-relevant tool-call turn → full conversation reset. Each step also rewrites the active task-store checkpoint so a later `/resume` can't reload the bad segment. User memory, skills, cron, credentials, and other-chat checkpoints are untouched at every step.
- **`reasoningSupport` tri-state in model registry** — known reasoning models marked `"yes"` (Opus 4.7/4.6, Sonnet 4.6, GPT-5.5/5.4/5.3-codex, gpt-5.4-mini), Haiku 4.5 marked `"no"`, everything else (incl. freeform OpenRouter / Custom model ids) resolves to `"unknown"`. The "yes" gate is authoritative — toggles never send the request param for non-yes models even when the user has them on.
- **Settings > AI Provider > Reasoning** — unified section with two master toggles plus a Custom-only Echo override. (1) **Extended thinking** drives the request enablement; (2) **Show thinking status** controls a temporary "Thinking..." Telegram bubble during extended-thinking turns. UI surfaces a user-facing hint when the active model is unsupported or unknown so users know the toggle is a no-op for that model. Reasoning content itself is never rendered in chat (v4 contract).
- **Settings > AI Provider > Reasoning > Echo reasoning to gateway** (Custom-only block) — per-Custom advanced override `customEchoReasoning` for power users on V4-shaped gateways whose model id doesn't match the known regex. Resets automatically when any signed Custom config field (model | baseUrl | format | header keys) changes — `CustomConfigSignature` mirrors algorithm Kotlin/Node-side with a golden-hash dual-side equivalence test.
- **Telegram `/think` command** — toggle reasoning fields from chat: `/think` shows status, `/think on/off` flips Extended thinking, `/think show/hide` flips the "Thinking..." status indicator, `/think echo on/off` flips the Custom override. Mirrors the Settings UI so power users don't have to leave the conversation. The no-args output uses user-facing language only (no `reasoningSupport=...` raw field, no jargon); the Custom block is hidden unless `provider === 'custom'`.
- **Centralized log-redaction helper** (`reasoning-redact.js`) — every reasoning-related log line goes through `fingerprint()` (sha256[:8]) + length-only summaries. Mobile logs end up in bug-report screenshots; raw thinking text, signatures, and `encrypted_content` MUST never leak there. Buffer / BigInt / circular-ref inputs all handled safely (no throw, no JSON expansion of secrets).
- **`DIAGNOSTICS.md` Reasoning section** — playbook for the most likely user-visible reasoning issues (toggle no-op surprise, V4 400 loop, R1 400 with echo, "Thinking..." bubble not appearing, "why doesn't this show reasoning text", signature spurious reset, redacted-log confusion).
- **Agent self-knowledge** — `buildSystemBlocks` injects a "Reasoning (Extended Thinking)" block per turn with the live state of all 3 toggles + active model's `reasoningSupport`, so the agent can answer "is reasoning on?" / "does my model support it?" without making things up.

### Fixed
- **DeepSeek V4-via-Custom `/resume` 400 crash** — the headline fix from BAT-549 Commit 1. V4 server requires reasoning_content echoed after tool calls; pre-BAT-549 the Custom adapter stripped it unconditionally and looped on the 400. Now the gating echoes for V4, strips for R1, captures-only for unknown gateways.

### Security
- **Header-VALUE bytes never hashed in `customConfigSignature`** — only sortedHeaderKeys (lowercase, deduped) participate in the hash, so secret material in `Authorization` / `X-API-Key` header values doesn't persist a leakable digest on disk.
- **API-key rotation invisible to the override-reset trigger** — the user's per-Custom advanced override survives normal key rotation (rotating `apiKey` doesn't change the signature). Only meaningful gateway-shape edits reset.
- **Locale-invariant Kotlin lowercase** — header-key lowercasing uses `Locale.ROOT` so Turkish-locale devices don't produce a different signature than other devices and the Node side (the dotted-I problem).
- **Sanitize-on-merge for corrupt `runtime_state.json`** — if the file got a wrong-type value (manual edit, schema rolled back), legacy 3-field writes fall back to defaults instead of carrying the bad value forward.

### Changed
- **Adapter `formatRequest` and `toApiMessages` accept an optional `requestOptions` arg** — additive 6th parameter (formatRequest) / 3rd parameter (toApiMessages). Existing call sites that don't pass it get the same pre-BAT-549 behavior. Used to thread `reasoningEnabled` / `reasoningSupport` / `customEchoOverride` through to per-adapter request-side decisions.
- **Anthropic `anthropic-beta` header** — now always includes `interleaved-thinking-2025-05-14` (no-op when reasoning is off; required so the API accepts replayed thinking blocks AFTER tool_use on the next turn — Commit 2a's capture path was inert without this).

## [1.9.0] - 2026-04-13

### Added
- **OpenAI Codex OAuth** — sign in with a ChatGPT Plus/Pro subscription instead of a platform API key. Browser PKCE flow, Keystore-encrypted token storage, automatic token refresh, per-provider auth-type memory across provider switches (BAT-485, #316)
- **Discord channel** — run the agent on Discord as an alternative to Telegram. Gateway v10 WebSocket, full media/reactions/reply threading, channel abstraction layer so future channels plug in cleanly (BAT-483, #310)
- **Custom AI Provider** — connect any OpenAI-compatible gateway (DeepSeek, Ollama, LiteLLM, etc.) via a base URL, API key, custom headers, and a model ID. Supports both Chat Completions and OpenAI Responses formats (BAT-482, #309)

### Fixed
- **OpenAI OAuth callback unreachable on IPv6-first devices** — the NanoHTTPD callback server was bound to literal `"localhost"`, which some Android builds resolve to `::1` only. Chrome's Custom Tab resolves `localhost` to `127.0.0.1`, so the callback hit a socket the server wasn't listening on. Server now binds wildcard and accepts both IPv4 and IPv6 loopback (including IPv4-mapped IPv6 `::ffff:127.0.0.1`), with a remote-IP filter rejecting non-loopback clients (BAT-489, #323)
- **OAuth callback server destroyed during browser authentication** — Android could destroy the stopped Activity while the user authenticated in Chrome Custom Tab, killing the localhost callback server. Moved the server and flow state to companion-object scope (application lifetime) so it survives Activity destruction. Concurrency model uses `synchronized(FLOW_LOCK)` with per-flow isolation via `activeFlowId` (BAT-493, #327)
- **OAuth token exchange failed on background-restricted devices** — when Chrome Custom Tab takes the foreground, Android restricts the background app's internet access on some devices. DNS resolution for `auth.openai.com` would fail with `UnknownHostException`. Added a temporary foreground service (`OAuthKeepAliveService`) that starts before Chrome opens and stops after the OAuth flow completes, giving the process unrestricted network access for the duration of authentication (BAT-494, #328, #329)
- **Fresh-install OAuth deadlock** — the token exchange threw `IllegalStateException("Config not loaded")` because `ConfigManager.loadConfig` returns null until setup is marked complete. New `loadConfigOrBootstrap` + `persistOpenAIOAuthTokens` paths let OAuth persist tokens mid-onboarding without marking setup complete prematurely (BAT-489, #323)
- **Fresh-install default provider** — setup and settings screens now both default to OpenAI + Sign in with ChatGPT on fresh installs, matching the intended onboarding flow (BAT-489, #323; BAT-495, #330)
- **Setup form state wiped by OAuth** — the `configVersion` bump from OAuth token persistence cascaded into `remember(configVersion)` field initializers, blanking out already-typed bot tokens. Form state is now `rememberSaveable`, surviving mid-flow OAuth writes and process death (BAT-489, #323)
- **Cross-provider OAuth token wipe** — saving setup as Claude or OpenRouter used to overwrite existing OpenAI OAuth tokens with empty strings. Preserved-OAuth values are now threaded through every provider branch (BAT-489, #323)
- **Legacy plaintext email pref PII leak** — the plaintext-to-encrypted `openai_oauth_email` migration only cleared the plaintext key on read. Every OAuth write/clear now wipes both forms (BAT-489, #323)
- **Agent runtime crash from regex SyntaxError** — `silent-reply.js` used Unicode property escapes (`\p{L}\p{N}`) that crashed nodejs-mobile's Node 18 V8 at module load. Rewrote boundary regexes to use ASCII `\w` instead (#325)
- **SILENT_REPLY sentinel over-stripped protocol discussion** — renamed the canonical sentinel from `SILENT_REPLY` to `[[SILENT_REPLY]]` so discussion of the protocol in prose passes through untouched, while the bracketed form is reserved for the control signal. Legacy whole-message compatibility path preserved for bare `SILENT_REPLY` and markdown-wrapped variants. 43 unit tests across 6 coverage sections (BAT-491, #324)
- **Silent Replies system prompt over-priming** — removed explicit right/wrong examples containing the literal sentinel string from the system prompt. The literal form now appears exactly once. Cron and heartbeat prompts reference the Silent Replies section by name instead of inlining the token (BAT-492, #326)
- **Google Play SMS hotfix** — `android_sms` on the googlePlay flavor now uses an intent handoff instead of `SEND_SMS` permission (BAT-484, #312) *(also tagged as v1.8.1)*
- **Codex SSE parsing** — handle missing Content-Type header from chatgpt.com
- **Web search provider reporting** — agent now knows which search backend actually ran with `provider: "auto"`
- **Dashboard credential check** — OpenAI OAuth users now see a green pill instead of "Credential missing"
- **Sign Out button color** — uses ActionDanger red for consistency with Reset/Wipe

### Changed
- **OAuth callback page redesigned** — DarkOps-themed card with Material Design checkmark/X icon, status badge, navigation hint, and inline SeekerClaw logo SVG. Matches the app's design system (BAT-495, #330)
- **Settings layout** — Quick Setup moved up, MCP Servers extracted to its own screen (#313)
- **Renamed user-visible "OpenClaw service" → "Claw Engine"** in log messages and Settings/System About rows
- **Provider switching is now atomic** — batched into a single `saveConfig` call instead of 2–3 sequential writes
- **Agent self-knowledge** — added OpenAI OAuth Provider block, OAuth Self-Diagnosis playbook, and OAuth sections in `DIAGNOSTICS.md` (SAB-AUDIT-v19)
- **Node smoke test harness** — `tests/nodejs-project/smoke.js` validates module load on every commit to catch regex/V8 crashes before they reach devices (#325)

### Security
- **OAuth tokens never touch disk in plaintext** — persisted directly via `ConfigManager` (Android Keystore), result files carry only status flags (RFC 6819 §5.1.4, OWASP MASVS-STORAGE-1)
- **`config.js` strict authType validation** — hard-fails on unsupported values for the OpenAI provider, with legacy-alias migration so older installs don't crash
- **OAuth callback listener** accepts only loopback clients (127.0.0.0/8, `::1`, and IPv4-mapped IPv6 forms) via a remote-IP check in `serve()` — wildcard bind is required for cross-platform loopback compatibility, so security is enforced at the request layer, not the socket layer
- **OAuth diagnostic logging sanitized** — token endpoint error responses are logged with only the `error` and `error_description` JSON fields, not the raw response body, to prevent accidental data exposure in production logcat (BAT-494, #328)
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
