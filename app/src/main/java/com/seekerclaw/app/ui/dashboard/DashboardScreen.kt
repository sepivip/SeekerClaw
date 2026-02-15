package com.seekerclaw.app.ui.dashboard

import androidx.compose.foundation.background
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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import android.widget.Toast
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.config.modelDisplayName
import com.seekerclaw.app.service.OpenClawService
import com.seekerclaw.app.ui.theme.SeekerClawColors
import com.seekerclaw.app.util.Analytics
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
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
fun DashboardScreen(onNavigateToSystem: () -> Unit = {}, onNavigateToSettings: () -> Unit = {}) {
    val context = LocalContext.current
    val haptic = LocalHapticFeedback.current
    val status by ServiceState.status.collectAsState()
    val uptime by ServiceState.uptime.collectAsState()
    val messageCount by ServiceState.messageCount.collectAsState()
    val messagesToday by ServiceState.messagesToday.collectAsState()
    val lastActivityTime by ServiceState.lastActivityTime.collectAsState()
    val logs by LogCollector.logs.collectAsState()

    val config = remember { ConfigManager.loadConfig(context) }
    val agentName = remember(config) { config?.agentName?.ifBlank { "SeekerClaw" } ?: "SeekerClaw" }
    val hasBotToken = remember(config) { config?.telegramBotToken?.isNotBlank() == true }
    val hasCredential = remember(config) { config?.activeCredential?.isNotBlank() == true }
    val validationError = remember(config) { ConfigManager.runtimeValidationError(config) }
    val latestError = logs.lastOrNull { it.level == LogLevel.ERROR }?.message

    // Fetch API stats from bridge (BAT-32)
    var apiRequests by remember { mutableStateOf(0) }
    var apiAvgLatency by remember { mutableStateOf(0) }
    var monthCost by remember { mutableStateOf(0f) }

    LaunchedEffect(status) {
        if (status == ServiceStatus.RUNNING) {
            while (true) {
                val stats = fetchDbSummary()
                if (stats != null) {
                    apiRequests = stats.todayRequests
                    apiAvgLatency = stats.todayAvgLatencyMs
                    monthCost = stats.monthCostEstimate
                } else {
                    apiRequests = 0
                    apiAvgLatency = 0
                    monthCost = 0f
                }
                delay(if (stats != null) 30_000L else 5_000L)
            }
        } else {
            apiRequests = 0
            apiAvgLatency = 0
            monthCost = 0f
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

    val statusColor = when (status) {
        ServiceStatus.RUNNING -> SeekerClawColors.Accent
        ServiceStatus.STARTING -> SeekerClawColors.Warning
        ServiceStatus.STOPPED -> SeekerClawColors.TextDim
        ServiceStatus.ERROR -> SeekerClawColors.Error
    }

    val statusText = when (status) {
        ServiceStatus.RUNNING -> "Online"
        ServiceStatus.STARTING -> "Starting\u2026"
        ServiceStatus.STOPPED -> "Offline"
        ServiceStatus.ERROR -> {
            if (validationError == "setup_not_complete" ||
                validationError == "missing_bot_token" ||
                validationError == "missing_credential"
            ) "Config Needed" else "Error"
        }
    }

    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(SeekerClawColors.Background)
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
    ) {
        // Header — two-tone logo
        Text(
            text = buildAnnotatedString {
                withStyle(SpanStyle(color = Color.White, fontWeight = FontWeight.ExtraBold)) {
                    append("Seeker")
                }
                withStyle(SpanStyle(color = SeekerClawColors.Primary, fontWeight = FontWeight.ExtraBold)) {
                    append("C/aw")
                }
            },
            fontFamily = FontFamily.Default,
            fontSize = 28.sp,
        )

        Spacer(modifier = Modifier.height(2.dp))

        Text(
            text = "Your AI Agent",
            fontFamily = FontFamily.Default,
            fontSize = 14.sp,
            color = SeekerClawColors.TextDim,
        )

        Spacer(modifier = Modifier.height(if (!isOnline) 16.dp else 24.dp))

        // Network offline banner
        if (!isOnline) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SeekerClawColors.Warning.copy(alpha = 0.15f), shape)
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(SeekerClawColors.Warning),
                )
                Spacer(modifier = Modifier.width(10.dp))
                Text(
                    text = "No internet connection",
                    fontFamily = FontFamily.Default,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                    color = SeekerClawColors.Warning,
                )
            }
            Spacer(modifier = Modifier.height(16.dp))
        }

        // Status card (tappable → System screen, or Settings if config needed)
        val configNeeded = statusText == "Config Needed"
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(SeekerClawColors.Surface, shape)
                .clickable { if (configNeeded) onNavigateToSettings() else onNavigateToSystem() }
                .padding(20.dp),
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
                            .background(statusColor),
                    )
                    Spacer(modifier = Modifier.width(12.dp))
                    Text(
                        text = statusText,
                        fontFamily = FontFamily.Default,
                        fontSize = 16.sp,
                        fontWeight = FontWeight.Medium,
                        color = SeekerClawColors.TextPrimary,
                    )
                }
                Text(
                    text = if (configNeeded) "Settings >" else "System >",
                    fontFamily = FontFamily.Default,
                    fontSize = 12.sp,
                    color = SeekerClawColors.TextDim,
                )
            }

            if (status == ServiceStatus.ERROR && !latestError.isNullOrBlank()) {
                Spacer(modifier = Modifier.height(10.dp))
                Text(
                    text = latestError,
                    fontFamily = FontFamily.Default,
                    fontSize = 12.sp,
                    color = SeekerClawColors.Error,
                )
            }

            Spacer(modifier = Modifier.height(20.dp))

            HorizontalDivider(
                color = SeekerClawColors.TextDim.copy(alpha = 0.2f),
                thickness = 1.dp,
            )

            Spacer(modifier = Modifier.height(20.dp))

            Text(
                text = "Uptime",
                fontFamily = FontFamily.Default,
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

            Spacer(modifier = Modifier.height(20.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                StatMini(label = "TODAY", value = "$messagesToday")
                StatMini(label = "TOTAL", value = "$messageCount")
                StatMini(label = "LAST", value = formatLastActivity(lastActivityTime, context))
            }
        }

        Spacer(modifier = Modifier.height(28.dp))

        // Uplinks
        Text(
            text = "Uplinks",
            fontFamily = FontFamily.Default,
            fontSize = 11.sp,
            fontWeight = FontWeight.Medium,
            color = SeekerClawColors.TextDim,
            letterSpacing = 1.sp,
        )

        Spacer(modifier = Modifier.height(10.dp))

        Column(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            val gatewaySubtitle = when (status) {
                ServiceStatus.RUNNING -> "OpenClaw engine"
                ServiceStatus.STARTING -> "Starting..."
                ServiceStatus.STOPPED -> "Offline"
                ServiceStatus.ERROR -> {
                    if (!hasBotToken || !hasCredential) "Blocked: missing config"
                    else "Engine error"
                }
            }
            val gatewayDotColor = when (status) {
                ServiceStatus.RUNNING -> SeekerClawColors.Accent
                ServiceStatus.STARTING -> SeekerClawColors.Warning
                ServiceStatus.STOPPED -> SeekerClawColors.TextDim
                ServiceStatus.ERROR -> SeekerClawColors.Error
            }

            val telegramSubtitle = if (!hasBotToken) "Bot token missing" else when (status) {
                ServiceStatus.RUNNING -> "Message relay"
                ServiceStatus.STARTING -> "Connecting..."
                ServiceStatus.ERROR -> "Relay error"
                ServiceStatus.STOPPED -> "Offline"
            }
            val telegramDotColor = if (!hasBotToken) SeekerClawColors.Error else when (status) {
                ServiceStatus.RUNNING -> SeekerClawColors.Accent
                ServiceStatus.STARTING -> SeekerClawColors.Warning
                ServiceStatus.ERROR -> SeekerClawColors.Error
                ServiceStatus.STOPPED -> SeekerClawColors.TextDim
            }

            val aiSubtitle = if (!hasCredential) "Credential missing" else when (status) {
                ServiceStatus.RUNNING -> modelDisplayName(config?.model)
                ServiceStatus.STARTING -> "Loading model..."
                ServiceStatus.ERROR -> "Model error"
                ServiceStatus.STOPPED -> "Offline"
            }
            val aiDotColor = if (!hasCredential) SeekerClawColors.Error else when (status) {
                ServiceStatus.RUNNING -> SeekerClawColors.Accent
                ServiceStatus.STARTING -> SeekerClawColors.Warning
                ServiceStatus.ERROR -> SeekerClawColors.Error
                ServiceStatus.STOPPED -> SeekerClawColors.TextDim
            }

            UplinkCard(
                icon = "//TG",
                name = "Telegram",
                subtitle = telegramSubtitle,
                dotColor = telegramDotColor,
                shape = shape,
            )
            UplinkCard(
                icon = "//GW",
                name = "Gateway",
                subtitle = gatewaySubtitle,
                dotColor = gatewayDotColor,
                shape = shape,
            )
            UplinkCard(
                icon = "//AI",
                name = "AI Model",
                subtitle = aiSubtitle,
                dotColor = aiDotColor,
                shape = shape,
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
                StatMini(small = true, label = "API", value = "$apiRequests req")
                StatMini(small = true, label = "LATENCY", value = "${apiAvgLatency}ms")
                StatMini(
                    small = true,
                    label = "COST",
                    value = if (monthCost > 0f) "$${String.format("%.2f", monthCost)}" else "--",
                )
            }
        }

        Spacer(modifier = Modifier.height(28.dp))

        // Action button
        Button(
            onClick = {
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                if (isRunning) {
                    Analytics.serviceStopped(uptime / 60000)
                    OpenClawService.stop(context)
                } else {
                    val cfg = ConfigManager.loadConfig(context)
                    val startError = when (ConfigManager.runtimeValidationError(cfg)) {
                        "setup_not_complete" -> "Setup is not complete yet."
                        "missing_bot_token" -> "Telegram Bot Token is missing."
                        "missing_credential" ->
                            if (cfg?.authType == "setup_token") "Setup Token is missing."
                            else "API Key is missing."
                        else -> null
                    }
                    if (startError != null) {
                        Toast.makeText(context, "$startError Open Settings to fix.", Toast.LENGTH_LONG).show()
                        return@Button
                    }
                    Analytics.serviceStarted(1)
                    OpenClawService.start(context)
                }
            },
            modifier = Modifier
                .fillMaxWidth()
                .height(52.dp),
            shape = shape,
            colors = ButtonDefaults.buttonColors(
                containerColor = if (isRunning) Color(0xFF374151) else SeekerClawColors.Primary,
                contentColor = Color.White,
            ),
        ) {
            Text(
                text = if (isRunning) "Stop Agent" else "Deploy Agent",
                fontFamily = FontFamily.Default,
                fontWeight = FontWeight.Bold,
                fontSize = 15.sp,
            )
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
            fontFamily = FontFamily.Default,
            fontSize = if (small) 9.sp else 10.sp,
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
                fontFamily = FontFamily.Default,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                color = SeekerClawColors.TextPrimary,
            )
            Text(
                text = subtitle,
                fontFamily = FontFamily.Default,
                fontSize = 12.sp,
                color = SeekerClawColors.TextDim,
            )
        }

        Box(
            modifier = Modifier
                .size(10.dp)
                .clip(CircleShape)
                .background(dotColor),
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

