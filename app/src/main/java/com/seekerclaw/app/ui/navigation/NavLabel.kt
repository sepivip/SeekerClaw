package com.seekerclaw.app.ui.navigation

import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.isSpecified
import androidx.compose.ui.unit.sp
import com.seekerclaw.app.ui.theme.RethinkSans

/** The bottom-nav label size at the system's default font scale. */
internal val NAV_LABEL_FONT_SIZE = 11.sp

/**
 * BAT-1725: the factor (0 < f ≤ 1) to multiply the label's font size by so a one-line label of
 * [textWidthPx] fits in [maxWidthPx]. 1 when it already fits, or when the slot width is unknown
 * (unbounded or not positive) — the label is then never shrunk.
 */
internal fun navLabelShrinkFactor(textWidthPx: Int, maxWidthPx: Int): Float {
    if (maxWidthPx <= 0 || textWidthPx <= maxWidthPx) return 1f
    return maxWidthPx.toFloat() / textWidthPx
}

/**
 * BAT-1725: a bottom-nav label that always stays on one line. It keeps the user's font scale
 * while the label fits its slot; otherwise it shrinks just enough to fit, instead of breaking a
 * word across two lines ("Setting" / "s" at 2.0×). Its colour comes from the NavigationBarItem.
 */
@Composable
internal fun NavLabel(text: String, selected: Boolean) {
    // The style Text actually renders: NavigationBarItem provides typography.labelMedium (with its
    // letter spacing) through LocalTextStyle, and Text merges with it — so measure that merge, not
    // the bare style, or the measured width is narrower than the drawn one.
    val base = LocalTextStyle.current.merge(
        TextStyle(
            fontFamily = RethinkSans,
            fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal,
            fontSize = NAV_LABEL_FONT_SIZE,
        ),
    )
    val measurer = rememberTextMeasurer()
    BoxWithConstraints {
        val bounded = constraints.hasBoundedWidth
        val measured = measurer.measure(text, base, maxLines = 1, softWrap = false).size.width
        val factor = navLabelShrinkFactor(measured, if (bounded) constraints.maxWidth else 0)
        Text(
            text = text,
            style = if (factor < 1f) shrunk(base, factor) else base,
            maxLines = 1,
            softWrap = false,
        )
    }
}

/** [base] scaled by [factor]: the font size and, when set, the letter spacing (so width scales linearly). */
private fun shrunk(base: TextStyle, factor: Float): TextStyle {
    return base.copy(
        fontSize = NAV_LABEL_FONT_SIZE * factor,
        letterSpacing = if (base.letterSpacing.isSpecified) base.letterSpacing * factor else base.letterSpacing,
    )
}
