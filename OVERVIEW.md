# SeekerClaw — Project Overview

> **Knowledgebase for pitch decks, partner docs, investor briefs, accelerator applications, and press.**
> Source-of-truth for "what is SeekerClaw, what have we built, where is it going." Every section is modular — lift it straight into a deck or form.
>
> Last refreshed: 2026-05-11 · v1.10.0 · 590+ commits this year

---

## TL;DR

**SeekerClaw is a phone-resident AI agent. An Android app embeds a full Node.js runtime that runs an OpenClaw-derived AI gateway 24/7 as a foreground service. The user talks to their agent through Telegram or Discord — the agent has its own Solana wallet, its own memory, 60+ built-in tools, and can do work for the user while the phone is in their pocket.**

Built for the Solana Seeker phone, runs on any Android 14+ device. Open source (MIT), shipping on the Solana dApp Store and Google Play.

---

## Headline Numbers

| Metric | Value |
|---|---|
| App version | **v1.10.0** (code 19, released 2026-05-02) |
| Total commits | **991** (across all branches) |
| Commits in 2026 | **590+** |
| Merged PRs | **363+** |
| Built-in tools | **63** + remote MCP tools |
| Skills | **35** (20 bundled, 13 workspace, 2 user-created) + partner marketplace |
| AI providers supported | **4** (Claude, OpenAI incl. Codex OAuth, OpenRouter, Custom) |
| Channels | **2** (Telegram, Discord) |
| Search providers | **5** (Brave, Perplexity, Exa, Tavily, Firecrawl) |
| Codebase | **~27K LOC Kotlin** · **~24K LOC JavaScript** across 85 Kotlin + 67 JS files |
| Android Bridge endpoints | **18+** |
| Telegram commands | **12** |
| SAB self-awareness audits | **24+** rounds (100% scores on shipped surface) |
| Active development since | 2026-02-12 (BAT-13) — ~3 months to v1.10.0 |
| License | MIT |

---

## One-Liner Variants

Pick the one that matches the audience:

- **General:** A 24/7 AI agent that lives inside your phone and you talk to through Telegram.
- **Solana / Seeker:** Turn your Solana Seeker into a personal AI agent with its own wallet.
- **Investor:** Local-first AI agents on mobile — your phone runs the agent, the agent runs your wallet.
- **Developer / OSS:** An open-source, on-device Node.js agent gateway with 60+ tools, MCP support, and a partner skill marketplace.
- **Partner / B2B:** A distribution channel into the pockets of Solana users — ship a skill, reach every SeekerClaw agent.

---

## The Pitch

### The Problem

AI agents today live in someone else's cloud. They forget you the moment you close the tab. They can't touch your wallet, your contacts, your camera, or your calendar without being given keys to your kingdom — and once given, those keys live on a server you don't control. For Solana users specifically, the gap is louder: there's no AI assistant that natively understands SPL tokens, Jupiter, MWA signing, or compressed NFTs.

Meanwhile, mobile is where users actually are. Phones are always on, always connected, with a wallet (Seeker), a camera, GPS, contacts — everything an agent needs. But "AI on phone" has meant either a thin client that pings a remote LLM or a tiny on-device model that can't do real work.

### The Insight

The right architecture for a personal AI agent is:
- **On-device runtime** (Node.js, sandboxed, foreground service)
- **Remote LLM brain** (Claude / OpenAI / OpenRouter / any OpenAI-compatible)
- **User's preferred messenger as the chat surface** (Telegram, Discord)
- **User's wallet on the same device** (Seeker / MWA)

The phone becomes the agent. The cloud LLM is just a brain-on-demand. Tools, memory, and secrets stay local. Distribution is whatever app store the user already uses.

### The Product

SeekerClaw is that architecture, shipped. An Android app packages Node.js 18 (via nodejs-mobile) and runs an AI gateway as a foreground service. Setup is QR-code-in / done. Then you message your agent from Telegram or Discord like a co-worker:

- *"Swap 0.1 SOL into USDC."*
- *"Remind me to call Mom in 2 hours."*
- *"What's in my portfolio right now and how is it doing today?"*
- *"Take a photo and tell me what's in the fridge."*
- *"Run the netwatch skill — am I on a safe network?"*
- *"Send a message to my partner that I'll be 15 minutes late."*

The agent has memory across conversations, scheduling, a Solana wallet, web access, device control, and an extensible skill system. **It's a real assistant, not a chatbot.**

---

## What It Does — Capabilities at a Glance

| Capability | What it actually means |
|---|---|
| **Multi-provider AI brain** | Anthropic Claude (Opus 4.7 default), OpenAI (API key or Codex OAuth), OpenRouter, or any OpenAI-compatible gateway (DeepSeek, Ollama, LiteLLM, etc.). Live switching from chat with `/provider` and `/model`. |
| **Extended Thinking** | Reasoning preserved byte-exact across all 4 providers, survives tool calls and `/resume`. Live toggle via `/think` or Settings. |
| **Solana wallet** | Balance, transfers, Jupiter swaps (gasless via Ultra API), limit orders, DCA, token search, security checks, holdings, NFT view. MWA sign-only — keys never leave the device. |
| **Burner Wallet + x402** | Optional app-managed Solana keypair with per-tx + daily caps for autonomous low-value spending. Key encrypted in Android KeyVault, never crosses the bridge into Node. Includes `agent_pay` for x402-protected HTTP endpoints (HTTPS-only, mainnet-only, USDC-only V1 envelope). |
| **24/7 Telegram / Discord channel** | Full bot, reactions, file sharing, vision (image analysis), inline keyboards, slash commands. Discord via Gateway v10 WebSocket. Single active channel at a time; channel-agnostic core. |
| **Device control** | Battery, GPS, camera (with vision), SMS, calls, clipboard, contacts, text-to-speech, apps. 13 Android bridge tools. |
| **Memory** | SOUL.md (personality), MEMORY.md (long-term), daily notes, ranked SQL.js full-text-style search with recency weighting. Session summaries on idle / checkpoint / `/new` / graceful Stop. |
| **Cron + scheduling** | "remind me in 30 minutes", "every day at 9am". Natural language, JSON persistence, zombie detection, atomic writes. |
| **Web intelligence** | 5 search providers + fetch + caching. HTML-to-markdown, JSON, redirects, custom headers. Single-active-provider with API key gating. |
| **Skills** | 20 bundled + 13 workspace + extensible. YAML frontmatter format, semantic AI-driven routing, `requires.env` / `requires.bins` gating, ZIP / .md import/export, partner marketplace. |
| **MCP support** | Remote Model Context Protocol servers via Streamable HTTP. Users add server URLs in Settings; agent discovers and uses tools at startup. SHA-256 rug-pull detection, untrusted content wrapping, rate limiting. |
| **Env Vars** | User-managed `process.env.KEY` store. Skills and tools read at runtime; values masked from logs. Single-add + `.env`-style bulk paste. |
| **Activity Heatmap** | 26-week heatmap of API requests on the System screen — see when the agent is working. Up to 13 months of daily history persisted on-device. |
| **Live cross-process settings** | Provider, model, MCP servers, search provider, agent name — all migrated to a `CrossProcessStore` JSON layer. Settings UI and `:node` see each other's writes without a service restart. |
| **Graceful Stop** | Tapping Stop triggers a bounded shutdown handshake — pending session summaries and dirty SQL.js writes persist within ~1.5s before kill. Last 60s of activity survives user-Stop. |

---

## Architecture

### High-level

```
                ┌───────────────────────────────────────────────┐
                │                  Your Phone                    │
                │                                                 │
  Telegram /    │   ┌──────────────────┐    ┌──────────────────┐ │
  Discord  ◄───────►│ Channel Adapter  │◄──►│  AI Agent (Node) │ │
                │   └──────────────────┘    │  ai.js, tools/   │ │
                │                            └────────┬─────────┘ │
                │                                     │            │
                │   ┌──────────────────┐              │            │
                │   │  Android Bridge  │◄─────────────┤            │
                │   │  (localhost:8765)│              │            │
                │   └──────────────────┘              │            │
                │      │                              │            │
                │      ▼                              ▼            │
                │  Camera, GPS, SMS,            ┌────────────┐    │
                │  Contacts, Clipboard,         │ MWA Wallet │    │
                │  TTS, Apps, KeyVault          │  / Burner  │    │
                │                                └────────────┘    │
                └────────────────┬────────┬──────────┬─────────────┘
                                 │        │          │
                                 ▼        ▼          ▼
                            Claude /  Jupiter /   Web search
                            OpenAI /  Solana RPC   providers
                            OpenRouter
```

### Process Model

- **Main process** (Compose UI) — Setup, Dashboard, Logs, Skills, Settings, System, Activity Heatmap
- **`:node` process** (Foreground Service) — Node.js runtime running the agent, kept alive 24/7 with `START_STICKY` + wake lock
- **Boot Receiver** — auto-starts on device boot (after first unlock)
- **Watchdog** — 30s health check, 60s dead declaration, automatic restart
- **Cross-process state** — runtime config, MCP servers, agent name, search provider live in shared JSON files (`runtime_state.json`, `mcp_servers.json`, `agent_preferences.json`) with atomic dual-writes and rollback

### Code Structure (the moat)

**Android (Kotlin / Jetpack Compose, Material 3):** ~27K lines across 85 files
- 10 UI screens: Setup, Dashboard, Logs, Skills, Settings, System, AnthropicConfig, ProviderConfig, ChannelConfig, SearchConfig
- 4 product flavors / 2 distributions (dApp Store APK, Google Play AAB)
- DarkOps single theme (dark navy + crimson + green status)
- SharedComponents.kt consolidates CardSurface, InfoRow, Scaffold, Switch across screens

**Node.js agent (JavaScript):** ~24K lines across 67 files
- `ai.js` (~2,330) — provider API, system prompt, multi-turn tool loop, `/think` integration
- `message-handler.js` (~665) — message routing, command dispatch, auto-resume, vision
- `providers/` — 4 adapters (Claude, OpenAI Responses, OpenRouter Chat Completions, Custom)
- `tools/` — 12 modules, 63 tool handlers (Solana 17, Android 13, memory 6, file 5, cron 5, telegram 4, system 2, web 2, skill 2, wallet 2, env 1, agent_pay/x402 1, session 1)
- `reasoning-gating.js`, `reasoning-recovery.js`, `reasoning-redact.js` — per-provider extended thinking lifecycle
- `mcp-client.js` — MCP Streamable HTTP client + rug-pull detection
- `cron.js`, `skills.js`, `memory.js`, `database.js` (SQL.js), `security.js`, `task-store.js`, `loop-detector.js`

### Why this architecture matters

1. **User data stays on the user's device.** Memory, secrets, wallet keys — local.
2. **LLM is swappable.** Provider abstraction means we can ride whichever model is best at any moment.
3. **Channel is swappable.** Telegram is shipped, Discord is shipped, WhatsApp / Slack / Signal are adapter-plug-ins away.
4. **The agent is extensible without forking the app.** Skills are markdown files, MCP servers are URLs.
5. **It survives.** Boot receiver, watchdog, graceful Stop, file observers, atomic writes everywhere.

---

## What We've Shipped (last 90 days, highlights)

Selected from 363+ merged PRs. See [PROJECT.md](PROJECT.md) and [CHANGELOG.md](CHANGELOG.md) for the full list.

### v1.10.0 — May 2026
- **Env Vars** — user-managed `process.env.KEY` store with skill `requires.env` gating, `.env`-style bulk paste, log redaction
- **Extended Thinking on every provider** — Anthropic / OpenAI / OpenRouter / Custom all preserve reasoning byte-exact across tool calls and `/resume`. Headline fix: DeepSeek V4-via-Custom `/resume` 400 loop
- **`/think`, `/model`, `/provider` slash commands** — switch reasoning state, model, or provider live from Telegram without opening Settings
- **Cross-process state migration** — runtime config, MCP servers, agent name, search provider all moved off process-local SharedPrefs into shared JSON with atomic dual-write rollback
- **Graceful Stop** — bounded shutdown handshake persists session summaries + dirty SQL.js writes within ~1.5s before kill
- **Activity Heatmap** — 26-week heatmap of agent activity on the System screen
- **Burner Wallet (BAT-582)** — app-managed Solana keypair, KeyVault-encrypted, per-tx + daily caps, x402 `agent_pay` for v1 + v2 protocols (settle v2 deferred), HTTPS-only / mainnet-only / USDC-only V1 envelope

### v1.7 - v1.9 — March - April 2026
- **Custom AI Provider** (BAT-482) — connect any OpenAI-compatible gateway (DeepSeek, Ollama, LiteLLM, etc.)
- **Discord channel** (BAT-483) — Gateway v10 WebSocket, channel abstraction, full feature parity with Telegram
- **OpenRouter provider** (BAT-447) — community-suggested by [@DyorAlex](https://github.com/DyorAlex), shipped end-to-end
- **OpenAI Codex OAuth** (BAT-485) — ChatGPT subscription auth alongside API key
- **Search Provider System** (BAT-481) — Exa, Tavily, Firecrawl added alongside Brave + Perplexity. DDG removed
- **Quick Actions** (`/quick`) — Telegram inline keyboard with 6 one-tap presets
- **Repetition detector** — catches degenerate model output before send
- **Onboarding redesign** — design system, haptic feedback, QR scan + manual entry

### v1.5 - v1.6 — Feb - Mar 2026
- **OpenClaw parity** — multiple rounds of porting from upstream (2026.2.22, 2026.2.26, 2026.2.28, 2026.3.8, 2026.4.10)
- **Multi-provider architecture foundation** (BAT-315) — Claude / OpenAI adapter pattern + DB-agnostic logging
- **OAuth + setup token billing attribution** (BAT-460) — Anthropic Pro/Max users can use their subscription
- **MCP support** (BAT-168) — remote tool servers via Streamable HTTP with security hardening
- **Tool confirmation gates** — YES/NO Telegram confirmations for SMS, calls, Solana sends, Jupiter orders
- **Prompt injection defense** — content trust policy, untrusted-content wrapping, pattern detection, Unicode homoglyph sanitization
- **Skills marketplace foundation** — bundled skills, workspace skills, partner skills, export/import (ZIP + .md)
- **Jupiter integration audit** — 7 surgical fixes from official skill audit (BAT-151–157)

### v1.0 - v1.4 — Feb 2026 (foundation, weeks 1-3)
- **Node.js on Android** — nodejs-mobile, foreground service, watchdog, boot receiver, IPC bridge
- **Claude integration** — Opus / Sonnet / Haiku, prompt caching, retry with backoff, rate-limit throttling
- **Telegram bot** — HTML formatting, reactions, file sharing, vision, inline keyboards
- **SQL.js database** — WASM SQLite for API logs, memory index, session storage
- **60+ tools** — file, memory, cron, web, Android bridge, Solana, system, skill
- **Skills system** — YAML frontmatter, semantic routing, install from URL
- **Open-source prep** — MIT license, CONTRIBUTING, issue/PR templates, CI + release workflows

---

## Distribution & Status

| Channel | Status | Notes |
|---|---|---|
| **Solana dApp Store** | Live (v1.4.3) | Primary distribution. APK signed with `dappStore` keystore. |
| **Google Play** | Build pipeline ready | AAB signed with `googlePlay` keystore. `googlePlay` flavor uses intent-handoff for SMS (no SEND_SMS permission). |
| **GitHub Releases** | Live | Latest APK downloadable from [github.com/sepivip/SeekerClaw/releases](https://github.com/sepivip/SeekerClaw/releases). RC + final release CI flow. |
| **Direct sideload** | Always supported | dApp Store APK can sideload on any Android 14+ device. |
| **Product Hunt** | Listed | [producthunt.com/products/seekerclaw](https://www.producthunt.com/products/seekerclaw) |
| **Website** | Live | [seekerclaw.xyz](https://seekerclaw.xyz) — landing + setup QR generator (client-side only, keys never leave browser) |

**Supported devices:**
- **Primary:** Solana Seeker (Android 14, Snapdragon 6 Gen 1, 8GB RAM)
- **Secondary:** Any Android 14+ with 4GB+ RAM
- **Note:** Aggressive OEM ROMs (Xiaomi MIUI, Samsung OneUI) may kill background services; Seeker's stock Android avoids this.

---

## Engineering Practices (the credibility section)

This is real software, not a demo. Some of the practices that distinguish it:

- **SAB — Self-Awareness Benchmark.** Custom 2-score behavioral audit run after every user-visible AI capability ships. v3 added behavioral probes that catch drift human reviewers miss. **24+ rounds run to date**, with PR-template gate (`.github/PULL_REQUEST_TEMPLATE.md`).
- **Pre-push gate** (`scripts/pre-push-check.sh`) — Node smoke test + Kotlin compile via Android Studio's JBR in ~5–10s. Catches missing imports, type errors, regex/V8 crashes before CI burns 4 minutes.
- **Copilot review iteration** — every non-trivial PR goes through multiple Copilot review rounds. Recent burner-wallet PR went **36 rounds** (BAT-582 R1–R36) — every reviewer comment investigated, addressed, or explicitly justified.
- **Drift-guard tests** — pinned regression tests for things like Telegram command registry, confirmation-policy v1.0 behavior, reasoning-gating fingerprints, MAX_STEPS, and CustomConfigSignature equivalence Kotlin↔Node.
- **Device-test discipline** — every release tested install-old-then-install-new on actual Seeker hardware; APK SHA verified against System screen short SHA before declaring tests done.
- **Memory preservation contract** — explicit rules in CLAUDE.md prohibit overwriting user memory files on update. Atomic dual-writes with rollback for any state touching SharedPrefs + CrossProcessStore.
- **Security posture** — prompt injection defense, untrusted-content wrapping, secrets blocklist, path traversal guards, `js_eval` sandbox, ALT-safe swap verification, bridge token auth, debug-log redaction for all secrets.
- **Open source** — MIT licensed. All issues, PRs, security disclosures public. Community contributors credited in README and PROJECT.md.

---

## Market & Positioning

### Why now

- **Solana Seeker shipping to 150K+ pre-orders** — a phone with a wallet built in. The hardware narrative needs a software narrative.
- **AI agents are the year's defining product category** — but every shipped product is cloud-hosted. Local-first / on-device is the contrarian bet that matches mobile's reality.
- **MCP standardizes tool extension** — the same way LSP standardized editor tooling. SeekerClaw is one of the first consumer apps to ship full MCP client support on mobile.
- **Crypto-native AI is a wide-open lane** — Jupiter, Pump.fun, Helius, Drift, Byreal, Metaplex — none have a first-party AI agent. SeekerClaw is the substrate.

### Closest comparables

| Product | What they do | What's different |
|---|---|---|
| **ChatGPT iOS / Android** | Thin client to cloud LLM | No wallet, no tools, no local memory, no skill marketplace, no device access |
| **OpenClaw** (desktop, upstream) | Desktop-bound CLI/server agent | Not mobile, no Solana wallet, no Telegram-as-primary, no Android Bridge |
| **Replika / Character.ai** | Companion chat | No tool use, no wallet, not extensible |
| **Custom Telegram bots** | Self-hosted scripts | No mobile runtime, no skill marketplace, no MCP, no provider abstraction |

**The defensible position:** SeekerClaw is the only product that combines (a) AI brain, (b) crypto wallet, (c) Telegram as the front end, (d) on-device runtime, (e) full Solana toolset, on a mobile target user-base. The moat is the combination, not any single piece.

---

## Roadmap

### High priority
- **Transaction monitoring + smart alerts** — watch wallet for incoming/outgoing, alert via Telegram
- **Vector embeddings for semantic memory** — currently keyword + recency; needs native bindings or WASM solution
- **Burner Wallet x402 v2 settle** — protocol detection + tx build shipped in v1.10.0+; settle path deferred until real-wire v2 success-response capture pins the proof-header path
- **dApp Store full listing parity** — pipeline exists, submission in flight

### Medium priority
- **FTS5 full-text search** on memory — SQL.js supports it
- **More channels** — WhatsApp Business, Signal, Slack (channel abstraction already exists)
- **Partner Skill marketplace v2** — review flow, signed skills, version pinning, paid skills
- **Multi-language support** — i18n scaffold (see `MULTILANGUAGE_PLAN.md`)

### Future
- **Multi-agent coordination** — collaborate between users' agents
- **Cross-device sync** — encrypted memory sync between Seeker and laptop OpenClaw
- **Browser / canvas / screen skills** — currently can't port from OpenClaw (require desktop env)

---

## Partner / Integration Story

For partners (DEXes, protocols, infra providers, indexers):

1. **Ship a skill.** Skills are markdown files with YAML frontmatter. Users install them via Telegram (`skill_install` tool) or web link. Your protocol gets a first-party agent surface for every SeekerClaw user.
2. **Or ship an MCP server.** Users add the URL in Settings → MCP Servers. Your tools appear in the agent's tool list at next startup.
3. **Or partner on bundled skills.** Featured in app at install, image rendered in the Skills tab.

**Shipped partner skills:** Byreal (DEX), Career Companion (AI coach), ClawPump (Pump.fun launches), Dune Analytics, Home Assistant. Format documented in [SKILL-FORMAT.md](SKILL-FORMAT.md).

---

## Team & Community

- **Creator / Lead:** [@sepivip](https://github.com/sepivip) (Beka — Tbilisi, Georgia)
- **Code contributors:** [@DashLabsDev](https://github.com/DashLabsDev), [@LevanIlashvili](https://github.com/LevanIlashvili) (security audit)
- **Ideas-into-features:** [@DyorAlex](https://github.com/DyorAlex) (proposed OpenRouter — shipped v1.7.0), [@Tofu-killer](https://github.com/Tofu-killer) (proposed Custom Provider — shipped v1.8)
- **Code-review collaborators:** Anthropic Claude, GitHub Copilot, ChatGPT Codex (used as PM / reviewer / contract author across many recent BATs)

**Community surfaces:**
- GitHub Issues + PRs ([sepivip/SeekerClaw](https://github.com/sepivip/SeekerClaw))
- Telegram channel ([t.me/seekerclaw](https://t.me/seekerclaw))
- X / Twitter ([@SeekerClaw](https://x.com/SeekerClaw))
- Website ([seekerclaw.xyz](https://seekerclaw.xyz))

---

## Risk Posture (the "what about safety" section)

A pitch-ready doc needs to address this head-on. The agent has real capabilities — wallet, messaging, device control. Mitigations shipped today:

| Risk | Mitigation |
|---|---|
| **AI hallucinates / makes mistakes** | Two-step confirmation gates for every state-mutating action (SMS, calls, sends, swaps, limit orders, DCA, cap changes). 60s auto-cancel. Rate limiting (Solana 15s, Jupiter 30s, SMS/call 60s). |
| **Prompt injection from web content** | Content Trust Policy in system prompt. `<<<EXTERNAL_UNTRUSTED_CONTENT>>>` boundary markers on all web_fetch / web_search results. 10-pattern suspicious content detector. Unicode homoglyph + zero-width-space sanitization. Skill file protection. |
| **Wallet drain via ALT bypass** | `verifySwapTransaction()` rejects instructions referencing programs via Address Lookup Tables. |
| **Secrets leakage in logs** | Centralized log redaction via `reasoning-redact.js` and the env-vars secrets register. sha256-fingerprint-only logging for reasoning content. API key redaction. |
| **Path traversal / shell escape** | Workspace sandboxing. Shell command allowlist (no `rm`, `kill`, etc.). `js_eval` blocks `child_process`/`vm`, proxied `fs` with sensitive-file guards. |
| **Bridge auth** | Per-boot bridge token authentication for all loopback endpoints. Cleartext exemption scoped to `127.0.0.1` only — TLS enforced for every real remote endpoint. |
| **Update breaks user data** | Memory preservation contract: workspace/, SOUL.md, MEMORY.md, IDENTITY.md, USER.md, memory/*.md, HEARTBEAT.md, skills/* preserved across `adb install -r` and app-store updates. Export/import in Settings. |
| **Burner wallet runaway spending** | Per-tx + daily caps (default 0.05/0.5 SOL, 5/50 USDC), atomic units throughout, UTC midnight rollover, reserve/commit/release state machine with 60s TTL on reservations. |

Full safety disclaimer in README. We tell users: "Treat your agent like a capable but imperfect assistant. Verify important actions. Don't trust it with more than you can afford to lose."

---

## Quick Facts (lift-into-form)

**Project name:** SeekerClaw
**Package:** `com.seekerclaw.app`
**License:** MIT
**Repo:** https://github.com/sepivip/SeekerClaw
**Website:** https://seekerclaw.xyz
**X / Twitter:** https://x.com/SeekerClaw
**Telegram:** https://t.me/seekerclaw
**Product Hunt:** https://www.producthunt.com/products/seekerclaw

**Primary platform:** Solana Seeker
**Supported platforms:** Android 14+ (4GB+ RAM)
**Language stack:** Kotlin (Jetpack Compose, Material 3) + Node.js 18 LTS (nodejs-mobile)
**Database:** SQL.js (WASM SQLite)
**Distribution:** Solana dApp Store (live, v1.4.3) · Google Play (build pipeline ready) · GitHub Releases · sideload

**Active development since:** 2026-02-12
**Latest release:** v1.10.0 (2026-05-02)
**Commits in 2026:** 590+
**Merged PRs:** 363+
**Codebase:** ~51K LOC (~27K Kotlin / ~24K JS)

**Tools:** 63 built-in + remote MCP
**Skills:** 35 (20 bundled + 13 workspace + 2 user-created)
**AI providers:** Claude, OpenAI (incl. Codex OAuth), OpenRouter, any OpenAI-compatible Custom gateway
**Default model:** Claude Opus 4.7
**Channels:** Telegram + Discord
**Search providers:** Brave, Perplexity, Exa, Tavily, Firecrawl

---

## Asks / What We Want From Partners

- **Distribution.** Featured slot on dApp Store / Solana ecosystem channels.
- **Partner skills.** Protocols building on Solana — ship a SeekerClaw skill, reach every user's pocket.
- **Investment.** Pre-seed / seed open to right strategic partners — particularly Solana-native funds and mobile-first AI thesis investors.
- **Accelerators / grants.** Solana Foundation, Superteam, Colosseum, a16z crypto — looking for sponsorship aligned with consumer-mobile + on-device AI thesis.
- **Code contributors.** Open-source, MIT, well-documented, active issue list. Especially welcome: WhatsApp / Signal channel adapters, vector embeddings, Metaplex compressed-NFT skill, more partner skill authors.

---

## Appendix — Where to Read More

- **For developers:** [README.md](README.md), [CONTRIBUTING.md](CONTRIBUTING.md), [SKILL-FORMAT.md](SKILL-FORMAT.md), [SECURITY.md](SECURITY.md)
- **For maintainers (internal):** [PROJECT.md](PROJECT.md) (source of truth, living doc), [CLAUDE.md](CLAUDE.md) (project guide for AI assistants), [CHANGELOG.md](CHANGELOG.md), `docs/internal/` (audits, plans, research)
- **For users:** [seekerclaw.xyz](https://seekerclaw.xyz), [seekerclaw.xyz/setup](https://seekerclaw.xyz/setup), step-by-step setup guide on [@SeekerClaw](https://x.com/SeekerClaw)

---

*This document is the canonical "what is SeekerClaw" overview. Slides, pitches, partner docs, and investor briefs all lift from this. When the product changes, update this first — everything downstream follows.*
