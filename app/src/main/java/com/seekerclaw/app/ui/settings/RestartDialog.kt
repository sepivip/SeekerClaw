package com.seekerclaw.app.ui.settings

import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.seekerclaw.app.service.OpenClawService
import com.seekerclaw.app.ui.theme.RethinkSans
import com.seekerclaw.app.ui.theme.SeekerClawColors

@Composable
fun RestartDialog(
    context: Context,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                "Config Updated",
                fontFamily = RethinkSans,
                fontWeight = FontWeight.Bold,
                color = SeekerClawColors.TextPrimary,
            )
        },
        text = {
            Text(
                "Restart the agent to apply changes?",
                fontFamily = RethinkSans,
                fontSize = 14.sp,
                color = SeekerClawColors.TextSecondary,
            )
        },
        confirmButton = {
            TextButton(onClick = {
                OpenClawService.restart(context)
                onDismiss()
                Toast.makeText(context, "Agent restarting\u2026", Toast.LENGTH_SHORT).show()
            }) {
                Text(
                    "Restart Now",
                    fontFamily = RethinkSans,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.Primary,
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(
                    "Later",
                    fontFamily = RethinkSans,
                    color = SeekerClawColors.TextDim,
                )
            }
        },
        containerColor = SeekerClawColors.Surface,
        shape = RoundedCornerShape(SeekerClawColors.CornerRadius),
    )
}
