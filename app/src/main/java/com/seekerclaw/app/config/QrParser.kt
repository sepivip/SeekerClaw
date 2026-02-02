package com.seekerclaw.app.config

import android.util.Base64
import org.json.JSONObject

data class QrPayload(
    val version: Int,
    val anthropicApiKey: String,
    val telegramBotToken: String,
    val telegramOwnerId: String,
    val model: String,
    val agentName: String,
)

object QrParser {

    fun parse(raw: String): Result<QrPayload> = runCatching {
        val decoded = Base64.decode(raw.trim(), Base64.DEFAULT)
        val json = JSONObject(String(decoded, Charsets.UTF_8))

        val version = json.optInt("v", 1)
        require(version == 1) { "Unsupported QR payload version: $version" }

        QrPayload(
            version = version,
            anthropicApiKey = json.getString("anthropic_api_key"),
            telegramBotToken = json.getString("telegram_bot_token"),
            telegramOwnerId = json.getString("telegram_owner_id"),
            model = json.optString("model", "claude-sonnet-4-20250514"),
            agentName = json.optString("agent_name", "MyAgent"),
        )
    }
}
