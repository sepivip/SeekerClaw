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
}
