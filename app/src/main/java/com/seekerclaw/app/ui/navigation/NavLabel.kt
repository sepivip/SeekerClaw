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

/** Re-measure passes [navLabelFitFactor] may take before it gives up (bounded work per layout). */
internal const val NAV_LABEL_FIT_PASSES = 6

/**
 * BAT-1725: the factor (0 < f ≤ 1) to scale the label by so its one-line width fits [maxWidthPx].
 * [widthAt] measures the label at a factor with the real text metrics. Width is not exactly linear
 * in the factor (font hinting rounds glyph advances), so each pass re-measures and shrinks again
 * — by at least 1% — until it fits, at most [NAV_LABEL_FIT_PASSES] times. 1 when the label already
 * fits, or when the slot width is unknown (not positive): it is then never shrunk.
 */
internal fun navLabelFitFactor(maxWidthPx: Int, widthAt: (Float) -> Int): Float {
    if (maxWidthPx <= 0) return 1f
    var factor = 1f
    var width = widthAt(factor)
    var passes = 0
    while (width > maxWidthPx && passes < NAV_LABEL_FIT_PASSES) {
        factor *= (maxWidthPx.toFloat() / width).coerceAtMost(0.99f)
        width = widthAt(factor)
        passes++
    }
    return factor
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
        val maxWidth = if (constraints.hasBoundedWidth) constraints.maxWidth else 0
        // Each pass measures exactly the style Text will draw at that factor.
        val factor = navLabelFitFactor(maxWidth) { f ->
            measurer.measure(text, if (f < 1f) shrunk(base, f) else base, maxLines = 1, softWrap = false).size.width
        }
        Text(
            text = text,
            style = if (factor < 1f) shrunk(base, factor) else base,
            maxLines = 1,
            softWrap = false,
        )
    }
}

/** [base] scaled by [factor]: the font size and, when set, the letter spacing (so width scales near-linearly). */
private fun shrunk(base: TextStyle, factor: Float): TextStyle {
    return base.copy(
        fontSize = NAV_LABEL_FONT_SIZE * factor,
        letterSpacing = if (base.letterSpacing.isSpecified) base.letterSpacing * factor else base.letterSpacing,
    )
}
