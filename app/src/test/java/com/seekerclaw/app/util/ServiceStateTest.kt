package com.seekerclaw.app.util

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import java.io.File

/**
 * Pure JVM tests for ServiceState's `service_state` file parse/write.
 *
 * Phase 2 of BAT-518 (BAT-522) added a new line 7 holding the
 * `serviceStartTimeMs`, and demoted line 1 (legacy uptime) to a
 * placeholder always written as 0L. These tests pin the upgrade
 * compatibility:
 *
 *   - new build reading a pre-BAT-522 file (5 or 7 lines) does not
 *     crash and defaults `serviceStartTimeMs` to 0L
 *   - new build round-trips its own writes (8 lines) cleanly
 *   - the legacy uptime line is read-tolerant: any value there is
 *     ignored, the new build never displays it
 */
class ServiceStateTest {

    private lateinit var tmp: File

    @Before
    fun setUp() {
        tmp = File.createTempFile("bat522-state", ".test")
        ServiceState.setStateFileForTest(tmp)
        ServiceState.resetForTest()
    }

    @After
    fun tearDown() {
        ServiceState.setStateFileForTest(null)
        ServiceState.resetForTest()
        tmp.delete()
    }

    @Test
    fun `read tolerates legacy 5-line format and defaults serviceStartTime to 0`() {
        // Pre-tokens, pre-BAT-522 layout. lines[1] = uptime millis (ignored
        // by new build). lines[5..] = absent.
        tmp.writeText("RUNNING\n42000\n10\n3\n1700000000000\n")

        ServiceState.readFromFileForTest()

        assertEquals(ServiceStatus.RUNNING, ServiceState.status.value)
        assertEquals(10, ServiceState.messageCount.value)
        assertEquals(3, ServiceState.messagesToday.value)
        assertEquals(1700000000000L, ServiceState.lastActivityTime.value)
        assertEquals(0L, ServiceState.tokensToday.value)
        assertEquals(0L, ServiceState.tokensTotal.value)
        // No line 7 — defaults to 0L. UI will render uptime as 00h 00m 00s
        // until the next service start writes a fresh start timestamp.
        assertEquals(0L, ServiceState.serviceStartTimeMs.value)
    }

    @Test
    fun `read tolerates legacy 7-line format with tokens and no start time`() {
        // Pre-BAT-522 file with tokens but no line 7 yet.
        tmp.writeText("RUNNING\n42000\n10\n3\n1700000000000\n12345\n67890\n")

        ServiceState.readFromFileForTest()

        assertEquals(ServiceStatus.RUNNING, ServiceState.status.value)
        assertEquals(10, ServiceState.messageCount.value)
        assertEquals(12345L, ServiceState.tokensToday.value)
        assertEquals(67890L, ServiceState.tokensTotal.value)
        assertEquals(0L, ServiceState.serviceStartTimeMs.value)
    }

    @Test
    fun `read picks up line 7 when present`() {
        val startTime = 1_700_000_500_000L
        tmp.writeText("RUNNING\n0\n10\n3\n1700000000000\n12345\n67890\n$startTime")

        ServiceState.readFromFileForTest()

        assertEquals(startTime, ServiceState.serviceStartTimeMs.value)
    }

    @Test
    fun `write produces an 8-line file with start time at line 7`() {
        ServiceState.updateStatus(ServiceStatus.RUNNING)
        ServiceState.setServiceStartTimeMs(1_700_000_500_000L)

        val lines = tmp.readLines()
        assertEquals(8, lines.size)
        assertEquals("RUNNING", lines[0])
        assertEquals("0", lines[1]) // legacy uptime placeholder
        assertEquals("1700000500000", lines[7])
    }

    @Test
    fun `write then read round-trips serviceStartTimeMs`() {
        val startTime = 1_700_000_500_000L
        ServiceState.updateStatus(ServiceStatus.RUNNING)
        ServiceState.setServiceStartTimeMs(startTime)

        ServiceState.resetForTest()
        ServiceState.readFromFileForTest()

        assertEquals(ServiceStatus.RUNNING, ServiceState.status.value)
        assertEquals(startTime, ServiceState.serviceStartTimeMs.value)
    }

    @Test
    fun `setting serviceStartTimeMs to 0 persists across read`() {
        ServiceState.updateStatus(ServiceStatus.RUNNING)
        ServiceState.setServiceStartTimeMs(1_700_000_500_000L)
        ServiceState.setServiceStartTimeMs(0L)

        ServiceState.resetForTest()
        ServiceState.readFromFileForTest()

        assertEquals(0L, ServiceState.serviceStartTimeMs.value)
    }

    @Test
    fun `legacy uptime value at line 1 is ignored`() {
        // Old build wrote an actual uptime here; new build must not
        // surface it as serviceStartTimeMs or anywhere else.
        tmp.writeText("RUNNING\n999999\n0\n0\n0\n0\n0\n")

        ServiceState.readFromFileForTest()

        // No public field maps to the legacy uptime — verify the new
        // start-time field stayed at default since the file lacks
        // line 7.
        assertEquals(0L, ServiceState.serviceStartTimeMs.value)
    }
}
