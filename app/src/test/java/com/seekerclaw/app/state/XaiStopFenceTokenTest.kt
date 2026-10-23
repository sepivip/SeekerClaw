package com.seekerclaw.app.state

import com.seekerclaw.app.util.SafeFs
import com.seekerclaw.app.util.StopToken
import com.seekerclaw.app.util.StopToken.State
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * BAT-1409 P1-A (amendment v3.3 M2, correction v3.4) — the boot reconcile clears the xAI stop
 * fence only when the stop token still equals the start's baseline, read inside the store lock.
 * Drives the real [XaiOAuthTokenStore] against a temp filesDir.
 */
class XaiStopFenceTokenTest {

    private lateinit var dir: File

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("xai-stop-token").toFile()
        XaiOAuthTokenStore.initForTest(dir)
    }

    @After
    fun tearDown() {
        XaiOAuthTokenStore.resetForTest()
        try { SafeFs.deleteTreeNoFollow(dir.toPath().parent, dir.toPath()) } catch (_: Exception) {}
    }

    private val tokenFile get() = File(dir, StopToken.FILE_NAME)

    /** A live family with the stop fence armed on its epoch. */
    private fun armedFence(): Long {
        val signed = XaiOAuthTokenStore.signIn("acc", "ref", "email", "2099-01-01T00:00:00Z")
        val epoch = (signed as XaiOAuthTokenStore.Result.Ok).record.epoch
        assertTrue(XaiOAuthTokenStore.armStopFenceAndProbeRotation(epoch) is XaiOAuthTokenStore.Result.Ok)
        assertEquals(epoch, XaiOAuthTokenStore.read().stopFenceEpoch)
        return epoch
    }

    /** Puts the token file into [s]'s state on disk. */
    private fun setOnDisk(s: State) {
        when (s) {
            State.Absent -> tokenFile.delete()
            is State.Token -> tokenFile.writeText(s.value)
            State.Unreadable -> tokenFile.writeText("not-a-token")
        }
        assertEquals(s, StopToken.read(dir.toPath()))
    }

    @Test
    fun clearsOnlyOnAnExactMatch() {
        val v = State.Token("a".repeat(32))
        val w = State.Token("b".repeat(32))
        val states = listOf(State.Absent, v, w, State.Unreadable)
        for (baseline in states) {
            for (current in states) {
                tearDown()
                setUp()
                val epoch = armedFence()
                setOnDisk(current)
                val r = XaiOAuthTokenStore.clearStopFenceIfUnchanged(baseline)
                val expectClear = StopToken.matches(baseline, current)
                val fence = XaiOAuthTokenStore.read().stopFenceEpoch
                if (expectClear) {
                    assertTrue("$baseline -> $current: $r", r is XaiOAuthTokenStore.Result.Ok)
                    assertEquals("$baseline -> $current clears", -1L, fence)
                } else {
                    assertTrue("$baseline -> $current: $r", r is XaiOAuthTokenStore.Result.Conflict)
                    assertEquals("$baseline -> $current keeps the fence", epoch, fence)
                }
            }
        }
    }

    @Test
    fun aStopTokenWrittenBeforeTheReconcileKeepsTheFence() {
        setOnDisk(State.Absent) // the start's baseline: a first start after the upgrade
        val epoch = armedFence()
        assertTrue(StopToken.writeFresh(dir.toPath())) // the stop's token lands first
        assertTrue(XaiOAuthTokenStore.clearStopFenceIfUnchanged(State.Absent) is XaiOAuthTokenStore.Result.Conflict)
        assertEquals(epoch, XaiOAuthTokenStore.read().stopFenceEpoch)
    }

    @Test
    fun notInitialisedFailsWithoutThrowing() {
        XaiOAuthTokenStore.resetForTest()
        assertTrue(XaiOAuthTokenStore.clearStopFenceIfUnchanged(State.Absent) is XaiOAuthTokenStore.Result.Failed)
        XaiOAuthTokenStore.initForTest(dir)
    }
}
