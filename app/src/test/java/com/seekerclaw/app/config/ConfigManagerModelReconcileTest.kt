package com.seekerclaw.app.config

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

/**
 * Pure JVM tests for [ConfigManager.resolveModelForReconcile] (BAT-1032).
 *
 * Pins the reconcile decision table — most importantly the equality gate
 * that lets a user-saved CUSTOM model ID survive loadConfig. Before
 * BAT-1032, reconcileWithAgentSettings validated the overlay model against
 * the registry allowlist unconditionally, so any custom ID on claude/openai
 * was silently clamped back to the provider default on the very next
 * loadConfig (UI showed the default while Node kept the custom model —
 * split-brain that also reverted the agent on service restart).
 *
 * Uses [ModelRegistry.initForTest] with a production-shaped fixture, same
 * pattern as ModelRegistryTest.
 */
class ConfigManagerModelReconcileTest {

    /**
     * Production-shaped fixture (all four providers, full Claude list) so
     * the clamp/default assertions exercise realistic registry state.
     * Installed fresh in @Before and torn down via resetForTest() in
     * @After (ModelRegistryTest's pattern) — the singleton never leaks
     * into other test classes regardless of execution order.
     */
    private val fixtureProviders: List<ProviderInfo> = listOf(
        ProviderInfo(
            id = "openai",
            displayName = "OpenAI",
            authTypes = listOf("api_key", "oauth"),
            keyHint = "sk-proj-…",
            consoleUrl = "https://platform.openai.com",
            keysUrl = "https://platform.openai.com/api-keys",
            freeform = false,
            defaultModel = "gpt-5.4",
            models = listOf(
                ModelInfo("gpt-5.5", "GPT-5.5", "yes"),
                ModelInfo("gpt-5.4", "GPT-5.4", "yes"),
                ModelInfo("gpt-5.3-codex", "GPT-5.3 Codex", "yes"),
            ),
            modelsByAuth = mapOf(
                "oauth" to listOf(
                    ModelInfo("gpt-5.5", "GPT-5.5", "yes"),
                    ModelInfo("gpt-5.4", "GPT-5.4", "yes"),
                    ModelInfo("gpt-5.4-mini", "GPT-5.4 Mini", "yes"),
                    ModelInfo("gpt-5.3-codex", "GPT-5.3 Codex", "yes"),
                ),
            ),
        ),
        ProviderInfo(
            id = "claude",
            displayName = "Anthropic",
            authTypes = listOf("api_key", "setup_token"),
            keyHint = "sk-ant-api03-…",
            consoleUrl = "https://console.anthropic.com",
            keysUrl = "https://console.anthropic.com/settings/keys",
            freeform = false,
            defaultModel = "claude-opus-4-8",
            models = listOf(
                ModelInfo("claude-fable-5", "Fable 5", "yes"),
                ModelInfo("claude-opus-4-8", "Opus 4.8", "yes"),
                ModelInfo("claude-opus-4-7", "Opus 4.7", "yes"),
                ModelInfo("claude-opus-4-6", "Opus 4.6", "yes"),
                ModelInfo("claude-sonnet-4-6", "Sonnet 4.6", "yes"),
                ModelInfo("claude-haiku-4-5", "Haiku 4.5", "no"),
            ),
        ),
        ProviderInfo(
            id = "openrouter",
            displayName = "OpenRouter",
            authTypes = listOf("api_key"),
            keyHint = "sk-or-v1-…",
            consoleUrl = "https://openrouter.ai",
            keysUrl = "https://openrouter.ai/keys",
            freeform = true,
            defaultModel = "anthropic/claude-sonnet-4-6",
            models = emptyList(),
        ),
        ProviderInfo(
            id = "custom",
            displayName = "Custom",
            authTypes = listOf("api_key"),
            keyHint = "your-api-key",
            consoleUrl = "https://seekerclaw.xyz/docs/custom-provider",
            keysUrl = "https://seekerclaw.xyz/docs/custom-provider",
            freeform = true,
            defaultModel = "",
            models = emptyList(),
        ),
    )

    @Before
    fun setUp() {
        ModelRegistry.resetForTest()
        ModelRegistry.initForTest(fixtureProviders)
    }

    @After
    fun tearDown() {
        // Reset the global singleton so this class can't pollute later
        // classes in the same JVM (matches ModelRegistryTest's pattern).
        ModelRegistry.resetForTest()
    }

    // ---- The BAT-1032 equality gate -----------------------------------

    @Test
    fun `custom model survives reconcile when overlay equals prefs`() {
        // Steady state after the Settings UI saves a custom ID: saveConfig
        // wrote the same value to prefs AND the overlay. Must NOT clamp.
        assertEquals(
            "my-custom-model-id",
            ConfigManager.resolveModelForReconcile(
                providerChanged = false,
                authChanged = false,
                newModel = "my-custom-model-id",
                prefsModel = "my-custom-model-id",
                effectiveProvider = "claude",
                effectiveAuth = "api_key",
            ),
        )
    }

    @Test
    fun `custom model survives on openai too`() {
        assertEquals(
            "ft-gpt-custom-123",
            ConfigManager.resolveModelForReconcile(
                providerChanged = false,
                authChanged = false,
                newModel = "ft-gpt-custom-123",
                prefsModel = "ft-gpt-custom-123",
                effectiveProvider = "openai",
                effectiveAuth = "api_key",
            ),
        )
    }

    @Test
    fun `dropped-from-registry model survives for existing users`() {
        // A model removed from the registry in a future bump must keep
        // working for users who still run it (uses a fake retired ID —
        // not in the fixture's claude list).
        assertEquals(
            "claude-legacy-model",
            ConfigManager.resolveModelForReconcile(
                providerChanged = false,
                authChanged = false,
                newModel = "claude-legacy-model",
                prefsModel = "claude-legacy-model",
                effectiveProvider = "claude",
                effectiveAuth = "api_key",
            ),
        )
    }

    @Test
    fun `padded prefs model still hits the equality gate`() {
        // stringField trims the overlay; the gate must trim the prefs side
        // too or a legacy padded value (e.g. an untrimmed claim import)
        // would fall into the clamp. The trimmed value is returned so
        // prefs self-normalize.
        assertEquals(
            "my-custom-model-id",
            ConfigManager.resolveModelForReconcile(
                providerChanged = false,
                authChanged = false,
                newModel = "my-custom-model-id",
                prefsModel = " my-custom-model-id ",
                effectiveProvider = "claude",
                effectiveAuth = "api_key",
            ),
        )
    }

    // ---- Defensive clamps preserved ------------------------------------

    @Test
    fun `external off-list overlay model still clamps to default`() {
        // Overlay differs from prefs (Node-written or tampered file) and the
        // value is off-list → defensive clamp to the provider default stays.
        assertEquals(
            "claude-opus-4-8",
            ConfigManager.resolveModelForReconcile(
                providerChanged = false,
                authChanged = false,
                newModel = "bogus-model-id",
                prefsModel = "claude-sonnet-4-6",
                effectiveProvider = "claude",
                effectiveAuth = "api_key",
            ),
        )
    }

    @Test
    fun `valid overlay model differing from prefs is adopted`() {
        // Node /model wrote a valid listed model → adopt it.
        assertEquals(
            "claude-sonnet-4-6",
            ConfigManager.resolveModelForReconcile(
                providerChanged = false,
                authChanged = false,
                newModel = "claude-sonnet-4-6",
                prefsModel = "claude-opus-4-8",
                effectiveProvider = "claude",
                effectiveAuth = "api_key",
            ),
        )
    }

    @Test
    fun `provider switch revalidates prefs model against new provider`() {
        // /provider openai while prefs.model is a claude ID → clamp to the
        // new provider's default.
        assertEquals(
            "gpt-5.4",
            ConfigManager.resolveModelForReconcile(
                providerChanged = true,
                authChanged = false,
                newModel = null,
                prefsModel = "claude-opus-4-8",
                effectiveProvider = "openai",
                effectiveAuth = "api_key",
            ),
        )
    }

    @Test
    fun `auth switch clamps oauth-only model`() {
        // openai oauth→api_key with gpt-5.4-mini (oauth-only) → must clamp.
        assertEquals(
            "gpt-5.4",
            ConfigManager.resolveModelForReconcile(
                providerChanged = false,
                authChanged = true,
                newModel = null,
                prefsModel = "gpt-5.4-mini",
                effectiveProvider = "openai",
                effectiveAuth = "api_key",
            ),
        )
    }

    @Test
    fun `equality gate does not apply when provider changed`() {
        // overlay==prefs but the provider changed in the same overlay —
        // the custom ID belongs to the OLD provider; validation applies.
        assertEquals(
            "gpt-5.4",
            ConfigManager.resolveModelForReconcile(
                providerChanged = true,
                authChanged = false,
                newModel = "my-custom-model-id",
                prefsModel = "my-custom-model-id",
                effectiveProvider = "openai",
                effectiveAuth = "api_key",
            ),
        )
    }

    @Test
    fun `no overlay and no change returns prefs model`() {
        assertEquals(
            "claude-opus-4-8",
            ConfigManager.resolveModelForReconcile(
                providerChanged = false,
                authChanged = false,
                newModel = null,
                prefsModel = "claude-opus-4-8",
                effectiveProvider = "claude",
                effectiveAuth = "api_key",
            ),
        )
    }
}
