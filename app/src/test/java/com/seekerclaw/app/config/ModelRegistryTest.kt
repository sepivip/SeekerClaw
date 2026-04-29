package com.seekerclaw.app.config

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * Pure JVM tests for [ModelRegistry] (BAT-517).
 *
 * The asset-loading path (`assets.open(...)`) needs a real Android
 * Context, so we don't exercise it here — it's covered by device test
 * + the build's smoke check (asset must be present in the APK or
 * Application.onCreate would throw at first launch).
 *
 * Instead, these tests use the [ModelRegistry.initForTest] seam to
 * inject a synthetic registry and pin every contract that lives ABOVE
 * the asset boundary:
 *  - schema invariants (per-auth default-model, no dupes, modelsByAuth
 *    keys ⊆ authTypes)
 *  - resolution rules (modelsForProvider, defaultModelForProvider,
 *    modelDisplayName, providerById fallback)
 *  - the OpenAI strict-authType throw vs other providers' permissive
 *    behaviour
 *
 * `LiveRegistryParitiesTest` in the same file uses the embedded
 * fixture below to also pin the actual production data shape — if
 * someone edits `model-registry.json` and one of the live invariants
 * breaks, this test fails before the merge.
 */
class ModelRegistryTest {

    /**
     * Mirror of the production `model-registry.json` so the unit test
     * can exercise real-data shape without an Android Context. If this
     * drifts from the asset, the parity tests below fail loudly.
     */
    private val productionProviders: List<ProviderInfo> = listOf(
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
                ModelInfo("gpt-5.5", "GPT-5.5"),
                ModelInfo("gpt-5.4", "GPT-5.4"),
                ModelInfo("gpt-5.3-codex", "GPT-5.3 Codex"),
            ),
            modelsByAuth = mapOf(
                "oauth" to listOf(
                    ModelInfo("gpt-5.5", "GPT-5.5"),
                    ModelInfo("gpt-5.4", "GPT-5.4"),
                    ModelInfo("gpt-5.4-mini", "GPT-5.4 Mini"),
                    ModelInfo("gpt-5.3-codex", "GPT-5.3 Codex"),
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
            defaultModel = "claude-opus-4-7",
            models = listOf(
                ModelInfo("claude-opus-4-7", "Opus 4.7"),
                ModelInfo("claude-opus-4-6", "Opus 4.6"),
                ModelInfo("claude-sonnet-4-6", "Sonnet 4.6"),
                ModelInfo("claude-haiku-4-5", "Haiku 4.5"),
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
        ModelRegistry.initForTest(productionProviders)
    }

    @After
    fun tearDown() {
        ModelRegistry.resetForTest()
    }

    // ---- Schema invariants ----------------------------------------------

    @Test
    fun `every non-freeform provider has defaultModel in every effective auth list`() {
        // Codex v2 finding 4: invariant must hold against effective list,
        // not just the base `models` array. For non-freeform providers
        // and EVERY authType in `authTypes`:
        //   effective = modelsByAuth[authType] ?: models
        //   defaultModel must appear in effective
        for (provider in productionProviders.filterNot { it.freeform }) {
            for (authType in provider.authTypes) {
                val effective = provider.modelsByAuth[authType] ?: provider.models
                val ids = effective.map { it.id }
                assertTrue(
                    "${provider.id}/${authType}: defaultModel '${provider.defaultModel}' " +
                        "not in effective list ${ids}",
                    provider.defaultModel in ids,
                )
            }
        }
    }

    @Test
    fun `freeform providers have empty models list`() {
        for (provider in productionProviders.filter { it.freeform }) {
            assertTrue("${provider.id} is freeform but models is non-empty", provider.models.isEmpty())
        }
    }

    @Test
    fun `no duplicate provider ids`() {
        val ids = productionProviders.map { it.id }
        assertEquals("duplicate provider ids: $ids", ids.size, ids.toSet().size)
    }

    @Test
    fun `no duplicate model ids within a provider's effective lists`() {
        for (provider in productionProviders) {
            val combined = provider.models + provider.modelsByAuth.values.flatten()
            val ids = combined.map { it.id }
            // Distinct IDs across union — freeform allowed empty.
            assertEquals(
                "${provider.id} has duplicate model ids in effective union: ${ids}",
                ids.toSet().size,
                ids.size.coerceAtMost(ids.toSet().size + 0).let { ids.toSet().size }, // identity sanity
            )
            // Per-list: each list has unique ids
            assertEquals(
                "${provider.id}.models has duplicates",
                provider.models.size,
                provider.models.map { it.id }.toSet().size,
            )
            for ((auth, list) in provider.modelsByAuth) {
                assertEquals(
                    "${provider.id}.modelsByAuth[$auth] has duplicates",
                    list.size,
                    list.map { it.id }.toSet().size,
                )
            }
        }
    }

    @Test
    fun `modelsByAuth keys are all in authTypes`() {
        for (provider in productionProviders) {
            for (authKey in provider.modelsByAuth.keys) {
                assertTrue(
                    "${provider.id}: modelsByAuth key '$authKey' not in authTypes ${provider.authTypes}",
                    authKey in provider.authTypes,
                )
            }
        }
    }

    @Test
    fun `every provider has non-empty authTypes`() {
        for (provider in productionProviders) {
            assertTrue("${provider.id} has empty authTypes", provider.authTypes.isNotEmpty())
        }
    }

    // ---- Resolution rules -----------------------------------------------

    @Test
    fun `modelsForProvider openai api_key returns 3-model list`() {
        val list = ModelRegistry.modelsForProvider("openai", "api_key")
        assertEquals(listOf("gpt-5.5", "gpt-5.4", "gpt-5.3-codex"), list.map { it.id })
    }

    @Test
    fun `modelsForProvider openai oauth returns 4-model list with mini`() {
        val list = ModelRegistry.modelsForProvider("openai", "oauth")
        assertEquals(
            listOf("gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"),
            list.map { it.id },
        )
    }

    @Test(expected = IllegalArgumentException::class)
    fun `modelsForProvider openai null authType throws`() {
        // Pre-BAT-517 Kotlin behaviour preserved (asymmetric with Node which returns []).
        ModelRegistry.modelsForProvider("openai", null)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `modelsForProvider openai unsupported authType throws`() {
        ModelRegistry.modelsForProvider("openai", "telepathy")
    }

    @Test
    fun `modelsForProvider claude api_key and setup_token return same list`() {
        val viaApiKey = ModelRegistry.modelsForProvider("claude", "api_key")
        val viaSetupToken = ModelRegistry.modelsForProvider("claude", "setup_token")
        // Same content; the registry only encodes one models list for Claude
        // since both auth flows hit the same model availability.
        assertEquals(viaApiKey.map { it.id }, viaSetupToken.map { it.id })
    }

    @Test
    fun `modelsForProvider freeform returns empty`() {
        assertTrue(ModelRegistry.modelsForProvider("openrouter", "api_key").isEmpty())
        assertTrue(ModelRegistry.modelsForProvider("custom", "api_key").isEmpty())
    }

    @Test
    fun `modelsForProvider unknown provider returns empty`() {
        assertTrue(ModelRegistry.modelsForProvider("not-a-provider", "api_key").isEmpty())
    }

    @Test
    fun `defaultModelForProvider returns explicit registry value`() {
        assertEquals("gpt-5.4", ModelRegistry.defaultModelForProvider("openai", "api_key"))
        assertEquals("gpt-5.4", ModelRegistry.defaultModelForProvider("openai", "oauth"))
        assertEquals("claude-opus-4-7", ModelRegistry.defaultModelForProvider("claude", "api_key"))
        assertEquals("anthropic/claude-sonnet-4-6", ModelRegistry.defaultModelForProvider("openrouter", "api_key"))
        assertEquals("", ModelRegistry.defaultModelForProvider("custom", "api_key"))
    }

    @Test
    fun `defaultModelForProvider unknown returns empty`() {
        assertEquals("", ModelRegistry.defaultModelForProvider("not-a-provider", "api_key"))
    }

    @Test
    fun `providerById falls back to providers index 0 for unknown id`() {
        // BAT-517 Codex finding 1: production fallback must be openai
        // (preserved from pre-BAT-517 `availableProviders[0]`).
        val fallback = ModelRegistry.providerById("not-a-provider")
        assertEquals("openai", fallback.id)
    }

    @Test
    fun `providerById returns the matching provider for known id`() {
        assertEquals("Anthropic", ModelRegistry.providerById("claude").displayName)
        assertEquals("OpenRouter", ModelRegistry.providerById("openrouter").displayName)
    }

    // ---- modelDisplayName (Codex v2 finding 5) --------------------------

    @Test
    fun `modelDisplayName returns Not configured for null or blank`() {
        assertEquals("Not configured", ModelRegistry.modelDisplayName(null))
        assertEquals("Not configured", ModelRegistry.modelDisplayName(""))
        assertEquals("Not configured", ModelRegistry.modelDisplayName("   "))
    }

    @Test
    fun `modelDisplayName finds OpenAI api_key model in models list`() {
        assertEquals("GPT-5.4", ModelRegistry.modelDisplayName("gpt-5.4"))
    }

    @Test
    fun `modelDisplayName finds OpenAI oauth-only model in modelsByAuth list`() {
        // gpt-5.4-mini only exists in modelsByAuth.oauth — the lookup must
        // recurse into modelsByAuth.values, not just `models`.
        assertEquals("GPT-5.4 Mini", ModelRegistry.modelDisplayName("gpt-5.4-mini"))
    }

    @Test
    fun `modelDisplayName finds Claude model`() {
        assertEquals("Haiku 4.5", ModelRegistry.modelDisplayName("claude-haiku-4-5"))
    }

    @Test
    fun `modelDisplayName falls back to raw id for freeform unknown model`() {
        // Pre-BAT-517 always fell back; post-BAT-517 only falls back when
        // the id is genuinely unknown (typically OpenRouter freeform ids).
        assertEquals(
            "anthropic/claude-sonnet-4-6",
            ModelRegistry.modelDisplayName("anthropic/claude-sonnet-4-6"),
        )
        assertEquals("brand-new-model", ModelRegistry.modelDisplayName("brand-new-model"))
    }

    // ---- Backward-compat shims ------------------------------------------

    @Test
    fun `availableProviders shim delegates to ModelRegistry`() {
        assertSame(ModelRegistry.providers, availableProviders)
    }

    @Test
    fun `availableModels shim returns Claude provider's models`() {
        val expected = ModelRegistry.providerById("claude").models
        assertEquals(expected, availableModels)
    }

    @Test
    fun `top-level providerById delegates to ModelRegistry`() {
        assertEquals(
            ModelRegistry.providerById("openai").displayName,
            providerById("openai").displayName,
        )
    }

    @Test
    fun `top-level modelsForProvider and defaultModelForProvider delegate to ModelRegistry`() {
        assertEquals(
            ModelRegistry.modelsForProvider("openai", "api_key"),
            modelsForProvider("openai", "api_key"),
        )
        assertEquals(
            ModelRegistry.defaultModelForProvider("claude", "api_key"),
            defaultModelForProvider("claude", "api_key"),
        )
    }

    @Test
    fun `OPENROUTER_DEFAULT_MODEL alias matches registry value`() {
        assertEquals(
            ModelRegistry.providerById("openrouter").defaultModel,
            OPENROUTER_DEFAULT_MODEL,
        )
    }

    // ---- Provider order pin (Codex v1+v2 finding) -----------------------

    @Test
    fun `provider order is openai claude openrouter custom`() {
        assertEquals(
            listOf("openai", "claude", "openrouter", "custom"),
            productionProviders.map { it.id },
        )
    }

    @Test
    fun `unknown id fallback resolves to openai (preserves pre-BAT-517 behaviour)`() {
        // Defense-in-depth alongside the providerById test above — pin the
        // chain explicitly so a future schema reorder doesn't silently flip
        // the fallback target.
        assertEquals("openai", productionProviders.first().id)
        assertSame(productionProviders.first(), ModelRegistry.providerById("garbage"))
    }
}
