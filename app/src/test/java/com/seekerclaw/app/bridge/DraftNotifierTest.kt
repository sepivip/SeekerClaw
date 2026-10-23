package com.seekerclaw.app.bridge

import android.app.PendingIntent
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.seekerclaw.app.bridge.DraftNotifier.Kind
import com.seekerclaw.app.bridge.DraftNotifier.Outcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.SecureRandom
import java.util.Random

/**
 * BAT-1409 P1-H — what a draft notification is built from ([DraftNotifier.spec]) and what
 * [DraftNotifier.post] does with what Android reports ([DraftSystem], faked here). The
 * contract's §5 "pure spec builder" and "outcome matrix" items.
 */
class DraftNotifierTest {

    private val number = "+15551234567"
    private val time = "14:05"

    /** A draw that returns [values] in order and fails the test if asked for more. */
    private class Draws(vararg values: Int) : () -> Int {
        private val queue = ArrayDeque(values.toList())
        var calls = 0
            private set

        override fun invoke(): Int {
            calls++
            return queue.removeFirstOrNull() ?: throw AssertionError("drew more ids than expected")
        }
    }

    private fun sms(body: String, active: Set<Int>, draw: () -> Int, to: String = number) =
        DraftNotifier.spec(Kind.SMS, to, body, time, active, draw)

    // ── The pure spec builder ───────────────────────────────────────────────

    @Test
    fun `two drafts to the same number get distinct ids, each its own request code and body`() {
        val draw = Draws(123_456, 123_456, 234_567) // the second draft is drawn the first one's id first
        val first = sms("first body", emptySet(), draw)
        val second = sms("second body", setOf(first.id), draw)
        assertNotEquals(first.id, second.id)
        assertEquals(first.id, first.requestCode)
        assertEquals(second.id, second.requestCode)
        assertEquals(mapOf("sms_body" to "first body"), first.extras)
        assertEquals(mapOf("sms_body" to "second body"), second.extras)
    }

    @Test
    fun `a draft to a second number never reuses an outstanding draft's id`() {
        val draw = Draws(500_000, 500_000, 600_000)
        val first = sms("hi", emptySet(), draw, to = "+15551234567")
        val second = sms("hi", setOf(first.id), draw, to = "+995599123456")
        assertEquals(500_000, first.id)
        assertEquals(600_000, second.id)
        assertEquals(600_000, second.requestCode)
        assertEquals("+995599123456", second.number)
    }

    @Test
    fun `an id colliding with an active notification is redrawn (drafts from before a node restart)`() {
        val active = setOf(300_000, 300_001)
        val draw = Draws(300_000, 300_001, 300_000, 777_777)
        val spec = sms("x", active, draw)
        assertEquals(777_777, spec.id)
        assertEquals(777_777, spec.requestCode)
        assertEquals(4, draw.calls)
    }

    @Test
    fun `the PendingIntent flags are IMMUTABLE, ONE_SHOT and CANCEL_CURRENT`() {
        for (kind in Kind.values()) {
            val spec = DraftNotifier.spec(kind, number, "b", time, emptySet(), Draws(100_000))
            assertEquals(PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_CANCEL_CURRENT, spec.pendingIntentFlags)
            // The literal value, so a stubbed (zero) constant cannot make the assertion vacuous.
            assertEquals(0x04000000 or 0x40000000 or 0x10000000, spec.pendingIntentFlags)
        }
    }

    @Test
    fun `an SMS draft opens SENDTO smsto with the body in sms_body, a call draft DIAL tel with no body`() {
        val s = DraftNotifier.spec(Kind.SMS, number, "see you at 5", time, emptySet(), Draws(100_001))
        assertEquals(Intent.ACTION_SENDTO, s.action)
        assertEquals("android.intent.action.SENDTO", s.action)
        assertEquals("smsto", s.uriScheme)
        assertEquals(number, s.number)
        assertEquals(mapOf("sms_body" to "see you at 5"), s.extras)
        assertEquals(0x10000000, s.intentFlags) // FLAG_ACTIVITY_NEW_TASK
        assertEquals(Intent.FLAG_ACTIVITY_NEW_TASK, s.intentFlags)

        val c = DraftNotifier.spec(Kind.CALL, number, "ignored for a call", time, emptySet(), Draws(100_002))
        assertEquals("android.intent.action.DIAL", c.action)
        assertEquals("tel", c.uriScheme)
        assertEquals(number, c.number)
        assertEquals(emptyMap<String, String>(), c.extras)
        assertEquals(0x10000000, c.intentFlags)

        // A missing SMS body travels as "" (as before), never as a missing extra.
        assertEquals(mapOf("sms_body" to ""), DraftNotifier.spec(Kind.SMS, number, null, time, emptySet(), Draws(100_003)).extras)
    }

    @Test
    fun `the label is the Kotlin template and carries neither the body nor the number`() {
        val body = "PIN 4821, meet at 19 Rustaveli"
        val s = DraftNotifier.spec(Kind.SMS, number, body, time, emptySet(), Draws(100_004))
        val c = DraftNotifier.spec(Kind.CALL, number, body, time, emptySet(), Draws(100_005))
        val digits = number.filter { it.isDigit() }
        for (spec in listOf(s, c)) {
            assertFalse("title carries the body", spec.title.contains(body))
            for (i in 0..digits.length - 3) {
                val run = digits.substring(i, i + 3)
                assertFalse("title carries the digit run $run of the number", spec.title.contains(run))
            }
            assertFalse("toString must not print the number", spec.toString().contains(digits.takeLast(4)))
            assertFalse("toString must not print the body", spec.toString().contains("PIN"))
        }
        assertEquals("Message draft · 14:05 — tap to review", s.title)
        assertEquals("Call draft · 14:05 — tap to review", c.title)
    }

    @Test
    fun `drafts are local only, expire after 15 minutes, auto-cancel, high priority, on the drafts channel`() {
        for (kind in Kind.values()) {
            val spec = DraftNotifier.spec(kind, number, "b", time, emptySet(), Draws(100_006))
            assertTrue(spec.localOnly)
            assertEquals(15 * 60_000L, spec.timeoutMs)
            assertTrue(spec.autoCancel)
            assertEquals(NotificationCompat.PRIORITY_HIGH, spec.priority)
            assertEquals(1, spec.priority)
            assertEquals("seekerclaw_drafts", spec.channelId)
        }
    }

    @Test
    fun `ids are drawn in DRAFT_ID_MIN until Int MAX_VALUE`() {
        val bounds = mutableListOf<Int>()
        val lowest = object : Random() {
            override fun nextInt(bound: Int): Int { bounds += bound; return 0 }
        }
        val highest = object : Random() {
            override fun nextInt(bound: Int): Int { bounds += bound; return bound - 1 }
        }
        assertEquals(DraftNotifier.DRAFT_ID_MIN, DraftNotifier.drawId(lowest))
        assertEquals(Int.MAX_VALUE - 1, DraftNotifier.drawId(highest))
        assertEquals(listOf(Int.MAX_VALUE - 100_000, Int.MAX_VALUE - 100_000), bounds)
        assertEquals(100_000, DraftNotifier.DRAFT_ID_MIN)
        val random = SecureRandom()
        repeat(1_000) {
            val id = DraftNotifier.drawId(random)
            assertTrue("$id out of range", id >= 100_000 && id < Int.MAX_VALUE)
        }
    }

    // ── post() against a fake Android ───────────────────────────────────────

    private class FakeSystem(
        var enabled: Boolean = true,
        var paused: Boolean = false,
        var importance: Int? = 4, // IMPORTANCE_HIGH
        var handler: Boolean = true,
        val active: MutableSet<Int> = mutableSetOf(),
    ) : DraftSystem {
        val calls = mutableListOf<String>()
        val resolved = mutableListOf<DraftSpec>()
        val notified = mutableListOf<Pair<Int, DraftSpec>>()

        override fun areNotificationsEnabled(): Boolean { calls += "enabled"; return enabled }
        override fun areNotificationsPaused(): Boolean { calls += "paused"; return paused }
        override fun channelImportance(channelId: String): Int? {
            calls += "channel:$channelId"
            return importance
        }
        override fun resolvesActivity(spec: DraftSpec): Boolean { calls += "resolve"; resolved += spec; return handler }
        override fun activeIds(): Set<Int> { calls += "active"; return active.toSet() }
        override fun timeText(): String { calls += "time"; return "09:30" }
        override fun notify(id: Int, spec: DraftSpec) {
            calls += "notify"
            notified += id to spec
            active += id
        }
    }

    /** A Random whose nextInt(bound) returns [values] in order (id = DRAFT_ID_MIN + value). */
    private class SeqRandom(vararg values: Int) : Random() {
        private val queue = ArrayDeque(values.toList())
        override fun nextInt(bound: Int): Int = queue.removeFirstOrNull() ?: throw AssertionError("drew more ids than expected")
    }

    @Test
    fun `every refusal returns its typed outcome and never posts`() {
        val cases = listOf(
            FakeSystem(enabled = false) to Outcome.NOTIFICATIONS_DISABLED,
            FakeSystem(paused = true) to Outcome.NOTIFICATIONS_PAUSED,
            FakeSystem(importance = null) to Outcome.CHANNEL_BLOCKED, // channel missing
            FakeSystem(importance = 0) to Outcome.CHANNEL_BLOCKED, // IMPORTANCE_NONE
            FakeSystem(handler = false) to Outcome.NO_HANDLER,
        )
        for ((system, expected) in cases) {
            for (kind in Kind.values()) {
                system.calls.clear()
                val outcome = DraftNotifier(system, SeqRandom(1)).post(kind, number, "body")
                assertEquals(expected, outcome)
                assertTrue("$expected must not notify: ${system.calls}", "notify" !in system.calls)
                assertTrue(system.notified.isEmpty())
            }
        }
    }

    @Test
    fun `a notification refusal never draws an id or asks for a handler`() {
        for (system in listOf(FakeSystem(enabled = false), FakeSystem(paused = true), FakeSystem(importance = 0))) {
            DraftNotifier(system, SeqRandom()).post(Kind.SMS, number, "body")
            assertTrue(system.calls.toString(), system.calls.none { it == "resolve" || it == "active" || it == "time" })
        }
    }

    @Test
    fun `an invalid recipient asks Android nothing and never posts`() {
        for (raw in listOf("*#06#", "555,666", "1-800-FLOWERS", null)) {
            val system = FakeSystem()
            assertEquals(Outcome.INVALID_RECIPIENT, DraftNotifier(system, SeqRandom()).post(Kind.SMS, raw, "body"))
            assertEquals(Outcome.INVALID_RECIPIENT, DraftNotifier(system, SeqRandom()).post(Kind.CALL, raw))
            assertEquals(emptyList<String>(), system.calls)
        }
    }

    @Test
    fun `a posted draft notifies exactly once, with the spec's id, the sanitised number and its body`() {
        val system = FakeSystem()
        val outcome = DraftNotifier(system, SeqRandom(400_000)).post(Kind.SMS, "+1 (555) 123-4567", "hello there")
        assertEquals(Outcome.POSTED, outcome)
        assertEquals(1, system.notified.size)
        val (id, spec) = system.notified.single()
        assertEquals(500_000, id)
        assertEquals(spec.id, id)
        assertEquals(id, spec.requestCode)
        assertEquals("+15551234567", spec.number)
        assertEquals(mapOf("sms_body" to "hello there"), spec.extras)
        assertEquals("Message draft · 09:30 — tap to review", spec.title)
        assertSame("the handler lookup and the notification use the same draft", system.resolved.single(), spec)
        assertEquals(listOf("enabled", "paused", "channel:seekerclaw_drafts", "time", "active", "resolve", "notify"), system.calls)
    }

    @Test
    fun `a second draft while the first is showing gets a fresh id even when the draw repeats`() {
        val system = FakeSystem(active = mutableSetOf(100_007)) // a draft from before a restart
        val notifier = DraftNotifier(system, SeqRandom(7, 1, 1, 2))
        assertEquals(Outcome.POSTED, notifier.post(Kind.SMS, "+15551234567", "one")) // 100_007 is taken → 100_001
        assertEquals(Outcome.POSTED, notifier.post(Kind.CALL, "+995599123456")) // 100_001 is now showing → 100_002
        assertEquals(listOf(100_001, 100_002), system.notified.map { it.first })
        assertEquals("+15551234567", system.notified[0].second.number)
        assertEquals(mapOf("sms_body" to "one"), system.notified[0].second.extras)
        assertEquals("+995599123456", system.notified[1].second.number)
        assertEquals(Kind.CALL, system.notified[1].second.kind)
    }
}
