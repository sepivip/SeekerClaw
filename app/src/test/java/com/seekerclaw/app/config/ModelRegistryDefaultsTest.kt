package com.seekerclaw.app.config

import com.seekerclaw.app.state.RuntimeState
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * BAT-1315 — keep the shipped model defaults from drifting apart.
 *
 * The default Claude model is written down in TWO places that nothing reconciles:
 *
 *   1. `model-registry.json` -> providers[claude].defaultModel
 *   2. `RuntimeState.model`  -> the Kotlin data-class default
 *
 * (2) is what a fresh install with empty prefs actually starts on, so if they
 * drift, the registry advertises one model and new users get another. Neither the
 * compiler nor any existing test could see that: both are valid strings.
 *
 * This is the same failure shape BAT-1293 removed for build identity — a value
 * written down twice with nothing asserting the copies agree — so it gets the
 * same treatment: a test that fails when they diverge.
 *
 * Also asserts every provider's declared default actually EXISTS in its own model
 * list. A default naming a model we do not ship is not a typo the user can
 * recover from: the agent starts, calls a model the provider rejects, and the
 * error surfaces as a provider failure with no hint that the registry is wrong.
 */
class ModelRegistryDefaultsTest {

    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `RuntimeState default model matches the shipped registry default for claude`() {
        val claudeDefault = defaultModelFor("claude")
        assertEquals(
            "RuntimeState.model must equal model-registry.json providers[claude].defaultModel. " +
                "RuntimeState is what a fresh install with empty prefs starts on, so a mismatch " +
                "ships a different model than the registry advertises.",
            claudeDefault,
            RuntimeState().model,
        )
    }

    @Test
    fun `RuntimeState default provider is one the registry actually ships`() {
        val ids = providers().map { it.jsonObject["id"]!!.jsonPrimitive.content }
        assertTrue(
            "RuntimeState.provider (${RuntimeState().provider}) must be a provider in the " +
                "shipped registry; otherwise a fresh install starts on a provider with no config. " +
                "Registry ships: $ids",
            RuntimeState().provider in ids,
        )
    }

    @Test
    fun `every provider default resolves to a model it actually ships`() {
        for (p in providers()) {
            val o = p.jsonObject
            val id = o["id"]!!.jsonPrimitive.content
            val default = o["defaultModel"]?.jsonPrimitive?.content.orEmpty()
            val models = o["models"]?.jsonArray.orEmpty()

            // Freeform providers (custom / openrouter) legitimately ship no static
            // list and may carry an empty or free-typed default — nothing to check.
            if (models.isEmpty()) continue

            val ids = models.map { it.jsonObject["id"]!!.jsonPrimitive.content }
            assertTrue(
                "provider '$id' declares defaultModel '$default', which is not in its own " +
                    "model list $ids. The agent would start and immediately call a model the " +
                    "provider rejects.",
                default in ids,
            )
        }
    }

    @Test
    fun `every model declares a valid reasoningSupport tri-state`() {
        // A missing or misspelled value silently disables reasoning on a model that
        // supports it, or sends adaptive thinking to one that rejects it with a 400.
        // Neither shows up until a live call.
        val allowed = setOf("yes", "no", "unknown")
        for (p in providers()) {
            val pid = p.jsonObject["id"]!!.jsonPrimitive.content
            for (m in p.jsonObject["models"]?.jsonArray.orEmpty()) {
                val mo = m.jsonObject
                val mid = mo["id"]!!.jsonPrimitive.content
                val rs = mo["reasoningSupport"]?.jsonPrimitive?.content
                assertTrue(
                    "$pid/$mid has reasoningSupport='$rs'; expected one of $allowed",
                    rs in allowed,
                )
            }
        }
    }

    /**
     * BAT-1315 — the shipped list is LATEST + ONE PREVIOUS per model line.
     *
     * Anthropic keeps every generation available indefinitely, so without a rule the
     * dropdown grows forever and users scroll past six Opus versions to reach the one
     * they want. The rule: when Opus 6 ships, Opus 4.8 leaves.
     *
     * Dropping a model does NOT strand anyone. Three things carry them:
     *   - reconcile's equality gate keeps a dropped-from-registry selection working
     *     (ConfigManagerModelReconcileTest: "dropped-from-registry model survives")
     *   - the model's MODEL_CONTEXT_LIMITS entry is retained in ai.js, so they keep
     *     200000 rather than falling to the 128000 default
     *   - the Custom-model field lets anyone type a dropped id back
     *
     * This is a PINNED LIST rather than a computed family rule on purpose. Model
     * naming does not decompose reliably — gpt-5.6-sol / -terra / -luna are three
     * tiers of one generation, not a version series — so a clever parser would
     * mis-fire on OpenAI while adding nothing here. Pinning makes every add or
     * removal a conscious edit with a reviewer, which is the actual goal.
     */
    @Test
    fun `claude list is latest plus one previous per line`() {
        val expected = listOf(
            "claude-fable-5-1",  // latest Fable
            "claude-fable-5",    // previous Fable
            "claude-opus-5",     // latest Opus
            "claude-opus-4-8",   // previous Opus — drops when Opus 6 ships
            "claude-sonnet-5",   // latest Sonnet
            "claude-sonnet-4-6", // previous Sonnet
            "claude-haiku-4-5",  // only Haiku
        )
        val actual = providers()
            .first { it.jsonObject["id"]!!.jsonPrimitive.content == "claude" }
            .jsonObject["models"]!!.jsonArray
            .map { it.jsonObject["id"]!!.jsonPrimitive.content }

        assertEquals(
            "The Anthropic list is latest + one previous per line (see CONTRIBUTING.md). " +
                "If you are adding a new generation, drop the oldest in that line and update " +
                "this list — but KEEP its MODEL_CONTEXT_LIMITS entry in ai.js so existing " +
                "users on it are not silently downgraded to the 128000 fallback.",
            expected,
            actual,
        )
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private fun providers() =
        json.parseToJsonElement(readRegistry()).jsonObject["providers"]!!.jsonArray

    private fun defaultModelFor(providerId: String): String {
        val p = providers().first { it.jsonObject["id"]!!.jsonPrimitive.content == providerId }
        return p.jsonObject["defaultModel"]!!.jsonPrimitive.content
    }

    /** Gradle runs unit tests from `app/`, but some runners use the repo root. */
    private fun readRegistry(): String {
        val candidates = listOf(
            "src/main/assets/nodejs-project/model-registry.json",
            "app/src/main/assets/nodejs-project/model-registry.json",
        )
        for (p in candidates) {
            val f = File(p)
            if (f.exists()) return f.readText()
        }
        error("model-registry.json not found from ${File(".").absolutePath}; tried $candidates")
    }
}
