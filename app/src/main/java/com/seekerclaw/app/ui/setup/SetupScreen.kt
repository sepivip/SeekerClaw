package com.seekerclaw.app.ui.setup

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
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
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.seekerclaw.app.config.AppConfig
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.service.OpenClawService
import com.seekerclaw.app.ui.components.AsciiLogoCompact
import com.seekerclaw.app.ui.components.PixelStepIndicator
import com.seekerclaw.app.ui.components.dotMatrix
import com.seekerclaw.app.ui.theme.SeekerClawColors

private val modelOptions = listOf(
    "claude-opus-4-6" to "Opus 4.6 (default)",
    "claude-sonnet-4-5-20250929" to "Sonnet 4.5 (balanced)",
    "claude-haiku-4-5-20251001" to "Haiku 4.5 (fast)",
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SetupScreen(onSetupComplete: () -> Unit) {
    val context = LocalContext.current

    var apiKey by remember { mutableStateOf("") }
    var authType by remember { mutableStateOf("api_key") }
    var botToken by remember { mutableStateOf("") }
    var ownerId by remember { mutableStateOf("") }
    var selectedModel by remember { mutableStateOf(modelOptions[0].first) }
    var agentName by remember { mutableStateOf("SeekerClaw") }
    var modelDropdownExpanded by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }

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
            errorMessage = "Claude API key is required"
            currentStep = 1
            return
        }
        val credentialError = ConfigManager.validateCredential(apiKey.trim(), authType)
        if (credentialError != null) {
            errorMessage = credentialError
            currentStep = 1
            return
        }
        if (botToken.isBlank()) {
            errorMessage = "Telegram bot token is required"
            currentStep = 2
            return
        }

        val config = AppConfig(
            anthropicApiKey = apiKey.trim(),
            authType = authType,
            telegramBotToken = botToken.trim(),
            telegramOwnerId = ownerId.trim(),
            model = selectedModel,
            agentName = agentName.trim().ifBlank { "SeekerClaw" },
        )
        ConfigManager.saveConfig(context, config)
        ConfigManager.seedWorkspace(context)
        OpenClawService.start(context)
        onSetupComplete()
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
        // Skip link
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.End,
        ) {
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

        Spacer(modifier = Modifier.height(16.dp))

        // Header
        if (SeekerClawColors.UseDotMatrix) {
            AsciiLogoCompact(color = SeekerClawColors.Primary)
        } else {
            Text(
                text = "SEEKER//CLAW",
                fontFamily = FontFamily.Monospace,
                fontSize = 28.sp,
                fontWeight = FontWeight.Bold,
                color = SeekerClawColors.Primary,
                letterSpacing = 1.sp,
            )
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = "Personal AI Agent",
                fontFamily = FontFamily.Monospace,
                fontSize = 13.sp,
                color = SeekerClawColors.TextDim,
            )
        }

        Spacer(modifier = Modifier.height(28.dp))

        PixelStepIndicator(
            currentStep = currentStep,
            totalSteps = 4,
        )

        Spacer(modifier = Modifier.height(28.dp))

        // Error message
        if (errorMessage != null) {
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
                    errorMessage = null
                    if (newValue.length > 20) {
                        authType = ConfigManager.detectAuthType(newValue)
                    }
                },
                authType = authType,
                onAuthTypeChange = { authType = it },
                fieldColors = fieldColors,
                onNext = { currentStep = 2 },
                onBack = { currentStep = 0 },
            )
            2 -> TelegramStep(
                botToken = botToken,
                onBotTokenChange = { botToken = it; errorMessage = null },
                ownerId = ownerId,
                onOwnerIdChange = { ownerId = it; errorMessage = null },
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
        }

        Spacer(modifier = Modifier.height(32.dp))
    }
}

@Composable
private fun WelcomeStep(onNext: () -> Unit) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)

    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = "Welcome",
            fontFamily = FontFamily.Monospace,
            fontSize = 20.sp,
            fontWeight = FontWeight.Bold,
            color = SeekerClawColors.TextPrimary,
        )

        Spacer(modifier = Modifier.height(24.dp))

        Text(
            text = """
                SeekerClaw turns your phone into a 24/7 personal AI agent.

                You'll need:

                1. Claude API key or Pro/Max token
                   API key or run: claude setup-token

                2. Telegram Bot
                   Create one via @BotFather

                3. Your Telegram User ID
                   We'll show you how
            """.trimIndent(),
            fontFamily = FontFamily.Monospace,
            fontSize = 14.sp,
            color = SeekerClawColors.TextPrimary,
            lineHeight = 22.sp,
        )

        Spacer(modifier = Modifier.height(32.dp))

        Button(
            onClick = onNext,
            modifier = Modifier
                .fillMaxWidth()
                .height(52.dp),
            shape = shape,
            colors = ButtonDefaults.buttonColors(
                containerColor = SeekerClawColors.Primary,
                contentColor = androidx.compose.ui.graphics.Color.White,
            ),
        ) {
            Text(
                "Get Started",
                fontFamily = FontFamily.Monospace,
                fontSize = 16.sp,
                fontWeight = FontWeight.Bold,
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
    fieldColors: androidx.compose.material3.TextFieldColors,
    onNext: () -> Unit,
    onBack: () -> Unit,
) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)
    val isToken = authType == "setup_token"

    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = "Step 1: Claude Auth",
            fontFamily = FontFamily.Monospace,
            fontSize = 18.sp,
            fontWeight = FontWeight.Bold,
            color = SeekerClawColors.TextPrimary,
        )

        Spacer(modifier = Modifier.height(16.dp))

        // Auth type selector
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
                            else SeekerClawColors.Surface,
                        contentColor = if (isSelected) SeekerClawColors.Primary
                            else SeekerClawColors.TextDim,
                    ),
                ) {
                    Text(
                        text = label,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 12.sp,
                        fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal,
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        Text(
            text = if (isToken) {
                """
                    Run in your terminal:
                    claude setup-token

                    Paste the generated token below.
                    Requires Claude Pro or Max subscription.
                """.trimIndent()
            } else {
                """
                    Get your API key from:
                    console.anthropic.com/settings/keys

                    Click "Create Key" and paste it below.
                """.trimIndent()
            },
            fontFamily = FontFamily.Monospace,
            fontSize = 13.sp,
            color = SeekerClawColors.TextSecondary,
            lineHeight = 20.sp,
        )

        Spacer(modifier = Modifier.height(24.dp))

        OutlinedTextField(
            value = apiKey,
            onValueChange = onApiKeyChange,
            label = {
                Text(
                    if (isToken) "Setup Token" else "API Key",
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                )
            },
            placeholder = {
                Text(
                    if (isToken) "sk-ant-oat01-..." else "sk-ant-api03-...",
                    fontFamily = FontFamily.Monospace,
                    fontSize = 14.sp,
                    color = SeekerClawColors.TextDim,
                )
            },
            modifier = Modifier.fillMaxWidth(),
            visualTransformation = PasswordVisualTransformation(),
            singleLine = true,
            colors = fieldColors,
            shape = shape,
        )

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
    fieldColors: androidx.compose.material3.TextFieldColors,
    onNext: () -> Unit,
    onBack: () -> Unit,
) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)

    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = "Step 2: Telegram",
            fontFamily = FontFamily.Monospace,
            fontSize = 18.sp,
            fontWeight = FontWeight.Bold,
            color = SeekerClawColors.TextPrimary,
        )

        Spacer(modifier = Modifier.height(16.dp))

        Text(
            text = "Bot Token",
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            color = SeekerClawColors.TextSecondary,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(modifier = Modifier.height(4.dp))
        Text(
            text = """
                1. Open Telegram, search @BotFather
                2. Send /newbot and follow prompts
                3. Copy the token it gives you
            """.trimIndent(),
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
            color = SeekerClawColors.TextDim,
            lineHeight = 18.sp,
            modifier = Modifier.fillMaxWidth(),
        )

        Spacer(modifier = Modifier.height(12.dp))

        OutlinedTextField(
            value = botToken,
            onValueChange = onBotTokenChange,
            label = { Text("Bot Token", fontFamily = FontFamily.Monospace, fontSize = 12.sp) },
            placeholder = { Text("123456789:ABC...", fontFamily = FontFamily.Monospace, fontSize = 14.sp, color = SeekerClawColors.TextDim) },
            modifier = Modifier.fillMaxWidth(),
            visualTransformation = PasswordVisualTransformation(),
            singleLine = true,
            colors = fieldColors,
            shape = shape,
        )

        Spacer(modifier = Modifier.height(24.dp))

        Text(
            text = "User ID (optional)",
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            color = SeekerClawColors.TextSecondary,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(modifier = Modifier.height(4.dp))
        Text(
            text = "Leave empty to auto-detect. The first person to message your bot becomes the owner.",
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
            color = SeekerClawColors.TextDim,
            lineHeight = 18.sp,
            modifier = Modifier.fillMaxWidth(),
        )

        Spacer(modifier = Modifier.height(12.dp))

        OutlinedTextField(
            value = ownerId,
            onValueChange = onOwnerIdChange,
            label = { Text("User ID", fontFamily = FontFamily.Monospace, fontSize = 12.sp) },
            placeholder = { Text("auto-detect", fontFamily = FontFamily.Monospace, fontSize = 14.sp, color = SeekerClawColors.TextDim) },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            colors = fieldColors,
            shape = shape,
        )

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

    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = "Step 3: Options",
            fontFamily = FontFamily.Monospace,
            fontSize = 18.sp,
            fontWeight = FontWeight.Bold,
            color = SeekerClawColors.TextPrimary,
        )

        Spacer(modifier = Modifier.height(16.dp))

        Text(
            text = "Choose your AI model and name your agent.",
            fontFamily = FontFamily.Monospace,
            fontSize = 13.sp,
            color = SeekerClawColors.TextSecondary,
        )

        Spacer(modifier = Modifier.height(24.dp))

        ExposedDropdownMenuBox(
            expanded = modelDropdownExpanded,
            onExpandedChange = onModelDropdownExpandedChange,
        ) {
            OutlinedTextField(
                value = modelOptions.first { it.first == selectedModel }.second,
                onValueChange = {},
                readOnly = true,
                label = { Text("Model", fontFamily = FontFamily.Monospace, fontSize = 12.sp) },
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
                modelOptions.forEach { (model, label) ->
                    DropdownMenuItem(
                        text = {
                            Text(
                                label,
                                fontFamily = FontFamily.Monospace,
                                color = SeekerClawColors.TextPrimary,
                            )
                        },
                        onClick = {
                            onModelChange(model)
                            onModelDropdownExpandedChange(false)
                        },
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(12.dp))

        OutlinedTextField(
            value = agentName,
            onValueChange = onAgentNameChange,
            label = { Text("Agent Name", fontFamily = FontFamily.Monospace, fontSize = 12.sp) },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            colors = fieldColors,
            shape = shape,
        )

        Spacer(modifier = Modifier.height(32.dp))

        TextButton(
            onClick = onBack,
        ) {
            Text(
                text = "Back",
                fontFamily = FontFamily.Monospace,
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
                contentColor = androidx.compose.ui.graphics.Color.White,
            ),
        ) {
            Text(
                "Initialize Agent",
                fontFamily = FontFamily.Monospace,
                fontSize = 16.sp,
                fontWeight = FontWeight.Bold,
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
                fontFamily = FontFamily.Monospace,
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
                contentColor = androidx.compose.ui.graphics.Color.White,
                disabledContainerColor = SeekerClawColors.Surface,
                disabledContentColor = SeekerClawColors.TextDim,
            ),
        ) {
            Text(
                text = "Next",
                fontFamily = FontFamily.Monospace,
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
            )
        }
    }
}
