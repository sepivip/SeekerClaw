package com.seekerclaw.app.config

enum class ParseStatus { OK, INVALID_NAME, RESERVED, MALFORMED }

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
                val trimmed = rawLine.trim()
                if (trimmed.isEmpty() || trimmed.startsWith("#")) null
                else parseLine(trimmed, rawLine)
            }
            .toList()
    }

    /** [trimmed] is used for parsing; [rawLine] is preserved verbatim for UI preview / error display. */
    private fun parseLine(trimmed: String, rawLine: String): ParsedEnvEntry {
        val stripped = if (trimmed.startsWith("export ")) trimmed.removePrefix("export ").trimStart() else trimmed
        val eq = stripped.indexOf('=')
        if (eq <= 0) {
            return ParsedEnvEntry(name = stripped, value = "", status = ParseStatus.MALFORMED, rawLine = rawLine)
        }
        val rawName = stripped.substring(0, eq).trim()
        val rawValue = unquote(stripped.substring(eq + 1).trim())

        val status = when {
            !EnvVar.NAME_REGEX.matches(rawName) -> ParseStatus.INVALID_NAME
            EnvVar.isReserved(rawName) -> ParseStatus.RESERVED
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
