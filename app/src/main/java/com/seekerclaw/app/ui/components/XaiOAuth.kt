package com.seekerclaw.app.ui.components

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.seekerclaw.app.config.ConfigManager
// DangerOutlineButton + cornerGlowBorder live in this same package — no extra import needed
import com.seekerclaw.app.oauth.XaiOAuthActivity
import com.seekerclaw.app.state.XaiOAuthTokenStore
import com.seekerclaw.app.ui.theme.RethinkSans
import com.seekerclaw.app.ui.theme.SeekerClawColors
import com.seekerclaw.app.ui.theme.Sizing
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * BAT-1661: the sign-in was saved but the agent's settings were busy, so it was not restarted.
 * The token is stored, so the section shows "Connected" with only Sign Out: the way to re-run the
 * settings update is Sign Out, then Sign in with Grok.
 */
internal const val XAI_RESTART_NEEDED_BUSY =
    "Signed in, but the agent's settings were busy, so it was not restarted. Sign out, then sign in with Grok again to finish."

/** BAT-1661: the sign-in was saved but runtime_state.json could not be written (storage). */
internal const val XAI_RESTART_NEEDED_NOT_SAVED =
    "Signed in, but the agent's settings could not be saved, so it was not restarted. Free up storage, then sign out and sign in with Grok again."

/**
 * BAT-1661 v2.12 (review m3): the sign-in was saved, but an interrupted model selection change is not
 * finished yet, so the agent's settings were not updated and it was not restarted.
 */
internal const val XAI_RESTART_NEEDED_HELD =
    "Signed in, but a model or provider change is still being finished, so the agent was not restarted. Close and reopen the app, then sign out and sign in with Grok again to finish."

/** BAT-1661 v2.12 (review m3): the sign-out was saved, but an interrupted model selection change is not finished yet. */
internal const val XAI_SIGN_OUT_HELD =
    "Signed out, but a model or provider change is still being finished, so the agent's settings were not updated. Close and reopen the app, then sign in again or choose API Key for xAI, before restarting the agent."

/** BAT-1661: the sign-out was saved but the agent's settings were busy and were not updated. */
internal const val XAI_SIGN_OUT_BUSY =
    "Signed out, but the agent's settings were busy and were not updated. Sign in again, or choose API Key for xAI, before restarting the agent."

/** BAT-1661: the sign-out was saved but the agent's settings could not be saved (storage). */
internal const val XAI_SIGN_OUT_NOT_SAVED =
    "Signed out, but the agent's settings could not be saved. Free up storage, then sign in again or choose API Key for xAI, before restarting the agent."

/**
 * BAT-1661 (CodeRabbit on ca06bb79): what the UI does once a sign-in or sign-out is saved.
 * [notify] false: the [onSignedIn]/[onSignedOut] callback (Settings' "Restart Now" prompt) must NOT
 * fire — runtime_state.json may still hold the previous xAI auth mode, and a restart now would
 * start the agent on it. [message] is the warning to keep on screen (null: none).
 */
internal data class XaiOAuthOutcome(val notify: Boolean, val message: String?)

/** After a sign-in, from the result file's `restartNeeded` ("" when the agent was restarted). */
internal fun xaiSignInOutcome(restartNeeded: String): XaiOAuthOutcome = when (restartNeeded) {
    "busy" -> XaiOAuthOutcome(notify = false, message = XAI_RESTART_NEEDED_BUSY)
    "not_saved" -> XaiOAuthOutcome(notify = false, message = XAI_RESTART_NEEDED_NOT_SAVED)
    "held" -> XaiOAuthOutcome(notify = false, message = XAI_RESTART_NEEDED_HELD)
    else -> XaiOAuthOutcome(notify = true, message = null)
}

/**
 * BAT-1661 (CodeRabbit on ab6385bd): the ONE place the sign-in/out callback (Settings' restart
 * prompt) is invoked — only when [outcome] allows it. Returns the message to keep on screen.
 */
internal fun applyXaiOutcome(outcome: XaiOAuthOutcome, notify: () -> Unit): String? {
    if (outcome.notify) {
        notify()
    }
    return outcome.message
}

/** After a saved sign-out, from the runtime_state sync's result. */
internal fun xaiSignOutOutcome(sync: ConfigManager.XaiAuthSync): XaiOAuthOutcome = when (sync) {
    ConfigManager.XaiAuthSync.SYNCED -> XaiOAuthOutcome(notify = true, message = null)
    ConfigManager.XaiAuthSync.BUSY -> XaiOAuthOutcome(notify = false, message = XAI_SIGN_OUT_BUSY)
    ConfigManager.XaiAuthSync.NOT_SAVED -> XaiOAuthOutcome(notify = false, message = XAI_SIGN_OUT_NOT_SAVED)
    ConfigManager.XaiAuthSync.HELD -> XaiOAuthOutcome(notify = false, message = XAI_SIGN_OUT_HELD)
}

/** Snapshot of xAI Grok OAuth state shared between the Settings screen and onboarding. */
data class XaiOAuthState(
    val isConnected: Boolean,
    val email: String,
    val isPolling: Boolean,
    val error: String?,
)

/** Controller returned by [rememberXaiOAuthController]. */
class XaiOAuthController internal constructor(
    val state: XaiOAuthState,
    val signIn: () -> Unit,
    val signOut: () -> Unit,
    val cancel: () -> Unit,
)

/**
 * Hoists xAI Grok OAuth flow state (browser sign-in, polling, sign-out) so it can be
 * driven from either the Settings screen or onboarding. Faithful clone of the OpenAI
 * controller (BAT-1124) — reactive to [ConfigManager.configVersion] so writes from the
 * OAuth activity flow back here.
 */
@Composable
fun rememberXaiOAuthController(
    context: Context,
    onSignedIn: () -> Unit = {},
    onSignedOut: () -> Unit = {},
): XaiOAuthController {
    val configVer by ConfigManager.configVersion
    val config = remember(configVer) { ConfigManager.loadConfigOrBootstrap(context) }

    var requestId by remember { mutableStateOf<String?>(null) }
    var isPolling by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    // Clean up stale OAuth result files (>1h) on first composition.
    LaunchedEffect(Unit) {
        withContext(Dispatchers.IO) {
            try {
                val resultsDir = File(context.filesDir, XaiOAuthActivity.RESULTS_DIR)
                if (resultsDir.isDirectory) {
                    val cutoff = System.currentTimeMillis() - 3_600_000L
                    resultsDir.listFiles()?.forEach { f ->
                        if (f.lastModified() < cutoff) f.delete()
                    }
                }
            } catch (_: Exception) { /* best effort */ }
        }
    }

    // CodeRabbit: sign-out does file I/O + a cross-process FileChannel lock (can block up
    // to LOCK_TIMEOUT_MS) — must run off the UI thread, and its Result must gate the flow.
    val scope = rememberCoroutineScope()

    // Poll the result file written by XaiOAuthActivity. Tokens are persisted by the
    // activity directly into XaiOAuthTokenStore (BAT-1155) — we just watch the
    // status flag here to update the UI state.
    LaunchedEffect(requestId, isPolling) {
        val reqId = requestId ?: return@LaunchedEffect
        if (!isPolling) return@LaunchedEffect
        val resultsDir = File(context.filesDir, XaiOAuthActivity.RESULTS_DIR)
        val resultFile = File(resultsDir, "$reqId.json")
        val deadline = System.currentTimeMillis() + 600_000 // 10 min
        while (isPolling && System.currentTimeMillis() < deadline) {
            delay(1000)
            val exists = withContext(Dispatchers.IO) { resultFile.exists() }
            if (!exists) continue
            try {
                val json = withContext(Dispatchers.IO) {
                    val text = resultFile.readText()
                    resultFile.delete()
                    JSONObject(text)
                }
                when (json.optString("status")) {
                    "success" -> {
                        isPolling = false
                        // BAT-1661: the agent was not restarted (see XaiOAuthActivity) → no restart
                        // prompt, keep the warning.
                        error = applyXaiOutcome(xaiSignInOutcome(json.optString("restartNeeded")), onSignedIn)
                    }
                    "error" -> {
                        error = json.optString("message", "Unknown error")
                        isPolling = false
                    }
                    else -> {
                        error = "Unexpected OAuth result status: ${json.optString("status")}"
                        isPolling = false
                    }
                }
            } catch (e: Exception) {
                error = "Failed to read OAuth result: ${e.message}"
                isPolling = false
            }
        }
        if (isPolling) {
            error = "OAuth timed out. Please try again."
            isPolling = false
        }
    }

    val state = XaiOAuthState(
        isConnected = config.xaiOAuthToken.isNotBlank(),
        email = config.xaiOAuthEmail,
        isPolling = isPolling,
        error = error,
    )

    return XaiOAuthController(
        state = state,
        signIn = {
            val newId = UUID.randomUUID().toString()
            val intent = Intent(context, XaiOAuthActivity::class.java).apply {
                putExtra("requestId", newId)
            }
            context.startActivity(intent)
            requestId = newId
            isPolling = true
            error = null
        },
        signOut = {
            // BAT-1155: write an epoch-advanced sign-out TOMBSTONE into the store
            // (dead record, no token). The advanced epoch CAS-rejects any in-flight
            // old-family rotation so it can't resurrect the account, and the
            // migration marker is preserved (a signed-out family must never be
            // re-imported from stale legacy prefs). Then re-derive runtime_state's
            // xai authType (H5) so a stale (xai, oauth) can't re-open the boot-loop.
            // CodeRabbit: run off the UI thread and gate on the Result — do NOT sync
            // runtime_state or fire onSignedOut() unless the tombstone write succeeded
            // (else the UI would show "signed out" while the store still holds a live
            // family that keeps rotating).
            scope.launch {
                var sync = ConfigManager.XaiAuthSync.SYNCED
                val result = withContext(Dispatchers.IO) {
                    val r = XaiOAuthTokenStore.signOut()
                    if (r is XaiOAuthTokenStore.Result.Ok) sync = ConfigManager.syncXaiRuntimeAuthType(context)
                    r
                }
                if (result is XaiOAuthTokenStore.Result.Ok) {
                    // BAT-1661 (CodeRabbit on 444ba220 / ca06bb79): the sign-out is saved, but
                    // runtime_state may still say oauth — a restart now would boot xAI sign-in with
                    // no token. No restart prompt then; the warning stays.
                    error = applyXaiOutcome(xaiSignOutOutcome(sync), onSignedOut)
                } else {
                    error = "Sign-out failed — please try again."
                }
            }
        },
        cancel = {
            // BAT-1124 (CodeRabbit): stop the ACTIVE flow (loopback server + keep-alive service),
            // not just local polling state, so a cancel doesn't leave the server bound to :56121.
            XaiOAuthActivity.cancelActiveFlow(context)
            isPolling = false
            requestId = null
            error = null
        },
    )
}

/**
 * Visual section for the xAI Grok OAuth (Sign in with Grok) flow. Stateless —
 * pass a [state] from [rememberXaiOAuthController].
 */
@Composable
fun XaiOAuthSection(
    state: XaiOAuthState,
    onSignIn: () -> Unit,
    onSignOut: () -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)

    Column(modifier = modifier) {
        if (state.isConnected) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "Connected as ",
                    fontFamily = RethinkSans,
                    fontSize = 13.sp,
                    color = SeekerClawColors.TextSecondary,
                )
                Text(
                    text = state.email.ifBlank { "your Grok account" },
                    fontFamily = RethinkSans,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.Accent,
                )
            }
        } else {
            Text(
                text = "Uses your Grok subscription.",
                fontFamily = RethinkSans,
                fontSize = 13.sp,
                color = SeekerClawColors.TextSecondary,
            )
        }

        Spacer(modifier = Modifier.height(16.dp))

        when {
            state.isConnected -> {
                DangerOutlineButton(
                    onClick = onSignOut,
                    label = "Sign Out",
                )
            }
            state.isPolling -> {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(16.dp),
                        strokeWidth = 2.dp,
                        color = SeekerClawColors.ActionPrimary,
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = "Waiting for authentication…",
                        fontFamily = RethinkSans,
                        fontSize = 13.sp,
                        color = SeekerClawColors.TextDim,
                    )
                }
                Spacer(modifier = Modifier.height(12.dp))
                Button(
                    onClick = onCancel,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(Sizing.buttonSecondaryHeight)
                        .cornerGlowBorder(),
                    shape = shape,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = SeekerClawColors.Surface,
                        contentColor = SeekerClawColors.TextPrimary,
                    ),
                    border = BorderStroke(Sizing.borderThin, SeekerClawColors.CardBorder),
                ) {
                    Text(
                        "Cancel",
                        fontFamily = RethinkSans,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Medium,
                    )
                }
            }
            else -> {
                Button(
                    onClick = onSignIn,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(Sizing.buttonPrimaryHeight)
                        .cornerGlowBorder(),
                    shape = shape,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = SeekerClawColors.ActionPrimary,
                        contentColor = Color.White,
                    ),
                ) {
                    Text(
                        "Sign in with Grok",
                        fontFamily = RethinkSans,
                        fontWeight = FontWeight.Bold,
                        fontSize = 16.sp,
                    )
                }
            }
        }

        if (state.error != null) {
            Spacer(modifier = Modifier.height(12.dp))
            Text(
                text = state.error,
                fontFamily = RethinkSans,
                fontSize = 13.sp,
                color = SeekerClawColors.Error,
            )
        }
    }
}
