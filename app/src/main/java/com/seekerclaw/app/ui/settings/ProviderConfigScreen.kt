package com.seekerclaw.app.ui.settings

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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import com.seekerclaw.app.ui.components.SeekerClawScaffold
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults

import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import com.seekerclaw.app.ui.components.CardSurface

import com.seekerclaw.app.ui.components.SectionLabel
import com.seekerclaw.app.ui.components.ConfigField
import com.seekerclaw.app.config.ConfigManager
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

@Composable
fun ProviderConfigScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val configVer by ConfigManager.configVersion
    var config by remember(configVer) { mutableStateOf(ConfigManager.loadConfig(context)) }

    val activeProvider = providerById(config?.provider ?: "claude").id
    var editField by remember { mutableStateOf<String?>(null) }
    var editLabel by remember { mutableStateOf("") }
    var editValue by remember { mutableStateOf("") }
    var showModelPicker by remember { mutableStateOf(false) }
    var showAuthTypePicker by remember { mutableStateOf(false) }
    var showCustomFormatPicker by remember { mutableStateOf(false) }
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

    fun customFormatLabel(value: String?): String = when (value) {
        "responses" -> "Responses API"
        else -> "Chat Completions"
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
            val defaultModel = when (newProviderId) {
                "openrouter" -> "anthropic/claude-sonnet-4-6"
                "custom" -> ""
                else -> ""
            }
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

    SeekerClawScaffold(title = "AI Provider", onBack = onBack) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 20.dp, vertical = 8.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            // Provider selection — two rows matching existing field pattern
            SectionLabel("Provider")
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
                            color = SeekerClawColors.CardBorder,
                            modifier = Modifier.padding(horizontal = 16.dp),
                        )
                    }
                }
            }

            // Active provider fields
            Spacer(modifier = Modifier.height(28.dp))
            SectionLabel("${providerById(activeProvider).displayName} Settings")
            Spacer(modifier = Modifier.height(10.dp))

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SeekerClawColors.Surface, shape),
            ) {
                when (activeProvider) {
                    "claude" -> {
                        val authTypeLabel = if (config?.authType == "setup_token") "Pro/Max Setup Token" else "API Key"
                        ConfigField(
                            label = "Model",
                            value = availableModels.find { it.id == config?.model }
                                ?.let { "${it.displayName} (${it.description})" }
                                ?: config?.model?.ifBlank { "Not set" } ?: "Not set",
                            onClick = { showModelPicker = true },
                            info = SettingsHelpTexts.MODEL,
                        )
                        ConfigField(
                            label = "Auth Type",
                            value = authTypeLabel,
                            onClick = { showAuthTypePicker = true },
                            info = SettingsHelpTexts.AUTH_TYPE,
                        )
                        ConfigField(
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
                        ConfigField(
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
                        ConfigField(
                            label = "Model",
                            value = openaiModels.find { it.id == config?.model }
                                ?.let { "${it.displayName} (${it.description})" }
                                ?: config?.model?.ifBlank { "Not set" } ?: "Not set",
                            onClick = { showModelPicker = true },
                            info = SettingsHelpTexts.MODEL,
                        )
                        ConfigField(
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
                        ConfigField(
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
                        ConfigField(
                            label = "Fallback Model (optional)",
                            value = (config?.openrouterFallbackModel?.ifBlank { "Not set" } ?: "Not set") + fallbackCtxDisplay,
                            onClick = {
                                orModelDialog = "fallback"
                                orModelValue = config?.openrouterFallbackModel ?: ""
                                orContextValue = config?.openrouterFallbackContext ?: ""
                            },
                            info = "Auto-switches if primary model is down (e.g. google/gemini-2.5-pro)",
                        )
                        ConfigField(
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
                    "custom" -> {
                        ConfigField(
                            label = "Model",
                            value = config?.model?.ifBlank { "Not set" } ?: "Not set",
                            onClick = { editField = "model"; editLabel = "Model ID"; editValue = config?.model ?: "" },
                            info = "Model ID expected by your gateway (e.g. gpt-4.1-mini, deepseek-chat).",
                            isRequired = true,
                        )
                        ConfigField(
                            label = "Endpoint URL",
                            value = config?.customBaseUrl?.ifBlank { "Not set" } ?: "Not set",
                            onClick = { editField = "customBaseUrl"; editLabel = "Endpoint URL"; editValue = config?.customBaseUrl ?: "" },
                            info = "Full inference endpoint URL (e.g. https://your-gateway/v1/chat/completions or /v1/responses).",
                            isRequired = true,
                        )
                        if (config?.customBaseUrl?.startsWith("http://") == true) {
                            Text(
                                text = "\u26A0 Unencrypted connection \u2014 API key will be sent in plaintext",
                                color = Color(0xFFFF9800),
                                fontSize = 12.sp,
                                fontFamily = RethinkSans,
                                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                            )
                        }
                        ConfigField(
                            label = "API Format",
                            value = customFormatLabel(config?.customFormat),
                            onClick = { showCustomFormatPicker = true },
                            info = "Wire format your gateway expects.",
                        )
                        ConfigField(
                            label = "Extra Headers (JSON)",
                            value = config?.customHeaders?.ifBlank { "Not set" } ?: "Not set",
                            onClick = { editField = "customHeaders"; editLabel = "Extra Headers (JSON)"; editValue = config?.customHeaders ?: "" },
                            info = "Optional JSON object. Example: {\"X-API-Key\":\"...\"}",
                        )
                        ConfigField(
                            label = "API Key",
                            value = maskKey(config?.customApiKey),
                            onClick = { editField = "customApiKey"; editLabel = "API Key"; editValue = config?.customApiKey ?: "" },
                            info = "Used as Bearer auth unless Authorization is in Extra Headers.",
                            isRequired = true,
                            showDivider = false,
                        )
                    }
                }
            }

            // Connection test
            Spacer(modifier = Modifier.height(28.dp))
            SectionLabel("Connection Test")
            Spacer(modifier = Modifier.height(10.dp))

            CardSurface {
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
                                "custom" -> testCustomConnection(
                                    endpointUrl = config?.customBaseUrl ?: "",
                                    apiKey = config?.customApiKey ?: "",
                                    model = config?.model ?: "",
                                    format = config?.customFormat ?: "chat_completions",
                                    extraHeaders = config?.customHeaders ?: "",
                                )
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
                val clearableFields = setOf("openrouterFallbackModel", "customHeaders")
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

    if (showCustomFormatPicker) {
        val formatOptions = listOf("chat_completions" to "Chat Completions", "responses" to "Responses API")
        var selectedFormat by remember { mutableStateOf(config?.customFormat ?: "chat_completions") }
        AlertDialog(
            onDismissRequest = { showCustomFormatPicker = false },
            title = { Text("API Format", fontFamily = RethinkSans, fontWeight = FontWeight.Bold, color = SeekerClawColors.TextPrimary) },
            text = {
                Column {
                    formatOptions.forEach { (formatId, label) ->
                        Row(
                            modifier = Modifier.fillMaxWidth().clickable { selectedFormat = formatId }.padding(vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = selectedFormat == formatId, onClick = { selectedFormat = formatId },
                                colors = RadioButtonDefaults.colors(selectedColor = SeekerClawColors.Primary, unselectedColor = SeekerClawColors.TextDim))
                            Column(modifier = Modifier.padding(start = 8.dp)) {
                                Text(label, fontFamily = RethinkSans, fontSize = 14.sp, color = SeekerClawColors.TextPrimary)
                                Text(if (formatId == "responses") "OpenAI Responses API format" else "Standard /v1/chat/completions format",
                                    fontFamily = RethinkSans, fontSize = 12.sp, color = SeekerClawColors.TextDim)
                            }
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { saveField("customFormat", selectedFormat, needsRestart = true); showCustomFormatPicker = false }) {
                    Text("Save", fontFamily = RethinkSans, fontWeight = FontWeight.Bold, color = SeekerClawColors.ActionPrimary)
                }
            },
            dismissButton = {
                TextButton(onClick = { showCustomFormatPicker = false }) { Text("Cancel", fontFamily = RethinkSans, color = SeekerClawColors.TextDim) }
            },
            containerColor = SeekerClawColors.Surface,
            shape = RoundedCornerShape(16.dp),
        )
    }

    // ==================== Restart Prompt ====================
    if (showRestartDialog) {
        RestartDialog(
            context = context,
            onDismiss = { showRestartDialog = false },
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

private suspend fun testCustomConnection(
    endpointUrl: String, apiKey: String, model: String, format: String, extraHeaders: String,
): Result<Unit> = withContext(Dispatchers.IO) {
    runCatching {
        val trimmedUrl = endpointUrl.trim()
        if (trimmedUrl.isBlank()) error("Endpoint URL is empty")
        if (apiKey.isBlank()) error("API key is empty")
        if (model.isBlank()) error("Model is empty")
        val headersJson = extraHeaders.trim().takeIf { it.isNotBlank() }?.let {
            try { org.json.JSONObject(it) } catch (_: Exception) { error("Extra Headers must be valid JSON") }
        }
        val url = java.net.URL(trimmedUrl)
        val conn = url.openConnection() as java.net.HttpURLConnection
        conn.requestMethod = "POST"; conn.doOutput = true; conn.connectTimeout = 15000; conn.readTimeout = 15000
        conn.setRequestProperty("Content-Type", "application/json")
        val hasAuthHeader = headersJson?.keys()?.asSequence()?.any { key ->
            key.equals("Authorization", ignoreCase = true) && headersJson.optString(key, "").isNotBlank()
        } ?: false
        if (!hasAuthHeader) {
            conn.setRequestProperty("Authorization", "Bearer $apiKey")
        }
        headersJson?.keys()?.forEach { key ->
            val value = headersJson.opt(key)?.toString()?.trim().orEmpty()
                .replace(Regex("[\r\n]+"), " ") // sanitize CRLF injection
            val safeKey = key.replace(Regex("[\r\n]+"), "")
            if (safeKey.isNotBlank() && value.isNotBlank()) conn.setRequestProperty(safeKey, value)
        }
        val payload = if (format == "responses") {
            org.json.JSONObject().apply { put("model", model); put("input", "ping"); put("max_output_tokens", 1) }
        } else {
            org.json.JSONObject().apply {
                put("model", model); put("max_tokens", 1)
                put("messages", org.json.JSONArray().put(org.json.JSONObject().apply { put("role", "user"); put("content", "ping") }))
            }
        }
        try {
            conn.outputStream.bufferedWriter().use { it.write(payload.toString()) }
            val status = conn.responseCode
            if (status in 200..299) return@runCatching
            val errorBody = try { (conn.errorStream ?: conn.inputStream)?.bufferedReader()?.use { it.readText() } ?: "" } catch (_: Exception) { "" }
            val apiMessage = try { org.json.JSONObject(errorBody).optJSONObject("error")?.optString("message", "") ?: "" } catch (_: Exception) { "" }
            error("Connection failed (${apiMessage.ifBlank { "HTTP $status" }})")
        } catch (_: java.net.SocketTimeoutException) { error("Connection timed out")
        } catch (_: java.io.IOException) { error("Network unreachable or timeout")
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
