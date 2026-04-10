package com.seekerclaw.app.ui.components

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.seekerclaw.app.config.ConfigManager
// DangerButton + cornerGlowBorder live in this same package — no extra import needed
import com.seekerclaw.app.oauth.OpenAIOAuthActivity
import com.seekerclaw.app.ui.theme.RethinkSans
import com.seekerclaw.app.ui.theme.SeekerClawColors
import com.seekerclaw.app.ui.theme.Sizing
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** Snapshot of OpenAI OAuth state shared between the Settings screen and onboarding. */
data class OpenAIOAuthState(
    val isConnected: Boolean,
    val email: String,
    val isPolling: Boolean,
    val error: String?,
)

/** Controller returned by [rememberOpenAIOAuthController]. */
class OpenAIOAuthController internal constructor(
    val state: OpenAIOAuthState,
    val signIn: () -> Unit,
    val signOut: () -> Unit,
    val cancel: () -> Unit,
)

/**
 * Hoists OpenAI OAuth flow state (browser sign-in, polling, sign-out) so it can be
 * driven from either the Settings screen or onboarding. State is reactive to
 * [ConfigManager.configVersion] so writes from the OAuth activity flow back here.
 */
@Composable
fun rememberOpenAIOAuthController(
    context: Context,
    onSignedIn: () -> Unit = {},
    onSignedOut: () -> Unit = {},
): OpenAIOAuthController {
    val configVer by ConfigManager.configVersion
    val config = remember(configVer) { ConfigManager.loadConfig(context) }

    var requestId by remember { mutableStateOf<String?>(null) }
    var isPolling by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    // Clean up stale OAuth result files (>1h) on first composition.
    LaunchedEffect(Unit) {
        withContext(Dispatchers.IO) {
            try {
                val resultsDir = File(context.filesDir, OpenAIOAuthActivity.RESULTS_DIR)
                if (resultsDir.isDirectory) {
                    val cutoff = System.currentTimeMillis() - 3_600_000L
                    resultsDir.listFiles()?.forEach { f ->
                        if (f.lastModified() < cutoff) f.delete()
                    }
                }
            } catch (_: Exception) { /* best effort */ }
        }
    }

    // Poll the result file written by OpenAIOAuthActivity. Tokens are persisted by the
    // activity directly via ConfigManager.saveConfig — we just watch for status here.
    LaunchedEffect(requestId, isPolling) {
        val reqId = requestId ?: return@LaunchedEffect
        if (!isPolling) return@LaunchedEffect
        val resultsDir = File(context.filesDir, OpenAIOAuthActivity.RESULTS_DIR)
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
                        // configVersion bumped by activity's saveConfig — recomposition
                        // will pick up the new token & email automatically.
                        isPolling = false
                        onSignedIn()
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

    val state = OpenAIOAuthState(
        isConnected = config?.openaiOAuthToken?.isNotBlank() == true,
        email = config?.openaiOAuthEmail ?: "",
        isPolling = isPolling,
        error = error,
    )

    return OpenAIOAuthController(
        state = state,
        signIn = {
            val newId = UUID.randomUUID().toString()
            val intent = Intent(context, OpenAIOAuthActivity::class.java).apply {
                putExtra("requestId", newId)
            }
            context.startActivity(intent)
            requestId = newId
            isPolling = true
            error = null
        },
        signOut = {
            ConfigManager.updateConfigField(context, "openaiOAuthToken", "")
            ConfigManager.updateConfigField(context, "openaiOAuthRefresh", "")
            ConfigManager.updateConfigField(context, "openaiOAuthEmail", "")
            ConfigManager.updateConfigField(context, "openaiOAuthExpiresAt", "")
            onSignedOut()
        },
        cancel = {
            isPolling = false
            requestId = null
            error = null
        },
    )
}

/**
 * Visual section for the OpenAI OAuth (Sign in with ChatGPT) flow. Stateless —
 * pass a [state] from [rememberOpenAIOAuthController].
 */
@Composable
fun OpenAIOAuthSection(
    state: OpenAIOAuthState,
    onSignIn: () -> Unit,
    onSignOut: () -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)

    Column(modifier = modifier) {
        // Single inline status line — mirrors the "Get your API key here" style
        // on the API Key tab. Swaps content based on connection state.
        if (state.isConnected) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "Connected as ",
                    fontFamily = RethinkSans,
                    fontSize = 13.sp,
                    color = SeekerClawColors.TextSecondary,
                )
                Text(
                    text = state.email.ifBlank { "your ChatGPT account" },
                    fontFamily = RethinkSans,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.Accent,
                )
            }
        } else {
            Text(
                text = "Uses your ChatGPT subscription.",
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
                        text = "Waiting for authentication\u2026",
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
                        "Sign in with ChatGPT",
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
