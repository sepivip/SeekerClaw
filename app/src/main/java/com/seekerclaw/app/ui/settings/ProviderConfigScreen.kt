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
import androidx.compose.foundation.BorderStroke
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
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
import com.seekerclaw.app.config.OPENROUTER_DEFAULT_MODEL
import com.seekerclaw.app.config.modelsForProvider
import com.seekerclaw.app.config.providerById
import com.seekerclaw.app.oauth.OpenAIOAuthActivity
import com.seekerclaw.app.util.Analytics
import com.seekerclaw.app.ui.theme.RethinkSans
import com.seekerclaw.app.ui.theme.SeekerClawColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.text.input.KeyboardType
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

// Sentinel for the "Custom model" radio in the model picker. Must NOT be a valid model id —
// using "__custom__" so a real model literally named "custom" can still be entered freely.
private const val CUSTOM_MODEL_SENTINEL = "__custom__"

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
    // OpenAI OAuth state
    var oauthRequestId by remember { mutableStateOf<String?>(null) }
    var oauthPolling by remember { mutableStateOf(false) }
    var oauthError by remember { mutableStateOf<String?>(null) }
    // Note: device code UI removed — only browser flow used for now

    // Clean up stale OAuth result files when this screen opens. If the user navigated
    // away mid-flow or the process was killed, orphaned status files can accumulate
    // under filesDir/oauth_results. Anything older than 1 hour is safe to delete.
    LaunchedEffect(Unit) {
        withContext(Dispatchers.IO) {
            try {
                val resultsDir = File(context.filesDir, OpenAIOAuthActivity.RESULTS_DIR)
                if (resultsDir.isDirectory) {
                    val cutoff = System.currentTimeMillis() - 3_600_000L
                    resultsDir.listFiles()?.forEach { f ->
                        if (f.lastModified() < cutoff) f.delete()
                    }
                }
            } catch (_: Exception) { /* best effort */ }
        }
    }

    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)

    // OAuth result file polling
    LaunchedEffect(oauthRequestId, oauthPolling) {
        val reqId = oauthRequestId ?: return@LaunchedEffect
        if (!oauthPolling) return@LaunchedEffect
        val resultsDir = File(context.filesDir, OpenAIOAuthActivity.RESULTS_DIR)
        val resultFile = File(resultsDir, "$reqId.json")
        val deadline = System.currentTimeMillis() + 600_000 // 10 min timeout — browser PKCE sign-in/consent can take a while
        while (oauthPolling && System.currentTimeMillis() < deadline) {
            delay(1000)
            val exists = withContext(Dispatchers.IO) { resultFile.exists() }
            if (!exists) continue
            try {
                val json = withContext(Dispatchers.IO) {
                    val text = resultFile.readText()
                    resultFile.delete()
                    JSONObject(text)
                }
                when (json.optString("status")) {
                    "success" -> {
                        // Tokens were persisted directly by OpenAIOAuthActivity via
                        // ConfigManager.saveConfig. authType is already "oauth" (the
                        // picker saves it on selection), so we just reload to pick up
                        // the new token and pop the restart dialog.
                        config = withContext(Dispatchers.IO) { ConfigManager.loadConfig(context) }
                        showRestartDialog = true
                        oauthPolling = false
                    }
                    "error" -> {
                        oauthError = json.optString("message", "Unknown error")
                        oauthPolling = false
                    }
                    else -> {
                        oauthError = "Unexpected OAuth result status: ${json.optString("status")}"
                        oauthPolling = false
                    }
                }
            } catch (e: Exception) {
                oauthError = "Failed to read OAuth result: ${e.message}"
                oauthPolling = false
            }
        }
        if (oauthPolling) {
            oauthError = "OAuth timed out. Please try again."
            oauthPolling = false
        }
    }

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
        // `switchProvider` is conceptually ONE user action — it should persist atomically.
        // Batching the 2-3 field mutations (provider + authType + possibly model) into a
        // single `saveConfig` avoids: (a) 3x disk writes on slow storage, (b) 3x
        // configVersion bumps re-rendering every observer, (c) observers briefly seeing
        // an inconsistent intermediate state like "OpenAI + setup_token + claude-opus".
        val current = config ?: return
        val oldProviderId = current.provider
        val oldAuthType = current.authType
        val currentModel = current.model

        // Cancel any in-progress OAuth polling — leaving it running across a provider
        // switch would let a stale callback flip authType or pop a restart dialog for
        // a provider the user already left.
        if (oldProviderId == "openai" && newProviderId != "openai") {
            oauthPolling = false
            oauthRequestId = null
            oauthError = null
        }

        // Remember per-provider last-used model and authType (similar to lastModel_*)
        // so explicit choices survive a round-trip through another provider. These are
        // cheap prefs-only writes, not full config saves.
        val prefs = context.getSharedPreferences("seekerclaw_prefs", android.content.Context.MODE_PRIVATE)
        prefs.edit()
            .putString("lastModel_$oldProviderId", currentModel)
            .putString("lastAuthType_$oldProviderId", oldAuthType)
            .apply()

        // Resolve the effective authType for the new provider. OpenAI defaults to OAuth
        // (ChatGPT subscription) on first switch-in — the OAuth section shows a Sign In
        // button. writeConfigJson translates oauth+blank → api_key only so Node doesn't
        // crash on an unsupported authType combination; a valid OpenAI API key is still
        // required if the user never completes sign-in. Explicit picker choice is
        // remembered per-provider via lastAuthType_<id>.
        val savedNewAuthType = prefs.getString("lastAuthType_$newProviderId", null)
        val effectiveAuthType = when (newProviderId) {
            "openai" -> when (savedNewAuthType) {
                "oauth", "api_key" -> savedNewAuthType
                else -> "oauth" // first-time switch-in default
            }
            "claude" -> when (savedNewAuthType) {
                "api_key", "setup_token" -> savedNewAuthType
                else -> if (oldAuthType == "setup_token") "setup_token" else "api_key"
            }
            else -> "api_key"
        }

        // Resolve the effective model for the new provider.
        val modelsForNew = modelsForProvider(newProviderId, effectiveAuthType)
        val savedModel = prefs.getString("lastModel_$newProviderId", null)
        val effectiveModel: String = if (modelsForNew.isEmpty()) {
            // Freeform provider (e.g. OpenRouter) — restore last-used or set default
            val defaultModel = when (newProviderId) {
                "openrouter" -> OPENROUTER_DEFAULT_MODEL
                "custom" -> ""
                else -> ""
            }
            savedModel?.takeIf { it.isNotBlank() } ?: defaultModel
        } else {
            if (modelsForNew.any { it.id == currentModel }) {
                // Current model is still valid — keep it.
                currentModel
            } else if (savedModel != null && modelsForNew.any { it.id == savedModel }) {
                savedModel
            } else {
                modelsForNew.firstOrNull()?.id ?: ""
            }
        }

        // Single atomic save.
        ConfigManager.saveConfig(
            context,
            current.copy(
                provider = newProviderId,
                authType = effectiveAuthType,
                model = effectiveModel,
            )
        )
        config = ConfigManager.loadConfig(context)
        showRestartDialog = true
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
                        // Match Node's view: only "oauth" is OAuth; everything else is API key.
                        // switchProvider() defaults OpenAI to "oauth" on first switch-in (unless
                        // a previous lastAuthType_openai is being restored), so this branch
                        // normally reflects the saved choice. The guard normalizes any legacy
                        // or drifted non-"oauth" value to "api_key".
                        val openaiAuthType = if (config?.authType == "oauth") "oauth" else "api_key"
                        val openaiModelList = modelsForProvider("openai", openaiAuthType)
                        // Auth Type first (determines model list + credential UI)
                        val openaiAuthLabel = if (openaiAuthType == "oauth") "ChatGPT OAuth" else "API Key"
                        ConfigField(
                            label = "Auth Type",
                            value = openaiAuthLabel,
                            onClick = { showAuthTypePicker = true },
                            info = "API Key uses your OpenAI platform key. OAuth uses your ChatGPT subscription via Codex OAuth.",
                        )
                        ConfigField(
                            label = "Model",
                            value = openaiModelList.find { it.id == config?.model }
                                ?.let { "${it.displayName} (${it.description})" }
                                ?: config?.model?.ifBlank { "Not set" } ?: "Not set",
                            onClick = { showModelPicker = true },
                            info = SettingsHelpTexts.MODEL,
                        )
                        // Show the OAuth section whenever an OAuth flow is in progress or has
                        // produced an error, even if the resolved authType is currently
                        // "api_key". This keeps the polling/error UI visible during transient
                        // OAuth state changes and recovery flows.
                        val showOAuthSection = openaiAuthType == "oauth" || oauthPolling || oauthError != null
                        if (!showOAuthSection) {
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
                        } else {
                            // OAuth section
                            HorizontalDivider(
                                color = SeekerClawColors.CardBorder,
                                modifier = Modifier.padding(horizontal = 16.dp),
                            )
                            OpenAIOAuthSection(
                                isConnected = !config?.openaiOAuthToken.isNullOrBlank(),
                                email = config?.openaiOAuthEmail ?: "",
                                onSignInBrowser = {
                                    val requestId = UUID.randomUUID().toString()
                                    val intent = Intent(context, OpenAIOAuthActivity::class.java).apply {
                                        putExtra("requestId", requestId)
                                    }
                                    context.startActivity(intent)
                                    oauthRequestId = requestId
                                    oauthPolling = true
                                    oauthError = null
                                },
                                onSignOut = {
                                    // Clear tokens but keep authType=oauth so the OAuth
                                    // section stays visible with the Sign In button — the
                                    // user just signed out, they probably want to sign
                                    // back in (or pick API Key explicitly via the picker).
                                    // writeConfigJson will translate oauth+blank → api_key
                                    // for Node so the agent stays startable in the meantime.
                                    ConfigManager.clearOpenAIOAuth(context)
                                    config = ConfigManager.loadConfig(context)
                                    showRestartDialog = true
                                },
                                onCancelPolling = {
                                    oauthPolling = false
                                    oauthError = null
                                },
                                oauthPolling = oauthPolling,
                                oauthError = oauthError,
                            )
                        }
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
                                "openai" -> {
                                    val authType = config?.authType ?: "api_key"
                                    if (authType == "oauth") {
                                        testOpenAIOAuthConnection(config?.openaiOAuthToken ?: "")
                                    } else {
                                        testOpenAIConnection(config?.openaiApiKey ?: "")
                                    }
                                }
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
    if (showModelPicker && modelsForProvider(activeProvider, config?.authType).isNotEmpty()) {
        val models = modelsForProvider(activeProvider, config?.authType)
        var selectedModel by remember {
            // Preserve the user's current model even when it's not in the known list —
            // otherwise opening the picker would silently overwrite a custom model ID.
            val current = config?.model.orEmpty()
            mutableStateOf(
                when {
                    current.isNotBlank() -> current
                    else -> models.firstOrNull()?.id ?: ""
                }
            )
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
                    // CUSTOM_MODEL_SENTINEL is a sentinel for "user wants to type a model ID" — never display
                    // it as the model ID itself, and don't treat it as a real selection.
                    val isCustomSelected = selectedModel == CUSTOM_MODEL_SENTINEL ||
                        (models.none { it.id == selectedModel } && selectedModel.isNotBlank())
                    var customModelId by remember {
                        mutableStateOf(if (isCustomSelected && selectedModel != CUSTOM_MODEL_SENTINEL) selectedModel else "")
                    }

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
                                    text = model.displayName,
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
                    // Custom model option
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { selectedModel = customModelId.ifBlank { CUSTOM_MODEL_SENTINEL } }
                            .padding(vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(
                            selected = isCustomSelected || selectedModel == CUSTOM_MODEL_SENTINEL,
                            onClick = { selectedModel = customModelId.ifBlank { CUSTOM_MODEL_SENTINEL } },
                            colors = RadioButtonDefaults.colors(
                                selectedColor = SeekerClawColors.Primary,
                                unselectedColor = SeekerClawColors.TextDim,
                            ),
                        )
                        Column(modifier = Modifier.padding(start = 8.dp).fillMaxWidth()) {
                            Text(
                                text = "Custom model",
                                fontFamily = RethinkSans,
                                fontSize = 14.sp,
                                color = SeekerClawColors.TextPrimary,
                            )
                            OutlinedTextField(
                                value = customModelId,
                                onValueChange = {
                                    customModelId = it
                                    // Update selectedModel even when blank — point at the sentinel
                                    // so canSave (which excludes the sentinel) disables Save.
                                    selectedModel = it.ifBlank { CUSTOM_MODEL_SENTINEL }
                                },
                                placeholder = { Text("e.g. gpt-5.4-pro", fontSize = 12.sp) },
                                textStyle = androidx.compose.ui.text.TextStyle(
                                    fontFamily = FontFamily.Monospace,
                                    fontSize = 12.sp,
                                    color = SeekerClawColors.TextPrimary,
                                ),
                                modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                                singleLine = true,
                                colors = OutlinedTextFieldDefaults.colors(
                                    focusedBorderColor = SeekerClawColors.Primary,
                                    unfocusedBorderColor = SeekerClawColors.TextDim,
                                    cursorColor = SeekerClawColors.Primary,
                                ),
                            )
                        }
                    }
                }
            },
            confirmButton = {
                val canSave = selectedModel.isNotBlank() && selectedModel != CUSTOM_MODEL_SENTINEL
                TextButton(
                    onClick = {
                        if (canSave) {
                            saveField("model", selectedModel, needsRestart = true)
                            Analytics.modelSelected(selectedModel)
                            showModelPicker = false
                        }
                    },
                    enabled = canSave,
                ) {
                    Text("Save", fontFamily = RethinkSans, fontWeight = FontWeight.Bold,
                        color = if (canSave) SeekerClawColors.ActionPrimary else SeekerClawColors.TextDim)
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

    // Auth type picker (Claude + OpenAI)
    if (showAuthTypePicker) {
        val authOptions = when (activeProvider) {
            "openai" -> listOf("oauth" to "ChatGPT OAuth", "api_key" to "API Key")
            else -> listOf("api_key" to "API Key", "setup_token" to "Pro/Max Setup Token")
        }
        // Normalize: ensure selectedAuth is a valid option for the current provider
        val validAuthTypes = authOptions.map { it.first }.toSet()
        var selectedAuth by remember {
            mutableStateOf((config?.authType ?: "api_key").let { if (it in validAuthTypes) it else "api_key" })
        }

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
                        text = if (activeProvider == "openai") "Switching auth type changes how you authenticate with OpenAI."
                               else "Both credentials are stored. Switching just changes which one is used.",
                        fontFamily = RethinkSans,
                        fontSize = 12.sp,
                        color = SeekerClawColors.TextDim,
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        // Persist the user's selection immediately. If they pick "oauth"
                        // without a token yet, that's fine — the OAuth section will render
                        // with a Sign In button. resolveAuthType() preserves the
                        // "oauth selected, sign-in pending" state in SharedPreferences;
                        // the oauth+blank → api_key fallback only happens at writeConfigJson
                        // time so Node never sees an unstartable combination.
                        saveField("authType", selectedAuth, needsRestart = true)
                        context.getSharedPreferences("seekerclaw_prefs", android.content.Context.MODE_PRIVATE)
                            .edit()
                            .putString("lastAuthType_$activeProvider", selectedAuth)
                            .apply()
                        if (activeProvider == "openai") {
                            val currentModel = config?.model ?: ""
                            val allowedModels = modelsForProvider("openai", selectedAuth)
                            if (allowedModels.none { it.id == currentModel }) {
                                val fallback = allowedModels.firstOrNull()?.id ?: "gpt-5.4"
                                saveField("model", fallback, needsRestart = false)
                            }
                            // If switching away from OAuth, clear any leftover OAuth UI state
                            // so the API key field renders cleanly. The showOAuthSection guard
                            // is forced on by oauthError/oauthPolling — without this clear, a
                            // prior OAuth error would keep the OAuth section visible.
                            if (selectedAuth == "api_key") {
                                oauthPolling = false
                                oauthError = null
                                oauthRequestId = null
                            }
                        }
                        Analytics.authTypeChanged(selectedAuth)
                        showAuthTypePicker = false
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

@Composable
private fun OpenAIOAuthSection(
    isConnected: Boolean,
    email: String,
    onSignInBrowser: () -> Unit,
    onSignOut: () -> Unit,
    onCancelPolling: () -> Unit,
    oauthPolling: Boolean,
    oauthError: String?,
) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)

    Column(modifier = Modifier.padding(16.dp)) {
        // Warning card
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(SeekerClawColors.Warning.copy(alpha = 0.1f), shape)
                .padding(12.dp),
        ) {
            Text(
                text = "Uses your ChatGPT subscription via Codex OAuth.",
                fontFamily = RethinkSans,
                fontSize = 13.sp,
                color = SeekerClawColors.Warning,
            )
        }

        Spacer(modifier = Modifier.height(16.dp))

        if (isConnected) {
            // Connected state
            Text(
                text = "Connected as:",
                fontFamily = RethinkSans,
                fontSize = 12.sp,
                color = SeekerClawColors.TextDim,
            )
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = email.ifBlank { "Unknown account" },
                fontFamily = RethinkSans,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                color = SeekerClawColors.ActionPrimary,
            )
            Spacer(modifier = Modifier.height(16.dp))
            Button(
                onClick = onSignOut,
                modifier = Modifier.fillMaxWidth(),
                shape = shape,
                colors = ButtonDefaults.buttonColors(
                    // Use the same destructive-action red as Reset/Wipe buttons elsewhere
                    // for visual consistency across the app's destructive surfaces.
                    containerColor = SeekerClawColors.ActionDanger,
                    contentColor = Color.White,
                ),
            ) {
                Text("Sign Out", fontFamily = RethinkSans, fontWeight = FontWeight.Bold, fontSize = 14.sp)
            }
        } else if (oauthPolling) {
            // Waiting for browser authentication
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CircularProgressIndicator(
                    modifier = Modifier.size(16.dp),
                    strokeWidth = 2.dp,
                    color = SeekerClawColors.ActionPrimary,
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = "Waiting for authentication...",
                    fontFamily = RethinkSans,
                    fontSize = 13.sp,
                    color = SeekerClawColors.TextDim,
                )
            }
            Spacer(modifier = Modifier.height(16.dp))
            OutlinedButton(
                onClick = onCancelPolling,
                modifier = Modifier.fillMaxWidth(),
                shape = shape,
                border = BorderStroke(1.dp, SeekerClawColors.TextDim),
            ) {
                Text("Cancel", fontFamily = RethinkSans, fontSize = 14.sp, color = SeekerClawColors.TextPrimary)
            }
        } else {
            // Not connected — show sign in buttons
            Button(
                onClick = onSignInBrowser,
                modifier = Modifier.fillMaxWidth(),
                shape = shape,
                colors = ButtonDefaults.buttonColors(
                    containerColor = SeekerClawColors.ActionPrimary,
                    contentColor = Color.White,
                ),
            ) {
                Text("Sign in with ChatGPT", fontFamily = RethinkSans, fontWeight = FontWeight.Bold, fontSize = 14.sp)
            }
        }

        // Error message
        if (oauthError != null) {
            Spacer(modifier = Modifier.height(12.dp))
            Text(
                text = oauthError,
                fontFamily = RethinkSans,
                fontSize = 13.sp,
                color = SeekerClawColors.Error,
            )
        }
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

private suspend fun testOpenAIOAuthConnection(accessToken: String): Result<Unit> = withContext(Dispatchers.IO) {
    runCatching {
        if (accessToken.isBlank()) error("OAuth token is empty — please sign in first")
        // OAuth tokens use the Codex endpoint; /v1/models won't work.
        // Use a lightweight GET to chatgpt.com/backend-api/me to verify the token is still valid.
        val url = URL("https://chatgpt.com/backend-api/me")
        val conn = url.openConnection() as HttpURLConnection
        conn.requestMethod = "GET"
        conn.setRequestProperty("Authorization", "Bearer $accessToken")
        conn.connectTimeout = 15000
        conn.readTimeout = 15000
        try {
            val status = conn.responseCode
            if (status in 200..299) return@runCatching
            when (status) {
                401, 403 -> error("OAuth session expired — please sign in again")
                429 -> error("Rate limited — try again in a moment")
                in 500..599 -> error("OpenAI unavailable")
                else -> error("HTTP $status")
            }
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
