package com.seekerclaw.app.ui.navigation

import com.seekerclaw.app.SourceText
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * BAT-1725: at the largest system font size (2.0×) the bottom-nav "Settings" label broke across
 * two lines ("Setting" / "s"). The label now stays on one line and shrinks only when it cannot fit.
 */
class NavLabelTest {

    @Test
    fun `a label that fits keeps the user's font scale`() {
        assertEquals(1f, navLabelShrinkFactor(textWidthPx = 180, maxWidthPx = 240))
        assertEquals(1f, navLabelShrinkFactor(textWidthPx = 240, maxWidthPx = 240))
    }

    @Test
    fun `a label too wide for its slot shrinks exactly to the slot`() {
        // The device case: about 1.3x too wide at 2.0x font in a quarter-width slot.
        val f = navLabelShrinkFactor(textWidthPx = 312, maxWidthPx = 240)
        assertEquals(240f / 312f, f, 1e-6f)
        assertTrue("shrunk text must fit: ${312 * f}", 312 * f <= 240f + 1e-3f)
    }

    @Test
    fun `an unknown slot width never shrinks the label`() {
        assertEquals(1f, navLabelShrinkFactor(textWidthPx = 500, maxWidthPx = 0))
        assertEquals(1f, navLabelShrinkFactor(textWidthPx = 500, maxWidthPx = -1))
    }

    @Test
    fun `every bottom-nav label goes through the one-line NavLabel`() {
        val nav = SourceText.flat(SourceText.codeOnly(SourceText.main("com/seekerclaw/app/ui/navigation/NavGraph.kt")))
        assertTrue("NavigationBarItem label must use NavLabel", nav.contains("label = { NavLabel(item.label, selected) }"))

        val label = SourceText.codeOnly(SourceText.main("com/seekerclaw/app/ui/navigation/NavLabel.kt"))
        val body = SourceText.flat(label.substring(SourceText.functionBody(label, "NavLabel")))
        // The rendered Text call itself, not the measure call (which also passes these arguments).
        val text = callArgs(body, "Text(")
        assertTrue("NavLabel's Text must render one line: maxLines = 1 (got: $text)", text.contains("maxLines = 1"))
        assertTrue("NavLabel's Text must not wrap: softWrap = false (got: $text)", text.contains("softWrap = false"))
        assertTrue("NavLabel must compute the shrink factor", body.contains("navLabelShrinkFactor("))
        assertTrue(
            "NavLabel's Text must render the shrunk style when the factor is below 1 (got: $text)",
            text.contains("style = if (factor < 1f) shrunk(base, factor) else base"),
        )
        // Measured and rendered widths must agree: both use `base`, the merge with LocalTextStyle.
        assertTrue("NavLabel must measure with LocalTextStyle merged in", body.contains("val base = LocalTextStyle.current.merge("))
        assertTrue(
            "NavLabel must measure the same style it renders (got: ${callArgs(body, "measure(")})",
            callArgs(body, "measure(").startsWith("text, base,"),
        )
        val shrunk = SourceText.flat(label.substring(SourceText.functionBody(label, "shrunk")))
        assertTrue("shrunk must scale the font size", shrunk.contains("fontSize = NAV_LABEL_FONT_SIZE * factor"))
        assertTrue("shrunk must scale the letter spacing", shrunk.contains("base.letterSpacing * factor"))
    }

    /** The argument text of the single call that starts with [open] (e.g. `Text(`) in [code]. */
    private fun callArgs(code: String, open: String): String {
        val starts = Regex("""\b${Regex.escape(open)}""").findAll(code).map { it.range.first }.toList()
        check(starts.size == 1) { "expected exactly one $open call, found ${starts.size}" }
        var depth = 0
        for (i in starts[0] + open.length - 1 until code.length) {
            when (code[i]) {
                '(' -> depth++
                ')' -> if (--depth == 0) return code.substring(starts[0] + open.length, i)
            }
        }
        error("unbalanced $open")
    }
}
