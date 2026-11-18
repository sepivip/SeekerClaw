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
