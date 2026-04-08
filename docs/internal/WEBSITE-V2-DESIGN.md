# WEBSITE v2 — Design Spec

> Created: 2026-04-08
> Status: Design approved, pending implementation
> Companion to: `WEBSITE.md` (current content) → this file defines the v2 rewrite

---

## Goal

Reposition SeekerClaw.xyz from a **crypto-first** feel to a **mainstream-first** feel, while keeping crypto/Solana as a proud (but later) section. Current live site still leans on "AI agent" and "autonomously" in the hero — jargon that bounces non-technical visitors in the first 3 seconds.

**Target audience (v2):** broad mainstream — productivity users, tech-curious Seeker owners, privacy-conscious on-device AI fans, *and* crypto-native users. Crypto is one capability among many, not the identity.

**Design north star:** "magical, quiet, powerful helper." Borrow tonal cues from [atomicbot.ai](https://atomicbot.ai) — playful mascot, conversational-yet-confident copy, dark+gradient premium aesthetic, personification over abstraction.

**Forbidden words in hero/top-of-page:** "agent" (in the normie section), "autonomous", "LLM", "on-device" (in that phrasing), "crypto", "Solana", "blockchain", "web3". These can all appear later, in sections built for the audience that wants them.

---

## Hero (locked)

- **Tag:** 🦞📲 AgentOS for your Android phone
- **Title:** Like having someone brilliant in your pocket.
- **Sub:** SeekerClaw turns your phone into a 24/7 helper powered by the world's best AI — Claude, GPT, and more. Text it on Telegram or Discord. It thinks, remembers, watches over your stuff, and quietly handles the boring parts of your day.
- **CTA Primary:** Get it on dApp Store
- **CTA Secondary:** See it in action (scroll anchor to the chat mockup)

**Design rationale:**
- **Tag "AgentOS for your Android phone"** does the category-defining work in 5 words — the quotable line for tweets, press, dApp Store subtitle. Saves "agent" jargon for a framing that sounds like *infrastructure*, not a feature.
- **Title "Like having someone brilliant in your pocket"** does the emotional work. Personification over abstraction. Never uses the word "AI" or "agent." Works for grandma.
- **Sub reveals the power** ("world's best AI — Claude, GPT, and more") — this is the magic. SeekerClaw is not a "little AI" — it runs the same frontier models people pay for in ChatGPT.
- **"Text it on Telegram or Discord"** tells the first-time visitor *how* they'd actually use it, in 6 words. Removes the "what does interaction look like" mystery.
- **🦞📲** emoji motif: crab claw + phone. Steal atomicbot's mascot trick. Should repeat throughout the page (favicon, section dividers, loading states, footer).
- **"Lives on your Android phone"** is avoided in the tag this time — "AgentOS for your Android phone" already places it. Seeker is a proud dedicated section later (section 8).

---

## Page Structure (11 sections)

The page deliberately delays crypto/Solana until section 8. A non-crypto visitor gets three full screens of mainstream value (hero → chat moment → scenarios → how it works → social proof → self-awareness → feature deep-dive) before Solana is named. A crypto-curious visitor finds everything, just later — and in a section built for them.

### 1. Hero
As locked above.

### 2. "Just text it." — the proof moment
A **single chat screenshot mockup** showing 3–4 real exchanges with SeekerClaw on Telegram. No other content in this section — the mockup *is* the section.

Example exchanges to render (final copy TBD during implementation):
- *"morning brief please"* → agent replies with weather + calendar + news bullets
- *"remind me tomorrow at 9 to call mom"* → agent confirms + sets cron
- *"did my package ship?"* → agent searches email/web + answers
- *"what's going on with SOL today?"* (optional — a subtle crypto wink)

**Purpose:** the "oh, I get it" moment. A visitor who scrolls from the hero should see this and immediately understand the product without reading any more words.

**Design notes:** Full-bleed dark panel. Chat bubbles styled like actual Telegram (or Discord — maybe a toggle between the two). Subtle glow/gradient behind. No headline needed — or just a tiny caption: *"This is the whole product."*

### 3. "What it quietly does for you" — 3 lifestyle scenarios
Replaces the current "6 feature cards" as the first capability section. Three big, plain-language scenarios — not feature cards.

| Icon | Title | Copy |
|------|-------|------|
| 🧠 | **Thinks with you** | Ask it anything. Research anything. Summarize long articles, draft emails, work through problems out loud, or just chat. It's as smart as the best AI on the planet — because it *is* the best AI on the planet. |
| 👀 | **Watches over things** | Keep an eye on your inbox, your calendar, your smart home, your bills — and, if you're into that, your Solana wallet. It pings you when something matters and stays quiet when it doesn't. |
| 🪄 | **Runs your chores** | Reminders, daily briefings, smart-home controls, file handling, messages, research tasks. Tell it once, and it just… keeps doing it. 24/7, forever. |

**Rationale:** Crypto lives inside **"Watches over things"** as one bullet — present for users who care, invisible to users who don't. The word "Solana" appears here exactly once.

### 4. "How it works" — 3 steps
Borrowed wholesale from atomicbot's radical-simplicity play.

1. **Install on your Seeker** (or any Android phone)
2. **Connect your Telegram or Discord**
3. **Start chatting. It's live.**

Minimal copy. Maybe one line under each step. Visual: 3-column layout, big numbered circles, tiny icons, lots of whitespace.

### 5. Social proof
Stats reframed in human language, plus room for user quotes if/when available.

| Old framing | New framing |
|-------------|-------------|
| 200,000+ Seeker Devices | **200k+ phones** it runs on |
| 56+ Built-in Tools | **56 things it can do** out of the box |
| 255+ PRs Shipped | *(drop — normies don't care)* |
| 100% SAB Score | **100%** self-awareness score |

Replace "PRs shipped" with something user-facing like **"35+ skills"** or **"Always updating"**.

Reserve vertical space for 2–3 user testimonial cards (populate over time as the user collects quotes from Seeker owners, Telegram users, and Discord users).

### 6. "It knows what it can and can't do" — Self-Aware Agent
Keep this section — it's genuinely differentiating and the 100% badge is great marketing. But retitle from *"An Agent That Knows Itself"* to something plainer. Proposed title: **"It knows what it can and can't do."**

Subtitle: *"Unlike most AI, SeekerClaw is brutally honest about its own capabilities, limits, and mistakes. If something's broken, it tells you — and tells you how to fix it."*

Three bullets (reworded from current):
- **Knows its tools** — ask it what it can do, it answers accurately. No hallucinated features.
- **Diagnoses itself** — something broken? It checks its own logs, finds the problem, explains it in plain English.
- **No silent failures** — API down, permission missing, tool timed out? You hear about it, with a fix.

Visual: a **100%** badge or circular "36/36 ✅" proof element. This is where a trust-building visitor pauses.

### 7. Feature deep-dive (6 cards)
The current 6 feature cards live **here** — section 7, not section 2. This is for the scrolling power-user who wants the meat.

Reordered and rewritten for mainstream-first framing:

1. **🤖 The best AI on earth** — Claude Opus, GPT-5, Sonnet, 100+ models via OpenRouter. Pick your brain.
2. **💬 Chat wherever you already are** — Telegram and Discord, with reactions, file sharing, and photo analysis.
3. **📱 Full phone powers** — GPS, camera, SMS, calls, contacts, apps, clipboard, text-to-speech.
4. **🌐 The web, read for you** — search, page reading, research, news, weather, crypto prices.
5. **🧩 35+ skills, extensible** — calorie tracker, security audits, news briefings, smart home, and you can add your own.
6. **💰 Crypto-native** (the *last* card, not the first) — Solana wallet, Jupiter swaps, DCA, limit orders, NFT tracking, secured by Seed Vault.

**Key change vs. current site:** the crypto card is #6, not #1. It's still there, still proud, still detailed — but the first five cards establish "this is a mainstream productivity tool" before crypto is mentioned.

### 8. "Built for Solana Seeker" — the dedicated Seeker section
Now — *after* the mainstream pitch has landed — the Seeker section gets to shine.

**Title:** Built for the Solana Seeker.
**Sub:** SeekerClaw runs on any Android 14+ phone, but it was made for one in particular.

Three reasons Seeker is the perfect home:
- **🔐 Seed Vault** — hardware-secured crypto, so your AI can touch your wallet safely.
- **📶 Stock Android** — no OEM ROM killing the background service. It actually stays on 24/7.
- **💪 8GB RAM, Snapdragon 6 Gen 1** — enough headroom to run Node.js, a full AI pipeline, and your normal phone life in parallel.

This is where a crypto-curious visitor or a Seeker owner feels seen. The section doubles as a "why Seeker is special" pitch for Solana Mobile itself.

### 9. "Why not just ChatGPT?" — comparison table
Keep the current comparison table structure, but:

- **Retitle** from vague *"Regular AI Apps vs SeekerClaw on Seeker"* to concrete **"ChatGPT / Gemini vs SeekerClaw."**
- **Drop technical rows** that normies don't parse: "Usage analytics", "Error resilience", "Shell access (33 Unix commands + curl)".
- **Add user-facing rows:** "Photo analysis", "File sharing in chat", "Runs in the background", "Can text you first", "Control your phone (SMS, calls, apps)".
- **Keep the crypto rows** but move them to the bottom of the table (consistent with the "crypto is one thing among many" narrative).

### 10. Roadmap
Trim to **max 6 shipped items** (current has 18). Cut internal/developer items ("OpenClaw parity", "MCP server support", "CI/CD"). Keep items that make a user say *"I want that."*

**Shipped (6):**
- 24/7 background agent with memory
- 56 built-in tools + 35 skills
- Telegram + Discord with reactions, photos, files
- Full phone control (GPS, camera, SMS, calls, apps)
- Solana wallet with Jupiter swaps + DCA
- Self-aware: 100% SAB score

**Next:** keep current list.
**Future:** keep current list, but move "Agent-to-agent economy on Solana" to the top (it's the most exciting line).

### 11. Vision + closing CTA
Keep the current Vision section, but rewrite the closing line to match the new positioning.

**Title:** The Vision
**Text:** Every phone owner gets a brilliant helper that lives in their pocket, thinks with them, and quietly handles the boring parts of life. The first and best one runs on Solana Seeker.
**Closing CTA:** Get SeekerClaw → dApp Store button

---

## Tonal & Visual Guidelines

Borrowed from atomicbot.ai, adapted for SeekerClaw:

- **Dark mode primary** — matches DarkOps theme: deep navy background, crimson red accents, green for status/success.
- **Gradient borders and subtle glows** on key elements (hero, chat mockup, self-awareness badge).
- **🦞📲 as recurring motif** — favicon, section dividers, loading spinners, footer.
- **Conversational copy voice** — *"quietly handles the boring parts of your day"* not *"automates daily workflows."* Feel like a friend wrote it.
- **Personification over abstraction** — "someone brilliant", "quiet helper", "watches over things" — NOT "agent", "AI assistant", "autonomous system."
- **No feature dumps** in the upper half of the page. Scenarios and chat mockups do the work; feature cards wait until section 7.

---

## Content Mapping (implementation notes)

When implementing in `SeekerClaw_Web/`:

| v2 Section | File(s) to update |
|------------|-------------------|
| Hero | `config.js → hero`, `index.html` hero block |
| Chat mockup (§2) | New section in `index.html` + asset(s) in `assets/mockups/` |
| Lifestyle scenarios (§3) | New section in `index.html` (replaces feature card position) |
| How it works (§4) | `config.js → howItWorks` (new) or new `index.html` block |
| Social proof (§5) | `config.js → stats[]` (rewording) |
| Self-awareness (§6) | Existing section — retitle + reword |
| Feature deep-dive (§7) | `config.js → features.items[]` — reorder, crypto last |
| Seeker section (§8) | New `index.html` block |
| Comparison (§9) | `config.js → comparison.rows[]` — rewrite header, drop technical rows |
| Roadmap (§10) | `config.js → roadmap.columns[]` — trim to 6 |
| Vision (§11) | `config.js → vision` — rewrite closing line |

**Meta / SEO:**
- OG description: *"Like having someone brilliant in your pocket. SeekerClaw is AgentOS for your Android phone — Claude & GPT, 24/7, on Telegram or Discord."*
- JSON-LD: drop "DeFi automation", keep "AI calorie tracking", "smart home control", "photo analysis", "wallet integration".
- Page title: `SeekerClaw — AgentOS for your Android phone`

---

## Non-Goals

- **Not redesigning the visual theme.** DarkOps stays. This is a content + structure refresh, not a visual overhaul.
- **Not removing crypto content.** Every crypto feature that exists today stays on the page — just repositioned as "one proud capability" instead of "the identity."
- **Not adding new features.** This spec only covers what exists today (as of app v1.9.0, OpenClaw 2026.3.24).
- **Not translating to other languages.** English only.

---

## Open Questions (to resolve in implementation plan)

1. **Chat mockup (§2):** Telegram-styled, Discord-styled, or toggle between the two? Recommend: **Telegram** (larger user base, cleaner aesthetic), with a small "also works on Discord" note.
2. **Testimonials (§5):** Do we have any real user quotes to pull from Telegram/Discord/GitHub yet? If not, leave the section with just stats for v2 launch and add quotes in a v2.1 pass.
3. **Mascot illustration:** Do we want to commission an actual 🦞📲 mascot illustration (not just the emoji), the way atomicbot has a stylized crab? Out of scope for this spec, but worth flagging as a follow-up.
4. **dApp Store CTA:** Is the Seeker dApp Store listing live yet? If not, the primary CTA should temporarily be "Quick Setup" or "Download APK" until listing goes live.

---

## Approval

- [x] Audience repositioning (mainstream-first, crypto as one section) — approved
- [x] Hero (Option 2: AgentOS tag + "brilliant in your pocket" title) — approved
- [x] 🦞📲 motif — approved
- [x] 11-section structure, Solana at §8 — approved
- [ ] User final review of this written spec — pending

---

## Next Step

Once this spec is approved, invoke the **writing-plans** skill to turn it into a step-by-step implementation plan against `SeekerClaw_Web/` (config.js + index.html edits, new section scaffolding, asset creation).
