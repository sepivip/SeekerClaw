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
import com.seekerclaw.app.ui.components.SeekerClawSwitch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
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
import com.seekerclaw.app.ui.theme.RethinkSans
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
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import com.seekerclaw.app.config.ConfigClaimImport
import com.seekerclaw.app.config.ConfigClaimImporter
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.config.availableModels
import com.seekerclaw.app.config.searchProviderById
import com.seekerclaw.app.qr.QrScannerActivity
import com.seekerclaw.app.service.OpenClawService
import com.seekerclaw.app.solana.SolanaAuthActivity
import com.seekerclaw.app.ui.theme.SeekerClawColors
import com.seekerclaw.app.util.Analytics
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
import com.seekerclaw.app.BuildConfig
import com.seekerclaw.app.ui.components.CardSurface
import com.seekerclaw.app.ui.components.SectionLabel
import com.seekerclaw.app.ui.components.ConfigField
import com.seekerclaw.app.ui.components.InfoDialog
import com.seekerclaw.app.ui.components.InfoRow
import com.seekerclaw.app.ui.components.cornerGlowBorder
import com.seekerclaw.app.ui.theme.Sizing
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.util.Date

@Composable
fun SettingsScreen(
    onRunSetupAgain: () -> Unit = {},
    onNavigateToAiConfig: () -> Unit = {},
    onNavigateToChannelConfig: () -> Unit = {},
    onNavigateToSearchConfig: () -> Unit = {},
    onNavigateToMcpConfig: () -> Unit = {},
) {
    val context = LocalContext.current
    // Observe configVersion so UI refreshes when bridge saves owner ID (auto-detect)
    val configVer by ConfigManager.configVersion
    var config by remember(configVer) { mutableStateOf(ConfigManager.loadConfig(context)) }

    var autoStartOnBoot by remember {
        mutableStateOf(ConfigManager.getAutoStartOnBoot(context))
    }
    var analyticsEnabled by remember {
        mutableStateOf(Analytics.isEnabled(context))
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
                // Reload config (cross-process: bridge may have saved owner ID)
                config = ConfigManager.loadConfig(context)
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

    // MCP server count (for ConfigField display) — load off main thread to avoid jank
    var mcpServerCount by remember { mutableIntStateOf(0) }
    LaunchedEffect(configVer) {
        mcpServerCount = withContext(Dispatchers.IO) {
            ConfigManager.loadMcpServers(context).size
        }
    }

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
                if (success) "Memory imported. Restart agent to apply."
                else "Import failed. Ensure the file is a valid SeekerClaw backup.",
                Toast.LENGTH_LONG
            ).show()
        }
    }

    val scope = rememberCoroutineScope()

    val skillsExportLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.CreateDocument("application/zip")
    ) { uri ->
        if (uri != null) {
            scope.launch {
                val success = withContext(Dispatchers.IO) { ConfigManager.exportUserSkills(context, uri) }
                Analytics.featureUsed("skills_bulk_exported")
                Toast.makeText(
                    context,
                    if (success) "Skills exported" else "No added skills to export",
                    Toast.LENGTH_SHORT,
                ).show()
            }
        }
    }

    val skillsImportLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenDocument()
    ) { uri ->
        if (uri != null) {
            scope.launch {
                val count = withContext(Dispatchers.IO) { ConfigManager.importUserSkills(context, uri) }
                Analytics.featureUsed("skills_imported")
                if (count > 0) {
                    Toast.makeText(
                        context,
                        "Imported $count skill${if (count > 1) "s" else ""}",
                        Toast.LENGTH_SHORT,
                    ).show()
                } else {
                    Toast.makeText(
                        context,
                        if (count == 0) "No skills found in file" else "Import failed",
                        Toast.LENGTH_SHORT,
                    ).show()
                }
            }
        }
    }

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

    val authTypeLabel = if (config?.authType == "setup_token") "Pro/Max Setup Token" else "API Key"
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
            fontFamily = RethinkSans,
            fontSize = 24.sp,
            fontWeight = FontWeight.Bold,
            color = SeekerClawColors.TextPrimary,
        )

        Spacer(modifier = Modifier.height(28.dp))

        // Configuration
        CollapsibleSection("Configuration", initiallyExpanded = true) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SeekerClawColors.Surface, shape)
                    .cornerGlowBorder(),
            ) {
                ConfigField(
                    label = "AI Configuration",
                    value = "Provider, Model, Keys",
                    onClick = onNavigateToAiConfig,
                    info = "Select AI provider, configure model and API credentials.",
                )
                ConfigField(
                    label = "Channel",
                    value = if (config?.channel == "discord") "Discord" else "Telegram",
                    onClick = onNavigateToChannelConfig,
                    info = "Select messaging channel and configure bot credentials.",
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
                    label = "Heartbeat Interval",
                    value = "Every ${config?.heartbeatIntervalMinutes ?: 30} minutes",
                    onClick = {
                        editField = "heartbeatIntervalMinutes"
                        editLabel = "Heartbeat Interval (minutes, 5–120)"
                        editValue = (config?.heartbeatIntervalMinutes ?: 30).toString()
                    },
                    info = SettingsHelpTexts.HEARTBEAT_INTERVAL,
                )
                ConfigField(
                    label = "Search Provider",
                    value = searchProviderById(config?.searchProvider ?: "brave").displayName +
                        if ((config?.activeSearchApiKey ?: "").isBlank()) " (not configured)" else "",
                    onClick = onNavigateToSearchConfig,
                    info = SettingsHelpTexts.SEARCH_PROVIDER,
                    showDivider = true,
                )
                ConfigField(
                    label = "MCP Servers",
                    value = "$mcpServerCount server${if (mcpServerCount != 1) "s" else ""} configured",
                    onClick = onNavigateToMcpConfig,
                    info = SettingsHelpTexts.MCP_SERVERS,
                    showDivider = false,
                )
            }
        }

        Spacer(modifier = Modifier.height(28.dp))

        // Preferences & Permissions
        CollapsibleSection("Preferences & Permissions", initiallyExpanded = true) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SeekerClawColors.Surface, shape)
                    .cornerGlowBorder()
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
                    label = "Usage analytics",
                    checked = analyticsEnabled,
                    onCheckedChange = {
                        analyticsEnabled = it
                        Analytics.setEnabled(context, it)
                    },
                    info = SettingsHelpTexts.ANALYTICS,
                )
                PermissionRow(
                    label = "Battery unrestricted",
                    granted = batteryOptimizationDisabled,
                    onRequest = {
                        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                            data = Uri.parse("package:${context.packageName}")
                        }
                        context.startActivity(intent)
                    },
                    onOpenSettings = { openAppSettings(context) },
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
                val allPermissionsOff = !hasCameraPermission && !hasLocationPermission &&
                    !hasContactsPermission && !hasSmsPermission && !hasCallPermission
                if (allPermissionsOff) {
                    Text(
                        text = "Enable permissions to unlock device features (camera, GPS, SMS, etc.)",
                        fontFamily = RethinkSans,
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
                    onOpenSettings = { openAppSettings(context) },
                    info = SettingsHelpTexts.CAMERA,
                )
                PermissionRow(
                    label = "GPS Location",
                    granted = hasLocationPermission,
                    onRequest = {
                        requestPermissionOrOpenSettings(context, Manifest.permission.ACCESS_FINE_LOCATION, locationLauncher)
                    },
                    onOpenSettings = { openAppSettings(context) },
                    info = SettingsHelpTexts.GPS_LOCATION,
                )
                PermissionRow(
                    label = "Contacts",
                    granted = hasContactsPermission,
                    onRequest = {
                        requestPermissionOrOpenSettings(context, Manifest.permission.READ_CONTACTS, contactsLauncher)
                    },
                    onOpenSettings = { openAppSettings(context) },
                    info = SettingsHelpTexts.CONTACTS,
                )
                // SMS permission only on dappStore — googlePlay uses intent handoff (no permission needed)
                if (BuildConfig.DISTRIBUTION == "dappStore") {
                    PermissionRow(
                        label = "SMS",
                        granted = hasSmsPermission,
                        onRequest = {
                            requestPermissionOrOpenSettings(context, Manifest.permission.SEND_SMS, smsLauncher)
                        },
                        onOpenSettings = { openAppSettings(context) },
                        info = SettingsHelpTexts.SMS,
                    )
                }
                PermissionRow(
                    label = "Phone Calls",
                    granted = hasCallPermission,
                    onRequest = {
                        requestPermissionOrOpenSettings(context, Manifest.permission.CALL_PHONE, callLauncher)
                    },
                    onOpenSettings = { openAppSettings(context) },
                    info = SettingsHelpTexts.PHONE_CALLS,
                )
            }
        }

        Spacer(modifier = Modifier.height(28.dp))

        // Solana Wallet
        CollapsibleSection("Solana Wallet", initiallyExpanded = false) {
            CardSurface {
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
                            fontFamily = RethinkSans,
                            fontSize = 13.sp,
                            color = SeekerClawColors.TextDim,
                        )
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                text = "${address.take(6)}\u2026${address.takeLast(4)}",
                                fontFamily = RethinkSans,
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
                    InfoRow("Wallet", label, isLast = true)
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
                    Text("Disconnect Wallet", fontFamily = RethinkSans, fontSize = 14.sp)
                }
            } else {
                // Not connected — show Connect button
                if (walletError != null) {
                    Text(
                        text = walletError!!,
                        fontFamily = RethinkSans,
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
                        .height(48.dp)
                        .cornerGlowBorder(),
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
                        Text("Connecting\u2026", fontFamily = RethinkSans, fontSize = 14.sp)
                    } else {
                        Text("Connect Wallet", fontFamily = RethinkSans, fontSize = 14.sp, fontWeight = FontWeight.Bold)
                    }
                }

                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = "Opens Phantom, Solflare, or Seeker Vault",
                    fontFamily = RethinkSans,
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
                showDivider = true,
                info = SettingsHelpTexts.JUPITER_API_KEY,
            )

            // Helius API Key (NFT holdings)
            Spacer(modifier = Modifier.height(20.dp))
            ConfigField(
                label = "Helius API Key",
                value = config?.heliusApiKey?.let { key ->
                    if (key.isBlank()) "Not set — NFT holdings disabled"
                    else if (key.length > 12) "${key.take(8)}${"*".repeat(8)}${key.takeLast(4)}"
                    else "*".repeat(key.length)
                } ?: "Not set — NFT holdings disabled",
                onClick = {
                    editField = "heliusApiKey"
                    editLabel = "Helius API Key"
                    editValue = config?.heliusApiKey ?: ""
                },
                showDivider = false,
                info = SettingsHelpTexts.HELIUS_API_KEY,
            )
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
                        fontFamily = RethinkSans,
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
                        fontFamily = RethinkSans,
                        fontSize = 14.sp,
                    )
                }

                Spacer(modifier = Modifier.height(8.dp))

                OutlinedButton(
                    onClick = {
                        val timestamp = android.text.format.DateFormat.format("yyyyMMdd", java.util.Date())
                        skillsExportLauncher.launch("seekerclaw_skills_$timestamp.zip")
                    },
                    modifier = Modifier.fillMaxWidth(),
                    shape = shape,
                    border = androidx.compose.foundation.BorderStroke(1.dp, SeekerClawColors.BorderSubtle),
                    colors = ButtonDefaults.outlinedButtonColors(
                        contentColor = SeekerClawColors.TextPrimary,
                    ),
                ) {
                    Text(
                        "Export Skills",
                        fontFamily = RethinkSans,
                        fontSize = 14.sp,
                    )
                }

                Spacer(modifier = Modifier.height(8.dp))

                OutlinedButton(
                    onClick = {
                        skillsImportLauncher.launch(arrayOf("application/zip", "text/markdown", "text/plain"))
                    },
                    modifier = Modifier.fillMaxWidth(),
                    shape = shape,
                    border = androidx.compose.foundation.BorderStroke(1.dp, SeekerClawColors.BorderSubtle),
                    colors = ButtonDefaults.outlinedButtonColors(
                        contentColor = SeekerClawColors.TextPrimary,
                    ),
                ) {
                    Text(
                        "Import Skills",
                        fontFamily = RethinkSans,
                        fontSize = 14.sp,
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(28.dp))

        // Setup — combines Scan QR (primary) + Run Setup Again (secondary)
        CollapsibleSection("Setup", initiallyExpanded = true) {
            // Primary: Scan Config QR
            Button(
                onClick = {
                    if (!isConfigImporting) {
                        Analytics.featureUsed("qr_scan")
                        qrConfigLauncher.launch(Intent(context, QrScannerActivity::class.java))
                    }
                },
                enabled = !isConfigImporting,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(Sizing.buttonPrimaryHeight)
                    .cornerGlowBorder(),
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
                    Text("Importing Config\u2026", fontFamily = RethinkSans, fontSize = 14.sp)
                } else {
                    Icon(
                        Icons.Default.QrCodeScanner,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        "Scan Config QR",
                        fontFamily = RethinkSans,
                        fontWeight = FontWeight.Bold,
                        fontSize = 14.sp,
                    )
                }
            }

            Spacer(modifier = Modifier.height(8.dp))

            // Secondary: Run Setup Again
            OutlinedButton(
                onClick = { showRunSetupDialog = true },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(Sizing.buttonSecondaryHeight)
                    .cornerGlowBorder(),
                shape = shape,
                border = androidx.compose.foundation.BorderStroke(1.dp, SeekerClawColors.BorderSubtle),
                colors = ButtonDefaults.outlinedButtonColors(
                    contentColor = SeekerClawColors.TextPrimary,
                ),
            ) {
                Text(
                    "Run Setup Again",
                    fontFamily = RethinkSans,
                    fontSize = 14.sp,
                )
            }

            Spacer(modifier = Modifier.height(10.dp))

            Text(
                text = "Generate a config QR at seekerclaw.xyz to set up your agent in seconds.",
                fontFamily = RethinkSans,
                fontSize = 12.sp,
                color = SeekerClawColors.TextDim,
            )

            if (configImportError != null) {
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = configImportError ?: "",
                    fontFamily = RethinkSans,
                    fontSize = 12.sp,
                    color = SeekerClawColors.Error,
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
                        fontFamily = RethinkSans,
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
                        fontFamily = RethinkSans,
                        fontWeight = FontWeight.Bold,
                        fontSize = 14.sp,
                    )
                }
            }
        }


        // System info
        SectionLabel("System")

        Spacer(modifier = Modifier.height(10.dp))

        CardSurface {
            InfoRow("Version", "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
            InfoRow("Claw Engine", BuildConfig.OPENCLAW_VERSION)
            InfoRow("Node.js", BuildConfig.NODEJS_VERSION, isLast = true)
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
                    fontFamily = RethinkSans,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.TextPrimary,
                )
            },
            text = {
                Column {
                    if (editField == "jupiterApiKey" || editField == "heliusApiKey") {
                        Text(
                            "Changing this requires an agent restart.",
                            fontFamily = RethinkSans,
                            fontSize = 12.sp,
                            color = SeekerClawColors.Warning,
                            modifier = Modifier.padding(bottom = 12.dp),
                        )
                    }
                    OutlinedTextField(
                        value = editValue,
                        onValueChange = { editValue = it },
                        label = { Text(editLabel, fontFamily = RethinkSans, fontSize = 12.sp) },
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
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        val field = editField ?: return@TextButton
                        val trimmed = editValue.trim()
                        if (field == "jupiterApiKey" || field == "heliusApiKey") {
                            // Allow empty to disable swaps/NFT holdings
                            saveField(field, trimmed)
                        } else if (trimmed.isNotEmpty()) {
                            saveField(field, trimmed)
                        }
                        editField = null
                    },
                ) {
                    Text(
                        "Save",
                        fontFamily = RethinkSans,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.ActionPrimary,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { editField = null }) {
                    Text(
                        "Cancel",
                        fontFamily = RethinkSans,
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
        RestartDialog(
            context = context,
            onDismiss = { showRestartDialog = false },
        )
    }

    // ==================== Reset Config Dialog ====================
    if (showResetDialog) {
        AlertDialog(
            onDismissRequest = { showResetDialog = false },
            title = {
                Text(
                    "Reset Config",
                    fontFamily = RethinkSans,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.Error,
                )
            },
            text = {
                Text(
                    "This will stop the agent, clear all config, and return to setup. This cannot be undone.",
                    fontFamily = RethinkSans,
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
                        fontFamily = RethinkSans,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showResetDialog = false }) {
                    Text(
                        "Cancel",
                        fontFamily = RethinkSans,
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
                    fontFamily = RethinkSans,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.Warning,
                )
            },
            text = {
                Text(
                    "This will overwrite personality, memory, and skills with the backup. A safety backup is created automatically before importing.",
                    fontFamily = RethinkSans,
                    fontSize = 13.sp,
                    color = SeekerClawColors.TextSecondary,
                    lineHeight = 20.sp,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    showImportDialog = false
                    importLauncher.launch(arrayOf("application/zip", "application/octet-stream"))
                }) {
                    Text(
                        "Select File",
                        fontFamily = RethinkSans,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Warning,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showImportDialog = false }) {
                    Text(
                        "Cancel",
                        fontFamily = RethinkSans,
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
                    fontFamily = RethinkSans,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.Warning,
                )
            },
            text = {
                Text(
                    "Schema: v${imported.schemaVersion}\n" +
                        "Source: $source\n" +
                        "Auth: ${if (importedConfig.authType == "setup_token") "Pro/Max Setup Token" else "API Key"}\n" +
                        "Credential: $maskedCredential\n" +
                        "Bot Token: $maskedBot\n" +
                        "Owner ID: ${importedConfig.telegramOwnerId.ifBlank { "Auto-detect" }}\n" +
                        "Model: ${importedConfig.model}\n" +
                        "Agent: ${importedConfig.agentName}\n" +
                        "Auto-start on boot: $autoStartSummary\n" +
                        "Server mode: $keepScreenSummary\n\n" +
                        "Apply this configuration to your device?",
                    fontFamily = RethinkSans,
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
                        fontFamily = RethinkSans,
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
                        fontFamily = RethinkSans,
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
                    fontFamily = RethinkSans,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.TextPrimary,
                )
            },
            text = {
                Text(
                    "This will restart the setup flow. Your current config will be overwritten when you complete setup.",
                    fontFamily = RethinkSans,
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
                        fontFamily = RethinkSans,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Primary,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showRunSetupDialog = false }) {
                    Text(
                        "Cancel",
                        fontFamily = RethinkSans,
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
                    fontFamily = RethinkSans,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.Error,
                )
            },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(
                        "This will delete all memory files. The agent will lose all accumulated knowledge. This cannot be undone.",
                        fontFamily = RethinkSans,
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
                                fontFamily = RethinkSans,
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
                        fontFamily = RethinkSans,
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
                        fontFamily = RethinkSans,
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
private fun CollapsibleSection(
    title: String,
    initiallyExpanded: Boolean = true,
    content: @Composable () -> Unit,
) {
    var expanded by rememberSaveable(key = "section_$title") { mutableStateOf(initiallyExpanded) }

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
            fontFamily = RethinkSans,
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
                fontFamily = RethinkSans,
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
        SeekerClawSwitch(
            checked = checked,
            onCheckedChange = {
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                onCheckedChange(it)
            },
        )
    }

    if (showInfo && info != null) {
        InfoDialog(title = label, message = info, onDismiss = { showInfo = false })
    }
}

@Composable
private fun PermissionRow(
    label: String,
    granted: Boolean,
    onRequest: () -> Unit,
    onOpenSettings: () -> Unit = {},
    info: String? = null,
) {
    val haptic = LocalHapticFeedback.current
    var showInfo by remember { mutableStateOf(false) }
    var showRevokeDialog by remember { mutableStateOf(false) }

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
                fontFamily = RethinkSans,
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
        SeekerClawSwitch(
            checked = granted,
            onCheckedChange = {
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                if (granted) {
                    showRevokeDialog = true
                } else {
                    onRequest()
                }
            },
        )
    }

    if (showInfo && info != null) {
        InfoDialog(title = label, message = info, onDismiss = { showInfo = false })
    }

    if (showRevokeDialog) {
        RevokePermissionDialog(
            permissionLabel = label,
            onOpenSettings = { showRevokeDialog = false; onOpenSettings() },
            onDismiss = { showRevokeDialog = false },
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

private fun openAppSettings(context: Context) {
    val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
        data = Uri.parse("package:${context.packageName}")
    }
    context.startActivity(intent)
}

@Composable
private fun RevokePermissionDialog(
    permissionLabel: String,
    onOpenSettings: () -> Unit,
    onDismiss: () -> Unit,
) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                text = "Disable $permissionLabel",
                fontFamily = RethinkSans,
                fontWeight = FontWeight.SemiBold,
                fontSize = 16.sp,
                color = SeekerClawColors.TextPrimary,
            )
        },
        text = {
            Text(
                text = "Android doesn't allow apps to revoke their own permissions.\n\nTo disable $permissionLabel, go to:\nSystem Settings \u2192 Apps \u2192 SeekerClaw \u2192 Permissions",
                fontFamily = RethinkSans,
                fontSize = 14.sp,
                color = SeekerClawColors.TextSecondary,
                lineHeight = 20.sp,
            )
        },
        confirmButton = {
            Button(
                onClick = onOpenSettings,
                colors = ButtonDefaults.buttonColors(containerColor = SeekerClawColors.ActionPrimary),
                shape = shape,
            ) {
                Text("Open Settings", fontFamily = RethinkSans, fontWeight = FontWeight.Medium)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel", fontFamily = RethinkSans, color = SeekerClawColors.TextSecondary)
            }
        },
        containerColor = SeekerClawColors.Surface,
        shape = shape,
    )
}

private fun maskSensitive(value: String): String {
    if (value.isBlank()) return "Not set"
    if (value.length <= 8) return "*".repeat(value.length)
    return "${value.take(6)}${"*".repeat(8)}${value.takeLast(4)}"
}

