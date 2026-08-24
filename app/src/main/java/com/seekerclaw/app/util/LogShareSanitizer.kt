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

    // A console ENTRY is emitted by LogsScreen as EXACTLY
    //     "[${'$'}{entry.level.name}] [${'$'}timeStr] ${'$'}{entry.message}"
    // i.e. a level token from [LogLevel] followed by a bracketed time
    // ("[INFO] [11:42:23 PM] …" / 24h "[WARN] [23:42:23] …").
    //
    // This MUST be strict. An earlier version matched any line starting with
    // "[", which let a message body leak: a multiline chat message whose
    // continuation line began with "[" — a pasted config section "[database]",
    // a markdown link, a bracketed log paste — looked like a new entry, flipped
    // `inMessage` off, and every following body line escaped the message scrub
    // with only [LogRedactor.redact] (static token shapes) standing between it
    // and the Share payload. Pasting logs/config into the agent is exactly when
    // secrets are in the message, so that was a live leak path
    // (CodeRabbit #449 R2 — Major).
    //
    // Anchored on the real emission format: only a genuine level+time header
    // ends redaction mode. Anything else is treated as body continuation.
    //
    // Built FROM [LogLevel] rather than hardcoding "DEBUG|INFO|WARN|ERROR", so
    // adding a level can't silently turn its entries into "continuation" and
    // erase them from the export. Enum names are Kotlin identifiers, so they
    // cannot contain regex metacharacters — no escaping needed.
    private val entryStart = Regex(
        LogLevel.entries.joinToString("|", prefix = """^\[(?:""", postfix = """)] \[""")
    )

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
