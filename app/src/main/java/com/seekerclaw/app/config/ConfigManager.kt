package com.seekerclaw.app.config

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.StatFs
import android.util.Base64
import android.util.Log
import androidx.compose.runtime.mutableIntStateOf
import androidx.core.content.ContextCompat
import com.seekerclaw.app.BuildConfig
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
    val authType: String = "api_key", // "api_key" or "setup_token"
    val telegramBotToken: String,
    val telegramOwnerId: String,
    val model: String,
    val agentName: String,
    val braveApiKey: String = "",
    val jupiterApiKey: String = "",
    val autoStartOnBoot: Boolean = true,
    val heartbeatIntervalMinutes: Int = 30,
) {
    /** Returns the credential that should be used based on the current authType. */
    val activeCredential: String
        get() = if (authType == "setup_token") setupToken else anthropicApiKey
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
    /** Incremented on every saveConfig(); observe in `remember(configVersion)`. */
    val configVersion = mutableIntStateOf(0)

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
    private const val KEY_JUPITER_API_KEY_ENC = "jupiter_api_key_enc"
    private const val KEY_WALLET_ADDRESS = "wallet_address"
    private const val KEY_WALLET_LABEL = "wallet_label"
    private const val KEY_MCP_SERVERS_ENC = "mcp_servers_enc"
    private const val KEY_HEARTBEAT_INTERVAL = "heartbeat_interval"

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun isSetupComplete(context: Context): Boolean =
        prefs(context).getBoolean(KEY_SETUP_COMPLETE, false)

    fun markSetupSkipped(context: Context) {
        prefs(context).edit()
            .putBoolean(KEY_SETUP_COMPLETE, true)
            .apply()
    }

    fun saveConfig(context: Context, config: AppConfig) {
        val encApiKey = KeystoreHelper.encrypt(config.anthropicApiKey)
        val encBotToken = KeystoreHelper.encrypt(config.telegramBotToken)

        val editor = prefs(context).edit()
            .putString(KEY_API_KEY_ENC, Base64.encodeToString(encApiKey, Base64.NO_WRAP))
            .putString(KEY_BOT_TOKEN_ENC, Base64.encodeToString(encBotToken, Base64.NO_WRAP))
            .putString(KEY_OWNER_ID, config.telegramOwnerId)
            .putString(KEY_MODEL, config.model)
            .putString(KEY_AGENT_NAME, config.agentName)
            .putString(KEY_AUTH_TYPE, config.authType)
            .putBoolean(KEY_AUTO_START, config.autoStartOnBoot)
            .putInt(KEY_HEARTBEAT_INTERVAL, config.heartbeatIntervalMinutes)
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

        if (config.jupiterApiKey.isNotBlank()) {
            val encJupiter = KeystoreHelper.encrypt(config.jupiterApiKey)
            editor.putString(KEY_JUPITER_API_KEY_ENC, Base64.encodeToString(encJupiter, Base64.NO_WRAP))
        } else {
            editor.remove(KEY_JUPITER_API_KEY_ENC)
        }

        val persisted = editor.commit()
        if (persisted) {
            configVersion.intValue++
        } else {
            LogCollector.append("[Config] Failed to persist config (commit=false)", LogLevel.ERROR)
        }
    }

    fun loadConfig(context: Context): AppConfig? {
        val p = prefs(context)
        if (!p.getBoolean(KEY_SETUP_COMPLETE, false)) return null

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

        val jupiterApiKey = try {
            val enc = p.getString(KEY_JUPITER_API_KEY_ENC, null)
            if (enc != null) KeystoreHelper.decrypt(Base64.decode(enc, Base64.NO_WRAP)) else ""
        } catch (e: Exception) {
            Log.w(TAG, "Failed to decrypt Jupiter API key", e)
            LogCollector.append("[Config] Failed to decrypt Jupiter API key: ${e.javaClass.simpleName}", LogLevel.ERROR)
            ""
        }

        return AppConfig(
            anthropicApiKey = apiKey,
            setupToken = setupToken,
            authType = p.getString(KEY_AUTH_TYPE, "api_key") ?: "api_key",
            telegramBotToken = botToken,
            telegramOwnerId = p.getString(KEY_OWNER_ID, "") ?: "",
            model = p.getString(KEY_MODEL, "claude-opus-4-6") ?: "claude-opus-4-6",
            agentName = p.getString(KEY_AGENT_NAME, "MyAgent") ?: "MyAgent",
            braveApiKey = braveApiKey,
            jupiterApiKey = jupiterApiKey,
            autoStartOnBoot = p.getBoolean(KEY_AUTO_START, true),
            heartbeatIntervalMinutes = p.getInt(KEY_HEARTBEAT_INTERVAL, 30),
        )
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

    fun updateConfigField(context: Context, field: String, value: String) {
        val config = loadConfig(context) ?: return
        val updated = when (field) {
            "anthropicApiKey" -> config.copy(anthropicApiKey = value)
            "setupToken" -> config.copy(setupToken = value)
            "telegramBotToken" -> config.copy(telegramBotToken = value)
            "telegramOwnerId" -> config.copy(telegramOwnerId = value)
            "model" -> config.copy(model = value)
            "agentName" -> config.copy(agentName = value)
            "authType" -> config.copy(authType = value)
            "braveApiKey" -> config.copy(braveApiKey = value)
            "jupiterApiKey" -> config.copy(jupiterApiKey = value)
            "heartbeatIntervalMinutes" -> config.copy(
                heartbeatIntervalMinutes = value.toIntOrNull()?.coerceIn(5, 120) ?: 30
            )
            else -> return
        }
        saveConfig(context, updated)
        writeAgentSettingsJson(context)
    }

    fun saveOwnerId(context: Context, ownerId: String) {
        prefs(context).edit().putString(KEY_OWNER_ID, ownerId).apply()
        configVersion.intValue++
    }

    fun clearConfig(context: Context) {
        prefs(context).edit().clear().apply() // Clears all prefs including MCP servers
        KeystoreHelper.deleteKey()
        configVersion.intValue++
    }

    /**
     * Escape string for safe JSON interpolation.
     * Handles quotes, backslashes, newlines, and control characters.
     */
    private fun escapeJson(value: String): String {
        return value
            .replace("\\", "\\\\")    // Backslash must be first
            .replace("\"", "\\\"")    // Quotes
            .replace("\n", "\\n")     // Newline
            .replace("\r", "\\r")     // Carriage return
            .replace("\t", "\\t")     // Tab
            .replace("\u2028", "\\\\u2028")  // Unicode line separator
            .replace("\u2029", "\\\\u2029")  // Unicode paragraph separator
    }

    /**
     * Write ephemeral config.json to workspace for Node.js to read on startup.
     * Includes per-boot bridge auth token. File is deleted after Node.js reads it.
     */
    fun writeConfigJson(context: Context, bridgeToken: String) {
        val config = loadConfig(context)
        if (config == null) {
            LogCollector.append("[Config] writeConfigJson: loadConfig returned null (cross-process?)", LogLevel.WARN)
            return
        }
        val workspaceDir = File(context.filesDir, "workspace").apply { mkdirs() }
        val credential = escapeJson(config.activeCredential)
        val braveField = if (config.braveApiKey.isNotBlank()) {
            """,
            |  "braveApiKey": "${escapeJson(config.braveApiKey)}""""
        } else ""
        val jupiterField = if (config.jupiterApiKey.isNotBlank()) {
            """,
            |  "jupiterApiKey": "${escapeJson(config.jupiterApiKey)}""""
        } else ""
        val mcpServers = loadMcpServers(context)
        val mcpField = if (mcpServers.isNotEmpty()) {
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
            """,
            |  "mcpServers": ${arr}"""
        } else ""
        val json = """
            |{
            |  "botToken": "${escapeJson(config.telegramBotToken)}",
            |  "ownerId": "${escapeJson(config.telegramOwnerId)}",
            |  "anthropicApiKey": "$credential",
            |  "authType": "${escapeJson(config.authType)}",
            |  "model": "${escapeJson(config.model)}",
            |  "agentName": "${escapeJson(config.agentName)}",
            |  "heartbeatIntervalMinutes": ${config.heartbeatIntervalMinutes},
            |  "bridgeToken": "${escapeJson(bridgeToken)}"$braveField$jupiterField$mcpField
            |}
        """.trimMargin()
        File(workspaceDir, "config.json").writeText(json)
    }

    fun writeAgentSettingsJson(context: Context) {
        val config = loadConfig(context)
        if (config == null) {
            LogCollector.append("[Config] writeAgentSettingsJson: loadConfig returned null; skipping write", LogLevel.WARN)
            return
        }
        val workspaceDir = File(context.filesDir, "workspace").apply { mkdirs() }
        val json = """{"heartbeatIntervalMinutes":${config.heartbeatIntervalMinutes}}"""
        try {
            File(workspaceDir, "agent_settings.json").writeText(json)
        } catch (e: Exception) {
            LogCollector.append("[Config] Failed to write agent_settings.json: ${e.message}", LogLevel.WARN)
        }
    }

    fun runtimeValidationError(config: AppConfig?): String? {
        if (config == null) return "setup_not_complete"
        if (config.telegramBotToken.isBlank()) return "missing_bot_token"
        if (config.activeCredential.isBlank()) return "missing_credential"
        return null
    }

    fun redactedSnapshot(config: AppConfig?): String {
        if (config == null) return "setup=false"
        return "setup=true authType=${config.authType} botSet=${config.telegramBotToken.isNotBlank()} " +
            "apiSet=${config.anthropicApiKey.isNotBlank()} setupTokenSet=${config.setupToken.isNotBlank()} " +
            "activeSet=${config.activeCredential.isNotBlank()} model=${config.model}"
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
        configVersion.intValue++
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
        configVersion.intValue++
        writeWalletConfig(context)
    }

    fun clearWalletAddress(context: Context) {
        prefs(context).edit()
            .remove(KEY_WALLET_ADDRESS)
            .remove(KEY_WALLET_LABEL)
            .apply()
        configVersion.intValue++
        val walletFile = File(File(context.filesDir, "workspace"), "solana_wallet.json")
        if (walletFile.exists()) walletFile.delete()
    }

    private fun writeWalletConfig(context: Context) {
        val address = prefs(context).getString(KEY_WALLET_ADDRESS, null) ?: return
        val label = prefs(context).getString(KEY_WALLET_LABEL, "") ?: ""
        val workspaceDir = File(context.filesDir, "workspace").apply { mkdirs() }
        val json = """{"publicKey": "$address", "label": "$label"}"""
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

        // Battery
        val batteryIntent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val batteryLevel = batteryIntent?.let { intent ->
            val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
            if (level >= 0 && scale > 0) (level * 100) / scale else 0
        } ?: 0
        val plugged = batteryIntent?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
        val isCharging = plugged != 0
        val chargeType: String? = when (plugged) {
            BatteryManager.BATTERY_PLUGGED_AC -> "AC"
            BatteryManager.BATTERY_PLUGGED_USB -> "USB"
            BatteryManager.BATTERY_PLUGGED_WIRELESS -> "Wireless"
            else -> null
        }
        val batteryStatus = if (isCharging) {
            if (chargeType != null) "Charging ($chargeType)" else "Charging"
        } else {
            "Not charging"
        }

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
        val authType = config?.authType ?: "api_key"
        val authLabel = if (authType == "setup_token") "Claude Pro/Max (setup token)" else "API key"
        val aiModel = config?.model ?: "claude-opus-4-6"

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
            appendLine("## Battery")
            appendLine("- Level: $batteryLevel%")
            appendLine("- Status: $batteryStatus")
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
