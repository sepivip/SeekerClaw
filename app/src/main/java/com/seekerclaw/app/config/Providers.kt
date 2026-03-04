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
        displayName = "Claude",
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
    ModelInfo("gpt-4.1", "GPT-4.1", "flagship"),
    ModelInfo("gpt-4.1-mini", "GPT-4.1 Mini", "balanced"),
    ModelInfo("gpt-4.1-nano", "GPT-4.1 Nano", "fast"),
    ModelInfo("o4-mini", "o4-mini", "reasoning"),
)

fun modelsForProvider(providerId: String): List<ModelInfo> = when (providerId) {
    "openai" -> openaiModels
    else -> availableModels
}

fun providerById(id: String): ProviderInfo =
    availableProviders.find { it.id == id } ?: availableProviders[0]
