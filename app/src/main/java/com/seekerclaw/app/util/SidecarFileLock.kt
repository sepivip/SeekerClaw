package com.seekerclaw.app.util

import java.io.File
import java.nio.channels.FileChannel
import java.nio.channels.FileLock
import java.nio.channels.OverlappingFileLockException
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock

/**
 * BAT-1157 (extracted from BAT-1155's `XaiOAuthTokenStore.withStoreLock`): a cross-process lock
 * on a stable sidecar file, for read-modify-write transactions on a store that is replaced by an
 * atomic rename (the rename swaps the store's inode, so the lock must live on a separate one).
 *
 * - An in-JVM [ReentrantLock] serialises this process's threads. The Java [FileLock] is held per
 *   JVM, not per thread, so without it two threads would collide with
 *   [OverlappingFileLockException].
 * - The OS file lock, opened no-follow ([SafeFs.openLockChannelNoFollow]), covers the other process.
 * - Both acquisitions share ONE monotonic deadline, so a stuck holder in the other process can
 *   never hang a caller (the shutdown path runs under a tight budget).
 * - A nested acquisition from a thread that already holds this lock FAILS FAST. The in-JVM lock
 *   would re-enter, but a second `FileChannel.tryLock` in the same JVM throws
 *   [OverlappingFileLockException]; retrying that until the deadline would turn a programming error
 *   into a silent one-second stall. Callers that need several store operations in one transaction
 *   use the store's under-lock forms instead.
 */
class SidecarFileLock(
    private val dir: () -> File?,
    private val lockName: String,
    private val timeoutMs: Long = DEFAULT_TIMEOUT_MS,
) {
    private val jvmLock = ReentrantLock()

    sealed class Outcome<out R> {
        data class Ran<R>(val value: R) : Outcome<R>()
        data class NotAcquired(val reason: String) : Outcome<Nothing>()
    }

    /** True when the calling thread is inside [withLock] on this lock. */
    val isHeldByCurrentThread: Boolean get() = jvmLock.isHeldByCurrentThread

    /**
     * Runs [action] holding both locks, then releases them. Returns [Outcome.NotAcquired] on a
     * timeout, an interrupt, a nested call, a missing directory, or a lock file that cannot be
     * opened. An exception thrown by [action] propagates after both locks are released.
     */
    fun <R> withLock(budgetMs: Long = timeoutMs, action: () -> R): Outcome<R> {
        if (jvmLock.isHeldByCurrentThread) return Outcome.NotAcquired("nested acquisition of $lockName")
        val lockDir = dir() ?: return Outcome.NotAcquired("not initialized")
        val allowanceMs = minOf(timeoutMs, budgetMs).coerceAtLeast(0L)
        val deadlineNs = System.nanoTime() + allowanceMs * 1_000_000L
        fun remainingMs() = (deadlineNs - System.nanoTime()) / 1_000_000L
        val gotJvm = try {
            jvmLock.tryLock(remainingMs().coerceAtLeast(0L), TimeUnit.MILLISECONDS)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            return Outcome.NotAcquired("interrupted")
        }
        if (!gotJvm) return Outcome.NotAcquired("jvm lock timeout")
        var chan: FileChannel? = null
        var lock: FileLock? = null
        try {
            chan = try {
                SafeFs.openLockChannelNoFollow(lockDir.toPath(), File(lockDir, lockName).toPath())
            } catch (e: Exception) {
                // A link at the lock path, or an IO error: fail closed like a timeout, never throw.
                return Outcome.NotAcquired("lock open failed: ${e.javaClass.simpleName}")
            }
            while (lock == null) {
                lock = try {
                    chan.tryLock()
                } catch (_: OverlappingFileLockException) {
                    null
                }
                if (lock == null) {
                    if (remainingMs() <= 0L) return Outcome.NotAcquired("lock timeout")
                    try {
                        Thread.sleep(RETRY_SLEEP_MS)
                    } catch (_: InterruptedException) {
                        Thread.currentThread().interrupt()
                        return Outcome.NotAcquired("interrupted")
                    }
                }
            }
            return Outcome.Ran(action())
        } finally {
            try { lock?.release() } catch (_: Exception) {}
            try { chan?.close() } catch (_: Exception) {}
            jvmLock.unlock()
        }
    }

    companion object {
        /** Far above the sub-millisecond real hold time, well inside the 2500 ms stop ceiling. */
        const val DEFAULT_TIMEOUT_MS = 1000L
        private const val RETRY_SLEEP_MS = 15L
    }
}
