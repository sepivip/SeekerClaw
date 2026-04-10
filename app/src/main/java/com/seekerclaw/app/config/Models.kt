package com.seekerclaw.app.config

data class ModelInfo(
    val id: String,
    val displayName: String,
)

val availableModels = listOf(
    ModelInfo("claude-sonnet-4-6", "Sonnet 4.6"),
    ModelInfo("claude-opus-4-6", "Opus 4.6"),
    ModelInfo("claude-haiku-4-5", "Haiku 4.5"),
)

fun modelDisplayName(modelId: String?): String {
    if (modelId.isNullOrBlank()) return "Not configured"
    return availableModels.find { it.id == modelId }?.displayName ?: modelId
}
