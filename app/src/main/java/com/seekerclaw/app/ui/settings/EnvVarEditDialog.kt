package com.seekerclaw.app.ui.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.seekerclaw.app.config.EnvVar
import java.util.Locale

@Composable
fun EnvVarEditDialog(
    state: EnvVarDialogState,
    existingKeys: Set<String>,
    onDismiss: () -> Unit,
    onSave: (EnvVar) -> Unit,
) {
    if (state !is EnvVarDialogState.Add && state !is EnvVarDialogState.Edit) return

    val isEdit = state is EnvVarDialogState.Edit
    val initialName = when (state) {
        is EnvVarDialogState.Edit -> state.existing.name
        is EnvVarDialogState.Add -> state.prefillName
        else -> ""
    }
    val initialValue = if (state is EnvVarDialogState.Edit) state.existing.value else ""

    var name by remember { mutableStateOf(initialName) }
    var value by remember { mutableStateOf(initialValue) }
    var showValue by remember { mutableStateOf(false) }

    // Locale.ROOT avoids locale-specific uppercasing (e.g. Turkish `i` → `İ` would
    // fail the ASCII-only POSIX name regex).
    val normalizedName = name.uppercase(Locale.ROOT).trim()
    val nameError: String? = when {
        name.isEmpty() -> null // silent while empty; Save button stays disabled
        !isEdit && existingKeys.contains(normalizedName) -> "Key already exists — edit instead"
        else -> EnvVar.validateName(normalizedName)
    }
    val valueError: String? = EnvVar.validateValue(value)
    // Empty values are allowed everywhere else (paste dialog's `FOO=` → OK,
    // ConfigManager.saveEnvVars permits empty strings) — keep the Add dialog
    // consistent. Some users use empty values as explicit "disabled" flags.
    val canSave = name.isNotEmpty() && nameError == null && valueError == null

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (isEdit) "Edit env var" else "Add env var") },
        text = {
            Column {
                OutlinedTextField(
                    value = name,
                    onValueChange = { input -> name = input.uppercase(Locale.ROOT) },
                    label = { Text("KEY") },
                    enabled = !isEdit,
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                    isError = nameError != null,
                    supportingText = {
                        Text(nameError ?: "UPPERCASE letters, digits, underscores")
                    },
                )
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = value,
                    onValueChange = { value = it },
                    label = { Text("VALUE") },
                    visualTransformation = if (showValue) VisualTransformation.None else PasswordVisualTransformation(),
                    trailingIcon = {
                        IconButton(onClick = { showValue = !showValue }) {
                            Icon(
                                imageVector = if (showValue) Icons.Default.VisibilityOff else Icons.Default.Visibility,
                                contentDescription = if (showValue) "Hide value" else "Reveal value",
                            )
                        }
                    },
                    singleLine = false,
                    maxLines = 4,
                    modifier = Modifier.fillMaxWidth(),
                    isError = valueError != null,
                    supportingText = { valueError?.let { Text(it) } },
                )
            }
        },
        confirmButton = {
            Button(
                onClick = { onSave(EnvVar(normalizedName, value)) },
                enabled = canSave,
            ) { Text("Save") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}
