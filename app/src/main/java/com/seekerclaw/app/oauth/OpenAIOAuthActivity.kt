package com.seekerclaw.app.oauth

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.browser.customtabs.CustomTabsIntent
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.service.OAuthKeepAliveService
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
                // Log.w survives R8 optimization (Log.d is stripped).
                // Include the exception class + message explicitly so release-build
                // logcat shows the actual error — R8 can strip the Throwable stack
                // trace from Log.e's 3-arg overload, leaving "Token exchange failed"
                // with zero diagnostic context (discovered BAT-494 Pixel 7 diagnosis).
                Log.w(TAG, "Exchange error: ${e.javaClass.simpleName}: ${e.message}")
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
                    // Log.w survives R8 (Log.d doesn't). Extract only the
                    // error/error_description fields from the JSON response
                    // to avoid leaking full token-endpoint payloads into
                    // production logcat (Copilot PR #328 review feedback).
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
            // Only stop the stale flow's captured server here; do NOT stop the
            // process-wide keep-alive service because a newer flow may still need it.
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
                        // Brief delay before stopping the server so NanoHTTPD's serve
                        // thread has time to finish writing the HTTP response to Chrome.
                        // State cleanup + service stop happen AFTER the server is actually
                        // stopped — keeping them atomic prevents a new OAuth attempt from
                        // starting on the same port while the old server is still bound.
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
                                    // Only stop the keep-alive service if this is still
                                    // the active flow. A newer flow may have started during
                                    // the 500ms delay — stopping the service would kill
                                    // the newer flow's network access.
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
            // DarkOps design system colors (from Theme.kt)
            val statusColor = if (isSuccess) "#00C805" else "#F87171" // actionPrimary / error
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
                    /* Corner glow — mirrors the Compose cornerGlowBorder */
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
                    .logo-footer { margin: 0 auto; width: 120px; height: 25px; }
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
                        <svg class="logo-footer" viewBox="0 0 371 78"><path d="M42.7937,0C34.9072,9.12651 30.0655,21.4812 30.0655,35.0828C30.0655,50.6604 36.4161,64.6024 46.4183,73.9326C40.25,76.3504 33.2995,77.71 25.9472,77.71C18.3952,77.71 11.267,76.2757 4.97506,73.7334C1.79378,66.8261 0.00000211116,59.0108 0,50.7333C0,23.878 18.8744,1.88402 42.7937,0Z" fill="#E41F28"/><path d="M79.2952,21.0796C72.5209,31.0595 61.8402,38.9336 48.7021,42.454C33.3533,46.5666 17.9386,43.8553 6.2498,36.271C5.53306,42.8156 6.02497,49.8319 7.9146,56.8841C9.93388,64.4201 13.3148,71.1227 17.592,76.6464C25.1648,77.9854 33.2748,77.714 41.3664,75.5459C67.3066,68.5952 83.6662,44.6715 79.2952,21.0796Z" fill="#E41F28"/><path d="M117.85,57.6C115.383,57.6 113.133,57.2 111.1,56.4C109.1,55.5667 107.483,54.3333 106.25,52.7C105.05,51.0333 104.4,48.9333 104.3,46.4H112.6C112.733,47.5667 113.2,48.6167 114,49.55C114.833,50.4833 116.083,50.95 117.75,50.95C119.183,50.95 120.25,50.6333 120.95,50C121.683,49.3667 122.05,48.5333 122.05,47.5C122.05,47.0333 121.967,46.6 121.8,46.2C121.667,45.8 121.383,45.4167 120.95,45.05C120.517,44.65 119.85,44.25 118.95,43.85C118.083,43.45 116.917,43.0167 115.45,42.55C112.717,41.6833 110.583,40.6667 109.05,39.5C107.517,38.3333 106.433,37.0833 105.8,35.75C105.2,34.4167 104.9,33.05 104.9,31.65C104.933,29.3833 105.5,27.5 106.6,26C107.7,24.4667 109.167,23.3167 111,22.55C112.833,21.7833 114.883,21.4 117.15,21.4C119.417,21.4 121.483,21.8 123.35,22.6C125.25,23.3667 126.783,24.5167 127.95,26.05C129.117,27.5833 129.717,29.4833 129.75,31.75H121.25C121.217,30.85 120.833,30 120.1,29.2C119.367,28.4 118.283,28 116.85,28C115.817,28.0333 114.933,28.3333 114.2,28.9C113.5,29.4333 113.15,30.2 113.15,31.2C113.15,32.0667 113.517,32.8167 114.25,33.45C114.983,34.0833 116.017,34.6667 117.35,35.2C118.717,35.7333 120.3,36.3 122.1,36.9C123.467,37.3667 124.667,37.9167 125.7,38.55C126.767,39.15 127.65,39.8667 128.35,40.7C129.05,41.5 129.583,42.4167 129.95,43.45C130.317,44.4833 130.5,45.65 130.5,46.95C130.5,49.0833 129.95,50.95 128.85,52.55C127.783,54.15 126.3,55.4 124.4,56.3C122.5,57.1667 120.317,57.6 117.85,57.6ZM145.359,57.6C143.059,57.6 140.942,57.1167 139.009,56.15C137.075,55.15 135.525,53.6833 134.359,51.75C133.192,49.8167 132.609,47.4333 132.609,44.6C132.609,41.7667 133.175,39.3833 134.309,37.45C135.442,35.5167 136.975,34.0667 138.909,33.1C140.842,32.1 142.992,31.6 145.359,31.6C147.825,31.6 149.992,32.1167 151.859,33.15C153.759,34.15 155.242,35.6 156.309,37.5C157.409,39.3667 157.959,41.6 157.959,44.2C157.959,44.5333 157.942,44.9 157.909,45.3C157.909,45.6667 157.875,46.05 157.809,46.45H140.309C140.409,47.65 140.692,48.6 141.159,49.3C141.659,50 142.259,50.5167 142.959,50.85C143.692,51.15 144.409,51.3 145.109,51.3C146.075,51.3 146.892,51.1 147.559,50.7C148.225,50.3 148.742,49.6833 149.109,48.85H157.359C156.992,50.4167 156.259,51.8667 155.159,53.2C154.059,54.5333 152.675,55.6 151.009,56.4C149.375,57.2 147.492,57.6 145.359,57.6ZM140.309,42.15H150.009C150.009,40.7833 149.559,39.7167 148.659,38.95C147.759,38.1833 146.625,37.8 145.259,37.8C143.925,37.8 142.825,38.2 141.959,39C141.092,39.7667 140.542,40.8167 140.309,42.15ZM172.214,57.6C169.914,57.6 167.797,57.1167 165.864,56.15C163.931,55.15 162.381,53.6833 161.214,51.75C160.047,49.8167 159.464,47.4333 159.464,44.6C159.464,41.7667 160.031,39.3833 161.164,37.45C162.297,35.5167 163.831,34.0667 165.764,33.1C167.697,32.1 169.847,31.6 172.214,31.6C174.681,31.6 176.847,32.1167 178.714,33.15C180.614,34.15 182.097,35.6 183.164,37.5C184.264,39.3667 184.814,41.6 184.814,44.2C184.814,44.5333 184.797,44.9 184.764,45.3C184.764,45.6667 184.731,46.05 184.664,46.45H167.164C167.264,47.65 167.547,48.6 168.014,49.3C168.514,50 169.114,50.5167 169.814,50.85C170.547,51.15 171.264,51.3 171.964,51.3C172.931,51.3 173.747,51.1 174.414,50.7C175.081,50.3 175.597,49.6833 175.964,48.85H184.214C183.847,50.4167 183.114,51.8667 182.014,53.2C180.914,54.5333 179.531,55.6 177.864,56.4C176.231,57.2 174.347,57.6 172.214,57.6ZM167.164,42.15H176.864C176.864,40.7833 176.414,39.7167 175.514,38.95C174.614,38.1833 173.481,37.8 172.114,37.8C170.781,37.8 169.681,38.2 168.814,39C167.947,39.7667 167.397,40.8167 167.164,42.15ZM186.97,57V22H194.67V42.1L202.02,32.2H211.52L201.32,44.5L211.87,57H202.32L194.67,46.45V57H186.97ZM222.263,57.6C219.963,57.6 217.846,57.1167 215.913,56.15C213.98,55.15 212.43,53.6833 211.263,51.75C210.096,49.8167 209.513,47.4333 209.513,44.6C209.513,41.7667 210.08,39.3833 211.213,37.45C212.346,35.5167 213.88,34.0667 215.813,33.1C217.746,32.1 219.896,31.6 222.263,31.6C224.73,31.6 226.896,32.1167 228.763,33.15C230.663,34.15 232.146,35.6 233.213,37.5C234.313,39.3667 234.863,41.6 234.863,44.2C234.863,44.5333 234.846,44.9 234.813,45.3C234.813,45.6667 234.78,46.05 234.713,46.45H217.213C217.313,47.65 217.596,48.6 218.063,49.3C218.563,50 219.163,50.5167 219.863,50.85C220.596,51.15 221.313,51.3 222.013,51.3C222.98,51.3 223.796,51.1 224.463,50.7C225.13,50.3 225.646,49.6833 226.013,48.85H234.263C233.896,50.4167 233.163,51.8667 232.063,53.2C230.963,54.5333 229.58,55.6 227.913,56.4C226.28,57.2 224.396,57.6 222.263,57.6ZM217.213,42.15H226.913C226.913,40.7833 226.463,39.7167 225.563,38.95C224.663,38.1833 223.53,37.8 222.163,37.8C220.83,37.8 219.73,38.2 218.863,39C217.996,39.7667 217.446,40.8167 217.213,42.15ZM237.018,57V32.2H244.718V36.05C245.585,34.7833 246.685,33.7333 248.018,32.9C249.352,32.0333 250.885,31.6 252.618,31.6V39.75H250.468C248.535,39.75 247.085,40.1833 246.118,41.05C245.185,41.9167 244.718,43.35 244.718,45.35V57H237.018Z" fill="#FFFFFF"/><path d="M271.55,57.6C267.917,57.6 264.817,56.8333 262.25,55.3C259.683,53.7333 257.717,51.6 256.35,48.9C255.017,46.2 254.35,43.1 254.35,39.6C254.35,36.1 255,32.9833 256.3,30.25C257.633,27.4833 259.583,25.3167 262.15,23.75C264.717,22.1833 267.85,21.4 271.55,21.4C275.883,21.4 279.45,22.5 282.25,24.7C285.05,26.8667 286.767,29.95 287.4,33.95H278.75C278.417,32.25 277.6,30.9333 276.3,30C275.033,29.0667 273.4,28.6 271.4,28.6C269.667,28.6 268.117,29.0167 266.75,29.85C265.383,30.65 264.317,31.8667 263.55,33.5C262.783,35.1 262.4,37.1333 262.4,39.6C262.4,42 262.767,44.0167 263.5,45.65C264.267,47.25 265.333,48.4667 266.7,49.3C268.067,50.1 269.633,50.5 271.4,50.5C273.4,50.5 275.033,50.0833 276.3,49.25C277.6,48.3833 278.417,47.1667 278.75,45.6H287.4C286.767,49.3333 285.05,52.2667 282.25,54.4C279.45,56.5333 275.883,57.6 271.55,57.6ZM289.742,63.1L302.192,17.7H309.842L297.292,63.1H289.742ZM316.883,57.6C315.449,57.6 314.116,57.3167 312.883,56.75C311.649,56.15 310.649,55.3 309.883,54.2C309.149,53.0667 308.783,51.7 308.783,50.1C308.783,48.2667 309.266,46.7833 310.233,45.65C311.199,44.4833 312.483,43.6333 314.083,43.1C315.716,42.5667 317.499,42.3 319.433,42.3H325.033C325.033,41.4333 324.883,40.6667 324.583,40C324.283,39.3333 323.833,38.8167 323.233,38.45C322.633,38.05 321.883,37.85 320.983,37.85C320.049,37.85 319.199,38.05 318.433,38.45C317.666,38.85 317.183,39.5333 316.983,40.5H309.533C309.666,38.6667 310.283,37.1 311.383,35.8C312.483,34.4667 313.883,33.4333 315.583,32.7C317.316,31.9667 319.166,31.6 321.133,31.6C323.433,31.6 325.449,32.0333 327.183,32.9C328.949,33.7333 330.316,34.95 331.283,36.55C332.249,38.1167 332.733,40.0167 332.733,42.25V48.6C332.733,49.3333 332.833,49.9 333.033,50.3C333.266,50.7 333.849,50.9 334.783,50.9V57C333.183,57 331.849,56.9 330.783,56.7C329.716,56.5 328.816,56.1333 328.083,55.6C327.349,55.0333 326.683,54.2167 326.083,53.15C324.983,54.6167 323.683,55.7333 322.183,56.5C320.683,57.2333 318.916,57.6 316.883,57.6ZM319.583,51.7C320.549,51.7 321.433,51.5 322.233,51.1C323.066,50.6667 323.733,50.0667 324.233,49.3C324.733,48.5333 324.983,47.6667 324.983,46.7V46.4H320.233C319.566,46.4 318.949,46.5 318.383,46.7C317.816,46.8667 317.366,47.15 317.033,47.55C316.699,47.9167 316.533,48.4333 316.533,49.1C316.533,50.0667 316.849,50.75 317.483,51.15C318.116,51.5167 318.816,51.7 319.583,51.7ZM339.518,57L332.768,32.2H340.368L343.868,49.95L348.068,32.2H356.118L360.318,49.85L363.768,32.2H370.968L364.218,57H355.818L351.918,40.9L347.868,57H339.518Z" fill="#E41F28"/></svg>
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

        // Start a temporary foreground service BEFORE opening Chrome Custom Tab.
        // On Pixel 7 / Android 14, the background process's internet is restricted
        // when Chrome takes the foreground — DNS resolution for auth.openai.com fails
        // with UnknownHostException. The foreground service gives the process
        // unrestricted network access for the duration of the OAuth flow (BAT-494).
        OAuthKeepAliveService.start(appCtx)

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
            OAuthKeepAliveService.stop(appCtx)
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
