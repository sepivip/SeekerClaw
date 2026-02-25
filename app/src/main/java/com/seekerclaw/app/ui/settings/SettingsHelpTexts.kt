package com.seekerclaw.app.ui.settings

/**
 * Centralized info/tooltip texts for all settings.
 * Update these constants to change what users see when tapping [i] icons.
 * Mirror changes in /docs/internal/SETTINGS_INFO.md for review tracking.
 */
object SettingsHelpTexts {

    // ── Configuration ──────────────────────────────────────────────

    const val AUTH_TYPE =
        "How your agent talks to the AI. " +
        "API Key = your own Anthropic key (you're the boss). " +
        "Setup Token = quick temporary access via Claude Code. " +
        "Pick whichever works for you."

    const val API_KEY =
        "Your Anthropic API key — the magic password that makes your agent smart. " +
        "Grab one at console.anthropic.com \u2192 API Keys \u2192 Create Key. " +
        "Starts with \"sk-ant-\". Guard it like a seed phrase \uD83D\uDD10"

    const val SETUP_TOKEN =
        "A temporary token for quick setup. " +
        "Run \"claude setup-token\" on any machine with Claude Code installed — " +
        "it'll give you a token to paste here. " +
        "Great if you don't want to deal with API keys. " +
        "Temporary = it expires, so grab a fresh one if it stops working."

    const val BOT_TOKEN =
        "Your Telegram bot's soul. " +
        "Get one: open Telegram \u2192 @BotFather \u2192 /newbot \u2192 follow the steps. " +
        "You'll get something like \"123456:ABC-DEF\". " +
        "This is how your agent lives on Telegram."

    const val OWNER_ID =
        "Your Telegram user ID (a number, not your @username). " +
        "This is who the agent obeys. " +
        "Leave blank = first person to message becomes owner. " +
        "Find yours: message @userinfobot on Telegram."

    const val MODEL =
        "Your agent's brain.\n\n" +
        "\u2022 Opus 4.6 — big brain, big bill.\n" +
        "\u2022 Sonnet 4.6 — sweet spot.\n" +
        "\u2022 Sonnet 4.5 — last gen, still solid.\n" +
        "\u2022 Haiku 4.5 — fast & cheap.\n\n" +
        "Pick your fighter \uD83E\uDDE0"

    const val AGENT_NAME =
        "What should we call your agent? " +
        "Shows on the dashboard and in its personality. " +
        "Totally cosmetic — go wild."

    const val HEARTBEAT_INTERVAL =
        "How often your agent proactively checks HEARTBEAT.md for tasks. " +
        "5–120 minutes. Changes take effect automatically (usually within a minute)."

    const val BRAVE_API_KEY =
        "Optional. Gives your agent Brave Search (better results). " +
        "Free key at brave.com/search/api."

    // ── Preferences ────────────────────────────────────────────────

    const val AUTO_START =
        "When enabled, the agent starts automatically every time your phone boots up. " +
        "You won't need to open the app and press Deploy manually. " +
        "Turn this on if you want your agent always available."

    const val BATTERY_UNRESTRICTED =
        "Android may kill background apps to save battery. " +
        "Enabling this prevents the system from stopping your agent while it's running. " +
        "Highly recommended — without this, your agent may randomly go offline."

    const val SERVER_MODE =
        "Keeps the display awake while the agent runs. " +
        "Useful when using camera automation on a dedicated device. " +
        "Higher battery usage and lower physical privacy/security."

    // ── Permissions ────────────────────────────────────────────────

    const val CAMERA =
        "Lets the agent capture a photo for vision tasks like \"check my dog\". " +
        "Capture is on-demand when you ask. The app does not stream video continuously."

    const val GPS_LOCATION =
        "Lets the agent know your phone's location. " +
        "Useful for location-based tasks like weather, nearby places, or navigation. " +
        "The agent only checks location when you ask — it doesn't track you in the background."

    const val CONTACTS =
        "Lets the agent read your contacts list. " +
        "This allows it to look up names and phone numbers when you ask, for example \"text Mom\" or \"call John\". " +
        "Your contacts are never sent to the cloud — only used on-device to resolve names."

    const val SMS =
        "Lets the agent send text messages on your behalf. " +
        "The agent will always tell you who it's texting and what it's sending before it acts. " +
        "Standard carrier SMS rates may apply."

    const val PHONE_CALLS =
        "Lets the agent make phone calls for you. " +
        "It will always confirm the number with you before dialing. " +
        "Useful for quick calls like \"call the pizza place\"."

    // ── MCP Servers ─────────────────────────────────────────────────

    const val MCP_SERVERS =
        "MCP (Model Context Protocol) servers give your agent extra tools from external services. " +
        "Add a server URL, optionally an auth token, and your agent discovers its tools on startup. " +
        "Remote only — your phone just makes HTTP calls. " +
        "Restart the agent after adding or changing servers."

    // ── Solana Wallet ──────────────────────────────────────────────

    const val JUPITER_API_KEY =
        "Optional. Required for Solana token swaps via Jupiter aggregator. " +
        "Get a free key at portal.jup.ag (free tier: 60 req/min). " +
        "Without this, swap and quote tools will not work."
}
