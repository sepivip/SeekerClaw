package com.seekerclaw.app.config

data class ModelInfo(
    val id: String,
    val displayName: String,
)

// Position [0] is the fallback target: SetupScreen coerces any saved model ID
// not present in this list to availableModels[0].id. Keep the freshest / default
// model at the top so coercion and fresh-install defaults stay symmetric.
val availableModels = listOf(
    ModelInfo("claude-opus-4-7", "Opus 4.7"),
    ModelInfo("claude-opus-4-6", "Opus 4.6"),
    ModelInfo("claude-sonnet-4-6", "Sonnet 4.6"),
    ModelInfo("claude-haiku-4-5", "Haiku 4.5"),
)

fun modelDisplayName(modelId: String?): String {
    if (modelId.isNullOrBlank()) return "Not configured"
    return availableModels.find { it.id == modelId }?.displayName ?: modelId
}
