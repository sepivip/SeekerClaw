package com.seekerclaw.app.ui.settings

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.seekerclaw.app.R
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.config.SearchProviderInfo
import com.seekerclaw.app.config.availableSearchProviders
import com.seekerclaw.app.config.searchProviderById
import com.seekerclaw.app.ui.theme.RethinkSans
import com.seekerclaw.app.ui.theme.SeekerClawColors

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SearchProviderConfigScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    var config by remember { mutableStateOf(ConfigManager.loadConfig(context)) }

    val activeProvider: SearchProviderInfo = searchProviderById(config?.searchProvider ?: "brave")
    var editField by remember { mutableStateOf<String?>(null) }
    var editLabel by remember { mutableStateOf("") }
    var editValue by remember { mutableStateOf("") }
    var showRestartDialog by remember { mutableStateOf(false) }

    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)

    val notSetLabel = stringResource(R.string.label_not_set)
    fun maskKey(key: String?): String {
        if (key.isNullOrBlank()) return notSetLabel
        if (key.length <= 8) return "*".repeat(key.length)
        return "${key.take(6)}${"*".repeat(8)}${key.takeLast(4)}"
    }

    fun saveField(field: String, value: String, needsRestart: Boolean = false) {
        ConfigManager.updateConfigField(context, field, value)
        config = ConfigManager.loadConfig(context)
        if (needsRestart) showRestartDialog = true
    }

    fun helpTextForProvider(providerId: String): String = when (providerId) {
        "brave" -> SettingsHelpTexts.BRAVE_API_KEY
        "perplexity" -> SettingsHelpTexts.PERPLEXITY_API_KEY
        "exa" -> SettingsHelpTexts.EXA_API_KEY
        "tavily" -> SettingsHelpTexts.TAVILY_API_KEY
        "firecrawl" -> SettingsHelpTexts.FIRECRAWL_API_KEY
        else -> SettingsHelpTexts.BRAVE_API_KEY
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = stringResource(R.string.search_title),
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
                            contentDescription = stringResource(R.string.button_back),
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
            // Provider selection
            ProviderSectionLabel(stringResource(R.string.provider_section_provider))
            Spacer(modifier = Modifier.height(10.dp))

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SeekerClawColors.Surface, shape),
            ) {
                availableSearchProviders.forEachIndexed { index, provider ->
                    val isActive = provider.id == activeProvider.id
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable {
                                if (!isActive) {
                                    saveField("searchProvider", provider.id, needsRestart = true)
                                }
                            }
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
                                text = stringResource(R.string.label_active),
                                fontFamily = RethinkSans,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Medium,
                                color = SeekerClawColors.Accent,
                            )
                        }
                    }
                    if (index < availableSearchProviders.size - 1) {
                        HorizontalDivider(
                            color = SeekerClawColors.TextDim.copy(alpha = 0.1f),
                            modifier = Modifier.padding(horizontal = 16.dp),
                        )
                    }
                }
            }

            // Active provider API key field
            Spacer(modifier = Modifier.height(24.dp))
            ProviderSectionLabel(stringResource(R.string.provider_settings_title, activeProvider.displayName))
            Spacer(modifier = Modifier.height(10.dp))

            val activeApiKey: String? = config?.activeSearchApiKey
            val isKeyMissing = activeApiKey.isNullOrBlank()

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SeekerClawColors.Surface, shape),
            ) {
                ProviderConfigField(
                    label = stringResource(R.string.search_label_api_key),
                    value = maskKey(activeApiKey),
                    onClick = {
                        editField = activeProvider.configField
                        editLabel = context.getString(R.string.search_edit_api_key, activeProvider.displayName)
                        editValue = activeApiKey ?: ""
                    },
                    info = helpTextForProvider(activeProvider.id),
                    isRequired = isKeyMissing,
                    showDivider = false,
                )
            }

            if (isKeyMissing) {
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = stringResource(R.string.search_not_configured),
                    fontFamily = RethinkSans,
                    fontSize = 12.sp,
                    color = SeekerClawColors.Error,
                )
            }

            // "Get API Key" link
            Spacer(modifier = Modifier.height(24.dp))
            ProviderSectionLabel(stringResource(R.string.search_section_resources))
            Spacer(modifier = Modifier.height(10.dp))

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SeekerClawColors.Surface, shape)
                    .padding(16.dp),
            ) {
                Text(
                    text = helpTextForProvider(activeProvider.id),
                    fontFamily = RethinkSans,
                    fontSize = 13.sp,
                    color = SeekerClawColors.TextDim,
                )
                Spacer(modifier = Modifier.height(12.dp))
                Text(
                    text = stringResource(R.string.search_get_api_key),
                    fontFamily = RethinkSans,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.TextInteractive,
                    modifier = Modifier.clickable {
                        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(activeProvider.consoleUrl))
                        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        context.startActivity(intent)
                    },
                )
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
                // Allow empty: this unsets the API key; the provider remains selected but searches will fail until a key is configured
                saveField(field, trimmed, needsRestart = true)
                editField = null
            },
            onDismiss = { editField = null },
        )
    }

    // Restart dialog
    if (showRestartDialog) {
        RestartDialog(
            context = context,
            onDismiss = { showRestartDialog = false },
        )
    }
}
