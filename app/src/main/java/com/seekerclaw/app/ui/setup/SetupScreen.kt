package com.seekerclaw.app.ui.setup

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import com.seekerclaw.app.ui.components.PixelNavButtons
import com.seekerclaw.app.ui.components.PixelStepIndicator
import com.seekerclaw.app.ui.components.dotMatrix
import com.seekerclaw.app.ui.theme.SeekerClawColors

private val modelOptions = listOf(
    "claude-sonnet-4-20250514" to "Sonnet 4 (default)",
    "claude-opus-4-5" to "Opus 4.5 (smartest)",
    "claude-haiku-3-5" to "Haiku 3.5 (fast)",
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SetupScreen(onSetupComplete: () -> Unit) {
    val context = LocalContext.current

    // Form state
    var apiKey by remember { mutableStateOf("") }
    var botToken by remember { mutableStateOf("") }
    var ownerId by remember { mutableStateOf("") }
    var selectedModel by remember { mutableStateOf(modelOptions[0].first) }
    var agentName by remember { mutableStateOf("SeekerClaw") }
    var modelDropdownExpanded by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }

    // Current step (0 = welcome, 1 = claude api, 2 = telegram, 3 = options)
    var currentStep by remember { mutableIntStateOf(0) }

    // Notification permission
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

    // Request notification permission on first appearance
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
        if (botToken.isBlank()) {
            errorMessage = "Telegram bot token is required"
            currentStep = 2
            return
        }

        val config = AppConfig(
            anthropicApiKey = apiKey.trim(),
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
        unfocusedBorderColor = SeekerClawColors.PrimaryDim.copy(alpha = 0.4f),
        focusedTextColor = SeekerClawColors.TextPrimary,
        unfocusedTextColor = SeekerClawColors.TextPrimary,
        cursorColor = SeekerClawColors.Primary,
        focusedLabelColor = SeekerClawColors.Primary,
        unfocusedLabelColor = SeekerClawColors.TextSecondary,
        focusedContainerColor = SeekerClawColors.Surface,
        unfocusedContainerColor = SeekerClawColors.Surface,
    )

    val scrollState = rememberScrollState()

    // Apply dot matrix background if theme supports it
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
        Spacer(modifier = Modifier.height(32.dp))

        // Header — use ASCII logo on Pixel theme
        if (SeekerClawColors.UseDotMatrix) {
            AsciiLogoCompact(color = SeekerClawColors.Primary)
        } else {
            Text(
                text = "SEEKER//CLAW",
                fontFamily = FontFamily.Monospace,
                fontSize = 28.sp,
                fontWeight = FontWeight.Bold,
                color = SeekerClawColors.Primary,
                letterSpacing = 3.sp,
            )
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = "PERSONAL AI AGENT",
                fontFamily = FontFamily.Monospace,
                fontSize = 12.sp,
                color = SeekerClawColors.TextDim,
                letterSpacing = 2.sp,
            )
        }

        Spacer(modifier = Modifier.height(24.dp))

        // Step indicators — pixel blocks or circles based on theme
        PixelStepIndicator(
            currentStep = currentStep,
            totalSteps = 4,
        )

        Spacer(modifier = Modifier.height(24.dp))

        // Error message
        if (errorMessage != null) {
            Text(
                text = "ERR: $errorMessage",
                fontFamily = FontFamily.Monospace,
                color = SeekerClawColors.Error,
                fontSize = 13.sp,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SeekerClawColors.ErrorGlow)
                    .border(1.dp, SeekerClawColors.ErrorDim)
                    .padding(12.dp),
            )
            Spacer(modifier = Modifier.height(16.dp))
        }

        when (currentStep) {
            0 -> WelcomeStep(onNext = { currentStep = 1 })
            1 -> ClaudeApiStep(
                apiKey = apiKey,
                onApiKeyChange = { apiKey = it; errorMessage = null },
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
    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = "[ WELCOME ]",
            fontFamily = FontFamily.Monospace,
            fontSize = 18.sp,
            fontWeight = FontWeight.Bold,
            color = SeekerClawColors.Primary,
            letterSpacing = 2.sp,
        )

        Spacer(modifier = Modifier.height(24.dp))

        Text(
            text = """
                SeekerClaw turns your phone into a 24/7 personal AI agent.

                You'll need:

                1. Claude API key
                   Get one at console.anthropic.com

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
                .height(52.dp)
                .border(1.dp, SeekerClawColors.Primary, RoundedCornerShape(SeekerClawColors.CornerRadius)),
            shape = RoundedCornerShape(SeekerClawColors.CornerRadius),
            colors = ButtonDefaults.buttonColors(
                containerColor = SeekerClawColors.PrimaryGlow,
                contentColor = SeekerClawColors.Primary,
            ),
        ) {
            Text(
                "[ LET'S GO ]",
                fontFamily = FontFamily.Monospace,
                fontSize = 16.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 2.sp,
            )
        }
    }
}

@Composable
private fun ClaudeApiStep(
    apiKey: String,
    onApiKeyChange: (String) -> Unit,
    fieldColors: androidx.compose.material3.TextFieldColors,
    onNext: () -> Unit,
    onBack: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = "[ STEP 1: CLAUDE API ]",
            fontFamily = FontFamily.Monospace,
            fontSize = 16.sp,
            fontWeight = FontWeight.Bold,
            color = SeekerClawColors.Primary,
            letterSpacing = 2.sp,
        )

        Spacer(modifier = Modifier.height(16.dp))

        Text(
            text = """
                Get your API key from:
                console.anthropic.com/settings/keys

                Click "Create Key" and copy it here.
                Your key starts with "sk-ant-..."
            """.trimIndent(),
            fontFamily = FontFamily.Monospace,
            fontSize = 13.sp,
            color = SeekerClawColors.TextSecondary,
            lineHeight = 20.sp,
        )

        Spacer(modifier = Modifier.height(24.dp))

        OutlinedTextField(
            value = apiKey,
            onValueChange = onApiKeyChange,
            label = { Text("CLAUDE_API_KEY", fontFamily = FontFamily.Monospace, fontSize = 11.sp) },
            placeholder = { Text("sk-ant-api03-...", fontFamily = FontFamily.Monospace, fontSize = 14.sp, color = SeekerClawColors.TextDim) },
            modifier = Modifier.fillMaxWidth(),
            visualTransformation = PasswordVisualTransformation(),
            singleLine = true,
            colors = fieldColors,
            shape = RoundedCornerShape(SeekerClawColors.CornerRadius),
        )

        Spacer(modifier = Modifier.height(24.dp))

        PixelNavButtons(
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
    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = "[ STEP 2: TELEGRAM ]",
            fontFamily = FontFamily.Monospace,
            fontSize = 16.sp,
            fontWeight = FontWeight.Bold,
            color = SeekerClawColors.Primary,
            letterSpacing = 2.sp,
        )

        Spacer(modifier = Modifier.height(16.dp))

        // Bot Token section
        Text(
            text = "BOT TOKEN",
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            color = SeekerClawColors.Accent,
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            text = """
                1. Open Telegram, search @BotFather
                2. Send /newbot and follow prompts
                3. Copy the token it gives you
            """.trimIndent(),
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
            color = SeekerClawColors.TextSecondary,
            lineHeight = 18.sp,
            modifier = Modifier.fillMaxWidth(),
        )

        Spacer(modifier = Modifier.height(12.dp))

        OutlinedTextField(
            value = botToken,
            onValueChange = onBotTokenChange,
            label = { Text("BOT_TOKEN", fontFamily = FontFamily.Monospace, fontSize = 11.sp) },
            placeholder = { Text("123456789:ABC...", fontFamily = FontFamily.Monospace, fontSize = 14.sp, color = SeekerClawColors.TextDim) },
            modifier = Modifier.fillMaxWidth(),
            visualTransformation = PasswordVisualTransformation(),
            singleLine = true,
            colors = fieldColors,
            shape = RoundedCornerShape(SeekerClawColors.CornerRadius),
        )

        Spacer(modifier = Modifier.height(20.dp))

        // User ID section
        Text(
            text = "YOUR USER ID (OPTIONAL)",
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            color = SeekerClawColors.Accent,
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            text = """
                Leave empty to auto-detect: the first person to message your bot becomes the owner.

                Or enter manually (search @userinfobot on Telegram to find your ID).
            """.trimIndent(),
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
            color = SeekerClawColors.TextSecondary,
            lineHeight = 18.sp,
            modifier = Modifier.fillMaxWidth(),
        )

        Spacer(modifier = Modifier.height(12.dp))

        OutlinedTextField(
            value = ownerId,
            onValueChange = onOwnerIdChange,
            label = { Text("YOUR_USER_ID", fontFamily = FontFamily.Monospace, fontSize = 11.sp) },
            placeholder = { Text("auto-detect", fontFamily = FontFamily.Monospace, fontSize = 14.sp, color = SeekerClawColors.TextDim) },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            colors = fieldColors,
            shape = RoundedCornerShape(SeekerClawColors.CornerRadius),
        )

        Spacer(modifier = Modifier.height(24.dp))

        PixelNavButtons(
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
    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = "[ STEP 3: OPTIONS ]",
            fontFamily = FontFamily.Monospace,
            fontSize = 16.sp,
            fontWeight = FontWeight.Bold,
            color = SeekerClawColors.Primary,
            letterSpacing = 2.sp,
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
                label = { Text("MODEL", fontFamily = FontFamily.Monospace, fontSize = 11.sp) },
                trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = modelDropdownExpanded) },
                modifier = Modifier
                    .fillMaxWidth()
                    .menuAnchor(MenuAnchorType.PrimaryNotEditable),
                colors = fieldColors,
                shape = RoundedCornerShape(SeekerClawColors.CornerRadius),
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
            label = { Text("AGENT_NAME", fontFamily = FontFamily.Monospace, fontSize = 11.sp) },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            colors = fieldColors,
            shape = RoundedCornerShape(SeekerClawColors.CornerRadius),
        )

        Spacer(modifier = Modifier.height(32.dp))

        // Back button
        Text(
            text = "< BACK",
            fontFamily = FontFamily.Monospace,
            fontSize = 14.sp,
            color = SeekerClawColors.Accent,
            modifier = Modifier
                .clickable { onBack() }
                .padding(8.dp),
        )

        Spacer(modifier = Modifier.height(16.dp))

        // Start button
        Button(
            onClick = onStartAgent,
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp)
                .border(1.dp, SeekerClawColors.Primary, RoundedCornerShape(SeekerClawColors.CornerRadius)),
            shape = RoundedCornerShape(SeekerClawColors.CornerRadius),
            colors = ButtonDefaults.buttonColors(
                containerColor = SeekerClawColors.PrimaryGlow,
                contentColor = SeekerClawColors.Primary,
            ),
        ) {
            Text(
                "[ INITIALIZE AGENT ]",
                fontFamily = FontFamily.Monospace,
                fontSize = 16.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 2.sp,
            )
        }
    }
}

