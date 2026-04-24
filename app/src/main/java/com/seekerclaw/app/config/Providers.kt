package com.seekerclaw.app.config

/**
 * Provider registry for multi-provider support (BAT-315).
 * Adding a new provider = 1 entry here + 1 model list.
 */
data class ProviderInfo(
    val id: String,
    val displayName: String,
    val authTypes: List<String>,
    val keyHint: String,
    val consoleUrl: String,
    val keysUrl: String = consoleUrl,
)

val availableProviders = listOf(
    ProviderInfo(
        id = "openai",
        displayName = "OpenAI",
        authTypes = listOf("api_key", "oauth"),
        keyHint = "sk-proj-…",
        consoleUrl = "https://platform.openai.com",
        keysUrl = "https://platform.openai.com/api-keys",
    ),
    ProviderInfo(
        id = "claude",
        displayName = "Anthropic",
        authTypes = listOf("api_key", "setup_token"),
        keyHint = "sk-ant-api03-…",
        consoleUrl = "https://console.anthropic.com",
        keysUrl = "https://console.anthropic.com/settings/keys",
    ),
    ProviderInfo(
        id = "openrouter",
        displayName = "OpenRouter",
        authTypes = listOf("api_key"),
        keyHint = "sk-or-v1-…",
        consoleUrl = "https://openrouter.ai",
        keysUrl = "https://openrouter.ai/keys",
    ),
    ProviderInfo(
        id = "custom",
        displayName = "Custom",
        authTypes = listOf("api_key"),
        keyHint = "your-api-key",
        consoleUrl = "https://seekerclaw.xyz/docs/custom-provider",
        keysUrl = "https://seekerclaw.xyz/docs/custom-provider",
    ),
)

// Display order: freshest first for UX. Default selection is NOT tied
// to list order — see defaultModelForProvider() below. Callers seeding
// a default must use that helper, not `firstOrNull()`, so newer models
// can appear at the top of the picker without accidentally becoming
// the default for tier-gated users.
val openaiModels = listOf(
    ModelInfo("gpt-5.5", "GPT-5.5"),
    ModelInfo("gpt-5.4", "GPT-5.4"),
    ModelInfo("gpt-5.3-codex", "GPT-5.3 Codex"),
)

val openaiOAuthModels = listOf(
    ModelInfo("gpt-5.5", "GPT-5.5"),
    ModelInfo("gpt-5.4", "GPT-5.4"),
    ModelInfo("gpt-5.4-mini", "GPT-5.4 Mini"),
    ModelInfo("gpt-5.3-codex", "GPT-5.3 Codex"),
)

/** Default model for freeform providers (OpenRouter) where model list is empty. */
const val OPENROUTER_DEFAULT_MODEL = "anthropic/claude-sonnet-4-6"

/**
 * Resolve the model list for a given provider.
 *
 * For OpenAI, `authType` MUST be an explicit "oauth" or "api_key" — passing null or
 * any other value throws so call sites can't accidentally fall through to the API-key
 * model list while the user is in OAuth mode. For other providers `authType` is
 * advisory/ignored.
 */
fun modelsForProvider(providerId: String, authType: String?): List<ModelInfo> = when (providerId) {
    "openai" -> when (authType) {
        "oauth" -> openaiOAuthModels
        "api_key" -> openaiModels
        null -> throw IllegalArgumentException("authType is required for providerId=openai")
        else -> throw IllegalArgumentException("Unsupported authType '$authType' for providerId=openai")
    }
    "openrouter", "custom" -> emptyList() // Freeform: user types model ID
    else -> availableModels
}

fun providerById(id: String): ProviderInfo =
    availableProviders.find { it.id == id } ?: availableProviders[0]

/**
 * Recommended default model for a given provider/authType.
 *
 * Decoupled from list order (intentionally) so the display list can prioritize
 * the newest/most-exciting model at the top while the default stays on a known-
 * safe, broadly-available choice. Rule of thumb: if a brand-new model is added
 * that's tier-gated (e.g. only available on ChatGPT Pro), leave this alone —
 * users on lower tiers must never hit a default that their plan can't reach.
 *
 * Call sites that seed an initial model (SetupScreen, provider/auth switches)
 * should use this helper instead of `modelsForProvider(...).firstOrNull()`.
 */
fun defaultModelForProvider(providerId: String, authType: String?): String = when (providerId) {
    // GPT-5.4 is available on every ChatGPT subscription tier AND via API key.
    // GPT-5.5 is tier-gated on some plans as of 2026-04 — don't pick it as a default.
    "openai" -> "gpt-5.4"
    "openrouter" -> OPENROUTER_DEFAULT_MODEL
    "custom" -> ""
    else -> availableModels.firstOrNull()?.id ?: ""
}
