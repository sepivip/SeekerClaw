package com.seekerclaw.app.service

import com.seekerclaw.app.util.LogLevel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * BAT-1161 P1A gate 1 — the Kotlin half of the one-wire log contract.
 * config.js writes `LEVEL|epochMs|message`; this pins parseNodeDebugLine's matrix,
 * especially the backward-compat cases that would silently lose data if wrong.
 */
class NodeLogParserTest {

    // A fixed "now" so the epoch range check is deterministic. 2026-07-16T10:00Z-ish.
    private val now = 1_784_196_000_000L
    private val goodEpoch = 1_784_100_000_000L // within [floor, now+skew]

    @Test fun `new format — level, event-time, message`() {
        val p = parseNodeDebugLine("INFO|$goodEpoch|hello world", now)
        assertEquals(LogLevel.INFO, p.level)
        assertEquals("hello world", p.message)
        assertEquals(goodEpoch, p.eventTimeMs)
        assertFalse(p.malformedEpoch)
    }

    @Test fun `new format preserves later pipes in the message`() {
        val p = parseNodeDebugLine("WARN|$goodEpoch|a|b|c", now)
        assertEquals(LogLevel.WARN, p.level)
        assertEquals("a|b|c", p.message)
        assertEquals(goodEpoch, p.eventTimeMs)
    }

    @Test fun `legacy no-second-pipe — receipt time, message intact`() {
        val p = parseNodeDebugLine("WARN|just a legacy message", now)
        assertEquals(LogLevel.WARN, p.level)
        assertEquals("just a legacy message", p.message)
        assertNull(p.eventTimeMs)
        assertFalse(p.malformedEpoch)
    }

    @Test fun `bare epoch with NO message must NOT adopt the epoch (the critical MF)`() {
        // `WARN|1784100000000` — absent 2nd pipe ⇒ unconditional legacy. The epoch must
        // stay as the MESSAGE (receipt time), not be consumed leaving an empty message.
        val p = parseNodeDebugLine("WARN|$goodEpoch", now)
        assertEquals(LogLevel.WARN, p.level)
        assertEquals("$goodEpoch", p.message)
        assertNull(p.eventTimeMs)
    }

    @Test fun `legacy message that merely contains a pipe — no epoch, no warn`() {
        val p = parseNodeDebugLine("INFO|user said a|b", now)
        assertEquals(LogLevel.INFO, p.level)
        assertEquals("user said a|b", p.message) // whole remainder preserved
        assertNull(p.eventTimeMs)
        assertFalse(p.malformedEpoch) // NOT flagged — token "user said a" isn't epoch-shaped
    }

    @Test fun `unknown level prefix — whole line as INFO`() {
        val p = parseNodeDebugLine("FOO|bar", now)
        assertEquals(LogLevel.INFO, p.level)
        assertEquals("FOO|bar", p.message)
        assertNull(p.eventTimeMs)
    }

    @Test fun `raw line with no pipe — INFO receipt time`() {
        val p = parseNodeDebugLine("plain node stdout", now)
        assertEquals(LogLevel.INFO, p.level)
        assertEquals("plain node stdout", p.message)
        assertNull(p.eventTimeMs)
    }

    @Test fun `epoch-shaped but future-out-of-range — receipt time + malformed flag`() {
        // 13 digits, but far in the future (> now + skew) ⇒ corrupt, not a real event time.
        val p = parseNodeDebugLine("ERROR|9999999999999|boom", now)
        assertEquals(LogLevel.ERROR, p.level)
        assertNull(p.eventTimeMs)
        assertTrue(p.malformedEpoch)
        assertEquals("9999999999999|boom", p.message) // no content loss
    }

    @Test fun `epoch-shaped but below floor — receipt time + malformed flag`() {
        val p = parseNodeDebugLine("INFO|0000000000123|x", now)
        assertNull(p.eventTimeMs)
        assertTrue(p.malformedEpoch)
    }

    @Test fun `short numeric second token is NOT an epoch (legacy pipe message)`() {
        // "123" — 3 digits, not epoch-shaped ⇒ legacy, whole remainder as message, no warn.
        val p = parseNodeDebugLine("INFO|123|x", now)
        assertNull(p.eventTimeMs)
        assertFalse(p.malformedEpoch)
        assertEquals("123|x", p.message)
    }

    @Test fun `clock-skew tolerance — slightly-future epoch within skew is accepted`() {
        val p = parseNodeDebugLine("INFO|${now + 60_000L}|soon", now)
        assertEquals(now + 60_000L, p.eventTimeMs)
        assertFalse(p.malformedEpoch)
    }

    @Test fun `empty message after epoch is allowed`() {
        val p = parseNodeDebugLine("INFO|$goodEpoch|", now)
        assertEquals("", p.message)
        assertEquals(goodEpoch, p.eventTimeMs)
    }
}

/**
 * BAT-1161 P1A gate 3 — the rotation-decision matrix (inode identity). Pins the forwarder's
 * branch selection without needing a real filesystem / Os.stat.
 */
class NodeLogRotationDecisionTest {

    @Test fun `top action — missing current file`() {
        assertEquals(NodeLogTopAction.MISSING, nodeDebugTopAction(currentInode = -1L, trackedInode = 100L))
        assertEquals(NodeLogTopAction.MISSING, nodeDebugTopAction(currentInode = -1L, trackedInode = -1L))
    }

    @Test fun `top action — rotation when inode changed`() {
        assertEquals(NodeLogTopAction.ROTATED, nodeDebugTopAction(currentInode = 200L, trackedInode = 100L))
    }

    @Test fun `top action — first-drain adopt when nothing tracked yet`() {
        assertEquals(NodeLogTopAction.ADOPT_FIRST, nodeDebugTopAction(currentInode = 200L, trackedInode = -1L))
    }

    @Test fun `top action — continue when same inode`() {
        assertEquals(NodeLogTopAction.CONTINUE, nodeDebugTopAction(currentInode = 100L, trackedInode = 100L))
    }

    @Test fun `rotate action — old is our generation, drain its tail`() {
        assertEquals(NodeLogRotateAction.DRAIN_OLD_TAIL, nodeDebugRotateAction(oldInode = 100L, trackedInode = 100L))
    }

    @Test fun `rotate action — old already gone, pure gap`() {
        assertEquals(NodeLogRotateAction.GAP_NONE, nodeDebugRotateAction(oldInode = -1L, trackedInode = 100L))
    }

    @Test fun `rotate action — old is a newer gen, our gen was evicted`() {
        assertEquals(NodeLogRotateAction.GAP_EVICTED, nodeDebugRotateAction(oldInode = 300L, trackedInode = 100L))
    }
}
