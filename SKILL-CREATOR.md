# SKILL-CREATOR.md — Skill Creator Page Spec

> **For:** The Claude Code instance building `seekerclaw.xyz`
> **Page URL:** `seekerclaw.xyz/skill-creator` (or `/skills/create`)
> **Type:** Single-page client-side tool. No backend. No API calls. Privacy-first.

---

## 1. Overview

A web page that helps SeekerClaw users create custom skills for their AI agent. Skills are `.md` files with YAML frontmatter that teach the agent new capabilities (e.g., "check crypto prices", "send SMS", "look up recipes").

### Three Creation Modes

| Mode | For whom | What it does |
|------|----------|-------------|
| **Blank** | Power users who know the format | Empty editor with all SKILL.md sections. User fills everything manually. |
| **Template** | Users who want a head start | Pick from 13 real skills. Pre-fills the editor. User customizes. |
| **Claude CC Prompt** | Everyone else (the magic one) | User answers 5 simple questions. Page generates a complete prompt they copy-paste into Claude Code / Claude. Claude writes the perfect skill. |

### Output

- **Blank & Template modes** → Valid SKILL.md content (copy to clipboard or download as `.md` file)
- **Claude CC Prompt mode** → A complete prompt (copy to clipboard) that the user pastes into Claude Code or any Claude interface

---

## 2. SKILL.md Format Specification

Every skill is a markdown file with two parts: **YAML frontmatter** + **markdown body**.

### YAML Frontmatter

```yaml
---
name: skill-name-in-kebab-case
version: "1.0.0"
description: "One-line description shown to the AI when deciding whether to use this skill"
metadata:
  openclaw:
    emoji: "🔧"
    requires:
      bins: []
      env: []
---
```

**Fields:**

| Field | Required | Type | Notes |
|-------|----------|------|-------|
| `name` | Yes | string | Kebab-case identifier (e.g., `crypto-prices`, `daily-standup`) |
| `version` | Yes | string | Semantic version, always quoted (e.g., `"1.0.0"`) |
| `description` | Yes | string | One-line. The AI reads this to decide when to activate the skill |
| `metadata.openclaw.emoji` | Yes | string | Single emoji representing the skill |
| `metadata.openclaw.requires.bins` | No | string[] | Shell commands the skill needs (e.g., `["curl"]`). Usually `[]` |
| `metadata.openclaw.requires.env` | No | string[] | Environment variables needed (e.g., `["GITHUB_TOKEN"]`). Usually `[]` |

### Markdown Body Structure

```markdown
# Skill Title

Brief intro sentence.

## When to Use

User asks about:
- "Example trigger message 1"
- "Example trigger message 2"
- "Example trigger message 3"

## Usage

### Action Name

\```javascript
tool_name({ param: "value" })
\```

Response:
\```json
{ "key": "value" }
\```

Format response:
"🔧 **Label:** formatted result"

## Response Format

Present results clearly:
\```
🔧 **Title**
- Detail 1
- Detail 2
\```

## Error Handling

If [error condition]:
"User-friendly error message"

## Examples

**User:** "example message"
**Action:** Description of what the agent should do

**User:** "another example"
**Action:** Description of what the agent should do
```

### Validation Rules

The skill parser enforces these rules (warnings logged if violated):
- `name` is required
- `description` is required
- `version` is recommended (needed for future auto-update support)
- Legacy `Trigger:` lines in markdown body work but are deprecated — use frontmatter instead

---

## 3. Mode Specs

### Mode 1: Blank

**Editor sections (all empty):**

| Section | Input type | Default value |
|---------|-----------|---------------|
| Name | Text input | `""` |
| Emoji | Emoji picker or text input | `"🔧"` |
| Description | Textarea (1-2 lines) | `""` |
| Version | Text input | `"1.0.0"` |
| Required env vars | Tag input (add/remove) | `[]` |
| Required bins | Tag input (add/remove) | `[]` |
| Instructions | Large markdown textarea | Empty with placeholder hint |

**Live preview panel** shows the generated SKILL.md updating in real-time as the user types.

**Validation:** Warn if name or description is empty before allowing copy/download.

---

### Mode 2: Template

**Template picker:** Grid/list of 13 skill cards. Each card shows emoji, name, and description. Clicking one loads it into the editor (same editor as Blank mode, but pre-filled).

**Template data: see Section 5 below** (all 13 skills with full content).

---

### Mode 3: Claude CC Prompt

**User input form:**

| Field | Label | Input type | Required | Placeholder text |
|-------|-------|-----------|----------|-----------------|
| `purpose` | What should this skill do? | Textarea (3-4 lines) | Yes | "Track my daily water intake and remind me to drink" |
| `api_service` | What API or service will it use? | Text input | No | "CoinGecko API (free, no key)" or "None — just device tools" |
| `example_messages` | Example messages that should trigger it | Textarea (3-4 lines) | No | "Log 2 glasses of water\nHow much water today?\nRemind me to drink" |
| `tools` | What tools should the agent use? | Checkbox grid (grouped) | No | Pre-grouped by category (see Section 6) |
| `api_keys` | Does it need any API keys or credentials? | Text input | No | "None" or "TMDB_API_KEY" |

**Output:** A complete prompt displayed in a code block with a "Copy Prompt" button. The prompt is built from the template in Section 4 below, with `{placeholders}` replaced by user input.

**Reference example selection logic:**
- If any device tools are checked (android_*) → include the "Speak" example
- If web_fetch or web_search is checked → include the "Crypto Prices" example
- If both → include both
- If neither → include one of each (default)

---

## 4. Claude CC Prompt Template

This is the **exact prompt template** to embed in the page JS. Replace `{placeholders}` with user input. The backticks in code blocks below are literal — they must appear in the generated prompt.

```
Create a SeekerClaw skill file. SeekerClaw is an Android app that runs an AI agent on the Solana Seeker phone. Skills are SKILL.md files that teach the agent new capabilities.

## SKILL.md Format

The file has two parts: YAML frontmatter (delimited by ---) and a markdown body.

### Frontmatter (required):

---
name: skill-name-kebab-case
version: "1.0.0"
description: "One sentence — the AI reads this to decide when to use the skill"
metadata:
  openclaw:
    emoji: "🔧"
    requires:
      bins: []
      env: [{api_keys_as_yaml_list}]
---

### Body sections (in order):

1. # Title — skill name as heading
2. Brief intro (1-2 sentences)
3. ## When to Use — bullet list of example user messages
4. ## Usage — sub-sections with tool call code blocks (```javascript), expected responses (```json), and formatted output examples
5. ## Response Format — how to present results to the user (use emoji)
6. ## Error Handling — what to say when things fail
7. ## Examples — "User:" / "Action:" pairs showing trigger→behavior

{reference_examples_block}

## Skill to Create

- **Purpose:** {purpose}
- **API/Service:** {api_service}
- **Example user messages that should trigger it:**
{example_messages_formatted}
- **Tools to use:** {tools_comma_separated}
- **API keys or credentials needed:** {api_keys}

## Rules

- Tool calls use function syntax: tool_name({ param: "value" })
- Include 3-5 example trigger messages in "When to Use"
- Include 2-4 "User:"/"Action:" pairs in "Examples"
- Show realistic API responses in code blocks
- Use emoji in response formats for visual clarity
- Include error handling (permission denied, API errors, not found)
- Only reference tools the skill actually needs
- Keep the file practical and actionable — the AI follows these instructions literally

## Available SeekerClaw Tools (only use what's needed)

{tools_reference_for_checked_categories}

Save the file as: workspace/skills/{name_slug}/SKILL.md

Output ONLY the file content. No explanations.
```

### Reference Examples (inserted at `{reference_examples_block}`)

**When web/API tools are selected:**

```
## Reference Example: API-Based Skill

---
name: crypto-prices
version: "1.0.0"
description: "Get real-time cryptocurrency prices and market data from CoinGecko (free, no API key)"
metadata:
  openclaw:
    emoji: "💰"
    requires:
      bins: []
      env: []
---

# Crypto Prices

Get cryptocurrency prices using the free CoinGecko API.

## When to Use

User asks about:
- Crypto prices ("What's Bitcoin at?", "SOL price")
- Market data ("Is ETH up or down?")
- Multiple coins ("Price of BTC, ETH, and SOL")

## Usage

### Get coin price

```javascript
web_fetch({
  url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true"
})
```

Response: `{"bitcoin":{"usd":45000,"usd_24h_change":2.3}}`

## Response Format

```
💰 Bitcoin (BTC): $45,123.45 (+2.3% 24h)
```

## Error Handling

If rate limited, wait 60 seconds before retrying.

## Examples

**User:** "What's the price of Bitcoin?"
**Action:** Fetch BTC price, format nicely

**User:** "How are BTC and ETH doing?"
**Action:** Fetch both with 24h change, show comparison
```

**When device tools are selected:**

```
## Reference Example: Device Tool Skill

---
name: speak
version: "1.0.0"
description: "Speak text out loud using device text-to-speech"
metadata:
  openclaw:
    emoji: "🔊"
    requires:
      bins: []
      env: []
---

# Speak (Text-to-Speech)

Speak text out loud using Android's built-in text-to-speech.

## When to Use

User asks to:
- Read something aloud ("Read this to me")
- Speak a message ("Say hello")
- Announce something ("Announce the time")

## Usage

```javascript
android_tts({ text: "Hello! How can I help you today?" })
```

Optional parameters:
- speed: 0.5 (slow) to 2.0 (fast), default 1.0
- pitch: 0.5 (low) to 2.0 (high), default 1.0

## Response Format

After speaking, confirm:
"🔊 *Speaking:* [summary of what was said]"

## Examples

**User:** "What time is it? Tell me out loud"
**Action:** Get time, speak it via android_tts
```

### Placeholder Formatting Rules

| Placeholder | How to fill | Example |
|-------------|------------|---------|
| `{purpose}` | Verbatim from user input | "Track daily water intake and remind me to drink" |
| `{api_service}` | Verbatim, or "None" if empty | "CoinGecko API (free, no key)" |
| `{example_messages_formatted}` | Each message as a bullet: `  - "message"` | `  - "Log 2 glasses"\n  - "How much water today?"` |
| `{tools_comma_separated}` | Comma-separated checked tools | "memory_save, memory_search, cron_create" |
| `{api_keys}` | Verbatim, or "None" if empty | "TMDB_API_KEY" |
| `{api_keys_as_yaml_list}` | YAML list, or empty `[]` | `["TMDB_API_KEY"]` or `[]` |
| `{name_slug}` | Kebab-case from purpose (auto-generate) | "water-tracker" |
| `{reference_examples_block}` | 1-2 examples based on selected tools (see above) | API example, device example, or both |
| `{tools_reference_for_checked_categories}` | Tool names + one-line descriptions for checked tool categories only (see Section 6) | "- web_fetch: Fetch a URL, returns markdown/JSON/text\n- web_search: Search the web via DuckDuckGo" |

---

## 5. Template Data (All 13 Skills)

Each template below includes its full SKILL.md content. In the implementation, store these as JS objects or strings and load them into the editor when the user selects a template.

### Template 1: crypto-prices

- **Emoji:** 💰
- **Category:** Crypto & DeFi
- **Description:** Get real-time cryptocurrency prices and market data from CoinGecko (free, no API key)

```markdown
---
name: crypto-prices
version: "1.0.0"
description: "Get real-time cryptocurrency prices and market data from CoinGecko (free, no API key)"
metadata:
  openclaw:
    emoji: "💰"
    requires:
      bins: []
      env: []
---

# Crypto Prices

Get cryptocurrency prices using the free CoinGecko API.

## When to Use

User asks about:
- Crypto prices ("What's Bitcoin at?", "SOL price")
- Market data ("Is ETH up or down?")
- Multiple coins ("Price of BTC, ETH, and SOL")

## API Endpoints

### Get single coin price

```javascript
web_fetch({
  url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
})
```

Response: `{"bitcoin":{"usd":45000}}`

### Get multiple coins with 24h change

```javascript
web_fetch({
  url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true"
})
```

### Get detailed coin info

```javascript
web_fetch({
  url: "https://api.coingecko.com/api/v3/coins/bitcoin"
})
```

Returns market cap, volume, all-time high, etc.

## Coin ID Mapping

Common coins and their CoinGecko IDs:

| Symbol | CoinGecko ID |
|--------|--------------|
| BTC | bitcoin |
| ETH | ethereum |
| SOL | solana |
| USDC | usd-coin |
| USDT | tether |
| BNB | binancecoin |
| XRP | ripple |
| ADA | cardano |
| DOGE | dogecoin |
| AVAX | avalanche-2 |

For other coins, search: `https://api.coingecko.com/api/v3/search?query=COINNAME`

## Response Format

Present prices clearly to the user:

```
Bitcoin (BTC): $45,123.45 (+2.3% 24h)
Ethereum (ETH): $2,456.78 (-1.2% 24h)
Solana (SOL): $98.76 (+5.4% 24h)
```

## Rate Limits

CoinGecko free tier: 10-30 requests/minute. Don't spam requests.
If rate limited, wait 60 seconds before retrying.

## Examples

**User:** "What's the price of Bitcoin?"
**Action:** Fetch BTC price, format nicely

**User:** "How are BTC and ETH doing?"
**Action:** Fetch both with 24h change, show comparison

**User:** "Give me SOL market cap"
**Action:** Use detailed endpoint for Solana, extract market_cap
```

---

### Template 2: solana-wallet

- **Emoji:** 🪙
- **Category:** Crypto & DeFi
- **Description:** Check Solana wallet balance, transaction history, and send SOL with wallet approval

```markdown
---
name: solana-wallet
version: "1.0.0"
description: "Check Solana wallet balance, transaction history, and send SOL with wallet approval"
metadata:
  openclaw:
    emoji: "🪙"
    requires:
      bins: []
      env: []
---

# Solana Wallet

Interact with the user's Solana wallet connected via the SeekerClaw app.

## When to Use

User asks about:
- Wallet balance ("What's my SOL balance?", "How much crypto do I have?")
- Token holdings ("Do I have any tokens?", "Show my wallet")
- Transaction history ("Show my recent transactions")
- Sending SOL ("Send 0.1 SOL to ...")
- Wallet address ("What's my wallet address?")

## Tools Available

| Tool | Purpose |
|------|---------|
| `solana_address` | Get connected wallet address |
| `solana_balance` | Get SOL + SPL token balances |
| `solana_history` | Get recent transaction history |
| `solana_send` | Send SOL (requires user + wallet approval) |

## Usage

### Check Balance

```javascript
solana_balance()
```

Response:
```json
{
  "address": "7xKX...",
  "sol": 2.5,
  "tokens": [
    { "mint": "EPjF...Dt1v", "amount": "100.0", "decimals": 6 }
  ]
}
```

Format:
```
🪙 **Wallet Balance**
💰 **SOL:** 2.5 SOL
🪙 **USDC:** 100.0
```

### Send SOL

**CRITICAL: Always confirm first!**

```javascript
solana_send({ to: "RecipientAddress...", amount: 0.1 })
```

## Examples

**User:** "What's my SOL balance?"
**Action:** Call solana_balance, format nicely

**User:** "Send 0.5 SOL to 9aE2..."
**Action:** Show confirmation, wait for yes, then call solana_send
```

---

### Template 3: solana-dapp

- **Emoji:** 📱
- **Category:** Crypto & DeFi
- **Description:** Discover, launch, and interact with Solana dApps on the Seeker device

```markdown
---
name: solana-dapp
version: "1.0.0"
description: "Discover, launch, and interact with Solana dApps on the Seeker device via the dApp Store and MWA"
metadata:
  openclaw:
    emoji: "📱"
    requires:
      bins: []
      env: []
---

# Solana Seeker dApp

Discover, launch, and manage Solana dApps on the Solana Seeker device.

## When to Use

User asks about:
- Solana dApps ("What dApps do I have?")
- dApp Store ("Find a swap app")
- Launching dApps ("Open Jupiter")
- DeFi on Seeker ("How do I swap tokens?")

## Tools Available

| Tool | Purpose |
|------|---------|
| `android_apps_list` | List installed apps |
| `android_apps_launch` | Launch an app by package name |
| `web_fetch` | Look up dApp info |
| `solana_balance` | Check wallet balance |

## Known dApp Package Names

| App | Package | Category |
|-----|---------|----------|
| Phantom | `app.phantom` | Wallet |
| Jupiter | `ag.jup.mobile` | DEX / Swap |
| Tensor | `com.tensor.android` | NFT Marketplace |
| Magic Eden | `io.magiceden.android` | NFT Marketplace |
| Marinade | `finance.marinade.app` | Staking |

## Usage

### List installed dApps
```javascript
android_apps_list()
```

### Launch a dApp
```javascript
android_apps_launch({ package: "ag.jup.mobile" })
```

## Examples

**User:** "Open Jupiter"
**Action:** Launch ag.jup.mobile, guide user on swapping

**User:** "What Solana apps do I have?"
**Action:** List apps, match against known dApp packages
```

---

### Template 4: device-status

- **Emoji:** 🔋
- **Category:** Device
- **Description:** Check battery level, storage space, and device status

```markdown
---
name: device-status
version: "1.0.0"
description: "Check battery level, storage space, and device status"
metadata:
  openclaw:
    emoji: "🔋"
    requires:
      bins: []
      env: []
---

# Device Status

Check device status including battery, storage, and more.

## When to Use

User asks about:
- Battery level ("How much battery do I have?")
- Storage space ("How much space is left?")
- Device info ("What's my phone status?")

## Usage

### Battery Status

```javascript
android_battery()
```

Response:
```json
{ "level": 75, "isCharging": true, "chargeType": "usb" }
```

Format: "🔋 **Battery:** 75% (charging via USB)"

### Storage Status

```javascript
android_storage()
```

Response:
```json
{ "totalFormatted": "120.00 GB", "availableFormatted": "42.00 GB" }
```

Format: "💾 **Storage:** 42 GB available of 120 GB (65% used)"

## Warnings

If battery < 20%: "⚠️ Battery is low. Consider charging soon."
If storage < 10%: "⚠️ Storage is almost full."

## Examples

**User:** "How much battery do I have?"
**Action:** Call android_battery, format with emoji

**User:** "Phone status?"
**Action:** Call both android_battery and android_storage, combine
```

---

### Template 5: location

- **Emoji:** 📍
- **Category:** Device
- **Description:** Get current GPS location and find nearby places

```markdown
---
name: location
version: "1.0.0"
description: "Get current GPS location and find nearby places"
metadata:
  openclaw:
    emoji: "📍"
    requires:
      bins: []
      env: []
---

# Location

Get current GPS location and find nearby places.

## When to Use

User asks about:
- Current location ("Where am I?")
- Nearby places ("Find coffee shops near me")

## Usage

```javascript
android_location()
```

Response:
```json
{ "latitude": 37.7749, "longitude": -122.4194, "accuracy": 10.5 }
```

### Find Nearby Places

After getting location:
```javascript
web_search({ query: "coffee shops near 37.7749, -122.4194" })
```

## Response Format

"📍 **Your Location**
Coordinates: 37.7749, -122.4194
[Open in Google Maps](https://maps.google.com/?q=37.7749,-122.4194)"

## Examples

**User:** "Where am I?"
**Action:** Get GPS location, show coordinates + map link

**User:** "Find pizza near me"
**Action:** Get location, web search nearby, list results
```

---

### Template 6: speak

- **Emoji:** 🔊
- **Category:** Device
- **Description:** Speak text out loud using device text-to-speech

```markdown
---
name: speak
version: "1.0.0"
description: "Speak text out loud using device text-to-speech"
metadata:
  openclaw:
    emoji: "🔊"
    requires:
      bins: []
      env: []
---

# Speak (Text-to-Speech)

Speak text out loud using Android's built-in text-to-speech.

## When to Use

User asks to:
- Read something aloud ("Read this to me")
- Speak a message ("Say hello")
- Announce something ("Announce the time")

## Usage

```javascript
android_tts({ text: "Hello! How can I help you today?" })
```

Optional: speed (0.5–2.0, default 1.0), pitch (0.5–2.0, default 1.0)

## Response Format

After speaking, confirm: "🔊 *Speaking:* [summary]"

## Examples

**User:** "What time is it? Tell me out loud"
**Action:** Get time, speak via android_tts

**User:** "Read me the weather"
**Action:** Fetch weather, then speak summary
```

---

### Template 7: phone-call

- **Emoji:** 📞
- **Category:** Device
- **Description:** Make phone calls to contacts or phone numbers

```markdown
---
name: phone-call
version: "1.0.0"
description: "Make phone calls to contacts or phone numbers"
metadata:
  openclaw:
    emoji: "📞"
    requires:
      bins: []
      env: []
---

# Phone Call

Make phone calls using the Android call tool.

## When to Use

User says: "Call Mom", "Phone John", "Dial 555-1234"

## CRITICAL: Always confirm before calling!

## Usage

### Step 1: Find contact
```javascript
android_contacts_search({ query: "Mom" })
```

### Step 2: Confirm with user
"📞 Call **Mom** (+1 555-123-4567)? Say 'yes' to call."

### Step 3: Make call
```javascript
android_call({ phone: "+15551234567" })
```

## Examples

**User:** "Call Mom"
**Action:** Search contacts, confirm, then dial

**User:** "Call the nearest pizza place"
**Action:** Web search for number, confirm, then dial
```

---

### Template 8: sms

- **Emoji:** 💬
- **Category:** Device
- **Description:** Send SMS text messages to contacts or phone numbers

```markdown
---
name: sms
version: "1.0.0"
description: "Send SMS text messages to contacts or phone numbers"
metadata:
  openclaw:
    emoji: "💬"
    requires:
      bins: []
      env: []
---

# SMS

Send text messages using the Android SMS tool.

## When to Use

User says: "Text John that I'll be late", "Send SMS to 555-1234", "Message Mom happy birthday"

## CRITICAL: Always confirm message content before sending!

## Usage

### Step 1: Find contact
```javascript
android_contacts_search({ query: "John" })
```

### Step 2: Confirm
"📱 **To:** John Smith (+1 555-123-4567)
💬 **Message:** Running 10 minutes late!
Should I send it?"

### Step 3: Send
```javascript
android_sms({ phone: "+15551234567", message: "Running 10 minutes late!" })
```

## Examples

**User:** "Text John that I'll be late"
**Action:** Find John, compose message, confirm, send

**User:** "Send Mom a happy birthday text"
**Action:** Find Mom, compose birthday message, confirm, send
```

---

### Template 9: github

- **Emoji:** 🐙
- **Category:** Web & API
- **Description:** Search repositories, view issues, check PRs, manage GitHub projects

```markdown
---
name: github
version: "1.0.0"
description: "Search repositories, view issues, check PRs, manage GitHub projects"
metadata:
  openclaw:
    emoji: "🐙"
    requires:
      bins: []
      env: ["GITHUB_TOKEN"]
---

# GitHub

Interact with GitHub using the REST API.

## When to Use

User asks about:
- Repositories ("Find Kotlin repos", "My repos")
- Issues ("Open issues on X")
- Pull requests ("PRs waiting for review")

## Authentication

Needs a GitHub Personal Access Token for private repos/higher rate limits.

## API Endpoints

Base URL: `https://api.github.com`

### Search repos
```javascript
web_fetch({
  url: "https://api.github.com/search/repositories?q=language:kotlin+stars:>1000&sort=stars"
})
```

### Authenticated requests
```javascript
web_fetch({
  url: "https://api.github.com/user/repos?sort=updated",
  headers: { "Authorization": "Bearer {GITHUB_TOKEN}" }
})
```

## Rate Limits

Unauthenticated: 60/hour. Authenticated: 5,000/hour.

## Examples

**User:** "Find popular Rust projects"
**Action:** Search repos with language:rust, sort by stars

**User:** "Show my recent PRs"
**Action:** Search user's open PRs across repos
```

---

### Template 10: dictionary

- **Emoji:** 📚
- **Category:** Web & API
- **Description:** Look up word definitions, pronunciation, and etymology using Free Dictionary API

```markdown
---
name: dictionary
version: "1.0.0"
description: "Look up word definitions, pronunciation, and etymology using Free Dictionary API"
metadata:
  openclaw:
    emoji: "📚"
    requires:
      bins: []
      env: []
---

# Dictionary

Look up word definitions using the Free Dictionary API.

## When to Use

User asks about:
- Word definitions ("What does 'ephemeral' mean?")
- Pronunciation ("How do you pronounce 'quinoa'?")
- Etymology ("Where does 'algorithm' come from?")

## API Endpoint

```javascript
web_fetch({
  url: "https://api.dictionaryapi.dev/api/v2/entries/en/ephemeral"
})
```

## Response Format

```
📚 **ephemeral** /ɪˈfɛm(ə)rəl/

**adjective**
1. Lasting for a very short time.
   _"Fashions are ephemeral."_

**Synonyms:** transitory, fleeting
**Origin:** Late 16th century, from Greek
```

## Examples

**User:** "Define serendipity"
**Action:** Fetch definition, format nicely

**User:** "Synonyms for happy"
**Action:** Fetch word, list synonyms
```

---

### Template 11: exchange-rates

- **Emoji:** 💱
- **Category:** Web & API
- **Description:** Get currency exchange rates and convert between currencies (free API)

```markdown
---
name: exchange-rates
version: "1.0.0"
description: "Get currency exchange rates and convert between currencies (free API)"
metadata:
  openclaw:
    emoji: "💱"
    requires:
      bins: []
      env: []
---

# Exchange Rates

Get currency exchange rates using free APIs.

## When to Use

User asks about:
- Exchange rates ("USD to EUR rate")
- Currency conversion ("Convert 100 USD to JPY")

## API Endpoints

```javascript
web_fetch({ url: "https://open.er-api.com/v6/latest/USD" })
```

Or Frankfurter API:
```javascript
web_fetch({ url: "https://api.frankfurter.app/latest?from=USD&to=EUR,GBP,JPY" })
```

## Response Format

```
💱 **USD → EUR**
Rate: 1 USD = 0.92 EUR
💰 100 USD = 92.00 EUR
```

## Examples

**User:** "What's the dollar to euro rate?"
**Action:** Get USD rates, show EUR rate

**User:** "Convert 500 yen to dollars"
**Action:** Get JPY rates, calculate USD amount
```

---

### Template 12: movie-tv

- **Emoji:** 🎬
- **Category:** Web & API
- **Description:** Search movies and TV shows, get ratings, recommendations using TMDB (free API)

```markdown
---
name: movie-tv
version: "1.0.0"
description: "Search movies and TV shows, get ratings, recommendations using TMDB (free API)"
metadata:
  openclaw:
    emoji: "🎬"
    requires:
      bins: []
      env: []
---

# Movie & TV

Search for movies and TV shows using The Movie Database (TMDB) API.

## When to Use

User asks about:
- Movie info ("Tell me about Dune")
- TV shows ("What's Severance about?")
- Recommendations ("Movies like Inception")

## API Key

TMDB requires a free API key. Get one at: https://www.themoviedb.org/settings/api

## API Endpoints

```javascript
web_fetch({
  url: "https://api.themoviedb.org/3/search/movie?api_key={API_KEY}&query=Dune"
})
```

Trending: `https://api.themoviedb.org/3/trending/all/day?api_key={API_KEY}`

## Response Format

```
🎬 Dune: Part Two (2024)
Rating: 8.3/10 | Runtime: 166 min
Genre: Science Fiction, Adventure
Director: Denis Villeneuve
```

## Examples

**User:** "What's the new Dune movie about?"
**Action:** Search "Dune", show latest result details

**User:** "Movies similar to Interstellar"
**Action:** Get Interstellar ID, fetch recommendations
```

---

### Template 13: recipe

- **Emoji:** 🍳
- **Category:** Web & API
- **Description:** Search recipes, get ingredients and cooking instructions from TheMealDB (free, no API key)

```markdown
---
name: recipe
version: "1.0.0"
description: "Search recipes, get ingredients and cooking instructions from TheMealDB (free, no API key)"
metadata:
  openclaw:
    emoji: "🍳"
    requires:
      bins: []
      env: []
---

# Recipe

Search for recipes using the free TheMealDB API.

## When to Use

User asks about:
- Recipes ("How do I make pasta carbonara?")
- Meal ideas ("What can I make with chicken?")
- Ingredients ("What's in a margarita?")

## API Endpoints

Search: `https://www.themealdb.com/api/json/v1/1/search.php?s=carbonara`
Random: `https://www.themealdb.com/api/json/v1/1/random.php`
By ingredient: `https://www.themealdb.com/api/json/v1/1/filter.php?i=chicken`
By cuisine: `https://www.themealdb.com/api/json/v1/1/filter.php?a=Italian`

## Response Format

```
🍳 **Pasta Carbonara**
🌍 Italian | 🍽️ Pasta

**Ingredients:**
- 320g Spaghetti
- 150g Guanciale
- 4 Egg Yolks
- 100g Pecorino Romano

**Instructions:**
1. Cook pasta in salted water
2. Fry guanciale until crispy
3. Mix egg yolks with cheese
4. Combine hot pasta with egg mixture
```

## Examples

**User:** "How do I make tiramisu?"
**Action:** Search "tiramisu", format recipe

**User:** "Give me a random recipe"
**Action:** Use random endpoint, present result

**User:** "What can I cook with salmon?"
**Action:** Filter by ingredient "salmon", list options
```

---

## 6. Tool Reference (All 56 Tools)

This is the complete list of SeekerClaw tools. Use this for:
- The tool checkbox grid in all modes
- The `{tools_reference_for_checked_categories}` placeholder in the Claude CC prompt

### Web & Search

| Tool | Description |
|------|-------------|
| `web_search` | Search the web for current information via DuckDuckGo (no API key needed) |
| `web_fetch` | Fetch a URL with full HTTP support. Returns markdown, JSON, or text |

### Memory

| Tool | Description |
|------|-------------|
| `memory_save` | Save important information to long-term memory (MEMORY.md) |
| `memory_read` | Read current contents of long-term memory |
| `daily_note` | Add a note to today's daily memory file |
| `memory_search` | Search the SQL.js database for memory content with ranked keyword matching |
| `memory_get` | Get specific lines from a memory file by line number |

### Files

| Tool | Description |
|------|-------------|
| `read` | Read a file from the workspace directory |
| `write` | Write or create a file in the workspace |
| `edit` | Edit an existing file in the workspace |
| `ls` | List files and directories in the workspace |
| `delete` | Delete a file from the workspace directory |

### Skills

| Tool | Description |
|------|-------------|
| `skill_read` | Read a skill's full instructions and supporting files |
| `skill_install` | Install or update a skill from a URL or raw markdown content |

### Scheduling

| Tool | Description |
|------|-------------|
| `cron_create` | Create a scheduled job (one-shot or recurring) with natural language time |
| `cron_list` | List all scheduled jobs with status and next run time |
| `cron_cancel` | Cancel a scheduled job by its ID |
| `cron_status` | Get scheduling service status |
| `datetime` | Get current date and time in various formats |

### Analytics

| Tool | Description |
|------|-------------|
| `session_status` | Get session info: uptime, memory usage, model, conversation stats, API analytics |
| `memory_stats` | Get memory system statistics: file sizes, daily file count, storage used |

### Device — Battery & Storage

| Tool | Description |
|------|-------------|
| `android_battery` | Get battery level, charging status, and charge type |
| `android_storage` | Get storage info (total, available, used) |

### Device — Clipboard

| Tool | Description |
|------|-------------|
| `android_clipboard_get` | Get current clipboard content |
| `android_clipboard_set` | Set clipboard content |

### Device — Communication

| Tool | Description |
|------|-------------|
| `android_contacts_search` | Search contacts by name |
| `android_sms` | Send an SMS message (requires confirmation) |
| `android_call` | Make a phone call (requires confirmation) |

### Device — Location & Sensors

| Tool | Description |
|------|-------------|
| `android_location` | Get current GPS location (latitude, longitude, accuracy) |
| `android_tts` | Speak text out loud using device text-to-speech |

### Device — Camera

| Tool | Description |
|------|-------------|
| `android_camera_capture` | Capture a photo from the device camera |
| `android_camera_check` | Capture a photo and analyze it with Claude vision |

### Device — Apps

| Tool | Description |
|------|-------------|
| `android_apps_list` | List installed apps that can be launched |
| `android_apps_launch` | Launch an app by package name |

### Solana — Wallet

| Tool | Description |
|------|-------------|
| `solana_address` | Get the connected Solana wallet address |
| `solana_balance` | Get SOL + SPL token balances |
| `solana_history` | Get recent transaction history |
| `solana_send` | Send SOL to a Solana address (requires confirmation) |
| `solana_price` | Get current USD price of one or more tokens |

### Solana — Jupiter Swap

| Tool | Description |
|------|-------------|
| `solana_quote` | Get a swap quote from Jupiter DEX aggregator |
| `solana_swap` | Swap tokens using Jupiter Ultra (gasless) |

### Solana — Jupiter Orders

| Tool | Description |
|------|-------------|
| `jupiter_trigger_create` | Create a limit/trigger order on Jupiter |
| `jupiter_trigger_list` | List active or historical limit/stop orders |
| `jupiter_trigger_cancel` | Cancel an active limit or stop order |

### Solana — Jupiter DCA

| Tool | Description |
|------|-------------|
| `jupiter_dca_create` | Create a recurring DCA (Dollar Cost Averaging) order |
| `jupiter_dca_list` | List active or historical DCA orders |
| `jupiter_dca_cancel` | Cancel an active DCA order |

### Solana — Jupiter Research

| Tool | Description |
|------|-------------|
| `jupiter_token_search` | Search for Solana tokens by name or symbol |
| `jupiter_token_security` | Check token safety using Jupiter Shield |
| `jupiter_wallet_holdings` | View all tokens held by a Solana wallet address |

### Telegram

| Tool | Description |
|------|-------------|
| `telegram_react` | Send a reaction emoji to a Telegram message |
| `telegram_send_file` | Send a file from workspace to the Telegram chat |
| `telegram_delete` | Delete a message from a Telegram chat |
| `telegram_send` | Send a Telegram message and get back the message_id |

### System

| Tool | Description |
|------|-------------|
| `shell_exec` | Execute a shell command in a sandboxed environment |
| `js_eval` | Execute JavaScript code in the Node.js runtime |

---

## 7. Export Spec

### Blank & Template Modes

**"Copy to Clipboard" button:**
- Copies the complete SKILL.md content (YAML frontmatter + markdown body)
- Shows a success toast/notification

**"Download" button:**
- Downloads as `{skill-name}.md` (e.g., `crypto-prices.md`)
- MIME type: `text/markdown`

### Claude CC Prompt Mode

**"Copy Prompt" button:**
- Copies the fully assembled prompt (template + user inputs + reference examples)
- Shows a success toast with brief instruction: "Paste this into Claude Code or Claude to generate your skill"

**No download in this mode** — the output is a prompt, not a skill file.

---

## 8. Installation Guide

Show this as a collapsible/expandable section below the export buttons. Same text for all modes.

```
## How to Install Your Skill

### Option 1: Tell Your Agent (Easiest)
Copy the SKILL.md content and send it to your SeekerClaw agent in Telegram:

"Save this as a skill called {name}:

[paste the SKILL.md content here]"

Your agent will save it to the right location automatically.

### Option 2: Use Claude Code
If you used the "Claude CC Prompt" mode, paste the generated prompt into
Claude Code. It will create the skill file at the correct path:
workspace/skills/{name}/SKILL.md

### Option 3: Manual (Advanced)
1. Connect to your device via ADB
2. Create the file at:
   /data/data/com.seekerclaw.app/files/workspace/skills/{name}/SKILL.md
3. Restart the SeekerClaw service to pick up the new skill

### After Installation
Your agent will automatically detect new skills on the next message.
Try sending one of the trigger messages to test it!
```
