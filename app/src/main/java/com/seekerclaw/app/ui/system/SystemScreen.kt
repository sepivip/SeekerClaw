package com.seekerclaw.app.ui.system

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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.seekerclaw.app.BuildConfig
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.ui.theme.SeekerClawColors
import com.seekerclaw.app.util.DeviceInfo
import com.seekerclaw.app.util.DeviceInfoProvider
import com.seekerclaw.app.util.ClaudeUsageData
import com.seekerclaw.app.util.ServiceState
import com.seekerclaw.app.util.ServiceStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.json.JSONObject

@Composable
fun SystemScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val status by ServiceState.status.collectAsState()
    val uptime by ServiceState.uptime.collectAsState()
    val messageCount by ServiceState.messageCount.collectAsState()
    val messagesToday by ServiceState.messagesToday.collectAsState()
    val tokensToday by ServiceState.tokensToday.collectAsState()
    val tokensTotal by ServiceState.tokensTotal.collectAsState()
    val claudeUsage by ServiceState.claudeUsage.collectAsState()

    val config = ConfigManager.loadConfig(context)
    val agentName = config?.agentName?.ifBlank { "SeekerClaw" } ?: "SeekerClaw"
    val modelName = config?.model
        ?.ifBlank { "Not set" }
        ?.let { formatModelName(it) }
        ?: "Not set"

    var deviceInfo by remember { mutableStateOf<DeviceInfo?>(null) }
    var dbSummary by remember { mutableStateOf<DbSummary?>(null) }

    // Refresh device info every 5 seconds, DB summary every 30 seconds
    LaunchedEffect(Unit) {
        while (true) {
            deviceInfo = DeviceInfoProvider.getDeviceInfo(context)
            delay(5000)
        }
    }
    LaunchedEffect(status) {
        if (status == ServiceStatus.RUNNING) {
            while (true) {
                dbSummary = fetchDbSummary()
                delay(30_000)
            }
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
        // Back + Title
        Row(
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) {
                Icon(
                    Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = "Back",
                    tint = SeekerClawColors.TextDim,
                )
            }
            Text(
                text = "System",
                fontFamily = FontFamily.Default,
                fontSize = 22.sp,
                fontWeight = FontWeight.Bold,
                color = SeekerClawColors.TextPrimary,
            )
        }

        Spacer(modifier = Modifier.height(28.dp))

        // ==================== STATUS ====================
        SectionLabel("Status")

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(SeekerClawColors.Surface, shape)
                .padding(16.dp),
        ) {
            InfoRow("Version", BuildConfig.VERSION_NAME)
            InfoRow(
                label = "Node.js",
                value = when (status) {
                    ServiceStatus.RUNNING -> "Running"
                    ServiceStatus.STARTING -> "Starting"
                    ServiceStatus.STOPPED -> "Stopped"
                    ServiceStatus.ERROR -> "Error"
                },
                dotColor = when (status) {
                    ServiceStatus.RUNNING -> SeekerClawColors.Accent
                    ServiceStatus.STARTING -> SeekerClawColors.Warning
                    ServiceStatus.STOPPED -> SeekerClawColors.TextDim
                    ServiceStatus.ERROR -> SeekerClawColors.Error
                },
            )
            InfoRow("Agent", agentName)
            InfoRow("Uptime", formatUptime(uptime), isLast = true)
        }

        Spacer(modifier = Modifier.height(24.dp))

        // ==================== DEVICE ====================
        SectionLabel("Device")

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(SeekerClawColors.Surface, shape)
                .padding(16.dp),
        ) {
            val info = deviceInfo
            if (info != null) {
                ResourceBar(
                    label = "Battery",
                    value = "${info.batteryLevel}%",
                    progress = info.batteryLevel / 100f,
                    suffix = if (info.isCharging) "Charging" else "",
                    barColor = when {
                        info.batteryLevel <= 20 -> SeekerClawColors.Error
                        info.batteryLevel <= 40 -> SeekerClawColors.Warning
                        else -> SeekerClawColors.Accent
                    },
                )
                Spacer(modifier = Modifier.height(16.dp))
                ResourceBar(
                    label = "Memory",
                    value = "%.1f / %.1f GB".format(
                        info.memoryUsedMb / 1024f,
                        info.memoryTotalMb / 1024f,
                    ),
                    progress = if (info.memoryTotalMb > 0) info.memoryUsedMb.toFloat() / info.memoryTotalMb else 0f,
                    barColor = when {
                        info.memoryTotalMb > 0 && info.memoryUsedMb.toFloat() / info.memoryTotalMb > 0.9f -> SeekerClawColors.Error
                        info.memoryTotalMb > 0 && info.memoryUsedMb.toFloat() / info.memoryTotalMb > 0.7f -> SeekerClawColors.Warning
                        else -> SeekerClawColors.Accent
                    },
                )
                Spacer(modifier = Modifier.height(16.dp))
                ResourceBar(
                    label = "Storage",
                    value = "%.1f / %.0f GB".format(info.storageUsedGb, info.storageTotalGb),
                    progress = if (info.storageTotalGb > 0) info.storageUsedGb / info.storageTotalGb else 0f,
                    barColor = when {
                        info.storageTotalGb > 0 && info.storageUsedGb / info.storageTotalGb > 0.9f -> SeekerClawColors.Error
                        info.storageTotalGb > 0 && info.storageUsedGb / info.storageTotalGb > 0.7f -> SeekerClawColors.Warning
                        else -> SeekerClawColors.Accent
                    },
                )
            } else {
                Text(
                    text = "Loading\u2026",
                    fontFamily = FontFamily.Monospace,
                    fontSize = 13.sp,
                    color = SeekerClawColors.TextDim,
                )
            }
        }

        Spacer(modifier = Modifier.height(24.dp))

        // ==================== CONNECTION ====================
        SectionLabel("Connection")

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(SeekerClawColors.Surface, shape)
                .padding(16.dp),
        ) {
            InfoRow(
                label = "Telegram",
                value = if (status == ServiceStatus.RUNNING) "Connected" else "Disconnected",
                dotColor = if (status == ServiceStatus.RUNNING) SeekerClawColors.Accent else SeekerClawColors.TextDim,
            )
            InfoRow("Model", modelName, isLast = true)
        }

        Spacer(modifier = Modifier.height(24.dp))

        // ==================== CLAUDE LIMITS ====================
        val usage = claudeUsage
        if (usage != null) {
            SectionLabel("Claude Limits")

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SeekerClawColors.Surface, shape)
                    .padding(16.dp),
            ) {
                when (usage) {
                    is ClaudeUsageData.OAuthUsage -> {
                        UsageLimitBar(
                            label = "Session",
                            utilization = usage.fiveHourUtilization,
                            resetsAt = usage.fiveHourResetsAt,
                        )
                        Spacer(modifier = Modifier.height(16.dp))
                        UsageLimitBar(
                            label = "Weekly",
                            utilization = usage.sevenDayUtilization,
                            resetsAt = usage.sevenDayResetsAt,
                        )
                    }
                    is ClaudeUsageData.ApiKeyUsage -> {
                        val reqProgress = if (usage.requestsLimit > 0)
                            (usage.requestsLimit - usage.requestsRemaining).toFloat() / usage.requestsLimit else 0f
                        UsageLimitBar(
                            label = "Requests",
                            utilization = reqProgress,
                            detailText = "${usage.requestsRemaining} / ${usage.requestsLimit}",
                            resetsAt = usage.requestsReset,
                        )
                        Spacer(modifier = Modifier.height(16.dp))
                        val tokProgress = if (usage.tokensLimit > 0)
                            (usage.tokensLimit - usage.tokensRemaining).toFloat() / usage.tokensLimit else 0f
                        UsageLimitBar(
                            label = "Tokens",
                            utilization = tokProgress,
                            detailText = "${formatTokens(usage.tokensRemaining)} / ${formatTokens(usage.tokensLimit)}",
                            resetsAt = usage.tokensReset,
                        )
                    }
                }

                if (usage.error != null) {
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = "Error: ${usage.error}",
                        fontFamily = FontFamily.Monospace,
                        fontSize = 10.sp,
                        color = SeekerClawColors.Error,
                    )
                }

                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = "Updated ${formatTimeAgo(usage.updatedAt)}",
                    fontFamily = FontFamily.Monospace,
                    fontSize = 10.sp,
                    color = SeekerClawColors.TextDim,
                )
            }

            Spacer(modifier = Modifier.height(24.dp))
        }

        // ==================== USAGE ====================
        SectionLabel("Usage")

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            StatCard(
                label = "Today",
                value = "$messagesToday",
                unit = "messages",
                modifier = Modifier.weight(1f),
            )
            StatCard(
                label = "All Time",
                value = "$messageCount",
                unit = "messages",
                modifier = Modifier.weight(1f),
            )
        }

        Spacer(modifier = Modifier.height(12.dp))

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            StatCard(
                label = "Today",
                value = formatTokens(tokensToday),
                unit = "tokens",
                modifier = Modifier.weight(1f),
            )
            StatCard(
                label = "All Time",
                value = formatTokens(tokensTotal),
                unit = "tokens",
                modifier = Modifier.weight(1f),
            )
        }

        // ==================== API ANALYTICS (BAT-32) ====================
        val stats = dbSummary
        if (stats != null && stats.todayRequests > 0) {
            Spacer(modifier = Modifier.height(24.dp))

            SectionLabel("API Analytics")

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SeekerClawColors.Surface, shape)
                    .padding(16.dp),
            ) {
                InfoRow("Requests", "${stats.todayRequests} today")
                InfoRow(
                    label = "Avg Latency",
                    value = if (stats.todayAvgLatencyMs > 0) "${stats.todayAvgLatencyMs}ms" else "--",
                    dotColor = when {
                        stats.todayAvgLatencyMs > 5000 -> SeekerClawColors.Error
                        stats.todayAvgLatencyMs > 3000 -> SeekerClawColors.Warning
                        else -> SeekerClawColors.Accent
                    },
                )
                InfoRow(
                    label = "Error Rate",
                    value = if (stats.todayRequests > 0)
                        "${(stats.todayErrors * 100) / stats.todayRequests}%" else "0%",
                    dotColor = when {
                        stats.todayErrors > 0 -> SeekerClawColors.Warning
                        else -> SeekerClawColors.Accent
                    },
                )
                InfoRow(
                    label = "Cache Hits",
                    value = "${(stats.todayCacheHitRate * 100).toInt()}%",
                )
                if (stats.monthCostEstimate > 0f) {
                    InfoRow(
                        label = "Est. Cost",
                        value = "$${String.format("%.2f", stats.monthCostEstimate)} /mo",
                        isLast = true,
                    )
                } else {
                    InfoRow(label = "Tokens In/Out",
                        value = "${formatTokens(stats.todayInputTokens)} / ${formatTokens(stats.todayOutputTokens)}",
                        isLast = true,
                    )
                }
            }
        }

        // ==================== MEMORY INDEX (BAT-33) ====================
        if (stats != null && (stats.memoryFilesIndexed > 0 || stats.memoryChunksCount > 0)) {
            Spacer(modifier = Modifier.height(24.dp))

            SectionLabel("Memory Index")

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SeekerClawColors.Surface, shape)
                    .padding(16.dp),
            ) {
                InfoRow("Files", "${stats.memoryFilesIndexed}")
                InfoRow("Chunks", "${stats.memoryChunksCount}")
                InfoRow(
                    label = "Last Indexed",
                    value = if (stats.memoryLastIndexed != null)
                        formatMemoryIndexTime(stats.memoryLastIndexed) else "Never",
                    isLast = true,
                    dotColor = when {
                        stats.memoryLastIndexed == null -> SeekerClawColors.TextDim
                        else -> SeekerClawColors.Accent
                    },
                )
            }
        }

        Spacer(modifier = Modifier.height(32.dp))
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text = text,
        fontFamily = FontFamily.Monospace,
        fontSize = 11.sp,
        fontWeight = FontWeight.Medium,
        color = SeekerClawColors.TextDim,
        letterSpacing = 1.sp,
    )
    Spacer(modifier = Modifier.height(10.dp))
}

@Composable
private fun InfoRow(
    label: String,
    value: String,
    dotColor: androidx.compose.ui.graphics.Color? = null,
    isLast: Boolean = false,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            fontFamily = FontFamily.Monospace,
            fontSize = 13.sp,
            color = SeekerClawColors.TextSecondary,
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = value,
                fontFamily = FontFamily.Monospace,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                color = SeekerClawColors.TextPrimary,
            )
            if (dotColor != null) {
                Spacer(modifier = Modifier.width(8.dp))
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(dotColor),
                )
            }
        }
    }
    if (!isLast) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(1.dp)
                .background(SeekerClawColors.TextDim.copy(alpha = 0.1f)),
        )
    }
}

@Composable
private fun ResourceBar(
    label: String,
    value: String,
    progress: Float,
    barColor: androidx.compose.ui.graphics.Color,
    suffix: String = "",
) {
    Column {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = label,
                fontFamily = FontFamily.Monospace,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                color = SeekerClawColors.TextPrimary,
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = value,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    color = SeekerClawColors.TextSecondary,
                )
                if (suffix.isNotEmpty()) {
                    Spacer(modifier = Modifier.width(6.dp))
                    Text(
                        text = suffix,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 10.sp,
                        color = SeekerClawColors.Accent,
                    )
                }
            }
        }
        Spacer(modifier = Modifier.height(6.dp))
        LinearProgressIndicator(
            progress = { progress.coerceIn(0f, 1f) },
            modifier = Modifier
                .fillMaxWidth()
                .height(6.dp)
                .clip(RoundedCornerShape(3.dp)),
            color = barColor,
            trackColor = SeekerClawColors.TextDim.copy(alpha = 0.15f),
        )
    }
}

@Composable
private fun StatCard(
    label: String,
    value: String,
    unit: String,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)

    Column(
        modifier = modifier
            .background(SeekerClawColors.Surface, shape)
            .padding(16.dp),
    ) {
        Text(
            text = label,
            fontFamily = FontFamily.Monospace,
            fontSize = 11.sp,
            color = SeekerClawColors.TextDim,
        )
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            text = value,
            fontFamily = FontFamily.Monospace,
            fontSize = 24.sp,
            fontWeight = FontWeight.Bold,
            color = SeekerClawColors.TextPrimary,
        )
        Spacer(modifier = Modifier.height(2.dp))
        Text(
            text = unit,
            fontFamily = FontFamily.Monospace,
            fontSize = 11.sp,
            color = SeekerClawColors.TextDim,
        )
    }
}

private fun formatUptime(millis: Long): String {
    if (millis <= 0) return "0m"
    val seconds = millis / 1000
    val minutes = seconds / 60
    val hours = minutes / 60
    val days = hours / 24
    return buildString {
        if (days > 0) append("${days}d ")
        if (hours % 24 > 0) append("${hours % 24}h ")
        append("${minutes % 60}m")
    }.trim()
}

private fun formatModelName(model: String): String {
    return when {
        model.contains("opus") -> "Opus 4.6"
        model.contains("sonnet") -> "Sonnet 4.5"
        model.contains("haiku") -> "Haiku 4.5"
        else -> model.substringAfterLast("-").replaceFirstChar { it.uppercase() }
    }
}

@Composable
private fun UsageLimitBar(
    label: String,
    utilization: Float,
    resetsAt: String = "",
    detailText: String? = null,
) {
    val percentage = (utilization * 100).toInt()
    val remaining = 100 - percentage
    val barColor = when {
        utilization > 0.9f -> SeekerClawColors.Error
        utilization > 0.7f -> SeekerClawColors.Warning
        else -> SeekerClawColors.Accent
    }

    Column {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = label,
                fontFamily = FontFamily.Monospace,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                color = SeekerClawColors.TextPrimary,
            )
            Text(
                text = "${remaining}% left",
                fontFamily = FontFamily.Monospace,
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold,
                color = barColor,
            )
        }

        Spacer(modifier = Modifier.height(6.dp))

        LinearProgressIndicator(
            progress = { utilization.coerceIn(0f, 1f) },
            modifier = Modifier
                .fillMaxWidth()
                .height(6.dp)
                .clip(RoundedCornerShape(3.dp)),
            color = barColor,
            trackColor = SeekerClawColors.TextDim.copy(alpha = 0.15f),
        )

        if (detailText != null || resetsAt.isNotBlank()) {
            Spacer(modifier = Modifier.height(4.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = detailText ?: "",
                    fontFamily = FontFamily.Monospace,
                    fontSize = 10.sp,
                    color = SeekerClawColors.TextDim,
                )
                if (resetsAt.isNotBlank()) {
                    Text(
                        text = "Resets ${formatResetTime(resetsAt)}",
                        fontFamily = FontFamily.Monospace,
                        fontSize = 10.sp,
                        color = SeekerClawColors.TextDim,
                    )
                }
            }
        }
    }
}

private fun formatResetTime(isoTimestamp: String): String {
    return try {
        val resetInstant = java.time.Instant.parse(isoTimestamp)
        val now = java.time.Instant.now()
        val diff = java.time.Duration.between(now, resetInstant)
        when {
            diff.isNegative -> "soon"
            diff.toHours() > 0 -> "in ${diff.toHours()}h ${diff.toMinutes() % 60}m"
            diff.toMinutes() > 0 -> "in ${diff.toMinutes()}m"
            else -> "in <1m"
        }
    } catch (_: Exception) {
        ""
    }
}

private fun formatTimeAgo(epochMillis: Long): String {
    val diff = System.currentTimeMillis() - epochMillis
    return when {
        diff < 60_000 -> "just now"
        diff < 3_600_000 -> "${diff / 60_000}m ago"
        diff < 86_400_000 -> "${diff / 3_600_000}h ago"
        else -> "${diff / 86_400_000}d ago"
    }
}

private fun formatTokens(count: Long): String {
    return when {
        count >= 1_000_000_000 -> "%.1fB".format(count / 1_000_000_000f)
        count >= 1_000_000 -> "%.1fM".format(count / 1_000_000f)
        count >= 1_000 -> "%.1fK".format(count / 1_000f)
        else -> "$count"
    }
}

private fun formatMemoryIndexTime(isoTimestamp: String): String {
    return try {
        val parts = isoTimestamp.split("T")
        if (parts.size < 2) return isoTimestamp
        val timePart = parts[1].substringBefore("+").substringBefore("-")
        val hm = timePart.split(":").take(2).joinToString(":")
        "Today $hm"
    } catch (_: Exception) {
        isoTimestamp
    }
}

// ==================== DB Summary (BAT-32) ====================

private data class DbSummary(
    val todayRequests: Int = 0,
    val todayInputTokens: Long = 0,
    val todayOutputTokens: Long = 0,
    val todayAvgLatencyMs: Int = 0,
    val todayErrors: Int = 0,
    val todayCacheHitRate: Float = 0f,
    val monthRequests: Int = 0,
    val monthInputTokens: Long = 0,
    val monthOutputTokens: Long = 0,
    val monthCostEstimate: Float = 0f,
    val memoryFilesIndexed: Int = 0,
    val memoryChunksCount: Int = 0,
    val memoryLastIndexed: String? = null,
)

private suspend fun fetchDbSummary(): DbSummary? = withContext(Dispatchers.IO) {
    try {
        val url = java.net.URL("http://127.0.0.1:8765/stats/db-summary")
        val conn = url.openConnection() as java.net.HttpURLConnection
        conn.requestMethod = "POST"
        conn.connectTimeout = 3000
        conn.readTimeout = 3000
        conn.setRequestProperty("Content-Type", "application/json")
        conn.doOutput = true
        conn.outputStream.use { it.write("{}".toByteArray()) }

        val code = conn.responseCode
        if (code !in 200..299) {
            conn.disconnect()
            return@withContext null
        }
        val body = conn.inputStream.bufferedReader().use { it.readText() }
        conn.disconnect()

        val json = JSONObject(body)
        val today = if (json.has("today") && !json.isNull("today")) json.getJSONObject("today") else null
        val month = if (json.has("month") && !json.isNull("month")) json.getJSONObject("month") else null
        val memory = if (json.has("memory") && !json.isNull("memory")) json.getJSONObject("memory") else null

        DbSummary(
            todayRequests = today?.optInt("requests", 0) ?: 0,
            todayInputTokens = today?.optLong("input_tokens", 0) ?: 0,
            todayOutputTokens = today?.optLong("output_tokens", 0) ?: 0,
            todayAvgLatencyMs = today?.optInt("avg_latency_ms", 0) ?: 0,
            todayErrors = today?.optInt("errors", 0) ?: 0,
            todayCacheHitRate = today?.optDouble("cache_hit_rate", 0.0)?.toFloat() ?: 0f,
            monthRequests = month?.optInt("requests", 0) ?: 0,
            monthInputTokens = month?.optLong("input_tokens", 0) ?: 0,
            monthOutputTokens = month?.optLong("output_tokens", 0) ?: 0,
            monthCostEstimate = month?.optDouble("total_cost_estimate", 0.0)?.toFloat() ?: 0f,
            memoryFilesIndexed = memory?.optInt("files_indexed", 0) ?: 0,
            memoryChunksCount = memory?.optInt("chunks_count", 0) ?: 0,
            memoryLastIndexed = memory?.optString("last_indexed", null),
        )
    } catch (_: Exception) {
        null
    }
}
