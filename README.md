<div align="center">
  <img src="design/banner.png" alt="SeekerClaw" width="100%">
  <br><br>
  <p>
    <img src="https://img.shields.io/badge/🏆_Solana_Mobile_Hackathon-Winner-FFD700?style=for-the-badge&labelColor=0d1117" alt="Solana Mobile Hackathon Winner">
  </p>
  <p>
    <img src="https://img.shields.io/badge/Android-14+-3DDC84?logo=android&logoColor=white" alt="Android 14+">
    <img src="https://img.shields.io/badge/Kotlin-2.0-7F52FF?logo=kotlin&logoColor=white" alt="Kotlin">
    <img src="https://img.shields.io/badge/Compose-Material_3-4285F4?logo=jetpackcompose&logoColor=white" alt="Jetpack Compose">
    <img src="https://img.shields.io/badge/Node.js-18_on--device-339933?logo=nodedotjs&logoColor=white" alt="Node.js">
    <img src="https://img.shields.io/badge/Claude-Powered-cc785c?logo=anthropic&logoColor=white" alt="Claude">
    <img src="https://img.shields.io/badge/OpenAI-Powered-412991?logo=openai&logoColor=white" alt="OpenAI">
    <img src="https://img.shields.io/badge/OpenRouter-Powered-6467F2?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAyQzYuNDggMiAyIDYuNDggMiAxMnM0LjQ4IDEwIDEwIDEwIDEwLTQuNDggMTAtMTBTMTcuNTIgMiAxMiAyem0wIDE4Yy00LjQyIDAtOC0zLjU4LTgtOHMzLjU4LTggOC04IDggMy41OCA4IDgtMy41OCA4LTggOHoiLz48L3N2Zz4=&logoColor=white" alt="OpenRouter">
    <img src="https://img.shields.io/badge/MCP-Streamable_HTTP-1a1a2e" alt="MCP">
    <img src="https://img.shields.io/badge/Solana-Seeker-9945FF?logo=solana&logoColor=white" alt="Solana">
    <img src="https://img.shields.io/badge/Telegram-Bot-26A5E4?logo=telegram&logoColor=white" alt="Telegram">
    <img src="https://img.shields.io/badge/License-MIT-blue" alt="MIT License">
  </p>
  <p>
    <a href="https://play.google.com/store/apps/details?id=com.seekerclaw.app"><img src="https://img.shields.io/badge/Google_Play-Download-414141?logo=google-play&logoColor=white&style=for-the-badge" alt="Google Play"></a>
    &nbsp;
    <a href="https://github.com/sepivip/SeekerClaw/releases/latest"><img src="https://img.shields.io/badge/dApp_Store-APK-9945FF?logo=solana&logoColor=white&style=for-the-badge" alt="dApp Store APK"></a>
  </p>
  <p>
    <a href="https://www.producthunt.com/products/seekerclaw"><img src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=seekerclaw&theme=dark" alt="SeekerClaw on Product Hunt" width="250" height="54"></a>
  </p>
</div>

---

SeekerClaw — winner of the **Solana Mobile Hackathon (April 2026)** — embeds a Node.js AI agent inside an Android app, running 24/7 as a foreground service. You interact through Telegram or Discord — ask questions, control your phone, trade crypto, schedule tasks, **and now pay for paid APIs autonomously in USDC**.

v2 introduces a **burner wallet + x402 payment client**: a small, app-stored wallet you import once that lets your agent transact within per-tx and daily caps you set — without leaving your main wallet exposed. The agent can call 44 catalogued paid endpoints across 10 services (market data, real estate, travel, research, captcha, SMS, more) once you opt in to a paid lookup, while your Phantom / MWA wallet remains user-controlled for swaps and transfers.

**63 built-in tools** (plus MCP remote tools), **22 bundled skills + 35+ partner skills**, two-wallet Solana, multi-provider AI (Claude + OpenAI + OpenRouter + any OpenAI-compatible gateway), extended thinking preserved across tool calls, graceful Stop — all running locally on your device. Built for the Solana Seeker, runs on any Android 14+ phone.

<div align="center">
  <img src="design/screenshots/01-first-launch.png" width="130">
  <img src="design/screenshots/02-always-on.png" width="130">
  <img src="design/screenshots/03-quick-deploy.png" width="130">
  <img src="design/screenshots/04-memory.png" width="130">
  <img src="design/screenshots/05-solana.png" width="130">
  <img src="design/screenshots/06-skills.png" width="130">
</div>

## 🏆 Award

**Winner — Solana Mobile Hackathon** · April 2026

SeekerClaw was selected as a winner of the Solana Mobile Hackathon, recognized for running a full AI agent on-device on the Solana Seeker. v2 builds on that foundation with autonomous USDC payments via the burner wallet — turning the on-device agent from a smart assistant into an actual economic agent on Solana.

[Announcement →](https://x.com/RadiantsDAO/status/2049549148395798847)

## Features

| | Feature | What it does |
|---|---|---|
| :robot: | **AI Engine** | Claude, OpenAI (API key + Codex OAuth), OpenRouter, or any OpenAI-compatible gateway (Custom). Multi-turn tool use, extended thinking on supported models |
| :credit_card: | **Autonomous Payments (x402)** | A separate, app-stored burner wallet (you import a key once) lets the agent pay for paid APIs in USDC on Solana — within per-tx and daily caps you set in Settings. Supports x402 v1 + v2 end-to-end including POST settlement (GET silent under cap, POST always confirmed). 44 catalogued endpoints across 10 services (Stablecrypto Market Data, Tripadvisor, Rentcast, Perplexity, WolframAlpha, Reducto, CrushRewards, 2Captcha, Textbelt SMS, Purch). **OPT-IN** — the catalog activates only when you explicitly ask to pay. Burner key encrypted under Android Keystore (AES-256-GCM); your main wallet stays user-controlled. |
| :thought_balloon: | **Extended Thinking** | Toggle in Settings → AI Provider → Reasoning or via `/think` from chat. Supported models (Fable 5, Opus 4.8 / 4.7 / 4.6, Sonnet 4.6, GPT-5.5 / 5.4 / 5.3-codex, gpt-5.4-mini) think across tool calls, with reasoning preserved across `/resume` and tool-loop turns on **all four providers** (Claude, OpenAI, OpenRouter, Custom). |
| :speech_balloon: | **Channels** | Telegram (full bot — reactions, file sharing, inline keyboards) or Discord (Gateway v10 — DMs, media, reply threading) |
| :link: | **Solana Wallets** | **Main wallet:** swaps, limit orders, DCA, transfers via Jupiter + MWA — you sign every action. **Burner wallet:** a key you import once, used for capped autonomous USDC payments (see Autonomous Payments below). |
| :iphone: | **Device Control** | Battery, GPS, camera, SMS, calls, clipboard, TTS |
| :brain: | **Memory** | Persistent personality, daily notes, ranked keyword search, session summaries preserved across user-Stop |
| :pause_button: | **Graceful Stop** | Tapping Stop Agent triggers a bounded flush handshake — pending session summaries and dirty SQL.js writes persist before the Node.js process exits. Last ~60s of activity survives a clean Stop. |
| :alarm_clock: | **Scheduling** | Cron jobs with natural language ("remind me in 30 min") |
| :globe_with_meridians: | **Web Intel** | Search (Brave / Perplexity / Exa / Tavily / Firecrawl), fetch, caching |
| :gear: | **Live Settings** | Change provider, model, MCP servers, search provider, or agent name in Settings — or from chat with `/model`, `/provider`, `/think` — and changes take effect on the very next AI turn. No agent restart, no lost session. Backed by cross-process JSON stores read by both the UI process and the `:node` service. |
| :key: | **Env Vars** | Plug arbitrary API keys into the agent via Settings → Env Vars (single add or `.env`-style bulk paste). Skills and tools read them at runtime via `process.env.KEY`; values masked from debug logs. Skills can gate on `requires.env` so missing keys block activation cleanly |
| :bar_chart: | **Activity** | 26-week heatmap of your agent's API requests on the System screen — see when it's active, spot quiet days. Up to 13 months of daily history persisted on-device |
| :electric_plug: | **Extensible** | 35+ partner skills + custom skills + MCP remote tools |

## Autonomous Payments

v2 makes SeekerClaw the first on-device agent that can actually transact on the open web. Two wallets, two roles:

- **Main wallet (you sign):** Phantom or any MWA wallet. Used for swaps, transfers, DCA, limit orders. Every action goes through a wallet popup.
- **Burner wallet (agent signs, within caps):** A Solana Ed25519 keypair *you import once* (from Phantom, Solflare, a hardware wallet, or `solana-keygen`) — encrypted at rest under Android Keystore (AES-256-GCM). **SeekerClaw does not generate keys.** Used only for x402 micropayments to paid APIs. You set per-tx and daily caps in USDC and SOL; the agent cannot exceed them.

With a funded burner, the agent uses three new tools — `agent_pay`, `wallet_status`, `wallet_set_caps` — to fetch x402-protected endpoints and settle payments. GET requests under cap settle silently; POST requests always ask for confirmation. SSRF defense, DNS-rebinding protection, and an 18-error-code DIAGNOSTICS playbook are built in.

**x402 v2 is live end-to-end.** `agent_pay` completes the full 402 → build USDC transfer → settle → retrieve response loop for v2 services including Tripadvisor, CoinGecko (via Stablecrypto Market Data), and Textbelt SMS POST. No "detect/build only" caveats — POST settlement works.

**Catalogued services (bundled paysh-catalog skill, OPT-IN):**

- Stablecrypto Market Data — 21 endpoints (CoinGecko + DefiLlama)
- Tripadvisor (5), Rentcast (5), CrushRewards (4)
- Perplexity (2), WolframAlpha (2), Reducto (2)
- 2Captcha, Textbelt SMS, Purch (1 each)

The catalog was built from a 72-service / 824-endpoint audit of the [pay.sh](https://pay.sh) ecosystem (BAT-706); 63 known-but-not-usable service entries are documented in `unsupported.json` with structured failure reasons. The catalog stays dormant unless you explicitly ask to pay ("pay", "x402", "paysh").

**Burner key security:** Imported Ed25519 seed stored under `filesDir/burner_keys/<id>`, encrypted with a Keystore-derived AES-256-GCM key. Signing happens inside the Kotlin vault — the Node.js process sends a transaction blob and gets back a signature; it never holds the raw key. Loopback bridge requires a per-boot auth token. `android:allowBackup=false` keeps burner keys out of cloud backups. `agent_pay` resolves DNS before any HTTP request and refuses private-range IPs.

**Opt out anytime:** Settings → Burner Wallet → Wipe Keys. The agent reverts to single-wallet mode with paysh-catalog dormant — zero behavior change vs v1.10.

<details>
<summary><strong>Architecture</strong></summary>

<br>

```mermaid
graph LR
    You["You (Telegram)"] -->|messages| Agent["SeekerClaw Agent"]
    Agent -->|reasoning| AI["AI Provider (Claude / OpenAI / OpenRouter / Custom)"]
    Agent -->|swaps, balance| Solana["Solana / Jupiter"]
    Agent -->|device access| Bridge["Android Bridge"]
    Agent -->|search, fetch| Web["Web APIs"]
    AI -->|tool calls| Agent
```

**On-device stack:**

```
Android App (Kotlin, Jetpack Compose)  ~27K lines, 68 files
 └─ Foreground Service (:node process)
     └─ Node.js Runtime (nodejs-mobile)  ~24K lines, 50+ JS modules
         ├─ ai.js                    — AI provider API, system prompt, conversations, /think
         ├─ message-handler.js       — Inbound message routing, commands, auto-resume
         ├─ providers/               — Claude, OpenAI (API key + Codex OAuth), OpenRouter, Custom adapters
         ├─ tools/                   — 63 tool handlers across 13 modules (incl. agent_pay, wallet_status, wallet_set_caps)
         ├─ payment/x402.js          — x402 v1 + v2 payment protocol (detect / build / settle — v2 settle is live end-to-end)
         ├─ wallet/dispatch.js       — Routes signing through burner (capped, silent) or main (popup)
         ├─ caps/preflight.js        — Per-tx and daily cap preflight checks before any tx
         ├─ confirmation/policy.js   — Confirmation gates (burner-silent vs main-confirm vs blocked)
         ├─ reasoning-gating.js      — Per-provider reasoning echo policy (R1 strip, V4 echo, etc.)
         ├─ reasoning-recovery.js    — Adaptive 3-step quarantine on 400 reasoning_content errors
         ├─ reasoning-redact.js      — sha256 fingerprint-only logging for reasoning content
         ├─ silent-reply.js          — [[SILENT_REPLY]] sentinel handling
         ├─ loop-detector.js         — Identical-call loop detection (3 warn / 5 break)
         ├─ http.js                  — HTTP/HTTPS transport, SSE streaming
         ├─ task-store.js            — Persistent task checkpoints
         ├─ solana.js                — Jupiter swaps, DCA, limit orders
         ├─ telegram.js              — Bot, formatting, commands, repetition detector
         ├─ telegram-commands.js     — Single-source registry for /commands menu + /help (drift-guarded)
         ├─ discord.js               — Discord Gateway v10 client + REST sends
         ├─ channel.js               — Channel router (telegram | discord)
         ├─ memory.js                — Persistent memory + ranked search
         ├─ skills.js                — Skill loading + semantic routing
         ├─ cron.js                  — Job scheduling + natural language parsing
         ├─ mcp-client.js            — MCP Streamable HTTP client (rug-pull detection)
         ├─ mcp-servers.js           — MCP server config CrossProcessStore (BAT-514)
         ├─ internal-control-server.js — Loopback control endpoints (/healthz, /mcp/reconcile, /shutdown/flush)
         ├─ runtime-state.js         — Live provider/authType/model overlay (BAT-513)
         ├─ agent-preferences.js     — searchProvider + agentName cross-process store (BAT-515)
         ├─ model-catalog.js         — Shared model registry (BAT-517)
         ├─ web.js                   — Search providers + fetch + caching
         ├─ database.js              — SQL.js analytics + flushForShutdown (BAT-525)
         ├─ security.js              — Prompt injection defense
         ├─ bridge.js                — Android Bridge HTTP client (main process)
         ├─ config.js                — Config loading + validation
         └─ main.js                  — Orchestrator + heartbeat + cron timer
```

</details>

## Quick Start

**Prerequisites:** Android Studio, JDK 17, Android SDK 35

```bash
git clone https://github.com/sepivip/SeekerClaw.git
cd SeekerClaw
./gradlew assembleDappStoreDebug
adb install app/build/outputs/apk/dappStore/debug/app-dappStore-debug.apk
```

Open the app → pick your AI provider (Claude, OpenAI, or OpenRouter) → enter your API key + [Telegram bot token](https://t.me/BotFather) + choose a model + name your agent — or generate a QR code at [seekerclaw.xyz/setup](https://seekerclaw.xyz/setup) and scan it. Done. For custom gateways (DeepSeek, Ollama, LiteLLM, etc.), configure in Settings after setup.

> **Step-by-step setup guide:** [How to set up SeekerClaw](https://x.com/SeekerClaw/status/2029197829068005849)

> **Beta** — SeekerClaw is under active development. Expect rough edges and breaking changes. Issues and PRs welcome.

## Partner Skills

SeekerClaw also ships 22 bundled skills out of the box — including the v2 additions `burner-wallet` and `paysh-catalog`, plus calculator, weather, news, research, summarize, translate, reminders, todo, github, crypto-prices, and more. See the [full partner skills catalog](https://seekerclaw.xyz/partner-skills) for all 35+ third-party options available from the marketplace.

Install via Telegram: send your agent the install link and it handles the rest.

| | Skill | What it does | Install |
|---|---|---|---|
| :ocean: | **Byreal** | Trade on Byreal DEX — pool analytics, swap quotes, LP positions, copy top farmers | [Install](https://seekerclaw.xyz/partner-skills/byreal.md) |
| :rocket: | **Career Companion** | AI career coach — job search, resume tailoring, mock interviews, salary research | [Install](https://seekerclaw.xyz/partner-skills/career-companion.md) |
| :paw_prints: | **ClawPump** | Launch tokens on Solana via pump.fun — gasless launches | [Install](https://seekerclaw.xyz/partner-skills/clawpump.md) |
| :crystal_ball: | **Dune Analytics** | Query onchain data — DEX trades, token stats, wallet activity | [Install](https://seekerclaw.xyz/partner-skills/dune-analytics.md) |
| :house: | **Home Assistant** | Control smart home — lights, climate, vacuum, alarm, media | [Install](https://seekerclaw.xyz/partner-skills/home-assistant.md) |

> **Build your own:** Skills are Markdown files with YAML frontmatter. See [SKILL-FORMAT.md](SKILL-FORMAT.md) for the spec.

## Important Safety Notice

SeekerClaw gives an AI agent real capabilities on your phone — including wallet transactions, messaging, and device control. Please be aware:

- **AI can make mistakes.** Large language models hallucinate, misinterpret instructions, and occasionally take unintended actions. Always verify before trusting critical outputs.
- **Prompt injection is a real risk.** Malicious content from websites, messages, or files could manipulate the agent. SeekerClaw includes defenses, but no system is bulletproof.
- **Wallet transactions are irreversible.** Swaps, transfers, and DCA orders on Solana cannot be undone. The agent requires confirmation for financial actions — read the details before approving.
- **Start with small amounts.** Don't connect a wallet with significant funds until you're comfortable with how the agent behaves.
- **The burner wallet pays autonomously, within caps.** v2's burner wallet — a key *you import once* — can settle x402 payments without prompting you, as long as the transaction stays under your per-tx and daily caps. Set caps you're comfortable with the agent spending, and only fund the burner with what you'd be okay losing if the agent makes a poor call. Your main wallet remains popup-protected.
- **You are responsible for your agent's actions.** SeekerClaw is a tool, not financial advice. The developers are not liable for any losses.

> **TL;DR:** Treat your agent like a capable but imperfect assistant. Verify important actions, secure your wallet, and don't trust it with more than you can afford to lose.

## Community

Thanks to all contributors:

<a href="https://github.com/sepivip"><img src="https://github.com/sepivip.png" width="50" height="50" alt="sepivip" title="sepivip — creator"></a>
<a href="https://github.com/DashLabsDev"><img src="https://github.com/DashLabsDev.png" width="50" height="50" alt="DashLabsDev" title="DashLabsDev — code contributor"></a>
<a href="https://github.com/DyorAlex"><img src="https://github.com/DyorAlex.png" width="50" height="50" alt="DyorAlex" title="DyorAlex — proposed OpenRouter support, shipped in v1.7.0"></a>
<a href="https://github.com/LevanIlashvili"><img src="https://github.com/LevanIlashvili.png" width="50" height="50" alt="LevanIlashvili" title="LevanIlashvili — security audit contributor"></a>
<a href="https://github.com/Tofu-killer"><img src="https://github.com/Tofu-killer.png" width="50" height="50" alt="Tofu-killer" title="Tofu-killer — proposed and prototyped Custom Provider support"></a>

## Links

**Website:** [seekerclaw.xyz](https://seekerclaw.xyz) · **Product Hunt:** [SeekerClaw](https://www.producthunt.com/products/seekerclaw) · **Twitter:** [@SeekerClaw](https://x.com/SeekerClaw) · **Telegram:** [t.me/seekerclaw](https://t.me/seekerclaw)

---

<div align="center">

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [License](LICENSE)

</div>
