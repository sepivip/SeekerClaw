package com.seekerclaw.app.ui.settings

import android.Manifest
import android.app.Activity
import android.app.LocaleManager
import androidx.compose.material3.HorizontalDivider
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.LocaleList
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
import androidx.compose.foundation.selection.selectable
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
import androidx.compose.ui.res.stringResource
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
import com.seekerclaw.app.config.searchProviderById
import com.seekerclaw.app.qr.QrScannerActivity
import com.seekerclaw.app.service.OpenClawService
import com.seekerclaw.app.solana.SolanaAuthActivity
import com.seekerclaw.app.ui.theme.SeekerClawColors
import com.seekerclaw.app.util.Analytics
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
import com.seekerclaw.app.BuildConfig
import com.seekerclaw.app.R
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
    onNavigateToTelegram: () -> Unit = {},
    onNavigateToSearchConfig: () -> Unit = {}
) {
    val context = LocalContext.current
    var config by remember { mutableStateOf(ConfigManager.loadConfig(context)) }

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
                        walletError = if (error.isNotBlank()) error else context.getString(R.string.toast_connection_cancelled)
                        resultFile.delete()
                    } else {
                        walletError = context.getString(R.string.toast_connection_cancelled)
                    }
                } catch (_: Exception) {
                    walletError = context.getString(R.string.toast_connection_failed)
                }
            } else {
                walletError = context.getString(R.string.toast_connection_cancelled)
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
                if (success) context.getString(R.string.toast_memory_exported) else context.getString(R.string.toast_export_failed),
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
                if (success) context.getString(R.string.toast_memory_imported)
                else context.getString(R.string.toast_memory_import_failed),
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
                    if (success) context.getString(R.string.toast_skills_exported) else context.getString(R.string.toast_no_skills_to_export),
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
                        context.resources.getQuantityString(R.plurals.toast_skills_imported, count, count),
                        Toast.LENGTH_SHORT,
                    ).show()
                } else {
                    Toast.makeText(
                        context,
                        if (count == 0) context.getString(R.string.toast_no_skills_in_file) else context.getString(R.string.toast_import_failed),
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
            configImportError = context.getString(R.string.toast_no_qr_data)
            Toast.makeText(context, context.getString(R.string.toast_no_qr_data), Toast.LENGTH_SHORT).show()
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
                configImportError = err.message ?: context.getString(R.string.toast_config_import_failed)
                Toast.makeText(context, configImportError, Toast.LENGTH_LONG).show()
            }
        }
    }

    fun saveField(field: String, value: String) {
        ConfigManager.updateConfigField(context, field, value)
        config = ConfigManager.loadConfig(context)
        showRestartDialog = true
    }

    val notSetLabel = stringResource(R.string.label_not_set)
    val authTypeLabel = if (config?.authType == "setup_token") stringResource(R.string.dialog_apply_config_auth_setup_token) else stringResource(R.string.dialog_apply_config_auth_api_key)
    val maskedApiKey = config?.anthropicApiKey?.let { key ->
        if (key.isBlank()) notSetLabel
        else if (key.length > 12) "${key.take(8)}${"*".repeat(8)}${key.takeLast(4)}" else "*".repeat(key.length)
    } ?: notSetLabel
    val maskedSetupToken = config?.setupToken?.let { token ->
        if (token.isBlank()) notSetLabel
        else if (token.length > 12) "${token.take(8)}${"*".repeat(8)}${token.takeLast(4)}" else "*".repeat(token.length)
    } ?: notSetLabel
    val maskedBotToken = config?.telegramBotToken?.let { token ->
        if (token.isBlank()) notSetLabel
        else if (token.length > 10) "${token.take(6)}${"*".repeat(8)}${token.takeLast(4)}"
        else "*".repeat(token.length)
    } ?: notSetLabel

    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(SeekerClawColors.Background)
            .padding(20.dp)
            .verticalScroll(rememberScrollState()),
    ) {
        Text(
            text = stringResource(R.string.settings_title),
            fontFamily = RethinkSans,
            fontSize = 24.sp,
            fontWeight = FontWeight.Bold,
            color = SeekerClawColors.TextPrimary,
        )

        Spacer(modifier = Modifier.height(28.dp))

        // Quick Setup — QR Config Import
        SectionLabel(stringResource(R.string.settings_section_quick_setup))

        Spacer(modifier = Modifier.height(10.dp))

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(SeekerClawColors.Surface, shape)
                .padding(16.dp),
        ) {
            Text(
                text = stringResource(R.string.settings_qr_description),
                fontFamily = RethinkSans,
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
                    Text(stringResource(R.string.settings_importing_config), fontFamily = RethinkSans, fontSize = 14.sp)
                } else {
                    Text(
                        stringResource(R.string.settings_scan_config_qr),
                        fontFamily = RethinkSans,
                        fontWeight = FontWeight.Bold,
                        fontSize = 14.sp,
                    )
                }
            }

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

        Spacer(modifier = Modifier.height(28.dp))

        // Configuration
        CollapsibleSection(stringResource(R.string.settings_section_configuration), initiallyExpanded = true) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SeekerClawColors.Surface, shape),
            ) {
                ConfigField(
                    label = stringResource(R.string.settings_ai_configuration),
                    value = stringResource(R.string.settings_ai_configuration_value),
                    onClick = onNavigateToAiConfig,
                    info = stringResource(R.string.settings_ai_configuration_info),
                )
                ConfigField(
                    label = stringResource(R.string.settings_telegram),
                    value = stringResource(R.string.settings_telegram_value),
                    onClick = onNavigateToTelegram,
                    info = stringResource(R.string.settings_telegram_info),
                )
                val agentNameLabel = stringResource(R.string.settings_agent_name)
                val agentNameDefault = stringResource(R.string.settings_agent_name_default)
                ConfigField(
                    label = agentNameLabel,
                    value = config?.agentName?.ifBlank { agentNameDefault } ?: agentNameDefault,
                    onClick = {
                        editField = "agentName"
                        editLabel = agentNameLabel
                        editValue = config?.agentName ?: ""
                    },
                    info = SettingsHelpTexts.AGENT_NAME,
                )
                val heartbeatLabel = stringResource(R.string.settings_heartbeat_interval)
                val heartbeatEditLabel = stringResource(R.string.settings_heartbeat_edit_label)
                ConfigField(
                    label = heartbeatLabel,
                    value = stringResource(R.string.settings_heartbeat_value, config?.heartbeatIntervalMinutes ?: 30),
                    onClick = {
                        editField = "heartbeatIntervalMinutes"
                        editLabel = heartbeatEditLabel
                        editValue = (config?.heartbeatIntervalMinutes ?: 30).toString()
                    },
                    info = SettingsHelpTexts.HEARTBEAT_INTERVAL,
                )
                ConfigField(
                    label = stringResource(R.string.settings_search_provider),
                    value = searchProviderById(config?.searchProvider ?: "brave").displayName +
                        if ((config?.activeSearchApiKey ?: "").isBlank()) stringResource(R.string.settings_not_configured) else "",
                    onClick = onNavigateToSearchConfig,
                    info = SettingsHelpTexts.SEARCH_PROVIDER,
                    showDivider = false,
                )
            }
        }

        Spacer(modifier = Modifier.height(28.dp))

        // Preferences & Permissions
        CollapsibleSection(stringResource(R.string.settings_section_prefs_permissions), initiallyExpanded = true) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SeekerClawColors.Surface, shape)
                    .padding(horizontal = 16.dp),
            ) {
                SettingRow(
                    label = stringResource(R.string.settings_auto_start),
                    checked = autoStartOnBoot,
                    onCheckedChange = {
                        autoStartOnBoot = it
                        ConfigManager.setAutoStartOnBoot(context, it)
                    },
                    info = SettingsHelpTexts.AUTO_START,
                )
                SettingRow(
                    label = stringResource(R.string.settings_analytics),
                    checked = analyticsEnabled,
                    onCheckedChange = {
                        analyticsEnabled = it
                        Analytics.setEnabled(context, it)
                    },
                    info = SettingsHelpTexts.ANALYTICS,
                )
                PermissionRow(
                    label = stringResource(R.string.settings_battery_unrestricted),
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
                    label = stringResource(R.string.settings_server_mode),
                    checked = keepScreenOn,
                    onCheckedChange = {
                        keepScreenOn = it
                        ConfigManager.setKeepScreenOn(context, it)
                        showRestartDialog = true
                    },
                    info = SettingsHelpTexts.SERVER_MODE,
                )

                // Language picker — per-app locale (API 33+)
                val localeManager = remember { context.getSystemService(LocaleManager::class.java) }
                if (localeManager != null) {
                    val currentLocales = localeManager.applicationLocales
                    val currentLangTag = if (currentLocales.isEmpty) "" else currentLocales.get(0)?.toLanguageTag() ?: ""
                    val languageOptions = listOf(
                        "" to stringResource(R.string.language_system_default),
                        "en" to stringResource(R.string.language_english),
                        "zh-CN" to stringResource(R.string.language_chinese_simplified),
                    )
                    var languageExpanded by remember { mutableStateOf(false) }
                    val currentLabel = languageOptions.firstOrNull { it.first == currentLangTag }?.second
                        ?: languageOptions.firstOrNull { it.first.isNotEmpty() && currentLangTag.startsWith(it.first) }?.second
                        ?: stringResource(R.string.language_system_default)

                    HorizontalDivider(color = SeekerClawColors.CardBorder)
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { languageExpanded = !languageExpanded }
                            .padding(vertical = 14.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = stringResource(R.string.settings_language),
                            fontFamily = RethinkSans,
                            fontSize = 14.sp,
                            color = SeekerClawColors.TextPrimary,
                        )
                        Text(
                            text = currentLabel,
                            fontFamily = RethinkSans,
                            fontSize = 14.sp,
                            color = SeekerClawColors.TextSecondary,
                        )
                    }
                    AnimatedVisibility(visible = languageExpanded) {
                        Column(
                            modifier = Modifier.padding(bottom = 8.dp),
                        ) {
                            languageOptions.forEach { (tag, label) ->
                                val isSelected = tag == currentLangTag ||
                                    (tag.isNotEmpty() && currentLangTag.startsWith(tag))
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .selectable(
                                            selected = isSelected,
                                            role = androidx.compose.ui.semantics.Role.RadioButton,
                                            onClick = {
                                                val newLocales = if (tag.isEmpty()) {
                                                    LocaleList.getEmptyLocaleList()
                                                } else {
                                                    LocaleList.forLanguageTags(tag)
                                                }
                                                localeManager.applicationLocales = newLocales
                                                languageExpanded = false
                                            },
                                        )
                                        .padding(vertical = 10.dp, horizontal = 8.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    RadioButton(
                                        selected = isSelected,
                                        onClick = null,
                                        colors = RadioButtonDefaults.colors(
                                            selectedColor = SeekerClawColors.Accent,
                                            unselectedColor = SeekerClawColors.TextSecondary,
                                        ),
                                    )
                                    Text(
                                        text = label,
                                        fontFamily = RethinkSans,
                                        fontSize = 14.sp,
                                    color = if (isSelected) SeekerClawColors.TextPrimary else SeekerClawColors.TextSecondary,
                                    modifier = Modifier.padding(start = 8.dp),
                                )
                            }
                        }
                    }
                }
                } // localeManager null check

                val allPermissionsOff = !hasCameraPermission && !hasLocationPermission &&
                    !hasContactsPermission && !hasSmsPermission && !hasCallPermission
                if (allPermissionsOff) {
                    Text(
                        text = stringResource(R.string.settings_permissions_hint),
                        fontFamily = RethinkSans,
                        fontSize = 12.sp,
                        color = SeekerClawColors.TextSecondary,
                        lineHeight = 18.sp,
                        modifier = Modifier.padding(top = 12.dp, bottom = 4.dp),
                    )
                }
                PermissionRow(
                    label = stringResource(R.string.permission_camera),
                    granted = hasCameraPermission,
                    onRequest = {
                        requestPermissionOrOpenSettings(context, Manifest.permission.CAMERA, cameraLauncher)
                    },
                    onOpenSettings = { openAppSettings(context) },
                    info = SettingsHelpTexts.CAMERA,
                )
                PermissionRow(
                    label = stringResource(R.string.permission_gps),
                    granted = hasLocationPermission,
                    onRequest = {
                        requestPermissionOrOpenSettings(context, Manifest.permission.ACCESS_FINE_LOCATION, locationLauncher)
                    },
                    onOpenSettings = { openAppSettings(context) },
                    info = SettingsHelpTexts.GPS_LOCATION,
                )
                PermissionRow(
                    label = stringResource(R.string.permission_contacts),
                    granted = hasContactsPermission,
                    onRequest = {
                        requestPermissionOrOpenSettings(context, Manifest.permission.READ_CONTACTS, contactsLauncher)
                    },
                    onOpenSettings = { openAppSettings(context) },
                    info = SettingsHelpTexts.CONTACTS,
                )
                PermissionRow(
                    label = stringResource(R.string.permission_sms),
                    granted = hasSmsPermission,
                    onRequest = {
                        requestPermissionOrOpenSettings(context, Manifest.permission.SEND_SMS, smsLauncher)
                    },
                    onOpenSettings = { openAppSettings(context) },
                    info = SettingsHelpTexts.SMS,
                )
                PermissionRow(
                    label = stringResource(R.string.permission_phone),
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
        CollapsibleSection(stringResource(R.string.settings_section_solana_wallet), initiallyExpanded = false) {
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
                            text = stringResource(R.string.wallet_address),
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
                                    Toast.makeText(context, context.getString(R.string.toast_address_copied), Toast.LENGTH_SHORT).show()
                                },
                                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp),
                            ) {
                                Text(
                                    text = stringResource(R.string.wallet_copy),
                                    fontSize = 12.sp,
                                    color = SeekerClawColors.TextInteractive,
                                )
                            }
                        }
                    }

                val label = ConfigManager.getWalletLabel(context)
                if (label.isNotBlank()) {
                    Spacer(modifier = Modifier.height(4.dp))
                    InfoRow(stringResource(R.string.wallet_label), label)
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
                    Text(stringResource(R.string.wallet_disconnect), fontFamily = RethinkSans, fontSize = 14.sp)
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
                        Text(stringResource(R.string.wallet_connecting), fontFamily = RethinkSans, fontSize = 14.sp)
                    } else {
                        Text(stringResource(R.string.wallet_connect), fontFamily = RethinkSans, fontSize = 14.sp, fontWeight = FontWeight.Bold)
                    }
                }

                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = stringResource(R.string.wallet_connect_hint),
                    fontFamily = RethinkSans,
                    fontSize = 11.sp,
                    color = SeekerClawColors.TextDim,
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            // Jupiter API Key (Solana swaps)
            Spacer(modifier = Modifier.height(20.dp))
            val jupiterLabel = stringResource(R.string.wallet_jupiter_api_key)
            val jupiterNotSet = stringResource(R.string.wallet_jupiter_not_set)
            ConfigField(
                label = jupiterLabel,
                value = config?.jupiterApiKey?.let { key ->
                    if (key.isBlank()) jupiterNotSet
                    else if (key.length > 12) "${key.take(8)}${"*".repeat(8)}${key.takeLast(4)}"
                    else "*".repeat(key.length)
                } ?: jupiterNotSet,
                onClick = {
                    editField = "jupiterApiKey"
                    editLabel = jupiterLabel
                    editValue = config?.jupiterApiKey ?: ""
                },
                showDivider = true,
                info = SettingsHelpTexts.JUPITER_API_KEY,
            )

            // Helius API Key (NFT holdings)
            Spacer(modifier = Modifier.height(20.dp))
            val heliusLabel = stringResource(R.string.wallet_helius_api_key)
            val heliusNotSet = stringResource(R.string.wallet_helius_not_set)
            ConfigField(
                label = heliusLabel,
                value = config?.heliusApiKey?.let { key ->
                    if (key.isBlank()) heliusNotSet
                    else if (key.length > 12) "${key.take(8)}${"*".repeat(8)}${key.takeLast(4)}"
                    else "*".repeat(key.length)
                } ?: heliusNotSet,
                onClick = {
                    editField = "heliusApiKey"
                    editLabel = heliusLabel
                    editValue = config?.heliusApiKey ?: ""
                },
                showDivider = false,
                info = SettingsHelpTexts.HELIUS_API_KEY,
            )
            }
        }

        Spacer(modifier = Modifier.height(28.dp))

        // MCP Servers (BAT-168)
        CollapsibleSection(stringResource(R.string.settings_section_mcp_servers), initiallyExpanded = false) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SeekerClawColors.Surface, shape)
                    .padding(16.dp),
            ) {
                Text(
                    text = SettingsHelpTexts.MCP_SERVERS,
                    fontFamily = RethinkSans,
                    fontSize = 13.sp,
                    color = SeekerClawColors.TextDim,
                )

                Spacer(modifier = Modifier.height(12.dp))

                if (mcpServers.isEmpty()) {
                    Text(
                        text = stringResource(R.string.mcp_no_servers),
                        fontFamily = RethinkSans,
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
                                    fontFamily = RethinkSans,
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
                                        checkedThumbColor = androidx.compose.ui.graphics.Color.White,
                                        checkedTrackColor = SeekerClawColors.ActionPrimary,
                                        uncheckedThumbColor = androidx.compose.ui.graphics.Color.White,
                                        uncheckedTrackColor = SeekerClawColors.BorderSubtle,
                                        uncheckedBorderColor = androidx.compose.ui.graphics.Color.Transparent,
                                    ),
                                )
                                IconButton(onClick = {
                                    editingMcpServer = server
                                    showMcpDialog = true
                                }) {
                                    Icon(
                                        imageVector = Icons.Default.Edit,
                                        contentDescription = stringResource(R.string.mcp_cd_edit_server),
                                        tint = SeekerClawColors.TextDim,
                                    )
                                }
                                IconButton(onClick = {
                                    deletingMcpServer = server
                                    showDeleteMcpDialog = true
                                }) {
                                    Icon(
                                        imageVector = Icons.Default.Delete,
                                        contentDescription = stringResource(R.string.mcp_cd_remove_server),
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
                    Text(stringResource(R.string.mcp_add_server), fontFamily = RethinkSans, fontSize = 14.sp)
                }
            }
        }

        Spacer(modifier = Modifier.height(28.dp))

        // Data backup
        CollapsibleSection(stringResource(R.string.settings_section_data), initiallyExpanded = false) {
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
                        stringResource(R.string.settings_export_memory),
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
                        stringResource(R.string.settings_import_memory),
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
                        stringResource(R.string.settings_export_skills),
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
                        stringResource(R.string.settings_import_skills),
                        fontFamily = RethinkSans,
                        fontSize = 14.sp,
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(28.dp))

        // Run Setup Again
        CollapsibleSection(stringResource(R.string.settings_section_setup), initiallyExpanded = false) {
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
                    stringResource(R.string.settings_run_setup_again),
                    fontFamily = RethinkSans,
                    fontSize = 14.sp,
                )
            }
        }

        Spacer(modifier = Modifier.height(32.dp))

        // Danger zone
        CollapsibleSection(stringResource(R.string.settings_section_danger_zone), initiallyExpanded = false) {
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
                        stringResource(R.string.settings_reset_config),
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
                        contentDescription = stringResource(R.string.settings_cd_warning),
                        modifier = Modifier.size(16.dp),
                        tint = SeekerClawColors.ActionDangerText,
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        stringResource(R.string.settings_wipe_memory),
                        fontFamily = RethinkSans,
                        fontWeight = FontWeight.Bold,
                        fontSize = 14.sp,
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(32.dp))

        // System info
        SectionLabel(stringResource(R.string.settings_section_system))

        Spacer(modifier = Modifier.height(10.dp))

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(SeekerClawColors.Surface, shape)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            InfoRow(stringResource(R.string.settings_version), "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
            InfoRow(stringResource(R.string.settings_openclaw), BuildConfig.OPENCLAW_VERSION)
            InfoRow(stringResource(R.string.settings_nodejs), BuildConfig.NODEJS_VERSION)
        }

        Spacer(modifier = Modifier.height(24.dp))
    }

    // ==================== Edit Field Dialog ====================
    if (editField != null) {
        AlertDialog(
            onDismissRequest = { editField = null },
            title = {
                Text(
                    stringResource(R.string.dialog_edit_title, editLabel),
                    fontFamily = RethinkSans,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.TextPrimary,
                )
            },
            text = {
                Column {
                    if (editField == "jupiterApiKey" || editField == "heliusApiKey") {
                        Text(
                            stringResource(R.string.dialog_restart_warning),
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
                        stringResource(R.string.button_save),
                        fontFamily = RethinkSans,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.ActionPrimary,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { editField = null }) {
                    Text(
                        stringResource(R.string.button_cancel),
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
                    stringResource(R.string.settings_reset_config),
                    fontFamily = RethinkSans,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.Error,
                )
            },
            text = {
                Text(
                    stringResource(R.string.dialog_reset_config_message),
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
                        stringResource(R.string.button_confirm),
                        fontFamily = RethinkSans,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showResetDialog = false }) {
                    Text(
                        stringResource(R.string.button_cancel),
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
                    stringResource(R.string.settings_import_memory),
                    fontFamily = RethinkSans,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.Warning,
                )
            },
            text = {
                Text(
                    stringResource(R.string.dialog_import_memory_message),
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
                        stringResource(R.string.button_select_file),
                        fontFamily = RethinkSans,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Warning,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showImportDialog = false }) {
                    Text(
                        stringResource(R.string.button_cancel),
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
        val maskedCredential = maskSensitive(importedConfig.activeCredential, notSetLabel)
        val maskedBot = maskSensitive(importedConfig.telegramBotToken, notSetLabel)
        val source = Uri.parse(imported.sourceUrl).host ?: imported.sourceUrl
        val enabledStr = stringResource(R.string.dialog_apply_config_enabled)
        val disabledStr = stringResource(R.string.dialog_apply_config_disabled)
        val noChangeStr = stringResource(R.string.dialog_apply_config_no_change)
        val autoStartSummary = imported.autoStartOnBoot?.let { if (it) enabledStr else disabledStr } ?: noChangeStr
        val keepScreenSummary = imported.keepScreenOn?.let { if (it) enabledStr else disabledStr } ?: noChangeStr
        AlertDialog(
            onDismissRequest = {
                showApplyConfigDialog = false
                pendingConfigImport = null
            },
            title = {
                Text(
                    stringResource(R.string.dialog_apply_config_title),
                    fontFamily = RethinkSans,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.Warning,
                )
            },
            text = {
                Text(
                    "Schema: v${imported.schemaVersion}\n" +
                        "Source: $source\n" +
                        "Auth: ${if (importedConfig.authType == "setup_token") context.getString(R.string.dialog_apply_config_auth_setup_token) else context.getString(R.string.dialog_apply_config_auth_api_key)}\n" +
                        "Credential: $maskedCredential\n" +
                        "Bot Token: $maskedBot\n" +
                        "Owner ID: ${importedConfig.telegramOwnerId.ifBlank { context.getString(R.string.dialog_apply_config_auto_detect) }}\n" +
                        "Model: ${importedConfig.model}\n" +
                        "Agent: ${importedConfig.agentName}\n" +
                        "Auto-start on boot: $autoStartSummary\n" +
                        "Server mode: $keepScreenSummary\n\n" +
                        context.getString(R.string.dialog_apply_config_question),
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
                        configImportError = context.getString(R.string.error_config_saved_invalid, saveValidationError)
                        Toast.makeText(
                            context,
                            context.getString(R.string.toast_config_saved_invalid, saveValidationError),
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
                    Toast.makeText(context, context.getString(R.string.toast_config_imported), Toast.LENGTH_SHORT).show()
                }) {
                    Text(
                        stringResource(R.string.button_apply),
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
                        stringResource(R.string.button_cancel),
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
                    stringResource(R.string.settings_run_setup_again),
                    fontFamily = RethinkSans,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.TextPrimary,
                )
            },
            text = {
                Text(
                    stringResource(R.string.dialog_run_setup_message),
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
                        stringResource(R.string.button_continue),
                        fontFamily = RethinkSans,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Primary,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showRunSetupDialog = false }) {
                    Text(
                        stringResource(R.string.button_cancel),
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
                    stringResource(R.string.settings_wipe_memory),
                    fontFamily = RethinkSans,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.Error,
                )
            },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(
                        stringResource(R.string.dialog_wipe_memory_message),
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
                                stringResource(R.string.dialog_wipe_confirm_label),
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
                        stringResource(R.string.button_confirm),
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
                        stringResource(R.string.button_cancel),
                        fontFamily = RethinkSans,
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
                    if (editingMcpServer != null) stringResource(R.string.mcp_edit_server) else stringResource(R.string.mcp_add_server),
                    fontFamily = RethinkSans,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.TextPrimary,
                )
            },
            text = {
                Column {
                    OutlinedTextField(
                        value = mcpName,
                        onValueChange = { mcpName = it },
                        label = { Text(stringResource(R.string.mcp_field_name), fontFamily = RethinkSans) },
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
                        label = { Text(stringResource(R.string.mcp_field_url), fontFamily = RethinkSans) },
                        placeholder = { Text(stringResource(R.string.mcp_field_url_placeholder), color = SeekerClawColors.TextDim) },
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
                        label = { Text(stringResource(R.string.mcp_field_auth_token), fontFamily = RethinkSans) },
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
                            Toast.makeText(context, context.getString(R.string.mcp_error_invalid_url), Toast.LENGTH_SHORT).show()
                            return@TextButton
                        }
                        // Warn if auth token + plain HTTP (non-localhost)
                        val trimToken = mcpToken.trim()
                        if (trimToken.isNotBlank()) {
                            val uri = Uri.parse(trimUrl)
                            val isHttps = uri.scheme == "https"
                            val isLocalhost = uri.host in listOf("localhost", "127.0.0.1", "::1", "[::1]")
                            if (!isHttps && !isLocalhost) {
                                Toast.makeText(context, context.getString(R.string.mcp_error_auth_requires_https), Toast.LENGTH_SHORT).show()
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
                        stringResource(R.string.button_save),
                        fontFamily = RethinkSans,
                        fontWeight = FontWeight.Bold,
                        color = if (mcpName.isNotBlank() && mcpUrl.isNotBlank()) SeekerClawColors.Accent else SeekerClawColors.TextDim,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showMcpDialog = false }) {
                    Text(stringResource(R.string.button_cancel), fontFamily = RethinkSans, color = SeekerClawColors.TextDim)
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
                    stringResource(R.string.mcp_dialog_remove_title),
                    fontFamily = RethinkSans,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.TextPrimary,
                )
            },
            text = {
                Text(
                    stringResource(R.string.mcp_dialog_remove_message, deletingMcpServer?.name ?: ""),
                    fontFamily = RethinkSans,
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
                        stringResource(R.string.button_remove),
                        fontFamily = RethinkSans,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showDeleteMcpDialog = false }) {
                    Text(stringResource(R.string.button_cancel), fontFamily = RethinkSans, color = SeekerClawColors.TextDim)
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
        fontFamily = RethinkSans,
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
            contentDescription = if (expanded) stringResource(R.string.settings_collapse_section, title) else stringResource(R.string.settings_expand_section, title),
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
    val requiredDescription = if (isRequired) stringResource(R.string.settings_field_required, label) else ""
    val infoDescription = if (info != null) stringResource(R.string.settings_info_about, label) else ""

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
                    contentDescription = requiredDescription
                } else Modifier,
            ) {
                Text(
                    text = label,
                    fontFamily = RethinkSans,
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
                            contentDescription = infoDescription,
                            tint = SeekerClawColors.TextDim,
                            modifier = Modifier.size(14.dp),
                        )
                    }
                }
            }
            if (onClick != null) {
                Text(
                    text = stringResource(R.string.button_edit),
                    fontFamily = RethinkSans,
                    fontSize = 12.sp,
                    color = SeekerClawColors.TextInteractive,
                )
            }
        }
        Spacer(modifier = Modifier.height(2.dp))
        Text(
            text = value,
            fontFamily = RethinkSans,
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
    val infoDescription = if (info != null) stringResource(R.string.settings_info_about, label) else ""

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
                        contentDescription = infoDescription,
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
            fontFamily = RethinkSans,
            fontSize = 13.sp,
            color = SeekerClawColors.TextDim,
        )
        Text(
            text = value,
            fontFamily = RethinkSans,
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
    onOpenSettings: () -> Unit = {},
    info: String? = null,
) {
    val haptic = LocalHapticFeedback.current
    var showInfo by remember { mutableStateOf(false) }
    var showRevokeDialog by remember { mutableStateOf(false) }
    val infoDescription = if (info != null) stringResource(R.string.settings_info_about, label) else ""

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
                        contentDescription = infoDescription,
                        tint = SeekerClawColors.TextDim,
                        modifier = Modifier.size(14.dp),
                    )
                }
            }
        }
        Switch(
            checked = granted,
            onCheckedChange = {
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                if (granted) {
                    showRevokeDialog = true
                } else {
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
                text = stringResource(R.string.dialog_disable_permission_title, permissionLabel),
                fontFamily = RethinkSans,
                fontWeight = FontWeight.SemiBold,
                fontSize = 16.sp,
                color = SeekerClawColors.TextPrimary,
            )
        },
        text = {
            Text(
                text = stringResource(R.string.dialog_disable_permission_message, permissionLabel),
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
                Text(stringResource(R.string.button_open_settings), fontFamily = RethinkSans, fontWeight = FontWeight.Medium)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.button_cancel), fontFamily = RethinkSans, color = SeekerClawColors.TextSecondary)
            }
        },
        containerColor = SeekerClawColors.Surface,
        shape = shape,
    )
}

private fun maskSensitive(value: String, notSet: String = "Not set"): String {
    if (value.isBlank()) return notSet
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
                fontFamily = RethinkSans,
                fontWeight = FontWeight.Bold,
                fontSize = 16.sp,
                color = SeekerClawColors.TextPrimary,
            )
        },
        text = {
            Text(
                text = message,
                fontFamily = RethinkSans,
                fontSize = 13.sp,
                color = SeekerClawColors.TextSecondary,
                lineHeight = 20.sp,
            )
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text(
                    stringResource(R.string.button_got_it),
                    fontFamily = RethinkSans,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.Primary,
                )
            }
        },
        containerColor = SeekerClawColors.Surface,
        shape = shape,
    )
}
