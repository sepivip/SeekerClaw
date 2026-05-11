package com.seekerclaw.app.ui.settings.wallet.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.sp
import com.seekerclaw.app.ui.components.PrimaryButton
import com.seekerclaw.app.ui.components.SectionLabel
import com.seekerclaw.app.ui.theme.RethinkSans
import com.seekerclaw.app.ui.theme.SeekerClawColors
import com.seekerclaw.app.ui.theme.Spacing

/**
 * BurnerCaps — UI-facing data class. Decimal strings are what the user
 * types and reads; the call site converts to atomic units via
 * [com.seekerclaw.app.ui.settings.wallet.WalletAmountFormat] before
 * persisting.
 *
 * Co-located with [CapsConfigSection] for V1 — if a second composable
 * starts using this shape, lift to a top-level file.
 */
data class BurnerCaps(
    val perTxSol: String = "",
    val dailySol: String = "",
    val perTxUsdc: String = "",
    val dailyUsdc: String = "",
)

/**
 * CapsConfigSection — 4-input cap editor for the Burner Wallet screen
 * (BAT-582). Labels and placeholders are CURRENTLY HARDCODED to
 * "Per-tx SOL", "Daily SOL", "Per-tx USDC", "Daily USDC" — this
 * composable is purpose-built for the burner-caps shape. If a future
 * capped-resource UI (rate limits, daily-message ceilings) wants to
 * reuse the four-input layout, parameterize the labels and asset names
 * at THAT TIME rather than speculatively now.
 *
 * Validation is intentionally NOT done here — the parent screen owns the
 * decimal/atomic boundary via [com.seekerclaw.app.ui.settings.wallet.WalletAmountFormat]
 * and surfaces parse errors as Toasts. This composable just collects
 * strings and emits them on Save.
 *
 * The Save button is enabled whenever any field differs from the
 * [initial] values, so an unchanged form doesn't trigger a no-op save.
 */
@Composable
fun CapsConfigSection(
    initial: BurnerCaps,
    onSave: (BurnerCaps) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    var perTxSol by remember(initial) { mutableStateOf(initial.perTxSol) }
    var dailySol by remember(initial) { mutableStateOf(initial.dailySol) }
    var perTxUsdc by remember(initial) { mutableStateOf(initial.perTxUsdc) }
    var dailyUsdc by remember(initial) { mutableStateOf(initial.dailyUsdc) }

    val current = BurnerCaps(perTxSol, dailySol, perTxUsdc, dailyUsdc)
    val dirty = current != initial

    Column(modifier = modifier) {
        SectionLabel("Spend caps")
        Spacer(Modifier.height(Spacing.sm))
        Text(
            text = "Burner can spend up to these amounts without your approval. Resets at 00:00 UTC.",
            fontFamily = RethinkSans,
            fontSize = 12.sp,
            color = SeekerClawColors.TextDim,
        )
        Spacer(Modifier.height(Spacing.lg))

        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Spacing.md)) {
            CapField(
                value = perTxSol,
                onValueChange = { perTxSol = it },
                label = "Per-tx SOL",
                placeholder = "0.05",
                modifier = Modifier.weight(1f),
                enabled = enabled,
            )
            CapField(
                value = dailySol,
                onValueChange = { dailySol = it },
                label = "Daily SOL",
                placeholder = "0.5",
                modifier = Modifier.weight(1f),
                enabled = enabled,
            )
        }
        Spacer(Modifier.height(Spacing.md))
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Spacing.md)) {
            CapField(
                value = perTxUsdc,
                onValueChange = { perTxUsdc = it },
                label = "Per-tx USDC",
                placeholder = "5",
                modifier = Modifier.weight(1f),
                enabled = enabled,
            )
            CapField(
                value = dailyUsdc,
                onValueChange = { dailyUsdc = it },
                label = "Daily USDC",
                placeholder = "50",
                modifier = Modifier.weight(1f),
                enabled = enabled,
            )
        }

        Spacer(Modifier.height(Spacing.lg))
        PrimaryButton(
            onClick = { onSave(current) },
            label = "Save caps",
            modifier = Modifier.fillMaxWidth(),
            enabled = enabled && dirty,
        )
    }
}

@Composable
private fun CapField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    placeholder: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        enabled = enabled,
        singleLine = true,
        modifier = modifier,
        label = {
            Text(
                text = label,
                fontFamily = RethinkSans,
                fontSize = 12.sp,
                color = SeekerClawColors.TextDim,
            )
        },
        placeholder = {
            Text(
                text = placeholder,
                fontFamily = FontFamily.Monospace,
                fontSize = 14.sp,
                color = SeekerClawColors.TextDim,
            )
        },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        textStyle = androidx.compose.ui.text.TextStyle(
            fontFamily = FontFamily.Monospace,
            fontSize = 14.sp,
            color = SeekerClawColors.TextPrimary,
            fontWeight = FontWeight.Medium,
        ),
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = SeekerClawColors.Primary,
            unfocusedBorderColor = SeekerClawColors.CardBorder,
            cursorColor = SeekerClawColors.Primary,
            focusedTextColor = SeekerClawColors.TextPrimary,
            unfocusedTextColor = SeekerClawColors.TextPrimary,
        ),
    )
}

@Preview(name = "CapsConfigSection — empty", showBackground = true, backgroundColor = 0xFF0D0D0D)
@Composable
private fun CapsConfigSectionEmptyPreview() {
    CapsConfigSection(initial = BurnerCaps(), onSave = {})
}

@Preview(name = "CapsConfigSection — filled", showBackground = true, backgroundColor = 0xFF0D0D0D)
@Composable
private fun CapsConfigSectionFilledPreview() {
    CapsConfigSection(
        initial = BurnerCaps(
            perTxSol = "0.05",
            dailySol = "0.5",
            perTxUsdc = "5",
            dailyUsdc = "50",
        ),
        onSave = {},
    )
}
