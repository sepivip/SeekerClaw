package com.seekerclaw.app.service

import com.seekerclaw.app.util.SafeFs
import com.seekerclaw.app.util.StopToken
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * BAT-1409 P1-A (amendment v3.3 M2, correction v3.4) — start fencing. The worker is a real
 * thread held by a latch; "the main looper" is a queue the test drains; a stop is
 * [StopToken.writeFresh] on the real token file, exactly what the companion stop() writes.
 */
class StartCoordinatorTest {

    private lateinit var tmp: Path
    private lateinit var files: Path
    private val main = LinkedBlockingQueue<Runnable>()
    @Volatile private var destroyed = false
    private val events = mutableListOf<String>()

    @Before
    fun setUp() {
        tmp = Files.createTempDirectory("start-coord")
        files = Files.createDirectories(tmp.resolve("files"))
    }

    @After
    fun tearDown() {
        try { SafeFs.deleteTreeNoFollow(tmp.parent, tmp) } catch (_: Exception) {}
    }

    private fun coordinator() = StartCoordinator(
        readToken = { StopToken.read(files) },
        repairToken = { StopToken.writeFresh(files).also { events += "repair" } },
        startWorker = { r -> Thread(r).apply { isDaemon = true }.start() },
        postToMain = { r -> main.put(r) },
        destroyed = { destroyed },
    )

    private val effects = object : StartCoordinator.Effects {
        override fun proceed(fence: StartCoordinator.Fence) { events += "proceed" }
        override fun fail(fence: StartCoordinator.Fence, reason: String) { events += "fail:$reason" }
        override fun abort(fence: StartCoordinator.Fence) { events += "abort" }
    }

    /** Runs the next main-looper message (the continuation). */
    private fun drainOne() {
        val r = main.poll(5, TimeUnit.SECONDS) ?: error("no continuation was posted")
        r.run()
    }

    private fun stop() = assertTrue(StopToken.writeFresh(files))

    /** Starts with a worker held until the returned latch is released. */
    private fun startHeld(c: StartCoordinator, result: StartCoordinator.Verification = StartCoordinator.Verification.Ok): CountDownLatch {
        val gate = CountDownLatch(1)
        assertTrue(c.tryAcquire())
        c.launch({ gate.await(5, TimeUnit.SECONDS); result }, effects)
        return gate
    }

    @Test
    fun freshInstallWithNoTokenFileProceeds() {
        val c = coordinator()
        startHeld(c).countDown()
        drainOne()
        assertEquals(listOf("proceed"), events)
        assertFalse(c.startInProgress)
    }

    @Test
    fun startAfterAnEarlierStopProceeds() {
        stop() // a previous stop left a token; this start's baseline is that token
        val c = coordinator()
        startHeld(c).countDown()
        drainOne()
        assertEquals(listOf("proceed"), events)
    }

    @Test
    fun stopWhileVerificationIsHeldAborts() {
        val c = coordinator()
        val gate = startHeld(c)
        stop()
        gate.countDown()
        drainOne()
        assertEquals(listOf("abort"), events)
        assertFalse(c.startInProgress)
    }

    @Test
    fun restartWhileHeldRunsOnlyTheNewStart() {
        val first = coordinator()
        val gate = startHeld(first)
        stop() // restart = stop (fresh token) ...
        gate.countDown()
        drainOne()
        val second = coordinator() // ... then a new start in a new process
        startHeld(second).countDown()
        drainOne()
        assertEquals(listOf("abort", "proceed"), events)
    }

    @Test
    fun tokenRemovedAfterAPresentBaselineAborts() {
        stop()
        val c = coordinator()
        val gate = startHeld(c)
        Files.delete(files.resolve(StopToken.FILE_NAME))
        gate.countDown()
        drainOne()
        assertEquals(listOf("abort"), events)
    }

    @Test
    fun tokenUnreadableAtContinuationAborts() {
        val c = coordinator()
        val gate = startHeld(c)
        Files.write(files.resolve(StopToken.FILE_NAME), "garbage".toByteArray())
        gate.countDown()
        drainOne()
        assertEquals(listOf("abort"), events)
    }

    @Test
    fun unreadableBaselineFailsWithoutAWorkerAndRepairsTheToken() {
        Files.write(files.resolve(StopToken.FILE_NAME), "garbage".toByteArray())
        val c = coordinator()
        assertTrue(c.tryAcquire())
        var workerRan = false
        c.launch({ workerRan = true; StartCoordinator.Verification.Ok }, effects)
        drainOne()
        assertFalse(workerRan)
        assertEquals(listOf("repair", "fail:${StartCoordinator.STOP_TOKEN_UNREADABLE}"), events)
        assertTrue(StopToken.read(files) is StopToken.State.Token)
        assertFalse(c.startInProgress)
        // The next start proceeds.
        events.clear()
        startHeld(coordinator()).countDown()
        drainOne()
        assertEquals(listOf("proceed"), events)
    }

    @Test
    fun aDirectoryPlantedAtTheTokenPathFailsOneStartOnly() {
        Files.createDirectories(files.resolve(StopToken.FILE_NAME).resolve("x"))
        val c = coordinator()
        assertTrue(c.tryAcquire())
        c.launch({ StartCoordinator.Verification.Ok }, effects)
        drainOne()
        assertEquals(listOf("repair", "fail:${StartCoordinator.STOP_TOKEN_UNREADABLE}"), events)
        events.clear()
        startHeld(coordinator()).countDown()
        drainOne()
        assertEquals("the repair converged, so the next start proceeds", listOf("proceed"), events)
    }

    @Test
    fun unreadableBaselineThenAStopAbortsWithoutError() {
        Files.write(files.resolve(StopToken.FILE_NAME), "garbage".toByteArray())
        val c = coordinator()
        assertTrue(c.tryAcquire())
        c.launch({ StartCoordinator.Verification.Ok }, effects)
        stop() // lands before the posted Failed continuation runs
        drainOne()
        assertEquals("a late Failed after a stop writes nothing", listOf("abort"), events)
    }

    @Test
    fun lateFailedAfterAStopAborts() {
        val c = coordinator()
        val gate = startHeld(c, StartCoordinator.Verification.Failed("BUNDLE"))
        stop()
        gate.countDown()
        drainOne()
        assertEquals(listOf("abort"), events)
    }

    @Test
    fun failedVerificationFailsAndClearsTheFlag() {
        val c = coordinator()
        startHeld(c, StartCoordinator.Verification.Failed("LINK_HYGIENE")).countDown()
        drainOne()
        assertEquals(listOf("fail:LINK_HYGIENE"), events)
        assertFalse(c.startInProgress)
    }

    @Test
    fun aThrowingWorkerFails() {
        val c = coordinator()
        assertTrue(c.tryAcquire())
        c.launch({ throw IllegalStateException("boom") }, effects)
        drainOne()
        assertEquals(listOf("fail:WORKER_IllegalStateException"), events)
        assertFalse(c.startInProgress)
    }

    @Test
    fun destroyedServiceAborts() {
        val c = coordinator()
        val gate = startHeld(c)
        destroyed = true
        gate.countDown()
        drainOne()
        assertEquals(listOf("abort"), events)
    }

    @Test
    fun secondQuickStartChangesNoState() {
        val c = coordinator()
        val gate = startHeld(c)
        assertFalse("single flight", c.tryAcquire())
        assertTrue(main.isEmpty())
        gate.countDown()
        drainOne()
        assertEquals(listOf("proceed"), events)
        assertTrue("the flag is free again after the continuation", c.tryAcquire())
    }

    @Test
    fun releaseFreesAStartThatEndedBeforeLaunch() {
        val c = coordinator()
        assertTrue(c.tryAcquire())
        c.release()
        assertTrue(c.tryAcquire())
    }

    @Test
    fun fenceIsReCheckedInsideTheContinuation() {
        val c = coordinator()
        var heldAtStart = false
        var heldAfterStop = true
        assertTrue(c.tryAcquire())
        c.launch({ StartCoordinator.Verification.Ok }, object : StartCoordinator.Effects {
            override fun proceed(fence: StartCoordinator.Fence) {
                heldAtStart = fence.holds()
                stop() // a stop arrives between continuation steps
                heldAfterStop = fence.holds()
            }
            override fun fail(fence: StartCoordinator.Fence, reason: String) = Unit
            override fun abort(fence: StartCoordinator.Fence) = Unit
        })
        drainOne()
        assertTrue(heldAtStart)
        assertFalse(heldAfterStop)
        assertFalse(c.startInProgress)
    }

    @Test
    fun coordinatorUsesNoAndroidApi() {
        val src = java.io.File("src/main/java/com/seekerclaw/app/service/StartCoordinator.kt")
        assertTrue("run from the app module", src.isFile)
        val code = src.readLines().filterNot { it.trimStart().let { t -> t.startsWith("*") || t.startsWith("/*") || t.startsWith("//") } }
        assertTrue(code.none { Regex("""\bandroid\.""").containsMatchIn(it) })
    }
}
