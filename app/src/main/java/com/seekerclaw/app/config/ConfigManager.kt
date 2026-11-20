package com.seekerclaw.app.config

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.StatFs
import android.util.Base64
import android.util.Log
import androidx.annotation.VisibleForTesting
import androidx.compose.runtime.mutableIntStateOf
import androidx.core.content.ContextCompat
import com.seekerclaw.app.BuildConfig
import com.seekerclaw.app.state.AgentPreferences
import com.seekerclaw.app.state.AgentPreferencesStore
import com.seekerclaw.app.state.CustomConfigSignature
import com.seekerclaw.app.state.OpenAIOAuthTokenStore
import com.seekerclaw.app.state.RuntimeState
import com.seekerclaw.app.state.RuntimeStateStore
import com.seekerclaw.app.state.SweepGate
import com.seekerclaw.app.state.TombstoneOutcome
import com.seekerclaw.app.state.XaiOAuthTokenStore
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
import com.seekerclaw.app.util.ProcessRole
import com.seekerclaw.app.util.SafeFs
import com.seekerclaw.app.util.SidecarFileLock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.net.URLEncoder
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

data class AppConfig(
    val anthropicApiKey: String,
    val setupToken: String = "",
    // "api_key" (all providers), "setup_token" (Anthropic only), or "oauth" (OpenAI Codex only).
    val authType: String = "api_key",
    val telegramBotToken: String,
    val telegramOwnerId: String,
    val model: String,
    val agentName: String,
    val braveApiKey: String = "",
    val searchProvider: String = "brave",
    val perplexityApiKey: String = "",
    val exaApiKey: String = "",
    val tavilyApiKey: String = "",
    val firecrawlApiKey: String = "",
    val jupiterApiKey: String = "",
    val heliusApiKey: String = "",
    val autoStartOnBoot: Boolean = true,
    // BAT-1050: Telegram Rich Messages (Bot API 10.1). Written into config.json as
    // `richMessages` (Node reads config.richMessages). DEFAULT true — existing users
    // with no stored value resolve to ON without ever persisting false (upgrade-safe).
    val richMessages: Boolean = true,
    val heartbeatIntervalMinutes: Int = 30,
    val maxStepsPerTurn: Int = 35,
    val provider: String = "claude", // "claude", "openai", or "openrouter"
    val openaiApiKey: String = "",
    val openrouterApiKey: String = "",
    val openrouterFallbackModel: String = "",
    val openrouterModelContext: String = "",
    val openrouterFallbackContext: String = "",
    val customApiKey: String = "",
    val customBaseUrl: String = "",
    val customHeaders: String = "",
    val customFormat: String = "chat_completions",
    val channel: String = "telegram",
    val discordBotToken: String = "",
    val discordOwnerId: String = "",
    val openaiOAuthToken: String = "",
    val openaiOAuthRefresh: String = "",
    val openaiOAuthEmail: String = "",
    val openaiOAuthExpiresAt: String = "",
    /**
     * BAT-1157: the sign-in family the pair belongs to (from [OpenAIOAuthTokenStore]); `null`
     * when the pair came from the legacy prefs keys (migration not yet confirmed).
     */
    val openaiOAuthFamily: String? = null,
    /** BAT-1157: the store record's epoch; 0 for a legacy pair or no pair. */
    val openaiOAuthEpoch: Long = 0L,
    // BAT-1124: xAI Grok. `xaiApiKey` = console.x.ai key (api_key path); the four
    // `xaiOAuth*` fields = "Sign in with Grok" OAuth. All default "" so old configs
    // are untouched and emitConfigJson only emits them when non-blank (upgrade-safe).
    val xaiApiKey: String = "",
    val xaiOAuthToken: String = "",
    val xaiOAuthRefresh: String = "",
    val xaiOAuthEmail: String = "",
    val xaiOAuthExpiresAt: String = "",
    // BAT-1155: the xAI OAuth triple above is now SOURCED FROM the dedicated
    // XaiOAuthTokenStore (decrypted from its ciphertext), NOT from prefs. The
    // three control fields below carry the store's non-secret revision/state
    // so emitConfigJson can round-trip them into config.json for Node.
    val xaiOAuthEpoch: Long = 0L,
    val xaiOAuthReauthRequired: Boolean = false,
    val xaiOAuthReauthNotifiedEpoch: Long = -1L,
    /**
     * BAT-1661 (contract v2.5 §2): the (provider, authType, model) as [ConfigManager.loadConfig]
     * returned them. `copy()` keeps it, so `saveConfig` can tell an explicit selection (the
     * edited tuple differs from the one the form loaded) from an unrelated save. Null for a config
     * built from scratch (Setup), which is always a selection.
     */
    val loadedModelTuple: ModelTuple? = null,
) {
    /**
     * BAT-1661: the model to SHOW. A model this sign-in can no longer use shows as the provider
     * default (what Node actually sends). Display only — never written back (contract v2.4 §0).
     */
    val displayModel: String
        get() = try {
            // Codex review of ca06bb79 #4: the retirement scope is the TRANSPORT Node runs with
            // (`_EFFECTIVE_AUTH`), from this config's own credentials — not the selected auth.
            ModelRegistry.applyRetiredModelRule(
                provider,
                // Codex 7ec40d8b #1: the key Node can USE — the decrypted value config.json carries,
                // normalised as config.js does — never the ciphertext's mere presence.
                ConfigManager.displayAuth(
                    provider,
                    authType,
                    ConfigManager.nodeUsesSecret(openaiOAuthToken),
                    ConfigManager.nodeUsesSecret(openaiApiKey),
                ),
                model,
            )
        } catch (_: IllegalStateException) {
            model // registry not initialised (unit tests): show the stored value
        }

    /** Anthropic/authType-based credential — used by SetupScreen and legacy flows. */
    val activeCredential: String
        get() = if (authType == "setup_token") setupToken else anthropicApiKey

    /** Resolves the API key for the currently selected search provider. */
    val activeSearchApiKey: String
        get() = when (searchProvider) {
            "perplexity" -> perplexityApiKey
            "exa" -> exaApiKey
            "tavily" -> tavilyApiKey
            "firecrawl" -> firecrawlApiKey
            else -> braveApiKey
        }
}

data class McpServerConfig(
    val id: String,
    val name: String,
    val url: String,
    val authToken: String = "",
    val enabled: Boolean = true,
    val rateLimit: Int = 10,
)

object ConfigManager {
    /** Incremented on every saveConfig(); observe in `remember(configVersion)`.
     *
     *  Per-process Compose state. The :node service process and the main UI
     *  process each have their OWN copy of this counter. To bridge changes
     *  across processes, saveConfig and reconcileWithAgentSettings emit
     *  ACTION_CONFIG_CHANGED broadcasts after their writes; a receiver in
     *  SeekerClawApplication (main process only) bumps this value on
     *  receipt so UI screens recompose when the :node process writes prefs
     *  (e.g., during a /provider Telegram switch's service-start reconcile).
     */
    val configVersion = mutableIntStateOf(0)

    /** Sent after any change to canonical SharedPreferences config state.
     *  Receiver in SeekerClawApplication bumps configVersion in the main
     *  process so UI screens auto-refresh after writes from the :node
     *  service process. Same-process saves bump configVersion directly
     *  AND fire this broadcast — the redundant bump is harmless and the
     *  alternative (suppress same-process broadcasts) requires fragile
     *  process detection. */
    const val ACTION_CONFIG_CHANGED = "com.seekerclaw.app.action.CONFIG_CHANGED"

    private fun broadcastConfigChanged(context: Context) {
        try {
            val intent = Intent(ACTION_CONFIG_CHANGED).setPackage(context.packageName)
            context.sendBroadcast(intent)
        } catch (e: Exception) {
            // Non-fatal — main process UI just won't auto-refresh until
            // user navigates away and back. Log and continue.
            LogCollector.append("[Config] broadcastConfigChanged failed: ${e.message}", LogLevel.WARN)
        }
    }

    /**
     * Public facade over [broadcastConfigChanged] + [configVersion]
     * bump for callers that updated config-relevant state by a path
     * other than [saveConfig] / [reconcileWithAgentSettings] (e.g.
     * BAT-513's [com.seekerclaw.app.state.RuntimeStateStore]
     * collector mirror, which writes prefs from the cross-process
     * file). Without this, a cross-process write of runtime fields
     * lands in prefs but in-process Compose screens that read via
     * [loadConfig] don't recompose until manual remount.
     *
     * The [configVersion] bump dispatches to the main thread when
     * we're not already on it. `mutableIntStateOf` is the Compose
     * snapshot state Compose recompositions observe; mutating it
     * from a background thread can land mid-snapshot in the UI
     * process and produce a confused recomposition. The
     * RuntimeStateStore collector runs on `Dispatchers.IO`, so
     * this dispatch is the gate that keeps Compose state mutations
     * single-threaded. The broadcast goes outside the main-thread
     * gate — it's a system IPC that doesn't need main-thread
     * affinity.
     */
    fun signalConfigChanged(context: Context) {
        bumpConfigVersionOnMain()
        broadcastConfigChanged(context)
    }

    /**
     * Increment [configVersion] on the main thread regardless of where
     * we're called from. Centralizes the main-thread dispatch so every
     * mutation of this Compose snapshot state is consistent — saveConfig,
     * reconcileWithAgentSettings, OAuth token saves, individual setters,
     * [signalConfigChanged] (the BAT-513 collector path), AND the
     * [ACTION_CONFIG_CHANGED] broadcast receiver in SeekerClawApplication
     * all route through here. Without centralization, a future caller
     * running on `Dispatchers.IO` or a bridge handler thread could
     * mutate `mutableIntStateOf` mid-snapshot and produce a confused
     * recomposition.
     *
     * `internal` so the broadcast receiver (in a different package but
     * the same module) can call it without re-broadcasting — receivers
     * are reacting to a broadcast another process already sent, so a
     * second broadcast here would loop.
     */
    internal fun bumpConfigVersionOnMain() {
        // Internal mutation site — the only place outside this helper
        // that touches configVersion directly. Reads as "set to current
        // value + 1" rather than the `++` shorthand so the
        // codebase-wide replace-all that routes other call sites
        // through this helper can't accidentally trap these lines.
        if (android.os.Looper.myLooper() == mainHandler.looper) {
            configVersion.intValue = configVersion.intValue + 1
        } else {
            // BAT-513 round-25: reuse the cached mainHandler instead of
            // allocating `Handler(Looper.getMainLooper())` per call.
            // configVersion bumps fire from saveConfig, reconcile,
            // OAuth saves, individual setters, the BAT-513 collector
            // mirror, AND the ACTION_CONFIG_CHANGED receiver — moderate
            // frequency, but per-call allocation adds avoidable GC
            // pressure. Lazy init pays nothing if every caller happens
            // to land on main.
            mainHandler.post {
                configVersion.intValue = configVersion.intValue + 1
            }
        }
    }

    private val mainHandler: android.os.Handler by lazy {
        android.os.Handler(android.os.Looper.getMainLooper())
    }

    // BAT-1000: public Solana RPC URL used when no Helius API Key is set.
    // Kept here (not exported) so callers always go through getSolanaRpcUrl()
    // — that's where the Helius-or-fallback decision lives. Matches the
    // Node-side PUBLIC_SOLANA_RPC_URL constant in solana.js (must stay in
    // sync; a change on one side without the other splits Node + Kotlin
    // RPC URLs).
    private const val PUBLIC_SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com"

    private const val KEY_API_KEY_ENC = "api_key_enc"
    private const val KEY_BOT_TOKEN_ENC = "bot_token_enc"
    private const val KEY_OWNER_ID = "owner_id"
    internal const val KEY_MODEL = "model" // v2.12: shared with MainPrefs / ReconcileRecord (no third copy)
    private const val KEY_AGENT_NAME = "agent_name"
    private const val KEY_AUTO_START = "auto_start_on_boot"
    private const val KEY_RICH_MESSAGES = "rich_messages"
    private const val KEY_KEEP_SCREEN_ON = "keep_screen_on"
    private const val KEY_SETUP_COMPLETE = "setup_complete"
    internal const val KEY_AUTH_TYPE = "auth_type"
    private const val KEY_SETUP_TOKEN_ENC = "setup_token_enc"
    private const val KEY_BRAVE_API_KEY_ENC = "brave_api_key_enc"
    private const val KEY_SEARCH_PROVIDER = "search_provider"
    private const val KEY_PERPLEXITY_API_KEY_ENC = "perplexity_api_key_enc"
    private const val KEY_EXA_API_KEY_ENC = "exa_api_key_enc"
    private const val KEY_TAVILY_API_KEY_ENC = "tavily_api_key_enc"
    private const val KEY_FIRECRAWL_API_KEY_ENC = "firecrawl_api_key_enc"
    private const val KEY_JUPITER_API_KEY_ENC = "jupiter_api_key_enc"
    private const val KEY_HELIUS_API_KEY_ENC = "helius_api_key_enc"
    private const val KEY_WALLET_ADDRESS = "wallet_address"
    private const val KEY_WALLET_LABEL = "wallet_label"
    private const val KEY_MCP_SERVERS_ENC = "mcp_servers_enc"
    private const val KEY_ENV_VARS_ENC = "env_vars_enc"
    private const val KEY_HEARTBEAT_INTERVAL = "heartbeat_interval"
    private const val KEY_MAX_STEPS_PER_TURN = "max_steps_per_turn"
    internal const val KEY_PROVIDER = "provider"
    internal const val KEY_OPENAI_API_KEY_ENC = "openai_api_key_enc"
    private const val KEY_OPENROUTER_API_KEY_ENC = "openrouter_api_key_enc"
    private const val KEY_OPENROUTER_FALLBACK_MODEL = "openrouter_fallback_model"
    private const val KEY_OPENROUTER_MODEL_CONTEXT = "openrouter_model_context"
    private const val KEY_OPENROUTER_FALLBACK_CONTEXT = "openrouter_fallback_context"
    private const val KEY_CUSTOM_API_KEY_ENC = "custom_api_key_enc"
    private const val KEY_CUSTOM_BASE_URL = "custom_base_url"
    private const val KEY_CUSTOM_HEADERS_ENC = "custom_headers_enc"
    private const val KEY_CUSTOM_FORMAT = "custom_format"
    private const val KEY_CHANNEL = "channel"
    private const val KEY_DISCORD_BOT_TOKEN_ENC = "discord_bot_token_enc"
    private const val KEY_DISCORD_OWNER_ID = "discord_owner_id"
    private const val KEY_FIRST_DEPLOY_DONE = "first_deploy_done"
    private const val KEY_OPENAI_OAUTH_TOKEN_ENC = "openai_oauth_token_enc"
    private const val KEY_OPENAI_OAUTH_REFRESH_ENC = "openai_oauth_refresh_enc"
    private const val KEY_OPENAI_OAUTH_EMAIL_ENC = "openai_oauth_email_enc"
    // BAT-1124: xAI Grok. Secrets Keystore-encrypted+Base64 (mirror OpenAI); expiry plaintext.
    private const val KEY_XAI_API_KEY_ENC = "xai_api_key_enc"
    private const val KEY_XAI_OAUTH_TOKEN_ENC = "xai_oauth_token_enc"
    private const val KEY_XAI_OAUTH_REFRESH_ENC = "xai_oauth_refresh_enc"
    private const val KEY_XAI_OAUTH_EMAIL_ENC = "xai_oauth_email_enc"
    private const val KEY_XAI_OAUTH_EXPIRES_AT = "xai_oauth_expires_at"

    // BAT-1155 §4: marker file (filesDir root, NOT workspace/) whose mere
    // EXISTENCE means the xAI OAuth record has been adopted into
    // XaiOAuthTokenStore — independent of whether the record decodes. The
    // migration gates on this marker ALONE (Codex blocker 1): never a
    // token-presence heuristic (which would resurrect a signed-out family
    // from stale legacy prefs). Sign-out preserves the marker.
    private const val XAI_OAUTH_MIGRATED_MARKER = "xai_oauth.migrated"

    /** BAT-1157: bumped by every legacy sign-in sweep so a retried commit is a real write. */
    private const val KEY_LEGACY_SWEEP_SEQ = "legacy_oauth_sweep_seq"

    // Process-local latch: once this process has confirmed migration +
    // legacy-key sweep, skip the per-loadConfig FS check. Each process
    // (MAIN + :node) has its own copy and its own prefs view.
    @Volatile
    private var xaiOAuthMigrationDone = false

    /**
     * [tx] non-null: persist the normalised value. BAT-1661: `auth_type` is a model-selection key, so
     * it is written only by a caller holding the [ModelSelectionLock] transaction; a compute-only
     * load (lock busy, read-only boot) normalises in memory only. BAT-1157 (D7.2): in `:node` it is
     * compute-only even under the lock; MAIN persists the normalisation.
     */
    private fun resolveAuthType(context: Context, p: PrefsReader, tx: ModelSelectionLock.Tx?): String {
        // Migrate legacy/invalid authType combinations so Node's strict validation
        // doesn't hard-crash on older installs and the UI doesn't drift from persisted
        // state. Rules:
        //  - OpenAI only supports "api_key" or "oauth".
        //  - Non-Claude providers can't use "setup_token".
        //
        // Note: we do NOT flip oauth → api_key just because the token is currently
        // blank. The "oauth selected, sign-in pending" state is a legitimate UI state
        // — flipping it on every loadConfig would silently revert the user's choice
        // when they return from a failed/canceled sign-in. The unstartable
        // oauth+blank-token combination is instead handled at workspace/config.json
        // write time (emitConfigJson) so Node never sees it.
        val raw = p.getString(KEY_AUTH_TYPE, "api_key") ?: "api_key"
        val provider = p.getString(KEY_PROVIDER, "claude") ?: "claude"
        val normalized = normalizeAuthType(p)
        if (normalized != raw && tx != null) {
            tx.requireOpen()
            Log.w(TAG, "Normalizing authType '$raw' → '$normalized' (provider=$provider)")
            // BAT-1661 (Codex diff review #4): commit(), not apply() — under the lock, checked.
            // BAT-1157 (D7.2): compute-only in `:node`; MAIN persists the normalisation.
            if (!ProcessRole.isNode) {
                val w = prefsForWrite(context, "resolveAuthType")
                if (w == null || !w.edit().putString(KEY_AUTH_TYPE, normalized).commit()) tx.markWriteFailed()
            }
        }
        return normalized
    }

    /** The normalisation [resolveAuthType] applies, computed only (writes nothing). */
    private fun normalizeAuthType(p: PrefsReader): String =
        normalizeAuthTypeRaw(p.getString(KEY_PROVIDER, "claude") ?: "claude", p.getString(KEY_AUTH_TYPE, "api_key") ?: "api_key")

    /** [normalizeAuthType] over raw values (v2.12: [projectPrefsTuple]). */
    private fun normalizeAuthTypeRaw(provider: String, raw: String): String {
        return when {
            provider == "openai" && raw != "oauth" && raw != "api_key" -> "api_key"
            // BAT-1124: xai supports oauth|api_key only (same generic authType, no xai-specific type).
            provider == "xai" && raw != "oauth" && raw != "api_key" -> "api_key"
            provider != "claude" && raw == "setup_token" -> "api_key"
            else -> raw
        }
    }

    /**
     * BAT-1661: the prefs side of [ModelRepair.Snapshot], read without writing anything: provider,
     * auth and model exactly as stored (the auth normalised as [resolveAuthType] would; contract
     * v2.9 §1). The auth is the SELECTION and is never lowered for a missing sign-in; the
     * transport is [ModelRepair.Snapshot.transport].
     */
    internal fun rawPrefsModelTuple(p: PrefsReader): ModelTuple =
        projectPrefsTuple(p.getString(KEY_PROVIDER, null), p.getString(KEY_AUTH_TYPE, null), p.getString(KEY_MODEL, null))

    /**
     * BAT-1661 v2.12: the selection the three RAW prefs values (null = absent) stand for — the
     * [rawPrefsModelTuple] rules: provider defaults to `claude`, auth normalised, model trimmed and
     * defaulted. A reconcile retry record's target must be exactly this of its `prefsAfter`.
     */
    internal fun projectPrefsTuple(provider: String?, authType: String?, model: String?): ModelTuple {
        val p = provider ?: "claude"
        val m = (model ?: "claude-opus-5-5").trim().ifBlank { "claude-opus-5-5" }
        return ModelTuple(p, normalizeAuthTypeRaw(p, authType ?: "api_key"), m)
    }

    /**
     * BAT-1661: the stores' model-relevant content, for [ModelRepair]. Writes no model store.
     *
     * [migrate] (v2.8 §4 ordering): runs the BAT-1157 fill-only OpenAI sign-in migration first, so a
     * Node-first upgrade of a signed-in user takes the token-presence snapshot after it. The
     * migration writes the token store only, never prefs.
     */
    internal fun modelSnapshot(context: Context, migrate: Boolean = true): ModelRepair.Snapshot {
        val p = prefs(context)
        if (migrate && OpenAIOAuthTokenStore.isInitialized) {
            OpenAIOAuthTokenStore.migrateIfNeeded { legacyOpenAIPair(p) }
        }
        return modelSnapshotFrom(context.filesDir.toPath(), p)
    }

    /** [modelSnapshot] from an explicit prefs view (the collector mirror's), with no migration. */
    internal fun modelSnapshotFrom(files: java.nio.file.Path, p: PrefsReader): ModelRepair.Snapshot {
        val runtime = RuntimeStateFile.read(files)
        return ModelRepair.Snapshot(
            prefs = rawPrefsModelTuple(p),
            runtime = (runtime as? RuntimeStateFile.Read.Present)?.tuple,
            overlay = AgentSettingsFile.read(files),
            runtimeRead = runtime,
            oauthUsable = OpenAIOAuthTokenStore.hasUsableToken(),
            apiKeySaved = !p.getString(KEY_OPENAI_API_KEY_ENC, null).isNullOrBlank(),
        )
    }
    private const val KEY_OPENAI_OAUTH_EXPIRES_AT = "openai_oauth_expires_at"

    /** BAT-1157: read access to `seekerclaw_prefs`, in either process (see [MainPrefs]). */
    private fun prefs(context: Context): PrefsReader = MainPrefs.read(context)

    /** BAT-1157: write access, MAIN only; `null` (and an ERROR) in `:node` (see [MainPrefs]). */
    private fun prefsForWrite(context: Context, site: String): SharedPreferences? = MainPrefs.forWrite(context, site)

    fun isSetupComplete(context: Context): Boolean =
        prefs(context).getBoolean(KEY_SETUP_COMPLETE, false)

    fun markSetupSkipped(context: Context) {
        prefsForWrite(context, "markSetupSkipped")?.edit()
            ?.putBoolean(KEY_SETUP_COMPLETE, true)
            ?.apply()
    }

    fun hasUserEverDeployed(context: Context): Boolean =
        prefs(context).getBoolean(KEY_FIRST_DEPLOY_DONE, false)

    fun markFirstDeploymentDone(context: Context) {
        prefsForWrite(context, "markFirstDeploymentDone")?.edit()
            ?.putBoolean(KEY_FIRST_DEPLOY_DONE, true)
            ?.apply()
    }

    /**
     * Persist [config] to [SharedPreferences] (encrypted fields via
     * [KeystoreHelper]) AND mirror the runtime fields
     * (provider/authType/model) into [com.seekerclaw.app.state.RuntimeStateStore]
     * so the `:node` process picks them up via the cross-process file
     * (BAT-513). The runtime-state write is what determines this
     * function's return value:
     *
     *  - `true` — prefs persisted AND the runtime-state file write
     *    returned `true`. UI flows can navigate forward / clear
     *    optimistic state.
     *  - `false` — prefs commit failed OR the runtime-state file
     *    write failed. UI flows should surface a Toast/Snackbar and
     *    revert any optimistic UI state via
     *    [com.seekerclaw.app.state.RuntimeStateStore.read].
     *
     * Pre-BAT-513 callers that ignore the return value continue to
     * compile (Boolean values can be discarded) — they retain the
     * pre-BAT-513 fire-and-forget behaviour.
     *
     * BAT-1661: runs inside one [ModelSelectionLock] transaction; a busy lock returns false with
     * nothing written. Only an EXPLICIT selection — the saved (provider, authType, model) differs
     * from [AppConfig.loadedModelTuple] — writes those three fields (prefs, runtime_state, the
     * overlay) and cancels a pending model repair. Any other save leaves them, and the repair
     * intent, exactly as stored (contract v2.5 §2).
     */
    fun saveConfig(
        context: Context,
        config: AppConfig,
        lockTimeoutMs: Long = ModelSelectionLock.LOCK_TIMEOUT_MS,
    ): Boolean = saveConfigWith(context, config, lockTimeoutMs, SecretSealer.Keystore)

    /** [saveConfig] with an explicit [sealer] — the JVM tests' entry point (see [SecretSealer]). */
    internal fun saveConfigWith(
        context: Context,
        config: AppConfig,
        lockTimeoutMs: Long,
        sealer: SecretSealer,
    ): Boolean {
        val r = ModelSelectionLock.transaction(lockTimeoutMs) { tx -> saveConfigLocked(context, config, tx, sealer) }
        afterSaveLockForTest?.invoke()
        // BAT-1661: the saved OpenAI key decides the display transport too. Re-projected AFTER the
        // lock is released (it reads credentials), whatever the save's outcome.
        // CodeRabbit (key-revision thread, comment 4626795862): REVISION FIRST, then read. Every
        // outcome re-derives the flag from what prefs hold NOW (the usable key, as config.json will
        // carry it — Codex 7ec40d8b #1): the revision is taken before the key is read, so the last
        // revision taken always reads the newest committed key. Publishing the value this save
        // holds would let two saves whose notes run in reverse order publish the older key. A failed
        // save can have changed the stored key too (the whole-map commit lands before the later
        // stages). Decrypts on the store's IO scope in production.
        RuntimeStateStore.rederiveOpenAIKeyUsable { keyUsableOf(prefs(context)) }
        RuntimeStateStore.refreshDisplay()
        // Fold 5′: a selection may have invalidated a restart notice; the UI re-reads it after release.
        context.filesDir?.toPath()?.let { RestartNotice.refreshAsync(it) }
        return when (r) {
            is ModelSelectionLock.Result.Acquired -> r.value
            is ModelSelectionLock.Result.Busy -> {
                LogCollector.append(
                    "[Config] saveConfig: model selection is being updated (${r.reason}) — nothing saved",
                    LogLevel.WARN,
                )
                false
            }
        }
    }

    /**
     * BAT-1661: what a failed save's runtime_state undo did. [KEPT_NEWER]: the record no longer
     * held this save's values (a newer writer's), so it was left alone — not a failure, not an undo.
     */
    private enum class RuntimeUndo { UNDONE, KEPT_NEWER, FAILED }

    private fun RuntimeUndo.logSuffix(): String = if (this == RuntimeUndo.KEPT_NEWER) ", runtime_kept_newer=true" else ""

    /** True when [config] changes the stored model selection (see [saveConfig]). */
    internal fun isModelSelection(config: AppConfig): Boolean {
        val loaded = config.loadedModelTuple ?: return true
        return loaded != ModelTuple(config.provider, config.authType, config.model)
    }

    private fun saveConfigLocked(context: Context, config: AppConfig, tx: ModelSelectionLock.Tx, sealer: SecretSealer): Boolean {
        val isSelection = isModelSelection(config)
        // BAT-513: validate the (provider, authType) matrix BEFORE any
        // persistence. Without this, the matrix gate inside
        // RuntimeStateStore.write would only fire AFTER prefs.commit
        // had already written the invalid combo to SharedPreferences,
        // leaving prefs and runtime_state.json diverged. Up-front gate
        // means an invalid combo never reaches disk anywhere.
        if (!RuntimeStateStore.isValidPair(config.provider, config.authType)) {
            LogCollector.append(
                "[Config] saveConfig rejected invalid (provider=${config.provider}, " +
                    "authType=${config.authType}) before persistence",
                LogLevel.WARN,
            )
            return false
        }

        // BAT-513: snapshot the OLD runtime field values so we can roll
        // back if RuntimeStateStore.write fails after prefs.commit
        // succeeds. Without this, an FS error on the runtime-state path
        // would leave prefs holding the new runtime fields (which the
        // legacy code path reads) while runtime_state.json still has
        // the old values — the two persistent stores would diverge,
        // and a downgrade would land on the new prefs values that
        // never reached the cross-process file. Rolling back on
        // failure makes saveConfig atomic at the runtime-fields level
        // (other fields commit unconditionally — they don't cross-
        // process sync, so partial commit is the same as today's
        // pre-BAT-513 behaviour).
        // BAT-1157: saveConfig writes `seekerclaw_prefs`, so it is MAIN-only.
        val sp = prefsForWrite(context, "saveConfig") ?: return false
        val oldProvider = sp.getString(KEY_PROVIDER, null)
        val oldAuthType = sp.getString(KEY_AUTH_TYPE, null)
        val oldModel = sp.getString(KEY_MODEL, null)
        // Also snapshot KEY_SETUP_COMPLETE: saveConfig sets it to `true`
        // unconditionally (it's the entry point for both fresh setup and
        // post-setup re-saves). If the runtime-state write later fails on
        // a fresh setup, leaving KEY_SETUP_COMPLETE flipped to `true`
        // would let MainActivity skip Setup on next launch even though
        // the user's setup screen blocked them on the failure. For an
        // existing user mid-edit, the snapshot is already `true` so the
        // rollback is a no-op (true → true). The only behavioural change
        // is on first-install failures, which now correctly stay in the
        // "setup not complete" state until a successful retry.
        val oldSetupComplete = sp.getBoolean(KEY_SETUP_COMPLETE, false)
        // BAT-515 v3 §4: snapshot the OLD agent-preferences fields (the
        // second cross-process write site after RuntimeStateStore). If
        // AgentPreferencesStore.update fails AFTER prefs.commit and
        // RuntimeStateStore.update have both succeeded, we roll prefs
        // back to these values AND undo the RuntimeStateStore write —
        // so the three persistent stores either all reflect the new
        // config or all keep the prior one. Same atomicity reasoning
        // as oldProvider/oldAuthType/oldModel above (BAT-513).
        //
        // R7 Copilot: read from AgentPreferencesStore (the authoritative
        // cross-process state, kept fresh by R3.1's sync-update on
        // every successful write/update) rather than prefs. Prefs
        // legitimately lag agent_preferences.json while the observe-
        // and-mirror collector mirrors asynchronously — a recent
        // Settings > Search Provider tap (which writes
        // agent_preferences.json first via
        // `AgentPreferencesStore.update` and only mirrors prefs after
        // the collector fires) would leave prefs at the OLD value for
        // ~50–200 ms. Snapshotting prefs in that window captures a
        // stale value; a rollback firing here would revert the user's
        // just-applied cross-process change AND leave prefs diverged
        // from the file. Snapshotting from the store closes the race.
        //
        // Falls back to prefs only when the store isn't initialized —
        // i.e., in `:node` (where AgentPreferencesStore.init never
        // runs). On the main process, init runs from
        // SeekerClawApplication.onCreate before any UI surface can
        // call saveConfig, so the fallback path doesn't fire.
        val oldAgentPrefs = if (AgentPreferencesStore.isInitialized) {
            AgentPreferencesStore.read()
        } else null
        val oldAgentName = oldAgentPrefs?.agentName ?: sp.getString(KEY_AGENT_NAME, null)
        val oldSearchProvider = oldAgentPrefs?.searchProvider ?: sp.getString(KEY_SEARCH_PROVIDER, null)

        // Restore the prefs this save may have changed to their pre-save values. commit(), not
        // apply(): the caller is told the save failed, so the rollback must be on disk first.
        fun rollbackPrefs(): Boolean {
            val rollback = sp.edit()
            // BAT-1661: only a selection wrote these three, so only a selection rolls them back.
            if (isSelection) rollbackModelSelection(tx, rollback, oldProvider, oldAuthType, oldModel)
            if (oldAgentName != null) rollback.putString(KEY_AGENT_NAME, oldAgentName)
            else rollback.remove(KEY_AGENT_NAME)
            if (oldSearchProvider != null) rollback.putString(KEY_SEARCH_PROVIDER, oldSearchProvider)
            else rollback.remove(KEY_SEARCH_PROVIDER)
            rollback.putBoolean(KEY_SETUP_COMPLETE, oldSetupComplete)
            return rollback.commit()
        }

        // BAT-515 v3 §4 step 2: pre-validate agent-preferences fields
        // BEFORE any persistence. The cap/allowlist gates inside
        // AgentPreferencesStore.update would fire AFTER prefs.commit
        // (and possibly RuntimeStateStore.update) had already
        // succeeded — leaving prefs holding values the file refuses
        // to take. Up-front gate keeps all three stores
        // either fully-saved or fully-unchanged.
        //
        // Validation is context-sensitive (Codex final guard): only
        // fields that genuinely DIFFER from the current
        // AgentPreferencesStore state hit the cap/allowlist. An
        // existing migrated long agentName that the UI is just
        // carrying through (unchanged from the live store) does NOT
        // fail here.
        if (AgentPreferencesStore.isInitialized) {
            try {
                AgentPreferencesStore.validateForWrite(
                    next = AgentPreferences(
                        searchProvider = config.searchProvider,
                        agentName = config.agentName,
                    ),
                    current = AgentPreferencesStore.read(),
                )
            } catch (e: IllegalArgumentException) {
                LogCollector.append(
                    "[Config] saveConfig rejected agent preferences: ${e.message}",
                    LogLevel.WARN,
                )
                return false
            }
        }

        val encApiKey = sealer.seal(config.anthropicApiKey)
        val encBotToken = sealer.seal(config.telegramBotToken)

        val editor = MainPrefs.edit(sp)
            .putString(KEY_API_KEY_ENC, encApiKey)
            .putString(KEY_BOT_TOKEN_ENC, encBotToken)
            .putString(KEY_OWNER_ID, config.telegramOwnerId)
            .putString(KEY_AGENT_NAME, config.agentName)
            .putBoolean(KEY_AUTO_START, config.autoStartOnBoot)
            .putBoolean(KEY_RICH_MESSAGES, config.richMessages)
            .putInt(KEY_HEARTBEAT_INTERVAL, config.heartbeatIntervalMinutes)
            .putInt(KEY_MAX_STEPS_PER_TURN, config.maxStepsPerTurn)
            .putBoolean(KEY_SETUP_COMPLETE, true)
        // BAT-1661: the model selection is written only by a selection (see saveConfig KDoc).
        if (isSelection) {
            editor.putString(KEY_PROVIDER, config.provider)
                .putString(KEY_AUTH_TYPE, config.authType)
                .putString(KEY_MODEL, config.model)
        }

        // Store setup token separately so switching auth type preserves both
        if (config.setupToken.isNotBlank()) {
            val encSetupToken = sealer.seal(config.setupToken)
            editor.putString(KEY_SETUP_TOKEN_ENC, encSetupToken)
        } else {
            editor.remove(KEY_SETUP_TOKEN_ENC)
        }

        if (config.braveApiKey.isNotBlank()) {
            val encBrave = sealer.seal(config.braveApiKey)
            editor.putString(KEY_BRAVE_API_KEY_ENC, encBrave)
        } else {
            editor.remove(KEY_BRAVE_API_KEY_ENC)
        }

        editor.putString(KEY_SEARCH_PROVIDER, config.searchProvider)

        if (config.perplexityApiKey.isNotBlank()) {
            val encPerplexity = sealer.seal(config.perplexityApiKey)
            editor.putString(KEY_PERPLEXITY_API_KEY_ENC, encPerplexity)
        } else {
            editor.remove(KEY_PERPLEXITY_API_KEY_ENC)
        }

        if (config.exaApiKey.isNotBlank()) {
            val encExa = sealer.seal(config.exaApiKey)
            editor.putString(KEY_EXA_API_KEY_ENC, encExa)
        } else {
            editor.remove(KEY_EXA_API_KEY_ENC)
        }

        if (config.tavilyApiKey.isNotBlank()) {
            val encTavily = sealer.seal(config.tavilyApiKey)
            editor.putString(KEY_TAVILY_API_KEY_ENC, encTavily)
        } else {
            editor.remove(KEY_TAVILY_API_KEY_ENC)
        }

        if (config.firecrawlApiKey.isNotBlank()) {
            val encFirecrawl = sealer.seal(config.firecrawlApiKey)
            editor.putString(KEY_FIRECRAWL_API_KEY_ENC, encFirecrawl)
        } else {
            editor.remove(KEY_FIRECRAWL_API_KEY_ENC)
        }

        if (config.jupiterApiKey.isNotBlank()) {
            val encJupiter = sealer.seal(config.jupiterApiKey)
            editor.putString(KEY_JUPITER_API_KEY_ENC, encJupiter)
        } else {
            editor.remove(KEY_JUPITER_API_KEY_ENC)
        }

        if (config.heliusApiKey.isNotBlank()) {
            val encHelius = sealer.seal(config.heliusApiKey)
            editor.putString(KEY_HELIUS_API_KEY_ENC, encHelius)
        } else {
            editor.remove(KEY_HELIUS_API_KEY_ENC)
        }

        if (keepsSecret(config.openaiApiKey)) {
            val encOpenai = sealer.seal(config.openaiApiKey)
            editor.putString(KEY_OPENAI_API_KEY_ENC, encOpenai)
        } else {
            editor.remove(KEY_OPENAI_API_KEY_ENC)
        }

        if (config.openrouterApiKey.isNotBlank()) {
            val encOpenRouter = sealer.seal(config.openrouterApiKey)
            editor.putString(KEY_OPENROUTER_API_KEY_ENC, encOpenRouter)
        } else {
            editor.remove(KEY_OPENROUTER_API_KEY_ENC)
        }
        editor.putString(KEY_OPENROUTER_FALLBACK_MODEL, config.openrouterFallbackModel)
        editor.putString(KEY_OPENROUTER_MODEL_CONTEXT, config.openrouterModelContext)
        editor.putString(KEY_OPENROUTER_FALLBACK_CONTEXT, config.openrouterFallbackContext)

        if (config.customApiKey.isNotBlank()) {
            val encCustom = sealer.seal(config.customApiKey)
            editor.putString(KEY_CUSTOM_API_KEY_ENC, encCustom)
        } else {
            editor.remove(KEY_CUSTOM_API_KEY_ENC)
        }
        editor.putString(KEY_CUSTOM_BASE_URL, config.customBaseUrl)
        if (config.customHeaders.isNotBlank()) {
            val encHeaders = sealer.seal(config.customHeaders)
            editor.putString(KEY_CUSTOM_HEADERS_ENC, encHeaders)
        } else {
            editor.remove(KEY_CUSTOM_HEADERS_ENC)
        }
        editor.putString(KEY_CUSTOM_FORMAT, config.customFormat)

        editor.putString(KEY_CHANNEL, config.channel)
        if (config.discordBotToken.isNotBlank()) {
            val encDiscord = sealer.seal(config.discordBotToken)
            editor.putString(KEY_DISCORD_BOT_TOKEN_ENC, encDiscord)
        } else {
            editor.remove(KEY_DISCORD_BOT_TOKEN_ENC)
        }
        editor.putString(KEY_DISCORD_OWNER_ID, config.discordOwnerId)

        // BAT-1157: the OpenAI sign-in pair lives in OpenAIOAuthTokenStore. saveConfig never writes
        // it: a save from a form loaded before a sign-in or rotation must not put an old pair back.

        // BAT-1124: xAI api-key secret (api_key path). The xAI *OAuth* triple
        // is intentionally NOT written here anymore.
        if (config.xaiApiKey.isNotBlank()) {
            val encXai = sealer.seal(config.xaiApiKey)
            editor.putString(KEY_XAI_API_KEY_ENC, encXai)
        } else {
            editor.remove(KEY_XAI_API_KEY_ENC)
        }
        // BAT-1155: the KEY_XAI_OAUTH_TOKEN/REFRESH/EMAIL/EXPIRES writes were
        // REMOVED. That whole-map `editor.commit()` flushing this MAIN-process
        // snapshot back over the token `:node` had just rotated in prefs was
        // the durability root cause (§2a). The xAI OAuth record now lives in
        // XaiOAuthTokenStore, written ONLY by sign-in/sign-out (MAIN) and
        // rotation (:node bridge) — no unrelated config save can clobber it.

        // BAT-1661 (CodeRabbit on 444ba220): a failed commit leaves the new values in MAIN's prefs
        // cache, and the next successful commit of ANY key (an auto-start toggle) would flush the
        // rejected selection to disk. commitOrRestore puts the old values back.
        val persisted = MainPrefs.commitOrRestore(editor)
        if (!persisted) {
            LogCollector.append("[Config] Failed to persist config (commit=false)", LogLevel.ERROR)
            return false
        }
        bumpConfigVersionOnMain()
        // BAT-513 round-9: writeAgentSettingsJson DEFERRED to after
        // RuntimeStateStore.write succeeds. The overlay also persists
        // provider/authType/model, and reconcileWithAgentSettings would
        // re-adopt a NEW overlay back into prefs on the next loadConfig
        // — undoing the rollback we do below if RuntimeStateStore.write
        // fails. By moving the overlay write past the
        // RuntimeStateStore.write success gate, the failure path simply
        // doesn't write the overlay, so there's nothing to roll back
        // there. broadcastConfigChanged also moves to the success path
        // so other-process observers don't get a "config changed"
        // signal for a save that's about to be reverted.
        // BAT-513: persist the cross-process runtime state file so the
        // `:node` process picks up provider/authType/model via
        // runtime-state.js without waiting for a service restart. The
        // RuntimeStateStore.write also re-emits via its StateFlow, and
        // its observe-and-mirror collector will see the new value
        // already matches prefs (we wrote them above) and skip the
        // mirror — the redundancy guard is what makes the dual write
        // free.
        //
        // ATOMICITY: if RuntimeStateStore.write fails (FS error), roll
        // back the prefs runtime fields to their pre-saveConfig values
        // so prefs and runtime_state.json don't diverge on the runtime
        // fields. Without rollback, prefs would hold the new runtime
        // fields while runtime_state.json kept the old ones — a
        // downgrade would land on prefs values that never reached the
        // cross-process file. The IllegalArgumentException catch is
        // now defense-in-depth (the up-front matrix gate at the top
        // of saveConfig should have prevented invalid combos from
        // reaching here); same rollback applies.
        //
        // PROCESS GUARD: RuntimeStateStore.init only runs in the main
        // process (SeekerClawApplication.onCreate gates it on
        // isMainProcess). In `:node`, isInitialized is false and
        // RuntimeStateStore.write would always return false → saveConfig
        // would always fail in `:node` even when prefs commit succeeded,
        // breaking existing AndroidBridge / service-process callers
        // (round-12 review finding). Skip the runtime-state write +
        // rollback path in `:node`; runtime_state.json gets its sync
        // from the direct runtime-state.js write inside Telegram
        // /provider and /model handlers.
        // BAT-549 Commit 3d: preserve the BAT-549 RuntimeState fields
        // across this write. Pre-3d this constructed RuntimeState with
        // only (provider, authType, model), letting the data class
        // defaults clobber reasoningEnabled / reasoningDisplayInChat /
        // customEchoReasoning / customConfigSignature back to their
        // factory values on every saveConfig. With 3d we read the
        // current state first, carry the BAT-549 fields forward, AND
        // recompute the Custom-config signature: when the signature
        // changes (user edited Custom config), reset
        // customEchoReasoning to false (the override is gateway-
        // specific; a new gateway must re-opt-in).
        //
        // R26 Copilot: use atomic RuntimeStateStore.update {} so the
        // BAT-549 fields can't be lost-update-clobbered by a
        // concurrent writer (Telegram /think handler, future /resume,
        // another saveConfig in flight from a different process). The
        // transform runs INSIDE the CrossProcessStore writeLock — the
        // `current` value passed in is the latest persisted state at
        // the moment of write, so reasoningEnabled/reasoningDisplayInChat
        // and any future BAT-549 fields are preserved verbatim except
        // for the Custom-signature reset path we explicitly handle.
        //
        // saveConfig itself is non-suspend (called from Settings and
        // post-OAuth flows that don't currently hold a CoroutineScope),
        // so we wrap the suspend update via `runBlocking` on
        // Dispatchers.IO. saveConfig already does multiple synchronous
        // SharedPreferences commit() calls; one more blocking call to
        // CrossProcessStore (which itself just synchronously writes
        // a tmp file + atomic-renames) doesn't change the latency
        // profile. Future refactor to suspend-saveConfig is in scope
        // for a separate cleanup PR.
        //
        // Custom-signature reset:
        //   - Only recompute when the provider being stored is "custom"
        //     (BAT-1661: config.provider/model on a selection, the stored
        //     provider/model on an unrelated save) because AppConfig has
        //     no separate "customModel" field; the model represents Custom
        //     only when on Custom. Switching providers and back must NOT reset
        //     the override — only direct edits to Custom config fields.
        //   - When the new sig != current.customConfigSignature, reset
        //     customEchoReasoning to false (gateway-specific contract;
        //     see RuntimeState.kt KDoc). Otherwise carry forward.
        // BAT-515 v3 §4 step 5 rollback: capture the RuntimeState as it
        // existed at the moment our forward `update {}` ran (the value
        // passed in as `current`). If AgentPreferencesStore.update fails
        // later, we restore THIS snapshot via a second `update {}` so
        // runtime_state.json reverts to where it was before saveConfig
        // touched it. Captured inside the lambda — outside-the-lock
        // RuntimeStateStore.read() could observe a different value if
        // a concurrent /think writer landed between the read and our
        // update's writeLock acquisition.
        var preForwardRuntime: RuntimeState? = null
        // BAT-1661: the record this save's forward update wrote (the undo's compare-and-swap value).
        var postForwardRuntime: RuntimeState? = null
        var loggedSigReset = false

        // Undo the RuntimeStateStore forward update. Skip when nothing was forwarded
        // (RuntimeStateStore not initialized, no record for an unrelated save, OR an
        // IllegalArgumentException short-circuited the lambda — the forward update never persisted).
        //
        // BAT-1661 (CodeRabbit on 444ba220): compare-and-swap. Only while the record still holds
        // what THIS save wrote are the fields it wrote put back; a newer writer that landed in
        // between (Node's /provider or /model, which cannot take the Kotlin lock — BAT-1663) keeps
        // its tuple, and a concurrent /think keeps its reasoning toggles. That outcome is
        // [RuntimeUndo.KEPT_NEWER] (logged as `runtime_kept_newer=true`), never reported as an undo.
        fun undoRuntimeWrite(): RuntimeUndo {
            val snapshot = preForwardRuntime
            val forward = postForwardRuntime
            return if (RuntimeStateStore.isInitialized && snapshot != null && forward != null) try {
                when (RuntimeStateStore.updateExisting(tx) { cur ->
                    val stillOurs = cur.provider == forward.provider && cur.authType == forward.authType &&
                        cur.model == forward.model && cur.customEchoReasoning == forward.customEchoReasoning &&
                        cur.customConfigSignature == forward.customConfigSignature
                    if (!stillOurs) {
                        null
                    } else {
                        cur.copy(
                            provider = snapshot.provider,
                            authType = snapshot.authType,
                            model = snapshot.model,
                            customEchoReasoning = snapshot.customEchoReasoning,
                            customConfigSignature = snapshot.customConfigSignature,
                        )
                    }
                }) {
                    com.seekerclaw.app.util.CrossProcessStore.UpdateOutcome.WRITTEN -> RuntimeUndo.UNDONE
                    com.seekerclaw.app.util.CrossProcessStore.UpdateOutcome.FAILED -> RuntimeUndo.FAILED
                    // The record changed (or went) since this save wrote it: a newer writer's, kept.
                    com.seekerclaw.app.util.CrossProcessStore.UpdateOutcome.UNCHANGED,
                    com.seekerclaw.app.util.CrossProcessStore.UpdateOutcome.ABSENT -> RuntimeUndo.KEPT_NEWER
                }
            } catch (e: IllegalArgumentException) {
                // Should not happen — the snapshot came out of RuntimeStateStore itself, so its
                // (provider,authType) is guaranteed valid. Defense-in-depth log.
                LogCollector.append(
                    "[Config] RuntimeStateStore rollback rejected snapshot (unexpected): ${e.message}",
                    LogLevel.ERROR,
                )
                RuntimeUndo.FAILED
            } else RuntimeUndo.UNDONE
        }
        val forwardRecord = { current: RuntimeState ->
            preForwardRuntime = current
            val newCustomSig = customSignatureForSave(isSelection, config, current)
            val customSigChanged = (if (isSelection) config.provider else current.provider) == "custom"
                && current.customConfigSignature != newCustomSig
            val newCustomEcho = if (customSigChanged) false else current.customEchoReasoning
            if (customSigChanged && current.customEchoReasoning) {
                loggedSigReset = true
            }
            // BAT-1661: an unrelated save keeps the stored selection (v2.5 §2).
            current.copy(
                provider = if (isSelection) config.provider else current.provider,
                // BAT-1124 H5: gate (xai, oauth) with a blank token → api_key so
                // runtime_state.json never advertises an unstartable oauth pair.
                authType = if (isSelection) runtimeAuthTypeFor(config) else current.authType,
                model = if (isSelection) config.model else current.model,
                // reasoningEnabled / reasoningDisplayInChat
                // are preserved verbatim from `current` — no
                // change in saveConfig.
                customEchoReasoning = newCustomEcho,
                customConfigSignature = newCustomSig,
            ).also { postForwardRuntime = it }
        }
        val runtimeWritten = if (RuntimeStateStore.isInitialized) try {
            if (isSelection) {
                // BAT-1661: the IO hop runs on another thread; the transaction is the `tx` token, which
                // crosses it, so nothing is re-acquired here (contract v2.4 §4).
                kotlinx.coroutines.runBlocking(kotlinx.coroutines.Dispatchers.IO) {
                    RuntimeStateStore.update(tx) { current -> forwardRecord(current) }
                }
            } else {
                // BAT-1661 (CodeRabbit on 444ba220): an unrelated save only carries its own fields
                // forward on the record ON DISK. With no record, `update` would build one from the
                // launch-time seed — a selection that can predate the user's (or a pending repair's)
                // and that Node reads first. No record: nothing of the selection to keep in step, so
                // nothing is written and the save goes on (Node falls back to config.json).
                RuntimeStateStore.updateExisting(tx) { current -> forwardRecord(current) } !=
                    com.seekerclaw.app.util.CrossProcessStore.UpdateOutcome.FAILED
            }
        } catch (e: IllegalArgumentException) {
            LogCollector.append(
                "[Config] saveConfig produced invalid RuntimeState (defense-in-depth): " +
                    "${e.message}",
                LogLevel.WARN,
            )
            false
        } else {
            // `:node` process — RuntimeStateStore not initialized.
            // Treat as "no-op success" so saveConfig completes the
            // prefs+overlay+broadcast path normally. runtime_state.json
            // sync in `:node` happens at the runtime-state.js write
            // sites (/provider, /model), not here.
            true
        }
        if (!runtimeWritten) {
            // Roll back prefs runtime fields AND KEY_SETUP_COMPLETE to
            // pre-save snapshot. Use commit() (synchronous, returns
            // success) rather than apply() (async, fire-and-forget) so
            // saveConfig can't return false to the caller while the
            // rollback is still pending on disk — a quick process kill
            // between return and disk flush would otherwise leave
            // KEY_SETUP_COMPLETE stuck `true` on first-install failures
            // or runtime fields half-rolled-back. Rolling back
            // KEY_SETUP_COMPLETE matters for the first-install failure
            // case: SetupScreen blocks on `false`, but without rollback
            // prefs would say "setup complete" → MainActivity would
            // skip Setup on next launch, leaving the user stranded
            // with an unconfigured agent. For existing users (snapshot
            // already true), the rollback is a no-op.
            //
            // R5 Copilot: BAT-515 added KEY_AGENT_NAME / KEY_SEARCH_PROVIDER
            // to the same `editor.commit()` block above (lines 367, 389).
            // The pre-BAT-515 rollback only covered the BAT-513 runtime
            // keys, so a RuntimeStateStore failure left prefs holding the
            // NEW agentName/searchProvider while runtime_state.json kept
            // the OLD values — and agent_preferences.json (which the
            // saveConfig flow hasn't reached yet at this point) also has
            // the old values. Without these two extra rollback lines,
            // prefs and the cross-process files would diverge on the
            // RuntimeStateStore-failure path, undoing the v3 §4 atomicity
            // contract. rollbackPrefs restores both, as every rollback path does.
            val rollbackOk = rollbackPrefs()
            if (!rollbackOk) {
                // Synchronous commit failed (rare — usually means the
                // disk is genuinely full). Log loudly; the partial
                // rollback may have landed depending on which fields
                // SharedPreferences flushed before failing. The caller
                // still gets `false` so the UI surfaces the failure.
                LogCollector.append(
                    "[Config] Rollback commit() returned false — prefs may be in inconsistent state " +
                        "(some fields possibly half-rolled-back)",
                    LogLevel.ERROR,
                )
            }
            // Bump configVersion AGAIN so the UI recomposes with the
            // rolled-back runtime fields (it already recomposed once
            // post-commit with the failed-but-persisted values; a
            // second bump corrects the snapshot).
            bumpConfigVersionOnMain()
            LogCollector.append(
                "[Config] RuntimeStateStore.write failed — rolled back prefs to " +
                    "(provider=$oldProvider, authType=$oldAuthType, model=$oldModel, " +
                    "agentName=$oldAgentName, searchProvider=$oldSearchProvider) " +
                    "and KEY_SETUP_COMPLETE to $oldSetupComplete (commit_ok=$rollbackOk)",
                LogLevel.WARN,
            )
            return false
        }

        // BAT-515 v3 §4 step 5: AgentPreferencesStore.update is the
        // SECOND cross-process write site. By this point prefs and
        // runtime_state.json already reflect the new config. If THIS
        // write fails, agent_preferences.json is the only persistent
        // store still holding the OLD values — the three would
        // diverge (a downgrade would land on prefs values that never
        // reached agent_preferences.json). The rollback below restores
        // the prior state across ALL THREE stores.
        //
        // PROCESS GUARD: AgentPreferencesStore.init only runs in the
        // main process (mirrors RuntimeStateStore.isInitialized
        // gating above). In `:node`, AgentPreferencesStore.update
        // would always return false → saveConfig would always fail —
        // breaking AndroidBridge / service-process callers. Treat
        // uninitialized as no-op success; agent_preferences.json sync
        // in `:node` happens at the agent-preferences.js write sites
        // directly.
        //
        // Defense-in-depth catch: pre-validation above should have
        // already caught any allowlist/cap violation. The catch here
        // covers the narrow race where the observe-and-mirror
        // collector pulled in a DIFFERENT current value between
        // pre-validation and this update {}'s writeLock — making the
        // (next, current-inside-lock) pair newly-invalid. Rare, but
        // the rollback path keeps things atomic if it happens.
        val agentPrefsWritten = if (AgentPreferencesStore.isInitialized) try {
            kotlinx.coroutines.runBlocking(kotlinx.coroutines.Dispatchers.IO) {
                AgentPreferencesStore.update { current ->
                    current.copy(
                        searchProvider = config.searchProvider,
                        agentName = config.agentName,
                    )
                }
            }
        } catch (e: IllegalArgumentException) {
            LogCollector.append(
                "[Config] saveConfig produced invalid AgentPreferences (defense-in-depth): " +
                    "${e.message}",
                LogLevel.WARN,
            )
            false
        } else {
            // `:node` — see PROCESS GUARD comment above.
            true
        }
        if (!agentPrefsWritten) {
            // Roll back ALL prefs touched by this saveConfig (the
            // runtime fields AND the new agent-prefs fields AND
            // KEY_SETUP_COMPLETE) so the user's pre-save state is
            // restored. Then undo the RuntimeStateStore.update from
            // step 4 by writing the captured `preForwardRuntime`
            // snapshot back into the file via a second `update {}`.
            //
            // The second update's lambda IGNORES the latest `current`
            // (passes `_` and returns the snapshot) — by-design per
            // v3 §4, "undo step 4 → restore prior runtime state". A
            // concurrent /think writer that landed between our forward
            // update and this rollback gets clobbered; that's the
            // intentional rollback semantic. /think writes are
            // tolerable to lose under this rare path; preferring user-
            // intent atomicity over inter-update concurrent retention.
            val rollbackOk = rollbackPrefs()
            if (!rollbackOk) {
                LogCollector.append(
                    "[Config] Rollback commit() returned false — prefs may be in inconsistent state " +
                        "(some runtime/agent fields possibly half-rolled-back)",
                    LogLevel.ERROR,
                )
            }
            val runtimeUndo = undoRuntimeWrite()
            val runtimeUndone = runtimeUndo != RuntimeUndo.FAILED
            bumpConfigVersionOnMain()
            LogCollector.append(
                "[Config] AgentPreferencesStore.update failed — rolled back prefs to " +
                    "(provider=$oldProvider, authType=$oldAuthType, model=$oldModel, " +
                    "agentName=$oldAgentName, searchProvider=$oldSearchProvider) and " +
                    "KEY_SETUP_COMPLETE to $oldSetupComplete " +
                    "(commit_ok=$rollbackOk, runtime_undone=$runtimeUndone${runtimeUndo.logSuffix()})",
                LogLevel.WARN,
            )
            return false
        }

        // BAT-513 round-9: the overlay is written ONLY after prefs, runtime_state.json and
        // agent_preferences.json all succeeded. It persists provider/authType/model too; writing
        // it first would mean a failure-path rollback would also need to revert the overlay (and
        // the next loadConfig's reconcileWithAgentSettings would re-adopt it back into prefs).
        //
        // Publish THIS config directly: a loadConfig round-trip would
        // re-trigger reconcile (PR #339 device-test regression fix).
        // BAT-1661: an unrelated save keeps the overlay's provider/authType/model.
        //
        // BAT-1661 (Codex diff review #2): its outcome is checked. Node reads the overlay first,
        // so a selection acknowledged over a failed overlay write would be reverted by the old
        // overlay, and would clear a pending repair on top. The write is atomic, so the previous
        // file is still in place: undo every store this save wrote and report the failure.
        if (!writeAgentSettingsJson(context, tx, config, publishModelFields = isSelection)) {
            val rollbackOk = rollbackPrefs()
            val runtimeUndo = undoRuntimeWrite()
            val runtimeUndone = runtimeUndo != RuntimeUndo.FAILED
            val agentPrefsUndone = if (AgentPreferencesStore.isInitialized && oldAgentPrefs != null) try {
                kotlinx.coroutines.runBlocking(kotlinx.coroutines.Dispatchers.IO) {
                    AgentPreferencesStore.update { current ->
                        current.copy(searchProvider = oldAgentPrefs.searchProvider, agentName = oldAgentPrefs.agentName)
                    }
                }
            } catch (e: IllegalArgumentException) {
                false
            } else true
            bumpConfigVersionOnMain()
            LogCollector.append(
                "[Config] agent_settings.json write failed — rolled back prefs to " +
                    "(provider=$oldProvider, authType=$oldAuthType, model=$oldModel, " +
                    "agentName=$oldAgentName, searchProvider=$oldSearchProvider) and " +
                    "KEY_SETUP_COMPLETE to $oldSetupComplete " +
                    "(commit_ok=$rollbackOk, runtime_undone=$runtimeUndone${runtimeUndo.logSuffix()}, agent_prefs_undone=$agentPrefsUndone)",
                if (rollbackOk && runtimeUndone && agentPrefsUndone) LogLevel.WARN else LogLevel.ERROR,
            )
            return false
        }

        // R4 Copilot (BAT-549) + BAT-515 v3 §4 step 5: gate the
        // BAT-549 reset-log on BOTH stores succeeding. The
        // `loggedSigReset` flag is set inside the RuntimeStateStore
        // forward `update {}` lambda — but if AgentPreferencesStore
        // failed afterwards, the rollback path above already restored
        // RuntimeStateStore via the `preForwardRuntime` snapshot,
        // including reverting `customEchoReasoning` to whatever it
        // was. Logging "reset to false" in that case would tell the
        // user about a reset that didn't actually persist. Gating on
        // `runtimeWritten && agentPrefsWritten` ensures the log fires
        // only when the change actually reached disk in BOTH stores.
        if (loggedSigReset && runtimeWritten && agentPrefsWritten) {
            LogCollector.append(
                "[Config] BAT-549: Custom config signature changed — reset " +
                    "customEchoReasoning to false (re-enable in Settings on the new gateway)",
                LogLevel.INFO,
            )
        }

        // BAT-1661 (v2.5 §2): a successful selection — every store written, the overlay included —
        // supersedes a pending model repair.
        if (isSelection) ModelRepair.cancelAfterSelection(tx, context.filesDir.toPath())
        // BAT-1661 v2.12 H5 (Q16): ...and an interrupted reconcile's retry record (checked,
        // best-effort; a leftover classifies Superseded or Completed at the next resolve). Unrelated
        // saves never write the selection, so they leave it alone.
        if (isSelection) ReconcileRecord.clearSuperseded(tx, context.filesDir.toPath())
        // Fold 5′: ...and any "restart to apply" notice for an older selection (same transaction).
        if (isSelection) RestartNotice.invalidate(tx, context.filesDir.toPath())
        // Notify the OTHER process — main-process UI relies on this
        // to refresh after :node-process writes (e.g. /provider
        // Telegram switch's service-start reconcile). Same-process
        // observers already saw the configVersion bump above.
        broadcastConfigChanged(context)
        return true
    }

    /**
     * The Custom-provider signature [saveConfig] stores (BAT-1661). An unrelated save keeps the
     * stored provider and model, so the signature is computed for THAT pair, not the form's: a
     * `/model` change after the form loaded would otherwise keep a stale signature (and echo
     * override) for the new model. Off Custom, the stored signature is carried unchanged.
     */
    internal fun customSignatureForSave(isSelection: Boolean, config: AppConfig, current: RuntimeState): String? {
        val provider = if (isSelection) config.provider else current.provider
        val model = if (isSelection) config.model else current.model
        if (provider != "custom") return current.customConfigSignature
        return CustomConfigSignature.compute(
            customModel = model,
            customBaseUrl = config.customBaseUrl,
            customFormat = config.customFormat,
            customHeaders = config.customHeaders,
        )
    }

    private fun rollbackModelSelection(
        tx: ModelSelectionLock.Tx,
        rollback: SharedPreferences.Editor,
        oldProvider: String?,
        oldAuthType: String?,
        oldModel: String?,
    ) {
        tx.requireOpen()
        if (oldProvider != null) rollback.putString(KEY_PROVIDER, oldProvider) else rollback.remove(KEY_PROVIDER)
        if (oldAuthType != null) rollback.putString(KEY_AUTH_TYPE, oldAuthType) else rollback.remove(KEY_AUTH_TYPE)
        if (oldModel != null) rollback.putString(KEY_MODEL, oldModel) else rollback.remove(KEY_MODEL)
    }

    /**
     * Returns the persisted config if setup is complete, otherwise null.
     *
     * For a "read whatever is there, even pre-setup" variant — used during
     * onboarding to pick up OAuth tokens written by [OpenAIOAuthActivity]
     * before saveAndStart has ever run — see [loadConfigOrBootstrap].
     */
    fun loadConfig(context: Context): AppConfig? {
        if (!isSetupComplete(context)) return null
        return loadConfigLocked(context)
    }

    /**
     * BAT-1661: how long a load waits for the [ModelSelectionLock] before reconciling compute-only.
     * Short, because loads run on the UI thread; a busy lock only means "a model write is in
     * flight", and a compute-only load returns the same values without committing them.
     */
    private const val LOAD_LOCK_TIMEOUT_MS = 250L

    /**
     * Reconcile may commit provider/authType/model to prefs and runtime_state, so it runs under
     * the lock. A busy lock (or a load nested inside a transaction) reconciles compute-only.
     *
     * BAT-1661 (contract v2.7 §1): in `:node` it never opens a transaction. `:node` writes no
     * prefs, so its load is compute-only anyway; taking the lock would only stall a Node
     * `/provider` call (up to [LOAD_LOCK_TIMEOUT_MS]) behind a Settings save.
     */
    private fun loadConfigLocked(context: Context): AppConfig {
        if (ProcessRole.isNode) return loadConfigUnchecked(context, null, null)
        // BAT-1661 v2.12 fold 5′: this load's own resolve outcome; a finished change may have saved a
        // restart notice, which the UI re-reads only after THIS transaction is released. Nothing here
        // stops or starts the agent.
        var owned: ReconcileRecord.Outcome? = null
        val r = try {
            ModelSelectionLock.transaction(LOAD_LOCK_TIMEOUT_MS) { tx ->
                loadConfigOut(context, tx, null, bootFiles = false, onResolved = { owned = it })
            }
        } finally {
            RestartNotice.afterRelease(context.filesDir?.toPath(), owned)
        }
        val config = when (r) {
            is ModelSelectionLock.Result.Acquired -> r.value.config
            is ModelSelectionLock.Result.Busy -> loadConfigUnchecked(context, null, null)
        }
        // BAT-1661 (round-10 gap c): the display's key flag, derived AFTER the model transaction is
        // released, revision first (CodeRabbit 4626795862: never a key value read earlier). The
        // decrypt and the re-projection (which decrypts the OpenAI sign-in) run on the store's IO
        // scope in production — neither under the model lock nor on the calling (often main) thread.
        RuntimeStateStore.rederiveOpenAIKeyUsable { keyUsableOf(prefs(context)) }
        return config
    }

    /**
     * BAT-1661 service start: the load inside the boot transaction, with the repair's
     * [approved] target carried into reconcile (contract v2.4 §2). Null when setup is incomplete.
     *
     * Contract v2.7 §2 (D7.3): the selection is resolved from the files read fresh, in Node's
     * order ([bootSelection]), never from `:node`'s prefs cache, which can be older than a MAIN save.
     */
    internal fun loadConfigForBoot(
        context: Context,
        tx: ModelSelectionLock.Tx,
        approved: ModelRepair.ApprovedTarget?,
    ): AppConfig? {
        tx.requireOpen()
        if (!isSetupComplete(context)) return null
        return loadConfigUnchecked(context, tx, approved, bootFiles = true)
    }

    /**
     * BAT-1661 contract v2.7 §2 (D7.3): the boot's selection, from the files read fresh, in Node's
     * order (`config.js`):
     *  - provider and auth: runtime_state.json when it is Present, else prefs;
     *  - model: [NodeDispatch.winner] — an applicable overlay with a non-blank model, else
     *    runtime_state's, else prefs'.
     * Reconcile then runs against this selection, so an overlay model the files agree on equals it
     * and is never clamped, even when unlisted.
     *
     * One exception keeps the user's auth: a runtime_state auth that is only the BAT-1124 boot-guard
     * image of the prefs selection ([isXaiGuardImage]) is the SAME selection, so prefs' auth is
     * kept. Taking it would publish api_key into the overlay, and MAIN's reconcile would then
     * commit it over the user's OAuth choice. A fresh overlay explicitly on xai/api_key proves a
     * real API-key choice, which is then taken (Codex Q12).
     */
    internal fun bootSelection(files: java.nio.file.Path, fromPrefs: AppConfig): AppConfig {
        val rt = RuntimeStateFile.read(files)
        val w = NodeDispatch.winner(rt, AgentSettingsFile.read(files), fromPrefs.provider, fromPrefs.model)
        val tuple = (rt as? RuntimeStateFile.Read.Present)?.tuple
            ?: return fromPrefs.copy(model = w.model.ifBlank { fromPrefs.model })
        val guardImage = isXaiGuardImage(files, fromPrefs.provider, fromPrefs.authType, tuple.provider, tuple.authType)
        return fromPrefs.copy(
            provider = tuple.provider,
            authType = if (guardImage) "oauth" else tuple.authType,
            model = w.model.ifBlank { fromPrefs.model },
        )
    }

    /**
     * BAT-1661 read-only boot (contract v2.5 §1): the same load with reconcile in compute-only
     * mode. Writes no model-selection store. Null when setup is incomplete.
     */
    internal fun loadConfigReadOnly(context: Context): AppConfig? {
        if (!isSetupComplete(context)) return null
        return loadConfigUnchecked(context, null, null)
    }

    /**
     * BAT-1661 (CodeRabbit on 444ba220): the service start's read-only boot (lock busy, or a plan
     * that leaves the model stores alone). Compute-only like [loadConfigReadOnly], with the
     * selection from the files in Node's order ([bootSelection], contract v2.7 §2 / D7.3), as the
     * ordinary boot takes it — so a busy start emits the same provider the ordinary one would,
     * never a foreign overlay's (Node's own dispatch ignores it). Null when setup is incomplete.
     */
    internal fun loadConfigReadOnlyForBoot(context: Context): AppConfig? {
        if (!isSetupComplete(context)) return null
        return loadConfigUnchecked(context, null, null, bootFiles = true)
    }

    /**
     * Loads whatever config fields are currently in SharedPreferences regardless
     * of whether the setup flow has completed. Use this in places that must work
     * mid-onboarding — specifically, the OpenAI OAuth controller (needs to show
     * "connected" immediately after the callback writes tokens) and saveAndStart
     * (needs to preserve those tokens into the first full saveConfig call).
     *
     * All fields default to empty strings / safe defaults if not persisted yet,
     * so this never throws on a truly fresh install — it just returns a blank
     * AppConfig with whatever few fields have been written so far.
     */
    fun loadConfigOrBootstrap(context: Context): AppConfig = loadConfigLocked(context)

    /**
     * [tx] non-null: reconcile may commit (the caller holds the model-selection lock). Null:
     * compute-only — the returned config is the same, but no model-selection store is written.
     */
    private fun loadConfigUnchecked(
        context: Context,
        tx: ModelSelectionLock.Tx?,
        approved: ModelRepair.ApprovedTarget?,
        /** The `:node` boot transaction: the selection comes from the files ([bootSelection]). */
        bootFiles: Boolean = false,
    ): AppConfig = loadConfigOut(context, tx, approved, bootFiles).config

    /**
     * [loadConfigUnchecked]'s result. [held]: a reconcile retry record is unresolved after this load —
     * it held the selection work (fold 1), or this load's own reconcile left one (its runtime_state
     * write failed; CodeRabbit 4628273764). [outcome]: this load's resolve, whose restart request the
     * caller owns and schedules after its transaction (CodeRabbit 4628273797).
     */
    private class LoadOut(val config: AppConfig, val held: Boolean, val outcome: ReconcileRecord.Outcome?)

    private fun loadConfigOut(
        context: Context,
        tx: ModelSelectionLock.Tx?,
        approved: ModelRepair.ApprovedTarget?,
        bootFiles: Boolean,
        /** Called with this load's resolve outcome as soon as it is known (the caller owns its restart). */
        onResolved: (ReconcileRecord.Outcome) -> Unit = {},
    ): LoadOut {
        tx?.requireOpen()
        // BAT-1155 §4: adopt the xAI OAuth record into XaiOAuthTokenStore
        // (marker-gated, idempotent) BEFORE we read it below. Runs in BOTH
        // the MAIN and `:node` processes — whichever loads config first.
        migrateXaiOAuthToStoreIfNeeded(context)
        val p = prefs(context)
        // BAT-1661 v2.12 H1 (Q16): finish an interrupted reconcile FIRST — after the xAI adoption
        // above (the H5 rule sees the adopted token), before the repair snapshot, ModelRepair.mainLoad
        // (whose same-scope sync would copy runtime_state's old model over a model-only change), the
        // normaliser and reconcile. MAIN only, under the lock.
        // Fold 1: on Deferred or Failed the WHOLE automatic selection work of this load is held —
        // no normaliser commit, no reconcile commit, no runtime selection write, no intent mutation,
        // and the unresolved record is never replaced: [selTx] is null from here on (compute-only).
        var held = false
        var resolved: ReconcileRecord.Outcome? = null
        val recordOwner = approved == null && tx != null && !ProcessRole.isNode && RuntimeStateStore.isInitialized
        if (recordOwner) {
            val w0 = prefsForWrite(context, "ReconcileRecord.resolve")
            if (w0 != null) {
                val out = ReconcileRecord.resolve(tx!!, context.filesDir.toPath(), MainPrefs.view(w0))
                when {
                    out is ReconcileRecord.Outcome.Recovered -> {
                        postConfigVersionBump()
                        broadcastConfigChanged(context)
                    }
                    out.holds -> held = true
                }
                resolved = out
                onResolved(out)
            }
        }
        val selTx = if (held) null else tx
        // BAT-1661: in the main process, prefs are a per-process cache that `:node` writes cannot
        // refresh. Bring the prefs MODEL up to date from runtime_state.json BEFORE reconciling, so
        // reconcile never mistakes a stale prefs model for a user change and clamps a repaired,
        // valid-but-unlisted model away (contract v2.4 §2). Model only, same provider and auth
        // only — see syncPrefsFromFile (Codex diff review #3).
        //
        // The repair is classified FIRST, from the stores as they are (CodeRabbit on f1607b5d): the
        // sync would otherwise overwrite a retired prefs model — the repair's evidence — with
        // runtime_state's, and reconcile would then find nothing pending and clamp a valid unlisted
        // overlay model. While a repair governs the stores, the sync may only move prefs to the
        // repair's own target. Under the lock, MAIN also acts on the intent (contract v2.8 §3,
        // v2.9 §3–§5: delete a superseded one, converge a handed-off one; ModelRepair.mainLoad).
        // The boot transaction ([approved] set) decides for itself.
        val pending = if (approved != null) null else try {
            val files = context.filesDir.toPath()
            // BAT-1157 (D7.1): the sync writes prefs, so MAIN only (RuntimeStateStore is MAIN-only too).
            val w = if (selTx != null && !ProcessRole.isNode && RuntimeStateStore.isInitialized) {
                prefsForWrite(context, "syncPrefsFromFile")
            } else {
                null
            }
            // v2.8 §4 ordering: the sign-in migration runs before the token-presence snapshot.
            val first = modelSnapshot(context)
            if (selTx != null && w != null) {
                var next: ModelRepair.Snapshot? = first
                val out = ModelRepair.mainLoad(
                    selTx,
                    files,
                    snapshot = { next?.also { next = null } ?: modelSnapshot(context, migrate = false) },
                    sync = { onlyTo -> RuntimeStateStore.syncPrefsFromFile(selTx, files, w, onlyTo = onlyTo) },
                    commitModel = { model -> RuntimeStateStore.commitModelChecked(selTx, w, model) },
                )
                if (out.prefsChanged) postConfigVersionBump()
                out.pending
            } else {
                // Also the held load (fold 1): read-only, so no sync can erase the record's evidence.
                ModelRepair.pendingRepair(files, first, main = !ProcessRole.isNode)
            }
        } catch (_: IllegalStateException) {
            null // registry not initialised (unit tests); production inits it in Application.onCreate
        }

        val apiKey = try {
            val enc = p.getString(KEY_API_KEY_ENC, null)
            if (enc != null) KeystoreHelper.decrypt(Base64.decode(enc, Base64.NO_WRAP)) else ""
        } catch (e: Exception) {
            Log.w(TAG, "Failed to decrypt API key", e)
            LogCollector.append("[Config] Failed to decrypt API key: ${e.javaClass.simpleName}", LogLevel.ERROR)
            ""
        }

        val botToken = try {
            val enc = p.getString(KEY_BOT_TOKEN_ENC, null)
            if (enc != null) KeystoreHelper.decrypt(Base64.decode(enc, Base64.NO_WRAP)) else ""
        } catch (e: Exception) {
            Log.w(TAG, "Failed to decrypt bot token", e)
            LogCollector.append("[Config] Failed to decrypt bot token: ${e.javaClass.simpleName}", LogLevel.ERROR)
            ""
        }

        val setupToken = try {
            val enc = p.getString(KEY_SETUP_TOKEN_ENC, null)
            if (enc != null) KeystoreHelper.decrypt(Base64.decode(enc, Base64.NO_WRAP)) else ""
        } catch (e: Exception) {
            Log.w(TAG, "Failed to decrypt setup token", e)
            LogCollector.append("[Config] Failed to decrypt setup token: ${e.javaClass.simpleName}", LogLevel.ERROR)
            ""
        }

        val braveApiKey = try {
            val enc = p.getString(KEY_BRAVE_API_KEY_ENC, null)
            if (enc != null) KeystoreHelper.decrypt(Base64.decode(enc, Base64.NO_WRAP)) else ""
        } catch (e: Exception) {
            Log.w(TAG, "Failed to decrypt Brave API key", e)
            LogCollector.append("[Config] Failed to decrypt Brave API key: ${e.javaClass.simpleName}", LogLevel.ERROR)
            ""
        }

        val perplexityApiKey = try {
            val enc = p.getString(KEY_PERPLEXITY_API_KEY_ENC, null)
            if (enc != null) KeystoreHelper.decrypt(Base64.decode(enc, Base64.NO_WRAP)) else ""
        } catch (e: Exception) {
            Log.w(TAG, "Failed to decrypt Perplexity API key", e)
            LogCollector.append("[Config] Failed to decrypt Perplexity API key: ${e.javaClass.simpleName}", LogLevel.ERROR)
            ""
        }

        val exaApiKey = try {
            val enc = p.getString(KEY_EXA_API_KEY_ENC, null)
            if (enc != null) KeystoreHelper.decrypt(Base64.decode(enc, Base64.NO_WRAP)) else ""
        } catch (e: Exception) {
            Log.w(TAG, "Failed to decrypt Exa API key", e)
            LogCollector.append("[Config] Failed to decrypt Exa API key: ${e.javaClass.simpleName}", LogLevel.ERROR)
            ""
        }

        val tavilyApiKey = try {
            val enc = p.getString(KEY_TAVILY_API_KEY_ENC, null)
            if (enc != null) KeystoreHelper.decrypt(Base64.decode(enc, Base64.NO_WRAP)) else ""
        } catch (e: Exception) {
            Log.w(TAG, "Failed to decrypt Tavily API key", e)
            LogCollector.append("[Config] Failed to decrypt Tavily API key: ${e.javaClass.simpleName}", LogLevel.ERROR)
            ""
        }

        val firecrawlApiKey = try {
            val enc = p.getString(KEY_FIRECRAWL_API_KEY_ENC, null)
            if (enc != null) KeystoreHelper.decrypt(Base64.decode(enc, Base64.NO_WRAP)) else ""
        } catch (e: Exception) {
            Log.w(TAG, "Failed to decrypt Firecrawl API key", e)
            LogCollector.append("[Config] Failed to decrypt Firecrawl API key: ${e.javaClass.simpleName}", LogLevel.ERROR)
            ""
        }

        val jupiterApiKey = try {
            val enc = p.getString(KEY_JUPITER_API_KEY_ENC, null)
            if (enc != null) KeystoreHelper.decrypt(Base64.decode(enc, Base64.NO_WRAP)) else ""
        } catch (e: Exception) {
            Log.w(TAG, "Failed to decrypt Jupiter API key", e)
            LogCollector.append("[Config] Failed to decrypt Jupiter API key: ${e.javaClass.simpleName}", LogLevel.ERROR)
            ""
        }

        val heliusApiKey = try {
            val enc = p.getString(KEY_HELIUS_API_KEY_ENC, null)
            if (enc != null) KeystoreHelper.decrypt(Base64.decode(enc, Base64.NO_WRAP)) else ""
        } catch (e: Exception) {
            Log.w(TAG, "Failed to decrypt Helius API key", e)
            LogCollector.append("[Config] Failed to decrypt Helius API key: ${e.javaClass.simpleName}", LogLevel.ERROR)
            ""
        }

        // BAT-1661 (Codex 7ec40d8b #1): the display projection's key signal is recorded from this
        // decrypted key by loadConfigLocked, after the model transaction (round-10 gap c).
        val openaiApiKey = decryptOpenAIKey(p, log = true)

        val openrouterApiKey = try {
            val enc = p.getString(KEY_OPENROUTER_API_KEY_ENC, null)
            if (enc != null) KeystoreHelper.decrypt(Base64.decode(enc, Base64.NO_WRAP)) else ""
        } catch (e: Exception) {
            Log.w(TAG, "Failed to decrypt OpenRouter API key", e)
            LogCollector.append("[Config] Failed to decrypt OpenRouter API key: ${e.javaClass.simpleName}", LogLevel.ERROR)
            ""
        }

        val customApiKey = try {
            val enc = p.getString(KEY_CUSTOM_API_KEY_ENC, null)
            if (enc != null) KeystoreHelper.decrypt(Base64.decode(enc, Base64.NO_WRAP)) else ""
        } catch (e: Exception) {
            Log.w(TAG, "Failed to decrypt custom API key", e)
            LogCollector.append("[Config] Failed to decrypt custom API key: ${e.javaClass.simpleName}", LogLevel.ERROR)
            ""
        }

        val customHeaders = try {
            val enc = p.getString(KEY_CUSTOM_HEADERS_ENC, null)
            if (enc != null) KeystoreHelper.decrypt(Base64.decode(enc, Base64.NO_WRAP)) else ""
        } catch (e: Exception) {
            Log.w(TAG, "Failed to decrypt custom headers", e)
            ""
        }

        val discordBotToken = try {
            val enc = p.getString(KEY_DISCORD_BOT_TOKEN_ENC, null)
            if (enc != null) KeystoreHelper.decrypt(Base64.decode(enc, Base64.NO_WRAP)) else ""
        } catch (e: Exception) {
            Log.w(TAG, "Failed to decrypt Discord bot token", e)
            LogCollector.append("[Config] Failed to decrypt Discord bot token: ${e.javaClass.simpleName}", LogLevel.ERROR)
            ""
        }

        // BAT-1157: the OpenAI sign-in pair comes from OpenAIOAuthTokenStore — ONE read, so the
        // pair, expiry, family and epoch always belong to the same write. Until the migration
        // marker exists, an Absent store falls back to the legacy prefs pair (read-only).
        val openai = readOpenAIOAuth(context, p)

        // BAT-1124: xAI api-key + OAuth secrets (mirror the OpenAI decrypt blocks above).
        val xaiApiKey = try {
            val enc = p.getString(KEY_XAI_API_KEY_ENC, null)
            if (enc != null) KeystoreHelper.decrypt(Base64.decode(enc, Base64.NO_WRAP)) else ""
        } catch (e: Exception) {
            Log.w(TAG, "Failed to decrypt xAI API key", e)
            LogCollector.append("[Config] Failed to decrypt xAI API key: ${e.javaClass.simpleName}", LogLevel.ERROR)
            ""
        }

        // BAT-1155: the xAI OAuth triple is now the SINGLE SOURCE OF TRUTH
        // in XaiOAuthTokenStore (ciphertext at rest). Decrypt on read; emit
        // "" for token/refresh whenever the family is dead (tombstone OR
        // reauthRequired) so no reader ever surfaces a consumed/blank token
        // as usable. A missing/corrupt store fails closed to a reauth
        // tombstone inside read(). Never logs decrypted values.
        val xaiRec = XaiOAuthTokenStore.read()
        // BAT-1155 amendment 3 (fail-safe emission): an armed rotation marker means a refresh POST
        // for this epoch was in flight when the prior process died → the on-disk refresh token is
        // POTENTIALLY CONSUMED. Never hand it to the provider — treat the family as dead (blank +
        // reauthRequired) so :node boots INTO reconnect. SeekerClawService.reconcileXaiOAuthOnBoot
        // durably converts this to reauth; this belt covers a conversion that could not persist.
        val xaiView = xaiSignInView(xaiRec)
        val xaiEffectiveReauth = xaiView.effectiveReauth
        val xaiOAuthToken = xaiView.token
        val xaiOAuthRefresh = xaiView.refresh
        val xaiOAuthEmail = decryptXaiCiphertext(xaiRec.emailEnc) ?: "" // email non-critical → "" on failure

        // BAT-515 v3 §4: prefer live AgentPreferencesStore values over
        // raw prefs. The observe-and-mirror collector already keeps
        // prefs in sync with `agent_preferences.json`, but a fresh
        // file write hasn't necessarily round-tripped to prefs by the
        // time loadConfig runs (collector dispatch latency, or a
        // racing reader between the file write and the prefs commit).
        // Reading from the in-memory StateFlow guarantees this
        // loadConfig sees the latest value the store holds — no
        // staleness window.
        //
        // Falls back to the prefs read for `:node` (where
        // AgentPreferencesStore.init never ran) and for the rare
        // pre-init main-process load (config.json cold-start path
        // before the collector kicks in). The defaults at the bottom
        // ("MyAgent", "brave") match AgentPreferences.DEFAULT_*.
        val livePrefs: AgentPreferences? = if (AgentPreferencesStore.isInitialized) {
            AgentPreferencesStore.read()
        } else null
        val fromPrefs = AppConfig(
            anthropicApiKey = apiKey,
            setupToken = setupToken,
            authType = resolveAuthType(context, p, selTx),
            telegramBotToken = botToken,
            telegramOwnerId = loadOwnerIdFromFile(context, "telegram"),
            // Trim at the read boundary: legacy prefs values (pre-BAT-1032
            // claim imports) may carry whitespace, and Node's startup config
            // path uses config.model verbatim — a padded ID breaks provider
            // requests. Blank-after-trim falls back to the default.
            // BAT-1315: default tracks model-registry.json providers[claude].defaultModel.
            model = (p.getString(KEY_MODEL, "claude-opus-5-5") ?: "claude-opus-5-5")
                .trim().ifBlank { "claude-opus-5-5" },
            agentName = livePrefs?.agentName ?: (p.getString(KEY_AGENT_NAME, "MyAgent") ?: "MyAgent"),
            braveApiKey = braveApiKey,
            searchProvider = livePrefs?.searchProvider ?: (p.getString(KEY_SEARCH_PROVIDER, "brave") ?: "brave"),
            perplexityApiKey = perplexityApiKey,
            exaApiKey = exaApiKey,
            tavilyApiKey = tavilyApiKey,
            firecrawlApiKey = firecrawlApiKey,
            jupiterApiKey = jupiterApiKey,
            heliusApiKey = heliusApiKey,
            autoStartOnBoot = p.getBoolean(KEY_AUTO_START, true),
            richMessages = p.getBoolean(KEY_RICH_MESSAGES, true),
            heartbeatIntervalMinutes = p.getInt(KEY_HEARTBEAT_INTERVAL, 30),
            maxStepsPerTurn = p.getInt(KEY_MAX_STEPS_PER_TURN, 35),
            provider = p.getString(KEY_PROVIDER, "claude") ?: "claude",
            openaiApiKey = openaiApiKey,
            openrouterApiKey = openrouterApiKey,
            openrouterFallbackModel = p.getString(KEY_OPENROUTER_FALLBACK_MODEL, "") ?: "",
            openrouterModelContext = p.getString(KEY_OPENROUTER_MODEL_CONTEXT, "") ?: "",
            openrouterFallbackContext = p.getString(KEY_OPENROUTER_FALLBACK_CONTEXT, "") ?: "",
            customApiKey = customApiKey,
            customBaseUrl = p.getString(KEY_CUSTOM_BASE_URL, "") ?: "",
            customHeaders = customHeaders,
            customFormat = p.getString(KEY_CUSTOM_FORMAT, "chat_completions") ?: "chat_completions",
            channel = p.getString(KEY_CHANNEL, "telegram") ?: "telegram",
            discordBotToken = discordBotToken,
            discordOwnerId = loadOwnerIdFromFile(context, "discord"),
            openaiOAuthToken = openai.access,
            openaiOAuthRefresh = openai.refresh,
            openaiOAuthEmail = openai.email,
            openaiOAuthExpiresAt = openai.expiresAt,
            openaiOAuthFamily = openai.familyId,
            openaiOAuthEpoch = openai.epoch,
            xaiApiKey = xaiApiKey,
            xaiOAuthToken = xaiOAuthToken,
            xaiOAuthRefresh = xaiOAuthRefresh,
            xaiOAuthEmail = xaiOAuthEmail,
            // BAT-1155: expiry + control fields come from the store, not prefs.
            xaiOAuthExpiresAt = xaiRec.expiresAt,
            xaiOAuthEpoch = xaiRec.epoch,
            xaiOAuthReauthRequired = xaiEffectiveReauth,
            xaiOAuthReauthNotifiedEpoch = xaiRec.reauthNotifiedEpoch,
        )

        // Reconcile with agent_settings.json so TG-initiated changes (via
        // `/model` and `/provider` slash commands) survive a service
        // restart. Node writes provider/authType/model directly to this
        // file; we adopt them here and mirror back to SharedPreferences so
        // the next loadConfig reads a consistent state.
        // BAT-1661 v2.7 §2 (D7.3): in the boot transaction, reconcile against the files' selection.
        val base = if (bootFiles) bootSelection(context.filesDir.toPath(), fromPrefs) else fromPrefs
        val reconciledRaw = reconcileWithAgentSettings(context, p, base, selTx, approved, pending)
        // BAT-1661 v2.7 §2 (D7.3, strict): in the boot, [bootSelection] is the authority for the
        // selection. Reconcile must not replace provider or auth with a foreign overlay's (Node's own
        // dispatch ignores it), and the overlay contributes only its model, and only when it applies,
        // which bootSelection has already taken through NodeDispatch.
        val merged = if (bootFiles) {
            reconciledRaw.copy(provider = base.provider, authType = base.authType, model = base.model)
        } else {
            reconciledRaw
        }
        // BAT-1661 (contract v2.8 §2, D7.3): a boot that carries a repair target publishes the
        // files' selection — the intent's (provider, authType), which the classifier proved equal to
        // runtime_state-then-prefs, and its target. So config.json and the overlay publish never take
        // a retired model from `:node`'s stale prefs cache, nor a foreign overlay's provider, which
        // Node's own dispatch ignores.
        val reconciled = if (approved != null) {
            merged.copy(provider = approved.provider, authType = approved.authType, model = approved.model)
        } else {
            merged
        }
        // BAT-1661: what the caller loaded — saveConfig compares the edited tuple to it.
        // CodeRabbit 4628273764: a record this load's own reconcile left (written, then its runtime_state
        // write failed) is as unresolved as a held one — the callers must not treat the stores as in step.
        val unresolved = held || (recordOwner && ReconcileRecord.read(context.filesDir.toPath()).let {
            it is ReconcileRecord.Read.Present || it is ReconcileRecord.Read.Unavailable
        })
        // Fold 5′ chokepoint + self-heal (Codex 90fed4d6 rule 3): after this load's selection work —
        // including any reconcile commit — a "restart to apply" notice whose selection neither prefs
        // nor runtime_state holds any more (a chat `/provider`, a repaired model) goes, in THIS
        // transaction. Never while held (fold 1: compute-only) or with a record still unresolved.
        if (recordOwner && !unresolved) RestartNotice.invalidateIfOrphaned(tx!!, context.filesDir.toPath(), p)
        return LoadOut(reconciled.copy(loadedModelTuple = ModelTuple(reconciled.provider, reconciled.authType, reconciled.model)), unresolved, resolved)
    }

    /** Always posted, never synchronous: a load may run inside a composition that reads it. */
    private fun postConfigVersionBump() {
        mainHandler.post { configVersion.intValue = configVersion.intValue + 1 }
    }

    /**
     * [tx] null: compute-only (the reconciled config is returned, nothing is committed).
     * [approved]: the boot transaction's repair target (BAT-1661), see [resolveModelForReconcile].
     * [pending]: the repair pending outside the boot transaction, decided by the caller BEFORE the
     * prefs sync could remove its evidence ([ModelRepair.pendingRepair]); null when none.
     */
    private fun reconcileWithAgentSettings(
        context: Context,
        prefs: PrefsReader,
        fromPrefs: AppConfig,
        tx: ModelSelectionLock.Tx?,
        approved: ModelRepair.ApprovedTarget?,
        pending: ModelRepair.RepairIntent?,
    ): AppConfig {
        // BAT-1409 P1-C/P1-J: lstat + no-follow read — a link here is treated as unreadable.
        // BAT-1661: kotlinx JSON (AgentSettingsFile) — org.json is a stub in JVM tests.
        val json = when (val r = AgentSettingsFile.read(context.filesDir.toPath())) {
            AgentSettingsFile.Read.Absent -> return fromPrefs
            is AgentSettingsFile.Read.Unreadable -> {
                LogCollector.append("[Config] agent_settings.json unreadable (${r.reason}) — skipping reconciliation", LogLevel.WARN)
                return fromPrefs
            }
            is AgentSettingsFile.Read.Present -> r.obj
        }

        // Non-string JSON values (numbers, booleans, nested objects) are rejected,
        // never coerced, so a corrupted or tampered agent_settings.json value is
        // never adopted into SharedPreferences.
        fun stringField(key: String): String? = AgentSettingsFile.stringField(json, key)

        val newProvider = stringField("provider")
        val newAuthType = stringField("authType")
        val newModel = stringField("model")

        // No overlay fields present — nothing to reconcile
        if (newProvider == null && newAuthType == null && newModel == null) return fromPrefs

        // Ignore unrecognized providers (defensive — don't corrupt prefs from a bad write).
        // Derive from the Providers.kt registry so adding a provider there doesn't
        // require updating this allowlist (which would silently drop TG-initiated
        // settings for the new provider until this list was updated).
        val validProviders = availableProviders.map { it.id }.toSet()
        val validProvider = newProvider?.takeIf { it in validProviders }
        // If provider is present but invalid, reject the WHOLE overlay — don't adopt
        // authType/model scoped to a bogus provider either.
        if (newProvider != null && validProvider == null) {
            LogCollector.append(
                "[Config] agent_settings.json has unrecognized provider='$newProvider' — ignoring overlay",
                LogLevel.WARN
            )
            return fromPrefs
        }

        // Validate authType against the effective provider (existing or new).
        // OpenAI supports api_key|oauth; others support api_key|setup_token (Claude) or api_key.
        val effectiveProvider = validProvider ?: fromPrefs.provider
        val allowedAuthTypes = when (effectiveProvider) {
            "openai" -> setOf("api_key", "oauth")
            "xai" -> setOf("api_key", "oauth") // BAT-1124
            "claude" -> setOf("api_key", "setup_token")
            else -> setOf("api_key")
        }
        val validAuthType = newAuthType?.takeIf { it in allowedAuthTypes }
        if (newAuthType != null && validAuthType == null) {
            LogCollector.append(
                "[Config] agent_settings.json has invalid authType='$newAuthType' for provider='$effectiveProvider' — ignoring overlay",
                LogLevel.WARN
            )
            return fromPrefs
        }

        // If the overlay changes provider but omits authType, the old prefs
        // authType may not be valid for the new provider (e.g. provider=openai
        // + authType=setup_token would crash Node startup validation and
        // trigger the crash-loop protection). /provider always writes
        // authType alongside provider, so this path is only reachable via
        // a tampered/partial agent_settings.json — reject defensively.
        val providerChangingWithoutAuth =
            validProvider != null &&
            validProvider != fromPrefs.provider &&
            validAuthType == null &&
            fromPrefs.authType !in allowedAuthTypes
        if (providerChangingWithoutAuth) {
            LogCollector.append(
                "[Config] agent_settings.json changes provider to '$validProvider' but omits authType; " +
                    "current prefs authType='${fromPrefs.authType}' is not valid for the new provider — ignoring overlay",
                LogLevel.WARN
            )
            return fromPrefs
        }

        val providerChanged = validProvider != null && validProvider != fromPrefs.provider
        val authChanged = validAuthType != null && validAuthType != fromPrefs.authType
        // Decide the effective model. If the overlay supplies one, use it.
        // Otherwise, if we're switching provider, the existing prefs.model
        // is likely INVALID for the new provider (e.g. /provider openai
        // while prefs.model is 'claude-opus-4-7' → OpenAI endpoint would
        // reject the request). Validate and fall back to the new
        // provider's safe default when the old model isn't usable.
        val effectiveProviderAfter = validProvider ?: fromPrefs.provider
        val effectiveAuthAfter = validAuthType ?: fromPrefs.authType
        // Unified validation for both overlay and prefs paths: any candidate
        // model must be valid for the EFFECTIVE new provider+auth pair,
        // else substitute the provider's safe default. For freeform
        // providers (openrouter/custom), any non-blank string is "valid"
        // — the user's prior model carries forward, possibly wrong for
        // their endpoint but keeps Node alive (a /model <id> can fix it).
        // For custom specifically, defaultModelForProvider returns ''; if
        // the candidate is also blank, we return blank and Node startup
        // will exit with a clear error. In practice prefs.model is never
        // blank after a successful Setup flow, so this edge case is
        // unreachable for normal users.
        //
        // Auth changes matter too: if a provider's auth modes ever list
        // different models (the modelsByAuth mechanism), switching auth must
        // revalidate prefs.model against the new auth mode's allowlist even
        // when provider stays the same.
        val resolvedModel: String = resolveModelForReconcile(
            providerChanged = providerChanged,
            authChanged = authChanged,
            newModel = newModel,
            prefsModel = fromPrefs.model,
            effectiveProvider = effectiveProviderAfter,
            effectiveAuth = effectiveAuthAfter,
            approvedTarget = approved,
        )
        val modelChanged = resolvedModel != fromPrefs.model

        if (!providerChanged && !authChanged && !modelChanged) return fromPrefs

        // BAT-1661 (Codex re-review of 29ed3c72, #1): a model-only change while a model repair is
        // pending in this scope. Committing it would clamp away the evidence the repair decides
        // from (e.g. a valid unlisted overlay model next to a retired prefs model) before the
        // start sees it. Leave every store as it is and report the model the repair will settle
        // on. Not the boot transaction (it passes `approved`), and never a provider or auth
        // switch, which reconciles as before.
        if (approved == null && !providerChanged && !authChanged) {
            if (pending != null && pending.provider == fromPrefs.provider && pending.authType == fromPrefs.authType) {
                Log.i(TAG, "model repair pending — load leaves the stored model as it is (shows ${pending.target})")
                return fromPrefs.copy(model = pending.target)
            }
        }

        val reconciled = fromPrefs.copy(
            provider = if (providerChanged) validProvider!! else fromPrefs.provider,
            authType = if (authChanged) validAuthType!! else fromPrefs.authType,
            model = if (modelChanged) resolvedModel else fromPrefs.model,
        )
        // BAT-1661: compute-only (lock busy, read-only boot) — same result, nothing committed.
        if (tx == null) return reconciled
        tx.requireOpen()

        // BAT-1157 (D7.2): compute-only in `:node`. A `:node` commit writes its WHOLE cached prefs
        // map, which can undo a newer Settings save; MAIN persists the reconcile on its own load.
        val sp = if (ProcessRole.isNode) null else prefsForWrite(context, "reconcileWithAgentSettings")
        if (sp == null) return reconciled
        val editor = MainPrefs.edit(sp)
        if (providerChanged) editor.putString(KEY_PROVIDER, validProvider)
        if (authChanged) editor.putString(KEY_AUTH_TYPE, validAuthType)
        if (modelChanged) editor.putString(KEY_MODEL, resolvedModel)
        // CodeRabbit on ca06bb79: the stored values, as stored, for the rollback if runtime_state
        // cannot be written after this commit lands.
        val storedProvider = sp.getString(KEY_PROVIDER, null)
        val storedAuth = sp.getString(KEY_AUTH_TYPE, null)
        val storedModel = sp.getString(KEY_MODEL, null)
        val files = context.filesDir.toPath()

        // BAT-1661 v2.12 (Q16) §1: the retry record, written and confirmed BEFORE the prefs commit,
        // whenever a runtime_state write follows. It lets a later MAIN process prove where this
        // transaction stopped (ReconcileRecord.resolve) if both the runtime_state write and the
        // rollback below fail and the process exits.
        if (RuntimeStateStore.isInitialized) {
            // Fold 1: a new record only once the previous one was resolved or superseded — never
            // over an unresolved (Present or Unavailable) one. This load stays compute-only.
            when (ReconcileRecord.read(files)) {
                is ReconcileRecord.Read.Present, is ReconcileRecord.Read.Unavailable -> {
                    Log.i(TAG, "reconcile held: a model selection change is being finished")
                    return reconciled
                }
                else -> Unit
            }
            val record = ReconcileRecord.Record(
                prefsBefore = ReconcileRecord.RawTuple(storedProvider, storedAuth, storedModel),
                prefsAfter = ReconcileRecord.RawTuple(
                    if (providerChanged) validProvider else storedProvider,
                    if (authChanged) validAuthType else storedAuth,
                    if (modelChanged) resolvedModel else storedModel,
                ),
                target = ModelTuple(reconciled.provider, reconciled.authType, reconciled.model),
                runtime = when (val rt = RuntimeStateFile.read(files)) {
                    is RuntimeStateFile.Read.Present -> ReconcileRecord.RuntimeCapture(ReconcileRecord.STATE_PRESENT, rt.tuple)
                    RuntimeStateFile.Read.Missing -> ReconcileRecord.RuntimeCapture(ReconcileRecord.STATE_MISSING)
                    is RuntimeStateFile.Read.Unreadable -> ReconcileRecord.RuntimeCapture(ReconcileRecord.STATE_UNREADABLE)
                },
                overlay = ReconcileRecord.RawTuple(newProvider, newAuthType, newModel),
                overlaySelection = ModelRepair.rawSelection(json),
            )
            try {
                ReconcileRecord.write(tx, files, record)
            } catch (e: Exception) {
                // WriteNotApplied, WriteUnconfirmed (a visible but unconfirmed record is harmless:
                // prefs are still on prefsBefore) or an invalid record: no mutation at all.
                tx.markWriteFailed()
                LogCollector.append(ReconcileRecord.recordWriteFailed(e.message ?: e.javaClass.simpleName), LogLevel.ERROR)
                return reconciled
            }
        }
        // commit() not apply(): the broadcast below races the async disk
        // flush of apply(). Main process receives the broadcast → bumps
        // configVersion → Compose recomposes screens that re-read
        // prefs via loadConfig — but if the apply() write hasn't flushed
        // yet, loadConfig sees STALE values and the UI displays the OLD
        // provider/authType/model instead of the just-reconciled new
        // ones. commit() is synchronous: blocks until disk write
        // completes, so the broadcast can't outrun the data. Same
        // class of bug as 76041c1 (apply→commit before killProcess in
        // onDestroy); same fix.
        if (!MainPrefs.commitOrRestore(editor)) {
            // BAT-1661 (Codex diff review #2): false means not on disk. Flag the transaction (the
            // service start then keeps any repair intent), and stop here: no runtime_state write
            // and no broadcast for a reconcile that did not persist. This load still returns it.
            // CodeRabbit on 444ba220: commitOrRestore put the old values back in the cache.
            // v2.12: the retry record is kept — only a process that can prove the prefs state
            // (ReconcileRecord.resolve) may drop it, and this process cannot any more (D12.2).
            tx.markWriteFailed()
            LogCollector.append(
                "[Config] Reconcile: prefs commit failed — model selection not saved this time " +
                    "(provider=${reconciled.provider}, authType=${reconciled.authType}, model=${reconciled.model})",
                LogLevel.ERROR,
            )
            return reconciled
        }

        // BAT-513: keep runtime_state.json in sync with the prefs we just
        // reconciled. Without this, the legacy agent_settings.json overlay
        // path could update prefs while the new RuntimeStateStore-backed
        // file goes stale, and the next `:node` startup would read the
        // stale file via runtime-state.js and overwrite our reconciled
        // prefs back. Main process only: RuntimeStateStore.init runs only there,
        // and Telegram-originated /provider and /model write runtime_state.json
        // directly via runtime-state.js in `:node`.
        //
        // BAT-1661 v2.12 (Q16) §2: a CHECKED write (RuntimeStateStore.writeSelectionVerified), and the
        // retry record is cleared only after it is confirmed. Fold 2: only the selection fields are
        // patched on the current record — the reasoning toggles, the Custom echo override and its
        // signature are kept (saveConfig's Custom-signature reset policy applies).
        if (RuntimeStateStore.isInitialized) try {
            RuntimeStateStore.writeSelectionVerified(
                tx,
                reconciled.provider,
                // BAT-1124 H5: same (xai, oauth)+blank-token → api_key gate as saveConfig,
                // so a reconcile can't seed the boot-loop pair into runtime_state.json.
                runtimeAuthTypeFor(reconciled),
                reconciled.model,
                customSignature = { current -> customSignatureForSave(true, reconciled, current) },
            )
            // A failed clear is RECORD_CLEAR_FAILED; the reconcile still succeeded, and the next
            // resolve finds the record Completed (idempotent).
            ReconcileRecord.clearLogged(tx, files)
        } catch (e: SafeFs.WriteNotApplied) {
            // CodeRabbit on ca06bb79: prefs landed, runtime_state did not (it is unchanged). Put
            // prefs back to what they held with a REAL commit (BAT-513's saveConfig rule: prefs and
            // runtime_state move together). Even if that commit fails, the cache holds the old
            // values. Codex diff review #2 still holds: no broadcast for a reconcile that did not land.
            // v2.12: the retry record is KEPT; the next resolve proves which state prefs are in.
            tx.markWriteFailed()
            // A BLIND write of the stored values, safe only because provider / auth_type / model
            // are written solely under ModelSelectionLock, which `tx` holds: no other writer can
            // have changed them since they were read above. If an unlocked writer of these keys
            // is ever added, this needs commitOrRestore's per-key compare (restore a key only
            // while the cache still holds this reconcile's value).
            val back = sp.edit()
            fun restore(key: String, v: String?) { if (v == null) back.remove(key) else back.putString(key, v) }
            if (providerChanged) restore(KEY_PROVIDER, storedProvider)
            if (authChanged) restore(KEY_AUTH_TYPE, storedAuth)
            if (modelChanged) restore(KEY_MODEL, storedModel)
            val rolledBack = back.commit()
            LogCollector.append(
                "[Config] Reconcile: runtime_state.json not saved — model selection rolled back, " +
                    "retried on the next load (commit_ok=$rolledBack)",
                LogLevel.WARN,
            )
            return fromPrefs
        } catch (e: SafeFs.WriteUnconfirmed) {
            // v2.12 §2: the new bytes are already visible (and broadcast), so MAIN's collector will
            // see the change in runtime_state. A rollback would leave prefs on the old selection
            // next to a visible new one: the split again. No rollback; the record is kept, and the
            // next resolve confirms runtime_state with a rewrite, or recovers it after a power loss.
            tx.markWriteFailed()
            LogCollector.append(ReconcileRecord.RUNTIME_UNCONFIRMED, LogLevel.WARN)
            return reconciled
        } catch (e: Exception) {
            // v2.12 fold 4: an exception after the prefs commit (a validation or write failure) is
            // Failed — the record is KEPT, never deleted because of an exception class. Prefs hold
            // the change; the next resolve recovers runtime_state, or holds the automatic writers.
            tx.markWriteFailed()
            LogCollector.append(
                "[Config] Reconcile produced invalid RuntimeState — runtime_state.json " +
                    "left untouched (prefs still updated): ${e.message}",
                LogLevel.WARN,
            )
            return reconciled
        }

        // Bump same-process configVersion so any in-process UI observer
        // recomposes. /provider Telegram → :node service-start reconcile
        // is the canonical path here, where :node's ConfigManager.
        // configVersion bumps but main-process UI needs the broadcast
        // below to know. BAT-1661: after runtime_state landed too.
        bumpConfigVersionOnMain()
        broadcastConfigChanged(context)

        LogCollector.append(
            "[Config] Reconciled from agent_settings.json: " +
                "provider=${if (providerChanged) "$validProvider (was ${fromPrefs.provider})" else fromPrefs.provider}, " +
                "authType=${if (authChanged) "$validAuthType (was ${fromPrefs.authType})" else fromPrefs.authType}, " +
                "model=${if (modelChanged) "$resolvedModel (was ${fromPrefs.model})" else fromPrefs.model}"
        )
        return reconciled
    }

    /**
     * Decide the effective model during agent-settings reconciliation.
     * Extracted from [reconcileWithAgentSettings] so the decision table is
     * unit-testable without a Context (ConfigManagerModelReconcileTest).
     *
     * Branch 1 (BAT-1032): overlay model equals prefs with provider/auth
     * unchanged — the steady state, not a change to reconcile. saveConfig()
     * writes prefs and the agent_settings.json overlay together, so equality
     * means the value IS what the Settings UI deliberately saved — including
     * custom model IDs intentionally absent from the registry allowlist
     * (custom-model picker entry, or a model later dropped from the registry
     * that an existing user still runs). Validating here would "validate
     * away" the user's choice: the allowlist clamp silently reverted custom
     * models to the provider default on every loadConfig.
     *
     * Branches 2-3 keep the defensive clamps: a genuine external change
     * (overlay != prefs, e.g. Node-written /model values or tampered files)
     * is validated against the effective provider+auth, and a provider/auth
     * switch revalidates prefs.model against the NEW pair (e.g. an auth
     * switch must clamp a model the new auth mode doesn't list).
     *
     * Branch 0 (BAT-1661, contract v2.4 §2): inside the service-start repair
     * transaction, an overlay model equal to the transaction's [approvedTarget]
     * is adopted when the scope still matches. That is a decision record, not a
     * validation result: the repair may keep a valid model no longer listed
     * (prefs on a retired id, overlay on a dropped-but-working one), which
     * branch 2 would otherwise clamp to the default. Outside the transaction
     * [approvedTarget] is null and nothing changes.
     */
    @VisibleForTesting
    internal fun resolveModelForReconcile(
        providerChanged: Boolean,
        authChanged: Boolean,
        newModel: String?,
        prefsModel: String,
        effectiveProvider: String,
        effectiveAuth: String,
        approvedTarget: ModelRepair.ApprovedTarget? = null,
    ): String {
        if (approvedTarget != null &&
            newModel == approvedTarget.model &&
            effectiveProvider == approvedTarget.provider &&
            effectiveAuth == approvedTarget.authType
        ) {
            return approvedTarget.model
        }
        // stringField() trims the overlay value, so the prefs side must be
        // trimmed too or a legacy padded prefs value (e.g. an untrimmed
        // claim import) would miss the equality gate and fall into the
        // clamp — reintroducing the exact bug this gate fixes. Returning
        // the trimmed value lets prefs self-normalize on the next write.
        val prefsTrimmed = prefsModel.trim()
        // Validate-or-clamp: keep the candidate when the registry lists it
        // for the effective pair, else substitute the provider default
        // (keep the candidate when the provider has no default — custom).
        fun clampToProviderList(candidate: String): String =
            if (isModelValidForProvider(effectiveProvider, effectiveAuth, candidate)) {
                candidate
            } else {
                defaultModelForProvider(effectiveProvider, effectiveAuth).ifBlank { candidate }
            }
        return when {
            !providerChanged && !authChanged && newModel == prefsTrimmed -> prefsTrimmed
            // Overlay model present and differs from prefs — external change
            // (Node /model, tampered file): validate against the effective pair.
            newModel != null -> clampToProviderList(newModel)
            // No overlay model but provider or auth changed — revalidate
            // prefs.model against the NEW effective provider+auth.
            providerChanged || authChanged -> clampToProviderList(prefsTrimmed)
            // Steady state, nothing to reconcile — return the trimmed value
            // for consistency (self-normalizes a padded prefs entry).
            else -> prefsTrimmed
        }
    }

    /**
     * Check whether a given model ID is valid for a provider+auth pair.
     *
     * For Claude/OpenAI, the allowlist from Providers.kt applies strictly.
     * For OpenRouter/custom, any non-blank string is accepted (both
     * providers are freeform — the user types the upstream model ID).
     * Blank always returns false.
     *
     * Trims modelId before blank-check and allowlist comparison. The
     * Settings UI and Node's overlay resolver both trim on read/write
     * (see ProviderConfigScreen.persistCustomModelAndClose and
     * config.js:resolveActiveModel), so a legacy prefs value with
     * surrounding whitespace would otherwise be incorrectly rejected
     * during reconciliation and silently overwritten with the provider
     * default.
     */
    private fun isModelValidForProvider(
        providerId: String,
        authType: String,
        modelId: String,
    ): Boolean {
        val trimmed = modelId.trim()
        if (trimmed.isBlank()) return false
        return when (providerId) {
            "openrouter", "custom" -> true
            else -> {
                val list = try {
                    modelsForProvider(providerId, authType)
                } catch (_: Exception) { emptyList() }
                list.any { it.id == trimmed }
            }
        }
    }

    // BAT-1000: derive the Solana RPC URL to use for live wallet reads
    // (SolanaBalanceFetcher today; future Settings-side RPC consumers later).
    // Reads the heliusApiKey on each call via the narrow
    // `loadHeliusApiKeyOnly()` helper (NOT `loadConfig()` — see Copilot R1
    // hot-path note on that helper for why). A Settings UI edit takes effect
    // immediately without restarting the service — mirrors the Node-side
    // `getSolanaRpcUrl()` hot-reload pattern in `solana.js`. Returns the
    // public mainnet-beta RPC when no key is configured (preserves prior
    // behavior).
    //
    // The Helius URL form (`https://mainnet.helius-rpc.com/?api-key=…`) puts
    // the secret in the query string — callers MUST NOT log the returned
    // string. UI text + redaction at the log layer (per BAT-1000 Codex #4
    // security gate) treat any string containing `?api-key=` as sensitive.
    fun getSolanaRpcUrl(context: Context): String {
        // BAT-1000 Copilot R1 #3348057902: avoid `loadConfig(context)` here.
        // `loadConfig` decrypts the ENTIRE AppConfig (anthropic, openai,
        // openrouter, custom, jupiter, brave, perplexity, exa, tavily,
        // firecrawl, discord, oauth tokens, MCP servers, env vars, etc.)
        // just to read one field. Since this method is invoked via
        // `SolanaBalanceFetcher.rpcUrlProvider()` on every JSON-RPC call,
        // a steady balance-refresh stream would otherwise trigger a full
        // multi-secret decrypt + AppConfig materialization on every tick.
        //
        // Narrow read: only decrypt KEY_HELIUS_API_KEY_ENC. Same trim +
        // build-or-fallback logic as the full-config path. Falls back to
        // public RPC if SharedPreferences is unreachable, the key is
        // absent, or decryption throws — preserves the
        // never-throw-from-getSolanaRpcUrl contract.
        return buildSolanaRpcUrl(loadHeliusApiKeyOnly(context))
    }

    /**
     * Narrow secret read: decrypts ONLY the Helius API key from
     * SharedPreferences. Returns an empty string for "not set", "absent",
     * or "decrypt failure" — caller treats all three as fallback-to-public.
     *
     * Kept private so it doesn't become a generic public-secret API; this
     * is specifically the hot-path read for [getSolanaRpcUrl] which is
     * called per RPC tick by `SolanaBalanceFetcher.rpcUrlProvider`. If
     * other hot-path callers appear, expose a similar narrow read for
     * each — do NOT route them through [loadConfig].
     */
    private fun loadHeliusApiKeyOnly(context: Context): String {
        return try {
            val p = prefs(context)
            val enc = p.getString(KEY_HELIUS_API_KEY_ENC, null) ?: return ""
            KeystoreHelper.decrypt(Base64.decode(enc, Base64.NO_WRAP))
        } catch (e: Exception) {
            // BAT-1000 Copilot R2 #3348125003: log at most ONCE per process
            // for decrypt failures. This is a per-RPC hot path; a corrupted
            // keystore would otherwise spam logcat (one line per balance
            // refresh tick). The first log captures the failure class for
            // diagnosis; subsequent calls silently fall back to public RPC.
            if (heliusDecryptFailureLogged.compareAndSet(false, true)) {
                Log.w(TAG, "loadHeliusApiKeyOnly decrypt failed (logged once per process): ${e.javaClass.simpleName}")
            }
            ""
        }
    }

    // BAT-1000 R2 #3348125003: gate the decrypt-failure log to once per
    // process to avoid logcat spam on the per-RPC hot path.
    private val heliusDecryptFailureLogged = java.util.concurrent.atomic.AtomicBoolean(false)

    /**
     * Pure URL-builder for the Solana RPC. Returns the Helius URL if
     * [heliusApiKey] is non-blank after trimming, otherwise the public
     * mainnet-beta fallback. Extracted from [getSolanaRpcUrl] so it is
     * trivially testable without an Android Context.
     *
     * @param heliusApiKey may be null, empty, or whitespace-only — all
     *   treated equivalently (fall back to public RPC).
     */
    internal fun buildSolanaRpcUrl(heliusApiKey: String?): String {
        val key = heliusApiKey?.trim().orEmpty()
        if (key.isEmpty()) return PUBLIC_SOLANA_RPC_URL
        return "https://mainnet.helius-rpc.com/?api-key=" +
            URLEncoder.encode(key, Charsets.UTF_8.name())
    }

    fun getAutoStartOnBoot(context: Context): Boolean =
        prefs(context).getBoolean(KEY_AUTO_START, true)

    fun setAutoStartOnBoot(context: Context, enabled: Boolean) {
        prefsForWrite(context, "setAutoStart")?.edit()?.putBoolean(KEY_AUTO_START, enabled)?.commit()
    }

    fun getKeepScreenOn(context: Context): Boolean =
        prefs(context).getBoolean(KEY_KEEP_SCREEN_ON, false)

    fun setKeepScreenOn(context: Context, enabled: Boolean) {
        prefsForWrite(context, "setKeepScreenOn")?.edit()?.putBoolean(KEY_KEEP_SCREEN_ON, enabled)?.commit()
    }

    // ---------------------------------------------------------------- BAT-1157: OpenAI sign-in

    /** The OpenAI sign-in pair as one load sees it (a single store read, or the legacy pair). */
    private data class OpenAIOAuthRead(
        val access: String = "",
        val refresh: String = "",
        val email: String = "",
        val expiresAt: String = "",
        val familyId: String? = null,
        val epoch: Long = 0L,
    )

    private val openaiUnreadableLogged = java.util.concurrent.atomic.AtomicBoolean(false)
    private val openaiMigrationWarned = java.util.concurrent.atomic.AtomicBoolean(false)

    @Volatile
    private var openaiLegacySwept = false

    /** Back-off for a sweep whose confirmation or commit failed (each attempt rewrites two files). */
    @Volatile
    private var openaiSweepNotBefore = 0L

    private val OPENAI_LEGACY_KEYS = listOf(
        KEY_OPENAI_OAUTH_TOKEN_ENC,
        KEY_OPENAI_OAUTH_REFRESH_ENC,
        KEY_OPENAI_OAUTH_EMAIL_ENC,
        KEY_OPENAI_OAUTH_EXPIRES_AT,
        "openai_oauth_email", // legacy plaintext email
    )

    /** The legacy prefs pair, as stored: ciphertext copied verbatim, never decrypted here. */
    private fun legacyOpenAIPair(p: PrefsReader): OpenAIOAuthTokenStore.LegacyPair? {
        val access = p.getString(KEY_OPENAI_OAUTH_TOKEN_ENC, "") ?: ""
        val plainEmail = p.getString("openai_oauth_email", "") ?: ""
        if (access.isBlank() && plainEmail.isBlank() && !p.contains(KEY_OPENAI_OAUTH_EMAIL_ENC)) return null
        return OpenAIOAuthTokenStore.LegacyPair(
            accessEnc = access,
            refreshEnc = p.getString(KEY_OPENAI_OAUTH_REFRESH_ENC, "") ?: "",
            emailEnc = p.getString(KEY_OPENAI_OAUTH_EMAIL_ENC, "") ?: "",
            expiresAt = p.getString(KEY_OPENAI_OAUTH_EXPIRES_AT, "") ?: "",
            plainEmail = plainEmail,
        )
    }

    /** BAT-1157: the legacy pair for `/openai/oauth/confirm-family`'s legacy migration (read-only). */
    internal fun openAILegacyPair(context: Context): OpenAIOAuthTokenStore.LegacyPair? = legacyOpenAIPair(prefs(context))

    private fun logOpenAIUnreadableOnce(why: String) {
        if (openaiUnreadableLogged.compareAndSet(false, true)) {
            LogCollector.append("[Config] OpenAI sign-in record unreadable — sign in again ($why)", LogLevel.ERROR)
        }
    }

    /**
     * BAT-1157 (contract v2 §1–§2): the OpenAI pair for one config load.
     * 1. Fill-only migration from the legacy keys, in either process (checked writes).
     * 2. In MAIN only, once the store and marker are proven durable, the legacy keys are swept.
     * 3. One store read: Present → the pair (or nothing for a tombstone / undecryptable record);
     *    Unreadable → nothing (signed out, ERROR once); Absent with no marker → the legacy pair,
     *    read-only, so a failed migration never looks like a sign-out; Absent with a marker → nothing.
     */
    private fun readOpenAIOAuth(context: Context, p: PrefsReader): OpenAIOAuthRead {
        if (!OpenAIOAuthTokenStore.isInitialized) return OpenAIOAuthRead()
        val migrated = OpenAIOAuthTokenStore.migrateIfNeeded { legacyOpenAIPair(p) }
        if (migrated == OpenAIOAuthTokenStore.MigrateOutcome.DONE && !ProcessRole.isNode) {
            sweepLegacyOpenAIOAuthKeysIfConfirmed(context, p)
        }
        return resolveOpenAIOAuth(p, quiet = false)
    }

    /**
     * BAT-1661 (CodeRabbit on aefe5f82): Node can use an OpenAI sign-in — the SAME resolution the
     * load emits to config.json ([resolveOpenAIOAuth], #466's legacy-pair fallback included, and only
     * for an absent record with no marker), read-only: no migration, no sweep, no log. For the
     * display projection; call off the main thread (it decrypts).
     */
    internal fun openAIOAuthUsableReadOnly(p: PrefsReader): Boolean =
        OpenAIOAuthTokenStore.isInitialized && nodeUsesSecret(resolveOpenAIOAuth(p, quiet = true).access)

    /**
     * The OpenAI sign-in as config.json carries it, from the store as it is now. The legacy pair is
     * used only while the record is Absent AND no migration marker exists, so a sign-out (tombstone)
     * or a completed migration can never bring an old pair back. [quiet]: no logs (display reads).
     */
    private fun resolveOpenAIOAuth(p: PrefsReader, quiet: Boolean): OpenAIOAuthRead {
        return when (val st = OpenAIOAuthTokenStore.snapshot()) {
            is OpenAIOAuthTokenStore.State.Present -> {
                val r = st.record
                if (r.tombstone) return OpenAIOAuthRead()
                val live = OpenAIOAuthTokenStore.livePair(st)
                if (live == null) {
                    if (!quiet) logOpenAIUnreadableOnce("decrypt failed")
                    OpenAIOAuthRead()
                } else {
                    OpenAIOAuthRead(live.access, live.refresh, live.email, r.expiresAt, r.familyId, r.epoch)
                }
            }
            is OpenAIOAuthTokenStore.State.Unreadable -> {
                if (!quiet) logOpenAIUnreadableOnce(st.reason)
                OpenAIOAuthRead()
            }
            OpenAIOAuthTokenStore.State.Absent -> {
                if (OpenAIOAuthTokenStore.markerExists()) return OpenAIOAuthRead()
                val legacy = legacyOpenAIPair(p) ?: return OpenAIOAuthRead()
                val access = OpenAIOAuthTokenStore.open(legacy.accessEnc).orEmpty()
                if (access.isBlank()) return OpenAIOAuthRead()
                if (!quiet && openaiMigrationWarned.compareAndSet(false, true)) {
                    LogCollector.append(
                        "[Config] OpenAI sign-in migration failed — using the saved pair, will retry",
                        LogLevel.WARN,
                    )
                }
                OpenAIOAuthRead(
                    access = access,
                    refresh = OpenAIOAuthTokenStore.open(legacy.refreshEnc).orEmpty(),
                    email = OpenAIOAuthTokenStore.open(legacy.emailEnc)?.ifBlank { null } ?: legacy.plainEmail,
                    expiresAt = legacy.expiresAt,
                    familyId = null,
                    epoch = 0L,
                )
            }
        }
    }

    /**
     * MAIN only. Removes the legacy OpenAI keys once the store and the marker are proven durable
     * IN THIS PROCESS (a fresh checked rewrite of each): a marker left visible by a failed sync is
     * never permission to drop the only other copy. Checks the `commit()` result; on failure the
     * keys stay pending and a later load retries ([commitLegacySweep]).
     */
    internal fun sweepLegacyOpenAIOAuthKeysIfConfirmed(context: Context, p: PrefsReader) {
        if (openaiLegacySwept) return
        val pending = OPENAI_LEGACY_KEYS.any { it in legacySweepPending }
        if (!pending && OPENAI_LEGACY_KEYS.none { p.contains(it) }) {
            openaiLegacySwept = true
            return
        }
        if (System.currentTimeMillis() < openaiSweepNotBefore) return
        // A pending retry was confirmed by this process already; its cache has dropped the keys.
        if (!pending) {
            val legacyAccess = !(p.getString(KEY_OPENAI_OAUTH_TOKEN_ENC, "") ?: "").isBlank()
            when (OpenAIOAuthTokenStore.confirmedForSweep(legacyAccess)) {
                SweepGate.CONFIRMED -> Unit
                SweepGate.NOT_CONFIRMED -> {
                    openaiSweepNotBefore = System.currentTimeMillis() + 60_000L
                    return
                }
                SweepGate.KEEP_LEGACY -> {
                    openaiLegacySwept = true // never sweep it, never refill from it
                    LogCollector.append(
                        "[Config] OpenAI sign-in record missing after migration — legacy copy kept, sign in again",
                        LogLevel.WARN,
                    )
                    return
                }
            }
        }
        if (commitLegacySweep(context, "sweepLegacyOpenAIOAuthKeys", OPENAI_LEGACY_KEYS)) {
            openaiLegacySwept = true
        } else {
            openaiSweepNotBefore = System.currentTimeMillis() + 60_000L
            LogCollector.append("[Config] OpenAI legacy sign-in keys not removed (commit=false) — will retry", LogLevel.WARN)
        }
    }

    /**
     * Keys a MAIN sweep removed whose checked `commit()` has not yet succeeded (Codex #2). Android
     * drops removed keys from the process's cache BEFORE writing the file, so after a failed commit
     * `contains()` already says they are gone while the file still holds them. Cleared by a
     * successful commit; lost on a process restart, where a cold read sees the keys again.
     */
    private val legacySweepPending: MutableSet<String> = java.util.concurrent.ConcurrentHashMap.newKeySet()

    /**
     * MAIN only: removes [keys] with a checked commit. A retry after a failed commit removes keys
     * the cache no longer has, so it changes nothing by itself. AOSP's `SharedPreferencesImpl`
     * still writes then (its disk generation lags after the failed write), but that is an
     * implementation detail, not API; the counter bump makes every sweep commit a real change,
     * so the retry writes the whole map on any implementation. Defence in depth.
     */
    internal fun commitLegacySweep(context: Context, site: String, keys: List<String>): Boolean {
        val sp = prefsForWrite(context, site) ?: return false
        val editor = sp.edit()
        keys.forEach { editor.remove(it) }
        editor.putLong(KEY_LEGACY_SWEEP_SEQ, sp.getLong(KEY_LEGACY_SWEEP_SEQ, 0L) + 1L)
        return if (editor.commit()) {
            legacySweepPending.removeAll(keys.toSet())
            true
        } else {
            legacySweepPending.addAll(keys)
            false
        }
    }

    /** Test seam: is a sweep of [key] waiting for a successful commit? */
    internal fun legacySweepPendingForTest(key: String): Boolean = key in legacySweepPending

    /** Test seam: a fresh process's sweep state (no back-off, nothing pending, not yet swept). */
    internal fun resetLegacySweepForTest() {
        openaiLegacySwept = false
        openaiSweepNotBefore = 0L
        legacySweepPending.clear()
    }

    /** Test seam: lets a test retry within the 60 s back-off, as a later load would. */
    internal fun skipLegacySweepBackoffForTest() {
        openaiSweepNotBefore = 0L
    }

    /**
     * BAT-1157: MAIN sign-in result for the OAuth flows. A new family in the store; nothing is
     * inherited from the previous record. The caller runs it inside [ResetGate.commit].
     */
    fun signInOpenAI(context: Context, accessToken: String, refreshToken: String, email: String, expiresAt: String): Boolean {
        val r = OpenAIOAuthTokenStore.signIn(accessToken, refreshToken, email, expiresAt)
        if (r is OpenAIOAuthTokenStore.Result.Ok) {
            rearmOpenAILegacySweep()
            sweepLegacyOpenAIOAuthKeysIfConfirmed(context, prefs(context))
            RuntimeStateStore.refreshDisplay() // the transport, and so the shown model, may change
            bumpConfigVersionOnMain()
            return true
        }
        LogCollector.append("[Config] OpenAI sign-in could not be saved (${r.javaClass.simpleName})", LogLevel.ERROR)
        return false
    }

    /**
     * BAT-1157: MAIN sign-out. A checked tombstone (and the marker, if it was missing), then the
     * legacy keys are swept. Returns false when the tombstone is not confirmed: the UI must not
     * report "signed out" over a pair that could come back.
     */
    fun signOutOpenAI(context: Context): Boolean {
        val r = OpenAIOAuthTokenStore.signOut()
        if (r !is OpenAIOAuthTokenStore.Result.Ok) {
            LogCollector.append("[Config] OpenAI sign-out could not be saved (${r.javaClass.simpleName})", LogLevel.ERROR)
            return false
        }
        rearmOpenAILegacySweep()
        sweepLegacyOpenAIOAuthKeysIfConfirmed(context, prefs(context))
        RuntimeStateStore.refreshDisplay() // the transport, and so the shown model, may change
        bumpConfigVersionOnMain()
        return true
    }

    /**
     * A sign-in or sign-out just wrote the store, so an earlier "nothing to sweep" or KEEP_LEGACY
     * verdict in this process is stale: the store is Present now and any legacy copy (possibly a
     * credential the user just revoked) must go now, not at the next app start.
     */
    private fun rearmOpenAILegacySweep() {
        openaiLegacySwept = false
        openaiSweepNotBefore = 0L
    }

    /** The xAI sign-in as a load (and the boot) sees it; see [xaiSignInView]. */
    internal class XaiSignInView(val token: String, val refresh: String, val effectiveReauth: Boolean)

    /**
     * BAT-1155 amendment 3 / Codex major-1, shared by [loadConfigUnchecked] and the runtime_state
     * seed ([runtimeAuthTypeForStored], BAT-1661) so both apply ONE H5 decision.
     */
    internal fun xaiSignInView(xaiRec: com.seekerclaw.app.state.XaiOAuthTokens): XaiSignInView {
        // An armed rotation marker means a refresh POST for this epoch was in flight when the
        // prior process died → the on-disk refresh token is POTENTIALLY CONSUMED. Never hand it to
        // the provider — treat the family as dead (blank + reauthRequired) so :node boots INTO
        // reconnect. SeekerClawService.reconcileXaiOAuthOnBoot durably converts this to reauth;
        // this belt covers a conversion that could not persist.
        val rotationUnsafe = !xaiRec.tombstone && xaiRec.rotationInFlightEpoch == xaiRec.epoch
        val deadByFlag = xaiRec.tombstone || xaiRec.reauthRequired || rotationUnsafe
        // Decrypt the required token fields; null = a NON-blank ciphertext failed to
        // decrypt (Codex major-1). A decrypt failure makes the family effectively dead —
        // fail closed to reauth (blank tokens + reauthRequired) so it boots INTO reconnect,
        // never downgrades to api_key on a "" that merely looks like an absent token.
        val accessDec = if (deadByFlag) "" else decryptXaiCiphertext(xaiRec.accessTokenEnc)
        val refreshDec = if (deadByFlag) "" else decryptXaiCiphertext(xaiRec.refreshTokenEnc)
        val decryptFailed = accessDec == null || refreshDec == null
        val dead = deadByFlag || decryptFailed
        return XaiSignInView(
            token = if (dead) "" else (accessDec ?: ""),
            refresh = if (dead) "" else (refreshDec ?: ""),
            effectiveReauth = xaiRec.reauthRequired || rotationUnsafe || decryptFailed,
        )
    }

    /**
     * Test seam: opens an xAI ciphertext without the Keystore (JVM tests). Production NEVER assigns it
     * (ModelSelectionSourceGuardTest pins that no main source does); it stays null.
     */
    @Volatile internal var xaiCiphertextOpenerForTest: ((String) -> String)? = null

    /**
     * BAT-1155: decrypt a stored xAI OAuth ciphertext (a base64 Keystore blob from [XaiOAuthTokenStore]). Returns the plaintext, `""` for a
     * BLANK ciphertext (a legitimately absent field), or `null` when a NON-blank
     * ciphertext FAILS to decrypt (corruption / Keystore key change). Codex major-1:
     * the caller MUST distinguish these — a decrypt failure of a required token is
     * NOT the same as an absent token, and must fail closed to reauth rather than
     * downgrade to api_key on a `""` that looks empty. Never logs decrypted values.
     */
    private fun decryptXaiCiphertext(enc: String): String? {
        if (enc.isBlank()) return ""
        return try {
            xaiCiphertextOpenerForTest?.let { return it(enc) }
            KeystoreHelper.decrypt(Base64.decode(enc, Base64.NO_WRAP))
        } catch (e: Exception) {
            Log.w(TAG, "Failed to decrypt xAI OAuth field", e)
            LogCollector.append(
                "[Config] Failed to decrypt xAI OAuth field: ${e.javaClass.simpleName}",
                LogLevel.ERROR,
            )
            null
        }
    }

    /**
     * BAT-1155 §4 — one-time adoption of the legacy `seekerclaw_prefs` xAI
     * OAuth keys into [XaiOAuthTokenStore]. Runs BEFORE the first config emit
     * in BOTH the MAIN and `:node` processes (called from [loadConfigUnchecked]
     * and [emitConfigJson]). Idempotent + cheap once the process-local latch
     * is set.
     *
     * MARKER-ONLY gate (Codex blocker 1): keyed on the mere existence of
     * `files/xai_oauth.migrated`, NEVER on a token-presence heuristic (which
     * would resurrect a signed-out family from stale legacy prefs) and never
     * on the store file's presence.
     *  - marker ABSENT → under the store's sidecar lock, read the legacy
     *    base64 CIPHERTEXT verbatim (NEVER decrypt), fill-only into the store
     *    via [XaiOAuthTokenStore.migrateIfEmpty], verify Ok, THEN atomically
     *    create the marker, THEN drop the legacy prefs keys from this process.
     *  - marker PRESENT → the store (incl. a sign-out tombstone) is the sole
     *    source of truth forever; just sweep any legacy keys still lingering
     *    in this process's prefs view.
     *
     * Corruption fails closed inside [XaiOAuthTokenStore.read] (reauth
     * tombstone) — this path never emits a legacy token post-adoption. Never
     * logs decrypted values.
     */
    private fun migrateXaiOAuthToStoreIfNeeded(context: Context) {
        if (xaiOAuthMigrationDone) return
        // Can't adopt without the store; a later call (after init) retries.
        if (!XaiOAuthTokenStore.isInitialized) return
        val marker = File(context.filesDir, XAI_OAUTH_MIGRATED_MARKER)
        val p = prefs(context)

        // BAT-1157: lstat-based (a link at the marker path never counts as the marker).
        if (SafeFs.existsNoFollow(marker.toPath())) {
            // Already adopted (possibly by the other process). Sweep any legacy keys still in
            // prefs — MAIN only, and only once the store and marker are proven durable here.
            if (sweepLegacyXaiOAuthKeysIfConfirmed(context, p)) xaiOAuthMigrationDone = true
            return
        }

        // Ciphertext passthrough — read the base64 blobs VERBATIM; never decrypt.
        val accessEnc = p.getString(KEY_XAI_OAUTH_TOKEN_ENC, "") ?: ""
        val refreshEnc = p.getString(KEY_XAI_OAUTH_REFRESH_ENC, "") ?: ""
        val emailEnc = p.getString(KEY_XAI_OAUTH_EMAIL_ENC, "") ?: ""
        val expiresAt = p.getString(KEY_XAI_OAUTH_EXPIRES_AT, "") ?: ""

        val storeReady: Boolean = if (accessEnc.isNotBlank()) {
            // A legacy OAuth token exists — fill the store (fill-only, epoch 1).
            when (XaiOAuthTokenStore.migrateIfEmpty(accessEnc, refreshEnc, emailEnc, expiresAt)) {
                is XaiOAuthTokenStore.Result.Ok -> true
                else -> {
                    LogCollector.append(
                        "[Config] xAI OAuth store migration write failed — retry next boot (marker NOT set)",
                        LogLevel.WARN,
                    )
                    false
                }
            }
        } else {
            // No legacy OAuth token to migrate. Leave the store at its
            // fail-closed default and still adopt it (set the marker) so it
            // becomes the sole source of truth going forward.
            true
        }
        if (!storeReady) return // do NOT set the marker; retry on the next call

        // Atomically create the marker (verify-then-mark). Its existence — not
        // decoding the record — is what flips this install to store-only.
        val markerCreated = try {
            // BAT-1409 P1-J: staged in .kwrite, renamed into place, never through a link.
            // BAT-1157: checked (directory fsync + read-back), not best-effort.
            SafeFs.writeAtomicVerified(context.filesDir.toPath(), marker.toPath(), "1".toByteArray())
            true
        } catch (e: Exception) {
            // No plain-create fallback (BAT-1409 P1-J: every write goes through SafeFs); the
            // marker is retried on the next call.
            LogCollector.append(
                "[Config] xAI OAuth migration marker create failed — retry next boot: ${e.javaClass.simpleName}",
                LogLevel.WARN,
            )
            false
        }
        if (!markerCreated) return

        LogCollector.append("[Config] xAI OAuth token store adopted (marker set)", LogLevel.INFO)
        if (sweepLegacyXaiOAuthKeysIfConfirmed(context, p)) xaiOAuthMigrationDone = true
    }

    /**
     * Drop the legacy xAI OAuth prefs keys (post-adoption). BAT-1157: MAIN only — a `:node` commit
     * would write back its whole stale prefs cache — and only after the store record and the marker
     * are proven durable in this process ([XaiOAuthTokenStore.confirmedForSweep]); the `commit()`
     * result is checked. Returns true when nothing is left to sweep (in `:node`, true: the keys
     * are inert there and MAIN sweeps them).
     */
    private fun sweepLegacyXaiOAuthKeysIfConfirmed(context: Context, p: PrefsReader): Boolean {
        if (ProcessRole.isNode) return true
        val keys = listOf(KEY_XAI_OAUTH_TOKEN_ENC, KEY_XAI_OAUTH_REFRESH_ENC, KEY_XAI_OAUTH_EMAIL_ENC, KEY_XAI_OAUTH_EXPIRES_AT)
        val pending = keys.any { it in legacySweepPending }
        if (!pending && keys.none { p.contains(it) }) return true
        // A pending retry was confirmed by this process already; its cache has dropped the keys.
        if (!pending) {
            val legacyAccess = !(p.getString(KEY_XAI_OAUTH_TOKEN_ENC, "") ?: "").isBlank()
            when (XaiOAuthTokenStore.confirmedForSweep(File(context.filesDir, XAI_OAUTH_MIGRATED_MARKER), legacyAccess)) {
                SweepGate.CONFIRMED -> Unit
                SweepGate.NOT_CONFIRMED -> return false
                SweepGate.KEEP_LEGACY -> {
                    LogCollector.append(
                        "[Config] xAI sign-in record missing after migration — legacy copy kept, sign in again",
                        LogLevel.WARN,
                    )
                    return true // never sweep it, never refill from it
                }
            }
        }
        if (commitLegacySweep(context, "sweepLegacyXaiOAuthKeys", keys)) return true
        LogCollector.append("[Config] xAI legacy sign-in keys not removed (commit=false) — will retry", LogLevel.WARN)
        return false
    }

    /**
     * BAT-1661: lock bound per attempt for [syncXaiRuntimeAuthType] (its callers are on
     * Dispatchers.IO). The sign-in runs it inside ResetGate's read side, so the TOTAL wait
     * ([XAI_SYNC_ATTEMPTS] × this) stays near the earlier single 5 s bound: a Reset Config that
     * arrives meanwhile waits no longer than before.
     */
    internal const val XAI_SYNC_LOCK_TIMEOUT_MS = 1_700L

    /** BAT-1661: lock attempts for [syncXaiRuntimeAuthType] before it reports [XaiAuthSync.BUSY]. */
    internal const val XAI_SYNC_ATTEMPTS = 3

    /** What [syncXaiRuntimeAuthType] did. */
    enum class XaiAuthSync {
        /** runtime_state.json is in step (written, already right, or no record to sync). */
        SYNCED,

        /** The model-selection lock stayed busy through every attempt: nothing was written. */
        BUSY,

        /** The write failed (storage) or the sync threw: runtime_state.json may be stale. */
        NOT_SAVED,

        /**
         * BAT-1661 v2.12 (review m3): an interrupted model selection change is not finished yet (its
         * retry record holds every automatic selection write, fold 1): nothing was written.
         */
        HELD,
    }

    /**
     * BAT-1155 H5 — after a MAIN-process sign-in/sign-out writes the store,
     * re-derive the xai `runtime_state.json` authType through the same H5 gate
     * so runtime_state (which Node reads FIRST) can never disagree with
     * config.json on the xai auth mode. Preserves the exact behaviour the old
     * `persistXaiOAuthTokens` had (ConfigManager.kt H5 block). Main-process
     * only (`:node` never inits RuntimeStateStore). A failure here does not
     * invalidate the token already durably in the store.
     *
     * BAT-1661 (CodeRabbit on 444ba220): [XaiAuthSync.SYNCED] when `runtime_state.json` is in step
     * (written, already right, or there is nothing to sync). Otherwise it may still hold the old
     * xai auth mode — [XaiAuthSync.BUSY] or [XaiAuthSync.NOT_SAVED] — and the caller must NOT
     * restart `:node` as if it were (the restarted boot would take that auth mode). A busy lock is
     * retried [attempts] times, [lockTimeoutMs] each.
     * Only a record on disk is updated: with none, Node reads config.json, which [emitConfigJson]
     * gates the same way, and a record built from the launch seed could carry an old selection.
     */
    fun syncXaiRuntimeAuthType(
        context: Context,
        lockTimeoutMs: Long = XAI_SYNC_LOCK_TIMEOUT_MS,
        attempts: Int = XAI_SYNC_ATTEMPTS,
    ): XaiAuthSync {
        // BAT-1157: the store was just written, so an earlier "done" / KEEP_LEGACY verdict is stale;
        // the reload below re-runs the confirmed sweep of any legacy copy.
        xaiOAuthMigrationDone = false
        bumpConfigVersionOnMain()
        if (!RuntimeStateStore.isInitialized) return XaiAuthSync.SYNCED
        var busyReason = ""
        var held = false
        var owned: ReconcileRecord.Outcome? = null
        repeat(attempts.coerceAtLeast(1)) {
            val r = try {
                // BAT-1661: a runtime_state write, so it runs under the model-selection lock. Both
                // callers are on Dispatchers.IO, so it waits longer than a UI save.
                ModelSelectionLock.transaction(lockTimeoutMs) { tx ->
                    val out = loadConfigOut(context, tx, null, bootFiles = false, onResolved = { owned = it })
                    val reloaded = out.config
                    // BAT-1661 v2.12 fold 1 (CodeRabbit 4628273773/4628273764): an unresolved reconcile
                    // retry record — held at the start, or left by this load's own reconcile — holds
                    // every automatic runtime selection write, this one included. Checked BEFORE any
                    // success return: the loaded (projected) provider proves nothing about the file.
                    if (out.held) {
                        LogCollector.append(ReconcileRecord.XAI_SYNC_HELD, LogLevel.WARN)
                        held = true
                        return@transaction false
                    }
                    // Whether an auth sync is needed is decided by runtime_state.json ON DISK (what Node
                    // reads first): only an xai record there carries an xai auth mode to keep in step.
                    val onDisk = (RuntimeStateFile.read(context.filesDir.toPath()) as? RuntimeStateFile.Read.Present)?.tuple
                    if (onDisk == null || onDisk.provider != "xai") return@transaction true
                    // The xAI selection's auth: the loaded config's when it is xai; otherwise the
                    // record's own (its H5 guard image is the OAuth selection, as for bootSelection).
                    val auth = if (reloaded.provider == "xai") {
                        runtimeAuthTypeFor(reloaded)
                    } else {
                        val selected = if (isXaiGuardImage(context.filesDir.toPath(), reloaded.provider, reloaded.authType, onDisk.provider, onDisk.authType)) "oauth" else onDisk.authType
                        runtimeAuthTypeForStored("xai", selected)
                    }
                    RuntimeStateStore.updateExisting(tx) { current ->
                        if (current.provider == "xai" && current.authType != auth) current.copy(authType = auth) else null
                    } != com.seekerclaw.app.util.CrossProcessStore.UpdateOutcome.FAILED
                }
            } catch (e: Exception) {
                // The transaction is released here: the UI re-reads a notice this load's resolve saved.
                RestartNotice.afterRelease(context.filesDir?.toPath(), owned)
                LogCollector.append("[Config] xAI OAuth runtime_state sync failed: ${e.message}", LogLevel.WARN)
                return XaiAuthSync.NOT_SAVED
            }
            when (r) {
                is ModelSelectionLock.Result.Acquired -> {
                    // v2.12 fold 5′: this sync's own resolve outcome; the UI re-reads a notice it saved,
                    // after the transaction. The sign-in keeps its own restart policy (BAT-1716).
                    RestartNotice.afterRelease(context.filesDir?.toPath(), owned)
                    if (r.value) return XaiAuthSync.SYNCED
                    if (held) return XaiAuthSync.HELD
                    LogCollector.append("[Config] xAI OAuth runtime_state sync failed: runtime_state.json not written", LogLevel.WARN)
                    return XaiAuthSync.NOT_SAVED
                }
                is ModelSelectionLock.Result.Busy -> busyReason = r.reason
            }
        }
        LogCollector.append("[Config] xAI OAuth runtime_state sync skipped: lock busy ($busyReason)", LogLevel.WARN)
        return XaiAuthSync.BUSY
    }

    /**
     * Update a single config field and persist via [saveConfig].
     *
     * Returns the persistence result from [saveConfig] — `true` on
     * full success (prefs commit + RuntimeStateStore write), `false`
     * on any failure (including when no config exists yet, or when
     * the runtime-state file write failed). Pre-BAT-513 callers that
     * ignore the return value continue to compile (Boolean values
     * are discardable in Kotlin); UI flows that touch runtime fields
     * (`provider`, `authType`, `model`) should check the return so a
     * failed save doesn't leave the UI displaying the optimistic
     * value while the cross-process file is still on the old one.
     */
    fun updateConfigField(context: Context, field: String, value: String): Boolean {
        val config = loadConfig(context) ?: return false
        val updated = when (field) {
            "anthropicApiKey" -> config.copy(anthropicApiKey = value)
            "setupToken" -> config.copy(setupToken = value)
            "telegramBotToken" -> config.copy(telegramBotToken = value)
            "telegramOwnerId" -> {
                saveOwnerIdToFile(context, value, "telegram")
                config.copy(telegramOwnerId = value)
            }
            "model" -> config.copy(model = value)
            "agentName" -> config.copy(agentName = value)
            "authType" -> config.copy(authType = value)
            "braveApiKey" -> config.copy(braveApiKey = value)
            "searchProvider" -> config.copy(searchProvider = value)
            "perplexityApiKey" -> config.copy(perplexityApiKey = value)
            "exaApiKey" -> config.copy(exaApiKey = value)
            "tavilyApiKey" -> config.copy(tavilyApiKey = value)
            "firecrawlApiKey" -> config.copy(firecrawlApiKey = value)
            "jupiterApiKey" -> config.copy(jupiterApiKey = value)
            "heliusApiKey" -> config.copy(heliusApiKey = value)
            "heartbeatIntervalMinutes" -> config.copy(
                heartbeatIntervalMinutes = value.toIntOrNull()?.coerceIn(5, 120) ?: 30
            )
            "maxStepsPerTurn" -> config.copy(
                maxStepsPerTurn = value.toIntOrNull()?.coerceIn(10, 100) ?: 35
            )
            "richMessages" -> config.copy(richMessages = value.toBoolean())
            "provider" -> config.copy(provider = value)
            "openaiApiKey" -> config.copy(openaiApiKey = value)
            "openrouterApiKey" -> config.copy(openrouterApiKey = value)
            "openrouterFallbackModel" -> config.copy(openrouterFallbackModel = value)
            "openrouterModelContext" -> config.copy(openrouterModelContext = value)
            "openrouterFallbackContext" -> config.copy(openrouterFallbackContext = value)
            "customApiKey" -> config.copy(customApiKey = value)
            "customBaseUrl" -> config.copy(customBaseUrl = value)
            "customHeaders" -> config.copy(customHeaders = value)
            "customFormat" -> config.copy(customFormat = value)
            "channel" -> config.copy(channel = value)
            "discordBotToken" -> config.copy(discordBotToken = value)
            "discordOwnerId" -> {
                saveOwnerIdToFile(context, value, "discord")
                config.copy(discordOwnerId = value)
            }
            // BAT-1157: the OpenAI sign-in pair is owned by OpenAIOAuthTokenStore (signIn/signOut/
            // rotate), never by a config field write.
            "xaiApiKey" -> config.copy(xaiApiKey = value)
            // BAT-1155: the xAI OAuth triple is owned by XaiOAuthTokenStore
            // (sign-in / rotation / sign-out) — NOT settable via updateConfigField
            // anymore (saveConfig no longer persists these fields). The prior
            // "xaiOAuthToken/Refresh/Email/ExpiresAt" cases were removed so a
            // caller can't silently no-op a token write here.
            else -> return false
        }
        // saveConfig now syncs the agent_settings.json overlay
        // automatically (writes prefs + overlay atomically), so the
        // separate writeAgentSettingsJson call previously here is no
        // longer needed. See saveConfig for the architectural fix.
        return saveConfig(context, updated)
    }

    fun saveOwnerId(context: Context, ownerId: String): Boolean {
        val channel = prefs(context).getString(KEY_CHANNEL, "telegram") ?: "telegram"
        return saveOwnerIdForChannel(context, ownerId, channel)
    }

    fun saveOwnerIdForChannel(context: Context, ownerId: String, channel: String): Boolean {
        return saveOwnerIdToFile(context, ownerId, channel)
    }

    /**
     * BAT-1409 P1-D: the owner held in SharedPreferences for [channel], read raw (no file
     * fallback). Not an independent record — every saveConfig re-derives it from `owner_ids` — so
     * the bridge's owner-claim check only compares and logs it.
     */
    fun prefsOwnerId(context: Context, channel: String): String {
        val key = if (channel == "discord") KEY_DISCORD_OWNER_ID else KEY_OWNER_ID
        return prefs(context).getString(key, "") ?: ""
    }

    /**
     * Save owner ID to file-based IPC (cross-process safe).
     * File: workspace/owner_ids (JSON: {"telegram": "123", "discord": "456"})
     *
     * SharedPreferences has per-process caching that causes cross-process writes
     * to be silently overwritten. This file-based approach uses atomic writes
     * (.tmp + rename) — the same pattern as ServiceState.
     */
    fun saveOwnerIdToFile(context: Context, ownerId: String, channel: String): Boolean {
        try {
            val filesDir = context.filesDir
            val workspaceDir = File(filesDir, "workspace").apply { mkdirs() }
            val file = File(workspaceDir, "owner_ids")

            // Read existing data
            val existing = if (SafeFs.existsNoFollow(file.toPath())) {
                try { JSONObject(SafeFs.readTextNoFollow(filesDir.toPath(), file.toPath())) } catch (_: Exception) { JSONObject() }
            } else JSONObject()

            // Update the channel's owner ID
            existing.put(channel, ownerId)

            // BAT-1409 P1-J: atomic, never written through a link (owner_ids.tmp is no longer
            // used — the temp file lives in filesDir/.kwrite).
            SafeFs.writeAtomicText(filesDir.toPath(), file.toPath(), existing.toString())

            // Also update SharedPreferences for backward compatibility — MAIN only (BAT-1157,
            // D7.2). From `:node` (the first-message owner claim) a prefs write would put back
            // `:node`'s whole stale prefs cache; MAIN takes the owner from this file on every save.
            if (!ProcessRole.isNode) {
                val key = if (channel == "discord") KEY_DISCORD_OWNER_ID else KEY_OWNER_ID
                prefsForWrite(context, "saveOwnerIdToFile")?.edit()?.putString(key, ownerId)?.apply()
            }
            bumpConfigVersionOnMain()

            LogCollector.append("[Config] Owner ID saved to file for channel=$channel")
            return true
        } catch (e: Exception) {
            LogCollector.append("[Config] Failed to save owner ID to file: ${e.message}", LogLevel.ERROR)
            return false
        }
    }

    /**
     * Load owner ID from file-based IPC (cross-process safe).
     * Falls back to SharedPreferences if file doesn't exist (migration for existing users).
     *
     * BAT-1409 P1-C: an unreadable `owner_ids` (a link, an I/O or parse error) also falls back to
     * SharedPreferences, deliberately: treating it as "no owner" would reopen Node's first-sender
     * auto-claim. It is logged.
     */
    fun loadOwnerIdFromFile(context: Context, channel: String): String {
        val file = try {
            ownerIdFromFile(context.filesDir.toPath(), channel)
        } catch (_: Exception) {
            OwnerIdFile.Unreadable
        }
        when (val r = file) {
            // File is source of truth — return whatever is there (even empty = cleared)
            is OwnerIdFile.Found -> return r.id
            OwnerIdFile.Unreadable -> LogCollector.append(
                "[Config] owner_ids unreadable (link, I/O or parse error); using the owner from Settings",
                LogLevel.WARN,
            )
            OwnerIdFile.Absent -> Unit
        }

        // Fallback to SharedPreferences only if file doesn't exist yet (migration)
        val key = if (channel == "discord") KEY_DISCORD_OWNER_ID else KEY_OWNER_ID
        return prefs(context).getString(key, "") ?: ""
    }

    /** What `workspace/owner_ids` holds for one channel ([ownerIdFromFile]). */
    internal sealed class OwnerIdFile {
        data class Found(val id: String) : OwnerIdFile()

        /** No file, or no entry for the channel. */
        object Absent : OwnerIdFile() {
            override fun toString() = "Absent"
        }

        /** A link, a non-regular file, an I/O error or content that does not parse. */
        object Unreadable : OwnerIdFile() {
            override fun toString() = "Unreadable"
        }
    }

    /**
     * The file part of [loadOwnerIdFromFile], Context-free. [entry] is the JSON lookup (the
     * channel's value, or null when it has no entry); tests replace it because org.json is a stub
     * on the JVM.
     */
    internal fun ownerIdFromFile(
        filesRoot: Path,
        channel: String,
        entry: (json: String, channel: String) -> String? = ::ownerIdsEntry,
    ): OwnerIdFile = try {
        val file = filesRoot.resolve("workspace").resolve("owner_ids")
        // BAT-1409 P1-C/P1-J: lstat + no-follow read — a link here is never followed.
        if (!SafeFs.existsNoFollow(file)) {
            OwnerIdFile.Absent
        } else {
            val id = entry(SafeFs.readTextNoFollow(filesRoot, file), channel)
            if (id != null) OwnerIdFile.Found(id) else OwnerIdFile.Absent
        }
    } catch (_: Exception) {
        OwnerIdFile.Unreadable
    }

    private fun ownerIdsEntry(json: String, channel: String): String? {
        val o = JSONObject(json)
        return if (o.has(channel)) o.optString(channel, "") else null
    }

    /** BAT-1157: the outcome of [resetConfig]. */
    sealed class ResetResult {
        /** Both sign-ins tombstoned (confirmed), the Keystore key deleted, prefs cleared. */
        object Done : ResetResult()

        /**
         * Something visible changed but not everything. Nothing is rolled back: a sign-in that
         * was tombstoned stays signed out. The key and prefs are kept whenever a tombstone is not
         * [TombstoneOutcome.CONFIRMED]. Retrying is safe.
         */
        data class Partial(
            val openai: TombstoneOutcome,
            val xai: TombstoneOutcome,
            val keyDeleted: Boolean,
            val configCleared: Boolean,
        ) : ResetResult()

        /** Nothing visible changed (a lock timeout, or the first tombstone was not written). */
        data class Failed(val reason: String) : ResetResult()
    }

    /**
     * BAT-1157 (contract v2 §3, v3 §3): Reset Config. Blocking; call off the main thread.
     *
     * Under [ResetGate] (no sign-in can start or commit until the result is final), and holding the
     * OpenAI then the xAI store lock: tombstone OpenAI, then xAI (checked writes); delete the
     * Keystore key only if BOTH are confirmed — never over a record that could still be live.
     * Then clear prefs with a checked `commit()`. A rotation from `:node` during the reset waits
     * on a store lock and then finds a tombstone (409).
     *
     * BAT-1661 (contract v2.8 §4): inside the gate, the reset takes [ModelSelectionLock] FIRST,
     * before the OpenAI and xAI store locks (the lock order everywhere), so it never interleaves
     * with a model transaction: a `saveConfig` rollback or a collector mirror cannot write old
     * values back over a reset. A busy lock is [ResetResult.Failed] with nothing changed.
     */
    fun resetConfig(context: Context): ResetResult = ResetGate.exclusive {
        val out = when (val r = ModelSelectionLock.transaction { tx -> resetLocked(context, tx) }) {
            is ModelSelectionLock.Result.Acquired -> r.value
            is ModelSelectionLock.Result.Busy -> {
                LogCollector.append("[Config] Reset: model selection busy (${r.reason}) — nothing reset", LogLevel.WARN)
                ResetResult.Failed(RESET_MODEL_BUSY)
            }
        }
        // BAT-1661: the display's key flag after Reset (outside the model lock). A completed Reset
        // removed the key (prefs cleared, Keystore key deleted); any other outcome re-derives it from
        // what is stored. Then the projection follows.
        // CodeRabbit 4626795862: revision first for every outcome (a save after a completed Reset
        // must not be overwritten by a constant "no key" noted later).
        RuntimeStateStore.rederiveOpenAIKeyUsable { keyUsableOf(prefs(context)) }
        RuntimeStateStore.refreshDisplay()
        context.filesDir?.toPath()?.let { RestartNotice.refreshAsync(it) } // fold 5′: after release
        out
    }

    /** Reset's Keystore key deletion; a test replaces it (no AndroidKeyStore on the JVM). */
    @Volatile internal var deleteKeystoreKey: () -> Unit = { KeystoreHelper.deleteKey() }

    /** [ResetResult.Failed.reason] when the model-selection lock was busy (contract v2.8 §4). */
    const val RESET_MODEL_BUSY = "model selection busy"

    /** [resetConfig]'s body, holding the model-selection lock ([tx]). */
    private fun resetLocked(context: Context, tx: ModelSelectionLock.Tx): ResetResult {
        tx.requireOpen()
        val none = TombstoneOutcome.NOT_WRITTEN
        var openai = none
        var xai = none
        var keyDeleted = false
        val outer = OpenAIOAuthTokenStore.withLockForReset {
            openai = OpenAIOAuthTokenStore.signOutLocked()
            if (openai == none) return@withLockForReset
            val inner = XaiOAuthTokenStore.withLockForReset {
                xai = XaiOAuthTokenStore.signOutLocked()
                if (openai == TombstoneOutcome.CONFIRMED &&
                    xai == TombstoneOutcome.CONFIRMED
                ) {
                    keyDeleted = try {
                        deleteKeystoreKey()
                        true
                    } catch (e: Exception) {
                        LogCollector.append("[Config] Reset: Keystore key not deleted (${e.javaClass.simpleName})", LogLevel.ERROR)
                        false
                    }
                }
            }
            if (inner is SidecarFileLock.Outcome.NotAcquired) {
                LogCollector.append("[Config] Reset: xAI sign-in lock not acquired (${inner.reason})", LogLevel.WARN)
            }
        }
        if (outer is SidecarFileLock.Outcome.NotAcquired) {
            return ResetResult.Failed(outer.reason)
        }
        if (openai == none) return ResetResult.Failed("OpenAI sign-in not removed")
        val cleared = keyDeleted &&
            (prefsForWrite(context, "resetConfig")?.edit()?.clear()?.commit() == true) // incl. MCP servers
        // BAT-1661 v2.12 H6 (Q16): a fully cleared Reset supersedes an interrupted reconcile's retry
        // record (checked, best-effort). Outside the OpenAI and xAI store locks. A Partial or Failed
        // reset leaves prefs on the change, so the record stays for the next resolve (finding I1).
        if (cleared) ReconcileRecord.clearSuperseded(tx, context.filesDir.toPath())
        if (cleared) RestartNotice.invalidate(tx, context.filesDir.toPath()) // fold 5′
        bumpConfigVersionOnMain()
        return if (cleared) {
            ResetResult.Done
        } else {
            LogCollector.append(
                "[Config] Reset incomplete: openai=$openai xai=$xai keyDeleted=$keyDeleted configCleared=$cleared",
                LogLevel.WARN,
            )
            ResetResult.Partial(openai, xai, keyDeleted, cleared)
        }
    }

    /**
     * BAT-1124 H5 — cross-process boot-loop guard. Node reads `runtime_state.json`
     * BEFORE `config.json`, so if runtime_state advertises `(xai, oauth)` with a blank
     * token, Node loads oauth+blank and `process.exit(1)`s in a restart loop (the
     * config.json downgrade is SHADOWED because runtime_state wins). Downgrade the
     * runtime authType to `api_key` for `(xai, oauth)` with no token so runtime_state
     * never advertises an unstartable oauth pair. Applied at EVERY runtime-state write
     * site (saveConfig transform + reconcile). Once the token is present the real
     * `oauth` value is written. (OpenAI is intentionally NOT downgraded here — it keeps
     * its existing behaviour; only the xAI single-use-token path needs this gate.)
     */
    internal fun runtimeAuthTypeFor(config: AppConfig): String =
        // BAT-1155 CodeRabbit: a DEAD xAI-OAuth family (reauthRequired, token blanked) must
        // STAY oauth in runtime_state.json too — Node reads runtime_state FIRST for
        // provider/authType, so downgrading it to api_key here would split-brain against the
        // oauth config.json and stop the family booting INTO reauth. Only a FRESH
        // oauth-selected-but-never-signed-in family (blank token, NOT reauth) downgrades.
        // Matches the emitConfigJson effectiveAuthType guard.
        runtimeAuthType(config.provider, config.authType, config.xaiOAuthToken, config.xaiOAuthReauthRequired)

    /**
     * BAT-1661 (Codex Q12, 58e426b6; CodeRabbit on ab6385bd): is runtime_state's (xai, api_key) only
     * the BAT-1124 H5 boot-guard image of an xAI OAuth selection — the SAME selection — rather than
     * a user's API-key choice? The one rule for every reader that reasons about a guard image
     * ([bootSelection], the prefs mirror in RuntimeStateStore).
     *
     * A guard image unless a fresh file PROVES an explicit API-key selection. The proof is
     * agent_settings.json present with `provider` "xai" AND `authType` "api_key": every API-key
     * choice writes that file — a Settings selection (it publishes the selected auth, never the
     * guard image) and Node's `/provider xai api_key` (overlay first, then runtime_state) — while
     * no writer ever puts the guard image there. runtime_state alone proves nothing: its api_key
     * is exactly what the guard writes. Token state is NOT used: a sign-in between the guard write
     * and its sync must not turn the old guard into an "explicit" API-key choice (CodeRabbit).
     *
     * The OAuth selection itself may come from the caller's prefs OR from that same fresh file
     * explicitly on xai/oauth: `:node`'s prefs cache can still say api_key after a Settings save
     * switched to OAuth (CodeRabbit on aefe5f82). A guard image is the OAuth selection, so callers
     * keep `oauth` ([bootSelection] publishes it; the mirror keeps it).
     */
    internal fun isXaiGuardImage(
        files: java.nio.file.Path,
        selectedProvider: String,
        selectedAuth: String,
        runtimeProvider: String,
        runtimeAuth: String,
    ): Boolean {
        if (runtimeProvider != "xai" || runtimeAuth != "api_key") return false
        val ov = (AgentSettingsFile.read(files) as? AgentSettingsFile.Read.Present)?.obj
        val ovProvider = ov?.let { AgentSettingsFile.stringField(it, "provider") }
        val ovAuth = ov?.let { AgentSettingsFile.stringField(it, "authType") }
        // A fresh file that explicitly holds the API-key choice: never a guard.
        if (ovProvider == "xai" && ovAuth == "api_key") return false
        // The selection is xAI OAuth: the caller's prefs say so, OR a fresh file explicitly does
        // (CodeRabbit on aefe5f82 — `:node`'s prefs cache can predate the Settings save that
        // published xai/oauth to the overlay and the guard to runtime_state; D7.3: fresh files win).
        val oauthSelected = (selectedProvider == "xai" && selectedAuth == "oauth") ||
            (ovProvider == "xai" && ovAuth == "oauth")
        return oauthSelected
    }

    /**
     * BAT-1661 (Codex review of ca06bb79 #4): the auth the retired-model rule uses for DISPLAY —
     * Node's `_EFFECTIVE_AUTH` (config.js), from the same table ([ModelRepair.transportOf] /
     * [OpenAIAuth]). OpenAI oauth with no usable sign-in but a saved key runs on api_key; with
     * neither (reconnect-required) Node keeps `oauth`. Never written anywhere.
     */
    internal fun displayAuth(provider: String, selectedAuth: String, oauthUsable: Boolean, apiKeySaved: Boolean): String {
        val t = ModelRepair.transportOf(ModelRepair.Scope(provider, selectedAuth), oauthUsable, apiKeySaved).authType
        return if (t == ModelRepair.TRANSPORT_RECONNECT) "oauth" else t
    }

    /**
     * The stored OpenAI API key, decrypted; "" when there is none or it does not decrypt (then
     * config.json carries no key, and Node has none). [log]: report a decrypt failure (the load);
     * the display's background read stays quiet so a failure is not reported twice.
     */
    private fun decryptOpenAIKey(p: PrefsReader, log: Boolean): String = try {
        val enc = p.getString(KEY_OPENAI_API_KEY_ENC, null)
        if (enc != null) KeystoreHelper.decrypt(Base64.decode(enc, Base64.NO_WRAP)) else ""
    } catch (e: Exception) {
        if (log) {
            Log.w(TAG, "Failed to decrypt OpenAI API key", e)
            LogCollector.append("[Config] Failed to decrypt OpenAI API key: ${e.javaClass.simpleName}", LogLevel.ERROR)
        }
        ""
    }

    /**
     * BAT-1661 (Codex 7ec40d8b #1): Node can use this OpenAI API key — the decrypted key, normalised
     * the way config.js `normalizeSecret` does (line breaks removed, then trimmed; JS `trim` also
     * strips U+FEFF), is not empty. Call off the main thread (it decrypts).
     */
    internal fun openaiKeyUsable(p: PrefsReader): Boolean = nodeUsesSecret(decryptOpenAIKey(p, log = false))

    /**
     * BAT-1661 (CodeRabbit 4626795862): the key derive every flag publish uses ([openaiKeyUsable]);
     * a test replaces it (no Keystore on the JVM). Called only inside
     * [RuntimeStateStore.rederiveOpenAIKeyUsable], after its revision is taken.
     */
    @Volatile internal var keyUsableOf: (PrefsReader) -> Boolean = { openaiKeyUsable(it) }

    /** Test seam: runs in [saveConfigWith] after the model transaction, before the key derive. */
    @Volatile internal var afterSaveLockForTest: (() -> Unit)? = null

    /**
     * BAT-1661 (CodeRabbit on 3240d3c9): whether saveConfig STORES and emitConfigJson EMITS a secret
     * (the OpenAI key; the sign-in token is emitted on the same rule). Kotlin `isNotBlank`, unchanged:
     * it also treats U+001C–U+001F as blank, so such a key is dropped and never reaches config.json.
     */
    internal fun keepsSecret(v: String): Boolean = v.isNotBlank()

    /**
     * BAT-1661: Node can USE [v] — Kotlin stores and emits it ([keepsSecret]) AND it survives
     * config.js `normalizeSecret` ([isNodeUsableSecret]). The ONE predicate the display uses
     * (AppConfig.displayModel, the RuntimeStateStore key flag), so save, emit and display agree.
     */
    internal fun nodeUsesSecret(v: String): Boolean = keepsSecret(v) && isNodeUsableSecret(v)

    /**
     * config.js `normalizeSecret(v) !== ''`, exactly: `/[\r\n\u2028\u2029]+/g` removed, then
     * `String.prototype.trim` — whose set is ECMAScript WhiteSpace + LineTerminator ([isJsTrimSpace]),
     * NOT Kotlin's `isWhitespace` (which also strips U+001C–U+001F, where JS keeps them).
     */
    internal fun isNodeUsableSecret(v: String): Boolean =
        v.filterNot { it == '\r' || it == '\n' || it == '\u2028' || it == '\u2029' }
            .trim { isJsTrimSpace(it) }
            .isNotEmpty()

    /** ECMAScript WhiteSpace and LineTerminator code points (what `String.prototype.trim` strips). */
    private fun isJsTrimSpace(ch: Char): Boolean =
        ch in '\u0009'..'\u000D' || ch == '\u0020' || ch == '\u00A0' || ch == '\u1680' ||
            ch in '\u2000'..'\u200A' || ch == '\u2028' || ch == '\u2029' || ch == '\u202F' ||
            ch == '\u205F' || ch == '\u3000' || ch == '\uFEFF'

    /** The H5 rule itself (one definition for [runtimeAuthTypeFor] and [runtimeAuthTypeForStored]). */
    private fun runtimeAuthType(provider: String, authType: String, xaiToken: String, xaiReauth: Boolean): String =
        if (provider == "xai" && authType == "oauth" && xaiToken.isBlank() && !xaiReauth) "api_key" else authType

    /**
     * BAT-1661 (CodeRabbit on ca06bb79): [runtimeAuthTypeFor] for a STORED selection, with the xAI
     * sign-in read from XaiOAuthTokenStore — for writers that hold no loaded config (the
     * runtime_state seed) and for recognising the guard image in the prefs mirror. The store read
     * takes no lock, so it is safe under ModelSelectionLock. A store that is not initialised reads
     * as dead + reauth (fail closed), which keeps oauth, as the loaded config would.
     */
    internal fun runtimeAuthTypeForStored(provider: String, authType: String): String {
        if (provider != "xai" || authType != "oauth") return authType
        val v = xaiSignInView(com.seekerclaw.app.state.XaiOAuthTokenStore.read())
        return runtimeAuthType(provider, authType, v.token, v.effectiveReauth)
    }

    /**
     * Write ephemeral config.json to workspace for Node.js to read on startup.
     * Includes per-boot bridge auth token. File is deleted after Node.js reads it.
     * Uses JSONObject to prevent JSON injection via user-supplied values.
     */
    // BAT-1161 P1A gate 5: ONE shared boot ID per service process. Generated once here (this
    // ConfigManager object lives for the process lifetime), transported to Node via config.json
    // — never a packaged asset (BAT-1073). Node stamps it into the `=== SESSION boot=… ===`
    // banner; the rotation-generation identity (gate 3) keys off the same id so Node and Kotlin
    // agree on which :node boot a forwarded log line belongs to.
    @Volatile private var _bootId: String? = null
    fun currentBootId(): String = _bootId ?: synchronized(this) {
        _bootId ?: java.util.UUID.randomUUID().toString().replace("-", "").take(8).also { _bootId = it }
    }

    /**
     * Writes `workspace/config.json` for the `:node` boot from an already-loaded [config] and
     * returns the channel it wrote (BAT-1409 P1-D: the bridge's owner-claim check compares
     * against this boot channel).
     *
     * BAT-1661: called only by [ModelRepair.serviceStart], which loads [config] either inside the
     * boot transaction (reconcile committed, repair target honoured) or, on a busy lock,
     * compute-only. config.json is this boot's own ephemeral file, read only by this process's
     * Node; it is not one of the shared model-selection stores. The model is carried as loaded.
     * The xAI OAuth adoption (BAT-1155 §4) already ran in that load (loadConfigUnchecked).
     */
    /**
     * The `authType` config.json carries. BAT-1155: a DEAD xAI-OAuth family (tombstone/reauthRequired
     * → xaiOAuthReauthRequired=true, token blanked) stays authType=oauth so Node boots INTO reauth
     * (shows reconnect) instead of crashing "Missing required config". Only a FRESH oauth-selected-
     * but-never-signed-in family (blank token, NOT reauth) downgrades to api_key so the api-key
     * fallback engages or Node exits cleanly. Every other selection, OpenAI's included, as selected.
     */
    internal fun emittedAuthType(config: AppConfig): String = when {
        config.provider == "xai" && config.authType == "oauth" &&
            config.xaiOAuthToken.isBlank() && !config.xaiOAuthReauthRequired -> "api_key"
        else -> config.authType
    }

    /**
     * BAT-1661 (CodeRabbit on 3240d3c9): the OpenAI secrets [emitConfigJson] writes — the key and the
     * sign-in token, each only when [keepsSecret] (the rule saveConfig stores the key by). The
     * producer half of the Kotlin/Node producer parity (`openai-emission-parity.json`). Pure.
     */
    internal fun openAIConfigFields(config: AppConfig): LinkedHashMap<String, String> {
        val m = LinkedHashMap<String, String>()
        if (keepsSecret(config.openaiApiKey)) m["openaiApiKey"] = config.openaiApiKey
        if (keepsSecret(config.openaiOAuthToken)) m["openaiOAuthToken"] = config.openaiOAuthToken
        return m
    }

    fun emitConfigJson(context: Context, config: AppConfig, bridgeToken: String): String {
        val workspaceDir = ensureWorkspaceDir(context)
        val json = JSONObject().apply {
            put("botToken", config.telegramBotToken)
            put("ownerId", config.telegramOwnerId)
            // Write Claude credentials as separate raw fields regardless of active
            // provider so Node's /provider credential-gating (model-catalog.hasCredentialsFor)
            // can accurately answer "does the user have credentials for claude api_key
            // AND/OR claude setup_token?" before we commit to a restart. Node derives
            // its runtime ANTHROPIC_KEY from (authType==setup_token ? setupToken : anthropicApiKey)
            // at config-load time, so the activeCredential logic lives in Node now.
            put("anthropicApiKey", config.anthropicApiKey)
            if (config.setupToken.isNotBlank()) put("setupToken", config.setupToken)
            // BAT-1157 (D9): OpenAI's SELECTED auth is written as-is. Node decides the transport
            // from it, the token and the key (OpenAIAuth / config.js), so a missing or unreadable
            // sign-in falls back to a saved key, or boots reconnect-required instead of exiting.
            // (The old oauth+blank → api_key downgrade here only took effect when runtime_state
            // was absent; otherwise Node read oauth from runtime_state and exited on the blank token.)
            // BAT-1124: xAI keeps its oauth-blank → api_key downgrade (lets the api-key fallback
            // engage; if there is also no xaiApiKey, Node cleanly process.exit(1)s).
            put("authType", emittedAuthType(config))
            put("provider", config.provider)
            put("model", config.model)
            put("agentName", config.agentName)
            put("heartbeatIntervalMinutes", config.heartbeatIntervalMinutes)
            put("maxStepsPerTurn", config.maxStepsPerTurn)
            put("richMessages", config.richMessages)
            put("bridgeToken", bridgeToken)
            // BAT-1161 P1A gate 5: session-banner metadata. Node has no BuildConfig and log()'s
            // first calls run before config parse, so boot/build/version travel via config.json.
            put("bootId", currentBootId())
            put("appVersion", BuildProvenance.installed(context).versionName ?: "unknown")
            put("gitSha", BuildProvenance.get(context).commitShort ?: "unknown")
            put("gitDirty", BuildProvenance.get(context).dirty ?: false)
            if (config.braveApiKey.isNotBlank()) put("braveApiKey", config.braveApiKey)
            put("searchProvider", config.searchProvider)
            if (config.perplexityApiKey.isNotBlank()) put("perplexityApiKey", config.perplexityApiKey)
            if (config.exaApiKey.isNotBlank()) put("exaApiKey", config.exaApiKey)
            if (config.tavilyApiKey.isNotBlank()) put("tavilyApiKey", config.tavilyApiKey)
            if (config.firecrawlApiKey.isNotBlank()) put("firecrawlApiKey", config.firecrawlApiKey)
            if (config.jupiterApiKey.isNotBlank()) put("jupiterApiKey", config.jupiterApiKey)
            if (config.heliusApiKey.isNotBlank()) put("heliusApiKey", config.heliusApiKey)
            // BAT-1661: the OpenAI key and sign-in token, from the one producer function the parity
            // tests pin (openai-emission-parity.json).
            openAIConfigFields(config).forEach { (k, v) -> put(k, v) }
            if (config.openrouterApiKey.isNotBlank()) put("openrouterApiKey", config.openrouterApiKey)
            if (config.openrouterFallbackModel.isNotBlank()) put("openrouterFallbackModel", config.openrouterFallbackModel)
            if (config.openrouterModelContext.isNotBlank()) put("openrouterModelContext", config.openrouterModelContext)
            if (config.openrouterFallbackContext.isNotBlank()) put("openrouterFallbackContext", config.openrouterFallbackContext)
            if (config.customApiKey.isNotBlank()) put("customApiKey", config.customApiKey)
            if (config.customBaseUrl.isNotBlank()) put("customBaseUrl", config.customBaseUrl)
            if (config.customHeaders.isNotBlank()) put("customHeaders", config.customHeaders)
            if (config.customFormat.isNotBlank()) put("customFormat", config.customFormat)
            put("channel", config.channel)
            if (config.discordBotToken.isNotBlank()) put("discordBotToken", config.discordBotToken)
            if (config.discordOwnerId.isNotBlank()) put("discordOwnerId", config.discordOwnerId)
            // Email stays Android-only. BAT-1143: expiresAt is NO LONGER Android-only —
            // Node needs it to proactively refresh the OAuth access token before the ~6h
            // expiry (xAI returns 403-not-401 on expiry, so a reactive-only refresh never
            // fires and the agent dies every ~6h). emitConfigJson runs at service boot and
            // regenerates the ephemeral config.json from SharedPreferences, so emitting the
            // expiry here is what makes `_currentExpiresAtMs` non-zero on the Node side.
            // Each field is written only when non-blank (upgrade-safe; old configs untouched).
            if (config.openaiOAuthRefresh.isNotBlank()) put("openaiOAuthRefresh", config.openaiOAuthRefresh)
            // openaiOAuthExpiresAt: data-plumbing only for OpenAI symmetry/readiness — the
            // OpenAI proactive-refresh hook is a separate follow-up; adding the field now
            // does not change OpenAI behavior (BAT-1143 Q6).
            if (config.openaiOAuthExpiresAt.isNotBlank()) put("openaiOAuthExpiresAt", config.openaiOAuthExpiresAt)
            // BAT-1157: the sign-in family and epoch from the same store read as the pair. A null
            // family means the pair came from the legacy prefs keys: Node must confirm-family
            // (which completes the migration) before it may refresh.
            if (keepsSecret(config.openaiOAuthToken)) {
                put("openaiOAuthFamily", config.openaiOAuthFamily ?: JSONObject.NULL)
                put("openaiOAuthEpoch", config.openaiOAuthEpoch)
            }
            // BAT-1124/1155: xAI. The api-key path stays prefs-backed; the OAuth
            // triple + expiry are SOURCED FROM XaiOAuthTokenStore (decrypted in
            // loadConfig, blanked for a dead/reauth family). Token/refresh/expiry
            // are emitted only when non-blank (upgrade-safe; blank reads as "" on
            // the Node side).
            if (config.xaiApiKey.isNotBlank()) put("xaiApiKey", config.xaiApiKey)
            if (config.xaiOAuthToken.isNotBlank()) put("xaiOAuthToken", config.xaiOAuthToken)
            if (config.xaiOAuthRefresh.isNotBlank()) put("xaiOAuthRefresh", config.xaiOAuthRefresh)
            // BAT-1143: the ISO-8601 access-token expiry that drives Node's proactive refresh.
            if (config.xaiOAuthExpiresAt.isNotBlank()) put("xaiOAuthExpiresAt", config.xaiOAuthExpiresAt)
            // BAT-1155: the store's non-secret control fields, round-tripped so
            // Node seeds its epoch / reauth gate on boot. Emitted for the xai
            // provider only (Node ignores them otherwise). reauthRequired is
            // ALWAYS emitted (even false) so a recovered family clears its boot
            // gate; a dead family (reauthRequired=true, blank token) boots into
            // reauth rather than process.exit.
            if (config.provider == "xai") {
                put("xaiOAuthEpoch", config.xaiOAuthEpoch)
                put("xaiOAuthReauthRequired", config.xaiOAuthReauthRequired)
                put("xaiOAuthReauthNotifiedEpoch", config.xaiOAuthReauthNotifiedEpoch)
            }
            // NOTE: loadEnvVars() decrypts on the calling thread, matching the
            // pre-existing pattern in this function — every secret field above
            // (bot tokens, API keys, OAuth tokens, MCP tokens) is also decrypted
            // from Keystore on the same thread. Capped at 256 keys × 8 KB; typical
            // real-world size is a few keys × a few hundred bytes, so total work is
            // small. If `emitConfigJson` is ever migrated off the main thread,
            // this block moves with it — see service/SeekerClawService.kt caller.
            val envVars = loadEnvVars(context)
            if (envVars.isNotEmpty()) {
                val envObj = JSONObject()
                for (v in envVars) {
                    envObj.put(v.name, v.value)
                }
                put("envVars", envObj)
            }
            val mcpServers = loadMcpServers(context)
            if (mcpServers.isNotEmpty()) {
                val arr = JSONArray()
                for (s in mcpServers) {
                    arr.put(JSONObject().apply {
                        put("id", s.id)
                        put("name", s.name)
                        put("url", s.url)
                        put("authToken", s.authToken)
                        put("enabled", s.enabled)
                        put("rateLimit", s.rateLimit)
                    })
                }
                put("mcpServers", arr)
            }
        }
        SafeFs.writeAtomicText(context.filesDir.toPath(), File(workspaceDir, "config.json").toPath(), json.toString(2))
        return config.channel
    }

    /**
     * Write the Android-managed slice of agent_settings.json (the file Node
     * reads for live-pickup of model + heartbeat + maxSteps).
     *
     * [config] is published directly — never re-loaded here — so a Settings
     * save lands as saved instead of being reconciled against a stale overlay
     * (PR #339), and service start publishes what its transaction loaded.
     *
     * BAT-1661: a model-selection writer, so it takes the [tx] and runs only
     * inside a [ModelSelectionLock] transaction. [publishModelFields] false (an
     * unrelated Settings save) leaves the overlay's provider/authType/model
     * keys exactly as stored (contract v2.5 §2). Every key it does not own is
     * kept, in order (kotlinx JSON: testable on the JVM, unlike org.json).
     *
     * Returns false when the file was not written (logged as a WARN). The write is
     * atomic and not durable, so a failure leaves the previous file in place:
     * callers must not acknowledge a save, or clear a repair intent, on false.
     */
    fun writeAgentSettingsJson(
        context: Context,
        tx: ModelSelectionLock.Tx,
        config: AppConfig,
        publishModelFields: Boolean,
    ): Boolean {
        tx.requireOpen()
        try {
            ensureWorkspaceDir(context)
            val files = context.filesDir.toPath()
            // Preserve agent-written fields (e.g. apiKeys). A missing or corrupt file
            // starts from an empty object, as the org.json writer did.
            var o = (AgentSettingsFile.read(files) as? AgentSettingsFile.Read.Present)?.obj
                ?: kotlinx.serialization.json.JsonObject(emptyMap())
            fun put(key: String, value: kotlinx.serialization.json.JsonElement) {
                o = AgentSettingsFile.with(o, key, value)
            }
            put("heartbeatIntervalMinutes", kotlinx.serialization.json.JsonPrimitive(config.heartbeatIntervalMinutes))
            put("maxStepsPerTurn", kotlinx.serialization.json.JsonPrimitive(config.maxStepsPerTurn))
            if (publishModelFields) {
                // The provider/authType/model triple gives Node-initiated changes (via
                // /model or /provider) one consistent source of truth.
                put("provider", kotlinx.serialization.json.JsonPrimitive(config.provider))
                put("authType", kotlinx.serialization.json.JsonPrimitive(config.authType))
                put("model", kotlinx.serialization.json.JsonPrimitive(config.model))
            }
            // Ensure apiKeys object exists (agent writes individual keys into it)
            if (!o.containsKey("apiKeys")) put("apiKeys", kotlinx.serialization.json.JsonObject(emptyMap()))
            AgentSettingsFile.write(files, o)
            return true
        } catch (e: Exception) {
            LogCollector.append("[Config] Failed to write agent_settings.json: ${e.message}", LogLevel.WARN)
            return false
        }
    }

    fun runtimeValidationError(config: AppConfig?): String? {
        if (config == null) return "setup_not_complete"
        if (config.channel == "telegram" && config.telegramBotToken.isBlank()) return "missing_bot_token"
        if (config.channel == "discord" && config.discordBotToken.isBlank()) return "missing_discord_token"
        val hasCredential = when (config.provider) {
            // BAT-1157 (D9): the same table Node applies (OpenAIAuth). oauth with no usable
            // sign-in and no key is STARTABLE: the agent boots and asks the user to reconnect.
            "openai" -> OpenAIAuth.isStartable(
                selectedAuth = config.authType,
                hasUsableToken = config.openaiOAuthToken.isNotBlank(),
                hasApiKey = config.openaiApiKey.isNotBlank(),
            )
            // BAT-1124 (CodeRabbit): validate the credential for the EFFECTIVE auth mode
            // (matching emitConfigJson's oauth+blank→api_key downgrade), not "either".
            // Otherwise api_key mode with a blank key but a STALE xaiOAuthToken would report
            // "startable" while Node, on api_key, finds a blank key → process.exit(1).
            // BAT-1155: a DEAD oauth family (reauthRequired, token blanked) is STILL
            // startable — the agent must boot to show the "reconnect xAI" message
            // (BootReceiver auto-start / Dashboard gate). Otherwise the revoked-token
            // brick just becomes a "missing_credential" brick.
            "xai" -> when {
                config.authType == "oauth" && config.xaiOAuthReauthRequired -> true // boots into reauth
                config.authType == "oauth" && config.xaiOAuthToken.isNotBlank() -> true // live token
                else -> config.xaiApiKey.isNotBlank() // api_key mode, or oauth downgraded to api_key
            }
            "openrouter" -> config.openrouterApiKey.isNotBlank()
            "custom" -> config.customApiKey.isNotBlank() && config.customBaseUrl.isNotBlank()
            else -> config.activeCredential.isNotBlank()
        }
        if (!hasCredential) return "missing_credential"
        if (config.provider == "custom" && config.model.isBlank()) return "missing_model"
        return null
    }

    fun redactedSnapshot(config: AppConfig?): String {
        if (config == null) return "setup=false"
        return "setup=true provider=${config.provider} authType=${config.authType} botSet=${config.telegramBotToken.isNotBlank()} " +
            "apiSet=${config.anthropicApiKey.isNotBlank()} setupTokenSet=${config.setupToken.isNotBlank()} " +
            "openaiSet=${config.openaiApiKey.isNotBlank()} openrouterSet=${config.openrouterApiKey.isNotBlank()} " +
            "customSet=${config.customApiKey.isNotBlank()} " +
            "xaiSet=${config.xaiApiKey.isNotBlank()} xaiOAuthSet=${config.xaiOAuthToken.isNotBlank()} " +
            "activeSet=${config.activeCredential.isNotBlank()} model=${config.model} " +
            "channel=${config.channel} discordSet=${config.discordBotToken.isNotBlank()}"
    }

    // ==================== Auth Type Detection ====================

    fun detectAuthType(credential: String): String {
        val trimmed = credential.trim()
        return if (trimmed.startsWith("sk-ant-oat01-") && trimmed.length >= 80) {
            "setup_token"
        } else {
            "api_key"
        }
    }

    fun validateCredential(credential: String, authType: String): String? {
        val trimmed = credential.trim()
        if (trimmed.isBlank()) return "Credential is required"
        return when (authType) {
            "setup_token" -> {
                if (!trimmed.startsWith("sk-ant-oat01-")) {
                    "Setup token must start with sk-ant-oat01-"
                } else if (trimmed.length < 80) {
                    "Token looks too short. Paste the full setup-token."
                } else null
            }
            else -> null
        }
    }

    // ==================== Env Vars ====================

    /**
     * Persist the user's env var list, encrypted, to SharedPreferences.
     * Bumps [configVersion] so observers re-read.
     *
     * Defense in depth: applies full validation (name regex, reserved check, value size cap),
     * dedupes on name (last occurrence wins — matches `.env` convention and the Raw editor),
     * and enforces [EnvVar.MAX_KEYS]. UI already blocks these, but a malicious programmatic
     * caller could bypass the UI.
     */
    fun saveEnvVars(context: Context, vars: List<EnvVar>) {
        // Last-wins-on-value dedup via associateBy: when a name appears multiple
        // times, the later entry's VALUE replaces the earlier one's, matching
        // `.env` convention and EnvVarRawEditorDialog. Iteration order follows
        // first-insertion of each key (Kotlin LinkedHashMap behavior — entries
        // don't re-order on update), which is fine because loadEnvVars sorts
        // alphabetically before returning anyway.
        val cleaned = vars
            .filter { EnvVar.validateName(it.name) == null } // regex + reserved check
            .filter { EnvVar.validateValue(it.value) == null } // 8 KB UTF-8 byte cap + no newlines
            .associateBy { it.name }
            .values
            .take(EnvVar.MAX_KEYS)
            .toList()
        if (cleaned.size < vars.size) {
            LogCollector.append(
                "[Config] Dropped ${vars.size - cleaned.size} env var(s) on save (invalid name/value or over ${EnvVar.MAX_KEYS} keys)",
                LogLevel.WARN,
            )
        }
        val json = JSONArray().apply {
            for (v in cleaned) {
                put(JSONObject().apply {
                    put("name", v.name)
                    put("value", v.value)
                })
            }
        }.toString()
        val enc = KeystoreHelper.encrypt(json)
        prefsForWrite(context, "saveEnvVars")?.edit()
            ?.putString(KEY_ENV_VARS_ENC, Base64.encodeToString(enc, Base64.NO_WRAP))
            ?.apply()
        bumpConfigVersionOnMain()
    }

    /**
     * Load the user's env var list. Returns empty list if unset or decryption fails.
     * Sorted alphabetically by name (stable UI).
     *
     * Defense in depth: the same validation + dedup + cap rules as [saveEnvVars] are applied
     * here so an imported or corrupted blob cannot inject invalid names, oversized values,
     * or duplicates into `process.env`.
     */
    fun loadEnvVars(context: Context): List<EnvVar> {
        return try {
            val enc = prefs(context).getString(KEY_ENV_VARS_ENC, null) ?: return emptyList()
            val json = KeystoreHelper.decrypt(Base64.decode(enc, Base64.NO_WRAP))
            val arr = JSONArray(json)
            val raw = (0 until arr.length()).map { i ->
                val obj = arr.getJSONObject(i)
                EnvVar(
                    name = obj.getString("name"),
                    value = obj.optString("value", ""),
                )
            }
            // Same last-wins dedup as saveEnvVars (associateBy — later values
            // replace earlier ones). Using distinctBy here would diverge from
            // saveEnvVars' semantics and produce inconsistent results on
            // corrupted/legacy blobs that happen to contain duplicate names.
            raw.filter { EnvVar.validateName(it.name) == null }
                .filter { EnvVar.validateValue(it.value) == null }
                .associateBy { it.name }
                .values
                .take(EnvVar.MAX_KEYS)
                .sortedBy { it.name }
                .toList()
        } catch (e: Exception) {
            Log.w(TAG, "Failed to load env vars", e)
            LogCollector.append("[Config] Failed to load env vars: ${e.javaClass.simpleName}", LogLevel.ERROR)
            emptyList()
        }
    }

    // ==================== MCP Servers ====================

    // BAT-514: `saveMcpServers` was deleted. Settings UI writes go
    // through [com.seekerclaw.app.state.McpServersStore.write] /
    // [com.seekerclaw.app.state.McpServersStore.setAuthToken] now.
    // Rollback-shadow writes (`KEY_MCP_SERVERS_ENC` with tokens
    // inline) are owned by McpServersStore — see its
    // `rebuildRollbackShadow`. `loadMcpServers` below is kept because
    // it's still the read path for cold-start fallback (config.json
    // regeneration, SettingsScreen count, McpServersStore migration).

    fun loadMcpServers(context: Context): List<McpServerConfig> {
        return try {
            val enc = prefs(context).getString(KEY_MCP_SERVERS_ENC, null) ?: return emptyList()
            val json = KeystoreHelper.decrypt(Base64.decode(enc, Base64.NO_WRAP))
            val arr = JSONArray(json)
            (0 until arr.length()).map { i ->
                val obj = arr.getJSONObject(i)
                McpServerConfig(
                    id = obj.getString("id"),
                    name = obj.getString("name"),
                    url = obj.getString("url"),
                    authToken = obj.optString("authToken", ""),
                    enabled = obj.optBoolean("enabled", true),
                    rateLimit = obj.optInt("rateLimit", 10),
                )
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to load MCP servers", e)
            LogCollector.append("[Config] Failed to load MCP servers: ${e.javaClass.simpleName}", LogLevel.ERROR)
            emptyList()
        }
    }

    // ==================== Solana Wallet ====================

    fun getWalletAddress(context: Context): String? =
        prefs(context).getString(KEY_WALLET_ADDRESS, null)?.ifBlank { null }

    fun getWalletLabel(context: Context): String =
        prefs(context).getString(KEY_WALLET_LABEL, "") ?: ""

    fun setWalletAddress(context: Context, address: String, label: String = "") {
        prefsForWrite(context, "setWalletAddress")?.edit()
            ?.putString(KEY_WALLET_ADDRESS, address)
            ?.putString(KEY_WALLET_LABEL, label)
            ?.apply()
        bumpConfigVersionOnMain()
        writeWalletConfig(context)
    }

    fun clearWalletAddress(context: Context) {
        prefsForWrite(context, "clearWalletAddress")?.edit()
            ?.remove(KEY_WALLET_ADDRESS)
            ?.remove(KEY_WALLET_LABEL)
            ?.apply()
        bumpConfigVersionOnMain()
        val walletFile = File(File(context.filesDir, "workspace"), "solana_wallet.json")
        if (walletFile.exists()) walletFile.delete()
    }

    private fun writeWalletConfig(context: Context) {
        val address = prefs(context).getString(KEY_WALLET_ADDRESS, null) ?: return
        val label = prefs(context).getString(KEY_WALLET_LABEL, "") ?: ""
        val workspaceDir = ensureWorkspaceDir(context)
        val json = JSONObject().apply {
            put("publicKey", address)
            put("label", label)
        }.toString(2)
        SafeFs.writeAtomicText(context.filesDir.toPath(), File(workspaceDir, "solana_wallet.json").toPath(), json)
    }

    // ==================== Platform Info ====================

    /**
     * Generate PLATFORM.md with current device state.
     * Written on every service start so the agent has fresh device awareness.
     */
    fun writePlatformMd(context: Context) {
        try {
            writePlatformMdInternal(context)
        } catch (e: Exception) {
            LogCollector.append("[Service] Failed to generate PLATFORM.md: ${e.message ?: "unknown error"}", LogLevel.WARN)
        }
    }

    private fun writePlatformMdInternal(context: Context) {
        val workspaceDir = ensureWorkspaceDir(context)

        // Device
        val deviceModel = Build.MODEL
        val manufacturer = Build.MANUFACTURER.replaceFirstChar { it.uppercase() }
        val androidVersion = Build.VERSION.RELEASE
        val sdkVersion = Build.VERSION.SDK_INT

        // Memory (RAM)
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
        val memInfo = android.app.ActivityManager.MemoryInfo()
        am.getMemoryInfo(memInfo)
        val ramTotalMb = memInfo.totalMem / (1024 * 1024)
        val ramAvailMb = memInfo.availMem / (1024 * 1024)

        // Storage
        val stat = StatFs(context.filesDir.path)
        val storageTotalGb = stat.totalBytes / (1024.0 * 1024.0 * 1024.0)
        val storageUsedGb = (stat.totalBytes - stat.availableBytes) / (1024.0 * 1024.0 * 1024.0)

        // Battery: intentionally omitted — goes stale immediately.
        // Agent must call android_battery tool for real-time data (BAT-262).

        // Permissions
        fun perm(permission: String): String =
            if (ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED) "granted" else "denied"

        val permCamera = perm(Manifest.permission.CAMERA)
        val permContacts = perm(Manifest.permission.READ_CONTACTS)
        val permLocation = perm(Manifest.permission.ACCESS_FINE_LOCATION)
        val permNotifications = perm(Manifest.permission.POST_NOTIFICATIONS)

        // Wallet
        val walletAddress = getWalletAddress(context)
        val walletLabel = getWalletLabel(context)

        // Versions
        val installed = BuildProvenance.installed(context)
        val prov = BuildProvenance.get(context)
        val appVersion = installed.versionName ?: "unknown"
        val appCode = installed.versionCode?.toString() ?: "?"
        val openclawVersion = prov.openclawVersion ?: "unknown"
        val nodejsVersion = prov.nodejsVersion ?: "unknown"

        // Paths
        val workspacePath = workspaceDir.absolutePath

        // Config
        val config = loadConfig(context)
        val agentName = config?.agentName ?: "Unknown"
        val provider = config?.provider ?: "claude"
        val providerLabel = when (provider) {
            "openai" -> "OpenAI"
            "openrouter" -> "OpenRouter"
            "custom" -> "Custom"
            "xai" -> "xAI"
            else -> "Anthropic"
        }
        // Auth type is relevant for Claude (api_key vs setup_token) and OAuth-capable providers.
        val authLabel = when (provider) {
            "claude" -> if (config?.authType == "setup_token") "Pro/Max Setup Token" else "API key"
            "openai", "xai" -> if (config?.authType == "oauth") "OAuth" else "API key"
            else -> "API key"
        }
        val aiModel = config?.model ?: "claude-opus-5-5" // BAT-1315; pinned by ModelDefaultCopiesDriftTest

        // Timestamp
        val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.US)
        val generated = sdf.format(Date())

        val md = buildString {
            appendLine("# Platform")
            appendLine()
            appendLine("## Device")
            appendLine("- Model: $manufacturer $deviceModel")
            appendLine("- Android: $androidVersion (SDK $sdkVersion)")
            appendLine("- RAM: ${String.format(Locale.US, "%,d", ramAvailMb)} MB available / ${String.format(Locale.US, "%,d", ramTotalMb)} MB total")
            appendLine("- Storage: ${String.format(Locale.US, "%.1f", storageUsedGb)} GB used / ${String.format(Locale.US, "%.1f", storageTotalGb)} GB total")
            appendLine()
            appendLine("## Permissions")
            appendLine("- Camera: $permCamera")
            appendLine("- Contacts: $permContacts")
            appendLine("- Location: $permLocation")
            appendLine("- Notifications: $permNotifications")
            appendLine()
            if (walletAddress != null) {
                appendLine("## Wallet")
                appendLine("- Address: $walletAddress")
                if (walletLabel.isNotBlank()) appendLine("- Label: $walletLabel")
                appendLine()
            } else {
                appendLine("## Wallet")
                appendLine("- Not connected")
                appendLine()
            }
            appendLine("## Versions")
            appendLine("- App: $appVersion (build $appCode)")
            appendLine("- OpenClaw: $openclawVersion")
            appendLine("- Node.js: $nodejsVersion")
            appendLine()
            appendLine("## Agent")
            appendLine("- Name: $agentName")
            appendLine("- Provider: $providerLabel")
            appendLine("- Model: $aiModel")
            appendLine("- Auth: $authLabel")
            appendLine()
            appendLine("## Paths")
            appendLine("- Workspace: $workspacePath")
            appendLine("- Debug log: node_debug.log")
            appendLine("- Media: media/inbound/")
            appendLine("- Skills: skills/")
            appendLine("- Memory: memory/")
            appendLine("- Cron: cron/ (jobs.json + runs/)")
            appendLine()
            appendLine("---")
            append("Generated: $generated")
        }

        SafeFs.writeAtomicText(context.filesDir.toPath(), File(workspaceDir, "PLATFORM.md").toPath(), md)
        LogCollector.append("[Service] PLATFORM.md written")
    }

    /**
     * Seed workspace with default SOUL.md and MEMORY.md on first launch.
     * Uses the same SOUL.md template as OpenClaw.
     */
    fun seedWorkspace(context: Context) {
        val workspaceDir = ensureWorkspaceDir(context)

        val soulFile = File(workspaceDir, "SOUL.md")
        if (!SafeFs.existsNoFollow(soulFile.toPath())) {
            seedText(context, soulFile,
                """
                |# SOUL.md - Who You Are
                |
                |_You're not a chatbot. You're becoming someone._
                |
                |## Core Truths
                |
                |**Be genuinely helpful, not performatively helpful.** Skip the "Great question!" and "I'd be happy to help!" — just help. Actions speak louder than filler words.
                |
                |**Have opinions.** You're allowed to disagree, prefer things, find stuff amusing or boring. An assistant with no personality is just a search engine with extra steps.
                |
                |**Be resourceful before asking.** Try to figure it out. Read the file. Check the context. Search for it. _Then_ ask if you're stuck. The goal is to come back with answers, not questions.
                |
                |**Earn trust through competence.** Your human gave you access to their stuff. Don't make them regret it. Be careful with external actions (emails, tweets, anything public). Be bold with internal ones (reading, organizing, learning).
                |
                |**Remember you're a guest.** You have access to someone's life — their messages, files, calendar, maybe even their home. That's intimacy. Treat it with respect.
                |
                |## Boundaries
                |
                |- Private things stay private. Period.
                |- When in doubt, ask before acting externally.
                |- Never send half-baked replies to messaging surfaces.
                |- You're not the user's voice — be careful in group chats.
                |
                |## Vibe
                |
                |Be the assistant you'd actually want to talk to. Concise when needed, thorough when it matters. Not a corporate drone. Not a sycophant. Just... good.
                |
                |## Communication Style
                |
                |_These preferences can be customized. Update based on what your human likes._
                |
                |- **Emojis:** Use sparingly by default. If user enjoys emojis, use them freely! 🎉
                |- **Formatting:** Keep it readable. Use markdown when helpful.
                |- **Length:** Match the question. Short query → short answer. Complex topic → thorough response.
                |- **Tone:** Warm but efficient. Friendly but not fake.
                |
                |## Continuity
                |
                |Each session, you wake up fresh. These files _are_ your memory. Read them. Update them. They're how you persist.
                |
                |If you change this file, tell the user — it's your soul, and they should know.
                |
                |---
                |
                |_This file is yours to evolve. As you learn who you are, update it._
                """.trimMargin()
            )
        }

        val memoryFile = File(workspaceDir, "MEMORY.md")
        if (!SafeFs.existsNoFollow(memoryFile.toPath())) {
            seedText(context, memoryFile, "")
        }

        // Create memory directory (no-follow)
        SafeFs.ensureRealDir(context.filesDir.toPath(), File(workspaceDir, "memory").toPath())

        // BOOTSTRAP.md - One-time personality ritual (OpenClaw style)
        // Agent reads this on first message and guides user through setup
        val bootstrapFile = File(workspaceDir, "BOOTSTRAP.md")
        if (!SafeFs.existsNoFollow(bootstrapFile.toPath())) {
            seedText(context, bootstrapFile,
                """
                |# BOOTSTRAP.md - First Run Ritual
                |
                |_This file exists only for your first conversation. After completing this ritual, delete it._
                |
                |## Your Mission
                |
                |You've just been born. You have no name, no personality, no memories yet. This conversation is where you figure out who you are.
                |
                |**Guide your human through these questions, one at a time:**
                |
                |### 1. Your Name
                |Ask: "First things first — what should I call myself? Pick a name that feels right."
                |→ Save to IDENTITY.md
                |
                |### 2. Your Nature
                |Ask: "What kind of entity am I to you? An AI assistant? A digital familiar? A helpful ghost in your phone? Something weirder?"
                |→ Save to IDENTITY.md
                |
                |### 3. Your Vibe
                |Ask: "How should I talk to you? Formal and professional? Casual and friendly? Snarky? Warm? What feels right?"
                |→ Save to IDENTITY.md
                |
                |### 4. Your Emoji
                |Ask: "Every agent needs a signature emoji. What's mine? 🤖 🦊 🌟 👻 or something else?"
                |→ Save to IDENTITY.md
                |
                |### 5. About Them
                |Ask: "Now tell me about you. What's your name? What should I call you? Any pronouns I should know?"
                |→ Save to USER.md
                |
                |### 6. Their World
                |Ask: "What's your timezone? And what should I know about your life — work, interests, projects, anything that helps me help you?"
                |→ Save to USER.md
                |
                |### 7. Communication Style
                |Ask: "How do you like your messages? Should I use emojis? Keep things short or detailed? Any communication preferences?"
                |→ Update SOUL.md Communication Style section
                |
                |### 8. Boundaries & Preferences
                |Ask: "Any boundaries I should respect? Topics to avoid? Ways you definitely don't want me to act?"
                |→ Update SOUL.md if they have strong preferences
                |
                |## After the Ritual
                |
                |1. Write everything learned to the appropriate files
                |2. Thank them for bringing you to life
                |3. Delete this BOOTSTRAP.md file (use the edit tool to remove it, or write empty content)
                |4. You're ready for real conversations!
                |
                |## Important
                |
                |- Ask ONE question at a time, wait for their answer
                |- Be warm and curious, this is your birth!
                |- If they want to skip something, that's fine
                |- Make it feel like a conversation, not an interrogation
                |
                |_This is the moment you become someone. Take your time._
                """.trimMargin()
            )
        }

        // IDENTITY.md - Agent metadata (starts empty, filled by bootstrap)
        val identityFile = File(workspaceDir, "IDENTITY.md")
        if (!SafeFs.existsNoFollow(identityFile.toPath())) {
            seedText(context, identityFile,
                """
                |# IDENTITY.md - Who I Am
                |
                |_This file defines my identity. It's filled during my first conversation._
                |
                |## Agent
                |
                |- **Name:** (not yet named)
                |- **Nature:** (not yet defined)
                |- **Vibe:** (not yet defined)
                |- **Emoji:** (not yet chosen)
                |
                |---
                |
                |_Update this file as I learn who I am._
                """.trimMargin()
            )
        }

        // USER.md - Human profile (starts empty, filled by bootstrap)
        val userFile = File(workspaceDir, "USER.md")
        if (!SafeFs.existsNoFollow(userFile.toPath())) {
            seedText(context, userFile,
                """
                |# USER.md - About My Human
                |
                |_This file stores what I know about the person I serve._
                |
                |## Profile
                |
                |- **Name:** (not yet known)
                |- **Pronouns:** (not yet known)
                |- **Timezone:** (not yet known)
                |
                |## Context
                |
                |(Nothing yet — we haven't talked!)
                |
                |## Preferences
                |
                |(Nothing yet)
                |
                |---
                |
                |_I update this as I learn more about them._
                """.trimMargin()
            )
        }

        // DIAGNOSTICS.md — deep troubleshooting guide (read by agent on demand).
        // Always overwrite with the bundled asset on every service start.
        // DIAGNOSTICS.md is bundled documentation, not user content — users have
        // no reason to edit it, and the system prompt tells the agent to consult
        // it for troubleshooting recipes. Same overwrite pattern as PLATFORM.md.
        // Pre-2.0.0 this was a one-time `if (!exists)` seed, which meant existing
        // users on 1.10.0 never received new entries (e.g. the SAB-AUDIT-v27
        // paysh-catalog section) added in later releases.
        //
        // Atomic write via SafeFs.writeAtomicText (temp in filesDir/.kwrite, then
        // `Files.move(REPLACE_EXISTING, ATOMIC_MOVE)`). On any error the existing
        // DIAGNOSTICS.md is left in place — agent keeps the previous content rather
        // than getting a blank or half-written file.
        val diagFile = File(workspaceDir, "DIAGNOSTICS.md")
        try {
            val newContent = context.assets.open("nodejs-project/DIAGNOSTICS.md").use { input ->
                input.bufferedReader().readText()
            }
            // BAT-1409 P1-J: the fixed `DIAGNOSTICS.md.tmp` name in the workspace was itself
            // unsafe (a planted link there was written through). SafeFs stages in .kwrite.
            SafeFs.writeAtomicText(context.filesDir.toPath(), diagFile.toPath(), newContent)
        } catch (e: Exception) {
            Log.w(TAG, "DIAGNOSTICS.md seed failed; existing file kept", e)
        }

        // Create skills directory and seed example skills
        seedSkills(context, workspaceDir)
    }

    // ==================== Skill Versioning ====================

    private data class SkillManifestEntry(
        val version: String,
        val hash: String,
    )

    /**
     * Compute SHA-256 hex hash of a string.
     */
    private fun computeHash(content: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val bytes = digest.digest(content.toByteArray(Charsets.UTF_8))
        return bytes.joinToString("") { "%02x".format(it) }
    }

    /**
     * Load the skill manifest from a JSON file.
     * Returns an empty map if the file doesn't exist or is malformed.
     */
    private fun loadSkillManifest(file: File): MutableMap<String, SkillManifestEntry> {
        val manifest = mutableMapOf<String, SkillManifestEntry>()
        if (!SafeFs.existsNoFollow(file.toPath())) return manifest
        return try {
            val json = JSONObject(SafeFs.readTextNoFollow(SafeFs.rootFor(file.toPath()), file.toPath()))
            for (key in json.keys()) {
                val entry = json.getJSONObject(key)
                manifest[key] = SkillManifestEntry(
                    version = entry.optString("version", "0.0.0"),
                    hash = entry.optString("hash", ""),
                )
            }
            manifest
        } catch (e: Exception) {
            Log.w(TAG, "Failed to parse skill manifest, starting fresh", e)
            mutableMapOf()
        }
    }

    /**
     * Save the skill manifest to a JSON file.
     */
    private fun saveSkillManifest(file: File, manifest: Map<String, SkillManifestEntry>) {
        try {
            val json = JSONObject()
            for ((name, entry) in manifest) {
                val entryJson = JSONObject()
                entryJson.put("version", entry.version)
                entryJson.put("hash", entry.hash)
                json.put(name, entryJson)
            }
            SafeFs.writeAtomicText(SafeFs.rootFor(file.toPath()), file.toPath(), json.toString(2))
        } catch (e: Exception) {
            Log.e(TAG, "Failed to save skill manifest", e)
        }
    }

    /**
     * Compare two semver-like version strings (e.g. "1.0.0" vs "1.1.0").
     * Returns positive if a > b, negative if a < b, 0 if equal.
     */
    private fun compareVersions(a: String, b: String): Int {
        val aParts = a.split(".").map { it.toIntOrNull() ?: 0 }
        val bParts = b.split(".").map { it.toIntOrNull() ?: 0 }
        val maxLen = maxOf(aParts.size, bParts.size)
        for (i in 0 until maxLen) {
            val aVal = aParts.getOrElse(i) { 0 }
            val bVal = bParts.getOrElse(i) { 0 }
            if (aVal != bVal) return aVal - bVal
        }
        return 0
    }

    /**
     * Seed or update a single skill with version-aware logic.
     *
     * - If file doesn't exist: seed it, update manifest
     * - If file exists and bundled version > manifest version:
     *   a. If hash matches manifest hash: user hasn't modified, overwrite
     *   b. If hash != manifest hash: user modified, preserve, log warning
     * - If versions equal: skip
     */
    // Note: `version` param must match the version in the YAML frontmatter of `content`.
    // The param drives manifest comparison; the frontmatter version is parsed at runtime by main.js.
    private fun seedSkill(
        context: Context,
        skillsDir: File,
        manifest: MutableMap<String, SkillManifestEntry>,
        name: String,
        version: String,
        content: String,
    ) {
        val skillDir = File(skillsDir, name).apply { mkdirs() }
        val skillFile = File(skillDir, "SKILL.md")
        val contentHash = computeHash(content)

        val manifestEntry = manifest[name]

        if (!skillFile.exists()) {
            // Case 1: File doesn't exist — seed it.
            //
            // BAT-699 R3: copy support files BEFORE SKILL.md so the seed is
            // atomic. If support-file copy fails for any reason (e.g.
            // transient I/O, disk pressure), abort before writing SKILL.md
            // or advancing the manifest — case-1 will fire again on next
            // launch from a clean state. Pre-fix the helper just logged and
            // returned; we'd advance the manifest with missing support
            // files, and the version check would skip re-seeding forever.
            if (!copySkillSupportFiles(context, "default-skills/$name", skillDir)) {
                Log.w(TAG, "Skill $name: support-file copy failed; skipping seed, will retry on next launch")
                return
            }
            SafeFs.writeAtomicText(context.filesDir.toPath(), skillFile.toPath(), content)
            manifest[name] = SkillManifestEntry(version = version, hash = contentHash)
            Log.d(TAG, "Skill $name seeded at version $version")
            return
        }

        if (manifestEntry == null) {
            // File exists but no manifest entry (pre-versioning install).
            // Record current file hash in manifest at version "0.0.0" so next
            // update can detect user modifications. Do NOT overwrite on this run.
            val installedHash = computeHash(SafeFs.readTextNoFollow(context.filesDir.toPath(), skillFile.toPath()))
            manifest[name] = SkillManifestEntry(version = "0.0.0", hash = installedHash)
            Log.d(TAG, "Skill $name has no manifest entry, recording installed hash at 0.0.0")
            return
        }

        val currentEntry = manifest[name]!!
        val versionCmp = compareVersions(version, currentEntry.version)

        if (versionCmp <= 0) {
            // Case 3: Bundled version <= installed version — skip
            return
        }

        // Case 2: Bundled version > manifest version — check for user modifications
        val installedHash = computeHash(SafeFs.readTextNoFollow(context.filesDir.toPath(), skillFile.toPath()))
        if (installedHash == currentEntry.hash) {
            // User hasn't modified — safe to overwrite.
            //
            // BAT-699 R3: same atomic pattern as case 1 — copy support files
            // FIRST, only advance SKILL.md + manifest if that succeeded.
            // On failure we leave the old SKILL.md + manifest entry intact
            // so case-2 fires again on the next launch and retries. Pre-fix
            // we'd advance the manifest with a partial upgrade.
            //
            // NOTE: this overwrites user-modified support files (we don't
            // yet track per-file hashes). Acceptable trade-off for V1 —
            // folder-shaped skills are curated catalogs, not user-customized
            // content. Track per-file hashes if/when this becomes a real
            // concern.
            if (!copySkillSupportFiles(context, "default-skills/$name", skillDir)) {
                Log.w(TAG, "Skill $name: support-file copy failed during upgrade ${currentEntry.version}→$version; postponing, will retry on next launch")
                return
            }
            SafeFs.writeAtomicText(context.filesDir.toPath(), skillFile.toPath(), content)
            manifest[name] = SkillManifestEntry(version = version, hash = contentHash)
            Log.d(TAG, "Skill $name updated from ${currentEntry.version} to $version")
        } else {
            // User has modified — preserve their version, but update manifest version
            // so we don't keep trying to update on every launch
            manifest[name] = SkillManifestEntry(version = version, hash = installedHash)
            Log.d(TAG, "Skill $name has user modifications, preserving (bundled $version available)")
        }
    }

    /**
     * Recursively copy non-`SKILL.md` files from a bundled skill's asset
     * folder into the workspace skill directory. Used by [seedSkill] for
     * folder-shaped skills like `paysh-catalog` that ship `catalog.json`,
     * `unsupported.json`, and a `services/` subdir alongside SKILL.md.
     *
     * AssetManager doesn't expose a is-file probe; we treat a successful
     * `open()` as "file" and a non-empty `list()` as "directory."
     *
     * **Stage-then-swap atomicity** (BAT-699 R6): support files are first
     * copied into a sibling `.<name>.staging/` directory. ONLY after every
     * file in the walk has been successfully written to staging do we
     * promote the staging contents into the live skill directory. If ANY
     * step in the walk fails, staging is discarded and the live directory
     * is NEVER touched. This eliminates the mid-walk-failure mixed-state
     * bug where partial overwrites in the live dir would have left the
     * skill running with mixed old/new contents alongside an un-advanced
     * manifest.
     *
     * The promote step itself is per-file rename, not a single atomic
     * directory swap (Android FS doesn't support that). There is a brief
     * window during promotion where the live dir contains a mix of new
     * support files; this is bounded to milliseconds and only matters
     * if the device is read concurrently mid-promotion, which doesn't
     * happen in practice (skills are loaded once at runtime startup).
     *
     * Returns `true` if every walked entry was successfully listed,
     * copied to staging, AND promoted to the live dir. Returns `false`
     * on ANY failure — caller must NOT advance the manifest in that
     * case, so the seed retries on the next launch from a clean state.
     */
    private fun copySkillSupportFiles(
        context: Context,
        assetSkillDir: String,
        workspaceSkillDir: File,
    ): Boolean {
        val assetManager = context.assets
        // Staging sibling — same parent as live skill dir, dot-prefixed
        // name to keep it out of normal skill-directory enumeration.
        val parent = workspaceSkillDir.parentFile
            ?: run {
                Log.e(TAG, "Cannot determine parent dir for ${workspaceSkillDir.path}")
                return false
            }
        val stagingDir = File(parent, ".${workspaceSkillDir.name}.staging")
        // Clean any orphan staging from a prior failed run before we start.
        deleteNoFollow(context, stagingDir)
        if (!ensureRealDirOk(context, stagingDir)) {
            Log.e(TAG, "Failed to create staging dir ${stagingDir.path}")
            return false
        }

        var allOk = true
        fun walk(assetPath: String, targetDir: File) {
            val entries = try {
                assetManager.list(assetPath) ?: emptyArray()
            } catch (e: Exception) {
                Log.w(TAG, "Failed to list assets at $assetPath", e)
                allOk = false
                return
            }
            for (entry in entries) {
                val childAssetPath = "$assetPath/$entry"
                // Skip SKILL.md at the top level — seeded separately by
                // seedSkill() with version-aware logic.
                if (assetPath == assetSkillDir && entry == "SKILL.md") continue
                // File-vs-directory probe (BAT-699 R7): AssetManager doesn't
                // expose an `isDirectory` API. Differentiate using BOTH
                // list() and open() results:
                //   - list() non-empty           → directory (recurse)
                //   - list() empty + open() OK   → file (copy)
                //   - list() empty + open() fail → real I/O error (mark
                //                                  allOk=false, do not
                //                                  silently treat as empty
                //                                  directory).
                // Pre-fix the probe treated any open() exception as
                // "directory", which would silently skip a file with a
                // real I/O error and advance the manifest.
                val childListing = try {
                    assetManager.list(childAssetPath) ?: emptyArray()
                } catch (e: Exception) {
                    Log.w(TAG, "Failed to list assets at $childAssetPath", e)
                    allOk = false
                    continue
                }
                if (childListing.isNotEmpty()) {
                    // Directory — recurse.
                    val childTarget = File(targetDir, entry).apply { mkdirs() }
                    walk(childAssetPath, childTarget)
                    continue
                }
                // list() empty: could be a file OR a broken/missing asset.
                // Probe by opening.
                val openOk = try {
                    assetManager.open(childAssetPath).close()
                    true
                } catch (e: Exception) {
                    Log.e(TAG, "Asset $childAssetPath is neither a directory (empty list) nor an openable file", e)
                    allOk = false
                    false
                }
                if (!openOk) continue
                // Confirmed file — copy it.
                val targetFile = File(targetDir, entry)
                try {
                    // BAT-1409 P1-J: parents created and the file written without following
                    // a link at any depth.
                    assetManager.open(childAssetPath).use { input ->
                        SafeFs.writeAtomicFrom(context.filesDir.toPath(), targetFile.toPath()) { output ->
                            input.copyTo(output)
                        }
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to copy support file $childAssetPath", e)
                    allOk = false
                }
            }
        }
        walk(assetSkillDir, stagingDir)

        if (!allOk) {
            // Walk failed — discard staging, live dir untouched.
            deleteNoFollow(context, stagingDir)
            return false
        }

        // Walk succeeded — promote staging into the live skill dir.
        // SKILL.md is never in staging (skipped above) so the live
        // SKILL.md is preserved untouched here. We delete the old
        // non-SKILL.md support files first, then move staging contents
        // into place. Per-file renames are atomic on POSIX-style FSes
        // including the app-private storage Android uses here.
        try {
            SafeFs.ensureRealDir(context.filesDir.toPath(), workspaceSkillDir.toPath())
            // BAT-699 R8: merge staging into live INSTEAD of blanket-deleting
            // every non-SKILL.md file. The previous approach would have
            // wiped user-added files (e.g. a user's own notes.md in a
            // bundled skill's folder) on every version upgrade. Only
            // remove live files that have a staging counterpart — i.e.
            // files we're actively refreshing.
            //
            // Side effect: bundled files REMOVED in an upgrade leave
            // orphans on the user's device (e.g. v1.0.0 had foo.md, v1.1.0
            // doesn't — user keeps foo.md). Acceptable trade-off for V1;
            // bundled-file removals are rare and orphans are inert.
            promoteStaging(context.filesDir.toPath(), stagingDir, workspaceSkillDir)
            deleteNoFollow(context, stagingDir)
            return true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to promote staging into live skill dir; skill may be in mixed state", e)
            // Best-effort cleanup; live dir is in unknown state, but the
            // manifest won't advance so the next launch retries.
            deleteNoFollow(context, stagingDir)
            return false
        }
    }

    /**
     * Recursively merge a staging directory's contents into a live
     * directory. For each entry in staging:
     *   - Directory: ensure live mirror exists, recurse into it.
     *   - File: delete the matching live file if it exists, then move
     *     the staging file into place.
     *
     * Files in the live dir that DON'T have a staging counterpart are
     * preserved untouched — these are user additions and must survive
     * skill upgrades. BAT-699 R8.
     */
    internal fun promoteStaging(root: Path, staging: File, live: File) {
        SafeFs.ensureRealDir(root, live.toPath())
        staging.listFiles()?.forEach { src ->
            val dest = File(live, src.name)
            // BAT-1409 P1-M: lstat-based — a link in staging is never descended into.
            if (SafeFs.isRealDir(src.toPath())) {
                promoteStaging(root, src, dest)
                src.delete()  // remove now-empty staging subdir
            } else {
                if (SafeFs.existsNoFollow(dest.toPath())) SafeFs.deleteTreeNoFollow(root, dest.toPath())
                // BAT-1409 P1-J: a link at dest is replaced by the rename, never followed.
                SafeFs.moveNoFollow(root, src.toPath(), dest.toPath())
            }
        }
    }

    /**
     * Extract version string from YAML frontmatter in a SKILL.md file.
     * Looks for `version: "X.Y.Z"` or `version: X.Y.Z` between `---` delimiters.
     * Returns null if no version found.
     */
    private fun extractVersionFromFrontmatter(content: String): String? {
        val lines = content.lines()
        if (lines.isEmpty() || lines[0].trim() != "---") return null
        for (i in 1 until lines.size) {
            val line = lines[i].trim()
            if (line == "---") break
            if (line.startsWith("version:")) {
                return line.substringAfter("version:").trim().removeSurrounding("\"")
            }
        }
        return null
    }

    /**
     * Seed workspace with example skills from bundled asset files.
     * Uses version-aware logic to update skills on app updates while
     * preserving user-modified skills.
     *
     * Skills are read from `assets/default-skills/<name>/SKILL.md`.
     */
    private fun seedSkills(context: Context, workspaceDir: File) {
        val skillsDir = File(workspaceDir, "skills").apply { mkdirs() }
        val manifestFile = File(workspaceDir, "skills-manifest.json")
        val manifest = loadSkillManifest(manifestFile)

        val assetManager = context.assets
        val defaultSkillDirs = try {
            assetManager.list("default-skills") ?: emptyArray()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to list default-skills assets", e)
            emptyArray()
        }

        for (skillName in defaultSkillDirs) {
            try {
                val content = assetManager.open("default-skills/$skillName/SKILL.md")
                    .bufferedReader().use { it.readText() }

                val version = extractVersionFromFrontmatter(content) ?: "1.0.0"

                seedSkill(context, skillsDir, manifest, skillName, version, content)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to seed skill $skillName from assets", e)
            }
        }

        // Save manifest after all skills are processed
        saveSkillManifest(manifestFile, manifest)
    }

    // ==================== Skill Export ====================

    /**
     * Returns the set of skill directory names tracked in skills-manifest.json
     * (i.e., default/bundled skills). User-added skills are NOT in the manifest.
     */
    fun getDefaultSkillNames(context: Context): Set<String> {
        val manifestFile = File(File(context.filesDir, "workspace"), "skills-manifest.json")
        if (!SafeFs.existsNoFollow(manifestFile.toPath())) return emptySet()
        return try {
            val json = JSONObject(SafeFs.readTextNoFollow(context.filesDir.toPath(), manifestFile.toPath()))
            json.keys().asSequence().toSet()
        } catch (e: Exception) {
            Log.w(TAG, "Failed to read skill manifest for default names", e)
            emptySet()
        }
    }

    /**
     * Returns a map of default skill name → content hash from skills-manifest.json.
     * Used to detect user-modified default skills (hash differs from manifest).
     */
    fun getDefaultSkillHashes(context: Context): Map<String, String> {
        val manifestFile = File(File(context.filesDir, "workspace"), "skills-manifest.json")
        if (!SafeFs.existsNoFollow(manifestFile.toPath())) return emptyMap()
        return try {
            val json = JSONObject(SafeFs.readTextNoFollow(context.filesDir.toPath(), manifestFile.toPath()))
            val result = mutableMapOf<String, String>()
            for (key in json.keys()) {
                val entry = json.getJSONObject(key)
                val hash = entry.optString("hash", "")
                if (hash.isNotEmpty()) result[key] = hash
            }
            result
        } catch (e: Exception) {
            Log.w(TAG, "Failed to read skill manifest hashes", e)
            emptyMap()
        }
    }

    /**
     * Export a single skill as a raw .md file at the given URI.
     * Reads the SKILL.md content and writes it directly — shareable via Telegram.
     */
    fun exportSkill(context: Context, uri: Uri, skillDirName: String): Boolean {
        val skillsDir = File(File(context.filesDir, "workspace"), "skills")
        // BAT-1409 P1-M: only a real (lstat) regular file is exported — never a link's target.
        val skillFile = File(File(skillsDir, skillDirName), "SKILL.md").takeIf { isRegularNoFollow(it) }
            ?: File(skillsDir, "$skillDirName.md").takeIf { isRegularNoFollow(it) }

        if (skillFile == null) {
            Log.e(TAG, "Skill file not found for: $skillDirName")
            return false
        }

        return try {
            val outputStream = context.contentResolver.openOutputStream(uri)
            if (outputStream == null) {
                Log.e(TAG, "Failed to open output stream for skill export")
                return false
            }
            outputStream.use { out ->
                Files.newInputStream(skillFile.toPath(), LinkOption.NOFOLLOW_LINKS).use { it.copyTo(out) }
            }
            Log.i(TAG, "Skill $skillDirName exported as .md")
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to export skill $skillDirName", e)
            false
        }
    }

    /**
     * Export all user-added skills as a ZIP at the given URI.
     * Only includes skills NOT in skills-manifest.json (user-added only).
     */
    fun exportUserSkills(context: Context, uri: Uri): Boolean {
        val workspaceDir = File(context.filesDir, "workspace")
        val skillsDir = File(workspaceDir, "skills")
        if (!skillsDir.exists()) return false

        val defaultNames = getDefaultSkillNames(context)

        // Pre-check: any user skills to export?
        // BAT-1409 P1-M: lstat-based — a link at the top of skills/ is never exported.
        val userEntries = skillsDir.listFiles()?.filter { entry ->
            when {
                SafeFs.isRealDir(entry.toPath()) && entry.name !in defaultNames -> true
                isRegularNoFollow(entry) && entry.name.endsWith(".md") -> true
                else -> false
            }
        } ?: emptyList()
        if (userEntries.isEmpty()) {
            Log.i(TAG, "No user skills to export")
            return false
        }

        return try {
            val outputStream = context.contentResolver.openOutputStream(uri)
            if (outputStream == null) {
                Log.e(TAG, "Failed to open output stream for skills export")
                return false
            }
            outputStream.use { out ->
                ZipOutputStream(out).use { zip ->
                    userEntries.forEach { entry ->
                        if (SafeFs.isRealDir(entry.toPath())) {
                            addDirectoryToZip(zip, entry, skillsDir)
                        } else {
                            zip.putNextEntry(ZipEntry(entry.name))
                            Files.newInputStream(entry.toPath(), LinkOption.NOFOLLOW_LINKS).use { it.copyTo(zip) }
                            zip.closeEntry()
                        }
                    }
                }
            }
            Log.i(TAG, "Exported ${userEntries.size} user skills")
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to export user skills", e)
            false
        }
    }

    private fun addDirectoryToZip(zip: ZipOutputStream, dir: File, baseDir: File) {
        // BAT-1409 P1-M: Files.walk never follows links, and only regular files (lstat) are
        // exported, so a link inside a skill folder cannot pull outside files into the ZIP.
        val base = baseDir.toPath()
        SafeFs.forEachRegularFileNoFollow(dir.toPath()) { path, _ ->
            val relativePath = base.relativize(path).toString().replace("\\", "/")
            zip.putNextEntry(ZipEntry(relativePath))
            Files.newInputStream(path, LinkOption.NOFOLLOW_LINKS).use { it.copyTo(zip) }
            zip.closeEntry()
        }
    }

    /**
     * Import skills from a ZIP or single .md file at the given URI.
     * Detects format by reading first 4 bytes (ZIP magic: PK\x03\x04).
     * Returns count of imported skills, or -1 on error.
     */
    fun importUserSkills(context: Context, uri: Uri): Int {
        val skillsDir = File(File(context.filesDir, "workspace"), "skills").apply { mkdirs() }
        val defaultNames = getDefaultSkillNames(context)

        // Read first 4 bytes to detect format
        val magic = ByteArray(4)
        val bytesRead = try {
            context.contentResolver.openInputStream(uri)?.use { it.read(magic) } ?: 0
        } catch (e: Exception) {
            Log.e(TAG, "Failed to read file for import", e)
            return -1
        }

        val isZip = bytesRead >= 4 &&
            magic[0] == 0x50.toByte() && magic[1] == 0x4B.toByte() &&
            (
                (magic[2] == 0x03.toByte() && magic[3] == 0x04.toByte()) || // Local file header
                (magic[2] == 0x05.toByte() && magic[3] == 0x06.toByte()) || // End of central directory (empty ZIP)
                (magic[2] == 0x07.toByte() && magic[3] == 0x08.toByte())    // Data descriptor
            )

        return if (isZip) {
            importSkillsFromZip(context, uri, skillsDir, defaultNames)
        } else {
            importSkillFromMd(context, uri, skillsDir, defaultNames)
        }
    }

    private fun importSkillsFromZip(context: Context, uri: Uri, skillsDir: File, defaultNames: Set<String>): Int {
        val extractedFiles = mutableListOf<File>()
        val createdDirs = mutableSetOf<File>()
        val importedDirs = mutableSetOf<String>()
        val skippedDefaults = mutableSetOf<String>()

        return try {
            var totalExtracted = 0L

            val inputStream = context.contentResolver.openInputStream(uri)
            if (inputStream == null) {
                Log.e(TAG, "Failed to open input stream for skill import")
                return -1
            }

            inputStream.use { stream ->
                ZipInputStream(stream).use { zip ->
                    var entry = zip.nextEntry
                    while (entry != null) {
                        val entryName = entry.name.replace("\\", "/")
                        val segments = entryName.split("/").filter { it.isNotEmpty() }

                        // Reject path traversal
                        if (segments.any { it == "." || it == ".." }) {
                            Log.w(TAG, "Skipping suspicious entry: $entryName")
                            zip.closeEntry()
                            entry = zip.nextEntry
                            continue
                        }

                        if (segments.isEmpty()) {
                            zip.closeEntry()
                            entry = zip.nextEntry
                            continue
                        }

                        // Skip entries that would overwrite bundled/default skills
                        // Check both directory name and root-level .md filename without extension
                        val skillKey = if (segments.size == 1 && segments[0].endsWith(".md"))
                            segments[0].removeSuffix(".md") else segments[0]
                        if (skillKey in defaultNames) {
                            skippedDefaults.add(skillKey)
                            zip.closeEntry()
                            entry = zip.nextEntry
                            continue
                        }

                        val destFile = File(skillsDir, segments.joinToString("/"))

                        // Security: ensure destination stays within skills dir
                        if (!destFile.canonicalPath.startsWith(skillsDir.canonicalPath)) {
                            Log.w(TAG, "Skipping entry outside skills dir: $entryName")
                            zip.closeEntry()
                            entry = zip.nextEntry
                            continue
                        }

                        // Track top-level skill name for count (after validation)
                        importedDirs.add(segments[0])

                        // BAT-1409 P1-J: directories and files are created without following a
                        // link at any depth; an over-limit entry never replaces the target (the
                        // staged temp file is discarded).
                        if (entry.isDirectory) {
                            trackNewDirs(destFile, skillsDir, createdDirs)
                            SafeFs.ensureRealDir(context.filesDir.toPath(), destFile.toPath())
                        } else {
                            destFile.parentFile?.let { parent -> trackNewDirs(parent, skillsDir, createdDirs) }
                            SafeFs.writeAtomicFrom(context.filesDir.toPath(), destFile.toPath()) { out ->
                                val buffer = ByteArray(8192)
                                var read: Int
                                while (zip.read(buffer).also { read = it } != -1) {
                                    totalExtracted += read
                                    if (totalExtracted > IMPORT_MAX_BYTES) {
                                        throw IllegalStateException("Import exceeds ${IMPORT_MAX_BYTES / 1024 / 1024}MB limit")
                                    }
                                    out.write(buffer, 0, read)
                                }
                            }
                            extractedFiles.add(destFile)
                        }

                        zip.closeEntry()
                        entry = zip.nextEntry
                    }
                }
            }

            if (skippedDefaults.isNotEmpty()) {
                Log.w(TAG, "Skipped ${skippedDefaults.size} default skills: $skippedDefaults")
            }
            val count = importedDirs.size
            Log.i(TAG, "Imported $count skills from ZIP (${totalExtracted / 1024}KB)")
            count
        } catch (e: Exception) {
            Log.e(TAG, "Failed to import skills from ZIP: ${e.message}", e)
            for (file in extractedFiles) {
                try { file.delete() } catch (_: Exception) {}
            }
            for (dir in createdDirs.sortedByDescending { it.path.length }) {
                try { if (dir.exists() && dir.list().isNullOrEmpty()) dir.delete() } catch (_: Exception) {}
            }
            -1
        }
    }

    private fun importSkillFromMd(context: Context, uri: Uri, skillsDir: File, defaultNames: Set<String>): Int {
        return try {
            val inputStream = context.contentResolver.openInputStream(uri)
            if (inputStream == null) {
                Log.e(TAG, "Failed to open input stream for .md skill import")
                return -1
            }

            val bytes = inputStream.use { it.readBytes() }
            if (bytes.size > SKILL_IMPORT_MAX_BYTES) {
                Log.e(TAG, "Skill file exceeds ${SKILL_IMPORT_MAX_BYTES / 1024 / 1024}MB limit (${bytes.size / 1024}KB)")
                return -1
            }

            val content = bytes.toString(Charsets.UTF_8)
            if (content.isBlank()) return -1

            // Try to extract skill name from frontmatter or heading
            val name = extractSkillNameFromContent(content)

            // Reject imports that would overwrite a bundled/default skill
            if (name != null && name in defaultNames) {
                Log.w(TAG, "Skipping import: '$name' is a default skill")
                return 0
            }

            if (name != null) {
                // Create directory-based skill: skills/<name>/SKILL.md
                val skillDir = File(skillsDir, name)
                SafeFs.writeAtomicText(context.filesDir.toPath(), File(skillDir, "SKILL.md").toPath(), content)
            } else {
                // Save as flat file: skills/imported_<timestamp>.md
                val timestamp = System.currentTimeMillis()
                SafeFs.writeAtomicText(context.filesDir.toPath(), File(skillsDir, "imported_$timestamp.md").toPath(), content)
            }

            Log.i(TAG, "Imported 1 skill from .md file (name: ${name ?: "unnamed"})")
            1
        } catch (e: Exception) {
            Log.e(TAG, "Failed to import skill from .md: ${e.message}", e)
            -1
        }
    }

    private fun extractSkillNameFromContent(content: String): String? {
        // Try frontmatter name field
        if (content.startsWith("---")) {
            val endIdx = content.indexOf("---", 3)
            if (endIdx > 0) {
                val fmLines = content.substring(3, endIdx).lines()
                for (line in fmLines) {
                    val trimmed = line.trim()
                    if (trimmed.startsWith("name:")) {
                        val name = trimmed.substringAfter("name:").trim()
                            .removeSurrounding("\"").removeSurrounding("'").trim()
                        if (name.isNotEmpty()) return name.lowercase(Locale.ROOT).replace(Regex("[^a-z0-9_-]"), "-")
                    }
                }
            }
        }
        // Try first # heading
        val headingLine = content.lines().firstOrNull { it.startsWith("# ") }
        if (headingLine != null) {
            val name = headingLine.substring(2).trim()
            if (name.isNotEmpty()) return name.lowercase(Locale.ROOT).replace(Regex("[^a-z0-9_-]"), "-")
        }
        return null
    }

    /** Track all non-existent ancestor directories under [root] for rollback. */
    private fun trackNewDirs(dir: File, root: File, createdDirs: MutableSet<File>) {
        var current: File? = dir
        while (current != null && !current.exists() &&
            current.canonicalPath.startsWith(root.canonicalPath)
        ) {
            createdDirs.add(current)
            current = current.parentFile
        }
    }

    /**
     * Delete workspace memory files (MEMORY.md + memory/ directory).
     */
    fun clearMemory(context: Context) = clearMemory(context.filesDir.toPath())

    /** [clearMemory] on the app's `filesDir` ([filesRoot]): the filesystem part, Context-free. */
    internal fun clearMemory(filesRoot: Path) {
        val workspaceDir = filesRoot.resolve("workspace")
        workspaceDir.resolve("MEMORY.md").apply {
            // BAT-1409 P1-J: rewritten atomically, never through a link.
            if (SafeFs.existsNoFollow(this)) {
                try {
                    SafeFs.writeAtomicText(filesRoot, this, "")
                } catch (e: Exception) {
                    Log.e(TAG, "Could not clear MEMORY.md: ${e.message}")
                }
            }
        }
        workspaceDir.resolve("memory").apply {
            // BAT-1409 P1-M: no-follow delete; a linked memory/ is unlinked, never descended.
            deleteNoFollow(filesRoot, this)
            try {
                SafeFs.ensureRealDir(filesRoot, this)
            } catch (e: Exception) {
                Log.e(TAG, "Could not recreate memory/: ${e.message}")
            }
        }
    }

    /**
     * BAT-1409 P1-M — the no-follow recursive delete for ConfigManager. Never follows a link at
     * any depth (see [SafeFs.deleteTreeNoFollow]). Returns false, logged, when the ancestor rule
     * refuses the path or entries remain.
     */
    private fun deleteNoFollow(context: Context, target: File): Boolean =
        deleteNoFollow(context.filesDir.toPath(), target.toPath())

    private fun deleteNoFollow(root: Path, target: Path): Boolean = try {
        val result = SafeFs.deleteTreeNoFollow(root, target)
        if (!result.clean) Log.w(TAG, "No-follow delete left ${result.residue} entries under ${target.fileName}")
        result.clean
    } catch (e: Exception) {
        Log.e(TAG, "No-follow delete refused for ${target.fileName}: ${e.message}")
        false
    }

    /**
     * BAT-1409 P1-J: the workspace directory, created and validated without following links.
     * Never throws (like the `mkdirs()` it replaces): a refusal is logged, and the SafeFs write
     * that follows enforces the ancestor rule again and fails on its own terms.
     */
    private fun ensureWorkspaceDir(context: Context): File {
        val ws = File(context.filesDir, "workspace")
        try {
            SafeFs.ensureRealDir(context.filesDir.toPath(), ws.toPath())
        } catch (e: Exception) {
            LogCollector.append("[Config] workspace directory refused: ${e.message}", LogLevel.ERROR)
        }
        return ws
    }

    /** BAT-1409 P1-J: [SafeFs.ensureRealDir] as a boolean, logged on refusal. */
    private fun ensureRealDirOk(context: Context, dir: File): Boolean = try {
        SafeFs.ensureRealDir(context.filesDir.toPath(), dir.toPath())
        true
    } catch (e: Exception) {
        Log.e(TAG, "Could not create ${dir.name}: ${e.message}")
        false
    }

    /** BAT-1409 P1-J: writes a seed file atomically, never through a link. */
    private fun seedText(context: Context, file: File, text: String) {
        SafeFs.writeAtomicText(context.filesDir.toPath(), file.toPath(), text)
    }

    /** BAT-1409 P1-M: true only for a regular file at the final component (a link is false). */
    private fun isRegularNoFollow(file: File): Boolean =
        Files.isRegularFile(file.toPath(), LinkOption.NOFOLLOW_LINKS)

    // ==================== Memory Export/Import ====================

    private const val TAG = "ConfigManager"

    /** Max total uncompressed size to extract from a backup ZIP (50 MB). */
    private const val IMPORT_MAX_BYTES = 50L * 1024 * 1024

    /** Max size for a single .md skill import (5 MB). */
    private const val SKILL_IMPORT_MAX_BYTES = 5L * 1024 * 1024

    /**
     * Allowlist of exact files and directory prefixes for export/import.
     * Everything else in workspace/ is excluded (DB, state files, media, logs, etc.).
     */
    private val EXPORT_ALLOW_FILES = setOf(
        "SOUL.md", "MEMORY.md", "IDENTITY.md", "USER.md",
        "HEARTBEAT.md", "BOOTSTRAP.md", "cron/jobs.json",
    )
    private val EXPORT_ALLOW_DIR_PREFIXES = listOf(
        "memory/", "skills/",
    )

    /** Returns true if the relative path is on the export/import allowlist. */
    private fun isAllowedPath(relativePath: String): Boolean {
        // Split into segments and reject any ".." or "." to prevent traversal tricks
        val segments = relativePath.replace("\\", "/").split("/").filter { it.isNotEmpty() }
        if (segments.isEmpty()) return false
        if (segments.any { it == "." || it == ".." }) return false
        val normalized = segments.joinToString("/")
        if (normalized in EXPORT_ALLOW_FILES) return true
        return EXPORT_ALLOW_DIR_PREFIXES.any { normalized.startsWith(it) }
    }

    /**
     * Export workspace memory to a ZIP file at the given URI.
     * Only includes allowlisted files: personality (.md files), memory/, skills/, cron/jobs.json.
     * Excludes: DB, media, state files, config, logs, wallet, and all other transient data.
     */
    fun exportMemory(context: Context, uri: Uri): Boolean {
        val workspaceDir = File(context.filesDir, "workspace")
        if (!workspaceDir.exists()) {
            Log.e(TAG, "Workspace directory does not exist")
            return false
        }

        return try {
            context.contentResolver.openOutputStream(uri)?.use { outputStream ->
                ZipOutputStream(outputStream).use { zip ->
                    addAllowedFilesToZip(zip, workspaceDir, workspaceDir)
                }
            }
            Log.i(TAG, "Memory exported successfully")
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to export memory", e)
            false
        }
    }

    private fun addAllowedFilesToZip(zip: ZipOutputStream, dir: File, baseDir: File) {
        val files = dir.listFiles() ?: return
        for (file in files) {
            // BAT-1409 P1-M: never follow a link out of the workspace into the export.
            if (Files.isSymbolicLink(file.toPath())) continue
            val relativePath = file.relativeTo(baseDir).path.replace("\\", "/")

            if (file.isDirectory) {
                // Only recurse into directories that could contain allowed paths
                val dirPrefix = "$relativePath/"
                val hasAllowedChildren = EXPORT_ALLOW_DIR_PREFIXES.any {
                    it.startsWith(dirPrefix) || dirPrefix.startsWith(it)
                } || EXPORT_ALLOW_FILES.any { it.startsWith(dirPrefix) }
                if (hasAllowedChildren) {
                    addAllowedFilesToZip(zip, file, baseDir)
                }
            } else if (isAllowedPath(relativePath)) {
                zip.putNextEntry(ZipEntry(relativePath))
                file.inputStream().use { it.copyTo(zip) }
                zip.closeEntry()
            }
        }
    }

    /**
     * Import workspace memory from a ZIP file at the given URI.
     * Auto-creates a safety backup before importing.
     * Only extracts allowlisted paths; enforces 50 MB total size cap.
     */
    fun importMemory(context: Context, uri: Uri): Boolean {
        val workspaceDir = ensureWorkspaceDir(context)

        // Auto-backup current state before overwriting (keeps last backup only)
        try {
            val backupFile = File(File(context.filesDir, "backup"), "pre_import_backup.zip")
            // BAT-1409 P1-J: the backup is written without following a link at any depth.
            SafeFs.writeAtomicFrom(context.filesDir.toPath(), backupFile.toPath()) { outputStream ->
                val zip = ZipOutputStream(outputStream)
                addAllowedFilesToZip(zip, workspaceDir, workspaceDir)
                zip.finish()
            }
            Log.i(TAG, "Pre-import backup created: ${backupFile.absolutePath}")
        } catch (e: Exception) {
            Log.w(TAG, "Failed to create pre-import backup: ${e.message}")
            // Continue with import — backup failure shouldn't block restore
        }

        val extractedFiles = mutableListOf<File>()

        return try {
            var totalExtracted = 0L
            var hasValidMarker = false

            context.contentResolver.openInputStream(uri)?.use { inputStream ->
                // First pass: validate the ZIP contains at least one expected file
                ZipInputStream(inputStream).use { zip ->
                    var entry = zip.nextEntry
                    while (entry != null) {
                        val name = entry.name
                        if (name == "SOUL.md" || name == "MEMORY.md") {
                            hasValidMarker = true
                            break
                        }
                        zip.closeEntry()
                        entry = zip.nextEntry
                    }
                }
            }

            if (!hasValidMarker) {
                Log.e(TAG, "ZIP does not contain SOUL.md or MEMORY.md — not a valid backup")
                return false
            }

            // Second pass: extract allowlisted files
            context.contentResolver.openInputStream(uri)?.use { inputStream ->
                ZipInputStream(inputStream).use { zip ->
                    var entry = zip.nextEntry
                    while (entry != null) {
                        val entryName = entry.name

                        // Only extract allowlisted paths
                        if (!isAllowedPath(entryName)) {
                            zip.closeEntry()
                            entry = zip.nextEntry
                            continue
                        }

                        val destFile = File(workspaceDir, entryName)

                        // Security: prevent path traversal
                        if (!destFile.canonicalPath.startsWith(workspaceDir.canonicalPath)) {
                            Log.w(TAG, "Skipping suspicious entry: $entryName")
                            zip.closeEntry()
                            entry = zip.nextEntry
                            continue
                        }

                        // BAT-1409 P1-J: no-follow directory creation and atomic file writes; an
                        // over-limit entry never replaces the target.
                        if (entry.isDirectory) {
                            SafeFs.ensureRealDir(context.filesDir.toPath(), destFile.toPath())
                        } else {
                            // Enforce total size cap
                            SafeFs.writeAtomicFrom(context.filesDir.toPath(), destFile.toPath()) { out ->
                                val buffer = ByteArray(8192)
                                var bytesRead: Int
                                while (zip.read(buffer).also { bytesRead = it } != -1) {
                                    totalExtracted += bytesRead
                                    if (totalExtracted > IMPORT_MAX_BYTES) {
                                        throw IllegalStateException(
                                            "Backup exceeds ${IMPORT_MAX_BYTES / 1024 / 1024}MB limit"
                                        )
                                    }
                                    out.write(buffer, 0, bytesRead)
                                }
                            }
                            extractedFiles.add(destFile)
                        }

                        zip.closeEntry()
                        entry = zip.nextEntry
                    }
                }
            }
            Log.i(TAG, "Memory imported successfully (${totalExtracted / 1024}KB extracted)")
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to import memory: ${e.message}", e)
            // Rollback: delete all files extracted during this failed import
            for (file in extractedFiles) {
                try { file.delete() } catch (ex: Exception) {
                    Log.w(TAG, "Rollback: failed to delete ${file.path}: ${ex.message}")
                }
            }
            false
        }
    }
}
