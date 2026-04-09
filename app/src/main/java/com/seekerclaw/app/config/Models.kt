package com.seekerclaw.app.config

data class ModelInfo(
    val id: String,
    val displayName: String,
    val description: String,
)

val availableModels = listOf(
    ModelInfo("claude-sonnet-4-6", "Sonnet 4.6", "balanced • recommended"),
    ModelInfo("claude-opus-4-6", "Opus 4.6", "smartest"),
    ModelInfo("claude-haiku-4-5", "Haiku 4.5", "fast"),
)

fun modelDisplayName(modelId: String?): String {
    if (modelId.isNullOrBlank()) return "Not configured"
    return availableModels.find { it.id == modelId }?.displayName ?: modelId
}
