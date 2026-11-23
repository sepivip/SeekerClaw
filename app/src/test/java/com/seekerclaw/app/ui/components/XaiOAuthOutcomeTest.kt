package com.seekerclaw.app.ui.components

import com.seekerclaw.app.config.ConfigManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * BAT-1661 (CodeRabbit on ca06bb79): after an xAI sign-in or sign-out whose runtime_state sync did
 * not land, Settings must NOT offer "Restart Now" (the restarted agent would start on the previous
 * xAI auth mode); the warning stays. `ModelSelectionSourceGuardTest` pins that the callbacks fire
 * only through these outcomes.
 */
class XaiOAuthOutcomeTest {

    @Test
    fun `sign-in - restarted agent - the prompt fires, no warning`() {
        assertEquals(XaiOAuthOutcome(notify = true, message = null), xaiSignInOutcome(""))
    }

    @Test
    fun `sign-in - settings busy - no prompt, the busy warning stays`() {
        assertEquals(XaiOAuthOutcome(notify = false, message = XAI_RESTART_NEEDED_BUSY), xaiSignInOutcome("busy"))
    }

    @Test
    fun `sign-in - not saved - no prompt, the storage warning stays`() {
        assertEquals(XaiOAuthOutcome(notify = false, message = XAI_RESTART_NEEDED_NOT_SAVED), xaiSignInOutcome("not_saved"))
    }

    @Test
    fun `applyXaiOutcome - the callback runs exactly once when allowed, never otherwise`() {
        var calls = 0
        assertEquals(null, applyXaiOutcome(XaiOAuthOutcome(notify = true, message = null)) { calls++ })
        assertEquals(1, calls)
        assertEquals(XAI_RESTART_NEEDED_BUSY, applyXaiOutcome(xaiSignInOutcome("busy")) { calls++ })
        assertEquals(XAI_RESTART_NEEDED_NOT_SAVED, applyXaiOutcome(xaiSignInOutcome("not_saved")) { calls++ })
        assertEquals(XAI_SIGN_OUT_BUSY, applyXaiOutcome(xaiSignOutOutcome(ConfigManager.XaiAuthSync.BUSY)) { calls++ })
        assertEquals("no prompt for any not-synced outcome", 1, calls)
    }

    @Test
    fun `sign-out - each sync result`() {
        assertEquals(XaiOAuthOutcome(true, null), xaiSignOutOutcome(ConfigManager.XaiAuthSync.SYNCED))
        assertEquals(XaiOAuthOutcome(false, XAI_SIGN_OUT_BUSY), xaiSignOutOutcome(ConfigManager.XaiAuthSync.BUSY))
        assertEquals(XaiOAuthOutcome(false, XAI_SIGN_OUT_NOT_SAVED), xaiSignOutOutcome(ConfigManager.XaiAuthSync.NOT_SAVED))
        assertEquals(XaiOAuthOutcome(false, XAI_SIGN_OUT_HELD), xaiSignOutOutcome(ConfigManager.XaiAuthSync.HELD))
    }

    @Test
    fun `v2_12 m3 - a held sync is its own outcome, never the storage message, and never prompts`() {
        assertEquals(XaiOAuthOutcome(notify = false, message = XAI_RESTART_NEEDED_HELD), xaiSignInOutcome("held"))
        var calls = 0
        assertEquals(XAI_RESTART_NEEDED_HELD, applyXaiOutcome(xaiSignInOutcome("held")) { calls++ })
        assertEquals(XAI_SIGN_OUT_HELD, applyXaiOutcome(xaiSignOutOutcome(ConfigManager.XaiAuthSync.HELD)) { calls++ })
        assertEquals("no restart prompt", 0, calls)
        assertTrue(XAI_RESTART_NEEDED_HELD != XAI_RESTART_NEEDED_NOT_SAVED && !XAI_RESTART_NEEDED_HELD.contains("Free up storage"))
        assertTrue(!XAI_SIGN_OUT_HELD.contains("Free up storage"))
        // CR ff5fc5be: HELD can also be an unreadable retry record — force stop first, then the Logs check.
        for (m in listOf(XAI_RESTART_NEEDED_HELD, XAI_SIGN_OUT_HELD)) {
            assertTrue(m.contains("Force stop the app (Settings > Apps > SeekerClaw) or restart the phone"))
            assertTrue(m.contains("check Logs for a reconcile warning (often full storage)"))
        }
    }
}
