package com.seekerclaw.app.ui.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.seekerclaw.app.ui.theme.RethinkSans
import com.seekerclaw.app.ui.theme.SeekerClawColors


@Composable
fun ProviderEditDialog(
    editField: String?,
    editLabel: String,
    editValue: String,
    onValueChange: (String) -> Unit,
    onSave: () -> Unit,
    onDismiss: () -> Unit
) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                "Edit $editLabel",
                fontFamily = RethinkSans,
                fontWeight = FontWeight.Bold,
                color = SeekerClawColors.TextPrimary,
            )
        },
        text = {
            Column {
                if (editField == "anthropicApiKey" || editField == "setupToken" || editField == "telegramBotToken") {
                    Text(
                        "Changing this requires an agent restart.",
                        fontFamily = RethinkSans,
                        fontSize = 12.sp,
                        color = SeekerClawColors.Warning,
                        modifier = Modifier.padding(bottom = 12.dp),
                    )
                }
                OutlinedTextField(
                    value = editValue,
                    onValueChange = onValueChange,
                    label = { Text(editLabel, fontFamily = RethinkSans, fontSize = 12.sp) },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = editField != "anthropicApiKey" && editField != "setupToken",
                    textStyle = androidx.compose.ui.text.TextStyle(
                        fontFamily = FontFamily.Monospace,
                        fontSize = 14.sp,
                        color = SeekerClawColors.TextPrimary,
                    ),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = SeekerClawColors.Primary,
                        unfocusedBorderColor = SeekerClawColors.TextDim.copy(alpha = 0.3f),
                        cursorColor = SeekerClawColors.Primary,
                        focusedTextColor = SeekerClawColors.TextPrimary,
                        unfocusedTextColor = SeekerClawColors.TextPrimary
                    ),
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = onSave,
            ) {
                Text(
                    "Save",
                    fontFamily = RethinkSans,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.ActionPrimary,
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(
                    "Cancel",
                    fontFamily = RethinkSans,
                    color = SeekerClawColors.TextDim,
                )
            }
        },
        containerColor = SeekerClawColors.Surface,
        shape = shape,
    )
}
