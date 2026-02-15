package com.seekerclaw.app.ui.logs

import androidx.compose.foundation.background
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.TextButton
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.platform.LocalContext
import com.seekerclaw.app.ui.theme.SeekerClawColors
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
import java.util.Date

@Composable
fun LogsScreen() {
    val context = LocalContext.current
    val logs by LogCollector.logs.collectAsState()
    val listState = rememberLazyListState()
    var autoScroll by remember { mutableStateOf(true) }

    var showClearDialog by remember { mutableStateOf(false) }

    // Filter toggles — all enabled by default
    var showInfo by remember { mutableStateOf(true) }
    var showWarn by remember { mutableStateOf(true) }
    var showError by remember { mutableStateOf(true) }

    val filteredLogs = remember(logs, showInfo, showWarn, showError) {
        logs.filter { entry ->
            when (entry.level) {
                LogLevel.INFO -> showInfo
                LogLevel.WARN -> showWarn
                LogLevel.ERROR -> showError
            }
        }
    }

    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)

    LaunchedEffect(filteredLogs.size, autoScroll) {
        if (autoScroll && filteredLogs.isNotEmpty()) {
            listState.animateScrollToItem(filteredLogs.size - 1)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(SeekerClawColors.Background)
            .padding(20.dp),
    ) {
        // Header — icon + title + share/trash buttons
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Default.Terminal,
                    contentDescription = null,
                    tint = SeekerClawColors.Primary,
                    modifier = Modifier.size(24.dp),
                )
                Spacer(modifier = Modifier.width(10.dp))
                Text(
                    text = "Console",
                    fontFamily = FontFamily.Default,
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.TextPrimary,
                )
            }
            Row {
                IconButton(onClick = {
                    val logText = buildString {
                        appendLine("SeekerClaw Logs — ${java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.US).format(Date())}")
                        appendLine("─".repeat(40))
                        filteredLogs.forEach { entry ->
                            val pattern = if (android.text.format.DateFormat.is24HourFormat(context)) "HH:mm:ss" else "hh:mm:ss a"
                            val timeStr = android.text.format.DateFormat.format(pattern, Date(entry.timestamp))
                            appendLine("[${entry.level.name}] [$timeStr] ${entry.message}")
                        }
                    }
                    val sendIntent = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                        type = "text/plain"
                        putExtra(android.content.Intent.EXTRA_TEXT, logText)
                        putExtra(android.content.Intent.EXTRA_SUBJECT, "SeekerClaw Logs")
                    }
                    context.startActivity(android.content.Intent.createChooser(sendIntent, "Share Logs"))
                }) {
                    Icon(
                        Icons.Default.Share,
                        contentDescription = "Share logs",
                        tint = SeekerClawColors.TextDim,
                    )
                }
                IconButton(onClick = { showClearDialog = true }) {
                    Icon(
                        Icons.Default.Delete,
                        contentDescription = "Clear logs",
                        tint = SeekerClawColors.TextDim,
                    )
                }
            }
        }

        Text(
            text = "System logs and diagnostics",
            fontFamily = FontFamily.Default,
            fontSize = 13.sp,
            color = SeekerClawColors.TextDim,
        )

        Spacer(modifier = Modifier.height(16.dp))

        // Terminal window
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .background(SeekerClawColors.Surface, shape),
        ) {
            if (filteredLogs.isEmpty()) {
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            text = "$ _",
                            fontFamily = FontFamily.Monospace,
                            fontSize = 24.sp,
                            color = SeekerClawColors.TextDim.copy(alpha = 0.4f),
                        )
                        Spacer(modifier = Modifier.height(8.dp))
                        Text(
                            text = "Awaiting output\u2026",
                            fontFamily = FontFamily.Monospace,
                            fontSize = 13.sp,
                            color = SeekerClawColors.TextDim,
                        )
                    }
                }
            } else {
                LazyColumn(
                    state = listState,
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                ) {
                    items(filteredLogs) { entry ->
                        val color = when (entry.level) {
                            LogLevel.INFO -> SeekerClawColors.LogInfo
                            LogLevel.WARN -> SeekerClawColors.Warning
                            LogLevel.ERROR -> SeekerClawColors.Error
                        }
                        val pattern = if (android.text.format.DateFormat.is24HourFormat(context)) "HH:mm:ss" else "hh:mm:ss a"
                        val timeStr = android.text.format.DateFormat.format(pattern, Date(entry.timestamp))
                        Text(
                            text = "[$timeStr] ${entry.message}",
                            color = color,
                            fontSize = 12.sp,
                            fontFamily = FontFamily.Monospace,
                            lineHeight = 18.sp,
                            modifier = Modifier.padding(vertical = 1.dp),
                        )
                    }
                }
            }
        }

        Spacer(modifier = Modifier.height(12.dp))

        // Auto-scroll toggle
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "Auto-scroll",
                fontFamily = FontFamily.Default,
                fontSize = 14.sp,
                color = SeekerClawColors.TextSecondary,
            )
            Switch(
                checked = autoScroll,
                onCheckedChange = { autoScroll = it },
                colors = SwitchDefaults.colors(
                    checkedThumbColor = Color.White,
                    checkedTrackColor = SeekerClawColors.Primary,
                    uncheckedThumbColor = Color.White,
                    uncheckedTrackColor = Color(0xFF374151),
                    uncheckedBorderColor = Color.Transparent,
                ),
            )
        }

        Spacer(modifier = Modifier.height(8.dp))

        // Log level filters
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            FilterChip(
                label = "Info",
                active = showInfo,
                activeColor = SeekerClawColors.LogInfo,
                shape = shape,
                modifier = Modifier.weight(1f),
                onClick = { showInfo = !showInfo },
            )
            FilterChip(
                label = "Warn",
                active = showWarn,
                activeColor = SeekerClawColors.Warning,
                shape = shape,
                modifier = Modifier.weight(1f),
                onClick = { showWarn = !showWarn },
            )
            FilterChip(
                label = "Error",
                active = showError,
                activeColor = SeekerClawColors.Error,
                shape = shape,
                modifier = Modifier.weight(1f),
                onClick = { showError = !showError },
            )
        }
    }

    if (showClearDialog) {
        AlertDialog(
            onDismissRequest = { showClearDialog = false },
            title = {
                Text(
                    "Clear Logs",
                    fontFamily = FontFamily.Default,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.TextPrimary,
                )
            },
            text = {
                Text(
                    "This will delete all log entries. This cannot be undone.",
                    fontFamily = FontFamily.Default,
                    fontSize = 13.sp,
                    color = SeekerClawColors.TextSecondary,
                    lineHeight = 20.sp,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    LogCollector.clear()
                    showClearDialog = false
                }) {
                    Text(
                        "Clear",
                        fontFamily = FontFamily.Default,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showClearDialog = false }) {
                    Text(
                        "Cancel",
                        fontFamily = FontFamily.Default,
                        color = SeekerClawColors.TextDim,
                    )
                }
            },
            containerColor = SeekerClawColors.Surface,
            shape = shape,
        )
    }
}

@Composable
private fun FilterChip(
    label: String,
    active: Boolean,
    activeColor: Color,
    shape: RoundedCornerShape,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Button(
        onClick = onClick,
        modifier = modifier,
        shape = shape,
        colors = ButtonDefaults.buttonColors(
            containerColor = if (active) activeColor.copy(alpha = 0.2f) else Color(0xFF1A1A1A),
            contentColor = if (active) activeColor else SeekerClawColors.TextDim,
        ),
    ) {
        Text(label, fontFamily = FontFamily.Default, fontSize = 12.sp)
    }
}
