package com.seekerclaw.app.ui.settings

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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

private val channels = listOf(
    "telegram" to "Telegram",
    "discord" to "Discord",
)

@Composable
fun DiscordConfigScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    var config by remember { mutableStateOf(ConfigManager.loadConfig(context)) }

    var editField by remember { mutableStateOf<String?>(null) }
    var editLabel by remember { mutableStateOf("") }
    var editValue by remember { mutableStateOf("") }
    var showRestartDialog by remember { mutableStateOf(false) }

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

    SeekerClawScaffold(title = "Messaging Channel", onBack = onBack) { padding ->
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
                channels.forEachIndexed { index, (id, label) ->
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
                        horizontalArrangement = androidx.compose.foundation.layout.Arrangement.SpaceBetween,
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
                    if (index < channels.size - 1) {
                        HorizontalDivider(
                            color = SeekerClawColors.CardBorder,
                            modifier = Modifier.padding(horizontal = 16.dp),
                        )
                    }
                }
            }

            // Discord credentials — only shown when Discord is selected
            if (activeChannel == "discord") {
                Spacer(modifier = Modifier.height(24.dp))
                SectionLabel("Discord Settings")
                Spacer(modifier = Modifier.height(10.dp))

                val discordToken = config?.discordBotToken
                val discordOwnerId = config?.discordOwnerId ?: ""
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
                        value = discordOwnerId.ifBlank { "Not set (optional)" },
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
                saveField(field, editValue.trim())
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
