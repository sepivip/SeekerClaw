package com.seekerclaw.app.ui.settings.wallet.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.sp
import com.seekerclaw.app.ui.components.DangerButton
import com.seekerclaw.app.ui.components.DangerOutlineButton
import com.seekerclaw.app.ui.components.SectionLabel
import com.seekerclaw.app.ui.theme.RethinkSans
import com.seekerclaw.app.ui.theme.SeekerClawColors
import com.seekerclaw.app.ui.theme.Spacing

/**
 * DangerZoneSection — Wipe + Rotate buttons for the Burner Wallet
 * screen (BAT-582). Owns its own confirm dialogs so the parent screen
 * doesn't have to manage dialog state.
 *
 * **Critical UX**: the Wipe confirm dialog DISPLAYS the burner address
 * explicitly before erasure. This is the user's last chance to drain
 * the wallet via Phantom or another tool — once wiped, SeekerClaw
 * cannot recover the key. Per the BAT-582 contract: "Wipe confirm
 * dialog shows burner address explicitly".
 *
 * Rotate = wipe + immediately re-prompt for new key. The parent owns
 * the re-prompt UI; this component just signals via [onRotateClick].
 */
@Composable
fun DangerZoneSection(
    burnerAddress: String,
    onWipeClick: () -> Unit,
    onRotateClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    var showWipeDialog by remember { mutableStateOf(false) }
    var showRotateDialog by remember { mutableStateOf(false) }

    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(Spacing.md)) {
        SectionLabel("Danger zone")
        Spacer(Modifier.height(Spacing.sm))
        Text(
            text = "Wiping the burner is permanent. Drain any remaining funds first — SeekerClaw cannot recover the key.",
            fontFamily = RethinkSans,
            fontSize = 12.sp,
            color = SeekerClawColors.TextDim,
        )
        DangerOutlineButton(
            onClick = { showRotateDialog = true },
            label = "Rotate key",
            enabled = enabled,
        )
        DangerButton(
            onClick = { showWipeDialog = true },
            label = "Wipe burner",
            enabled = enabled,
        )
    }

    if (showWipeDialog) {
        WipeConfirmDialog(
            burnerAddress = burnerAddress,
            actionLabel = "Wipe",
            title = "Wipe burner?",
            body = "This permanently deletes the burner key from this device. Drain any remaining funds first — SeekerClaw cannot recover this key.",
            onConfirm = {
                showWipeDialog = false
                onWipeClick()
            },
            onDismiss = { showWipeDialog = false },
        )
    }

    if (showRotateDialog) {
        WipeConfirmDialog(
            burnerAddress = burnerAddress,
            actionLabel = "Rotate",
            title = "Rotate burner key?",
            body = "This wipes the current burner and prompts you to set up a new one. Drain any remaining funds first — the existing key cannot be recovered.",
            onConfirm = {
                showRotateDialog = false
                onRotateClick()
            },
            onDismiss = { showRotateDialog = false },
        )
    }
}

@Composable
private fun WipeConfirmDialog(
    burnerAddress: String,
    actionLabel: String,
    title: String,
    body: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                text = title,
                fontFamily = RethinkSans,
                fontWeight = FontWeight.Bold,
                fontSize = 16.sp,
                color = SeekerClawColors.TextPrimary,
            )
        },
        text = {
            Column {
                Text(
                    text = body,
                    fontFamily = RethinkSans,
                    fontSize = 13.sp,
                    color = SeekerClawColors.TextSecondary,
                    lineHeight = 20.sp,
                )
                Spacer(Modifier.height(Spacing.md))
                Text(
                    text = "Address",
                    fontFamily = RethinkSans,
                    fontSize = 11.sp,
                    color = SeekerClawColors.TextDim,
                )
                Text(
                    text = burnerAddress,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    color = SeekerClawColors.TextPrimary,
                    fontWeight = FontWeight.Medium,
                )
            }
        },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(
                    text = actionLabel,
                    fontFamily = RethinkSans,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.Error,
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(
                    text = "Cancel",
                    fontFamily = RethinkSans,
                    color = SeekerClawColors.TextSecondary,
                )
            }
        },
        containerColor = SeekerClawColors.Surface,
        shape = RoundedCornerShape(SeekerClawColors.CornerRadius),
    )
}

@Preview(name = "DangerZoneSection", showBackground = true, backgroundColor = 0xFF0D0D0D)
@Composable
private fun DangerZoneSectionPreview() {
    DangerZoneSection(
        burnerAddress = "7xKXTg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
        onWipeClick = {},
        onRotateClick = {},
    )
}
