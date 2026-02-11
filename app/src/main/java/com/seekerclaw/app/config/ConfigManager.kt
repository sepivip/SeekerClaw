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

        val apiKey = when {
            p.getString(KEY_API_KEY_ENC, null) != null -> {
                when (val result = KeystoreHelper.decrypt(Base64.decode(p.getString(KEY_API_KEY_ENC, null)!!, Base64.NO_WRAP))) {
                    is Result.Success -> result.data
                    is Result.Failure -> {
                        LogCollector.append("[Config] Failed to decrypt API key: ${result.error}", LogLevel.WARN)
                        return Result.Failure("Failed to decrypt API key: ${result.error}", result.exception)
                    }
                }
            }
            else -> ""
        }

        val botToken = when {
            p.getString(KEY_BOT_TOKEN_ENC, null) != null -> {
                when (val result = KeystoreHelper.decrypt(Base64.decode(p.getString(KEY_BOT_TOKEN_ENC, null)!!, Base64.NO_WRAP))) {
                    is Result.Success -> result.data
                    is Result.Failure -> {
                        LogCollector.append("[Config] Failed to decrypt bot token: ${result.error}", LogLevel.WARN)
                        return Result.Failure("Failed to decrypt bot token: ${result.error}", result.exception)
                    }
                }
            }
            else -> ""
        }

        val setupToken = when {
            p.getString(KEY_SETUP_TOKEN_ENC, null) != null -> {
                when (val result = KeystoreHelper.decrypt(Base64.decode(p.getString(KEY_SETUP_TOKEN_ENC, null)!!, Base64.NO_WRAP))) {
                    is Result.Success -> result.data
                    is Result.Failure -> {
                        LogCollector.append("[Config] Failed to decrypt setup token: ${result.error}", LogLevel.WARN)
                        return Result.Failure("Failed to decrypt setup token: ${result.error}", result.exception)
                    }
                }
            }
            else -> ""
        }

        val braveApiKey = when {
            p.getString(KEY_BRAVE_API_KEY_ENC, null) != null -> {
                when (val result = KeystoreHelper.decrypt(Base64.decode(p.getString(KEY_BRAVE_API_KEY_ENC, null)!!, Base64.NO_WRAP))) {
                    is Result.Success -> result.data
                    is Result.Failure -> {
                        LogCollector.append("[Config] Failed to decrypt Brave API key: ${result.error}", LogLevel.WARN)
                        return Result.Failure("Failed to decrypt Brave API key: ${result.error}", result.exception)
                    }
                }
            }
            else -> ""
        }

        return Result.Success(
            AppConfig(
                anthropicApiKey = apiKey,
                setupToken = setupToken,
                authType = p.getString(KEY_AUTH_TYPE, "api_key") ?: "api_key",
                telegramBotToken = botToken,
                telegramOwnerId = p.getString(KEY_OWNER_ID, "") ?: "",
                model = p.getString(KEY_MODEL, Constants.DEFAULT_MODEL) ?: Constants.DEFAULT_MODEL,
                agentName = p.getString(KEY_AGENT_NAME, "MyAgent") ?: "MyAgent",
                braveApiKey = braveApiKey,
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

    /**
     * Seed workspace with example skills demonstrating the Skills system.
     */
    private fun seedSkills(workspaceDir: File) {
        val skillsDir = File(workspaceDir, "skills").apply { mkdirs() }

        // Weather skill
        val weatherDir = File(skillsDir, "weather").apply { mkdirs() }
        val weatherSkill = File(weatherDir, "SKILL.md")
        if (!weatherSkill.exists()) {
            weatherSkill.writeText(
                """
                |# Weather
                |
                |Trigger: weather, forecast, temperature, rain, snow, sunny, cloudy, humidity
                |
                |## Description
                |Get current weather information and forecasts for any location.
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
                """.trimMargin()
            )
        }

        // Web Research skill
        val researchDir = File(skillsDir, "research").apply { mkdirs() }
        val researchSkill = File(researchDir, "SKILL.md")
        if (!researchSkill.exists()) {
            researchSkill.writeText(
                """
                |# Web Research
                |
                |Trigger: research, find out, look up, search for, what is, who is, tell me about
                |
                |## Description
                |Deep research on topics using web search and page fetching.
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
                """.trimMargin()
            )
        }

        // Daily Briefing skill
        val briefingDir = File(skillsDir, "briefing").apply { mkdirs() }
        val briefingSkill = File(briefingDir, "SKILL.md")
        if (!briefingSkill.exists()) {
            briefingSkill.writeText(
                """
                |# Daily Briefing
                |
                |Trigger: briefing, morning, daily update, what's happening, news today, catch me up
                |
                |## Description
                |Provide a personalized daily briefing with news, weather, and reminders.
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
                """.trimMargin()
            )
        }

        // Reminders skill
        val remindersDir = File(skillsDir, "reminders").apply { mkdirs() }
        val remindersSkill = File(remindersDir, "SKILL.md")
        if (!remindersSkill.exists()) {
            remindersSkill.writeText(
                """
                |---
                |name: reminders
                |description: "Set reminders that will notify you at the specified time"
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
                """.trimMargin()
            )
        }

        // Quick Notes skill
        val notesDir = File(skillsDir, "notes").apply { mkdirs() }
        val notesSkill = File(notesDir, "SKILL.md")
        if (!notesSkill.exists()) {
            notesSkill.writeText(
                """
                |# Quick Notes
                |
                |Trigger: note, jot down, write down, save this, remember this, take note
                |
                |## Description
                |Quickly capture and organize notes for later reference.
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
                """.trimMargin()
            )
        }

        // Translate skill
        val translateDir = File(skillsDir, "translate").apply { mkdirs() }
        val translateSkill = File(translateDir, "SKILL.md")
        if (!translateSkill.exists()) {
            translateSkill.writeText(
                """
                |# Translate
                |
                |Trigger: translate, translation, in english, in spanish, how do you say, what does mean
                |
                |## Description
                |Translate text between languages.
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
                """.trimMargin()
            )
        }

        // Calculator skill
        val calcDir = File(skillsDir, "calculator").apply { mkdirs() }
        val calcSkill = File(calcDir, "SKILL.md")
        if (!calcSkill.exists()) {
            calcSkill.writeText(
                """
                |# Calculator
                |
                |Trigger: calculate, math, convert, how much is, percentage, divide, multiply, plus, minus
                |
                |## Description
                |Perform calculations, unit conversions, and math operations.
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
                """.trimMargin()
            )
        }

        // Summarize skill
        val summarizeDir = File(skillsDir, "summarize").apply { mkdirs() }
        val summarizeSkill = File(summarizeDir, "SKILL.md")
        if (!summarizeSkill.exists()) {
            summarizeSkill.writeText(
                """
                |# Summarize
                |
                |Trigger: summarize, summary, tldr, sum up, key points, main ideas, recap
                |
                |## Description
                |Summarize web pages, articles, or text content.
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
                """.trimMargin()
            )
        }

        // Timer skill
        val timerDir = File(skillsDir, "timer").apply { mkdirs() }
        val timerSkill = File(timerDir, "SKILL.md")
        if (!timerSkill.exists()) {
            timerSkill.writeText(
                """
                |---
                |name: timer
                |description: "Set countdown timers for cooking, workouts, or any timed activity"
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
                """.trimMargin()
            )
        }

        // Define skill
        val defineDir = File(skillsDir, "define").apply { mkdirs() }
        val defineSkill = File(defineDir, "SKILL.md")
        if (!defineSkill.exists()) {
            defineSkill.writeText(
                """
                |---
                |name: define
                |description: "Look up definitions, word meanings, and etymology"
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
                """.trimMargin()
            )
        }

        // News skill
        val newsDir = File(skillsDir, "news").apply { mkdirs() }
        val newsSkill = File(newsDir, "SKILL.md")
        if (!newsSkill.exists()) {
            newsSkill.writeText(
                """
                |---
                |name: news
                |description: "Get latest news headlines and current events"
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
                """.trimMargin()
            )
        }

        // Todo skill
        val todoDir = File(skillsDir, "todo").apply { mkdirs() }
        val todoSkill = File(todoDir, "SKILL.md")
        if (!todoSkill.exists()) {
            todoSkill.writeText(
                """
                |---
                |name: todo
                |description: "Manage tasks and to-do lists with add, complete, and list operations"
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
                """.trimMargin()
            )
        }

        // Bookmark skill
        val bookmarkDir = File(skillsDir, "bookmark").apply { mkdirs() }
        val bookmarkSkill = File(bookmarkDir, "SKILL.md")
        if (!bookmarkSkill.exists()) {
            bookmarkSkill.writeText(
                """
                |---
                |name: bookmark
                |description: "Save and organize links for later reading"
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
                """.trimMargin()
            )
        }

        // Joke skill
        val jokeDir = File(skillsDir, "joke").apply { mkdirs() }
        val jokeSkill = File(jokeDir, "SKILL.md")
        if (!jokeSkill.exists()) {
            jokeSkill.writeText(
                """
                |---
                |name: joke
                |description: "Tell jokes and make the user laugh"
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
                """.trimMargin()
            )
        }

        // Quote skill
        val quoteDir = File(skillsDir, "quote").apply { mkdirs() }
        val quoteSkill = File(quoteDir, "SKILL.md")
        if (!quoteSkill.exists()) {
            quoteSkill.writeText(
                """
                |---
                |name: quote
                |description: "Share inspirational quotes and wisdom"
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
                """.trimMargin()
            )
        }

        // ============================================
        // Phase 4: API-Based Skills (using web_fetch)
        // ============================================

        // Crypto Prices skill (CoinGecko - free, no API key)
        val cryptoDir = File(skillsDir, "crypto-prices").apply { mkdirs() }
        val cryptoSkill = File(cryptoDir, "SKILL.md")
        if (!cryptoSkill.exists()) {
            cryptoSkill.writeText(
                """
                |---
                |name: crypto-prices
                |description: "Get real-time cryptocurrency prices and market data from CoinGecko (free, no API key)"
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
                """.trimMargin()
            )
        }

        // Movie & TV skill (TMDB - free with key)
        val movieDir = File(skillsDir, "movie-tv").apply { mkdirs() }
        val movieSkill = File(movieDir, "SKILL.md")
        if (!movieSkill.exists()) {
            movieSkill.writeText(
                """
                |---
                |name: movie-tv
                |description: "Search movies and TV shows, get ratings, recommendations using TMDB"
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
                """.trimMargin()
            )
        }

        // GitHub skill (REST API - optional token)
        val githubDir = File(skillsDir, "github").apply { mkdirs() }
        val githubSkill = File(githubDir, "SKILL.md")
        if (!githubSkill.exists()) {
            githubSkill.writeText(
                """
                |---
                |name: github
                |description: "Search repositories, view issues, check PRs on GitHub"
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
                """.trimMargin()
            )
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

    // Files to exclude from export (regenerated or transient)
    private val EXPORT_EXCLUDE = setOf(
        "config.yaml", "config.json", "node_debug.log"
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
            LogCollector.append("[Config] Cannot export: workspace directory does not exist", LogLevel.ERROR)
            return false
        }

        return try {
            context.contentResolver.openOutputStream(uri)?.use { outputStream ->
                ZipOutputStream(outputStream).use { zip ->
                    addDirectoryToZip(zip, workspaceDir, workspaceDir)
                }
            }
            LogCollector.append("[Config] Memory exported successfully")
            true
        } catch (e: Exception) {
            LogCollector.append("[Config] Failed to export memory: ${e.message}", LogLevel.ERROR)
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
                            LogCollector.append("[Config] Skipping suspicious import entry: $entryName", LogLevel.WARN)
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
            LogCollector.append("[Config] Memory imported successfully")
            true
        } catch (e: Exception) {
            LogCollector.append("[Config] Failed to import memory: ${e.message}", LogLevel.ERROR)
            false
        }
    }
}
