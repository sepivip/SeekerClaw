package com.seekerclaw.app.ui.setup

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.HelpOutline
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.seekerclaw.app.R
import com.seekerclaw.app.config.AppConfig
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.config.availableModels
import com.seekerclaw.app.service.OpenClawService
import com.seekerclaw.app.ui.components.SetupStepIndicator
import com.seekerclaw.app.ui.components.dotMatrix
import com.seekerclaw.app.ui.theme.SeekerClawColors

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SetupScreen(onSetupComplete: () -> Unit) {
    val context = LocalContext.current

    // Pre-fill from existing config (for "Run Setup Again" flow)
    val existingConfig = remember { ConfigManager.loadConfig(context) }

    var apiKey by remember { mutableStateOf(existingConfig?.activeCredential ?: "") }
    var authType by remember { mutableStateOf(existingConfig?.authType ?: "api_key") }
    var botToken by remember { mutableStateOf(existingConfig?.telegramBotToken ?: "") }
    var ownerId by remember { mutableStateOf(existingConfig?.telegramOwnerId ?: "") }
    var selectedModel by remember {
        mutableStateOf(
            existingConfig?.model?.takeIf { model ->
                availableModels.any { it.id == model }
            } ?: availableModels[0].id
        )
    }
    var agentName by remember { mutableStateOf(existingConfig?.agentName ?: "SeekerClaw") }
    var modelDropdownExpanded by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var apiKeyError by remember { mutableStateOf<String?>(null) }
    var botTokenError by remember { mutableStateOf<String?>(null) }

    var currentStep by remember { mutableIntStateOf(0) }

    fun skipSetup() {
        ConfigManager.markSetupSkipped(context)
        onSetupComplete()
    }

    var hasNotificationPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
                    PackageManager.PERMISSION_GRANTED
        )
    }

    val notificationPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        hasNotificationPermission = granted
    }

    LaunchedEffect(Unit) {
        if (!hasNotificationPermission) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    fun saveAndStart() {
        if (apiKey.isBlank()) {
            apiKeyError = "Required"
            errorMessage = "Claude API key is required"
            currentStep = 1
            return
        }
        val credentialError = ConfigManager.validateCredential(apiKey.trim(), authType)
        if (credentialError != null) {
            apiKeyError = credentialError
            errorMessage = credentialError
            currentStep = 1
            return
        }
        if (botToken.isBlank()) {
            botTokenError = "Required"
            errorMessage = "Telegram bot token is required"
            currentStep = 2
            return
        }

        val trimmedKey = apiKey.trim()
        val config = AppConfig(
            anthropicApiKey = if (authType == "api_key") trimmedKey else "",
            setupToken = if (authType == "setup_token") trimmedKey else "",
            authType = authType,
            telegramBotToken = botToken.trim(),
            telegramOwnerId = ownerId.trim(),
            model = selectedModel,
            agentName = agentName.trim().ifBlank { "SeekerClaw" },
        )
        ConfigManager.saveConfig(context, config)
        ConfigManager.seedWorkspace(context)
        OpenClawService.start(context)
        currentStep = 4
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

    Column(
        modifier = bgModifier
            .padding(24.dp)
            .verticalScroll(scrollState),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (currentStep < 4) {
            // Header row: logo left, skip right
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Image(
                    painter = painterResource(R.drawable.ic_seekerclaw_logo_horizontal),
                    contentDescription = null,
                    modifier = Modifier.height(36.dp),
                )
                Text(
                    text = "Skip",
                    fontFamily = FontFamily.Monospace,
                    fontSize = 14.sp,
                    color = SeekerClawColors.TextDim,
                    modifier = Modifier
                        .clickable { skipSetup() }
                        .padding(4.dp),
                )
            }

            Spacer(modifier = Modifier.height(4.dp))

            Text(
                text = "Your personal AI agent, running on your phone",
                fontSize = 13.sp,
                color = SeekerClawColors.TextDim,
                modifier = Modifier.fillMaxWidth(),
            )

            Spacer(modifier = Modifier.height(24.dp))

            // Step indicator
            SetupStepIndicator(
                currentStep = currentStep,
                labels = listOf("Welcome", "Claude", "Telegram", "Options"),
            )

            Spacer(modifier = Modifier.height(24.dp))
        }

        // Error message
        if (errorMessage != null && currentStep < 4) {
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

        when (currentStep) {
            0 -> WelcomeStep(onNext = { currentStep = 1 })
            1 -> ClaudeApiStep(
                apiKey = apiKey,
                onApiKeyChange = { newValue ->
                    apiKey = newValue
                    apiKeyError = null
                    errorMessage = null
                    if (newValue.length > 20) {
                        authType = ConfigManager.detectAuthType(newValue)
                    }
                },
                authType = authType,
                onAuthTypeChange = { authType = it },
                apiKeyError = apiKeyError,
                fieldColors = fieldColors,
                onNext = { currentStep = 2 },
                onBack = { currentStep = 0 },
            )
            2 -> TelegramStep(
                botToken = botToken,
                onBotTokenChange = { botToken = it; botTokenError = null; errorMessage = null },
                ownerId = ownerId,
                onOwnerIdChange = { ownerId = it; errorMessage = null },
                botTokenError = botTokenError,
                fieldColors = fieldColors,
                onNext = { currentStep = 3 },
                onBack = { currentStep = 1 },
            )
            3 -> OptionsStep(
                selectedModel = selectedModel,
                onModelChange = { selectedModel = it },
                modelDropdownExpanded = modelDropdownExpanded,
                onModelDropdownExpandedChange = { modelDropdownExpanded = it },
                agentName = agentName,
                onAgentNameChange = { agentName = it },
                fieldColors = fieldColors,
                onStartAgent = ::saveAndStart,
                onBack = { currentStep = 2 },
            )
            4 -> SetupSuccessStep(
                agentName = agentName.ifBlank { "SeekerClaw" },
                onContinue = onSetupComplete,
            )
        }

        Spacer(modifier = Modifier.height(32.dp))
    }
}

@Composable
private fun WelcomeStep(onNext: () -> Unit) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)
    val uriHandler = LocalUriHandler.current

    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = "SeekerClaw turns your phone into a 24/7 personal AI agent. " +
                   "To get started, you\u2019ll need:",
            fontSize = 14.sp,
            color = SeekerClawColors.TextPrimary,
            lineHeight = 22.sp,
        )

        Spacer(modifier = Modifier.height(20.dp))

        // Requirements card
        SetupCard {
            RequirementRow(
                icon = Icons.Default.Key,
                title = "Claude API Key",
                subtitle = "From console.anthropic.com, or a Pro/Max token",
            )
            HorizontalDivider(
                color = SeekerClawColors.CardBorder,
                modifier = Modifier.padding(vertical = 14.dp),
            )
            RequirementRow(
                icon = Icons.Default.SmartToy,
                title = "Telegram Bot",
                subtitle = "Create one via @BotFather in Telegram",
            )
            HorizontalDivider(
                color = SeekerClawColors.CardBorder,
                modifier = Modifier.padding(vertical = 14.dp),
            )
            RequirementRow(
                icon = Icons.Default.Person,
                title = "Your Telegram User ID",
                subtitle = "Optional \u2014 can be auto-detected",
            )
        }

        Spacer(modifier = Modifier.height(28.dp))

        Button(
            onClick = onNext,
            modifier = Modifier
                .fillMaxWidth()
                .height(52.dp),
            shape = shape,
            colors = ButtonDefaults.buttonColors(
                containerColor = SeekerClawColors.Primary,
                contentColor = Color.White,
            ),
        ) {
            Text(
                "Get Started",
                fontSize = 16.sp,
                fontWeight = FontWeight.Bold,
            )
        }

        Spacer(modifier = Modifier.height(8.dp))

        TextButton(
            onClick = { uriHandler.openUri("https://seekerclaw.xyz/quick-setup.html") },
        ) {
            Icon(
                Icons.Default.HelpOutline,
                contentDescription = null,
                tint = SeekerClawColors.TextDim,
                modifier = Modifier.size(16.dp),
            )
            Spacer(modifier = Modifier.width(6.dp))
            Text(
                "Need help? Quick setup guide",
                fontSize = 13.sp,
                color = SeekerClawColors.TextDim,
            )
        }
    }
}

@Composable
private fun ClaudeApiStep(
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
    val isToken = authType == "setup_token"
    val uriHandler = LocalUriHandler.current
    val isValid = apiKey.trim().isNotBlank() &&
        ConfigManager.validateCredential(apiKey.trim(), authType) == null &&
        apiKeyError == null

    Column(modifier = Modifier.fillMaxWidth()) {
        SectionLabel("Authentication")

        Spacer(modifier = Modifier.height(10.dp))

        SetupCard {
            // Auth type toggle
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                listOf("api_key" to "API Key", "setup_token" to "Pro/Max Token").forEach { (type, label) ->
                    val isSelected = authType == type
                    Button(
                        onClick = { onAuthTypeChange(type) },
                        modifier = Modifier.weight(1f).height(42.dp),
                        shape = shape,
                        colors = ButtonDefaults.buttonColors(
                            containerColor = if (isSelected) SeekerClawColors.Primary.copy(alpha = 0.15f)
                                else SeekerClawColors.Background,
                            contentColor = if (isSelected) SeekerClawColors.Primary
                                else SeekerClawColors.TextDim,
                        ),
                    ) {
                        Text(
                            text = label,
                            fontSize = 12.sp,
                            fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal,
                        )
                    }
                }
            }

            Spacer(modifier = Modifier.height(16.dp))

            // Instructions with clickable link
            if (isToken) {
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
                        text = "console.anthropic.com",
                        fontSize = 13.sp,
                        color = SeekerClawColors.Primary,
                        modifier = Modifier.clickable {
                            uriHandler.openUri("https://console.anthropic.com/settings/keys")
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
                        if (isToken) "Setup Token" else "API Key",
                        fontSize = 12.sp,
                    )
                },
                placeholder = {
                    Text(
                        if (isToken) "sk-ant-oat01-\u2026" else "sk-ant-api03-\u2026",
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

        Spacer(modifier = Modifier.height(28.dp))

        NavButtons(
            onBack = onBack,
            onNext = onNext,
            nextEnabled = apiKey.isNotBlank(),
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
) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)

    Column(modifier = Modifier.fillMaxWidth()) {
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

        Spacer(modifier = Modifier.height(28.dp))

        NavButtons(
            onBack = onBack,
            onNext = onNext,
            nextEnabled = botToken.isNotBlank(),
        )
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
    onStartAgent: () -> Unit,
    onBack: () -> Unit,
) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)

    Column(modifier = Modifier.fillMaxWidth()) {
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
                text = "Choose the Claude model that powers your agent.",
                fontSize = 12.sp,
                color = SeekerClawColors.TextDim,
            )

            Spacer(modifier = Modifier.height(12.dp))

            ExposedDropdownMenuBox(
                expanded = modelDropdownExpanded,
                onExpandedChange = onModelDropdownExpandedChange,
            ) {
                OutlinedTextField(
                    value = availableModels.first { it.id == selectedModel }.let { "${it.displayName} (${it.description})" },
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
                    availableModels.forEach { model ->
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

        TextButton(
            onClick = onBack,
            modifier = Modifier.align(Alignment.CenterHorizontally),
        ) {
            Text(
                text = "Back",
                fontSize = 14.sp,
                color = SeekerClawColors.TextDim,
            )
        }

        Spacer(modifier = Modifier.height(12.dp))

        Button(
            onClick = onStartAgent,
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp),
            shape = shape,
            colors = ButtonDefaults.buttonColors(
                containerColor = SeekerClawColors.Primary,
                contentColor = Color.White,
            ),
        ) {
            Icon(
                Icons.Default.PlayArrow,
                contentDescription = null,
                modifier = Modifier.size(20.dp),
            )
            Spacer(modifier = Modifier.width(8.dp))
            Text(
                "Initialize Agent",
                fontSize = 16.sp,
                fontWeight = FontWeight.Bold,
            )
        }
    }
}

@Composable
private fun SetupSuccessStep(
    agentName: String,
    onContinue: () -> Unit,
) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)

    // Auto-navigate after 2 seconds
    LaunchedEffect(Unit) {
        kotlinx.coroutines.delay(2000)
        onContinue()
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 48.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // Checkmark circle
        Box(
            modifier = Modifier
                .size(80.dp)
                .background(SeekerClawColors.Accent.copy(alpha = 0.15f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Icons.Rounded.Check,
                contentDescription = "Success",
                tint = SeekerClawColors.Accent,
                modifier = Modifier.size(40.dp),
            )
        }

        Spacer(modifier = Modifier.height(24.dp))

        Text(
            text = "You're all set!",
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Bold,
            fontSize = 22.sp,
            color = SeekerClawColors.TextPrimary,
        )

        Spacer(modifier = Modifier.height(8.dp))

        Text(
            text = "$agentName is starting up. Opening dashboard\u2026",
            fontFamily = FontFamily.Default,
            fontSize = 14.sp,
            color = SeekerClawColors.TextDim,
        )

        Spacer(modifier = Modifier.height(32.dp))

        // Manual continue button (in case user doesn't want to wait)
        TextButton(onClick = onContinue) {
            Text(
                text = "Go to Dashboard",
                fontFamily = FontFamily.Default,
                fontWeight = FontWeight.Medium,
                fontSize = 14.sp,
                color = SeekerClawColors.Primary,
            )
        }
    }
}

@Composable
private fun NavButtons(
    onBack: () -> Unit,
    onNext: () -> Unit,
    nextEnabled: Boolean,
) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(onClick = onBack) {
            Text(
                text = "Back",
                fontSize = 14.sp,
                color = SeekerClawColors.TextDim,
            )
        }

        Button(
            onClick = onNext,
            enabled = nextEnabled,
            shape = shape,
            colors = ButtonDefaults.buttonColors(
                containerColor = SeekerClawColors.Primary,
                contentColor = Color.White,
                disabledContainerColor = SeekerClawColors.Surface,
                disabledContentColor = SeekerClawColors.TextDim,
            ),
        ) {
            Text(
                text = "Next",
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
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
            .padding(20.dp),
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

@Composable
private fun SectionLabel(title: String) {
    Text(
        text = title,
        fontSize = 11.sp,
        fontWeight = FontWeight.Medium,
        color = SeekerClawColors.TextDim,
        letterSpacing = 1.sp,
        modifier = Modifier.fillMaxWidth(),
    )
}

