package com.seekerclaw.app.config

import android.util.Log
import com.seekerclaw.app.util.SafeFs
import java.nio.channels.FileChannel
import java.nio.channels.FileLock
import java.nio.channels.OverlappingFileLockException
import java.nio.file.Path
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * BAT-1661 (contract v2.3 §2, v2.4 §4) — the one lock every Kotlin writer of the stored
 * provider / auth type / model takes: prefs `provider`/`auth_type`/`model`,
 * `runtime_state.json` and the `workspace/agent_settings.json` overlay.
 *
 * Two layers, acquired in this order under ONE monotonic deadline:
 *  1. an in-process [Semaphore] (one transaction per process at a time), then
 *  2. an OS file lock on `filesDir/model_selection.lock` (one process at a time).
 * The order matters: a JVM may hold only one OS lock on a file, so the semaphore must
 * serialise this process's transactions before the file lock is tried. This is the
 * XaiOAuthTokenStore pattern (jvmLock, then a sidecar FileChannel lock), with one change:
 *
 * **Ownership is the [Tx] token, not the thread.** `saveConfig` runs its runtime-state
 * write through `runBlocking(Dispatchers.IO)`, i.e. on another thread. A thread-owned lock
 * would deadlock or need a second acquisition there. Here the outer caller opens ONE
 * transaction and passes `tx` to every nested writer; a writer that receives a `tx` never
 * acquires anything. A permit-based semaphore can also be released from any thread.
 *
 * Acquisition is bounded ([LOCK_TIMEOUT_MS]) and never throws. A timeout returns
 * [Result.Busy]; each caller has a defined busy path (service start: read-only boot;
 * `saveConfig`: return false; `loadConfig`: compute-only reconcile).
 *
 * Node cannot take this lock. That residual (Node `/model`, `/provider` vs a Settings save
 * while Node runs) is unchanged and tracked by BAT-1663; the repair writes only before Node
 * starts.
 */
object ModelSelectionLock {
    private const val TAG = "ModelSelectionLock"

    /** Sidecar lock file, a direct child of `filesDir`. In the boot link-hygiene inventory. */
    const val LOCK_NAME = "model_selection.lock"

    /** Same order as XaiOAuthTokenStore.LOCK_TIMEOUT_MS. */
    const val LOCK_TIMEOUT_MS = 1_000L

    private const val RETRY_SLEEP_MS = 15L

    /**
     * The transaction token. Valid only between acquisition and release; every nested writer
     * calls [requireOpen] before writing, so a token kept past its transaction fails loudly
     * instead of writing unlocked.
     */
    class Tx internal constructor(val id: Long) {
        @Volatile
        internal var open: Boolean = true

        fun requireOpen() {
            check(open) { "ModelSelectionLock.Tx#$id used after its transaction ended" }
        }

        /**
         * True once a writer under this transaction reported a write that did not reach disk —
         * e.g. `SharedPreferences.commit() == false`, which still leaves the new value in the
         * in-memory prefs. A re-read cannot detect that, so the service start checks this flag
         * before it treats the stores as repaired and clears the intent (Codex diff review #2).
         */
        @Volatile
        var writeFailed: Boolean = false
            private set

        fun markWriteFailed() {
            writeFailed = true
        }
    }

    sealed class Result<out T> {
        data class Acquired<T>(val value: T) : Result<T>()

        /** The lock was not obtained within the bound. Nothing ran. */
        data class Busy(val reason: String) : Result<Nothing>()
    }

    @Volatile
    private var lockRoot: Path? = null

    private val permit = Semaphore(1)
    private val nextId = AtomicLong(1)

    /**
     * Thread currently inside a transaction, for nested-call detection only (ownership is the
     * token). A nested [transaction] on the same thread would wait on its own permit until the
     * bound; it is refused at once instead, with an ERROR, because it means a writer that
     * should have received `tx` did not.
     */
    @Volatile
    private var holderThread: Thread? = null

    /** Called once per process from `SeekerClawApplication` with `filesDir`. */
    fun init(filesDir: Path) {
        lockRoot = filesDir
    }

    /**
     * Runs [block] holding the lock. Returns [Result.Busy] when the lock is not obtained
     * within [timeoutMs] (or [init] never ran). Exceptions from [block] propagate after the
     * lock is released.
     */
    fun <T> transaction(timeoutMs: Long = LOCK_TIMEOUT_MS, block: (Tx) -> T): Result<T> {
        val root = lockRoot ?: return Result.Busy("not initialized")
        if (holderThread === Thread.currentThread()) {
            Log.e(TAG, "nested transaction on one thread — a writer was not handed the tx")
            return Result.Busy("nested")
        }
        val deadlineNs = System.nanoTime() + timeoutMs.coerceAtLeast(0L) * 1_000_000L
        fun remainingMs() = (deadlineNs - System.nanoTime()) / 1_000_000L

        val gotPermit = try {
            permit.tryAcquire(remainingMs().coerceAtLeast(0L), TimeUnit.MILLISECONDS)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            false
        }
        if (!gotPermit) return Result.Busy("in-process lock timeout")

        var chan: FileChannel? = null
        var lock: FileLock? = null
        var tx: Tx? = null
        try {
            chan = try {
                SafeFs.openLockChannelNoFollow(root, root.resolve(LOCK_NAME))
            } catch (e: java.io.IOException) {
                // A link at the lock path, a full disk: no lock, so nothing runs. Only the
                // open is caught here — an IOException from [block] must reach the caller.
                Log.w(TAG, "lock open failed: ${e.message}")
                return Result.Busy("lock open failed")
            }
            while (lock == null) {
                lock = try {
                    chan.tryLock()
                } catch (_: OverlappingFileLockException) {
                    null
                }
                if (lock == null) {
                    if (remainingMs() <= 0L) return Result.Busy("file lock timeout")
                    try {
                        Thread.sleep(RETRY_SLEEP_MS)
                    } catch (_: InterruptedException) {
                        Thread.currentThread().interrupt()
                        return Result.Busy("interrupted")
                    }
                }
            }
            tx = Tx(nextId.getAndIncrement())
            holderThread = Thread.currentThread()
            return Result.Acquired(block(tx))
        } finally {
            tx?.open = false
            holderThread = null
            try { lock?.release() } catch (_: Exception) {}
            try { chan?.close() } catch (_: Exception) {}
            permit.release()
        }
    }

    /** Test seam: point the lock at a temp directory and reset in-process state. */
    internal fun initForTest(filesDir: Path?) {
        lockRoot = filesDir
        holderThread = null
    }
}
