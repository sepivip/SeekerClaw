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
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import com.seekerclaw.app.ui.theme.SeekerClawColors
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun LogsScreen() {
    val logs by LogCollector.logs.collectAsState()
    val listState = rememberLazyListState()
    var autoScroll by remember { mutableStateOf(true) }

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
        // Header — icon + title + trash button
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
            IconButton(onClick = { LogCollector.clear() }) {
                Icon(
                    Icons.Default.Delete,
                    contentDescription = "Clear logs",
                    tint = SeekerClawColors.TextDim,
                )
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
                            text = "Awaiting output...",
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
                        val timeFormat = remember { SimpleDateFormat("HH:mm:ss", Locale.US) }
                        Text(
                            text = "[${timeFormat.format(Date(entry.timestamp))}] ${entry.message}",
                            color = color,
                            fontSize = 11.sp,
                            fontFamily = FontFamily.Monospace,
                            lineHeight = 16.sp,
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
