package com.seekerclaw.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * BAT-1161 P1A gate 6 — LogRedactor mirrors the Node redactSecrets static token shapes.
 * Pins each shape + the specific-before-generic ordering + non-over-redaction of prose.
 */
class LogRedactorTest {

    private fun red(s: String) = LogRedactor.redact(s)

    @Test fun `anthropic key masked`() {
        assertEquals("key=sk-ant-***", red("key=sk-ant-abcdef0123456789XYZ"))
    }

    @Test fun `telegram bot token masked`() {
        assertEquals("token ***:*** used", red("token 12345678:ABCDEFGHIJKLMNOPQRSTUVWX used"))
    }

    @Test fun `brave and perplexity keys masked`() {
        assertEquals("BSA***", red("BSAabcdef0123456789"))
        assertEquals("pplx-***", red("pplx-abcdef0123456789"))
    }

    @Test fun `openrouter key masked BEFORE generic sk- (ordering)`() {
        // Must become sk-or-***, not sk-*** — the specific prefix runs first.
        assertEquals("sk-or-***", red("sk-or-v1-abcdef1234567890"))
    }

    @Test fun `openai project + generic sk- masked`() {
        assertEquals("sk-proj-***", red("sk-proj-abcdefghij1234567890XY"))
        assertEquals("sk-***", red("sk-abcdefghij1234567890XYZ"))
    }

    @Test fun `xai api key masked`() {
        assertEquals("xai-***", red("xai-1234567890abcdef"))
    }

    @Test fun `JWT bearer or refresh token masked`() {
        val jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc_DEF-123"
        assertEquals("Authorization: Bearer eyJ***", red("Authorization: Bearer $jwt"))
    }

    @Test fun `only the token is masked, surrounding prose intact`() {
        val jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc_DEF-123"
        val out = red("xAI 403 forbidden for grok-4.5 with token $jwt at console.x.ai")
        assertTrue(out.contains("grok-4.5"))
        assertTrue(out.contains("console.x.ai"))
        assertTrue(out.contains("eyJ***"))
        assertFalse(out.contains(jwt))
    }

    @Test fun `ordinary message is unchanged (no over-redaction)`() {
        val msg = "Node started; Provider: xai; Model: grok-4.5; heartbeat 5m"
        assertEquals(msg, red(msg))
    }

    @Test fun `empty string is safe`() {
        assertEquals("", red(""))
    }
}
