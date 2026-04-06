package com.seekerclaw.app.oauth

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.browser.customtabs.CustomTabsIntent
import fi.iki.elonen.NanoHTTPD
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * Transparent Activity that handles OpenAI OAuth flows.
 * Supports two methods:
 *   - "browser": PKCE authorization code flow via Custom Tabs + local redirect server
 *   - "device_code": Device code flow with polling
 *
 * Results are communicated via files (same pattern as SolanaAuthActivity).
 */
class OpenAIOAuthActivity : ComponentActivity() {

    companion object {
        private const val TAG = "OpenAIOAuth"
        const val RESULTS_DIR = "oauth_results"
        const val CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
        const val AUTH_URL = "https://auth.openai.com/oauth/authorize"
        const val TOKEN_URL = "https://auth.openai.com/oauth/token"
        const val DEVICE_URL = "https://auth.openai.com/oauth/device/code"
        const val DEVICE_VERIFY_URL = "https://auth.openai.com/codex/device"  // User-facing page
        const val REDIRECT_URI = "http://localhost:1455/auth/callback"
        const val SCOPES = "openid profile email offline_access"
        private const val CALLBACK_PORT = 1455
    }

    private var callbackServer: CallbackServer? = null
    private val scope = CoroutineScope(Dispatchers.Main + Job())
    private var pollingJob: Job? = null
    private var callbackReceived = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val method = intent.getStringExtra("method") ?: run {
            Log.w(TAG, "No method specified")
            finish()
            return
        }
        val requestId = intent.getStringExtra("requestId") ?: run {
            Log.w(TAG, "No requestId specified")
            finish()
            return
        }

        Log.i(TAG, "Starting OAuth flow: $method (request: $requestId)")

        when (method) {
            "browser" -> startBrowserFlow(requestId)
            "device_code" -> startDeviceCodeFlow(requestId)
            else -> {
                Log.w(TAG, "Unknown method: $method")
                writeResultFile(requestId, JSONObject().apply {
                    put("status", "error")
                    put("message", "Unknown method: $method")
                })
                finish()
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        callbackServer?.stop()
        callbackServer = null
        pollingJob?.cancel()
        scope.cancel()
    }

    // ── Flow A: Browser Redirect (PKCE) ──────────────────────────────────

    private fun startBrowserFlow(requestId: String) {
        val codeVerifier = generateCodeVerifier()
        val codeChallenge = generateCodeChallenge(codeVerifier)
        val state = generateState()

        // Start local callback server
        val server = CallbackServer(CALLBACK_PORT) { params ->
            handleCallback(requestId, params, state, codeVerifier)
        }
        try {
            server.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)
            callbackServer = server
            Log.i(TAG, "Callback server started on port $CALLBACK_PORT")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start callback server", e)
            writeResultFile(requestId, JSONObject().apply {
                put("status", "error")
                put("message", "Failed to start callback server: ${e.message}")
            })
            finish()
            return
        }

        // Build authorize URL
        val authorizeUrl = buildString {
            append(AUTH_URL)
            append("?response_type=code")
            append("&client_id=").append(URLEncoder.encode(CLIENT_ID, "UTF-8"))
            append("&redirect_uri=").append(URLEncoder.encode(REDIRECT_URI, "UTF-8"))
            append("&scope=").append(URLEncoder.encode(SCOPES, "UTF-8"))
            append("&state=").append(URLEncoder.encode(state, "UTF-8"))
            append("&code_challenge=").append(URLEncoder.encode(codeChallenge, "UTF-8"))
            append("&code_challenge_method=S256")
            append("&id_token_add_organizations=true")
            append("&codex_cli_simplified_flow=true")
        }

        // Open in Custom Tab or fallback to browser
        try {
            val customTabsIntent = CustomTabsIntent.Builder().build()
            customTabsIntent.launchUrl(this, Uri.parse(authorizeUrl))
        } catch (e: Exception) {
            Log.w(TAG, "Custom Tabs unavailable, falling back to ACTION_VIEW", e)
            val browserIntent = Intent(Intent.ACTION_VIEW, Uri.parse(authorizeUrl))
            startActivity(browserIntent)
        }

        // Safety timeout: if user abandons browser login, stop server and write error after 10 min.
        // Gate on !callbackReceived so a slow token exchange (already in progress) isn't clobbered
        // by a timeout error written over its eventual success/error result.
        scope.launch {
            delay(600_000)
            if (!callbackReceived && callbackServer != null) {
                Log.w(TAG, "Browser flow timed out after 10 minutes")
                callbackServer?.stop()
                callbackServer = null
                writeResultFile(requestId, JSONObject().apply {
                    put("status", "error")
                    put("message", "Browser login timed out. Please try again.")
                })
                finishOnMain()
            }
        }
    }

    private fun handleCallback(
        requestId: String,
        params: Map<String, String>,
        expectedState: String,
        codeVerifier: String
    ): String {
        callbackReceived = true
        val code = params["code"]
        val state = params["state"]
        val error = params["error"]

        if (error != null) {
            Log.e(TAG, "OAuth error: $error")
            writeResultFile(requestId, JSONObject().apply {
                put("status", "error")
                put("message", "OAuth error: $error")
            })
            finishOnMain()
            return buildHtmlResponse("Error", "Authentication failed: $error")
        }

        if (state != expectedState) {
            Log.e(TAG, "State mismatch")
            writeResultFile(requestId, JSONObject().apply {
                put("status", "error")
                put("message", "State mismatch — possible CSRF attack")
            })
            finishOnMain()
            return buildHtmlResponse("Error", "State verification failed. Please try again.")
        }

        if (code == null) {
            Log.e(TAG, "No code in callback")
            writeResultFile(requestId, JSONObject().apply {
                put("status", "error")
                put("message", "No authorization code received")
            })
            finishOnMain()
            return buildHtmlResponse("Error", "No authorization code received.")
        }

        // Exchange code for tokens asynchronously in a coroutine after returning the NanoHTTPD response.
        scope.launch {
            exchangeCodeForTokens(requestId, code, codeVerifier)
        }

        return buildHtmlResponse(
            "Completing Sign-In",
            "Finishing authentication — please return to SeekerClaw for status."
        )
    }

    private suspend fun exchangeCodeForTokens(
        requestId: String,
        code: String,
        codeVerifier: String
    ) {
        try {
            val tokenResponse = withContext(Dispatchers.IO) {
                val body = buildString {
                    append("grant_type=authorization_code")
                    append("&code=").append(URLEncoder.encode(code, "UTF-8"))
                    append("&redirect_uri=").append(URLEncoder.encode(REDIRECT_URI, "UTF-8"))
                    append("&client_id=").append(URLEncoder.encode(CLIENT_ID, "UTF-8"))
                    append("&code_verifier=").append(URLEncoder.encode(codeVerifier, "UTF-8"))
                }
                httpPost(TOKEN_URL, body)
            }

            val json = JSONObject(tokenResponse)
            val accessToken = json.optString("access_token", "")
            val refreshToken = json.optString("refresh_token", "")
            val idToken = json.optString("id_token", "")
            val expiresIn = json.optLong("expires_in", 3600)
            val expiresAt = java.time.Instant.now().plusSeconds(expiresIn).toString()
            // Try id_token first (has email), fall back to access_token
            val email = extractEmailFromJwt(idToken) ?: extractEmailFromJwt(accessToken)

            writeResultFile(requestId, JSONObject().apply {
                put("status", "success")
                put("accessToken", accessToken)
                put("refreshToken", refreshToken)
                put("email", email ?: JSONObject.NULL)
                put("expiresAt", expiresAt)
            })
            Log.i(TAG, "Browser flow completed successfully")
        } catch (e: Exception) {
            Log.e(TAG, "Token exchange failed", e)
            writeResultFile(requestId, JSONObject().apply {
                put("status", "error")
                put("message", "Token exchange failed: ${e.message}")
            })
        } finally {
            callbackServer?.stop()
            callbackServer = null
            finishOnMain()
        }
    }

    // ── Flow B: Device Code ──────────────────────────────────────────────

    private fun startDeviceCodeFlow(requestId: String) {
        scope.launch {
            try {
                val deviceResponse = withContext(Dispatchers.IO) {
                    val body = buildString {
                        append("client_id=").append(URLEncoder.encode(CLIENT_ID, "UTF-8"))
                        append("&scope=").append(URLEncoder.encode(SCOPES, "UTF-8"))
                    }
                    httpPost(DEVICE_URL, body)
                }

                val json = JSONObject(deviceResponse)
                val deviceCode = json.getString("device_code")
                val userCode = json.getString("user_code")
                val verificationUri = json.getString("verification_uri")
                val interval = json.optInt("interval", 5)
                val expiresIn = json.optInt("expires_in", 600)

                // Write pending result so the caller can show the user code
                writeResultFile(requestId, JSONObject().apply {
                    put("status", "pending")
                    put("userCode", userCode)
                    put("verificationUri", verificationUri)
                })

                // Poll for authorization
                pollForDeviceAuthorization(requestId, deviceCode, interval, expiresIn)
            } catch (e: Exception) {
                Log.e(TAG, "Device code request failed", e)
                writeResultFile(requestId, JSONObject().apply {
                    put("status", "error")
                    put("message", "Device code request failed: ${e.message}")
                })
                finish()
            }
        }
    }

    private fun pollForDeviceAuthorization(
        requestId: String,
        deviceCode: String,
        interval: Int,
        expiresIn: Int
    ) {
        val deadline = System.currentTimeMillis() + (expiresIn * 1000L)

        pollingJob = scope.launch {
            while (isActive && System.currentTimeMillis() < deadline) {
                delay(interval * 1000L)

                try {
                    val response = withContext(Dispatchers.IO) {
                        val body = buildString {
                            append("grant_type=").append(
                                URLEncoder.encode(
                                    "urn:ietf:params:oauth:grant-type:device_code",
                                    "UTF-8"
                                )
                            )
                            append("&device_code=").append(URLEncoder.encode(deviceCode, "UTF-8"))
                            append("&client_id=").append(URLEncoder.encode(CLIENT_ID, "UTF-8"))
                        }
                        httpPostRaw(TOKEN_URL, body)
                    }

                    val statusCode = response.first
                    val responseBody = response.second
                    val json = JSONObject(responseBody)

                    if (statusCode in 200..299 && json.has("access_token")) {
                        // Success
                        val accessToken = json.getString("access_token")
                        val refreshToken = json.optString("refresh_token", "")
                        val tokenExpiresIn = json.optLong("expires_in", 3600)
                        val expiresAt =
                            java.time.Instant.now().plusSeconds(tokenExpiresIn).toString()
                        val email = extractEmailFromJwt(accessToken)

                        writeResultFile(requestId, JSONObject().apply {
                            put("status", "success")
                            put("accessToken", accessToken)
                            put("refreshToken", refreshToken)
                            put("email", email ?: JSONObject.NULL)
                            put("expiresAt", expiresAt)
                        })
                        Log.i(TAG, "Device code flow completed successfully")
                        finishOnMain()
                        return@launch
                    }

                    val errorCode = json.optString("error", "")
                    when (errorCode) {
                        "authorization_pending", "slow_down" -> {
                            // Continue polling (slow_down: RFC says increase interval,
                            // but we keep it simple for now)
                            Log.d(TAG, "Device code polling: $errorCode")
                        }

                        "expired_token" -> {
                            writeResultFile(requestId, JSONObject().apply {
                                put("status", "error")
                                put("message", "Code expired. Please try again.")
                            })
                            finishOnMain()
                            return@launch
                        }

                        "access_denied" -> {
                            writeResultFile(requestId, JSONObject().apply {
                                put("status", "error")
                                put("message", "Access denied by user.")
                            })
                            finishOnMain()
                            return@launch
                        }

                        else -> {
                            Log.w(TAG, "Unexpected polling error: $errorCode")
                        }
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Polling request failed, will retry", e)
                }
            }

            // Timeout
            if (isActive) {
                writeResultFile(requestId, JSONObject().apply {
                    put("status", "error")
                    put("message", "Code expired. Please try again.")
                })
                finishOnMain()
            }
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    private fun generateCodeVerifier(): String {
        val bytes = ByteArray(64)
        SecureRandom().nextBytes(bytes)
        return Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    }

    private fun generateCodeChallenge(verifier: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII))
        return Base64.encodeToString(digest, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    }

    private fun generateState(): String {
        val bytes = ByteArray(32)
        SecureRandom().nextBytes(bytes)
        return Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    }

    /**
     * Decode the payload segment of a JWT and extract email (or sub as fallback).
     */
    private fun extractEmailFromJwt(jwt: String): String? {
        return try {
            val parts = jwt.split(".")
            if (parts.size < 3) return null
            val payload = parts[1]
            // Base64url decode — normalize padding to avoid edge cases on some Android versions
            val normalizedPayload = when (payload.length % 4) {
                0 -> payload
                else -> payload.padEnd(payload.length + (4 - (payload.length % 4)), '=')
            }
            val decoded = Base64.decode(normalizedPayload, Base64.URL_SAFE or Base64.NO_WRAP)
            val json = JSONObject(String(decoded, Charsets.UTF_8))
            // Try multiple claim names — OpenAI JWT varies by auth method
            val email = json.optString("email", "")
            val name = json.optString("name", "")
            val preferredUsername = json.optString("preferred_username", "")
            val sub = json.optString("sub", "")
            email.ifEmpty { preferredUsername.ifEmpty { name.ifEmpty { sub.ifEmpty { null } } } }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to extract email from JWT", e)
            null
        }
    }

    private fun httpPost(url: String, body: String): String {
        val result = httpPostRaw(url, body)
        if (result.first !in 200..299) {
            throw RuntimeException("HTTP ${result.first}: ${result.second}")
        }
        return result.second
    }

    /**
     * Returns Pair(statusCode, responseBody).
     */
    private fun httpPostRaw(url: String, body: String): Pair<Int, String> {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
            conn.doOutput = true
            conn.connectTimeout = 15_000
            conn.readTimeout = 15_000

            OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(body) }

            val statusCode = conn.responseCode
            val stream = if (statusCode in 200..299) conn.inputStream else conn.errorStream
            val responseBody = stream?.bufferedReader()?.use { it.readText() } ?: ""
            return Pair(statusCode, responseBody)
        } finally {
            conn.disconnect()
        }
    }

    private fun writeResultFile(requestId: String, result: JSONObject) {
        val resultDir = File(filesDir, RESULTS_DIR).apply { mkdirs() }
        val tmpFile = File(resultDir, "$requestId.tmp")
        val jsonFile = File(resultDir, "$requestId.json")
        tmpFile.writeText(result.toString())
        jsonFile.delete() // renameTo won't overwrite existing file on Android
        if (!tmpFile.renameTo(jsonFile)) {
            // Fallback: copy + delete if rename fails on some Android filesystems
            tmpFile.copyTo(jsonFile, overwrite = true)
            tmpFile.delete()
        }
        Log.d(TAG, "Result written: ${jsonFile.absolutePath}")
    }

    private fun finishOnMain() {
        runOnUiThread { finish() }
    }

    private fun escapeHtml(text: String): String = text
        .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace("\"", "&quot;").replace("'", "&#39;")

    private fun buildHtmlResponse(title: String, message: String): String {
        val safeTitle = escapeHtml(title)
        val safeMessage = escapeHtml(message)
        val isSuccess = title == "Success" || title == "Completing Sign-In"
        val accentColor = if (isSuccess) "#4ADE80" else "#F87171"
        val icon = if (isSuccess) "&#10003;" else "&#10007;"
        return """
            <!DOCTYPE html>
            <html>
            <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>SeekerClaw — $safeTitle</title>
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                    display: flex; justify-content: center; align-items: center;
                    height: 100vh; background: #0A0A0F; color: #fff;
                }
                .card {
                    text-align: center; padding: 3rem 2rem;
                    max-width: 400px; width: 90%;
                }
                .icon {
                    width: 80px; height: 80px; border-radius: 50%;
                    background: ${accentColor}15;
                    border: 2px solid ${accentColor};
                    display: flex; align-items: center; justify-content: center;
                    margin: 0 auto 1.5rem; font-size: 36px; color: $accentColor;
                }
                h1 {
                    font-size: 24px; font-weight: 700; color: $accentColor;
                    margin-bottom: 0.75rem; letter-spacing: -0.5px;
                }
                .message {
                    font-size: 15px; color: rgba(255,255,255,0.6);
                    line-height: 1.5; margin-bottom: 2rem;
                }
                .brand {
                    font-size: 12px; color: rgba(255,255,255,0.25);
                    letter-spacing: 1px; text-transform: uppercase;
                }
            </style>
            </head>
            <body>
                <div class="card">
                    <div class="icon">$icon</div>
                    <h1>$safeTitle</h1>
                    <p class="message">$safeMessage</p>
                    <p class="brand">SeekerClaw</p>
                </div>
            </body>
            </html>
        """.trimIndent()
    }

    // ── NanoHTTPD Callback Server ────────────────────────────────────────

    private class CallbackServer(
        port: Int,
        private val onCallback: (Map<String, String>) -> String
    ) : NanoHTTPD("127.0.0.1", port) {

        override fun serve(session: IHTTPSession): Response {
            if (session.uri == "/auth/callback" && session.method == Method.GET) {
                @Suppress("DEPRECATION")
                val params = session.parms ?: emptyMap()
                val html = onCallback(params)
                return newFixedLengthResponse(Response.Status.OK, "text/html", html)
            }
            return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "Not found")
        }
    }
}
