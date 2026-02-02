package com.seekerclaw.app.config

import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import java.io.File

data class AppConfig(
    val anthropicApiKey: String,
    val telegramBotToken: String,
    val telegramOwnerId: String,
    val model: String,
    val agentName: String,
    val autoStartOnBoot: Boolean = true,
)

object ConfigManager {
    private const val PREFS_NAME = "seekerclaw_prefs"
    private const val KEY_API_KEY_ENC = "api_key_enc"
    private const val KEY_BOT_TOKEN_ENC = "bot_token_enc"
    private const val KEY_OWNER_ID = "owner_id"
    private const val KEY_MODEL = "model"
    private const val KEY_AGENT_NAME = "agent_name"
    private const val KEY_AUTO_START = "auto_start_on_boot"
    private const val KEY_SETUP_COMPLETE = "setup_complete"

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun isSetupComplete(context: Context): Boolean =
        prefs(context).getBoolean(KEY_SETUP_COMPLETE, false)

    fun saveConfig(context: Context, config: AppConfig) {
        val encApiKey = KeystoreHelper.encrypt(config.anthropicApiKey)
        val encBotToken = KeystoreHelper.encrypt(config.telegramBotToken)

        prefs(context).edit()
            .putString(KEY_API_KEY_ENC, Base64.encodeToString(encApiKey, Base64.NO_WRAP))
            .putString(KEY_BOT_TOKEN_ENC, Base64.encodeToString(encBotToken, Base64.NO_WRAP))
            .putString(KEY_OWNER_ID, config.telegramOwnerId)
            .putString(KEY_MODEL, config.model)
            .putString(KEY_AGENT_NAME, config.agentName)
            .putBoolean(KEY_AUTO_START, config.autoStartOnBoot)
            .putBoolean(KEY_SETUP_COMPLETE, true)
            .apply()
    }

    fun loadConfig(context: Context): AppConfig? {
        val p = prefs(context)
        if (!p.getBoolean(KEY_SETUP_COMPLETE, false)) return null

        val encApiKeyB64 = p.getString(KEY_API_KEY_ENC, null) ?: return null
        val encBotTokenB64 = p.getString(KEY_BOT_TOKEN_ENC, null) ?: return null

        val apiKey = KeystoreHelper.decrypt(Base64.decode(encApiKeyB64, Base64.NO_WRAP))
        val botToken = KeystoreHelper.decrypt(Base64.decode(encBotTokenB64, Base64.NO_WRAP))

        return AppConfig(
            anthropicApiKey = apiKey,
            telegramBotToken = botToken,
            telegramOwnerId = p.getString(KEY_OWNER_ID, "") ?: "",
            model = p.getString(KEY_MODEL, "claude-sonnet-4-20250514") ?: "claude-sonnet-4-20250514",
            agentName = p.getString(KEY_AGENT_NAME, "MyAgent") ?: "MyAgent",
            autoStartOnBoot = p.getBoolean(KEY_AUTO_START, true),
        )
    }

    fun getAutoStartOnBoot(context: Context): Boolean =
        prefs(context).getBoolean(KEY_AUTO_START, true)

    fun setAutoStartOnBoot(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_AUTO_START, enabled).apply()
    }

    fun clearConfig(context: Context) {
        prefs(context).edit().clear().apply()
        KeystoreHelper.deleteKey()
    }

    /**
     * Write config.yaml to the workspace directory for OpenClaw to read.
     */
    fun writeConfigYaml(context: Context) {
        val config = loadConfig(context) ?: return
        val workspaceDir = File(context.filesDir, "workspace").apply { mkdirs() }
        val yaml = """
            |version: 1
            |providers:
            |  anthropic:
            |    apiKey: "${config.anthropicApiKey}"
            |
            |agents:
            |  main:
            |    model: "${config.model}"
            |    channel: telegram
            |
            |channels:
            |  telegram:
            |    botToken: "${config.telegramBotToken}"
            |    ownerIds:
            |      - "${config.telegramOwnerId}"
            |    polling: true
        """.trimMargin()
        File(workspaceDir, "config.yaml").writeText(yaml)

        // Also write config.json for easy reading from Node.js
        val json = """
            |{
            |  "botToken": "${config.telegramBotToken}",
            |  "ownerId": "${config.telegramOwnerId}",
            |  "apiKey": "${config.anthropicApiKey}",
            |  "model": "${config.model}",
            |  "agentName": "${config.agentName}"
            |}
        """.trimMargin()
        File(workspaceDir, "config.json").writeText(json)
    }

    /**
     * Seed workspace with default SOUL.md and MEMORY.md on first launch.
     */
    fun seedWorkspace(context: Context) {
        val workspaceDir = File(context.filesDir, "workspace").apply { mkdirs() }

        val soulFile = File(workspaceDir, "SOUL.md")
        if (!soulFile.exists()) {
            soulFile.writeText(
                """
                |# Agent Personality
                |
                |You are a helpful, friendly AI assistant running on a Solana Seeker phone.
                |You communicate via Telegram and help your owner with tasks, questions,
                |and conversation. Be concise, helpful, and personable.
                """.trimMargin()
            )
        }

        val memoryFile = File(workspaceDir, "MEMORY.md")
        if (!memoryFile.exists()) {
            memoryFile.writeText("")
        }

        // Create memory directory
        File(workspaceDir, "memory").mkdirs()
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
}
