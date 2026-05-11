package com.seekerclaw.app.bridge.burner

import com.seekerclaw.app.data.caps.CapEnforcer
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.math.BigInteger

/**
 * Pure-JVM tests for the response allowlist + scrubber on
 * BurnerBridgeEndpoints (BAT-582).
 *
 * The endpoint dispatch handlers themselves require a Context to wire
 * KeyVault + CapEnforcer + JupiterOwnership; those are covered by
 * device tests (instrumented). The scrubber path is the ONE thing we
 * MUST exercise in pure JVM — it's the defense-in-depth gate that
 * stops accidental key bytes from leaving Android in any response.
 */
class BurnerBridgeEndpointsTest {

    @After
    fun tearDown() {
        // BAT-582 R1: TestEndpointBuilder allocates a tmp dir per
        // CapEnforcer + JupiterOwnershipEndpoint inside `build()`. Each
        // test creates its own pair (via `newEndpoints()`), so without
        // an explicit cleanup the dirs leak across runs and bloat the
        // OS tmp space. We track them in `TestEndpointBuilder` and
        // delete here — JUnit 4 calls @After after every @Test (success
        // OR failure) so cleanup is guaranteed even on assertion
        // failures.
        TestEndpointBuilder.cleanupTempDirs()
    }

    private fun newEndpoints(): BurnerBridgeEndpoints {
        // Build via reflection-bypass: use a no-op fake KeyVault +
        // ledger-less CapEnforcer + ownership, since scrubResponse is
        // a pure function and doesn't touch any of them. We just need
        // an instance to call .scrubResponse on.
        // We achieve this with a minimal construction by passing null
        // through unchecked casts — but we don't actually invoke any
        // dispatch handler in this test, only the pure scrubResponse.
        // To avoid Context, we lift scrubResponse to a static-equivalent
        // by constructing through the test seam below.
        return TestEndpointBuilder.build()
    }

    @Test
    fun `allowlist drops field named key`() {
        val ep = newEndpoints()
        val scrubbed = ep.scrubResponse(mapOf("ok" to true, "key" to "leaky-secret"))
        assertEquals(true, scrubbed["ok"])
        assertNull(scrubbed["key"])
    }

    @Test
    fun `allowlist drops field named seed`() {
        val ep = newEndpoints()
        val scrubbed = ep.scrubResponse(mapOf("ok" to true, "seed" to "leaky"))
        assertNull(scrubbed["seed"])
    }

    @Test
    fun `allowlist drops field named secret`() {
        val ep = newEndpoints()
        val scrubbed = ep.scrubResponse(mapOf("ok" to true, "secret" to "leaky"))
        assertNull(scrubbed["secret"])
    }

    @Test
    fun `allowlist drops fields starting with private`() {
        val ep = newEndpoints()
        val scrubbed = ep.scrubResponse(
            mapOf(
                "ok" to true,
                "privateKey" to "leaky",
                "privateSeed" to "leaky",
                "private_key" to "leaky",
            )
        )
        assertEquals(true, scrubbed["ok"])
        assertNull(scrubbed["privateKey"])
        assertNull(scrubbed["privateSeed"])
        assertNull(scrubbed["private_key"])
    }

    @Test
    fun `allowlist drops fields not in allowlist even if otherwise innocuous`() {
        val ep = newEndpoints()
        val scrubbed = ep.scrubResponse(mapOf("ok" to true, "debugTrace" to "stuff"))
        assertEquals(true, scrubbed["ok"])
        assertNull(scrubbed["debugTrace"])
    }

    @Test
    fun `allowlist preserves all expected response fields`() {
        val ep = newEndpoints()
        val full = mapOf(
            "ok" to true,
            "error" to "some_code",
            "reason" to "explanation",
            "configured" to false,
            "pubkey" to "abc123",
            "balanceSol" to "0",
            "balanceUsdc" to "0",
            "capPerTxSol" to "100",
            "capPerTxUsdc" to "100",
            "capDailySol" to "1000",
            "capDailyUsdc" to "1000",
            "spentTodaySol" to "0",
            "spentTodayUsdc" to "0",
            "network" to "mainnet",
            "reservationId" to "uuid",
            "signedTxBase64" to "AAA=",
            "signature" to "SIG",
            // BAT-582 Phase 5: /jupiter/order-owner/get response field.
            "creatorWalletRole" to "burner",
        )
        val scrubbed = ep.scrubResponse(full)
        // Every field survives
        assertEquals(full.size, scrubbed.size)
        for ((k, v) in full) {
            assertEquals("field $k preserved", v, scrubbed[k])
        }
    }

    @Test
    fun `case insensitive key forbidden check rejects KEY SEED SECRET`() {
        val ep = newEndpoints()
        val scrubbed = ep.scrubResponse(
            mapOf(
                "ok" to true,
                "KEY" to "leaky",
                "Seed" to "leaky",
                "SECRET" to "leaky",
                "PrivateKey" to "leaky",
            )
        )
        assertEquals(true, scrubbed["ok"])
        assertEquals("only ok survives", 1, scrubbed.size)
    }

    @Test
    fun `error responses also go through scrubber`() {
        // Simulate an error response that accidentally contains a key field
        // due to a bug — assert it's stripped.
        val ep = newEndpoints()
        val errorBody = mapOf(
            "error" to "burner_not_configured",
            "reason" to "no key set",
            "key" to "OOPS_LEAKED_KEY",
        )
        val scrubbed = ep.scrubResponse(errorBody)
        assertNull(scrubbed["key"])
        assertEquals("burner_not_configured", scrubbed["error"])
    }

    @Test
    fun `nested-looking field names are dropped if not in allowlist`() {
        val ep = newEndpoints()
        val scrubbed = ep.scrubResponse(
            mapOf(
                "ok" to true,
                "kSeedRoot" to "fine name but not allowlisted",
                "wallet.key" to "weird name",
            )
        )
        assertEquals(1, scrubbed.size)
        assertEquals(true, scrubbed["ok"])
    }

    // ─────────────────────────────────────────────────────────────────────────
    // BAT-582 R2: /burner/sign-transaction reservation-validation gate
    //
    // The CRITICAL security finding from PR #364 R2: the endpoint accepted
    // any non-empty reservationId and produced a signature unconditionally,
    // bypassing the cap state machine entirely. These tests verify the
    // four lookup outcomes — NotFound, Expired, NotPending, Pending — each
    // map to the right error code (or to a sign attempt for the happy path).
    //
    // Why the tests live HERE and not in CapEnforcerTest: CapEnforcer.lookupReservation
    // has its own lookup-shape tests in CapEnforcerTest. THIS file's tests
    // cover the bridge integration: that handleSignTransactionInternal
    // actually CALLS the lookup before signing, and that the error codes
    // surface correctly through the ErrorCodes vocabulary.
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    fun `sign-transaction with unknown reservationId returns reservation_not_found`() = runBlocking {
        val (ep, _, recorder) = TestEndpointBuilder.buildWithRealCapEnforcer()
        // Pre-fix bug: this would have signed for arbitrary input.
        val res = ep.handleSignTransactionInternal(
            txB64 = "AAA=",
            reservationId = "totally-fake-id",
        )
        assertEquals("must reject pre-sign with 400", 400, res.httpStatus)
        assertEquals(BurnerBridgeEndpoints.ErrorCodes.RESERVATION_NOT_FOUND, res.body["error"])
        assertNull("must NOT produce signedTxBase64 on validation failure", res.body["signedTxBase64"])
        assertEquals("KeyVault.signTransaction must NOT be invoked", 0, recorder.signCount)
    }

    @Test
    fun `sign-transaction with expired reservation returns reservation_expired`() = runBlocking {
        val (ep, enforcer, recorder) = TestEndpointBuilder.buildWithRealCapEnforcer(clockTickMs = 0L)
        // Configure caps so reserve will succeed.
        enforcer.setCaps(capPerTxSol = "100000000", capDailySol = "1000000000")
        val r = enforcer.reserve("burner.daily.sol", BigInteger("50000000"), ttlMs = 60_000)
        val resId = (r as CapEnforcer.ReserveResult.Ok).reservationId

        // Advance the clock past the TTL — the lookup must see Expired.
        TestEndpointBuilder.advanceTestClock(70_000)

        val res = ep.handleSignTransactionInternal(
            txB64 = "AAA=",
            reservationId = resId,
        )
        assertEquals(400, res.httpStatus)
        assertEquals(BurnerBridgeEndpoints.ErrorCodes.RESERVATION_EXPIRED, res.body["error"])
        assertNull(res.body["signedTxBase64"])
        assertEquals("KeyVault must NOT sign for expired reservation", 0, recorder.signCount)
    }

    @Test
    fun `sign-transaction with already-committed reservation returns reservation_not_pending`() = runBlocking {
        val (ep, enforcer, recorder) = TestEndpointBuilder.buildWithRealCapEnforcer()
        enforcer.setCaps(capPerTxSol = "100000000", capDailySol = "1000000000")
        val r = enforcer.reserve("burner.daily.sol", BigInteger("50000000"))
        val resId = (r as CapEnforcer.ReserveResult.Ok).reservationId

        // Commit it — disposed-id ring now records this id as finalized.
        enforcer.commit(resId, signature = null)

        val res = ep.handleSignTransactionInternal(
            txB64 = "AAA=",
            reservationId = resId,
        )
        assertEquals(400, res.httpStatus)
        assertEquals(
            BurnerBridgeEndpoints.ErrorCodes.RESERVATION_NOT_PENDING,
            res.body["error"]
        )
        assertNull(res.body["signedTxBase64"])
        assertEquals("KeyVault must NOT sign a committed reservation", 0, recorder.signCount)
    }

    @Test
    fun `sign-transaction with already-released reservation returns reservation_not_pending`() = runBlocking {
        val (ep, enforcer, recorder) = TestEndpointBuilder.buildWithRealCapEnforcer()
        enforcer.setCaps(capPerTxSol = "100000000", capDailySol = "1000000000")
        val r = enforcer.reserve("burner.daily.sol", BigInteger("50000000"))
        val resId = (r as CapEnforcer.ReserveResult.Ok).reservationId

        // Release it — disposed-id ring records this id as finalized too.
        enforcer.release(resId, "test-release")

        val res = ep.handleSignTransactionInternal(
            txB64 = "AAA=",
            reservationId = resId,
        )
        assertEquals(400, res.httpStatus)
        assertEquals(
            BurnerBridgeEndpoints.ErrorCodes.RESERVATION_NOT_PENDING,
            res.body["error"]
        )
        assertEquals("KeyVault must NOT sign a released reservation", 0, recorder.signCount)
    }

    @Test
    fun `sign-transaction with pending unexpired reservation reaches the signer`() = runBlocking {
        val (ep, enforcer, recorder) = TestEndpointBuilder.buildWithRealCapEnforcer()
        enforcer.setCaps(capPerTxSol = "100000000", capDailySol = "1000000000")
        val r = enforcer.reserve("burner.daily.sol", BigInteger("50000000"))
        val resId = (r as CapEnforcer.ReserveResult.Ok).reservationId

        // Use the decoded entry point — the Base64 decode in the public
        // handler is stubbed in pure-JVM tests (returnDefaultValues=true
        // → returns null), so we'd never reach the KeyVault to verify the
        // sign call. signTransactionDecoded skips the decode and runs
        // identical validation + signing. This proves "validation passes
        // → KeyVault.signTransaction is invoked exactly once".
        val res = ep.handleSignTransactionDecoded(
            reservationId = resId,
            txBytes = ByteArray(8) { 0x01.toByte() },
        )

        assertEquals(
            "KeyVault.signTransaction must be invoked exactly once for a pending+fresh reservation",
            1,
            recorder.signCount,
        )
        // No reservation-validation error code on the happy path.
        val errCode = res.body["error"] as String?
        if (errCode != null) {
            assertNotEquals(
                BurnerBridgeEndpoints.ErrorCodes.RESERVATION_NOT_FOUND,
                errCode,
            )
            assertNotEquals(
                BurnerBridgeEndpoints.ErrorCodes.RESERVATION_EXPIRED,
                errCode,
            )
            assertNotEquals(
                BurnerBridgeEndpoints.ErrorCodes.RESERVATION_NOT_PENDING,
                errCode,
            )
        }
    }

    @Test
    fun `sign-transaction missing fields still fails before reservation lookup`() = runBlocking {
        val (ep, _, recorder) = TestEndpointBuilder.buildWithRealCapEnforcer()
        val res1 = ep.handleSignTransactionInternal(txB64 = "", reservationId = "anything")
        assertEquals(400, res1.httpStatus)
        assertEquals(BurnerBridgeEndpoints.ErrorCodes.INVALID_INPUT, res1.body["error"])

        val res2 = ep.handleSignTransactionInternal(txB64 = "AAA=", reservationId = "")
        assertEquals(400, res2.httpStatus)
        assertEquals(BurnerBridgeEndpoints.ErrorCodes.INVALID_INPUT, res2.body["error"])

        assertEquals("KeyVault never invoked when args are malformed", 0, recorder.signCount)
    }
}

/**
 * Test seam: build a BurnerBridgeEndpoints instance whose dispatch
 * handlers are inert (we never call them in scrubResponse tests). We
 * use null-bypass casts since the scrubber doesn't reach into any
 * dependency. If a future change makes scrubResponse touch the
 * dependencies, replace this with a Robolectric-backed instance.
 */
private object TestEndpointBuilder {
    // BAT-582 R1: track every tmp dir allocated by build() so the test
    // class's @After can recursively delete them. Without this, every
    // @Test run leaks two temp dirs (one for caps, one for ownership)
    // that survive on disk across test runs and bloat the OS tmp space.
    private val tempDirs = mutableListOf<java.io.File>()

    // BAT-582 R2: shared mutable clock for sign-transaction tests that
    // need to age reservations past TTL. Each call to buildWithRealCapEnforcer
    // resets it to a known epoch; advanceTestClock() bumps it forward.
    @Volatile
    private var testClockMs: Long = 0L

    fun build(): BurnerBridgeEndpoints {
        // Use the internal test-only constructor that bypasses the
        // Context-resolving production wiring. NoopKeyVault provides
        // a dependency-free signing surface; the cap enforcer + owner
        // each get a tmp-dir-backed CrossProcessStore. None of these
        // are actually invoked by scrubResponse, but constructor
        // arguments must be non-null so the type system stays sound.
        return BurnerBridgeEndpoints(
            keyVault = NoopKeyVault,
            capEnforcer = noopCapEnforcer(),
            jupiterOwnership = noopOwnership(),
        )
    }

    /**
     * BAT-582 R2: build the endpoints with a REAL CapEnforcer + a
     * recording KeyVault, so sign-transaction validation tests can
     * exercise the actual reserve/commit/release/lookup state machine.
     *
     * The third tuple element is the [RecordingKeyVault] — tests use it
     * to assert "signTransaction was (or was not) called", which is the
     * canonical proof that the validation gate either passed or short-
     * circuited as expected.
     *
     * [clockTickMs] is the initial epoch for the cap enforcer's clock;
     * tests then call [advanceTestClock] to age reservations past TTL.
     */
    fun buildWithRealCapEnforcer(
        clockTickMs: Long = 1_700_000_000_000L,
    ): Triple<BurnerBridgeEndpoints, com.seekerclaw.app.data.caps.CapEnforcer, RecordingKeyVault> {
        testClockMs = clockTickMs
        val tmpCaps = newTempDir("signtx-caps")
        val capStore = com.seekerclaw.app.util.CrossProcessStore(
            filesDir = tmpCaps,
            fileName = com.seekerclaw.app.data.caps.BurnerCapsState.FILE_NAME,
            serializer = com.seekerclaw.app.data.caps.BurnerCapsState.serializer(),
            initial = com.seekerclaw.app.data.caps.BurnerCapsState(),
        )
        val ledger = com.seekerclaw.app.data.caps.ReservationLedger(capStore)
        val enforcer = com.seekerclaw.app.data.caps.CapEnforcer(
            ledger = ledger,
            clock = { testClockMs },
        )
        val keyVault = RecordingKeyVault()
        val ep = BurnerBridgeEndpoints(
            keyVault = keyVault,
            capEnforcer = enforcer,
            jupiterOwnership = noopOwnership(),
        )
        return Triple(ep, enforcer, keyVault)
    }

    /** Advance the shared test clock by [deltaMs] for currently-running test. */
    fun advanceTestClock(deltaMs: Long) {
        testClockMs += deltaMs
    }

    fun cleanupTempDirs() {
        synchronized(tempDirs) {
            for (dir in tempDirs) {
                try { dir.deleteRecursively() } catch (_: Exception) { /* best-effort */ }
            }
            tempDirs.clear()
        }
    }

    private fun newTempDir(prefix: String): java.io.File {
        val dir = java.io.File.createTempFile(prefix, "").apply {
            delete()
            mkdirs()
        }
        synchronized(tempDirs) { tempDirs.add(dir) }
        return dir
    }

    private object NoopKeyVault : com.seekerclaw.app.data.wallet.KeyVault {
        override suspend fun store(id: String, expanded64: ByteArray) = Unit
        // BAT-582 v1.6 Phase 5d: signTransaction grew an allowPartiallySigned
        // param. Default values only apply at call sites; overrides must
        // explicitly declare the param to match the interface contract.
        override suspend fun signTransaction(id: String, txBytes: ByteArray, allowPartiallySigned: Boolean): ByteArray =
            throw NotImplementedError()
        override suspend fun getPubkey(id: String): String? = null
        override suspend fun wipe(id: String) = Unit
    }

    /**
     * BAT-582 R2: KeyVault that counts how many times signTransaction is
     * invoked. Tests assert the count to prove the validation gate either
     * blocked or admitted the request as intended. signTransaction
     * returns a fixed byte array (so the success path doesn't trip
     * null-checks); the actual signature bytes are not inspected.
     */
    class RecordingKeyVault : com.seekerclaw.app.data.wallet.KeyVault {
        @Volatile var signCount: Int = 0
            private set

        override suspend fun store(id: String, expanded64: ByteArray) = Unit
        // BAT-582 v1.6 Phase 5d: signTransaction grew an allowPartiallySigned
        // param. Recording stub ignores the flag — call-count is what these
        // tests assert.
        override suspend fun signTransaction(id: String, txBytes: ByteArray, allowPartiallySigned: Boolean): ByteArray {
            signCount++
            // Return fake "signed" bytes — base64 encoding is stubbed in
            // unit tests (returnDefaultValues=true) so the exact contents
            // don't matter for the assertion-by-call-count strategy.
            return ByteArray(64) { 0xAB.toByte() }
        }
        override suspend fun getPubkey(id: String): String? = null
        override suspend fun wipe(id: String) = Unit
    }

    private fun noopCapEnforcer(): com.seekerclaw.app.data.caps.CapEnforcer {
        // CapEnforcer requires a ReservationLedger which requires a
        // CrossProcessStore. We use the test-only constructor with a
        // tmp dir tracked via newTempDir() for @After cleanup.
        val tmp = newTempDir("scrub-test-caps")
        val store = com.seekerclaw.app.util.CrossProcessStore(
            filesDir = tmp,
            fileName = com.seekerclaw.app.data.caps.BurnerCapsState.FILE_NAME,
            serializer = com.seekerclaw.app.data.caps.BurnerCapsState.serializer(),
            initial = com.seekerclaw.app.data.caps.BurnerCapsState(),
        )
        return com.seekerclaw.app.data.caps.CapEnforcer(
            ledger = com.seekerclaw.app.data.caps.ReservationLedger(store),
        )
    }

    private fun noopOwnership(): JupiterOwnershipEndpoint {
        val tmp = newTempDir("scrub-test-own")
        val store = com.seekerclaw.app.util.CrossProcessStore(
            filesDir = tmp,
            fileName = JupiterOwnershipState.FILE_NAME,
            serializer = JupiterOwnershipState.serializer(),
            initial = JupiterOwnershipState(),
        )
        return JupiterOwnershipEndpoint(store)
    }
}
