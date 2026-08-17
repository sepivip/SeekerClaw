package com.seekerclaw.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * BAT-1247 (PM Q2) acceptance criteria: the Share payload must contain
 * (a) NO raw Telegram message bodies and (b) NO known secret/token forms —
 * while retaining timestamp / level / source metadata.
 */
class LogShareSanitizerTest {

    // ── (a) message bodies absent ───────────────────────────────────────────

    @Test
    fun `message body is replaced with deterministic marker`() {
        val line = "[11:42:23 PM] [Node] Message: Hey girl"
        val out = LogShareSanitizer.sanitizeLine(line)
        assertFalse("body must not survive", out.contains("Hey girl"))
        assertEquals("[11:42:23 PM] [Node] Message: [redacted, 8 chars]", out)
    }

    @Test
    fun `metadata before the marker is preserved`() {
        val out = LogShareSanitizer.sanitizeLine("[11:42:32 PM] [Node] Message: How are you?")
        assertTrue(out.startsWith("[11:42:32 PM] [Node] "))
        assertFalse(out.contains("How are you?"))
    }

    @Test
    fun `media and reply suffixes are scrubbed with the body`() {
        // message-handler.js appends " [photo]" / " [reply]" AFTER the body —
        // they are part of the post-marker segment and go with it.
        val out = LogShareSanitizer.sanitizeLine("[1:00:00 AM] [Node] Message: secret plan [photo] [reply]")
        assertFalse(out.contains("secret plan"))
        assertTrue(out.contains("[redacted,"))
    }

    @Test
    fun `multi-line payload scrubs every message line`() {
        val text = listOf(
            "[11:41:23 PM] [Node] [DB] Loaded existing database",
            "[11:42:23 PM] [Node] Message: Hey girl",
            "[11:42:32 PM] [Node] Message: How are you?",
        ).joinToString("\n")
        val out = LogShareSanitizer.sanitize(text)
        assertFalse(out.contains("Hey girl"))
        assertFalse(out.contains("How are you?"))
        assertTrue("non-message lines untouched", out.contains("[DB] Loaded existing database"))
    }

    @Test
    fun `lines without the marker are unchanged`() {
        val line = "[11:41:24 PM] [Node] [ControlServer] Listening on 127.0.0.1:8766"
        assertEquals(line, LogShareSanitizer.sanitizeLine(line))
    }

    // ── (b) known secret forms absent ───────────────────────────────────────

    @Test
    fun `anthropic key form is masked in share payload`() {
        val out = LogShareSanitizer.sanitizeLine("[E] auth failed for sk-ant-api03-AbCdEfGhIjKlMnOp")
        assertFalse(out.contains("sk-ant-api03-AbCdEfGhIjKlMnOp"))
        assertTrue(out.contains("sk-ant-***"))
    }

    @Test
    fun `telegram bot token form is masked in share payload`() {
        val out = LogShareSanitizer.sanitizeLine("[E] polling 12345678:AAAbbbCCCdddEEEfffGGGhh failed")
        assertFalse(out.contains("12345678:AAAbbbCCCdddEEEfffGGGhh"))
    }

    @Test
    fun `jwt form is masked in share payload`() {
        val out = LogShareSanitizer.sanitizeLine("bearer eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM rejected")
        assertFalse(out.contains("eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM"))
        assertTrue(out.contains("eyJ***"))
    }

    @Test
    fun `secret inside a message body is doubly covered`() {
        val out = LogShareSanitizer.sanitizeLine("[N] Message: my key is sk-ant-api03-AbCdEfGhIjKlMnOp")
        assertFalse(out.contains("sk-ant-api03"))
        assertFalse(out.contains("my key is"))
    }

    // ── multiline bodies (CodeRabbit #449 R1 regression) ────────────────────

    // NOTE ON FIXTURES: multi-line tests below use the REAL emission format from
    // LogsScreen.kt — `"[${'$'}{entry.level.name}] [${'$'}timeStr] ${'$'}{entry.message}"`, i.e.
    // "[INFO] [11:42:23 PM] [Node] …". Earlier fixtures omitted the level token
    // and so exercised a shape the app never produces; since `entryStart` is now
    // anchored on the real header, fixtures must match production or these tests
    // prove nothing.

    @Test
    fun `multiline message body is fully scrubbed, not just the first line`() {
        val text = listOf(
            "[INFO] [11:42:23 PM] [Node] Message: first secret line",
            "second secret line without prefix",
            "third secret line",
            "[DEBUG] [11:43:00 PM] [Node] [DB] Loaded existing database",
        ).joinToString("\n")
        val out = LogShareSanitizer.sanitize(text)
        assertFalse(out.contains("first secret line"))
        assertFalse(out.contains("second secret line"))
        assertFalse(out.contains("third secret line"))
        assertTrue("continuation replaced", out.contains("[redacted continuation]"))
        assertTrue("next entry intact", out.contains("[DB] Loaded existing database"))
    }

    @Test
    fun `continuation state resets at the next bracketed entry`() {
        val text = listOf(
            "[INFO] [1:00 AM] [Node] Message: body",
            "body continues",
            "[INFO] [1:01 AM] [Node] [ControlServer] Listening on 127.0.0.1:8766",
            "[INFO] [1:02 AM] [Node] [Skills] 35 skills loaded",
        ).joinToString("\n")
        val out = LogShareSanitizer.sanitize(text)
        assertFalse(out.contains("body continues"))
        assertTrue(out.contains("Listening on 127.0.0.1:8766"))
        assertTrue(out.contains("35 skills loaded"))
    }

    // ── bracket-prefixed continuation (CodeRabbit #449 R2 — Major) ──────────
    // A multiline chat body whose continuation line STARTS WITH "[" — a pasted
    // config section, a markdown link, a bracketed log paste — must not be
    // mistaken for a new console entry. The old `^\[` rule flipped redaction
    // OFF there, so every following body line reached the Share payload with
    // only LogRedactor's static token shapes protecting it. Pasting logs or
    // config into the agent is precisely when secrets are in the message.

    @Test
    fun `bracketed continuation line does not end redaction`() {
        val text = listOf(
            "[INFO] [2:00 PM] [Node] Message: here is my config",
            "[database]",
            "host=admin:hunter2@internal.db",
            "[INFO] [2:01 PM] [Node] [Skills] 29 loaded",
        ).joinToString("\n")
        val out = LogShareSanitizer.sanitize(text)
        assertFalse("bracketed continuation must not leak", out.contains("[database]"))
        assertFalse("line AFTER it must not leak", out.contains("hunter2"))
        assertFalse(out.contains("internal.db"))
        assertTrue("real next entry still recognised", out.contains("29 loaded"))
    }

    @Test
    fun `markdown-link continuation does not end redaction`() {
        val text = listOf(
            "[WARN] [3:00 PM] [Node] Message: check this",
            "[my private doc](https://internal.example.com/secret-token-abc)",
            "[ERROR] [3:01 PM] [Node] [DB] ok",
        ).joinToString("\n")
        val out = LogShareSanitizer.sanitize(text)
        assertFalse(out.contains("secret-token-abc"))
        assertFalse(out.contains("my private doc"))
        assertTrue(out.contains("[DB] ok"))
    }

    @Test
    fun `every log level is recognised as an entry header`() {
        // If a level were missing from the pattern, entries at that level would
        // be swallowed as "continuation" after any Message: line — silently
        // destroying diagnostics in the export.
        for (level in LogLevel.entries) {
            val text = listOf(
                "[INFO] [4:00 PM] [Node] Message: body",
                "[${level.name}] [4:01 PM] [Node] [DB] marker-$level",
            ).joinToString("\n")
            val out = LogShareSanitizer.sanitize(text)
            assertTrue("$level entry must survive", out.contains("marker-$level"))
        }
    }
}
