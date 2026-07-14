package com.seekerclaw.app.oauth

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.browser.customtabs.CustomTabsIntent
import com.seekerclaw.app.BuildConfig
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.config.KeystoreHelper
import com.seekerclaw.app.service.OAuthKeepAliveService
import com.seekerclaw.app.service.SeekerClawService
import com.seekerclaw.app.state.XaiOAuthTokenStore
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
import java.net.BindException
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * Activity that handles the xAI Grok ("Sign in with Grok") OAuth PKCE flow:
 * Custom Tabs → user signs in on auth.x.ai → 127.0.0.1:56121 loopback callback → token exchange.
 *
 * Faithful clone of [OpenAIOAuthActivity] (BAT-1124). Divergences from the OpenAI flow, all
 * required by the BAT-1124 contract §5.1 / §11b:
 *  - Own [RESULTS_DIR] (`xai_oauth_results`) so the poller never collides with the OpenAI one.
 *  - xAI endpoints + public client_id; redirect is the FIXED loopback `http://127.0.0.1:56121/callback`
 *    (no random-port fallback — xAI registered this exact value). Port-in-use is a loud failure (M3).
 *  - Authorize URL DROPS the OpenAI-only `id_token_add_organizations` / `codex_cli_simplified_flow`
 *    params and adds NO `plan`/`referrer` (community ports warn those misroute to the API-console SSO).
 *  - H4: an explicit `User-Agent: SeekerClaw/<versionName>` on the token-exchange POST — auth.x.ai is
 *    Cloudflare-gated and bot-blocks default/empty UAs (a browser-opened authorize URL is unaffected).
 *  - M4: the `id_token` email is decoded UNVERIFIED and used for DISPLAY/PII ONLY — never for any
 *    authorization or owner-binding decision. It is stored Keystore-encrypted like the tokens.
 *  - M2: the NanoHTTPD server binds 127.0.0.1 explicitly (the redirect is IPv4-literal, so no BAT-489
 *    "localhost→::1" hazard) and STILL enforces the non-loopback 403 guard as defense-in-depth; the
 *    PKCE verifier is never logged.
 *
 * IMPORTANT — Activity lifecycle vs. server lifetime (unchanged from OpenAI):
 * The NanoHTTPD callback server lives in the companion object (application-lifetime),
 * NOT as an Activity instance variable, because Android can destroy the stopped Activity
 * while the user authenticates in Chrome Custom Tab. If the server died with the Activity,
 * Chrome's redirect to 127.0.0.1:56121 would get "connection refused."
 *
 * onDestroy() deliberately does NOT stop the server. It is cleaned up by three paths:
 * callback received, Cancel pressed, or the 10-minute timeout.
 */
class XaiOAuthActivity : ComponentActivity() {

    companion object {
        private const val TAG = "XaiOAuth"
        const val RESULTS_DIR = "xai_oauth_results"
        // Duplicated Kotlin↔Node — providers/xai.js OAUTH_CLIENT_ID must be BYTE-EQUAL
        // (drift silently breaks refresh). Pinned by a client_id equality test (L3).
        const val CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
        const val AUTH_URL = "https://auth.x.ai/oauth2/authorize"
        const val TOKEN_URL = "https://auth.x.ai/oauth2/token"
        // Fixed loopback redirect — xAI registered EXACTLY this value (contract §3/§D1). Unlike
        // the OpenAI flow there is no random-`:0` fallback: if the port is taken we fail loud (M3).
        const val REDIRECT_URI = "http://127.0.0.1:56121/callback"
        const val SCOPES = "openid profile email offline_access grok-cli:access api:access"
        private const val CALLBACK_PORT = 56121
        private const val CALLBACK_PATH = "/callback"

        private val UUID_PATTERN = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

        // H4: SeekerClaw's OWN User-Agent for the Cloudflare-gated token endpoint.
        private val TOKEN_UA = "SeekerClaw/${BuildConfig.VERSION_NAME}"

        // Application-lifetime scope for the token exchange AND the server timeout.
        private val EXCHANGE_SCOPE = CoroutineScope(SupervisorJob() + Dispatchers.IO)

        // ── Active flow state (application-lifetime) ────────────────────
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

        /**
         * BAT-1124 (CodeRabbit): cancel an in-flight OAuth flow from OUTSIDE the Activity
         * (the Settings "Cancel" button only sees the controller). Tears down the loopback
         * server AND stops the keep-alive foreground service, so a cancel doesn't leave the
         * server bound to 127.0.0.1:56121 or the keep-alive service running.
         */
        fun cancelActiveFlow(context: Context) {
            resetActiveFlow()
            OAuthKeepAliveService.stop(context.applicationContext)
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
                        // PKCE verifier is transmitted here but NEVER logged (M2).
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
                // M4: email is decoded UNVERIFIED from the id_token — DISPLAY/PII ONLY.
                // No authorization/owner-binding decision may ever read this value.
                val email = extractEmailFromJwtStatic(idToken) ?: extractEmailFromJwtStatic(accessToken)

                // Guard: only persist if this is still the active flow (a newer flow may
                // have started while the HTTP exchange was in flight).
                if (!isActiveFlow(requestId)) {
                    Log.w(TAG, "Token exchange completed for stale flow $requestId — discarding tokens")
                    return
                }

                withContext(NonCancellable + Dispatchers.IO) {
                    val prior = ConfigManager.loadConfigOrBootstrap(appCtx)
                    val resolvedRefresh = refreshToken.ifBlank { prior.xaiOAuthRefresh }
                    val resolvedEmail = email ?: prior.xaiOAuthEmail
                    // BAT-1155: persist into the dedicated XaiOAuthTokenStore as a NEW
                    // family (sign-in, epoch-advanced, no CAS) — NOT prefs/saveConfig.
                    // Encrypt to the store's ciphertext-at-rest format; blanks stay "".
                    val encAccess = Base64.encodeToString(KeystoreHelper.encrypt(accessToken), Base64.NO_WRAP)
                    val encRefresh = if (resolvedRefresh.isNotBlank())
                        Base64.encodeToString(KeystoreHelper.encrypt(resolvedRefresh), Base64.NO_WRAP) else ""
                    val encEmail = if (resolvedEmail.isNotBlank())
                        Base64.encodeToString(KeystoreHelper.encrypt(resolvedEmail), Base64.NO_WRAP) else ""
                    val signInResult = XaiOAuthTokenStore.signIn(encAccess, encRefresh, encEmail, expiresAt)
                    if (signInResult is XaiOAuthTokenStore.Result.Failed) {
                        // Fail loud — the outer catch writes the error result file.
                        throw IllegalStateException("token store sign-in write failed: ${signInResult.reason}")
                    }
                    // H5: keep runtime_state.json's xai authType in step with the fresh
                    // sign-in so Node (which reads runtime_state FIRST) can't boot the
                    // (xai, api_key) pair over a valid oauth token.
                    ConfigManager.syncXaiRuntimeAuthType(appCtx)
                    // Locked decision 5: recovery is restart-only. Restart :node so it
                    // re-reads config.json and clears any in-memory _refreshDead /
                    // reauthRequired from a prior dead family. D2 makes this restart
                    // zero-refresh while the freshly-minted token's TTL is valid.
                    // ONLY for in-place recovery (setup already complete → the agent is
                    // the 24/7 service). During onboarding the SetupScreen's saveAndStart
                    // starts the service fresh, so a premature restart here is skipped.
                    // Kept INSIDE the NonCancellable block (CodeRabbit) so a cancellation
                    // can't leave the store written but :node not restarted (recovery
                    // half-done → stale in-memory dead flag persists until the next boot).
                    if (ConfigManager.isSetupComplete(appCtx)) {
                        try {
                            SeekerClawService.restart(appCtx)
                        } catch (e: Exception) {
                            Log.w(TAG, "Could not restart :node after xAI sign-in", e)
                        }
                    }
                    writeResultFileStatic(appCtx, requestId, JSONObject().apply {
                        put("status", "success")
                    })
                }
                Log.i(TAG, "Browser flow completed successfully")
                // BAT-1124 (device-test UX): xAI completes the loopback exchange in the
                // BACKGROUND and leaves the browser on its own "copy code into Grok Build"
                // page — unlike OpenAI, whose redirect lands the user on our "Signed In" page.
                // So the user would be stranded on a confusing browser tab with no "connected"
                // signal. Pull SeekerClaw back to the foreground so they land on the Settings
                // screen, which shows "Connected as <email>" from the result-file poller.
                try {
                    appCtx.startActivity(
                        Intent(appCtx, com.seekerclaw.app.MainActivity::class.java).apply {
                            addFlags(
                                Intent.FLAG_ACTIVITY_NEW_TASK or
                                    Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or
                                    Intent.FLAG_ACTIVITY_SINGLE_TOP
                            )
                        }
                    )
                } catch (e: Exception) {
                    Log.w(TAG, "Could not bring app to foreground after xAI sign-in", e)
                }
            } catch (e: Exception) {
                // Log.w survives R8; the message deliberately omits tokens + PKCE verifier.
                Log.w(TAG, "Exchange error: ${e.javaClass.simpleName}: ${e.message}")
                Log.e(TAG, "Token exchange failed", e)
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
                // H4: Cloudflare on auth.x.ai bot-blocks empty/default (Dalvik) UAs.
                conn.setRequestProperty("User-Agent", TOKEN_UA)
                conn.doOutput = true
                conn.connectTimeout = 15_000
                conn.readTimeout = 15_000
                OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(body) }
                val statusCode = conn.responseCode
                val stream = if (statusCode in 200..299) conn.inputStream else conn.errorStream
                val responseBody = stream?.bufferedReader()?.use { it.readText() } ?: ""
                if (statusCode !in 200..299) {
                    // Extract only error/error_description — never leak full token-endpoint payloads.
                    val safeError = try {
                        val j = org.json.JSONObject(responseBody)
                        "${j.optString("error", "?")} — ${j.optString("error_description", "")}".take(200)
                    } catch (_: Exception) {
                        responseBody.take(100).replace(Regex("[\\r\\n]+"), " ")
                    }
                    Log.w(TAG, "Token endpoint HTTP $statusCode: $safeError")
                    throw RuntimeException("HTTP $statusCode: $safeError")
                }
                return responseBody
            } finally {
                conn.disconnect()
            }
        }

        /**
         * Write a result JSON file for the polling UI. Retries once, then falls back to a
         * minimal status-only write so the poller always sees a terminal status.
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

        private fun handleCallbackStatic(
            appCtx: Context,
            activityRef: WeakReference<XaiOAuthActivity>,
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

            if (!isActiveFlow(requestId)) {
                Log.w(TAG, "Callback arrived for stale flow $requestId — ignoring")
                serverInstance.stop()
                return buildHtmlResponse(
                    "Ignored Redirect",
                    "A newer sign-in attempt is active. Return to SeekerClaw."
                )
            }

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
                serverInstance.stop()
                OAuthKeepAliveService.stop(appCtx)
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
                OAuthKeepAliveService.stop(appCtx)
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

            EXCHANGE_SCOPE.launch {
                exchangeCodeForTokensStatic(
                    appCtx = appCtx,
                    requestId = requestId,
                    code = code,
                    codeVerifier = codeVerifier,
                    onComplete = {
                        EXCHANGE_SCOPE.launch {
                            kotlinx.coroutines.delay(500)
                            serverInstance.stop()
                            synchronized(FLOW_LOCK) {
                                if (activeFlowId == requestId) {
                                    activeTimeoutJob?.cancel()
                                    activeTimeoutJob = null
                                    if (activeServer === serverInstance) activeServer = null
                                    activeWriteState = WriteState.COMPLETED
                                    activeFlowId = null
                                    activeCallbackReceived = false
                                    OAuthKeepAliveService.stop(appCtx)
                                }
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
            val statusColor = if (isSuccess) "#00C805" else "#F87171"
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
                        min-height: 100vh; background: #0A0A0F; color: #fff;
                        padding: 24px;
                    }
                    .card {
                        text-align: center; padding: 40px 28px 32px;
                        max-width: 380px; width: 100%;
                        background: #16161F;
                        border: 1px solid rgba(55, 65, 81, 0.25);
                        border-radius: 12px;
                        position: relative;
                        overflow: hidden;
                    }
                    .card::before {
                        content: '';
                        position: absolute; top: -1px; left: -1px; right: -1px; bottom: -1px;
                        border-radius: 12px;
                        background: radial-gradient(ellipse at top left, ${statusColor}20 0%, transparent 50%),
                                    radial-gradient(ellipse at bottom right, ${statusColor}10 0%, transparent 50%);
                        pointer-events: none; z-index: 0;
                    }
                    .card > * { position: relative; z-index: 1; }
                    .icon-ring {
                        width: 72px; height: 72px; border-radius: 50%;
                        background: ${statusColor}12;
                        border: 2px solid ${statusColor}40;
                        display: flex; align-items: center; justify-content: center;
                        margin: 0 auto 20px;
                    }
                    .icon-ring svg { width: 32px; height: 32px; }
                    h1 {
                        font-size: 20px; font-weight: 700;
                        color: rgba(255, 255, 255, 0.94);
                        margin-bottom: 8px; letter-spacing: -0.3px;
                    }
                    .status {
                        display: inline-block; padding: 3px 10px;
                        background: ${statusColor}18; color: $statusColor;
                        border-radius: 999px; font-size: 12px; font-weight: 600;
                        letter-spacing: 0.5px; text-transform: uppercase;
                        margin-bottom: 16px;
                    }
                    .message {
                        font-size: 14px; color: #9CA3AF;
                        line-height: 1.6; margin-bottom: 28px;
                    }
                    .hint {
                        font-size: 13px; color: rgba(255, 255, 255, 0.35);
                        margin-bottom: 24px; line-height: 1.5;
                    }
                    .hint b { color: rgba(255, 255, 255, 0.55); }
                    .divider {
                        height: 1px; background: rgba(55, 65, 81, 0.4);
                        margin-bottom: 16px;
                    }
                    .brand {
                        font-size: 11px; color: rgba(255, 255, 255, 0.2);
                        letter-spacing: 2px; text-transform: uppercase;
                    }
                    .brand span { color: #E41F28; }
                </style>
                </head>
                <body>
                    <div class="card">
                        <div class="icon-ring">${if (isSuccess)
                            """<svg viewBox="0 0 24 24" fill="none"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" fill="$statusColor"/></svg>"""
                        else
                            """<svg viewBox="0 0 24 24" fill="none"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z" fill="$statusColor"/></svg>"""
                        }</div>
                        <h1>$safeTitle</h1>
                        <div class="status">${when (title) {
                            "Signed In", "Success" -> "Connected"
                            "Completing Sign-In" -> "Processing"
                            "Ignored Redirect" -> "Ignored"
                            else -> "Failed"
                        }}</div>
                        <p class="message">$safeMessage</p>
                        <p class="hint">Tap <b>&#10005;</b> or <b>&#8592;</b> above to return to SeekerClaw</p>
                        <div class="divider"></div>
                        <div class="brand">Seeker<span>Claw</span></div>
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
            text = "Waiting for Grok sign-in"
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
                if (!isActiveFlow(requestId)) {
                    Log.d(TAG, "Cancel pressed for stale flow — ignoring shared state")
                    finish()
                    return@setOnClickListener
                }
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
                OAuthKeepAliveService.stop(applicationContext)
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

    // IMPORTANT: No onDestroy() override — the callback server lives in the companion
    // object and must survive Activity destruction (see class KDoc). Cleaned up by the
    // callback handler, cancel button, or 10-minute timeout on EXCHANGE_SCOPE.

    // ── Browser Redirect Flow (PKCE) ────────────────────────────────────

    private fun startBrowserFlow(requestId: String) {
        val codeVerifier = generateCodeVerifier()
        val codeChallenge = generateCodeChallenge(codeVerifier)
        val state = generateState()
        // BAT-1124 (Copilot): OIDC `nonce` — defense-in-depth for the `openid` id_token
        // and parity with the --login spike harness (which sends one). Reuses the same
        // CSPRNG b64url generator; a nonce needs the same unguessable-random property as
        // state. (Primary CSRF/replay protection here is still state + PKCE.)
        val nonce = generateState()

        resetActiveFlow()

        val appCtx = applicationContext
        val activityRef = WeakReference(this)

        // Foreground service BEFORE opening Chrome Custom Tab (BAT-494): keeps the
        // backgrounded process's network unrestricted for the token exchange.
        OAuthKeepAliveService.start(appCtx)

        var server: CallbackServer? = null
        server = CallbackServer(CALLBACK_PORT) { params ->
            handleCallbackStatic(appCtx, activityRef, requestId, server!!, params, state, codeVerifier)
        }
        synchronized(FLOW_LOCK) {
            activeFlowId = requestId
        }
        try {
            server.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)
            synchronized(FLOW_LOCK) {
                activeServer = server
            }
            Log.i(TAG, "Callback server started on 127.0.0.1:$CALLBACK_PORT")
        } catch (e: Exception) {
            // M3: port 56121 is FIXED (xAI registered the exact redirect). A BindException
            // means the port is in use — surface a loud, actionable error, stop keep-alive,
            // and do NOT hang. There is no random-port fallback (xAI would reject a mismatch).
            val portInUse = e is BindException ||
                (e.message?.contains("in use", ignoreCase = true) == true) ||
                (e.message?.contains("EADDRINUSE", ignoreCase = true) == true)
            Log.e(TAG, "Failed to start callback server (portInUse=$portInUse)", e)
            synchronized(FLOW_LOCK) { activeFlowId = null }
            if (claimWrite()) {
                EXCHANGE_SCOPE.launch {
                    try {
                        writeResultFileStatic(appCtx, requestId, JSONObject().apply {
                            put("status", "error")
                            put(
                                "message",
                                if (portInUse) "Port 56121 is in use — close the app using it and try again."
                                else "Couldn't start local callback server. Please try again."
                            )
                        })
                    } catch (writeErr: Exception) {
                        Log.w(TAG, "Failed to write server-fail result", writeErr)
                    } finally {
                        markWriteCompleted()
                    }
                }
            }
            OAuthKeepAliveService.stop(appCtx)
            finish()
            return
        }

        // Build authorize URL — NOTE the deliberate absence of the OpenAI-only
        // id_token_add_organizations / codex_cli_simplified_flow params, and NO plan/referrer.
        val authorizeUrl = buildString {
            append(AUTH_URL)
            append("?response_type=code")
            append("&client_id=").append(URLEncoder.encode(CLIENT_ID, "UTF-8"))
            append("&redirect_uri=").append(URLEncoder.encode(REDIRECT_URI, "UTF-8"))
            append("&scope=").append(URLEncoder.encode(SCOPES, "UTF-8"))
            append("&state=").append(URLEncoder.encode(state, "UTF-8"))
            append("&code_challenge=").append(URLEncoder.encode(codeChallenge, "UTF-8"))
            append("&code_challenge_method=S256")
            append("&nonce=").append(URLEncoder.encode(nonce, "UTF-8"))
        }

        try {
            val customTabsIntent = CustomTabsIntent.Builder().build()
            customTabsIntent.launchUrl(this, Uri.parse(authorizeUrl))
        } catch (e: Exception) {
            Log.w(TAG, "Custom Tabs unavailable, falling back to ACTION_VIEW", e)
            try {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(authorizeUrl)))
            } catch (e2: Exception) {
                // BAT-1124 (CodeRabbit): no browser at all is TERMINAL — write an error result,
                // tear down the server + keep-alive, and finish, so the UI poller doesn't hang to
                // its 10-minute timeout waiting for a callback that can never arrive.
                Log.e(TAG, "No browser available to open the authorize URL", e2)
                synchronized(FLOW_LOCK) {
                    activeServer?.stop(); activeServer = null
                    activeFlowId = null
                }
                if (claimWrite()) {
                    EXCHANGE_SCOPE.launch {
                        try {
                            writeResultFileStatic(appCtx, requestId, JSONObject().apply {
                                put("status", "error")
                                put("message", "No browser available to complete sign-in.")
                            })
                        } catch (writeErr: Exception) {
                            Log.w(TAG, "Failed to write no-browser result", writeErr)
                        } finally { markWriteCompleted() }
                    }
                }
                OAuthKeepAliveService.stop(appCtx)
                finish()
                return
            }
        }

        synchronized(FLOW_LOCK) {
            activeTimeoutJob = EXCHANGE_SCOPE.launch {
                delay(600_000)
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
                        // BAT-1124 (CodeRabbit): fully reset flow state on timeout.
                        activeFlowId = null
                        activeCallbackReceived = false
                    }
                    OAuthKeepAliveService.stop(appCtx) // BAT-1124 (CodeRabbit): stop keep-alive on timeout
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
    ) : NanoHTTPD("127.0.0.1", port) {
        // M2: bind 127.0.0.1 EXPLICITLY. The redirect is the IPv4 literal 127.0.0.1:56121,
        // so Chrome connects to IPv4 loopback — no BAT-489 "localhost→::1" hazard (that bug
        // only bit the OpenAI flow because its redirect used the "localhost" hostname). Binding
        // IPv4-loopback also refuses off-host connections at the socket layer. The isLoopback()
        // 403 guard below stays as defense-in-depth.

        override fun serve(session: IHTTPSession): Response {
            val remoteIp = session.remoteIpAddress ?: ""
            if (!isLoopback(remoteIp)) {
                Log.w(TAG, "Rejecting non-loopback callback request from $remoteIp")
                return newFixedLengthResponse(Response.Status.FORBIDDEN, "text/plain", "Forbidden")
            }
            if (session.uri == CALLBACK_PATH && session.method == Method.GET) {
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
