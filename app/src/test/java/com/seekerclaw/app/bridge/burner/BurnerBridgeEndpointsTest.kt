package com.seekerclaw.app.bridge.burner

import com.seekerclaw.app.data.caps.CapEnforcer
import com.seekerclaw.app.data.wallet.SolanaBalanceFetcher
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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

    // ─────────────────────────────────────────────────────────────────────────
    // BAT-1001 PR-B: /burner/status live SOL+USDC balance wiring.
    //
    // Atomic-string-or-omit contract:
    //   - balanceFetcher == null OR fetcher.fetch returns null →
    //     balanceSol AND balanceUsdc are OMITTED from the response.
    //     (Never sent as "0" or as null — downstream
    //     wallet_status.handlers distinguishes field-absent from
    //     field-present-as-zero via `status.balanceSol != null`.)
    //   - fetcher.fetch returns Balances → BOTH fields present as
    //     atomic-unit decimal strings (lamports for SOL, microunits
    //     for USDC). u64-safe via BigInteger.toString().
    //
    // We test via dispatch("/burner/status", JSONObject()) because
    // handleStatus is private; the public dispatch entry point gives
    // us the same EndpointResult to assert on.
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    fun `handleStatus omits balance fields when fetcher returns null`() = runBlocking {
        val ep = TestEndpointBuilder.buildForStatus(
            balanceFetcher = TestEndpointBuilder.StubBalanceFetcher(result = null),
            pubkey = "FakePubkey11111111111111111111111111111111",
        )
        val result = ep.dispatch("/burner/status", JSONObject())
        assertEquals(200, result!!.httpStatus)
        // The "unavailable" contract: fields ABSENT from the map,
        // not present-as-null and not present-as-"0".
        assertFalse(
            "balanceSol must be OMITTED when fetcher returns null, not present-as-null",
            result.body.containsKey("balanceSol"),
        )
        assertFalse(
            "balanceUsdc must be OMITTED when fetcher returns null, not present-as-null",
            result.body.containsKey("balanceUsdc"),
        )
        // Sanity: caps and spend ARE still present (they don't depend
        // on the RPC fetcher).
        assertTrue("capPerTxSol should still be present", result.body.containsKey("capPerTxSol"))
    }

    @Test
    fun `handleStatus emits atomic-unit decimal strings when fetcher returns balances`() = runBlocking {
        val ep = TestEndpointBuilder.buildForStatus(
            balanceFetcher = TestEndpointBuilder.StubBalanceFetcher(
                result = SolanaBalanceFetcher.Balances(
                    solLamports = BigInteger("1234567890"),       // 1.234... SOL
                    usdcMicrounits = BigInteger("9876543"),       // 9.876... USDC
                ),
            ),
            pubkey = "FakePubkey11111111111111111111111111111111",
        )
        val result = ep.dispatch("/burner/status", JSONObject())
        assertEquals(200, result!!.httpStatus)
        // Atomic units, as STRINGS (not numbers, not decimals).
        assertEquals("1234567890", result.body["balanceSol"])
        assertEquals("9876543", result.body["balanceUsdc"])
        // Type assertion: the wire shape MUST be String, not Long /
        // BigInteger / decimal. JSON serialization would coerce
        // BigInteger to scientific notation for large values; only
        // String preserves the exact atomic-unit shape.
        assertTrue("balanceSol must be a String", result.body["balanceSol"] is String)
        assertTrue("balanceUsdc must be a String", result.body["balanceUsdc"] is String)
    }

    @Test
    fun `handleStatus atomic strings are u64-safe at the upper bound`() = runBlocking {
        // u64 max = 2^64 - 1 = 18446744073709551615. Java Long max is
        // ~9.2e18, less than u64 max. Real Solana SOL supply is ~580M
        // (far below either) and USDC is similar, but the Solana spec
        // documents these fields as u64 — be correct against the spec
        // rather than the current supply. BigInteger.toString()
        // preserves the full unsigned range.
        val u64Max = BigInteger("18446744073709551615")
        val ep = TestEndpointBuilder.buildForStatus(
            balanceFetcher = TestEndpointBuilder.StubBalanceFetcher(
                result = SolanaBalanceFetcher.Balances(
                    solLamports = u64Max,
                    usdcMicrounits = u64Max,
                ),
            ),
            pubkey = "FakePubkey11111111111111111111111111111111",
        )
        val result = ep.dispatch("/burner/status", JSONObject())
        assertEquals(200, result!!.httpStatus)
        // Round-trip: exact decimal-string representation preserved.
        assertEquals("18446744073709551615", result.body["balanceSol"])
        assertEquals("18446744073709551615", result.body["balanceUsdc"])
    }

    @Test
    fun `handleStatus omits balance fields when fetcher is null (legacy path)`() = runBlocking {
        // Back-compat: an endpoint built without a fetcher (e.g. via
        // the 3-arg internal constructor in older tests) MUST omit
        // balance fields rather than crash. This preserves the v1
        // BAT-582 R2 behaviour for any code path that hasn't been
        // migrated yet.
        val ep = TestEndpointBuilder.buildForStatus(
            balanceFetcher = null,
            pubkey = "FakePubkey11111111111111111111111111111111",
        )
        val result = ep.dispatch("/burner/status", JSONObject())
        assertEquals(200, result!!.httpStatus)
        assertFalse(result.body.containsKey("balanceSol"))
        assertFalse(result.body.containsKey("balanceUsdc"))
    }

    @Test
    fun `handleStatus omits balance fields when burner is not configured (pubkey null)`() = runBlocking {
        // The fetcher only fires when configured == true. An
        // unconfigured burner (no pubkey) should never trigger an
        // RPC call — even if a fetcher is wired. Verifies the
        // configured-gate around the fetch.
        val recordingFetcher = TestEndpointBuilder.StubBalanceFetcher(
            result = SolanaBalanceFetcher.Balances(
                solLamports = BigInteger("100"),
                usdcMicrounits = BigInteger("200"),
            ),
        )
        val ep = TestEndpointBuilder.buildForStatus(
            balanceFetcher = recordingFetcher,
            pubkey = null, // not configured
        )
        val result = ep.dispatch("/burner/status", JSONObject())
        assertEquals(200, result!!.httpStatus)
        assertEquals(false, result.body["configured"])
        assertFalse("balanceSol must NOT appear for unconfigured burner", result.body.containsKey("balanceSol"))
        assertFalse("balanceUsdc must NOT appear for unconfigured burner", result.body.containsKey("balanceUsdc"))
        assertEquals(
            "fetcher.fetch must NOT be invoked when pubkey is null",
            0,
            recordingFetcher.fetchCallCount,
        )
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

    /**
     * BAT-1001 PR-B: build an endpoint instance for /burner/status
     * balance-wiring tests. The KeyVault returns the given [pubkey]
     * (so `configured` is true when non-null), the CapEnforcer is
     * real with sensible defaults so status() returns valid cap
     * fields, the JupiterOwnership is the noop seam, and the
     * [balanceFetcher] is whatever the test passed (typically a
     * StubBalanceFetcher returning a fixed Balances? value).
     */
    fun buildForStatus(
        balanceFetcher: SolanaBalanceFetcher?,
        pubkey: String?,
    ): BurnerBridgeEndpoints {
        val tmpCaps = newTempDir("status-caps")
        val capStore = com.seekerclaw.app.util.CrossProcessStore(
            filesDir = tmpCaps,
            fileName = com.seekerclaw.app.data.caps.BurnerCapsState.FILE_NAME,
            serializer = com.seekerclaw.app.data.caps.BurnerCapsState.serializer(),
            initial = com.seekerclaw.app.data.caps.BurnerCapsState(),
        )
        val enforcer = com.seekerclaw.app.data.caps.CapEnforcer(
            ledger = com.seekerclaw.app.data.caps.ReservationLedger(capStore),
        )
        return BurnerBridgeEndpoints(
            keyVault = FixedPubkeyKeyVault(pubkey),
            capEnforcer = enforcer,
            jupiterOwnership = noopOwnership(),
            balanceFetcher = balanceFetcher,
        )
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
     * BAT-1001 PR-B: KeyVault that returns a fixed pubkey (or null
     * to simulate "burner not configured"). Used by [buildForStatus]
     * so handleStatus can compute `configured = pubkey != null`
     * without needing the real EncryptedPrefsKeyVault wiring (which
     * requires a Context).
     */
    private class FixedPubkeyKeyVault(private val pubkey: String?) :
        com.seekerclaw.app.data.wallet.KeyVault {
        override suspend fun store(id: String, expanded64: ByteArray) = Unit
        override suspend fun signTransaction(id: String, txBytes: ByteArray, allowPartiallySigned: Boolean): ByteArray =
            throw NotImplementedError()
        override suspend fun getPubkey(id: String): String? = pubkey
        override suspend fun wipe(id: String) = Unit
    }

    /**
     * BAT-1001 PR-B: SolanaBalanceFetcher subclass that returns a
     * fixed Balances? result and counts fetch invocations. Used by
     * the /burner/status balance-wiring tests to verify the atomic-
     * string-or-omit contract without needing a real RPC server. The
     * primary constructor's `rpcUrlProvider` default is preserved
     * (we never reach the URL — fetch() is fully overridden).
     */
    class StubBalanceFetcher(
        private val result: SolanaBalanceFetcher.Balances?,
    ) : SolanaBalanceFetcher() {
        @Volatile var fetchCallCount: Int = 0
            private set

        override suspend fun fetch(pubkey: String): SolanaBalanceFetcher.Balances? {
            fetchCallCount++
            return result
        }
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
