package com.seekerclaw.app.ui.settings

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
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
import com.seekerclaw.app.ui.theme.SeekerClawThemeStyle
import com.seekerclaw.app.ui.theme.ThemeManager
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private val modelOptions = listOf(
    "claude-sonnet-4-20250514" to "Sonnet 4 (default)",
    "claude-opus-4-5" to "Opus 4.5 (smartest)",
    "claude-haiku-3-5" to "Haiku 3.5 (fast)",
)

@Composable
fun SettingsScreen() {
    val context = LocalContext.current
    var config by remember { mutableStateOf(ConfigManager.loadConfig(context)) }

    var autoStartOnBoot by remember {
        mutableStateOf(ConfigManager.getAutoStartOnBoot(context))
    }
    var showResetDialog by remember { mutableStateOf(false) }
    var showClearMemoryDialog by remember { mutableStateOf(false) }
    var showImportDialog by remember { mutableStateOf(false) }
    var showRestartDialog by remember { mutableStateOf(false) }

    // Edit dialog state
    var editField by remember { mutableStateOf<String?>(null) }
    var editLabel by remember { mutableStateOf("") }
    var editValue by remember { mutableStateOf("") }
    var showModelPicker by remember { mutableStateOf(false) }

    // File picker for export (save ZIP)
    val exportLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.CreateDocument("application/zip")
    ) { uri ->
        if (uri != null) {
            val success = ConfigManager.exportMemory(context, uri)
            Toast.makeText(
                context,
                if (success) "Memory exported successfully" else "Export failed",
                Toast.LENGTH_SHORT
            ).show()
        }
    }

    // File picker for import (open ZIP)
    val importLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenDocument()
    ) { uri ->
        if (uri != null) {
            val success = ConfigManager.importMemory(context, uri)
            Toast.makeText(
                context,
                if (success) "Memory imported. Restart agent to apply." else "Import failed",
                Toast.LENGTH_SHORT
            ).show()
        }
    }

    // Helper to save a field and refresh config
    fun saveField(field: String, value: String) {
        ConfigManager.updateConfigField(context, field, value)
        config = ConfigManager.loadConfig(context)
        showRestartDialog = true
    }

    // Masked display values
    val maskedApiKey = config?.anthropicApiKey?.let { key ->
        if (key.length > 12) "${key.take(8)}${"*".repeat(8)}${key.takeLast(4)}" else "*".repeat(key.length)
    } ?: "---"
    val maskedBotToken = config?.telegramBotToken?.let { token ->
        if (token.length > 10) "${token.take(6)}${"*".repeat(8)}${token.takeLast(4)}" else "*".repeat(token.length)
    } ?: "---"

    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(SeekerClawColors.Background)
            .padding(16.dp)
            .verticalScroll(rememberScrollState()),
    ) {
        Text(
            text = "CONFIG",
            fontFamily = FontFamily.Monospace,
            fontSize = 18.sp,
            fontWeight = FontWeight.Bold,
            color = SeekerClawColors.Primary,
            letterSpacing = 2.sp,
        )

        Spacer(modifier = Modifier.height(24.dp))

        // Config section
        SectionHeader("CONFIGURATION")

        ConfigField(
            label = "API_KEY",
            value = maskedApiKey,
            onClick = {
                editField = "anthropicApiKey"
                editLabel = "API KEY"
                editValue = config?.anthropicApiKey ?: ""
            },
        )
        ConfigField(
            label = "BOT_TOKEN",
            value = maskedBotToken,
            onClick = {
                editField = "telegramBotToken"
                editLabel = "BOT TOKEN"
                editValue = config?.telegramBotToken ?: ""
            },
        )
        ConfigField(
            label = "OWNER_ID",
            value = config?.telegramOwnerId ?: "---",
            onClick = {
                editField = "telegramOwnerId"
                editLabel = "OWNER ID"
                editValue = config?.telegramOwnerId ?: ""
            },
        )
        ConfigField(
            label = "MODEL",
            value = modelOptions.firstOrNull { it.first == config?.model }?.second
                ?: (config?.model ?: "---"),
            onClick = { showModelPicker = true },
        )
        ConfigField(
            label = "AGENT_NAME",
            value = config?.agentName ?: "---",
            onClick = {
                editField = "agentName"
                editLabel = "AGENT NAME"
                editValue = config?.agentName ?: ""
            },
        )

        Spacer(modifier = Modifier.height(24.dp))

        // Appearance section
        SectionHeader("APPEARANCE")

        ThemeSelector()

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
                .border(1.dp, SeekerClawColors.PrimaryDim.copy(alpha = 0.4f), shape),
            shape = shape,
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

        // Memory backup section
        SectionHeader("DATA BACKUP")

        OutlinedButton(
            onClick = {
                val timestamp = SimpleDateFormat("yyyyMMdd_HHmm", Locale.US).format(Date())
                exportLauncher.launch("seekerclaw_backup_$timestamp.zip")
            },
            modifier = Modifier
                .fillMaxWidth()
                .border(1.dp, SeekerClawColors.Primary.copy(alpha = 0.5f), shape),
            shape = shape,
            colors = ButtonDefaults.outlinedButtonColors(
                contentColor = SeekerClawColors.Primary,
            ),
        ) {
            Text(
                "[ EXPORT MEMORY ]",
                fontFamily = FontFamily.Monospace,
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.sp,
            )
        }

        Spacer(modifier = Modifier.height(8.dp))

        OutlinedButton(
            onClick = { showImportDialog = true },
            modifier = Modifier
                .fillMaxWidth()
                .border(1.dp, SeekerClawColors.Warning.copy(alpha = 0.5f), shape),
            shape = shape,
            colors = ButtonDefaults.outlinedButtonColors(
                contentColor = SeekerClawColors.Warning,
            ),
        ) {
            Text(
                "[ IMPORT MEMORY ]",
                fontFamily = FontFamily.Monospace,
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
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
                .border(1.dp, SeekerClawColors.ErrorDim, shape),
            shape = shape,
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
                .border(1.dp, SeekerClawColors.ErrorDim, shape),
            shape = shape,
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

    // ==================== Edit Field Dialog ====================
    if (editField != null) {
        AlertDialog(
            onDismissRequest = { editField = null },
            title = {
                Text(
                    "EDIT $editLabel",
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.Primary,
                )
            },
            text = {
                Column {
                    if (editField == "anthropicApiKey" || editField == "telegramBotToken") {
                        Text(
                            "CHANGING THIS REQUIRES AN AGENT RESTART.",
                            fontFamily = FontFamily.Monospace,
                            fontSize = 11.sp,
                            color = SeekerClawColors.Warning,
                            modifier = Modifier.padding(bottom = 12.dp),
                        )
                    }
                    OutlinedTextField(
                        value = editValue,
                        onValueChange = { editValue = it },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = editField != "anthropicApiKey",
                        textStyle = androidx.compose.ui.text.TextStyle(
                            fontFamily = FontFamily.Monospace,
                            fontSize = 13.sp,
                            color = SeekerClawColors.TextPrimary,
                        ),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = SeekerClawColors.Primary,
                            unfocusedBorderColor = SeekerClawColors.PrimaryDim.copy(alpha = 0.4f),
                            cursorColor = SeekerClawColors.Primary,
                        ),
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        val field = editField ?: return@TextButton
                        val trimmed = editValue.trim()
                        if (trimmed.isNotEmpty()) {
                            saveField(field, trimmed)
                        }
                        editField = null
                    },
                ) {
                    Text(
                        "[ SAVE ]",
                        fontFamily = FontFamily.Monospace,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Primary,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { editField = null }) {
                    Text(
                        "[ CANCEL ]",
                        fontFamily = FontFamily.Monospace,
                        color = SeekerClawColors.TextDim,
                    )
                }
            },
            containerColor = SeekerClawColors.Surface,
            shape = RoundedCornerShape(SeekerClawColors.CornerRadius),
        )
    }

    // ==================== Model Picker Dialog ====================
    if (showModelPicker) {
        var selectedModel by remember { mutableStateOf(config?.model ?: modelOptions[0].first) }

        AlertDialog(
            onDismissRequest = { showModelPicker = false },
            title = {
                Text(
                    "SELECT MODEL",
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.Primary,
                )
            },
            text = {
                Column {
                    modelOptions.forEach { (modelId, label) ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { selectedModel = modelId }
                                .padding(vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(
                                selected = selectedModel == modelId,
                                onClick = { selectedModel = modelId },
                                colors = RadioButtonDefaults.colors(
                                    selectedColor = SeekerClawColors.Primary,
                                    unselectedColor = SeekerClawColors.TextDim,
                                ),
                            )
                            Column(modifier = Modifier.padding(start = 8.dp)) {
                                Text(
                                    text = label,
                                    fontFamily = FontFamily.Monospace,
                                    fontSize = 13.sp,
                                    color = SeekerClawColors.TextPrimary,
                                )
                                Text(
                                    text = modelId,
                                    fontFamily = FontFamily.Monospace,
                                    fontSize = 10.sp,
                                    color = SeekerClawColors.TextDim,
                                )
                            }
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        saveField("model", selectedModel)
                        showModelPicker = false
                    },
                ) {
                    Text(
                        "[ SAVE ]",
                        fontFamily = FontFamily.Monospace,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Primary,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showModelPicker = false }) {
                    Text(
                        "[ CANCEL ]",
                        fontFamily = FontFamily.Monospace,
                        color = SeekerClawColors.TextDim,
                    )
                }
            },
            containerColor = SeekerClawColors.Surface,
            shape = RoundedCornerShape(SeekerClawColors.CornerRadius),
        )
    }

    // ==================== Restart Prompt ====================
    if (showRestartDialog) {
        AlertDialog(
            onDismissRequest = { showRestartDialog = false },
            title = {
                Text(
                    "CONFIG UPDATED",
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.Primary,
                )
            },
            text = {
                Text(
                    "RESTART THE AGENT TO APPLY CHANGES?",
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    color = SeekerClawColors.TextSecondary,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    OpenClawService.stop(context)
                    OpenClawService.start(context)
                    showRestartDialog = false
                    Toast.makeText(context, "Agent restarting...", Toast.LENGTH_SHORT).show()
                }) {
                    Text(
                        "[ RESTART NOW ]",
                        fontFamily = FontFamily.Monospace,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Primary,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showRestartDialog = false }) {
                    Text(
                        "[ LATER ]",
                        fontFamily = FontFamily.Monospace,
                        color = SeekerClawColors.TextDim,
                    )
                }
            },
            containerColor = SeekerClawColors.Surface,
            shape = RoundedCornerShape(SeekerClawColors.CornerRadius),
        )
    }

    // ==================== Reset Config Dialog ====================
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
            shape = RoundedCornerShape(SeekerClawColors.CornerRadius),
        )
    }

    // ==================== Import Dialog ====================
    if (showImportDialog) {
        AlertDialog(
            onDismissRequest = { showImportDialog = false },
            title = {
                Text(
                    "IMPORT MEMORY",
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.Warning,
                )
            },
            text = {
                Text(
                    "THIS WILL OVERWRITE CURRENT MEMORY FILES WITH THE BACKUP. EXISTING SOUL.MD, MEMORY.MD, AND DAILY FILES WILL BE REPLACED. EXPORT FIRST IF YOU WANT TO KEEP CURRENT DATA.",
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    color = SeekerClawColors.TextSecondary,
                    lineHeight = 18.sp,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    showImportDialog = false
                    importLauncher.launch(arrayOf("application/zip"))
                }) {
                    Text(
                        "[ SELECT FILE ]",
                        fontFamily = FontFamily.Monospace,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Warning,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showImportDialog = false }) {
                    Text(
                        "[ ABORT ]",
                        fontFamily = FontFamily.Monospace,
                        color = SeekerClawColors.TextDim,
                    )
                }
            },
            containerColor = SeekerClawColors.Surface,
            shape = RoundedCornerShape(SeekerClawColors.CornerRadius),
        )
    }

    // ==================== Clear Memory Dialog ====================
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
            shape = RoundedCornerShape(SeekerClawColors.CornerRadius),
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
            .background(SeekerClawColors.Surface, RoundedCornerShape(SeekerClawColors.CornerRadius))
            .border(1.dp, SeekerClawColors.PrimaryDim.copy(alpha = 0.2f), RoundedCornerShape(SeekerClawColors.CornerRadius))
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(12.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = label,
                fontFamily = FontFamily.Monospace,
                fontSize = 10.sp,
                color = SeekerClawColors.TextDim,
                letterSpacing = 1.sp,
            )
            if (onClick != null) {
                Text(
                    text = "EDIT",
                    fontFamily = FontFamily.Monospace,
                    fontSize = 9.sp,
                    color = SeekerClawColors.Primary.copy(alpha = 0.6f),
                    letterSpacing = 1.sp,
                )
            }
        }
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
                checkedThumbColor = SeekerClawColors.Accent,
                checkedTrackColor = SeekerClawColors.Accent.copy(alpha = 0.3f),
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

@Composable
private fun ThemeSelector() {
    val currentTheme = ThemeManager.currentStyle

    Column(
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(
            text = "THEME",
            fontFamily = FontFamily.Monospace,
            fontSize = 10.sp,
            color = SeekerClawColors.TextDim,
            letterSpacing = 1.sp,
            modifier = Modifier.padding(bottom = 8.dp),
        )

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            SeekerClawThemeStyle.entries.forEach { style ->
                val isSelected = style == currentTheme
                Button(
                    onClick = { ThemeManager.setTheme(style) },
                    modifier = Modifier
                        .weight(1f)
                        .border(
                            width = if (isSelected) 2.dp else 1.dp,
                            color = if (isSelected) SeekerClawColors.Primary else SeekerClawColors.PrimaryDim.copy(alpha = 0.4f),
                            shape = RoundedCornerShape(SeekerClawColors.CornerRadius),
                        ),
                    shape = RoundedCornerShape(SeekerClawColors.CornerRadius),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = if (isSelected) SeekerClawColors.PrimaryGlow else SeekerClawColors.Surface,
                        contentColor = if (isSelected) SeekerClawColors.Primary else SeekerClawColors.TextSecondary,
                    ),
                ) {
                    Text(
                        text = style.displayName.uppercase(),
                        fontFamily = FontFamily.Monospace,
                        fontSize = 11.sp,
                        fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal,
                        letterSpacing = 1.sp,
                    )
                }
            }
        }
    }
}
