# Settings Info Texts Reference

> Quick-reference for all `[i]` tooltip texts shown on the Settings screen.
> Source of truth: `app/.../ui/settings/SettingsHelpTexts.kt` — update both files together.
> **Note:** Text column contains summaries. For multi-line tooltips (e.g. MODEL), see the Kotlin constant for exact formatting.

---

## Configuration

| # | Setting | Constant | Status | Text |
|---|---------|----------|--------|------|
| 1 | Auth Type | `AUTH_TYPE` | ✅ Good | How your agent authenticates with the AI provider. "API Key" uses your personal Anthropic key. "Setup Token" uses a shared team token from your admin. Pick whichever one you were given. |
| 2 | API Key | `API_KEY` | ✅ Good | Your personal Anthropic API key. Get one at console.anthropic.com under API Keys. It starts with "sk-ant-". This is used to send messages to the AI model. Keep it secret — anyone with this key can use your account. |
| 3 | Setup Token | `SETUP_TOKEN` | ✅ Good | A team token provided by your administrator or OpenClaw gateway. Use this instead of an API Key if someone set up a shared gateway for you. If you have your own API key, you probably don't need this. |
| 4 | Bot Token | `BOT_TOKEN` | ✅ Good | Your Telegram bot token. To get one: open Telegram, message @BotFather, send /newbot, and follow the steps. BotFather will give you a token like "123456:ABC-DEF". This lets your agent send and receive messages through Telegram. |
| 5 | Owner ID | `OWNER_ID` | ✅ Good | Your Telegram user ID (a number, not your username). This tells the agent who is allowed to control it. Leave blank to auto-detect — the first person to message the bot becomes the owner. To find your ID: message @userinfobot on Telegram. |
| 6 | Model | `MODEL` | ✅ Good | Which AI model powers your agent. Opus 4.6 — Most capable. Sonnet 4.5 — Good balance. Haiku 4.5 — Fastest and cheapest. (Summary — see in-app tooltip for full details.) |
| 7 | Agent Name | `AGENT_NAME` | ✅ Good | A display name for your agent. This appears on the dashboard and in the agent's system prompt. Purely cosmetic — change it to whatever you like. |
| 8 | Brave API Key | `BRAVE_API_KEY` | ✅ Good | Optional. Lets your agent search the web using Brave Search (better quality). Get a free key at brave.com/search/api. Without this, DuckDuckGo is used (no key required). |

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
