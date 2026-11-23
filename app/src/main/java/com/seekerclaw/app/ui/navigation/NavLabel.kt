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

/** The smallest factor a label is shrunk to (half the user's size) — the search's floor. */
internal const val NAV_LABEL_MIN_FACTOR = 0.5f

/** Binary-search steps between the floor and the proportional guess (bounded work per layout). */
internal const val NAV_LABEL_FIT_STEPS = 6

/**
 * BAT-1725: the largest factor (≤ 1) to scale the label by so its one-line width fits [maxWidthPx].
 * [widthAt] measures the label at a factor with the real text metrics. Width is not exactly linear
 * in the factor (font hinting rounds glyph advances, and can hold the width flat for a while), so
 * a proportional shrink is only a first guess:
 * - 1 when the label already fits, or when the slot width is unknown (not positive).
 * - the proportional guess when it measures as fitting.
 * - otherwise a binary search in [NAV_LABEL_MIN_FACTOR, guess] that only ever returns a factor
 *   it has MEASURED to fit — however long a width plateau lasts.
 * Only if even the floor does not fit does it return the floor (the smallest size it will draw).
 * At most 3 + [NAV_LABEL_FIT_STEPS] measures; a fitting label costs one.
 */
internal fun navLabelFitFactor(maxWidthPx: Int, widthAt: (Float) -> Int): Float {
    if (maxWidthPx <= 0) return 1f
    val full = widthAt(1f)
    if (full <= maxWidthPx) return 1f
    val guess = (maxWidthPx.toFloat() / full).coerceAtLeast(NAV_LABEL_MIN_FACTOR)
    if (widthAt(guess) <= maxWidthPx) return guess
    if (widthAt(NAV_LABEL_MIN_FACTOR) > maxWidthPx) return NAV_LABEL_MIN_FACTOR
    var fits = NAV_LABEL_MIN_FACTOR // invariant: measured to fit
    var tooWide = guess // invariant: measured too wide
    repeat(NAV_LABEL_FIT_STEPS) {
        val mid = (fits + tooWide) / 2
        if (widthAt(mid) <= maxWidthPx) fits = mid else tooWide = mid
    }
    return fits
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
