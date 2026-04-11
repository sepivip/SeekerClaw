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
import java.util.concurrent.atomic.AtomicReference
import android.content.Context
import java.lang.ref.WeakReference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
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
 * Activity that handles the OpenAI OAuth PKCE flow:
 * Custom Tabs → user signs in on auth.openai.com → 127.0.0.1:1455 callback → token exchange.
 *
 * Tokens obtained from the flow are persisted directly via [ConfigManager] (encrypted via
 * Android Keystore). The on-disk result file under `filesDir/oauth_results/` only carries
 * a status flag (success/error/canceled) — it never contains secrets — and is consumed by
 * `ProviderConfigScreen`'s polling coroutine to know when to reload config.
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
        // NOTE: this is the URI the browser resolves. The NanoHTTPD server itself binds
        // to all loopback interfaces (see CallbackServer below) so it's reachable
        // regardless of whether the OS resolves "localhost" to 127.0.0.1 or ::1.
        const val REDIRECT_URI = "http://localhost:1455/auth/callback"
        const val SCOPES = "openid profile email offline_access"
        private const val CALLBACK_PORT = 1455

        private val UUID_PATTERN = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

        // Application-lifetime scope for the token exchange. Survives Activity destruction
        // (rotation, system reclaim, fast back-press) so a successful browser redirect
        // always completes its persist + result-write, regardless of UI lifecycle.
        // SupervisorJob means a single failed exchange doesn't cancel sibling jobs.
        private val EXCHANGE_SCOPE = CoroutineScope(SupervisorJob() + Dispatchers.IO)

        /**
         * Static token-exchange entry point. Pure function — takes only Application
         * Context + the OAuth params + a cleanup callback. Does NOT capture an Activity
         * instance, so launching this on EXCHANGE_SCOPE cannot leak the Activity.
         *
         * Persists tokens via ConfigManager (encrypted via Keystore) and writes the
         * status result file directly to filesDir. Calls [onComplete] on the same
         * thread when done so the caller can do whatever cleanup it likes (typically
         * via a WeakReference back to the Activity).
         */
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

                withContext(NonCancellable + Dispatchers.IO) {
                    val current = ConfigManager.loadConfig(appCtx)
                        ?: throw IllegalStateException("Config not loaded — cannot persist OAuth tokens")
                    ConfigManager.saveConfig(
                        appCtx,
                        current.copy(
                            openaiOAuthToken = accessToken,
                            openaiOAuthRefresh = refreshToken.ifBlank { current.openaiOAuthRefresh },
                            openaiOAuthEmail = email ?: current.openaiOAuthEmail,
                            openaiOAuthExpiresAt = expiresAt,
                        )
                    )
                    writeResultFileStatic(appCtx, requestId, JSONObject().apply {
                        put("status", "success")
                    })
                }
                Log.i(TAG, "Browser flow completed successfully")
            } catch (e: Exception) {
                // Log the full exception (including any details) only to Logcat. The
                // result file gets a generic user-safe message — `e.message` can
                // contain raw HTTP response bodies that may include tokens or PII.
                Log.e(TAG, "Token exchange failed", e)
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

        /** Static HTTP POST helper — used by both the companion exchange and the instance flow. */
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
                    // Don't put the response body into logs OR the exception message —
                    // OAuth/token endpoints can return content that includes secrets or
                    // untrusted HTML. Status code is enough for diagnostics.
                    Log.d(TAG, "httpPostStatic non-2xx response: HTTP $statusCode")
                    throw RuntimeException("HTTP $statusCode")
                }
                return responseBody
            } finally {
                conn.disconnect()
            }
        }

        /** Static result-file writer using only application Context — no Activity capture. */
        private fun writeResultFileStatic(appCtx: Context, requestId: String, result: JSONObject) {
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

        /** Static JWT email extractor — no Activity dependency. */
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
    }

    private var callbackServer: CallbackServer? = null
    private val scope = CoroutineScope(Dispatchers.Main + Job())
    // Written from the NanoHTTPD server thread, read from the Main timeout coroutine — needs @Volatile.
    @Volatile
    private var callbackReceived = false
    // Three-state machine so onDestroy() never races with an in-flight result write
    // AND a write that fails mid-way still falls back to a canceled result on destroy.
    //   IDLE      — no write attempted yet; onDestroy may take over
    //   WRITING   — a write is in progress; onDestroy must NOT also write
    //   COMPLETED — write finished; onDestroy must NOT write
    private enum class WriteState { IDLE, WRITING, COMPLETED }
    private val writeState = AtomicReference(WriteState.IDLE)
    private var currentRequestId: String? = null

    /** Atomically claim the write slot. Returns true if the caller may proceed to write. */
    private fun claimWrite(): Boolean = writeState.compareAndSet(WriteState.IDLE, WriteState.WRITING)
    private fun markWriteCompleted() { writeState.set(WriteState.COMPLETED) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val rawRequestId = intent.getStringExtra("requestId") ?: run {
            Log.w(TAG, "No requestId specified")
            finish()
            return
        }
        // Sanitize requestId — even though the activity is exported=false, we want to
        // ensure the value can never escape filesDir/oauth_results via path traversal.
        // Accept only UUID format (hex digits, either case, separated by dashes).
        if (!UUID_PATTERN.matches(rawRequestId)) {
            Log.w(TAG, "Rejected non-UUID requestId: ${rawRequestId.take(40)}")
            finish()
            return
        }
        val requestId = rawRequestId
        currentRequestId = requestId

        // Minimal "waiting for sign-in" UI so the user doesn't return from the
        // browser to a blank translucent activity. The Cancel button stops the
        // local callback server, writes a canceled result, and finishes.
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
                callbackServer?.stop()
                callbackServer = null
                if (claimWrite()) {
                    // Use EXCHANGE_SCOPE (application-lifetime) so the write completes
                    // even if the activity is destroyed before scope.launch would have
                    // started. Capture only locals — no `this` reference inside the
                    // lambda — and signal completion via the AtomicReference directly.
                    val appCtx = applicationContext
                    val stateRef = writeState
                    EXCHANGE_SCOPE.launch {
                        try {
                            writeResultFileStatic(appCtx, requestId, JSONObject().apply {
                                put("status", "error")
                                put("message", "Sign-in canceled")
                            })
                        } catch (e: Exception) {
                            Log.w(TAG, "Failed to write canceled result", e)
                        } finally {
                            stateRef.set(WriteState.COMPLETED)
                        }
                    }
                }
                finishOnMain()
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

    override fun onDestroy() {
        super.onDestroy()
        callbackServer?.stop()
        callbackServer = null
        // If the activity is dismissed (Back button, system kill, swipe-away) BEFORE a
        // valid callback has arrived AND no other path has claimed the write slot, leave
        // a canceled result so ProviderConfigScreen stops polling immediately. We MUST
        // gate on !callbackReceived — if a callback has already arrived, the EXCHANGE_SCOPE
        // exchange is in flight and writing a synthetic "canceled" here would race a real
        // sign-in and produce a misleading status. Use EXCHANGE_SCOPE (application-
        // lifetime) instead of scope (being cancelled here) so the write actually runs.
        val reqId = currentRequestId
        if (reqId != null && !callbackReceived && claimWrite()) {
            // Capture only application Context and a local reference to the state
            // AtomicReference. The launched lambda must NOT call any instance method
            // (no markWriteCompleted, no writeResultFile, no Log without TAG capture)
            // so it doesn't pin the Activity beyond destroy.
            val appCtx = applicationContext
            val stateRef = writeState
            EXCHANGE_SCOPE.launch {
                try {
                    writeResultFileStatic(appCtx, reqId, JSONObject().apply {
                        put("status", "error")
                        put("message", "Sign-in canceled")
                    })
                } catch (e: Exception) {
                    Log.w(TAG, "Failed to write canceled result on destroy", e)
                } finally {
                    stateRef.set(WriteState.COMPLETED)
                }
            }
        }
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
            if (claimWrite()) {
                // EXCHANGE_SCOPE so the write survives even if the activity is
                // destroyed before this coroutine starts. No `this` capture.
                val appCtx = applicationContext
                val stateRef = writeState
                EXCHANGE_SCOPE.launch {
                    try {
                        writeResultFileStatic(appCtx, requestId, JSONObject().apply {
                            put("status", "error")
                            put("message", "Couldn't start local callback server. Please try again.")
                        })
                    } catch (writeErr: Exception) {
                        Log.w(TAG, "Failed to write server-fail result", writeErr)
                    } finally {
                        stateRef.set(WriteState.COMPLETED)
                    }
                }
            }
            finishOnMain()
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
            if (!callbackReceived && callbackServer != null && claimWrite()) {
                Log.w(TAG, "Browser flow timed out after 10 minutes")
                callbackServer?.stop()
                callbackServer = null
                withContext(NonCancellable + Dispatchers.IO) {
                    writeResultFile(requestId, JSONObject().apply {
                        put("status", "error")
                        put("message", "Browser login timed out. Please try again.")
                    })
                }
                markWriteCompleted()
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
        val code = params["code"]
        val state = params["state"]
        val error = params["error"]

        // Reject stray/hostile requests BEFORE flipping the idempotency guard.
        // Otherwise an attacker (or buggy client) hitting 127.0.0.1:1455/auth/callback
        // with the wrong state could permanently lock out the real browser redirect
        // and DoS the sign-in flow.
        if (state != expectedState) {
            Log.w(TAG, "State mismatch — ignoring stray callback (not flipping guard)")
            return buildHtmlResponse(
                "Ignored Redirect",
                "This sign-in redirect was ignored because it did not match the active request. " +
                    "Return to SeekerClaw to retry or cancel the sign-in."
            )
        }

        // Idempotency guard: flip only after state is validated. Browser refresh on a
        // valid redirect would otherwise launch multiple token exchanges that race
        // on the same result file.
        synchronized(this) {
            if (callbackReceived) {
                Log.d(TAG, "Duplicate valid callback ignored")
                return buildHtmlResponse(
                    "Completing Sign-In",
                    "Already processing — please return to SeekerClaw for status."
                )
            }
            callbackReceived = true
        }

        // From here on, we know this is the legitimate browser redirect. Log any
        // OpenAI-side error for diagnostics, but persist/display only a generic
        // message — callback query params are untrusted input (any local app can
        // hit 127.0.0.1:1455) and may contain arbitrary content.
        if (error != null) {
            Log.e(TAG, "OAuth error: $error")
            if (claimWrite()) {
                writeResultFile(requestId, JSONObject().apply {
                    put("status", "error")
                    put("message", "Authentication failed. Please try again.")
                })
                markWriteCompleted()
            }
            finishOnMain()
            return buildHtmlResponse("Error", "Authentication failed. Please try again.")
        }

        if (code == null) {
            Log.e(TAG, "No code in callback")
            if (claimWrite()) {
                writeResultFile(requestId, JSONObject().apply {
                    put("status", "error")
                    put("message", "No authorization code received")
                })
                markWriteCompleted()
            }
            finishOnMain()
            return buildHtmlResponse("Error", "No authorization code received.")
        }

        // Claim the write slot HERE, before launching the exchange. This closes the race
        // window where onDestroy() (e.g. user kills the activity right after the redirect)
        // could otherwise sneak in and write a "canceled" result before the exchange
        // coroutine even starts. The exchange will see the slot already claimed and just
        // markWriteCompleted() when done.
        if (!claimWrite()) {
            Log.w(TAG, "Write slot already claimed before exchange could start")
            return buildHtmlResponse("Error", "Sign-in already completed in another tab.")
        }

        // Run the exchange on the application-lifetime EXCHANGE_SCOPE via a companion
        // function that takes only appCtx + a WeakReference for cleanup. The launched
        // coroutine therefore does NOT capture the Activity instance — it survives
        // destruction without leaking, and the cleanup callback is a no-op if the
        // activity is already gone.
        val appCtx = applicationContext
        val activityRef = WeakReference(this)
        EXCHANGE_SCOPE.launch {
            exchangeCodeForTokensStatic(
                appCtx = appCtx,
                requestId = requestId,
                code = code,
                codeVerifier = codeVerifier,
                onComplete = { activityRef.get()?.onExchangeComplete() },
            )
        }

        return buildHtmlResponse(
            "Signed In",
            "You can close this tab and return to SeekerClaw."
        )
    }

    /**
     * Called by the companion-object exchange when it completes (success or failure).
     * Runs on whatever thread the companion finishes on; hops to Main for UI work.
     * No-op if the activity is already gone (the WeakReference returns null).
     */
    private fun onExchangeComplete() {
        callbackServer?.stop()
        callbackServer = null
        markWriteCompleted()
        finishOnMain()
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

    private fun writeResultFile(requestId: String, result: JSONObject) {
        try {
            doWriteResultFile(requestId, result)
        } catch (e: Exception) {
            // Storage full or filesystem error. Retry once on EXCHANGE_SCOPE after a
            // short delay (transient pressure self-resolves). If retry also fails, write
            // a minimal status-only file so the polling UI sees *something* and stops.
            Log.e(TAG, "Failed to write OAuth result file for requestId=$requestId", e)
            val appCtx = applicationContext
            EXCHANGE_SCOPE.launch {
                kotlinx.coroutines.delay(500)
                try {
                    writeResultFileStatic(appCtx, requestId, result)
                    Log.i(TAG, "Result file write succeeded on retry")
                } catch (retry: Exception) {
                    Log.e(TAG, "Result file retry also failed", retry)
                    try {
                        File(appCtx.filesDir, RESULTS_DIR).apply { mkdirs() }
                            .resolve("$requestId.json")
                            .writeText("""{"status":"error","message":"Failed to persist OAuth result"}""")
                    } catch (_: Exception) { /* nothing more we can do */ }
                }
            }
            try { finishOnMain() } catch (finishEx: Exception) {
                Log.e(TAG, "Failed to finish activity after writeResultFile error", finishEx)
            }
        }
    }

    private fun doWriteResultFile(requestId: String, result: JSONObject) {
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

    // ── NanoHTTPD Callback Server ────────────────────────────────────────

    private class CallbackServer(
        port: Int,
        private val onCallback: (Map<String, String>) -> String
    ) : NanoHTTPD(port) {
        // Bind to all loopback interfaces (NanoHTTPD's no-hostname constructor binds
        // to 0.0.0.0). We used to pass "localhost" here, but on newer Android devices
        // (e.g. Pixel 7 / Android 14) InetAddress.getByName("localhost") resolves to
        // ::1 only, so the server bound only to IPv6 loopback. Meanwhile Chrome's
        // Custom Tab resolves "localhost" to 127.0.0.1 for the redirect, causing
        // connection refused on the callback. Reported as BAT-489.
        //
        // Binding to 0.0.0.0 accepts both 127.0.0.1 and ::1 connections. We preserve
        // the localhost-only security intent by validating the remote IP in serve()
        // below — any non-loopback request is rejected with 403.

        override fun serve(session: IHTTPSession): Response {
            // Security: reject anything that isn't loopback. With a 0.0.0.0 bind we
            // could in principle be reached from other hosts on the same network, so
            // we gate every request on the client IP. NanoHTTPD reports the remote
            // address in v4 form (127.0.0.1) or v6 form (0:0:0:0:0:0:0:1 or ::1)
            // depending on how the client connected.
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
            // IPv4 loopback: entire 127.0.0.0/8 block
            if (ip.startsWith("127.")) return true
            // IPv6 loopback, short and long forms
            if (ip == "::1" || ip == "0:0:0:0:0:0:0:1") return true
            return false
        }
    }
}
