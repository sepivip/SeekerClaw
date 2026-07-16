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
    // CodeRabbit: @Volatile so a reader thread (read()/mutate()/migrateIfEmpty(), called
    // off arbitrary threads) is GUARANTEED to observe the values init() publishes — without
    // it the JMM gives no happens-before edge from the init() writer, so a late caller could
    // read a stale null and fail-closed / "not initialized" forever on that thread.
    @Volatile private var ownedScope: CoroutineScope? = null
    @Volatile private var store: CrossProcessStore<XaiOAuthTokens>? = null
    /** Directory holding the sidecar lock file. `filesDir` in production; a temp dir under test. */
    @Volatile private var lockDir: File? = null

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

        // ---- BAT-1155 stop-fence protocol results (prepareRefresh / conditional mark) ----
        /** [prepareRefresh]: a controlled stop is fencing this epoch — the refresh must NOT POST. */
        object Fenced : Result()
        /** [prepareRefresh]: the family is tombstoned or reauth-required — terminal, no POST ever. */
        object Dead : Result()
        /**
         * [prepareRefresh]: a rotation marker is ALREADY armed for this epoch — a prior POST may
         * have consumed the on-disk refresh token, so a second POST is forbidden. Terminal until a
         * rotate/proven-not-sent-clear/supersede/durable-reauth resolves it. Node must latch this.
         */
        object Unsafe : Result()
        /**
         * [markReauthIfRotationInFlight]: the rotation marker was already cleared (a proven-not-sent
         * refresh) — the family is live and safe; nothing was marked. The stop treats this as durable.
         */
        object Safe : Result()
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
    private fun withStoreLock(
        lockBudgetMs: Long = LOCK_TIMEOUT_MS,
        action: (CrossProcessStore<XaiOAuthTokens>, XaiOAuthTokens) -> Result,
    ): Result {
        val cps = store ?: return Result.Failed("not initialized")
        val dir = lockDir ?: return Result.Failed("not initialized")
        // Monotonic deadline (Codex: System.currentTimeMillis can jump on an NTP
        // correction and break the bound). Covers BOTH lock acquisitions. Codex re-review
        // major-1: cap the acquisition by the SMALLER of the standard allowance and the
        // caller's remaining end-to-end budget, so a mutation started near a shutdown
        // deadline can't overrun it by waiting the full LOCK_TIMEOUT_MS.
        val budgetMs = minOf(LOCK_TIMEOUT_MS, lockBudgetMs).coerceAtLeast(0L)
        val deadlineNs = System.nanoTime() + budgetMs * 1_000_000L
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
                    // CodeRabbit: restore the interrupt flag (mirrors the jvmLock.tryLock path)
                    // so an interrupt during back-off isn't silently lost by the outer catch.
                    try {
                        Thread.sleep(15)
                    } catch (e: InterruptedException) {
                        Thread.currentThread().interrupt()
                        return Result.Failed("interrupted")
                    }
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
        lockBudgetMs: Long = LOCK_TIMEOUT_MS,
        transform: (XaiOAuthTokens) -> XaiOAuthTokens,
    ): Result = withStoreLock(lockBudgetMs) { cps, current ->
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
            // mutate advances the epoch to cur.epoch + 1 AFTER this transform, so the successor
            // epoch is knowable here as cur.epoch + 1 (the CAS matched cur.epoch == expectedEpoch).
            cur.copy(
                accessTokenEnc = accessTokenEnc,
                refreshTokenEnc = refreshTokenEnc,
                expiresAt = expiresAt,
                tombstone = false,
                reauthRequired = false,
                reauthNotifiedEpoch = -1L,
                // The in-flight rotation just completed — the successor pair (T1) is now on disk.
                rotationInFlightEpoch = -1L,
                // BAT-1155 amendment 1: if a stop armed the fence on the from-epoch WHILE this
                // (already-authorized) refresh was in flight, REBASE the fence forward to the new
                // epoch so the completed-safe rotation doesn't drop the fence and let a new refresh
                // start before teardown. Otherwise leave it clear.
                stopFenceEpoch = if (cur.stopFenceEpoch == cur.epoch) cur.epoch + 1L else -1L,
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
                // BAT-1155: a fresh family SUPERSEDES the prior family entirely — clear its
                // rotation marker and stop fence so no prior-family state leaks onto the new epoch.
                rotationInFlightEpoch = -1L,
                stopFenceEpoch = -1L,
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
    fun markReauth(expectedEpoch: Long, maxLockMs: Long = LOCK_TIMEOUT_MS): Result =
        // BAT-1155 amendment 3: a durable reauth SUPERSEDES the rotation marker (a reconnect will
        // mint a brand-new family, so a possibly-consumed T0 can never be replayed) → clear it.
        // The stop fence is left inert on a now-dead family.
        mutate(expectedEpoch, advanceEpoch = false, lockBudgetMs = maxLockMs) {
            it.copy(reauthRequired = true, rotationInFlightEpoch = -1L)
        }

    /**
     * Record that the single autonomous "reconnect" notice has fired for the dead
     * family at [expectedEpoch], so restarts don't re-notify. **CAS'd** so a stale
     * latch can't land on a fresh family (Codex blocker-2). Sets
     * `reauthNotifiedEpoch = expectedEpoch`; epoch NOT advanced. Explicit user
     * requests are answered regardless (that logic lives in Node, keyed on this).
     */
    fun markReauthNotified(expectedEpoch: Long): Result =
        // BAT-1155 amendment 3: touches ONLY reauthNotifiedEpoch — it must NEVER reset
        // rotationInFlightEpoch (the notify path clearing the safety marker before a durable
        // reauth lands would let a crash-then-boot replay a consumed T0). `.copy` preserves it.
        mutate(expectedEpoch, advanceEpoch = false) { it.copy(reauthNotifiedEpoch = expectedEpoch) }

    // ---- BAT-1155 stop-fence protocol (the durable consumed-token state machine) ---------

    /**
     * The single atomic pre-POST transaction the `:node` refresh path runs BEFORE presenting the
     * on-disk refresh token to xAI (Codex-locked order). Under the sidecar lock, in priority order:
     *  1. `expectedEpoch != on-disk epoch` → [Result.Conflict] (superseded; Node discards, no POST);
     *  2. tombstone / reauthRequired → [Result.Dead] (terminal, no POST — amendment 3);
     *  3. a stop is fencing this epoch (`stopFenceEpoch == epoch`) → [Result.Fenced] (no POST);
     *  4. a rotation marker is ALREADY armed (`rotationInFlightEpoch == epoch`) → [Result.Unsafe]
     *     (a prior POST may have consumed the token — a second POST is forbidden; Codex blocker);
     *  5. otherwise arm `rotationInFlightEpoch = epoch` (epoch-STABLE) → [Result.Ok] and the caller
     *     may POST — the "potentially-consumed" marker is now durably on disk BEFORE any request.
     * At most one concurrent/cross-process `prepareRefresh(E)` can return Ok. Never throws.
     */
    fun prepareRefresh(expectedEpoch: Long): Result = withStoreLock { cps, current ->
        if (current.epoch != expectedEpoch) return@withStoreLock Result.Conflict(current.epoch)
        if (current.tombstone || current.reauthRequired) return@withStoreLock Result.Dead
        if (current.stopFenceEpoch == current.epoch) return@withStoreLock Result.Fenced
        if (current.rotationInFlightEpoch == current.epoch) return@withStoreLock Result.Unsafe
        val next = current.copy(rotationInFlightEpoch = current.epoch)
        if (cps.write(next)) Result.Ok(next) else Result.Failed("write failed")
    }

    /**
     * Clear the rotation marker (epoch-STABLE CAS). Called ONLY when the refresh transport proves
     * the request bytes could NOT have reached the token endpoint (DNS/connection-refused before
     * the body was written) — see the `:node` marker discipline. Never on timeout/5xx/any received
     * response (those retain the marker, since the token may be consumed).
     */
    fun clearRotationInFlight(expectedEpoch: Long): Result =
        mutate(expectedEpoch, advanceEpoch = false) { it.copy(rotationInFlightEpoch = -1L) }

    /**
     * Stop-side transaction (MAIN gate / `:node` onDestroy): durably arm the stop fence for the
     * CURRENT live epoch and return the resulting record so the caller can read `rotationInFlightEpoch`
     * in the SAME locked snapshot (the fence ⇄ prepareRefresh serialization point). On a CAS conflict
     * — a concurrent rotate/sign-in advanced the epoch — re-read and re-arm the WINNING live epoch,
     * retrying within [maxLockMs] until the live family is fenced OR is tombstone/reauth (Codex
     * amendment 1: never leave the winning live epoch unfenced). Returns [Result.Ok] with the fenced
     * (or already-dead) record, or [Result.Failed] on deadline/FS failure. Never throws.
     */
    fun armStopFenceAndProbeRotation(expectedEpoch: Long, maxLockMs: Long = LOCK_TIMEOUT_MS): Result {
        val deadlineNs = System.nanoTime() + maxLockMs.coerceAtLeast(0L) * 1_000_000L
        var target = expectedEpoch
        while (true) {
            val remainingMs = (deadlineNs - System.nanoTime()) / 1_000_000L
            if (remainingMs <= 0L) return Result.Failed("arm fence deadline")
            val r = mutate(target, advanceEpoch = false, lockBudgetMs = remainingMs) { cur ->
                cur.copy(stopFenceEpoch = cur.epoch)
            }
            when (r) {
                is Result.Ok -> return r
                is Result.Conflict -> {
                    val cur = read()
                    // A dead/reauth winner has nothing to fence (a refresh can never start on it) —
                    // hand it back so the caller treats it as durable/safe.
                    if (cur.tombstone || cur.reauthRequired) return Result.Ok(cur)
                    target = cur.epoch // re-fence the winning live epoch
                }
                else -> return r // Failed
            }
        }
    }

    /**
     * Clear the stop fence (epoch-STABLE, unconditional on the current record). Called at `:node`
     * boot (drop a stale fence from the prior generation) and on an ABANDONED stop — where the
     * caller MUST confirm this returns [Result.Ok] BEFORE unquiescing/resuming; if it fails, stay
     * stopped and retry (Codex amendment 2 / decision 3 — no TTL). Never throws.
     */
    fun clearStopFence(): Result =
        mutate(null, advanceEpoch = false) { it.copy(stopFenceEpoch = -1L) }

    /**
     * CONDITIONAL fail-close (Codex major): durably mark the family reauth-required ONLY IF the
     * rotation marker is STILL armed for [expectedEpoch]. If the marker was cleared between the
     * stop's probe and now (a proven-not-sent refresh), returns [Result.Safe] — the family is live
     * and must NOT be bricked. Epoch-STABLE, so a chained markReauthNotified keeps the same epoch.
     * [Result.Conflict] if a fresh sign-in/out advanced the epoch (the winning family is intact →
     * the caller treats it as durable). Never throws.
     */
    fun markReauthIfRotationInFlight(expectedEpoch: Long, maxLockMs: Long = LOCK_TIMEOUT_MS): Result =
        withStoreLock(maxLockMs) { cps, current ->
            if (current.epoch != expectedEpoch) return@withStoreLock Result.Conflict(current.epoch)
            if (current.rotationInFlightEpoch != current.epoch) return@withStoreLock Result.Safe
            val next = current.copy(reauthRequired = true, rotationInFlightEpoch = -1L)
            if (cps.write(next)) Result.Ok(next) else Result.Failed("write failed")
        }

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
    /**
     * BAT-1155 stop-fence protocol. A refresh POST for THIS epoch's on-disk refresh token
     * has been initiated (armed ≡ `== epoch`) → the token is potentially-consumed → feeds
     * `isDiskUnsafe`. Terminal once armed until exactly one of: a proven-not-sent clear, a
     * successful rotate to the successor pair, a superseding signIn/signOut, or a durable
     * reauth. Absent in pre-upgrade records → decodes to -1 (never spuriously armed).
     */
    val rotationInFlightEpoch: Long = -1L,
    /**
     * BAT-1155 stop-fence protocol. A controlled stop is in progress for THIS epoch (armed ≡
     * `== epoch`) → a refresh must NOT begin a new rotation POST. Rebased forward by a rotate
     * that started before the fence; cleared at :node boot and on an abandoned stop (which
     * must persist the clear BEFORE resuming — no TTL).
     */
    val stopFenceEpoch: Long = -1L,
)
