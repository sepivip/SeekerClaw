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

    private val recordJson = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    fun path(filesDir: Path): Path = filesDir.resolve(NAME)

    /**
     * BAT-1661 (contract v2.9 §3): the file in three states. [Unreadable] covers everything Node's
     * `config.js` rejects and falls back to config.json for: corrupt JSON, not an object, a
     * provider/authType/model that is not a string, or a (provider, authType) pair outside the
     * matrix. Node checks the pair on the RAW strings (`validateMatrix`), so this does too.
     */
    sealed class Read {
        object Missing : Read()

        data class Unreadable(val reason: String) : Read()

        data class Present(val tuple: ModelTuple) : Read()
    }

    fun read(filesDir: Path): Read {
        val p = path(filesDir)
        if (!SafeFs.existsNoFollow(p)) return Read.Missing
        val o = try {
            Json.parseToJsonElement(SafeFs.readTextNoFollow(filesDir, p)) as? JsonObject
                ?: return Read.Unreadable("not a JSON object")
        } catch (e: Exception) {
            return Read.Unreadable(e.message ?: e.javaClass.simpleName)
        }
        fun s(k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
        val provider = s("provider")
        val authType = s("authType")
        val model = s("model")
        if (provider == null || authType == null || model == null) return Read.Unreadable("invalid content")
        if (!com.seekerclaw.app.state.RuntimeStateStore.isValidPair(provider, authType)) {
            return Read.Unreadable("invalid provider/authType")
        }
        return Read.Present(ModelTuple(provider, authType, model))
    }

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
     * The stored tuple, or null when the file is [Read.Missing] or [Read.Unreadable]. Node treats
     * both the same way: it falls back to config.json.
     */
    fun readTuple(filesDir: Path): ModelTuple? = (read(filesDir) as? Read.Present)?.tuple

    /** Sets `model` only; every other field is kept. Throws when the file is not a JSON object. */
    fun writeModel(filesDir: Path, model: String) {
        val o = readObject(filesDir) ?: throw java.io.IOException("runtime_state.json is not readable")
        val next = AgentSettingsFile.with(o, "model", JsonPrimitive(model))
        SafeFs.writeAtomicText(filesDir, path(filesDir), Json.encodeToString(JsonObject.serializer(), next))
    }

    /**
     * BAT-1661 (contract v2.8 §2, v2.10 §3): writes [tuple] as a complete record, CHECKED
     * ([SafeFs.writeAtomicVerified]). The record shape is [com.seekerclaw.app.state.RuntimeState]'s,
     * the one `RuntimeStateStore` writes: a readable object keeps its other fields (reasoning
     * toggles, the Custom signature); a missing or corrupt file gets the record's defaults for them.
     *
     * Throws [SafeFs.WriteNotApplied] or [SafeFs.WriteUnconfirmed]; the caller must not take the step
     * that depends on this write on either.
     */
    fun writeTupleVerified(tx: ModelSelectionLock.Tx, filesDir: Path, tuple: ModelTuple) {
        tx.requireOpen()
        require(com.seekerclaw.app.state.RuntimeStateStore.isValidPair(tuple.provider, tuple.authType)) {
            "Invalid (provider=${tuple.provider}, authType=${tuple.authType})"
        }
        val base = readObject(filesDir)?.let {
            try {
                recordJson.decodeFromJsonElement(com.seekerclaw.app.state.RuntimeState.serializer(), it)
            } catch (_: Exception) {
                null
            }
        } ?: com.seekerclaw.app.state.RuntimeState()
        val record = base.copy(provider = tuple.provider, authType = tuple.authType, model = tuple.model)
        SafeFs.writeAtomicVerified(
            filesDir,
            path(filesDir),
            recordJson.encodeToString(com.seekerclaw.app.state.RuntimeState.serializer(), record).toByteArray(Charsets.UTF_8),
        )
    }
}

/**
 * BAT-1661 (contract v2.9 §3, v2.10 §3): which file Node's dispatch reads the model from, decided
 * the way `config.js` does it. One function, pinned to Node by `ModelDispatchParityTest` and
 * `model-dispatch-parity.test.js` over one shared table
 * (`tests/nodejs-project/fixtures/model-dispatch-parity.json`).
 *
 * - **The running provider** is runtime_state's when that file is [RuntimeStateFile.Read.Present],
 *   else config.json's (unknown or blank: `claude`), as `config.js` `PROVIDER`.
 * - **The overlay** wins when it is a JSON object, its `provider` is missing, blank, not a string,
 *   or equal to the running provider, and its `model` is a non-blank string (`resolveActiveModel`).
 * - **Else runtime_state,** when Present with a non-blank model (`_runtimeModel`).
 * - **Else config.json** (`config.model`). That is the boot payload, never a durable handoff.
 */
object NodeDispatch {
    enum class Source { OVERLAY, RUNTIME, CONFIG }

    data class Winner(val source: Source, val model: String)

    private val SUPPORTED = setOf("claude", "openai", "openrouter", "custom", "xai")

    fun runningProvider(runtime: RuntimeStateFile.Read, configProvider: String): String {
        val raw = (runtime as? RuntimeStateFile.Read.Present)?.tuple?.provider?.trim()?.lowercase()?.ifBlank { null }
            ?: configProvider.trim().lowercase().ifBlank { null }
            ?: "claude"
        return if (raw in SUPPORTED) raw else "claude"
    }

    fun winner(
        runtime: RuntimeStateFile.Read,
        overlay: AgentSettingsFile.Read,
        configProvider: String,
        configModel: String,
    ): Winner {
        val provider = runningProvider(runtime, configProvider)
        if (overlay is AgentSettingsFile.Read.Present) {
            val p = AgentSettingsFile.stringField(overlay.obj, "provider")
            val m = AgentSettingsFile.stringField(overlay.obj, "model")
            if ((p == null || p == provider) && m != null) return Winner(Source.OVERLAY, m)
        }
        if (runtime is RuntimeStateFile.Read.Present) {
            val m = runtime.tuple.model.trim()
            if (m.isNotEmpty()) return Winner(Source.RUNTIME, m)
        }
        return Winner(Source.CONFIG, configModel.trim())
    }
}
