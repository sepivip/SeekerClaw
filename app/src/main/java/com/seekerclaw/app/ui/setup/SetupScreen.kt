package com.seekerclaw.app.ui.setup

import android.Manifest
import android.content.pm.PackageManager
import android.util.Size
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.zxing.BinaryBitmap
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.seekerclaw.app.config.AppConfig
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.config.QrParser
import com.seekerclaw.app.service.OpenClawService
import com.seekerclaw.app.ui.theme.SeekerClawColors
import java.util.concurrent.Executors

private val modelOptions = listOf(
    "claude-sonnet-4-20250514" to "Sonnet 4 (default)",
    "claude-opus-4-5" to "Opus 4.5 (smartest)",
    "claude-haiku-3-5" to "Haiku 3.5 (fast)",
)

private enum class SetupMode { LANDING, QR_SCAN, MANUAL_ENTRY }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SetupScreen(onSetupComplete: () -> Unit) {
    val context = LocalContext.current
    var mode by remember { mutableStateOf(SetupMode.LANDING) }
    var apiKey by remember { mutableStateOf("") }
    var botToken by remember { mutableStateOf("") }
    var ownerId by remember { mutableStateOf("") }
    var selectedModel by remember { mutableStateOf(modelOptions[0].first) }
    var agentName by remember { mutableStateOf("MyAgent") }
    var modelDropdownExpanded by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var hasCameraPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                    PackageManager.PERMISSION_GRANTED
        )
    }
    var hasNotificationPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
                    PackageManager.PERMISSION_GRANTED
        )
    }

    val cameraPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        hasCameraPermission = granted
        if (granted) mode = SetupMode.QR_SCAN
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
        if (apiKey.isBlank() || botToken.isBlank() || ownerId.isBlank()) {
            errorMessage = "All fields are required"
            return
        }
        val config = AppConfig(
            anthropicApiKey = apiKey.trim(),
            telegramBotToken = botToken.trim(),
            telegramOwnerId = ownerId.trim(),
            model = selectedModel,
            agentName = agentName.trim().ifBlank { "MyAgent" },
        )
        ConfigManager.saveConfig(context, config)
        ConfigManager.seedWorkspace(context)
        OpenClawService.start(context)
        onSetupComplete()
    }

    when (mode) {
        SetupMode.LANDING -> {
            LandingContent(
                onScanQr = {
                    if (hasCameraPermission) {
                        mode = SetupMode.QR_SCAN
                    } else {
                        cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                    }
                },
                onManualEntry = { mode = SetupMode.MANUAL_ENTRY },
            )
        }

        SetupMode.QR_SCAN -> {
            QrScanContent(
                onQrScanned = { raw ->
                    QrParser.parse(raw).fold(
                        onSuccess = { payload ->
                            apiKey = payload.anthropicApiKey
                            botToken = payload.telegramBotToken
                            ownerId = payload.telegramOwnerId
                            selectedModel = payload.model
                            agentName = payload.agentName
                            // Auto-save and start
                            val config = AppConfig(
                                anthropicApiKey = payload.anthropicApiKey,
                                telegramBotToken = payload.telegramBotToken,
                                telegramOwnerId = payload.telegramOwnerId,
                                model = payload.model,
                                agentName = payload.agentName,
                            )
                            ConfigManager.saveConfig(context, config)
                            ConfigManager.seedWorkspace(context)
                            OpenClawService.start(context)
                            onSetupComplete()
                        },
                        onFailure = { e ->
                            errorMessage = "Invalid QR code: ${e.message}"
                            mode = SetupMode.MANUAL_ENTRY
                        },
                    )
                },
                onBack = { mode = SetupMode.LANDING },
                errorMessage = errorMessage,
            )
        }

        SetupMode.MANUAL_ENTRY -> {
            ManualEntryContent(
                apiKey = apiKey,
                onApiKeyChange = { apiKey = it },
                botToken = botToken,
                onBotTokenChange = { botToken = it },
                ownerId = ownerId,
                onOwnerIdChange = { ownerId = it },
                selectedModel = selectedModel,
                onModelChange = { selectedModel = it },
                modelDropdownExpanded = modelDropdownExpanded,
                onModelDropdownExpandedChange = { modelDropdownExpanded = it },
                agentName = agentName,
                onAgentNameChange = { agentName = it },
                errorMessage = errorMessage,
                onStartAgent = ::saveAndStart,
                onBack = { mode = SetupMode.LANDING },
            )
        }
    }
}

@Composable
private fun LandingContent(
    onScanQr: () -> Unit,
    onManualEntry: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(SeekerClawColors.Background)
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        // ASCII-art style logo
        Text(
            text = "> SEEKER_CLAW",
            fontFamily = FontFamily.Monospace,
            fontSize = 28.sp,
            fontWeight = FontWeight.Bold,
            color = SeekerClawColors.Primary,
            letterSpacing = 3.sp,
        )
        Spacer(modifier = Modifier.height(4.dp))
        Text(
            text = "////////////////////////////",
            fontFamily = FontFamily.Monospace,
            fontSize = 14.sp,
            color = SeekerClawColors.PrimaryDim,
        )
        Spacer(modifier = Modifier.height(16.dp))
        Text(
            text = "[ AI AGENT RUNTIME v1.0 ]",
            fontFamily = FontFamily.Monospace,
            fontSize = 14.sp,
            color = SeekerClawColors.TextSecondary,
            textAlign = TextAlign.Center,
        )
        Spacer(modifier = Modifier.height(4.dp))
        Text(
            text = "SYSTEM READY. AWAITING CONFIG.",
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
            color = SeekerClawColors.TextDim,
            textAlign = TextAlign.Center,
        )
        Spacer(modifier = Modifier.height(48.dp))

        // Scan QR button — terminal-style with hard corners
        Button(
            onClick = onScanQr,
            modifier = Modifier
                .fillMaxWidth()
                .height(52.dp)
                .border(1.dp, SeekerClawColors.Primary, RoundedCornerShape(2.dp)),
            shape = RoundedCornerShape(2.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = SeekerClawColors.PrimaryGlow,
                contentColor = SeekerClawColors.Primary,
            ),
        ) {
            Text(
                "[ SCAN QR CODE ]",
                fontFamily = FontFamily.Monospace,
                fontSize = 16.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 2.sp,
            )
        }
        Spacer(modifier = Modifier.height(16.dp))
        TextButton(onClick = onManualEntry) {
            Text(
                "> enter manually_",
                fontFamily = FontFamily.Monospace,
                color = SeekerClawColors.Accent,
                letterSpacing = 1.sp,
            )
        }
    }
}

@Composable
private fun QrScanContent(
    onQrScanned: (String) -> Unit,
    onBack: () -> Unit,
    errorMessage: String?,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    var scanned by remember { mutableStateOf(false) }
    val cameraExecutor = remember { Executors.newSingleThreadExecutor() }

    DisposableEffect(Unit) {
        onDispose { cameraExecutor.shutdown() }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        AndroidView(
            factory = { ctx ->
                val previewView = PreviewView(ctx)
                val cameraProviderFuture = ProcessCameraProvider.getInstance(ctx)

                cameraProviderFuture.addListener({
                    val cameraProvider = cameraProviderFuture.get()
                    val preview = Preview.Builder().build().also {
                        it.surfaceProvider = previewView.surfaceProvider
                    }

                    val imageAnalysis = ImageAnalysis.Builder()
                        .setTargetResolution(Size(1280, 720))
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build()

                    imageAnalysis.setAnalyzer(cameraExecutor) { imageProxy ->
                        if (scanned) {
                            imageProxy.close()
                            return@setAnalyzer
                        }
                        val buffer = imageProxy.planes[0].buffer
                        val bytes = ByteArray(buffer.remaining())
                        buffer.get(bytes)

                        val source = PlanarYUVLuminanceSource(
                            bytes,
                            imageProxy.width,
                            imageProxy.height,
                            0, 0,
                            imageProxy.width,
                            imageProxy.height,
                            false,
                        )
                        val binaryBitmap = BinaryBitmap(HybridBinarizer(source))

                        try {
                            val result = MultiFormatReader().decode(binaryBitmap)
                            scanned = true
                            onQrScanned(result.text)
                        } catch (_: Exception) {
                            // No QR code found in this frame
                        } finally {
                            imageProxy.close()
                        }
                    }

                    cameraProvider.unbindAll()
                    cameraProvider.bindToLifecycle(
                        lifecycleOwner,
                        CameraSelector.DEFAULT_BACK_CAMERA,
                        preview,
                        imageAnalysis,
                    )
                }, ContextCompat.getMainExecutor(ctx))

                previewView
            },
            modifier = Modifier.fillMaxSize(),
        )

        // Overlay UI — terminal HUD style
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(24.dp),
            verticalArrangement = Arrangement.SpaceBetween,
        ) {
            TextButton(onClick = onBack) {
                Text(
                    "< BACK",
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.Primary,
                    letterSpacing = 1.sp,
                )
            }

            Column(
                modifier = Modifier.fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    text = "[ SCANNING FOR QR SIGNAL... ]",
                    fontFamily = FontFamily.Monospace,
                    color = SeekerClawColors.Primary,
                    fontSize = 14.sp,
                    letterSpacing = 1.sp,
                    modifier = Modifier
                        .background(SeekerClawColors.Background.copy(alpha = 0.85f))
                        .border(1.dp, SeekerClawColors.PrimaryDim)
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                )
                if (errorMessage != null) {
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = "ERR: $errorMessage",
                        fontFamily = FontFamily.Monospace,
                        color = SeekerClawColors.Error,
                        fontSize = 12.sp,
                        modifier = Modifier
                            .background(SeekerClawColors.Background.copy(alpha = 0.85f))
                            .border(1.dp, SeekerClawColors.ErrorDim)
                            .padding(horizontal = 16.dp, vertical = 8.dp),
                    )
                }
                Spacer(modifier = Modifier.height(32.dp))
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ManualEntryContent(
    apiKey: String,
    onApiKeyChange: (String) -> Unit,
    botToken: String,
    onBotTokenChange: (String) -> Unit,
    ownerId: String,
    onOwnerIdChange: (String) -> Unit,
    selectedModel: String,
    onModelChange: (String) -> Unit,
    modelDropdownExpanded: Boolean,
    onModelDropdownExpandedChange: (Boolean) -> Unit,
    agentName: String,
    onAgentNameChange: (String) -> Unit,
    errorMessage: String?,
    onStartAgent: () -> Unit,
    onBack: () -> Unit,
) {
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

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(SeekerClawColors.Background)
            .padding(24.dp)
            .verticalScroll(scrollState),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(modifier = Modifier.height(16.dp))

        Text(
            text = "> CONFIG_INPUT",
            fontFamily = FontFamily.Monospace,
            fontSize = 22.sp,
            fontWeight = FontWeight.Bold,
            color = SeekerClawColors.Primary,
            letterSpacing = 2.sp,
        )
        Spacer(modifier = Modifier.height(4.dp))
        Text(
            text = "ENTER CREDENTIALS TO INITIALIZE",
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
            color = SeekerClawColors.TextDim,
            letterSpacing = 1.sp,
        )

        Spacer(modifier = Modifier.height(24.dp))

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

        OutlinedTextField(
            value = apiKey,
            onValueChange = onApiKeyChange,
            label = { Text("ANTHROPIC_API_KEY", fontFamily = FontFamily.Monospace, fontSize = 11.sp) },
            modifier = Modifier.fillMaxWidth(),
            visualTransformation = PasswordVisualTransformation(),
            singleLine = true,
            colors = fieldColors,
            shape = RoundedCornerShape(2.dp),
        )
        Spacer(modifier = Modifier.height(12.dp))

        OutlinedTextField(
            value = botToken,
            onValueChange = onBotTokenChange,
            label = { Text("TELEGRAM_BOT_TOKEN", fontFamily = FontFamily.Monospace, fontSize = 11.sp) },
            modifier = Modifier.fillMaxWidth(),
            visualTransformation = PasswordVisualTransformation(),
            singleLine = true,
            colors = fieldColors,
            shape = RoundedCornerShape(2.dp),
        )
        Spacer(modifier = Modifier.height(12.dp))

        OutlinedTextField(
            value = ownerId,
            onValueChange = onOwnerIdChange,
            label = { Text("TELEGRAM_OWNER_ID", fontFamily = FontFamily.Monospace, fontSize = 11.sp) },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            colors = fieldColors,
            shape = RoundedCornerShape(2.dp),
        )
        Spacer(modifier = Modifier.height(12.dp))

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
                shape = RoundedCornerShape(2.dp),
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
            shape = RoundedCornerShape(2.dp),
        )
        Spacer(modifier = Modifier.height(24.dp))

        Button(
            onClick = onStartAgent,
            modifier = Modifier
                .fillMaxWidth()
                .height(52.dp)
                .border(
                    1.dp,
                    if (apiKey.isNotBlank() && botToken.isNotBlank() && ownerId.isNotBlank())
                        SeekerClawColors.Primary
                    else
                        SeekerClawColors.TextDim,
                    RoundedCornerShape(2.dp),
                ),
            enabled = apiKey.isNotBlank() && botToken.isNotBlank() && ownerId.isNotBlank(),
            shape = RoundedCornerShape(2.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = SeekerClawColors.PrimaryGlow,
                contentColor = SeekerClawColors.Primary,
                disabledContainerColor = SeekerClawColors.Surface,
                disabledContentColor = SeekerClawColors.TextDim,
            ),
        ) {
            Text(
                "[ INITIALIZE AGENT ]",
                fontFamily = FontFamily.Monospace,
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 2.sp,
            )
        }
        Spacer(modifier = Modifier.height(12.dp))

        TextButton(onClick = onBack) {
            Text(
                "< back to scanner_",
                fontFamily = FontFamily.Monospace,
                color = SeekerClawColors.Accent,
                letterSpacing = 1.sp,
            )
        }

        Spacer(modifier = Modifier.height(24.dp))
    }
}
