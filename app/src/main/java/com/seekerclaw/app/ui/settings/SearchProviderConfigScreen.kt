package com.seekerclaw.app.ui.settings

import android.content.Intent
import android.net.Uri
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import com.seekerclaw.app.ui.components.SeekerClawScaffold
import androidx.compose.material3.HorizontalDivider

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.seekerclaw.app.ui.components.CardSurface

import com.seekerclaw.app.ui.components.SectionLabel
import com.seekerclaw.app.ui.components.ConfigField
import com.seekerclaw.app.ui.components.cornerGlowBorder
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.config.SearchProviderInfo
import com.seekerclaw.app.config.availableSearchProviders
import com.seekerclaw.app.config.searchProviderById
import com.seekerclaw.app.state.AgentPreferencesStore
import com.seekerclaw.app.ui.theme.RethinkSans
import com.seekerclaw.app.ui.theme.SeekerClawColors
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun SearchProviderConfigScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val configVer by ConfigManager.configVersion
    var config by remember(configVer) { mutableStateOf(ConfigManager.loadConfig(context)) }

    // BAT-515 v3 §4 + R14: bind activeProvider directly to the
    // AgentPreferencesStore StateFlow so cross-process writes (Telegram
    // /provider when we add it, Node-side switch from the future
    // session_status flow) flow through to the UI without a configVersion
    // bump. The optimistic local override gives instant visual feedback
    // on tap while the IO dispatch persists. Note: SearchProviderConfigScreen
    // is a main-process-only UI surface, so AgentPreferencesStore.isInitialized
    // is always true here — no fallback to config?.searchProvider needed.
    val agentPrefs by AgentPreferencesStore.state.collectAsState()
    val scope = rememberCoroutineScope()
    var optimisticProvider by remember(agentPrefs.searchProvider) { mutableStateOf<String?>(null) }
    val effectiveProvider = optimisticProvider ?: agentPrefs.searchProvider
    val activeProvider: SearchProviderInfo = searchProviderById(effectiveProvider)

    var editField by remember { mutableStateOf<String?>(null) }
    var editLabel by remember { mutableStateOf("") }
    var editValue by remember { mutableStateOf("") }
    var showRestartDialog by remember { mutableStateOf(false) }

    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)

    fun maskKey(key: String?): String {
        if (key.isNullOrBlank()) return "Not set"
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

    SeekerClawScaffold(title = "Search Provider", onBack = onBack) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 20.dp, vertical = 8.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            // Provider selection
            SectionLabel("Provider")
            Spacer(modifier = Modifier.height(10.dp))

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SeekerClawColors.Surface, shape)
                    .cornerGlowBorder(),
            ) {
                availableSearchProviders.forEachIndexed { index, provider ->
                    val isActive = provider.id == activeProvider.id
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable {
                                if (!isActive) {
                                    // BAT-515 v3 §4 + R14/R17/R24: optimistic
                                    // local override + IO-dispatched atomic
                                    // update. Switching is LIVE — `:node`
                                    // reads `agent_preferences.json` per
                                    // web_search call, so the next search
                                    // uses the new provider without a
                                    // service restart. R24 reasoning
                                    // applies: AgentPreferencesStore.update
                                    // re-reads inside the writeLock so a
                                    // concurrent cross-process write isn't
                                    // clobbered by a stale `current` from
                                    // outside the lock. R17: clear the
                                    // optimistic override on failure rather
                                    // than reverting to the prior id — the
                                    // canonical state may have changed
                                    // mid-flight.
                                    optimisticProvider = provider.id
                                    scope.launch(Dispatchers.IO) {
                                        // R10 Copilot: capture the
                                        // failure cause for the log
                                        // path so a field issue is
                                        // diagnosable from device logs
                                        // (FS error vs validation
                                        // error are different bugs to
                                        // chase).
                                        var validationError: String? = null
                                        val ok = try {
                                            AgentPreferencesStore.update {
                                                it.copy(searchProvider = provider.id)
                                            }
                                        } catch (e: IllegalArgumentException) {
                                            validationError = e.message
                                            false
                                        }
                                        withContext(Dispatchers.Main) {
                                            if (!ok) {
                                                optimisticProvider = null
                                                // R10 Copilot: surface
                                                // the failure so a
                                                // silent revert
                                                // doesn't look like
                                                // the tap was
                                                // ignored. Toast for
                                                // user-visible feedback
                                                // (mirrors the failure-
                                                // surface pattern other
                                                // Settings screens use
                                                // for irrecoverable
                                                // saves); LogCollector
                                                // entry for post-hoc
                                                // triage when a user
                                                // reports "the picker
                                                // doesn't stick".
                                                Toast.makeText(
                                                    context,
                                                    "Couldn't switch search provider — try again",
                                                    Toast.LENGTH_SHORT,
                                                ).show()
                                                LogCollector.append(
                                                    "[Settings] Search provider switch to '${provider.id}' failed " +
                                                        (validationError?.let { "(validation: $it)" }
                                                            ?: "(FS error or store uninitialized)"),
                                                    LogLevel.WARN,
                                                )
                                            }
                                        }
                                    }
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
                                text = "Active",
                                fontFamily = RethinkSans,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Medium,
                                color = SeekerClawColors.Accent,
                            )
                        }
                    }
                    if (index < availableSearchProviders.size - 1) {
                        HorizontalDivider(
                            color = SeekerClawColors.CardBorder,
                            modifier = Modifier.padding(horizontal = 16.dp),
                        )
                    }
                }
            }

            // Active provider API key field
            Spacer(modifier = Modifier.height(24.dp))
            SectionLabel("${activeProvider.displayName} Settings")
            Spacer(modifier = Modifier.height(10.dp))

            // R1 Copilot: derive the API key from `effectiveProvider`
            // (the optimistic value), NOT `config.activeSearchApiKey`
            // (which still reads the lagging `config.searchProvider`).
            // During the optimistic window between the tap and the
            // configVersion bump, `activeProvider.displayName` shows
            // the new provider while `config.activeSearchApiKey`
            // would still resolve to the OLD provider's key — a
            // confusing visible mismatch. Looking up via
            // `effectiveProvider` keeps the section label, masked-key
            // value, and "missing key" warning all internally
            // consistent for whichever provider is currently
            // displayed as Active.
            val activeApiKey: String? = when (effectiveProvider) {
                "perplexity" -> config?.perplexityApiKey
                "exa" -> config?.exaApiKey
                "tavily" -> config?.tavilyApiKey
                "firecrawl" -> config?.firecrawlApiKey
                else -> config?.braveApiKey
            }
            val isKeyMissing = activeApiKey.isNullOrBlank()

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SeekerClawColors.Surface, shape)
                    .cornerGlowBorder(),
            ) {
                ConfigField(
                    label = "API Key",
                    value = maskKey(activeApiKey),
                    onClick = {
                        editField = activeProvider.configField
                        editLabel = "${activeProvider.displayName} API Key"
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
                    text = "Not configured — web search will not work until an API key is set.",
                    fontFamily = RethinkSans,
                    fontSize = 12.sp,
                    color = SeekerClawColors.Error,
                )
            }

            // "Get API Key" link
            Spacer(modifier = Modifier.height(24.dp))
            SectionLabel("Resources")
            Spacer(modifier = Modifier.height(10.dp))

            CardSurface {
                Text(
                    text = helpTextForProvider(activeProvider.id),
                    fontFamily = RethinkSans,
                    fontSize = 13.sp,
                    color = SeekerClawColors.TextDim,
                )
                Spacer(modifier = Modifier.height(12.dp))
                Text(
                    text = "Get API Key →",
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
