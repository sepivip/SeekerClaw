package com.seekerclaw.app.ui.settings

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.ui.components.CardSurface
import com.seekerclaw.app.ui.components.ConfigField
import com.seekerclaw.app.ui.components.SectionLabel
import com.seekerclaw.app.ui.components.SeekerClawScaffold
import com.seekerclaw.app.ui.theme.RethinkSans
import com.seekerclaw.app.ui.theme.SeekerClawColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private val channelOptions = listOf(
    "telegram" to "Telegram",
    "discord" to "Discord",
)

@Composable
fun ChannelConfigScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    // Poll owner IDs directly from file every 2s (cross-process safe).
    // This is the ONLY source of truth for owner IDs — not config object.
    var telegramOwnerId by remember { mutableStateOf(ConfigManager.loadOwnerIdFromFile(context, "telegram")) }
    var discordOwnerId by remember { mutableStateOf(ConfigManager.loadOwnerIdFromFile(context, "discord")) }
    var config by remember { mutableStateOf(ConfigManager.loadConfig(context)) }

    LaunchedEffect(Unit) {
        while (true) {
            kotlinx.coroutines.delay(2000)
            telegramOwnerId = ConfigManager.loadOwnerIdFromFile(context, "telegram")
            discordOwnerId = ConfigManager.loadOwnerIdFromFile(context, "discord")
        }
    }

    // Reload full config on in-process changes (local edits)
    val configVer by ConfigManager.configVersion
    LaunchedEffect(configVer) {
        config = ConfigManager.loadConfig(context)
    }

    var editField by remember { mutableStateOf<String?>(null) }
    var editLabel by remember { mutableStateOf("") }
    var editValue by remember { mutableStateOf("") }
    var showRestartDialog by remember { mutableStateOf(false) }

    // Telegram connection test state
    var testStatus by remember { mutableStateOf("Idle") }
    var testMessage by remember { mutableStateOf("") }

    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)
    val activeChannel = config?.channel ?: "telegram"

    fun maskKey(key: String?): String {
        if (key.isNullOrBlank()) return "Not set"
        if (key.length <= 8) return "*".repeat(key.length)
        return "${key.take(6)}${"*".repeat(8)}${key.takeLast(4)}"
    }

    fun saveField(field: String, value: String) {
        ConfigManager.updateConfigField(context, field, value)
        config = ConfigManager.loadConfig(context)
        showRestartDialog = true
    }

    SeekerClawScaffold(title = "Channel", onBack = onBack) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 20.dp, vertical = 8.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            // Channel selector
            SectionLabel("Channel")
            Spacer(modifier = Modifier.height(10.dp))

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SeekerClawColors.Surface, shape),
            ) {
                channelOptions.forEachIndexed { index, (id, label) ->
                    val isActive = id == activeChannel
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable {
                                if (!isActive) {
                                    saveField("channel", id)
                                }
                            }
                            .padding(horizontal = 16.dp, vertical = 14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Column {
                            Text(
                                text = label,
                                fontFamily = RethinkSans,
                                fontSize = 14.sp,
                                fontWeight = if (isActive) FontWeight.Bold else FontWeight.Normal,
                                color = SeekerClawColors.TextPrimary,
                            )
                        }
                        if (isActive) {
                            Text(
                                text = "Active",
                                fontFamily = RethinkSans,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Medium,
                                color = SeekerClawColors.Accent,
                            )
                        }
                    }
                    if (index < channelOptions.size - 1) {
                        HorizontalDivider(
                            color = SeekerClawColors.CardBorder,
                            modifier = Modifier.padding(horizontal = 16.dp),
                        )
                    }
                }
            }

            // Active channel settings
            when (activeChannel) {
                "telegram" -> {
                    Spacer(modifier = Modifier.height(24.dp))
                    SectionLabel("Telegram Settings")
                    Spacer(modifier = Modifier.height(10.dp))

                    val maskedBotToken = config?.telegramBotToken?.let { token ->
                        if (token.isBlank()) "Not set"
                        else if (token.length > 20) "${token.take(8)}${"*".repeat(8)}${token.takeLast(4)}" else "*".repeat(token.length)
                    } ?: "Not set"

                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(SeekerClawColors.Surface, shape),
                    ) {
                        ConfigField(
                            label = "Bot Token",
                            value = maskedBotToken,
                            onClick = {
                                editField = "telegramBotToken"
                                editLabel = "Bot Token"
                                editValue = config?.telegramBotToken ?: ""
                            },
                            info = SettingsHelpTexts.BOT_TOKEN,
                            isRequired = true,
                        )
                        ConfigField(
                            label = "Owner ID",
                            value = telegramOwnerId.ifBlank { "Auto-detect" },
                            onClick = {
                                editField = "telegramOwnerId"
                                editLabel = "Owner ID"
                                editValue = telegramOwnerId
                            },
                            info = SettingsHelpTexts.OWNER_ID,
                            showDivider = false,
                        )
                    }

                    // Connection test
                    Spacer(modifier = Modifier.height(24.dp))
                    SectionLabel("Connection Test")
                    Spacer(modifier = Modifier.height(10.dp))

                    CardSurface {
                        Text(
                            text = "Verify your bot token is valid and Telegram is reachable.",
                            fontFamily = RethinkSans,
                            fontSize = 13.sp,
                            color = SeekerClawColors.TextDim,
                        )
                        Spacer(modifier = Modifier.height(12.dp))

                        Button(
                            onClick = {
                                if (testStatus == "Loading") return@Button
                                testStatus = "Loading"
                                testMessage = ""
                                val token = config?.telegramBotToken ?: ""
                                if (token.isBlank()) {
                                    testStatus = "Error"
                                    testMessage = "Bot token is empty."
                                    return@Button
                                }

                                scope.launch {
                                    val result = testTelegramBot(token)
                                    if (result.isSuccess) {
                                        testStatus = "Success"
                                        testMessage = "Bot connected as @${result.getOrNull()}"
                                    } else {
                                        testStatus = "Error"
                                        testMessage = result.exceptionOrNull()?.message ?: "Connection failed"
                                    }
                                }
                            },
                            enabled = testStatus != "Loading",
                            modifier = Modifier.fillMaxWidth(),
                            shape = shape,
                            colors = ButtonDefaults.buttonColors(
                                containerColor = SeekerClawColors.ActionPrimary,
                                contentColor = Color.White,
                            ),
                        ) {
                            if (testStatus == "Loading") {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(16.dp),
                                    strokeWidth = 2.dp,
                                    color = Color.White,
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                                Text("Testing...", fontFamily = RethinkSans, fontSize = 14.sp)
                            } else {
                                Text("Test Bot", fontFamily = RethinkSans, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                            }
                        }

                        if (testStatus == "Success" || testStatus == "Error") {
                            Spacer(modifier = Modifier.height(12.dp))
                            Text(
                                text = testMessage,
                                fontFamily = RethinkSans,
                                fontSize = 13.sp,
                                color = if (testStatus == "Success") SeekerClawColors.ActionPrimary else SeekerClawColors.Error,
                            )
                        }
                    }
                }

                "discord" -> {
                    Spacer(modifier = Modifier.height(24.dp))
                    SectionLabel("Discord Settings")
                    Spacer(modifier = Modifier.height(10.dp))

                    val discordToken = config?.discordBotToken
                    val isTokenMissing = discordToken.isNullOrBlank()

                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(SeekerClawColors.Surface, shape),
                    ) {
                        ConfigField(
                            label = "Bot Token",
                            value = maskKey(discordToken),
                            onClick = {
                                editField = "discordBotToken"
                                editLabel = "Discord Bot Token"
                                editValue = discordToken ?: ""
                            },
                            info = SettingsHelpTexts.DISCORD_BOT_TOKEN,
                            isRequired = isTokenMissing,
                        )
                        ConfigField(
                            label = "Owner ID",
                            value = discordOwnerId.ifBlank { "Auto-detect" },
                            onClick = {
                                editField = "discordOwnerId"
                                editLabel = "Discord Owner ID"
                                editValue = discordOwnerId
                            },
                            info = SettingsHelpTexts.DISCORD_OWNER_ID,
                            showDivider = false,
                        )
                    }

                    if (isTokenMissing) {
                        Spacer(modifier = Modifier.height(8.dp))
                        Text(
                            text = "Bot token required — Discord channel will not work without it.",
                            fontFamily = RethinkSans,
                            fontSize = 12.sp,
                            color = SeekerClawColors.Error,
                        )
                    }

                    // Connection Test (same pattern as Telegram)
                    if (!isTokenMissing) {
                        Spacer(modifier = Modifier.height(24.dp))
                        SectionLabel("Connection Test")
                        Spacer(modifier = Modifier.height(10.dp))

                        var discordTestStatus by remember { mutableStateOf("") }
                        var discordTestMessage by remember { mutableStateOf("") }

                        CardSurface {
                            Text(
                                text = "Verify your bot token is valid and Discord is reachable.",
                                fontFamily = RethinkSans,
                                fontSize = 13.sp,
                                color = SeekerClawColors.TextDim,
                            )
                            Spacer(modifier = Modifier.height(12.dp))

                            Button(
                                onClick = {
                                    if (discordTestStatus == "Loading") return@Button
                                    discordTestStatus = "Loading"
                                    discordTestMessage = ""

                                    scope.launch {
                                        val result = testDiscordBot(discordToken!!)
                                        if (result.isSuccess) {
                                            discordTestStatus = "Success"
                                            discordTestMessage = "Bot connected as @${result.getOrNull()}"
                                        } else {
                                            discordTestStatus = "Error"
                                            discordTestMessage = result.exceptionOrNull()?.message ?: "Connection failed"
                                        }
                                    }
                                },
                                enabled = discordTestStatus != "Loading",
                                modifier = Modifier.fillMaxWidth(),
                                shape = shape,
                                colors = ButtonDefaults.buttonColors(
                                    containerColor = SeekerClawColors.ActionPrimary,
                                    contentColor = Color.White,
                                ),
                            ) {
                                if (discordTestStatus == "Loading") {
                                    CircularProgressIndicator(
                                        modifier = Modifier.size(16.dp),
                                        strokeWidth = 2.dp,
                                        color = Color.White,
                                    )
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Text("Testing...", fontFamily = RethinkSans, fontSize = 14.sp)
                                } else {
                                    Text("Test Bot", fontFamily = RethinkSans, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                                }
                            }

                            if (discordTestStatus == "Success" || discordTestStatus == "Error") {
                                Spacer(modifier = Modifier.height(12.dp))
                                Text(
                                    text = discordTestMessage,
                                    fontFamily = RethinkSans,
                                    fontSize = 13.sp,
                                    color = if (discordTestStatus == "Success") SeekerClawColors.ActionPrimary else SeekerClawColors.Error,
                                )
                            }
                        }
                    }

                    Spacer(modifier = Modifier.height(24.dp))
                    SectionLabel("Resources")
                    Spacer(modifier = Modifier.height(10.dp))

                    CardSurface {
                        Text(
                            text = SettingsHelpTexts.DISCORD_BOT_TOKEN,
                            fontFamily = RethinkSans,
                            fontSize = 13.sp,
                            color = SeekerClawColors.TextDim,
                        )
                        Spacer(modifier = Modifier.height(12.dp))
                        Text(
                            text = "Discord Developer Portal \u2192",
                            fontFamily = RethinkSans,
                            fontSize = 14.sp,
                            fontWeight = FontWeight.Bold,
                            color = SeekerClawColors.TextInteractive,
                            modifier = Modifier.clickable {
                                val intent = Intent(
                                    Intent.ACTION_VIEW,
                                    Uri.parse("https://discord.com/developers/applications"),
                                )
                                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                context.startActivity(intent)
                            },
                        )
                    }
                }
            }

            Spacer(modifier = Modifier.height(20.dp))
        }
    }

    // Edit dialog
    if (editField != null) {
        ProviderEditDialog(
            editField = editField,
            editLabel = editLabel,
            editValue = editValue,
            onValueChange = { editValue = it },
            onSave = {
                val field = editField ?: return@ProviderEditDialog
                val trimmed = editValue.trim()
                if (trimmed.isNotEmpty()) {
                    saveField(field, trimmed)
                } else if (field == "telegramOwnerId" || field == "discordOwnerId") {
                    // Allow clearing Owner ID to fallback to Auto-detect
                    saveField(field, trimmed)
                }
                editField = null
            },
            onDismiss = { editField = null },
        )
    }

    // Restart dialog
    if (showRestartDialog) {
        RestartDialog(
            context = context,
            onDismiss = { showRestartDialog = false },
        )
    }
}

/**
 * Test Discord bot token by calling GET /users/@me.
 * Returns the bot's username on success.
 */
internal suspend fun testDiscordBot(token: String): Result<String> = withContext(Dispatchers.IO) {
    runCatching {
        val url = java.net.URL("https://discord.com/api/v10/users/@me")
        val conn = url.openConnection() as java.net.HttpURLConnection
        conn.requestMethod = "GET"
        conn.setRequestProperty("Authorization", "Bot $token")
        conn.setRequestProperty("User-Agent", "SeekerClaw (https://seekerclaw.xyz, 1.0)")
        conn.connectTimeout = 15000
        conn.readTimeout = 15000

        try {
            val status = conn.responseCode
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val responseText = stream?.bufferedReader()?.use { it.readText() } ?: ""

            if (status in 200..299) {
                val json = org.json.JSONObject(responseText)
                val username = json.optString("username", "")
                if (username.isNotBlank()) {
                    return@runCatching username
                } else {
                    error("No username in response")
                }
            } else {
                var errorMessage = "HTTP $status"
                try {
                    val json = org.json.JSONObject(responseText)
                    if (json.has("message")) {
                        errorMessage += ": ${json.getString("message")}"
                    }
                } catch (_: Exception) {}
                error(errorMessage)
            }
        } finally {
            conn.disconnect()
        }
    }
}
