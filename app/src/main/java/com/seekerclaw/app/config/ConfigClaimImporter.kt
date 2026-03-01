package com.seekerclaw.app.config

import android.net.Uri
import com.seekerclaw.app.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.Base64

data class ConfigClaimImport(
    val config: AppConfig,
    val sourceUrl: String,
    val claimId: String? = null,
    val schemaVersion: Int = 1,
    val autoStartOnBoot: Boolean? = null,
    val keepScreenOn: Boolean? = null,
)

object ConfigClaimImporter {
    private data class ClaimRef(
        val url: String,
        val claimId: String?,
    )

    suspend fun fetchFromQr(qrText: String): Result<ConfigClaimImport> = withContext(Dispatchers.IO) {
        runCatching {
            val raw = qrText.trim()
            val inline = parseInlineConfigJson(raw)
            if (inline != null) {
                return@runCatching parseImport(inline.first, inline.second, null)
            }

            val ref = parseClaimRef(raw)
                ?: error("Unsupported QR format. Expected seekerclaw://config payload, seekerclaw://claim, raw JSON, or https URL.")
            val claimUri = Uri.parse(ref.url)
            require(isAllowedClaimUrl(claimUri)) {
                "Claim URL must use HTTPS (or localhost HTTP for development)."
            }

            val (status, body) = httpGet(ref.url)
            require(status in 200..299) { "Claim fetch failed ($status): ${body.take(200)}" }
            val root = JSONObject(body)
            parseImport(root, ref.url, ref.claimId)
        }
    }

    private fun parseImport(root: JSONObject, sourceUrl: String, claimIdHint: String?): ConfigClaimImport {
        val cfg = if (root.has("config") && root.opt("config") is JSONObject) {
            root.getJSONObject("config")
        } else {
            root
        }
        val schemaVersion = root.optInt("v", cfg.optInt("v", 1)).coerceAtLeast(1)

        val auth = cfg.optJSONObject("auth")
        val telegram = cfg.optJSONObject("telegram")
        val agent = cfg.optJSONObject("agent")
        val integrations = cfg.optJSONObject("integrations")
        val device = cfg.optJSONObject("device")

        val rawAuthType = firstNonBlank(
            auth?.optString("type"),
            cfg.optString("authType"),
            root.optString("authType"),
        )
        val rawApiKey = firstNonBlank(
            auth?.optString("apiKey"),
            auth?.optString("anthropicApiKey"),
            cfg.optString("anthropicApiKey"),
            root.optString("anthropicApiKey"),
        )
        val rawSetupToken = firstNonBlank(
            auth?.optString("setupToken"),
            cfg.optString("setupToken"),
            root.optString("setupToken"),
        )
        val credential = firstNonBlank(
            auth?.optString("credential"),
            cfg.optString("credential"),
            root.optString("credential"),
        )

        val authType = normalizeAuthType(rawAuthType, credential, rawApiKey, rawSetupToken)

        val resolvedApiKey: String
        val resolvedSetupToken: String
        if (credential.isNotBlank() && rawApiKey.isBlank() && rawSetupToken.isBlank()) {
            if (authType == "setup_token") {
                resolvedApiKey = ""
                resolvedSetupToken = credential
            } else {
                resolvedApiKey = credential
                resolvedSetupToken = ""
            }
        } else {
            resolvedApiKey = rawApiKey
            resolvedSetupToken = rawSetupToken
        }

        val botToken = firstNonBlank(
            telegram?.optString("botToken"),
            telegram?.optString("telegramBotToken"),
            cfg.optString("telegramBotToken"),
            cfg.optString("botToken"),
            root.optString("telegramBotToken"),
            root.optString("botToken"),
        ).trim()
        val ownerId = firstNonBlank(
            telegram?.optString("ownerId"),
            telegram?.optString("telegramOwnerId"),
            cfg.optString("telegramOwnerId"),
            cfg.optString("ownerId"),
            root.optString("telegramOwnerId"),
            root.optString("ownerId"),
        ).trim()
        val model = firstNonBlank(
            agent?.optString("model"),
            cfg.optString("model"),
            root.optString("model"),
            "claude-opus-4-6",
        ).ifBlank { "claude-opus-4-6" }
        val agentName = firstNonBlank(
            agent?.optString("name"),
            agent?.optString("agentName"),
            cfg.optString("agentName"),
            root.optString("agentName"),
            "SeekerClaw",
        ).ifBlank { "SeekerClaw" }
        val braveApiKey = firstNonBlank(
            integrations?.optString("braveApiKey"),
            cfg.optString("braveApiKey"),
            root.optString("braveApiKey"),
        )

        val autoStartOnBoot = firstNonNull(
            readBoolean(device, "autoStartOnBoot"),
            readBoolean(cfg, "autoStartOnBoot"),
            readBoolean(root, "autoStartOnBoot"),
        )
        val keepScreenOn = firstNonNull(
            readBoolean(device, "keepScreenOn"),
            readBoolean(cfg, "keepScreenOn"),
            readBoolean(root, "keepScreenOn"),
        )

        val appConfig = AppConfig(
            anthropicApiKey = resolvedApiKey.trim(),
            setupToken = resolvedSetupToken.trim(),
            authType = authType,
            telegramBotToken = botToken,
            telegramOwnerId = ownerId,
            model = model,
            agentName = agentName,
            braveApiKey = braveApiKey.trim(),
        )

        require(appConfig.telegramBotToken.isNotBlank()) { "Config is missing telegramBotToken." }
        require(appConfig.activeCredential.isNotBlank()) { "Config is missing AI credential." }

        return ConfigClaimImport(
            config = appConfig,
            sourceUrl = sourceUrl,
            claimId = claimIdHint
                ?: cfg.optString("claimId", "").ifBlank { null }
                ?: root.optString("claimId", "").ifBlank { null },
            schemaVersion = schemaVersion,
            autoStartOnBoot = autoStartOnBoot,
            keepScreenOn = keepScreenOn,
        )
    }

    private fun parseInlineConfigJson(text: String): Pair<JSONObject, String>? {
        if (text.isBlank()) return null

        if (text.startsWith("{")) {
            return JSONObject(text) to "inline-json"
        }

        val uri = Uri.parse(text)
        if (!uri.scheme.equals("seekerclaw", ignoreCase = true)) return null
        if (!uri.host.equals("config", ignoreCase = true)) return null

        val payload = firstNonBlank(
            uri.getQueryParameter("payload"),
            uri.getQueryParameter("data"),
            uri.getQueryParameter("p"),
        )
        if (payload.isNotBlank()) {
            val decoded = decodeBase64Url(payload)
            return JSONObject(decoded) to "inline-payload"
        }

        val json = firstNonBlank(
            uri.getQueryParameter("json"),
            uri.getQueryParameter("config"),
        )
        if (json.isNotBlank()) {
            return JSONObject(json) to "inline-query-json"
        }

        return null
    }

    private fun decodeBase64Url(value: String): String {
        val normalized = value.trim()
            .replace('-', '+')
            .replace('_', '/')
        val padding = (4 - normalized.length % 4) % 4
        val padded = normalized + "=".repeat(padding)
        val bytes = Base64.getDecoder().decode(padded)
        return bytes.toString(Charsets.UTF_8)
    }

    private fun parseClaimRef(text: String): ClaimRef? {
        if (text.isBlank()) return null

        val uri = Uri.parse(text)
        if (uri.scheme.equals("seekerclaw", ignoreCase = true)) {
            if (!uri.host.equals("claim", ignoreCase = true)) return null

            val directUrl = uri.getQueryParameter("url")?.trim()
            val claimId = uri.getQueryParameter("id")?.trim().orEmpty()
            val sig = uri.getQueryParameter("sig")?.trim().orEmpty()
            val token = uri.getQueryParameter("token")?.trim().orEmpty()

            if (!directUrl.isNullOrBlank()) {
                return ClaimRef(directUrl, claimId.ifBlank { null })
            }

            val base = uri.getQueryParameter("base")?.trim()?.trimEnd('/')
            if (!base.isNullOrBlank() && claimId.isNotBlank()) {
                val params = mutableListOf<String>()
                if (sig.isNotBlank()) params += "sig=${Uri.encode(sig)}"
                if (token.isNotBlank()) params += "token=${Uri.encode(token)}"
                val query = if (params.isEmpty()) "" else "?${params.joinToString("&")}"
                return ClaimRef("$base/api/mobile/config-claims/${Uri.encode(claimId)}$query", claimId)
            }
            return null
        }

        if (uri.scheme.equals("https", ignoreCase = true) || uri.scheme.equals("http", ignoreCase = true)) {
            return ClaimRef(text, uri.getQueryParameter("id"))
        }

        return null
    }

    private fun isAllowedClaimUrl(uri: Uri): Boolean {
        if (uri.scheme.equals("https", ignoreCase = true)) return true
        if (!uri.scheme.equals("http", ignoreCase = true)) return false
        val host = uri.host?.lowercase() ?: return false
        // M-22: Only allow emulator gateway address in debug builds
        if (host == "10.0.2.2") return BuildConfig.DEBUG
        return host == "localhost" || host == "127.0.0.1"
    }

    private fun httpGet(url: String): Pair<Int, String> {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 15_000
            readTimeout = 15_000
            setRequestProperty("Accept", "application/json")
            setRequestProperty("User-Agent", "SeekerClaw/Android")
        }

        return try {
            val status = conn.responseCode
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val body = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            status to body
        } finally {
            conn.disconnect()
        }
    }

    private fun firstNonBlank(vararg values: String?): String {
        for (v in values) {
            if (!v.isNullOrBlank()) return v
        }
        return ""
    }

    private fun <T> firstNonNull(vararg values: T?): T? {
        for (v in values) {
            if (v != null) return v
        }
        return null
    }

    private fun readBoolean(obj: JSONObject?, key: String): Boolean? {
        if (obj == null || !obj.has(key)) return null
        val raw = obj.opt(key) ?: return null
        return when (raw) {
            is Boolean -> raw
            is Number -> raw.toInt() != 0
            is String -> when (raw.trim().lowercase()) {
                "1", "true", "yes", "on" -> true
                "0", "false", "no", "off" -> false
                else -> null
            }
            else -> null
        }
    }

    private fun normalizeAuthType(raw: String, credential: String, apiKey: String, setupToken: String): String {
        val clean = raw.trim().lowercase()
        if (clean == "api_key" || clean == "setup_token") return clean
        if (setupToken.isNotBlank()) return "setup_token"
        if (apiKey.isNotBlank()) return "api_key"
        if (credential.isNotBlank()) return ConfigManager.detectAuthType(credential)
        return "api_key"
    }
}
