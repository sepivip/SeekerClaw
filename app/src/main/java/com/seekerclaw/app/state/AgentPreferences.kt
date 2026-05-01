package com.seekerclaw.app.state

import kotlinx.serialization.Serializable

/**
 * User-typed agent preferences that cross the UI ↔ `:node` boundary
 * (BAT-515). Two fields move out of `SharedPreferences` (which is
 * process-local and read-cached, so the `:node` side never sees
 * UI-side writes without a service restart) into a
 * [com.seekerclaw.app.util.CrossProcessStore]-backed file:
 *
 *  - [agentName] — display/runtime identity label. Live-updateable so
 *    a Settings change is reflected without a service restart in
 *    surfaces that read this store. Surfaces: System screen Agent
 *    row, Dashboard, Settings summary, `/status` Telegram reply, Node
 *    startup banner (Telegram + Discord paths in `main.js`), and
 *    `session_status.agent` (R11 Copilot — the agent's CORE identity
 *    in the system prompt comes from `IDENTITY.md`, not this field;
 *    `buildSystemBlocks` does not currently reference `agentName`).
 *
 *  - [searchProvider] — which web search backend the `web_search` tool
 *    uses (brave / perplexity / exa / tavily / firecrawl). Live-updateable
 *    so the next `web_search` call uses the new provider. Surfaces:
 *    Settings > Search Provider config screen, Node `tools/web.js` per
 *    `web_search` call, `session_status.features.webSearchProvider`.
 *
 * ## Storage
 *
 *  - File: `<filesDir>/agent_preferences.json`
 *  - Pattern mirrors BAT-513's `runtime_state.json` (see [RuntimeState]
 *    + [RuntimeStateStore]).
 *  - Decoded with `ignoreUnknownKeys = true` (configured in
 *    [com.seekerclaw.app.util.CrossProcessStore]) so a future build
 *    that adds a new field can roll back to a current build without
 *    crashing its own data.
 *
 * ## Validation
 *
 * Validation lives in [AgentPreferencesStore.write] / `update`:
 *  - `searchProvider` must be in `KNOWN_SEARCH_PROVIDERS` (allowlist).
 *  - `agentName` must be non-blank for new edits; ≤ [AGENT_NAME_MAX]
 *    characters for new edits. Migration of an existing >cap name is
 *    preserved verbatim with a WARN — never truncated, never thrown
 *    (BAT-515 v3 §1).
 *
 * ## Defaults
 *
 * Match the values [com.seekerclaw.app.config.ConfigManager.loadConfig]
 * has historically returned for absent prefs. Changing these defaults
 * would be a user-visible behaviour change for fresh installs.
 */
@Serializable
data class AgentPreferences(
    val searchProvider: String = DEFAULT_SEARCH_PROVIDER,
    val agentName: String = DEFAULT_AGENT_NAME,
) {
    companion object {
        const val DEFAULT_SEARCH_PROVIDER = "brave"
        const val DEFAULT_AGENT_NAME = "MyAgent"

        /**
         * 64-char cap on `agentName` for NEW edits via Settings UI /
         * fresh setup / config import. Migration of an existing
         * over-cap name is preserved verbatim (BAT-515 v3 §1) — the
         * cap applies only when the incoming write is genuinely
         * changing the value.
         */
        const val AGENT_NAME_MAX = 64

        /**
         * Allowlist of known search providers. Mirrors the IDs Kotlin
         * exposes via the Settings Search Provider picker. Custom
         * gateways are NOT in this list — Custom uses the AI provider
         * config, not the search provider.
         */
        val KNOWN_SEARCH_PROVIDERS: Set<String> = setOf(
            "brave", "perplexity", "exa", "tavily", "firecrawl",
        )
    }
}
