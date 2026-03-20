package com.seekerclaw.app.ui.settings

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.service.OpenClawService
import com.seekerclaw.app.config.availableModels
import com.seekerclaw.app.config.availableProviders
import com.seekerclaw.app.config.modelsForProvider
import com.seekerclaw.app.config.openaiModels
import com.seekerclaw.app.config.providerById
import com.seekerclaw.app.util.Analytics
import com.seekerclaw.app.ui.theme.RethinkSans
import com.seekerclaw.app.ui.theme.SeekerClawColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.ui.text.input.KeyboardType
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProviderConfigScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var config by remember { mutableStateOf(ConfigManager.loadConfig(context)) }

    val activeProvider = providerById(config?.provider ?: "claude").id
    var editField by remember { mutableStateOf<String?>(null) }
    var editLabel by remember { mutableStateOf("") }
    var editValue by remember { mutableStateOf("") }
    var showModelPicker by remember { mutableStateOf(false) }
    var showAuthTypePicker by remember { mutableStateOf(false) }
    // OpenRouter model+context edit dialog state
    var orModelDialog by remember { mutableStateOf<String?>(null) } // "model" or "fallback"
    var orModelValue by remember { mutableStateOf("") }
    var orContextValue by remember { mutableStateOf("") }
    var testStatus by remember { mutableStateOf("Idle") }
    var testMessage by remember { mutableStateOf("") }
    var showRestartDialog by remember { mutableStateOf(false) }

    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)

    fun saveField(field: String, value: String, needsRestart: Boolean = false) {
        ConfigManager.updateConfigField(context, field, value)
        config = ConfigManager.loadConfig(context)
        if (needsRestart) showRestartDialog = true
    }

    fun maskKey(key: String?): String {
        if (key.isNullOrBlank()) return "Not set"
        if (key.length <= 8) return "*".repeat(key.length)
        return "${key.take(6)}${"*".repeat(8)}${key.takeLast(4)}"
    }

    fun switchProvider(newProviderId: String) {
        val oldProviderId = config?.provider ?: "claude"
        val currentModel = config?.model ?: ""

        // Remember the current model for the old provider before switching
        val prefs = context.getSharedPreferences("seekerclaw_prefs", android.content.Context.MODE_PRIVATE)
        prefs.edit().putString("lastModel_$oldProviderId", currentModel).apply()

        saveField("provider", newProviderId, needsRestart = true)

        // Restore last-used model for new provider, or fall back to first model
        val modelsForNew = modelsForProvider(newProviderId)
        if (modelsForNew.isEmpty()) {
            // Freeform provider (e.g. OpenRouter) — restore last-used or set default
            val savedModel = prefs.getString("lastModel_$newProviderId", null)
            val defaultModel = if (newProviderId == "openrouter") "anthropic/claude-sonnet-4-6" else ""
            saveField("model", savedModel?.takeIf { it.isNotBlank() } ?: defaultModel)
        } else {
            val savedModel = prefs.getString("lastModel_$newProviderId", null)
            val restoredModel = if (savedModel != null && modelsForNew.any { it.id == savedModel }) {
                savedModel
            } else {
                modelsForNew.firstOrNull()?.id ?: ""
            }
            if (modelsForNew.none { it.id == currentModel }) {
                saveField("model", restoredModel)
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = "AI Provider",
                        fontFamily = RethinkSans,
                        fontSize = 18.sp,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.TextPrimary,
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "Back",
                            tint = SeekerClawColors.TextPrimary,
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = SeekerClawColors.Background,
                ),
            )
        },
        containerColor = SeekerClawColors.Background,
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 20.dp, vertical = 8.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            // Provider selection — two rows matching existing field pattern
            ProviderSectionLabel("Provider")
            Spacer(modifier = Modifier.height(10.dp))

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SeekerClawColors.Surface, shape),
            ) {
                availableProviders.forEachIndexed { index, provider ->
                    val isActive = provider.id == activeProvider
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { if (!isActive) switchProvider(provider.id) }
                            .padding(horizontal = 16.dp, vertical = 14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = androidx.compose.foundation.layout.Arrangement.SpaceBetween,
                    ) {
                        Column {
                            Text(
                                text = provider.displayName,
                                fontFamily = RethinkSans,
                                fontSize = 14.sp,
                                fontWeight = if (isActive) FontWeight.Bold else FontWeight.Normal,
                                color = SeekerClawColors.TextPrimary,
                            )
                        }
                        if (isActive) {
                            Text(
                                text = "Active",
                                fontFamily = RethinkSans,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Medium,
                                color = SeekerClawColors.Accent,
                            )
                        }
                    }
                    if (index < availableProviders.size - 1) {
                        HorizontalDivider(
                            color = SeekerClawColors.TextDim.copy(alpha = 0.1f),
                            modifier = Modifier.padding(horizontal = 16.dp),
                        )
                    }
                }
            }

            // Active provider fields
            Spacer(modifier = Modifier.height(28.dp))
            ProviderSectionLabel("${providerById(activeProvider).displayName} Settings")
            Spacer(modifier = Modifier.height(10.dp))

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SeekerClawColors.Surface, shape),
            ) {
                when (activeProvider) {
                    "claude" -> {
                        val authTypeLabel = if (config?.authType == "setup_token") "Pro/Max Setup Token" else "API Key"
                        ProviderConfigField(
                            label = "Model",
                            value = availableModels.find { it.id == config?.model }
                                ?.let { "${it.displayName} (${it.description})" }
                                ?: config?.model?.ifBlank { "Not set" } ?: "Not set",
                            onClick = { showModelPicker = true },
                            info = SettingsHelpTexts.MODEL,
                        )
                        ProviderConfigField(
                            label = "Auth Type",
                            value = authTypeLabel,
                            onClick = { showAuthTypePicker = true },
                            info = SettingsHelpTexts.AUTH_TYPE,
                        )
                        ProviderConfigField(
                            label = if (config?.authType == "api_key") "API Key (active)" else "API Key",
                            value = maskKey(config?.anthropicApiKey),
                            onClick = {
                                editField = "anthropicApiKey"
                                editLabel = "Anthropic API Key"
                                editValue = config?.anthropicApiKey ?: ""
                            },
                            info = SettingsHelpTexts.API_KEY,
                            isRequired = config?.authType == "api_key",
                        )
                        ProviderConfigField(
                            label = if (config?.authType == "setup_token") "Setup Token (active)" else "Setup Token",
                            value = maskKey(config?.setupToken),
                            onClick = {
                                editField = "setupToken"
                                editLabel = "Setup Token"
                                editValue = config?.setupToken ?: ""
                            },
                            info = SettingsHelpTexts.SETUP_TOKEN,
                            isRequired = config?.authType == "setup_token",
                            showDivider = false,
                        )
                    }
                    "openai" -> {
                        ProviderConfigField(
                            label = "Model",
                            value = openaiModels.find { it.id == config?.model }
                                ?.let { "${it.displayName} (${it.description})" }
                                ?: config?.model?.ifBlank { "Not set" } ?: "Not set",
                            onClick = { showModelPicker = true },
                            info = SettingsHelpTexts.MODEL,
                        )
                        ProviderConfigField(
                            label = "API Key",
                            value = maskKey(config?.openaiApiKey),
                            onClick = {
                                editField = "openaiApiKey"
                                editLabel = "OpenAI API Key"
                                editValue = config?.openaiApiKey ?: ""
                            },
                            info = SettingsHelpTexts.OPENAI_API_KEY,
                            isRequired = true,
                            showDivider = false,
                        )
                    }
                    "openrouter" -> {
                        val modelCtxDisplay = config?.openrouterModelContext?.ifBlank { null }
                            ?.let { " ($it ctx)" } ?: ""
                        ProviderConfigField(
                            label = "Model",
                            value = (config?.model?.ifBlank { "Not set" } ?: "Not set") + modelCtxDisplay,
                            onClick = {
                                orModelDialog = "model"
                                orModelValue = config?.model ?: ""
                                orContextValue = config?.openrouterModelContext ?: ""
                            },
                            info = "Full model ID from openrouter.ai/models (e.g. anthropic/claude-sonnet-4-6)",
                        )
                        val fallbackCtxDisplay = config?.openrouterFallbackContext?.ifBlank { null }
                            ?.let { " ($it ctx)" } ?: ""
                        ProviderConfigField(
                            label = "Fallback Model (optional)",
                            value = (config?.openrouterFallbackModel?.ifBlank { "Not set" } ?: "Not set") + fallbackCtxDisplay,
                            onClick = {
                                orModelDialog = "fallback"
                                orModelValue = config?.openrouterFallbackModel ?: ""
                                orContextValue = config?.openrouterFallbackContext ?: ""
                            },
                            info = "Auto-switches if primary model is down (e.g. google/gemini-2.5-pro)",
                        )
                        ProviderConfigField(
                            label = "API Key",
                            value = maskKey(config?.openrouterApiKey),
                            onClick = {
                                editField = "openrouterApiKey"
                                editLabel = "OpenRouter API Key"
                                editValue = config?.openrouterApiKey ?: ""
                            },
                            info = "Get your key at openrouter.ai/keys",
                            isRequired = true,
                            showDivider = false,
                        )
                    }
                }
            }

            // Connection test
            Spacer(modifier = Modifier.height(28.dp))
            ProviderSectionLabel("Connection Test")
            Spacer(modifier = Modifier.height(10.dp))

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SeekerClawColors.Surface, shape)
                    .padding(16.dp),
            ) {
                Text(
                    text = "Verify your credentials are valid and the API is reachable.",
                    fontFamily = RethinkSans,
                    fontSize = 13.sp,
                    color = SeekerClawColors.TextDim,
                )
                Spacer(modifier = Modifier.height(12.dp))

                Button(
                    onClick = {
                        if (testStatus == "Loading") return@Button
                        testStatus = "Loading"
                        testMessage = ""
                        scope.launch {
                            val result = when (activeProvider) {
                                "openrouter" -> testOpenRouterConnection(config?.openrouterApiKey ?: "")
                                "openai" -> testOpenAIConnection(config?.openaiApiKey ?: "")
                                else -> {
                                    // Use Anthropic-specific credential derived from authType
                                    val authType = config?.authType ?: "api_key"
                                    val anthropicCredential = if (authType == "setup_token") {
                                        config?.setupToken ?: ""
                                    } else {
                                        config?.anthropicApiKey ?: ""
                                    }
                                    testAnthropicConnection(anthropicCredential, authType)
                                }
                            }
                            if (result.isSuccess) {
                                testStatus = "Success"
                                testMessage = "Connection successful!"
                            } else {
                                testStatus = "Error"
                                testMessage = result.exceptionOrNull()?.message ?: "Connection failed"
                            }
                        }
                    },
                    enabled = testStatus != "Loading",
                    modifier = Modifier.fillMaxWidth(),
                    shape = shape,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = SeekerClawColors.ActionPrimary,
                        contentColor = Color.White,
                    ),
                ) {
                    if (testStatus == "Loading") {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp),
                            strokeWidth = 2.dp,
                            color = Color.White,
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("Testing...", fontFamily = RethinkSans, fontSize = 14.sp)
                    } else {
                        Text("Test Connection", fontFamily = RethinkSans, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                    }
                }

                if (testStatus == "Success" || testStatus == "Error") {
                    Spacer(modifier = Modifier.height(12.dp))
                    Text(
                        text = testMessage,
                        fontFamily = RethinkSans,
                        fontSize = 13.sp,
                        color = if (testStatus == "Success") SeekerClawColors.ActionPrimary else SeekerClawColors.Error,
                    )
                }
            }

            Spacer(modifier = Modifier.height(20.dp))
        }
    }

    // Edit dialog
    if (editField != null) {
        ProviderEditDialog(
            editField = editField,
            editLabel = editLabel,
            editValue = editValue,
            onValueChange = { editValue = it },
            onSave = {
                val field = editField ?: return@ProviderEditDialog
                val trimmed = editValue.trim()
                // Optional fields that can be cleared to empty
                val clearableFields = setOf("openrouterFallbackModel")
                if (field == "setupToken") {
                    saveField(field, trimmed, needsRestart = true)
                    if (trimmed.isNotEmpty()) saveField("authType", "setup_token")
                } else if (trimmed.isNotEmpty() || field in clearableFields) {
                    if (field == "anthropicApiKey") {
                        val detected = ConfigManager.detectAuthType(trimmed)
                        if (detected == "setup_token") {
                            saveField("setupToken", trimmed, needsRestart = true)
                            saveField("authType", "setup_token")
                            editField = null
                            return@ProviderEditDialog
                        }
                    }
                    saveField(field, trimmed, needsRestart = true)
                }
                editField = null
            },
            onDismiss = { editField = null },
        )
    }

    // OpenRouter model + context edit dialog
    if (orModelDialog != null) {
        val isModel = orModelDialog == "model"
        val title = if (isModel) "Edit Model" else "Edit Fallback Model"
        val modelField = if (isModel) "model" else "openrouterFallbackModel"
        val contextField = if (isModel) "openrouterModelContext" else "openrouterFallbackContext"

        OpenRouterModelEditDialog(
            title = title,
            modelValue = orModelValue,
            contextValue = orContextValue,
            onModelChange = { orModelValue = it },
            onContextChange = { orContextValue = it },
            isRequired = isModel,
            onSave = {
                val trimmedModel = orModelValue.trim()
                val trimmedCtx = orContextValue.trim()
                if (trimmedModel.isNotEmpty() || !isModel) {
                    saveField(modelField, trimmedModel, needsRestart = true)
                }
                // Validate + clamp context: empty is OK, otherwise 4096..2000000
                if (trimmedCtx.isEmpty()) {
                    saveField(contextField, "")
                } else {
                    val num = trimmedCtx.toLongOrNull()
                    if (num != null) {
                        val clamped = num.coerceIn(4096, 2_000_000)
                        saveField(contextField, clamped.toString())
                    }
                    // Non-numeric silently ignored (field stays unchanged)
                }
                orModelDialog = null
            },
            onDismiss = { orModelDialog = null },
        )
    }

    // Model picker dialog — shows models for active provider only (skip for freeform providers)
    if (showModelPicker && modelsForProvider(activeProvider).isNotEmpty()) {
        val models = modelsForProvider(activeProvider)
        var selectedModel by remember {
            mutableStateOf(models.firstOrNull { it.id == config?.model }?.id ?: models.firstOrNull()?.id ?: "")
        }

        AlertDialog(
            onDismissRequest = { showModelPicker = false },
            title = {
                Text(
                    "Select Model",
                    fontFamily = RethinkSans,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.TextPrimary,
                )
            },
            text = {
                Column {
                    models.forEach { model ->
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
                                    fontFamily = RethinkSans,
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
                        saveField("model", selectedModel, needsRestart = true)
                        Analytics.modelSelected(selectedModel)
                        showModelPicker = false
                    },
                ) {
                    Text("Save", fontFamily = RethinkSans, fontWeight = FontWeight.Bold, color = SeekerClawColors.ActionPrimary)
                }
            },
            dismissButton = {
                TextButton(onClick = { showModelPicker = false }) {
                    Text("Cancel", fontFamily = RethinkSans, color = SeekerClawColors.TextDim)
                }
            },
            containerColor = SeekerClawColors.Surface,
            shape = shape,
        )
    }

    // Auth type picker (Claude only)
    if (showAuthTypePicker) {
        val authOptions = listOf("api_key" to "API Key", "setup_token" to "Pro/Max Setup Token")
        var selectedAuth by remember { mutableStateOf(config?.authType ?: "api_key") }

        AlertDialog(
            onDismissRequest = { showAuthTypePicker = false },
            title = {
                Text("Auth Type", fontFamily = RethinkSans, fontWeight = FontWeight.Bold, color = SeekerClawColors.TextPrimary)
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
                                fontFamily = RethinkSans,
                                fontSize = 14.sp,
                                color = SeekerClawColors.TextPrimary,
                                modifier = Modifier.padding(start = 8.dp),
                            )
                        }
                    }
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = "Both credentials are stored. Switching just changes which one is used.",
                        fontFamily = RethinkSans,
                        fontSize = 12.sp,
                        color = SeekerClawColors.TextDim,
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        saveField("authType", selectedAuth, needsRestart = true)
                        Analytics.authTypeChanged(selectedAuth)
                        showAuthTypePicker = false
                    },
                ) {
                    Text("Save", fontFamily = RethinkSans, fontWeight = FontWeight.Bold, color = SeekerClawColors.ActionPrimary)
                }
            },
            dismissButton = {
                TextButton(onClick = { showAuthTypePicker = false }) {
                    Text("Cancel", fontFamily = RethinkSans, color = SeekerClawColors.TextDim)
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
                    fontFamily = RethinkSans,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.TextPrimary,
                )
            },
            text = {
                Text(
                    "Restart the agent to apply changes?",
                    fontFamily = RethinkSans,
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
                        fontFamily = RethinkSans,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Primary,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showRestartDialog = false }) {
                    Text(
                        "Later",
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

internal suspend fun testAnthropicConnection(credential: String, authType: String): Result<Unit> = withContext(Dispatchers.IO) {
    runCatching {
        if (credential.isBlank()) error("Credential is empty")
        val url = URL("https://api.anthropic.com/v1/models")
        val conn = url.openConnection() as HttpURLConnection
        conn.requestMethod = "GET"
        if (authType == "setup_token") {
            conn.setRequestProperty("Authorization", "Bearer $credential")
            conn.setRequestProperty("anthropic-beta", "prompt-caching-2024-07-31,oauth-2025-04-20")
        } else {
            conn.setRequestProperty("x-api-key", credential)
            conn.setRequestProperty("anthropic-beta", "prompt-caching-2024-07-31")
        }
        conn.setRequestProperty("anthropic-version", "2023-06-01")
        conn.connectTimeout = 15000
        conn.readTimeout = 15000
        try {
            val status = conn.responseCode
            if (status in 200..299) return@runCatching
            val errorMessage = when {
                status == 401 || status == 403 -> "Unauthorized / Invalid credential"
                status in 500..599 -> "Anthropic API unavailable"
                else -> {
                    val errorStream = conn.errorStream?.bufferedReader()?.use { it.readText() } ?: ""
                    try {
                        val json = JSONObject(errorStream)
                        val err = json.optJSONObject("error")
                        if (err?.has("message") == true) "HTTP $status: ${err.getString("message")}" else "HTTP $status"
                    } catch (_: Exception) { "HTTP $status" }
                }
            }
            error("Connection failed ($errorMessage)")
        } catch (_: java.net.SocketTimeoutException) {
            error("Connection timed out")
        } catch (_: java.io.IOException) {
            error("Network unreachable or timeout")
        } finally { conn.disconnect() }
    }
}

private suspend fun testOpenRouterConnection(apiKey: String): Result<Unit> = withContext(Dispatchers.IO) {
    runCatching {
        if (apiKey.isBlank()) error("API key is empty")
        // Use /api/v1/auth/key — validates the key and returns account info.
        // /api/v1/models is public and returns 200 for any key.
        val url = URL("https://openrouter.ai/api/v1/auth/key")
        val conn = url.openConnection() as HttpURLConnection
        conn.requestMethod = "GET"
        conn.setRequestProperty("Authorization", "Bearer $apiKey")
        conn.setRequestProperty("HTTP-Referer", "https://seekerclaw.com")
        conn.setRequestProperty("X-Title", "SeekerClaw")
        conn.connectTimeout = 15000
        conn.readTimeout = 15000
        try {
            val status = conn.responseCode
            if (status in 200..299) return@runCatching
            val errorBody = try {
                (conn.errorStream ?: conn.inputStream)?.bufferedReader()?.use { r -> r.readText() } ?: ""
            } catch (_: Exception) { "" }
            val apiMessage = try {
                JSONObject(errorBody).optJSONObject("error")?.optString("message", "") ?: ""
            } catch (_: Exception) { "" }
            val errorMessage = when {
                status == 401 -> apiMessage.ifBlank { "Invalid API key" }
                status == 402 -> "Insufficient credits — add funds at openrouter.ai/credits"
                status == 429 -> "Rate limited — try again in a moment"
                status in 500..599 -> "OpenRouter API unavailable"
                else -> apiMessage.ifBlank { "HTTP $status" }
            }
            error("Connection failed ($errorMessage)")
        } catch (_: java.net.SocketTimeoutException) {
            error("Connection timed out")
        } catch (_: java.io.IOException) {
            error("Network unreachable or timeout")
        } finally { conn.disconnect() }
    }
}

private suspend fun testOpenAIConnection(apiKey: String): Result<Unit> = withContext(Dispatchers.IO) {
    runCatching {
        if (apiKey.isBlank()) error("API key is empty")
        val url = URL("https://api.openai.com/v1/models")
        val conn = url.openConnection() as HttpURLConnection
        conn.requestMethod = "GET"
        conn.setRequestProperty("Authorization", "Bearer $apiKey")
        conn.connectTimeout = 15000
        conn.readTimeout = 15000
        try {
            val status = conn.responseCode
            if (status in 200..299) return@runCatching
            // Parse error body for actionable message
            val errorBody = try {
                val stream = conn.errorStream ?: conn.inputStream
                stream?.bufferedReader()?.readText() ?: ""
            } catch (_: Exception) { "" }
            val apiMessage = try {
                org.json.JSONObject(errorBody).optJSONObject("error")?.optString("message", "") ?: ""
            } catch (_: Exception) { "" }
            val errorMessage = when {
                status == 401 || status == 403 -> apiMessage.ifBlank { "Unauthorized / Invalid API key" }
                status == 429 -> "Rate limited — try again in a moment"
                status in 500..599 -> "OpenAI API unavailable"
                else -> apiMessage.ifBlank { "HTTP $status" }
            }
            error("Connection failed ($errorMessage)")
        } catch (_: java.net.SocketTimeoutException) {
            error("Connection timed out")
        } catch (_: java.io.IOException) {
            error("Network unreachable or timeout")
        } finally { conn.disconnect() }
    }
}

@Composable
fun OpenRouterModelEditDialog(
    title: String,
    modelValue: String,
    contextValue: String,
    onModelChange: (String) -> Unit,
    onContextChange: (String) -> Unit,
    isRequired: Boolean,
    onSave: () -> Unit,
    onDismiss: () -> Unit,
) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)
    val fieldColors = OutlinedTextFieldDefaults.colors(
        focusedBorderColor = SeekerClawColors.Primary,
        unfocusedBorderColor = SeekerClawColors.TextDim.copy(alpha = 0.3f),
        cursorColor = SeekerClawColors.Primary,
        focusedTextColor = SeekerClawColors.TextPrimary,
        unfocusedTextColor = SeekerClawColors.TextPrimary,
    )
    val monoStyle = androidx.compose.ui.text.TextStyle(
        fontFamily = FontFamily.Monospace,
        fontSize = 14.sp,
        color = SeekerClawColors.TextPrimary,
    )

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                title,
                fontFamily = RethinkSans,
                fontWeight = FontWeight.Bold,
                color = SeekerClawColors.TextPrimary,
            )
        },
        text = {
            Column {
                OutlinedTextField(
                    value = modelValue,
                    onValueChange = onModelChange,
                    label = {
                        Text(
                            if (isRequired) "Model ID *" else "Model ID (optional)",
                            fontFamily = RethinkSans,
                            fontSize = 12.sp,
                        )
                    },
                    placeholder = { Text("e.g. anthropic/claude-sonnet-4-6", fontSize = 12.sp, color = SeekerClawColors.TextDim) },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    textStyle = monoStyle,
                    colors = fieldColors,
                )
                Spacer(modifier = Modifier.height(12.dp))
                OutlinedTextField(
                    value = contextValue,
                    onValueChange = { new -> onContextChange(new.filter { it.isDigit() }) },
                    label = { Text("Context Length (optional)", fontFamily = RethinkSans, fontSize = 12.sp) },
                    placeholder = { Text("Default: 128000", fontSize = 12.sp, color = SeekerClawColors.TextDim) },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    textStyle = monoStyle,
                    colors = fieldColors,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                )
                Text(
                    "Max tokens the model supports. Check openrouter.ai/models",
                    fontFamily = RethinkSans,
                    fontSize = 11.sp,
                    color = SeekerClawColors.TextDim,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        },
        confirmButton = {
            TextButton(onClick = onSave) {
                Text(
                    "Save",
                    fontFamily = RethinkSans,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.ActionPrimary,
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
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
