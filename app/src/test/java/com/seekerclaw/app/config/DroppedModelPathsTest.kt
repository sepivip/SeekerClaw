package com.seekerclaw.app.config

import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File

/**
 * BAT-1661 v2.11 §2a (D11.4) — what happens to a stored model that leaves the picker, against
 * the SHIPPED registry (not a fixture), so the pins hold for the ids this release actually drops:
 * `claude-opus-4-8`, `claude-sonnet-4-6` and `gpt-6-sol`.
 *
 *  - Kept when nothing changes: reconcile's equality gate (overlay equals prefs, provider and auth
 *    unchanged) passes an unlisted stored model through (BAT-1032 / BAT-1315).
 *  - Moved to the provider default (`claude-opus-5-5` / `gpt-6.2-sol`) when the overlay differs
 *    from prefs, or the provider or auth changed (`clampToProviderList`).
 *  - Extended Thinking stops applying: `reasoningSupportFor` is `unknown` for an unlisted id.
 *  - A stored `claude-opus-5` is NOT moved: it stays listed, so every allowlist check passes it.
 *
 * Node's half (`/model` rejection, the request bodies on both OpenAI transports, context limits)
 * is pinned in tests/nodejs-project/model-list-v2-11.test.js.
 */
class DroppedModelPathsTest {

    /** (provider, auth, dropped id). Each auth the provider ships. */
    private val dropped = listOf(
        Triple("claude", "api_key", "claude-opus-4-8"),
        Triple("claude", "setup_token", "claude-opus-4-8"),
        Triple("claude", "api_key", "claude-sonnet-4-6"),
        Triple("claude", "setup_token", "claude-sonnet-4-6"),
        Triple("openai", "api_key", "gpt-6-sol"),
        Triple("openai", "oauth", "gpt-6-sol"),
    )

    private val newDefault = mapOf("claude" to "claude-opus-5-5", "openai" to "gpt-6.2-sol")

    /** The other auth of the same provider, for an auth change. */
    private val otherAuth = mapOf(
        "api_key" to mapOf("claude" to "setup_token", "openai" to "oauth"),
        "setup_token" to mapOf("claude" to "api_key"),
        "oauth" to mapOf("openai" to "api_key"),
    )

    @Before
    fun setUp() {
        ModelRegistry.resetForTest()
        ModelRegistry.initForTest(shippedRegistry())
    }

    @After
    fun tearDown() {
        ModelRegistry.resetForTest()
    }

    @Test
    fun `precondition - the dropped ids are unlisted and not retired, the defaults moved`() {
        for ((p, auth, id) in dropped) {
            assertFalse("$p/$auth: $id must be unlisted", ModelRegistry.modelsForProvider(p, auth).any { it.id == id })
            assertFalse("$p/$auth: $id is dropped, not retired", id in ModelRegistry.retiredModelsFor(p, auth))
            assertEquals("$p/$auth default", newDefault[p], ModelRegistry.defaultModelForProvider(p, auth))
        }
    }

    @Test
    fun `a stored dropped id is kept through the reconcile equality gate`() {
        for ((p, auth, id) in dropped) {
            assertEquals("$p/$auth $id", id, reconcile(p, auth, overlay = id, prefs = id))
            // A padded prefs value still hits the gate (and self-normalises).
            assertEquals("$p/$auth $id padded", id, reconcile(p, auth, overlay = id, prefs = " $id "))
            // No overlay model and nothing changed: the steady state keeps it too.
            assertEquals("$p/$auth $id no overlay", id, reconcile(p, auth, overlay = null, prefs = id))
        }
    }

    @Test
    fun `a stored dropped id moves to the default when the overlay differs from prefs`() {
        for ((p, auth, id) in dropped) {
            val listed = ModelRegistry.modelsForProvider(p, auth).first { it.id != newDefault[p] }.id
            assertEquals("$p/$auth overlay $id, prefs $listed", newDefault[p], reconcile(p, auth, overlay = id, prefs = listed))
        }
    }

    @Test
    fun `a stored dropped id moves to the default on a provider or auth change`() {
        for ((p, auth, id) in dropped) {
            assertEquals(
                "$p/$auth $id, provider changed",
                newDefault[p],
                reconcile(p, auth, overlay = null, prefs = id, providerChanged = true),
            )
            val other = otherAuth.getValue(auth).getValue(p)
            assertEquals(
                "$p: $id, auth $auth → $other",
                newDefault[p],
                reconcile(p, other, overlay = null, prefs = id, authChanged = true),
            )
            // The equality gate does not apply once the provider or auth changed.
            assertEquals(
                "$p/$auth $id, overlay equals prefs but auth changed",
                newDefault[p],
                reconcile(p, other, overlay = id, prefs = id, authChanged = true),
            )
        }
    }

    @Test
    fun `reasoningSupportFor is unknown for a dropped id, so Extended Thinking stops applying`() {
        for ((p, auth, id) in dropped) {
            assertEquals("$p/$auth $id", "unknown", ModelRegistry.reasoningSupportFor(p, id, auth))
        }
        // Controls: the listed successors are "yes".
        assertEquals("yes", ModelRegistry.reasoningSupportFor("claude", "claude-opus-5-5", "api_key"))
        assertEquals("yes", ModelRegistry.reasoningSupportFor("openai", "gpt-6.2-sol", "oauth"))
    }

    @Test
    fun `a stored claude-opus-5 is not moved - it stays listed`() {
        for (auth in listOf("api_key", "setup_token")) {
            assertTrue(ModelRegistry.modelsForProvider("claude", auth).any { it.id == "claude-opus-5" })
            val other = otherAuth.getValue(auth).getValue("claude")
            assertEquals("auth change", "claude-opus-5", reconcile("claude", other, overlay = null, prefs = "claude-opus-5", authChanged = true))
            assertEquals("overlay differs", "claude-opus-5", reconcile("claude", auth, overlay = "claude-opus-5", prefs = "claude-sonnet-5"))
            assertEquals("yes", ModelRegistry.reasoningSupportFor("claude", "claude-opus-5", auth))
        }
    }

    // --------------------------------------------------------------------- helpers

    private fun reconcile(
        provider: String,
        auth: String,
        overlay: String?,
        prefs: String,
        providerChanged: Boolean = false,
        authChanged: Boolean = false,
    ) = ConfigManager.resolveModelForReconcile(
        providerChanged = providerChanged,
        authChanged = authChanged,
        newModel = overlay,
        prefsModel = prefs,
        effectiveProvider = provider,
        effectiveAuth = auth,
    )

    private fun shippedRegistry(): List<ProviderInfo> {
        val text = listOf("src/main/assets/nodejs-project/model-registry.json", "app/src/main/assets/nodejs-project/model-registry.json")
            .map { File(it) }.first { it.exists() }.readText()
        val json = Json { ignoreUnknownKeys = true }
        return json.decodeFromJsonElement(
            ListSerializer(ProviderInfo.serializer()),
            json.parseToJsonElement(text).jsonObject["providers"]!!,
        )
    }
}
