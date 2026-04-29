package com.seekerclaw.app.bridge

import android.Manifest
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.provider.ContactsContract
import android.speech.tts.TextToSpeech
import android.telephony.SmsManager
import android.util.Log
import androidx.core.content.ContextCompat
import com.seekerclaw.app.camera.CameraCaptureActivity
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.service.SeekerClawService
import com.seekerclaw.app.util.Analytics
import com.seekerclaw.app.util.ServiceState
import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/**
 * AndroidBridge - HTTP server for Node.js <-> Kotlin IPC
 *
 * Runs on localhost:8765 and provides Android-native capabilities
 * to the Node.js agent via simple HTTP POST requests.
 */
class AndroidBridge(
    private val context: Context,
    private val authToken: String,
    port: Int = 8765
) : NanoHTTPD("127.0.0.1", port) {

    companion object {
        private const val TAG = "AndroidBridge"
        private const val AUTH_HEADER = "X-Bridge-Token"
        // BAT-514: MCP server id format mirrors McpServersStore.ID_REGEX.
        // Validated at the bridge boundary as defense-in-depth /
        // early reject — McpTokenStore.read() also runs its own
        // ID_REGEX check before constructing the file path, so the
        // bridge check is the outer rail (rejects malformed JSON-RPC
        // input with HTTP 400 + a clean log) rather than a unique
        // safety boundary.
        private val MCP_TOKEN_ID_REGEX = Regex("^[A-Za-z0-9_-]+$")
        // Delay between returning HTTP 200 and stopping the service — gives the
        // Node caller (and its Telegram reply) time to flush.
        private const val RESTART_DELAY_MS = 500L
        // Delay from stopService to the AlarmManager-scheduled fresh start.
        // Long enough for onDestroy cleanup + process death + OS reclaim.
        private const val SERVICE_RESTART_DELAY_MS = 2_000L
        private const val SERVICE_RESTART_REQUEST_CODE = 1001
    }

    private var tts: TextToSpeech? = null
    private var ttsReady = false

    // Per-endpoint rate limiting (thread-safe for NanoHTTPD's thread pool)
    private val rateLimiter = ConcurrentHashMap<String, MutableList<Long>>()
    private val rateLimits = mapOf(
        "/sms" to Pair(5, 60_000L),
        "/call" to Pair(3, 60_000L),
        "/camera/capture" to Pair(10, 60_000L),
        "/contacts/search" to Pair(20, 60_000L),
        "/contacts/add" to Pair(10, 60_000L),
        "/location" to Pair(10, 60_000L),
        "/openai/oauth/save-tokens" to Pair(5, 60_000L),
        // /config/credentials loads AppConfig (Keystore decrypt +
        // agent_settings reconciliation) on every call — rate-limit so
        // a misbehaving Node caller can't spin it. 10/min is ample for
        // normal /provider interactive use.
        "/config/credentials" to Pair(10, 60_000L),
        // BAT-514: /config/mcp-token can fire once per MCP server per
        // connect; 30/min covers a 10-server install with reconcile
        // bursts during Settings edits without throttling normal use.
        "/config/mcp-token" to Pair(30, 60_000L),
        "/service/restart" to Pair(3, 60_000L),
    )

    @Synchronized
    private fun isRateLimited(endpoint: String): Boolean {
        val limit = rateLimits[endpoint] ?: return false
        val now = System.currentTimeMillis()
        val timestamps = rateLimiter.getOrPut(endpoint) { mutableListOf() }
        timestamps.removeAll { now - it > limit.second }
        if (timestamps.size >= limit.first) return true
        timestamps.add(now)
        return false
    }

    init {
        // Initialize Text-to-Speech
        tts = TextToSpeech(context) { status ->
            ttsReady = status == TextToSpeech.SUCCESS
            if (ttsReady) {
                tts?.language = Locale.US
            }
        }
    }

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri
        val method = session.method

        Log.d(TAG, "Request: $method $uri")

        // Only allow POST requests
        if (method != Method.POST) {
            return jsonResponse(400, mapOf("error" to "Only POST requests allowed"))
        }

        // Verify auth token on every request (per-boot random secret)
        val token = session.headers?.get(AUTH_HEADER.lowercase())
        if (token != authToken) {
            Log.w(TAG, "Unauthorized request to $uri (bad/missing token)")
            return jsonResponse(403, mapOf("error" to "Unauthorized"))
        }

        // Rate limiting for sensitive endpoints
        if (isRateLimited(uri)) {
            return jsonResponse(429, mapOf("error" to "Rate limit exceeded for $uri"))
        }

        // Parse body
        val body = mutableMapOf<String, String>()
        try {
            session.parseBody(body)
        } catch (e: Exception) {
            Log.e(TAG, "Error parsing body", e)
        }

        val postData = body["postData"] ?: "{}"
        val params = try {
            JSONObject(postData)
        } catch (e: Exception) {
            JSONObject()
        }

        return try {
            when (uri) {
                "/battery" -> handleBattery()
                "/storage" -> handleStorage()
                "/network" -> handleNetwork()
                "/clipboard/get" -> handleClipboardGet()
                "/clipboard/set" -> handleClipboardSet(params)
                "/contacts/search" -> handleContactsSearch(params)
                "/contacts/add" -> handleContactsAdd(params)
                "/sms" -> handleSms(params)
                "/call" -> handleCall(params)
                "/location" -> handleLocation()
                "/tts" -> handleTts(params)
                "/camera/capture" -> handleCameraCapture(params)
                "/apps/list" -> handleAppsList()
                "/apps/launch" -> handleAppsLaunch(params)
                "/stats/message" -> handleStatsMessage()
                "/stats/tokens" -> handleStatsTokens(params)
                "/solana/authorize" -> handleSolanaAuthorize()
                "/solana/address" -> handleSolanaAddress()
                "/solana/sign" -> handleSolanaSign(params)
                "/solana/sign-only" -> handleSolanaSignOnly(params)
                "/solana/send" -> handleSolanaSend(params)
                "/config/save-owner" -> handleConfigSaveOwner(params)
                "/openai/oauth/save-tokens" -> handleOpenAIOAuthSaveTokens(params)
                "/config/credentials" -> handleConfigCredentials()
                "/config/mcp-token" -> handleConfigMcpToken(params)
                "/service/restart" -> handleServiceRestart()
                "/stats/db-summary" -> proxyToNodeStats()
                "/ping" -> jsonResponse(200, mapOf("status" to "ok", "bridge" to "AndroidBridge"))
                else -> jsonResponse(404, mapOf("error" to "Unknown endpoint: $uri"))
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error handling $uri", e)
            jsonResponse(500, mapOf("error" to e.message))
        }
    }

    // ==================== Config credentials ====================

    /**
     * Returns credential PRESENCE (not values) for every provider auth
     * mode that /provider credential-gating cares about. Used by the
     * Node /provider handler so switching decisions reflect the
     * runtime Kotlin SharedPreferences (which gets updated on
     * Settings saves, OAuth token saves, etc.) rather than the stale
     * workspace/config.json snapshot that Node loaded at startup.
     *
     * Security: credential VALUES never leave Kotlin — every field
     * is returned as a short placeholder ("•") when set and "" when
     * unset, so Node's `nonBlank` credential-gating checks work
     * unchanged without exposing secrets across the bridge.
     *
     * customBaseUrl is returned the same way. Even though it's a URL
     * rather than a direct secret, URLs can legally embed credentials
     * (https://user:pass@host) or tokens in query params (?token=…),
     * so returning verbatim would risk accidental secret exposure to
     * Node's logs / bridge caller. Presence is all Node's gating
     * needs for the "is custom provider configured" check — the real
     * URL is read from config.json at service start when Node
     * actually needs to route requests.
     */
    private fun handleConfigCredentials(): Response {
        val config = ConfigManager.loadConfig(context)
        if (config == null) {
            return jsonResponse(200, mapOf("ok" to true, "credentials" to emptyMap<String, String>()))
        }
        val placeholder = "•" // • — any non-blank string; values never leak.
        val creds = mapOf(
            "anthropicApiKey" to if (config.anthropicApiKey.isNotBlank()) placeholder else "",
            "setupToken" to if (config.setupToken.isNotBlank()) placeholder else "",
            "openaiApiKey" to if (config.openaiApiKey.isNotBlank()) placeholder else "",
            "openaiOAuthToken" to if (config.openaiOAuthToken.isNotBlank()) placeholder else "",
            "openrouterApiKey" to if (config.openrouterApiKey.isNotBlank()) placeholder else "",
            "customApiKey" to if (config.customApiKey.isNotBlank()) placeholder else "",
            "customBaseUrl" to if (config.customBaseUrl.isNotBlank()) placeholder else "",
        )
        return jsonResponse(200, mapOf("ok" to true, "credentials" to creds))
    }

    // ==================== MCP token fetch (BAT-514) ====================

    /**
     * Returns the decrypted bearer token for the requested MCP server
     * id, sourced from per-id encrypted file storage
     * (`filesDir/mcp_tokens/<id>`, AES-GCM via `KeystoreHelper`).
     * Called by `MCPClient.connect` in `:node` once
     * per connect attempt — the token never persists in `MCP_SERVERS`
     * post-BAT-514, so the bridge fetch is the only path.
     *
     * Security:
     *  - Bridge-token auth on the outer hop (already enforced by
     *    [serve]).
     *  - Body validates `id` as `^[A-Za-z0-9_-]+$` so a hostile caller
     *    can't use path traversal or crafted names to probe arbitrary
     *    files via this endpoint; access is constrained to the
     *    intended per-id token files under `filesDir/mcp_tokens/`.
     *  - Returns `{ token: "" }` for unknown ids and decryption
     *    failures — the caller can't distinguish "no token" from
     *    "decrypt failed", which is the same defensive behavior as
     *    `McpTokenStore.read`.
     */
    private fun handleConfigMcpToken(params: JSONObject): Response {
        val id = params.optString("id", "").trim()
        if (id.isEmpty() || !MCP_TOKEN_ID_REGEX.matches(id)) {
            return jsonResponse(400, mapOf("error" to "invalid id"))
        }
        return try {
            val token = com.seekerclaw.app.state.McpTokenStore.read(context, id)
            jsonResponse(200, mapOf("token" to token))
        } catch (e: Exception) {
            // Don't leak the failure mode to the caller — same shape
            // as the token-not-found response.
            Log.w(TAG, "[Bridge] /config/mcp-token failed for id=$id: ${e.message}")
            jsonResponse(200, mapOf("token" to ""))
        }
    }

    // ==================== Service restart ====================

    /**
     * Cleanly stops the :node service and schedules a fresh start 2s later.
     *
     * Used by the /provider Telegram slash command — changing provider or
     * auth type requires re-initializing provider-specific module state
     * (adapter selection, endpoint, auth headers) which are set at startup
     * from module-level consts in config.js.
     *
     * Why the two-step dance:
     *   1. stopService triggers SeekerClawService.onDestroy() which runs the
     *      full shutdown sequence (Watchdog.stop, NodeBridge.stop, wake-lock
     *      release, crash-counter reset, and killProcess at the end). That's
     *      much cleaner than raw Process.killProcess from the bridge, which
     *      skipped all of it — notably the crash-counter reset, so rapid
     *      back-to-back /provider switches could hit the 3-restarts-in-30s
     *      crash-loop protection and stop the service entirely.
     *   2. stopService is an EXPLICIT stop, so START_STICKY won't auto-
     *      respawn. AlarmManager schedules a fresh startForegroundService
     *      2s later — that's durable across :node process death (unlike a
     *      postDelayed on a :node handler, which dies with the process).
     *
     * The initial RESTART_DELAY_MS gives the HTTP response (and the Node
     * Telegram reply that triggered this) time to flush before onDestroy
     * closes the bridge.
     */
    private fun handleServiceRestart(): Response {
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
            try {
                Log.i(TAG, "[Bridge] /service/restart — scheduling clean restart")
                scheduleServiceRestart(SERVICE_RESTART_DELAY_MS)
                // SeekerClawService.stop() is the canonical shutdown path: it
                // clears any pending restart callbacks on the companion
                // Handler (so a stale restart scheduled elsewhere can't race
                // our AlarmManager one), updates ServiceState, and then
                // delegates to stopService() which triggers onDestroy →
                // full cleanup → Process.killProcess at the end.
                SeekerClawService.stop(context)
            } catch (e: Exception) {
                Log.e(TAG, "[Bridge] /service/restart failed: ${e.message}", e)
            }
        }, RESTART_DELAY_MS)
        return jsonResponse(
            200,
            mapOf("status" to "restarting", "delayMs" to RESTART_DELAY_MS + SERVICE_RESTART_DELAY_MS)
        )
    }

    private fun scheduleServiceRestart(delayMs: Long) {
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val intent = Intent(context, SeekerClawService::class.java)
        val pendingIntent = PendingIntent.getForegroundService(
            context,
            SERVICE_RESTART_REQUEST_CODE,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        // setAndAllowWhileIdle: inexact (±few seconds) but doesn't require
        // the SCHEDULE_EXACT_ALARM permission (gated on Android 12+). A
        // /provider-initiated restart is user-facing but not latency-
        // critical; "about 2 seconds" is acceptable UX.
        alarmManager.setAndAllowWhileIdle(
            AlarmManager.ELAPSED_REALTIME_WAKEUP,
            android.os.SystemClock.elapsedRealtime() + delayMs,
            pendingIntent,
        )
    }

    // ==================== Battery ====================

    private fun handleBattery(): Response {
        val batteryIntent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = batteryIntent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = batteryIntent?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
        val percentage = if (scale > 0) (level * 100 / scale) else -1

        val status = batteryIntent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val isCharging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                status == BatteryManager.BATTERY_STATUS_FULL

        val plugged = batteryIntent?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
        val chargeType = when (plugged) {
            BatteryManager.BATTERY_PLUGGED_AC -> "ac"
            BatteryManager.BATTERY_PLUGGED_USB -> "usb"
            BatteryManager.BATTERY_PLUGGED_WIRELESS -> "wireless"
            else -> "none"
        }

        return jsonResponse(200, mapOf(
            "level" to percentage,
            "isCharging" to isCharging,
            "chargeType" to chargeType
        ))
    }

    // ==================== Storage ====================

    private fun handleStorage(): Response {
        val stat = StatFs(Environment.getDataDirectory().path)
        val blockSize = stat.blockSizeLong
        val totalBlocks = stat.blockCountLong
        val availableBlocks = stat.availableBlocksLong

        val totalBytes = totalBlocks * blockSize
        val availableBytes = availableBlocks * blockSize
        val usedBytes = totalBytes - availableBytes

        return jsonResponse(200, mapOf(
            "total" to totalBytes,
            "available" to availableBytes,
            "used" to usedBytes,
            "totalFormatted" to formatBytes(totalBytes),
            "availableFormatted" to formatBytes(availableBytes),
            "usedFormatted" to formatBytes(usedBytes)
        ))
    }

    // ==================== Network ====================

    private fun handleNetwork(): Response {
        val connectivityManager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
        val network = connectivityManager.activeNetwork
        val capabilities = connectivityManager.getNetworkCapabilities(network)

        val isConnected = network != null
        val type = when {
            capabilities?.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) == true -> "wifi"
            capabilities?.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR) == true -> "cellular"
            capabilities?.hasTransport(android.net.NetworkCapabilities.TRANSPORT_ETHERNET) == true -> "ethernet"
            else -> "none"
        }

        return jsonResponse(200, mapOf(
            "isConnected" to isConnected,
            "type" to type
        ))
    }

    // ==================== Clipboard ====================

    private fun handleClipboardGet(): Response {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = clipboard.primaryClip
        val text = if (clip != null && clip.itemCount > 0) {
            clip.getItemAt(0).text?.toString() ?: ""
        } else {
            ""
        }
        return jsonResponse(200, mapOf("content" to text))
    }

    private fun handleClipboardSet(params: JSONObject): Response {
        val content = params.optString("content", "")
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = ClipData.newPlainText("SeekerClaw", content)
        clipboard.setPrimaryClip(clip)
        return jsonResponse(200, mapOf("success" to true))
    }

    // ==================== Contacts ====================

    private fun handleContactsSearch(params: JSONObject): Response {
        if (!hasPermission(Manifest.permission.READ_CONTACTS)) {
            return jsonResponse(403, mapOf("error" to "READ_CONTACTS permission not granted"))
        }

        val query = params.optString("query", "")
        val limit = params.optInt("limit", 10)

        val contacts = mutableListOf<Map<String, String?>>()
        val cursor = context.contentResolver.query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            arrayOf(
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                ContactsContract.CommonDataKinds.Phone.NUMBER
            ),
            "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} LIKE ?",
            arrayOf("%$query%"),
            "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} ASC"
        )

        cursor?.use {
            var count = 0
            while (it.moveToNext() && count < limit) {
                val name = it.getString(0)
                val phone = it.getString(1)
                contacts.add(mapOf("name" to name, "phone" to phone))
                count++
            }
        }

        return jsonResponse(200, mapOf("contacts" to contacts, "count" to contacts.size))
    }

    private fun handleContactsAdd(params: JSONObject): Response {
        if (!hasPermission(Manifest.permission.WRITE_CONTACTS)) {
            return jsonResponse(403, mapOf("error" to "WRITE_CONTACTS permission not granted"))
        }

        val name = params.optString("name", "")
        val phone = params.optString("phone", "")

        if (name.isBlank() || phone.isBlank()) {
            return jsonResponse(400, mapOf("error" to "name and phone are required"))
        }

        // Use intent to add contact (safer, doesn't require raw insert)
        val intent = Intent(Intent.ACTION_INSERT).apply {
            type = ContactsContract.Contacts.CONTENT_TYPE
            putExtra(ContactsContract.Intents.Insert.NAME, name)
            putExtra(ContactsContract.Intents.Insert.PHONE, phone)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)

        return jsonResponse(200, mapOf("success" to true, "message" to "Contact add dialog opened"))
    }

    // ==================== SMS ====================

    private fun handleSms(params: JSONObject): Response {
        val phone = params.optString("phone", "")
        val message = params.optString("message", "")

        if (phone.isBlank() || message.isBlank()) {
            return jsonResponse(400, mapOf("error" to "phone and message are required"))
        }

        // If SEND_SMS permission is available (dappStore), send directly.
        // Otherwise (googlePlay), hand off to system messaging app via intent.
        if (hasPermission(Manifest.permission.SEND_SMS)) {
            try {
                val smsManager = context.getSystemService(SmsManager::class.java)
                val parts = smsManager.divideMessage(message)
                smsManager.sendMultipartTextMessage(phone, null, parts, null, null)
                return jsonResponse(200, mapOf("success" to true, "phone" to phone, "parts" to parts.size))
            } catch (e: Exception) {
                return jsonResponse(500, mapOf("error" to "Failed to send SMS: ${e.message}"))
            }
        } else {
            // Intent handoff — opens system messaging app with message pre-filled
            try {
                val intent = Intent(Intent.ACTION_SENDTO).apply {
                    data = Uri.parse("smsto:$phone")
                    putExtra("sms_body", message)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
                return jsonResponse(200, mapOf("success" to true, "handoff" to true, "phone" to phone,
                    "note" to "SMS app opened with message pre-filled. User must tap Send."))
            } catch (e: Exception) {
                return jsonResponse(500, mapOf("error" to "Failed to open SMS app: ${e.message}"))
            }
        }
    }

    // ==================== Phone Call ====================

    private fun handleCall(params: JSONObject): Response {
        if (!hasPermission(Manifest.permission.CALL_PHONE)) {
            return jsonResponse(403, mapOf("error" to "CALL_PHONE permission not granted"))
        }

        val phone = params.optString("phone", "")
        if (phone.isBlank()) {
            return jsonResponse(400, mapOf("error" to "phone is required"))
        }

        val intent = Intent(Intent.ACTION_CALL).apply {
            data = Uri.parse("tel:$phone")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)

        return jsonResponse(200, mapOf("success" to true, "phone" to phone))
    }

    // ==================== Location ====================

    private fun handleLocation(): Response {
        if (!hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)) {
            return jsonResponse(403, mapOf("error" to "ACCESS_FINE_LOCATION permission not granted"))
        }

        val locationManager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager

        // Try to get last known location
        val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
        var bestLocation: Location? = null

        for (provider in providers) {
            try {
                val location = locationManager.getLastKnownLocation(provider)
                if (location != null) {
                    if (bestLocation == null || location.accuracy < bestLocation.accuracy) {
                        bestLocation = location
                    }
                }
            } catch (e: SecurityException) {
                Log.e(TAG, "Security exception for provider $provider", e)
            }
        }

        return if (bestLocation != null) {
            jsonResponse(200, mapOf(
                "latitude" to bestLocation.latitude,
                "longitude" to bestLocation.longitude,
                "accuracy" to bestLocation.accuracy,
                "altitude" to bestLocation.altitude,
                "provider" to bestLocation.provider,
                "time" to bestLocation.time
            ))
        } else {
            jsonResponse(200, mapOf("error" to "No location available. Enable GPS and try again."))
        }
    }

    // ==================== Text-to-Speech ====================

    private fun handleTts(params: JSONObject): Response {
        if (!ttsReady) {
            return jsonResponse(503, mapOf("error" to "TTS not ready"))
        }

        val text = params.optString("text", "")
        if (text.isBlank()) {
            return jsonResponse(400, mapOf("error" to "text is required"))
        }

        val pitch = params.optDouble("pitch", 1.0).toFloat()
        val speed = params.optDouble("speed", 1.0).toFloat()

        tts?.setPitch(pitch)
        tts?.setSpeechRate(speed)
        tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "seekerclaw_tts")

        return jsonResponse(200, mapOf("success" to true, "text" to text))
    }

    // ==================== Camera ====================

    private fun handleCameraCapture(params: JSONObject): Response {
        if (!hasPermission(Manifest.permission.CAMERA)) {
            return jsonResponse(403, mapOf("error" to "CAMERA permission not granted"))
        }

        val requestId = java.util.UUID.randomUUID().toString()
        val lens = params.optString("lens", "back").lowercase().let {
            if (it == "front") "front" else "back"
        }

        try {
            val intent = Intent(context, CameraCaptureActivity::class.java).apply {
                putExtra("requestId", requestId)
                putExtra("lens", lens)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
        } catch (e: Exception) {
            return jsonResponse(500, mapOf("error" to "Failed to start camera capture: ${e.message}"))
        }

        val resultFile = java.io.File(java.io.File(context.filesDir, CameraCaptureActivity.RESULTS_DIR), "$requestId.json")
        val deadline = System.currentTimeMillis() + 30_000
        while (System.currentTimeMillis() < deadline) {
            if (resultFile.exists()) {
                val result = JSONObject(resultFile.readText())
                resultFile.delete()
                val error = result.optString("error", "")
                val imagePath = result.optString("path", "")
                val capturedAt = result.optLong("capturedAt", 0L)

                return if (error.isBlank() && imagePath.isNotBlank()) {
                    jsonResponse(200, mapOf(
                        "success" to true,
                        "path" to imagePath,
                        "lens" to result.optString("lens", lens),
                        "capturedAt" to capturedAt
                    ))
                } else {
                    jsonResponse(400, mapOf("error" to error.ifBlank { "Camera capture failed" }))
                }
            }
            Thread.sleep(250)
        }

        return jsonResponse(408, mapOf("error" to "Camera capture timed out"))
    }

    // ==================== Apps ====================

    private fun handleAppsList(): Response {
        val pm = context.packageManager
        val apps = pm.getInstalledApplications(PackageManager.GET_META_DATA)
            .filter { pm.getLaunchIntentForPackage(it.packageName) != null }
            .map { mapOf(
                "name" to pm.getApplicationLabel(it).toString(),
                "package" to it.packageName
            )}
            .sortedBy { it["name"]?.lowercase() }

        return jsonResponse(200, mapOf("apps" to apps, "count" to apps.size))
    }

    private fun handleAppsLaunch(params: JSONObject): Response {
        val packageName = params.optString("package", "")
        if (packageName.isBlank()) {
            return jsonResponse(400, mapOf("error" to "package is required"))
        }

        val intent = context.packageManager.getLaunchIntentForPackage(packageName)
        if (intent == null) {
            return jsonResponse(404, mapOf("error" to "App not found: $packageName"))
        }

        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)

        return jsonResponse(200, mapOf("success" to true, "package" to packageName))
    }

    // ==================== Stats ====================

    private fun handleStatsMessage(): Response {
        ServiceState.incrementMessages()
        return jsonResponse(200, mapOf("success" to true))
    }

    private fun handleStatsTokens(params: JSONObject): Response {
        val inputTokens = params.optLong("input_tokens", 0)
        val outputTokens = params.optLong("output_tokens", 0)
        val total = inputTokens + outputTokens
        if (total > 0) {
            ServiceState.addTokens(total)
        }
        val model = params.optString("model", "unknown")
        Analytics.messageSent(model, total)
        return jsonResponse(200, mapOf("success" to true, "tokens_added" to total))
    }

    // ==================== Solana ====================

    private fun handleSolanaAuthorize(): Response {
        val requestId = java.util.UUID.randomUUID().toString()
        val intent = Intent(context, com.seekerclaw.app.solana.SolanaAuthActivity::class.java).apply {
            putExtra("action", "authorize")
            putExtra("requestId", requestId)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)

        val resultFile = java.io.File(java.io.File(context.filesDir, "solana_results"), "$requestId.json")
        val deadline = System.currentTimeMillis() + 60_000
        while (System.currentTimeMillis() < deadline) {
            if (resultFile.exists()) {
                val result = JSONObject(resultFile.readText())
                resultFile.delete()
                val address = result.optString("address", "")
                val error = result.optString("error", "")

                return if (address.isNotBlank()) {
                    jsonResponse(200, mapOf("address" to address, "success" to true))
                } else {
                    jsonResponse(400, mapOf("error" to error.ifBlank { "Authorization failed" }))
                }
            }
            Thread.sleep(300)
        }
        return jsonResponse(408, mapOf("error" to "Authorization timed out"))
    }

    private fun handleSolanaAddress(): Response {
        val address = ConfigManager.getWalletAddress(context)
        return if (address != null) {
            val label = ConfigManager.getWalletLabel(context)
            jsonResponse(200, mapOf("address" to address, "label" to label))
        } else {
            jsonResponse(404, mapOf("error" to "No wallet connected"))
        }
    }

    private fun handleSolanaSign(params: JSONObject): Response {
        val txBase64 = params.optString("transaction", "")
        if (txBase64.isBlank()) {
            return jsonResponse(400, mapOf("error" to "transaction (base64) is required"))
        }

        val txBytes = android.util.Base64.decode(txBase64, android.util.Base64.NO_WRAP)
        val requestId = java.util.UUID.randomUUID().toString()

        val intent = Intent(context, com.seekerclaw.app.solana.SolanaAuthActivity::class.java).apply {
            putExtra("action", "sign")
            putExtra("requestId", requestId)
            putExtra("transaction", txBytes)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)

        val resultFile = java.io.File(java.io.File(context.filesDir, "solana_results"), "$requestId.json")
        val deadline = System.currentTimeMillis() + 120_000
        while (System.currentTimeMillis() < deadline) {
            if (resultFile.exists()) {
                val result = JSONObject(resultFile.readText())
                resultFile.delete()
                val sigB64 = result.optString("signature", "")
                val error = result.optString("error", "")

                return if (sigB64.isNotBlank()) {
                    jsonResponse(200, mapOf("signature" to sigB64, "success" to true))
                } else {
                    jsonResponse(400, mapOf("error" to error.ifBlank { "Transaction rejected by user" }))
                }
            }
            Thread.sleep(300)
        }
        return jsonResponse(408, mapOf("error" to "Signing timed out"))
    }

    /**
     * Sign-only endpoint for Jupiter Ultra flow.
     * Returns the full signed transaction (base64) without broadcasting.
     * Jupiter Ultra handles broadcasting via /execute.
     */
    private fun handleSolanaSignOnly(params: JSONObject): Response {
        val txBase64 = params.optString("transaction", "")
        if (txBase64.isBlank()) {
            return jsonResponse(400, mapOf("error" to "transaction (base64) is required"))
        }

        val txBytes = try {
            android.util.Base64.decode(txBase64, android.util.Base64.NO_WRAP)
        } catch (e: IllegalArgumentException) {
            return jsonResponse(400, mapOf("error" to "transaction is invalid base64"))
        }
        val requestId = java.util.UUID.randomUUID().toString()

        val intent = Intent(context, com.seekerclaw.app.solana.SolanaAuthActivity::class.java).apply {
            putExtra("action", "signOnly")
            putExtra("requestId", requestId)
            putExtra("transaction", txBytes)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)

        val resultsDir = java.io.File(context.filesDir, com.seekerclaw.app.solana.SolanaAuthActivity.RESULTS_DIR)
        val resultFile = java.io.File(resultsDir, "$requestId.json")
        val deadline = System.currentTimeMillis() + 120_000
        while (System.currentTimeMillis() < deadline) {
            if (resultFile.exists()) {
                val result = JSONObject(resultFile.readText())
                resultFile.delete()
                val signedTx = result.optString("signedTransaction", "")
                val error = result.optString("error", "")

                return if (signedTx.isNotBlank()) {
                    jsonResponse(200, mapOf("signedTransaction" to signedTx, "success" to true))
                } else {
                    jsonResponse(400, mapOf("error" to error.ifBlank { "Transaction rejected by user" }))
                }
            }
            Thread.sleep(300)
        }
        return jsonResponse(408, mapOf("error" to "Signing timed out"))
    }

    private fun handleSolanaSend(params: JSONObject): Response {
        // Legacy endpoint — solana_send now builds tx in JS and uses /solana/sign
        return jsonResponse(400, mapOf("error" to "Use /solana/sign instead. Transaction building is handled by the Node.js agent."))
    }

    // ==================== Config ====================

    private fun handleConfigSaveOwner(params: JSONObject): Response {
        val ownerId = params.optString("ownerId", "")
        if (ownerId.isBlank()) {
            return jsonResponse(400, mapOf("error" to "ownerId is required"))
        }
        // Node.js tells us which channel this owner belongs to — no guessing
        val channel = params.optString("channel", "")
        val persisted = if (channel.isNotBlank()) {
            ConfigManager.saveOwnerIdForChannel(context, ownerId, channel)
        } else {
            ConfigManager.saveOwnerId(context, ownerId)
        }
        return if (persisted) {
            jsonResponse(200, mapOf("success" to true))
        } else {
            jsonResponse(500, mapOf("error" to "Failed to persist owner ID"))
        }
    }

    // ==================== OpenAI OAuth ====================

    private fun handleOpenAIOAuthSaveTokens(params: JSONObject): Response {
        val accessToken = params.optString("accessToken", "")
        val refreshToken = params.optString("refreshToken", "")
        val expiresAt = params.optString("expiresAt", "")
        if (accessToken.isBlank()) {
            return jsonResponse(400, mapOf("error" to "accessToken required"))
        }
        return try {
            val config = ConfigManager.loadConfig(context)
                ?: return jsonResponse(500, mapOf("error" to "config not loaded"))
            ConfigManager.saveConfig(
                context, config.copy(
                    openaiOAuthToken = accessToken,
                    openaiOAuthRefresh = if (refreshToken.isNotBlank()) refreshToken else config.openaiOAuthRefresh,
                    openaiOAuthExpiresAt = if (expiresAt.isNotBlank()) expiresAt else config.openaiOAuthExpiresAt,
                )
            )
            jsonResponse(200, mapOf("success" to true))
        } catch (e: Exception) {
            // Log full details locally; never echo internal exception messages
            // back across the bridge boundary.
            Log.w(TAG, "Failed to save OpenAI OAuth tokens", e)
            jsonResponse(500, mapOf(
                "error" to "Failed to save OpenAI OAuth tokens",
                "code" to "OPENAI_OAUTH_SAVE_FAILED",
            ))
        }
    }

    // ==================== Helpers ====================

    // Proxy /stats/db-summary to Node.js internal stats server (BAT-31)
    private fun proxyToNodeStats(): Response {
        var conn: java.net.HttpURLConnection? = null
        return try {
            val url = java.net.URL("http://127.0.0.1:8766/stats/db-summary")
            conn = url.openConnection() as java.net.HttpURLConnection
            conn.requestMethod = "GET"
            conn.connectTimeout = 5000
            conn.readTimeout = 5000

            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val body = stream?.bufferedReader()?.use { it.readText() } ?: "{}"
            val status = Response.Status.lookup(code) ?: Response.Status.INTERNAL_ERROR
            newFixedLengthResponse(status, "application/json", body)
        } catch (e: Exception) {
            Log.w(TAG, "Stats proxy failed: ${e.message}")
            jsonResponse(503, mapOf("error" to "Stats unavailable"))
        } finally {
            conn?.disconnect()
        }
    }

    private fun hasPermission(permission: String): Boolean {
        return ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
    }

    private fun jsonResponse(status: Int, data: Map<String, Any?>): Response {
        val json = JSONObject(data).toString()
        return newFixedLengthResponse(
            Response.Status.lookup(status) ?: Response.Status.OK,
            "application/json",
            json
        )
    }

    private fun formatBytes(bytes: Long): String {
        if (bytes <= 0) return "0 B"
        val units = arrayOf("B", "KB", "MB", "GB", "TB")
        val digitGroups = (Math.log10(bytes.toDouble()) / Math.log10(1024.0)).toInt()
        return String.format("%.2f %s", bytes / Math.pow(1024.0, digitGroups.toDouble()), units[digitGroups])
    }

    fun shutdown() {
        tts?.stop()
        tts?.shutdown()
        stop()
    }
}
