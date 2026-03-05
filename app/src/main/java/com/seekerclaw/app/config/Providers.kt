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
)

val availableProviders = listOf(
    ProviderInfo(
        id = "claude",
        displayName = "Anthropic",
        authTypes = listOf("api_key", "setup_token"),
        keyHint = "sk-ant-api03-…",
        consoleUrl = "https://console.anthropic.com",
    ),
    ProviderInfo(
        id = "openai",
        displayName = "OpenAI",
        authTypes = listOf("api_key"),
        keyHint = "sk-proj-…",
        consoleUrl = "https://platform.openai.com/api-keys",
    ),
)

val openaiModels = listOf(
    ModelInfo("gpt-5.2", "GPT-5.2", "flagship"),
    ModelInfo("gpt-5.3-codex", "GPT-5.3 Codex", "code agent"),
)

fun modelsForProvider(providerId: String): List<ModelInfo> = when (providerId) {
    "openai" -> openaiModels
    else -> availableModels
}

fun providerById(id: String): ProviderInfo =
    availableProviders.find { it.id == id } ?: availableProviders[0]
