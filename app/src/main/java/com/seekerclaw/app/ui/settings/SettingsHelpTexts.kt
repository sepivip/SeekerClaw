package com.seekerclaw.app.ui.settings

/**
 * Centralized info/tooltip texts for all settings.
 * Update these constants to change what users see when tapping [i] icons.
 * Mirror changes in /SETTINGS_INFO.md for review tracking.
 */
object SettingsHelpTexts {

    // ── Configuration ──────────────────────────────────────────────

    const val AUTH_TYPE =
        "How your agent authenticates with the AI provider. " +
        "\"API Key\" uses your personal Anthropic key. " +
        "\"Setup Token\" uses a shared team token from your admin. " +
        "Pick whichever one you were given."

    const val API_KEY =
        "Your personal Anthropic API key. " +
        "Get one at console.anthropic.com under API Keys. " +
        "It starts with \"sk-ant-\". " +
        "This is used to send messages to the AI model. " +
        "Keep it secret — anyone with this key can use your account."

    const val SETUP_TOKEN =
        "A team token provided by your administrator or OpenClaw gateway. " +
        "Use this instead of an API Key if someone set up a shared gateway for you. " +
        "If you have your own API key, you probably don't need this."

    const val BOT_TOKEN =
        "Your Telegram bot token. " +
        "To get one: open Telegram, message @BotFather, send /newbot, and follow the steps. " +
        "BotFather will give you a token like \"123456:ABC-DEF\". " +
        "This lets your agent send and receive messages through Telegram."

    const val OWNER_ID =
        "Your Telegram user ID (a number, not your username). " +
        "This tells the agent who is allowed to control it. " +
        "Leave blank to auto-detect — the first person to message the bot becomes the owner. " +
        "To find your ID: message @userinfobot on Telegram."

    const val MODEL =
        "Which AI model powers your agent.\n\n" +
        "• Opus 4.6 — Most capable, best for complex tasks. Uses more credits.\n" +
        "• Sonnet 4.5 — Good balance of speed and smarts. Recommended for most users.\n" +
        "• Haiku 4.5 — Fastest and cheapest. Great for simple tasks and quick replies."

    const val AGENT_NAME =
        "A display name for your agent. " +
        "This appears on the dashboard and in the agent's system prompt. " +
        "Purely cosmetic — change it to whatever you like."

    const val BRAVE_API_KEY =
        "Optional. Lets your agent search the web using Brave Search (better quality). " +
        "Get a free key at brave.com/search/api. " +
        "Without this, DuckDuckGo is used (no key required)."

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

    // ── Solana Wallet ──────────────────────────────────────────────

    const val JUPITER_API_KEY =
        "Optional. Required for Solana token swaps via Jupiter aggregator. " +
        "Get a free key at portal.jup.ag (free tier: 60 req/min). " +
        "Without this, swap and quote tools will not work."
}
