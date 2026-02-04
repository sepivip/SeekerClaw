# Phase 4: Android Superpowers

> **Goal:** Make SeekerClaw the most powerful mobile AI agent by leveraging Android-specific capabilities that desktop OpenClaw cannot access.

---

## Architecture Clarification

**IMPORTANT:** This follows the OpenClaw approach:

| Type | What It Is | Example |
|------|------------|---------|
| **Skill** | SKILL.md instruction file teaching agent to use existing tools | `github.md` teaches agent to use `web_fetch` with GitHub API |
| **Tool** | Actual code in main.js that provides new capability | `android_sms` tool sends SMS via Android bridge |

**Rule:** Only add new tools when:
1. OAuth authentication is required (can't do stateless)
2. Android native APIs are needed (no web equivalent)
3. Complex stateful operations are needed

**Most API integrations = SKILL.md files using `web_fetch`**

---

## Overview

SeekerClaw has unique advantages over desktop OpenClaw:
- **Always with you** — Phone is always in your pocket
- **Android APIs** — Access to phone sensors, apps, and services
- **Solana Seeker** — Built-in crypto wallet (future)
- **24/7 portable** — Truly personal agent

---

## Part A: SKILL.md Files (Instructions Only)

These are pure instruction files that teach the agent how to use `web_fetch` with various APIs. **No new code needed** — just markdown files in `workspace/skills/`.

### 🟢 No API Key Required (Free APIs)

| Skill | API | Notes |
|-------|-----|-------|
| **crypto-prices** | CoinGecko | Free, no key, rate limited |
| **movie-tv** | TMDB | Free with registration |
| **youtube-info** | YouTube oEmbed | Free, limited info |
| **recipe** | TheMealDB | Free, no key |
| **dictionary** | Free Dictionary API | Free, no key |
| **quote-of-day** | Quotable API | Free, no key |
| **ip-lookup** | ip-api.com | Free, no key |
| **exchange-rates** | ExchangeRate-API | Free tier available |

### 🟡 API Key Required (User Provides)

| Skill | API | Key Source |
|-------|-----|------------|
| **github** | GitHub REST API | User's personal token |
| **notion** | Notion API | User's integration token |
| **trello** | Trello REST API | User's API key + token |
| **openai-image** | OpenAI DALL-E | User's OpenAI key |
| **elevenlabs-tts** | ElevenLabs | User's API key |
| **giphy** | Giphy/Tenor | Free API key |
| **stocks** | Alpha Vantage | Free tier with key |
| **flight-tracker** | AviationStack | Free tier with key |
| **package-tracker** | 17track | Free tier with key |
| **home-assistant** | Home Assistant | User's HA instance + token |

### Example: crypto-prices SKILL.md

```markdown
---
name: crypto-prices
description: "Get real-time cryptocurrency prices and market data"
metadata:
  openclaw:
    emoji: "💰"
    requires:
      bins: []
      env: []
---

# Crypto Prices

Get cryptocurrency prices using the free CoinGecko API.

## Usage

When the user asks for crypto prices, use the `web_fetch` tool:

### Get single coin price
```
web_fetch({
  url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
  method: "GET"
})
```

### Get multiple coins
```
web_fetch({
  url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true",
  method: "GET"
})
```

### Coin name mapping
- BTC = bitcoin
- ETH = ethereum
- SOL = solana
- USDC = usd-coin
- DOGE = dogecoin

## Response Format

Present prices clearly:
- Bitcoin (BTC): $XX,XXX.XX
- Include 24h change if requested

## Rate Limits

CoinGecko free tier: 10-30 calls/minute. Don't spam requests.
```

### Example: github SKILL.md

```markdown
---
name: github
description: "Search repos, view issues, check PRs on GitHub"
metadata:
  openclaw:
    emoji: "🐙"
    requires:
      bins: []
      env: ["GITHUB_TOKEN"]
---

# GitHub

Interact with GitHub using the REST API.

## Setup

User must set GITHUB_TOKEN in their config. Check `memory_read` for stored token or ask user.

## Usage

### Search repositories
```
web_fetch({
  url: "https://api.github.com/search/repositories?q=seekerclaw",
  method: "GET",
  headers: {
    "Authorization": "Bearer {GITHUB_TOKEN}",
    "Accept": "application/vnd.github+json"
  }
})
```

### Get user's repos
```
web_fetch({
  url: "https://api.github.com/user/repos",
  method: "GET",
  headers: {
    "Authorization": "Bearer {GITHUB_TOKEN}"
  }
})
```

### Get repo issues
```
web_fetch({
  url: "https://api.github.com/repos/{owner}/{repo}/issues",
  method: "GET",
  headers: {
    "Authorization": "Bearer {GITHUB_TOKEN}"
  }
})
```

## Without Token

Can still search public repos without auth (lower rate limit):
```
web_fetch({
  url: "https://api.github.com/search/repositories?q=language:kotlin+stars:>1000",
  method: "GET"
})
```
```

---

## Part B: New Tools Required (Actual Code)

These require actual tool implementations in `main.js` because they either need OAuth or Android native APIs.

### 🔐 OAuth Tools (2 tools)

These APIs require OAuth 2.0 flow which can't be done with simple `web_fetch`:

| Tool | Why Tool Needed | Implementation |
|------|-----------------|----------------|
| **spotify_auth** | OAuth 2.0 PKCE flow | Store refresh token, handle token refresh |
| **google_auth** | OAuth 2.0 flow | For Calendar, Drive, etc. |

**Note:** After OAuth, the actual API calls can use `web_fetch` with the access token. The tool just handles the auth flow.

### 📱 Android Bridge Tools (10 tools)

These require Android native APIs with no web equivalent:

| Tool | Android API | Permission |
|------|-------------|------------|
| **android_location** | LocationManager | ACCESS_FINE_LOCATION |
| **android_contacts_read** | ContactsProvider | READ_CONTACTS |
| **android_contacts_write** | ContactsProvider | WRITE_CONTACTS |
| **android_sms** | SmsManager | SEND_SMS |
| **android_call** | Intent.ACTION_CALL | CALL_PHONE |
| **android_clipboard_get** | ClipboardManager | — |
| **android_clipboard_set** | ClipboardManager | — |
| **android_battery** | BatteryManager | — |
| **android_tts** | TextToSpeech | — |
| **android_app_launch** | PackageManager | — |

---

## Part C: Android Bridge Architecture

```
┌─────────────────────────────────────────────┐
│           Node.js (main.js)                  │
│  ┌─────────────────────────────────────────┐│
│  │  Tools: android_*                       ││
│  │  Makes HTTP calls to localhost:8765     ││
│  └────────────────┬────────────────────────┘│
│                   │                          │
└───────────────────┼──────────────────────────┘
                    │ HTTP POST
┌───────────────────▼──────────────────────────┐
│         Kotlin (AndroidBridge.kt)             │
│  ┌──────────────────────────────────────────┐│
│  │  NanoHTTPD server on localhost:8765      ││
│  │                                          ││
│  │  POST /location → LocationManager        ││
│  │  POST /contacts → ContactsProvider       ││
│  │  POST /sms      → SmsManager             ││
│  │  POST /call     → TelecomManager         ││
│  │  POST /clipboard→ ClipboardManager       ││
│  │  POST /battery  → BatteryManager         ││
│  │  POST /tts      → TextToSpeech           ││
│  │  POST /launch   → PackageManager         ││
│  └──────────────────────────────────────────┘│
└──────────────────────────────────────────────┘
```

**Implementation Steps:**
1. Add NanoHTTPD dependency to build.gradle
2. Create `AndroidBridge.kt` with HTTP server
3. Start bridge server in OpenClawService alongside Node.js
4. Add `android_*` tools to main.js that POST to bridge
5. Create SKILL.md files that instruct agent when to use these tools

---

## Part D: SKILL.md Files for Android Tools

Even Android tools need instruction files! The skill teaches the agent WHEN and HOW to use the tool.

### Example: sms SKILL.md

```markdown
---
name: sms
description: "Send SMS text messages to contacts or phone numbers"
metadata:
  openclaw:
    emoji: "💬"
    requires:
      bins: []
---

# SMS

Send text messages using the Android SMS tool.

## When to Use

User says things like:
- "Text John that I'll be late"
- "Send SMS to 555-1234"
- "Message Mom happy birthday"

## Usage

### Send to phone number
```
android_sms({
  phone: "+15551234567",
  message: "Hello!"
})
```

### Send to contact
First look up the contact:
```
android_contacts_read({ query: "John" })
```
Then send using their number.

## Important

- Always confirm before sending
- Don't send to unknown numbers without asking
- Keep messages concise (160 char limit for single SMS)
```

---

## Implementation Roadmap

### Sprint 1: Free API Skills (SKILL.md only)
- [ ] crypto-prices.md (CoinGecko)
- [ ] movie-tv.md (TMDB)
- [ ] recipe.md (TheMealDB)
- [ ] exchange-rates.md

### Sprint 2: API Key Skills (SKILL.md only)
- [ ] github.md
- [ ] notion.md
- [ ] trello.md
- [ ] stocks.md

### Sprint 3: Android Bridge (Tools + Skills)
- [ ] Create AndroidBridge.kt
- [ ] android_location tool + location.md skill
- [ ] android_contacts_read tool + contacts.md skill
- [ ] android_sms tool + sms.md skill
- [ ] android_call tool + phone-call.md skill

### Sprint 4: More Android (Tools + Skills)
- [ ] android_clipboard tools + clipboard.md
- [ ] android_battery tool + device-status.md
- [ ] android_tts tool + speak.md
- [ ] android_app_launch tool + app-launcher.md

### Sprint 5: OAuth (Tools + Skills)
- [ ] spotify_auth tool + spotify.md skill
- [ ] google_auth tool + google-calendar.md skill

### Sprint 6: Solana (Future)
- [ ] Seed Vault integration
- [ ] solana-wallet tools
- [ ] nft-gallery skill

---

## Summary: What We're Building

| Type | Count | Examples |
|------|-------|----------|
| **SKILL.md files** | ~20 | crypto-prices, github, movie-tv |
| **Android Bridge tools** | 10 | android_sms, android_location |
| **OAuth tools** | 2 | spotify_auth, google_auth |
| **TOTAL new tools** | 12 | |

**Key insight:** Most "features" are just SKILL.md instruction files, not code!

---

## Permissions Required

| Feature | Android Permission | Runtime? |
|---------|-------------------|----------|
| Location | ACCESS_FINE_LOCATION | Yes |
| Contacts (read) | READ_CONTACTS | Yes |
| Contacts (write) | WRITE_CONTACTS | Yes |
| SMS | SEND_SMS | Yes |
| Phone Calls | CALL_PHONE | Yes |

---

## What Makes Us Better Than OpenClaw

| Feature | OpenClaw | SeekerClaw |
|---------|----------|------------|
| 24/7 Availability | Desktop must be on | ✅ Phone always on |
| Portability | Tied to computer | ✅ Always with you |
| Location Awareness | ❌ No GPS | ✅ GPS location |
| Phone Calls | ❌ No | ✅ Yes |
| SMS | ❌ No | ✅ Yes |
| Contacts | ❌ No | ✅ Yes |
| Crypto Wallet | ❌ No native | ✅ Solana Seeker |
| Voice Output | Requires setup | ✅ Android TTS |
| App Control | macOS only | ✅ Android intents |

---

*Last updated: 2026-02-04*
*Architecture: Skills = Instructions, Tools = Code*
