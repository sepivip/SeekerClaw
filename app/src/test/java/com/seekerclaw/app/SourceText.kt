package com.seekerclaw.app

import java.io.File

/**
 * Test-only helpers for source guards that must match on statement order. Kotlin source is lexed
 * just enough to tell code from comments and string literals (nested block comments, raw strings,
 * string templates and char literals included), so a guard is never satisfied or broken by a word
 * in a comment or a log message.
 */
internal object SourceText {

    /** Reads a main source file relative to the app module, with `\n` line ends. */
    fun main(relative: String): String {
        val f = File("src/main/java/$relative")
        check(f.isFile) { "run from the app module: $relative" }
        return f.readText().replace("\r\n", "\n")
    }

    /** Every `.kt` file under `src/main/java`, as (path, text with `\n` line ends). */
    fun allMain(): List<Pair<String, String>> {
        val root = File("src/main/java")
        check(root.isDirectory) { "run from the app module" }
        return root.walkTopDown().filter { it.isFile && it.name.endsWith(".kt") }
            .map { it.path.replace('\\', '/') to it.readText().replace("\r\n", "\n") }
            .sortedBy { it.first }
            .toList()
    }

    /** [src] with comments blanked to spaces (newlines kept, so offsets and lines still line up). */
    fun withoutComments(src: String): String = lex(src, blankStrings = false)

    /** [src] with comments and string literals blanked: what remains is code only. */
    fun codeOnly(src: String): String = lex(src, blankStrings = true)

    /**
     * The body of the first function declaration in [code] (a [codeOnly] text) that [declaration]
     * matches (by default `fun <name>(`; the match must end before the parameter list): the range
     * strictly inside its outermost braces. Expression bodies are not supported; the guard fails
     * loudly instead of matching the wrong thing.
     */
    fun functionBody(
        code: String,
        name: String,
        declaration: Regex = Regex("""\bfun\s+$name\b(?=\s*\()"""),
    ): IntRange {
        val m = declaration.find(code) ?: error("declaration of $name not found")
        return braceBlockAfter(code, m.range.last + 1, rejectExpressionBody = true)
    }

    /** The range strictly inside the first top-level `{ … }` block that starts at or after [from]. */
    fun braceBlockAfter(code: String, from: Int, rejectExpressionBody: Boolean = false): IntRange {
        var i = from
        var parens = 0
        while (i < code.length) {
            when (code[i]) {
                '(' -> parens++
                ')' -> parens--
                '=' -> if (rejectExpressionBody && parens == 0 && code.getOrNull(i + 1) != '=') {
                    error("expression body at $i")
                }
                '{' -> if (parens == 0) break
            }
            i++
        }
        check(i < code.length) { "no block after $from" }
        val open = i
        var depth = 0
        while (i < code.length) {
            when (code[i]) {
                '{' -> depth++
                '}' -> {
                    depth--
                    if (depth == 0) return (open + 1) until i
                }
            }
            i++
        }
        error("unbalanced braces after $open")
    }

    /** [text] with every whitespace run collapsed to one space, trimmed: statements on one line. */
    fun flat(text: String): String = text.replace(Regex("""\s+"""), " ").trim()

    /** The 1-based line of [offset] in [text], for messages. */
    fun lineOf(text: String, offset: Int): Int = text.substring(0, offset).count { it == '\n' } + 1

    private fun lex(src: String, blankStrings: Boolean): String = Lexer(src, blankStrings).run()

    private class Lexer(private val src: String, private val blankStrings: Boolean) {
        private val out = StringBuilder(src)

        fun run(): String {
            var i = 0
            while (i < src.length) i = code(i, untilBrace = false)
            return out.toString()
        }

        private fun blank(from: Int, to: Int) {
            for (k in from until minOf(to, src.length)) if (out[k] != '\n') out[k] = ' '
        }

        // Returns the index just past the string that starts at [start] (a `"` or `"""`).
        private fun string(start: Int): Int {
            val raw = src.startsWith("\"\"\"", start)
            var j = start + if (raw) 3 else 1
            while (j < src.length) {
                if (raw && src.startsWith("\"\"\"", j)) {
                    // A raw string may end with extra quotes: `""""` closes on the last three.
                    var end = j + 3
                    while (end < src.length && src[end] == '"') end++
                    return end
                }
                val c = src[j]
                if (!raw && c == '\\') { j += 2; continue }
                if (!raw && c == '"') return j + 1
                if (c == '$' && src.getOrNull(j + 1) == '{') {
                    j = code(j + 2, untilBrace = true)
                    continue
                }
                j++
            }
            return j
        }

        // Lexes code from [start]; with [untilBrace], stops after the `}` that closes a template.
        private fun code(start: Int, untilBrace: Boolean): Int {
            var j = start
            var depth = 0
            while (j < src.length) {
                val c = src[j]
                when {
                    src.startsWith("//", j) -> {
                        val end = src.indexOf('\n', j).let { if (it < 0) src.length else it }
                        blank(j, end)
                        j = end
                    }
                    src.startsWith("/*", j) -> {
                        var nest = 0
                        var k = j
                        while (k < src.length) {
                            if (src.startsWith("/*", k)) { nest++; k += 2; continue }
                            if (src.startsWith("*/", k)) { nest--; k += 2; if (nest == 0) break; continue }
                            k++
                        }
                        blank(j, k)
                        j = k
                    }
                    c == '"' -> {
                        val end = string(j)
                        if (blankStrings) blank(j, end)
                        j = end
                    }
                    c == '\'' -> {
                        val end = if (src.getOrNull(j + 1) == '\\') src.indexOf('\'', j + 3) + 1 else j + 3
                        if (blankStrings) blank(j, end)
                        j = end
                    }
                    c == '{' -> { depth++; j++ }
                    c == '}' -> {
                        if (untilBrace && depth == 0) return j + 1
                        depth--
                        j++
                    }
                    else -> j++
                }
            }
            return j
        }
    }
}
