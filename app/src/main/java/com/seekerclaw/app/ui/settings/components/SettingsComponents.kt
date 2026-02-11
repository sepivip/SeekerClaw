package com.seekerclaw.app.ui.settings.components

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.ManagedActivityResultLauncher
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
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
import androidx.core.app.ActivityCompat
import com.seekerclaw.app.ui.theme.SeekerClawColors

/**
 * Section label - small caps label for grouping settings
 */
@Composable
fun SectionLabel(title: String) {
    Text(
        text = title,
        fontFamily = FontFamily.Default,
        fontSize = 11.sp,
        fontWeight = FontWeight.Medium,
        color = SeekerClawColors.TextDim,
        letterSpacing = 1.sp,
    )
}

/**
 * Config field - displays a config value with optional edit action and info dialog
 */
@Composable
fun ConfigField(
    label: String,
    value: String,
    onClick: (() -> Unit)? = null,
    showDivider: Boolean = true,
    info: String? = null,
) {
    var showInfo by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 16.dp, vertical = 14.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = label,
                    fontFamily = FontFamily.Default,
                    fontSize = 12.sp,
                    color = SeekerClawColors.TextDim,
                )
                if (info != null) {
                    IconButton(
                        onClick = { showInfo = true },
                        modifier = Modifier.size(20.dp),
                    ) {
                        Icon(
                            Icons.Outlined.Info,
                            contentDescription = "More info about $label",
                            tint = SeekerClawColors.TextDim,
                            modifier = Modifier.size(14.dp),
                        )
                    }
                }
            }
            if (onClick != null) {
                Text(
                    text = "Edit",
                    fontFamily = FontFamily.Default,
                    fontSize = 12.sp,
                    color = SeekerClawColors.Primary,
                )
            }
        }
        Spacer(modifier = Modifier.height(2.dp))
        Text(
            text = value,
            fontFamily = FontFamily.Default,
            fontSize = 14.sp,
            color = SeekerClawColors.TextPrimary,
        )
    }
    if (showDivider) {
        androidx.compose.material3.HorizontalDivider(
            color = SeekerClawColors.TextDim.copy(alpha = 0.1f),
            modifier = Modifier.padding(horizontal = 16.dp),
        )
    }

    if (showInfo && info != null) {
        InfoDialog(title = label, message = info, onDismiss = { showInfo = false })
    }
}

/**
 * Setting row - toggle switch with label and optional info
 */
@Composable
fun SettingRow(
    label: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    info: String? = null,
) {
    var showInfo by remember { mutableStateOf(false) }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = label,
                fontFamily = FontFamily.Default,
                fontSize = 14.sp,
                color = SeekerClawColors.TextPrimary,
            )
            if (info != null) {
                IconButton(
                    onClick = { showInfo = true },
                    modifier = Modifier.size(20.dp),
                ) {
                    Icon(
                        Icons.Outlined.Info,
                        contentDescription = "More info about $label",
                        tint = SeekerClawColors.TextDim,
                        modifier = Modifier.size(14.dp),
                    )
                }
            }
        }
        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
            colors = SwitchDefaults.colors(
                checkedThumbColor = Color.White,
                checkedTrackColor = Color(0xFF10B981),
                uncheckedThumbColor = Color.White,
                uncheckedTrackColor = Color(0xFF374151),
                uncheckedBorderColor = Color.Transparent,
            ),
        )
    }

    if (showInfo && info != null) {
        InfoDialog(title = label, message = info, onDismiss = { showInfo = false })
    }
}

/**
 * Info row - simple label-value pair
 */
@Composable
fun InfoRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            text = label,
            fontFamily = FontFamily.Default,
            fontSize = 13.sp,
            color = SeekerClawColors.TextDim,
        )
        Text(
            text = value,
            fontFamily = FontFamily.Default,
            fontSize = 13.sp,
            color = SeekerClawColors.TextSecondary,
        )
    }
}

/**
 * Permission row - toggle switch for permissions with smart request/settings flow
 */
@Composable
fun PermissionRow(
    label: String,
    granted: Boolean,
    onRequest: () -> Unit,
    info: String? = null,
) {
    var showInfo by remember { mutableStateOf(false) }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = label,
                fontFamily = FontFamily.Default,
                fontSize = 14.sp,
                color = SeekerClawColors.TextPrimary,
            )
            if (info != null) {
                IconButton(
                    onClick = { showInfo = true },
                    modifier = Modifier.size(20.dp),
                ) {
                    Icon(
                        Icons.Outlined.Info,
                        contentDescription = "More info about $label",
                        tint = SeekerClawColors.TextDim,
                        modifier = Modifier.size(14.dp),
                    )
                }
            }
        }
        Switch(
            checked = granted,
            onCheckedChange = { if (!granted) onRequest() },
            colors = SwitchDefaults.colors(
                checkedThumbColor = Color.White,
                checkedTrackColor = Color(0xFF10B981),
                uncheckedThumbColor = Color.White,
                uncheckedTrackColor = Color(0xFF374151),
                uncheckedBorderColor = Color.Transparent,
            ),
        )
    }

    if (showInfo && info != null) {
        InfoDialog(title = label, message = info, onDismiss = { showInfo = false })
    }
}

/**
 * Helper function to request permission or open settings if already denied
 */
fun requestPermissionOrOpenSettings(
    context: Context,
    permission: String,
    launcher: ManagedActivityResultLauncher<String, Boolean>,
) {
    val activity = context as? Activity ?: return
    if (ActivityCompat.shouldShowRequestPermissionRationale(activity, permission)) {
        launcher.launch(permission)
    } else {
        val prefs = context.getSharedPreferences("seekerclaw_prefs", Context.MODE_PRIVATE)
        val askedKey = "permission_asked_$permission"
        if (prefs.getBoolean(askedKey, false)) {
            val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:${context.packageName}")
            }
            context.startActivity(intent)
        } else {
            prefs.edit().putBoolean(askedKey, true).apply()
            launcher.launch(permission)
        }
    }
}

/**
 * Info dialog - simple informational alert
 */
@Composable
fun InfoDialog(title: String, message: String, onDismiss: () -> Unit) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)
    AlertDialog(
        onDismissRequest = onDismiss,
        shape = shape,
        containerColor = SeekerClawColors.Surface,
        title = {
            Text(
                text = title,
                fontFamily = FontFamily.Default,
                fontWeight = FontWeight.Bold,
                fontSize = 16.sp,
                color = SeekerClawColors.TextPrimary,
            )
        },
        text = {
            Text(
                text = message,
                fontFamily = FontFamily.Default,
                fontSize = 13.sp,
                color = SeekerClawColors.TextSecondary,
                lineHeight = 20.sp,
            )
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text(
                    "Got it",
                    fontFamily = FontFamily.Default,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.Primary,
                )
            }
        },
    )
}
