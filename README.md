<div align="center">
  <img src="design/symbol.svg" alt="SeekerClaw" width="80">
  <h1>SeekerClaw</h1>
  <p><em>AgentOS for Android</em></p>
  <p><strong>A 24/7 AI agent that lives on your phone</strong></p>

  <p>
    <img src="https://img.shields.io/badge/Android-14+-3DDC84?logo=android&logoColor=white" alt="Android 14+">
    <img src="https://img.shields.io/badge/Kotlin-2.0-7F52FF?logo=kotlin&logoColor=white" alt="Kotlin">
    <img src="https://img.shields.io/badge/Claude-Powered-cc785c?logo=anthropic&logoColor=white" alt="Claude">
    <img src="https://img.shields.io/badge/Solana-Seeker-9945FF?logo=solana&logoColor=white" alt="Solana">
    <img src="https://img.shields.io/badge/Telegram-Bot-26A5E4?logo=telegram&logoColor=white" alt="Telegram">
    <img src="https://img.shields.io/badge/License-MIT-blue" alt="MIT License">
  </p>
</div>

---

SeekerClaw embeds a Node.js AI agent inside an Android app, running 24/7 as a foreground service. You interact through Telegram — ask questions, control your phone, trade crypto, schedule tasks. **56 tools, 35 skills, Solana wallet**, all running locally on your device. Built for the Solana Seeker, runs on any Android 14+ phone.

<div align="center">
  <img src="design/screenshots/01-first-launch.png" width="130">
  <img src="design/screenshots/02-always-on.png" width="130">
  <img src="design/screenshots/03-quick-deploy.png" width="130">
  <img src="design/screenshots/04-memory.png" width="130">
  <img src="design/screenshots/05-solana.png" width="130">
  <img src="design/screenshots/06-skills.png" width="130">
  <img src="design/screenshots/07-explore.png" width="130">
</div>

## Features

| | Feature | What it does |
|---|---|---|
| :robot: | **AI Engine** | Claude (Opus / Sonnet / Haiku) with multi-turn tool use |
| :speech_balloon: | **Telegram** | Full bot — reactions, file sharing, inline keyboards, 12 commands |
| :link: | **Solana Wallet** | Swaps, limit orders, DCA, transfers via Jupiter + MWA |
| :iphone: | **Device Control** | Battery, GPS, camera, SMS, calls, clipboard, TTS |
| :brain: | **Memory** | Persistent personality, daily notes, ranked keyword search |
| :alarm_clock: | **Scheduling** | Cron jobs with natural language ("remind me in 30 min") |
| :globe_with_meridians: | **Web Intel** | Search (Brave / DuckDuckGo / Perplexity), fetch, caching |
| :electric_plug: | **Extensible** | 35 skills + custom skills + MCP remote tools |

<details>
<summary><strong>Architecture</strong></summary>

<br>

```mermaid
graph LR
    You["You (Telegram)"] -->|messages| Agent["SeekerClaw Agent"]
    Agent -->|reasoning| Claude["Claude API"]
    Agent -->|swaps, balance| Solana["Solana / Jupiter"]
    Agent -->|device access| Bridge["Android Bridge"]
    Agent -->|search, fetch| Web["Web APIs"]
    Claude -->|tool calls| Agent
```

**On-device stack:**

```
Android App (Kotlin, Jetpack Compose)
 └─ Foreground Service
     └─ Node.js Runtime (nodejs-mobile)
         ├─ claude.js      — Claude API, system prompt, conversations
         ├─ tools.js       — 56 tool handlers + confirmations
         ├─ solana.js      — Jupiter swaps, DCA, limit orders
         ├─ telegram.js    — Bot, formatting, commands
         ├─ memory.js      — Persistent memory + ranked search
         ├─ skills.js      — Skill loading + semantic routing
         ├─ cron.js        — Job scheduling + natural language parsing
         ├─ mcp-client.js  — MCP Streamable HTTP client
         ├─ web.js         — Search + fetch + caching
         ├─ database.js    — SQL.js analytics
         ├─ security.js    — Prompt injection defense
         ├─ bridge.js      — Android Bridge HTTP client
         ├─ config.js      — Config loading + validation
         └─ main.js        — Orchestrator + heartbeat
```

</details>

## Quick Start

**Prerequisites:** Android Studio, JDK 17, Android SDK 35

```bash
git clone https://github.com/sepivip/SeekerClaw.git
cd SeekerClaw
./gradlew assembleDebug
adb install app/build/outputs/apk/debug/app-debug.apk
```

Open the app → scan QR or enter your [Anthropic API key](https://console.anthropic.com/) + [Telegram bot token](https://t.me/BotFather) → choose a model → name your agent → done.

> **Beta** — SeekerClaw is under active development. Expect rough edges and breaking changes. Issues and PRs welcome.

## Links

**Website:** [seekerclaw.xyz](https://seekerclaw.xyz) · **Twitter:** [@SeekerClaw](https://x.com/SeekerClaw)

---

<div align="center">

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [License](LICENSE)

</div>
