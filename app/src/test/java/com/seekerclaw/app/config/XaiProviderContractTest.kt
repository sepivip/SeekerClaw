package com.seekerclaw.app.config

import com.seekerclaw.app.oauth.XaiOAuthActivity
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * BAT-1124 pure-JVM contract tests for the xAI Grok provider.
 *
 * Covers the two §11b "do-now" cheap gates that ARE testable without an Android
 * runtime (L3, L5). The persist→load round-trip (L1) is intentionally NOT here:
 * it exercises `KeystoreHelper` (Android Keystore) + a real `Context`, which need
 * an instrumented/device run — this repo has no Robolectric or androidTest source
 * set, so L1 is validated during the on-device test phase.
 *
 * NOTE on L3: `XaiOAuthActivity.CLIENT_ID` is a `const val`, so the Kotlin compiler
 * INLINES the literal at this call site — referencing it does NOT load the Android
 * Activity class, so this runs cleanly on the JVM.
 */
class XaiProviderContractTest {

    // ── L3: client_id byte-equality (Kotlin ↔ spec ↔ Node) ───────────────

    @Test
    fun `L3 - XaiOAuthActivity CLIENT_ID equals the pinned public client id`() {
        // Must be BYTE-EQUAL to providers/xai.js OAUTH_CLIENT_ID — drift silently
        // breaks OAuth refresh (the Node refresh POST would use a different client_id).
        assertEquals("b1a00492-073a-47ea-816f-4c329264a828", XaiOAuthActivity.CLIENT_ID)
    }

    @Test
    fun `L3 - Node providers-xai OAUTH_CLIENT_ID assignment byte-matches the Kotlin literal`() {
        // Cross-file drift guard. Capture the ACTUAL `const OAUTH_CLIENT_ID = '<uuid>'`
        // assignment — asserting on a bare contains() would let a CHANGED real constant
        // pass if the old UUID still appeared in a comment/header, which is the exact
        // failure this guard exists to catch (a one-sided edit silently breaks refresh).
        val xaiJs = readRepoFile(
            "app/src/main/assets/nodejs-project/providers/xai.js",
            "src/main/assets/nodejs-project/providers/xai.js",
        )
        val match = Regex("""OAUTH_CLIENT_ID\s*=\s*['"]([0-9a-fA-F-]{36})['"]""").find(xaiJs)
        assertNotNull("providers/xai.js must declare const OAUTH_CLIENT_ID = '<uuid>'", match)
        assertEquals(
            "Node OAUTH_CLIENT_ID must byte-match XaiOAuthActivity.CLIENT_ID",
            XaiOAuthActivity.CLIENT_ID,
            match!!.groupValues[1],
        )
    }

    // ── H5: runtime authType boot-loop gate (ConfigManager.runtimeAuthTypeFor) ────

    private fun cfg(provider: String, authType: String, xaiOAuthToken: String) = AppConfig(
        anthropicApiKey = "", telegramBotToken = "", telegramOwnerId = "", model = "", agentName = "",
        provider = provider, authType = authType, xaiOAuthToken = xaiOAuthToken,
    )

    @Test
    fun `H5 - xai oauth with a blank token downgrades to api_key (no boot-loop)`() {
        // The core boot-loop guard: (xai, oauth) + blank token must never reach
        // runtime_state.json, or Node reads oauth+blank → process.exit(1) restart loop.
        assertEquals("api_key", ConfigManager.runtimeAuthTypeFor(cfg("xai", "oauth", "")))
    }

    @Test
    fun `H5 - xai oauth with a token present stays oauth`() {
        assertEquals("oauth", ConfigManager.runtimeAuthTypeFor(cfg("xai", "oauth", "eyJa.b.c")))
    }

    @Test
    fun `H5 - xai api_key is unchanged`() {
        assertEquals("api_key", ConfigManager.runtimeAuthTypeFor(cfg("xai", "api_key", "")))
    }

    @Test
    fun `H5 - non-xai providers are never downgraded by the xai gate`() {
        // The gate is xai-specific — OpenAI oauth (blank token) keeps its existing behaviour.
        assertEquals("oauth", ConfigManager.runtimeAuthTypeFor(cfg("openai", "oauth", "")))
        assertEquals("setup_token", ConfigManager.runtimeAuthTypeFor(cfg("claude", "setup_token", "")))
    }

    // ── L5: shipped model-registry.json decodes + invariants hold ────────

    @Test
    fun `L5 - shipped registry decodes and preserves providerById unknown equals openai`() {
        val providers = decodeShippedRegistryProviders()
        // Unknown-id fallback resolves to providers[0]; appending xai must keep openai first
        // (else EVERY app launch would resolve unknown ids to the wrong provider).
        assertEquals("openai", providers.first().id)
    }

    @Test
    fun `L5 - shipped registry xai entry has required fields (no MissingFieldException)`() {
        // decodeShippedRegistryProviders() would THROW MissingFieldException here if the
        // xai entry omitted keyHint/consoleUrl/keysUrl — which would crash every user at
        // launch (ModelRegistry.init). Reaching this point already proves it decodes.
        val providers = decodeShippedRegistryProviders()
        val xai = providers.find { it.id == "xai" }
        assertNotNull("shipped registry must contain the xai provider", xai)
        requireNotNull(xai)
        assertTrue("xai.keyHint must be present", xai.keyHint.isNotBlank())
        assertTrue("xai.consoleUrl must be present", xai.consoleUrl.isNotBlank())
        assertTrue("xai.keysUrl must be present", xai.keysUrl.isNotBlank())
        assertEquals("grok-4.3", xai.defaultModel)
        assertEquals(listOf("api_key", "oauth"), xai.authTypes)
        // defaultModel must be present in the model list (freeform:false, models:[] is unshippable).
        assertTrue(
            "xai.defaultModel must be in the model list",
            xai.models.any { it.id == xai.defaultModel },
        )
    }

    // ── helpers ──────────────────────────────────────────────────────────

    private val json = Json { ignoreUnknownKeys = true }

    private fun decodeShippedRegistryProviders(): List<ProviderInfo> {
        val raw = readRepoFile(
            "app/src/main/assets/nodejs-project/model-registry.json",
            "src/main/assets/nodejs-project/model-registry.json",
        )
        val providersArray = json.parseToJsonElement(raw).jsonObject["providers"]!!.jsonArray
        // decodeFromJsonElement THROWS MissingFieldException if any provider omits a
        // non-defaulted required field (keyHint/consoleUrl/keysUrl/…) — that is the
        // upgrade-safety gate (§8): a malformed appended entry crashes here, not on device.
        return providersArray.map { json.decodeFromJsonElement(ProviderInfo.serializer(), it) }
    }

    /**
     * Read a repo file trying each candidate path relative to the Gradle unit-test
     * working directory (module dir `app/` by default, but repo-root under some runners).
     */
    private fun readRepoFile(vararg candidatePaths: String): String {
        for (p in candidatePaths) {
            val f = File(p)
            if (f.exists()) return f.readText()
        }
        error("File not found from ${File(".").absolutePath}; tried ${candidatePaths.toList()}")
    }
}
