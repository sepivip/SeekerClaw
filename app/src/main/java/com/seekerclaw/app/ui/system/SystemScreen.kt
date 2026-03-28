package com.seekerclaw.app.ui.system

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.layout.widthIn
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
import com.seekerclaw.app.ui.theme.RethinkSans
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.seekerclaw.app.BuildConfig
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.ui.theme.SeekerClawColors
import com.seekerclaw.app.util.AppStorageInfo
import com.seekerclaw.app.util.DeviceInfo
import com.seekerclaw.app.util.DeviceInfoProvider
import com.seekerclaw.app.util.ApiUsageData
import com.seekerclaw.app.util.DayActivity
import com.seekerclaw.app.util.DbSummary
import com.seekerclaw.app.util.ServiceState
import com.seekerclaw.app.util.ServiceStatus
import com.seekerclaw.app.util.fetchDbSummary
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.format.TextStyle
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

private val HeatmapColors = listOf(
    Color(0xFF1A1A24),
    Color(0xFF3D1117),
    Color(0xFF6B1D2A),
    Color(0xFF8B2232),
    Color(0xFFE41F28),
)

private fun heatmapColorForCount(count: Int, thresholds: List<Int>): Color {
    if (count == 0) return HeatmapColors[0]
    if (thresholds.isEmpty()) return HeatmapColors[4]
    return when {
        count <= thresholds.getOrElse(0) { 1 } -> HeatmapColors[1]
        count <= thresholds.getOrElse(1) { 2 } -> HeatmapColors[2]
        count <= thresholds.getOrElse(2) { 5 } -> HeatmapColors[3]
        else -> HeatmapColors[4]
    }
}

@Composable
fun SystemScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val status by ServiceState.status.collectAsState()
    val uptime by ServiceState.uptime.collectAsState()
    val messageCount by ServiceState.messageCount.collectAsState()
    val messagesToday by ServiceState.messagesToday.collectAsState()
    val tokensToday by ServiceState.tokensToday.collectAsState()
    val tokensTotal by ServiceState.tokensTotal.collectAsState()
    val apiUsage by ServiceState.apiUsage.collectAsState()
    val lastActivity by ServiceState.lastActivityTime.collectAsState()

    val cfgVersion by ConfigManager.configVersion
    val config = remember(cfgVersion) { ConfigManager.loadConfig(context) }
    val agentName = remember(config) { config?.agentName?.ifBlank { "SeekerClaw" } ?: "SeekerClaw" }
    val modelName = config?.model
        ?.ifBlank { "Not set" }
        ?.let { formatModelName(it) }
        ?: "Not set"

    var deviceInfo by remember { mutableStateOf<DeviceInfo?>(null) }
    var appStorage by remember { mutableStateOf<AppStorageInfo?>(null) }
    var dbSummary by remember { mutableStateOf<DbSummary?>(null) }

    // Refresh device info every 5 seconds
    LaunchedEffect(Unit) {
        while (true) {
            deviceInfo = DeviceInfoProvider.getDeviceInfo(context)
            delay(5000)
        }
    }
    // App storage: recursive file walk on IO thread, refresh every 60s (not 5s — too expensive)
    LaunchedEffect(Unit) {
        while (true) {
            appStorage = withContext(Dispatchers.IO) {
                DeviceInfoProvider.getAppStorageInfo(context)
            }
            delay(60_000)
        }
    }
    // Fetch DB summary every 30s while running; clear on stop
    LaunchedEffect(status) {
        if (status == ServiceStatus.RUNNING) {
            while (true) {
                val result = fetchDbSummary()
                dbSummary = result
                delay(if (result != null) 30_000L else 5_000L)
            }
        } else {
            dbSummary = null
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
                fontFamily = RethinkSans,
                fontSize = 22.sp,
                fontWeight = FontWeight.Bold,
                color = SeekerClawColors.TextPrimary,
            )
        }

        Spacer(modifier = Modifier.height(24.dp))

        // ==================== STATUS ====================
        SectionLabel("Status")

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(SeekerClawColors.Surface, shape)
                .padding(16.dp),
        ) {
            InfoRow("Version", "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
            InfoRow("OpenClaw", BuildConfig.OPENCLAW_VERSION)
            InfoRow(
                label = "Node.js",
                value = "${BuildConfig.NODEJS_VERSION} — ${when (status) {
                    ServiceStatus.RUNNING -> "Running"
                    ServiceStatus.STARTING -> "Starting"
                    ServiceStatus.STOPPED -> "Stopped"
                    ServiceStatus.ERROR -> "Error"
                }}",
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

        // ==================== MESSAGE ACTIVITY ====================
        SectionLabel("Message Activity")

        MessageActivityHeatmap(
            dailyActivity = dbSummary?.dailyActivity ?: emptyList()
        )

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
                    label = "Device Memory",
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
                    label = "Device Storage",
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

            // App Storage breakdown (inside Device card as sub-section)
            val appInfo = appStorage
            if (appInfo != null && appInfo.totalMb > 0.1f) {
                Spacer(modifier = Modifier.height(12.dp))
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(1.dp)
                        .background(SeekerClawColors.TextDim.copy(alpha = 0.15f)),
                )
                Spacer(modifier = Modifier.height(12.dp))
                Text(
                    text = "APP STORAGE",
                    fontFamily = FontFamily.Monospace,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.TextDim,
                    letterSpacing = 1.sp,
                )
                Spacer(modifier = Modifier.height(8.dp))
                InfoRow("Workspace", "%.1f MB".format(appInfo.workspaceMb))
                InfoRow("Database", "%.1f MB".format(appInfo.databaseMb))
                InfoRow("Logs", "%.1f MB".format(appInfo.logsMb))
                InfoRow("Runtime", "%.1f MB".format(appInfo.runtimeMb))
                InfoRow("Total", "%.1f MB".format(appInfo.totalMb), isLast = true)
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
            if (status == ServiceStatus.RUNNING && lastActivity > 0L) {
                InfoRow(
                    label = "Last message",
                    value = formatTimeAgo(lastActivity),
                )
            }
            InfoRow("Model", modelName, isLast = true)
        }

        Spacer(modifier = Modifier.height(24.dp))

        // ==================== API LIMITS ====================
        val usage = apiUsage
        if (usage != null) {
            SectionLabel("API Limits")

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SeekerClawColors.Surface, shape)
                    .padding(16.dp),
            ) {
                // Only show bars if we have real data (not error-only)
                val hasValidData = when (usage) {
                    is ApiUsageData.OAuthUsage ->
                        usage.error == null || usage.fiveHourUtilization > 0f || usage.sevenDayUtilization > 0f
                    is ApiUsageData.ApiKeyUsage ->
                        usage.error == null || usage.requestsLimit > 0
                }

                if (hasValidData) {
                    when (usage) {
                        is ApiUsageData.OAuthUsage -> {
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
                        is ApiUsageData.ApiKeyUsage -> {
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
                }

                if (usage.error != null) {
                    if (hasValidData) Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = if (hasValidData) "Error: ${usage.error}" else "Usage data unavailable (${usage.error})",
                        fontFamily = FontFamily.Monospace,
                        fontSize = 10.sp,
                        color = if (hasValidData) SeekerClawColors.Error else SeekerClawColors.TextDim,
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
        if (status == ServiceStatus.RUNNING || status == ServiceStatus.STARTING) {
            Spacer(modifier = Modifier.height(24.dp))

            SectionLabel("API Analytics")

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SeekerClawColors.Surface, shape)
                    .padding(16.dp),
            ) {
                InfoRow("Requests", if (stats != null) "${stats.todayRequests} today" else "--")
                InfoRow(
                    label = "Avg Latency",
                    value = if (stats != null && stats.todayAvgLatencyMs > 0) "${stats.todayAvgLatencyMs}ms" else "--",
                    dotColor = when {
                        stats == null -> SeekerClawColors.TextDim
                        stats.todayAvgLatencyMs > 5000 -> SeekerClawColors.Error
                        stats.todayAvgLatencyMs > 3000 -> SeekerClawColors.Warning
                        else -> SeekerClawColors.Accent
                    },
                )
                InfoRow(
                    label = "Error Rate",
                    value = if (stats != null && stats.todayRequests > 0 && stats.todayErrors > 0)
                        String.format("%.1f%%", stats.todayErrors.toDouble() * 100.0 / stats.todayRequests)
                    else if (stats != null) "0%" else "--",
                    dotColor = when {
                        stats == null -> SeekerClawColors.TextDim
                        stats.todayErrors > 0 -> SeekerClawColors.Warning
                        else -> SeekerClawColors.Accent
                    },
                )
                InfoRow(
                    label = "Cache Hits",
                    value = if (stats != null) "${(stats.todayCacheHitRate * 100).toInt()}%" else "--",
                )
                InfoRow(
                    label = "Tokens In/Out",
                    value = if (stats != null)
                        "${formatTokens(stats.todayInputTokens)} / ${formatTokens(stats.todayOutputTokens)}"
                    else "--",
                    isLast = true,
                )
            }

            // ==================== MEMORY INDEX (BAT-33) ====================
            Spacer(modifier = Modifier.height(24.dp))

            SectionLabel("Memory Index")

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SeekerClawColors.Surface, shape)
                    .padding(16.dp),
            ) {
                InfoRow("Files", if (stats != null) "${stats.memoryFilesIndexed}" else "--")
                InfoRow("Chunks", if (stats != null) "${stats.memoryChunksCount}" else "--")
                val lastIndexedRaw = stats?.memoryLastIndexed
                val lastIndexedFormatted = remember(lastIndexedRaw) {
                    if (lastIndexedRaw != null) formatMemoryIndexTime(lastIndexedRaw) else "--"
                }
                InfoRow(
                    label = "Last Indexed",
                    value = if (stats != null) lastIndexedFormatted else "--",
                    isLast = true,
                    dotColor = when {
                        stats == null || lastIndexedRaw == null -> SeekerClawColors.TextDim
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
    Spacer(modifier = Modifier.height(8.dp))
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
                        .size(10.dp)
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
                .background(SeekerClawColors.TextDim.copy(alpha = 0.15f)),
        )
    }
}

@Composable
private fun ResourceBar(
    label: String,
    value: String,
    progress: Float,
    barColor: androidx.compose.ui.graphics.Color,
    modifier: Modifier = Modifier,
    suffix: String = "",
) {
    Column(modifier = modifier) {
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
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = suffix,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 10.sp,
                        color = SeekerClawColors.Accent,
                    )
                }
            }
        }
        Spacer(modifier = Modifier.height(8.dp))
        LinearProgressIndicator(
            progress = { progress.coerceIn(0f, 1f) },
            modifier = Modifier
                .fillMaxWidth()
                .height(8.dp)
                .clip(RoundedCornerShape(4.dp)),
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
            fontFamily = RethinkSans,
            fontSize = 26.sp,
            fontWeight = FontWeight.Bold,
            color = SeekerClawColors.TextPrimary,
        )
        Spacer(modifier = Modifier.height(2.dp))
        Text(
            text = unit,
            fontFamily = RethinkSans,
            fontSize = 11.sp,
            color = SeekerClawColors.TextDim,
        )
    }
}

@Composable
private fun MessageActivityHeatmap(dailyActivity: List<DayActivity>) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)
    val cellGap = 2.dp
    val cellShape = RoundedCornerShape(2.dp)

    val today = LocalDate.now()
    // 6-month half-year chunks: Jan-Jun or Jul-Dec
    val halfYearStart = if (today.monthValue <= 6) {
        LocalDate.of(today.year, 1, 1)
    } else {
        LocalDate.of(today.year, 7, 1)
    }
    // Grid starts on Monday of the week containing halfYearStart
    val gridStart = halfYearStart.with(DayOfWeek.MONDAY)

    // Build date -> count map
    val dateCountMap = remember(dailyActivity) {
        dailyActivity.mapNotNull { activity ->
            try {
                LocalDate.parse(activity.day) to activity.count
            } catch (_: Exception) {
                null
            }
        }.toMap()
    }

    // Build weeks grid: each week = 7 days (Mon-Sun), null for out-of-range
    val weeks = remember(gridStart, today, halfYearStart) {
        val result = mutableListOf<List<LocalDate?>>()
        var current = gridStart
        while (current <= today) {
            val week = (0 until 7).map { dow ->
                val day = current.plusDays(dow.toLong())
                if (day > today || day < halfYearStart) null else day
            }
            result.add(week)
            current = current.plusWeeks(1)
        }
        result
    }

    // Percentile thresholds from non-zero counts
    val thresholds = remember(dateCountMap) {
        val nonZero = dateCountMap.values.filter { it > 0 }.sorted()
        if (nonZero.isEmpty()) emptyList()
        else listOf(
            nonZero[(nonZero.size * 0.25).toInt().coerceAtMost(nonZero.size - 1)],
            nonZero[(nonZero.size * 0.50).toInt().coerceAtMost(nonZero.size - 1)],
            nonZero[(nonZero.size * 0.75).toInt().coerceAtMost(nonZero.size - 1)],
        )
    }

    val totalMessages = remember(dateCountMap) { dateCountMap.values.sum() }

    // Month labels
    val monthLabels = remember(weeks) {
        val labels = mutableListOf<Pair<Int, String>>()
        var lastMonth = -1
        weeks.forEachIndexed { weekIndex, week ->
            val firstDay = week.firstOrNull { it != null }
            if (firstDay != null && firstDay.monthValue != lastMonth) {
                lastMonth = firstDay.monthValue
                labels.add(weekIndex to firstDay.month.getDisplayName(TextStyle.SHORT, Locale.ENGLISH))
            }
        }
        labels
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(SeekerClawColors.Surface, shape)
            .padding(16.dp),
    ) {
        if (dailyActivity.isEmpty() || totalMessages == 0) {
            Text(
                text = "No message data yet",
                fontFamily = FontFamily.Monospace,
                fontSize = 11.sp,
                color = SeekerClawColors.TextDim,
            )
        } else {
            // Use BoxWithConstraints to calculate cell size that fills available width
            androidx.compose.foundation.layout.BoxWithConstraints(
                modifier = Modifier.fillMaxWidth()
            ) {
                val numWeeks = weeks.size
                // Cell size = (available width - gaps) / number of weeks
                val availableWidth = maxWidth
                val totalGaps = cellGap * (numWeeks - 1)
                val cellSize = ((availableWidth - totalGaps) / numWeeks).coerceIn(6.dp, 16.dp)

                Column {
                    // Month labels
                    Row(modifier = Modifier.fillMaxWidth()) {
                        var labelIndex = 0
                        for (weekIndex in weeks.indices) {
                            val colWidth = cellSize + if (weekIndex < numWeeks - 1) cellGap else 0.dp
                            if (labelIndex < monthLabels.size && monthLabels[labelIndex].first == weekIndex) {
                                Text(
                                    text = monthLabels[labelIndex].second,
                                    fontFamily = FontFamily.Monospace,
                                    fontSize = 9.sp,
                                    color = SeekerClawColors.TextDim,
                                    modifier = Modifier.widthIn(min = colWidth),
                                    maxLines = 1,
                                    overflow = androidx.compose.ui.text.style.TextOverflow.Visible,
                                )
                                labelIndex++
                            } else {
                                Spacer(modifier = Modifier.width(colWidth))
                            }
                        }
                    }

                    Spacer(modifier = Modifier.height(4.dp))

                    // Grid: 7 rows x N weeks
                    for (dayOfWeek in 0..6) {
                        Row {
                            for (weekIndex in weeks.indices) {
                                val date = weeks[weekIndex].getOrNull(dayOfWeek)
                                val count = if (date != null) dateCountMap[date] ?: 0 else 0
                                val color = if (date != null) {
                                    heatmapColorForCount(count, thresholds)
                                } else {
                                    Color.Transparent
                                }
                                Box(
                                    modifier = Modifier
                                        .size(cellSize)
                                        .background(color, cellShape),
                                )
                                if (weekIndex < numWeeks - 1) {
                                    Spacer(modifier = Modifier.width(cellGap))
                                }
                            }
                        }
                        if (dayOfWeek < 6) {
                            Spacer(modifier = Modifier.height(cellGap))
                        }
                    }
                }
            }

            Spacer(modifier = Modifier.height(12.dp))

            // Footer
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                val countText = when {
                    totalMessages >= 1_000_000 -> "${totalMessages / 1_000_000}M+"
                    totalMessages >= 100_000 -> "${totalMessages / 1_000}K+"
                    else -> "%,d".format(totalMessages)
                }
                Text(
                    text = "$countText msgs in last 6 months",
                    fontFamily = FontFamily.Monospace,
                    fontSize = 11.sp,
                    color = SeekerClawColors.TextDim,
                )

                // Legend
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = "Less",
                        fontFamily = FontFamily.Monospace,
                        fontSize = 11.sp,
                        color = SeekerClawColors.TextDim,
                    )
                    Spacer(modifier = Modifier.width(4.dp))
                    val legendSize = 8.dp
                    for (i in HeatmapColors.indices) {
                        Box(
                            modifier = Modifier
                                .size(legendSize)
                                .background(HeatmapColors[i], cellShape),
                        )
                        if (i < HeatmapColors.size - 1) {
                            Spacer(modifier = Modifier.width(2.dp))
                        }
                    }
                    Spacer(modifier = Modifier.width(4.dp))
                    Text(
                        text = "More",
                        fontFamily = FontFamily.Monospace,
                        fontSize = 11.sp,
                        color = SeekerClawColors.TextDim,
                    )
                }
            }
        }
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
        model.contains("sonnet-4-6") -> "Sonnet 4.6"
        model.contains("sonnet") -> "Sonnet 4.5"
        model.contains("haiku") -> "Haiku 4.5"
        else -> model.substringAfterLast("-").replaceFirstChar { it.uppercase() }
    }
}

@Composable
private fun UsageLimitBar(
    label: String,
    utilization: Float,
    modifier: Modifier = Modifier,
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

    Column(modifier = modifier) {
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

        Spacer(modifier = Modifier.height(8.dp))

        LinearProgressIndicator(
            progress = { utilization.coerceIn(0f, 1f) },
            modifier = Modifier
                .fillMaxWidth()
                .height(8.dp)
                .clip(RoundedCornerShape(4.dp)),
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
        // Parse with timezone awareness, converting to local device time
        val zonedDateTime = try {
            java.time.OffsetDateTime.parse(isoTimestamp)
                .atZoneSameInstant(java.time.ZoneId.systemDefault())
        } catch (_: Exception) {
            java.time.Instant.parse(isoTimestamp)
                .atZone(java.time.ZoneId.systemDefault())
        }
        val localDate = zonedDateTime.toLocalDate()
        val localTime = zonedDateTime.toLocalTime()
        val hm = "%02d:%02d".format(localTime.hour, localTime.minute)
        val today = java.time.LocalDate.now(java.time.ZoneId.systemDefault())
        if (localDate == today) "Today $hm" else "$localDate $hm"
    } catch (_: Exception) {
        // Fallback: naive string split for non-standard formats
        try {
            val parts = isoTimestamp.split("T")
            if (parts.size < 2) return isoTimestamp
            val datePart = parts[0]
            val timePart = parts[1].substringBefore("+").substringBefore("-")
            val hm = timePart.split(":").take(2).joinToString(":")
            val todayStr = java.time.LocalDate.now().toString()
            if (datePart == todayStr) "Today $hm" else "$datePart $hm"
        } catch (_: Exception) {
            isoTimestamp
        }
    }
}

// DbSummary and fetchDbSummary are in com.seekerclaw.app.util.StatsClient
