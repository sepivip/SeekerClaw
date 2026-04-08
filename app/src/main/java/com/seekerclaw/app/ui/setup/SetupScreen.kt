package com.seekerclaw.app.ui.setup

import android.Manifest
import android.app.Activity
import android.content.Intent
import com.seekerclaw.app.ui.components.SectionLabel
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.ui.draw.blur
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.ui.semantics.Role
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.HelpOutline
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.foundation.BorderStroke
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import com.seekerclaw.app.ui.theme.RethinkSans
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.seekerclaw.app.R
import com.seekerclaw.app.config.AppConfig
import com.seekerclaw.app.config.ConfigClaimImporter
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.config.OPENROUTER_DEFAULT_MODEL
import com.seekerclaw.app.config.availableModels
import com.seekerclaw.app.config.availableProviders
import com.seekerclaw.app.config.providerById
import com.seekerclaw.app.config.modelsForProvider
import com.seekerclaw.app.qr.QrScannerActivity
import com.seekerclaw.app.service.OpenClawService
import com.seekerclaw.app.util.Analytics
import kotlinx.coroutines.launch
import com.seekerclaw.app.ui.components.SetupStepIndicator
import com.seekerclaw.app.ui.components.dotMatrix
import com.seekerclaw.app.ui.theme.BrandAlpha
import com.seekerclaw.app.ui.theme.OnboardingColors
import com.seekerclaw.app.ui.theme.SetupLayout
import com.seekerclaw.app.ui.theme.Sizing
import com.seekerclaw.app.ui.theme.Spacing
import com.seekerclaw.app.ui.theme.TypeScale
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin
import com.seekerclaw.app.ui.theme.SeekerClawColors

private object SetupSteps {
    const val WELCOME = 0
    const val PROVIDER = 1
    const val MODEL = 2
    const val TELEGRAM = 3
    const val SUCCESS = 4
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SetupScreen(onSetupComplete: () -> Unit) {
    val context = LocalContext.current

    // Pre-fill from existing config (for "Run Setup Again" flow)
    val existingConfig = remember { ConfigManager.loadConfig(context) }

    var apiKey by remember {
        mutableStateOf(
            when (existingConfig?.provider) {
                "openai" -> existingConfig.openaiApiKey
                "openrouter" -> existingConfig.openrouterApiKey
                else -> existingConfig?.activeCredential ?: ""
            }
        )
    }
    var authType by remember { mutableStateOf(existingConfig?.authType ?: "api_key") }
    var scannedProvider by remember { mutableStateOf(existingConfig?.provider ?: "claude") }
    var botToken by remember { mutableStateOf(existingConfig?.telegramBotToken ?: "") }
    var ownerId by remember { mutableStateOf(existingConfig?.telegramOwnerId ?: "") }
    val existingProvider = existingConfig?.provider ?: "claude"
    var selectedModel by remember {
        // Setup screen always uses API-key auth (OAuth happens later in settings),
        // so derive the model list from the api_key list to match what saveAndStart persists.
        mutableStateOf(
            existingConfig?.model?.let { model ->
                val models = modelsForProvider(existingProvider, "api_key")
                if (models.isEmpty() || models.any { it.id == model }) model
                else models[0].id
            } ?: modelsForProvider(existingProvider, "api_key").firstOrNull()?.id ?: availableModels[0].id
        )
    }
    var agentName by remember { mutableStateOf(existingConfig?.agentName ?: "SeekerClaw") }
    var modelDropdownExpanded by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var apiKeyError by remember { mutableStateOf<String?>(null) }
    var botTokenError by remember { mutableStateOf<String?>(null) }

    var currentStep by remember { mutableIntStateOf(SetupSteps.WELCOME) }
    var isQrImporting by remember { mutableStateOf(false) }
    var qrError by remember { mutableStateOf<String?>(null) }

    val scope = rememberCoroutineScope()
    val qrScanLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val scanError = result.data?.getStringExtra(QrScannerActivity.EXTRA_ERROR)
        if (!scanError.isNullOrBlank()) {
            qrError = scanError
            return@rememberLauncherForActivityResult
        }
        if (result.resultCode != Activity.RESULT_OK) return@rememberLauncherForActivityResult

        val qrText = result.data?.getStringExtra(QrScannerActivity.EXTRA_QR_TEXT)
        if (qrText.isNullOrBlank()) {
            qrError = "No QR data received"
            return@rememberLauncherForActivityResult
        }

        isQrImporting = true
        qrError = null
        scope.launch {
            ConfigClaimImporter.fetchFromQr(qrText)
                .onSuccess { imported ->
                    val cfg = imported.config
                    scannedProvider = cfg.provider
                    authType = cfg.authType
                    apiKey = when (cfg.provider) {
                        "openai" -> cfg.openaiApiKey
                        "openrouter" -> cfg.openrouterApiKey
                        else -> if (cfg.authType == "setup_token") cfg.setupToken else cfg.anthropicApiKey
                    }
                    botToken = cfg.telegramBotToken
                    ownerId = cfg.telegramOwnerId
                    // Setup uses api_key auth — see saveAndStart. Match the model list.
                    val providerModels = modelsForProvider(cfg.provider, "api_key")
                    selectedModel = if (providerModels.isEmpty()) {
                        cfg.model // OpenRouter: accept freeform model as-is
                    } else {
                        cfg.model.takeIf { m -> providerModels.any { it.id == m } }
                            ?: providerModels[0].id
                    }
                    agentName = cfg.agentName
                    isQrImporting = false
                    errorMessage = null
                    currentStep = SetupSteps.TELEGRAM // QR fills all fields — jump to final step
                }
                .onFailure { err ->
                    isQrImporting = false
                    qrError = err.message ?: "Config import failed"
                }
        }
    }

    var hasNotificationPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
                    PackageManager.PERMISSION_GRANTED
        )
    }
    var showNotificationDialog by remember { mutableStateOf(!hasNotificationPermission) }
    var isStarting by remember { mutableStateOf(false) }

    val notificationPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        hasNotificationPermission = granted
        showNotificationDialog = false
    }

    fun saveAndStart() {
        if (isStarting) return
        // Non-Claude providers only support api_key auth
        val effectiveAuthType = if (scannedProvider != "claude") "api_key" else authType

        if (apiKey.isBlank()) {
            apiKeyError = "Required"
            errorMessage = "AI credential is required"
            currentStep = SetupSteps.PROVIDER
            return
        }
        if (scannedProvider != "claude" && apiKey.trim().startsWith("sk-ant-oat")) {
            apiKeyError = "Setup tokens are only valid for Anthropic"
            errorMessage = apiKeyError
            currentStep = SetupSteps.PROVIDER
            return
        }
        val credentialError = ConfigManager.validateCredential(apiKey.trim(), effectiveAuthType)
        if (credentialError != null) {
            apiKeyError = credentialError
            errorMessage = credentialError
            currentStep = SetupSteps.PROVIDER
            return
        }
        if (botToken.isBlank()) {
            botTokenError = "Required"
            errorMessage = "Telegram bot token is required"
            currentStep = SetupSteps.TELEGRAM
            return
        }

        errorMessage = null
        isStarting = true
        try {
            val trimmedKey = apiKey.trim()
            val existing = ConfigManager.loadConfig(context)
            val config = when (scannedProvider) {
                "openai" -> AppConfig(
                    anthropicApiKey = existing?.anthropicApiKey ?: "",
                    setupToken = existing?.setupToken ?: "",
                    openaiApiKey = trimmedKey,
                    openrouterApiKey = existing?.openrouterApiKey ?: "",
                    provider = "openai",
                    authType = "api_key",
                    telegramBotToken = botToken.trim(),
                    telegramOwnerId = ownerId.trim(),
                    model = selectedModel,
                    agentName = agentName.trim().ifBlank { "SeekerClaw" },
                )
                "openrouter" -> AppConfig(
                    anthropicApiKey = existing?.anthropicApiKey ?: "",
                    setupToken = existing?.setupToken ?: "",
                    openaiApiKey = existing?.openaiApiKey ?: "",
                    openrouterApiKey = trimmedKey,
                    provider = "openrouter",
                    authType = "api_key",
                    telegramBotToken = botToken.trim(),
                    telegramOwnerId = ownerId.trim(),
                    model = selectedModel,
                    agentName = agentName.trim().ifBlank { "SeekerClaw" },
                )
                else -> AppConfig(
                    anthropicApiKey = if (effectiveAuthType == "api_key") trimmedKey else "",
                    openaiApiKey = existing?.openaiApiKey ?: "",
                    openrouterApiKey = existing?.openrouterApiKey ?: "",
                    provider = "claude",
                    setupToken = if (effectiveAuthType == "setup_token") trimmedKey else "",
                    authType = effectiveAuthType,
                    telegramBotToken = botToken.trim(),
                    telegramOwnerId = ownerId.trim(),
                    model = selectedModel,
                    agentName = agentName.trim().ifBlank { "SeekerClaw" },
                )
            }
            ConfigManager.saveConfig(context, config)
            ConfigManager.seedWorkspace(context)
            OpenClawService.start(context)
            ConfigManager.markFirstDeploymentDone(context)
            currentStep = SetupSteps.SUCCESS
        } catch (e: Exception) {
            LogCollector.append("[Setup] Failed to start agent: ${e.message}", LogLevel.ERROR)
            isStarting = false
            errorMessage = e.message ?: "Failed to start agent"
        }
    }

    val fieldColors = OutlinedTextFieldDefaults.colors(
        focusedBorderColor = SeekerClawColors.Primary,
        unfocusedBorderColor = SeekerClawColors.TextDim.copy(alpha = 0.3f),
        focusedTextColor = SeekerClawColors.TextPrimary,
        unfocusedTextColor = SeekerClawColors.TextPrimary,
        cursorColor = SeekerClawColors.Primary,
        focusedLabelColor = SeekerClawColors.Primary,
        unfocusedLabelColor = SeekerClawColors.TextSecondary,
        focusedContainerColor = SeekerClawColors.Surface,
        unfocusedContainerColor = SeekerClawColors.Surface,
    )

    val scrollState = rememberScrollState()
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)

    val bgModifier = if (SeekerClawColors.UseDotMatrix) {
        Modifier
            .fillMaxSize()
            .background(SeekerClawColors.Background)
            .dotMatrix(
                dotColor = SeekerClawColors.DotMatrix,
                dotSpacing = 6.dp,
                dotRadius = 1.dp,
            )
    } else {
        Modifier
            .fillMaxSize()
            .background(SeekerClawColors.Background)
    }

    if (currentStep == SetupSteps.WELCOME) {
        WelcomeStep(
            onNext = { currentStep = SetupSteps.PROVIDER },
            onSkip = {
                ConfigManager.markSetupSkipped(context)
                onSetupComplete()
            },
            onScanQr = {
                Analytics.featureUsed("qr_scan_setup")
                qrScanLauncher.launch(Intent(context, QrScannerActivity::class.java))
            },
            isQrImporting = isQrImporting,
            qrError = qrError,
        )
    } else Box(
        modifier = Modifier
            .fillMaxSize()
            .background(OnboardingColors.heroBackground),
    ) {
        AuroraGridBackground(modifier = Modifier.fillMaxSize())

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = SetupLayout.contentHorizontal)
                .padding(top = SetupLayout.contentTop, bottom = SetupLayout.contentBottom),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
        if (currentStep > SetupSteps.WELCOME && currentStep < SetupSteps.SUCCESS) {
            // Top row: Skip aligned right
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "Skip",
                    fontFamily = RethinkSans,
                    fontSize = TypeScale.bodySmall,
                    color = SeekerClawColors.TextDim,
                    modifier = Modifier
                        .clickable {
                            ConfigManager.markSetupSkipped(context)
                            onSetupComplete()
                        }
                        .padding(Spacing.xs),
                )
            }

            Spacer(modifier = Modifier.height(Spacing.lg))

            // Per-step title block (same style as Welcome hero)
            val (line1, line2) = when (currentStep) {
                SetupSteps.PROVIDER -> "PICK YOUR" to "PROVIDER \uD83E\uDDE0"
                SetupSteps.MODEL -> "PICK YOUR" to "MODEL \u26A1"
                SetupSteps.TELEGRAM -> "CONNECT" to "TELEGRAM \uD83D\uDCAC"
                else -> "" to ""
            }
            StepTitle(line1 = line1, line2 = line2)

            Spacer(modifier = Modifier.height(SetupLayout.gapAfterIndicator))
        }

        // Error message
        if (errorMessage != null && currentStep < SetupSteps.SUCCESS) {
            Text(
                text = errorMessage!!,
                fontFamily = FontFamily.Monospace,
                color = SeekerClawColors.Error,
                fontSize = 13.sp,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SeekerClawColors.Error.copy(alpha = 0.1f), shape)
                    .padding(14.dp),
            )
            Spacer(modifier = Modifier.height(16.dp))
        }

        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
        when (currentStep) {
            SetupSteps.WELCOME -> Unit // handled by full-bleed branch above
            SetupSteps.PROVIDER -> ProviderSetupStep(
                provider = scannedProvider,
                onProviderChange = { newProvider ->
                    scannedProvider = newProvider
                    // Load existing key for new provider (preserves credentials on switch)
                    apiKey = when (newProvider) {
                        "openai" -> existingConfig?.openaiApiKey ?: ""
                        "openrouter" -> existingConfig?.openrouterApiKey ?: ""
                        else -> existingConfig?.activeCredential ?: ""
                    }
                    apiKeyError = null
                    errorMessage = null
                    // Claude only supports {api_key, setup_token}; everything else (including
                    // a leftover "oauth" from OpenAI) must fall back to api_key.
                    authType = if (newProvider == "claude") {
                        when (existingConfig?.authType) {
                            "setup_token" -> "setup_token"
                            else -> "api_key"
                        }
                    } else "api_key"
                    // Restore model: use existing config's model if same provider, else default
                    // Setup screen always uses API-key auth — OAuth flow happens later in settings.
                    val models = modelsForProvider(newProvider, "api_key")
                    selectedModel = if (newProvider == existingConfig?.provider) {
                        existingConfig.model
                    } else {
                        models.firstOrNull()?.id ?: OPENROUTER_DEFAULT_MODEL
                    }
                },
                apiKey = apiKey,
                onApiKeyChange = { newValue ->
                    apiKey = newValue
                    apiKeyError = null
                    errorMessage = null
                    if (scannedProvider == "claude" && newValue.length > 20) {
                        authType = ConfigManager.detectAuthType(newValue)
                    }
                },
                authType = authType,
                onAuthTypeChange = { authType = it },
                apiKeyError = apiKeyError,
                fieldColors = fieldColors,
                onNext = { currentStep = SetupSteps.MODEL },
                onBack = { currentStep = SetupSteps.WELCOME },
            )
            SetupSteps.MODEL -> OptionsStep(
                selectedModel = selectedModel,
                onModelChange = { selectedModel = it },
                modelDropdownExpanded = modelDropdownExpanded,
                onModelDropdownExpandedChange = { modelDropdownExpanded = it },
                agentName = agentName,
                onAgentNameChange = { agentName = it },
                fieldColors = fieldColors,
                onNext = { currentStep = SetupSteps.TELEGRAM },
                onBack = { currentStep = SetupSteps.PROVIDER },
                provider = scannedProvider,
            )
            SetupSteps.TELEGRAM -> TelegramStep(
                botToken = botToken,
                onBotTokenChange = { botToken = it; botTokenError = null; errorMessage = null },
                ownerId = ownerId,
                onOwnerIdChange = { ownerId = it; errorMessage = null },
                botTokenError = botTokenError,
                fieldColors = fieldColors,
                onNext = ::saveAndStart,
                onBack = { if (!isStarting) currentStep = SetupSteps.MODEL },
                isStarting = isStarting,
            )
            SetupSteps.SUCCESS -> SetupSuccessStep(
                agentName = agentName.ifBlank { "SeekerClaw" },
                botToken = botToken,
                onContinue = onSetupComplete,
            )
        }
        }
        }
    }

    // Notification permission explanation dialog
    if (showNotificationDialog) {
        AlertDialog(
            onDismissRequest = { showNotificationDialog = false },
            title = {
                Text(
                    "Enable Notifications",
                    fontFamily = RethinkSans,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.TextPrimary,
                )
            },
            text = {
                Text(
                    "SeekerClaw runs your AI agent in the background. " +
                        "Notifications let you know when the agent starts, stops, " +
                        "or needs attention \u2014 even when the app isn\u2019t open.",
                    fontFamily = RethinkSans,
                    fontSize = 13.sp,
                    color = SeekerClawColors.TextSecondary,
                    lineHeight = 20.sp,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                }) {
                    Text(
                        "Enable",
                        fontFamily = RethinkSans,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Primary,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showNotificationDialog = false }) {
                    Text(
                        "Not Now",
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
private fun WelcomeStep(
    onNext: () -> Unit,
    onSkip: () -> Unit,
    onScanQr: () -> Unit = {},
    isQrImporting: Boolean = false,
    qrError: String? = null,
) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)
    val uriHandler = LocalUriHandler.current

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(OnboardingColors.heroBackground),
    ) {
        AuroraGridBackground(modifier = Modifier.fillMaxSize())

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = SetupLayout.contentHorizontal)
                .padding(top = SetupLayout.heroTop, bottom = SetupLayout.contentBottom),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {

        // Hero: claw symbol with ambient dark shadow beneath
        Box(
            modifier = Modifier.size(Sizing.heroBoxSize),
            contentAlignment = Alignment.Center,
        ) {
            // Ambient shadow — radial dark glow offset beneath the logo
            Canvas(modifier = Modifier.fillMaxSize()) {
                val cx = size.width / 2f
                val cy = size.height / 2f + Sizing.heroShadowOffsetY.toPx()
                val r = Sizing.heroShadowRadius.toPx()
                drawCircle(
                    brush = Brush.radialGradient(
                        colors = listOf(
                            OnboardingColors.heroBackground.copy(alpha = BrandAlpha.shadowStrong),
                            OnboardingColors.heroBackground.copy(alpha = BrandAlpha.shadowSoft),
                            Color.Transparent,
                        ),
                        center = Offset(cx, cy),
                        radius = r,
                    ),
                    center = Offset(cx, cy),
                    radius = r,
                )
            }
            Image(
                painter = painterResource(R.drawable.ic_seekerclaw_symbol),
                contentDescription = "SeekerClaw",
                modifier = Modifier.size(Sizing.heroLogoSize),
            )
        }

        Spacer(modifier = Modifier.height(Spacing.xxl))

        Text(
            text = "EMPOWER YOUR",
            fontFamily = RethinkSans,
            fontSize = TypeScale.displayLarge,
            fontWeight = FontWeight.ExtraBold,
            color = SeekerClawColors.TextPrimary,
            textAlign = TextAlign.Center,
            lineHeight = TypeScale.lineHeightDisplayLarge,
        )
        Text(
            text = "PHONE \uD83E\uDD9E\uD83D\uDCF2",
            fontFamily = RethinkSans,
            fontSize = TypeScale.displaySmall,
            fontWeight = FontWeight.ExtraBold,
            color = SeekerClawColors.TextPrimary,
            textAlign = TextAlign.Center,
            lineHeight = TypeScale.lineHeightDisplaySmall,
        )

        Spacer(modifier = Modifier.height(Spacing.md))

        Text(
            text = "3 steps and your AI assistant is live 24/7",
            fontFamily = RethinkSans,
            fontSize = TypeScale.bodyLarge,
            color = SeekerClawColors.TextDim,
            textAlign = TextAlign.Center,
            lineHeight = TypeScale.lineHeightBody,
        )

        Spacer(modifier = Modifier.weight(1f))

        // Primary CTA: Get Started
        Button(
            onClick = onNext,
            modifier = Modifier
                .fillMaxWidth()
                .height(Sizing.buttonPrimaryHeight),
            shape = shape,
            colors = ButtonDefaults.buttonColors(
                containerColor = SeekerClawColors.ActionPrimary,
                contentColor = OnboardingColors.onActionPrimary,
            ),
        ) {
            Text(
                "Get Started",
                fontFamily = RethinkSans,
                fontSize = TypeScale.titleMedium,
                fontWeight = FontWeight.Bold,
            )
            Spacer(modifier = Modifier.width(Spacing.xs))
            Text("\u2197", fontFamily = RethinkSans, fontSize = TypeScale.titleMedium, fontWeight = FontWeight.Bold)
        }

        Spacer(modifier = Modifier.height(SetupLayout.gapBetweenButtons))

        // Secondary row: Scan Config + Skip
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(SetupLayout.gapBetweenButtons),
        ) {
            Button(
                onClick = onScanQr,
                enabled = !isQrImporting,
                modifier = Modifier
                    .weight(1f)
                    .height(Sizing.buttonSecondaryHeight),
                shape = shape,
                colors = ButtonDefaults.buttonColors(
                    containerColor = SeekerClawColors.Surface,
                    contentColor = SeekerClawColors.TextPrimary,
                ),
                border = BorderStroke(Sizing.borderThin, SeekerClawColors.CardBorder),
            ) {
                if (isQrImporting) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(Sizing.iconSm),
                        strokeWidth = 2.dp,
                        color = SeekerClawColors.TextPrimary,
                    )
                } else {
                    Icon(
                        Icons.Default.QrCodeScanner,
                        contentDescription = null,
                        modifier = Modifier.size(Sizing.iconMd),
                    )
                    Spacer(modifier = Modifier.width(Spacing.sm))
                    Text("Scan Config", fontFamily = RethinkSans, fontSize = TypeScale.bodyMedium, fontWeight = FontWeight.Medium)
                }
            }

            Button(
                onClick = onSkip,
                modifier = Modifier
                    .weight(1f)
                    .height(Sizing.buttonSecondaryHeight),
                shape = shape,
                colors = ButtonDefaults.buttonColors(
                    containerColor = SeekerClawColors.Surface,
                    contentColor = SeekerClawColors.TextPrimary,
                ),
                border = BorderStroke(Sizing.borderThin, SeekerClawColors.CardBorder),
            ) {
                Text("Skip", fontFamily = RethinkSans, fontSize = TypeScale.bodyMedium, fontWeight = FontWeight.Medium)
            }
        }

        if (qrError != null) {
            Spacer(modifier = Modifier.height(Spacing.sm))
            Text(
                text = qrError,
                fontFamily = FontFamily.Monospace,
                color = SeekerClawColors.Error,
                fontSize = TypeScale.labelSmall,
            )
        }

        Spacer(modifier = Modifier.height(SetupLayout.gapBeforeNav))

        TextButton(
            onClick = { uriHandler.openUri("https://seekerclaw.xyz/setup") },
        ) {
            Icon(
                @Suppress("DEPRECATION") Icons.Default.HelpOutline,
                contentDescription = "Help",
                tint = SeekerClawColors.TextDim,
                modifier = Modifier.size(Sizing.iconSm),
            )
            Spacer(modifier = Modifier.width(Spacing.xs))
            Text(
                "Need help? Quick setup guide",
                fontFamily = RethinkSans,
                fontSize = TypeScale.bodySmall,
                color = SeekerClawColors.TextDim,
            )
        }

        }
    }
}

@Composable
private fun AuroraGridBackground(modifier: Modifier = Modifier) {
    val infinite = rememberInfiniteTransition(label = "aurora")
    val angle1 by infinite.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 22000, easing = LinearEasing),
        ),
        label = "angle1",
    )
    val angle2 by infinite.animateFloat(
        initialValue = 180f,
        targetValue = 540f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 28000, easing = LinearEasing),
        ),
        label = "angle2",
    )

    val red = SeekerClawColors.Primary

    Box(modifier = modifier.background(OnboardingColors.heroBackground)) {
        Canvas(modifier = Modifier.fillMaxSize()) {
            val cx = size.width / 2f
            val cy = size.height / 2f

            // Blob 1 — drifting radial gradient (no blur modifier needed)
            val rad1 = Math.toRadians(angle1.toDouble())
            val b1x = cx + (cos(rad1) * SetupLayout.blob1Drift.toPx()).toFloat()
            val b1y = cy + (sin(rad1) * SetupLayout.blob1Drift.toPx()).toFloat()
            val b1r = SetupLayout.blob1Radius.toPx()
            drawCircle(
                brush = Brush.radialGradient(
                    colors = listOf(
                        red.copy(alpha = BrandAlpha.blob1Core),
                        red.copy(alpha = BrandAlpha.blob1Mid),
                        Color.Transparent,
                    ),
                    center = Offset(b1x, b1y),
                    radius = b1r,
                ),
                center = Offset(b1x, b1y),
                radius = b1r,
            )

            // Blob 2
            val rad2 = Math.toRadians(angle2.toDouble())
            val b2x = cx + (cos(rad2) * SetupLayout.blob2Drift.toPx()).toFloat()
            val b2y = cy + (sin(rad2) * SetupLayout.blob2Drift.toPx()).toFloat()
            val b2r = SetupLayout.blob2Radius.toPx()
            drawCircle(
                brush = Brush.radialGradient(
                    colors = listOf(
                        red.copy(alpha = BrandAlpha.blob2Core),
                        red.copy(alpha = BrandAlpha.blob2Mid),
                        Color.Transparent,
                    ),
                    center = Offset(b2x, b2y),
                    radius = b2r,
                ),
                center = Offset(b2x, b2y),
                radius = b2r,
            )

            // Grid lines
            val spacing = SetupLayout.gridSpacing.toPx()
            val lineColor = red.copy(alpha = BrandAlpha.gridLine)
            val stroke = Sizing.strokeMedium
            var x = 0f
            while (x < size.width) {
                drawLine(lineColor, Offset(x, 0f), Offset(x, size.height), stroke)
                x += spacing
            }
            var y = 0f
            while (y < size.height) {
                drawLine(lineColor, Offset(0f, y), Offset(size.width, y), stroke)
                y += spacing
            }

            // Radial vignette — fades grid/blobs at edges back to background
            drawRect(
                brush = Brush.radialGradient(
                    colors = listOf(
                        Color.Transparent,
                        Color.Transparent,
                        OnboardingColors.heroBackground,
                    ),
                    center = Offset(cx, cy),
                    radius = size.minDimension * 0.85f,
                ),
            )
        }
    }
}

@Composable
private fun ProviderSetupStep(
    provider: String,
    onProviderChange: (String) -> Unit,
    apiKey: String,
    onApiKeyChange: (String) -> Unit,
    authType: String,
    onAuthTypeChange: (String) -> Unit,
    apiKeyError: String?,
    fieldColors: androidx.compose.material3.TextFieldColors,
    onNext: () -> Unit,
    onBack: () -> Unit,
) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)
    val providerInfo = providerById(provider)
    val isToken = authType == "setup_token"
    val uriHandler = LocalUriHandler.current
    val effectiveAuthType = if (provider != "claude") "api_key" else authType
    val isValid = apiKey.trim().isNotBlank() &&
        ConfigManager.validateCredential(apiKey.trim(), effectiveAuthType) == null &&
        apiKeyError == null

    Column(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState()),
        ) {
        // Provider selector
        SectionLabel("Provider")

        Spacer(modifier = Modifier.height(10.dp))

        SetupCard {
            Column(modifier = Modifier.selectableGroup()) {
                availableProviders.forEachIndexed { index, p ->
                    val isSelected = p.id == provider
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .selectable(
                                selected = isSelected,
                                onClick = { if (!isSelected) onProviderChange(p.id) },
                                role = Role.RadioButton,
                            )
                            .padding(vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(
                            selected = isSelected,
                            onClick = null,
                            colors = RadioButtonDefaults.colors(
                                selectedColor = SeekerClawColors.Primary,
                                unselectedColor = SeekerClawColors.TextDim,
                            ),
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = p.displayName,
                            fontFamily = RethinkSans,
                            fontSize = 15.sp,
                            fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal,
                            color = if (isSelected) SeekerClawColors.TextPrimary else SeekerClawColors.TextDim,
                        )
                    }
                    if (index < availableProviders.size - 1) {
                        HorizontalDivider(color = SeekerClawColors.CardBorder)
                    }
                }
            }
        }

        Spacer(modifier = Modifier.height(20.dp))

        // Provider-specific credential fields
        SectionLabel("Credentials")

        Spacer(modifier = Modifier.height(10.dp))

        SetupCard {
            // Auth type toggle — Claude only
            if (provider == "claude") {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    listOf("api_key" to "API Key", "setup_token" to "Pro/Max Setup Token").forEach { (type, label) ->
                        val isAuthSelected = authType == type
                        Button(
                            onClick = { onAuthTypeChange(type) },
                            modifier = Modifier.weight(1f).height(48.dp),
                            shape = shape,
                            border = if (!isAuthSelected) BorderStroke(1.dp, SeekerClawColors.CardBorder) else null,
                            colors = ButtonDefaults.buttonColors(
                                containerColor = if (isAuthSelected) SeekerClawColors.Primary.copy(alpha = 0.15f)
                                    else SeekerClawColors.Background,
                                contentColor = if (isAuthSelected) SeekerClawColors.Primary
                                    else SeekerClawColors.TextDim,
                            ),
                        ) {
                            Text(
                                text = label,
                                fontSize = 12.sp,
                                fontWeight = if (isAuthSelected) FontWeight.Bold else FontWeight.Normal,
                            )
                        }
                    }
                }

                Spacer(modifier = Modifier.height(16.dp))
            }

            // Instructions — provider-specific
            if (provider == "claude" && isToken) {
                Text(
                    text = "Run in your terminal:",
                    fontSize = 13.sp,
                    color = SeekerClawColors.TextSecondary,
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = "claude setup-token",
                    fontFamily = FontFamily.Monospace,
                    fontSize = 13.sp,
                    color = SeekerClawColors.Primary,
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = "Requires Claude Pro or Max subscription.",
                    fontSize = 12.sp,
                    color = SeekerClawColors.TextDim,
                )
            } else {
                Row {
                    Text(
                        text = "Get your API key from ",
                        fontSize = 13.sp,
                        color = SeekerClawColors.TextSecondary,
                    )
                    Text(
                        text = providerInfo.keysUrl.removePrefix("https://"),
                        fontSize = 13.sp,
                        color = SeekerClawColors.Primary,
                        modifier = Modifier.clickable {
                            uriHandler.openUri(providerInfo.keysUrl)
                        },
                    )
                }
            }

            Spacer(modifier = Modifier.height(16.dp))

            OutlinedTextField(
                value = apiKey,
                onValueChange = onApiKeyChange,
                label = {
                    Text(
                        if (provider == "claude" && isToken) "Setup Token" else "API Key",
                        fontSize = 12.sp,
                    )
                },
                placeholder = {
                    Text(
                        if (provider == "claude" && isToken) "sk-ant-oat01-\u2026" else providerInfo.keyHint,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 14.sp,
                        color = SeekerClawColors.TextDim,
                    )
                },
                modifier = Modifier.fillMaxWidth(),
                visualTransformation = PasswordVisualTransformation(),
                singleLine = true,
                isError = apiKeyError != null,
                trailingIcon = if (isValid) {
                    {
                        Icon(
                            Icons.Default.CheckCircle,
                            contentDescription = "Valid",
                            tint = SeekerClawColors.Accent,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                } else null,
                supportingText = apiKeyError?.let { err ->
                    { Text(err, fontSize = 12.sp) }
                },
                colors = fieldColors,
                shape = shape,
            )
        }

        }

        Spacer(modifier = Modifier.height(SetupLayout.gapBeforeNav))

        NavButtons(
            onBack = onBack,
            onNext = onNext,
            nextEnabled = apiKey.isNotBlank(),
            currentStep = 0,
        )
    }
}

@Composable
private fun TelegramStep(
    botToken: String,
    onBotTokenChange: (String) -> Unit,
    ownerId: String,
    onOwnerIdChange: (String) -> Unit,
    botTokenError: String?,
    fieldColors: androidx.compose.material3.TextFieldColors,
    onNext: () -> Unit,
    onBack: () -> Unit,
    isStarting: Boolean = false,
) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)

    Column(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState()),
        ) {
        SectionLabel("Telegram Connection")

        Spacer(modifier = Modifier.height(10.dp))

        SetupCard {
            // Bot token
            Text(
                text = "Bot Token",
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                color = SeekerClawColors.TextPrimary,
            )
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = "Open Telegram \u2192 @BotFather \u2192 /newbot \u2192 copy the token.",
                fontSize = 12.sp,
                color = SeekerClawColors.TextDim,
                lineHeight = 18.sp,
            )

            Spacer(modifier = Modifier.height(12.dp))

            OutlinedTextField(
                value = botToken,
                onValueChange = onBotTokenChange,
                label = { Text("Bot Token", fontSize = 12.sp) },
                placeholder = {
                    Text(
                        "123456789:ABC\u2026",
                        fontFamily = FontFamily.Monospace,
                        fontSize = 14.sp,
                        color = SeekerClawColors.TextDim,
                    )
                },
                modifier = Modifier.fillMaxWidth(),
                visualTransformation = PasswordVisualTransformation(),
                singleLine = true,
                isError = botTokenError != null,
                supportingText = botTokenError?.let { err ->
                    { Text(err, fontSize = 12.sp) }
                },
                trailingIcon = if (
                    botToken.trim().matches(Regex("^\\d+:[A-Za-z0-9_-]+$")) &&
                    botTokenError == null
                ) {
                    {
                        Icon(
                            Icons.Default.CheckCircle,
                            contentDescription = "Valid format",
                            tint = SeekerClawColors.Accent,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                } else {
                    null
                },
                colors = fieldColors,
                shape = shape,
            )

            Spacer(modifier = Modifier.height(16.dp))

            HorizontalDivider(color = SeekerClawColors.CardBorder)

            Spacer(modifier = Modifier.height(16.dp))

            // User ID with auto-detect badge
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "User ID",
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Medium,
                    color = SeekerClawColors.TextPrimary,
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = "(optional)",
                    fontSize = 12.sp,
                    color = SeekerClawColors.TextDim,
                )
                if (ownerId.isBlank()) {
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = "AUTO-DETECT",
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Accent,
                        letterSpacing = 0.5.sp,
                        modifier = Modifier
                            .background(
                                SeekerClawColors.Accent.copy(alpha = 0.12f),
                                RoundedCornerShape(4.dp),
                            )
                            .padding(horizontal = 6.dp, vertical = 2.dp),
                    )
                }
            }
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = "Leave empty \u2014 the first person to message your bot becomes the owner.",
                fontSize = 12.sp,
                color = SeekerClawColors.TextDim,
                lineHeight = 18.sp,
            )

            Spacer(modifier = Modifier.height(12.dp))

            OutlinedTextField(
                value = ownerId,
                onValueChange = onOwnerIdChange,
                label = { Text("User ID", fontSize = 12.sp) },
                placeholder = {
                    Text(
                        "auto-detect",
                        fontSize = 14.sp,
                        color = SeekerClawColors.TextDim,
                    )
                },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                colors = fieldColors,
                shape = shape,
            )
        }

        }

        Spacer(modifier = Modifier.height(SetupLayout.gapBeforeNav))

        val uriHandler = LocalUriHandler.current
        Column(modifier = Modifier.fillMaxWidth()) {
            PageDots(
                currentStep = 2,
                totalSteps = 3,
                modifier = Modifier.align(Alignment.CenterHorizontally),
            )
            Spacer(modifier = Modifier.height(SetupLayout.gapBeforeNav))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(SetupLayout.gapBetweenButtons),
            ) {
                Button(
                    onClick = onBack,
                    enabled = !isStarting,
                    modifier = Modifier.weight(1f).height(Sizing.buttonSecondaryHeight),
                    shape = shape,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = SeekerClawColors.Surface,
                        contentColor = SeekerClawColors.TextPrimary,
                    ),
                    border = BorderStroke(Sizing.borderThin, SeekerClawColors.CardBorder),
                ) {
                    Text("Back", fontFamily = RethinkSans, fontSize = TypeScale.bodyMedium, fontWeight = FontWeight.Medium)
                }
                Button(
                    onClick = onNext,
                    enabled = botToken.isNotBlank() && !isStarting,
                    modifier = Modifier.weight(1f).height(Sizing.buttonSecondaryHeight),
                    shape = shape,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = SeekerClawColors.ActionPrimary,
                        contentColor = OnboardingColors.onActionPrimary,
                        disabledContainerColor = SeekerClawColors.ActionPrimary.copy(alpha = BrandAlpha.disabledSurface),
                        disabledContentColor = OnboardingColors.onActionPrimary.copy(alpha = BrandAlpha.disabledContent),
                    ),
                ) {
                    if (isStarting) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(Sizing.iconSm),
                            color = OnboardingColors.onActionPrimary,
                            strokeWidth = 2.dp,
                        )
                        Spacer(modifier = Modifier.width(Spacing.xs))
                        Text("Starting\u2026", fontFamily = RethinkSans, fontSize = TypeScale.bodyMedium, fontWeight = FontWeight.Bold)
                    } else {
                        Text("Initialize Agent", fontFamily = RethinkSans, fontSize = TypeScale.bodyMedium, fontWeight = FontWeight.Bold)
                    }
                }
            }

            Spacer(modifier = Modifier.height(SetupLayout.gapBeforeNav))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.Center,
            ) {
                TextButton(onClick = { uriHandler.openUri("https://seekerclaw.xyz/setup") }) {
                    Icon(
                        @Suppress("DEPRECATION") Icons.Default.HelpOutline,
                        contentDescription = "Help",
                        tint = SeekerClawColors.TextDim,
                        modifier = Modifier.size(Sizing.iconSm),
                    )
                    Spacer(modifier = Modifier.width(Spacing.xs))
                    Text(
                        "Need help? Quick setup guide",
                        fontFamily = RethinkSans,
                        fontSize = TypeScale.bodySmall,
                        color = SeekerClawColors.TextDim,
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun OptionsStep(
    selectedModel: String,
    onModelChange: (String) -> Unit,
    modelDropdownExpanded: Boolean,
    onModelDropdownExpandedChange: (Boolean) -> Unit,
    agentName: String,
    onAgentNameChange: (String) -> Unit,
    fieldColors: androidx.compose.material3.TextFieldColors,
    onNext: () -> Unit,
    onBack: () -> Unit,
    provider: String = "claude",
) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)

    Column(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState()),
        ) {
        SectionLabel("Configuration")

        Spacer(modifier = Modifier.height(10.dp))

        SetupCard {
            // Model
            Text(
                text = "AI Model",
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                color = SeekerClawColors.TextPrimary,
            )
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = "Choose the model that powers your agent.",
                fontSize = 12.sp,
                color = SeekerClawColors.TextDim,
            )

            Spacer(modifier = Modifier.height(12.dp))

            // Setup screen: API-key auth only (OAuth flows from settings, post-setup).
            val setupModels = modelsForProvider(provider, "api_key")
            if (setupModels.isEmpty()) {
                // Freeform model (e.g. OpenRouter) — editable text field
                OutlinedTextField(
                    value = selectedModel,
                    onValueChange = onModelChange,
                    singleLine = true,
                    label = { Text("Model ID", fontSize = 12.sp) },
                    placeholder = { Text("e.g. anthropic/claude-sonnet-4-6", fontSize = 14.sp, color = SeekerClawColors.TextDim) },
                    modifier = Modifier.fillMaxWidth(),
                    colors = fieldColors,
                    shape = shape,
                )
            } else {
                ExposedDropdownMenuBox(
                    expanded = modelDropdownExpanded,
                    onExpandedChange = onModelDropdownExpandedChange,
                ) {
                    OutlinedTextField(
                        value = setupModels.firstOrNull { it.id == selectedModel }?.let { "${it.displayName} (${it.description})" } ?: selectedModel,
                        onValueChange = {},
                        readOnly = true,
                        label = { Text("Model", fontSize = 12.sp) },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = modelDropdownExpanded) },
                        modifier = Modifier
                            .fillMaxWidth()
                            .menuAnchor(MenuAnchorType.PrimaryNotEditable),
                        colors = fieldColors,
                        shape = shape,
                    )
                    ExposedDropdownMenu(
                        expanded = modelDropdownExpanded,
                        onDismissRequest = { onModelDropdownExpandedChange(false) },
                    ) {
                        setupModels.forEach { model ->
                            DropdownMenuItem(
                                text = {
                                    Text(
                                        "${model.displayName} (${model.description})",
                                        color = SeekerClawColors.TextPrimary,
                                    )
                                },
                                onClick = {
                                    onModelChange(model.id)
                                    onModelDropdownExpandedChange(false)
                                },
                            )
                        }
                    }
                }
            }

            Spacer(modifier = Modifier.height(16.dp))

            HorizontalDivider(color = SeekerClawColors.CardBorder)

            Spacer(modifier = Modifier.height(16.dp))

            // Agent name
            Text(
                text = "Agent Name",
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                color = SeekerClawColors.TextPrimary,
            )
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = "Give your agent a name. You can change this later.",
                fontSize = 12.sp,
                color = SeekerClawColors.TextDim,
            )

            Spacer(modifier = Modifier.height(12.dp))

            OutlinedTextField(
                value = agentName,
                onValueChange = onAgentNameChange,
                label = { Text("Agent Name", fontSize = 12.sp) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                colors = fieldColors,
                shape = shape,
            )
        }

        Spacer(modifier = Modifier.height(28.dp))

        }

        Spacer(modifier = Modifier.height(SetupLayout.gapBeforeNav))

        NavButtons(
            onBack = onBack,
            onNext = onNext,
            nextEnabled = selectedModel.isNotBlank(),
            currentStep = 1,
        )
    }
}

@Composable
private fun SetupSuccessStep(
    agentName: String,
    botToken: String,
    onContinue: () -> Unit,
) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)
    val botId = Regex("""^(\d+):""").find(botToken)?.groupValues?.get(1)

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // Checkmark circle
        Box(
            modifier = Modifier
                .size(80.dp)
                .background(SeekerClawColors.ActionPrimary.copy(alpha = 0.15f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Icons.Rounded.Check,
                contentDescription = "Success",
                tint = SeekerClawColors.ActionPrimary,
                modifier = Modifier.size(40.dp),
            )
        }

        Spacer(modifier = Modifier.height(24.dp))

        Text(
            text = "You're all set!",
            fontFamily = RethinkSans,
            fontWeight = FontWeight.Bold,
            fontSize = 22.sp,
            color = SeekerClawColors.TextPrimary,
        )

        Spacer(modifier = Modifier.height(8.dp))

        Text(
            text = "$agentName is starting up",
            fontFamily = RethinkSans,
            fontSize = 14.sp,
            color = SeekerClawColors.TextDim,
        )

        Spacer(modifier = Modifier.height(28.dp))

        // Guidance cards
        Column(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // Step 1: Find bot on Telegram
            SetupCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        modifier = Modifier
                            .size(28.dp)
                            .background(SeekerClawColors.Accent.copy(alpha = 0.15f), CircleShape),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = "1",
                            fontFamily = FontFamily.Monospace,
                            fontSize = 14.sp,
                            fontWeight = FontWeight.Bold,
                            color = SeekerClawColors.Accent,
                        )
                    }
                    Spacer(modifier = Modifier.width(12.dp))
                    Column {
                        Text(
                            text = "Open Telegram",
                            fontFamily = RethinkSans,
                            fontWeight = FontWeight.Medium,
                            fontSize = 14.sp,
                            color = SeekerClawColors.TextPrimary,
                        )
                        Text(
                            text = if (!botId.isNullOrBlank())
                                       "Search for the bot username you set with @BotFather (bot ID: $botId)"
                                   else "Search for the bot username you created with @BotFather",
                            fontFamily = RethinkSans,
                            fontSize = 12.sp,
                            color = SeekerClawColors.TextDim,
                        )
                    }
                }
            }

            // Step 2: Chat
            SetupCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        modifier = Modifier
                            .size(28.dp)
                            .background(SeekerClawColors.Primary.copy(alpha = 0.15f), CircleShape),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = "2",
                            fontFamily = FontFamily.Monospace,
                            fontSize = 14.sp,
                            fontWeight = FontWeight.Bold,
                            color = SeekerClawColors.Primary,
                        )
                    }
                    Spacer(modifier = Modifier.width(12.dp))
                    Column {
                        Text(
                            text = "Send your first message",
                            fontFamily = RethinkSans,
                            fontWeight = FontWeight.Medium,
                            fontSize = 14.sp,
                            color = SeekerClawColors.TextPrimary,
                        )
                        Text(
                            text = "Try: \"Hello, what can you do?\"",
                            fontFamily = RethinkSans,
                            fontSize = 12.sp,
                            color = SeekerClawColors.TextDim,
                        )
                    }
                }
            }
        }

        Spacer(modifier = Modifier.height(28.dp))

        Button(
            onClick = onContinue,
            shape = shape,
            colors = ButtonDefaults.buttonColors(
                containerColor = SeekerClawColors.ActionPrimary,
                contentColor = Color.White,
            ),
            modifier = Modifier.fillMaxWidth().height(52.dp),
        ) {
            Text(
                text = "Go to Dashboard",
                fontFamily = RethinkSans,
                fontWeight = FontWeight.Bold,
                fontSize = 15.sp,
            )
        }
    }
}

@Composable
private fun NavButtons(
    onBack: () -> Unit,
    onNext: () -> Unit,
    nextEnabled: Boolean,
    nextLabel: String = "Next",
    currentStep: Int = -1,
    totalSteps: Int = 3,
) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)
    val uriHandler = LocalUriHandler.current

    Column(modifier = Modifier.fillMaxWidth()) {
        if (currentStep >= 0) {
            PageDots(
                currentStep = currentStep,
                totalSteps = totalSteps,
                modifier = Modifier.align(Alignment.CenterHorizontally),
            )
            Spacer(modifier = Modifier.height(SetupLayout.gapBeforeNav))
        }
        // Row: Back | Next (same layout as Welcome's Scan Config | Skip row)
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(SetupLayout.gapBetweenButtons),
        ) {
            Button(
                onClick = onBack,
                modifier = Modifier
                    .weight(1f)
                    .height(Sizing.buttonSecondaryHeight),
                shape = shape,
                colors = ButtonDefaults.buttonColors(
                    containerColor = SeekerClawColors.Surface,
                    contentColor = SeekerClawColors.TextPrimary,
                ),
                border = BorderStroke(Sizing.borderThin, SeekerClawColors.CardBorder),
            ) {
                Text("Back", fontFamily = RethinkSans, fontSize = TypeScale.bodyMedium, fontWeight = FontWeight.Medium)
            }

            Button(
                onClick = onNext,
                enabled = nextEnabled,
                modifier = Modifier
                    .weight(1f)
                    .height(Sizing.buttonSecondaryHeight),
                shape = shape,
                colors = ButtonDefaults.buttonColors(
                    containerColor = SeekerClawColors.ActionPrimary,
                    contentColor = OnboardingColors.onActionPrimary,
                    disabledContainerColor = SeekerClawColors.BorderSubtle,
                    disabledContentColor = SeekerClawColors.TextDim,
                ),
            ) {
                Text(nextLabel, fontFamily = RethinkSans, fontSize = TypeScale.bodyMedium, fontWeight = FontWeight.Bold)
            }
        }

        Spacer(modifier = Modifier.height(SetupLayout.gapBeforeNav))

        // Help link
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.Center,
        ) {
            TextButton(onClick = { uriHandler.openUri("https://seekerclaw.xyz/setup") }) {
                Icon(
                    @Suppress("DEPRECATION") Icons.Default.HelpOutline,
                    contentDescription = "Help",
                    tint = SeekerClawColors.TextDim,
                    modifier = Modifier.size(Sizing.iconSm),
                )
                Spacer(modifier = Modifier.width(Spacing.xs))
                Text(
                    "Need help? Quick setup guide",
                    fontFamily = RethinkSans,
                    fontSize = TypeScale.bodySmall,
                    color = SeekerClawColors.TextDim,
                )
            }
        }
    }
}

@Composable
private fun StepTitle(line1: String, line2: String) {
    Text(
        text = line1,
        fontFamily = RethinkSans,
        fontSize = TypeScale.displayLarge,
        fontWeight = FontWeight.ExtraBold,
        color = SeekerClawColors.TextPrimary,
        textAlign = TextAlign.Center,
        lineHeight = TypeScale.lineHeightDisplayLarge,
    )
    Text(
        text = line2,
        fontFamily = RethinkSans,
        fontSize = TypeScale.displaySmall,
        fontWeight = FontWeight.ExtraBold,
        color = SeekerClawColors.TextPrimary,
        textAlign = TextAlign.Center,
        lineHeight = TypeScale.lineHeightDisplaySmall,
    )
}

@Composable
private fun PageDots(
    currentStep: Int,
    totalSteps: Int,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val dotShape = RoundedCornerShape(Sizing.pageDotCornerRadius)
        for (i in 0 until totalSteps) {
            val isActive = i == currentStep
            Box(
                modifier = Modifier
                    .width(if (isActive) Sizing.pageDotActiveWidth else Sizing.pageDotSize)
                    .height(Sizing.pageDotSize)
                    .background(
                        if (isActive) SeekerClawColors.TextPrimary
                        else SeekerClawColors.TextDim.copy(alpha = BrandAlpha.disabledSurface),
                        dotShape,
                    ),
            )
        }
    }
}

// ============================================================================
// SHARED COMPOSABLES — Card wrapper, requirement row, section label
// ============================================================================

@Composable
private fun SetupCard(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(SeekerClawColors.Surface, shape)
            .border(1.dp, SeekerClawColors.CardBorder, shape)
            .padding(16.dp),
        content = content,
    )
}

@Composable
private fun RequirementRow(
    icon: ImageVector,
    title: String,
    subtitle: String,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = SeekerClawColors.Primary,
            modifier = Modifier.size(22.dp),
        )
        Spacer(modifier = Modifier.width(14.dp))
        Column {
            Text(
                text = title,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                color = SeekerClawColors.TextPrimary,
            )
            Text(
                text = subtitle,
                fontSize = 12.sp,
                color = SeekerClawColors.TextDim,
            )
        }
    }
}


