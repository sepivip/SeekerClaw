package com.seekerclaw.app.state

import android.content.Context
import android.util.Log
import com.seekerclaw.app.util.CrossProcessStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.Serializable
import java.io.File
import java.io.RandomAccessFile
import java.nio.channels.FileChannel
import java.nio.channels.FileLock
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.locks.ReentrantLock

/**
 * Cross-process, single-domain store for the xAI OAuth ("Sign in with Grok")
 * token record (BAT-1155, Codex-signed contract v4).
 *
 * ## Why this exists
 * The xAI OAuth token USED to live in `seekerclaw_prefs` (`MODE_PRIVATE`),
 * written by BOTH the `:node` rotation path and the MAIN/UI `saveConfig`.
 * `MODE_PRIVATE` gives no cross-process coherence, so a MAIN-process
 * `editor.commit()` flushed that process's stale in-memory prefs map back
 * over the token `:node` had just rotated — the next boot then POSTed an
 * already-consumed single-use refresh token and xAI revoked the whole
 * family (the live incident). `CrossProcessStore`'s own header names this:
 * "SharedPreferences … credentials are all latent instances of the same
 * [staleness] bug." This store moves the xAI OAuth record into a dedicated
 * `filesDir` file with a real cross-process transaction so no unrelated
 * config write can ever clobber it.
 *
 * ## Location & reachability (contract D1)
 * `files/xai_oauth.json` (a sibling of `runtime_state.json`, `filesDir`
 * root) — deliberately NOT under `workDir=files/workspace`, so the agent's
 * `safePath`-confined file tools can neither read nor delete it. Belt-and-
 * suspenders: `xai_oauth.json` is also in Node's `SECRETS_BLOCKED`.
 *
 * ## Secrets at rest
 * `accessTokenEnc` / `refreshTokenEnc` / `emailEnc` are KeystoreHelper
 * AES-256-GCM ciphertext (base64, `IV||ciphertext`) — identical key/format
 * to the legacy prefs, so migration is a ciphertext passthrough (no
 * cleartext ever materializes). `expiresAt` / `reauthRequired` /
 * `reauthNotifiedEpoch` / `epoch` / `tombstone` are non-secret plaintext;
 * their INTEGRITY is protected by the `filesDir` location (out of agent
 * write-reach).
 *
 * ## Cross-process CAS (contract D1, Codex amendment 1)
 * `CrossProcessStore` is last-writer-wins across processes, so an `epoch`
 * compared inside two independent RMWs still has a TOCTOU window. Every
 * mutation here runs as a transaction under a STABLE SIDECAR OS FILE LOCK
 * (`files/xai_oauth.lock`, a separate inode the atomic-rename never
 * replaces): `acquire → read current → validate expectedEpoch → write an
 * epoch-advanced record via the atomic move → release`. The Java `FileLock`
 * is per-JVM (not per-thread), so it is additionally wrapped in an in-JVM
 * [jvmMutex] to serialize same-process callers (else `OverlappingFile
 * LockException`); the mutex serializes this process, the file lock covers
 * the other process.
 *
 * ## Fail-closed default
 * The store's [initial] snapshot is a reauth-required tombstone (no token),
 * so a MISSING or CORRUPT store (`CrossProcessStore.read()` returns the
 * initial on both) is read as "reconnect needed" — never as a usable/legacy
 * token. Post-adoption this is the whole fail-closed guarantee.
 */
object XaiOAuthTokenStore {
    private const val TAG = "XaiOAuthTokenStore"
    // CodeRabbit: bound the sidecar cross-process lock acquisition so a stuck holder in
    // the other process can never hang a mutation indefinitely (the shutdown durability
    // gate runs markReauth() under onDestroy's tight budget). 1000ms is far above the
    // sub-ms real hold time while staying well inside the 2500ms stop ceiling.
    private const val LOCK_TIMEOUT_MS = 1000L
    const val FILE_NAME = "xai_oauth.json"
    const val LOCK_NAME = "xai_oauth.lock"

    /**
     * Fail-closed default: reauth-required, no token, epoch 0. Returned by
     * [read] whenever the file is missing or undecodable, so corruption can
     * never surface a usable token.
     */
    private val FAIL_CLOSED = XaiOAuthTokens(reauthRequired = true, tombstone = true, epoch = 0L)

    private val initialized = AtomicBoolean(false)
    private var ownedScope: CoroutineScope? = null
    private var store: CrossProcessStore<XaiOAuthTokens>? = null
    /** Directory holding the sidecar lock file. `filesDir` in production; a temp dir under test. */
    private var lockDir: File? = null

    /**
     * Per-JVM serialization for the sidecar file lock (see class KDoc). A
     * ReentrantLock (not `synchronized`) so acquisition is itself BOUNDED
     * (Codex: `synchronized` can't time out — under the shutdown budget an
     * unbounded monitor wait would blow the ceiling / risk a stuck thread).
     */
    private val jvmLock = ReentrantLock()

    val isInitialized: Boolean get() = store != null

    /** Idempotent. Call once from `SeekerClawApplication.onCreate`. */
    fun init(context: Context) {
        if (!initialized.compareAndSet(false, true)) return
        val app = context.applicationContext
        lockDir = app.filesDir
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        ownedScope = scope
        store = CrossProcessStore(
            context = app,
            fileName = FILE_NAME,
            serializer = XaiOAuthTokens.serializer(),
            initial = FAIL_CLOSED,
            parentScope = scope,
        )
    }

    /**
     * Current record. Missing/corrupt → [FAIL_CLOSED] (reauth tombstone).
     * Returns [FAIL_CLOSED] if [init] was never called.
     */
    fun read(): XaiOAuthTokens = store?.read() ?: FAIL_CLOSED

    /** Result of a CAS mutation. */
    sealed class Result {
        /** Written; [record] is the persisted, epoch-advanced record. */
        data class Ok(val record: XaiOAuthTokens) : Result()
        /** expectedEpoch != on-disk epoch — the caller's pair is stale. */
        data class Conflict(val currentEpoch: Long) : Result()
        /** FS/lock failure; nothing was persisted. */
        data class Failed(val reason: String) : Result()
    }

    /**
     * Run [transform] as a cross-process transaction under the sidecar lock.
     * If [expectedEpoch] is non-null and differs from the on-disk epoch,
     * returns [Result.Conflict] WITHOUT writing (the CAS gate). Otherwise
     * persists `transform(current).copy(epoch = current.epoch + 1)` and
     * returns [Result.Ok].
     *
     * [transform] must NOT itself set `epoch` — this method advances it so
     * every mutation is monotonic. Never throws.
     */
    /**
     * Acquire BOTH the in-JVM [jvmLock] and the cross-process sidecar file lock
     * under ONE monotonic end-to-end deadline ([LOCK_TIMEOUT_MS]), run [action]
     * with the store + the freshly-read current record, and always release both.
     * Returns [Result.Failed] on a lock timeout — never blocks indefinitely and
     * never throws (Codex blocker-1: the shutdown path must be bounded + deadlock-
     * proof, so every acquisition here is time-bounded off a monotonic clock).
     */
    private fun withStoreLock(action: (CrossProcessStore<XaiOAuthTokens>, XaiOAuthTokens) -> Result): Result {
        val cps = store ?: return Result.Failed("not initialized")
        val dir = lockDir ?: return Result.Failed("not initialized")
        // Monotonic deadline (Codex: System.currentTimeMillis can jump on an NTP
        // correction and break the bound). Covers BOTH lock acquisitions.
        val deadlineNs = System.nanoTime() + LOCK_TIMEOUT_MS * 1_000_000L
        val remainingMs = { (deadlineNs - System.nanoTime()) / 1_000_000L }
        val gotJvm = try {
            jvmLock.tryLock(remainingMs().coerceAtLeast(0L), TimeUnit.MILLISECONDS)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            false
        }
        if (!gotJvm) return Result.Failed("jvm lock timeout")
        var raf: RandomAccessFile? = null
        var chan: FileChannel? = null
        var lock: FileLock? = null
        try {
            val lockFile = File(dir, LOCK_NAME)
            raf = RandomAccessFile(lockFile, "rw")
            chan = raf.channel
            // Bounded cross-process acquisition: tryLock + brief retries instead of a
            // blocking lock() that could hang forever on a stuck other-process holder.
            while (lock == null) {
                lock = try {
                    chan.tryLock()
                } catch (_: java.nio.channels.OverlappingFileLockException) {
                    null // jvmLock already serializes this process; back off + retry
                }
                if (lock == null) {
                    if (remainingMs() <= 0L) return Result.Failed("lock timeout")
                    Thread.sleep(15)
                }
            }
            return action(cps, cps.read())
        } catch (e: Exception) {
            Log.w(TAG, "store op failed: ${e.message}")
            return Result.Failed(e.message ?: "unknown")
        } finally {
            try { lock?.release() } catch (_: Exception) {}
            try { chan?.close() } catch (_: Exception) {}
            try { raf?.close() } catch (_: Exception) {}
            jvmLock.unlock()
        }
    }

    /**
     * CAS mutation. [Result.Conflict] (no write) when [expectedEpoch] is non-null
     * and differs from the on-disk epoch, or when [rejectIfTombstone] and the
     * current record is any tombstone. Otherwise persists `transform(current)`
     * with the epoch advanced by one — UNLESS [advanceEpoch] is false (annotation
     * writes like markReauth that keep the family's epoch stable so their CAS
     * stays meaningful across chained marks). Never throws.
     */
    private fun mutate(
        expectedEpoch: Long?,
        rejectIfTombstone: Boolean = false,
        advanceEpoch: Boolean = true,
        transform: (XaiOAuthTokens) -> XaiOAuthTokens,
    ): Result = withStoreLock { cps, current ->
        if (expectedEpoch != null && current.epoch != expectedEpoch) {
            return@withStoreLock Result.Conflict(current.epoch)
        }
        // A dead family (sign-out tombstone OR the epoch-0 FAIL_CLOSED sentinel) is
        // terminal for a rotation — reject EVERY tombstone regardless of epoch
        // (Codex blocker-3); the epoch-0 fill exception lives ONLY in migrateIfEmpty.
        if (rejectIfTombstone && current.tombstone) {
            return@withStoreLock Result.Conflict(current.epoch)
        }
        val next = transform(current).copy(epoch = if (advanceEpoch) current.epoch + 1 else current.epoch)
        if (cps.write(next)) Result.Ok(next) else Result.Failed("write failed")
    }

    // ---- Mutations (each advances epoch under the CAS lock) --------------

    /**
     * `:node` rotation write. Sends the `expectedEpoch` Node last saw; a
     * mismatch means a MAIN sign-in/out landed first → [Result.Conflict],
     * on which Node MUST discard the pending pair (never retry it). Preserves
     * `email` and clears the reauth flags (a successful rotation proves the
     * family is alive).
     */
    fun rotate(expectedEpoch: Long, accessTokenEnc: String, refreshTokenEnc: String, expiresAt: String): Result =
        mutate(expectedEpoch, rejectIfTombstone = true) { cur ->
            cur.copy(
                accessTokenEnc = accessTokenEnc,
                refreshTokenEnc = refreshTokenEnc,
                expiresAt = expiresAt,
                tombstone = false,
                reauthRequired = false,
                reauthNotifiedEpoch = -1L,
            )
        }

    /**
     * MAIN sign-in: a brand-new token family. No `expectedEpoch` gate (a
     * fresh sign-in intentionally supersedes anything in flight); advances
     * the epoch so any older in-flight rotation is rejected by its CAS.
     * Clears all dead/notify state atomically.
     */
    fun signIn(accessTokenEnc: String, refreshTokenEnc: String, emailEnc: String, expiresAt: String): Result =
        mutate(null) { cur ->
            cur.copy(
                accessTokenEnc = accessTokenEnc,
                refreshTokenEnc = refreshTokenEnc,
                emailEnc = emailEnc,
                expiresAt = expiresAt,
                tombstone = false,
                reauthRequired = false,
                reauthNotifiedEpoch = -1L,
            )
        }

    /**
     * MAIN sign-out: an epoch-advanced TOMBSTONE (dead record, no token) so
     * an in-flight old-family rotation is CAS-rejected and cannot resurrect
     * the account. Deliberately keeps NO token material.
     */
    fun signOut(): Result =
        mutate(null) {
            XaiOAuthTokens(tombstone = true, reauthRequired = false, epoch = 0L /* replaced by mutate */)
        }

    /**
     * Mark the CURRENT family dead (revoked refresh token) WITHOUT touching the
     * token fields — the token-less write D4 needs. **CAS'd on [expectedEpoch]**
     * (Codex blocker-2): if a fresh sign-in/out has advanced the epoch, a delayed
     * old-family mark returns [Result.Conflict] and NEVER poisons the winning
     * family. Epoch is NOT advanced (an annotation on the same family), so a
     * caller can chain markReauthNotified with the same epoch. Idempotent.
     */
    fun markReauth(expectedEpoch: Long): Result =
        mutate(expectedEpoch, advanceEpoch = false) { it.copy(reauthRequired = true) }

    /**
     * Record that the single autonomous "reconnect" notice has fired for the dead
     * family at [expectedEpoch], so restarts don't re-notify. **CAS'd** so a stale
     * latch can't land on a fresh family (Codex blocker-2). Sets
     * `reauthNotifiedEpoch = expectedEpoch`; epoch NOT advanced. Explicit user
     * requests are answered regardless (that logic lives in Node, keyed on this).
     */
    fun markReauthNotified(expectedEpoch: Long): Result =
        mutate(expectedEpoch, advanceEpoch = false) { it.copy(reauthNotifiedEpoch = expectedEpoch) }

    /**
     * One-time upgrade fill from the legacy `seekerclaw_prefs` xAI OAuth keys
     * (BAT-1155 §4). CIPHERTEXT PASSTHROUGH — the caller reads the base64
     * Keystore blobs verbatim and hands them here WITHOUT decrypting; this
     * store holds ciphertext at rest, so migration never materializes
     * cleartext.
     *
     * FILL-ONLY, under the sidecar lock, and — unlike every other mutation —
     * it does NOT advance the epoch on the no-op path and writes the filled
     * record at **epoch 1** (a freshly-adopted family's first revision).
     *
     * No-op (returns `Ok(current)` unchanged) when a REAL record already
     * exists:
     *  - a non-empty `accessTokenEnc` — a prior migration already landed, so
     *    a re-run (idempotency) must not clobber it; OR
     *  - a PERSISTED tombstone (`tombstone && epoch >= 1`) — a real sign-out.
     *
     * The [FAIL_CLOSED] default (`tombstone = true`, `epoch = 0`, no token)
     * is the "never-written" sentinel, NOT a persisted tombstone, so it
     * FILLS — this is the upgrade case. (The migration caller additionally
     * gates on the `xai_oauth.migrated` marker so a signed-out family whose
     * marker is present never reaches this method at all — see
     * ConfigManager.migrateXaiOAuthToStoreIfNeeded, Codex blocker 1.)
     *
     * Never throws.
     */
    fun migrateIfEmpty(
        accessTokenEnc: String,
        refreshTokenEnc: String,
        emailEnc: String,
        expiresAt: String,
    ): Result = withStoreLock { cps, current ->
        // Fill-only guard. A real persisted tombstone is epoch >= 1; the
        // FAIL_CLOSED default (epoch 0) is the never-written sentinel and MUST fill.
        val realTombstone = current.tombstone && current.epoch >= 1L
        if (current.accessTokenEnc.isNotEmpty() || realTombstone) {
            return@withStoreLock Result.Ok(current) // no-op — epoch deliberately NOT advanced
        }
        val next = XaiOAuthTokens(
            accessTokenEnc = accessTokenEnc,
            refreshTokenEnc = refreshTokenEnc,
            emailEnc = emailEnc,
            expiresAt = expiresAt,
            reauthRequired = false,
            reauthNotifiedEpoch = -1L,
            epoch = 1L,
            tombstone = false,
        )
        if (cps.write(next)) Result.Ok(next) else Result.Failed("write failed")
    }

    // ---- Test seams -----------------------------------------------------

    /**
     * JVM-only init (no Android Context) mirroring CrossProcessStore's round-19 test
     * constructor: drives the REAL mutate/CAS/epoch/tombstone/migration logic against a
     * temp [filesDir] (which also holds the sidecar lock file). Lets the v4 matrix
     * exercise production code paths — not a mirror — off a plain tmp dir.
     */
    internal fun initForTest(filesDir: File) {
        resetForTest()
        initialized.set(true)
        lockDir = filesDir
        store = CrossProcessStore(
            filesDir = filesDir,
            fileName = FILE_NAME,
            serializer = XaiOAuthTokens.serializer(),
            initial = FAIL_CLOSED,
        )
    }

    internal fun resetForTest() {
        ownedScope?.cancel()
        ownedScope = null
        store?.close()
        store = null
        lockDir = null
        initialized.set(false)
    }
}

/**
 * The persisted xAI OAuth record (BAT-1155). Secret fields are KeystoreHelper
 * ciphertext (base64); the rest are non-secret plaintext control fields whose
 * integrity is protected by the `filesDir` location. A `tombstone` record
 * (sign-out or fail-closed default) carries no token material.
 */
@Serializable
data class XaiOAuthTokens(
    val accessTokenEnc: String = "",
    val refreshTokenEnc: String = "",
    val emailEnc: String = "",
    val expiresAt: String = "",
    val reauthRequired: Boolean = false,
    /** Epoch for which the one autonomous reconnect notice already fired; -1 = none. */
    val reauthNotifiedEpoch: Long = -1L,
    /** Monotonic revision; advanced by every [XaiOAuthTokenStore] mutation. */
    val epoch: Long = 0L,
    /** Dead record (sign-out or fail-closed default) — no usable token. */
    val tombstone: Boolean = false,
)
