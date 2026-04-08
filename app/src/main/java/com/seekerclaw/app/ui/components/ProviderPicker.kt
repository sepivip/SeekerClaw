package com.seekerclaw.app.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.seekerclaw.app.config.availableProviders
import com.seekerclaw.app.ui.theme.RethinkSans
import com.seekerclaw.app.ui.theme.SeekerClawColors
import androidx.compose.ui.text.font.FontWeight

/**
 * Shared provider picker — single source of truth for the AI provider radio list.
 * Used by both the onboarding flow and Settings → Provider screen.
 *
 * When [exclude] contains a provider id, that provider is hidden from the list.
 * The onboarding flow passes `setOf("custom")` to keep custom providers
 * Settings-only.
 *
 * Renders the radio list inside the caller's parent — wrap in a [CardSurface]
 * if you want the card frame.
 */
@Composable
fun ProviderPicker(
    selectedProviderId: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
    exclude: Set<String> = emptySet(),
) {
    val visibleProviders = availableProviders.filter { it.id !in exclude }
    Column(modifier = modifier.selectableGroup()) {
        visibleProviders.forEachIndexed { index, p ->
            val isSelected = p.id == selectedProviderId
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .selectable(
                        selected = isSelected,
                        onClick = { if (!isSelected) onSelect(p.id) },
                        role = Role.RadioButton,
                    )
                    .padding(vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RadioButton(
                    selected = isSelected,
                    onClick = null,
                    colors = RadioButtonDefaults.colors(
                        selectedColor = SeekerClawColors.Primary,
                        unselectedColor = SeekerClawColors.TextDim,
                    ),
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = p.displayName,
                    fontFamily = RethinkSans,
                    fontSize = 15.sp,
                    fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal,
                    color = if (isSelected) SeekerClawColors.TextPrimary else SeekerClawColors.TextDim,
                )
            }
            if (index < visibleProviders.size - 1) {
                HorizontalDivider(color = SeekerClawColors.CardBorder)
            }
        }
    }
}
