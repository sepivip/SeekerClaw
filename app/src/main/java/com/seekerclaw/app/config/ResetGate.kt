package com.seekerclaw.app.config

import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantReadWriteLock

/**
 * BAT-1157 (contract v3 §3, D14): keeps a sign-in from landing in the middle of Reset Config.
 *
 * Reset Config tombstones both OAuth stores, deletes the shared Keystore key and clears prefs. A
 * sign-in that commits in between would write a record the reset then orphans: encrypted under
 * the deleted key (unreadable), or under a key `getOrCreateKey` silently re-created (a live record
 * after a reset that reported Done).
 *
 * - The reset holds the WRITE side from its first step until its result is final, and bumps the
 *   generation under it before the first tombstone ([exclusive]).
 * - A sign-in flow takes the READ side at its start to capture the generation ([beginFlow]), and
 *   again for its commit ([commit]), where it checks the generation and runs everything that
 *   follows the commit (the runtime auth sync, the service restart, the result file) inside.
 *
 * Both the reset and every sign-in flow run in the MAIN process, so an in-process lock suffices.
 */
object ResetGate {
    private const val TRY_MS = 1_000L
    private const val BEGIN_TRY_MS = 250L

    private val rw = ReentrantReadWriteLock()

    @Volatile
    private var generation = 0L

    /**
     * At a sign-in flow's start: the current generation, or null while a reset is running. Called
     * on the main thread (Activity.onCreate), so it waits briefly, not the full commit budget.
     */
    fun beginFlow(): Long? {
        if (!tryRead(BEGIN_TRY_MS)) return null
        try {
            return generation
        } finally {
            rw.readLock().unlock()
        }
    }

    sealed class Commit<out R> {
        data class Ran<R>(val value: R) : Commit<R>()

        /** A reset ran (or is running) since the flow began: nothing was written. */
        object Cancelled : Commit<Nothing>()
    }

    /** Runs a sign-in's commit and its follow-up work, unless a reset intervened since [flowGeneration]. */
    fun <R> commit(flowGeneration: Long, action: () -> R): Commit<R> {
        if (!tryRead()) return Commit.Cancelled
        try {
            if (generation != flowGeneration) return Commit.Cancelled
            return Commit.Ran(action())
        } finally {
            rw.readLock().unlock()
        }
    }

    /** Reset Config only: runs [action] holding the write side, after bumping the generation. */
    internal fun <R> exclusive(action: () -> R): R {
        rw.writeLock().lockInterruptibly()
        try {
            generation++
            return action()
        } finally {
            rw.writeLock().unlock()
        }
    }

    private fun tryRead(waitMs: Long = TRY_MS): Boolean = try {
        rw.readLock().tryLock(waitMs, TimeUnit.MILLISECONDS)
    } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
        false
    }
}
