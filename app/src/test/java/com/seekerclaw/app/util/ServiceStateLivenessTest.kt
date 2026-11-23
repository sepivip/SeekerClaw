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
    fun `a probe for an older raw snapshot never publishes, and the newer snapshot probes after it`() {
        // X probes for RUNNING/100; the raw status then changes to RUNNING/300. Fresh probes are
        // serialised, so Y's probe waits for X's; X's stale answer must never be shown.
        writeFile("RUNNING", 100)
        val xEntered = CountDownLatch(1); val xRelease = CountDownLatch(1)
        val calls = AtomicInteger(0)
        ServiceState.nodeLivenessProbe = {
            if (calls.getAndIncrement() == 0) {
                xEntered.countDown(); xRelease.await(5, TimeUnit.SECONDS); NodeLiveness.Alive(100)
            } else {
                NodeLiveness.Absent
            }
        }
        val x = Thread { ServiceState.readFromFileForTest() }.apply { start() }
        assertTrue(xEntered.await(5, TimeUnit.SECONDS))

        writeFile("RUNNING", 300)
        val y = Thread { ServiceState.readFromFileForTest() }.apply { start() }
        y.join(300)
        assertEquals("Y does not sample while X is in the OS", 1, calls.get())

        xRelease.countDown(); x.join(5_000)
        assertTrue("the stale snapshot's answer is never shown", ServiceState.status.value != ServiceStatus.RUNNING)

        y.join(5_000)
        val deadline = System.currentTimeMillis() + 5_000
        while (ServiceState.status.value != ServiceStatus.STOPPED && System.currentTimeMillis() < deadline) Thread.sleep(10)
        assertEquals(ServiceStatus.STOPPED, ServiceState.status.value)
    }

    @Test
    fun `an earlier-issued probe that samples later is never outranked by an earlier sample`() {
        // Codex e0db6a17 #3: probe A is issued first but reaches the OS late; probe B is issued
        // second and samples Alive first; the process then dies and A samples Absent. When the
        // sequence was taken before the OS call, A's later sample carried the OLDER sequence and
        // was dropped at both the cache and the publication, leaving a dead :node shown RUNNING.
        // Fresh probes now take their sequence and sample under one lock, so B cannot sample while
        // A is in the OS: it waits, re-checks the cache and reuses A's answer.
        writeFile("RUNNING", 100)
        val aInOs = CountDownLatch(1); val aRelease = CountDownLatch(1)
        val calls = AtomicInteger(0)
        ServiceState.nodeLivenessProbe = {
            if (calls.getAndIncrement() == 0) {
                aInOs.countDown(); aRelease.await(5, TimeUnit.SECONDS); NodeLiveness.Absent // after the death
            } else {
                NodeLiveness.Alive(100) // a sample from before the death
            }
        }
        val a = Thread { ServiceState.readFromFileForTest() }.apply { start() }
        assertTrue("A was issued and is in the OS", aInOs.await(5, TimeUnit.SECONDS))

        val bDone = CountDownLatch(1)
        val b = Thread { ServiceState.readFromFileForTest(); bDone.countDown() }.apply { start() }
        assertFalse("B cannot sample while A is in the OS", bDone.await(300, TimeUnit.MILLISECONDS))

        aRelease.countDown(); a.join(5_000); b.join(5_000)
        assertEquals("only A sampled; B reused its answer", 1, calls.get())
        assertEquals("the later sample wins", ServiceStatus.STOPPED, ServiceState.status.value)
        // The cache holds that newest sample, for a read inside the window and for a new raw
        // snapshot from the same owner (which publishes unconditionally).
        assertEquals(ServiceStatus.STOPPED, read())
        writeFile("STARTING", 100)
        assertEquals("a same-owner status change sees the newest cached answer", ServiceStatus.STOPPED, read())
        assertEquals(1, calls.get())
    }

    @Test
    fun `a cached older observation cannot overwrite a fresher one, whichever recompute started first`() {
        // CodeRabbit on 3f3dc8d5: recompute A starts first but pauses before reading the clock;
        // recompute B starts later, takes the CACHED Alive and pauses before publishing; the cache
        // expires, A probes Absent and publishes STOPPED; B must not then publish its older Alive.
        writeFile("RUNNING", 100)
        live = NodeLiveness.Alive(100)
        assertEquals(ServiceStatus.RUNNING, read()) // caches Alive (observation 1)

        val aAtClock = CountDownLatch(1); val aClockRelease = CountDownLatch(1)
        val bAtPublish = CountDownLatch(1); val bPublishRelease = CountDownLatch(1)
        lateinit var a: Thread
        lateinit var b: Thread
        ServiceState.elapsedClock = {
            if (Thread.currentThread() === a && aAtClock.count > 0) {
                aAtClock.countDown(); aClockRelease.await(5, TimeUnit.SECONDS)
            }
            now
        }
        ServiceState.beforePublishForTest = {
            if (Thread.currentThread() === b && bAtPublish.count > 0) {
                bAtPublish.countDown(); bPublishRelease.await(5, TimeUnit.SECONDS)
            }
        }
        a = Thread { ServiceState.readFromFileForTest() }
        b = Thread { ServiceState.readFromFileForTest() }
        a.start()
        assertTrue("A started first and is parked before its clock read", aAtClock.await(5, TimeUnit.SECONDS))
        b.start()
        assertTrue("B took the cached Alive and is parked before publishing", bAtPublish.await(5, TimeUnit.SECONDS))

        afterCache(); live = NodeLiveness.Absent // the cache expires; the process is gone
        aClockRelease.countDown(); a.join(5_000)
        assertEquals("A's fresh probe shows the death", ServiceStatus.STOPPED, ServiceState.status.value)

        bPublishRelease.countDown(); b.join(5_000)
        assertEquals("B's older cached observation is discarded", ServiceStatus.STOPPED, ServiceState.status.value)
    }

    @Test
    fun `a newer observation dropped by a generation change is republished on the current snapshot`() {
        // CodeRabbit on d433eb99: X probes fresh (Absent) for the old generation; meanwhile the raw
        // snapshot changes (same owner) and its recompute publishes an older cached Alive. X's newer
        // observation must not be lost at the generation check: it is re-applied to the new snapshot.
        writeFile("RUNNING", 100)
        live = NodeLiveness.Alive(100)
        assertEquals(ServiceStatus.RUNNING, read()) // caches Alive (observation 1)

        val xAtProbe = CountDownLatch(1); val xRelease = CountDownLatch(1)
        lateinit var x: Thread
        val calls = AtomicInteger(0)
        ServiceState.elapsedClock = { if (Thread.currentThread() === x) now + ServiceState.LIVENESS_CACHE_MS else now }
        ServiceState.nodeLivenessProbe = {
            if (calls.getAndIncrement() == 0) { xAtProbe.countDown(); xRelease.await(5, TimeUnit.SECONDS) }
            NodeLiveness.Absent // the process is gone
        }
        x = Thread { ServiceState.readFromFileForTest() } // sees the cache expired: fresh probe
        x.start()
        assertTrue(xAtProbe.await(5, TimeUnit.SECONDS))

        writeFile("STARTING", 100) // a new raw snapshot, same owner
        assertEquals("the new snapshot publishes from the older cached Alive", ServiceStatus.STARTING, read())

        xRelease.countDown(); x.join(5_000) // X's newer Absent arrives for the old generation
        val deadline = System.currentTimeMillis() + 5_000
        while (ServiceState.status.value != ServiceStatus.STOPPED && System.currentTimeMillis() < deadline) Thread.sleep(10)
        assertEquals("the newer observation is re-applied to the current snapshot", ServiceStatus.STOPPED, ServiceState.status.value)
    }

    @Test
    fun `a cache hit keeps its original observation order against a fresher probe in flight`() {
        // A cached Alive (observation 1) is read by B while A's fresh probe (observation 2, Absent)
        // is still in flight. A's newer observation must win even though B publishes first.
        writeFile("RUNNING", 100)
        live = NodeLiveness.Alive(100)
        assertEquals(ServiceStatus.RUNNING, read()) // caches Alive as observation 1

        val aAtProbe = CountDownLatch(1); val aRelease = CountDownLatch(1)
        lateinit var a: Thread
        ServiceState.elapsedClock = { if (Thread.currentThread() === a) now + ServiceState.LIVENESS_CACHE_MS else now }
        ServiceState.nodeLivenessProbe = { aAtProbe.countDown(); aRelease.await(5, TimeUnit.SECONDS); NodeLiveness.Absent }
        a = Thread { ServiceState.readFromFileForTest() } // its clock sees the cache expired: fresh probe
        a.start()
        assertTrue(aAtProbe.await(5, TimeUnit.SECONDS))

        assertEquals("B's cache hit publishes the older observation first", ServiceStatus.RUNNING, read())
        aRelease.countDown(); a.join(5_000)
        assertEquals("A's newer observation wins", ServiceStatus.STOPPED, ServiceState.status.value)
    }

    // ── Codex e0db6a17: init, raw/publish atomicity, read order ─────

    @Test
    fun `a Stop during the first restore never erases a persisted ERROR`() {
        // Codex e0db6a17 #1: the restore marks itself initialized before it publishes. A Stop in
        // that window (finishStop: init() fast path, then the ERROR guard) saw the default STOPPED
        // and wrote STOPPED over the persisted ERROR. The guard now reads the raw snapshot.
        val dir = java.nio.file.Files.createTempDirectory("bat1724-restore").toFile()
        try {
            tmp.delete()
            tmp = File(dir, "service_state") // the restore also writes service_state_day beside it
            ServiceState.setStateFileForTest(tmp)
            writeFile("ERROR", 100)
            val atProjection = CountDownLatch(1); val release = CountDownLatch(1)
            lateinit var restorer: Thread
            ServiceState.afterRestoreForTest = {
                if (Thread.currentThread() === restorer) { atProjection.countDown(); release.await(5, TimeUnit.SECONDS) }
            }
            restorer = Thread { ServiceState.restoreFromDiskForTest() }
            restorer.start()
            assertTrue("restored and initialized, not yet published", atProjection.await(5, TimeUnit.SECONDS))
            assertEquals("the shown status is still the default", ServiceStatus.STOPPED, ServiceState.status.value)

            ServiceState.restoreFromDiskForTest() // finishStop's init(): the fast path returns
            ServiceState.markStoppedUnlessError() // finishStop's guarded Stop

            assertEquals(ServiceStatus.ERROR, ServiceState.rawStatusForTest())
            assertEquals("the file keeps ERROR", "ERROR", tmp.readLines()[0])
            release.countDown(); restorer.join(5_000)
            assertEquals(ServiceStatus.ERROR, ServiceState.status.value)
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `a Stop of a non-ERROR status still writes STOPPED and keeps the owner`() {
        writeFile("RUNNING", 100)
        live = NodeLiveness.Alive(100)
        assertEquals(ServiceStatus.RUNNING, read())
        ServiceState.markStoppedUnlessError()
        assertEquals(ServiceStatus.STOPPED, ServiceState.status.value)
        val lines = tmp.readLines()
        assertEquals("STOPPED", lines[0])
        assertEquals("MAIN keeps the owner pid it read", "100", lines[8])
    }

    @Test
    fun `a raw change cannot land between the generation check and the publish`() {
        // Codex e0db6a17 #2: the generation check and the write of the shown status are one
        // critical section with every raw replacement.
        writeFile("RUNNING", 100)
        live = NodeLiveness.Alive(100)
        val inWindow = CountDownLatch(1); val release = CountDownLatch(1)
        lateinit var older: Thread
        ServiceState.afterPublishCheckForTest = {
            if (Thread.currentThread() === older && inWindow.count > 0) { inWindow.countDown(); release.await(5, TimeUnit.SECONDS) }
        }
        older = Thread { ServiceState.readFromFileForTest() }
        older.start()
        assertTrue("the older recompute passed its check and is about to publish", inWindow.await(5, TimeUnit.SECONDS))

        writeFile("STARTING", 200)
        live = NodeLiveness.Alive(200)
        val newerDone = CountDownLatch(1)
        val newer = Thread { ServiceState.readFromFileForTest(); newerDone.countDown() }.apply { start() }
        assertFalse("the newer snapshot waits for the publication in progress", newerDone.await(300, TimeUnit.MILLISECONDS))
        assertEquals("raw is not replaced inside the window", 100, ServiceState.rawOwnerPidForTest())

        release.countDown(); older.join(5_000); newer.join(5_000)
        assertEquals(ServiceStatus.STARTING, ServiceState.status.value)
    }

    @Test
    fun `an older file read cannot commit after a newer one`() {
        // Codex e0db6a17 #2: overlapping reads (observer, ticker, catch-up) commit in the order
        // they read, so an older read can never land as a new generation after a newer snapshot.
        writeFile("RUNNING", 100)
        live = NodeLiveness.Alive(200)
        val readOld = CountDownLatch(1); val release = CountDownLatch(1)
        lateinit var older: Thread
        ServiceState.afterFileReadForTest = {
            if (Thread.currentThread() === older && readOld.count > 0) { readOld.countDown(); release.await(5, TimeUnit.SECONDS) }
        }
        older = Thread { ServiceState.readFromFileForTest() }
        older.start()
        assertTrue("the older read has RUNNING/100 in hand, uncommitted", readOld.await(5, TimeUnit.SECONDS))

        writeFile("STARTING", 200) // a new :node took over
        val newer = Thread { ServiceState.readFromFileForTest() }.apply { start() }
        newer.join(300) // left unserialised, it would commit STARTING/200 here

        release.countDown(); older.join(5_000); newer.join(5_000)
        assertEquals(ServiceStatus.STARTING, ServiceState.rawStatusForTest())
        assertEquals(200, ServiceState.rawOwnerPidForTest())
        assertEquals(ServiceStatus.STARTING, ServiceState.status.value)
    }

    @Test
    fun `an older file read cannot commit after a Stop`() {
        writeFile("RUNNING", 100)
        live = NodeLiveness.Alive(100)
        val readOld = CountDownLatch(1); val release = CountDownLatch(1)
        lateinit var older: Thread
        ServiceState.afterFileReadForTest = {
            if (Thread.currentThread() === older && readOld.count > 0) { readOld.countDown(); release.await(5, TimeUnit.SECONDS) }
        }
        older = Thread { ServiceState.readFromFileForTest() }
        older.start()
        assertTrue(readOld.await(5, TimeUnit.SECONDS))

        val stop = Thread { ServiceState.markStoppedUnlessError() }.apply { start() }
        stop.join(300) // left unserialised, the Stop would land here and the old read after it

        release.countDown(); older.join(5_000); stop.join(5_000)
        assertEquals(ServiceStatus.STOPPED, ServiceState.rawStatusForTest())
        assertEquals("STOPPED", tmp.readLines()[0])
        assertEquals(ServiceStatus.STOPPED, ServiceState.status.value)
    }

    // ── Source guards ────────────────────────────────────────────────

    @Test
    fun `both Stop paths keep ERROR through the raw snapshot`() {
        val code = SourceText.codeOnly(SourceText.main("com/seekerclaw/app/service/SeekerClawService.kt"))
        assertFalse("no Stop decides on the shown status", code.contains("status.value != ServiceStatus.ERROR"))
        assertEquals("onDestroy and finishStop", 2, Regex("""ServiceState\.markStoppedUnlessError\(\)""").findAll(code).count())
    }

    @Test
    fun `writeToFile serialises the raw snapshot, never the shown status`() {
        val code = SourceText.codeOnly(SourceText.main("com/seekerclaw/app/util/ServiceState.kt"))
        val body = SourceText.flat(code.substring(SourceText.functionBody(code, "writeToFileLocked")))
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
