package com.seekerclaw.app.state

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.io.RandomAccessFile

/**
 * BAT-1155 Codex re-review — behavioral coverage for the controlled-stop durability gate
 * ([XaiOAuthDurabilityGate]) and the budget-bounded store lock ([XaiOAuthTokenStore.markReauth]).
 *
 * These drive the REAL gate + REAL store against a temp filesDir. The Node flush leg is
 * naturally "unreachable" here (no bridge token / no control server), which is exactly the
 * fail-closed path the gate must handle: when Node can't confirm the disk is safe, the gate
 * MUST durably CAS-mark the live family reauth rather than report a false-clean. The true
 * two-process MAIN-vs-`:node` sidecar-lock race is validated by the on-device instrumentation
 * suite + the 24h soak (contract §6); this pins the single-process decision logic + bounds.
 */
class XaiOAuthDurabilityGateTest {

    private lateinit var workDir: File

    @Before
    fun setUp() {
        workDir = File.createTempFile("bat1155-gate", "").apply { delete(); mkdirs() }
        XaiOAuthTokenStore.initForTest(workDir)
        // The Node flush leg is naturally unreachable here: no bridge token (→ flushShutdown
        // returns null immediately) or, if another test left one set, a connect-refused on the
        // absent control server (→ null). Either way the gate takes its fail-closed path.
    }

    @After
    fun tearDown() {
        XaiOAuthTokenStore.resetForTest()
        workDir.deleteRecursively()
    }

    private fun ok(r: XaiOAuthTokenStore.Result): XaiOAuthTokens {
        assertTrue("expected Ok but was $r", r is XaiOAuthTokenStore.Result.Ok)
        return (r as XaiOAuthTokenStore.Result.Ok).record
    }

    // ---- stop-fence gate behavior (BAT-1155) ----------------------------------

    @Test
    fun `gate is positively safe (NO brick) for a live family with no rotation in flight`() {
        // The soak-brick regression: a fresh sign-in with no rotation marker, Node unreachable.
        // The new gate arms the stop fence + probes the durable marker (a pure store op) — fenced +
        // nothing-in-flight is POSITIVELY safe, so it must NOT fail-close on the null control path.
        val e1 = ok(XaiOAuthTokenStore.signIn("acc", "ref", "email", "exp")).epoch // live, epoch 1, no marker
        val durable = XaiOAuthDurabilityGate.ensureDurableBeforeStop()
        assertTrue("fenced + no rotation in flight = positively safe, even with Node unreachable", durable)
        val rec = XaiOAuthTokenStore.read()
        assertFalse("a live family with nothing consumed must NOT be bricked (the soak brick)", rec.reauthRequired)
        assertEquals("armStopFence is epoch-stable — epoch unchanged", e1, rec.epoch)
        assertEquals("the stop fence is armed on the live epoch", e1, rec.stopFenceEpoch)
        assertEquals("token material intact", "acc", rec.accessTokenEnc)
    }

    @Test
    fun `gate conditionally fail-closes a live family with a rotation marker armed and Node unreachable`() {
        val e1 = ok(XaiOAuthTokenStore.signIn("acc", "ref", "email", "exp")).epoch // epoch 1
        ok(XaiOAuthTokenStore.prepareRefresh(e1)) // arm rotationInFlightEpoch=1 — a refresh POST is "in flight"
        val durable = XaiOAuthDurabilityGate.ensureDurableBeforeStop()
        assertTrue("gate reports durable once the conditional mark lands", durable)
        val rec = XaiOAuthTokenStore.read()
        assertTrue("an in-flight rotation the unreachable Node can't drain must fail-close to reauth", rec.reauthRequired)
        assertEquals("markReauthIfRotationInFlight is epoch-stable", e1, rec.epoch)
    }

    @Test
    fun `gate is a no-op for an already-dead (reauth) family`() {
        val e1 = ok(XaiOAuthTokenStore.signIn("acc", "ref", "email", "exp")).epoch
        ok(XaiOAuthTokenStore.markReauth(e1)) // already dead-marked
        val before = XaiOAuthTokenStore.read()
        val durable = XaiOAuthDurabilityGate.ensureDurableBeforeStop()
        assertTrue(durable)
        val after = XaiOAuthTokenStore.read()
        assertEquals("no-op must not advance the epoch", before.epoch, after.epoch)
        assertTrue(after.reauthRequired)
    }

    @Test
    fun `gate is a no-op for a signed-out tombstone`() {
        ok(XaiOAuthTokenStore.signIn("acc", "ref", "email", "exp"))
        ok(XaiOAuthTokenStore.signOut())
        val before = XaiOAuthTokenStore.read()
        assertTrue(XaiOAuthDurabilityGate.ensureDurableBeforeStop())
        val after = XaiOAuthTokenStore.read()
        assertTrue("still signed out", after.tombstone)
        assertEquals("tombstone untouched", before.epoch, after.epoch)
    }

    @Test
    fun `gate is a no-op (durable) for the fail-closed default (no family)`() {
        // Fresh store = FAIL_CLOSED tombstone → nothing live to protect.
        assertTrue(XaiOAuthDurabilityGate.ensureDurableBeforeStop())
        assertTrue(XaiOAuthTokenStore.read().tombstone)
    }

    @Test
    fun `gate returns durable when the store is uninitialized`() {
        XaiOAuthTokenStore.resetForTest()
        assertTrue("nothing to protect when uninitialized", XaiOAuthDurabilityGate.ensureDurableBeforeStop())
    }

    // ---- Codex re-review major-1: the store lock honors the caller's remaining budget ----

    @Test
    fun `markReauth returns Failed within the caller budget under sidecar-lock contention`() {
        ok(XaiOAuthTokenStore.signIn("acc", "ref", "email", "exp")) // epoch 1
        // Hold the sidecar OS lock so the mutation can NEVER acquire it (same-JVM overlap →
        // the store's tryLock throws + retries until the budget expires). A small maxLockMs
        // must bound the wait far below the default LOCK_TIMEOUT_MS (1000ms).
        val lockFile = File(workDir, XaiOAuthTokenStore.LOCK_NAME)
        val raf = RandomAccessFile(lockFile, "rw")
        val held = raf.channel.lock()
        try {
            val budgetMs = 120L
            val t0 = System.nanoTime()
            val r = XaiOAuthTokenStore.markReauth(1L, maxLockMs = budgetMs)
            val elapsedMs = (System.nanoTime() - t0) / 1_000_000L
            assertTrue("contended lock → Failed (not a hang)", r is XaiOAuthTokenStore.Result.Failed)
            assertTrue("must return near the ${budgetMs}ms budget, well under the 1000ms default (was ${elapsedMs}ms)",
                elapsedMs in (budgetMs - 40)..(budgetMs + 500))
        } finally {
            held.release()
            raf.close()
        }
        // The family must be untouched by the failed mark.
        assertFalse("a Failed mark must not have flipped reauth", XaiOAuthTokenStore.read().reauthRequired)
    }

    // ---- Codex re-review major-1: the gate DRAINS a pending notify mark over the real
    //      Stop round-trip (not just the direct flushPendingPersist helper) ----

}
