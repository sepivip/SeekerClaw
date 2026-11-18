package com.seekerclaw.app.ui.components

import com.seekerclaw.app.config.ConfigManager
import org.junit.Assert.assertEquals
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
    fun `sign-out - each sync result`() {
        assertEquals(XaiOAuthOutcome(true, null), xaiSignOutOutcome(ConfigManager.XaiAuthSync.SYNCED))
        assertEquals(XaiOAuthOutcome(false, XAI_SIGN_OUT_BUSY), xaiSignOutOutcome(ConfigManager.XaiAuthSync.BUSY))
        assertEquals(XaiOAuthOutcome(false, XAI_SIGN_OUT_NOT_SAVED), xaiSignOutOutcome(ConfigManager.XaiAuthSync.NOT_SAVED))
    }
}
