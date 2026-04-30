package com.seekerclaw.app.config

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Provider + model registry shared between Kotlin and Node (BAT-517).
 *
 * Source of truth: `app/src/main/assets/nodejs-project/model-registry.json`.
 * Both runtimes read the SAME file:
 *  - Kotlin: `context.assets.open("nodejs-project/model-registry.json")`
 *  - Node:   `path.join(__dirname, 'model-registry.json')` after the
 *            APK→filesDir extraction in NodeBridge.
 *
 * Adding a new provider or model = ONE edit to the JSON file. The
 * pre-BAT-517 layout had the same data encoded twice — once in this
 * file and once in `model-catalog.js` — and it had already drifted
 * during BAT-509. Centralizing here keeps both sides in sync.
 *
 * ## Read-only by design
 *
 * The registry ships with the APK and is never mutated at runtime —
 * model data only changes via app updates. So no [com.seekerclaw.app.util.CrossProcessStore],
 * no FileObserver, no atomic-RMW: this is just a JSON-backed lookup
 * table.
 */
@Serializable
data class ProviderInfo(
    val id: String,
    val displayName: String,
    val authTypes: List<String>,
    val keyHint: String,
    val consoleUrl: String,
    val keysUrl: String,
    val freeform: Boolean,
    val defaultModel: String,
    val models: List<ModelInfo>,
    /**
     * Per-auth-type override map. Optional — most providers don't need
     * it. Today only OpenAI uses this (`oauth` exposes an extra
     * `gpt-5.4-mini` that the API-key flow doesn't have access to).
     * Default `emptyMap()` so providers that omit the field parse
     * cleanly via kotlinx-serialization (Codex v2.1 finding).
     */
    val modelsByAuth: Map<String, List<ModelInfo>> = emptyMap(),
)

@Serializable
private data class ModelRegistryFile(
    val version: Int,
    val providers: List<ProviderInfo>,
)

object ModelRegistry {
    private const val ASSET_PATH = "nodejs-project/model-registry.json"
    private const val EXPECTED_VERSION = 1

    @Volatile
    private var initialized = false
    private val initLock = Any()

    // BAT-517 R1 Copilot: must be @Volatile. The `providers` getter reads
    // `_providers` without taking `initLock` (and without consulting
    // `initialized`), so without volatile semantics the JIT can reorder
    // the writes inside `init` such that a reader on another thread sees
    // `initialized == true` (or just sees a non-null check pass and
    // immediately afterwards null) while `_providers` is still null /
    // partially-constructed. @Volatile on `_providers` gives the
    // happens-before edge that pairs with the `synchronized(initLock)`
    // write so any non-null read after init publication is well-defined.
    @Volatile
    private var _providers: List<ProviderInfo>? = null

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    /**
     * Idempotent. Call from [com.seekerclaw.app.SeekerClawApplication.onCreate]
     * BEFORE any code that touches `ConfigManager` / provider helpers,
     * and OUTSIDE any `isMainProcess` guard — both the main UI process
     * AND the `:node` service process need the registry available
     * (Codex v2 finding).
     *
     * Load-and-validate first, publish-after-success: a failed parse
     * (bad JSON, schema mismatch, missing required field) throws and
     * leaves [initialized] = false so a retry can re-attempt the load
     * (Codex v2.1 finding).
     */
    fun init(context: Context) {
        if (initialized) return
        synchronized(initLock) {
            if (initialized) return
            // loadAndValidate may throw on bad JSON or schema mismatch.
            // Until publication on the next two lines, `initialized`
            // stays false and any retry caller starts from scratch.
            val loaded = loadAndValidate(context.applicationContext)
            _providers = loaded
            initialized = true
        }
    }

    /**
     * Test seam — bypass the asset load and inject a synthetic
     * registry. Used by `ModelRegistryTest` to exercise edge cases
     * without a real Android Context.
     */
    @androidx.annotation.VisibleForTesting
    internal fun initForTest(providers: List<ProviderInfo>) {
        // BAT-517 R3 Copilot: mirror the runtime loader's minimal-validation
        // shape so a misused test seam fails with a clear message instead
        // of an obscure IndexOutOfBoundsException at the next
        // `providerById` call (which falls back to `list[0]`).
        require(providers.isNotEmpty()) {
            "initForTest requires a non-empty providers list"
        }
        synchronized(initLock) {
            _providers = providers
            initialized = true
        }
    }

    @androidx.annotation.VisibleForTesting
    internal fun resetForTest() {
        synchronized(initLock) {
            _providers = null
            initialized = false
        }
    }

    val providers: List<ProviderInfo>
        get() = _providers
            ?: error("ModelRegistry.init(context) must be called before use")

    /**
     * Look up a provider by id. Falls back to the FIRST provider in the
     * registry for unknown ids — preserves the pre-BAT-517 behaviour
     * where unknown id → `availableProviders[0]` (which today is
     * `openai`). The fallback is intentional: code paths that use
     * `providerById` for branding / display never crash on a corrupt
     * persisted provider id.
     */
    fun providerById(id: String): ProviderInfo {
        val list = providers
        return list.find { it.id == id } ?: list[0]
    }

    /**
     * Strict lookup variant — throws if the named provider is missing.
     *
     * Use for backward-compat aliases that name a SPECIFIC provider
     * ([availableModels] = "claude", [OPENROUTER_DEFAULT_MODEL] =
     * "openrouter"): these aliases mean "this provider's data" by
     * contract, so the silent fallback in [providerById] would let a
     * malformed registry (claude removed, openrouter renamed) silently
     * return the wrong provider's data instead of failing fast at app
     * startup. BAT-517 R3 Copilot finding.
     */
    internal fun requireProviderById(id: String): ProviderInfo {
        return providers.find { it.id == id }
            ?: error("ModelRegistry is missing required provider: $id")
    }

    /**
     * BAT-549 Commit 3: tri-state reasoning-support resolver. Returns one
     * of `"yes"`, `"no"`, `"unknown"` for any (providerId, modelId,
     * authType?) triple. Settings UI consults this to decide whether to
     * show / activate the "Extended Thinking" row, and adapter request
     * paths consult it before sending the thinking/reasoning param.
     *
     * `"unknown"` is the SAFE-DEFAULT state — adapters and Settings UI
     * MUST treat it as capture-only / don't-enable-in-request. Codex 3a
     * R1 thread 1: single consistent meaning across Node + Kotlin.
     *
     * Matrix per v4.1 contract:
     *  - Known model in registry with `reasoningSupport === "yes"` → "yes"
     *  - Known model with `"no"` → "no" (toggle is a true no-op)
     *  - Known model with the field absent OR unknown model id OR
     *    freeform provider (openrouter, custom) → "unknown"
     *  - OpenAI with null / unsupported authType → "unknown" (Codex 3a
     *    R1 thread 3: match `modelsForProvider`'s strict authType
     *    semantics — silently falling through to the api_key list
     *    would misclassify oauth-only models like gpt-5.4-mini)
     *
     * Mirrors `model-catalog.js` `reasoningSupportFor` Node-side helper.
     * Unit-tested in ModelRegistryTest.
     */
    fun reasoningSupportFor(providerId: String, modelId: String?, authType: String?): String {
        if (modelId.isNullOrBlank()) return "unknown"
        val provider = providers.find { it.id == providerId } ?: return "unknown"
        if (provider.freeform) return "unknown"
        // Mirror modelsForProvider's strict-authType handling for OpenAI:
        // only 'api_key' and 'oauth' are valid. Anything else → "unknown".
        val effective: List<ModelInfo> = when {
            provider.id == "openai" && authType == "oauth" ->
                provider.modelsByAuth["oauth"] ?: provider.models
            provider.id == "openai" && authType == "api_key" ->
                provider.models
            provider.id == "openai" -> return "unknown" // null / other authType
            authType != null -> provider.modelsByAuth[authType] ?: provider.models
            else -> provider.models
        }
        val found = effective.find { it.id == modelId } ?: return "unknown"
        return when (found.reasoningSupport) {
            "yes" -> "yes"
            "no" -> "no"
            else -> "unknown"
        }
    }

    /**
     * Resolve the model list for a given provider+auth combination.
     *
     * For OpenAI specifically, [authType] MUST be either `"api_key"` or
     * `"oauth"` — passing null or any other value throws so callers
     * can't accidentally fall through to the API-key model list while
     * the user is in OAuth mode. This mirrors the pre-BAT-517 Kotlin
     * behaviour and is intentionally asymmetric with Node (which
     * returns `[]` instead of throwing — Node tools can't crash the
     * chat turn). For other providers [authType] is advisory; we
     * always return the base `models` list (or per-auth override if
     * present and the auth matches), and freeform providers get `[]`.
     */
    fun modelsForProvider(providerId: String, authType: String?): List<ModelInfo> {
        val provider = providers.find { it.id == providerId } ?: return emptyList()
        if (provider.freeform) return emptyList()
        if (provider.id == "openai") {
            return when (authType) {
                "oauth" -> provider.modelsByAuth["oauth"] ?: provider.models
                "api_key" -> provider.models
                null -> throw IllegalArgumentException("authType is required for providerId=openai")
                else -> throw IllegalArgumentException("Unsupported authType '$authType' for providerId=openai")
            }
        }
        // Other providers: per-auth override wins if present, else base models.
        if (authType != null) {
            provider.modelsByAuth[authType]?.let { return it }
        }
        return provider.models
    }

    /**
     * Recommended default model for a given provider. Decoupled from
     * [ProviderInfo.models] order — explicit registry value, not
     * `models[0]`. The display order in the picker can put a
     * tier-gated model at the top without it silently becoming the
     * fresh-install default.
     *
     * No per-auth defaults today; if a future provider needs them,
     * extend the schema with `defaultModelByAuth` symmetric to
     * `modelsByAuth`.
     */
    fun defaultModelForProvider(providerId: String, @Suppress("UNUSED_PARAMETER") authType: String?): String {
        val provider = providers.find { it.id == providerId } ?: return ""
        return provider.defaultModel
    }

    /**
     * Render a model id as its display label by searching every
     * provider's [ProviderInfo.models] AND every
     * [ProviderInfo.modelsByAuth] list. First match wins. Falls back
     * to the raw id verbatim for freeform / future / unknown models —
     * so an OpenRouter id like `anthropic/claude-sonnet-4-6` displays
     * as itself rather than a confusing "Not configured" or empty
     * string. Pre-BAT-517 this only searched the Claude list, so
     * `modelDisplayName("gpt-5.4")` returned the raw id; post-BAT-517
     * it returns `"GPT-5.4"`. Codex v2 finding 5.
     */
    fun modelDisplayName(modelId: String?): String {
        if (modelId.isNullOrBlank()) return "Not configured"
        for (provider in providers) {
            provider.models.find { it.id == modelId }?.let { return it.displayName }
            for (overrideList in provider.modelsByAuth.values) {
                overrideList.find { it.id == modelId }?.let { return it.displayName }
            }
        }
        return modelId
    }

    /**
     * Internal load + minimal-validation entry point. Throws on:
     *  - missing asset / IO failure
     *  - JSON parse error
     *  - version mismatch
     *  - empty providers list (a valid registry MUST list at least
     *    one provider so [providerById]'s fallback is well-defined)
     *
     * Heavier invariants (default-model membership, no-duplicate-ids,
     * `modelsByAuth` keys ⊆ `authTypes`) are pinned by
     * `ModelRegistryTest` rather than enforced at load — failing hard
     * on a malformed bundled asset is the right call (it's a build-
     * time bug), but we don't want the runtime loader doing every
     * check the test suite does.
     */
    private fun loadAndValidate(applicationContext: Context): List<ProviderInfo> {
        val raw = applicationContext.assets.open(ASSET_PATH)
            .use { it.bufferedReader().readText() }
        val parsed = json.decodeFromString(ModelRegistryFile.serializer(), raw)
        require(parsed.version == EXPECTED_VERSION) {
            "model-registry.json version=${parsed.version}, expected=$EXPECTED_VERSION"
        }
        require(parsed.providers.isNotEmpty()) {
            "model-registry.json has no providers"
        }
        return parsed.providers
    }
}

// ─── Backward-compatible top-level API ──────────────────────────────
//
// Pre-BAT-517 callers across UI/config code import these names. They
// stay as property getters / delegating functions so the existing
// import statements keep working without churn. The implementations
// route through ModelRegistry — getters specifically (NOT eager top-
// level vals) so each access reads after `ModelRegistry.init()` has
// run, even for a caller that ran before init() (Codex v2.1 finding).

val availableProviders: List<ProviderInfo>
    get() = ModelRegistry.providers

fun providerById(id: String): ProviderInfo = ModelRegistry.providerById(id)

fun modelsForProvider(providerId: String, authType: String?): List<ModelInfo> =
    ModelRegistry.modelsForProvider(providerId, authType)

fun defaultModelForProvider(providerId: String, authType: String?): String =
    ModelRegistry.defaultModelForProvider(providerId, authType)

/**
 * Default for OpenRouter — kept as a top-level alias for the call
 * sites that imported it directly pre-BAT-517. Sourced from the
 * registry instead of a hardcoded const.
 *
 * Uses the strict [ModelRegistry.requireProviderById] lookup (NOT the
 * fall-back-tolerant `providerById`) — the alias is by name "the
 * OpenRouter default", so a missing/renamed `openrouter` entry must
 * fail fast rather than silently return another provider's default
 * (BAT-517 R3 Copilot finding).
 */
val OPENROUTER_DEFAULT_MODEL: String
    get() = ModelRegistry.requireProviderById("openrouter").defaultModel
