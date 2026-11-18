package com.seekerclaw.app.config

import com.seekerclaw.app.state.RuntimeState
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/**
 * BAT-1661 v2.11 §3a (D11.5) — every hardcoded copy of a provider default must equal
 * `model-registry.json`'s `defaultModel`.
 *
 * The registry is not the only place a default is written down. A fresh install, a claim
 * import, a blank prefs value and the PLATFORM.md line each fall back to a LITERAL, and nothing
 * reconciles those literals with the registry: when the registry's default moves and a copy is
 * missed, new users land on a different model than the registry advertises, and no compiler or
 * behaviour test notices — both values are valid strings.
 *
 * [ModelRegistryDefaultsTest] already pins `RuntimeState().model`. This class pins the rest:
 *  - Kotlin: `ConfigManager` (rawPrefsModelTuple, loadConfig, the PLATFORM.md `aiModel` line),
 *    `ConfigClaimImporter` (its per-provider `when`), `RuntimeState`;
 *  - Node: `config.js` (its `_defaultModel` chain) and `runtime-state.js` (`DEFAULTS.model`).
 *
 * The two SCAN tests are the backstop for a copy nobody listed: every first-party model-id
 * literal in production code must be its provider's registry default, and the number of copies
 * per file is pinned, so adding or removing one is a conscious edit.
 */
class ModelDefaultCopiesDriftTest {

    private val json = Json { ignoreUnknownKeys = true }

    /** providerId → registry defaultModel. */
    private val defaults: Map<String, String> by lazy {
        json.parseToJsonElement(read("src/main/assets/nodejs-project/model-registry.json"))
            .jsonObject["providers"]!!.jsonArray
            .associate { p ->
                p.jsonObject["id"]!!.jsonPrimitive.content to p.jsonObject["defaultModel"]!!.jsonPrimitive.content
            }
    }

    /** First-party model ids name their provider by prefix. An OpenRouter id (`anthropic/claude-…`) does not match. */
    private fun providerOf(model: String) = when {
        model.startsWith("claude-") -> "claude"
        model.startsWith("gpt-") -> "openai"
        model.startsWith("grok-") -> "xai"
        else -> error("no first-party provider for $model")
    }

    // ------------------------------------------------------------------- behaviour

    @Test
    fun `rawPrefsModelTuple falls back to the registry claude default on empty and blank prefs`() {
        assertEquals(defaults["claude"], ConfigManager.rawPrefsModelTuple(prefs(emptyMap())).model)
        assertEquals(defaults["claude"], ConfigManager.rawPrefsModelTuple(prefs(mapOf("model" to "   "))).model)
        assertEquals(defaults["claude"], RuntimeState().model)
    }

    // ------------------------------------------------------- the named copies, per provider

    @Test
    fun `ConfigClaimImporter's per-provider default matches the registry for every provider`() {
        val src = read("src/main/java/com/seekerclaw/app/config/ConfigClaimImporter.kt")
        val block = src.substringAfter("val defaultModel = when (provider) {", "")
            .substringBefore("}")
        val arms = Regex(""""(\w+)"\s*->\s*"([^"]*)"""").findAll(block)
            .associate { it.groupValues[1] to it.groupValues[2] }
        val elseArm = Regex("""else\s*->\s*"([^"]*)"""").find(block)?.groupValues?.get(1)
        assertEquals("the `else` arm is the claude default", defaults["claude"], elseArm)
        assertEquals(
            "one arm per non-claude provider, each the registry default",
            defaults - "claude",
            arms,
        )
    }

    @Test
    fun `config_js _defaultModel chain matches the registry for every provider`() {
        val src = read("src/main/assets/nodejs-project/config.js")
        val chain = src.substringAfter("const _defaultModel =", "").substringBefore(";")
        val arms = Regex("""PROVIDER === '(\w+)' \? '([^']*)'""").findAll(chain)
            .associate { it.groupValues[1] to it.groupValues[2] }
        val last = Regex(""":\s*'([^']*)'\s*$""").find(chain.trimEnd())?.groupValues?.get(1)
        assertEquals("the final fallback is the claude default", defaults["claude"], last)
        assertEquals("one arm per non-claude provider, each the registry default", defaults - "claude", arms)
    }

    @Test
    fun `runtime-state_js DEFAULTS model is the registry claude default`() {
        val src = read("src/main/assets/nodejs-project/runtime-state.js")
        val block = src.substringAfter("const DEFAULTS = Object.freeze({", "").substringBefore("});")
        assertEquals("claude", Regex("""provider:\s*'([^']*)'""").find(block)?.groupValues?.get(1))
        assertEquals(defaults["claude"], Regex("""model:\s*'([^']*)'""").find(block)?.groupValues?.get(1))
    }

    // ------------------------------------------------------------------ the backstops

    @Test
    fun `every first-party model literal in Kotlin code is its provider's registry default`() {
        val root = dir("src/main/java/com/seekerclaw/app")
        // Literals that are deliberately NOT a default. Each needs a reason.
        val allowed = mapOf(
            // The OAuth connection ping's stable target, documented in its kdoc.
            "ui/settings/ProviderConfigScreen.kt" to setOf("grok-4.3"),
        )
        val literal = Regex(""""((?:claude|gpt|grok)-[A-Za-z0-9.\-]+)"""")
        val offenders = mutableListOf<String>()
        val counts = sortedMapOf<String, Int>()
        root.walkTopDown().filter { it.isFile && it.extension == "kt" }.forEach { f ->
            val rel = f.relativeTo(root).invariantSeparatorsPath
            f.readLines().forEachIndexed { i, line ->
                if (isComment(line)) return@forEachIndexed
                for (m in literal.findAll(line.substringBefore(" // "))) {
                    val id = m.groupValues[1]
                    if (id in allowed[rel].orEmpty()) continue
                    counts[rel] = (counts[rel] ?: 0) + 1
                    if (id != defaults[providerOf(id)]) offenders += "$rel:${i + 1} \"$id\" (registry: ${defaults[providerOf(id)]})"
                }
            }
        }
        assertEquals("hardcoded model literals that are not the registry default. A legitimate non-default id " +
            "(a ping target, a list) belongs in the registry or in this test's allow-list, with its reason", emptyList<String>(), offenders)
        assertEquals(
            "the default copies per file. A new copy, or one removed, is a conscious edit: " +
                "update this map and v2.11 §3a's list.",
            sortedMapOf(
                "config/ConfigClaimImporter.kt" to 3, // openai, xai, else = claude
                // rawPrefsModelTuple 3 + loadConfig 3 + the PLATFORM.md `aiModel` line 1
                "config/ConfigManager.kt" to 7,
                "state/RuntimeState.kt" to 1,
            ),
            counts,
        )
    }

    @Test
    fun `every first-party model literal in Node code is its provider's registry default`() {
        val root = dir("src/main/assets/nodejs-project")
        val literal = Regex("""['"]((?:claude|gpt|grok)-[A-Za-z0-9.\-]+)['"]""")
        // MODEL_CONTEXT_LIMITS rows (`'id': 200000,`) list models on purpose; they are not defaults.
        val limitRow = Regex("""^\s*['"][^'"]+['"]\s*:\s*\d+\s*,""")
        val offenders = mutableListOf<String>()
        val counts = sortedMapOf<String, Int>()
        root.walkTopDown()
            .onEnter { it.name != "node_modules" }
            .filter { it.isFile && it.extension == "js" }
            .forEach { f ->
                val rel = f.relativeTo(root).invariantSeparatorsPath
                f.readLines().forEachIndexed { i, line ->
                    if (isComment(line) || limitRow.containsMatchIn(line)) return@forEachIndexed
                    for (m in literal.findAll(line.substringBefore(" // "))) {
                        val id = m.groupValues[1]
                        counts[rel] = (counts[rel] ?: 0) + 1
                        if (id != defaults[providerOf(id)]) offenders += "$rel:${i + 1} '$id' (registry: ${defaults[providerOf(id)]})"
                    }
                }
            }
        assertEquals("hardcoded model literals that are not the registry default. A legitimate non-default id " +
            "(a ping target, a list) belongs in the registry or in this test's allow-list, with its reason", emptyList<String>(), offenders)
        assertEquals(
            "the default copies per file. A new copy, or one removed, is a conscious edit.",
            sortedMapOf(
                "config.js" to 3, // openai, xai, the claude fallback
                "runtime-state.js" to 1,
            ),
            counts,
        )
    }

    // --------------------------------------------------------------------- helpers

    private fun isComment(line: String) =
        line.trimStart().let { it.startsWith("//") || it.startsWith("*") || it.startsWith("/*") }

    private fun prefs(m: Map<String, String>) = object : PrefsReader {
        override fun getString(key: String, defValue: String?) = m[key] ?: defValue
        override fun getStringSet(key: String, defValues: Set<String>?) = defValues
        override fun getBoolean(key: String, defValue: Boolean) = defValue
        override fun getInt(key: String, defValue: Int) = defValue
        override fun getLong(key: String, defValue: Long) = defValue
        override fun getFloat(key: String, defValue: Float) = defValue
        override fun contains(key: String) = m.containsKey(key)
    }

    /** Gradle runs unit tests from `app/`, but some runners use the repo root. */
    private fun file(rel: String): File =
        listOf(File(rel), File("app/$rel")).firstOrNull { it.exists() }
            ?: error("$rel not found from ${File(".").absolutePath}")

    private fun read(rel: String) = file(rel).readText()

    private fun dir(rel: String) = file(rel).also { check(it.isDirectory) { "$rel is not a directory" } }
}
