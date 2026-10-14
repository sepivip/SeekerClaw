package com.seekerclaw.app.service

import com.seekerclaw.app.util.StopToken
import java.util.concurrent.atomic.AtomicBoolean

/**
 * BAT-1409 P1-A (amendment v3.3 M2, correction v3.4) — how a `:node` start is sequenced. Pure
 * (no `android.*`), so the fences are unit-testable; [SeekerClawService] supplies the effects.
 *
 * - **Single flight.** After the caller has checked `NodeBridge.isAlive()`, [tryAcquire] is a
 *   compare-and-set on the in-progress flag. A losing call changes no state.
 * - **Baseline.** [launch] records the stop token once, before any worker runs. `Absent` and
 *   `Token` are valid baselines. `Unreadable` launches no worker: the start ends as
 *   `Failed(STOP_TOKEN_UNREADABLE)` through the fenced continuation, which writes a fresh token
 *   so the next start can proceed (a fresh token can only make other starts abort).
 * - **Worker and continuation.** The worker runs verification only. Its result is posted to the
 *   main looper, where the continuation checks [Fence.holds] and then runs exactly one of
 *   [Effects.proceed], [Effects.fail] or [Effects.abort]. A stop that began after this start
 *   changed the token, so its continuation aborts — including a `Failed` one, which therefore
 *   never writes `ERROR` after a stop.
 * - Every end of a launched start clears the in-progress flag, in a `finally`.
 */
class StartCoordinator(
    private val readToken: () -> StopToken.State,
    private val repairToken: () -> Boolean,
    private val startWorker: (Runnable) -> Unit,
    private val postToMain: (Runnable) -> Unit,
    private val destroyed: () -> Boolean,
) {
    private val inProgress = AtomicBoolean(false)

    val startInProgress: Boolean get() = inProgress.get()

    sealed class Verification {
        object Ok : Verification() {
            override fun toString() = "Ok"
        }

        data class Failed(val reason: String) : Verification()
    }

    /** The start's fence: it holds while the service lives and the stop token is its baseline. */
    inner class Fence(val baseline: StopToken.State) {
        fun holds(): Boolean {
            if (destroyed()) return false
            val now = readToken()
            // An Unreadable baseline can only fail the start; it does so only while no stop has
            // since written a valid token.
            return if (baseline == StopToken.State.Unreadable) now == StopToken.State.Unreadable
            else StopToken.matches(baseline, now)
        }
    }

    /** What a continuation does. All three run on the main looper. */
    interface Effects {
        /** Verification passed and the fence holds: the rest of the start sequence. */
        fun proceed(fence: Fence)

        /** Verification failed and the fence holds: the error path, then `stopSelf()`. */
        fun fail(fence: Fence, reason: String)

        /** A stop began after this start (or the service is gone): `stopSelf()`, nothing else. */
        fun abort(fence: Fence)
    }

    /** Single flight: true for the one call that may start. */
    fun tryAcquire(): Boolean = inProgress.compareAndSet(false, true)

    /** Ends an acquired start that stops before [launch] (for example crash-loop protection). */
    fun release() = inProgress.set(false)

    /** Records the baseline and runs [verify] off the main thread. Call only after [tryAcquire]. */
    fun launch(verify: () -> Verification, effects: Effects) {
        val fence = Fence(readToken())
        if (fence.baseline == StopToken.State.Unreadable) {
            postToMain(Runnable { finish(fence, Verification.Failed(STOP_TOKEN_UNREADABLE), effects) })
            return
        }
        try {
            startWorker(
                Runnable {
                    val v = try {
                        verify()
                    } catch (t: Throwable) {
                        Verification.Failed("WORKER_${t.javaClass.simpleName}")
                    }
                    postToMain(Runnable { finish(fence, v, effects) })
                },
            )
        } catch (t: Throwable) {
            postToMain(Runnable { finish(fence, Verification.Failed("WORKER_START"), effects) })
        }
    }

    private fun finish(fence: Fence, v: Verification, effects: Effects) {
        try {
            if (!fence.holds()) {
                effects.abort(fence)
                return
            }
            when (v) {
                Verification.Ok -> effects.proceed(fence)
                is Verification.Failed -> {
                    if (v.reason == STOP_TOKEN_UNREADABLE) repairToken()
                    effects.fail(fence, v.reason)
                }
            }
        } finally {
            inProgress.set(false)
        }
    }

    companion object {
        const val STOP_TOKEN_UNREADABLE = "STOP_TOKEN_UNREADABLE"
    }
}
