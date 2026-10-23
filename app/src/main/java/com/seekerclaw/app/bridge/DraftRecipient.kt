package com.seekerclaw.app.bridge

/**
 * BAT-1409 P1-H — the phone number for a message or call draft. Pure (no `android.*`).
 *
 * Formatting is removed first: spaces (Unicode too), `-` and Unicode dashes, `(`, `)`, `.` and
 * `/`. What is left must be one plain number, `^\+?[0-9]{3,15}$`. Everything else is refused:
 * several recipients (`,` `;`), `*` and `#` (USSD codes), the pause characters `p`/`w`, letters
 * (vanity numbers included) and anything not ASCII digits.
 */
object DraftRecipient {

    private val NUMBER = Regex("^\\+?[0-9]{3,15}$")

    /**
     * True for the separator characters a person types inside a number. Control characters
     * (`\n`, `\t`) are not among them, so two numbers on separate lines are refused rather than
     * merged into one.
     */
    private fun isFormatting(c: Char): Boolean =
        Character.isSpaceChar(c) ||
            c == '-' || Character.getType(c) == Character.DASH_PUNCTUATION.toInt() ||
            c == '(' || c == ')' || c == '.' || c == '/'

    /** The normalised number, or null when [raw] is not exactly one plain phone number. */
    fun sanitize(raw: String?): String? {
        if (raw == null) return null
        val out = StringBuilder()
        for (c in raw.trim()) {
            if (isFormatting(c)) continue
            out.append(c)
        }
        val n = out.toString()
        return if (NUMBER.matches(n)) n else null
    }
}
