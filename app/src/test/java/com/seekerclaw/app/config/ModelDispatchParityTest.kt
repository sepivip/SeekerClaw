package com.seekerclaw.app.config

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.builtins.ListSerializer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files
import java.nio.file.Path

/**
 * BAT-1661 (contract v2.9 §1, §3; v2.10 §3): the Kotlin side of the Kotlin/Node parity pair.
 *
 * One table, `tests/nodejs-project/fixtures/model-dispatch-parity.json`, read by both runners.
 * `model-dispatch-parity.test.js` boots the REAL `config.js` per row; this runs
 * [NodeDispatch.winner] (with [RuntimeStateFile.read] / [AgentSettingsFile.read] on real files) and
 * [ModelRepair.transportOf] / [ModelRepair.Snapshot.transport] over the same rows. A change to either
 * rule that the other side does not share fails one of the two runners.
 */
class ModelDispatchParityTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private val table: JsonObject by lazy {
        val f = listOf("../tests/nodejs-project/fixtures/model-dispatch-parity.json", "tests/nodejs-project/fixtures/model-dispatch-parity.json")
            .map { File(it) }
            .first { it.isFile }
        Json.parseToJsonElement(f.readText()).jsonObject
    }

    private fun write(p: Path, v: JsonElement?) {
        when {
            v == null || v is JsonNull -> Unit
            v is JsonPrimitive && v.isString -> p.toFile().writeText(v.content)
            else -> p.toFile().writeText(v.toString())
        }
    }

    @Test
    fun `dispatch file - NodeDispatch matches config_js resolveActiveModel on every row`() {
        val rows = table["dispatch"]!!.jsonArray
        assertTrue(rows.size >= 20)
        val failures = mutableListOf<String>()
        for (r in rows) {
            val row = r.jsonObject
            val name = row["name"]!!.jsonPrimitive.content
            val files = tmp.newFolder().toPath()
            Files.createDirectories(files.resolve("workspace"))
            write(RuntimeStateFile.path(files), row["runtime"])
            write(AgentSettingsFile.path(files), row["overlay"])
            val w = NodeDispatch.winner(
                RuntimeStateFile.read(files),
                AgentSettingsFile.read(files),
                configProvider = row["configProvider"]!!.jsonPrimitive.content,
                configModel = "m-config",
            )
            val expect = row["expect"]!!.jsonPrimitive.content
            val marker = when (expect) {
                "OVERLAY" -> "m-overlay"
                "RUNTIME" -> "m-runtime"
                else -> "m-config"
            }
            if (w.source.name != expect || w.model != marker) failures += "$name: expected $expect/$marker, got ${w.source}/${w.model}"
        }
        assertEquals(failures.joinToString("\n"), emptyList<String>(), failures)
    }

    /**
     * Codex 7ec40d8b #1: what Settings shows ([AppConfig.displayModel]) is the model Node runs on, for
     * the key Node can USE — the decrypted key config.json carries ("" when it did not decrypt),
     * normalised as config.js does. Against the shipped registry, as the Node runner.
     */
    @Test
    fun `display - AppConfig displayModel matches config_js resolveActiveModel on every row`() {
        val registryText = listOf("src/main/assets/nodejs-project/model-registry.json", "app/src/main/assets/nodejs-project/model-registry.json")
            .map { File(it) }.first { it.exists() }.readText()
        val lenient = Json { ignoreUnknownKeys = true }
        val providers = lenient.decodeFromJsonElement(
            ListSerializer(ProviderInfo.serializer()),
            lenient.parseToJsonElement(registryText).jsonObject["providers"]!!,
        )
        ModelRegistry.resetForTest()
        ModelRegistry.initForTest(providers)
        try {
            val openaiDefault = providers.first { it.id == "openai" }.defaultModel
            val rows = table["display"]!!.jsonArray
            assertTrue(rows.size >= 6)
            val failures = mutableListOf<String>()
            for (r in rows) {
                val row = r.jsonObject
                val stored = row["stored"]!!.jsonPrimitive.content
                val key = row["key"]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content
                val cfg = AppConfig(
                    anthropicApiKey = "",
                    telegramBotToken = "",
                    telegramOwnerId = "",
                    model = stored,
                    agentName = "",
                    provider = "openai",
                    authType = row["selected"]!!.jsonPrimitive.content,
                    openaiApiKey = key ?: "",
                    openaiOAuthToken = if (row["token"]!!.jsonPrimitive.boolean) "oauth-PLACEHOLDER-TOKEN" else "",
                )
                val expectStored = row["expect"]!!.jsonPrimitive.content == "STORED"
                val name = row["name"]!!.jsonPrimitive.content
                if (key == null || ConfigManager.keepsSecret(key)) {
                    // Kotlin stores and emits this key: Settings must show what Node runs.
                    val want = if (expectStored) stored else openaiDefault
                    if (cfg.displayModel != want) failures += "$name: expected $want, got ${cfg.displayModel}"
                } else {
                    // Kotlin never stores or emits this key (keepsSecret), so Node never sees it: the
                    // row pins config.js normalisation itself, and Settings shows the no-key default.
                    if (ConfigManager.isNodeUsableSecret(key) != expectStored) failures += "$name: normalisation parity"
                    if (cfg.displayModel != openaiDefault) failures += "$name: not emitted, so the default; got ${cfg.displayModel}"
                }
            }
            assertEquals(failures.joinToString("\n"), emptyList<String>(), failures)
        } finally {
            ModelRegistry.resetForTest()
        }
    }

    /**
     * CodeRabbit on 3240d3c9: the PRODUCER half of the producer parity. For every golden row, what
     * the emitter writes for OpenAI ([ConfigManager.emittedAuthType] + [ConfigManager.openAIConfigFields])
     * and what Settings shows ([AppConfig.displayModel]) must equal the golden file — which the Node
     * runner feeds to the real config.js. A drift on either side fails a runner.
     */
    @Test
    fun `producer - the emitted OpenAI fields and displayModel match the golden file Node boots`() {
        val goldenFile = listOf("../tests/nodejs-project/fixtures/openai-emission-parity.json", "tests/nodejs-project/fixtures/openai-emission-parity.json")
            .map { File(it) }.first { it.isFile }
        val golden = Json.parseToJsonElement(goldenFile.readText()).jsonObject
        val registryText = listOf("src/main/assets/nodejs-project/model-registry.json", "app/src/main/assets/nodejs-project/model-registry.json")
            .map { File(it) }.first { it.exists() }.readText()
        val lenient = Json { ignoreUnknownKeys = true }
        ModelRegistry.resetForTest()
        ModelRegistry.initForTest(
            lenient.decodeFromJsonElement(ListSerializer(ProviderInfo.serializer()), lenient.parseToJsonElement(registryText).jsonObject["providers"]!!),
        )
        try {
            val rows = golden["rows"]!!.jsonArray
            assertTrue(rows.size >= 8)
            val failures = mutableListOf<String>()
            for (r in rows) {
                val row = r.jsonObject
                val input = row["input"]!!.jsonObject
                val cfg = AppConfig(
                    anthropicApiKey = "",
                    telegramBotToken = "",
                    telegramOwnerId = "",
                    model = input["model"]!!.jsonPrimitive.content,
                    agentName = "",
                    provider = "openai",
                    authType = input["authType"]!!.jsonPrimitive.content,
                    openaiApiKey = input["openaiApiKey"]!!.jsonPrimitive.content,
                    openaiOAuthToken = input["openaiOAuthToken"]!!.jsonPrimitive.content,
                )
                val emitted = LinkedHashMap<String, String>()
                emitted["authType"] = ConfigManager.emittedAuthType(cfg)
                emitted.putAll(ConfigManager.openAIConfigFields(cfg))
                val want = row["emitted"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content }
                val name = row["name"]!!.jsonPrimitive.content
                if (emitted != want) failures += "$name: emits $emitted, golden $want"
                val display = row["display"]!!.jsonPrimitive.content
                if (cfg.displayModel != display) failures += "$name: shows ${cfg.displayModel}, golden $display"
            }
            assertEquals(failures.joinToString("\n"), emptyList<String>(), failures)
        } finally {
            ModelRegistry.resetForTest()
        }
    }

    @Test
    fun `transport - ModelRepair matches config_js OPENAI_AUTH_TYPE on every row`() {
        val rows = table["transport"]!!.jsonArray
        assertTrue(rows.size >= 6)
        val failures = mutableListOf<String>()
        for (r in rows) {
            val row = r.jsonObject
            val name = row["name"]!!.jsonPrimitive.content
            val selectedInConfig = row["selected"]!!.jsonPrimitive.content
            val runtimeAuth = row["runtimeAuth"]?.jsonPrimitive?.content
            val token = row["token"]!!.jsonPrimitive.boolean
            val key = row["key"]!!.jsonPrimitive.boolean
            // Through the snapshot, as the repair computes it: runtime_state first, then prefs.
            val s = ModelRepair.Snapshot(
                prefs = ModelTuple("openai", selectedInConfig, "m-config"),
                runtime = runtimeAuth?.let { ModelTuple("openai", it, "m-runtime") },
                overlay = AgentSettingsFile.Read.Absent,
                oauthUsable = token,
                apiKeySaved = key,
            )
            val got = when (s.transport.authType) {
                "oauth" -> "OAUTH"
                "api_key" -> "API_KEY"
                ModelRepair.TRANSPORT_RECONNECT -> "RECONNECT"
                else -> "?${s.transport.authType}"
            }
            val expect = row["expect"]!!.jsonPrimitive.content
            if (got != expect) failures += "$name: expected $expect, got $got"
            // And OpenAIAuth directly (the KDoc's OpenAIAuthParity table).
            val direct = OpenAIAuth.effective(runtimeAuth ?: selectedInConfig, token, key).name
            if (direct != expect) failures += "$name (OpenAIAuth): expected $expect, got $direct"
        }
        assertEquals(failures.joinToString("\n"), emptyList<String>(), failures)
    }
}
