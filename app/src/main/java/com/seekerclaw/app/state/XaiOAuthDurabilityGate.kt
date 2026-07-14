package com.seekerclaw.app.state

import com.seekerclaw.app.bridge.NodeControlClient
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.TimeUnit

/**
 * BAT-1155 §D6 / Codex blocker-1 — the pre-stop durability gate for the xAI
 * OAuth token family.
 *
 * ## The hazard
 * xAI refresh tokens are single-use and rotate. When `:node` rotates
 * `T0 → T1`, the server has ALREADY consumed `T0`; if the process is killed
 * before `T1` reaches disk, the next boot POSTs the consumed `T0` and xAI
 * revokes the WHOLE family (the live incident). A blind `killProcess` on
 * Stop is therefore unsafe whenever a rotation might be mid-flight.
 *
 * ## What this gate guarantees
 * A controlled Stop must reach ONE of two durable states before the process
 * is torn down (Codex: "never kill without positive durability"):
 *   1. **Persisted** — Node confirms the rotated `T1` landed on disk
 *      (`flushShutdown()` → `pendingPersist:false`); the family stays live. OR
 *   2. **Fail-closed** — we could not confirm the persist (Node reports it
 *      still pending, or is unreachable), so we durably CAS-mark the family
 *      `reauthRequired` ([XaiOAuthTokenStore.markReauth]). The next boot then
 *      boots INTO reconnect instead of replaying a possibly-consumed token.
 *
 * Preference order matters: we give Node repeated chances to persist the
 * VALID `T1` FIRST (a persisted `T1` keeps the user signed in), and only fall
 * back to the reauth mark (which forces one reconnect) when persistence can't
 * be confirmed within the budget. The mark is CAS'd on the epoch we read, so
 * a concurrent fresh sign-in is never clobbered ([Result.Conflict] ⇒ durable,
 * the winning family is intact).
 *
 * ## Bounded, monotonic, deadlock-proof
 * The whole gate runs under ONE monotonic end-to-end deadline
 * ([BUDGET_MS], `System.nanoTime`-based — immune to NTP wall-clock jumps).
 * Every sub-step (each `flushShutdown`, each `markReauth`) is bounded by its
 * own internal timeouts AND re-checks the deadline, so the gate can never hang
 * a Stop. It is a no-op (returns `true` immediately) unless the store shows a
 * LIVE oauth family — api-key users and already-dead/tombstoned families are
 * never gated. This object holds no state; it is safe to call from any thread
 * (the caller runs it off the main thread).
 */
object XaiOAuthDurabilityGate {
    private const val TAG = "XaiDurabilityGate"

    /** End-to-end wall budget for the whole gate. Sits inside the caller's stop ceiling. */
    private const val BUDGET_MS = 2_500L

    /** How many times we re-ask Node to persist the rotated pair before falling back to markReauth. */
    private const val MAX_FLUSH_ROUNDS = 3

    /** Brief backoff between markReauth retries when the disk write is momentarily contended. */
    private const val MARK_RETRY_BACKOFF_MS = 20L

    /**
     * Ensure the xAI OAuth family is in a durable state for a controlled stop (BAT-1155 stop-fence
     * protocol). Returns `true` when durable, `false` only when the store I/O is broken and no
     * durable state could be reached (the caller keeps the service alive and retries). Never throws.
     *
     * The decision is made ENTIRELY on durable store state, so it is correct even when `:node`'s
     * control endpoint is unreachable (the original soak brick was fail-closing a fresh family on a
     * null control probe):
     *   1. Not a live oauth family → nothing to protect → durable.
     *   2. **Arm the stop fence** for the current live epoch and **atomically probe** the rotation
     *      marker (`armStopFenceAndProbeRotation`, a pure sidecar-locked store op). The fence blocks
     *      any NEW refresh from beginning.
     *   3. Fence armed AND no rotation marker → nothing consumed, nothing can start → **positively
     *      safe**, even on a null control path. (Subsumes the sign-in restart; also fixes a healthy
     *      rotated family false-bricking on an unreachable stop.)
     *   4. A rotation marker IS armed → a refresh POST may be mid-flight → give `:node` bounded
     *      chances to DRAIN it (persist the successor pair via `rotate`, which clears the marker and
     *      rebases the fence). The durable STORE marker — not the in-memory flush signal — is the
     *      authority.
     *   5. Still in-flight after the budget (or `:node` unreachable) → **conditional** fail-close
     *      ([markReauthIfRotationInFlight]) — marks reauth ONLY if the marker is STILL armed, so a
     *      concurrent proven-not-sent clear can never brick a now-safe family.
     */
    fun ensureDurableBeforeStop(): Boolean {
        if (!XaiOAuthTokenStore.isInitialized) return true
        val rec = XaiOAuthTokenStore.read() // never throws — missing/corrupt → FAIL_CLOSED (not live)
        val live = !rec.tombstone && !rec.reauthRequired && rec.accessTokenEnc.isNotEmpty()
        if (!live) return true

        val deadlineNs = deadline()

        // Arm the fence for the live epoch + atomically probe the rotation marker. Pure durable-store
        // op → works even when :node is unreachable. Retries internally to fence the WINNING live
        // epoch if a concurrent rotate/sign-in advances it (Codex amendment 1).
        val armed = XaiOAuthTokenStore.armStopFenceAndProbeRotation(rec.epoch, maxLockMs = remainingMs(deadlineNs))
        val rec2 = when (armed) {
            is XaiOAuthTokenStore.Result.Ok -> armed.record
            else -> {
                LogCollector.append("[Shutdown] xAI durability gate: could not arm stop fence ($armed) — conditional fail-closed attempt", LogLevel.WARN)
                return markReauthIfInFlightWithinDeadline(rec.epoch, deadlineNs)
            }
        }
        // Went dead/reauth concurrently → already durable.
        if (rec2.tombstone || rec2.reauthRequired) return true
        // Fenced + nothing in flight → POSITIVELY SAFE (even on a null control path).
        if (rec2.rotationInFlightEpoch != rec2.epoch) return true

        // A refresh POST for this epoch may be in flight. DRAIN it (durabilityOnly flush triggers
        // :node's pending-persist → rotate() clears the marker + rebases the fence). Re-read the
        // DURABLE marker after each round — the store is authoritative, not the flush's diskUnsafe.
        var round = 0
        while (round < MAX_FLUSH_ROUNDS && remainingMs(deadlineNs) > 0L) {
            round++
            try {
                val budget = remainingMs(deadlineNs).toInt().coerceAtLeast(1)
                runBlocking { withTimeoutOrNull(budget.toLong()) { NodeControlClient.flushShutdown(budget, durabilityOnly = true) } }
            } catch (e: Exception) {
                LogCollector.append("[Shutdown] xAI durability gate: drain round $round threw (${e.message})", LogLevel.WARN)
            }
            val rec3 = XaiOAuthTokenStore.read()
            if (rec3.tombstone || rec3.reauthRequired) return true
            if (rec3.rotationInFlightEpoch != rec3.epoch) {
                if (round > 1) LogCollector.append("[Shutdown] xAI durability gate: in-flight rotation drained/persisted on round $round", LogLevel.INFO)
                return true
            }
        }

        // Still in flight after the budget (or :node unreachable). Conditional fail-close.
        android.util.Log.w(TAG, "durability gate: rotation still in-flight after drain — conditional fail-closed markReauth")
        LogCollector.append("[Shutdown] xAI durability gate: rotation still in-flight after drain — conditional fail-close", LogLevel.WARN)
        return markReauthIfInFlightWithinDeadline(rec2.epoch, deadlineNs)
    }

    /**
     * Retry [XaiOAuthTokenStore.markReauthIfRotationInFlight] until durable or [deadlineNs] passes.
     * `Ok` ⇒ marked reauth (the marker was still armed → fail-closed). `Safe` ⇒ the marker was
     * cleared by a proven-not-sent refresh between the probe and now → the family is live and MUST
     * NOT be bricked (Codex major). `Conflict` ⇒ a fresh sign-in/out advanced the epoch → the
     * winning family is intact. All three are durable. `Failed` ⇒ retry within budget; `false` only
     * if the store I/O never succeeds (disk broken — nothing could have saved the family anyway).
     */
    private fun markReauthIfInFlightWithinDeadline(expectedEpoch: Long, deadlineNs: Long): Boolean {
        while (remainingMs(deadlineNs) > 0L) {
            val r = try {
                XaiOAuthTokenStore.markReauthIfRotationInFlight(expectedEpoch, maxLockMs = remainingMs(deadlineNs))
            } catch (e: Exception) {
                XaiOAuthTokenStore.Result.Failed(e.message ?: e.javaClass.simpleName)
            }
            when (r) {
                is XaiOAuthTokenStore.Result.Ok -> {
                    LogCollector.append("[Shutdown] xAI durability gate: fail-closed reauth mark persisted (epoch=${r.record.epoch})", LogLevel.WARN)
                    return true
                }
                is XaiOAuthTokenStore.Result.Safe -> {
                    LogCollector.append("[Shutdown] xAI durability gate: rotation marker already cleared (proven-not-sent) — family live, no brick", LogLevel.INFO)
                    return true
                }
                is XaiOAuthTokenStore.Result.Conflict -> {
                    LogCollector.append("[Shutdown] xAI durability gate: epoch advanced ($expectedEpoch→${r.currentEpoch}) — winning family durable", LogLevel.WARN)
                    return true
                }
                is XaiOAuthTokenStore.Result.Failed -> {
                    if (remainingMs(deadlineNs) <= MARK_RETRY_BACKOFF_MS) break
                    try {
                        Thread.sleep(MARK_RETRY_BACKOFF_MS)
                    } catch (e: InterruptedException) {
                        Thread.currentThread().interrupt()
                        break
                    }
                }
                else -> return true // Fenced/Dead/Unsafe are not produced here; treat as durable defensively
            }
        }
        LogCollector.append("[Shutdown] xAI durability gate: could NOT confirm durability within ${BUDGET_MS}ms budget", LogLevel.ERROR)
        return false
    }

    private fun deadline(): Long = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(BUDGET_MS)
    private fun remainingMs(deadlineNs: Long): Long = TimeUnit.NANOSECONDS.toMillis(deadlineNs - System.nanoTime())
}
