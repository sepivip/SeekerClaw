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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
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
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import com.seekerclaw.app.ui.theme.SeekerClawColors
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
import java.util.Date

@Composable
fun LogsScreen() {
    val context = LocalContext.current
    val haptic = LocalHapticFeedback.current
    val logs by LogCollector.logs.collectAsState()
    val listState = rememberLazyListState()
    var autoScroll by remember { mutableStateOf(true) }

    var showClearDialog by remember { mutableStateOf(false) }
    var searchQuery by remember { mutableStateOf("") }

    // Filter toggles — all enabled by default
    var showInfo by remember { mutableStateOf(true) }
    var showWarn by remember { mutableStateOf(true) }
    var showError by remember { mutableStateOf(true) }

    val filteredLogs = remember(logs, showInfo, showWarn, showError, searchQuery) {
        logs.filter { entry ->
            val levelMatch = when (entry.level) {
                LogLevel.INFO -> showInfo
                LogLevel.WARN -> showWarn
                LogLevel.ERROR -> showError
            }
            val searchMatch = searchQuery.isBlank() ||
                entry.message.contains(searchQuery, ignoreCase = true)
            levelMatch && searchMatch
        }
    }

    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)
    val timePattern = if (android.text.format.DateFormat.is24HourFormat(context)) "HH:mm:ss" else "hh:mm:ss a"

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
                            val timeStr = android.text.format.DateFormat.format(timePattern, Date(entry.timestamp))
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
                TextButton(onClick = { showClearDialog = true }) {
                    Icon(
                        Icons.Default.Delete,
                        contentDescription = "Clear logs",
                        tint = SeekerClawColors.TextDim,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(modifier = Modifier.width(4.dp))
                    Text(
                        text = "Clear",
                        fontFamily = FontFamily.Default,
                        fontSize = 13.sp,
                        color = SeekerClawColors.TextDim,
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

        Spacer(modifier = Modifier.height(12.dp))

        // Search bar
        OutlinedTextField(
            value = searchQuery,
            onValueChange = { searchQuery = it },
            placeholder = {
                Text(
                    "Search logs\u2026",
                    fontFamily = FontFamily.Monospace,
                    fontSize = 13.sp,
                )
            },
            leadingIcon = {
                Icon(
                    Icons.Default.Search,
                    contentDescription = "Search",
                    tint = SeekerClawColors.TextDim,
                    modifier = Modifier.size(18.dp),
                )
            },
            trailingIcon = {
                if (searchQuery.isNotEmpty()) {
                    IconButton(onClick = { searchQuery = "" }) {
                        Icon(
                            Icons.Default.Close,
                            contentDescription = "Clear search",
                            tint = SeekerClawColors.TextDim,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                }
            },
            singleLine = true,
            textStyle = androidx.compose.ui.text.TextStyle(
                fontFamily = FontFamily.Monospace,
                fontSize = 13.sp,
                color = SeekerClawColors.TextPrimary,
            ),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = SeekerClawColors.Primary,
                unfocusedBorderColor = SeekerClawColors.TextDim.copy(alpha = 0.3f),
                cursorColor = SeekerClawColors.Primary,
            ),
            shape = shape,
            modifier = Modifier.fillMaxWidth(),
        )

        Spacer(modifier = Modifier.height(12.dp))

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
                    itemsIndexed(
                        filteredLogs,
                        key = { index, _ -> index },
                    ) { index, entry ->
                        val color = when (entry.level) {
                            LogLevel.INFO -> SeekerClawColors.LogInfo
                            LogLevel.WARN -> SeekerClawColors.Warning
                            LogLevel.ERROR -> SeekerClawColors.Error
                        }
                        val timeStr = android.text.format.DateFormat.format(timePattern, Date(entry.timestamp))
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
                onCheckedChange = {
                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                    autoScroll = it
                },
                colors = SwitchDefaults.colors(
                    checkedThumbColor = Color.White,
                    checkedTrackColor = SeekerClawColors.Primary,
                    uncheckedThumbColor = Color.White,
                    uncheckedTrackColor = SeekerClawColors.BorderSubtle,
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
                onClick = {
                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                    showInfo = !showInfo
                },
            )
            FilterChip(
                label = "Warn",
                active = showWarn,
                activeColor = SeekerClawColors.Warning,
                shape = shape,
                modifier = Modifier.weight(1f),
                onClick = {
                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                    showWarn = !showWarn
                },
            )
            FilterChip(
                label = "Error",
                active = showError,
                activeColor = SeekerClawColors.Error,
                shape = shape,
                modifier = Modifier.weight(1f),
                onClick = {
                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                    showError = !showError
                },
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
            containerColor = if (active) activeColor.copy(alpha = 0.2f) else SeekerClawColors.Surface,
            contentColor = if (active) activeColor else SeekerClawColors.TextDim,
        ),
    ) {
        Text(label, fontFamily = FontFamily.Default, fontSize = 12.sp)
    }
}
