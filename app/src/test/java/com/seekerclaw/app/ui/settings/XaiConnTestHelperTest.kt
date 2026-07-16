package com.seekerclaw.app.ui.settings

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * BAT-1172 — xAI connection-test error helpers (Settings "Test connection" for Grok).
 * Pins the two gaps CodeRabbit flagged on PR #444: the parse must fall back to top-level
 * `message`, and OAuth users must never be shown xAI's api-key-centric auth copy.
 */
class XaiConnTestHelperTest {

    // NOTE: parseXaiConnErrorMessage (the nested→flat→top-level `message` extraction) is NOT
    // unit-tested here — this module sets `unitTests.isReturnDefaultValues = true`, so the
    // android.jar `org.json.JSONObject` stub returns empty for everything and real parsing can't
    // run without adding an org.json test dependency. That extraction mirrors the Node `_xaiError`
    // helper, which IS covered by tests/nodejs-project/xai.test.js (flat/nested/string/Buffer/null).

    // ── isXaiAuthLikeReason — narrowed (no bare "api key") ──
    @Test fun `auth-like reasons detected`() {
        assertTrue(isXaiAuthLikeReason("Incorrect API key provided."))
        assertTrue(isXaiAuthLikeReason("unauthenticated: bad credentials"))
        assertTrue(isXaiAuthLikeReason("token expired"))
    }

    @Test fun `genuine entitlement reasons are NOT auth-like`() {
        assertFalse(isXaiAuthLikeReason("Access to grok-4.5 is not enabled for your team."))
        assertFalse(isXaiAuthLikeReason("Access requires an xAI API key.")) // narrowed: bare "api key" excluded
        assertFalse(isXaiAuthLikeReason(""))
    }

    // ── xaiConnErrorText — the Major fix: never show OAuth users api-key copy ──
    @Test fun `OAuth 403 with api-key-worded reason maps to reconnect, never api-key text`() {
        val out = xaiConnErrorText(403, "Incorrect API key provided. Obtain one from console.x.ai.", isOAuth = true)
        assertTrue(out.contains("reconnect", ignoreCase = true))
        assertFalse(out.contains("API key", ignoreCase = true))
        assertFalse(out.contains("console.x.ai", ignoreCase = true))
    }

    @Test fun `OAuth 403 with a GENUINE reason surfaces that reason`() {
        val reason = "Access to grok-4.5 is not enabled for your team."
        assertEquals(reason, xaiConnErrorText(403, reason, isOAuth = true))
    }

    @Test fun `api_key 403 surfaces the real reason (api-key users should see it)`() {
        val reason = "Incorrect API key provided. Obtain one from console.x.ai."
        assertEquals(reason, xaiConnErrorText(403, reason, isOAuth = false))
    }

    @Test fun `OAuth 401 auth-like maps to sign-in guidance`() {
        val out = xaiConnErrorText(401, "unauthenticated: bad credentials", isOAuth = true)
        assertTrue(out.contains("sign in", ignoreCase = true))
        assertFalse(out.contains("API key", ignoreCase = true))
    }

    @Test fun `blank body falls back to mode-aware copy`() {
        assertTrue(xaiConnErrorText(403, "", isOAuth = true).contains("reconnect", ignoreCase = true))
        assertTrue(xaiConnErrorText(403, "", isOAuth = false).contains("console.x.ai", ignoreCase = true))
    }

    @Test fun `429 and 5xx are fixed strings, unknown status surfaces the reason`() {
        assertTrue(xaiConnErrorText(429, "whatever", isOAuth = true).contains("Rate limited"))
        assertEquals("xAI unavailable", xaiConnErrorText(503, "boom", isOAuth = true))
        assertEquals("weird thing", xaiConnErrorText(418, "weird thing", isOAuth = true))
    }
}
