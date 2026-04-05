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
        id = "claude",
        displayName = "Anthropic",
        authTypes = listOf("api_key", "setup_token"),
        keyHint = "sk-ant-api03-…",
        consoleUrl = "https://console.anthropic.com",
        keysUrl = "https://console.anthropic.com/settings/keys",
    ),
    ProviderInfo(
        id = "openai",
        displayName = "OpenAI",
        authTypes = listOf("api_key", "oauth"),
        keyHint = "sk-proj-…",
        consoleUrl = "https://platform.openai.com",
        keysUrl = "https://platform.openai.com/api-keys",
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

val openaiModels = listOf(
    ModelInfo("gpt-5.4", "GPT-5.4", "frontier"),
    ModelInfo("gpt-5.2", "GPT-5.2", "flagship"),
    ModelInfo("gpt-5.3-codex", "GPT-5.3 Codex", "code agent"),
)

val openaiOAuthModels = listOf(
    ModelInfo("gpt-5.4", "GPT-5.4", "frontier"),
    ModelInfo("gpt-5.4-mini", "GPT-5.4 Mini", "fast"),
    ModelInfo("gpt-5.3-codex", "GPT-5.3 Codex", "code agent"),
    ModelInfo("gpt-5.2", "GPT-5.2", "flagship"),
)

/** Default model for freeform providers (OpenRouter) where model list is empty. */
const val OPENROUTER_DEFAULT_MODEL = "anthropic/claude-sonnet-4-6"

fun modelsForProvider(providerId: String, authType: String? = null): List<ModelInfo> = when (providerId) {
    "openai" -> if (authType == "oauth") openaiOAuthModels else openaiModels
    "openrouter", "custom" -> emptyList() // Freeform: user types model ID
    else -> availableModels
}

fun providerById(id: String): ProviderInfo =
    availableProviders.find { it.id == id } ?: availableProviders[0]
