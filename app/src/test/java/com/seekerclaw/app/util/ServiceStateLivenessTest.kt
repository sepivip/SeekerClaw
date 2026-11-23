package com.seekerclaw.app.util

import com.seekerclaw.app.SourceText
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * BAT-1724: MAIN shows a RUNNING / STARTING from `service_state` only while the `:node` process that
 * wrote it is alive. A force-stop (or LMK kill, app update) leaves RUNNING on disk with nothing alive;
 * the dashboard must then show STOPPED — without ever writing that back to the file.
 */
class ServiceStateLivenessTest {

    private lateinit var tmp: File
    private var now = 10_000L
    private val probeCalls = AtomicInteger(0)
    @Volatile private var live: NodeLiveness = NodeLiveness.Unknown

    @Before
    fun setUp() {
        tmp = File.createTempFile("bat1724-state", ".test")
        ServiceState.setStateFileForTest(tmp)
        ServiceState.resetForTest()
        ProcessRole.setForTest(false) // MAIN
        ServiceState.isMainThread = { false }
        ServiceState.elapsedClock = { now }
        ServiceState.nodeLivenessProbe = { probeCalls.incrementAndGet(); live }
    }

    @After
    fun tearDown() {
        ProcessRole.setForTest(null)
        ServiceState.setStateFileForTest(null)
        ServiceState.resetForTest()
        tmp.delete()
    }

    /** A file as a `:node` of this build writes it (line 8 = owner pid), or an older build (no pid). */
    private fun writeFile(status: String, ownerPid: Int?) {
        val base = "$status\n0\n10\n3\n1700000000000\n12345\n67890\n1700000500000"
        tmp.writeText(if (ownerPid == null) base else "$base\n$ownerPid")
    }

    private fun read(): ServiceStatus {
        ServiceState.readFromFileForTest()
        return ServiceState.status.value
    }

    private fun afterCache() { now += ServiceState.LIVENESS_CACHE_MS }

    // ── The decision, through ServiceState ───────────────────────────

    @Test
    fun `RUNNING written by pid 100 follows the liveness of pid 100`() {
        writeFile("RUNNING", 100)
        live = NodeLiveness.Alive(100); assertEquals(ServiceStatus.RUNNING, read())
        afterCache(); live = NodeLiveness.Alive(200); assertEquals("a different :node is alive", ServiceStatus.STOPPED, read())
        afterCache(); live = NodeLiveness.Absent; assertEquals("force-stopped", ServiceStatus.STOPPED, read())
        afterCache(); live = NodeLiveness.Unknown; assertEquals("keep-on-doubt", ServiceStatus.RUNNING, read())
    }

    @Test
    fun `STARTING whose writer is gone shows STOPPED, not ERROR`() {
        writeFile("STARTING", 100)
        live = NodeLiveness.Absent
        assertEquals(ServiceStatus.STOPPED, read())
    }

    @Test
    fun `a file from an older build falls back to the process name`() {
        writeFile("RUNNING", null)
        live = NodeLiveness.Alive(200); assertEquals(ServiceStatus.RUNNING, read())
        afterCache(); live = NodeLiveness.Absent; assertEquals(ServiceStatus.STOPPED, read())
    }

    @Test
    fun `STOPPED and ERROR are shown as written and never probe`() {
        live = NodeLiveness.Absent
        writeFile("ERROR", 100); assertEquals(ServiceStatus.ERROR, read())
        writeFile("STOPPED", 100); assertEquals(ServiceStatus.STOPPED, read())
        assertEquals("no binder call for an inactive status", 0, probeCalls.get())
    }

    @Test
    fun `no probe context means Unknown, so the file value is shown`() {
        ServiceState.resetForTest() // restores the real default probe, with no captured context
        ServiceState.setStateFileForTest(tmp)
        ProcessRole.setForTest(false)
        ServiceState.isMainThread = { false }
        writeFile("RUNNING", 100)
        assertEquals(ServiceStatus.RUNNING, read())
    }

    @Test
    fun `a probe that throws is Unknown`() {
        ServiceState.nodeLivenessProbe = { throw SecurityException("denied") }
        writeFile("RUNNING", 100)
        assertEquals(ServiceStatus.RUNNING, read())
    }

    // ── Raw vs effective: nothing leaks into the file ────────────────

    @Test
    fun `a downgraded status is never written back`() {
        writeFile("RUNNING", 100)
        live = NodeLiveness.Absent
        assertEquals(ServiceStatus.STOPPED, read())

        ServiceState.setServiceStartTimeMs(5L)
        ServiceState.writeToFileForTest()

        val lines = tmp.readLines()
        assertEquals("line 0 stays the raw status", "RUNNING", lines[0])
        assertEquals("line 8 stays the raw owner", "100", lines[8])
        assertEquals("5", lines[7])
    }

    @Test
    fun `MAIN's own Stop keeps the owner pid it read and never stamps its own`() {
        ServiceState.myPid = { 999 }
        writeFile("RUNNING", 100)
        live = NodeLiveness.Alive(100); read()

        ServiceState.updateStatus(ServiceStatus.STOPPED)

        val lines = tmp.readLines()
        assertEquals("STOPPED", lines[0])
        assertEquals("100", lines[8])
        assertEquals(ServiceStatus.STOPPED, ServiceState.status.value)
    }

    // ── :node: no override; the pid moves only with a status change ──

    @Test
    fun `in node the raw status is shown and the probe is never called`() {
        ProcessRole.setForTest(true)
        writeFile("RUNNING", 100)
        live = NodeLiveness.Absent
        assertEquals(ServiceStatus.RUNNING, read())
        assertEquals(0, probeCalls.get())
    }

    @Test
    fun `a new node does not adopt an old RUNNING until it writes its own status`() {
        // Codex b5602e77 clarification 1: restore RUNNING/100 in a new :node with pid 200.
        ProcessRole.setForTest(true)
        ServiceState.myPid = { 200 }
        writeFile("RUNNING", 100)
        read()

        // Writes that are not status changes carry the old owner.
        ServiceState.setServiceStartTimeMs(1L)
        ServiceState.incrementMessages()
        ServiceState.addTokens(7)
        var lines = tmp.readLines()
        assertEquals("RUNNING", lines[0])
        assertEquals("non-status writes never relabel the owner", "100", lines[8])
        assertEquals(100, ServiceState.rawOwnerPidForTest())

        // The explicit status change adopts the new pid.
        ServiceState.updateStatus(ServiceStatus.STARTING)
        lines = tmp.readLines()
        assertEquals("STARTING", lines[0])
        assertEquals("200", lines[8])
    }

    @Test
    fun `in the pre-STARTING window MAIN shows STOPPED, then follows the new node`() {
        // :node 200 is alive but has not written STARTING yet: the file still says RUNNING/100.
        writeFile("RUNNING", 100)
        live = NodeLiveness.Alive(200)
        assertEquals("no false Online in the start window", ServiceStatus.STOPPED, read())

        writeFile("STARTING", 200) // its explicit status write
        assertEquals("a new owner is re-probed at once", ServiceStatus.STARTING, read())
    }

    // ── Probe cache ──────────────────────────────────────────────────

    @Test
    fun `the probe answer is reused within the cache window and refreshed after it`() {
        writeFile("RUNNING", 100)
        live = NodeLiveness.Alive(100)
        read(); read(); read()
        assertEquals("one binder call per cache window", 1, probeCalls.get())

        afterCache(); read()
        assertEquals(2, probeCalls.get())
    }

    @Test
    fun `a death right after a cached probe shows within one cache window`() {
        writeFile("RUNNING", 100)
        live = NodeLiveness.Alive(100)
        assertEquals(ServiceStatus.RUNNING, read()) // cached at t0

        live = NodeLiveness.Absent // :node dies just after the probe
        now += ServiceState.LIVENESS_CACHE_MS - 1
        assertEquals("still inside the cache window", ServiceStatus.RUNNING, read())
        now += 1
        assertEquals("at the window boundary the death shows", ServiceStatus.STOPPED, read())
    }

    @Test
    fun `an owner change re-probes even inside the cache window`() {
        writeFile("RUNNING", 100)
        live = NodeLiveness.Alive(100); read()
        writeFile("RUNNING", 300)
        live = NodeLiveness.Alive(300)
        assertEquals(ServiceStatus.RUNNING, read())
        assertEquals(2, probeCalls.get())
    }

    @Test
    fun `a clock that went backwards does not keep the cache`() {
        writeFile("RUNNING", 100)
        live = NodeLiveness.Alive(100); read()
        now -= 5_000
        live = NodeLiveness.Absent
        assertEquals(ServiceStatus.STOPPED, read())
        assertEquals(2, probeCalls.get())
    }

    // ── Every read exit recomputes; the ticker reads the file ─────────

    @Test
    fun `a missing or unparseable file still re-evaluates the last raw status`() {
        writeFile("RUNNING", 100)
        live = NodeLiveness.Alive(100); assertEquals(ServiceStatus.RUNNING, read())

        afterCache(); live = NodeLiveness.Absent
        tmp.delete()
        assertEquals("missing file", ServiceStatus.STOPPED, read())

        afterCache(); live = NodeLiveness.Alive(100)
        tmp.writeText("garbage")
        assertEquals("unparseable file", ServiceStatus.RUNNING, read())
    }

    @Test
    fun `a tick notices a death with no file event`() {
        writeFile("RUNNING", 100)
        live = NodeLiveness.Alive(100); read()

        afterCache(); live = NodeLiveness.Absent
        ServiceState.tickOnce()
        assertEquals(ServiceStatus.STOPPED, ServiceState.status.value)

        afterCache(); live = NodeLiveness.Alive(100)
        ServiceState.tickOnce()
        assertEquals(ServiceStatus.RUNNING, ServiceState.status.value)
    }

    // ── Threads ──────────────────────────────────────────────────────

    @Test
    fun `the probe never runs on the main thread, and an off-main recompute follows`() {
        val testThread = Thread.currentThread()
        ServiceState.isMainThread = { Thread.currentThread() === testThread }
        val probeThreads = mutableListOf<Thread>()
        val release = CountDownLatch(1) // holds the off-main probe until the raw value is checked
        ServiceState.nodeLivenessProbe = {
            synchronized(probeThreads) { probeThreads += Thread.currentThread() }
            release.await(5, TimeUnit.SECONDS)
            NodeLiveness.Absent
        }
        writeFile("RUNNING", 100)

        assertEquals("on the main thread the raw value is shown", ServiceStatus.RUNNING, read())
        release.countDown()
        val deadline = System.currentTimeMillis() + 5_000
        while (ServiceState.status.value != ServiceStatus.STOPPED && System.currentTimeMillis() < deadline) Thread.sleep(10)

        assertEquals("the scheduled off-main recompute applied the probe", ServiceStatus.STOPPED, ServiceState.status.value)
        synchronized(probeThreads) {
            assertTrue("probed at least once", probeThreads.isNotEmpty())
            assertFalse("never on the main thread", probeThreads.any { it === testThread })
        }
    }

    @Test
    fun `a slow probe for an older raw status cannot overwrite a newer one`() {
        writeFile("RUNNING", 100)
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        ServiceState.nodeLivenessProbe = { entered.countDown(); release.await(5, TimeUnit.SECONDS); NodeLiveness.Alive(100) }

        val slow = Thread { ServiceState.readFromFileForTest() }.apply { start() }
        assertTrue(entered.await(5, TimeUnit.SECONDS))

        // While the slow probe is in flight, the agent is stopped (a newer raw status).
        writeFile("STOPPED", 100)
        assertEquals(ServiceStatus.STOPPED, read())

        release.countDown(); slow.join(5_000)
        assertEquals("the stale RUNNING is discarded", ServiceStatus.STOPPED, ServiceState.status.value)
    }

    @Test
    fun `a probe for an older raw snapshot cannot publish while the newer one is still probing`() {
        // X probes for RUNNING/100; the raw status then changes to RUNNING/300, whose own probe (Y)
        // is still in flight when X finishes. X must not publish its stale answer in between.
        writeFile("RUNNING", 100)
        val xEntered = CountDownLatch(1); val xRelease = CountDownLatch(1)
        val yEntered = CountDownLatch(1); val yRelease = CountDownLatch(1)
        val calls = AtomicInteger(0)
        ServiceState.nodeLivenessProbe = {
            if (calls.getAndIncrement() == 0) {
                xEntered.countDown(); xRelease.await(5, TimeUnit.SECONDS); NodeLiveness.Alive(100)
            } else {
                yEntered.countDown(); yRelease.await(5, TimeUnit.SECONDS); NodeLiveness.Absent
            }
        }
        val x = Thread { ServiceState.readFromFileForTest() }.apply { start() }
        assertTrue(xEntered.await(5, TimeUnit.SECONDS))

        writeFile("RUNNING", 300)
        val y = Thread { ServiceState.readFromFileForTest() }.apply { start() }
        assertTrue(yEntered.await(5, TimeUnit.SECONDS))

        xRelease.countDown(); x.join(5_000)
        assertEquals("the stale snapshot's answer is never shown", ServiceStatus.STOPPED, ServiceState.status.value)

        yRelease.countDown(); y.join(5_000)
        assertEquals(ServiceStatus.STOPPED, ServiceState.status.value)
    }

    @Test
    fun `a newer recompute holding an older probe answer publishes the newest observation`() {
        // CodeRabbit on 18de5316: recompute B (newer sequence) can start its probe BEFORE recompute
        // A (older sequence). A's probe answers later but is the newer observation (Absent); B's
        // older answer (Alive) must not be published over it because B's recompute is newer.
        writeFile("RUNNING", 100)
        val aAtClock = CountDownLatch(1); val aClockRelease = CountDownLatch(1)
        val bAtProbe = CountDownLatch(1); val bProbeRelease = CountDownLatch(1)
        lateinit var a: Thread
        ServiceState.elapsedClock = {
            if (Thread.currentThread() === a && aAtClock.count > 0) {
                aAtClock.countDown(); aClockRelease.await(5, TimeUnit.SECONDS)
            }
            now
        }
        val calls = AtomicInteger(0)
        ServiceState.nodeLivenessProbe = {
            if (calls.getAndIncrement() == 0) {
                bAtProbe.countDown(); bProbeRelease.await(5, TimeUnit.SECONDS); NodeLiveness.Alive(100) // older observation
            } else {
                NodeLiveness.Absent // newer observation: the process is gone
            }
        }
        a = Thread { ServiceState.readFromFileForTest() }
        a.start()
        assertTrue("A holds its recompute sequence, before probing", aAtClock.await(5, TimeUnit.SECONDS))

        val b = Thread { ServiceState.readFromFileForTest() }.apply { start() } // newer sequence, probes first
        assertTrue(bAtProbe.await(5, TimeUnit.SECONDS))

        aClockRelease.countDown(); a.join(5_000) // A probes second (newer observation) and publishes
        assertEquals(ServiceStatus.STOPPED, ServiceState.status.value)

        bProbeRelease.countDown(); b.join(5_000) // B's older answer arrives last
        assertEquals("the newest observation wins", ServiceStatus.STOPPED, ServiceState.status.value)
    }

    @Test
    fun `an older probe completion cannot overwrite a newer one for the same raw status`() {
        writeFile("RUNNING", 100)
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val first = AtomicInteger(0)
        ServiceState.nodeLivenessProbe = {
            if (first.getAndIncrement() == 0) {
                entered.countDown(); release.await(5, TimeUnit.SECONDS); NodeLiveness.Alive(100) // stale "alive"
            } else {
                NodeLiveness.Absent // the newer, true answer
            }
        }
        val slow = Thread { ServiceState.readFromFileForTest() }.apply { start() }
        assertTrue(entered.await(5, TimeUnit.SECONDS))

        assertEquals("the newer probe publishes first", ServiceStatus.STOPPED, read())

        release.countDown(); slow.join(5_000)
        assertEquals("the older completion is discarded", ServiceStatus.STOPPED, ServiceState.status.value)
        // Nor may the stale answer be cached over the newer one: a read inside the window agrees.
        assertEquals("the cache keeps the newer answer", ServiceStatus.STOPPED, read())
    }

    // ── Source guards ────────────────────────────────────────────────

    @Test
    fun `writeToFile serialises the raw snapshot, never the shown status`() {
        val code = SourceText.codeOnly(SourceText.main("com/seekerclaw/app/util/ServiceState.kt"))
        val body = SourceText.flat(code.substring(SourceText.functionBody(code, "writeToFile")))
        assertTrue("reads one raw snapshot", body.contains("val snap = raw"))
        assertTrue("line 0 is the raw status", body.contains("appendLine(snap.status.name)"))
        assertFalse("never the shown status: $body", body.contains("_status"))
        assertTrue("line 8 is the raw owner", body.contains("snap.ownerPid"))
    }

    @Test
    fun `the first restore never holds initLock across the liveness check`() {
        // Codex b5602e77 clarification 2: no broad lock across the ActivityManager call. A
        // main-thread init() waits on initLock during the first restore.
        val code = SourceText.codeOnly(SourceText.main("com/seekerclaw/app/util/ServiceState.kt"))
        val restore = code.substring(SourceText.functionBody(code, "restoreFromDisk"))
        val lockStart = restore.indexOf("synchronized(initLock)")
        assertTrue("restoreFromDisk takes initLock", lockStart >= 0)
        val locked = restore.substring(SourceText.braceBlockAfter(restore, lockStart))
        assertFalse("no readFromFile (which recomputes) under initLock", Regex("""\breadFromFile\(""").containsMatchIn(locked))
        assertFalse("no recompute under initLock", locked.contains("recomputeStatus("))
        val after = restore.substring(restore.indexOf("synchronized(initLock)"))
        assertTrue("the restore still recomputes, after the lock", after.contains("recomputeStatus()"))
    }

    @Test
    fun `the staleness ticker reads service_state through tickOnce`() {
        val code = SourceText.codeOnly(SourceText.main("com/seekerclaw/app/util/ServiceState.kt"))
        val ticker = SourceText.flat(code.substring(SourceText.functionBody(code, "startStalenessTicker")))
        assertTrue("the loop calls tickOnce: $ticker", ticker.contains("tickOnce()"))
        val tick = SourceText.flat(code.substring(SourceText.functionBody(code, "tickOnce")))
        assertTrue("tickOnce reads service_state", tick.contains("readFromFile()"))
    }

    @Test
    fun `the restored default seams leave no test state behind`() {
        ServiceState.resetForTest()
        assertNull(ServiceState.rawOwnerPidForTest())
        assertEquals(ServiceStatus.STOPPED, ServiceState.status.value)
    }
}
