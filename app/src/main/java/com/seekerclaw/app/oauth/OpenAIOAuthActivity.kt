package com.seekerclaw.app.oauth

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.browser.customtabs.CustomTabsIntent
import com.seekerclaw.app.config.ConfigManager
import fi.iki.elonen.NanoHTTPD
import android.content.Context
import java.lang.ref.WeakReference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * Activity that handles the OpenAI OAuth PKCE flow:
 * Custom Tabs → user signs in on auth.openai.com → localhost:1455 loopback callback → token exchange.
 *
 * IMPORTANT — Activity lifecycle vs. server lifetime:
 * The NanoHTTPD callback server lives in the companion object (application-lifetime),
 * NOT as an Activity instance variable. This is critical because Android can destroy
 * the stopped Activity while the user is authenticating in Chrome Custom Tab (observed
 * on Pixel 7 / stock Android 14, which aggressively reclaims stopped Activities during
 * fresh install when no foreground service is running). If the server died with the
 * Activity, Chrome's redirect to localhost:1455 would get "connection refused."
 *
 * The server is cleaned up by three paths:
 * 1. Callback received (success or error) → handleCallbackStatic stops it
 * 2. User presses Cancel button → cancel UI stops it
 * 3. 10-minute timeout on EXCHANGE_SCOPE → timeout stops it
 *
 * onDestroy() deliberately does NOT stop the server.
 */
class OpenAIOAuthActivity : ComponentActivity() {

    companion object {
        private const val TAG = "OpenAIOAuth"
        const val RESULTS_DIR = "oauth_results"
        const val CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
        const val AUTH_URL = "https://auth.openai.com/oauth/authorize"
        const val TOKEN_URL = "https://auth.openai.com/oauth/token"
        // Must be exactly "localhost" — the Codex OAuth client (app_EMoamEEZ...) is
        // registered with this redirect URI. Using 127.0.0.1 causes OpenAI to reject the
        // authorize request as a redirect_uri mismatch ("unknown_error" on their side).
        const val REDIRECT_URI = "http://localhost:1455/auth/callback"
        const val SCOPES = "openid profile email offline_access"
        private const val CALLBACK_PORT = 1455

        private val UUID_PATTERN = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

        // Application-lifetime scope for the token exchange AND the server timeout.
        // Survives Activity destruction so a successful browser redirect always
        // completes its persist + result-write, and the timeout always fires.
        private val EXCHANGE_SCOPE = CoroutineScope(SupervisorJob() + Dispatchers.IO)

        // ── Active flow state (application-lifetime) ────────────────────
        // Lives in companion so the NanoHTTPD server survives Activity destruction.
        // ALL reads and writes of these fields are guarded by FLOW_LOCK so that
        // resetActiveFlow(), claimWrite(), and callback handling are atomic with
        // respect to each other. Without the lock, a callback from an old flow
        // could pass isActiveFlow() + claimWrite() while resetActiveFlow() is
        // mid-way through resetting fields for a new flow.
        //
        // Per-flow isolation: activeFlowId is set to the requestId at the start
        // of each flow. All async completions (token exchange, timeout, cancel
        // write) check their captured flowId against activeFlowId before mutating
        // shared state — stale coroutines from a prior flow become no-ops.

        private val FLOW_LOCK = Any()
        private var activeServer: CallbackServer? = null
        private var activeCallbackReceived = false
        private var activeFlowId: String? = null
        private var activeTimeoutJob: Job? = null

        private enum class WriteState { IDLE, WRITING, COMPLETED }
        private var activeWriteState = WriteState.IDLE

        private fun claimWrite(): Boolean = synchronized(FLOW_LOCK) {
            if (activeWriteState != WriteState.IDLE) return false
            activeWriteState = WriteState.WRITING
            true
        }
        private fun markWriteCompleted() = synchronized(FLOW_LOCK) {
            activeWriteState = WriteState.COMPLETED
        }

        /** Check if a flow is still the active one before mutating shared state. */
        private fun isActiveFlow(flowId: String): Boolean =
            synchronized(FLOW_LOCK) { activeFlowId == flowId }

        /** Stop the callback server and reset flow state for a new OAuth attempt. */
        private fun resetActiveFlow() = synchronized(FLOW_LOCK) {
            activeTimeoutJob?.cancel()
            activeTimeoutJob = null
            activeServer?.stop()
            activeServer = null
            activeCallbackReceived = false
            activeFlowId = null
            activeWriteState = WriteState.IDLE
        }

        // ── Static token exchange ───────────────────────────────────────

        suspend fun exchangeCodeForTokensStatic(
            appCtx: Context,
            requestId: String,
            code: String,
            codeVerifier: String,
            onComplete: () -> Unit,
        ) {
            try {
                val tokenResponse = withContext(NonCancellable + Dispatchers.IO) {
                    val body = buildString {
                        append("grant_type=authorization_code")
                        append("&code=").append(URLEncoder.encode(code, "UTF-8"))
                        append("&redirect_uri=").append(URLEncoder.encode(REDIRECT_URI, "UTF-8"))
                        append("&client_id=").append(URLEncoder.encode(CLIENT_ID, "UTF-8"))
                        append("&code_verifier=").append(URLEncoder.encode(codeVerifier, "UTF-8"))
                    }
                    httpPostStatic(TOKEN_URL, body)
                }
                val json = JSONObject(tokenResponse)
                val accessToken = json.optString("access_token", "")
                if (accessToken.isBlank()) {
                    val errMsg = json.optString("error_description", "")
                        .ifBlank { json.optString("error", "Token response missing access_token") }
                    throw IllegalStateException(errMsg)
                }
                val refreshToken = json.optString("refresh_token", "")
                val idToken = json.optString("id_token", "")
                val expiresIn = json.optLong("expires_in", 3600)
                val expiresAt = java.time.Instant.now().plusSeconds(expiresIn).toString()
                val email = extractEmailFromJwtStatic(idToken) ?: extractEmailFromJwtStatic(accessToken)

                // Guard: only persist tokens and write success if this is still
                // the active flow. A newer flow may have started while the HTTP
                // exchange was in flight — persisting stale tokens would overwrite
                // the newer flow's credentials.
                if (!isActiveFlow(requestId)) {
                    Log.w(TAG, "Token exchange completed for stale flow $requestId — discarding tokens")
                    return
                }

                withContext(NonCancellable + Dispatchers.IO) {
                    val prior = ConfigManager.loadConfigOrBootstrap(appCtx)
                    ConfigManager.persistOpenAIOAuthTokens(
                        context = appCtx,
                        accessToken = accessToken,
                        refreshToken = refreshToken.ifBlank { prior.openaiOAuthRefresh },
                        email = email ?: prior.openaiOAuthEmail,
                        expiresAt = expiresAt,
                    )
                    writeResultFileStatic(appCtx, requestId, JSONObject().apply {
                        put("status", "success")
                    })
                }
                Log.i(TAG, "Browser flow completed successfully")
            } catch (e: Exception) {
                Log.e(TAG, "Token exchange failed", e)
                // Only write error result if still active — don't clobber a newer flow.
                if (!isActiveFlow(requestId)) return
                try {
                    withContext(NonCancellable + Dispatchers.IO) {
                        writeResultFileStatic(appCtx, requestId, JSONObject().apply {
                            put("status", "error")
                            put("message", "Sign-in failed. Please try again.")
                        })
                    }
                } catch (writeErr: Exception) {
                    Log.e(TAG, "Failed to write OAuth error result", writeErr)
                }
            } finally {
                onComplete()
            }
        }

        private fun httpPostStatic(url: String, body: String): String {
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
                if (statusCode !in 200..299) {
                    Log.d(TAG, "httpPostStatic non-2xx response: HTTP $statusCode")
                    throw RuntimeException("HTTP $statusCode")
                }
                return responseBody
            } finally {
                conn.disconnect()
            }
        }

        /**
         * Write a result JSON file for the polling UI. Retries once on failure,
         * then falls back to a minimal status-only write so the poller always
         * sees a terminal status instead of hanging until its own 10-min timeout.
         */
        private fun writeResultFileStatic(appCtx: Context, requestId: String, result: JSONObject) {
            try {
                doWriteResultFile(appCtx, requestId, result)
            } catch (e: Exception) {
                Log.e(TAG, "Result file write failed, retrying", e)
                try {
                    doWriteResultFile(appCtx, requestId, result)
                } catch (retry: Exception) {
                    Log.e(TAG, "Retry also failed, writing minimal fallback", retry)
                    try {
                        File(appCtx.filesDir, RESULTS_DIR).apply { mkdirs() }
                            .resolve("$requestId.json")
                            .writeText("""{"status":"error","message":"Failed to persist OAuth result"}""")
                    } catch (_: Exception) { /* nothing more we can do */ }
                }
            }
        }

        private fun doWriteResultFile(appCtx: Context, requestId: String, result: JSONObject) {
            val resultDir = File(appCtx.filesDir, RESULTS_DIR).apply { mkdirs() }
            val tmpFile = File(resultDir, "$requestId.tmp")
            val jsonFile = File(resultDir, "$requestId.json")
            tmpFile.writeText(result.toString())
            jsonFile.delete()
            if (!tmpFile.renameTo(jsonFile)) {
                tmpFile.copyTo(jsonFile, overwrite = true)
                tmpFile.delete()
            }
            Log.d(TAG, "Result written: ${jsonFile.absolutePath}")
        }

        private fun extractEmailFromJwtStatic(jwt: String): String? {
            return try {
                val parts = jwt.split(".")
                if (parts.size < 3) return null
                val payload = parts[1]
                val normalized = when (payload.length % 4) {
                    0 -> payload
                    else -> payload.padEnd(payload.length + (4 - (payload.length % 4)), '=')
                }
                val decoded = Base64.decode(normalized, Base64.URL_SAFE or Base64.NO_WRAP)
                val json = JSONObject(String(decoded, Charsets.UTF_8))
                val email = json.optString("email", "")
                val name = json.optString("name", "")
                val preferredUsername = json.optString("preferred_username", "")
                val sub = json.optString("sub", "")
                email.ifEmpty { preferredUsername.ifEmpty { name.ifEmpty { sub.ifEmpty { null } } } }
            } catch (_: Exception) {
                null
            }
        }

        // ── Static callback handler ─────────────────────────────────────
        // Runs on NanoHTTPD's server thread. Uses only companion state +
        // captured locals — no Activity instance reference (may be destroyed).

        private fun handleCallbackStatic(
            appCtx: Context,
            activityRef: WeakReference<OpenAIOAuthActivity>,
            requestId: String,
            serverInstance: CallbackServer,
            params: Map<String, String>,
            expectedState: String,
            codeVerifier: String,
        ): String {
            val code = params["code"]
            val state = params["state"]
            val error = params["error"]

            if (state != expectedState) {
                Log.w(TAG, "State mismatch — ignoring stray callback (not flipping guard)")
                return buildHtmlResponse(
                    "Ignored Redirect",
                    "This sign-in redirect was ignored because it did not match the active request. " +
                        "Return to SeekerClaw to retry or cancel the sign-in."
                )
            }

            // Reject callbacks from a stale flow — a new OAuth attempt may have
            // started (resetting shared state). Don't flip any shared guards.
            if (!isActiveFlow(requestId)) {
                Log.w(TAG, "Callback arrived for stale flow $requestId — ignoring")
                serverInstance.stop()
                return buildHtmlResponse(
                    "Ignored Redirect",
                    "A newer sign-in attempt is active. Return to SeekerClaw."
                )
            }

            // Idempotency guard — uses companion state under FLOW_LOCK.
            synchronized(FLOW_LOCK) {
                if (activeCallbackReceived) {
                    Log.d(TAG, "Duplicate valid callback ignored")
                    return buildHtmlResponse(
                        "Completing Sign-In",
                        "Already processing — please return to SeekerClaw for status."
                    )
                }
                activeCallbackReceived = true
            }

            if (error != null) {
                Log.e(TAG, "OAuth error: $error")
                if (claimWrite()) {
                    try {
                        writeResultFileStatic(appCtx, requestId, JSONObject().apply {
                            put("status", "error")
                            put("message", "Authentication failed. Please try again.")
                        })
                    } catch (e: Exception) {
                        Log.e(TAG, "Failed to write OAuth error result on callback thread", e)
                    }
                    markWriteCompleted()
                }
                // Stop THIS flow's server via the captured instance — activeServer
                // may not be assigned yet or may point to a newer flow's server.
                serverInstance.stop()
                synchronized(FLOW_LOCK) {
                    activeTimeoutJob?.cancel()
                    activeTimeoutJob = null
                    if (activeServer === serverInstance) activeServer = null
                }
                activityRef.get()?.finishOnMain()
                return buildHtmlResponse("Error", "Authentication failed. Please try again.")
            }

            if (code == null) {
                Log.e(TAG, "No code in callback")
                if (claimWrite()) {
                    try {
                        writeResultFileStatic(appCtx, requestId, JSONObject().apply {
                            put("status", "error")
                            put("message", "No authorization code received")
                        })
                    } catch (e: Exception) {
                        Log.e(TAG, "Failed to write no-code result on callback thread", e)
                    }
                    markWriteCompleted()
                }
                serverInstance.stop()
                synchronized(FLOW_LOCK) {
                    activeTimeoutJob?.cancel()
                    activeTimeoutJob = null
                    if (activeServer === serverInstance) activeServer = null
                }
                activityRef.get()?.finishOnMain()
                return buildHtmlResponse("Error", "No authorization code received.")
            }

            if (!claimWrite()) {
                Log.w(TAG, "Write slot already claimed before exchange could start")
                return buildHtmlResponse("Error", "Sign-in already completed in another tab.")
            }

            // exchangeCodeForTokensStatic checks isActiveFlow before persisting
            // tokens or writing results — stale exchanges discard their tokens.
            // onComplete uses serverInstance to stop THIS flow's server, and only
            // clears activeServer if it still points to this instance.
            EXCHANGE_SCOPE.launch {
                exchangeCodeForTokensStatic(
                    appCtx = appCtx,
                    requestId = requestId,
                    code = code,
                    codeVerifier = codeVerifier,
                    onComplete = {
                        serverInstance.stop()
                        synchronized(FLOW_LOCK) {
                            if (activeFlowId == requestId) {
                                activeTimeoutJob?.cancel()
                                activeTimeoutJob = null
                                if (activeServer === serverInstance) activeServer = null
                                activeWriteState = WriteState.COMPLETED
                                activeFlowId = null
                                activeCallbackReceived = false
                            }
                        }
                        activityRef.get()?.finishOnMain()
                    },
                )
            }

            return buildHtmlResponse(
                "Signed In",
                "You can close this tab and return to SeekerClaw."
            )
        }

        // ── HTML helpers (pure functions) ────────────────────────────────

        private fun escapeHtml(text: String): String = text
            .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace("\"", "&quot;").replace("'", "&#39;")

        private fun buildHtmlResponse(title: String, message: String): String {
            val safeTitle = escapeHtml(title)
            val safeMessage = escapeHtml(message)
            val isSuccess = title == "Success" || title == "Completing Sign-In" || title == "Signed In"
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
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val rawRequestId = intent.getStringExtra("requestId") ?: run {
            Log.w(TAG, "No requestId specified")
            finish()
            return
        }
        if (!UUID_PATTERN.matches(rawRequestId)) {
            Log.w(TAG, "Rejected non-UUID requestId: ${rawRequestId.take(40)}")
            finish()
            return
        }
        val requestId = rawRequestId

        setContentView(buildWaitingView(requestId))

        Log.i(TAG, "Starting OAuth browser flow (request: $requestId)")
        startBrowserFlow(requestId)
    }

    private fun buildWaitingView(requestId: String): android.view.View {
        val ctx = this
        val density = resources.displayMetrics.density
        fun dp(v: Int) = (v * density).toInt()

        val root = android.widget.LinearLayout(ctx).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            gravity = android.view.Gravity.CENTER
            setBackgroundColor(0xFF0A0A0F.toInt())
            setPadding(dp(32), dp(32), dp(32), dp(32))
            layoutParams = android.view.ViewGroup.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
            )
        }
        val title = android.widget.TextView(ctx).apply {
            text = "Waiting for OpenAI sign-in"
            textSize = 20f
            setTextColor(0xFFFFFFFF.toInt())
            gravity = android.view.Gravity.CENTER
        }
        val subtitle = android.widget.TextView(ctx).apply {
            text = "Complete sign-in in your browser, then return to SeekerClaw."
            textSize = 14f
            setTextColor(0xCCFFFFFF.toInt())
            gravity = android.view.Gravity.CENTER
            setPadding(0, dp(12), 0, dp(24))
        }
        val progress = android.widget.ProgressBar(ctx).apply {
            isIndeterminate = true
        }
        val cancel = android.widget.Button(ctx).apply {
            text = "Cancel"
            setOnClickListener {
                Log.i(TAG, "User canceled OAuth flow")
                // Only touch shared state if this is still the active flow.
                // A new flow may have started if the user navigated away and
                // came back — don't let a stale cancel clobber it.
                if (!isActiveFlow(requestId)) {
                    Log.d(TAG, "Cancel pressed for stale flow — ignoring shared state")
                    finish()
                    return@setOnClickListener
                }
                // Stop server + timeout synchronously so the port is freed and
                // no stale timeout can fire after the user pressed Cancel.
                synchronized(FLOW_LOCK) {
                    activeTimeoutJob?.cancel()
                    activeTimeoutJob = null
                    activeServer?.stop()
                    activeServer = null
                }
                val appCtx = applicationContext
                if (claimWrite()) {
                    EXCHANGE_SCOPE.launch {
                        try {
                            writeResultFileStatic(appCtx, requestId, JSONObject().apply {
                                put("status", "error")
                                put("message", "Sign-in canceled")
                            })
                        } catch (e: Exception) {
                            Log.w(TAG, "Failed to write canceled result", e)
                        } finally {
                            if (isActiveFlow(requestId)) {
                                synchronized(FLOW_LOCK) {
                                    activeFlowId = null
                                    activeWriteState = WriteState.COMPLETED
                                }
                            }
                        }
                    }
                }
                finish()
            }
        }
        root.addView(title)
        root.addView(subtitle)
        root.addView(progress)
        val cancelParams = android.widget.LinearLayout.LayoutParams(
            android.view.ViewGroup.LayoutParams.WRAP_CONTENT,
            android.view.ViewGroup.LayoutParams.WRAP_CONTENT,
        ).apply { topMargin = dp(24) }
        root.addView(cancel, cancelParams)
        return root
    }

    // IMPORTANT: No onDestroy() override — the callback server lives in the
    // companion object and must survive Activity destruction. Android can destroy
    // this Activity while the user authenticates in Chrome Custom Tab (observed
    // on Pixel 7 / stock Android 14 during fresh install). The server is cleaned
    // up by: callback handler, cancel button, or 10-minute timeout on EXCHANGE_SCOPE.

    // ── Browser Redirect Flow (PKCE) ────────────────────────────────────

    private fun startBrowserFlow(requestId: String) {
        val codeVerifier = generateCodeVerifier()
        val codeChallenge = generateCodeChallenge(codeVerifier)
        val state = generateState()

        // Reset any prior flow (e.g. user retries after a failure).
        // Cancels stale timeout, stops old server, resets write state.
        resetActiveFlow()

        val appCtx = applicationContext
        val activityRef = WeakReference(this)

        // Start callback server — lives in companion object, survives Activity destruction.
        // Pass the server instance into the callback so handleCallbackStatic can stop
        // THIS server (not whatever activeServer points to if a new flow starts).
        var server: CallbackServer? = null
        server = CallbackServer(CALLBACK_PORT) { params ->
            handleCallbackStatic(appCtx, activityRef, requestId, server!!, params, state, codeVerifier)
        }
        // Publish flowId BEFORE server.start() so callbacks from NanoHTTPD's
        // accept thread are recognized as the active flow from the first request.
        // If start() fails, we clean up flowId in the catch block.
        synchronized(FLOW_LOCK) {
            activeFlowId = requestId
        }
        try {
            server.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)
            synchronized(FLOW_LOCK) {
                activeServer = server
            }
            Log.i(TAG, "Callback server started on port $CALLBACK_PORT")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start callback server", e)
            synchronized(FLOW_LOCK) { activeFlowId = null }
            if (claimWrite()) {
                EXCHANGE_SCOPE.launch {
                    try {
                        writeResultFileStatic(appCtx, requestId, JSONObject().apply {
                            put("status", "error")
                            put("message", "Couldn't start local callback server. Please try again.")
                        })
                    } catch (writeErr: Exception) {
                        Log.w(TAG, "Failed to write server-fail result", writeErr)
                    } finally {
                        markWriteCompleted()
                    }
                }
            }
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

        // Safety timeout on EXCHANGE_SCOPE (survives Activity destruction).
        // If user abandons browser login, stop server and write error after 10 min.
        // Stored in activeTimeoutJob (under FLOW_LOCK) so resetActiveFlow() can
        // cancel it on retry. All state reads + mutations inside the lock.
        synchronized(FLOW_LOCK) {
            activeTimeoutJob = EXCHANGE_SCOPE.launch {
                delay(600_000)
                // Check + mutate under FLOW_LOCK so we don't race with
                // resetActiveFlow() or a callback that arrived just now.
                val shouldFire = synchronized(FLOW_LOCK) {
                    if (activeFlowId == requestId && !activeCallbackReceived
                        && activeServer != null && activeWriteState == WriteState.IDLE
                    ) {
                        activeWriteState = WriteState.WRITING
                        true
                    } else false
                }
                if (shouldFire) {
                    Log.w(TAG, "Browser flow timed out after 10 minutes")
                    withContext(NonCancellable + Dispatchers.IO) {
                        writeResultFileStatic(appCtx, requestId, JSONObject().apply {
                            put("status", "error")
                            put("message", "Browser login timed out. Please try again.")
                        })
                    }
                    synchronized(FLOW_LOCK) {
                        activeServer?.stop()
                        activeServer = null
                        activeTimeoutJob = null
                        activeWriteState = WriteState.COMPLETED
                    }
                    activityRef.get()?.finishOnMain()
                }
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

    private fun finishOnMain() {
        runOnUiThread { finish() }
    }

    // ── NanoHTTPD Callback Server ────────────────────────────────────────

    private class CallbackServer(
        port: Int,
        private val onCallback: (Map<String, String>) -> String
    ) : NanoHTTPD(port) {
        // Bind to the wildcard address (NanoHTTPD's no-hostname constructor binds to
        // 0.0.0.0, i.e. all network interfaces). We used to pass "localhost" here,
        // but on newer Android devices (e.g. Pixel 7 / Android 14)
        // InetAddress.getByName("localhost") resolves to ::1 only, so the server
        // bound only to IPv6 loopback. Meanwhile Chrome's Custom Tab resolves
        // "localhost" to 127.0.0.1 for the redirect, causing connection refused on
        // the callback. Reported as BAT-489.
        //
        // Binding wildcard accepts both 127.0.0.1 and ::1 connections — but it also
        // accepts connections from other hosts on the same network, which we do NOT
        // want. The localhost-only security guarantee is therefore NOT provided by
        // the bind itself; it is enforced in serve() below by rejecting any request
        // whose remote IP is outside the loopback range with 403 Forbidden.

        override fun serve(session: IHTTPSession): Response {
            val remoteIp = session.remoteIpAddress ?: ""
            if (!isLoopback(remoteIp)) {
                Log.w(TAG, "Rejecting non-loopback callback request from $remoteIp")
                return newFixedLengthResponse(Response.Status.FORBIDDEN, "text/plain", "Forbidden")
            }
            if (session.uri == "/auth/callback" && session.method == Method.GET) {
                @Suppress("DEPRECATION")
                val params = session.parms ?: emptyMap()
                val html = onCallback(params)
                return newFixedLengthResponse(Response.Status.OK, "text/html", html)
            }
            return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "Not found")
        }

        private fun isLoopback(ip: String): Boolean {
            if (ip.isEmpty()) return false
            val stripped = ip.substringBefore('%')
            if (stripped.startsWith("::ffff:127.", ignoreCase = true)) return true
            return try {
                InetAddress.getByName(stripped).isLoopbackAddress
            } catch (e: Exception) {
                false
            }
        }
    }
}
