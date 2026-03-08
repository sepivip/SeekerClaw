# Settings Info Texts Reference

> Quick-reference for all `[i]` tooltip texts shown on the Settings screen.
> Source of truth: `app/.../ui/settings/SettingsHelpTexts.kt` — update both files together.
> **Note:** Text column contains summaries. For multi-line tooltips (e.g. MODEL), see the Kotlin constant for exact formatting.

---

## Configuration

| # | Setting | Constant | Status | Text |
|---|---------|----------|--------|------|
| 1 | Model | `MODEL` | ✅ Good | Your agent's brain. Opus 4.6 — big brain, big bill. Sonnet 4.6 — sweet spot. Sonnet 4.5 — last gen, still solid. Haiku 4.5 — fast & cheap. Pick your fighter. |
| 2 | Auth Type | `AUTH_TYPE` | ✅ Good | How your agent talks to the AI. API Key = your own Anthropic key (you're the boss). Setup Token = quick temporary access via Claude Code. Pick whichever works for you. |
| 3 | API Key | `API_KEY` | ✅ Good | Your Anthropic API key — the magic password that makes your agent smart. Grab one at console.anthropic.com → API Keys → Create Key. Starts with "sk-ant-". Guard it like a seed phrase. |
| 4 | Setup Token | `SETUP_TOKEN` | ✅ Good | A temporary token for quick setup. Run "claude setup-token" on any machine with Claude Code installed — it'll give you a token to paste here. Great if you don't want to deal with API keys. Temporary = it expires. |
| 5 | Bot Token | `BOT_TOKEN` | ✅ Good | Your Telegram bot's soul. Get one: open Telegram → @BotFather → /newbot → follow the steps. You'll get something like "123456:ABC-DEF". This is how your agent lives on Telegram. |
| 6 | Owner ID | `OWNER_ID` | ✅ Good | Your Telegram user ID (a number, not your @username). This is who the agent obeys. Leave blank = first person to message becomes owner. Find yours: message @userinfobot on Telegram. |
| 7 | Agent Name | `AGENT_NAME` | ✅ Good | What should we call your agent? Shows on the dashboard and in its personality. Totally cosmetic — go wild. |
| 8 | Brave API Key | `BRAVE_API_KEY` | ✅ Good | Optional. Gives your agent Brave Search (better results). Free key at brave.com/search/api. |

## Preferences

| # | Setting | Constant | Status | Text |
|---|---------|----------|--------|------|
| 9 | Auto-start on boot | `AUTO_START` | ✅ Good | When enabled, the agent starts automatically every time your phone boots up. You won't need to open the app and press Deploy manually. Turn this on if you want your agent always available. |
| 10 | Battery unrestricted | `BATTERY_UNRESTRICTED` | ✅ Good | Android may kill background apps to save battery. Enabling this prevents the system from stopping your agent while it's running. Highly recommended — without this, your agent may randomly go offline. |
| 11 | Server mode | `SERVER_MODE` | ✅ Good | Keeps the display awake while the agent runs. Useful when using camera automation on a dedicated device. Higher battery usage and lower physical privacy/security. |

## Permissions

| # | Setting | Constant | Status | Text |
|---|---------|----------|--------|------|
| 12 | Camera | `CAMERA` | ✅ Good | Lets the agent capture a photo for vision tasks like "check my dog". Capture is on-demand when you ask. The app does not stream video continuously. |
| 13 | GPS Location | `GPS_LOCATION` | ✅ Good | Lets the agent know your phone's location. Useful for location-based tasks like weather, nearby places, or navigation. The agent only checks location when you ask — it doesn't track you in the background. |
| 14 | Contacts | `CONTACTS` | ✅ Good | Lets the agent read your contacts list. This allows it to look up names and phone numbers when you ask, for example "text Mom" or "call John". Your contacts are never sent to the cloud — only used on-device to resolve names. |
| 15 | SMS | `SMS` | ✅ Good | Lets the agent send text messages on your behalf. The agent will always tell you who it's texting and what it's sending before it acts. Standard carrier SMS rates may apply. |
| 16 | Phone Calls | `PHONE_CALLS` | ✅ Good | Lets the agent make phone calls for you. It will always confirm the number with you before dialing. Useful for quick calls like "call the pizza place". |

## Solana Wallet

| # | Setting | Constant | Status | Text |
|---|---------|----------|--------|------|
| 17 | Jupiter API Key | `JUPITER_API_KEY` | ✅ Good | Optional. Required for Solana token swaps via Jupiter aggregator. Get a free key at portal.jup.ag (free tier: 60 req/min). Without this, swap and quote tools will not work. |
| 18 | Helius API Key | `HELIUS_API_KEY` | ✅ Good | Optional. Required for viewing NFT holdings (including compressed NFTs). Get a free key at helius.dev (free tier: 50k requests/day). Without this, the NFT holdings tool will not work. |

## MCP Servers

| # | Setting | Constant | Status | Text |
|---|---------|----------|--------|------|
| 19 | MCP Servers | `MCP_SERVERS` | ✅ Good | MCP servers give your agent extra tools from external services. Add a server URL, optionally an auth token, and your agent discovers its tools on startup. Remote only — your phone just makes HTTP calls. Restart after changes. |

---

## Status Legend

| Status | Meaning |
|--------|---------|
| ✅ Good | Text is accurate and complete |
| ⚠️ Needs update | Text is outdated or too basic |
| ❌ Wrong | Text contains incorrect information |
| 🔄 Draft | New text drafted, not yet in code |

## How to Update

1. Change the **Status** column above to flag what needs work
2. Draft new text in the **Text** column (or add notes below)
3. Update the matching constant in `SettingsHelpTexts.kt`
4. The app reads from the Kotlin constants — this markdown is for review only
