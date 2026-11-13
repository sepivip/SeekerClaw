package com.seekerclaw.app.config

import com.seekerclaw.app.util.SafeFs
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.nio.file.Path

/**
 * BAT-1661 — pure-JVM access to the two FILE stores of the model selection, shared by
 * [ConfigManager] (reconcile, the overlay publisher) and [ModelRepair].
 *
 * `kotlinx.serialization`, not `org.json`: `org.json` is an Android stub on the JVM (every call
 * returns a default), which made reconcile and the overlay publisher impossible to test
 * headlessly. Every read and write is no-follow ([SafeFs]).
 */

/** The (provider, authType, model) a store holds. Values are as stored (not trimmed). */
@Serializable
data class ModelTuple(val provider: String, val authType: String, val model: String)

/** `workspace/agent_settings.json` — the overlay Node reads for live pickup. */
object AgentSettingsFile {
    const val NAME = "agent_settings.json"

    @OptIn(ExperimentalSerializationApi::class)
    private val pretty = Json { prettyPrint = true; prettyPrintIndent = "  " }

    fun path(filesDir: Path): Path = filesDir.resolve("workspace").resolve(NAME)

    sealed class Read {
        object Absent : Read()

        /** Present but not a JSON object (corrupt, a link, unreadable). */
        data class Unreadable(val reason: String) : Read()

        data class Present(val obj: JsonObject) : Read()
    }

    fun read(filesDir: Path): Read {
        val p = path(filesDir)
        if (!SafeFs.existsNoFollow(p)) return Read.Absent
        return try {
            val el = Json.parseToJsonElement(SafeFs.readTextNoFollow(filesDir, p))
            if (el is JsonObject) Read.Present(el) else Read.Unreadable("not a JSON object")
        } catch (e: Exception) {
            Read.Unreadable(e.message ?: e.javaClass.simpleName)
        }
    }

    /** Pretty-printed with two spaces, as the org.json writer did. Throws on failure. */
    fun write(filesDir: Path, obj: JsonObject) {
        SafeFs.writeAtomicText(filesDir, path(filesDir), pretty.encodeToString(JsonObject.serializer(), obj))
    }

    /**
     * A string field, trimmed; null when missing, blank or not a string. Non-string values are
     * rejected rather than coerced (a number or object is never adopted as a model id).
     */
    fun stringField(obj: JsonObject, key: String): String? {
        val p = obj[key] as? JsonPrimitive ?: return null
        if (!p.isString) return null
        return p.content.trim().ifBlank { null }
    }

    /** [obj] with [key] set to [value]; every other key and its value is kept, in order. */
    fun with(obj: JsonObject, key: String, value: JsonElement): JsonObject =
        JsonObject(LinkedHashMap<String, JsonElement>(obj).apply { put(key, value) })
}

/**
 * `filesDir/runtime_state.json`, read and written directly. In `:node` the
 * [com.seekerclaw.app.state.RuntimeStateStore] is never initialised, so the pre-Node repair
 * uses this; the main process sees the change through its FileObserver.
 */
object RuntimeStateFile {
    const val NAME = "runtime_state.json"

    fun path(filesDir: Path): Path = filesDir.resolve(NAME)

    /** The stored object, or null when missing or not a JSON object. */
    fun readObject(filesDir: Path): JsonObject? {
        val p = path(filesDir)
        if (!SafeFs.existsNoFollow(p)) return null
        return try {
            Json.parseToJsonElement(SafeFs.readTextNoFollow(filesDir, p)) as? JsonObject
        } catch (_: Exception) {
            null
        }
    }

    /**
     * The stored tuple, or null when missing, corrupt, or not a valid (provider, authType)
     * pair. Node treats an invalid file the same way: it falls back to config.json.
     */
    fun readTuple(filesDir: Path): ModelTuple? {
        val o = readObject(filesDir) ?: return null
        fun s(k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
        val provider = s("provider")?.trim()?.lowercase() ?: return null
        val authType = s("authType")?.trim()?.lowercase() ?: return null
        val model = s("model") ?: return null
        if (!com.seekerclaw.app.state.RuntimeStateStore.isValidPair(provider, authType)) return null
        return ModelTuple(provider, authType, model)
    }

    /** Sets `model` only; every other field is kept. Throws when the file is not a JSON object. */
    fun writeModel(filesDir: Path, model: String) {
        val o = readObject(filesDir) ?: throw java.io.IOException("runtime_state.json is not readable")
        val next = AgentSettingsFile.with(o, "model", JsonPrimitive(model))
        SafeFs.writeAtomicText(filesDir, path(filesDir), Json.encodeToString(JsonObject.serializer(), next))
    }
}
