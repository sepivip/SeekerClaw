package com.seekerclaw.app.state

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File

/**
 * BAT-1155 v4 matrix — drives the REAL [XaiOAuthTokenStore] CAS/epoch/tombstone/
 * migration logic against a temp filesDir (JVM seam [XaiOAuthTokenStore.initForTest]),
 * not a mirror. Pins the Codex-signed contract invariants: fail-closed default,
 * epoch-advancing mutations, single-use rotation CAS, epoch-0 tombstone rejection
 * (blocker-3), versioned dead-marks (blocker-2), fill-only migration, and corruption
 * fail-closed. The Android-specific surfaces (cross-process file lock under real
 * multi-process contention) are device-validated — same convention CrossProcessStoreTest
 * follows.
 */
class XaiOAuthTokenStoreTest {

    private lateinit var workDir: File

    @Before
    fun setUp() {
        workDir = File.createTempFile("bat1155-xai", "").apply { delete(); mkdirs() }
        XaiOAuthTokenStore.initForTest(workDir)
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

    // ---- Fail-closed default -------------------------------------------------

    @Test
    fun `fresh store reads fail-closed reauth tombstone with no token`() {
        val rec = XaiOAuthTokenStore.read()
        assertTrue("missing store must be a tombstone", rec.tombstone)
        assertTrue("missing store must require reauth", rec.reauthRequired)
        assertEquals("sentinel epoch is 0", 0L, rec.epoch)
        assertTrue("no token material", rec.accessTokenEnc.isEmpty() && rec.refreshTokenEnc.isEmpty())
    }

    @Test
    fun `corrupt store file reads fail-closed (never a usable token)`() {
        // A live family on disk, then the file is corrupted (partial write / bad key).
        ok(XaiOAuthTokenStore.signIn("acc", "ref", "email", "2099-01-01T00:00:00Z"))
        File(workDir, XaiOAuthTokenStore.FILE_NAME).writeText("{ this is not json")
        val rec = XaiOAuthTokenStore.read()
        assertTrue("corrupt store must fail closed to tombstone", rec.tombstone)
        assertTrue("corrupt store must require reauth", rec.reauthRequired)
        assertTrue("corrupt store must expose no token", rec.accessTokenEnc.isEmpty())
    }

    // ---- signIn / signOut ----------------------------------------------------

    @Test
    fun `signIn establishes a live family and advances epoch`() {
        val rec = ok(XaiOAuthTokenStore.signIn("acc", "ref", "email", "2099-01-01T00:00:00Z"))
        assertFalse(rec.tombstone)
        assertFalse(rec.reauthRequired)
        assertEquals("acc", rec.accessTokenEnc)
        assertEquals("ref", rec.refreshTokenEnc)
        assertEquals("email", rec.emailEnc)
        assertEquals("signIn advances 0→1", 1L, rec.epoch)
        assertEquals("reset notify latch", -1L, rec.reauthNotifiedEpoch)
    }

    @Test
    fun `signOut writes an epoch-advanced tombstone with no token`() {
        ok(XaiOAuthTokenStore.signIn("acc", "ref", "email", "2099-01-01T00:00:00Z")) // epoch 1
        val rec = ok(XaiOAuthTokenStore.signOut())
        assertTrue(rec.tombstone)
        assertEquals("signOut advances 1→2", 2L, rec.epoch)
        assertTrue("sign-out keeps NO token material", rec.accessTokenEnc.isEmpty() && rec.refreshTokenEnc.isEmpty())
    }

    // ---- rotate CAS ----------------------------------------------------------

    @Test
    fun `rotate with matching epoch persists and advances`() {
        val e1 = ok(XaiOAuthTokenStore.signIn("acc0", "ref0", "email", "exp0")).epoch // 1
        val rec = ok(XaiOAuthTokenStore.rotate(e1, "acc1", "ref1", "exp1"))
        assertEquals("acc1", rec.accessTokenEnc)
        assertEquals("ref1", rec.refreshTokenEnc)
        assertEquals("rotate advances 1→2", 2L, rec.epoch)
        assertFalse("rotation proves family alive → clears reauth", rec.reauthRequired)
    }

    @Test
    fun `rotate with stale epoch is a CAS conflict and does NOT write`() {
        ok(XaiOAuthTokenStore.signIn("acc0", "ref0", "email", "exp0")) // epoch 1
        // A concurrent sign-in advanced the epoch to 2; the old-family rotation carries epoch 1.
        ok(XaiOAuthTokenStore.signIn("accNEW", "refNEW", "email", "expNEW")) // epoch 2
        val r = XaiOAuthTokenStore.rotate(1L, "accSTALE", "refSTALE", "expSTALE")
        assertTrue("stale rotation must conflict", r is XaiOAuthTokenStore.Result.Conflict)
        assertEquals(2L, (r as XaiOAuthTokenStore.Result.Conflict).currentEpoch)
        // The winning family is intact and untouched.
        val rec = XaiOAuthTokenStore.read()
        assertEquals("accNEW", rec.accessTokenEnc)
        assertEquals(2L, rec.epoch)
    }

    @Test
    fun `rotate rejects a real sign-out tombstone (no resurrection)`() {
        ok(XaiOAuthTokenStore.signIn("acc0", "ref0", "email", "exp0")) // 1
        val dead = ok(XaiOAuthTokenStore.signOut()) // tombstone, epoch 2
        // Even with the CORRECT epoch, a tombstone is terminal for rotation.
        val r = XaiOAuthTokenStore.rotate(dead.epoch, "accZOMBIE", "refZOMBIE", "expZOMBIE")
        assertTrue("rotate onto a tombstone must conflict (blocker-3)", r is XaiOAuthTokenStore.Result.Conflict)
        assertTrue("account stays signed out", XaiOAuthTokenStore.read().tombstone)
    }

    @Test
    fun `rotate rejects the epoch-0 fail-closed sentinel`() {
        // No sign-in yet: the store is the epoch-0 FAIL_CLOSED tombstone. A rotation that
        // raced a never-provisioned family must NOT resurrect it (blocker-3: EVERY tombstone
        // rejected, the epoch-0 fill exception lives ONLY in migrateIfEmpty).
        val r = XaiOAuthTokenStore.rotate(0L, "acc", "ref", "exp")
        assertTrue("rotate onto epoch-0 sentinel must conflict", r is XaiOAuthTokenStore.Result.Conflict)
        assertTrue(XaiOAuthTokenStore.read().tombstone)
    }

    // ---- versioned dead-marks (blocker-2) ------------------------------------

    @Test
    fun `markReauth on the live family sets reauth WITHOUT advancing epoch`() {
        val e1 = ok(XaiOAuthTokenStore.signIn("acc", "ref", "email", "exp")).epoch // 1
        val rec = ok(XaiOAuthTokenStore.markReauth(e1))
        assertTrue(rec.reauthRequired)
        assertEquals("markReauth is an annotation — epoch stays 1", 1L, rec.epoch)
        assertEquals("token preserved (token-less mark)", "acc", rec.accessTokenEnc)
    }

    @Test
    fun `stale markReauth does NOT poison a freshly signed-in family`() {
        ok(XaiOAuthTokenStore.signIn("acc0", "ref0", "email", "exp0")) // epoch 1
        // A fresh sign-in supersedes it (epoch 2) while a delayed old-family mark still
        // carries epoch 1. The CAS must reject it so the new family stays healthy.
        ok(XaiOAuthTokenStore.signIn("accNEW", "refNEW", "email", "expNEW")) // epoch 2
        val r = XaiOAuthTokenStore.markReauth(1L)
        assertTrue("stale mark must conflict (blocker-2)", r is XaiOAuthTokenStore.Result.Conflict)
        val rec = XaiOAuthTokenStore.read()
        assertFalse("fresh family must NOT be marked reauth by a stale mark", rec.reauthRequired)
        assertEquals("accNEW", rec.accessTokenEnc)
    }

    @Test
    fun `markReauth then markReauthNotified chain on the same stable epoch`() {
        val e1 = ok(XaiOAuthTokenStore.signIn("acc", "ref", "email", "exp")).epoch // 1
        val marked = ok(XaiOAuthTokenStore.markReauth(e1))
        assertEquals(1L, marked.epoch)
        // Because markReauth did NOT advance the epoch, the notify latch CAS uses the same epoch.
        val notified = ok(XaiOAuthTokenStore.markReauthNotified(e1))
        assertEquals("notify latch records the epoch it fired for", e1, notified.reauthNotifiedEpoch)
        assertTrue("still reauth-required after notify", notified.reauthRequired)
        assertEquals("still epoch 1", 1L, notified.epoch)
    }

    @Test
    fun `markReauth is idempotent`() {
        val e1 = ok(XaiOAuthTokenStore.signIn("acc", "ref", "email", "exp")).epoch
        ok(XaiOAuthTokenStore.markReauth(e1))
        val again = ok(XaiOAuthTokenStore.markReauth(e1)) // epoch unchanged → same expected epoch still valid
        assertTrue(again.reauthRequired)
        assertEquals(1L, again.epoch)
    }

    // ---- migrateIfEmpty (fill-only, marker semantics) ------------------------

    @Test
    fun `migrateIfEmpty fills the epoch-0 sentinel at epoch 1`() {
        val rec = ok(XaiOAuthTokenStore.migrateIfEmpty("accL", "refL", "emailL", "expL"))
        assertEquals("accL", rec.accessTokenEnc)
        assertFalse(rec.tombstone)
        assertFalse(rec.reauthRequired)
        assertEquals("adopted family's first revision is epoch 1", 1L, rec.epoch)
    }

    @Test
    fun `migrateIfEmpty is a no-op when a real token already exists`() {
        val existing = ok(XaiOAuthTokenStore.signIn("accX", "refX", "email", "exp")) // epoch 1
        val rec = ok(XaiOAuthTokenStore.migrateIfEmpty("accL", "refL", "emailL", "expL"))
        assertEquals("must NOT clobber the existing token", "accX", rec.accessTokenEnc)
        assertEquals("no-op does NOT advance epoch", existing.epoch, rec.epoch)
    }

    @Test
    fun `migrateIfEmpty does NOT resurrect a real sign-out tombstone`() {
        ok(XaiOAuthTokenStore.signIn("acc", "ref", "email", "exp")) // 1
        val dead = ok(XaiOAuthTokenStore.signOut()) // tombstone, epoch 2 (a REAL persisted tombstone)
        val rec = ok(XaiOAuthTokenStore.migrateIfEmpty("accL", "refL", "emailL", "expL"))
        assertTrue("a persisted sign-out (epoch>=1) blocks the fill", rec.tombstone)
        assertTrue("no legacy token materializes over a sign-out", rec.accessTokenEnc.isEmpty())
        assertEquals("no-op leaves the sign-out epoch untouched", dead.epoch, rec.epoch)
    }

    @Test
    fun `read reflects the last committed mutation`() {
        ok(XaiOAuthTokenStore.signIn("acc1", "ref1", "email", "exp"))
        assertEquals("acc1", XaiOAuthTokenStore.read().accessTokenEnc)
        ok(XaiOAuthTokenStore.rotate(1L, "acc2", "ref2", "exp2"))
        assertEquals("acc2", XaiOAuthTokenStore.read().accessTokenEnc)
        assertEquals(2L, XaiOAuthTokenStore.read().epoch)
    }

    // ---- BAT-1155 stop-fence protocol -----------------------------------------

    @Test
    fun `signIn resets both stop-fence markers`() {
        // ARM both markers on a live family FIRST, so this actually pins the explicit clears in
        // signIn (a trivial fresh-signIn starts at -1 and would pass even if the clears were dropped).
        val e1 = ok(XaiOAuthTokenStore.signIn("acc", "ref", "email", "exp")).epoch // epoch 1
        ok(XaiOAuthTokenStore.prepareRefresh(e1)) // rotationInFlightEpoch = 1
        ok(XaiOAuthTokenStore.armStopFenceAndProbeRotation(e1)) // stopFenceEpoch = 1
        val armed = XaiOAuthTokenStore.read()
        assertEquals("precondition: rotation marker armed", e1, armed.rotationInFlightEpoch)
        assertEquals("precondition: stop fence armed", e1, armed.stopFenceEpoch)

        // A fresh sign-in SUPERSEDES the prior family and must clear BOTH markers on the new epoch.
        val r2 = ok(XaiOAuthTokenStore.signIn("acc2", "ref2", "email2", "exp2"))
        assertEquals("fresh family unarmed", -1L, r2.rotationInFlightEpoch)
        assertEquals("fresh family unfenced", -1L, r2.stopFenceEpoch)
    }

    @Test
    fun `armStopFenceAndProbeRotation re-fences the WINNING epoch after a CAS conflict`() {
        // Codex amendment 1: a stop that arms an already-superseded epoch must re-read and re-arm the
        // WINNING live epoch, never leave it unfenced. Drive the retry loop into a real CAS conflict.
        ok(XaiOAuthTokenStore.signIn("acc", "ref", "email", "exp")) // epoch 1
        ok(XaiOAuthTokenStore.signIn("acc2", "ref2", "email", "exp")) // epoch 2 supersedes
        // Call with the STALE epoch 1 → mutate CAS-conflicts (on-disk is 2) → the loop re-reads and
        // re-arms epoch 2.
        val r = ok(XaiOAuthTokenStore.armStopFenceAndProbeRotation(1L))
        assertEquals("re-fenced the winning live epoch", 2L, r.epoch)
        assertEquals("stop fence armed on the winning epoch, not the stale one", 2L, r.stopFenceEpoch)
    }

    @Test
    fun `prepareRefresh arms the marker then returns Unsafe on a second call (no double-POST)`() {
        ok(XaiOAuthTokenStore.signIn("acc", "ref", "email", "exp")) // epoch 1
        assertTrue("first prepare arms the marker", XaiOAuthTokenStore.prepareRefresh(1L) is XaiOAuthTokenStore.Result.Ok)
        assertEquals(1L, XaiOAuthTokenStore.read().rotationInFlightEpoch)
        assertTrue(
            "an already-armed marker (a prior POST timed out/5xx'd, marker retained) must reject a second prepare",
            XaiOAuthTokenStore.prepareRefresh(1L) is XaiOAuthTokenStore.Result.Unsafe,
        )
    }

    @Test
    fun `prepareRefresh is Dead for a reauth family and Fenced under a stop`() {
        ok(XaiOAuthTokenStore.signIn("acc", "ref", "email", "exp")) // epoch 1
        ok(XaiOAuthTokenStore.markReauth(1L))
        assertTrue("a reauth family → Dead (no POST)", XaiOAuthTokenStore.prepareRefresh(1L) is XaiOAuthTokenStore.Result.Dead)

        ok(XaiOAuthTokenStore.signIn("acc2", "ref2", "email", "exp")) // epoch 2, live
        ok(XaiOAuthTokenStore.armStopFenceAndProbeRotation(2L))
        assertTrue("a fenced epoch → Fenced (no POST)", XaiOAuthTokenStore.prepareRefresh(2L) is XaiOAuthTokenStore.Result.Fenced)
    }

    @Test
    fun `prepareRefresh Conflicts on a superseded epoch`() {
        ok(XaiOAuthTokenStore.signIn("acc", "ref", "email", "exp")) // epoch 1
        ok(XaiOAuthTokenStore.signIn("acc2", "ref2", "email", "exp")) // epoch 2 supersedes
        val r = XaiOAuthTokenStore.prepareRefresh(1L) // Node still thinks it is epoch 1
        assertTrue(r is XaiOAuthTokenStore.Result.Conflict)
        assertEquals(2L, (r as XaiOAuthTokenStore.Result.Conflict).currentEpoch)
    }

    @Test
    fun `rotate rebases an armed stop fence forward and clears the rotation marker`() {
        ok(XaiOAuthTokenStore.signIn("acc", "ref", "email", "exp")) // epoch 1
        ok(XaiOAuthTokenStore.prepareRefresh(1L)) // rotationInFlightEpoch=1 (refresh authorized)
        val armed = ok(XaiOAuthTokenStore.armStopFenceAndProbeRotation(1L)) // stop arms the fence at 1
        assertEquals("fence armed on the live epoch", 1L, armed.stopFenceEpoch)
        assertEquals("probe sees the in-flight rotation", 1L, armed.rotationInFlightEpoch)
        // The already-authorized rotation completes: rotate must REBASE the fence to the new epoch
        // (amendment 1) so a completed-safe rotation never drops the fence before teardown.
        val rot = ok(XaiOAuthTokenStore.rotate(1L, "acc2", "ref2", "exp2"))
        assertEquals("epoch advanced", 2L, rot.epoch)
        assertEquals("stop fence rebased to the new epoch", 2L, rot.stopFenceEpoch)
        assertEquals("rotation marker cleared", -1L, rot.rotationInFlightEpoch)
    }

    @Test
    fun `markReauthIfRotationInFlight marks when armed, is Safe when cleared`() {
        ok(XaiOAuthTokenStore.signIn("acc", "ref", "email", "exp")) // epoch 1
        ok(XaiOAuthTokenStore.prepareRefresh(1L))
        assertTrue("armed marker → conditional mark lands", XaiOAuthTokenStore.markReauthIfRotationInFlight(1L) is XaiOAuthTokenStore.Result.Ok)
        assertTrue("family reauth", XaiOAuthTokenStore.read().reauthRequired)

        // clear-vs-mark race: a proven-not-sent clear before the conditional mark → Safe, no brick.
        ok(XaiOAuthTokenStore.signIn("acc2", "ref2", "email", "exp")) // epoch 2, fresh live
        ok(XaiOAuthTokenStore.prepareRefresh(2L))
        ok(XaiOAuthTokenStore.clearRotationInFlight(2L))
        assertTrue("cleared marker → Safe (family live, no brick)", XaiOAuthTokenStore.markReauthIfRotationInFlight(2L) is XaiOAuthTokenStore.Result.Safe)
        assertFalse("family stays live", XaiOAuthTokenStore.read().reauthRequired)
    }

    @Test
    fun `markReauthNotified PRESERVES the rotation marker`() {
        ok(XaiOAuthTokenStore.signIn("acc", "ref", "email", "exp")) // epoch 1
        ok(XaiOAuthTokenStore.prepareRefresh(1L)) // rotationInFlightEpoch=1
        ok(XaiOAuthTokenStore.markReauthNotified(1L)) // amendment 3: must NEVER clear the safety marker
        assertEquals("the notify path must not erase the rotation marker", 1L, XaiOAuthTokenStore.read().rotationInFlightEpoch)
    }

    @Test
    fun `markReauth clears the rotation marker (durable reauth supersedes it)`() {
        ok(XaiOAuthTokenStore.signIn("acc", "ref", "email", "exp")) // epoch 1
        ok(XaiOAuthTokenStore.prepareRefresh(1L))
        ok(XaiOAuthTokenStore.markReauth(1L))
        assertEquals("durable reauth clears the marker (a reconnect mints a fresh family)", -1L, XaiOAuthTokenStore.read().rotationInFlightEpoch)
        assertTrue(XaiOAuthTokenStore.read().reauthRequired)
    }

    @Test
    fun `a record missing the stop-fence fields decodes to -1 on upgrade (never spuriously armed)`() {
        // Pre-upgrade file with no rotationInFlightEpoch / stopFenceEpoch keys.
        File(workDir, XaiOAuthTokenStore.FILE_NAME).writeText(
            """{"accessTokenEnc":"acc","refreshTokenEnc":"ref","emailEnc":"e","expiresAt":"x","reauthRequired":false,"reauthNotifiedEpoch":-1,"epoch":5,"tombstone":false}""",
        )
        val rec = XaiOAuthTokenStore.read()
        assertEquals("epoch preserved on upgrade", 5L, rec.epoch)
        assertEquals("missing marker decodes to -1 (never armed — -1 == epoch is impossible)", -1L, rec.rotationInFlightEpoch)
        assertEquals("missing fence decodes to -1", -1L, rec.stopFenceEpoch)
    }
}
