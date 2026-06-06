package com.seekerclaw.app.solana

import android.net.Uri
import android.os.Looper
import android.util.Log
import androidx.annotation.VisibleForTesting
import java.util.Locale
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import com.solana.mobilewalletadapter.clientlib.AdapterOperations
import com.solana.mobilewalletadapter.clientlib.ConnectionIdentity
import com.solana.mobilewalletadapter.clientlib.MobileWalletAdapter
import com.solana.mobilewalletadapter.clientlib.Solana
import com.solana.mobilewalletadapter.clientlib.TransactionResult
import com.solana.mobilewalletadapter.clientlib.protocol.JsonRpc20Client
import com.solana.mobilewalletadapter.clientlib.protocol.MobileWalletAdapterClient.AuthorizationResult
import com.solana.mobilewalletadapter.common.ProtocolContract
import com.solana.mobilewalletadapter.common.signin.SignInWithSolana

/**
 * Wraps [MobileWalletAdapter] with an app-local auth-token cache so that
 * subsequent transactions take the SDK's silent reauthorize path instead
 * of bouncing the user back to the wallet picker on every signature.
 *
 * ## Threading
 *
 * Every public suspend function in this object MUST be invoked on
 * `Dispatchers.Main`. MWA's `ActivityResultLauncher` registration is
 * main-thread-only; calling from any other dispatcher will crash inside
 * the SDK. The defensive [assertMainThread] guard at the top of each
 * entry point enforces this at runtime — it is intentional belt-and-
 * suspenders given that the singleton may be called from future ViewModel
 * or service code paths that don't already pin to Main.
 *
 * ## Auth-token cache
 *
 * [cachedAuthToken] is the process-local memory of the last auth token
 * returned by a successful authorize/reauthorize round-trip. It is
 * `@Volatile` because the singleton is reachable from any thread (Node.js
 * bridge calls, UI, services) — even though writes only happen from
 * Main, reads from other threads (e.g. a future debug screen) must
 * see the latest value without tearing or stale-cache surprises.
 *
 * The cache is intentionally process-only — it is NOT persisted across
 * process death. nodejs-mobile + the foreground service keep the process
 * alive in normal operation; on cold start the user signs once and the
 * cache repopulates.
 *
 * ## Stale-token retry
 *
 * If the wallet has revoked the auth token on its side (user disconnect,
 * wallet reinstall, time-out), the SDK surfaces a
 * [JsonRpc20Client.JsonRpc20RemoteException] with code
 * [ProtocolContract.ERROR_AUTHORIZATION_FAILED] (-1). When [isStaleAuthError]
 * detects that, both caches are cleared and the operation is retried
 * exactly ONCE so the user only sees a single wallet popup rather than
 * an opaque failure.
 */
object SolanaWalletManager {
    private const val TAG = "SolanaWallet"

    /**
     * Indirection over [MobileWalletAdapter] so unit tests can supply a
     * fake. Production wiring is [RealMwaCore]; tests swap in a scripted
     * fake before exercising [authorize] / [signTransaction] /
     * [signAndSendTransaction].
     */
    internal interface MwaCore {
        var authToken: String?
        /**
         * `sender` is nullable on the interface to let unit tests pass
         * `null` (constructing a real [ActivityResultSender] requires a
         * `ComponentActivity` which is unavailable in pure JVM tests).
         * The production [RealMwaCore] enforces non-null at runtime.
         */
        suspend fun <T> transact(
            sender: ActivityResultSender?,
            signInPayload: SignInWithSolana.Payload? = null,
            block: suspend AdapterOperations.(authResult: AuthorizationResult) -> T,
        ): TransactionResult<T>
    }

    /** Default production [MwaCore] that delegates straight to the real SDK adapter. */
    internal class RealMwaCore(private val adapter: MobileWalletAdapter) : MwaCore {
        override var authToken: String?
            get() = adapter.authToken
            set(value) { adapter.authToken = value }

        override suspend fun <T> transact(
            sender: ActivityResultSender?,
            signInPayload: SignInWithSolana.Payload?,
            block: suspend AdapterOperations.(authResult: AuthorizationResult) -> T,
        ): TransactionResult<T> {
            val realSender = requireNotNull(sender) { "ActivityResultSender required for real MWA transact" }
            return adapter.transact(realSender, signInPayload, block)
        }
    }

    private fun buildAdapter(): MobileWalletAdapter = MobileWalletAdapter(
        connectionIdentity = ConnectionIdentity(
            identityUri = Uri.parse("https://seekerclaw.xyz"),
            iconUri = Uri.parse("favicon.ico"),
            identityName = "SeekerClaw",
        )
    ).apply {
        blockchain = Solana.Mainnet
    }

    /**
     * Injectable seam. Constructed lazily so production `Uri.parse(...)`
     * inside [buildAdapter] is not triggered during object init —
     * important because (a) JVM unit tests never call into the real
     * adapter, and (b) `Uri.parse` returns null under
     * `unitTests.isReturnDefaultValues = true` which would crash
     * `<clinit>` before tests get a chance to swap the seam.
     *
     * Tests assign [overrideCore] before invoking any public method.
     */
    private var overrideCore: MwaCore? = null
    private val realCore: MwaCore by lazy { RealMwaCore(buildAdapter()) }

    @VisibleForTesting
    internal var core: MwaCore
        get() = overrideCore ?: realCore
        set(value) { overrideCore = value }

    /**
     * Process-local cached auth token. `null` means "no token yet —
     * fall through to the fresh-authorize path". See class kdoc for
     * the @Volatile rationale.
     */
    @Volatile
    private var cachedAuthToken: String? = null

    /** Test-only inspection of the cache. */
    @VisibleForTesting
    internal fun peekCachedAuthToken(): String? = cachedAuthToken

    /** Test-only reset between tests. Clears cached token and the injected core override. */
    @VisibleForTesting
    internal fun resetForTest() {
        cachedAuthToken = null
        overrideCore = null
    }

    /**
     * Explicit disconnect entry point — call this whenever the user
     * disconnects, wipes the wallet, or the persisted wallet address
     * is cleared. Drops both our process cache and the SDK's own copy
     * so the next [authorize] call reliably triggers a fresh consent
     * popup.
     *
     * **Threading:** call from the main thread. The function is non-
     * suspend and runs synchronously; UI button `onClick` handlers
     * already satisfy this. The `@Volatile cachedAuthToken` write is
     * thread-safe regardless, but the SDK's `core.authToken` setter
     * has no documented thread-safety guarantee, so do not call this
     * concurrently with an in-flight transact on another thread.
     */
    fun clearAuthToken() {
        val hadCached = cachedAuthToken != null
        cachedAuthToken = null
        core.authToken = null
        if (hadCached) {
            Log.i(TAG, "Clearing cached MWA authToken (explicit disconnect)")
        }
    }

    /**
     * Acquire / refresh an authorization. On a warm cache the SDK runs
     * the silent reauthorize path and returns immediately with the same
     * address; on a cold cache the user sees the wallet picker.
     */
    suspend fun authorize(
        sender: ActivityResultSender,
    ): Result<String> = authorizeInternal(sender)

    @VisibleForTesting
    internal suspend fun authorizeInternal(
        sender: ActivityResultSender?,
    ): Result<String> {
        assertMainThread()
        return runWithStaleRetry(op = "authorize") {
            val result = primeAndTransact(sender) { authResult ->
                Pair(authResult.authToken, authResult.accounts.firstOrNull()?.publicKey)
            }
            handlePubKeyResult(result, op = "authorize")
        }
    }

    /**
     * Sign AND broadcast a transaction via MWA.
     * The wallet handles both signing and submitting to the network.
     * Returns the raw transaction signature bytes (64 bytes).
     */
    suspend fun signAndSendTransaction(
        sender: ActivityResultSender,
        unsignedTransaction: ByteArray,
    ): Result<ByteArray> = signAndSendTransactionInternal(sender, unsignedTransaction)

    @VisibleForTesting
    internal suspend fun signAndSendTransactionInternal(
        sender: ActivityResultSender?,
        unsignedTransaction: ByteArray,
    ): Result<ByteArray> {
        assertMainThread()
        return runWithStaleRetry(op = "signAndSend") {
            val result = primeAndTransact(sender) { authResult ->
                val sig = signAndSendTransactions(arrayOf(unsignedTransaction))
                    .signatures.firstOrNull()
                Pair(authResult.authToken, sig)
            }
            handleByteArrayResult(result, op = "signAndSend", emptyLabel = "No signature returned")
        }
    }

    /**
     * Sign a transaction via MWA WITHOUT broadcasting.
     * Returns the full signed transaction bytes (for Jupiter Ultra flow
     * where Jupiter handles broadcasting via /execute).
     */
    suspend fun signTransaction(
        sender: ActivityResultSender,
        unsignedTransaction: ByteArray,
    ): Result<ByteArray> = signTransactionInternal(sender, unsignedTransaction)

    @VisibleForTesting
    internal suspend fun signTransactionInternal(
        sender: ActivityResultSender?,
        unsignedTransaction: ByteArray,
    ): Result<ByteArray> {
        assertMainThread()
        return runWithStaleRetry(op = "sign") {
            val result = primeAndTransact(sender) { authResult ->
                val signed = signTransactions(arrayOf(unsignedTransaction))
                    .signedPayloads.firstOrNull()
                Pair(authResult.authToken, signed)
            }
            handleByteArrayResult(result, op = "sign", emptyLabel = "No signed transaction returned")
        }
    }

    // ── internal helpers ───────────────────────────────────────────────

    /**
     * Hands the cached auth token to the SDK ONLY when it is non-null —
     * Codex amendment #2: do not stomp the SDK's internal state with a
     * `null` because that prevents the SDK from running its own
     * reauthorize-by-handle path on edge cases, and surfaces a noisier
     * connect flow on cold start.
     *
     * Logs which path is being taken (cached vs fresh) but NEVER logs
     * the token value itself.
     */
    private suspend fun <T> primeAndTransact(
        sender: ActivityResultSender?,
        block: suspend AdapterOperations.(authResult: AuthorizationResult) -> Pair<String?, T>,
    ): TransactionResult<Pair<String?, T>> {
        val cached = cachedAuthToken
        if (cached != null) {
            core.authToken = cached
            Log.i(TAG, "MWA call: reauthorize path (cached token present)")
        } else {
            Log.i(TAG, "MWA call: fresh authorize path (no cached token; SDK handles)")
        }
        return try {
            core.transact(sender, signInPayload = null, block = block)
        } catch (e: Exception) {
            // Preserve the original error-contract: any throw from the SDK
            // (or RealMwaCore.requireNotNull(sender), or main-thread
            // registration failure, etc.) must surface as a
            // TransactionResult.Failure so the downstream handlers can
            // route it through stale-auth detection + the retry wrapper,
            // instead of crashing the caller and bypassing the contract.
            Log.e(TAG, "MWA transact threw; converting to Failure for unified handling", e)
            TransactionResult.Failure(e.message ?: e.javaClass.simpleName, e)
        }
    }

    /**
     * Single-retry wrapper: if [block] surfaces [StaleAuthSignal] in its
     * `Result.failure`, clear both caches and retry exactly once. Any
     * other failure (user rejection, network, etc.) propagates unchanged.
     *
     * The sentinel is internal-only — it is never allowed to escape to
     * the caller. If the retry attempt ALSO reports stale-auth (cache
     * was cleared but the wallet still refuses), we surface a real,
     * caller-meaningful [Exception] instead so downstream code never
     * sees the private [StaleAuthSignal] type.
     */
    private suspend fun <R> runWithStaleRetry(
        op: String,
        block: suspend () -> Result<R>,
    ): Result<R> {
        val first = block()
        if (first.exceptionOrNull() !is StaleAuthSignal) return first

        Log.w(TAG, "$op: stale auth token detected, clearing cache and retrying once")
        cachedAuthToken = null
        core.authToken = null
        val retry = block()
        val retryError = retry.exceptionOrNull()
        return if (retryError is StaleAuthSignal) {
            // Double-stale: the retry itself was rejected. The sentinel must
            // not leak — convert to a public-facing exception. This is the
            // user-revoked-during-retry / wallet-uninstalled scenario.
            Log.e(TAG, "$op: stale auth retry also failed; surfacing caller-facing failure")
            Result.failure(Exception("Authorization failed after retry (${retryError.message})"))
        } else {
            retry
        }
    }

    /** Sentinel exception used internally to flag "this failure was stale-auth, retry it". */
    private class StaleAuthSignal(message: String) : Exception(message)

    private fun handlePubKeyResult(
        result: TransactionResult<Pair<String?, ByteArray?>>,
        op: String,
    ): Result<String> = when (result) {
        is TransactionResult.Success -> {
            val (freshToken, pubKey) = result.payload!!
            refreshCache(freshToken)
            if (pubKey != null) {
                val base58 = org.sol4k.PublicKey(pubKey).toBase58()
                Log.i(TAG, "Wallet authorized: $base58")
                Result.success(base58)
            } else {
                Result.failure(Exception("No account returned from wallet"))
            }
        }
        is TransactionResult.NoWalletFound -> {
            Result.failure(Exception("No MWA-compatible wallet found. Install Phantom or Solflare."))
        }
        is TransactionResult.Failure -> {
            if (isStaleAuthError(result)) {
                Result.failure(StaleAuthSignal(result.message))
            } else {
                Log.e(TAG, "MWA $op failed: ${result.message}")
                Result.failure(Exception(result.message, result.e))
            }
        }
    }

    private fun handleByteArrayResult(
        result: TransactionResult<Pair<String?, ByteArray?>>,
        op: String,
        emptyLabel: String,
    ): Result<ByteArray> = when (result) {
        is TransactionResult.Success -> {
            val (freshToken, bytes) = result.payload!!
            refreshCache(freshToken)
            if (bytes != null) {
                Log.i(TAG, "MWA $op: ${bytes.size} bytes")
                Result.success(bytes)
            } else {
                Result.failure(Exception(emptyLabel))
            }
        }
        is TransactionResult.NoWalletFound -> {
            Result.failure(Exception("No MWA-compatible wallet found. Install Phantom or Solflare."))
        }
        is TransactionResult.Failure -> {
            if (isStaleAuthError(result)) {
                Result.failure(StaleAuthSignal(result.message))
            } else {
                Log.e(TAG, "MWA $op failed: ${result.message}")
                Result.failure(Exception(result.message, result.e))
            }
        }
    }

    private fun refreshCache(freshToken: String?) {
        if (freshToken != null) {
            cachedAuthToken = freshToken
        }
    }

    /**
     * Centralized stale-auth detection. Two paths:
     *
     *  1. Typed exception: walks [TransactionResult.Failure.e] and up to
     *     two `cause` links looking for a
     *     [JsonRpc20Client.JsonRpc20RemoteException] with
     *     `code == [ProtocolContract.ERROR_AUTHORIZATION_FAILED]` (-1).
     *     This is the canonical path — the SDK puts the
     *     `JsonRpc20RemoteException` directly in [TransactionResult.Failure.e],
     *     but we walk the cause chain defensively in case a wrapper is
     *     introduced upstream.
     *
     *  2. Message fallback: case-insensitive match against known stale-
     *     auth phrases the SDK pre-translates into the message field.
     *     This is a belt for the case where the typed shape changes in
     *     a future SDK release.
     */
    @VisibleForTesting
    internal fun isStaleAuthError(failure: TransactionResult.Failure<*>): Boolean {
        // Path 1: typed JsonRpc20RemoteException (code -1) anywhere in the chain
        var t: Throwable? = failure.e
        var depth = 0
        while (t != null && depth < 4) {
            if (t is JsonRpc20Client.JsonRpc20RemoteException &&
                t.code == ProtocolContract.ERROR_AUTHORIZATION_FAILED
            ) {
                return true
            }
            t = t.cause
            depth++
        }
        // Path 2: known SDK-translated messages. Use locale-invariant
        // lowercase so a device set to Turkish (where lowercase('I') is
        // 'ı', not 'i') doesn't break the contains check on
        // "auth token invalid" / "authorization failed".
        val msg = failure.message.lowercase(Locale.ROOT)
        return STALE_AUTH_MESSAGE_HINTS.any { msg.contains(it) }
    }

    private val STALE_AUTH_MESSAGE_HINTS = listOf(
        "auth token invalid",
        "auth_token_not_valid",
        "authorization failed",
    )

    private fun assertMainThread() {
        // In pure JVM unit tests, Looper.getMainLooper() may return null
        // (or its static stub may throw under default-values mode);
        // skip the check then so tests don't have to fake the looper.
        val main = try { Looper.getMainLooper() } catch (_: Throwable) { null } ?: return
        check(Looper.myLooper() == main) {
            "SolanaWalletManager must be called on Dispatchers.Main"
        }
    }
}
