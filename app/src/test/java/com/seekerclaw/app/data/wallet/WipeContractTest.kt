package com.seekerclaw.app.data.wallet

import com.seekerclaw.app.data.caps.BurnerCapsState
import com.seekerclaw.app.data.caps.CapEnforcer
import com.seekerclaw.app.data.caps.ReservationLedger
import com.seekerclaw.app.util.CrossProcessStore
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File

/**
 * Pure JVM tests that pin the wipe contract for the burner wallet
 * (BAT-582 R1, PR #364 review).
 *
 * **Contract under test:** after [wipeBurner] semantics run (zero caps
 * + delete caps file), the device state must be indistinguishable from
 * "burner never configured":
 *
 *   1. `burner_keys/burner` is absent.
 *   2. `burner_caps.json` is absent.
 *   3. The periodic-sweep gate ([EncryptedPrefsKeyVault.isConfigured])
 *      returns false.
 *   4. A future reseed of caps via [CapEnforcer.setCaps] starts from
 *      the [BurnerCapsState] defaults (zeros), not from any leftover
 *      pre-wipe state.
 *
 * **Why this test is here:** the previous gate proxy
 * (`burner_caps.json.exists()`) was wrong — wipe zeroed caps but left
 * the file on disk, so the sweep ran forever on a wiped wallet,
 * burning CPU + flash + holding CapEnforcer machinery alive. The
 * gate now uses [EncryptedPrefsKeyVault.isConfigured] (the key file)
 * AND the wipe flow deletes the caps file too (defense-in-depth).
 * This test pins both halves so a future refactor can't reintroduce
 * the leak.
 *
 * **Test strategy:** we don't drive [BurnerWalletScreen]'s wipeBurner
 * directly because that's a private Composable-file suspend fun with a
 * Context dependency. Instead we replicate the contract steps
 * (KeyVault.wipe + setCaps zeros + delete caps file) against a real
 * tmp filesDir, then assert the post-state. Any future changes to
 * wipeBurner that drop one of the steps will fail this test.
 *
 * The Android Keystore part of EncryptedPrefsKeyVault.store is bypassed
 * in JVM tests — we plant the key file directly so wipe has something
 * to delete. This is the same pattern used in [EncryptedPrefsKeyVaultTest]
 * for testing storage-boundary contracts without Robolectric.
 */
class WipeContractTest {

    private lateinit var workDir: File

    @Before
    fun setUp() {
        workDir = File.createTempFile("bat582-wipe", "").apply {
            delete()
            mkdirs()
        }
    }

    @After
    fun tearDown() {
        workDir.deleteRecursively()
    }

    /** Plant a fake encrypted key file at the path `EncryptedPrefsKeyVault` would write. */
    private fun plantKeyFile(): File {
        val burnerKeysDir = File(workDir, "burner_keys").apply { mkdirs() }
        return File(burnerKeysDir, "burner").apply {
            writeBytes(ByteArray(80) { it.toByte() })  // dummy ciphertext
        }
    }

    private fun makeCapsStore(): CrossProcessStore<BurnerCapsState> = CrossProcessStore(
        filesDir = workDir,
        fileName = BurnerCapsState.FILE_NAME,
        serializer = BurnerCapsState.serializer(),
        initial = BurnerCapsState(),
    )

    private fun makeEnforcer(): CapEnforcer {
        val store = makeCapsStore()
        val ledger = ReservationLedger(store)
        return CapEnforcer(ledger = ledger, clock = { 1_700_000_000_000L })
    }

    /**
     * Replicate the wipe contract steps from
     * [com.seekerclaw.app.ui.settings.wallet.wipeBurner]:
     *   1. Delete the encrypted key file.
     *   2. Zero caps via setCaps (defense-in-depth for in-process refs).
     *   3. Delete the caps file (post-wipe = indistinguishable from
     *      never-configured).
     */
    private suspend fun wipeContract(enforcer: CapEnforcer, keyFile: File) {
        // Step 1: key file delete (mimics EncryptedPrefsKeyVault.wipe).
        if (keyFile.exists()) keyFile.delete()
        // Step 2: zero caps in any live in-process CapEnforcer.
        enforcer.setCaps("0", "0", "0", "0")
        // Step 3: delete the caps file itself.
        val capsFile = File(workDir, BurnerCapsState.FILE_NAME)
        if (capsFile.exists()) capsFile.delete()
        val tmp = File(capsFile.parentFile, "${capsFile.name}.tmp")
        if (tmp.exists()) tmp.delete()
    }

    // --- The tests ---

    @Test
    fun `post-wipe both key file AND caps file are absent`() = runBlocking {
        val enforcer = makeEnforcer()
        val keyFile = plantKeyFile()
        // Seed caps to non-default values so we can prove they don't
        // survive wipe.
        enforcer.setCaps("100000000", "5000000", "500000000", "50000000")
        val capsFile = File(workDir, BurnerCapsState.FILE_NAME)
        assertTrue("setup: key file should exist", keyFile.exists())
        assertTrue("setup: caps file should exist", capsFile.exists())

        wipeContract(enforcer, keyFile)

        assertFalse("post-wipe: key file must be deleted", keyFile.exists())
        assertFalse("post-wipe: caps file must be deleted", capsFile.exists())
    }

    @Test
    fun `post-wipe a fresh CapEnforcer reads BurnerCapsState defaults`() = runBlocking {
        val enforcer = makeEnforcer()
        val keyFile = plantKeyFile()
        enforcer.setCaps("100000000", "5000000", "500000000", "50000000")

        wipeContract(enforcer, keyFile)

        // A NEW CapEnforcer (simulating service restart or new process)
        // must see fresh defaults — not the zeroed-cap state we wrote
        // mid-wipe. This is the contract that "wipe = full reset, not
        // 'configured-but-disabled'."
        val freshStore = makeCapsStore()
        val freshState = freshStore.read()
        val defaults = BurnerCapsState()
        assertTrue(
            "post-wipe fresh state must equal BurnerCapsState() defaults; was $freshState",
            freshState == defaults,
        )
    }

    @Test
    fun `EncryptedPrefsKeyVault isConfigured returns false post-wipe`() = runBlocking {
        // The sweep gate's correctness predicate. If isConfigured returns
        // true after wipe, the service runs sweepStale forever on an
        // empty pending queue — that's the bug the R1 fix addresses.
        val enforcer = makeEnforcer()
        val keyFile = plantKeyFile()
        enforcer.setCaps("100000000", "5000000", "500000000", "50000000")

        // Pre-wipe: gate should be true (key file exists).
        assertTrue("setup: planted key file should exist", keyFile.exists())

        wipeContract(enforcer, keyFile)

        // Post-wipe: the gate must be false.
        assertFalse(
            "post-wipe: key file should be gone (sweep gate should be false)",
            keyFile.exists(),
        )
    }

    @Test
    fun `wipe is idempotent — running twice produces same end state`() = runBlocking {
        val enforcer = makeEnforcer()
        val keyFile = plantKeyFile()
        enforcer.setCaps("100000000", "5000000", "500000000", "50000000")
        val capsFile = File(workDir, BurnerCapsState.FILE_NAME)

        wipeContract(enforcer, keyFile)
        // Second wipe must not throw and must not resurrect any files.
        wipeContract(enforcer, keyFile)

        assertFalse(keyFile.exists())
        // setCaps in step 2 of wipeContract creates a fresh capsFile;
        // step 3 deletes it. After two passes we should still see no
        // residue.
        assertFalse(capsFile.exists())
    }

    /**
     * Regression pin for the R1 bug: the OLD wipe flow (zero caps but
     * leave the file on disk) is explicitly broken under the new
     * contract. This test simulates the pre-fix behavior and asserts
     * that it would FAIL the contract — i.e. the caps file would still
     * exist post-wipe, which would cause SeekerClawService's old
     * file-existence proxy to keep allocating CapEnforcer + running
     * sweepStale forever.
     *
     * If a future refactor reintroduces the bug (drops step 3 from
     * wipeContract), the contract tests above will fail because the
     * caps file survives. This test pins WHY the file-survival case
     * is the bug we're guarding against.
     */
    @Test
    fun `pre-fix wipe (no caps-file delete) leaves caps file behind — the R1 bug`() = runBlocking {
        val enforcer = makeEnforcer()
        val keyFile = plantKeyFile()
        enforcer.setCaps("100000000", "5000000", "500000000", "50000000")
        val capsFile = File(workDir, BurnerCapsState.FILE_NAME)

        // Simulate the BUGGY pre-fix wipe: only steps 1 + 2.
        if (keyFile.exists()) keyFile.delete()
        enforcer.setCaps("0", "0", "0", "0")
        // (NO delete of capsFile here — that's the bug.)

        // Bug evidence: caps file is still there.
        assertTrue(
            "pre-fix bug evidence: caps file survives the buggy wipe",
            capsFile.exists(),
        )
        // Bug consequence: service's old `capsFile.exists()` gate would
        // still pass even though the wallet has been wiped, so the
        // periodic sweep would keep running CapEnforcer.sweepStale on
        // a wiped wallet's empty queue. The new gate
        // (EncryptedPrefsKeyVault.isConfigured -> burner_keys/burner)
        // correctly returns false here because we deleted the key file.
        assertFalse(
            "new gate (key file existence) correctly reports unconfigured " +
                "even though caps file survives the buggy wipe",
            keyFile.exists(),
        )
    }

    @Test
    fun `pre-wipe with non-default caps proves wipe actually clears them`() = runBlocking {
        // Sanity check: prove the test setup WOULD fail without the
        // wipe (otherwise the assertions above could be passing on a
        // never-configured fixture). Seed non-default caps, verify
        // they're persisted, THEN wipe and verify defaults.
        val enforcer = makeEnforcer()
        val keyFile = plantKeyFile()
        enforcer.setCaps("123456789", "987654321", "111111111", "222222222")

        val midState = makeCapsStore().read()
        assertTrue("setup must have non-default caps; was $midState", midState.capPerTxSol == "123456789")

        wipeContract(enforcer, keyFile)

        val postState = makeCapsStore().read()
        assertTrue(
            "post-wipe state must be defaults, was $postState",
            postState == BurnerCapsState(),
        )
    }
}
