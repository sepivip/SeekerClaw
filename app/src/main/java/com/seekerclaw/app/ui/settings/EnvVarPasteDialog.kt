package com.seekerclaw.app.ui.settings

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import com.seekerclaw.app.config.EnvVar

/**
 * Paste a `.env` file blob and bulk-import vars.
 *
 * Stub — auto-dismisses so navigation compiles. Task 13 will add the text
 * area input, live [EnvVarParser] preview, and apply logic.
 */
@Composable
fun EnvVarPasteDialog(
    existingKeys: Set<String>,
    onDismiss: () -> Unit,
    onApply: (List<EnvVar>) -> Unit,
) {
    // TODO Task 13: paste dialog with live parser preview.
    LaunchedEffect(Unit) { onDismiss() }
}
