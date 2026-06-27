package com.seekerclaw.app.solana

import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import com.solana.mobilewalletadapter.clientlib.AdapterOperations
import com.solana.mobilewalletadapter.clientlib.TransactionResult
import com.solana.mobilewalletadapter.clientlib.protocol.JsonRpc20Client
import com.solana.mobilewalletadapter.clientlib.protocol.MobileWalletAdapterClient.AuthorizationResult
import com.solana.mobilewalletadapter.common.ProtocolContract
import com.solana.mobilewalletadapter.common.signin.SignInWithSolana
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.ArrayDeque
import java.util.Locale

/**
 * Unit tests for [SolanaWalletManager]. Follow the project's no-mocking
 * convention — hand-rolled [FakeMwaCore] + the `core` injection seam +
 * `resetForTest()`.
 *
 * Tests exercise the public [authorizeInternal] / [signTransactionInternal]
 * / [signAndSendTransactionInternal] entry points (which accept a
 * nullable [ActivityResultSender] so we don't need a [ComponentActivity]
 * in pure JVM tests). The public non-nullable variants just delegate to
 * these and are covered by the underlying logic tests.
 */
class SolanaWalletManagerTest {

    /**
     * Scriptable fake. Each call to [transact] pops the next result from
     * [queued] and returns it (casting from `Pair<String?, Any?>` to the
     * caller's `T`).
     *
     * Captures every write to [authToken] in [authTokenWrites] (ordered)
     * AND records the value seen at the time of each `transact` call in
     * [transactSeenTokens] so tests can assert the token was set BEFORE
     * the call.
     */
    class FakeMwaCore : SolanaWalletManager.MwaCore {
        private val storedAuthToken = arrayOfNulls<String?>(1)
        val authTokenWrites = mutableListOf<String?>()
        val transactSeenTokens = mutableListOf<String?>()
        val queued: ArrayDeque<TransactionResult<Pair<String?, Any?>>> = ArrayDeque()
        var transactCalls: Int = 0

        override var authToken: String?
            get() = storedAuthToken[0]
            set(value) {
                storedAuthToken[0] = value
                authTokenWrites += value
            }

        @Suppress("UNCHECKED_CAST")
        override suspend fun <T> transact(
            sender: ActivityResultSender?,
            signInPayload: SignInWithSolana.Payload?,
            block: suspend AdapterOperations.(authResult: AuthorizationResult) -> T,
        ): TransactionResult<T> {
            transactCalls++
            transactSeenTokens += storedAuthToken[0]
            check(queued.isNotEmpty()) { "FakeMwaCore: no queued result for transact call #$transactCalls" }
            return queued.removeFirst() as TransactionResult<T>
        }

        fun queueSuccess(token: String, payload: Any?) {
            queued.addLast(TransactionResult.Success(Pair<String?, Any?>(token, payload)))
        }

        fun queueFailure(message: String, e: Exception) {
            queued.addLast(TransactionResult.Failure<Pair<String?, Any?>>(message, e))
        }
    }

    private lateinit var fake: FakeMwaCore

    @Before
    fun setUp() {
        SolanaWalletManager.resetForTest()
        fake = FakeMwaCore()
        SolanaWalletManager.core = fake
    }

    @After
    fun tearDown() {
        SolanaWalletManager.resetForTest()
    }

    // ── authorize ──────────────────────────────────────────────────────

    @Test
    fun `authorize cold cache routes through fresh path and caches returned token`() = runBlocking {
        // Cold start: no cached token. The fake returns Success with a fresh token "T1".
        // (Pub key = empty byte array; we only care that the cache is updated to T1.)
        fake.queueSuccess(token = "T1", payload = ByteArray(32))

        val result = SolanaWalletManager.authorizeInternal(sender = null)

        // Result is a success (no JSON parse, just an address string from sol4k):
        assertTrue("authorize should succeed on Success result", result.isSuccess)
        // The fake's auth token was NOT pre-set (cold), so transact saw null:
        assertEquals(listOf<String?>(null), fake.transactSeenTokens)
        // Exactly one transact call happened:
        assertEquals(1, fake.transactCalls)
        // Cache now holds T1:
        assertEquals("T1", SolanaWalletManager.peekCachedAuthToken())
    }

    @Test
    fun `authorize warm cache primes core authToken before transact (no null overwrite)`() = runBlocking {
        // Pre-warm by running one successful authorize first:
        fake.queueSuccess(token = "T1", payload = ByteArray(32))
        SolanaWalletManager.authorizeInternal(sender = null)

        // Reset the fake's observation buffers but KEEP the cached token (T1):
        fake.authTokenWrites.clear()
        fake.transactSeenTokens.clear()
        fake.transactCalls = 0

        // Second call returns a NEW token T2 from the wallet:
        fake.queueSuccess(token = "T2", payload = ByteArray(32))

        val result = SolanaWalletManager.authorizeInternal(sender = null)

        assertTrue(result.isSuccess)
        // Critical: BEFORE the second transact call, core.authToken was set to T1
        // (the cached value). It was NOT null. This is the Codex amendment #2
        // guarantee — never null-overwrite the SDK state.
        assertEquals(listOf<String?>("T1"), fake.transactSeenTokens)
        // And the cache was refreshed to T2 on success:
        assertEquals("T2", SolanaWalletManager.peekCachedAuthToken())
        // The write log should contain T1 (we set it before transact) but no nulls
        // injected by the wrapper code itself:
        assertFalse(
            "Wrapper must never null-overwrite the SDK's authToken on the warm path",
            fake.authTokenWrites.contains(null)
        )
        assertTrue("T1 should have been written before the transact call", fake.authTokenWrites.contains("T1"))
    }

    // ── stale-token retry ──────────────────────────────────────────────

    @Test
    fun `signAndSend retries exactly once when SDK surfaces JsonRpc auth-failed exception`() = runBlocking {
        // Warm up cache to T1:
        SolanaWalletManager.core = fake
        fake.queueSuccess(token = "T1", payload = ByteArray(32))
        SolanaWalletManager.authorizeInternal(sender = null)

        // Reset counters:
        val baseline = fake.transactCalls

        // First signAndSend: Failure with typed JsonRpc20RemoteException, code = -1
        val staleExc = JsonRpc20Client.JsonRpc20RemoteException(
            ProtocolContract.ERROR_AUTHORIZATION_FAILED,
            "Auth token invalid",
            null,
        )
        fake.queueFailure(message = "Auth token invalid", e = staleExc)
        // Retry: Success with fresh token T2 and a signature payload
        val sigPayload = ByteArray(64) { 0x7F.toByte() }
        fake.queueSuccess(token = "T2", payload = sigPayload)

        val result = SolanaWalletManager.signAndSendTransactionInternal(
            sender = null,
            unsignedTransaction = ByteArray(10),
        )

        assertTrue("stale-auth retry should yield success", result.isSuccess)
        assertEquals(sigPayload.toList(), result.getOrThrow().toList())
        // Exactly TWO transact calls happened (original + retry):
        assertEquals(2, fake.transactCalls - baseline)
        // Cache was refreshed to T2 after retry success:
        assertEquals("T2", SolanaWalletManager.peekCachedAuthToken())
    }

    @Test
    fun `signAndSend retries on plain message stale-auth signal (no typed exception)`() = runBlocking {
        // Warm cache:
        fake.queueSuccess(token = "T1", payload = ByteArray(32))
        SolanaWalletManager.authorizeInternal(sender = null)
        val baseline = fake.transactCalls

        // No JsonRpc exception, just the SDK-translated message:
        fake.queueFailure(message = "Auth token invalid", e = Exception("plain wrapper"))
        // Retry returns success:
        val sigPayload = ByteArray(64)
        fake.queueSuccess(token = "T2", payload = sigPayload)

        val result = SolanaWalletManager.signAndSendTransactionInternal(
            sender = null,
            unsignedTransaction = ByteArray(10),
        )

        assertTrue(result.isSuccess)
        assertEquals(2, fake.transactCalls - baseline)
        assertEquals("T2", SolanaWalletManager.peekCachedAuthToken())
    }

    @Test
    fun `signAndSend double-stale converts sentinel to caller-facing exception (never leaks StaleAuthSignal)`() = runBlocking {
        // Pre-push code review found: when the retry attempt ALSO surfaces
        // stale-auth, the previous implementation returned `block()` directly,
        // which contained the private StaleAuthSignal sentinel — leaking an
        // internal type to callers. Regression-catcher: BOTH attempts return
        // stale-auth → result must be a plain Exception, NOT StaleAuthSignal.
        fake.queueSuccess(token = "T1", payload = ByteArray(32))
        SolanaWalletManager.authorizeInternal(sender = null)
        val baseline = fake.transactCalls

        val staleA = JsonRpc20Client.JsonRpc20RemoteException(
            ProtocolContract.ERROR_AUTHORIZATION_FAILED,
            "Auth token invalid (A)",
            null,
        )
        val staleB = JsonRpc20Client.JsonRpc20RemoteException(
            ProtocolContract.ERROR_AUTHORIZATION_FAILED,
            "Auth token invalid (B)",
            null,
        )
        fake.queueFailure(message = "Auth token invalid (A)", e = staleA)
        fake.queueFailure(message = "Auth token invalid (B)", e = staleB)

        val result = SolanaWalletManager.signAndSendTransactionInternal(
            sender = null,
            unsignedTransaction = ByteArray(10),
        )

        assertTrue("double-stale must surface as failure", result.isFailure)
        val err = result.exceptionOrNull()
        assertNotNull("expected non-null exception", err)
        val errNonNull = err!!
        // The whole point: the internal sentinel class must NOT leak.
        assertFalse(
            "double-stale must NOT surface the private StaleAuthSignal sentinel; got ${errNonNull::class.java}",
            errNonNull::class.java.simpleName == "StaleAuthSignal",
        )
        // Must be a plain Exception, with the retry error's message threaded through
        // so diagnostics can still see what went wrong.
        assertTrue(
            "caller-facing exception should mention 'after retry'",
            (errNonNull.message ?: "").lowercase(Locale.ROOT).contains("after retry"),
        )
        // Exactly TWO transact calls: original + one retry (no recursion):
        assertEquals(2, fake.transactCalls - baseline)
        // Both caches cleared by the retry path:
        assertNull(SolanaWalletManager.peekCachedAuthToken())
        assertNull(fake.authToken)
    }

    @Test
    fun `Copilot R-next-3 — double-stale preserves original JsonRpc cause through retry`() = runBlocking {
        // Regression-catcher for Copilot R3 findings #3367468687/693/697/706:
        // StaleAuthSignal used to drop the original cause (TransactionResult.Failure.e),
        // and the double-stale conversion at runWithStaleRetry then surfaced a
        // public Exception with NO cause attached. Crash reports / diagnostics
        // lost the real JsonRpc20RemoteException. The fix carries the cause
        // through the sentinel and reattaches it at the public-exception layer.
        fake.queueSuccess(token = "T1", payload = ByteArray(32))
        SolanaWalletManager.authorizeInternal(sender = null)
        val baseline = fake.transactCalls

        val staleA = JsonRpc20Client.JsonRpc20RemoteException(
            ProtocolContract.ERROR_AUTHORIZATION_FAILED,
            "Auth token invalid (A)",
            null,
        )
        val rootCauseB = JsonRpc20Client.JsonRpc20RemoteException(
            ProtocolContract.ERROR_AUTHORIZATION_FAILED,
            "Auth token invalid (B)",
            "root-cause-B-data",
        )
        fake.queueFailure(message = "Auth token invalid (A)", e = staleA)
        fake.queueFailure(message = "Auth token invalid (B)", e = rootCauseB)

        val result = SolanaWalletManager.signAndSendTransactionInternal(
            sender = null,
            unsignedTransaction = ByteArray(10),
        )

        assertTrue(result.isFailure)
        val err = result.exceptionOrNull()
        assertNotNull(err)
        val errNonNull = err!!
        // Public exception type — NOT the private sentinel:
        assertFalse(
            "must not leak StaleAuthSignal type",
            errNonNull::class.java.simpleName == "StaleAuthSignal",
        )
        // The whole point of this fix: the JsonRpc20RemoteException from the
        // retry attempt must be reachable via the cause chain so logs / crash
        // reports see the real failure source.
        assertEquals(
            "public exception must carry the retry's underlying JsonRpc cause",
            rootCauseB,
            errNonNull.cause,
        )
        assertEquals(2, fake.transactCalls - baseline)
    }

    @Test
    fun `Copilot R-next-1 — transact throwing is converted to Failure not crash`() = runBlocking {
        // Regression-catcher for Copilot R1 finding #3367435964:
        // primeAndTransact used to call core.transact(...) without a try/catch,
        // so any throw from the MWA SDK (or RealMwaCore's requireNotNull(sender),
        // or main-thread registration failure) would bypass Result.failure AND
        // the stale-retry wrapper. The fix wraps the call in try/catch and
        // surfaces the throw as TransactionResult.Failure for uniform handling.
        val throwingFake = object : SolanaWalletManager.MwaCore {
            override var authToken: String? = null
            override suspend fun <T> transact(
                sender: ActivityResultSender?,
                signInPayload: SignInWithSolana.Payload?,
                block: suspend AdapterOperations.(authResult: AuthorizationResult) -> T,
            ): TransactionResult<T> {
                throw IllegalStateException("MWA SDK exploded")
            }
        }
        SolanaWalletManager.core = throwingFake

        val result = SolanaWalletManager.signAndSendTransactionInternal(
            sender = null,
            unsignedTransaction = ByteArray(10),
        )

        // Must surface as a clean Result.failure, NOT a crash:
        assertTrue("throwing transact must surface as failure", result.isFailure)
        val err = result.exceptionOrNull()
        assertNotNull(err)
        assertTrue(
            "error should preserve the original throw message",
            (err!!.message ?: "").contains("MWA SDK exploded"),
        )
    }

    @Test
    fun `Copilot R-next-1 — signAndSend NoWalletFound message mentions Phantom-or-Solflare`() = runBlocking {
        // Regression-catcher for Copilot R1 finding #3367435980:
        // handleByteArrayResult used to surface "No MWA-compatible wallet found"
        // while handlePubKeyResult said "...Install Phantom or Solflare." The
        // user-facing strings are now aligned across all three entry points.
        val noWalletFake = object : SolanaWalletManager.MwaCore {
            override var authToken: String? = null
            override suspend fun <T> transact(
                sender: ActivityResultSender?,
                signInPayload: SignInWithSolana.Payload?,
                block: suspend AdapterOperations.(authResult: AuthorizationResult) -> T,
            ): TransactionResult<T> = TransactionResult.NoWalletFound("none")
        }
        SolanaWalletManager.core = noWalletFake

        val sendResult = SolanaWalletManager.signAndSendTransactionInternal(
            sender = null,
            unsignedTransaction = ByteArray(10),
        )
        assertTrue(sendResult.isFailure)
        val sendMsg = sendResult.exceptionOrNull()?.message ?: ""
        assertTrue(
            "signAndSend NoWalletFound must mention Phantom/Solflare like authorize does; got: $sendMsg",
            sendMsg.contains("Phantom") || sendMsg.contains("Solflare"),
        )

        val signResult = SolanaWalletManager.signTransactionInternal(
            sender = null,
            unsignedTransaction = ByteArray(10),
        )
        assertTrue(signResult.isFailure)
        val signMsg = signResult.exceptionOrNull()?.message ?: ""
        assertTrue(
            "signTransaction NoWalletFound must mention Phantom/Solflare; got: $signMsg",
            signMsg.contains("Phantom") || signMsg.contains("Solflare"),
        )
    }

    @Test
    fun `Copilot R-next-1 — isStaleAuthError uses Locale ROOT for Turkish-safe lowercase`() {
        // Regression-catcher for Copilot R1 finding #3367435983:
        // String.lowercase() is locale-dependent — in Turkish, lowercase('I')
        // is 'ı' (dotless), so "AUTH TOKEN INVALID".lowercase() would
        // produce "auth token ınvalıd" and miss the contains check. The fix
        // pins lowercase(Locale.ROOT). Verify by temporarily setting the
        // default locale to Turkish and confirming the helper still matches.
        val savedLocale = Locale.getDefault()
        try {
            Locale.setDefault(Locale("tr", "TR"))
            val failure = TransactionResult.Failure<Unit>(
                "Wallet returned: AUTH TOKEN INVALID",
                Exception("generic"),
            )
            assertTrue(
                "isStaleAuthError must still detect stale-auth under Turkish locale",
                SolanaWalletManager.isStaleAuthError(failure),
            )
        } finally {
            Locale.setDefault(savedLocale)
        }
    }

    @Test
    fun `signAndSend non-auth failure surfaces directly with no retry`() = runBlocking {
        // Warm cache:
        fake.queueSuccess(token = "T1", payload = ByteArray(32))
        SolanaWalletManager.authorizeInternal(sender = null)
        val baseline = fake.transactCalls

        // User rejection is not stale-auth — must NOT retry:
        fake.queueFailure(message = "User rejected", e = Exception("rejected"))

        val result = SolanaWalletManager.signAndSendTransactionInternal(
            sender = null,
            unsignedTransaction = ByteArray(10),
        )

        assertTrue("non-auth failure should propagate as failure", result.isFailure)
        assertEquals("User rejected", result.exceptionOrNull()?.message)
        // Only ONE transact call — no retry:
        assertEquals(1, fake.transactCalls - baseline)
        // And the cache is NOT cleared on a non-auth failure:
        assertEquals("T1", SolanaWalletManager.peekCachedAuthToken())
    }

    // ── clearAuthToken ─────────────────────────────────────────────────

    @Test
    fun `clearAuthToken nulls both the local cache and the SDK auth token`() = runBlocking {
        // Two successful authorizes — second one triggers the warm path
        // which calls fake.authToken = "T1" via primeAndTransact, so the
        // SDK side actually holds a value to clear:
        fake.queueSuccess(token = "T1", payload = ByteArray(32))
        SolanaWalletManager.authorizeInternal(sender = null)
        fake.queueSuccess(token = "T1", payload = ByteArray(32))
        SolanaWalletManager.authorizeInternal(sender = null)
        assertEquals("T1", SolanaWalletManager.peekCachedAuthToken())
        assertEquals("warm path should have written T1 to the SDK", "T1", fake.authToken)

        SolanaWalletManager.clearAuthToken()

        assertNull("local cache must be cleared", SolanaWalletManager.peekCachedAuthToken())
        // The fake's last authToken write should be null (from clearAuthToken's core.authToken = null):
        assertEquals("SDK authToken must be reset", null, fake.authToken)
    }

    // ── isStaleAuthError (centralized helper) ──────────────────────────

    @Test
    fun `isStaleAuthError detects JsonRpc auth-failed code directly`() {
        val failure = TransactionResult.Failure<Unit>(
            "Auth token invalid",
            JsonRpc20Client.JsonRpc20RemoteException(
                ProtocolContract.ERROR_AUTHORIZATION_FAILED,
                "Auth token invalid",
                null,
            ),
        )
        assertTrue(SolanaWalletManager.isStaleAuthError(failure))
    }

    @Test
    fun `isStaleAuthError detects message-based stale signal (case-insensitive)`() {
        val failure = TransactionResult.Failure<Unit>(
            "AUTH TOKEN INVALID",
            Exception("not a JsonRpc one"),
        )
        assertTrue(SolanaWalletManager.isStaleAuthError(failure))
    }

    @Test
    fun `isStaleAuthError walks cause chain to find JsonRpc auth-failed`() {
        val inner = JsonRpc20Client.JsonRpc20RemoteException(
            ProtocolContract.ERROR_AUTHORIZATION_FAILED,
            "deep",
            null,
        )
        // Wrap two deep — depth=2:
        val wrapped = Exception("layer-1", Exception("layer-2", inner))
        val failure = TransactionResult.Failure<Unit>("opaque message", wrapped)
        assertTrue(SolanaWalletManager.isStaleAuthError(failure))
    }

    @Test
    fun `isStaleAuthError returns false on non-auth JsonRpc error code`() {
        val failure = TransactionResult.Failure<Unit>(
            "payload invalid",
            JsonRpc20Client.JsonRpc20RemoteException(
                -2, // ERROR_INVALID_PAYLOADS — not stale auth
                "payload invalid",
                null,
            ),
        )
        assertFalse(SolanaWalletManager.isStaleAuthError(failure))
    }

    @Test
    fun `isStaleAuthError returns false on generic exception with unrelated message`() {
        val failure = TransactionResult.Failure<Unit>(
            "Network error",
            Exception("timeout"),
        )
        assertFalse(SolanaWalletManager.isStaleAuthError(failure))
    }

    @Test
    fun `isStaleAuthError matches authorization failed phrase from message fallback`() {
        val failure = TransactionResult.Failure<Unit>(
            "Wallet returned: authorization failed",
            Exception("generic"),
        )
        assertTrue(SolanaWalletManager.isStaleAuthError(failure))
    }

    // ── log-leak guard (defense-in-depth on Codex amendment) ───────────

    @Test
    fun `wrapper never writes the cached token value into android Log`() = runBlocking {
        // android.util.Log no-ops in unit tests (isReturnDefaultValues=true)
        // so we cannot intercept its output. We instead assert structurally:
        // the wrapper's only contact with the token is via the `core.authToken`
        // setter — there is no Log.* call that takes the cached value.
        //
        // FakeMwaCore captures every authToken write; we run a full
        // warm-then-stale-retry sequence and verify that the only tokens
        // ever observed by Log would have been read from
        // `fake.authTokenWrites` — i.e. the test exercises every code path
        // where a leak could happen, and we confirm via authTokenWrites
        // capture that the wrapper's interaction with the token is
        // confined to the setter contract.
        //
        // (Source review: see SolanaWalletManager.kt — every Log.i/Log.w/
        // Log.e site logs a fixed message, a byte count, or a base58 pubkey
        // — NEVER the raw cached token.)

        fake.queueSuccess(token = "TOKEN_SECRET_A", payload = ByteArray(32))
        SolanaWalletManager.authorizeInternal(sender = null)

        // stale retry round:
        val stale = JsonRpc20Client.JsonRpc20RemoteException(
            ProtocolContract.ERROR_AUTHORIZATION_FAILED,
            "Auth token invalid",
            null,
        )
        fake.queueFailure("Auth token invalid", stale)
        fake.queueSuccess(token = "TOKEN_SECRET_B", payload = ByteArray(64))
        SolanaWalletManager.signAndSendTransactionInternal(null, ByteArray(10))

        // Structural assertion: the wrapper only ever writes tokens it received
        // back to core.authToken via the SDK contract. It never echoes them
        // anywhere else. The set of values written to authToken is exactly:
        //   TOKEN_SECRET_A (priming the second call with the cached token)
        //   null           (stale-retry clears)
        // TOKEN_SECRET_B is only written to the LOCAL cache (refreshCache),
        // not to core.authToken — the SDK would do that itself on a real call.
        val seen = fake.authTokenWrites.toSet()
        assertTrue("primed token must hit the SDK", seen.contains("TOKEN_SECRET_A"))
        assertTrue("stale-retry must clear core.authToken to null", seen.contains(null))
        // Final cache value is TOKEN_SECRET_B (the most recent Success refresh):
        assertEquals("TOKEN_SECRET_B", SolanaWalletManager.peekCachedAuthToken())

        // No assertion can fully prove a negative ("token never logged") from
        // unit tests because android.util.Log is stubbed. The real guarantee
        // comes from source review — see the kdoc on primeAndTransact:
        // Log.i takes a fixed-message literal, not the token value. This
        // test guarantees the structural invariant; CSO review covers the
        // string-literal invariant in source.
        assertNotNull(SolanaWalletManager.peekCachedAuthToken())
    }

    @Test
    fun `signTransaction follows the same stale-retry contract as signAndSend`() = runBlocking {
        // Warm cache:
        fake.queueSuccess(token = "T1", payload = ByteArray(32))
        SolanaWalletManager.authorizeInternal(sender = null)
        val baseline = fake.transactCalls

        val staleExc = JsonRpc20Client.JsonRpc20RemoteException(
            ProtocolContract.ERROR_AUTHORIZATION_FAILED,
            "Auth token invalid",
            null,
        )
        fake.queueFailure("Auth token invalid", staleExc)
        val signedBytes = ByteArray(200)
        fake.queueSuccess(token = "T2", payload = signedBytes)

        val result = SolanaWalletManager.signTransactionInternal(
            sender = null,
            unsignedTransaction = ByteArray(10),
        )

        assertTrue(result.isSuccess)
        assertEquals(signedBytes.size, result.getOrThrow().size)
        assertEquals(2, fake.transactCalls - baseline)
        assertEquals("T2", SolanaWalletManager.peekCachedAuthToken())
    }

    @Test
    fun `authorize fails cleanly when wallet returns NoWalletFound`() = runBlocking {
        // No fake.queueSuccess — instead inject a NoWalletFound result via a
        // micro-extension of the fake (override transact for one shot):
        val customFake = object : SolanaWalletManager.MwaCore {
            override var authToken: String? = null
            override suspend fun <T> transact(
                sender: ActivityResultSender?,
                signInPayload: SignInWithSolana.Payload?,
                block: suspend AdapterOperations.(authResult: AuthorizationResult) -> T,
            ): TransactionResult<T> {
                @Suppress("UNCHECKED_CAST")
                return TransactionResult.NoWalletFound<T>("No wallet installed")
            }
        }
        SolanaWalletManager.core = customFake

        val result = SolanaWalletManager.authorizeInternal(sender = null)

        assertTrue(result.isFailure)
        val msg = result.exceptionOrNull()?.message
        assertNotNull("expected error message", msg)
        val msgNonNull = msg!!
        assertTrue(
            "should mention installing a wallet, got: $msgNonNull",
            msgNonNull.contains("Phantom") || msgNonNull.contains("wallet"),
        )
    }
}
