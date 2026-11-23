package com.seekerclaw.app.util

import com.seekerclaw.app.bridge.UiForeground
import com.seekerclaw.app.bridge.UiForeground.Proc
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** BAT-1724: the pure liveness reading and the effective-status rule. */
class NodeLivenessTest {

    private val pkg = "com.seekerclaw.app"
    private val main = Proc(pkg, 100, pid = 1000)
    private fun node(pid: Int) = Proc("$pkg:node", 125, pid = pid)

    // ── NodeLiveness.of ──────────────────────────────────────────────

    @Test
    fun `no list, an empty list or a list without our own entry is Unknown`() {
        assertEquals(NodeLiveness.Unknown, NodeLiveness.of(null, pkg))
        assertEquals(NodeLiveness.Unknown, NodeLiveness.of(emptyList(), pkg))
        // A partial list (our own MAIN entry missing) proves nothing about :node.
        assertEquals(NodeLiveness.Unknown, NodeLiveness.of(listOf(Proc("com.other", 100, 5)), pkg))
        assertEquals(NodeLiveness.Unknown, NodeLiveness.of(listOf(node(200)), pkg))
        assertEquals(NodeLiveness.Unknown, NodeLiveness.of(listOf(main), ""))
    }

    @Test
    fun `own entry and no node entry is Absent`() {
        assertEquals(NodeLiveness.Absent, NodeLiveness.of(listOf(main), pkg))
        assertEquals(NodeLiveness.Absent, NodeLiveness.of(listOf(Proc("com.other:node", 125, 7), main), pkg))
    }

    @Test
    fun `own entry plus a node entry is Alive with its pid, in any list order`() {
        assertEquals(NodeLiveness.Alive(200), NodeLiveness.of(listOf(main, node(200)), pkg))
        assertEquals(NodeLiveness.Alive(200), NodeLiveness.of(listOf(node(200), Proc("x", 1, 3), main), pkg))
    }

    @Test
    fun `process names are matched exactly`() {
        val lookalikes = listOf(main, Proc("$pkg:nodeX", 125, 300), Proc("$pkg.extra:node", 125, 301))
        assertEquals(NodeLiveness.Absent, NodeLiveness.of(lookalikes, pkg))
    }

    @Test
    fun `a node entry without a valid pid, or two different pids, is Unknown`() {
        assertEquals(NodeLiveness.Unknown, NodeLiveness.of(listOf(main, node(0)), pkg))
        assertEquals(NodeLiveness.Unknown, NodeLiveness.of(listOf(main, node(-4)), pkg))
        assertEquals(NodeLiveness.Unknown, NodeLiveness.of(listOf(main, node(200), node(201)), pkg))
    }

    @Test
    fun `adding a pid to Proc leaves foreground visibility unchanged`() {
        // UiForeground.isVisible ignores pid; the bridge's foreground decision must not move.
        assertTrue(UiForeground.isVisible(listOf(Proc(pkg, 100)), pkg))
        assertTrue(UiForeground.isVisible(listOf(Proc(pkg, 200, pid = 9)), pkg))
        assertFalse(UiForeground.isVisible(listOf(Proc(pkg, 125, pid = 9)), pkg))
    }

    // ── effectiveStatus ──────────────────────────────────────────────

    @Test
    fun `RUNNING and STARTING follow the decision table`() {
        for (raw in listOf(ServiceStatus.RUNNING, ServiceStatus.STARTING)) {
            assertEquals(ServiceStatus.STOPPED, effectiveStatus(raw, 100, NodeLiveness.Absent))
            assertEquals(ServiceStatus.STOPPED, effectiveStatus(raw, null, NodeLiveness.Absent))
            assertEquals("written by a dead :node", ServiceStatus.STOPPED, effectiveStatus(raw, 100, NodeLiveness.Alive(200)))
            assertEquals(raw, effectiveStatus(raw, 100, NodeLiveness.Alive(100)))
            assertEquals("old file: name-only fallback", raw, effectiveStatus(raw, null, NodeLiveness.Alive(200)))
            assertEquals("keep-on-doubt", raw, effectiveStatus(raw, 100, NodeLiveness.Unknown))
            assertEquals(raw, effectiveStatus(raw, null, NodeLiveness.Unknown))
        }
    }

    @Test
    fun `STOPPED and ERROR are shown as written`() {
        for (raw in listOf(ServiceStatus.STOPPED, ServiceStatus.ERROR)) {
            for (live in listOf(NodeLiveness.Absent, NodeLiveness.Alive(200), NodeLiveness.Unknown)) {
                assertEquals(raw, effectiveStatus(raw, 100, live))
            }
        }
    }
}
