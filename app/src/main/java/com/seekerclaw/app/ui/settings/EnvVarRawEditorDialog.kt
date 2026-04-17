package com.seekerclaw.app.ui.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.seekerclaw.app.config.EnvVar
import com.seekerclaw.app.config.EnvVarParser
import com.seekerclaw.app.config.ParseStatus
import com.seekerclaw.app.ui.theme.RethinkSans
import com.seekerclaw.app.ui.theme.SeekerClawColors

/**
 * Raw editor for bulk env var edits.
 *
 * Pre-fills with current env vars serialized as `KEY=VALUE` lines (alphabetical,
 * plaintext — same level of exposure as the per-row eye toggle in [EnvVarEditDialog]).
 * User edits freely. Live-parse previews the diff against the current list across
 * four buckets: ADDED, MODIFIED, REMOVED, INVALID. Save applies the full new list;
 * Cancel discards.
 *
 * Subsumes the older "Paste .env" dialog — bulk paste still works when the buffer
 * starts empty, but the same flow now handles rename / delete / edit-in-place.
 */
@Composable
fun EnvVarRawEditorDialog(
    currentVars: List<EnvVar>,
    onDismiss: () -> Unit,
    onApply: (List<EnvVar>) -> Unit,
) {
    val initialText = remember(currentVars) {
        currentVars.sortedBy { it.name }.joinToString("\n") { "${it.name}=${it.value}" }
    }
    // Key the editable buffer to currentVars too — if the parent ever opens the
    // dialog before its async load completes (the screen now blocks this, but
    // keep the guard), the buffer picks up the real content when the prop
    // updates. Once the user is actively editing, the parent closes the dialog
    // on save before configVersion-driven reloads fire, so we don't clobber edits.
    var text by remember(currentVars) { mutableStateOf(initialText) }

    // Parse + diff run synchronously on each `text` change. Kotlin regex over
    // realistic inputs (≤ 256 keys × a few hundred bytes each = ~100 KB of text)
    // completes in sub-ms and keeps the preview perfectly live. A pathological
    // 2 MB paste (theoretical max: 256 × 8 KB) might add a few ms of jank — if
    // that ever shows up in practice, debounce here with LaunchedEffect(text)
    // + Dispatchers.Default. Not worth the complexity for the typical case.
    val parsed = remember(text) { EnvVarParser.parse(text) }
    val currentByName = remember(currentVars) { currentVars.associateBy { it.name } }

    // Final list = valid parsed entries, last-wins on duplicate names.
    val finalList: List<EnvVar> = parsed
        .filter { it.status == ParseStatus.OK }
        .associateBy { it.name }
        .values
        .map { EnvVar(it.name, it.value) }
    val finalByName = finalList.associateBy { it.name }

    val added = finalList.filter { it.name !in currentByName }
    val removed = currentVars.filter { it.name !in finalByName }
    val modified = finalList.filter { v ->
        val curr = currentByName[v.name] ?: return@filter false
        curr.value != v.value
    }
    val invalid = parsed.filter { it.status != ParseStatus.OK }

    // ConfigManager.saveEnvVars silently caps at EnvVar.MAX_KEYS (256) after dedup.
    // Surface that limit here so users don't paste 500 entries, see "Save" enabled,
    // and discover after save that half were dropped.
    val overCap = finalList.size > EnvVar.MAX_KEYS
    val overCapBy = if (overCap) finalList.size - EnvVar.MAX_KEYS else 0

    val hasChanges = added.isNotEmpty() || removed.isNotEmpty() || modified.isNotEmpty()
    val canSave = invalid.isEmpty() && hasChanges && !overCap

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                text = "Raw editor",
                fontFamily = RethinkSans,
                fontWeight = FontWeight.Bold,
                color = SeekerClawColors.TextPrimary,
            )
        },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    modifier = Modifier.fillMaxWidth().height(240.dp),
                    textStyle = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 12.sp),
                    label = {
                        Text(
                            text = "KEY=VALUE per line",
                            fontFamily = RethinkSans,
                            fontSize = 12.sp,
                        )
                    },
                )

                Spacer(Modifier.height(12.dp))

                when {
                    text.isBlank() && currentVars.isEmpty() -> {
                        Text(
                            text = "Type or paste KEY=VALUE lines to create vars.",
                            fontFamily = RethinkSans,
                            fontSize = 12.sp,
                            color = SeekerClawColors.TextDim,
                        )
                    }
                    !hasChanges && invalid.isEmpty() -> {
                        Text(
                            text = "No changes.",
                            fontFamily = RethinkSans,
                            fontSize = 12.sp,
                            color = SeekerClawColors.TextDim,
                        )
                    }
                    else -> {
                        val summary = buildList {
                            if (added.isNotEmpty()) add("+${added.size} add")
                            if (modified.isNotEmpty()) add("~${modified.size} modify")
                            if (removed.isNotEmpty()) add("-${removed.size} remove")
                            if (invalid.isNotEmpty()) add("${invalid.size} invalid")
                        }.joinToString("  \u00b7  ")
                        Text(
                            text = summary,
                            fontFamily = RethinkSans,
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Medium,
                            color = SeekerClawColors.TextSecondary,
                        )
                        if (overCap) {
                            Spacer(Modifier.height(4.dp))
                            Text(
                                text = "Exceeds ${EnvVar.MAX_KEYS}-key limit by $overCapBy. " +
                                    "Remove $overCapBy row${if (overCapBy == 1) "" else "s"} to enable save.",
                                fontFamily = RethinkSans,
                                fontSize = 12.sp,
                                color = SeekerClawColors.Error,
                            )
                        }
                        Spacer(Modifier.height(8.dp))

                        if (added.isNotEmpty()) {
                            DiffSection(
                                title = "Added",
                                lines = added.map { "+ ${it.name}" },
                                accent = SeekerClawColors.Primary,
                            )
                        }
                        if (modified.isNotEmpty()) {
                            DiffSection(
                                title = "Modified",
                                lines = modified.map { "~ ${it.name}" },
                                accent = SeekerClawColors.Warning,
                            )
                        }
                        if (removed.isNotEmpty()) {
                            DiffSection(
                                title = "Removed",
                                lines = removed.map { "- ${it.name}" },
                                accent = SeekerClawColors.Error,
                            )
                        }
                        if (invalid.isNotEmpty()) {
                            DiffSection(
                                title = "Invalid (blocks save)",
                                lines = invalid.map { entry ->
                                    val reason = when (entry.status) {
                                        ParseStatus.INVALID_NAME -> "invalid name"
                                        ParseStatus.RESERVED -> "reserved"
                                        ParseStatus.MALFORMED -> "malformed"
                                        ParseStatus.VALUE_TOO_LARGE -> "value > 8 KB"
                                        ParseStatus.VALUE_HAS_NEWLINE -> "value contains newline"
                                        ParseStatus.OK -> ""
                                    }
                                    val name = entry.name.ifBlank { "(unnamed)" }
                                    "! $name \u00b7 $reason"
                                },
                                accent = SeekerClawColors.Error,
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            Button(
                onClick = { onApply(finalList) },
                enabled = canSave,
            ) {
                Text(
                    text = if (hasChanges) "Save changes" else "Save",
                    fontFamily = RethinkSans,
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(
                    text = "Cancel",
                    fontFamily = RethinkSans,
                    color = SeekerClawColors.TextDim,
                )
            }
        },
        containerColor = SeekerClawColors.Surface,
    )
}

@Composable
private fun DiffSection(
    title: String,
    lines: List<String>,
    accent: Color,
) {
    Column(Modifier.padding(top = 4.dp)) {
        Text(
            text = title,
            fontFamily = RethinkSans,
            fontSize = 10.sp,
            fontWeight = FontWeight.Medium,
            color = accent,
        )
        for (line in lines) {
            Text(
                text = line,
                fontFamily = FontFamily.Monospace,
                fontSize = 11.sp,
                color = SeekerClawColors.TextSecondary,
            )
        }
    }
}
