package com.seekerclaw.app.ui.dashboard

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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import com.seekerclaw.app.ui.theme.RethinkSans
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.res.stringResource
import com.seekerclaw.app.R
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.config.modelDisplayName
import com.seekerclaw.app.config.providerById
import com.seekerclaw.app.service.OpenClawService
import com.seekerclaw.app.ui.theme.SeekerClawColors
import com.seekerclaw.app.util.Analytics
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
import com.seekerclaw.app.util.AgentHealth
import com.seekerclaw.app.util.ServiceState
import com.seekerclaw.app.util.ServiceStatus
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.seekerclaw.app.util.fetchDbSummary
import kotlinx.coroutines.delay
import java.util.Date

@Composable
fun DashboardScreen(
    onNavigateToSystem: () -> Unit = {},
    onNavigateToSettings: () -> Unit = {},
    onNavigateToSetup: () -> Unit = {},
) {
    val context = LocalContext.current
    val haptic = LocalHapticFeedback.current
    val status by ServiceState.status.collectAsState()
    val uptime by ServiceState.uptime.collectAsState()
    val messageCount by ServiceState.messageCount.collectAsState()
    val messagesToday by ServiceState.messagesToday.collectAsState()
    val lastActivityTime by ServiceState.lastActivityTime.collectAsState()
    val health by ServiceState.agentHealth.collectAsState()
    val logs by LogCollector.logs.collectAsState()

    val cfgVersion by ConfigManager.configVersion
    val config = remember(cfgVersion) { ConfigManager.loadConfig(context) }
    val agentName = remember(config) { config?.agentName?.ifBlank { "SeekerClaw" } ?: "SeekerClaw" }
    val hasBotToken = remember(config) { config?.telegramBotToken?.isNotBlank() == true }
    val hasCredential = remember(config) {
        when (config?.provider) {
            "openai" -> config?.openaiApiKey?.isNotBlank() == true
            "openrouter" -> config?.openrouterApiKey?.isNotBlank() == true
            else -> config?.activeCredential?.isNotBlank() == true
        }
    }
    val validationError = remember(config) { ConfigManager.runtimeValidationError(config) }
    val latestError = logs.lastOrNull { it.level == LogLevel.ERROR }?.message

    // Banner dismiss states
    var networkBannerDismissed by remember { mutableStateOf(false) }
    var errorBannerDismissedKey by remember { mutableStateOf<String?>(null) }
    val configReady = validationError == null

    // Fetch API stats from bridge (BAT-32)
    var apiRequests by remember { mutableStateOf(0) }
    var apiAvgLatency by remember { mutableStateOf(0) }
    var apiCacheHits by remember { mutableStateOf(0) }

    LaunchedEffect(status) {
        if (status == ServiceStatus.RUNNING) {
            while (true) {
                val stats = fetchDbSummary()
                if (stats != null) {
                    apiRequests = stats.todayRequests
                    apiAvgLatency = stats.todayAvgLatencyMs
                    apiCacheHits = (stats.todayCacheHitRate * 100).toInt()
                } else {
                    apiRequests = 0
                    apiAvgLatency = 0
                    apiCacheHits = 0
                }
                delay(if (stats != null) 30_000L else 5_000L)
            }
        } else {
            apiRequests = 0
            apiAvgLatency = 0
            apiCacheHits = 0
        }
    }

    // Network connectivity observer
    var isOnline by remember { mutableStateOf(true) }
    DisposableEffect(context) {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = cm.getNetworkCapabilities(cm.activeNetwork)
        isOnline = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true

        val mainHandler = Handler(Looper.getMainLooper())
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                val netCaps = cm.getNetworkCapabilities(network)
                isOnline = netCaps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true
            }
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                isOnline = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            }
            override fun onLost(network: Network) {
                isOnline = false
            }
        }
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        cm.registerNetworkCallback(request, callback, mainHandler)
        onDispose { runCatching { cm.unregisterNetworkCallback(callback) } }
    }

    val isRunning = status == ServiceStatus.RUNNING || status == ServiceStatus.STARTING

    // Pulse animation for status dot — runs when RUNNING and not in error state
    // Note: Compose's InfiniteTransition already respects ANIMATOR_DURATION_SCALE
    val shouldPulse = status == ServiceStatus.RUNNING &&
        health.apiStatus != "error" && health.apiStatus != "stale"
    val pulseAlpha = if (shouldPulse) {
        val infiniteTransition = rememberInfiniteTransition(label = "statusPulse")
        infiniteTransition.animateFloat(
            initialValue = 0.4f,
            targetValue = 1.0f,
            animationSpec = infiniteRepeatable(
                animation = tween(durationMillis = 1000),
                repeatMode = RepeatMode.Reverse,
            ),
            label = "pulseAlpha",
        ).value
    } else {
        1.0f
    }

    // Health-aware status color and text (BAT-134)
    val apiUnhealthy = status == ServiceStatus.RUNNING &&
        health.apiStatus != "healthy" && health.apiStatus != "unknown"

    // Recovery banner: show briefly when transitioning from unhealthy → healthy
    var showRecoveryBanner by remember { mutableStateOf(false) }
    var prevStatus by remember { mutableStateOf<ServiceStatus?>(null) }
    var prevApiStatus by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(status, health.apiStatus) {
        val prevRunning = prevStatus == ServiceStatus.RUNNING
        val wasUnhealthy = prevRunning && prevApiStatus in listOf("error", "degraded", "stale")
        val isRunning = status == ServiceStatus.RUNNING
        val isHealthy = isRunning && health.apiStatus == "healthy"
        val isUnhealthyNow = isRunning && health.apiStatus in listOf("error", "degraded", "stale")

        if (wasUnhealthy && isHealthy) {
            showRecoveryBanner = true
            delay(5000)
            showRecoveryBanner = false
        }
        if (isUnhealthyNow) showRecoveryBanner = false

        prevStatus = status
        prevApiStatus = health.apiStatus
    }

    // Reset dismiss states via side effects (not during composition)
    LaunchedEffect(isOnline) { if (isOnline) networkBannerDismissed = false }
    LaunchedEffect(apiUnhealthy) { if (!apiUnhealthy) errorBannerDismissedKey = null }

    val statusColor = when (status) {
        ServiceStatus.RUNNING -> when (health.apiStatus) {
            "degraded", "stale" -> SeekerClawColors.Warning
            "error" -> SeekerClawColors.Error
            else -> SeekerClawColors.Accent
        }
        ServiceStatus.STARTING -> SeekerClawColors.Warning
        ServiceStatus.STOPPED -> SeekerClawColors.TextDim
        ServiceStatus.ERROR -> SeekerClawColors.Error
    }

    val statusText = when (status) {
        ServiceStatus.RUNNING -> when (health.apiStatus) {
            "degraded" -> when (health.lastErrorType) {
                "rate_limit" -> stringResource(R.string.status_rate_limited)
                "overloaded" -> stringResource(R.string.status_api_overloaded)
                "cloudflare" -> stringResource(R.string.status_api_unreachable)
                else -> stringResource(R.string.status_api_unstable)
            }
            "error" -> when (health.lastErrorType) {
                "auth" -> stringResource(R.string.status_auth_error)
                "billing" -> stringResource(R.string.status_billing_issue)
                "quota" -> stringResource(R.string.status_quota_exceeded)
                "network" -> stringResource(R.string.status_network_error)
                else -> stringResource(R.string.status_api_error)
            }
            "stale" -> stringResource(R.string.status_agent_unresponsive)
            else -> stringResource(R.string.status_online)
        }
        ServiceStatus.STARTING -> stringResource(R.string.status_starting)
        ServiceStatus.STOPPED -> stringResource(R.string.status_offline)
        ServiceStatus.ERROR -> {
            if (validationError == "setup_not_complete" ||
                validationError == "missing_bot_token" ||
                validationError == "missing_credential"
            ) stringResource(R.string.status_config_needed) else stringResource(R.string.status_error)
        }
    }

    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(SeekerClawColors.Background)
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
    ) {
        // Header — two-tone logo
        Text(
            text = buildAnnotatedString {
                withStyle(SpanStyle(color = SeekerClawColors.TextPrimary, fontWeight = FontWeight.ExtraBold)) {
                    append(stringResource(R.string.brand_seeker))
                }
                withStyle(SpanStyle(color = SeekerClawColors.Primary, fontWeight = FontWeight.ExtraBold)) {
                    append(stringResource(R.string.brand_claw))
                }
            },
            fontFamily = RethinkSans,
            fontSize = 28.sp,
        )

        Spacer(modifier = Modifier.height(2.dp))

        Text(
            text = stringResource(R.string.brand_agent_os),
            fontFamily = RethinkSans,
            fontSize = 14.sp,
            color = SeekerClawColors.TextDim,
        )

        Spacer(modifier = Modifier.height(if (!isOnline) 16.dp else 24.dp))

        // Network offline banner (dismissible, resets via LaunchedEffect when online)
        AnimatedVisibility(
            visible = !isOnline && !networkBannerDismissed,
            enter = fadeIn() + expandVertically(),
            exit = fadeOut() + shrinkVertically(),
        ) {
            Row(
                modifier = Modifier
                    .padding(bottom = 24.dp)
                    .fillMaxWidth()
                    .background(SeekerClawColors.Warning.copy(alpha = 0.15f), shape)
                    .padding(start = 16.dp, top = 12.dp, bottom = 12.dp, end = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(SeekerClawColors.Warning),
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = stringResource(R.string.banner_no_internet),
                    fontFamily = RethinkSans,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                    color = SeekerClawColors.Warning,
                    modifier = Modifier.weight(1f),
                )
                IconButton(
                    onClick = { networkBannerDismissed = true },
                ) {
                    Icon(
                        Icons.Default.Close,
                        contentDescription = stringResource(R.string.banner_dismiss_network),
                        tint = SeekerClawColors.Warning,
                        modifier = Modifier.size(16.dp),
                    )
                }
            }
        }

        // API health error banner (BAT-134) — dismissible, resets via LaunchedEffect
        val errorBannerKey = "${health.apiStatus}:${health.lastErrorType}"
        val errorDismissed = apiUnhealthy && errorBannerDismissedKey == errorBannerKey
        val showErrorBanner = apiUnhealthy && !errorDismissed
        AnimatedVisibility(
            visible = showErrorBanner,
            enter = fadeIn() + expandVertically(),
            exit = fadeOut() + shrinkVertically(),
        ) {
            val bannerColor = if (health.apiStatus == "error") SeekerClawColors.Error
                else SeekerClawColors.Warning
            val providerName = providerById(config?.provider ?: "claude").displayName
            val bannerText = when (health.lastErrorType) {
                "auth" -> stringResource(R.string.banner_auth_rejected, health.lastErrorStatus?.let { " ($it)" } ?: "")
                "billing" -> stringResource(R.string.banner_billing_issue, providerById(config?.provider ?: "claude").consoleUrl)
                "quota" -> stringResource(R.string.banner_quota_exceeded)
                "rate_limit" -> stringResource(R.string.banner_rate_limited)
                "server", "overloaded" -> stringResource(R.string.banner_server_unavailable, providerName)
                "cloudflare" -> stringResource(R.string.banner_cloudflare, providerName)
                "network" -> stringResource(R.string.banner_network_error, providerName)
                else -> if (health.apiStatus == "stale") stringResource(R.string.banner_agent_stale)
                    else stringResource(R.string.banner_api_error_generic)
            }
            Row(
                modifier = Modifier
                    .padding(bottom = 24.dp)
                    .fillMaxWidth()
                    .background(bannerColor.copy(alpha = 0.12f), shape)
                    .padding(start = 16.dp, top = 12.dp, bottom = 12.dp, end = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(bannerColor),
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = bannerText,
                    fontFamily = RethinkSans,
                    fontSize = 12.sp,
                    color = bannerColor,
                    modifier = Modifier.weight(1f),
                )
                IconButton(
                    onClick = { errorBannerDismissedKey = errorBannerKey },
                ) {
                    Icon(
                        Icons.Default.Close,
                        contentDescription = stringResource(R.string.banner_dismiss_error),
                        tint = bannerColor,
                        modifier = Modifier.size(16.dp),
                    )
                }
            }
        }

        // Recovery banner — brief green confirmation after API recovers
        val showRecovery = showRecoveryBanner && status == ServiceStatus.RUNNING
        AnimatedVisibility(
            visible = showRecovery,
            enter = fadeIn() + expandVertically(),
            exit = fadeOut() + shrinkVertically(),
        ) {
            Row(
                modifier = Modifier
                    .padding(bottom = 24.dp)
                    .fillMaxWidth()
                    .background(SeekerClawColors.Accent.copy(alpha = 0.12f), shape)
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(SeekerClawColors.Accent),
                )
                Spacer(modifier = Modifier.width(12.dp))
                Text(
                    text = stringResource(R.string.banner_api_restored),
                    fontFamily = RethinkSans,
                    fontSize = 13.sp,
                    color = SeekerClawColors.Accent,
                    modifier = Modifier.weight(1f),
                )
            }
        }

        // Setup needed card — prominent when config is incomplete
        val showSetupCard = validationError != null && !isRunning
        AnimatedVisibility(
            visible = showSetupCard,
            enter = fadeIn() + expandVertically(),
            exit = fadeOut() + shrinkVertically(),
        ) {
            Column(
                modifier = Modifier
                    .padding(bottom = 24.dp)
                    .fillMaxWidth()
                    .background(SeekerClawColors.Warning.copy(alpha = 0.10f), shape)
                    .border(1.dp, SeekerClawColors.Warning.copy(alpha = 0.3f), shape)
                    .padding(16.dp),
            ) {
                Text(
                    text = stringResource(R.string.card_complete_setup),
                    fontFamily = RethinkSans,
                    fontWeight = FontWeight.Bold,
                    fontSize = 16.sp,
                    color = SeekerClawColors.Warning,
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = when (validationError) {
                        "missing_bot_token" -> stringResource(R.string.card_missing_bot_token)
                        "missing_credential" -> stringResource(R.string.card_missing_credential)
                        else -> stringResource(R.string.card_needs_configuration)
                    },
                    fontFamily = RethinkSans,
                    fontSize = 13.sp,
                    color = SeekerClawColors.TextDim,
                )
                Spacer(modifier = Modifier.height(12.dp))
                Button(
                    onClick = onNavigateToSetup,
                    shape = shape,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = SeekerClawColors.Warning,
                        contentColor = SeekerClawColors.Background,
                    ),
                    modifier = Modifier.fillMaxWidth().height(44.dp),
                ) {
                    Text(
                        text = stringResource(R.string.button_continue_setup),
                        fontFamily = RethinkSans,
                        fontWeight = FontWeight.Bold,
                        fontSize = 14.sp,
                    )
                }
            }
        }

        // First-launch guide — show when config is ready but user hasn't deployed yet
        val showFirstLaunchGuide = configReady &&
            status == ServiceStatus.STOPPED &&
            !ConfigManager.hasUserEverDeployed(context)
        AnimatedVisibility(
            visible = showFirstLaunchGuide,
            enter = fadeIn() + expandVertically(),
            exit = fadeOut() + shrinkVertically(),
        ) {
            Column(
                modifier = Modifier
                    .padding(bottom = 24.dp)
                    .fillMaxWidth()
                    .background(SeekerClawColors.Accent.copy(alpha = 0.08f), shape)
                    .border(1.dp, SeekerClawColors.Accent.copy(alpha = 0.2f), shape)
                    .padding(16.dp),
            ) {
                Text(
                    text = stringResource(R.string.card_ready_to_go),
                    fontFamily = RethinkSans,
                    fontWeight = FontWeight.Bold,
                    fontSize = 15.sp,
                    color = SeekerClawColors.Accent,
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = stringResource(R.string.card_first_launch_hint, agentName),
                    fontFamily = RethinkSans,
                    fontSize = 13.sp,
                    color = SeekerClawColors.TextDim,
                    lineHeight = 18.sp,
                )
            }
        }

        // Status card (tappable → System screen, or Settings if config needed)
        val configNeeded = !configReady
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(SeekerClawColors.Surface, shape)
                .alpha(if (isRunning) 1f else 0.6f)
                .clickable { if (configNeeded) onNavigateToSettings() else onNavigateToSystem() }
                .padding(16.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        modifier = Modifier
                            .size(10.dp)
                            .clip(CircleShape)
                            .background(statusColor)
                            .alpha(if (isRunning) pulseAlpha else 1f),
                    )
                    Spacer(modifier = Modifier.width(12.dp))
                    Text(
                        text = statusText,
                        fontFamily = RethinkSans,
                        fontSize = 16.sp,
                        fontWeight = FontWeight.Medium,
                        color = SeekerClawColors.TextPrimary,
                    )
                }
                Text(
                    text = if (configNeeded) stringResource(R.string.button_settings_nav) else stringResource(R.string.button_system_nav),
                    fontFamily = RethinkSans,
                    fontSize = 12.sp,
                    color = SeekerClawColors.TextDim,
                )
            }

            if (status == ServiceStatus.ERROR && !latestError.isNullOrBlank()) {
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = latestError,
                    fontFamily = RethinkSans,
                    fontSize = 12.sp,
                    color = SeekerClawColors.Error,
                )
            }

            Spacer(modifier = Modifier.height(16.dp))

            HorizontalDivider(
                color = SeekerClawColors.TextDim.copy(alpha = 0.2f),
                thickness = 1.dp,
            )

            Spacer(modifier = Modifier.height(16.dp))

            Text(
                text = stringResource(R.string.label_uptime),
                fontFamily = RethinkSans,
                fontSize = 10.sp,
                fontWeight = FontWeight.Medium,
                color = SeekerClawColors.TextDim,
                letterSpacing = 1.sp,
            )
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = formatUptime(uptime),
                fontFamily = FontFamily.Monospace,
                fontSize = 32.sp,
                fontWeight = FontWeight.Bold,
                color = SeekerClawColors.TextPrimary,
            )

            Spacer(modifier = Modifier.height(16.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                StatMini(label = stringResource(R.string.label_today), value = "$messagesToday")
                StatMini(label = stringResource(R.string.label_total), value = "$messageCount")
                StatMini(label = stringResource(R.string.label_last), value = formatLastActivity(lastActivityTime, context))
            }
        }

        Spacer(modifier = Modifier.height(24.dp))

        // Uplinks
        Text(
            text = stringResource(R.string.label_status),
            fontFamily = RethinkSans,
            fontSize = 11.sp,
            fontWeight = FontWeight.Medium,
            color = SeekerClawColors.TextDim,
            letterSpacing = 1.sp,
        )

        Spacer(modifier = Modifier.height(8.dp))

        Column(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            val gatewaySubtitle = when (status) {
                ServiceStatus.RUNNING -> when (health.apiStatus) {
                    "degraded" -> stringResource(R.string.uplink_engine_retrying)
                    "error" -> stringResource(R.string.uplink_engine_error)
                    "stale" -> stringResource(R.string.uplink_engine_unresponsive)
                    else -> stringResource(R.string.uplink_engine_running)
                }
                ServiceStatus.STARTING -> stringResource(R.string.uplink_engine_starting)
                ServiceStatus.STOPPED -> stringResource(R.string.uplink_engine_offline)
                ServiceStatus.ERROR -> {
                    if (!hasBotToken || !hasCredential) stringResource(R.string.uplink_engine_blocked)
                    else stringResource(R.string.uplink_engine_error)
                }
            }
            val gatewayDotColor = when (status) {
                ServiceStatus.RUNNING -> when (health.apiStatus) {
                    "degraded", "stale" -> SeekerClawColors.Warning
                    "error" -> SeekerClawColors.Error
                    else -> SeekerClawColors.Accent
                }
                ServiceStatus.STARTING -> SeekerClawColors.Warning
                ServiceStatus.STOPPED -> SeekerClawColors.TextDim
                ServiceStatus.ERROR -> SeekerClawColors.Error
            }

            val telegramSubtitle = if (!hasBotToken) stringResource(R.string.uplink_telegram_missing_token) else when (status) {
                ServiceStatus.RUNNING -> stringResource(R.string.uplink_telegram_relay)
                ServiceStatus.STARTING -> stringResource(R.string.uplink_telegram_connecting)
                ServiceStatus.ERROR -> stringResource(R.string.uplink_telegram_error)
                ServiceStatus.STOPPED -> stringResource(R.string.uplink_telegram_offline)
            }
            val telegramDotColor = if (!hasBotToken) SeekerClawColors.Error else when (status) {
                ServiceStatus.RUNNING -> SeekerClawColors.Accent
                ServiceStatus.STARTING -> SeekerClawColors.Warning
                ServiceStatus.ERROR -> SeekerClawColors.Error
                ServiceStatus.STOPPED -> SeekerClawColors.TextDim
            }

            val aiSubtitle = if (!hasCredential) stringResource(R.string.uplink_ai_missing_credential) else when (status) {
                ServiceStatus.RUNNING -> when (health.apiStatus) {
                    "degraded" -> stringResource(R.string.uplink_ai_retrying, modelDisplayName(config?.model))
                    "error" -> when (health.lastErrorType) {
                        "auth" -> stringResource(R.string.uplink_ai_auth_expired)
                        "billing" -> stringResource(R.string.uplink_ai_billing)
                        "quota" -> stringResource(R.string.uplink_ai_quota)
                        else -> stringResource(R.string.uplink_ai_error)
                    }
                    "stale" -> stringResource(R.string.uplink_ai_unresponsive)
                    else -> modelDisplayName(config?.model)
                }
                ServiceStatus.STARTING -> stringResource(R.string.uplink_ai_loading)
                ServiceStatus.ERROR -> stringResource(R.string.uplink_ai_model_error)
                ServiceStatus.STOPPED -> stringResource(R.string.uplink_ai_offline)
            }
            val aiDotColor = if (!hasCredential) SeekerClawColors.Error else when (status) {
                ServiceStatus.RUNNING -> when (health.apiStatus) {
                    "degraded", "stale" -> SeekerClawColors.Warning
                    "error" -> SeekerClawColors.Error
                    else -> SeekerClawColors.Accent
                }
                ServiceStatus.STARTING -> SeekerClawColors.Warning
                ServiceStatus.ERROR -> SeekerClawColors.Error
                ServiceStatus.STOPPED -> SeekerClawColors.TextDim
            }

            UplinkCard(
                icon = "//TG",
                name = stringResource(R.string.uplink_telegram),
                subtitle = telegramSubtitle,
                dotColor = telegramDotColor,
                shape = shape,
                dotAlpha = if (isRunning) pulseAlpha else 1f,
            )
            UplinkCard(
                icon = "//GW",
                name = stringResource(R.string.uplink_engine),
                subtitle = gatewaySubtitle,
                dotColor = gatewayDotColor,
                shape = shape,
                dotAlpha = if (isRunning) pulseAlpha else 1f,
            )
            UplinkCard(
                icon = "//AI",
                name = stringResource(R.string.uplink_ai_provider),
                subtitle = aiSubtitle,
                dotColor = aiDotColor,
                shape = shape,
                dotAlpha = if (isRunning) pulseAlpha else 1f,
            )
        }

        Spacer(modifier = Modifier.height(24.dp))

        // Action button — disabled when config incomplete (unless already running)
        val deployEnabled = isRunning || configReady
        Button(
            onClick = {
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                if (isRunning) {
                    Analytics.serviceStopped(uptime / 60000)
                    OpenClawService.stop(context)
                } else {
                    Analytics.serviceStarted(1)
                    OpenClawService.start(context)
                    ConfigManager.markFirstDeploymentDone(context)
                }
            },
            enabled = deployEnabled,
            modifier = Modifier
                .fillMaxWidth()
                .height(52.dp),
            shape = shape,
            colors = ButtonDefaults.buttonColors(
                containerColor = if (isRunning) SeekerClawColors.Primary else SeekerClawColors.ActionPrimary,
                contentColor = Color.White,
                disabledContainerColor = SeekerClawColors.BorderSubtle,
                disabledContentColor = SeekerClawColors.TextDim,
            ),
        ) {
            Text(
                text = if (isRunning) stringResource(R.string.button_stop_agent) else stringResource(R.string.button_deploy_agent),
                fontFamily = RethinkSans,
                fontWeight = FontWeight.Bold,
                fontSize = 15.sp,
            )
        }
        if (!deployEnabled) {
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = stringResource(R.string.hint_complete_setup_to_deploy),
                fontFamily = RethinkSans,
                fontSize = 12.sp,
                color = SeekerClawColors.TextDim,
                modifier = Modifier.fillMaxWidth(),
                textAlign = TextAlign.Center,
            )
        }

        // API stats mini row (BAT-32)
        if (isRunning && apiRequests > 0) {
            Spacer(modifier = Modifier.height(16.dp))

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SeekerClawColors.Surface, shape)
                    .padding(horizontal = 16.dp, vertical = 14.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                StatMini(small = true, label = stringResource(R.string.stat_api), value = stringResource(R.string.stat_api_value, apiRequests))
                StatMini(small = true, label = stringResource(R.string.stat_latency), value = stringResource(R.string.stat_latency_value, apiAvgLatency))
                StatMini(small = true, label = stringResource(R.string.stat_cache), value = stringResource(R.string.stat_cache_value, apiCacheHits))
            }
        }

        Spacer(modifier = Modifier.height(24.dp))
    }
}

@Composable
private fun StatMini(label: String, value: String, small: Boolean = false) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(
            text = value,
            fontFamily = FontFamily.Monospace,
            fontSize = if (small) 13.sp else 20.sp,
            fontWeight = FontWeight.Bold,
            color = SeekerClawColors.TextPrimary,
        )
        if (!small) Spacer(modifier = Modifier.height(2.dp))
        Text(
            text = label,
            fontFamily = RethinkSans,
            fontSize = 10.sp,
            fontWeight = FontWeight.Medium,
            color = SeekerClawColors.TextDim,
            letterSpacing = 1.sp,
        )
    }
}

@Composable
private fun UplinkCard(
    icon: String,
    name: String,
    subtitle: String,
    dotColor: Color,
    shape: RoundedCornerShape,
    dotAlpha: Float = 1f,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(SeekerClawColors.Surface, shape)
            .padding(horizontal = 16.dp, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = icon,
            fontFamily = FontFamily.Monospace,
            fontSize = 13.sp,
            fontWeight = FontWeight.Bold,
            color = SeekerClawColors.Primary,
            modifier = Modifier.width(44.dp),
        )

        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = name,
                fontFamily = RethinkSans,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                color = SeekerClawColors.TextPrimary,
            )
            Text(
                text = subtitle,
                fontFamily = RethinkSans,
                fontSize = 12.sp,
                color = SeekerClawColors.TextDim,
            )
        }

        Box(
            modifier = Modifier
                .size(10.dp)
                .clip(CircleShape)
                .background(dotColor)
                .alpha(dotAlpha),
        )
    }
}

private fun formatUptime(millis: Long): String {
    if (millis <= 0) return "00h 00m 00s"
    val seconds = millis / 1000
    val minutes = seconds / 60
    val hours = minutes / 60
    val days = hours / 24
    return buildString {
        if (days > 0) append("${days}d ")
        append("%02dh %02dm %02ds".format(hours % 24, minutes % 60, seconds % 60))
    }.trimEnd()
}

private fun formatLastActivity(timestamp: Long, context: Context): String {
    if (timestamp <= 0L) return "--:--"
    val format = android.text.format.DateFormat.getTimeFormat(context)
    return format.format(Date(timestamp))
}

