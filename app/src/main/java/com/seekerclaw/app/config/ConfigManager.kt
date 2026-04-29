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
import androidx.compose.runtime.mutableIntStateOf
import androidx.core.content.ContextCompat
import com.seekerclaw.app.BuildConfig
import com.seekerclaw.app.state.RuntimeState
import com.seekerclaw.app.state.RuntimeStateStore
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
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
) {
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

    private const val PREFS_NAME = "seekerclaw_prefs"
    private const val KEY_API_KEY_ENC = "api_key_enc"
    private const val KEY_BOT_TOKEN_ENC = "bot_token_enc"
    private const val KEY_OWNER_ID = "owner_id"
    private const val KEY_MODEL = "model"
    private const val KEY_AGENT_NAME = "agent_name"
    private const val KEY_AUTO_START = "auto_start_on_boot"
    private const val KEY_KEEP_SCREEN_ON = "keep_screen_on"
    private const val KEY_SETUP_COMPLETE = "setup_complete"
    private const val KEY_AUTH_TYPE = "auth_type"
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
    private const val KEY_PROVIDER = "provider"
    private const val KEY_OPENAI_API_KEY_ENC = "openai_api_key_enc"
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

    // Email migration is a true one-shot: legacy plaintext key is consumed exactly once
    // and the encrypted form persists thereafter. Process flag avoids re-checking the
    // legacy key on every loadConfig() call.
    @Volatile
    private var emailMigrated = false

    private fun resolveAuthType(p: SharedPreferences): String {
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
        // write time (writeConfigJson) so Node never sees it.
        val raw = p.getString(KEY_AUTH_TYPE, "api_key") ?: "api_key"
        val provider = p.getString(KEY_PROVIDER, "claude") ?: "claude"
        val normalized = when {
            provider == "openai" && raw != "oauth" && raw != "api_key" -> "api_key"
            provider != "claude" && raw == "setup_token" -> "api_key"
            else -> raw
        }
        if (normalized != raw) {
            Log.w(TAG, "Normalizing authType '$raw' → '$normalized' (provider=$provider)")
            p.edit().putString(KEY_AUTH_TYPE, normalized).apply()
        }
        return normalized
    }
    private const val KEY_OPENAI_OAUTH_EXPIRES_AT = "openai_oauth_expires_at"

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun isSetupComplete(context: Context): Boolean =
        prefs(context).getBoolean(KEY_SETUP_COMPLETE, false)

    fun markSetupSkipped(context: Context) {
        prefs(context).edit()
            .putBoolean(KEY_SETUP_COMPLETE, true)
            .apply()
    }

    fun hasUserEverDeployed(context: Context): Boolean =
        prefs(context).getBoolean(KEY_FIRST_DEPLOY_DONE, false)

    fun markFirstDeploymentDone(context: Context) {
        prefs(context).edit()
            .putBoolean(KEY_FIRST_DEPLOY_DONE, true)
            .apply()
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
     */
    fun saveConfig(context: Context, config: AppConfig): Boolean {
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
        val sp = prefs(context)
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

        val encApiKey = KeystoreHelper.encrypt(config.anthropicApiKey)
        val encBotToken = KeystoreHelper.encrypt(config.telegramBotToken)

        val editor = sp.edit()
            .putString(KEY_API_KEY_ENC, Base64.encodeToString(encApiKey, Base64.NO_WRAP))
            .putString(KEY_BOT_TOKEN_ENC, Base64.encodeToString(encBotToken, Base64.NO_WRAP))
            .putString(KEY_OWNER_ID, config.telegramOwnerId)
            .putString(KEY_MODEL, config.model)
            .putString(KEY_AGENT_NAME, config.agentName)
            .putString(KEY_AUTH_TYPE, config.authType)
            .putBoolean(KEY_AUTO_START, config.autoStartOnBoot)
            .putInt(KEY_HEARTBEAT_INTERVAL, config.heartbeatIntervalMinutes)
            .putInt(KEY_MAX_STEPS_PER_TURN, config.maxStepsPerTurn)
            .putBoolean(KEY_SETUP_COMPLETE, true)

        // Store setup token separately so switching auth type preserves both
        if (config.setupToken.isNotBlank()) {
            val encSetupToken = KeystoreHelper.encrypt(config.setupToken)
            editor.putString(KEY_SETUP_TOKEN_ENC, Base64.encodeToString(encSetupToken, Base64.NO_WRAP))
        } else {
            editor.remove(KEY_SETUP_TOKEN_ENC)
        }

        if (config.braveApiKey.isNotBlank()) {
            val encBrave = KeystoreHelper.encrypt(config.braveApiKey)
            editor.putString(KEY_BRAVE_API_KEY_ENC, Base64.encodeToString(encBrave, Base64.NO_WRAP))
        } else {
            editor.remove(KEY_BRAVE_API_KEY_ENC)
        }

        editor.putString(KEY_SEARCH_PROVIDER, config.searchProvider)

        if (config.perplexityApiKey.isNotBlank()) {
            val encPerplexity = KeystoreHelper.encrypt(config.perplexityApiKey)
            editor.putString(KEY_PERPLEXITY_API_KEY_ENC, Base64.encodeToString(encPerplexity, Base64.NO_WRAP))
        } else {
            editor.remove(KEY_PERPLEXITY_API_KEY_ENC)
        }

        if (config.exaApiKey.isNotBlank()) {
            val encExa = KeystoreHelper.encrypt(config.exaApiKey)
            editor.putString(KEY_EXA_API_KEY_ENC, Base64.encodeToString(encExa, Base64.NO_WRAP))
        } else {
            editor.remove(KEY_EXA_API_KEY_ENC)
        }

        if (config.tavilyApiKey.isNotBlank()) {
            val encTavily = KeystoreHelper.encrypt(config.tavilyApiKey)
            editor.putString(KEY_TAVILY_API_KEY_ENC, Base64.encodeToString(encTavily, Base64.NO_WRAP))
        } else {
            editor.remove(KEY_TAVILY_API_KEY_ENC)
        }

        if (config.firecrawlApiKey.isNotBlank()) {
            val encFirecrawl = KeystoreHelper.encrypt(config.firecrawlApiKey)
            editor.putString(KEY_FIRECRAWL_API_KEY_ENC, Base64.encodeToString(encFirecrawl, Base64.NO_WRAP))
        } else {
            editor.remove(KEY_FIRECRAWL_API_KEY_ENC)
        }

        if (config.jupiterApiKey.isNotBlank()) {
            val encJupiter = KeystoreHelper.encrypt(config.jupiterApiKey)
            editor.putString(KEY_JUPITER_API_KEY_ENC, Base64.encodeToString(encJupiter, Base64.NO_WRAP))
        } else {
            editor.remove(KEY_JUPITER_API_KEY_ENC)
        }

        if (config.heliusApiKey.isNotBlank()) {
            val encHelius = KeystoreHelper.encrypt(config.heliusApiKey)
            editor.putString(KEY_HELIUS_API_KEY_ENC, Base64.encodeToString(encHelius, Base64.NO_WRAP))
        } else {
            editor.remove(KEY_HELIUS_API_KEY_ENC)
        }

        editor.putString(KEY_PROVIDER, config.provider)

        if (config.openaiApiKey.isNotBlank()) {
            val encOpenai = KeystoreHelper.encrypt(config.openaiApiKey)
            editor.putString(KEY_OPENAI_API_KEY_ENC, Base64.encodeToString(encOpenai, Base64.NO_WRAP))
        } else {
            editor.remove(KEY_OPENAI_API_KEY_ENC)
        }

        if (config.openrouterApiKey.isNotBlank()) {
            val encOpenRouter = KeystoreHelper.encrypt(config.openrouterApiKey)
            editor.putString(KEY_OPENROUTER_API_KEY_ENC, Base64.encodeToString(encOpenRouter, Base64.NO_WRAP))
        } else {
            editor.remove(KEY_OPENROUTER_API_KEY_ENC)
        }
        editor.putString(KEY_OPENROUTER_FALLBACK_MODEL, config.openrouterFallbackModel)
        editor.putString(KEY_OPENROUTER_MODEL_CONTEXT, config.openrouterModelContext)
        editor.putString(KEY_OPENROUTER_FALLBACK_CONTEXT, config.openrouterFallbackContext)

        if (config.customApiKey.isNotBlank()) {
            val encCustom = KeystoreHelper.encrypt(config.customApiKey)
            editor.putString(KEY_CUSTOM_API_KEY_ENC, Base64.encodeToString(encCustom, Base64.NO_WRAP))
        } else {
            editor.remove(KEY_CUSTOM_API_KEY_ENC)
        }
        editor.putString(KEY_CUSTOM_BASE_URL, config.customBaseUrl)
        if (config.customHeaders.isNotBlank()) {
            val encHeaders = KeystoreHelper.encrypt(config.customHeaders)
            editor.putString(KEY_CUSTOM_HEADERS_ENC, Base64.encodeToString(encHeaders, Base64.NO_WRAP))
        } else {
            editor.remove(KEY_CUSTOM_HEADERS_ENC)
        }
        editor.putString(KEY_CUSTOM_FORMAT, config.customFormat)

        editor.putString(KEY_CHANNEL, config.channel)
        if (config.discordBotToken.isNotBlank()) {
            val encDiscord = KeystoreHelper.encrypt(config.discordBotToken)
            editor.putString(KEY_DISCORD_BOT_TOKEN_ENC, Base64.encodeToString(encDiscord, Base64.NO_WRAP))
        } else {
            editor.remove(KEY_DISCORD_BOT_TOKEN_ENC)
        }
        editor.putString(KEY_DISCORD_OWNER_ID, config.discordOwnerId)

        if (config.openaiOAuthToken.isNotBlank()) {
            val encOAuthToken = KeystoreHelper.encrypt(config.openaiOAuthToken)
            editor.putString(KEY_OPENAI_OAUTH_TOKEN_ENC, Base64.encodeToString(encOAuthToken, Base64.NO_WRAP))
        } else {
            editor.remove(KEY_OPENAI_OAUTH_TOKEN_ENC)
        }
        if (config.openaiOAuthRefresh.isNotBlank()) {
            val encOAuthRefresh = KeystoreHelper.encrypt(config.openaiOAuthRefresh)
            editor.putString(KEY_OPENAI_OAUTH_REFRESH_ENC, Base64.encodeToString(encOAuthRefresh, Base64.NO_WRAP))
        } else {
            editor.remove(KEY_OPENAI_OAUTH_REFRESH_ENC)
        }
        if (config.openaiOAuthEmail.isNotBlank()) {
            // Email is PII — encrypt at rest like other OAuth fields.
            val encEmail = KeystoreHelper.encrypt(config.openaiOAuthEmail)
            editor.putString(KEY_OPENAI_OAUTH_EMAIL_ENC, Base64.encodeToString(encEmail, Base64.NO_WRAP))
        } else {
            editor.remove(KEY_OPENAI_OAUTH_EMAIL_ENC)
        }
        editor.putString(KEY_OPENAI_OAUTH_EXPIRES_AT, config.openaiOAuthExpiresAt)

        val persisted = editor.commit()
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
        val runtimeWritten = if (RuntimeStateStore.isInitialized) try {
            RuntimeStateStore.write(
                RuntimeState(
                    provider = config.provider,
                    authType = config.authType,
                    model = config.model,
                ),
            )
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
            val rollback = sp.edit()
            if (oldProvider != null) rollback.putString(KEY_PROVIDER, oldProvider)
            else rollback.remove(KEY_PROVIDER)
            if (oldAuthType != null) rollback.putString(KEY_AUTH_TYPE, oldAuthType)
            else rollback.remove(KEY_AUTH_TYPE)
            if (oldModel != null) rollback.putString(KEY_MODEL, oldModel)
            else rollback.remove(KEY_MODEL)
            rollback.putBoolean(KEY_SETUP_COMPLETE, oldSetupComplete)
            val rollbackOk = rollback.commit()
            if (!rollbackOk) {
                // Synchronous commit failed (rare — usually means the
                // disk is genuinely full). Log loudly; the partial
                // rollback may have landed depending on which fields
                // SharedPreferences flushed before failing. The caller
                // still gets `false` so the UI surfaces the failure.
                LogCollector.append(
                    "[Config] Rollback commit() returned false — prefs may be in inconsistent state " +
                        "(some runtime fields possibly half-rolled-back)",
                    LogLevel.ERROR,
                )
            }
            // Bump configVersion AGAIN so the UI recomposes with the
            // rolled-back runtime fields (it already recomposed once
            // post-commit with the failed-but-persisted values; a
            // second bump corrects the snapshot).
            bumpConfigVersionOnMain()
            LogCollector.append(
                "[Config] RuntimeStateStore.write failed — rolled back prefs runtime fields " +
                    "to (provider=$oldProvider, authType=$oldAuthType, model=$oldModel) " +
                    "and KEY_SETUP_COMPLETE to $oldSetupComplete (commit_ok=$rollbackOk)",
                LogLevel.WARN,
            )
            return false
        }
        // BAT-513 round-9: write the overlay AND broadcast the change
        // ONLY after both prefs commit + RuntimeStateStore.write
        // succeeded. The overlay persists provider/authType/model too;
        // writing it before the runtime-state write would mean a
        // failure-path rollback would also need to revert the
        // overlay (and the next loadConfig's reconcileWithAgentSettings
        // would re-adopt the unreverted overlay back into prefs).
        // Deferring keeps all three persistent stores (prefs, overlay,
        // runtime_state.json) atomic at the runtime-fields level —
        // either all updated together or all left at the prior values.
        //
        // configOverride=config: skip the loadConfig round-trip
        // writeAgentSettingsJson would otherwise do, which would
        // re-trigger reconcile (PR #339 device-test regression fix).
        writeAgentSettingsJson(context, configOverride = config)
        // Notify the OTHER process — main-process UI relies on this
        // to refresh after :node-process writes (e.g. /provider
        // Telegram switch's service-start reconcile). Same-process
        // observers already saw the configVersion bump above.
        broadcastConfigChanged(context)
        return true
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
        return loadConfigUnchecked(context)
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
    fun loadConfigOrBootstrap(context: Context): AppConfig = loadConfigUnchecked(context)

    private fun loadConfigUnchecked(context: Context): AppConfig {
        val p = prefs(context)

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

        val openaiApiKey = try {
            val enc = p.getString(KEY_OPENAI_API_KEY_ENC, null)
            if (enc != null) KeystoreHelper.decrypt(Base64.decode(enc, Base64.NO_WRAP)) else ""
        } catch (e: Exception) {
            Log.w(TAG, "Failed to decrypt OpenAI API key", e)
            LogCollector.append("[Config] Failed to decrypt OpenAI API key: ${e.javaClass.simpleName}", LogLevel.ERROR)
            ""
        }

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

        val openaiOAuthToken = try {
            val enc = p.getString(KEY_OPENAI_OAUTH_TOKEN_ENC, null)
            if (enc != null) KeystoreHelper.decrypt(Base64.decode(enc, Base64.NO_WRAP)) else ""
        } catch (e: Exception) {
            Log.w(TAG, "Failed to decrypt OpenAI OAuth token", e)
            LogCollector.append("[Config] Failed to decrypt OpenAI OAuth token: ${e.javaClass.simpleName}", LogLevel.ERROR)
            ""
        }

        val openaiOAuthRefresh = try {
            val enc = p.getString(KEY_OPENAI_OAUTH_REFRESH_ENC, null)
            if (enc != null) KeystoreHelper.decrypt(Base64.decode(enc, Base64.NO_WRAP)) else ""
        } catch (e: Exception) {
            Log.w(TAG, "Failed to decrypt OpenAI OAuth refresh token", e)
            LogCollector.append("[Config] Failed to decrypt OpenAI OAuth refresh token: ${e.javaClass.simpleName}", LogLevel.ERROR)
            ""
        }

        val openaiOAuthEmail = try {
            val enc = p.getString(KEY_OPENAI_OAUTH_EMAIL_ENC, null)
            if (enc != null) {
                KeystoreHelper.decrypt(Base64.decode(enc, Base64.NO_WRAP))
            } else if (!emailMigrated) {
                // One-time per-process migration: pull any legacy plaintext value, persist
                // it encrypted under the new key, then drop the old key. Gated by the
                // emailMigrated flag so subsequent loadConfig() calls don't re-touch prefs.
                val legacy = p.getString("openai_oauth_email", "") ?: ""
                if (legacy.isNotBlank()) {
                    val encLegacy = KeystoreHelper.encrypt(legacy)
                    p.edit()
                        .putString(KEY_OPENAI_OAUTH_EMAIL_ENC, Base64.encodeToString(encLegacy, Base64.NO_WRAP))
                        .remove("openai_oauth_email")
                        .apply()
                }
                emailMigrated = true
                legacy
            } else {
                ""
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to decrypt OpenAI OAuth email", e)
            LogCollector.append("[Config] Failed to decrypt OpenAI OAuth email: ${e.javaClass.simpleName}", LogLevel.ERROR)
            ""
        }

        val fromPrefs = AppConfig(
            anthropicApiKey = apiKey,
            setupToken = setupToken,
            authType = resolveAuthType(p),
            telegramBotToken = botToken,
            telegramOwnerId = loadOwnerIdFromFile(context, "telegram"),
            model = p.getString(KEY_MODEL, "claude-opus-4-7") ?: "claude-opus-4-7",
            agentName = p.getString(KEY_AGENT_NAME, "MyAgent") ?: "MyAgent",
            braveApiKey = braveApiKey,
            searchProvider = p.getString(KEY_SEARCH_PROVIDER, "brave") ?: "brave",
            perplexityApiKey = perplexityApiKey,
            exaApiKey = exaApiKey,
            tavilyApiKey = tavilyApiKey,
            firecrawlApiKey = firecrawlApiKey,
            jupiterApiKey = jupiterApiKey,
            heliusApiKey = heliusApiKey,
            autoStartOnBoot = p.getBoolean(KEY_AUTO_START, true),
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
            openaiOAuthToken = openaiOAuthToken,
            openaiOAuthRefresh = openaiOAuthRefresh,
            openaiOAuthEmail = openaiOAuthEmail,
            openaiOAuthExpiresAt = p.getString(KEY_OPENAI_OAUTH_EXPIRES_AT, "") ?: "",
        )

        // Reconcile with agent_settings.json so TG-initiated changes (via
        // `/model` and `/provider` slash commands) survive a service
        // restart. Node writes provider/authType/model directly to this
        // file; we adopt them here and mirror back to SharedPreferences so
        // the next loadConfig reads a consistent state.
        return reconcileWithAgentSettings(context, p, fromPrefs)
    }

    private fun reconcileWithAgentSettings(
        context: Context,
        prefs: android.content.SharedPreferences,
        fromPrefs: AppConfig,
    ): AppConfig {
        val settingsFile = File(File(context.filesDir, "workspace"), "agent_settings.json")
        if (!settingsFile.exists()) return fromPrefs
        val json = try {
            JSONObject(settingsFile.readText())
        } catch (e: Exception) {
            LogCollector.append("[Config] agent_settings.json unreadable (${e.message}) — skipping reconciliation", LogLevel.WARN)
            return fromPrefs
        }

        // Use opt() + cast rather than optString() — optString() coerces
        // non-string JSON values (numbers, booleans, nested objects) into
        // strings via .toString(), which would silently adopt a corrupted
        // or tampered agent_settings.json value into SharedPreferences.
        // Reject non-String values up front.
        fun stringField(key: String): String? {
            val raw = json.opt(key) ?: return null
            val v = (raw as? String)?.trim() ?: return null
            return if (v.isBlank()) null else v
        }

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
        // Auth changes matter too: OpenAI's oauth model list includes
        // gpt-5.4-mini but the api_key list doesn't, so switching oauth→
        // api_key on OpenAI must revalidate prefs.model against the new
        // auth mode's allowlist even when provider stays the same.
        val resolvedModel: String = when {
            newModel != null -> {
                // Overlay model present — validate; substitute default if invalid.
                if (isModelValidForProvider(effectiveProviderAfter, effectiveAuthAfter, newModel)) {
                    newModel
                } else {
                    val providerDefault = defaultModelForProvider(effectiveProviderAfter, effectiveAuthAfter)
                    if (providerDefault.isNotBlank()) providerDefault else newModel
                }
            }
            providerChanged || authChanged -> {
                // No overlay model but provider or auth changed — validate
                // prefs.model against the NEW effective provider+auth.
                if (isModelValidForProvider(effectiveProviderAfter, effectiveAuthAfter, fromPrefs.model)) {
                    fromPrefs.model
                } else {
                    val providerDefault = defaultModelForProvider(effectiveProviderAfter, effectiveAuthAfter)
                    if (providerDefault.isNotBlank()) providerDefault else fromPrefs.model
                }
            }
            else -> fromPrefs.model
        }
        val modelChanged = resolvedModel != fromPrefs.model

        if (!providerChanged && !authChanged && !modelChanged) return fromPrefs

        val editor = prefs.edit()
        if (providerChanged) editor.putString(KEY_PROVIDER, validProvider)
        if (authChanged) editor.putString(KEY_AUTH_TYPE, validAuthType)
        if (modelChanged) editor.putString(KEY_MODEL, resolvedModel)
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
        editor.commit()

        // Bump same-process configVersion so any in-process UI observer
        // recomposes. /provider Telegram → :node service-start reconcile
        // is the canonical path here, where :node's ConfigManager.
        // configVersion bumps but main-process UI needs the broadcast
        // below to know.
        bumpConfigVersionOnMain()
        broadcastConfigChanged(context)

        LogCollector.append(
            "[Config] Reconciled from agent_settings.json: " +
                "provider=${if (providerChanged) "$validProvider (was ${fromPrefs.provider})" else fromPrefs.provider}, " +
                "authType=${if (authChanged) "$validAuthType (was ${fromPrefs.authType})" else fromPrefs.authType}, " +
                "model=${if (modelChanged) "$resolvedModel (was ${fromPrefs.model})" else fromPrefs.model}"
        )

        val reconciled = fromPrefs.copy(
            provider = if (providerChanged) validProvider!! else fromPrefs.provider,
            authType = if (authChanged) validAuthType!! else fromPrefs.authType,
            model = if (modelChanged) resolvedModel else fromPrefs.model,
        )
        // BAT-513: keep runtime_state.json in sync with the prefs we just
        // reconciled. Without this, the legacy agent_settings.json overlay
        // path could update prefs while the new RuntimeStateStore-backed
        // file goes stale, and the next `:node` startup would read the
        // stale file via runtime-state.js and overwrite our reconciled
        // prefs back. RuntimeStateStore.write is a no-op (returns false)
        // if init() hasn't run yet — that's fine for the `:node` process,
        // which doesn't init RuntimeStateStore. The collector's
        // redundancy guard ensures prefs aren't double-mirrored. Wrap
        // in try/catch so a (theoretically unreachable) invalid combo
        // out of reconcile doesn't crash this hot path; the prefs side
        // is already updated and the agent stays operational.
        //
        // Capture and log the Boolean so a transient FS failure (full
        // storage etc.) surfaces — without this, runtime_state.json
        // could go stale relative to prefs without any signal,
        // hiding the divergence until the next successful write.
        //
        // Gate on RuntimeStateStore.isInitialized: reconcile fires in
        // BOTH the main process and `:node`, but RuntimeStateStore.init
        // is only called in the main process. In `:node`, write() would
        // always return false (store is null) — that would produce a
        // misleading WARN every reconcile call there. The :node side
        // doesn't need this mirror anyway: Telegram-originated
        // /provider/model commands write runtime_state.json directly
        // via runtime-state.js, so the reconcile→runtime_state path
        // is a genuinely main-process-only sync of the legacy overlay
        // back into the new file.
        if (RuntimeStateStore.isInitialized) try {
            val runtimeWritten = RuntimeStateStore.write(
                RuntimeState(
                    provider = reconciled.provider,
                    authType = reconciled.authType,
                    model = reconciled.model,
                ),
            )
            if (!runtimeWritten) {
                LogCollector.append(
                    "[Config] Reconcile: RuntimeStateStore.write returned false — " +
                        "runtime_state.json may be stale vs prefs until next successful write",
                    LogLevel.WARN,
                )
            }
        } catch (e: IllegalArgumentException) {
            LogCollector.append(
                "[Config] Reconcile produced invalid RuntimeState — runtime_state.json " +
                    "left untouched (prefs still updated): ${e.message}",
                LogLevel.WARN,
            )
        }
        return reconciled
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

    fun getAutoStartOnBoot(context: Context): Boolean =
        prefs(context).getBoolean(KEY_AUTO_START, true)

    fun setAutoStartOnBoot(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_AUTO_START, enabled).commit()
    }

    fun getKeepScreenOn(context: Context): Boolean =
        prefs(context).getBoolean(KEY_KEEP_SCREEN_ON, false)

    fun setKeepScreenOn(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_KEEP_SCREEN_ON, enabled).commit()
    }

    /**
     * Persist OpenAI OAuth tokens directly to SharedPreferences, bypassing the
     * full [saveConfig] path. Used by [OpenAIOAuthActivity] during the
     * post-callback token exchange so the flow works on a fresh install — at
     * that point [saveConfig]'s prerequisites (bot token, agent name, etc.)
     * don't exist yet, and [loadConfig] still returns null because setup isn't
     * marked complete.
     *
     * This deliberately does NOT set `KEY_SETUP_COMPLETE`: the user still needs
     * to finish the onboarding flow normally. It only writes the four OAuth
     * prefs (access token + refresh token + email + expiry) and bumps
     * [configVersion] so reactive UI picks up the change.
     */
    fun persistOpenAIOAuthTokens(
        context: Context,
        accessToken: String,
        refreshToken: String,
        email: String,
        expiresAt: String,
    ) {
        val editor = prefs(context).edit()

        if (accessToken.isNotBlank()) {
            val enc = KeystoreHelper.encrypt(accessToken)
            editor.putString(KEY_OPENAI_OAUTH_TOKEN_ENC, Base64.encodeToString(enc, Base64.NO_WRAP))
        } else {
            editor.remove(KEY_OPENAI_OAUTH_TOKEN_ENC)
        }

        if (refreshToken.isNotBlank()) {
            val enc = KeystoreHelper.encrypt(refreshToken)
            editor.putString(KEY_OPENAI_OAUTH_REFRESH_ENC, Base64.encodeToString(enc, Base64.NO_WRAP))
        } else {
            editor.remove(KEY_OPENAI_OAUTH_REFRESH_ENC)
        }

        if (email.isNotBlank()) {
            val enc = KeystoreHelper.encrypt(email)
            editor.putString(KEY_OPENAI_OAUTH_EMAIL_ENC, Base64.encodeToString(enc, Base64.NO_WRAP))
            // If an older install still has the legacy plaintext pref hanging
            // around (loadConfigUnchecked migrates it on read, but not every code
            // path has triggered a read since the migration landed), drop it too
            // to ensure the encrypted value becomes the single source of truth.
            editor.remove("openai_oauth_email")
        } else {
            // Clear email in both locations — the encrypted key that we own and
            // the legacy plaintext key from pre-migration installs. Leaving the
            // plaintext pref behind on sign-out would be a PII regression.
            editor.remove(KEY_OPENAI_OAUTH_EMAIL_ENC)
            editor.remove("openai_oauth_email")
        }

        editor.putString(KEY_OPENAI_OAUTH_EXPIRES_AT, expiresAt)

        val persisted = editor.commit()
        if (persisted) {
            bumpConfigVersionOnMain()
        } else {
            LogCollector.append("[Config] Failed to persist OAuth tokens (commit=false)", LogLevel.ERROR)
        }
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
            "openaiOAuthToken" -> config.copy(openaiOAuthToken = value)
            "openaiOAuthRefresh" -> config.copy(openaiOAuthRefresh = value)
            "openaiOAuthEmail" -> config.copy(openaiOAuthEmail = value)
            "openaiOAuthExpiresAt" -> config.copy(openaiOAuthExpiresAt = value)
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
            val existing = if (file.exists()) {
                try { JSONObject(file.readText()) } catch (_: Exception) { JSONObject() }
            } else JSONObject()

            // Update the channel's owner ID
            existing.put(channel, ownerId)

            // Atomic write: write to .tmp, then rename
            val tmp = File(workspaceDir, "owner_ids.tmp")
            tmp.writeText(existing.toString())
            tmp.renameTo(file)

            // Also update SharedPreferences for backward compatibility
            val key = if (channel == "discord") KEY_DISCORD_OWNER_ID else KEY_OWNER_ID
            prefs(context).edit().putString(key, ownerId).apply()
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
     */
    fun loadOwnerIdFromFile(context: Context, channel: String): String {
        try {
            val file = File(context.filesDir, "workspace/owner_ids")
            if (file.exists()) {
                val json = JSONObject(file.readText())
                // File is source of truth — return whatever is there (even empty = cleared)
                if (json.has(channel)) return json.optString(channel, "")
            }
        } catch (_: Exception) {}

        // Fallback to SharedPreferences only if file doesn't exist yet (migration)
        val key = if (channel == "discord") KEY_DISCORD_OWNER_ID else KEY_OWNER_ID
        return prefs(context).getString(key, "") ?: ""
    }

    fun clearConfig(context: Context) {
        prefs(context).edit().clear().apply() // Clears all prefs including MCP servers
        KeystoreHelper.deleteKey()
        bumpConfigVersionOnMain()
    }

    fun clearOpenAIOAuth(context: Context) {
        prefs(context).edit()
            .remove(KEY_OPENAI_OAUTH_TOKEN_ENC)
            .remove(KEY_OPENAI_OAUTH_REFRESH_ENC)
            .remove(KEY_OPENAI_OAUTH_EMAIL_ENC)
            .remove("openai_oauth_email") // legacy plaintext key — clean up on sign-out
            .remove(KEY_OPENAI_OAUTH_EXPIRES_AT)
            .apply()
        bumpConfigVersionOnMain()
    }

    /**
     * Write ephemeral config.json to workspace for Node.js to read on startup.
     * Includes per-boot bridge auth token. File is deleted after Node.js reads it.
     * Uses JSONObject to prevent JSON injection via user-supplied values.
     */
    fun writeConfigJson(context: Context, bridgeToken: String) {
        val config = loadConfig(context)
        if (config == null) {
            LogCollector.append("[Config] writeConfigJson: loadConfig returned null (cross-process?)", LogLevel.WARN)
            return
        }
        val workspaceDir = File(context.filesDir, "workspace").apply { mkdirs() }
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
            // For OpenAI: if user has selected oauth but hasn't completed sign-in (token
            // is blank), write api_key to the workspace JSON so Node's strict validation
            // doesn't crash on startup. The UI keeps the user's intended "oauth" choice
            // in SharedPreferences so the OAuth section remains visible.
            val effectiveAuthType = if (
                config.provider == "openai" &&
                config.authType == "oauth" &&
                config.openaiOAuthToken.isBlank()
            ) "api_key" else config.authType
            put("authType", effectiveAuthType)
            put("provider", config.provider)
            put("model", config.model)
            put("agentName", config.agentName)
            put("heartbeatIntervalMinutes", config.heartbeatIntervalMinutes)
            put("maxStepsPerTurn", config.maxStepsPerTurn)
            put("bridgeToken", bridgeToken)
            if (config.braveApiKey.isNotBlank()) put("braveApiKey", config.braveApiKey)
            put("searchProvider", config.searchProvider)
            if (config.perplexityApiKey.isNotBlank()) put("perplexityApiKey", config.perplexityApiKey)
            if (config.exaApiKey.isNotBlank()) put("exaApiKey", config.exaApiKey)
            if (config.tavilyApiKey.isNotBlank()) put("tavilyApiKey", config.tavilyApiKey)
            if (config.firecrawlApiKey.isNotBlank()) put("firecrawlApiKey", config.firecrawlApiKey)
            if (config.jupiterApiKey.isNotBlank()) put("jupiterApiKey", config.jupiterApiKey)
            if (config.heliusApiKey.isNotBlank()) put("heliusApiKey", config.heliusApiKey)
            if (config.openaiApiKey.isNotBlank()) put("openaiApiKey", config.openaiApiKey)
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
            // Only the tokens are needed by Node — email/expiresAt are Android-only metadata.
            if (config.openaiOAuthToken.isNotBlank()) put("openaiOAuthToken", config.openaiOAuthToken)
            if (config.openaiOAuthRefresh.isNotBlank()) put("openaiOAuthRefresh", config.openaiOAuthRefresh)
            // NOTE: loadEnvVars() decrypts on the calling thread, matching the
            // pre-existing pattern in this function — every secret field above
            // (bot tokens, API keys, OAuth tokens, MCP tokens) is also decrypted
            // from Keystore on the same thread. Capped at 256 keys × 8 KB; typical
            // real-world size is a few keys × a few hundred bytes, so total work is
            // small. If `writeConfigJson` is ever migrated off the main thread,
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
        File(workspaceDir, "config.json").writeText(json.toString(2))
    }

    /**
     * Write the Android-managed slice of agent_settings.json (the file Node
     * reads for live-pickup of model + heartbeat + maxSteps).
     *
     * @param configOverride if non-null, write THESE values to the overlay
     *   without going through loadConfig. Used by saveField (Settings UI)
     *   so the just-saved AppConfig lands directly in the overlay,
     *   bypassing reconcileWithAgentSettings — otherwise the reconcile
     *   would see the stale overlay (from a prior /provider command)
     *   and revert prefs back to the overlay's value, undoing the
     *   Settings UI save. Service-start callers omit this param to get
     *   the default reconcile-then-publish behavior.
     */
    fun writeAgentSettingsJson(context: Context, configOverride: AppConfig? = null) {
        val config = configOverride ?: loadConfig(context)
        if (config == null) {
            LogCollector.append("[Config] writeAgentSettingsJson: loadConfig returned null; skipping write", LogLevel.WARN)
            return
        }
        val workspaceDir = File(context.filesDir, "workspace").apply { mkdirs() }
        val settingsFile = File(workspaceDir, "agent_settings.json")
        try {
            // Read existing file to preserve agent-written fields (e.g. apiKeys)
            val existing = if (settingsFile.exists()) {
                try { JSONObject(settingsFile.readText()) } catch (_: Exception) { JSONObject() }
            } else {
                JSONObject()
            }
            // Android-managed fields always overwrite. The provider/authType/model
            // triple is included so Node-initiated changes (via /model or /provider
            // Telegram commands) have a single consistent source of truth, and a
            // Settings UI save here publishes the canonical values.
            existing.put("heartbeatIntervalMinutes", config.heartbeatIntervalMinutes)
            existing.put("maxStepsPerTurn", config.maxStepsPerTurn)
            existing.put("provider", config.provider)
            existing.put("authType", config.authType)
            existing.put("model", config.model)
            // Ensure apiKeys object exists (agent writes individual keys into it)
            if (!existing.has("apiKeys")) {
                existing.put("apiKeys", JSONObject())
            }
            settingsFile.writeText(existing.toString(2))
        } catch (e: Exception) {
            LogCollector.append("[Config] Failed to write agent_settings.json: ${e.message}", LogLevel.WARN)
        }
    }

    fun runtimeValidationError(config: AppConfig?): String? {
        if (config == null) return "setup_not_complete"
        if (config.channel == "telegram" && config.telegramBotToken.isBlank()) return "missing_bot_token"
        if (config.channel == "discord" && config.discordBotToken.isBlank()) return "missing_discord_token"
        val hasCredential = when (config.provider) {
            "openai" -> {
                // Match writeConfigJson's effective auth type: oauth requires a token,
                // but if the user is on oauth without a token AND has a valid API key,
                // writeConfigJson falls back to api_key for Node — so the agent IS
                // startable. Validation must align or it would block startup despite
                // valid credentials.
                config.openaiOAuthToken.isNotBlank() || config.openaiApiKey.isNotBlank()
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
        prefs(context).edit()
            .putString(KEY_ENV_VARS_ENC, Base64.encodeToString(enc, Base64.NO_WRAP))
            .apply()
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

    fun saveMcpServers(context: Context, servers: List<McpServerConfig>) {
        val json = JSONArray().apply {
            for (s in servers) {
                put(JSONObject().apply {
                    put("id", s.id)
                    put("name", s.name)
                    put("url", s.url)
                    put("authToken", s.authToken)
                    put("enabled", s.enabled)
                    put("rateLimit", s.rateLimit)
                })
            }
        }.toString()
        val enc = KeystoreHelper.encrypt(json)
        prefs(context).edit()
            .putString(KEY_MCP_SERVERS_ENC, Base64.encodeToString(enc, Base64.NO_WRAP))
            .apply()
        bumpConfigVersionOnMain()
    }

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
        prefs(context).edit()
            .putString(KEY_WALLET_ADDRESS, address)
            .putString(KEY_WALLET_LABEL, label)
            .apply()
        bumpConfigVersionOnMain()
        writeWalletConfig(context)
    }

    fun clearWalletAddress(context: Context) {
        prefs(context).edit()
            .remove(KEY_WALLET_ADDRESS)
            .remove(KEY_WALLET_LABEL)
            .apply()
        bumpConfigVersionOnMain()
        val walletFile = File(File(context.filesDir, "workspace"), "solana_wallet.json")
        if (walletFile.exists()) walletFile.delete()
    }

    private fun writeWalletConfig(context: Context) {
        val address = prefs(context).getString(KEY_WALLET_ADDRESS, null) ?: return
        val label = prefs(context).getString(KEY_WALLET_LABEL, "") ?: ""
        val workspaceDir = File(context.filesDir, "workspace").apply { mkdirs() }
        val json = JSONObject().apply {
            put("publicKey", address)
            put("label", label)
        }.toString(2)
        File(workspaceDir, "solana_wallet.json").writeText(json)
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
        val workspaceDir = File(context.filesDir, "workspace").apply { mkdirs() }

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
        val permSms = perm(Manifest.permission.SEND_SMS)
        val permPhone = perm(Manifest.permission.CALL_PHONE)
        val permContacts = perm(Manifest.permission.READ_CONTACTS)
        val permLocation = perm(Manifest.permission.ACCESS_FINE_LOCATION)
        val permNotifications = perm(Manifest.permission.POST_NOTIFICATIONS)

        // Wallet
        val walletAddress = getWalletAddress(context)
        val walletLabel = getWalletLabel(context)

        // Versions
        val appVersion = BuildConfig.VERSION_NAME
        val appCode = BuildConfig.VERSION_CODE
        val openclawVersion = BuildConfig.OPENCLAW_VERSION
        val nodejsVersion = BuildConfig.NODEJS_VERSION

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
            else -> "Anthropic"
        }
        // Auth type is only relevant for Claude (api_key vs setup_token)
        val authLabel = when (provider) {
            "claude" -> if (config?.authType == "setup_token") "Pro/Max Setup Token" else "API key"
            else -> "API key"
        }
        val aiModel = config?.model ?: "claude-opus-4-7"

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
            appendLine("- SMS: $permSms")
            appendLine("- Phone: $permPhone")
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

        File(workspaceDir, "PLATFORM.md").writeText(md)
        LogCollector.append("[Service] PLATFORM.md written")
    }

    /**
     * Seed workspace with default SOUL.md and MEMORY.md on first launch.
     * Uses the same SOUL.md template as OpenClaw.
     */
    fun seedWorkspace(context: Context) {
        val workspaceDir = File(context.filesDir, "workspace").apply { mkdirs() }

        val soulFile = File(workspaceDir, "SOUL.md")
        if (!soulFile.exists()) {
            soulFile.writeText(
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
        if (!memoryFile.exists()) {
            memoryFile.writeText("")
        }

        // Create memory directory
        File(workspaceDir, "memory").mkdirs()

        // BOOTSTRAP.md - One-time personality ritual (OpenClaw style)
        // Agent reads this on first message and guides user through setup
        val bootstrapFile = File(workspaceDir, "BOOTSTRAP.md")
        if (!bootstrapFile.exists()) {
            bootstrapFile.writeText(
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
        if (!identityFile.exists()) {
            identityFile.writeText(
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
        if (!userFile.exists()) {
            userFile.writeText(
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

        // DIAGNOSTICS.md — deep troubleshooting guide (read by agent on demand)
        val diagFile = File(workspaceDir, "DIAGNOSTICS.md")
        if (!diagFile.exists()) {
            try {
                context.assets.open("nodejs-project/DIAGNOSTICS.md").use { input ->
                    diagFile.writeText(input.bufferedReader().readText())
                }
            } catch (_: Exception) { /* asset missing — skip */ }
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
        if (!file.exists()) return manifest
        return try {
            val json = JSONObject(file.readText())
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
            file.writeText(json.toString(2))
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
            // Case 1: File doesn't exist — seed it
            skillFile.writeText(content)
            manifest[name] = SkillManifestEntry(version = version, hash = contentHash)
            Log.d(TAG, "Skill $name seeded at version $version")
            return
        }

        if (manifestEntry == null) {
            // File exists but no manifest entry (pre-versioning install).
            // Record current file hash in manifest at version "0.0.0" so next
            // update can detect user modifications. Do NOT overwrite on this run.
            val installedHash = computeHash(skillFile.readText())
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
        val installedHash = computeHash(skillFile.readText())
        if (installedHash == currentEntry.hash) {
            // User hasn't modified — safe to overwrite
            skillFile.writeText(content)
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

                seedSkill(skillsDir, manifest, skillName, version, content)
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
        if (!manifestFile.exists()) return emptySet()
        return try {
            val json = JSONObject(manifestFile.readText())
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
        if (!manifestFile.exists()) return emptyMap()
        return try {
            val json = JSONObject(manifestFile.readText())
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
        val skillFile = File(File(skillsDir, skillDirName), "SKILL.md").takeIf { it.exists() }
            ?: File(skillsDir, "$skillDirName.md").takeIf { it.exists() }

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
                skillFile.inputStream().use { it.copyTo(out) }
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
        val userEntries = skillsDir.listFiles()?.filter { entry ->
            when {
                entry.isDirectory && entry.name !in defaultNames -> true
                entry.isFile && entry.name.endsWith(".md") -> true
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
                        if (entry.isDirectory) {
                            addDirectoryToZip(zip, entry, skillsDir)
                        } else {
                            zip.putNextEntry(ZipEntry(entry.name))
                            entry.inputStream().use { it.copyTo(zip) }
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
        dir.walkTopDown().filter { it.isFile }.forEach { file ->
            val relativePath = file.relativeTo(baseDir).path.replace("\\", "/")
            zip.putNextEntry(ZipEntry(relativePath))
            file.inputStream().use { it.copyTo(zip) }
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

                        if (entry.isDirectory) {
                            trackNewDirs(destFile, skillsDir, createdDirs)
                            destFile.mkdirs()
                        } else {
                            destFile.parentFile?.let { parent ->
                                trackNewDirs(parent, skillsDir, createdDirs)
                                parent.mkdirs()
                            }
                            destFile.outputStream().use { out ->
                                val buffer = ByteArray(8192)
                                var read: Int
                                while (zip.read(buffer).also { read = it } != -1) {
                                    totalExtracted += read
                                    if (totalExtracted > IMPORT_MAX_BYTES) {
                                        destFile.delete()
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
                val skillDir = File(skillsDir, name).apply { mkdirs() }
                File(skillDir, "SKILL.md").writeText(content)
            } else {
                // Save as flat file: skills/imported_<timestamp>.md
                val timestamp = System.currentTimeMillis()
                File(skillsDir, "imported_$timestamp.md").writeText(content)
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
    fun clearMemory(context: Context) {
        val workspaceDir = File(context.filesDir, "workspace")
        File(workspaceDir, "MEMORY.md").apply {
            if (exists()) writeText("")
        }
        File(workspaceDir, "memory").apply {
            if (exists()) deleteRecursively()
            mkdirs()
        }
    }

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
        val workspaceDir = File(context.filesDir, "workspace").apply { mkdirs() }

        // Auto-backup current state before overwriting (keeps last backup only)
        try {
            val backupDir = File(context.filesDir, "backup").apply { mkdirs() }
            val backupFile = File(backupDir, "pre_import_backup.zip")
            backupFile.outputStream().use { outputStream ->
                ZipOutputStream(outputStream).use { zip ->
                    addAllowedFilesToZip(zip, workspaceDir, workspaceDir)
                }
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

                        if (entry.isDirectory) {
                            destFile.mkdirs()
                        } else {
                            // Enforce total size cap
                            destFile.parentFile?.mkdirs()
                            destFile.outputStream().use { out ->
                                val buffer = ByteArray(8192)
                                var bytesRead: Int
                                while (zip.read(buffer).also { bytesRead = it } != -1) {
                                    totalExtracted += bytesRead
                                    if (totalExtracted > IMPORT_MAX_BYTES) {
                                        destFile.delete()
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
