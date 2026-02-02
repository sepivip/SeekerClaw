package com.seekerclaw.app.ui.dashboard

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.service.OpenClawService
import com.seekerclaw.app.ui.theme.SeekerClawColors
import com.seekerclaw.app.util.ServiceState
import com.seekerclaw.app.util.ServiceStatus
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun DashboardScreen() {
    val context = LocalContext.current
    val status by ServiceState.status.collectAsState()
    val uptime by ServiceState.uptime.collectAsState()
    val messageCount by ServiceState.messageCount.collectAsState()
    val messagesToday by ServiceState.messagesToday.collectAsState()
    val lastActivityTime by ServiceState.lastActivityTime.collectAsState()

    val config = ConfigManager.loadConfig(context)
    val agentName = config?.agentName ?: "MyAgent"

    val statusColor = when (status) {
        ServiceStatus.RUNNING -> SeekerClawColors.Primary
        ServiceStatus.STARTING -> SeekerClawColors.Warning
        ServiceStatus.STOPPED -> SeekerClawColors.Error
        ServiceStatus.ERROR -> SeekerClawColors.Error
    }

    val statusText = when (status) {
        ServiceStatus.RUNNING -> "ONLINE"
        ServiceStatus.STARTING -> "BOOT"
        ServiceStatus.STOPPED -> "OFFLINE"
        ServiceStatus.ERROR -> "FAULT"
    }

    val statusLabel = when (status) {
        ServiceStatus.RUNNING -> "SYSTEM NOMINAL"
        ServiceStatus.STARTING -> "INITIALIZING..."
        ServiceStatus.STOPPED -> "SYSTEM HALTED"
        ServiceStatus.ERROR -> "SYSTEM ERROR"
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(SeekerClawColors.Background)
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // Header
        Text(
            text = "> ${agentName.uppercase()}",
            fontFamily = FontFamily.Monospace,
            fontSize = 18.sp,
            fontWeight = FontWeight.Bold,
            color = SeekerClawColors.Primary,
            letterSpacing = 2.sp,
        )
        Text(
            text = "================================",
            fontFamily = FontFamily.Monospace,
            fontSize = 14.sp,
            color = SeekerClawColors.PrimaryDim,
        )

        Spacer(modifier = Modifier.height(32.dp))

        // Status display — retro CRT box instead of a circle
        Box(
            modifier = Modifier
                .size(140.dp)
                .background(statusColor.copy(alpha = 0.08f), RoundedCornerShape(4.dp))
                .border(2.dp, statusColor, RoundedCornerShape(4.dp))
                .drawBehind {
                    // Inner border for double-line retro feel
                    drawRoundRect(
                        color = statusColor.copy(alpha = 0.3f),
                        cornerRadius = CornerRadius(2.dp.toPx()),
                        style = Stroke(width = 1.dp.toPx()),
                        size = size.copy(
                            width = size.width - 12.dp.toPx(),
                            height = size.height - 12.dp.toPx(),
                        ),
                        topLeft = androidx.compose.ui.geometry.Offset(6.dp.toPx(), 6.dp.toPx()),
                    )
                },
            contentAlignment = Alignment.Center,
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    text = statusText,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 22.sp,
                    fontWeight = FontWeight.Bold,
                    color = statusColor,
                    letterSpacing = 3.sp,
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = if (status == ServiceStatus.RUNNING) ">>>>>>>" else "- - - -",
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    color = statusColor.copy(alpha = 0.6f),
                )
            }
        }

        Spacer(modifier = Modifier.height(12.dp))

        Text(
            text = statusLabel,
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
            color = statusColor.copy(alpha = 0.7f),
            letterSpacing = 1.sp,
        )

        Spacer(modifier = Modifier.height(8.dp))

        Text(
            text = "UPTIME: ${formatUptime(uptime)}",
            fontFamily = FontFamily.Monospace,
            fontSize = 13.sp,
            color = SeekerClawColors.TextSecondary,
        )

        Spacer(modifier = Modifier.height(24.dp))

        // Start/Stop button
        val isRunning = status == ServiceStatus.RUNNING || status == ServiceStatus.STARTING
        val btnColor = if (isRunning) SeekerClawColors.Error else SeekerClawColors.Primary
        val btnGlow = if (isRunning) SeekerClawColors.ErrorGlow else SeekerClawColors.PrimaryGlow

        Button(
            onClick = {
                if (isRunning) {
                    OpenClawService.stop(context)
                } else {
                    OpenClawService.start(context)
                }
            },
            modifier = Modifier
                .fillMaxWidth()
                .height(48.dp)
                .border(1.dp, btnColor, RoundedCornerShape(2.dp)),
            shape = RoundedCornerShape(2.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = btnGlow,
                contentColor = btnColor,
            ),
        ) {
            Text(
                text = if (isRunning) "[ TERMINATE ]" else "[ DEPLOY AGENT ]",
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Bold,
                letterSpacing = 2.sp,
            )
        }

        Spacer(modifier = Modifier.height(32.dp))

        // Stats — retro terminal boxes
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceEvenly,
        ) {
            StatCard(label = "TODAY", value = "$messagesToday")
            StatCard(label = "TOTAL", value = "$messageCount")
            StatCard(label = "LAST", value = formatLastActivity(lastActivityTime))
        }
    }
}

@Composable
private fun StatCard(label: String, value: String) {
    Column(
        modifier = Modifier
            .width(100.dp)
            .background(SeekerClawColors.Surface, RoundedCornerShape(2.dp))
            .border(1.dp, SeekerClawColors.PrimaryDim.copy(alpha = 0.4f), RoundedCornerShape(2.dp))
            .padding(12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = value,
            fontFamily = FontFamily.Monospace,
            fontSize = 20.sp,
            fontWeight = FontWeight.Bold,
            color = SeekerClawColors.Primary,
            textAlign = TextAlign.Center,
        )
        Spacer(modifier = Modifier.height(4.dp))
        Text(
            text = label,
            fontFamily = FontFamily.Monospace,
            fontSize = 10.sp,
            color = SeekerClawColors.TextDim,
            textAlign = TextAlign.Center,
            letterSpacing = 1.sp,
        )
    }
}

private fun formatUptime(millis: Long): String {
    if (millis <= 0) return "00:00:00"
    val seconds = millis / 1000
    val minutes = seconds / 60
    val hours = minutes / 60
    val days = hours / 24
    return buildString {
        if (days > 0) append("${days}d ")
        append("%02d:%02d:%02d".format(hours % 24, minutes % 60, seconds % 60))
    }.trimEnd()
}

private fun formatLastActivity(timestamp: Long): String {
    if (timestamp <= 0L) return "--:--"
    val format = SimpleDateFormat("HH:mm", Locale.US)
    return format.format(Date(timestamp))
}
