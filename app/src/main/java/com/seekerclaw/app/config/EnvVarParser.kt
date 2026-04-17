package com.seekerclaw.app.config

enum class ParseStatus { OK, INVALID_NAME, RESERVED, MALFORMED, VALUE_TOO_LARGE, VALUE_HAS_NEWLINE }

data class ParsedEnvEntry(
    val name: String,
    val value: String,
    val status: ParseStatus,
    val rawLine: String,
)

object EnvVarParser {
    fun parse(text: String): List<ParsedEnvEntry> {
        return text.lines()
            .asSequence()
            .mapNotNull { rawLine ->
                // Strip a trailing \r (Windows CRLF endings — String.lines() leaves
                // the \r) and leading whitespace (for indented / export-prefixed
                // lines). Preserve trailing whitespace inside values — a round-trip
                // through the Raw editor should not silently mutate user input.
                val stripped = rawLine.trimEnd('\r')
                val leftTrimmed = stripped.trimStart()
                if (leftTrimmed.isEmpty() || leftTrimmed.startsWith("#")) null
                else parseLine(leftTrimmed, rawLine)
            }
            .toList()
    }

    /** [leftTrimmed] is used for parsing (leading whitespace + \r removed only);
     *  [rawLine] is preserved verbatim for UI preview / error display. */
    private fun parseLine(leftTrimmed: String, rawLine: String): ParsedEnvEntry {
        val stripped = if (leftTrimmed.startsWith("export ")) leftTrimmed.removePrefix("export ").trimStart() else leftTrimmed
        val eq = stripped.indexOf('=')
        if (eq <= 0) {
            return ParsedEnvEntry(name = stripped, value = "", status = ParseStatus.MALFORMED, rawLine = rawLine)
        }
        val rawName = stripped.substring(0, eq).trim()
        // Preserve trailing whitespace in unquoted values — POSIX `.env` convention
        // calls for stripping it, but that breaks Raw editor round-trips where the
        // user's intent is to persist exactly what they wrote. Quotes still strip.
        val rawValue = unquote(stripped.substring(eq + 1))

        val status = when {
            !EnvVar.NAME_REGEX.matches(rawName) -> ParseStatus.INVALID_NAME
            EnvVar.isReserved(rawName) -> ParseStatus.RESERVED
            // Distinguish newline rejection from size-cap rejection so the Raw
            // editor can surface the specific reason. In practice the parser
            // rarely sees newline-containing values (each input line is one
            // entry), but a legacy stored value with `\n` would hit this path
            // when rehydrated as the Raw editor's initialText.
            rawValue.contains('\n') || rawValue.contains('\r') -> ParseStatus.VALUE_HAS_NEWLINE
            EnvVar.validateValue(rawValue) != null -> ParseStatus.VALUE_TOO_LARGE
            else -> ParseStatus.OK
        }
        return ParsedEnvEntry(name = rawName, value = rawValue, status = status, rawLine = rawLine)
    }

    private fun unquote(s: String): String {
        if (s.length >= 2) {
            if ((s.startsWith("\"") && s.endsWith("\"")) ||
                (s.startsWith("'") && s.endsWith("'"))) {
                return s.substring(1, s.length - 1)
            }
        }
        return s
    }
}
