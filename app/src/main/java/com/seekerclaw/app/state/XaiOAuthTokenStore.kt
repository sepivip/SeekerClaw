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
import java.util.concurrent.atomic.AtomicBoolean

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
    const val FILE_NAME = "xai_oauth.json"
    const val LOCK_NAME = "xai_oauth.lock"

    /**
     * Fail-closed default: reauth-required, no token, epoch 0. Returned by
     * [read] whenever the file is missing or undecodable, so corruption can
     * never surface a usable token.
     */
    private val FAIL_CLOSED = XaiOAuthTokens(reauthRequired = true, tombstone = true, epoch = 0L)

    private val initialized = AtomicBoolean(false)
    private var appContext: Context? = null
    private var ownedScope: CoroutineScope? = null
    private var store: CrossProcessStore<XaiOAuthTokens>? = null

    /** Per-JVM serialization for the sidecar file lock (see class KDoc). */
    private val jvmMutex = Any()

    val isInitialized: Boolean get() = store != null

    /** Idempotent. Call once from `SeekerClawApplication.onCreate`. */
    fun init(context: Context) {
        if (!initialized.compareAndSet(false, true)) return
        val app = context.applicationContext
        appContext = app
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
    private fun mutate(
        expectedEpoch: Long?,
        rejectIfTombstone: Boolean = false,
        transform: (XaiOAuthTokens) -> XaiOAuthTokens,
    ): Result {
        val cps = store ?: return Result.Failed("not initialized")
        val app = appContext ?: return Result.Failed("not initialized")
        synchronized(jvmMutex) {
            val lockFile = File(app.filesDir, LOCK_NAME)
            var raf: RandomAccessFile? = null
            var chan: FileChannel? = null
            var lock: FileLock? = null
            try {
                raf = RandomAccessFile(lockFile, "rw")
                chan = raf.channel
                lock = chan.lock() // blocking, cross-process exclusive
                val current = cps.read()
                if (expectedEpoch != null && current.epoch != expectedEpoch) {
                    return Result.Conflict(current.epoch)
                }
                // A dead family (sign-out tombstone) is terminal for a
                // rotation: even once Node syncs its epoch to the tombstone
                // (via a prior conflict response), a later rotation must NOT
                // revive it — only signIn clears a tombstone. Without this, a
                // still-running :node could rotate back onto a signed-out
                // account and silently undo the sign-out (BAT-1155 verify
                // blocker-1). Persisted tombstones are epoch >= 1; the
                // never-written FAIL_CLOSED sentinel (epoch 0) is excluded.
                if (rejectIfTombstone && current.tombstone && current.epoch >= 1L) {
                    return Result.Conflict(current.epoch)
                }
                val next = transform(current).copy(epoch = current.epoch + 1)
                return if (cps.write(next)) Result.Ok(next) else Result.Failed("write failed")
            } catch (e: Exception) {
                Log.w(TAG, "mutate failed: ${e.message}")
                return Result.Failed(e.message ?: "unknown")
            } finally {
                try { lock?.release() } catch (_: Exception) {}
                try { chan?.close() } catch (_: Exception) {}
                try { raf?.close() } catch (_: Exception) {}
            }
        }
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
     * Mark the current family dead (revoked refresh token) WITHOUT touching
     * the token fields — the token-less write D4 needs (a dead token has no
     * new pair to persist). Idempotent.
     */
    fun markReauth(): Result = mutate(null) { it.copy(reauthRequired = true) }

    /**
     * Record that the single autonomous "reconnect" notice has fired for the
     * current dead epoch, so restarts don't re-notify. Explicit user requests
     * are answered regardless (that logic lives in Node, keyed on this field).
     */
    fun markReauthNotified(epoch: Long): Result = mutate(null) { it.copy(reauthNotifiedEpoch = epoch) }

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
    ): Result {
        val cps = store ?: return Result.Failed("not initialized")
        val app = appContext ?: return Result.Failed("not initialized")
        synchronized(jvmMutex) {
            val lockFile = File(app.filesDir, LOCK_NAME)
            var raf: RandomAccessFile? = null
            var chan: FileChannel? = null
            var lock: FileLock? = null
            try {
                raf = RandomAccessFile(lockFile, "rw")
                chan = raf.channel
                lock = chan.lock() // blocking, cross-process exclusive
                val current = cps.read()
                // Fill-only guard. A real persisted tombstone is epoch >= 1;
                // the FAIL_CLOSED default (epoch 0) is the never-written
                // sentinel and MUST fill.
                val realTombstone = current.tombstone && current.epoch >= 1L
                if (current.accessTokenEnc.isNotEmpty() || realTombstone) {
                    return Result.Ok(current) // no-op — epoch deliberately NOT advanced
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
                return if (cps.write(next)) Result.Ok(next) else Result.Failed("write failed")
            } catch (e: Exception) {
                Log.w(TAG, "migrateIfEmpty failed: ${e.message}")
                return Result.Failed(e.message ?: "unknown")
            } finally {
                try { lock?.release() } catch (_: Exception) {}
                try { chan?.close() } catch (_: Exception) {}
                try { raf?.close() } catch (_: Exception) {}
            }
        }
    }

    // ---- Test seams -----------------------------------------------------

    internal fun resetForTest() {
        ownedScope?.cancel()
        ownedScope = null
        store?.close()
        store = null
        appContext = null
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
