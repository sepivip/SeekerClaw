package com.seekerclaw.app.ui.settings

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import com.seekerclaw.app.config.EnvVar

/**
 * Add / Edit dialog for a single [EnvVar].
 *
 * This is a stub — it compiles and immediately dismisses so the screen navigation
 * works end-to-end. Task 12 will replace this body with full validation,
 * visibility toggle, and duplicate-key guard.
 */
@Composable
fun EnvVarEditDialog(
    state: EnvVarDialogState,
    existingKeys: Set<String>,
    onDismiss: () -> Unit,
    onSave: (EnvVar) -> Unit,
) {
    // TODO Task 12: full dialog with validation, paste-visibility toggle, duplicate-key guard.
    // Auto-dismiss to avoid showing an empty dialog.
    LaunchedEffect(state) { onDismiss() }
}
