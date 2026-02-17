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
) {
    /** Returns the credential that should be used based on the current authType. */
    val activeCredential: String
        get() = if (authType == "setup_token") setupToken else anthropicApiKey
}

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
            else -> return
        }
        saveConfig(context, updated)
    }

    fun saveOwnerId(context: Context, ownerId: String) {
        prefs(context).edit().putString(KEY_OWNER_ID, ownerId).apply()
        configVersion.intValue++
    }

    fun clearConfig(context: Context) {
        prefs(context).edit().clear().apply()
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
        val json = """
            |{
            |  "botToken": "${escapeJson(config.telegramBotToken)}",
            |  "ownerId": "${escapeJson(config.telegramOwnerId)}",
            |  "anthropicApiKey": "$credential",
            |  "authType": "${escapeJson(config.authType)}",
            |  "model": "${escapeJson(config.model)}",
            |  "agentName": "${escapeJson(config.agentName)}",
            |  "bridgeToken": "${escapeJson(bridgeToken)}"$braveField$jupiterField
            |}
        """.trimMargin()
        File(workspaceDir, "config.json").writeText(json)
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
            appendLine("- Media: media/inbound/")
            appendLine("- Skills: skills/")
            appendLine("- Memory: memory/")
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
        seedSkills(workspaceDir)
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
     * Seed workspace with example skills demonstrating the Skills system.
     * Uses version-aware logic to update skills on app updates while
     * preserving user-modified skills.
     */
    private fun seedSkills(workspaceDir: File) {
        val skillsDir = File(workspaceDir, "skills").apply { mkdirs() }
        val manifestFile = File(workspaceDir, "skills-manifest.json")
        val manifest = loadSkillManifest(manifestFile)

        // Weather skill
        seedSkill(skillsDir, manifest, "weather", "1.0.0", """
            |---
            |name: weather
            |description: "Get current weather information and forecasts for any location"
            |version: "1.0.0"
            |---
            |
            |# Weather
            |
            |## Instructions
            |When the user asks about weather:
            |
            |1. Identify the location they're asking about
            |   - If no location specified, ask which city they want
            |   - Remember their home location if they've told you before
            |
            |2. Use web_search to find current weather
            |   - Search: "[city] weather today"
            |   - Include temperature, conditions, and any alerts
            |
            |3. Format your response concisely:
            |   - Current temperature and conditions
            |   - High/low for the day
            |   - Any notable weather alerts
            |   - Brief forecast if they asked
            |
            |Keep responses short - this is for mobile viewing.
        """.trimMargin().trimEnd() + "\n")

        // Web Research skill
        seedSkill(skillsDir, manifest, "research", "1.0.0", """
            |---
            |name: research
            |description: "Deep research on topics using web search and page fetching"
            |version: "1.0.0"
            |---
            |
            |# Web Research
            |
            |## Instructions
            |When researching a topic:
            |
            |1. Start with a broad web_search to understand the topic
            |
            |2. For detailed info, use web_fetch on promising URLs
            |   - Prefer authoritative sources (Wikipedia, official sites, reputable news)
            |   - Avoid clickbait or low-quality sources
            |
            |3. Synthesize information from multiple sources
            |   - Cross-reference facts when possible
            |   - Note if sources conflict
            |
            |4. Format findings clearly:
            |   - Lead with the key answer
            |   - Add supporting details
            |   - Cite sources when relevant
            |
            |5. Save important findings to memory if the user might need them later
        """.trimMargin().trimEnd() + "\n")

        // Daily Briefing skill
        seedSkill(skillsDir, manifest, "briefing", "1.0.0", """
            |---
            |name: briefing
            |description: "Provide a personalized daily briefing with news, weather, and reminders"
            |version: "1.0.0"
            |---
            |
            |# Daily Briefing
            |
            |## Instructions
            |When asked for a briefing:
            |
            |1. Check memory for user's preferences:
            |   - Their location for weather
            |   - Topics they care about
            |   - Any scheduled reminders
            |
            |2. Gather information:
            |   - Local weather using web_search
            |   - Top news in their interest areas
            |   - Any notes from yesterday's daily memory
            |
            |3. Format as a concise briefing:
            |   - Start with weather (1-2 lines)
            |   - Key news headlines (3-5 items)
            |   - Any reminders or follow-ups from memory
            |
            |4. Keep it scannable - use bullet points
            |
            |5. Add today's briefing to daily_note for reference
        """.trimMargin().trimEnd() + "\n")

        // Reminders skill
        seedSkill(skillsDir, manifest, "reminders", "1.0.0", """
            |---
            |name: reminders
            |description: "Set reminders that will notify you at the specified time"
            |version: "1.0.0"
            |emoji: "⏰"
            |---
            |
            |# Reminders
            |
            |## Instructions
            |Use the reminder tools to manage reminders:
            |
            |**Setting a reminder:**
            |1. Extract what to remind about
            |2. Parse when (natural language supported):
            |   - "in 30 minutes", "in 2 hours"
            |   - "tomorrow at 9am", "at 5pm"
            |   - "2024-01-15 14:30" (ISO format)
            |3. Call reminder_set with message and time
            |4. Confirm with the scheduled time
            |
            |**Listing reminders:**
            |- Use reminder_list to show pending reminders
            |- Show ID, message, and when it's due
            |
            |**Canceling reminders:**
            |- Use reminder_cancel with the reminder ID
            |- Confirm cancellation
            |
            |Examples:
            |- "Remind me to call mom in 30 minutes"
            |  → reminder_set("Call mom", "in 30 minutes")
            |- "What reminders do I have?"
            |  → reminder_list()
            |- "Cancel reminder rem_abc123"
            |  → reminder_cancel("rem_abc123")
        """.trimMargin().trimEnd() + "\n")

        // Quick Notes skill
        seedSkill(skillsDir, manifest, "notes", "1.0.0", """
            |---
            |name: notes
            |description: "Quickly capture and organize notes for later reference"
            |version: "1.0.0"
            |---
            |
            |# Quick Notes
            |
            |## Instructions
            |When the user wants to save a note:
            |
            |1. Identify the content to save
            |
            |2. Determine if it should go to:
            |   - daily_note: Temporary, day-specific info
            |   - memory_save: Long-term, important info
            |
            |3. Add appropriate tags if mentioned (#idea, #todo, #link)
            |
            |4. Format notes clearly with topic and content
            |
            |5. Confirm the note was saved
            |
            |When retrieving notes:
            |- Check both MEMORY.md and today's daily file
            |- Search for relevant tags or keywords
        """.trimMargin().trimEnd() + "\n")

        // Translate skill
        seedSkill(skillsDir, manifest, "translate", "1.0.0", """
            |---
            |name: translate
            |description: "Translate text between languages"
            |version: "1.0.0"
            |---
            |
            |# Translate
            |
            |## Instructions
            |When translating:
            |
            |1. Identify source and target languages
            |   - If not specified, translate TO user's preferred language
            |   - Check memory for language preferences
            |
            |2. Provide the translation directly
            |   - Include pronunciation hints for non-Latin scripts
            |   - Note any nuances or alternative meanings
            |
            |3. For longer texts, translate paragraph by paragraph
            |
            |4. If source language is unclear, detect it first
            |
            |Supported: All major languages including English, Spanish,
            |French, German, Chinese, Japanese, Korean, Arabic, Russian, etc.
        """.trimMargin().trimEnd() + "\n")

        // Calculator skill
        seedSkill(skillsDir, manifest, "calculator", "1.0.0", """
            |---
            |name: calculator
            |description: "Perform calculations, unit conversions, and math operations"
            |version: "1.0.0"
            |---
            |
            |# Calculator
            |
            |## Instructions
            |For calculations:
            |
            |1. Parse the mathematical expression
            |
            |2. Show work for complex calculations (step by step)
            |   Just the answer for simple arithmetic
            |
            |3. Unit conversions supported:
            |   - Temperature: C/F/K
            |   - Length: m/ft/in/cm/km/mi
            |   - Weight: kg/lb/g/oz
            |   - Volume: L/gal/ml
            |   - Currency: Use web_search for current rates
            |
            |4. Percentages: X% of Y, tip calculations
            |
            |5. Date math: days between dates, X days from now
            |
            |Format results clearly with units.
        """.trimMargin().trimEnd() + "\n")

        // Summarize skill
        seedSkill(skillsDir, manifest, "summarize", "1.0.0", """
            |---
            |name: summarize
            |description: "Summarize web pages, articles, or text content"
            |version: "1.0.0"
            |---
            |
            |# Summarize
            |
            |## Instructions
            |When summarizing:
            |
            |1. If given a URL, use web_fetch to get the content
            |
            |2. Create a summary with:
            |   - TL;DR: 1-2 sentence overview
            |   - Key Points: 3-5 bullet points
            |   - Details: Important specifics if relevant
            |
            |3. Adjust length based on request:
            |   - "quick summary" = TL;DR only
            |   - "detailed summary" = all sections
            |   - Default = TL;DR + Key Points
            |
            |4. For long content, focus on most important 20%
            |
            |5. Offer to save summary to memory if important
        """.trimMargin().trimEnd() + "\n")

        // Timer skill
        seedSkill(skillsDir, manifest, "timer", "1.0.0", """
            |---
            |name: timer
            |description: "Set countdown timers for cooking, workouts, or any timed activity"
            |version: "1.0.0"
            |emoji: "⏱️"
            |---
            |
            |# Timer
            |
            |## Instructions
            |When the user wants a timer:
            |
            |1. Parse the duration:
            |   - "5 minutes", "30 seconds", "1 hour"
            |   - "5 min timer", "timer for 10 minutes"
            |
            |2. Use reminder_set with the duration:
            |   - Message: "⏱️ Timer complete! [original request]"
            |   - Time: "in X minutes"
            |
            |3. Confirm the timer is set with the end time
            |
            |4. For very short timers (<1 min), note that there may be a slight delay
            |
            |Examples:
            |- "Set a 5 minute timer" → reminder_set("⏱️ Timer done!", "in 5 minutes")
            |- "Timer for 30 minutes for pasta" → reminder_set("⏱️ Pasta timer done!", "in 30 minutes")
        """.trimMargin().trimEnd() + "\n")

        // Define skill
        seedSkill(skillsDir, manifest, "define", "1.0.0", """
            |---
            |name: define
            |description: "Look up definitions, word meanings, and etymology"
            |version: "1.0.0"
            |emoji: "📖"
            |---
            |
            |# Define
            |
            |## Instructions
            |When the user asks for a definition:
            |
            |1. Use your knowledge for common words
            |   - Provide clear, concise definition
            |   - Include part of speech
            |   - Give 1-2 example sentences
            |
            |2. For technical/specialized terms:
            |   - Use web_search if unsure
            |   - Include context (field/domain)
            |
            |3. Format:
            |   **word** (part of speech)
            |   Definition: ...
            |   Example: "..."
            |
            |4. If asked about etymology, include word origin
            |
            |5. For multiple meanings, list top 2-3 most common
        """.trimMargin().trimEnd() + "\n")

        // News skill
        seedSkill(skillsDir, manifest, "news", "1.0.0", """
            |---
            |name: news
            |description: "Get latest news headlines and current events"
            |version: "1.0.0"
            |emoji: "📰"
            |---
            |
            |# News
            |
            |## Instructions
            |When the user asks about news:
            |
            |1. Determine the topic:
            |   - General news: "what's happening", "news today"
            |   - Topic-specific: "tech news", "sports news", "crypto news"
            |   - Location-specific: "news in Tokyo", "local news"
            |
            |2. Use web_search with relevant queries:
            |   - "latest news [topic] today"
            |   - Include date for freshness
            |
            |3. Format as scannable list:
            |   📰 **Headline 1**
            |   Brief description (1 line)
            |
            |   📰 **Headline 2**
            |   ...
            |
            |4. Provide 3-5 headlines unless asked for more
            |
            |5. Note the time/date of news for context
            |
            |6. Offer to get more details on any story
        """.trimMargin().trimEnd() + "\n")

        // Todo skill
        seedSkill(skillsDir, manifest, "todo", "1.0.0", """
            |---
            |name: todo
            |description: "Manage tasks and to-do lists with add, complete, and list operations"
            |version: "1.0.0"
            |emoji: "✅"
            |---
            |
            |# Todo
            |
            |## Instructions
            |Task management using workspace/todo.json file.
            |
            |**Adding tasks:**
            |1. Read current todo.json (or create empty array if missing)
            |2. Add new task: { "id": timestamp, "task": "text", "done": false, "created": ISO date }
            |3. Write updated JSON back
            |4. Confirm: "Added: [task]"
            |
            |**Listing tasks:**
            |1. Read todo.json
            |2. Format as:
            |   ☐ Task 1
            |   ☐ Task 2
            |   ☑ Completed task
            |3. Show count: "3 tasks (1 done)"
            |
            |**Completing tasks:**
            |1. Find task by text match or number
            |2. Set "done": true, add "completed": ISO date
            |3. Confirm: "✅ Completed: [task]"
            |
            |**Clearing completed:**
            |1. Filter out done tasks
            |2. Save cleaned list
            |
            |Use read/write tools on "todo.json" for storage.
        """.trimMargin().trimEnd() + "\n")

        // Bookmark skill
        seedSkill(skillsDir, manifest, "bookmark", "1.0.0", """
            |---
            |name: bookmark
            |description: "Save and organize links for later reading"
            |version: "1.0.0"
            |emoji: "🔖"
            |---
            |
            |# Bookmark
            |
            |## Instructions
            |Link management using workspace/bookmarks.json file.
            |
            |**Saving a bookmark:**
            |1. Extract URL from message
            |2. Optionally fetch title using web_fetch
            |3. Add to bookmarks.json:
            |   { "url": "...", "title": "...", "tags": [], "saved": ISO date }
            |4. Confirm: "🔖 Saved: [title]"
            |
            |**Listing bookmarks:**
            |1. Read bookmarks.json
            |2. Format as:
            |   🔖 **Title**
            |   url.com/...
            |   Tags: #tag1 #tag2
            |
            |**Finding bookmarks:**
            |1. Search by tag: "bookmarks tagged #tech"
            |2. Search by text: "find bookmark about React"
            |3. Return matching entries
            |
            |**Deleting bookmarks:**
            |1. Find by URL or title
            |2. Remove from array
            |3. Save updated file
            |
            |Use read/write tools on "bookmarks.json" for storage.
        """.trimMargin().trimEnd() + "\n")

        // Joke skill
        seedSkill(skillsDir, manifest, "joke", "1.0.0", """
            |---
            |name: joke
            |description: "Tell jokes and make the user laugh"
            |version: "1.0.0"
            |emoji: "😄"
            |---
            |
            |# Joke
            |
            |## Instructions
            |When the user wants humor:
            |
            |1. Tell a joke appropriate to context
            |   - Clean, family-friendly by default
            |   - Adapt to user's humor preferences if known
            |
            |2. Joke types available:
            |   - Puns and wordplay
            |   - One-liners
            |   - Programmer/tech jokes
            |   - Dad jokes
            |   - Knock-knock jokes
            |
            |3. Format:
            |   Just tell the joke naturally
            |   No need to explain unless asked
            |
            |4. If they want more, offer another
            |
            |5. Remember jokes they liked in memory
        """.trimMargin().trimEnd() + "\n")

        // Quote skill
        seedSkill(skillsDir, manifest, "quote", "1.0.0", """
            |---
            |name: quote
            |description: "Share inspirational quotes and wisdom"
            |version: "1.0.0"
            |emoji: "💭"
            |---
            |
            |# Quote
            |
            |## Instructions
            |When the user wants inspiration:
            |
            |1. Select an appropriate quote:
            |   - Match their mood if apparent
            |   - Consider topics they care about
            |   - Vary sources (philosophers, leaders, authors)
            |
            |2. Format:
            |   "[Quote text]"
            |   — Author Name
            |
            |3. Quote categories:
            |   - Motivation & success
            |   - Life & wisdom
            |   - Creativity & innovation
            |   - Perseverance & resilience
            |   - Humor & lightness
            |
            |4. If they want a specific type, honor that
            |
            |5. Offer to save favorites to memory
        """.trimMargin().trimEnd() + "\n")

        // ============================================
        // Phase 4: API-Based Skills (using web_fetch)
        // ============================================

        // Crypto Prices skill (CoinGecko - free, no API key)
        seedSkill(skillsDir, manifest, "crypto-prices", "1.0.0", """
            |---
            |name: crypto-prices
            |description: "Get real-time cryptocurrency prices and market data from CoinGecko (free, no API key)"
            |version: "1.0.0"
            |metadata:
            |  openclaw:
            |    emoji: "💰"
            |    requires:
            |      bins: []
            |      env: []
            |---
            |
            |# Crypto Prices
            |
            |Get cryptocurrency prices using the free CoinGecko API.
            |
            |## When to Use
            |
            |User asks about:
            |- Crypto prices ("What's Bitcoin at?", "SOL price")
            |- Market data ("Is ETH up or down?")
            |- Multiple coins ("Price of BTC, ETH, and SOL")
            |
            |## API Endpoints
            |
            |### Get single coin price
            |```javascript
            |web_fetch({
            |  url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
            |})
            |```
            |
            |### Get multiple coins with 24h change
            |```javascript
            |web_fetch({
            |  url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true"
            |})
            |```
            |
            |## Coin ID Mapping
            |
            || Symbol | CoinGecko ID |
            ||--------|--------------|
            || BTC | bitcoin |
            || ETH | ethereum |
            || SOL | solana |
            || USDC | usd-coin |
            || DOGE | dogecoin |
            || ADA | cardano |
            || XRP | ripple |
            |
            |## Response Format
            |
            |Present prices clearly:
            |```
            |Bitcoin (BTC): ${'$'}45,123.45 (+2.3% 24h)
            |Ethereum (ETH): ${'$'}2,456.78 (-1.2% 24h)
            |```
            |
            |## Rate Limits
            |
            |CoinGecko free tier: 10-30 requests/minute.
        """.trimMargin().trimEnd() + "\n")

        // Movie & TV skill (TMDB - free with key)
        seedSkill(skillsDir, manifest, "movie-tv", "1.0.0", """
            |---
            |name: movie-tv
            |description: "Search movies and TV shows, get ratings, recommendations using TMDB"
            |version: "1.0.0"
            |metadata:
            |  openclaw:
            |    emoji: "🎬"
            |    requires:
            |      bins: []
            |      env: []
            |---
            |
            |# Movie & TV
            |
            |Search for movies and TV shows using The Movie Database (TMDB) API.
            |
            |## When to Use
            |
            |User asks about:
            |- Movie info ("Tell me about Dune")
            |- TV shows ("What's Severance about?")
            |- Recommendations ("Movies like Inception")
            |- What's trending
            |
            |## API Key
            |
            |TMDB requires a free API key. Check memory for TMDB_API_KEY.
            |User can get free key at: https://www.themoviedb.org/settings/api
            |
            |## API Endpoints
            |
            |### Search movies
            |```javascript
            |web_fetch({
            |  url: "https://api.themoviedb.org/3/search/movie?api_key={KEY}&query=Dune"
            |})
            |```
            |
            |### Get trending
            |```javascript
            |web_fetch({
            |  url: "https://api.themoviedb.org/3/trending/all/day?api_key={KEY}"
            |})
            |```
            |
            |## Response Format
            |
            |🎬 **Dune: Part Two** (2024)
            |Rating: 8.3/10
            |Genre: Science Fiction, Adventure
            |Synopsis: Follow the mythic journey...
        """.trimMargin().trimEnd() + "\n")

        // GitHub skill (REST API - optional token)
        seedSkill(skillsDir, manifest, "github", "1.0.0", """
            |---
            |name: github
            |description: "Search repositories, view issues, check PRs on GitHub"
            |version: "1.0.0"
            |metadata:
            |  openclaw:
            |    emoji: "🐙"
            |    requires:
            |      bins: []
            |      env: ["GITHUB_TOKEN"]
            |---
            |
            |# GitHub
            |
            |Interact with GitHub using the REST API.
            |
            |## When to Use
            |
            |User asks about:
            |- Repositories ("Find Kotlin repos", "My repos")
            |- Issues ("Open issues on X")
            |- Pull requests
            |
            |## Authentication
            |
            |For private repos, check memory for GITHUB_TOKEN.
            |Public repos work without token (lower rate limit).
            |
            |## API Endpoints
            |
            |### Search repos (no auth)
            |```javascript
            |web_fetch({
            |  url: "https://api.github.com/search/repositories?q=language:kotlin+stars:>1000"
            |})
            |```
            |
            |### With auth
            |```javascript
            |web_fetch({
            |  url: "https://api.github.com/user/repos",
            |  headers: {
            |    "Authorization": "Bearer {TOKEN}",
            |    "Accept": "application/vnd.github+json"
            |  }
            |})
            |```
            |
            |## Rate Limits
            |
            |- Unauthenticated: 60 req/hour
            |- Authenticated: 5,000 req/hour
        """.trimMargin().trimEnd() + "\n")

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

    // Files to exclude from export (regenerated or transient)
    private val EXPORT_EXCLUDE = setOf(
        "config.yaml", "config.json", "node_debug.log", "skills-manifest.json"
    )

    /**
     * Export workspace memory to a ZIP file at the given URI.
     * Includes: SOUL.md, MEMORY.md, IDENTITY.md, USER.md, HEARTBEAT.md,
     *           memory dir, skills dir, BOOTSTRAP.md
     * Excludes: config.yaml, config.json, node_debug.log
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
                    addDirectoryToZip(zip, workspaceDir, workspaceDir)
                }
            }
            Log.i(TAG, "Memory exported successfully")
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to export memory", e)
            false
        }
    }

    private fun addDirectoryToZip(zip: ZipOutputStream, dir: File, baseDir: File) {
        val files = dir.listFiles() ?: return
        for (file in files) {
            val relativePath = file.relativeTo(baseDir).path.replace("\\", "/")

            // Skip excluded files
            if (file.name in EXPORT_EXCLUDE) continue

            if (file.isDirectory) {
                addDirectoryToZip(zip, file, baseDir)
            } else {
                zip.putNextEntry(ZipEntry(relativePath))
                file.inputStream().use { it.copyTo(zip) }
                zip.closeEntry()
            }
        }
    }

    /**
     * Import workspace memory from a ZIP file at the given URI.
     * Extracts into workspace directory, overwriting existing files.
     * Does NOT overwrite config.yaml/config.json (those are regenerated).
     */
    fun importMemory(context: Context, uri: Uri): Boolean {
        val workspaceDir = File(context.filesDir, "workspace").apply { mkdirs() }

        return try {
            context.contentResolver.openInputStream(uri)?.use { inputStream ->
                ZipInputStream(inputStream).use { zip ->
                    var entry = zip.nextEntry
                    while (entry != null) {
                        val entryName = entry.name

                        // Skip config files (regenerated from encrypted store)
                        if (entryName in EXPORT_EXCLUDE) {
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
                            destFile.parentFile?.mkdirs()
                            destFile.outputStream().use { zip.copyTo(it) }
                        }

                        zip.closeEntry()
                        entry = zip.nextEntry
                    }
                }
            }
            Log.i(TAG, "Memory imported successfully")
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to import memory", e)
            false
        }
    }
}
