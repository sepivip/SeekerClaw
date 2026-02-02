package com.seekerclaw.app.ui.logs

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.VerticalAlignBottom
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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

    // Auto-scroll to bottom when new logs arrive
    LaunchedEffect(logs.size, autoScroll) {
        if (autoScroll && logs.isNotEmpty()) {
            listState.animateScrollToItem(logs.size - 1)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(SeekerClawColors.Background),
    ) {
        // Toolbar — terminal header bar
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(SeekerClawColors.Surface)
                .border(
                    width = 1.dp,
                    color = SeekerClawColors.PrimaryDim.copy(alpha = 0.3f),
                )
                .padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "> LOG [${logs.size}]",
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Bold,
                color = SeekerClawColors.Primary,
                fontSize = 14.sp,
                letterSpacing = 1.sp,
            )
            Row {
                IconButton(onClick = { autoScroll = !autoScroll }) {
                    Icon(
                        Icons.Default.VerticalAlignBottom,
                        contentDescription = "Auto-scroll",
                        tint = if (autoScroll) SeekerClawColors.Primary else SeekerClawColors.TextDim,
                    )
                }
                IconButton(onClick = { /* TODO: Share/export logs */ }) {
                    Icon(
                        Icons.Default.Share,
                        contentDescription = "Share",
                        tint = SeekerClawColors.TextDim,
                    )
                }
                IconButton(onClick = { LogCollector.clear() }) {
                    Icon(
                        Icons.Default.Delete,
                        contentDescription = "Clear",
                        tint = SeekerClawColors.Error.copy(alpha = 0.7f),
                    )
                }
            }
        }

        // Log entries
        if (logs.isEmpty()) {
            Box(
                modifier = Modifier.fillMaxSize(),
                contentAlignment = Alignment.Center,
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        text = "> _",
                        fontFamily = FontFamily.Monospace,
                        fontSize = 24.sp,
                        color = SeekerClawColors.PrimaryDim,
                    )
                    Text(
                        text = "AWAITING OUTPUT...",
                        fontFamily = FontFamily.Monospace,
                        fontSize = 12.sp,
                        color = SeekerClawColors.TextDim,
                        letterSpacing = 1.sp,
                    )
                }
            }
        } else {
            LazyColumn(
                state = listState,
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 8.dp, vertical = 4.dp),
            ) {
                items(logs) { entry ->
                    val color = when (entry.level) {
                        LogLevel.INFO -> SeekerClawColors.TextPrimary
                        LogLevel.WARN -> SeekerClawColors.Warning
                        LogLevel.ERROR -> SeekerClawColors.Error
                    }
                    val prefix = when (entry.level) {
                        LogLevel.INFO -> " "
                        LogLevel.WARN -> "!"
                        LogLevel.ERROR -> "X"
                    }
                    val timeFormat = remember { SimpleDateFormat("HH:mm:ss", Locale.US) }
                    Text(
                        text = "$prefix ${timeFormat.format(Date(entry.timestamp))} ${entry.message}",
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
}
