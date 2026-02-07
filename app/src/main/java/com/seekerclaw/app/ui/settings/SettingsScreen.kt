package com.seekerclaw.app.ui.settings

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import android.widget.Toast
import androidx.activity.compose.ManagedActivityResultLauncher
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
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
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
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
    "claude-opus-4-6" to "Opus 4.6 (default)",
    "claude-sonnet-4-5-20250929" to "Sonnet 4.5 (balanced)",
    "claude-haiku-4-5-20251001" to "Haiku 4.5 (fast)",
)

@Composable
fun SettingsScreen() {
    val context = LocalContext.current
    var config by remember { mutableStateOf(ConfigManager.loadConfig(context)) }

    var autoStartOnBoot by remember {
        mutableStateOf(ConfigManager.getAutoStartOnBoot(context))
    }

    // Battery optimization state — refresh when returning from system settings
    val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
    var batteryOptimizationDisabled by remember {
        mutableStateOf(powerManager.isIgnoringBatteryOptimizations(context.packageName))
    }

    // Permission states
    var hasLocationPermission by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED)
    }
    var hasContactsPermission by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED)
    }
    var hasSmsPermission by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED)
    }
    var hasCallPermission by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED)
    }

    val locationLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { hasLocationPermission = it }
    val contactsLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { hasContactsPermission = it }
    val smsLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { hasSmsPermission = it }
    val callLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { hasCallPermission = it }

    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                batteryOptimizationDisabled = powerManager.isIgnoringBatteryOptimizations(context.packageName)
                hasLocationPermission = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                hasContactsPermission = ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED
                hasSmsPermission = ContextCompat.checkSelfPermission(context, Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED
                hasCallPermission = ContextCompat.checkSelfPermission(context, Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    var showResetDialog by remember { mutableStateOf(false) }
    var showClearMemoryDialog by remember { mutableStateOf(false) }
    var showImportDialog by remember { mutableStateOf(false) }
    var showRestartDialog by remember { mutableStateOf(false) }

    var editField by remember { mutableStateOf<String?>(null) }
    var editLabel by remember { mutableStateOf("") }
    var editValue by remember { mutableStateOf("") }
    var showModelPicker by remember { mutableStateOf(false) }

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

    fun saveField(field: String, value: String) {
        ConfigManager.updateConfigField(context, field, value)
        config = ConfigManager.loadConfig(context)
        showRestartDialog = true
    }

    val authTypeLabel = if (config?.authType == "setup_token") "Setup Token" else "API Key"
    val maskedApiKey = config?.anthropicApiKey?.let { key ->
        if (key.length > 12) "${key.take(8)}${"*".repeat(8)}${key.takeLast(4)}" else "*".repeat(key.length)
    } ?: "Not set"
    val maskedBotToken = config?.telegramBotToken?.let { token ->
        if (token.length > 10) "${token.take(6)}${"*".repeat(8)}${token.takeLast(4)}" else "*".repeat(token.length)
    } ?: "Not set"

    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(SeekerClawColors.Background)
            .padding(20.dp)
            .verticalScroll(rememberScrollState()),
    ) {
        Text(
            text = "Settings",
            fontFamily = FontFamily.Monospace,
            fontSize = 20.sp,
            fontWeight = FontWeight.Bold,
            color = SeekerClawColors.TextPrimary,
        )

        Spacer(modifier = Modifier.height(28.dp))

        // Configuration
        SectionLabel("CONFIGURATION")

        Spacer(modifier = Modifier.height(10.dp))

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(SeekerClawColors.Surface, shape),
        ) {
            ConfigField(
                label = authTypeLabel,
                value = maskedApiKey,
                onClick = {
                    editField = "anthropicApiKey"
                    editLabel = authTypeLabel
                    editValue = config?.anthropicApiKey ?: ""
                },
            )
            ConfigField(
                label = "Bot Token",
                value = maskedBotToken,
                onClick = {
                    editField = "telegramBotToken"
                    editLabel = "Bot Token"
                    editValue = config?.telegramBotToken ?: ""
                },
            )
            ConfigField(
                label = "Owner ID",
                value = config?.telegramOwnerId?.ifBlank { "Auto-detect" } ?: "Auto-detect",
                onClick = {
                    editField = "telegramOwnerId"
                    editLabel = "Owner ID"
                    editValue = config?.telegramOwnerId ?: ""
                },
            )
            ConfigField(
                label = "Model",
                value = modelOptions.firstOrNull { it.first == config?.model }?.second
                    ?: (config?.model ?: "Not set"),
                onClick = { showModelPicker = true },
            )
            ConfigField(
                label = "Agent Name",
                value = config?.agentName ?: "SeekerClaw",
                onClick = {
                    editField = "agentName"
                    editLabel = "Agent Name"
                    editValue = config?.agentName ?: ""
                },
                showDivider = false,
            )
        }

        Spacer(modifier = Modifier.height(28.dp))

        // Appearance
        SectionLabel("APPEARANCE")

        Spacer(modifier = Modifier.height(10.dp))

        ThemeSelector()

        Spacer(modifier = Modifier.height(28.dp))

        // Preferences
        SectionLabel("PREFERENCES")

        Spacer(modifier = Modifier.height(10.dp))

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(SeekerClawColors.Surface, shape)
                .padding(horizontal = 16.dp),
        ) {
            SettingRow(
                label = "Auto-start on boot",
                checked = autoStartOnBoot,
                onCheckedChange = {
                    autoStartOnBoot = it
                    ConfigManager.setAutoStartOnBoot(context, it)
                },
            )
            SettingRow(
                label = "Battery unrestricted",
                checked = batteryOptimizationDisabled,
                onCheckedChange = {
                    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                        data = Uri.parse("package:${context.packageName}")
                    }
                    context.startActivity(intent)
                },
            )
        }

        Spacer(modifier = Modifier.height(28.dp))

        // Permissions
        SectionLabel("PERMISSIONS")

        Spacer(modifier = Modifier.height(10.dp))

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(SeekerClawColors.Surface, shape)
                .padding(horizontal = 16.dp),
        ) {
            PermissionRow("GPS Location", hasLocationPermission) {
                requestPermissionOrOpenSettings(context, Manifest.permission.ACCESS_FINE_LOCATION, locationLauncher)
            }
            PermissionRow("Contacts", hasContactsPermission) {
                requestPermissionOrOpenSettings(context, Manifest.permission.READ_CONTACTS, contactsLauncher)
            }
            PermissionRow("SMS", hasSmsPermission) {
                requestPermissionOrOpenSettings(context, Manifest.permission.SEND_SMS, smsLauncher)
            }
            PermissionRow("Phone Calls", hasCallPermission) {
                requestPermissionOrOpenSettings(context, Manifest.permission.CALL_PHONE, callLauncher)
            }
        }

        Spacer(modifier = Modifier.height(28.dp))

        // Solana Wallet
        SectionLabel("SOLANA WALLET")

        Spacer(modifier = Modifier.height(10.dp))

        var walletAddress by remember { mutableStateOf(ConfigManager.getWalletAddress(context)) }

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(SeekerClawColors.Surface, shape)
                .padding(16.dp),
        ) {
            if (walletAddress != null) {
                InfoRow("Address", "${walletAddress!!.take(6)}...${walletAddress!!.takeLast(4)}")
                Spacer(modifier = Modifier.height(12.dp))
                OutlinedButton(
                    onClick = {
                        ConfigManager.clearWalletAddress(context)
                        walletAddress = null
                    },
                    modifier = Modifier.fillMaxWidth(),
                    shape = shape,
                    colors = ButtonDefaults.outlinedButtonColors(
                        contentColor = SeekerClawColors.Error,
                    ),
                ) {
                    Text("Disconnect Wallet", fontFamily = FontFamily.Monospace, fontSize = 14.sp)
                }
            } else {
                var manualAddress by remember { mutableStateOf("") }
                OutlinedTextField(
                    value = manualAddress,
                    onValueChange = { manualAddress = it },
                    label = {
                        Text(
                            "Wallet Address",
                            fontFamily = FontFamily.Monospace,
                            fontSize = 12.sp,
                        )
                    },
                    placeholder = {
                        Text(
                            "Paste public key...",
                            fontFamily = FontFamily.Monospace,
                            fontSize = 14.sp,
                            color = SeekerClawColors.TextDim,
                        )
                    },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    textStyle = androidx.compose.ui.text.TextStyle(
                        fontFamily = FontFamily.Monospace,
                        fontSize = 14.sp,
                        color = SeekerClawColors.TextPrimary,
                    ),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = SeekerClawColors.Primary,
                        unfocusedBorderColor = SeekerClawColors.TextDim.copy(alpha = 0.3f),
                        cursorColor = SeekerClawColors.Primary,
                    ),
                )
                Spacer(modifier = Modifier.height(12.dp))
                Button(
                    onClick = {
                        if (manualAddress.isNotBlank()) {
                            ConfigManager.setWalletAddress(context, manualAddress.trim())
                            walletAddress = manualAddress.trim()
                            manualAddress = ""
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                    shape = shape,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = SeekerClawColors.Accent.copy(alpha = 0.15f),
                        contentColor = SeekerClawColors.Accent,
                    ),
                ) {
                    Text("Save Address", fontFamily = FontFamily.Monospace, fontSize = 14.sp)
                }
            }
        }

        Spacer(modifier = Modifier.height(28.dp))

        // Data backup
        SectionLabel("DATA")

        Spacer(modifier = Modifier.height(10.dp))

        OutlinedButton(
            onClick = {
                val timestamp = SimpleDateFormat("yyyyMMdd_HHmm", Locale.US).format(Date())
                exportLauncher.launch("seekerclaw_backup_$timestamp.zip")
            },
            modifier = Modifier.fillMaxWidth(),
            shape = shape,
            colors = ButtonDefaults.outlinedButtonColors(
                contentColor = SeekerClawColors.TextPrimary,
            ),
        ) {
            Text(
                "Export Memory",
                fontFamily = FontFamily.Monospace,
                fontSize = 14.sp,
            )
        }

        Spacer(modifier = Modifier.height(8.dp))

        OutlinedButton(
            onClick = { showImportDialog = true },
            modifier = Modifier.fillMaxWidth(),
            shape = shape,
            colors = ButtonDefaults.outlinedButtonColors(
                contentColor = SeekerClawColors.TextPrimary,
            ),
        ) {
            Text(
                "Import Memory",
                fontFamily = FontFamily.Monospace,
                fontSize = 14.sp,
            )
        }

        Spacer(modifier = Modifier.height(32.dp))

        // Danger zone
        SectionLabel("DANGER ZONE")

        Spacer(modifier = Modifier.height(10.dp))

        Button(
            onClick = { showResetDialog = true },
            modifier = Modifier.fillMaxWidth(),
            shape = shape,
            colors = ButtonDefaults.buttonColors(
                containerColor = SeekerClawColors.Error.copy(alpha = 0.12f),
                contentColor = SeekerClawColors.Error,
            ),
        ) {
            Text(
                "Reset Config",
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Medium,
                fontSize = 14.sp,
            )
        }

        Spacer(modifier = Modifier.height(8.dp))

        Button(
            onClick = { showClearMemoryDialog = true },
            modifier = Modifier.fillMaxWidth(),
            shape = shape,
            colors = ButtonDefaults.buttonColors(
                containerColor = SeekerClawColors.Error.copy(alpha = 0.12f),
                contentColor = SeekerClawColors.Error,
            ),
        ) {
            Text(
                "Wipe Memory",
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Medium,
                fontSize = 14.sp,
            )
        }

        Spacer(modifier = Modifier.height(32.dp))

        // System info
        SectionLabel("SYSTEM")

        Spacer(modifier = Modifier.height(10.dp))

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(SeekerClawColors.Surface, shape)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            InfoRow("Version", "1.0.0")
            InfoRow("OpenClaw", "---")
            InfoRow("Node.js", "18 LTS")
        }

        Spacer(modifier = Modifier.height(24.dp))
    }

    // ==================== Edit Field Dialog ====================
    if (editField != null) {
        AlertDialog(
            onDismissRequest = { editField = null },
            title = {
                Text(
                    "Edit $editLabel",
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.TextPrimary,
                )
            },
            text = {
                Column {
                    if (editField == "anthropicApiKey" || editField == "telegramBotToken") {
                        Text(
                            "Changing this requires an agent restart.",
                            fontFamily = FontFamily.Monospace,
                            fontSize = 12.sp,
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
                            fontSize = 14.sp,
                            color = SeekerClawColors.TextPrimary,
                        ),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = SeekerClawColors.Primary,
                            unfocusedBorderColor = SeekerClawColors.TextDim.copy(alpha = 0.3f),
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
                            if (field == "anthropicApiKey") {
                                val detected = ConfigManager.detectAuthType(trimmed)
                                saveField("authType", detected)
                            }
                            saveField(field, trimmed)
                        }
                        editField = null
                    },
                ) {
                    Text(
                        "Save",
                        fontFamily = FontFamily.Monospace,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Primary,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { editField = null }) {
                    Text(
                        "Cancel",
                        fontFamily = FontFamily.Monospace,
                        color = SeekerClawColors.TextDim,
                    )
                }
            },
            containerColor = SeekerClawColors.Surface,
            shape = shape,
        )
    }

    // ==================== Model Picker Dialog ====================
    if (showModelPicker) {
        var selectedModel by remember { mutableStateOf(config?.model ?: modelOptions[0].first) }

        AlertDialog(
            onDismissRequest = { showModelPicker = false },
            title = {
                Text(
                    "Select Model",
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.TextPrimary,
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
                                    fontSize = 14.sp,
                                    color = SeekerClawColors.TextPrimary,
                                )
                                Text(
                                    text = modelId,
                                    fontFamily = FontFamily.Monospace,
                                    fontSize = 11.sp,
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
                        "Save",
                        fontFamily = FontFamily.Monospace,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Primary,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showModelPicker = false }) {
                    Text(
                        "Cancel",
                        fontFamily = FontFamily.Monospace,
                        color = SeekerClawColors.TextDim,
                    )
                }
            },
            containerColor = SeekerClawColors.Surface,
            shape = shape,
        )
    }

    // ==================== Restart Prompt ====================
    if (showRestartDialog) {
        AlertDialog(
            onDismissRequest = { showRestartDialog = false },
            title = {
                Text(
                    "Config Updated",
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.TextPrimary,
                )
            },
            text = {
                Text(
                    "Restart the agent to apply changes?",
                    fontFamily = FontFamily.Monospace,
                    fontSize = 14.sp,
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
                        "Restart Now",
                        fontFamily = FontFamily.Monospace,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Primary,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showRestartDialog = false }) {
                    Text(
                        "Later",
                        fontFamily = FontFamily.Monospace,
                        color = SeekerClawColors.TextDim,
                    )
                }
            },
            containerColor = SeekerClawColors.Surface,
            shape = shape,
        )
    }

    // ==================== Reset Config Dialog ====================
    if (showResetDialog) {
        AlertDialog(
            onDismissRequest = { showResetDialog = false },
            title = {
                Text(
                    "Reset Config",
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.Error,
                )
            },
            text = {
                Text(
                    "This will stop the agent, clear all config, and return to setup. This cannot be undone.",
                    fontFamily = FontFamily.Monospace,
                    fontSize = 13.sp,
                    color = SeekerClawColors.TextSecondary,
                    lineHeight = 20.sp,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    OpenClawService.stop(context)
                    ConfigManager.clearConfig(context)
                    showResetDialog = false
                }) {
                    Text(
                        "Confirm",
                        fontFamily = FontFamily.Monospace,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showResetDialog = false }) {
                    Text(
                        "Cancel",
                        fontFamily = FontFamily.Monospace,
                        color = SeekerClawColors.TextDim,
                    )
                }
            },
            containerColor = SeekerClawColors.Surface,
            shape = shape,
        )
    }

    // ==================== Import Dialog ====================
    if (showImportDialog) {
        AlertDialog(
            onDismissRequest = { showImportDialog = false },
            title = {
                Text(
                    "Import Memory",
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.Warning,
                )
            },
            text = {
                Text(
                    "This will overwrite current memory files with the backup. Export first if you want to keep current data.",
                    fontFamily = FontFamily.Monospace,
                    fontSize = 13.sp,
                    color = SeekerClawColors.TextSecondary,
                    lineHeight = 20.sp,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    showImportDialog = false
                    importLauncher.launch(arrayOf("application/zip"))
                }) {
                    Text(
                        "Select File",
                        fontFamily = FontFamily.Monospace,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Warning,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showImportDialog = false }) {
                    Text(
                        "Cancel",
                        fontFamily = FontFamily.Monospace,
                        color = SeekerClawColors.TextDim,
                    )
                }
            },
            containerColor = SeekerClawColors.Surface,
            shape = shape,
        )
    }

    // ==================== Clear Memory Dialog ====================
    if (showClearMemoryDialog) {
        AlertDialog(
            onDismissRequest = { showClearMemoryDialog = false },
            title = {
                Text(
                    "Wipe Memory",
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.Error,
                )
            },
            text = {
                Text(
                    "This will delete all memory files. The agent will lose all accumulated knowledge. This cannot be undone.",
                    fontFamily = FontFamily.Monospace,
                    fontSize = 13.sp,
                    color = SeekerClawColors.TextSecondary,
                    lineHeight = 20.sp,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    ConfigManager.clearMemory(context)
                    showClearMemoryDialog = false
                }) {
                    Text(
                        "Confirm",
                        fontFamily = FontFamily.Monospace,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showClearMemoryDialog = false }) {
                    Text(
                        "Cancel",
                        fontFamily = FontFamily.Monospace,
                        color = SeekerClawColors.TextDim,
                    )
                }
            },
            containerColor = SeekerClawColors.Surface,
            shape = shape,
        )
    }
}

@Composable
private fun SectionLabel(title: String) {
    Text(
        text = title,
        fontFamily = FontFamily.Monospace,
        fontSize = 11.sp,
        fontWeight = FontWeight.Medium,
        color = SeekerClawColors.TextSecondary,
        letterSpacing = 0.5.sp,
    )
}

@Composable
private fun ConfigField(
    label: String,
    value: String,
    onClick: (() -> Unit)? = null,
    showDivider: Boolean = true,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 16.dp, vertical = 14.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = label,
                fontFamily = FontFamily.Monospace,
                fontSize = 12.sp,
                color = SeekerClawColors.TextDim,
            )
            if (onClick != null) {
                Text(
                    text = "Edit",
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    color = SeekerClawColors.Primary.copy(alpha = 0.7f),
                )
            }
        }
        Spacer(modifier = Modifier.height(2.dp))
        Text(
            text = value,
            fontFamily = FontFamily.Monospace,
            fontSize = 14.sp,
            color = SeekerClawColors.TextPrimary,
        )
    }
    if (showDivider) {
        androidx.compose.material3.HorizontalDivider(
            color = SeekerClawColors.TextDim.copy(alpha = 0.1f),
            modifier = Modifier.padding(horizontal = 16.dp),
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
            fontSize = 14.sp,
            color = SeekerClawColors.TextPrimary,
        )
        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
            colors = SwitchDefaults.colors(
                checkedThumbColor = SeekerClawColors.Accent,
                checkedTrackColor = SeekerClawColors.Accent.copy(alpha = 0.3f),
                uncheckedThumbColor = SeekerClawColors.TextDim,
                uncheckedTrackColor = SeekerClawColors.Background,
                uncheckedBorderColor = SeekerClawColors.TextDim.copy(alpha = 0.3f),
            ),
        )
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            text = label,
            fontFamily = FontFamily.Monospace,
            fontSize = 13.sp,
            color = SeekerClawColors.TextDim,
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
private fun PermissionRow(label: String, granted: Boolean, onRequest: () -> Unit) {
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
            fontSize = 14.sp,
            color = SeekerClawColors.TextPrimary,
        )
        Switch(
            checked = granted,
            onCheckedChange = { if (!granted) onRequest() },
            colors = SwitchDefaults.colors(
                checkedThumbColor = SeekerClawColors.Accent,
                checkedTrackColor = SeekerClawColors.Accent.copy(alpha = 0.3f),
                uncheckedThumbColor = SeekerClawColors.TextDim,
                uncheckedTrackColor = SeekerClawColors.Background,
                uncheckedBorderColor = SeekerClawColors.TextDim.copy(alpha = 0.3f),
            ),
        )
    }
}

private fun requestPermissionOrOpenSettings(
    context: Context,
    permission: String,
    launcher: ManagedActivityResultLauncher<String, Boolean>,
) {
    val activity = context as? Activity ?: return
    if (ActivityCompat.shouldShowRequestPermissionRationale(activity, permission)) {
        launcher.launch(permission)
    } else {
        val prefs = context.getSharedPreferences("seekerclaw_prefs", Context.MODE_PRIVATE)
        val askedKey = "permission_asked_$permission"
        if (prefs.getBoolean(askedKey, false)) {
            val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:${context.packageName}")
            }
            context.startActivity(intent)
        } else {
            prefs.edit().putBoolean(askedKey, true).apply()
            launcher.launch(permission)
        }
    }
}

@Composable
private fun ThemeSelector() {
    val currentTheme = ThemeManager.currentStyle

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        SeekerClawThemeStyle.entries.forEach { style ->
            val isSelected = style == currentTheme
            Button(
                onClick = { ThemeManager.setTheme(style) },
                modifier = Modifier.weight(1f),
                shape = RoundedCornerShape(SeekerClawColors.CornerRadius),
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (isSelected) SeekerClawColors.Primary.copy(alpha = 0.15f) else SeekerClawColors.Surface,
                    contentColor = if (isSelected) SeekerClawColors.Primary else SeekerClawColors.TextDim,
                ),
            ) {
                Text(
                    text = style.displayName,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 11.sp,
                    fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal,
                )
            }
        }
    }
}
