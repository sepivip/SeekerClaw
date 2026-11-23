package com.seekerclaw.app.ui.navigation

import com.seekerclaw.app.SourceText
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.ceil

/**
 * BAT-1725: at the largest system font size (2.0×) the bottom-nav "Settings" label broke across
 * two lines ("Setting" / "s"). The label now stays on one line and shrinks only when it cannot fit,
 * re-measuring until it does (hinted glyph advances are not exactly linear in the font size).
 */
class NavLabelTest {

    /** A linear measure: [full] pixels wide at factor 1, rounded up like TextLayoutResult.size. */
    private fun linear(full: Int): (Float) -> Int = { f -> ceil(full * f).toInt() }

    /**
     * A hinted-like measure: wider than linear below factor 1 (each of [glyphs] advances rounds up
     * to a whole pixel), so one proportional shrink lands a little over the slot.
     */
    private fun hinted(full: Int, glyphs: Int): (Float) -> Int = { f ->
        if (f >= 1f) full else ceil(full * f).toInt() + glyphs
    }

    private fun fits(width: (Float) -> Int, max: Int): Float {
        val f = navLabelFitFactor(max, width)
        assertTrue("factor in (0, 1]: $f", f > 0f && f <= 1f)
        assertTrue("label must fit: width ${width(f)} > slot $max at factor $f", width(f) <= max)
        return f
    }

    @Test
    fun `a label that fits keeps the user's font scale`() {
        assertEquals(1f, navLabelFitFactor(240, linear(180)))
        assertEquals(1f, navLabelFitFactor(240, linear(240)))
        assertEquals(1f, navLabelFitFactor(240, hinted(240, glyphs = 8)))
    }

    @Test
    fun `a label too wide for its slot shrinks until it fits`() {
        // The device case: about 1.3x too wide at 2.0x font in a quarter-width slot.
        fits(linear(312), 240)
        fits(hinted(312, glyphs = 8), 240)
    }

    @Test
    fun `a slot one pixel narrower than the label still fits, for both weights`() {
        // Normal and Medium weight measure differently; both must fit a slot 1px short of them.
        for (full in listOf(240, 252)) {
            fits(linear(full), full - 1)
            fits(hinted(full, glyphs = 8), full - 1)
        }
    }

    @Test
    fun `a measure that only changes in coarse steps still converges`() {
        // Hinting can hold the width flat across small factor changes. A 1px-short slot asks for a
        // ~0.4% shrink each pass; without a minimum step the label never crosses the step at 0.95.
        val stepped: (Float) -> Int = { f -> if (f > 0.95f) 240 else 200 }
        fits(stepped, 239)
    }

    @Test
    fun `a width plateau longer than any fixed number of passes still ends in a fit`() {
        // CodeRabbit on efccd5d0: the width holds at 240 until the factor drops below 0.90.
        // The result must be MEASURED to fit, and close to the largest factor that does.
        val plateau: (Float) -> Int = { f -> if (f >= 0.90f) 240 else ceil(240 * f).toInt() }
        val f = fits(plateau, 239)
        assertTrue("near the largest fitting factor (just under 0.90): $f", f > 0.85f && f < 0.90f)
    }

    @Test
    fun `the result is always a factor that was measured to fit`() {
        // Non-monotonic noise: the returned factor must be one that measured as fitting, never a guess.
        val measured = mutableMapOf<Float, Int>()
        val noisy: (Float) -> Int = { f -> (ceil(300 * f).toInt() + if ((f * 1000).toInt() % 3 == 0) 9 else 0).also { measured[f] = it } }
        val f = navLabelFitFactor(240, noisy)
        assertTrue("returned factor $f was measured", measured.containsKey(f))
        assertTrue("and it measured as fitting: ${measured[f]}", measured.getValue(f) <= 240)
    }

    @Test
    fun `an unknown slot width never shrinks the label`() {
        assertEquals(1f, navLabelFitFactor(0, linear(500)))
        assertEquals(1f, navLabelFitFactor(-1, linear(500)))
    }

    @Test
    fun `when even the floor does not fit, it stops at the floor with bounded work`() {
        var calls = 0
        val f = navLabelFitFactor(10) { calls++; 500 } // never fits: a pathological measure
        assertEquals(NAV_LABEL_MIN_FACTOR, f)
        assertEquals("full size, the guess, the floor — then it stops without searching", 3, calls)
    }

    @Test
    fun `a label that fits, exactly or with room, costs one measure`() {
        for (full in listOf(180, 240)) {
            var calls = 0
            assertEquals(1f, navLabelFitFactor(240) { f -> calls++; ceil(full * f).toInt() })
            assertEquals("width $full in a 240 slot", 1, calls)
        }
    }

    @Test
    fun `the search is bounded in measures`() {
        var calls = 0
        val plateau: (Float) -> Int = { f -> calls++; if (f >= 0.90f) 240 else ceil(240 * f).toInt() }
        navLabelFitFactor(239, plateau)
        assertTrue("at most 3 + steps measures: $calls", calls <= 3 + NAV_LABEL_FIT_STEPS)
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
        assertTrue("NavLabel must fit by re-measuring", body.contains("navLabelFitFactor("))
        assertTrue(
            "NavLabel's Text must render the shrunk style when the factor is below 1 (got: $text)",
            text.contains("style = if (factor < 1f) shrunk(base, factor) else base"),
        )
        // Measured and rendered widths must agree: each pass measures the exact style Text draws.
        assertTrue("NavLabel must measure with LocalTextStyle merged in", body.contains("val base = LocalTextStyle.current.merge("))
        assertTrue(
            "NavLabel must measure the style it renders at each factor (got: ${callArgs(body, "measure(")})",
            callArgs(body, "measure(").startsWith("text, if (f < 1f) shrunk(base, f) else base,"),
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
