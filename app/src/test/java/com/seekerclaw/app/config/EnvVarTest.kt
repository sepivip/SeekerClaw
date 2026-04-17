package com.seekerclaw.app.config

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class EnvVarTest {

    @Test fun `valid POSIX name passes`() {
        assertNull(EnvVar.validateName("GITHUB_TOKEN"))
        assertNull(EnvVar.validateName("_FOO"))
        assertNull(EnvVar.validateName("A1"))
    }

    @Test fun `empty name fails`() {
        assertNotNull(EnvVar.validateName(""))
    }

    @Test fun `leading digit fails`() {
        assertNotNull(EnvVar.validateName("1FOO"))
    }

    @Test fun `lowercase fails`() {
        assertNotNull(EnvVar.validateName("github_token"))
    }

    @Test fun `hyphen fails`() {
        assertNotNull(EnvVar.validateName("FOO-BAR"))
    }

    @Test fun `reserved name PATH fails`() {
        assertNotNull(EnvVar.validateName("PATH"))
    }

    @Test fun `reserved prefix NODE fails`() {
        assertNotNull(EnvVar.validateName("NODE_FOO"))
        assertNotNull(EnvVar.validateName("NODE_OPTIONS"))
    }

    @Test fun `reserved prefix ANDROID fails`() {
        assertNotNull(EnvVar.validateName("ANDROID_DATA"))
    }

    @Test fun `lowercase npm prefix fails via charset check`() {
        // Name regex requires uppercase, so npm_* fails at the charset check
        // before reserved-prefix lookup. Keep the guard anyway (defense in depth).
        assertNotNull(EnvVar.validateName("npm_config_x"))
    }

    @Test fun `uppercase NPM prefix also reserved`() {
        // User types `npm_x` → auto-uppercases to `NPM_X` → hits the NPM_ reservation.
        // Prevents the dead-code problem of reserving `npm_` which regex already blocks.
        assertNotNull(EnvVar.validateName("NPM_CONFIG_X"))
    }

    @Test fun `reserved API_TIMEOUT_MS fails`() {
        assertNotNull(EnvVar.validateName("API_TIMEOUT_MS"))
    }

    @Test fun `AGENT_NAME passes even though AGENT_VERSION is reserved`() {
        // AGENT_VERSION is reserved; AGENT_NAME is not. Reservation is exact-match.
        assertNull(EnvVar.validateName("AGENT_NAME"))
    }

    @Test fun `generic multi-word uppercase name passes`() {
        assertNull(EnvVar.validateName("FOO_BAR_BAZ"))
        assertNull(EnvVar.validateName("MY_CUSTOM_API_KEY"))
    }

    @Test fun `value over 8 KB fails`() {
        val tooLong = "a".repeat(8193)
        assertNotNull(EnvVar.validateValue(tooLong))
    }

    @Test fun `value at 8 KB passes`() {
        val ok = "a".repeat(8192)
        assertNull(EnvVar.validateValue(ok))
    }

    @Test fun `value with newline fails`() {
        assertNotNull(EnvVar.validateValue("foo\nbar"))
        assertNotNull(EnvVar.validateValue("foo\r\nbar"))
        assertNotNull(EnvVar.validateValue("\n"))
    }

    @Test fun `reserved names list size is stable`() {
        // Canary: if these numbers change without deliberate intent, review should catch.
        assertEquals(14, EnvVar.RESERVED_EXACT.size)
        assertEquals(5, EnvVar.RESERVED_PREFIXES.size)
    }
}
