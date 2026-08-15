package com.seekerclaw.app.util

/**
 * BAT-1247 (PM Q2): sanitize the log text handed to the Share sheet.
 *
 * The on-device console keeps full fidelity — this runs ONLY on the Share
 * payload, the one-tap path OFF the device. Two passes:
 *
 *  1. **Message-body scrub.** The Node runtime logs inbound chat messages as
 *     `… Message: <first 100 chars>` (message-handler.js). Everything after
 *     the `Message: ` marker is replaced with a deterministic
 *     `[redacted, N chars]` marker. Timestamp, level, and source prefix are
 *     preserved (PM: retain useful metadata), so support can still see WHEN
 *     messages flowed without seeing WHAT was said.
 *  2. **Secret backstop.** [LogRedactor.redact] over every line — the same
 *     static token shapes (sk-ant-/bot tokens/JWTs/…) applied to the mirror
 *     and console, re-applied here as defense in depth.
 *
 * Pure and allocation-light; callers wrap fail-open like the existing share
 * redaction (a sanitizer crash must not open an unredacted escape hatch).
 */
object LogShareSanitizer {

    // `Message: ` preceded by start-of-line or whitespace/bracket — anchored on
    // the exact emission format so arbitrary prose containing the word
    // "Message:" mid-sentence is left alone only when it IS the marker.
    private val messageMarker = Regex("""(^|.*?\s)Message: (.*)$""")

    // A console ENTRY starts with a bracketed prefix ("[11:42:23 PM] …",
    // "[Node] …"). A chat body that itself contained newlines renders as
    // continuation lines WITHOUT that prefix — those must be scrubbed too
    // (CodeRabbit #449 R1: single-line scrubbing let multiline bodies leak).
    private val entryStart = Regex("""^\[""")

    /** Sanitize one already-formatted console line for the Share payload. */
    fun sanitizeLine(line: String): String {
        val scrubbed = messageMarker.replace(line) { m ->
            val prefix = m.groupValues[1]
            val body = m.groupValues[2]
            "${prefix}Message: [redacted, ${body.length} chars]"
        }
        return LogRedactor.redact(scrubbed)
    }

    /**
     * Sanitize the full multi-line share payload. Stateful: once a line hits
     * the message marker, every following line that does NOT start a new
     * console entry is treated as body continuation and fully replaced —
     * conservative by design (over-scrubbing a stray continuation beats
     * leaking one line of a user's chat).
     */
    fun sanitize(text: String): String {
        var inMessage = false
        return text.lineSequence().joinToString("\n") { line ->
            when {
                messageMarker.matches(line) -> {
                    inMessage = true
                    sanitizeLine(line)
                }
                inMessage && !entryStart.containsMatchIn(line) ->
                    "[redacted continuation]"
                else -> {
                    inMessage = false
                    sanitizeLine(line)
                }
            }
        }
    }
}
