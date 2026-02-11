package com.seekerclaw.app.config

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import android.util.Base64
import com.seekerclaw.app.Constants
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
import com.seekerclaw.app.util.Result
import java.io.File

data class AppConfig(
    val anthropicApiKey: String,
    val setupToken: String = "",
    val authType: String = "api_key", // "api_key" or "setup_token"
    val telegramBotToken: String,
    val telegramOwnerId: String,
    val model: String,
    val agentName: String,
    val braveApiKey: String = "",
    val autoStartOnBoot: Boolean = true,
) {
    /** Returns the credential that should be used based on the current authType. */
    val activeCredential: String
        get() = if (authType == "setup_token") setupToken else anthropicApiKey
}

object ConfigManager {
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
    private const val KEY_WALLET_ADDRESS = "wallet_address"
    private const val KEY_WALLET_LABEL = "wallet_label"

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /**
     * Helper function to decrypt a field from SharedPreferences.
     * Returns empty string if field doesn't exist, or Result.Failure if decryption fails.
     */
    private fun decryptField(
        prefs: SharedPreferences,
        key: String,
        fieldName: String
    ): Result<String> {
        val encrypted = prefs.getString(key, null) ?: return Result.Success("")

        return when (val result = KeystoreHelper.decrypt(Base64.decode(encrypted, Base64.NO_WRAP))) {
            is Result.Success -> Result.Success(result.data)
            is Result.Failure -> {
                LogCollector.append("[Config] Failed to decrypt $fieldName: ${result.error}", LogLevel.WARN)
                Result.Failure("Failed to decrypt $fieldName: ${result.error}", result.exception)
            }
        }
    }

    fun isSetupComplete(context: Context): Boolean =
        prefs(context).getBoolean(KEY_SETUP_COMPLETE, false)

    fun markSetupSkipped(context: Context) {
        prefs(context).edit()
            .putBoolean(KEY_SETUP_COMPLETE, true)
            .apply()
    }

    fun saveConfig(context: Context, config: AppConfig): Result<Unit> {
        // Encrypt all sensitive fields
        val encApiKeyResult = KeystoreHelper.encrypt(config.anthropicApiKey)
        if (encApiKeyResult is Result.Failure) {
            return Result.Failure("Failed to encrypt API key: ${encApiKeyResult.error}", encApiKeyResult.exception)
        }

        val encBotTokenResult = KeystoreHelper.encrypt(config.telegramBotToken)
        if (encBotTokenResult is Result.Failure) {
            return Result.Failure("Failed to encrypt bot token: ${encBotTokenResult.error}", encBotTokenResult.exception)
        }

        val encApiKey = (encApiKeyResult as Result.Success).data
        val encBotToken = (encBotTokenResult as Result.Success).data

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
            when (val encSetupTokenResult = KeystoreHelper.encrypt(config.setupToken)) {
                is Result.Success -> {
                    editor.putString(KEY_SETUP_TOKEN_ENC, Base64.encodeToString(encSetupTokenResult.data, Base64.NO_WRAP))
                }
                is Result.Failure -> {
                    return Result.Failure("Failed to encrypt setup token: ${encSetupTokenResult.error}", encSetupTokenResult.exception)
                }
            }
        } else {
            editor.remove(KEY_SETUP_TOKEN_ENC)
        }

        if (config.braveApiKey.isNotBlank()) {
            when (val encBraveResult = KeystoreHelper.encrypt(config.braveApiKey)) {
                is Result.Success -> {
                    editor.putString(KEY_BRAVE_API_KEY_ENC, Base64.encodeToString(encBraveResult.data, Base64.NO_WRAP))
                }
                is Result.Failure -> {
                    return Result.Failure("Failed to encrypt Brave API key: ${encBraveResult.error}", encBraveResult.exception)
                }
            }
        } else {
            editor.remove(KEY_BRAVE_API_KEY_ENC)
        }

        editor.apply()
        return Result.Success(Unit)
    }

    fun loadConfig(context: Context): Result<AppConfig> {
        val p = prefs(context)
        if (!p.getBoolean(KEY_SETUP_COMPLETE, false)) {
            return Result.Failure("Setup not complete")
        }

        // Decrypt all sensitive fields using helper function
        val apiKeyResult = decryptField(p, KEY_API_KEY_ENC, "API key")
        if (apiKeyResult is Result.Failure) return apiKeyResult

        val botTokenResult = decryptField(p, KEY_BOT_TOKEN_ENC, "bot token")
        if (botTokenResult is Result.Failure) return botTokenResult

        val setupTokenResult = decryptField(p, KEY_SETUP_TOKEN_ENC, "setup token")
        if (setupTokenResult is Result.Failure) return setupTokenResult

        val braveApiKeyResult = decryptField(p, KEY_BRAVE_API_KEY_ENC, "Brave API key")
        if (braveApiKeyResult is Result.Failure) return braveApiKeyResult

        return Result.Success(
            AppConfig(
                anthropicApiKey = (apiKeyResult as Result.Success).data,
                setupToken = (setupTokenResult as Result.Success).data,
                authType = p.getString(KEY_AUTH_TYPE, "api_key") ?: "api_key",
                telegramBotToken = (botTokenResult as Result.Success).data,
                telegramOwnerId = p.getString(KEY_OWNER_ID, "") ?: "",
                model = p.getString(KEY_MODEL, Constants.DEFAULT_MODEL) ?: Constants.DEFAULT_MODEL,
                agentName = p.getString(KEY_AGENT_NAME, "MyAgent") ?: "MyAgent",
                braveApiKey = (braveApiKeyResult as Result.Success).data,
                autoStartOnBoot = p.getBoolean(KEY_AUTO_START, true),
            )
        )
    }

    fun getAutoStartOnBoot(context: Context): Boolean =
        prefs(context).getBoolean(KEY_AUTO_START, true)

    fun setAutoStartOnBoot(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_AUTO_START, enabled).apply()
    }

    fun getKeepScreenOn(context: Context): Boolean =
        prefs(context).getBoolean(KEY_KEEP_SCREEN_ON, false)

    fun setKeepScreenOn(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_KEEP_SCREEN_ON, enabled).apply()
    }

    fun updateConfigField(context: Context, field: String, value: String): Result<Unit> {
        val configResult = loadConfig(context)
        if (configResult is Result.Failure) {
            return Result.Failure("Cannot update config field: ${configResult.error}", configResult.exception)
        }

        val config = (configResult as Result.Success).data
        val updated = when (field) {
            "anthropicApiKey" -> config.copy(anthropicApiKey = value)
            "setupToken" -> config.copy(setupToken = value)
            "telegramBotToken" -> config.copy(telegramBotToken = value)
            "telegramOwnerId" -> config.copy(telegramOwnerId = value)
            "model" -> config.copy(model = value)
            "agentName" -> config.copy(agentName = value)
            "authType" -> config.copy(authType = value)
            "braveApiKey" -> config.copy(braveApiKey = value)
            else -> return Result.Failure("Unknown config field: $field")
        }

        return saveConfig(context, updated)
    }

    fun saveOwnerId(context: Context, ownerId: String) {
        prefs(context).edit().putString(KEY_OWNER_ID, ownerId).apply()
    }

    fun clearConfig(context: Context): Result<Unit> {
        prefs(context).edit().clear().apply()
        return when (val result = KeystoreHelper.deleteKey()) {
            is Result.Success -> {
                LogCollector.append("[Config] Config cleared successfully")
                Result.Success(Unit)
            }
            is Result.Failure -> {
                LogCollector.append("[Config] Failed to delete keystore key: ${result.error}", LogLevel.WARN)
                // Still return success since prefs were cleared - key deletion is best-effort
                Result.Success(Unit)
            }
        }
    }

    /**
     * Write ephemeral config.json to workspace for Node.js to read on startup.
     * Includes per-boot bridge auth token. File is deleted after Node.js reads it.
     * Returns Result<Unit> - Failure if config cannot be loaded or written.
     */
    fun writeConfigJson(context: Context, bridgeToken: String): Result<Unit> {
        val configResult = loadConfig(context)
        if (configResult is Result.Failure) {
            return Result.Failure("Cannot write config.json: ${configResult.error}", configResult.exception)
        }

        val config = (configResult as Result.Success).data
        val workspaceDir = File(context.filesDir, "workspace").apply { mkdirs() }
        val credential = config.activeCredential
        val braveField = if (config.braveApiKey.isNotBlank()) {
            """,
            |  "braveApiKey": "${config.braveApiKey}""""
        } else ""
        val json = """
            |{
            |  "botToken": "${config.telegramBotToken}",
            |  "ownerId": "${config.telegramOwnerId}",
            |  "anthropicApiKey": "$credential",
            |  "authType": "${config.authType}",
            |  "model": "${config.model}",
            |  "agentName": "${config.agentName}",
            |  "bridgeToken": "$bridgeToken"$braveField
            |}
        """.trimMargin()

        return try {
            File(workspaceDir, "config.json").writeText(json)
            Result.Success(Unit)
        } catch (e: Exception) {
            LogCollector.append("[Config] Failed to write config.json: ${e.message}", LogLevel.ERROR)
            Result.Failure("Failed to write config.json: ${e.message}", e)
        }
    }

    // ==================== Auth Type Detection ====================

    fun detectAuthType(credential: String): String {
        val trimmed = credential.trim()
        return if (trimmed.startsWith(Constants.SETUP_TOKEN_PREFIX) &&
                   trimmed.length >= Constants.MIN_SETUP_TOKEN_LENGTH) {
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
                if (!trimmed.startsWith(Constants.SETUP_TOKEN_PREFIX)) {
                    "Setup token must start with ${Constants.SETUP_TOKEN_PREFIX}"
                } else if (trimmed.length < Constants.MIN_SETUP_TOKEN_LENGTH) {
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
        writeWalletConfig(context)
    }

    fun clearWalletAddress(context: Context) {
        prefs(context).edit()
            .remove(KEY_WALLET_ADDRESS)
            .remove(KEY_WALLET_LABEL)
            .apply()
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

    /**
     * Seed workspace with default files on first launch.
     * Delegates to WorkspaceManager.
     */
    fun seedWorkspace(context: Context) = WorkspaceManager.seedWorkspace(context)

    /**
     * Delete workspace memory files (MEMORY.md + memory/ directory).
     * Delegates to WorkspaceManager.
     */
    fun clearMemory(context: Context) = WorkspaceManager.clearMemory(context)

    // ==================== Memory Export/Import ====================

    /**
     * Export workspace memory to a ZIP file.
     * Delegates to MemoryExporter.
     */
    fun exportMemory(context: Context, uri: Uri): Boolean =
        MemoryExporter.exportMemory(context, uri)

    /**
     * Import workspace memory from a ZIP file.
     * Delegates to MemoryExporter.
     */
    fun importMemory(context: Context, uri: Uri): Boolean =
        MemoryExporter.importMemory(context, uri)
}
