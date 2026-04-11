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
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.TabRowDefaults
import androidx.compose.material3.TabRowDefaults.tabIndicatorOffset
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.ui.semantics.Role
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.LastPage
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import com.seekerclaw.app.ui.components.ActionResult
import com.seekerclaw.app.ui.components.CardSurface
import com.seekerclaw.app.ui.components.InputMask
import com.seekerclaw.app.ui.components.InputWithActionButton
import com.seekerclaw.app.ui.components.MorphActionButton
import com.seekerclaw.app.ui.components.PrimaryButton
import com.seekerclaw.app.ui.components.SecondaryButton
import com.seekerclaw.app.ui.components.OpenAIOAuthSection
import com.seekerclaw.app.ui.components.ProviderPicker
import com.seekerclaw.app.ui.components.rememberOpenAIOAuthController
import com.seekerclaw.app.ui.components.cornerGlowBorder
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

    // Pre-fill from existing config — reactive to ConfigManager.configVersion so any
    // edit made in Settings while onboarding is on the back stack flows through here.
    val configVersion = ConfigManager.configVersion.intValue
    val existingConfig = remember(configVersion) { ConfigManager.loadConfig(context) }

    // Fresh-install defaults land on OpenAI + OAuth (Sign in with ChatGPT) — it's the
    // first provider in the onboarding picker and the smoothest onboarding path (no
    // key to paste, just a browser tap). If existingConfig is present (user came back
    // from Settings or a previous partial setup), honour whatever they chose before.
    val initialProvider = existingConfig?.provider ?: "openai"
    val initialAuthType = existingConfig?.authType ?: "oauth"

    var apiKey by remember(configVersion) {
        mutableStateOf(
            when (existingConfig?.provider) {
                "openai" -> existingConfig.openaiApiKey
                "openrouter" -> existingConfig.openrouterApiKey
                else -> existingConfig?.activeCredential ?: ""
            }
        )
    }
    var authType by remember(configVersion) { mutableStateOf(initialAuthType) }
    var scannedProvider by remember(configVersion) { mutableStateOf(initialProvider) }
    var botToken by remember(configVersion) { mutableStateOf(existingConfig?.telegramBotToken ?: "") }
    var ownerId by remember(configVersion) { mutableStateOf(existingConfig?.telegramOwnerId ?: "") }
    var selectedModel by remember(configVersion) {
        // Use the effective auth type so OpenAI+OAuth picks from the OAuth model list
        // (GPT-5.x Codex) instead of the API-key list — modelsForProvider throws for
        // openai when authType is null, so we must pass it through.
        val modelAuthType = if (initialProvider == "openai") initialAuthType else "api_key"
        val models = modelsForProvider(initialProvider, modelAuthType)
        mutableStateOf(
            existingConfig?.model?.let { model ->
                if (models.isEmpty() || models.any { it.id == model }) model
                else models[0].id
            } ?: models.firstOrNull()?.id ?: availableModels[0].id
        )
    }
    var agentName by remember(configVersion) { mutableStateOf(existingConfig?.agentName ?: "SeekerClaw") }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var apiKeyError by remember { mutableStateOf<String?>(null) }
    var botTokenError by remember { mutableStateOf<String?>(null) }

    var currentStep by remember { mutableIntStateOf(SetupSteps.WELCOME) }
    // Map SetupSteps (WELCOME=0, PROVIDER=1, MODEL=2, TELEGRAM=3, SUCCESS=4)
    // to PageDots positions (TELEGRAM=0, PROVIDER=1, SUCCESS=2).
    val dotPosition = when (currentStep) {
        SetupSteps.TELEGRAM -> 0f
        SetupSteps.PROVIDER -> 1f
        SetupSteps.SUCCESS -> 2f
        else -> 0f
    }
    // Parent-scoped animation — stable across step swaps, so it actually animates.
    val animatedDotPosition by androidx.compose.animation.core.animateFloatAsState(
        targetValue = dotPosition,
        animationSpec = androidx.compose.animation.core.tween(
            durationMillis = 400,
            easing = androidx.compose.animation.core.FastOutSlowInEasing,
        ),
        label = "dotPosition",
    )
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
                    // Match the model list to the imported config's effective auth type.
                    // OpenAI's OAuth and API-key model lists differ (gpt-5.4-mini is
                    // OAuth-only), so a QR config with provider=openai + authType=oauth
                    // must validate against the OAuth list — not the API-key list.
                    val qrModelAuthType = if (cfg.provider == "openai") cfg.authType else "api_key"
                    val providerModels = modelsForProvider(cfg.provider, qrModelAuthType)
                    selectedModel = if (providerModels.isEmpty()) {
                        cfg.model // OpenRouter: accept freeform model as-is
                    } else {
                        cfg.model.takeIf { m -> providerModels.any { it.id == m } }
                            ?: providerModels[0].id
                    }
                    agentName = cfg.agentName
                    isQrImporting = false
                    errorMessage = null
                    currentStep = SetupSteps.PROVIDER // QR fills all fields — jump to final step (Initialize Agent)
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
        // OpenAI supports oauth; everything else (non-Claude) is api_key only.
        val effectiveAuthType = when {
            scannedProvider == "claude" -> authType
            scannedProvider == "openai" && authType == "oauth" -> "oauth"
            else -> "api_key"
        }
        val isOpenAIOAuth = scannedProvider == "openai" && effectiveAuthType == "oauth"

        // For OpenAI OAuth, the credential lives in openaiOAuthToken (set by the OAuth
        // activity), not apiKey — skip the apiKey blank check entirely.
        if (!isOpenAIOAuth && apiKey.isBlank()) {
            apiKeyError = "Required"
            errorMessage = "AI credential is required"
            currentStep = SetupSteps.PROVIDER
            return
        }
        if (scannedProvider != "claude" && !isOpenAIOAuth && apiKey.trim().startsWith("sk-ant-oat")) {
            apiKeyError = "Setup tokens are only valid for Anthropic"
            errorMessage = apiKeyError
            currentStep = SetupSteps.PROVIDER
            return
        }
        val credentialError = if (isOpenAIOAuth) null
            else ConfigManager.validateCredential(apiKey.trim(), effectiveAuthType)
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
                    // Don't wipe an existing openaiApiKey when the user picked OAuth.
                    openaiApiKey = if (isOpenAIOAuth) (existing?.openaiApiKey ?: "") else trimmedKey,
                    openrouterApiKey = existing?.openrouterApiKey ?: "",
                    // Preserve OAuth tokens written by OpenAIOAuthActivity.
                    openaiOAuthToken = existing?.openaiOAuthToken ?: "",
                    openaiOAuthRefresh = existing?.openaiOAuthRefresh ?: "",
                    openaiOAuthEmail = existing?.openaiOAuthEmail ?: "",
                    openaiOAuthExpiresAt = existing?.openaiOAuthExpiresAt ?: "",
                    provider = "openai",
                    authType = effectiveAuthType,
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
                    // Preserve the OTHER auth type's stored key — never wipe data the user
                    // might still have set in Settings under the alternate Claude auth flow.
                    anthropicApiKey = if (effectiveAuthType == "api_key") trimmedKey
                        else (existing?.anthropicApiKey ?: ""),
                    setupToken = if (effectiveAuthType == "setup_token") trimmedKey
                        else (existing?.setupToken ?: ""),
                    openaiApiKey = existing?.openaiApiKey ?: "",
                    openrouterApiKey = existing?.openrouterApiKey ?: "",
                    provider = "claude",
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
            isStarting = false
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
            onNext = { currentStep = SetupSteps.TELEGRAM },
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
                    fontSize = TypeScale.bodyMedium,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.TextPrimary,
                    modifier = Modifier
                        .clickable {
                            ConfigManager.markSetupSkipped(context)
                            onSetupComplete()
                        }
                        .padding(Spacing.sm),
                )
            }

            Spacer(modifier = Modifier.height(Spacing.lg))

            // Per-step title block (same style as Welcome hero)
            val (stepTitle, stepTagline) = when (currentStep) {
                SetupSteps.PROVIDER -> "Pick Your Provider" to
                    "You can change your provider later in Settings, including custom providers."
                SetupSteps.MODEL -> "" to "" // Model step removed — unreachable
                SetupSteps.TELEGRAM -> "Connect Telegram" to
                    "Your user ID will be set automatically when you send your first message. You can change it later in Settings."
                else -> "" to ""
            }
            StepTitle(title = stepTitle, tagline = stepTagline)

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
                    // Per-provider auth defaults:
                    //   Claude  → "setup_token" if the user previously used one,
                    //             otherwise "api_key".
                    //   OpenAI  → "oauth" on fresh install (existingConfig == null),
                    //             or if the user previously chose oauth, or if there's
                    //             already an OAuth token on file. Otherwise "api_key"
                    //             — e.g. user came from Settings where they had set
                    //             an OpenAI API key directly.
                    //   Other   → "api_key".
                    val newAuthType = when (newProvider) {
                        "claude" -> when (existingConfig?.authType) {
                            "setup_token" -> "setup_token"
                            else -> "api_key"
                        }
                        "openai" -> if (existingConfig == null ||
                            existingConfig.authType == "oauth" ||
                            existingConfig.openaiOAuthToken.isNotBlank()) "oauth" else "api_key"
                        else -> "api_key"
                    }
                    authType = newAuthType
                    // Restore model. Two concerns:
                    //  1. Freeform providers (OpenRouter/custom) have no fixed model
                    //     list — prefer existingConfig.model for the same provider,
                    //     otherwise use the freeform fallback.
                    //  2. Providers with a fixed list must validate existingConfig.model
                    //     against the list for the EFFECTIVE auth type. Example: an
                    //     existing config with openai + api_key + "gpt-5.4-mini" would
                    //     otherwise survive a provider-change round-trip even though
                    //     gpt-5.4-mini is only present in the OAuth model list. Always
                    //     coerce to the first valid entry when the stored model isn't.
                    val modelAuthType = if (newProvider == "openai") newAuthType else "api_key"
                    val models = modelsForProvider(newProvider, modelAuthType)
                    // Capture existingConfig into a stable local so the null check
                    // propagates cleanly (Kotlin doesn't smart-cast a nullable into
                    // lambdas, so we need an already-non-null local to work with).
                    val cfgModelForProvider = existingConfig
                        ?.takeIf { it.provider == newProvider }
                        ?.model
                    selectedModel = if (models.isEmpty()) {
                        // Freeform (OpenRouter/custom): no validation possible —
                        // preserve the stored freeform model, fall back to default.
                        cfgModelForProvider ?: OPENROUTER_DEFAULT_MODEL
                    } else {
                        // Fixed list: restore only if the stored model is still valid
                        // for the effective auth type; otherwise coerce to first entry.
                        cfgModelForProvider?.takeIf { m -> models.any { it.id == m } }
                            ?: models[0].id
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
                onAuthTypeChange = { newAuthType ->
                    authType = newAuthType
                    // Swap displayed key to the value stored under the new auth type so
                    // the field always reflects what's saved for the active tab.
                    if (scannedProvider == "claude") {
                        apiKey = if (newAuthType == "setup_token")
                            existingConfig?.setupToken ?: ""
                        else
                            existingConfig?.anthropicApiKey ?: ""
                    } else if (scannedProvider == "openai") {
                        // OAuth tab doesn't use the apiKey field — leave it untouched.
                        // Switching to API Key restores the saved OpenAI key.
                        if (newAuthType == "api_key") {
                            apiKey = existingConfig?.openaiApiKey ?: ""
                        }
                        // OpenAI's OAuth and API-key model lists overlap on the main
                        // GPT-5.x entries but aren't identical — gpt-5.4-mini is
                        // OAuth-only, for example. If the currently-selected model
                        // isn't in the new auth type's list, coerce to the first valid
                        // entry so a cross-auth stale model never gets persisted by
                        // saveAndStart. Shared models are left alone.
                        val validModels = modelsForProvider("openai", newAuthType)
                        if (validModels.isNotEmpty() && validModels.none { it.id == selectedModel }) {
                            selectedModel = validModels[0].id
                        }
                    }
                    apiKeyError = null
                    errorMessage = null
                },
                apiKeyError = apiKeyError,
                fieldColors = fieldColors,
                onNext = ::saveAndStart,
                onBack = { if (!isStarting) currentStep = SetupSteps.TELEGRAM },
                animatedDotPosition = animatedDotPosition,
                isStarting = isStarting,
            )
            SetupSteps.MODEL -> Unit // Model step removed — default model auto-selected with provider
            SetupSteps.TELEGRAM -> TelegramStep(
                botToken = botToken,
                onBotTokenChange = { botToken = it; botTokenError = null; errorMessage = null },
                agentName = agentName,
                onAgentNameChange = { agentName = it },
                botTokenError = botTokenError,
                fieldColors = fieldColors,
                onNext = { currentStep = SetupSteps.PROVIDER },
                onBack = { currentStep = SetupSteps.WELCOME },
                animatedDotPosition = animatedDotPosition,
            )
            SetupSteps.SUCCESS -> SetupSuccessStep(
                agentName = agentName.ifBlank { "SeekerClaw" },
                onContinue = onSetupComplete,
                onBack = { currentStep = SetupSteps.PROVIDER },
                animatedDotPosition = animatedDotPosition,
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
            fontSize = TypeScale.displayLarge,
            fontWeight = FontWeight.ExtraBold,
            color = SeekerClawColors.TextPrimary,
            textAlign = TextAlign.Center,
            lineHeight = TypeScale.lineHeightDisplayLarge,
        )

        Spacer(modifier = Modifier.height(Spacing.md))

        Text(
            text = "In 3 steps, your AI assistant will be live 24/7",
            fontFamily = RethinkSans,
            fontSize = TypeScale.bodyLarge,
            color = SeekerClawColors.TextDim,
            textAlign = TextAlign.Center,
            lineHeight = TypeScale.lineHeightBody,
        )

        Spacer(modifier = Modifier.height(Spacing.lg))

        Text(
            text = "Add your AI provider, connect Telegram, and start chatting with your agent.",
            fontFamily = RethinkSans,
            fontSize = TypeScale.bodyMedium,
            color = SeekerClawColors.TextDim,
            textAlign = TextAlign.Center,
            lineHeight = TypeScale.lineHeightBody,
        )

        Spacer(modifier = Modifier.weight(1f))

        // Primary CTA: Get Started
        PrimaryButton(
            modifier = Modifier.fillMaxWidth(),
            onClick = onNext,
            label = "Get Started",
        )

        Spacer(modifier = Modifier.height(SetupLayout.gapBetweenButtons))

        // Secondary row: Scan Config + Skip
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(SetupLayout.gapBetweenButtons),
        ) {
            SecondaryButton(
                modifier = Modifier.weight(1f),
                onClick = onScanQr,
                label = "Scan Config",
                isLoading = isQrImporting,
                leadingIcon = {
                    Icon(
                        Icons.Default.QrCodeScanner,
                        contentDescription = null,
                        modifier = Modifier.size(Sizing.iconMd),
                    )
                },
            )

            SecondaryButton(
                onClick = onSkip,
                label = "Skip",
                modifier = Modifier.weight(1f),
                leadingIcon = {
                    Icon(
                        Icons.AutoMirrored.Filled.LastPage,
                        contentDescription = null,
                        modifier = Modifier.size(Sizing.iconMd),
                    )
                },
            )
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
    animatedDotPosition: Float,
    isStarting: Boolean = false,
) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)
    val context = LocalContext.current
    val providerInfo = providerById(provider)
    val isToken = authType == "setup_token"
    val isOpenAIOAuth = provider == "openai" && authType == "oauth"
    val uriHandler = LocalUriHandler.current
    val effectiveAuthType = when {
        provider == "claude" -> authType
        isOpenAIOAuth -> "oauth"
        else -> "api_key"
    }
    // Shared OAuth controller — same flow as Settings, syncs via configVersion.
    val oauthController = rememberOpenAIOAuthController(context)
    val isValid = apiKey.trim().isNotBlank() &&
        ConfigManager.validateCredential(apiKey.trim(), effectiveAuthType) == null &&
        apiKeyError == null

    // Inline test state for the API key field
    val scope = rememberCoroutineScope()
    var keyTestState by remember { mutableStateOf<ActionResult>(ActionResult.Idle) }
    LaunchedEffect(apiKey, provider, authType) {
        if (keyTestState !is ActionResult.Idle) keyTestState = ActionResult.Idle
    }
    fun runKeyTest() {
        val key = apiKey.trim()
        if (key.isBlank() || keyTestState is ActionResult.Loading) return
        // Format check first
        val formatErr = ConfigManager.validateCredential(key, effectiveAuthType)
        if (formatErr != null) {
            keyTestState = ActionResult.Error(formatErr)
            return
        }
        keyTestState = ActionResult.Loading
        scope.launch {
            keyTestState = try {
                val (host, path, headers) = when (provider) {
                    "openai" -> Triple("api.openai.com", "/v1/models", mapOf("Authorization" to "Bearer $key"))
                    "openrouter" -> Triple("openrouter.ai", "/api/v1/models", mapOf("Authorization" to "Bearer $key"))
                    else -> Triple(
                        "api.anthropic.com",
                        "/v1/models",
                        mapOf(
                            "x-api-key" to key,
                            "anthropic-version" to "2023-06-01",
                        ),
                    )
                }
                val code = withContext(Dispatchers.IO) {
                    val conn = (URL("https://$host$path").openConnection() as HttpURLConnection).apply {
                        connectTimeout = 8000
                        readTimeout = 8000
                        requestMethod = "GET"
                        headers.forEach { (k, v) -> setRequestProperty(k, v) }
                    }
                    try { conn.responseCode } finally { conn.disconnect() }
                }
                when (code) {
                    200 -> ActionResult.Success("Key is valid")
                    401, 403 -> ActionResult.Error("Invalid or unauthorized key")
                    else -> ActionResult.Error("HTTP $code from provider")
                }
            } catch (e: Exception) {
                ActionResult.Error(e.message ?: "Network error")
            }
        }
    }

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

        CardSurface {
            ProviderPicker(
                selectedProviderId = provider,
                onSelect = onProviderChange,
                exclude = setOf("custom"), // Custom provider is Settings-only
            )
        }

        Spacer(modifier = Modifier.height(20.dp))

        // Provider-specific credential fields
        SectionLabel("Credentials")

        Spacer(modifier = Modifier.height(10.dp))

        CardSurface {
            // Auth type tabs — Claude (API Key/Setup Token) and OpenAI (OAuth/API Key)
            val authTabs = when (provider) {
                "claude" -> listOf("api_key" to "API Key", "setup_token" to "Pro/Max Token")
                "openai" -> listOf("oauth" to "OAuth", "api_key" to "API Key")
                else -> emptyList()
            }
            if (authTabs.isNotEmpty()) {
                val selectedTabIndex = authTabs.indexOfFirst { it.first == authType }.coerceAtLeast(0)
                TabRow(
                    selectedTabIndex = selectedTabIndex,
                    containerColor = androidx.compose.ui.graphics.Color.Transparent,
                    contentColor = SeekerClawColors.TextPrimary,
                    indicator = { tabPositions ->
                        TabRowDefaults.Indicator(
                            modifier = Modifier.tabIndicatorOffset(tabPositions[selectedTabIndex]),
                            color = SeekerClawColors.Primary,
                            height = 2.dp,
                        )
                    },
                    divider = {
                        HorizontalDivider(color = SeekerClawColors.CardBorder)
                    },
                ) {
                    authTabs.forEach { (type, label) ->
                        val isAuthSelected = type == authType
                        Tab(
                            selected = isAuthSelected,
                            onClick = { onAuthTypeChange(type) },
                            selectedContentColor = SeekerClawColors.Primary,
                            unselectedContentColor = SeekerClawColors.TextDim,
                            text = {
                                Text(
                                    text = label,
                                    fontFamily = RethinkSans,
                                    fontSize = TypeScale.bodyMedium,
                                    fontWeight = if (isAuthSelected) FontWeight.ExtraBold else FontWeight.Medium,
                                )
                            },
                        )
                    }
                }

                Spacer(modifier = Modifier.height(16.dp))
            }

            if (isOpenAIOAuth) {
                // OAuth flow — shared with Settings via the controller. No API key field.
                OpenAIOAuthSection(
                    state = oauthController.state,
                    onSignIn = oauthController.signIn,
                    onSignOut = oauthController.signOut,
                    onCancel = oauthController.cancel,
                )
            } else {
            // Instructions — provider-specific
            if (provider == "claude" && isToken) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = "Run in terminal: ",
                        fontFamily = RethinkSans,
                        fontSize = TypeScale.bodySmall,
                        color = SeekerClawColors.TextSecondary,
                    )
                    Text(
                        text = "claude setup-token",
                        fontFamily = FontFamily.Monospace,
                        fontSize = TypeScale.bodySmall,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Primary,
                    )
                }
            } else {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = "Get your API key ",
                        fontFamily = RethinkSans,
                        fontSize = TypeScale.bodySmall,
                        color = SeekerClawColors.TextSecondary,
                    )
                    Text(
                        text = "here",
                        fontFamily = RethinkSans,
                        fontSize = TypeScale.bodySmall,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Primary,
                        modifier = Modifier.clickable {
                            uriHandler.openUri(providerInfo.keysUrl)
                        },
                    )
                }
            }

            Spacer(modifier = Modifier.height(16.dp))

            InputWithActionButton(
                value = apiKey,
                onValueChange = onApiKeyChange,
                actionLabel = "Test",
                onAction = { runKeyTest() },
                actionState = keyTestState,
                placeholder = if (provider == "claude" && isToken) "sk-ant-oat01-\u2026" else providerInfo.keyHint,
                visualTransformation = InputMask.MaskMiddle,
                isError = apiKeyError != null,
            )

            // Inline error message — success is shown by the button morph alone
            val errorMessage = when (val s = keyTestState) {
                is ActionResult.Error -> s.message
                else -> apiKeyError
            }
            if (!errorMessage.isNullOrBlank()) {
                Spacer(modifier = Modifier.height(Spacing.sm))
                Text(
                    text = errorMessage,
                    fontFamily = RethinkSans,
                    fontSize = TypeScale.labelSmall,
                    color = SeekerClawColors.Error,
                )
            }
            } // end else (api key path)
        }

        }

        Spacer(modifier = Modifier.height(SetupLayout.gapBeforeNav))

        NavButtons(
            onBack = onBack,
            onNext = onNext,
            nextEnabled = if (isOpenAIOAuth) oauthController.state.isConnected
                else apiKey.isNotBlank(),
            nextLabel = "Create Agent",
            animatedDotPosition = animatedDotPosition,
            isLoading = isStarting,
        )
    }
}

@Composable
private fun TelegramStep(
    botToken: String,
    onBotTokenChange: (String) -> Unit,
    agentName: String,
    onAgentNameChange: (String) -> Unit,
    botTokenError: String?,
    fieldColors: androidx.compose.material3.TextFieldColors,
    onNext: () -> Unit,
    onBack: () -> Unit,
    animatedDotPosition: Float,
) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)
    val scope = rememberCoroutineScope()
    val uriHandler = LocalUriHandler.current

    var testState by remember { mutableStateOf<ActionResult>(ActionResult.Idle) }

    fun runTest() {
        val token = botToken.trim()
        if (token.isBlank() || testState is ActionResult.Loading) return
        testState = ActionResult.Loading
        scope.launch {
            testState = try {
                val body = withContext(Dispatchers.IO) {
                    val conn = (URL("https://api.telegram.org/bot$token/getMe").openConnection() as HttpURLConnection).apply {
                        connectTimeout = 8000
                        readTimeout = 8000
                        requestMethod = "GET"
                    }
                    try {
                        if (conn.responseCode == 200) {
                            conn.inputStream.bufferedReader().readText()
                        } else {
                            "__err__:${conn.responseCode}"
                        }
                    } finally {
                        conn.disconnect()
                    }
                }
                if (body.startsWith("__err__:")) {
                    ActionResult.Error("Telegram returned ${body.removePrefix("__err__:")}. Check the token.")
                } else {
                    val json = JSONObject(body)
                    if (json.optBoolean("ok", false)) {
                        val result = json.optJSONObject("result")
                        val username = result?.optString("username", "") ?: ""
                        ActionResult.Success(if (username.isNotBlank()) "Connected to @$username" else "Connected")
                    } else {
                        ActionResult.Error(json.optString("description", "Invalid response"))
                    }
                }
            } catch (e: Exception) {
                ActionResult.Error(e.message ?: "Network error")
            }
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState()),
        ) {
        SectionLabel("Telegram Connection")

        Spacer(modifier = Modifier.height(10.dp))

        CardSurface {
            // Bot token
            Text(
                text = "Bot Token",
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                color = SeekerClawColors.TextPrimary,
            )
            Spacer(modifier = Modifier.height(4.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "Open Telegram \u2192 ",
                    fontFamily = RethinkSans,
                    fontSize = TypeScale.labelSmall,
                    color = SeekerClawColors.TextDim,
                    lineHeight = 18.sp,
                )
                Text(
                    text = "@BotFather",
                    fontFamily = RethinkSans,
                    fontSize = TypeScale.labelSmall,
                    color = SeekerClawColors.Primary,
                    lineHeight = 18.sp,
                    modifier = Modifier.clickable {
                        uriHandler.openUri("https://t.me/BotFather")
                    },
                )
                Text(
                    text = " \u2192 /newbot",
                    fontFamily = RethinkSans,
                    fontSize = TypeScale.labelSmall,
                    color = SeekerClawColors.TextDim,
                    lineHeight = 18.sp,
                )
            }

            Spacer(modifier = Modifier.height(12.dp))

            // Reset test state whenever the token changes so the user can retest
            LaunchedEffect(botToken) {
                if (testState !is ActionResult.Idle) testState = ActionResult.Idle
            }

            InputWithActionButton(
                value = botToken,
                onValueChange = onBotTokenChange,
                actionLabel = "Test",
                onAction = { runTest() },
                actionState = testState,
                placeholder = "123456789:ABC\u2026",
                visualTransformation = InputMask.MaskMiddle,
                isError = botTokenError != null,
            )

            if (botTokenError != null) {
                Spacer(modifier = Modifier.height(Spacing.xs))
                Text(
                    text = botTokenError,
                    fontFamily = RethinkSans,
                    fontSize = TypeScale.labelSmall,
                    color = SeekerClawColors.Error,
                )
            } else if (testState is ActionResult.Error) {
                Spacer(modifier = Modifier.height(Spacing.xs))
                Text(
                    text = (testState as ActionResult.Error).message,
                    fontFamily = RethinkSans,
                    fontSize = TypeScale.labelSmall,
                    color = SeekerClawColors.Error,
                )
            }

            Spacer(modifier = Modifier.height(Spacing.lg))

            HorizontalDivider(color = SeekerClawColors.CardBorder)

            Spacer(modifier = Modifier.height(Spacing.lg))

            // Agent Name
            Text(
                text = "Agent Name",
                fontFamily = RethinkSans,
                fontSize = TypeScale.bodyMedium,
                fontWeight = FontWeight.Medium,
                color = SeekerClawColors.TextPrimary,
            )
            Spacer(modifier = Modifier.height(Spacing.xs))
            Text(
                text = "Give your agent a name. You can change it later.",
                fontFamily = RethinkSans,
                fontSize = TypeScale.labelSmall,
                color = SeekerClawColors.TextDim,
                lineHeight = 18.sp,
            )

            Spacer(modifier = Modifier.height(Spacing.md))

            OutlinedTextField(
                value = agentName,
                onValueChange = onAgentNameChange,
                label = { Text("Agent Name", fontSize = TypeScale.labelSmall) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                colors = fieldColors,
                shape = shape,
            )
        }

        }

        Spacer(modifier = Modifier.height(SetupLayout.gapBeforeNav))

        NavButtons(
            onBack = onBack,
            onNext = onNext,
            nextEnabled = botToken.isNotBlank(),
            animatedDotPosition = animatedDotPosition,
        )
    }
}

@Composable
private fun SetupSuccessStep(
    agentName: String,
    onContinue: () -> Unit,
    onBack: () -> Unit,
    animatedDotPosition: Float,
) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)

    Column(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
        // Match Welcome's logo Y position. Welcome:
        //   Box(top=heroTop) → Box(size=heroBoxSize, contentAlignment=Center)
        //     → Image(size=heroLogoSize)
        //   Image top edge = heroTop + (heroBoxSize - heroLogoSize) / 2
        // Success is inside the parent's padding(top=contentTop), so the spacer
        // needs to add the difference.
        Spacer(
            modifier = Modifier.height(
                SetupLayout.heroTop -
                    SetupLayout.contentTop +
                    (Sizing.heroBoxSize - Sizing.heroLogoSize) / 2
            )
        )

        // Hero logo (smaller version of Welcome's claw)
        Image(
            painter = painterResource(R.drawable.ic_seekerclaw_symbol),
            contentDescription = "SeekerClaw",
            modifier = Modifier.size(96.dp),
        )

        Spacer(modifier = Modifier.height(Spacing.xl))

        StepTitle(
            title = "You\u2019re all set!",
            tagline = "$agentName is getting ready",
        )

        Spacer(modifier = Modifier.height(Spacing.xl))

        // Guidance cards
        Column(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // Step 1: Find bot on Telegram
            CardSurface {
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
                            text = "Open Telegram and search for your bot username.",
                            fontFamily = RethinkSans,
                            fontSize = 12.sp,
                            color = SeekerClawColors.TextDim,
                        )
                    }
                }
            }

            // Step 2: Chat
            CardSurface {
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

        }

        Spacer(modifier = Modifier.height(SetupLayout.gapBeforeNav))

        NavButtons(
            onBack = onBack,
            onNext = onContinue,
            nextEnabled = true,
            nextLabel = "Dashboard",
            animatedDotPosition = animatedDotPosition,
        )
    }
}

@Composable
private fun NavButtons(
    onBack: () -> Unit,
    onNext: () -> Unit,
    nextEnabled: Boolean,
    nextLabel: String = "Next",
    animatedDotPosition: Float = -1f,
    totalSteps: Int = 3,
    isLoading: Boolean = false,
) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)
    val uriHandler = LocalUriHandler.current

    Column(modifier = Modifier.fillMaxWidth()) {
        if (animatedDotPosition >= 0f) {
            PageDots(
                animatedPosition = animatedDotPosition,
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
            SecondaryButton(
                modifier = Modifier.weight(1f),
                onClick = onBack,
                label = "Back",
            )

            PrimaryButton(
                modifier = Modifier.weight(1f),
                onClick = onNext,
                label = nextLabel,
                enabled = nextEnabled,
                isLoading = isLoading,
                loadingLabel = "Starting\u2026",
                height = Sizing.buttonSecondaryHeight,
            )
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
private fun StepTitle(title: String, tagline: String) {
    Text(
        text = title,
        fontFamily = RethinkSans,
        fontSize = TypeScale.displayLarge,
        fontWeight = FontWeight.ExtraBold,
        color = SeekerClawColors.TextPrimary,
        textAlign = TextAlign.Center,
        lineHeight = TypeScale.lineHeightDisplayLarge,
    )
    Spacer(modifier = Modifier.height(Spacing.sm))
    Text(
        text = tagline,
        fontFamily = RethinkSans,
        fontSize = TypeScale.bodyLarge,
        color = SeekerClawColors.TextDim,
        textAlign = TextAlign.Center,
        lineHeight = TypeScale.lineHeightBody,
    )
}

@Composable
internal fun PageDots(
    animatedPosition: Float,
    totalSteps: Int,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val dotShape = RoundedCornerShape(Sizing.pageDotCornerRadius)
        val minDp = Sizing.pageDotSize
        val maxDp = Sizing.pageDotActiveWidth
        val activeColor = SeekerClawColors.TextPrimary
        val inactiveColor = SeekerClawColors.TextDim.copy(alpha = BrandAlpha.disabledSurface)
        for (i in 0 until totalSteps) {
            // Proximity: 0 = fully active (this dot), 1+ = fully inactive
            val proximity = kotlin.math.abs(animatedPosition - i).coerceIn(0f, 1f)
            val width = minDp + (maxDp - minDp) * (1f - proximity)
            val color = androidx.compose.ui.graphics.lerp(activeColor, inactiveColor, proximity)
            Box(
                modifier = Modifier
                    .width(width)
                    .height(Sizing.pageDotSize)
                    .background(color, dotShape),
            )
        }
    }
}

// ============================================================================
// SHARED COMPOSABLES — Card wrapper, requirement row, section label
// ============================================================================

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


