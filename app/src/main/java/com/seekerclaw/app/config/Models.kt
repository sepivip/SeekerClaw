package com.seekerclaw.app.config

import kotlinx.serialization.Serializable

@Serializable
data class ModelInfo(
    val id: String,
    val displayName: String,
)

/**
 * Backward-compat alias for the Claude model list. Pre-BAT-517 this
 * was the canonical "available models" list (Claude was the only
 * provider). Today it's just the Claude entry's `models` from the
 * registry, exposed as a property getter so callers that import it
 * directly keep working without churn.
 *
 * Property getter (NOT eager top-level val) so each access reads
 * AFTER `ModelRegistry.init()` has run — Codex v2.1 finding.
 *
 * Uses the strict [ModelRegistry.requireProviderById] lookup (NOT the
 * fall-back-tolerant `providerById`) — the alias is by name "the
 * Claude model list", so a malformed registry that drops or renames
 * `claude` must fail fast instead of silently returning OpenAI's
 * models (BAT-517 R3 Copilot finding).
 */
val availableModels: List<ModelInfo>
    get() = ModelRegistry.requireProviderById("claude").models

/**
 * Render a model id as its display label.
 *
 * Searches EVERY provider's `models` AND every `modelsByAuth` list
 * (Codex v2 finding 5). Pre-BAT-517 this only searched the Claude
 * list, so `modelDisplayName("gpt-5.4")` returned the raw id when
 * the user was on OpenAI; post-BAT-517 it returns `"GPT-5.4"`.
 *
 * Behaviour summary:
 *  - null/blank → `"Not configured"` (preserved)
 *  - found in any provider's effective list → the registry display name
 *  - not found (freeform / future / unknown) → the raw id verbatim
 */
fun modelDisplayName(modelId: String?): String =
    ModelRegistry.modelDisplayName(modelId)
