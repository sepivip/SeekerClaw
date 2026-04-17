package com.seekerclaw.app.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.seekerclaw.app.config.EnvVar
import com.seekerclaw.app.config.EnvVarParser
import com.seekerclaw.app.config.ParseStatus
import com.seekerclaw.app.config.ParsedEnvEntry

@Composable
fun EnvVarPasteDialog(
    existingKeys: Set<String>,
    onDismiss: () -> Unit,
    onApply: (List<EnvVar>) -> Unit,
) {
    var text by remember { mutableStateOf("") }
    // Pair = (parsed entry, user's include-this-row decision)
    var parsed by remember { mutableStateOf<List<Pair<ParsedEnvEntry, Boolean>>>(emptyList()) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Paste .env file") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                OutlinedTextField(
                    value = text,
                    onValueChange = { newText ->
                        text = newText
                        // Live reparse: valid rows default to included; invalid rows disabled.
                        parsed = EnvVarParser.parse(newText)
                            .map { entry -> entry to (entry.status == ParseStatus.OK) }
                    },
                    label = { Text("KEY=VALUE per line") },
                    modifier = Modifier.fillMaxWidth().height(160.dp),
                    textStyle = TextStyle(fontFamily = FontFamily.Monospace),
                )

                Spacer(Modifier.height(12.dp))

                if (parsed.isNotEmpty()) {
                    val okCount = parsed.count { it.first.status == ParseStatus.OK }
                    val overwriteCount = parsed.count {
                        it.first.status == ParseStatus.OK && existingKeys.contains(it.first.name)
                    }
                    val invalidCount = parsed.count { it.first.status != ParseStatus.OK }

                    Text("$okCount valid  \u00b7  $overwriteCount will overwrite  \u00b7  $invalidCount invalid")
                    Spacer(Modifier.height(8.dp))

                    parsed.forEachIndexed { idx, (entry, included) ->
                        val statusLabel = when (entry.status) {
                            ParseStatus.OK -> if (existingKeys.contains(entry.name)) "overwrite" else "new"
                            ParseStatus.INVALID_NAME -> "invalid name"
                            ParseStatus.RESERVED -> "reserved"
                            ParseStatus.MALFORMED -> "malformed"
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(
                                checked = included && entry.status == ParseStatus.OK,
                                onCheckedChange = { checked ->
                                    parsed = parsed.toMutableList().also {
                                        it[idx] = entry to checked
                                    }
                                },
                                enabled = entry.status == ParseStatus.OK,
                            )
                            Column(Modifier.weight(1f)) {
                                Text(
                                    text = if (entry.name.isNotBlank()) entry.name else "(unnamed)",
                                    fontFamily = FontFamily.Monospace,
                                )
                                Text("\u00b7 $statusLabel")
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            val toApply = parsed
                .filter { it.first.status == ParseStatus.OK && it.second }
                .map { EnvVar(it.first.name, it.first.value) }
            Button(
                onClick = { onApply(toApply) },
                enabled = toApply.isNotEmpty(),
            ) { Text("Add ${toApply.size}") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}
