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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.service.OpenClawService
import com.seekerclaw.app.ui.theme.SeekerClawColors
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
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
    val logs by LogCollector.logs.collectAsState()

    val config = ConfigManager.loadConfig(context)
    val agentName = config?.agentName ?: "MyAgent"

    val isRunning = status == ServiceStatus.RUNNING || status == ServiceStatus.STARTING

    val statusColor = when (status) {
        ServiceStatus.RUNNING -> SeekerClawColors.Accent
        ServiceStatus.STARTING -> SeekerClawColors.Warning
        ServiceStatus.STOPPED -> SeekerClawColors.TextDim
        ServiceStatus.ERROR -> SeekerClawColors.Error
    }

    val statusText = when (status) {
        ServiceStatus.RUNNING -> "SYSTEM NOMINAL"
        ServiceStatus.STARTING -> "INITIALIZING..."
        ServiceStatus.STOPPED -> "SYSTEM OFFLINE"
        ServiceStatus.ERROR -> "SYSTEM FAULT"
    }

    val statusBadge = when (status) {
        ServiceStatus.RUNNING -> "ONLINE"
        ServiceStatus.STARTING -> "BOOT"
        ServiceStatus.STOPPED -> "OFFLINE"
        ServiceStatus.ERROR -> "FAULT"
    }

    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(SeekerClawColors.Background)
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
    ) {
        // ═══ BRANDING HEADER ═══
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "SEEKER//CLAW",
                fontFamily = FontFamily.Monospace,
                fontSize = 18.sp,
                fontWeight = FontWeight.Bold,
                color = SeekerClawColors.Primary,
                letterSpacing = 2.sp,
            )
            Box(
                modifier = Modifier
                    .background(statusColor.copy(alpha = 0.15f), RoundedCornerShape(4.dp))
                    .border(1.dp, statusColor.copy(alpha = 0.5f), RoundedCornerShape(4.dp))
                    .padding(horizontal = 10.dp, vertical = 4.dp),
            ) {
                Text(
                    text = statusBadge,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    color = statusColor,
                    letterSpacing = 1.sp,
                )
            }
        }

        Spacer(modifier = Modifier.height(4.dp))

        Text(
            text = agentName.uppercase(),
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
            color = SeekerClawColors.TextDim,
            letterSpacing = 1.sp,
        )

        Spacer(modifier = Modifier.height(20.dp))

        // ═══ STATUS CARD ═══
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(SeekerClawColors.Surface, shape)
                .border(1.dp, SeekerClawColors.Primary.copy(alpha = 0.2f), shape)
                .padding(20.dp),
        ) {
            Column {
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
                        fontFamily = FontFamily.Monospace,
                        fontSize = 16.sp,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.TextPrimary,
                        letterSpacing = 1.sp,
                    )
                }

                Spacer(modifier = Modifier.height(16.dp))

                HorizontalDivider(
                    color = SeekerClawColors.Primary.copy(alpha = 0.1f),
                    thickness = 1.dp,
                )

                Spacer(modifier = Modifier.height(16.dp))

                Text(
                    text = "UPTIME",
                    fontFamily = FontFamily.Monospace,
                    fontSize = 10.sp,
                    color = SeekerClawColors.TextDim,
                    letterSpacing = 1.sp,
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = formatUptime(uptime),
                    fontFamily = FontFamily.Monospace,
                    fontSize = 22.sp,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.TextPrimary,
                    letterSpacing = 2.sp,
                )

                Spacer(modifier = Modifier.height(16.dp))

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    StatMini(label = "TODAY", value = "$messagesToday")
                    StatMini(label = "TOTAL", value = "$messageCount")
                    StatMini(label = "LAST", value = formatLastActivity(lastActivityTime))
                }
            }
        }

        Spacer(modifier = Modifier.height(24.dp))

        // ═══ ACTIVE UPLINKS ═══
        Text(
            text = "ACTIVE UPLINKS",
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            color = SeekerClawColors.Primary,
            letterSpacing = 1.sp,
        )

        Spacer(modifier = Modifier.height(12.dp))

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(SeekerClawColors.Surface, shape)
                .border(1.dp, SeekerClawColors.Primary.copy(alpha = 0.12f), shape),
        ) {
            UplinkRow(
                icon = "//TG",
                name = "Telegram Uplink",
                subtitle = "MSG RELAY",
                serviceStatus = status,
            )
            HorizontalDivider(
                color = SeekerClawColors.Primary.copy(alpha = 0.08f),
                modifier = Modifier.padding(horizontal = 16.dp),
            )
            UplinkRow(
                icon = "//GW",
                name = "Gateway",
                subtitle = "OPENCLAW ENGINE",
                serviceStatus = status,
            )
            HorizontalDivider(
                color = SeekerClawColors.Primary.copy(alpha = 0.08f),
                modifier = Modifier.padding(horizontal = 16.dp),
            )
            UplinkRow(
                icon = "//AI",
                name = "AI Model",
                subtitle = config?.model?.substringAfterLast("-")?.uppercase() ?: "---",
                serviceStatus = status,
            )
        }

        Spacer(modifier = Modifier.height(24.dp))

        // ═══ MINI TERMINAL ═══
        Text(
            text = "TERMINAL",
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            color = SeekerClawColors.Primary,
            letterSpacing = 1.sp,
        )

        Spacer(modifier = Modifier.height(12.dp))

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(100.dp)
                .background(SeekerClawColors.Background, shape)
                .border(1.dp, SeekerClawColors.Primary.copy(alpha = 0.08f), shape)
                .padding(12.dp),
        ) {
            if (logs.isEmpty()) {
                Text(
                    text = "$ awaiting output...",
                    fontFamily = FontFamily.Monospace,
                    fontSize = 11.sp,
                    color = SeekerClawColors.TextDim,
                )
            } else {
                Column {
                    logs.takeLast(4).forEach { entry ->
                        val color = when (entry.level) {
                            LogLevel.INFO -> SeekerClawColors.Accent.copy(alpha = 0.7f)
                            LogLevel.WARN -> SeekerClawColors.Warning
                            LogLevel.ERROR -> SeekerClawColors.Error
                        }
                        Text(
                            text = "$ ${entry.message}",
                            fontFamily = FontFamily.Monospace,
                            fontSize = 10.sp,
                            color = color,
                            maxLines = 1,
                            lineHeight = 14.sp,
                        )
                    }
                }
            }
        }

        Spacer(modifier = Modifier.height(24.dp))

        // ═══ ACTION BUTTON ═══
        val btnColor = if (isRunning) SeekerClawColors.Error else SeekerClawColors.Primary

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
                .height(52.dp),
            shape = shape,
            colors = ButtonDefaults.buttonColors(
                containerColor = btnColor,
                contentColor = Color.White,
            ),
        ) {
            Text(
                text = if (isRunning) "[ TERMINATE ]" else "[ DEPLOY AGENT ]",
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Bold,
                fontSize = 15.sp,
                letterSpacing = 2.sp,
            )
        }

        Spacer(modifier = Modifier.height(24.dp))
    }
}

@Composable
private fun StatMini(label: String, value: String) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(
            text = value,
            fontFamily = FontFamily.Monospace,
            fontSize = 16.sp,
            fontWeight = FontWeight.Bold,
            color = SeekerClawColors.TextPrimary,
        )
        Spacer(modifier = Modifier.height(2.dp))
        Text(
            text = label,
            fontFamily = FontFamily.Monospace,
            fontSize = 9.sp,
            color = SeekerClawColors.TextDim,
            letterSpacing = 1.sp,
        )
    }
}

@Composable
private fun UplinkRow(
    icon: String,
    name: String,
    subtitle: String,
    serviceStatus: ServiceStatus,
) {
    val dotColor = when (serviceStatus) {
        ServiceStatus.RUNNING -> SeekerClawColors.Accent
        ServiceStatus.STARTING -> SeekerClawColors.Warning
        ServiceStatus.STOPPED -> SeekerClawColors.TextDim
        ServiceStatus.ERROR -> SeekerClawColors.Error
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = icon,
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            color = SeekerClawColors.Primary,
            modifier = Modifier.width(40.dp),
        )

        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = name,
                fontFamily = FontFamily.Monospace,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                color = SeekerClawColors.TextPrimary,
            )
            Text(
                text = subtitle,
                fontFamily = FontFamily.Monospace,
                fontSize = 10.sp,
                color = SeekerClawColors.TextDim,
                letterSpacing = 1.sp,
            )
        }

        Box(
            modifier = Modifier
                .size(8.dp)
                .clip(CircleShape)
                .background(dotColor),
        )
    }
}

private fun formatUptime(millis: Long): String {
    if (millis <= 0) return "00H 00M 00S"
    val seconds = millis / 1000
    val minutes = seconds / 60
    val hours = minutes / 60
    val days = hours / 24
    return buildString {
        if (days > 0) append("${days}D ")
        append("%02dH %02dM %02dS".format(hours % 24, minutes % 60, seconds % 60))
    }.trimEnd()
}

private fun formatLastActivity(timestamp: Long): String {
    if (timestamp <= 0L) return "--:--"
    val format = SimpleDateFormat("HH:mm", Locale.US)
    return format.format(Date(timestamp))
}
