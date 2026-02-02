package com.seekerclaw.app.ui.settings

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.service.OpenClawService
import com.seekerclaw.app.ui.theme.SeekerClawColors

@Composable
fun SettingsScreen() {
    val context = LocalContext.current
    val config = ConfigManager.loadConfig(context)

    var autoStartOnBoot by remember {
        mutableStateOf(ConfigManager.getAutoStartOnBoot(context))
    }
    var showResetDialog by remember { mutableStateOf(false) }
    var showClearMemoryDialog by remember { mutableStateOf(false) }

    // Masked display values
    val maskedApiKey = config?.anthropicApiKey?.let { key ->
        if (key.length > 12) "${key.take(8)}${"*".repeat(8)}${key.takeLast(4)}" else "*".repeat(key.length)
    } ?: "---"
    val maskedBotToken = config?.telegramBotToken?.let { token ->
        if (token.length > 10) "${token.take(6)}${"*".repeat(8)}${token.takeLast(4)}" else "*".repeat(token.length)
    } ?: "---"

    // Tap-to-reveal state
    var revealApiKey by remember { mutableStateOf(false) }
    var revealBotToken by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(SeekerClawColors.Background)
            .padding(24.dp)
            .verticalScroll(rememberScrollState()),
    ) {
        Text(
            text = "> SETTINGS",
            fontFamily = FontFamily.Monospace,
            fontSize = 20.sp,
            fontWeight = FontWeight.Bold,
            color = SeekerClawColors.Primary,
            letterSpacing = 2.sp,
        )
        Text(
            text = "================================",
            fontFamily = FontFamily.Monospace,
            fontSize = 14.sp,
            color = SeekerClawColors.PrimaryDim,
        )

        Spacer(modifier = Modifier.height(24.dp))

        // Config section
        SectionHeader("CONFIGURATION")

        ConfigField(
            label = "API_KEY",
            value = if (revealApiKey) (config?.anthropicApiKey ?: "---") else maskedApiKey,
            onClick = { revealApiKey = !revealApiKey },
        )
        ConfigField(
            label = "BOT_TOKEN",
            value = if (revealBotToken) (config?.telegramBotToken ?: "---") else maskedBotToken,
            onClick = { revealBotToken = !revealBotToken },
        )
        ConfigField(
            label = "OWNER_ID",
            value = config?.telegramOwnerId ?: "---",
        )
        ConfigField(
            label = "MODEL",
            value = config?.model ?: "claude-sonnet-4-20250514",
        )
        ConfigField(
            label = "AGENT_NAME",
            value = config?.agentName ?: "MyAgent",
        )

        Spacer(modifier = Modifier.height(24.dp))

        // Preferences section
        SectionHeader("PREFERENCES")

        SettingRow(
            label = "AUTO_START_ON_BOOT",
            checked = autoStartOnBoot,
            onCheckedChange = {
                autoStartOnBoot = it
                ConfigManager.setAutoStartOnBoot(context, it)
            },
        )

        Spacer(modifier = Modifier.height(8.dp))

        OutlinedButton(
            onClick = {
                val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:${context.packageName}")
                }
                context.startActivity(intent)
            },
            modifier = Modifier
                .fillMaxWidth()
                .border(1.dp, SeekerClawColors.PrimaryDim.copy(alpha = 0.4f), RoundedCornerShape(2.dp)),
            shape = RoundedCornerShape(2.dp),
            colors = ButtonDefaults.outlinedButtonColors(
                contentColor = SeekerClawColors.TextPrimary,
            ),
        ) {
            Text(
                "[ BATTERY OPTIMIZATION ]",
                fontFamily = FontFamily.Monospace,
                fontSize = 13.sp,
                letterSpacing = 1.sp,
            )
        }

        Spacer(modifier = Modifier.height(32.dp))

        // Danger zone
        SectionHeader("!! DANGER ZONE !!")

        Button(
            onClick = { showResetDialog = true },
            modifier = Modifier
                .fillMaxWidth()
                .border(1.dp, SeekerClawColors.ErrorDim, RoundedCornerShape(2.dp)),
            shape = RoundedCornerShape(2.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = SeekerClawColors.ErrorGlow,
                contentColor = SeekerClawColors.Error,
            ),
        ) {
            Text(
                "[ RESET CONFIG ]",
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.sp,
            )
        }

        Spacer(modifier = Modifier.height(8.dp))

        Button(
            onClick = { showClearMemoryDialog = true },
            modifier = Modifier
                .fillMaxWidth()
                .border(1.dp, SeekerClawColors.ErrorDim, RoundedCornerShape(2.dp)),
            shape = RoundedCornerShape(2.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = SeekerClawColors.ErrorGlow,
                contentColor = SeekerClawColors.Error,
            ),
        ) {
            Text(
                "[ WIPE MEMORY ]",
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.sp,
            )
        }

        Spacer(modifier = Modifier.height(32.dp))

        // About section
        SectionHeader("SYSTEM INFO")

        AboutRow("VERSION", "1.0.0")
        AboutRow("OPENCLAW", "---")
        AboutRow("NODE.JS", "18 LTS")

        Spacer(modifier = Modifier.height(24.dp))
    }

    // Reset confirmation dialog
    if (showResetDialog) {
        AlertDialog(
            onDismissRequest = { showResetDialog = false },
            title = {
                Text(
                    "!! RESET CONFIG !!",
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.Error,
                )
            },
            text = {
                Text(
                    "THIS WILL TERMINATE THE AGENT, PURGE ALL CONFIG DATA, AND RETURN TO SETUP. THIS OPERATION IS IRREVERSIBLE.",
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    color = SeekerClawColors.TextSecondary,
                    lineHeight = 18.sp,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    OpenClawService.stop(context)
                    ConfigManager.clearConfig(context)
                    showResetDialog = false
                }) {
                    Text(
                        "[ CONFIRM ]",
                        fontFamily = FontFamily.Monospace,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showResetDialog = false }) {
                    Text(
                        "[ ABORT ]",
                        fontFamily = FontFamily.Monospace,
                        color = SeekerClawColors.TextDim,
                    )
                }
            },
            containerColor = SeekerClawColors.Surface,
            shape = RoundedCornerShape(4.dp),
        )
    }

    // Clear memory confirmation dialog
    if (showClearMemoryDialog) {
        AlertDialog(
            onDismissRequest = { showClearMemoryDialog = false },
            title = {
                Text(
                    "!! WIPE MEMORY !!",
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.Error,
                )
            },
            text = {
                Text(
                    "THIS WILL DELETE MEMORY.MD AND ALL DAILY MEMORY FILES. THE AGENT WILL LOSE ALL ACCUMULATED KNOWLEDGE. IRREVERSIBLE.",
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    color = SeekerClawColors.TextSecondary,
                    lineHeight = 18.sp,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    ConfigManager.clearMemory(context)
                    showClearMemoryDialog = false
                }) {
                    Text(
                        "[ CONFIRM ]",
                        fontFamily = FontFamily.Monospace,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showClearMemoryDialog = false }) {
                    Text(
                        "[ ABORT ]",
                        fontFamily = FontFamily.Monospace,
                        color = SeekerClawColors.TextDim,
                    )
                }
            },
            containerColor = SeekerClawColors.Surface,
            shape = RoundedCornerShape(4.dp),
        )
    }
}

@Composable
private fun SectionHeader(title: String) {
    Text(
        text = "--- $title ---",
        fontFamily = FontFamily.Monospace,
        fontSize = 12.sp,
        fontWeight = FontWeight.Bold,
        color = SeekerClawColors.Accent,
        letterSpacing = 1.sp,
        modifier = Modifier.padding(bottom = 8.dp),
    )
}

@Composable
private fun ConfigField(label: String, value: String, onClick: (() -> Unit)? = null) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
            .background(SeekerClawColors.Surface, RoundedCornerShape(2.dp))
            .border(1.dp, SeekerClawColors.PrimaryDim.copy(alpha = 0.2f), RoundedCornerShape(2.dp))
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(12.dp),
    ) {
        Text(
            text = label,
            fontFamily = FontFamily.Monospace,
            fontSize = 10.sp,
            color = SeekerClawColors.TextDim,
            letterSpacing = 1.sp,
        )
        Text(
            text = value,
            fontFamily = FontFamily.Monospace,
            fontSize = 13.sp,
            color = SeekerClawColors.TextPrimary,
        )
    }
}

@Composable
private fun SettingRow(label: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            fontFamily = FontFamily.Monospace,
            fontSize = 13.sp,
            color = SeekerClawColors.TextPrimary,
            letterSpacing = 1.sp,
        )
        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
            colors = SwitchDefaults.colors(
                checkedThumbColor = SeekerClawColors.Primary,
                checkedTrackColor = SeekerClawColors.PrimaryGlow,
                uncheckedThumbColor = SeekerClawColors.TextDim,
                uncheckedTrackColor = SeekerClawColors.Surface,
                uncheckedBorderColor = SeekerClawColors.PrimaryDim.copy(alpha = 0.3f),
            ),
        )
    }
}

@Composable
private fun AboutRow(label: String, value: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            text = label,
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
            color = SeekerClawColors.TextDim,
            letterSpacing = 1.sp,
        )
        Text(
            text = value,
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
            color = SeekerClawColors.TextPrimary,
        )
    }
}
