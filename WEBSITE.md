# WEBSITE.md — Website Content

> Last updated: 2026-02-23 | Last deployed: _never_
>
> **Rule:** Every item must earn its screen space. Less is more.
> Before deploying, review the Editorial Notes in each section.
>
> **How to use:** Compare this file with `SeekerClaw_Web/js/config.js` + `index.html`.
> Copy updated content into those files. After deploying, set "Last deployed" date.

---

## Content Strategy

<!-- Review this section every 2 weeks or when major features ship -->

**Target audience:** Solana Seeker phone owners who want more from their device
**Primary hook:** Your phone becomes an autonomous AI agent (24/7, on-device, via Telegram)
**Secondary hooks:** Crypto-native (wallet, swaps, DCA), device control, privacy (runs locally)

**Current market trends to leverage:**
- AI agents are mainstream — position as "your personal one"
- On-device AI is trending (Apple Intelligence, Galaxy AI) — we're the crypto version
- Jupiter/Solana ecosystem is active — show DeFi capabilities

**What NOT to lead with:**
- Internal tech details (SQL.js, OpenClaw parity, cron implementation)
- Developer-facing features (MCP servers, shell exec, js_eval)
- Feature counts alone — "54 tools" means nothing without context

---

## Stats (4 values)
<!-- Maps to: config.js → stats[] -->
<!-- Derived from: PROJECT.md → Stats -->

| Value | Label | Why this stat? |
|-------|-------|---------------|
| 150,000+ | Seeker Devices | Social proof — large addressable market |
| 56+ | Built-in Tools | Shows depth — but consider "50+" for cleaner number |
| 179+ | PRs Shipped | Shows velocity — but do users care about PRs? |
| 24/7 | Autonomous Agent | Key differentiator — always on |

<!-- REVIEW: Is "PRs Shipped" the right 3rd stat? Alternatives:
  - "34 Skills" — shows extensibility
  - "16 Integrations" — sounds more user-facing
  - "13 Device Controls" — highlights Android bridge
  Consider what makes a user think "I need this" -->

---

## Hero
<!-- Maps to: config.js → hero -->

- **Tag:** Built for Solana Seeker
- **Title:** The AI Agent Layer / for Solana Seeker
- **Description:** SeekerClaw turns your Seeker phone into an autonomous AI agent. Monitor your wallet, trade on Jupiter, get Telegram alerts, control your device — all running 24/7 on your phone.
- **CTA Primary:** Get on dApp Store
- **CTA Secondary:** Quick Setup

<!-- REVIEW: "AI Agent Layer" — is this clear to non-technical users?
   Alternatives: "Your Phone's AI Brain", "Always-On AI Assistant" -->

---

## Feature Cards (6)
<!-- Maps to: config.js → features.items[] + index.html static cards -->

### 1. Solana Wallet Integration (icon: clock)
Check SOL & SPL token balances, send transactions, swap tokens via Jupiter,
create limit orders and DCA positions — all secured by Seed Vault hardware.

### 2. Autonomous AI Agent (icon: brain)
Powered by Claude (Opus / Sonnet / Haiku) with persistent memory,
customizable personality, and scheduled automation running 24/7.
Self-aware — knows its own capabilities, diagnoses its own issues,
and tells you what went wrong instead of failing silently.

### 3. Social & Messaging (icon: chat)
Telegram integration with reactions, file sharing, and vision analysis.
Send SMS, make calls, manage contacts — your agent handles it all.

### 4. Deep Device Control (icon: terminal)
GPS location, camera with AI vision, app launching, clipboard, battery
monitoring, text-to-speech — full native control of your Seeker.

### 5. Web Intelligence (icon: globe)
Real-time web search, page reading, crypto prices, news, weather,
and deep research on any topic — delivered to your chat.

### 6. Modular Skill System (icon: tool)
35 built-in skills: crypto prices, calorie tracking, news briefings,
reminders, research, and more. Add custom skills without touching code.

<!-- REVIEW: Card order matters. Currently: Wallet → AI → Social → Device → Web → Skills
   Should Wallet lead? Or should AI Agent lead since that's the primary value prop?
   Consider: AI Agent → Wallet → Web → Device → Social → Skills -->

---

## Self-Aware Agent
<!-- Maps to: new section in index.html, after features/capabilities -->
<!-- Position: after "What SeekerClaw Does" (capabilities), before "How It Works" or Use Cases -->

**Title:** An Agent That Knows Itself

**Subtitle:** SeekerClaw scores 100% on SAB (Self-Awareness Benchmark) — 36 audit points across knowledge and diagnostics.

**Three points:**

- **Knows what it can do** — Your agent understands its own tools, limits, and configuration. Ask it anything about itself and it answers accurately.
- **Diagnoses its own problems** — When something breaks, it checks logs, reads health files, and pinpoints the issue — across Telegram, wallet, memory, scheduling, and device control.
- **Tells you what's wrong** — No silent failures. If the API is down, a permission is missing, or a tool times out — your agent explains what happened and what to do next.

<!-- REVIEW: Consider a visual element — a circular badge showing "100%" or "36/36 ✅"
   alongside the three points. Keeps it punchy and adds visual proof. -->

---

## Use Cases (6)
<!-- Maps to: config.js → useCases.items[] -->

### Wallet Watcher (icon: eye)
- "Alert me on Telegram when my SOL balance drops below 5"
- "Check my portfolio every morning and send me a summary"

### DeFi Assistant (icon: trending-up)
- "What's the current price of SOL, JUP, and BONK?"
- "Swap 1 SOL to USDC with less than 1% slippage"

### Onchain Notifications (icon: bell)
- Agent monitors your wallet and sends alerts for incoming/outgoing transactions.

### Crypto Calendar (icon: calendar)
- "Remind me about the Jupiter airdrop claim on March 15th"
- "Every Friday at 6pm, show me my weekly portfolio performance"

### Shell & DevOps (icon: terminal)
- "Check disk space and clean up old files"
- "Curl this API endpoint and summarize the JSON response"

### Web Research (icon: globe)
- "Search the web for the latest Solana Mobile news"
- "Fetch this article and give me a 3-bullet summary"

<!-- REVIEW: "Shell & DevOps" — does a Seeker owner care about this?
   This is a developer use case on a consumer device.
   Consider replacing with:
   - "Health & Fitness" — "Track my calories from a food photo" (CalClaw!)
   - "Daily Briefing" — "Every morning, send me crypto news + portfolio update"
   - "Smart Home" — future, but aspirational
   CalClaw is a strong candidate — food photo → calories is very visual and relatable -->

---

## Comparison Table
<!-- Maps to: config.js → comparison.rows[] -->

| Feature | Regular AI Apps | SeekerClaw on Seeker |
|---------|----------------|---------------------|
| Runs on device | Cloud only | ✓ Native on Seeker |
| Wallet access | ✗ | ✓ Via Seed Vault |
| Persistent memory | ✗ | ✓ Learns and remembers |
| Shell access | ✗ | ✓ 22 Unix commands + curl |
| Messaging + reactions | ✗ | ✓ Telegram with full formatting |
| Crypto-native | ✗ | ✓ Solana-first |
| Cron scheduling | ✗ | ✓ Natural language + recurring |
| Usage analytics | ✗ | ✓ Per-session token tracking |
| Error resilience | ✗ | ✓ Auto-retry + graceful fallback |
| Self-diagnosis | ✗ | ✓ Agent knows when something's wrong and tells you |
| Hardware wallet security | ✗ | ✓ Seed Vault signing |

<!-- REVIEW: "Regular AI Apps" is vague. Users compare against ChatGPT, Siri, Gemini.
   Consider: "ChatGPT / Gemini" as the comparison column header — more concrete.
   Also: "Usage analytics" and "Error resilience" are technical. Do users care?
   Consider replacing with:
   - "Photo analysis" — food photos, documents, screenshots
   - "File sharing" — send/receive files via Telegram
   - "Device control" — GPS, camera, SMS, calls -->

---

## Roadmap
<!-- Maps to: config.js → roadmap.columns[] -->
<!-- Shipped derived from: PROJECT.md → Features Shipped + Changelog -->

### Shipped
- Persistent memory with ranked search
- Android device bridge (SMS, calls, GPS, camera, apps, contacts)
- Solana wallet (balance, send, swap, limit orders, DCA)
- Telegram with reactions, file sharing, and AI vision
- 56 built-in tools with analytics
- Natural language cron scheduling
- Multi-provider web search + page reading
- MCP server support for extensible tools
- 35 skills including CalClaw calorie tracker and Netwatch security audit
- OpenClaw v2026.2.22 parity
- Open-source: MIT license, CI/CD, community contribution ready

<!-- REVIEW: 10 items. Max ~8 for readability. Consider cutting:
   - "OpenClaw parity" — meaningless to users, internal metric
   - "MCP server support" — developer feature
   Keep the items that make users say "I want that" -->

### Next
- Transaction monitoring & smart alerts
- Vector embeddings for semantic memory
- dApp Store listing
- Community skill marketplace

### Future
- Multi-agent coordination
- X, Discord & WhatsApp integration
- Multi-chain support
- DePIN & IoT device control
- Agent-to-agent economy on Solana

---

## Vision
<!-- Maps to: config.js → vision -->

**Title:** The Vision
**Text:** Every Seeker owner gets a personal AI agent that lives on their phone 24/7 — monitors their wallet, keeps them informed via Telegram, and gets smarter every day.
**Tagline:** SeekerClaw is how Solana Seeker becomes the first true AI + Crypto phone.

---

## Static HTML Notes
<!-- These require index.html edits, not config.js -->

**JSON-LD featureList** (index.html ~line 34-79):
- Remove: "NFT tracking" (not implemented)
- Remove: "DeFi automation" (overpromise)
- Add: "AI calorie tracking", "MCP extensibility"

**OG/Twitter meta descriptions:**
- Update to: "Turn your Seeker phone into an autonomous AI agent. Monitor wallets, trade on Jupiter, get Telegram alerts — 24/7 on-device."

---

## Deployment Checklist

When deploying WEBSITE.md to the website:
- [ ] Review all `<!-- REVIEW -->` comments — resolve before deploying
- [ ] Update `config.js → stats[]`
- [ ] Update `config.js → features.items[]` descriptions
- [ ] Update `config.js → roadmap.columns[]`
- [ ] Update `config.js → comparison.rows[]`
- [ ] Update `config.js → useCases.items[]`
- [ ] Update `index.html` → feature cards (static HTML)
- [ ] Update `index.html` → JSON-LD + OG meta
- [ ] Set "Last deployed" date at top of this file
