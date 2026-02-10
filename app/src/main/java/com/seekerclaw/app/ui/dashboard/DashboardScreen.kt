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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.config.modelDisplayName
import com.seekerclaw.app.service.OpenClawService
import com.seekerclaw.app.ui.theme.SeekerClawColors
import com.seekerclaw.app.util.ServiceState
import com.seekerclaw.app.util.ServiceStatus
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun DashboardScreen(onNavigateToSystem: () -> Unit = {}) {
    val context = LocalContext.current
    val status by ServiceState.status.collectAsState()
    val uptime by ServiceState.uptime.collectAsState()
    val messageCount by ServiceState.messageCount.collectAsState()
    val messagesToday by ServiceState.messagesToday.collectAsState()
    val lastActivityTime by ServiceState.lastActivityTime.collectAsState()

    val config = ConfigManager.loadConfig(context)
    val agentName = config?.agentName ?: "SeekerClaw"

    val isRunning = status == ServiceStatus.RUNNING || status == ServiceStatus.STARTING

    val statusColor = when (status) {
        ServiceStatus.RUNNING -> SeekerClawColors.Accent
        ServiceStatus.STARTING -> SeekerClawColors.Warning
        ServiceStatus.STOPPED -> SeekerClawColors.TextDim
        ServiceStatus.ERROR -> SeekerClawColors.Error
    }

    val statusText = when (status) {
        ServiceStatus.RUNNING -> "Online"
        ServiceStatus.STARTING -> "Starting..."
        ServiceStatus.STOPPED -> "Offline"
        ServiceStatus.ERROR -> "Error"
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
            text = agentName,
            fontFamily = FontFamily.Default,
            fontSize = 14.sp,
            color = SeekerClawColors.TextDim,
        )

        Spacer(modifier = Modifier.height(24.dp))

        // Status card (tappable → System screen)
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(SeekerClawColors.Surface, shape)
                .clickable { onNavigateToSystem() }
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
                    text = "System >",
                    fontFamily = FontFamily.Default,
                    fontSize = 12.sp,
                    color = SeekerClawColors.TextDim,
                )
            }

            Spacer(modifier = Modifier.height(20.dp))

            HorizontalDivider(
                color = SeekerClawColors.TextDim.copy(alpha = 0.2f),
                thickness = 1.dp,
            )

            Spacer(modifier = Modifier.height(20.dp))

            Text(
                text = "UPTIME",
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
                StatMini(label = "LAST", value = formatLastActivity(lastActivityTime))
            }
        }

        Spacer(modifier = Modifier.height(28.dp))

        // Uplinks
        Text(
            text = "UPLINKS",
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
            UplinkCard(
                icon = "//TG",
                name = "Telegram",
                subtitle = "Message relay",
                serviceStatus = status,
                shape = shape,
            )
            UplinkCard(
                icon = "//GW",
                name = "Gateway",
                subtitle = "OpenClaw engine",
                serviceStatus = status,
                shape = shape,
            )
            UplinkCard(
                icon = "//AI",
                name = "AI Model",
                subtitle = modelDisplayName(config?.model),
                serviceStatus = status,
                shape = shape,
            )
        }

        Spacer(modifier = Modifier.height(28.dp))

        // Action button
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
private fun StatMini(label: String, value: String) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(
            text = value,
            fontFamily = FontFamily.Monospace,
            fontSize = 20.sp,
            fontWeight = FontWeight.Bold,
            color = SeekerClawColors.TextPrimary,
        )
        Spacer(modifier = Modifier.height(2.dp))
        Text(
            text = label,
            fontFamily = FontFamily.Default,
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
    serviceStatus: ServiceStatus,
    shape: RoundedCornerShape,
) {
    val dotColor = when (serviceStatus) {
        ServiceStatus.RUNNING -> SeekerClawColors.Primary
        ServiceStatus.STARTING -> SeekerClawColors.Warning
        ServiceStatus.STOPPED -> SeekerClawColors.TextDim
        ServiceStatus.ERROR -> SeekerClawColors.Error
    }

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

private fun formatLastActivity(timestamp: Long): String {
    if (timestamp <= 0L) return "--:--"
    val format = SimpleDateFormat("HH:mm", Locale.US)
    return format.format(Date(timestamp))
}

