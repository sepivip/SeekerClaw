package com.seekerclaw.app.ui.settings

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
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
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import com.seekerclaw.app.config.ConfigClaimImport
import com.seekerclaw.app.config.ConfigClaimImporter
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.config.McpServerConfig
import com.seekerclaw.app.config.availableModels
import com.seekerclaw.app.qr.QrScannerActivity
import com.seekerclaw.app.service.OpenClawService
import com.seekerclaw.app.solana.SolanaAuthActivity
import com.seekerclaw.app.ui.theme.SeekerClawColors
import com.seekerclaw.app.util.Analytics
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
import com.seekerclaw.app.BuildConfig
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File
import java.util.Date

@Composable
fun SettingsScreen(onRunSetupAgain: () -> Unit = {}) {
    val context = LocalContext.current
    var config by remember { mutableStateOf(ConfigManager.loadConfig(context)) }

    var autoStartOnBoot by remember {
        mutableStateOf(ConfigManager.getAutoStartOnBoot(context))
    }
    var keepScreenOn by remember {
        mutableStateOf(ConfigManager.getKeepScreenOn(context))
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
    var hasCameraPermission by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
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
    val cameraLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { hasCameraPermission = it }
    val contactsLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { hasContactsPermission = it }
    val smsLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { hasSmsPermission = it }
    val callLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { hasCallPermission = it }

    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                batteryOptimizationDisabled = powerManager.isIgnoringBatteryOptimizations(context.packageName)
                hasLocationPermission = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                hasCameraPermission = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
                hasContactsPermission = ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED
                hasSmsPermission = ContextCompat.checkSelfPermission(context, Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED
                hasCallPermission = ContextCompat.checkSelfPermission(context, Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    var showRunSetupDialog by remember { mutableStateOf(false) }
    var showResetDialog by remember { mutableStateOf(false) }
    var showClearMemoryDialog by remember { mutableStateOf(false) }
    var showImportDialog by remember { mutableStateOf(false) }
    var showApplyConfigDialog by remember { mutableStateOf(false) }
    var showRestartDialog by remember { mutableStateOf(false) }
    var isConfigImporting by remember { mutableStateOf(false) }
    var configImportError by remember { mutableStateOf<String?>(null) }
    var pendingConfigImport by remember { mutableStateOf<ConfigClaimImport?>(null) }

    var editField by remember { mutableStateOf<String?>(null) }
    var editLabel by remember { mutableStateOf("") }
    var editValue by remember { mutableStateOf("") }
    var showModelPicker by remember { mutableStateOf(false) }
    var showAuthTypePicker by remember { mutableStateOf(false) }

    // MCP server state
    var mcpServers by remember { mutableStateOf(ConfigManager.loadMcpServers(context)) }
    var showMcpDialog by remember { mutableStateOf(false) }
    var editingMcpServer by remember { mutableStateOf<McpServerConfig?>(null) }
    var showDeleteMcpDialog by remember { mutableStateOf(false) }
    var deletingMcpServer by remember { mutableStateOf<McpServerConfig?>(null) }

    // Wallet connect state
    var walletAddress by remember { mutableStateOf(ConfigManager.getWalletAddress(context)) }
    var isConnecting by remember { mutableStateOf(false) }
    var walletError by remember { mutableStateOf<String?>(null) }
    var walletRequestId by remember { mutableStateOf<String?>(null) }

    val walletLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { _ ->
        isConnecting = false
        // SolanaAuthActivity saves address to ConfigManager on success — just re-read
        val newAddress = ConfigManager.getWalletAddress(context)
        if (newAddress != null) {
            walletAddress = newAddress
            walletError = null
        } else {
            // Read result file for specific error
            val reqId = walletRequestId
            if (reqId != null) {
                try {
                    val resultFile = File(context.filesDir, "${SolanaAuthActivity.RESULTS_DIR}/$reqId.json")
                    if (resultFile.exists()) {
                        val result = JSONObject(resultFile.readText())
                        val error = result.optString("error", "")
                        walletError = if (error.isNotBlank()) error else "Connection cancelled"
                        resultFile.delete()
                    } else {
                        walletError = "Connection cancelled"
                    }
                } catch (_: Exception) {
                    walletError = "Connection failed"
                }
            } else {
                walletError = "Connection cancelled"
            }
        }
        walletRequestId = null
    }

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

    val scope = rememberCoroutineScope()
    val qrConfigLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val qrError = result.data?.getStringExtra(QrScannerActivity.EXTRA_ERROR)
        if (!qrError.isNullOrBlank()) {
            configImportError = qrError
            Toast.makeText(context, qrError, Toast.LENGTH_SHORT).show()
            return@rememberLauncherForActivityResult
        }
        if (result.resultCode != Activity.RESULT_OK) return@rememberLauncherForActivityResult

        val qrText = result.data?.getStringExtra(QrScannerActivity.EXTRA_QR_TEXT)
        if (qrText.isNullOrBlank()) {
            configImportError = "No QR data received"
            Toast.makeText(context, "No QR data received", Toast.LENGTH_SHORT).show()
            return@rememberLauncherForActivityResult
        }

        isConfigImporting = true
        configImportError = null
        scope.launch {
            val importResult = ConfigClaimImporter.fetchFromQr(qrText)
            isConfigImporting = false
            importResult.onSuccess { imported ->
                pendingConfigImport = imported
                showApplyConfigDialog = true
            }.onFailure { err ->
                configImportError = err.message ?: "Config import failed"
                Toast.makeText(context, configImportError, Toast.LENGTH_LONG).show()
            }
        }
    }

    fun saveField(field: String, value: String) {
        ConfigManager.updateConfigField(context, field, value)
        config = ConfigManager.loadConfig(context)
        showRestartDialog = true
    }

    val authTypeLabel = if (config?.authType == "setup_token") "Pro/Max Token" else "API Key"
    val maskedApiKey = config?.anthropicApiKey?.let { key ->
        if (key.isBlank()) "Not set"
        else if (key.length > 12) "${key.take(8)}${"*".repeat(8)}${key.takeLast(4)}" else "*".repeat(key.length)
    } ?: "Not set"
    val maskedSetupToken = config?.setupToken?.let { token ->
        if (token.isBlank()) "Not set"
        else if (token.length > 12) "${token.take(8)}${"*".repeat(8)}${token.takeLast(4)}" else "*".repeat(token.length)
    } ?: "Not set"
    val maskedBotToken = config?.telegramBotToken?.let { token ->
        if (token.isBlank()) "Not set"
        else if (token.length > 10) "${token.take(6)}${"*".repeat(8)}${token.takeLast(4)}"
        else "*".repeat(token.length)
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
            fontFamily = FontFamily.Default,
            fontSize = 24.sp,
            fontWeight = FontWeight.Bold,
            color = SeekerClawColors.TextPrimary,
        )

        Spacer(modifier = Modifier.height(28.dp))

        // Quick Setup — QR Config Import
        SectionLabel("Quick Setup")

        Spacer(modifier = Modifier.height(10.dp))

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(SeekerClawColors.Surface, shape)
                .padding(16.dp),
        ) {
            Text(
                text = "Generate a config QR at seekerclaw.xyz and scan it to set up your agent in seconds.",
                fontFamily = FontFamily.Default,
                fontSize = 13.sp,
                color = SeekerClawColors.TextDim,
            )

            Spacer(modifier = Modifier.height(12.dp))

            Button(
                onClick = {
                    if (!isConfigImporting) {
                        Analytics.featureUsed("qr_scan")
                        qrConfigLauncher.launch(Intent(context, QrScannerActivity::class.java))
                    }
                },
                enabled = !isConfigImporting,
                modifier = Modifier.fillMaxWidth(),
                shape = shape,
                colors = ButtonDefaults.buttonColors(
                    containerColor = SeekerClawColors.ActionPrimary,
                    contentColor = androidx.compose.ui.graphics.Color.White,
                ),
            ) {
                if (isConfigImporting) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(16.dp),
                        strokeWidth = 2.dp,
                        color = androidx.compose.ui.graphics.Color.White,
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text("Importing Config\u2026", fontFamily = FontFamily.Default, fontSize = 14.sp)
                } else {
                    Text(
                        "Scan Config QR",
                        fontFamily = FontFamily.Default,
                        fontWeight = FontWeight.Bold,
                        fontSize = 14.sp,
                    )
                }
            }

            if (configImportError != null) {
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = configImportError ?: "",
                    fontFamily = FontFamily.Default,
                    fontSize = 12.sp,
                    color = SeekerClawColors.Error,
                )
            }
        }

        Spacer(modifier = Modifier.height(28.dp))

        // Configuration
        CollapsibleSection("Configuration", initiallyExpanded = true) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SeekerClawColors.Surface, shape),
            ) {
                ConfigField(
                    label = "Auth Type",
                    value = authTypeLabel,
                    onClick = { showAuthTypePicker = true },
                    info = SettingsHelpTexts.AUTH_TYPE,
                )
                ConfigField(
                    label = if (config?.authType == "api_key") "API Key (active)" else "API Key",
                    value = maskedApiKey,
                    onClick = {
                        editField = "anthropicApiKey"
                        editLabel = "API Key"
                        editValue = config?.anthropicApiKey ?: ""
                    },
                    info = SettingsHelpTexts.API_KEY,
                    isRequired = config?.authType == "api_key",
                )
                ConfigField(
                    label = if (config?.authType == "setup_token") "Setup Token (active)" else "Setup Token",
                    value = maskedSetupToken,
                    onClick = {
                        editField = "setupToken"
                        editLabel = "Setup Token"
                        editValue = config?.setupToken ?: ""
                    },
                    info = SettingsHelpTexts.SETUP_TOKEN,
                    isRequired = config?.authType == "setup_token",
                )
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
                    value = config?.telegramOwnerId?.ifBlank { "Auto-detect" } ?: "Auto-detect",
                    onClick = {
                        editField = "telegramOwnerId"
                        editLabel = "Owner ID"
                        editValue = config?.telegramOwnerId ?: ""
                    },
                    info = SettingsHelpTexts.OWNER_ID,
                )
                ConfigField(
                    label = "Model",
                    value = availableModels.find { it.id == config?.model }
                        ?.let { "${it.displayName} (${it.description})" }
                        ?: config?.model?.ifBlank { "Not set" }
                        ?: "Not set",
                    onClick = { showModelPicker = true },
                    info = SettingsHelpTexts.MODEL,
                )
                ConfigField(
                    label = "Agent Name",
                    value = config?.agentName?.ifBlank { "SeekerClaw" } ?: "SeekerClaw",
                    onClick = {
                        editField = "agentName"
                        editLabel = "Agent Name"
                        editValue = config?.agentName ?: ""
                    },
                    info = SettingsHelpTexts.AGENT_NAME,
                )
                ConfigField(
                    label = "Brave API Key",
                    value = config?.braveApiKey?.let { key ->
                        if (key.isBlank()) "Not set — using DuckDuckGo"
                        else if (key.length > 12) "${key.take(8)}${"*".repeat(8)}${key.takeLast(4)}"
                        else "*".repeat(key.length)
                    } ?: "Not set — using DuckDuckGo",
                    onClick = {
                        editField = "braveApiKey"
                        editLabel = "Brave API Key"
                        editValue = config?.braveApiKey ?: ""
                    },
                    info = SettingsHelpTexts.BRAVE_API_KEY,
                    showDivider = false,
                )
            }
        }

        Spacer(modifier = Modifier.height(28.dp))

        // Preferences
        CollapsibleSection("Preferences", initiallyExpanded = true) {
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
                    info = SettingsHelpTexts.AUTO_START,
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
                    info = SettingsHelpTexts.BATTERY_UNRESTRICTED,
                )
                SettingRow(
                    label = "Server mode (keep screen awake)",
                    checked = keepScreenOn,
                    onCheckedChange = {
                        keepScreenOn = it
                        ConfigManager.setKeepScreenOn(context, it)
                        showRestartDialog = true
                    },
                    info = SettingsHelpTexts.SERVER_MODE,
                )
            }
        }

        Spacer(modifier = Modifier.height(28.dp))

        // Permissions
        CollapsibleSection("Permissions", initiallyExpanded = false) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SeekerClawColors.Surface, shape)
                    .padding(horizontal = 16.dp),
            ) {
                val allPermissionsOff = !hasCameraPermission && !hasLocationPermission &&
                    !hasContactsPermission && !hasSmsPermission && !hasCallPermission
                if (allPermissionsOff) {
                    Text(
                        text = "Enable permissions to unlock device features (camera, GPS, SMS, etc.)",
                        fontFamily = FontFamily.Default,
                        fontSize = 12.sp,
                        color = SeekerClawColors.TextSecondary,
                        lineHeight = 18.sp,
                        modifier = Modifier.padding(top = 12.dp, bottom = 4.dp),
                    )
                }
                PermissionRow(
                    label = "Camera",
                    granted = hasCameraPermission,
                    onRequest = {
                        requestPermissionOrOpenSettings(context, Manifest.permission.CAMERA, cameraLauncher)
                    },
                    info = SettingsHelpTexts.CAMERA,
                )
                PermissionRow(
                    label = "GPS Location",
                    granted = hasLocationPermission,
                    onRequest = {
                        requestPermissionOrOpenSettings(context, Manifest.permission.ACCESS_FINE_LOCATION, locationLauncher)
                    },
                    info = SettingsHelpTexts.GPS_LOCATION,
                )
                PermissionRow(
                    label = "Contacts",
                    granted = hasContactsPermission,
                    onRequest = {
                        requestPermissionOrOpenSettings(context, Manifest.permission.READ_CONTACTS, contactsLauncher)
                    },
                    info = SettingsHelpTexts.CONTACTS,
                )
                PermissionRow(
                    label = "SMS",
                    granted = hasSmsPermission,
                    onRequest = {
                        requestPermissionOrOpenSettings(context, Manifest.permission.SEND_SMS, smsLauncher)
                    },
                    info = SettingsHelpTexts.SMS,
                )
                PermissionRow(
                    label = "Phone Calls",
                    granted = hasCallPermission,
                    onRequest = {
                        requestPermissionOrOpenSettings(context, Manifest.permission.CALL_PHONE, callLauncher)
                    },
                    info = SettingsHelpTexts.PHONE_CALLS,
                )
            }
        }

        Spacer(modifier = Modifier.height(28.dp))

        // Solana Wallet
        CollapsibleSection("Solana Wallet", initiallyExpanded = false) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SeekerClawColors.Surface, shape)
                    .padding(16.dp),
            ) {
                if (walletAddress != null) {
                    // Connected state — address with copy button
                    val address = walletAddress!!
                    val hapticCopy = LocalHapticFeedback.current
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = "Address",
                            fontFamily = FontFamily.Default,
                            fontSize = 13.sp,
                            color = SeekerClawColors.TextDim,
                        )
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                text = "${address.take(6)}\u2026${address.takeLast(4)}",
                                fontFamily = FontFamily.Default,
                                fontSize = 13.sp,
                                color = SeekerClawColors.TextSecondary,
                            )
                            TextButton(
                                onClick = {
                                    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                                    clipboard.setPrimaryClip(ClipData.newPlainText("wallet address", address))
                                    hapticCopy.performHapticFeedback(HapticFeedbackType.LongPress)
                                    Toast.makeText(context, "Address copied", Toast.LENGTH_SHORT).show()
                                },
                                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp),
                            ) {
                                Text(
                                    text = "Copy",
                                    fontSize = 12.sp,
                                    color = SeekerClawColors.TextInteractive,
                                )
                            }
                        }
                    }

                val label = ConfigManager.getWalletLabel(context)
                if (label.isNotBlank()) {
                    Spacer(modifier = Modifier.height(4.dp))
                    InfoRow("Wallet", label)
                }

                Spacer(modifier = Modifier.height(12.dp))
                OutlinedButton(
                    onClick = {
                        ConfigManager.clearWalletAddress(context)
                        walletAddress = null
                        walletError = null
                        Analytics.featureUsed("wallet_disconnected")
                    },
                    modifier = Modifier.fillMaxWidth(),
                    shape = shape,
                    colors = ButtonDefaults.outlinedButtonColors(
                        contentColor = SeekerClawColors.Error,
                    ),
                ) {
                    Text("Disconnect Wallet", fontFamily = FontFamily.Default, fontSize = 14.sp)
                }
            } else {
                // Not connected — show Connect button
                if (walletError != null) {
                    Text(
                        text = walletError!!,
                        fontFamily = FontFamily.Default,
                        fontSize = 12.sp,
                        color = SeekerClawColors.Error,
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(SeekerClawColors.Error.copy(alpha = 0.1f), shape)
                            .padding(12.dp),
                    )
                    Spacer(modifier = Modifier.height(12.dp))
                }

                Button(
                    onClick = {
                        isConnecting = true
                        walletError = null
                        Analytics.featureUsed("wallet_connected")
                        val requestId = "settings_${System.currentTimeMillis()}"
                        walletRequestId = requestId
                        val intent = Intent(context, SolanaAuthActivity::class.java).apply {
                            putExtra("action", "authorize")
                            putExtra("requestId", requestId)
                        }
                        walletLauncher.launch(intent)
                    },
                    enabled = !isConnecting,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(48.dp),
                    shape = shape,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = SeekerClawColors.ActionPrimary,
                        contentColor = androidx.compose.ui.graphics.Color.White,
                        disabledContainerColor = SeekerClawColors.ActionPrimary.copy(alpha = 0.4f),
                        disabledContentColor = androidx.compose.ui.graphics.Color.White.copy(alpha = 0.6f),
                    ),
                ) {
                    if (isConnecting) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(18.dp),
                            color = androidx.compose.ui.graphics.Color.White,
                            strokeWidth = 2.dp,
                        )
                        Spacer(modifier = Modifier.padding(start = 8.dp))
                        Text("Connecting\u2026", fontFamily = FontFamily.Default, fontSize = 14.sp)
                    } else {
                        Text("Connect Wallet", fontFamily = FontFamily.Default, fontSize = 14.sp, fontWeight = FontWeight.Bold)
                    }
                }

                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = "Opens Phantom, Solflare, or Seeker Vault",
                    fontFamily = FontFamily.Default,
                    fontSize = 11.sp,
                    color = SeekerClawColors.TextDim,
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            // Jupiter API Key (Solana swaps)
            Spacer(modifier = Modifier.height(20.dp))
            ConfigField(
                label = "Jupiter API Key",
                value = config?.jupiterApiKey?.let { key ->
                    if (key.isBlank()) "Not set — swaps disabled"
                    else if (key.length > 12) "${key.take(8)}${"*".repeat(8)}${key.takeLast(4)}"
                    else "*".repeat(key.length)
                } ?: "Not set — swaps disabled",
                onClick = {
                    editField = "jupiterApiKey"
                    editLabel = "Jupiter API Key"
                    editValue = config?.jupiterApiKey ?: ""
                },
                showDivider = false,
                info = SettingsHelpTexts.JUPITER_API_KEY,
            )
            }
        }

        Spacer(modifier = Modifier.height(28.dp))

        // MCP Servers (BAT-168)
        CollapsibleSection("MCP Servers", initiallyExpanded = false) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SeekerClawColors.Surface, shape)
                    .padding(16.dp),
            ) {
                Text(
                    text = SettingsHelpTexts.MCP_SERVERS,
                    fontFamily = FontFamily.Default,
                    fontSize = 13.sp,
                    color = SeekerClawColors.TextDim,
                )

                Spacer(modifier = Modifier.height(12.dp))

                if (mcpServers.isEmpty()) {
                    Text(
                        text = "No servers configured",
                        fontFamily = FontFamily.Default,
                        fontSize = 13.sp,
                        color = SeekerClawColors.TextDim,
                        fontStyle = androidx.compose.ui.text.font.FontStyle.Italic,
                    )
                } else {
                    for (server in mcpServers) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 6.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    text = server.name,
                                    fontFamily = FontFamily.Default,
                                    fontSize = 14.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = SeekerClawColors.TextPrimary,
                                )
                                Text(
                                    text = server.url,
                                    fontFamily = FontFamily.Monospace,
                                    fontSize = 11.sp,
                                    color = SeekerClawColors.TextDim,
                                    maxLines = 1,
                                    overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                                )
                            }
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Switch(
                                    checked = server.enabled,
                                    onCheckedChange = { enabled ->
                                        mcpServers = mcpServers.map {
                                            if (it.id == server.id) it.copy(enabled = enabled) else it
                                        }
                                        ConfigManager.saveMcpServers(context, mcpServers)
                                        showRestartDialog = true
                                    },
                                    colors = SwitchDefaults.colors(
                                        checkedTrackColor = SeekerClawColors.StatusGreen,
                                        uncheckedTrackColor = SeekerClawColors.SurfaceVariant,
                                    ),
                                )
                                IconButton(onClick = {
                                    editingMcpServer = server
                                    showMcpDialog = true
                                }) {
                                    Icon(
                                        imageVector = Icons.Default.Edit,
                                        contentDescription = "Edit server",
                                        tint = SeekerClawColors.TextDim,
                                    )
                                }
                                IconButton(onClick = {
                                    deletingMcpServer = server
                                    showDeleteMcpDialog = true
                                }) {
                                    Icon(
                                        imageVector = Icons.Default.Delete,
                                        contentDescription = "Remove server",
                                        tint = SeekerClawColors.Error,
                                    )
                                }
                            }
                        }
                    }
                }

                Spacer(modifier = Modifier.height(8.dp))

                Button(
                    onClick = {
                        editingMcpServer = null
                        showMcpDialog = true
                    },
                    modifier = Modifier.fillMaxWidth(),
                    shape = shape,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = SeekerClawColors.ActionPrimary,
                        contentColor = androidx.compose.ui.graphics.Color.White,
                    ),
                ) {
                    Text("Add MCP Server", fontFamily = FontFamily.Default, fontSize = 14.sp)
                }
            }
        }

        Spacer(modifier = Modifier.height(28.dp))

        // Data backup
        CollapsibleSection("Data", initiallyExpanded = false) {
            Column {
                OutlinedButton(
                    onClick = {
                        Analytics.featureUsed("memory_exported")
                        val timestamp = android.text.format.DateFormat.format("yyyyMMdd_HHmm", Date())
                        exportLauncher.launch("seekerclaw_backup_$timestamp.zip")
                    },
                    modifier = Modifier.fillMaxWidth(),
                    shape = shape,
                    border = androidx.compose.foundation.BorderStroke(1.dp, SeekerClawColors.BorderSubtle),
                    colors = ButtonDefaults.outlinedButtonColors(
                        contentColor = SeekerClawColors.TextPrimary,
                    ),
                ) {
                    Text(
                        "Export Memory",
                        fontFamily = FontFamily.Default,
                        fontSize = 14.sp,
                    )
                }

                Spacer(modifier = Modifier.height(8.dp))

                OutlinedButton(
                    onClick = {
                        Analytics.featureUsed("memory_imported")
                        showImportDialog = true
                    },
                    modifier = Modifier.fillMaxWidth(),
                    shape = shape,
                    border = androidx.compose.foundation.BorderStroke(1.dp, SeekerClawColors.BorderSubtle),
                    colors = ButtonDefaults.outlinedButtonColors(
                        contentColor = SeekerClawColors.TextPrimary,
                    ),
                ) {
                    Text(
                        "Import Memory",
                        fontFamily = FontFamily.Default,
                        fontSize = 14.sp,
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(28.dp))

        // Run Setup Again
        CollapsibleSection("Setup", initiallyExpanded = false) {
            OutlinedButton(
                onClick = { showRunSetupDialog = true },
                modifier = Modifier.fillMaxWidth(),
                shape = shape,
                border = androidx.compose.foundation.BorderStroke(1.dp, SeekerClawColors.BorderSubtle),
                colors = ButtonDefaults.outlinedButtonColors(
                    contentColor = SeekerClawColors.TextPrimary,
                ),
            ) {
                Text(
                    "Run Setup Again",
                    fontFamily = FontFamily.Default,
                    fontSize = 14.sp,
                )
            }
        }

        Spacer(modifier = Modifier.height(32.dp))

        // Danger zone
        CollapsibleSection("Danger Zone", initiallyExpanded = false) {
            Column {
                Button(
                    onClick = { showResetDialog = true },
                    modifier = Modifier.fillMaxWidth(),
                    shape = shape,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = SeekerClawColors.ActionDanger,
                        contentColor = SeekerClawColors.ActionDangerText,
                    ),
                ) {
                    Text(
                        "Reset Config",
                        fontFamily = FontFamily.Default,
                        fontWeight = FontWeight.Medium,
                        fontSize = 14.sp,
                    )
                }

                Spacer(modifier = Modifier.height(8.dp))

                Button(
                    onClick = { showClearMemoryDialog = true },
                    modifier = Modifier.fillMaxWidth(),
                    shape = shape,
                    border = BorderStroke(1.dp, SeekerClawColors.Error),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = SeekerClawColors.ActionDanger,
                        contentColor = SeekerClawColors.ActionDangerText,
                    ),
                ) {
                    Icon(
                        Icons.Default.Warning,
                        contentDescription = "Warning",
                        modifier = Modifier.size(16.dp),
                        tint = SeekerClawColors.ActionDangerText,
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        "Wipe Memory",
                        fontFamily = FontFamily.Default,
                        fontWeight = FontWeight.Bold,
                        fontSize = 14.sp,
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(32.dp))

        // System info
        SectionLabel("System")

        Spacer(modifier = Modifier.height(10.dp))

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(SeekerClawColors.Surface, shape)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            InfoRow("Version", "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
            InfoRow("OpenClaw", BuildConfig.OPENCLAW_VERSION)
            InfoRow("Node.js", BuildConfig.NODEJS_VERSION)
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
                    fontFamily = FontFamily.Default,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.TextPrimary,
                )
            },
            text = {
                Column {
                    if (editField == "anthropicApiKey" || editField == "setupToken" || editField == "telegramBotToken" || editField == "braveApiKey" || editField == "jupiterApiKey") {
                        Text(
                            "Changing this requires an agent restart.",
                            fontFamily = FontFamily.Default,
                            fontSize = 12.sp,
                            color = SeekerClawColors.Warning,
                            modifier = Modifier.padding(bottom = 12.dp),
                        )
                    }
                    OutlinedTextField(
                        value = editValue,
                        onValueChange = { editValue = it },
                        label = { Text(editLabel, fontFamily = FontFamily.Default, fontSize = 12.sp) },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = editField != "anthropicApiKey" && editField != "setupToken",
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
                        if (field == "braveApiKey") {
                            // Allow empty to disable web search
                            saveField(field, trimmed)
                        } else if (field == "jupiterApiKey") {
                            // Allow empty to disable swaps
                            saveField(field, trimmed)
                        } else if (field == "setupToken") {
                            // Allow empty to clear, auto-switch auth type if setting a token
                            saveField(field, trimmed)
                            if (trimmed.isNotEmpty()) {
                                saveField("authType", "setup_token")
                            }
                        } else if (trimmed.isNotEmpty()) {
                            if (field == "anthropicApiKey") {
                                // Auto-detect: if user pastes a setup token into API key field, store it correctly
                                val detected = ConfigManager.detectAuthType(trimmed)
                                if (detected == "setup_token") {
                                    saveField("setupToken", trimmed)
                                    saveField("authType", "setup_token")
                                    editField = null
                                    return@TextButton
                                }
                            }
                            saveField(field, trimmed)
                        }
                        editField = null
                    },
                ) {
                    Text(
                        "Save",
                        fontFamily = FontFamily.Default,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.ActionPrimary,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { editField = null }) {
                    Text(
                        "Cancel",
                        fontFamily = FontFamily.Default,
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
        var selectedModel by remember { mutableStateOf(config?.model ?: availableModels[0].id) }

        AlertDialog(
            onDismissRequest = { showModelPicker = false },
            title = {
                Text(
                    "Select Model",
                    fontFamily = FontFamily.Default,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.TextPrimary,
                )
            },
            text = {
                Column {
                    availableModels.forEach { model ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { selectedModel = model.id }
                                .padding(vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(
                                selected = selectedModel == model.id,
                                onClick = { selectedModel = model.id },
                                colors = RadioButtonDefaults.colors(
                                    selectedColor = SeekerClawColors.Primary,
                                    unselectedColor = SeekerClawColors.TextDim,
                                ),
                            )
                            Column(modifier = Modifier.padding(start = 8.dp)) {
                                Text(
                                    text = "${model.displayName} (${model.description})",
                                    fontFamily = FontFamily.Default,
                                    fontSize = 14.sp,
                                    color = SeekerClawColors.TextPrimary,
                                )
                                Text(
                                    text = model.id,
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
                        Analytics.modelSelected(selectedModel)
                        showModelPicker = false
                    },
                ) {
                    Text(
                        "Save",
                        fontFamily = FontFamily.Default,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.ActionPrimary,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showModelPicker = false }) {
                    Text(
                        "Cancel",
                        fontFamily = FontFamily.Default,
                        color = SeekerClawColors.TextDim,
                    )
                }
            },
            containerColor = SeekerClawColors.Surface,
            shape = shape,
        )
    }

    // ==================== Auth Type Picker ====================
    if (showAuthTypePicker) {
        val authOptions = listOf(
            "api_key" to "API Key",
            "setup_token" to "Pro/Max Token",
        )
        var selectedAuth by remember { mutableStateOf(config?.authType ?: "api_key") }

        AlertDialog(
            onDismissRequest = { showAuthTypePicker = false },
            title = {
                Text(
                    "Auth Type",
                    fontFamily = FontFamily.Default,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.TextPrimary,
                )
            },
            text = {
                Column {
                    authOptions.forEach { (typeId, label) ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { selectedAuth = typeId }
                                .padding(vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(
                                selected = selectedAuth == typeId,
                                onClick = { selectedAuth = typeId },
                                colors = RadioButtonDefaults.colors(
                                    selectedColor = SeekerClawColors.Primary,
                                    unselectedColor = SeekerClawColors.TextDim,
                                ),
                            )
                            Text(
                                text = label,
                                fontFamily = FontFamily.Default,
                                fontSize = 14.sp,
                                color = SeekerClawColors.TextPrimary,
                                modifier = Modifier.padding(start = 8.dp),
                            )
                        }
                    }
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = "Both credentials are stored. Switching just changes which one is used.",
                        fontFamily = FontFamily.Default,
                        fontSize = 12.sp,
                        color = SeekerClawColors.TextDim,
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        saveField("authType", selectedAuth)
                        Analytics.authTypeChanged(selectedAuth)
                        showAuthTypePicker = false
                    },
                ) {
                    Text(
                        "Save",
                        fontFamily = FontFamily.Default,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.ActionPrimary,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showAuthTypePicker = false }) {
                    Text(
                        "Cancel",
                        fontFamily = FontFamily.Default,
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
                    fontFamily = FontFamily.Default,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.TextPrimary,
                )
            },
            text = {
                Text(
                    "Restart the agent to apply changes?",
                    fontFamily = FontFamily.Default,
                    fontSize = 14.sp,
                    color = SeekerClawColors.TextSecondary,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    OpenClawService.restart(context)
                    showRestartDialog = false
                    Toast.makeText(context, "Agent restarting\u2026", Toast.LENGTH_SHORT).show()
                }) {
                    Text(
                        "Restart Now",
                        fontFamily = FontFamily.Default,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Primary,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showRestartDialog = false }) {
                    Text(
                        "Later",
                        fontFamily = FontFamily.Default,
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
                    fontFamily = FontFamily.Default,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.Error,
                )
            },
            text = {
                Text(
                    "This will stop the agent, clear all config, and return to setup. This cannot be undone.",
                    fontFamily = FontFamily.Default,
                    fontSize = 13.sp,
                    color = SeekerClawColors.TextSecondary,
                    lineHeight = 20.sp,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    OpenClawService.stop(context)
                    ConfigManager.clearConfig(context)
                    Analytics.featureUsed("config_reset")
                    showResetDialog = false
                    onRunSetupAgain()
                }) {
                    Text(
                        "Confirm",
                        fontFamily = FontFamily.Default,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showResetDialog = false }) {
                    Text(
                        "Cancel",
                        fontFamily = FontFamily.Default,
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
                    fontFamily = FontFamily.Default,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.Warning,
                )
            },
            text = {
                Text(
                    "This will overwrite current memory files with the backup. Export first if you want to keep current data.",
                    fontFamily = FontFamily.Default,
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
                        fontFamily = FontFamily.Default,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Warning,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showImportDialog = false }) {
                    Text(
                        "Cancel",
                        fontFamily = FontFamily.Default,
                        color = SeekerClawColors.TextDim,
                    )
                }
            },
            containerColor = SeekerClawColors.Surface,
            shape = shape,
        )
    }

    // ==================== Apply Config Import Dialog ====================
    if (showApplyConfigDialog && pendingConfigImport != null) {
        val imported = pendingConfigImport!!
        val importedConfig = imported.config
        val maskedCredential = maskSensitive(importedConfig.activeCredential)
        val maskedBot = maskSensitive(importedConfig.telegramBotToken)
        val source = Uri.parse(imported.sourceUrl).host ?: imported.sourceUrl
        val autoStartSummary = imported.autoStartOnBoot?.let { if (it) "Enabled" else "Disabled" } ?: "No change"
        val keepScreenSummary = imported.keepScreenOn?.let { if (it) "Enabled" else "Disabled" } ?: "No change"
        AlertDialog(
            onDismissRequest = {
                showApplyConfigDialog = false
                pendingConfigImport = null
            },
            title = {
                Text(
                    "Apply Imported Config",
                    fontFamily = FontFamily.Default,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.Warning,
                )
            },
            text = {
                Text(
                    "Schema: v${imported.schemaVersion}\n" +
                        "Source: $source\n" +
                        "Auth: ${if (importedConfig.authType == "setup_token") "Pro/Max Token" else "API Key"}\n" +
                        "Credential: $maskedCredential\n" +
                        "Bot Token: $maskedBot\n" +
                        "Owner ID: ${importedConfig.telegramOwnerId.ifBlank { "Auto-detect" }}\n" +
                        "Model: ${importedConfig.model}\n" +
                        "Agent: ${importedConfig.agentName}\n" +
                        "Auto-start on boot: $autoStartSummary\n" +
                        "Server mode: $keepScreenSummary\n\n" +
                        "Apply this configuration to your device?",
                    fontFamily = FontFamily.Default,
                    fontSize = 13.sp,
                    color = SeekerClawColors.TextSecondary,
                    lineHeight = 20.sp,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    ConfigManager.saveConfig(context, importedConfig)
                    val savedConfig = ConfigManager.loadConfig(context)
                    LogCollector.append(
                        "[ConfigImport] Saved snapshot: ${ConfigManager.redactedSnapshot(savedConfig)}"
                    )
                    val saveValidationError = ConfigManager.runtimeValidationError(savedConfig)
                    if (saveValidationError != null) {
                        LogCollector.append(
                            "[ConfigImport] Validation failed after save: $saveValidationError",
                            LogLevel.ERROR,
                        )
                        configImportError = "Config saved but invalid: $saveValidationError"
                        Toast.makeText(
                            context,
                            "Imported config could not be applied: $saveValidationError",
                            Toast.LENGTH_LONG
                        ).show()
                        showApplyConfigDialog = false
                        pendingConfigImport = null
                        return@TextButton
                    }
                    imported.autoStartOnBoot?.let {
                        ConfigManager.setAutoStartOnBoot(context, it)
                        autoStartOnBoot = it
                    }
                    imported.keepScreenOn?.let {
                        ConfigManager.setKeepScreenOn(context, it)
                        keepScreenOn = it
                    }
                    config = ConfigManager.loadConfig(context)
                    showApplyConfigDialog = false
                    pendingConfigImport = null
                    configImportError = null
                    showRestartDialog = true
                    Toast.makeText(context, "Config imported", Toast.LENGTH_SHORT).show()
                }) {
                    Text(
                        "Apply",
                        fontFamily = FontFamily.Default,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Warning,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = {
                    showApplyConfigDialog = false
                    pendingConfigImport = null
                }) {
                    Text(
                        "Cancel",
                        fontFamily = FontFamily.Default,
                        color = SeekerClawColors.TextDim,
                    )
                }
            },
            containerColor = SeekerClawColors.Surface,
            shape = shape,
        )
    }

    // ==================== Run Setup Again Dialog ====================
    if (showRunSetupDialog) {
        AlertDialog(
            onDismissRequest = { showRunSetupDialog = false },
            title = {
                Text(
                    "Run Setup Again",
                    fontFamily = FontFamily.Default,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.TextPrimary,
                )
            },
            text = {
                Text(
                    "This will restart the setup flow. Your current config will be overwritten when you complete setup.",
                    fontFamily = FontFamily.Default,
                    fontSize = 13.sp,
                    color = SeekerClawColors.TextSecondary,
                    lineHeight = 20.sp,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    showRunSetupDialog = false
                    OpenClawService.stop(context)
                    Analytics.featureUsed("setup_rerun")
                    onRunSetupAgain()
                }) {
                    Text(
                        "Continue",
                        fontFamily = FontFamily.Default,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Primary,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showRunSetupDialog = false }) {
                    Text(
                        "Cancel",
                        fontFamily = FontFamily.Default,
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
        var wipeConfirmText by remember { mutableStateOf("") }
        val wipeConfirmed = wipeConfirmText.equals("WIPE", ignoreCase = true)

        AlertDialog(
            onDismissRequest = {
                showClearMemoryDialog = false
                wipeConfirmText = ""
            },
            title = {
                Text(
                    "Wipe Memory",
                    fontFamily = FontFamily.Default,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.Error,
                )
            },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(
                        "This will delete all memory files. The agent will lose all accumulated knowledge. This cannot be undone.",
                        fontFamily = FontFamily.Default,
                        fontSize = 13.sp,
                        color = SeekerClawColors.TextSecondary,
                        lineHeight = 20.sp,
                    )
                    OutlinedTextField(
                        value = wipeConfirmText,
                        onValueChange = { wipeConfirmText = it },
                        label = {
                            Text(
                                "Type WIPE to confirm",
                                fontFamily = FontFamily.Default,
                                fontSize = 13.sp,
                            )
                        },
                        singleLine = true,
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = SeekerClawColors.Error,
                            unfocusedBorderColor = SeekerClawColors.TextDim,
                            focusedLabelColor = SeekerClawColors.Error,
                            unfocusedLabelColor = SeekerClawColors.TextDim,
                            cursorColor = SeekerClawColors.Error,
                            focusedTextColor = SeekerClawColors.TextPrimary,
                            unfocusedTextColor = SeekerClawColors.TextPrimary,
                        ),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        ConfigManager.clearMemory(context)
                        Analytics.featureUsed("memory_wiped")
                        showClearMemoryDialog = false
                        wipeConfirmText = ""
                    },
                    enabled = wipeConfirmed,
                ) {
                    Text(
                        "Confirm",
                        fontFamily = FontFamily.Default,
                        fontWeight = FontWeight.Bold,
                        color = if (wipeConfirmed) SeekerClawColors.Error else SeekerClawColors.TextDim,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = {
                    showClearMemoryDialog = false
                    wipeConfirmText = ""
                }) {
                    Text(
                        "Cancel",
                        fontFamily = FontFamily.Default,
                        color = SeekerClawColors.TextDim,
                    )
                }
            },
            containerColor = SeekerClawColors.Surface,
            shape = shape,
        )
    }

    // ==================== MCP Server Add/Edit Dialog ====================
    if (showMcpDialog) {
        var mcpName by remember(editingMcpServer) { mutableStateOf(editingMcpServer?.name ?: "") }
        var mcpUrl by remember(editingMcpServer) { mutableStateOf(editingMcpServer?.url ?: "") }
        var mcpToken by remember(editingMcpServer) { mutableStateOf(editingMcpServer?.authToken ?: "") }

        AlertDialog(
            onDismissRequest = { showMcpDialog = false },
            title = {
                Text(
                    if (editingMcpServer != null) "Edit MCP Server" else "Add MCP Server",
                    fontFamily = FontFamily.Default,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.TextPrimary,
                )
            },
            text = {
                Column {
                    OutlinedTextField(
                        value = mcpName,
                        onValueChange = { mcpName = it },
                        label = { Text("Name", fontFamily = FontFamily.Default) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = SeekerClawColors.Accent,
                            unfocusedBorderColor = SeekerClawColors.BorderSubtle,
                            focusedTextColor = SeekerClawColors.TextPrimary,
                            unfocusedTextColor = SeekerClawColors.TextPrimary,
                            cursorColor = SeekerClawColors.Accent,
                            focusedLabelColor = SeekerClawColors.Accent,
                            unfocusedLabelColor = SeekerClawColors.TextDim,
                        ),
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    OutlinedTextField(
                        value = mcpUrl,
                        onValueChange = { mcpUrl = it },
                        label = { Text("Server URL", fontFamily = FontFamily.Default) },
                        placeholder = { Text("https://mcp.example.com/sse", color = SeekerClawColors.TextDim) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = SeekerClawColors.Accent,
                            unfocusedBorderColor = SeekerClawColors.BorderSubtle,
                            focusedTextColor = SeekerClawColors.TextPrimary,
                            unfocusedTextColor = SeekerClawColors.TextPrimary,
                            cursorColor = SeekerClawColors.Accent,
                            focusedLabelColor = SeekerClawColors.Accent,
                            unfocusedLabelColor = SeekerClawColors.TextDim,
                        ),
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    OutlinedTextField(
                        value = mcpToken,
                        onValueChange = { mcpToken = it },
                        label = { Text("Auth Token (optional)", fontFamily = FontFamily.Default) },
                        visualTransformation = PasswordVisualTransformation(),
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = SeekerClawColors.Accent,
                            unfocusedBorderColor = SeekerClawColors.BorderSubtle,
                            focusedTextColor = SeekerClawColors.TextPrimary,
                            unfocusedTextColor = SeekerClawColors.TextPrimary,
                            cursorColor = SeekerClawColors.Accent,
                            focusedLabelColor = SeekerClawColors.Accent,
                            unfocusedLabelColor = SeekerClawColors.TextDim,
                        ),
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        val trimName = mcpName.trim()
                        val trimUrl = mcpUrl.trim()
                        // Validate URL format before saving
                        val isValidUrl = try {
                            val uri = Uri.parse(trimUrl)
                            uri.scheme in listOf("https", "http") && !uri.host.isNullOrBlank()
                        } catch (_: Exception) { false }
                        if (!isValidUrl) {
                            Toast.makeText(context, "Invalid URL. Must start with https:// or http://", Toast.LENGTH_SHORT).show()
                            return@TextButton
                        }
                        // Warn if auth token + plain HTTP (non-localhost)
                        val trimToken = mcpToken.trim()
                        if (trimToken.isNotBlank()) {
                            val uri = Uri.parse(trimUrl)
                            val isHttps = uri.scheme == "https"
                            val isLocalhost = uri.host in listOf("localhost", "127.0.0.1")
                            if (!isHttps && !isLocalhost) {
                                Toast.makeText(context, "Auth token requires HTTPS (or localhost)", Toast.LENGTH_SHORT).show()
                                return@TextButton
                            }
                        }
                        if (trimName.isNotBlank() && trimUrl.isNotBlank()) {
                            val serverId = editingMcpServer?.id
                                ?: java.util.UUID.randomUUID().toString()
                            val server = if (editingMcpServer != null) {
                                editingMcpServer!!.copy(
                                    name = trimName,
                                    url = trimUrl,
                                    authToken = mcpToken.trim(),
                                )
                            } else {
                                McpServerConfig(
                                    id = serverId,
                                    name = trimName,
                                    url = trimUrl,
                                    authToken = mcpToken.trim(),
                                )
                            }
                            mcpServers = if (editingMcpServer != null) {
                                mcpServers.map { if (it.id == serverId) server else it }
                            } else {
                                mcpServers + server
                            }
                            ConfigManager.saveMcpServers(context, mcpServers)
                            showMcpDialog = false
                            showRestartDialog = true
                        }
                    },
                    enabled = mcpName.isNotBlank() && mcpUrl.isNotBlank(),
                ) {
                    Text(
                        "Save",
                        fontFamily = FontFamily.Default,
                        fontWeight = FontWeight.Bold,
                        color = if (mcpName.isNotBlank() && mcpUrl.isNotBlank()) SeekerClawColors.Accent else SeekerClawColors.TextDim,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showMcpDialog = false }) {
                    Text("Cancel", fontFamily = FontFamily.Default, color = SeekerClawColors.TextDim)
                }
            },
            containerColor = SeekerClawColors.Surface,
            shape = shape,
        )
    }

    // ==================== MCP Server Delete Dialog ====================
    if (showDeleteMcpDialog && deletingMcpServer != null) {
        AlertDialog(
            onDismissRequest = { showDeleteMcpDialog = false },
            title = {
                Text(
                    "Remove Server",
                    fontFamily = FontFamily.Default,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.TextPrimary,
                )
            },
            text = {
                Text(
                    "Remove \"${deletingMcpServer?.name}\"? Its tools will no longer be available to your agent.",
                    fontFamily = FontFamily.Default,
                    fontSize = 14.sp,
                    color = SeekerClawColors.TextSecondary,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    mcpServers = mcpServers.filter { it.id != deletingMcpServer?.id }
                    ConfigManager.saveMcpServers(context, mcpServers)
                    showDeleteMcpDialog = false
                    deletingMcpServer = null
                    showRestartDialog = true
                }) {
                    Text(
                        "Remove",
                        fontFamily = FontFamily.Default,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showDeleteMcpDialog = false }) {
                    Text("Cancel", fontFamily = FontFamily.Default, color = SeekerClawColors.TextDim)
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
        fontFamily = FontFamily.Default,
        fontSize = 11.sp,
        fontWeight = FontWeight.Medium,
        color = SeekerClawColors.TextSecondary,
        letterSpacing = 1.sp,
    )
}

@Composable
private fun CollapsibleSection(
    title: String,
    initiallyExpanded: Boolean = true,
    content: @Composable () -> Unit,
) {
    var expanded by remember { mutableStateOf(initiallyExpanded) }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { expanded = !expanded }
            .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = title,
            fontFamily = FontFamily.Default,
            fontSize = 11.sp,
            fontWeight = FontWeight.Medium,
            color = SeekerClawColors.TextSecondary,
            letterSpacing = 1.sp,
        )
        Icon(
            imageVector = if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
            contentDescription = if (expanded) "Collapse $title" else "Expand $title",
            tint = SeekerClawColors.TextDim,
            modifier = Modifier.size(20.dp),
        )
    }

    AnimatedVisibility(
        visible = expanded,
        enter = expandVertically(),
        exit = shrinkVertically(),
    ) {
        Column {
            Spacer(modifier = Modifier.height(10.dp))
            content()
        }
    }
}

@Composable
private fun ConfigField(
    label: String,
    value: String,
    onClick: (() -> Unit)? = null,
    showDivider: Boolean = true,
    info: String? = null,
    isRequired: Boolean = false,
) {
    var showInfo by remember { mutableStateOf(false) }

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
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = if (isRequired) Modifier.semantics(mergeDescendants = true) {
                    contentDescription = "$label, required"
                } else Modifier,
            ) {
                Text(
                    text = label,
                    fontFamily = FontFamily.Default,
                    fontSize = 12.sp,
                    color = SeekerClawColors.TextDim,
                )
                if (isRequired) {
                    Text(
                        text = " *",
                        fontSize = 12.sp,
                        color = SeekerClawColors.Error,
                    )
                }
                if (info != null) {
                    IconButton(
                        onClick = { showInfo = true },
                    ) {
                        Icon(
                            Icons.Outlined.Info,
                            contentDescription = "More info about $label",
                            tint = SeekerClawColors.TextDim,
                            modifier = Modifier.size(14.dp),
                        )
                    }
                }
            }
            if (onClick != null) {
                Text(
                    text = "Edit",
                    fontFamily = FontFamily.Default,
                    fontSize = 12.sp,
                    color = SeekerClawColors.TextInteractive,
                )
            }
        }
        Spacer(modifier = Modifier.height(2.dp))
        Text(
            text = value,
            fontFamily = FontFamily.Default,
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

    if (showInfo && info != null) {
        InfoDialog(title = label, message = info, onDismiss = { showInfo = false })
    }
}

@Composable
private fun SettingRow(
    label: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    info: String? = null,
) {
    val haptic = LocalHapticFeedback.current
    var showInfo by remember { mutableStateOf(false) }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = label,
                fontFamily = FontFamily.Default,
                fontSize = 14.sp,
                color = SeekerClawColors.TextPrimary,
            )
            if (info != null) {
                IconButton(onClick = { showInfo = true }) {
                    Icon(
                        Icons.Outlined.Info,
                        contentDescription = "More info about $label",
                        tint = SeekerClawColors.TextDim,
                        modifier = Modifier.size(14.dp),
                    )
                }
            }
        }
        Switch(
            checked = checked,
            onCheckedChange = {
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                onCheckedChange(it)
            },
            colors = SwitchDefaults.colors(
                checkedThumbColor = androidx.compose.ui.graphics.Color.White,
                checkedTrackColor = SeekerClawColors.ActionPrimary,
                uncheckedThumbColor = androidx.compose.ui.graphics.Color.White,
                uncheckedTrackColor = SeekerClawColors.BorderSubtle,
                uncheckedBorderColor = androidx.compose.ui.graphics.Color.Transparent,
            ),
        )
    }

    if (showInfo && info != null) {
        InfoDialog(title = label, message = info, onDismiss = { showInfo = false })
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
            fontFamily = FontFamily.Default,
            fontSize = 13.sp,
            color = SeekerClawColors.TextDim,
        )
        Text(
            text = value,
            fontFamily = FontFamily.Default,
            fontSize = 13.sp,
            color = SeekerClawColors.TextSecondary,
        )
    }
}

@Composable
private fun PermissionRow(
    label: String,
    granted: Boolean,
    onRequest: () -> Unit,
    info: String? = null,
) {
    val haptic = LocalHapticFeedback.current
    var showInfo by remember { mutableStateOf(false) }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = label,
                fontFamily = FontFamily.Default,
                fontSize = 14.sp,
                color = SeekerClawColors.TextPrimary,
            )
            if (info != null) {
                IconButton(onClick = { showInfo = true }) {
                    Icon(
                        Icons.Outlined.Info,
                        contentDescription = "More info about $label",
                        tint = SeekerClawColors.TextDim,
                        modifier = Modifier.size(14.dp),
                    )
                }
            }
        }
        Switch(
            checked = granted,
            onCheckedChange = {
                if (!granted) {
                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                    onRequest()
                }
            },
            colors = SwitchDefaults.colors(
                checkedThumbColor = androidx.compose.ui.graphics.Color.White,
                checkedTrackColor = SeekerClawColors.ActionPrimary,
                uncheckedThumbColor = androidx.compose.ui.graphics.Color.White,
                uncheckedTrackColor = SeekerClawColors.BorderSubtle,
                uncheckedBorderColor = androidx.compose.ui.graphics.Color.Transparent,
            ),
        )
    }

    if (showInfo && info != null) {
        InfoDialog(title = label, message = info, onDismiss = { showInfo = false })
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

private fun maskSensitive(value: String): String {
    if (value.isBlank()) return "Not set"
    if (value.length <= 8) return "*".repeat(value.length)
    return "${value.take(6)}${"*".repeat(8)}${value.takeLast(4)}"
}

@Composable
private fun InfoDialog(title: String, message: String, onDismiss: () -> Unit) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                text = title,
                fontFamily = FontFamily.Default,
                fontWeight = FontWeight.Bold,
                fontSize = 16.sp,
                color = SeekerClawColors.TextPrimary,
            )
        },
        text = {
            Text(
                text = message,
                fontFamily = FontFamily.Default,
                fontSize = 13.sp,
                color = SeekerClawColors.TextSecondary,
                lineHeight = 20.sp,
            )
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text(
                    "Got it",
                    fontFamily = FontFamily.Default,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.Primary,
                )
            }
        },
        containerColor = SeekerClawColors.Surface,
        shape = shape,
    )
}
