package com.seekerclaw.app.state

import com.seekerclaw.app.config.SecretCodec
import com.seekerclaw.app.testing.PowerLossFs
import com.seekerclaw.app.util.SafeFs
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File

/**
 * BAT-1157 — drives the REAL [OpenAIOAuthTokenStore] against a temp filesDir, pinning the signed-off
 * contract (v1–v4, Codex sign-off 0fc1ead6). Secrets go through a reversible test codec (no Android
 * Keystore on the JVM); everything else is production code. Durability pins use [PowerLossFs], where a
 * rename is durable only after a LATER successful directory fsync and a failed fsync covers nothing.
 */
class OpenAIOAuthTokenStoreTest {

    private lateinit var dir: File
    private lateinit var fs: PowerLossFs

    /** Reversible, non-identity "encryption": the tests can see that ciphertext, not plaintext, is stored. */
    private val codec = object : SecretCodec {
        override fun seal(plain: String) = "enc:" + plain.reversed()
        override fun open(sealed: String): String {
            require(sealed.startsWith("enc:")) { "not ours" }
            return sealed.removePrefix("enc:").reversed()
        }
    }

    @Before
    fun setUp() {
        dir = File.createTempFile("bat1157-openai", "").apply { delete(); mkdirs() }
        fs = PowerLossFs().also { it.install() }
        SafeFs.filesRoot = dir.toPath()
        OpenAIOAuthTokenStore.initForTest(dir, codec)
    }

    @After
    fun tearDown() {
        OpenAIOAuthTokenStore.resetForTest()
        fs.uninstall()
        SafeFs.filesRoot = null
        dir.deleteRecursively()
    }

    private val store = OpenAIOAuthTokenStore
    private fun recordFile() = File(dir, OpenAIOAuthTokenStore.FILE_NAME)
    private fun markerFile() = File(dir, OpenAIOAuthTokenStore.MARKER_NAME)

    private fun ok(r: OpenAIOAuthTokenStore.Result): OpenAIOAuthTokens {
        assertTrue("expected Ok but was $r", r is OpenAIOAuthTokenStore.Result.Ok)
        return (r as OpenAIOAuthTokenStore.Result.Ok).record
    }

    private fun present(): OpenAIOAuthTokens {
        val s = store.snapshot()
        assertTrue("expected Present but was $s", s is OpenAIOAuthTokenStore.State.Present)
        return (s as OpenAIOAuthTokenStore.State.Present).record
    }

    private fun legacy(access: String = "enc:" + "legacy-access".reversed(), refresh: String = "enc:" + "legacy-refresh".reversed()) =
        OpenAIOAuthTokenStore.LegacyPair(access, refresh, "", "2099-01-01T00:00:00Z", plainEmail = "")

    // ------------------------------------------------------------------ reading

    @Test
    fun `absent and unreadable are told apart and neither is a token`() {
        assertEquals(OpenAIOAuthTokenStore.State.Absent, store.snapshot())
        recordFile().writeText("{ not json")
        assertTrue(store.snapshot() is OpenAIOAuthTokenStore.State.Unreadable)
        assertFalse(store.hasUsableToken())
        // A record decoding at epoch 0 is never persisted by the store: unreadable too.
        recordFile().writeText("""{"accessTokenEnc":"enc:x","epoch":0}""")
        assertTrue(store.snapshot() is OpenAIOAuthTokenStore.State.Unreadable)
        // A corrupt maximal epoch would overflow on the next advance: unreadable, and a sign-in
        // over it still yields a record that reads back as Present.
        recordFile().writeText("""{"accessTokenEnc":"enc:x","epoch":${Long.MAX_VALUE}}""")
        assertTrue(store.snapshot() is OpenAIOAuthTokenStore.State.Unreadable)
        ok(store.signIn("acc", "ref", "", "t"))
        assertTrue(store.snapshot() is OpenAIOAuthTokenStore.State.Present)
    }

    @Test
    fun `at the epoch limit every write still reads back as Present`() {
        val last = OpenAIOAuthTokenStore.EPOCH_LIMIT - 1
        fun seed(tombstone: Boolean = false) = recordFile().writeText(
            """{"accessTokenEnc":"enc:${"acc".reversed()}","refreshTokenEnc":"enc:${"ref".reversed()}","epoch":$last,"familyId":"fam","tombstone":$tombstone}""")
        seed()
        assertEquals(last, present().epoch)
        // A sign-in at the limit restarts at 1 (the new family rejects the old session) and reads back.
        assertEquals(1L, ok(store.signIn("acc2", "ref2", "", "t")).epoch)
        assertEquals(1L, present().epoch)
        // A sign-out at the limit likewise.
        seed(); assertEquals(1L, ok(store.signOut()).epoch); assertTrue(present().tombstone)
        // A rotation at the limit fails instead of writing an unreadable record.
        seed()
        assertTrue(store.rotate("fam", last, "r", "a", "b", "t") is OpenAIOAuthTokenStore.Result.Failed)
        assertEquals("the record is untouched", last, present().epoch)
    }

    @Test
    fun `a record that exists but cannot be read is never treated as absent (no fill over it)`() {
        ok(store.signIn("acc", "ref", "", "t"))
        markerFile().delete()
        val live = recordFile().readBytes()
        // Replace the record with a directory: it exists, but reading it fails with a non-missing error.
        recordFile().delete()
        recordFile().mkdirs()
        assertTrue(store.snapshot() is OpenAIOAuthTokenStore.State.Unreadable)
        assertEquals(OpenAIOAuthTokenStore.MigrateOutcome.UNREADABLE, store.migrateIfNeeded { legacy() })
        // Checked BEFORE restoring: migration left the unreadable entry exactly as it was (no fill
        // replaced it with a legacy record) and wrote no marker.
        assertTrue("migration did not replace the unreadable entry", recordFile().isDirectory)
        assertFalse("no marker over an unreadable record", markerFile().exists())
    }

    // ------------------------------------------------------------------ sign-in / sign-out

    @Test
    fun `sign-in stores ciphertext, a new family, and never inherits the previous refresh token or email`() {
        val first = ok(store.signIn("acc1", "ref1", "a@x", "t1"))
        assertTrue(first.accessTokenEnc.startsWith("enc:") && !first.accessTokenEnc.contains("acc1"))
        assertTrue(markerFile().exists())
        val second = ok(store.signIn("acc2", "", "", "t2"))
        assertNotEquals(first.familyId, second.familyId)
        assertEquals(first.epoch + 1, second.epoch)
        assertEquals("a blank refresh token stays blank on sign-in", "", second.refreshTokenEnc)
        assertEquals("a blank email stays blank on sign-in", "", second.emailEnc)
    }

    @Test
    fun `sign-out writes a tombstone with no token material and an advanced epoch`() {
        val live = ok(store.signIn("acc", "ref", "", "t"))
        val tomb = ok(store.signOut())
        assertTrue(tomb.tombstone)
        assertEquals(live.epoch + 1, tomb.epoch)
        assertEquals("", tomb.accessTokenEnc + tomb.refreshTokenEnc + tomb.familyId)
        assertFalse(store.hasUsableToken())
    }

    // ------------------------------------------------------------------ rotate (CAS)

    @Test
    fun `rotate needs the same family and epoch, and an old session can never overwrite a new sign-in`() {
        val a = ok(store.signIn("accA", "refA", "", "t"))
        val b = ok(store.signIn("accB", "refB", "", "t"))
        // The old session's rotation carries A's family: rejected, B survives.
        assertTrue(store.rotate(a.familyId, a.epoch, "r1", "x", "y", "t") is OpenAIOAuthTokenStore.Result.Conflict)
        // Even if the epoch numbers collide, the family decides.
        assertTrue(store.rotate(a.familyId, b.epoch, "r2", "x", "y", "t") is OpenAIOAuthTokenStore.Result.Conflict)
        assertEquals(b.familyId, present().familyId)
        // The current session rotates.
        val c = ok(store.rotate(b.familyId, b.epoch, "r3", "accC", "refC", "t2"))
        assertEquals(b.epoch + 1, c.epoch)
        assertEquals("r3", c.lastRotationId)
    }

    @Test
    fun `rotate after a sign-out is a conflict — no resurrection`() {
        val a = ok(store.signIn("acc", "ref", "", "t"))
        ok(store.signOut())
        assertTrue(store.rotate(a.familyId, a.epoch, "r", "new", "new", "t") is OpenAIOAuthTokenStore.Result.Conflict)
        assertTrue(present().tombstone)
    }

    @Test
    fun `rotate on an unreadable or absent record is a storage failure, not a sign-in change`() {
        assertTrue(store.rotate("fam", 1, "r", "a", "b", "t") is OpenAIOAuthTokenStore.Result.Failed)
        recordFile().writeText("garbage")
        assertTrue(store.rotate("fam", 1, "r", "a", "b", "t") is OpenAIOAuthTokenStore.Result.Failed)
    }

    @Test
    fun `a blank refresh token in rotate keeps the stored refresh ciphertext`() {
        val a = ok(store.signIn("acc", "ref", "", "t"))
        val b = ok(store.rotate(a.familyId, a.epoch, "r", "acc2", "", "t2"))
        assertEquals(a.refreshTokenEnc, b.refreshTokenEnc)
    }

    // ------------------------------------------------------------------ v3 §1: duplicate saves

    @Test
    fun `a rename whose directory fsync fails is unconfirmed, and a duplicate only confirms after a fresh rewrite`() {
        val a = ok(store.signIn("acc", "ref", "", "t"))
        fs.syncFails = true
        val first = store.rotate(a.familyId, a.epoch, "rot-1", "acc2", "ref2", "t2")
        assertTrue("first save: rename ok, sync failed → Unconfirmed (503)", first is OpenAIOAuthTokenStore.Result.Unconfirmed)
        assertEquals("the new record is visible", a.epoch + 1, present().epoch)
        // Duplicate while the sync still fails: still unconfirmed.
        assertTrue(store.rotate(a.familyId, a.epoch, "rot-1", "acc2", "ref2", "t2") is OpenAIOAuthTokenStore.Result.Unconfirmed)
        // Duplicate once the sync works: 200, no second epoch bump, and the record survives a power cut.
        fs.syncFails = false
        val dup = ok(store.rotate(a.familyId, a.epoch, "rot-1", "acc2", "ref2", "t2"))
        assertEquals(a.epoch + 1, dup.epoch)
        fs.powerLoss()
        assertEquals("confirmed by the rewrite, so it survives power loss", a.epoch + 1, present().epoch)
    }

    @Test
    fun `negative control — re-syncing and reading back an already-visible record is NOT proof of durability`() {
        val a = ok(store.signIn("acc", "ref", "", "t"))
        fs.syncFails = true
        store.rotate(a.familyId, a.epoch, "rot-1", "acc2", "ref2", "t2")
        fs.syncFails = false
        // What a sync-and-read-back duplicate would do: the sync now succeeds and the read-back matches…
        SafeFs.dirSyncChecked(dir.toPath())
        assertEquals(a.epoch + 1, present().epoch)
        // …yet the failed sync dropped the rename's dirty state, so a power cut still loses it.
        assertFalse(fs.isDurable(recordFile().toPath()))
        fs.powerLoss()
        assertEquals("a re-sync acknowledged a pair a power loss rolled back", a.epoch, present().epoch)
    }

    @Test
    fun `a lost reply after a durable commit is answered 200 on the first duplicate`() {
        val a = ok(store.signIn("acc", "ref", "", "t"))
        ok(store.rotate(a.familyId, a.epoch, "rot-1", "acc2", "ref2", "t2"))
        val dup = ok(store.rotate(a.familyId, a.epoch, "rot-1", "acc2", "ref2", "t2"))
        assertEquals(a.epoch + 1, dup.epoch)
        // A DIFFERENT rotation id at the old epoch is a conflict, not a duplicate.
        assertTrue(store.rotate(a.familyId, a.epoch, "rot-2", "x", "y", "t") is OpenAIOAuthTokenStore.Result.Conflict)
    }

    // ------------------------------------------------------------------ migration

    @Test
    fun `migration fills an absent store from the legacy ciphertext verbatim, then writes the marker`() {
        val l = legacy()
        assertEquals(OpenAIOAuthTokenStore.MigrateOutcome.DONE, store.migrateIfNeeded { l })
        val r = present()
        assertEquals("ciphertext copied, never decrypted and re-encrypted", l.accessEnc, r.accessTokenEnc)
        assertEquals(1L, r.epoch)
        assertTrue(r.familyId.isNotBlank())
        assertTrue(markerFile().exists())
    }

    @Test
    fun `migration never imports over a live record, a tombstone, or an unreadable file`() {
        ok(store.signIn("acc", "ref", "", "t"))
        markerFile().delete()
        val live = present()
        assertEquals(OpenAIOAuthTokenStore.MigrateOutcome.DONE, store.migrateIfNeeded { legacy() })
        assertEquals(live, present())

        ok(store.signOut()); markerFile().delete()
        store.migrateIfNeeded { legacy() }
        assertTrue("a sign-out is never resurrected by the legacy keys", present().tombstone)

        recordFile().writeText("garbage"); markerFile().delete()
        assertEquals(OpenAIOAuthTokenStore.MigrateOutcome.UNREADABLE, store.migrateIfNeeded { legacy() })
        assertFalse("no marker over an unreadable record", markerFile().exists())
    }

    @Test
    fun `a migration whose sync fails leaves no marker, and a later load finishes it`() {
        fs.syncFails = true
        assertEquals(OpenAIOAuthTokenStore.MigrateOutcome.NOT_CONFIRMED, store.migrateIfNeeded { legacy() })
        assertFalse(markerFile().exists())
        fs.powerLoss()
        assertEquals("the unconfirmed fill is undone by a power cut", OpenAIOAuthTokenStore.State.Absent, store.snapshot())
        fs.syncFails = false
        assertEquals(OpenAIOAuthTokenStore.MigrateOutcome.DONE, store.migrateIfNeeded { legacy() })
        assertTrue(markerFile().exists())
    }

    @Test
    fun `sweep confirmation re-proves a visible marker rather than trusting it`() {
        fs.syncFails = true
        store.migrateIfNeeded { legacy() } // record visible, marker not written
        assertEquals(SweepGate.NOT_CONFIRMED, store.confirmedForSweep(legacyAccessPresent = true))
        fs.syncFails = false
        assertEquals(OpenAIOAuthTokenStore.MigrateOutcome.DONE, store.migrateIfNeeded { legacy() })
        fs.syncFails = true
        assertEquals("a failing sync never permits the sweep", SweepGate.NOT_CONFIRMED, store.confirmedForSweep(true))
        fs.syncFails = false
        assertEquals(SweepGate.CONFIRMED, store.confirmedForSweep(true))
    }

    /**
     * Codex diff review #1 (ed09115a), the exact sequence: a fill whose sync fails leaves the record
     * visible but not durable; an ordinary retry (in `:node`, with no power cut in between) sees it
     * Present; then the power is cut before MAIN sweeps or any 401. The marker must never outlive
     * the record. Negative control: drop the `rewriteVerified()` in migrateIn's Present branch and
     * the marker survives over an Absent store.
     */
    @Test
    fun `failed fill, ordinary retry, power cut — the marker never outlives the record`() {
        fs.syncFails = true
        assertEquals(OpenAIOAuthTokenStore.MigrateOutcome.NOT_CONFIRMED, store.migrateIfNeeded { legacy() })
        assertTrue("the fill is visible", store.snapshot() is OpenAIOAuthTokenStore.State.Present)
        fs.syncFails = false
        assertEquals(OpenAIOAuthTokenStore.MigrateOutcome.DONE, store.migrateIfNeeded { legacy() })
        fs.powerLoss()
        assertTrue(markerFile().exists())
        assertEquals("the record the marker vouches for survived", "enc:" + "legacy-access".reversed(), present().accessTokenEnc)
    }

    @Test
    fun `Absent plus marker with a legacy access token is never swept and never refilled`() {
        ok(store.signIn("acc", "ref", "", "t"))
        recordFile().delete() // the anomaly: the marker outlived the record
        assertTrue(markerFile().exists())
        assertEquals(SweepGate.KEEP_LEGACY, store.confirmedForSweep(legacyAccessPresent = true))
        assertEquals("the marker means adopted: no refill", OpenAIOAuthTokenStore.MigrateOutcome.DONE, store.migrateIfNeeded { legacy() })
        assertEquals(OpenAIOAuthTokenStore.State.Absent, store.snapshot())
        // With only inert legacy keys (an expiry, an email) the marker alone is enough.
        assertEquals(SweepGate.CONFIRMED, store.confirmedForSweep(legacyAccessPresent = false))
    }

    // ------------------------------------------------------------------ confirm-family (v4, C1)

    private fun fp(s: String) = OpenAIOAuthTokenStore.fingerprint(s)

    @Test
    fun `confirm-family confirms a matching family and rewrites the record byte-identical`() {
        val a = ok(store.signIn("acc", "ref", "", "t"))
        val before = recordFile().readBytes()
        val out = store.confirmFamily(a.familyId, a.epoch, fp("ref")) { null }
        assertEquals(OpenAIOAuthTokenStore.ConfirmOutcome.Confirmed(a.familyId, a.epoch), out)
        assertTrue("no epoch bump, lastRotationId kept", before.contentEquals(recordFile().readBytes()))
    }

    @Test
    fun `confirm-family — C1 legacy requests never compare the stored epoch, only the fingerprint`() {
        // A record MAIN already migrated (epoch 1), and a newly filled one: both confirm a legacy request.
        val l = legacy()
        val out = store.confirmFamily(null, 0, fp("legacy-refresh")) { l }
        assertTrue("newly filled record confirms", out is OpenAIOAuthTokenStore.ConfirmOutcome.Confirmed)
        val again = store.confirmFamily(null, 0, fp("legacy-refresh")) { l }
        assertTrue("already-migrated matching record confirms", again is OpenAIOAuthTokenStore.ConfirmOutcome.Confirmed)
        assertEquals((out as OpenAIOAuthTokenStore.ConfirmOutcome.Confirmed).epoch, 1L)
        // A different refresh token is another sign-in.
        assertEquals(OpenAIOAuthTokenStore.ConfirmOutcome.FamilyChanged, store.confirmFamily(null, 0, fp("other")) { l })
    }

    @Test
    fun `confirm-family check order — unusable is reconnect before any mismatch`() {
        assertEquals(OpenAIOAuthTokenStore.ConfirmOutcome.Reconnect, store.confirmFamily("fam", 3, fp("x")) { null })
        val a = ok(store.signIn("acc", "ref", "", "t"))
        ok(store.signOut())
        // A tombstone with a moved epoch is RECONNECT, not FAMILY_CHANGED.
        assertEquals(OpenAIOAuthTokenStore.ConfirmOutcome.Reconnect, store.confirmFamily(a.familyId, a.epoch, fp("ref")) { null })
        recordFile().writeText("garbage")
        assertEquals(OpenAIOAuthTokenStore.ConfirmOutcome.Reconnect, store.confirmFamily(a.familyId, a.epoch, fp("ref")) { null })
    }

    @Test
    fun `confirm-family — another family, a moved epoch, or another refresh token is family-changed`() {
        val a = ok(store.signIn("acc", "ref", "", "t"))
        val b = ok(store.signIn("acc2", "ref2", "", "t"))
        assertEquals(OpenAIOAuthTokenStore.ConfirmOutcome.FamilyChanged, store.confirmFamily(a.familyId, a.epoch, fp("ref")) { null })
        assertEquals(OpenAIOAuthTokenStore.ConfirmOutcome.FamilyChanged, store.confirmFamily(b.familyId, b.epoch + 5, fp("ref2")) { null })
        assertEquals(OpenAIOAuthTokenStore.ConfirmOutcome.FamilyChanged, store.confirmFamily(b.familyId, b.epoch, fp("ref")) { null })
    }

    @Test
    fun `confirm-family is not confirmed while persistence is failing`() {
        val a = ok(store.signIn("acc", "ref", "", "t"))
        fs.syncFails = true
        assertTrue(store.confirmFamily(a.familyId, a.epoch, fp("ref")) { null } is OpenAIOAuthTokenStore.ConfirmOutcome.NotConfirmed)
        // A legacy request whose migration cannot be confirmed: no family handed out.
        recordFile().delete(); markerFile().delete()
        assertTrue(store.confirmFamily(null, 0, fp("legacy-refresh")) { legacy() } is OpenAIOAuthTokenStore.ConfirmOutcome.NotConfirmed)
    }

    @Test
    fun `the fingerprint uses Node's canonical form and fails closed on malformed input`() {
        val stored = "the-refresh-token"
        assertTrue(store.fingerprintMatches(stored, fp(stored)))
        assertTrue("surrounding whitespace / line breaks on either side still match",
            store.fingerprintMatches("  $stored\r\n", fp("\n$stored  ")))
        assertTrue("hex case carries no meaning", store.fingerprintMatches(stored, fp(stored).uppercase()))
        assertFalse(store.fingerprintMatches(stored, fp("other")))
        assertFalse(store.fingerprintMatches(stored, ""))
        assertFalse(store.fingerprintMatches(stored, "zz".repeat(32)))
        assertFalse(store.fingerprintMatches(stored, fp(stored).dropLast(2)))
        assertFalse("an empty stored token never matches", store.fingerprintMatches("   ", fp("")))
    }
}
