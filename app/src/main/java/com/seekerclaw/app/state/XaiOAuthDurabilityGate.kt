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
     * Ensure the xAI OAuth family is in a durable state for a controlled stop.
     * Returns `true` when durable (persisted OR fail-closed marked OR nothing to
     * protect), `false` only when the budget was exhausted without reaching a
     * durable state (catastrophic disk failure — the caller decides whether to
     * keep the service alive and retry, or OS-fallback kill). Never throws.
     */
    fun ensureDurableBeforeStop(): Boolean {
        if (!XaiOAuthTokenStore.isInitialized) return true
        val rec = try {
            XaiOAuthTokenStore.read()
        } catch (e: Exception) {
            LogCollector.append("[Shutdown] xAI durability gate: read failed (${e.javaClass.simpleName})", LogLevel.WARN)
            // Can't read the record → can't prove there's nothing stranded → fail-closed attempt.
            return markReauthWithinDeadline(expectedEpoch = 0L, deadlineNs = deadline())
        }
        // Only a LIVE oauth family can strand a consumed→rotated pair. api-key users,
        // sign-outs, and already-dead families have nothing to protect.
        val live = !rec.tombstone && !rec.reauthRequired && rec.accessTokenEnc.isNotEmpty()
        if (!live) return true

        val deadlineNs = deadline()

        // Phase 1 — give Node repeated chances to persist the VALID rotated T1.
        var round = 0
        while (round < MAX_FLUSH_ROUNDS && remainingMs(deadlineNs) > 0L) {
            round++
            // The signal is Node's AUTHORITATIVE `diskUnsafe` (Codex re-review blocker-2):
            // false = the on-disk record is safe to boot from; true = unsafe (pending pair OR
            // convergence-exhausted OR failed dead-mark); null = unreachable/unparseable.
            val unsafe: Boolean? = try {
                // Codex re-review major-1: cap the round to the REMAINING budget at BOTH levels —
                // pass the budget into flushShutdown so its underlying (non-cancellable) HTTP
                // connect/read timeouts are themselves capped, AND wrap in withTimeoutOrNull as a
                // coroutine-level backstop. Either way a late-starting round stays inside BUDGET_MS
                // (null on timeout → treated as unreachable → fail-closed).
                val budget = remainingMs(deadlineNs)
                runBlocking { withTimeoutOrNull(budget) { NodeControlClient.flushShutdown(budget.toInt().coerceAtLeast(1)) } }
            } catch (e: Exception) {
                LogCollector.append(
                    "[Shutdown] xAI durability gate: flush round threw (${e.javaClass.simpleName}: ${e.message})",
                    LogLevel.WARN,
                )
                null
            }
            when (unsafe) {
                false -> {
                    // Node confirmed the on-disk record is safe — nothing stranded/unsafe.
                    if (round > 1) {
                        LogCollector.append("[Shutdown] xAI durability gate: disk confirmed safe on round $round", LogLevel.INFO)
                    }
                    return true
                }
                true -> {
                    // Disk unsafe after Node's own drain. Another round MAY let a momentary
                    // persist failure recover; otherwise we fall through to the fail-closed mark.
                    LogCollector.append(
                        "[Shutdown] xAI durability gate: on-disk token unsafe to boot from (round $round/$MAX_FLUSH_ROUNDS)",
                        LogLevel.WARN,
                    )
                }
                null -> {
                    // Unreachable/unparseable — no point re-flushing; go straight to fail-closed.
                    LogCollector.append(
                        "[Shutdown] xAI durability gate: Node unreachable — engaging fail-closed mark",
                        LogLevel.WARN,
                    )
                    break
                }
            }
        }

        // Phase 2 — fail closed: durably mark the family reauth-required so the next
        // boot reconnects instead of replaying a possibly-consumed refresh token.
        return markReauthWithinDeadline(expectedEpoch = rec.epoch, deadlineNs = deadlineNs)
    }

    /**
     * Retry [XaiOAuthTokenStore.markReauth] until it is positively durable or the
     * monotonic [deadlineNs] passes. `Ok` ⇒ marked; `Conflict` ⇒ a fresh sign-in/out
     * already advanced the epoch (the winning family is intact, so we ARE durable);
     * `Failed` ⇒ retry within budget. Returns `false` only if the budget expires with
     * every attempt Failed (disk broken — nothing could have saved the family anyway).
     */
    private fun markReauthWithinDeadline(expectedEpoch: Long, deadlineNs: Long): Boolean {
        while (remainingMs(deadlineNs) > 0L) {
            // The store's markReauth is documented never-throws, but keep the gate itself
            // fail-closed (CodeRabbit): any unexpected throw becomes a retryable Failed rather
            // than propagating out of ensureDurableBeforeStop (whose caller must NOT fail open).
            val r = try {
                // Codex re-review major-1: cap the store lock to the gate's REMAINING budget so a
                // mark started near expiry can't add its own full lock allowance on top of BUDGET_MS.
                XaiOAuthTokenStore.markReauth(expectedEpoch, maxLockMs = remainingMs(deadlineNs))
            } catch (e: Exception) {
                XaiOAuthTokenStore.Result.Failed(e.message ?: e.javaClass.simpleName)
            }
            when (r) {
                is XaiOAuthTokenStore.Result.Ok -> {
                    LogCollector.append(
                        "[Shutdown] xAI durability gate: fail-closed reauth mark persisted (epoch=${r.record.epoch})",
                        LogLevel.WARN,
                    )
                    return true
                }
                is XaiOAuthTokenStore.Result.Conflict -> {
                    LogCollector.append(
                        "[Shutdown] xAI durability gate: epoch advanced ($expectedEpoch→${r.currentEpoch}) — winning family durable",
                        LogLevel.WARN,
                    )
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
            }
        }
        LogCollector.append(
            "[Shutdown] xAI durability gate: could NOT confirm durability within ${BUDGET_MS}ms budget",
            LogLevel.ERROR,
        )
        return false
    }

    private fun deadline(): Long = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(BUDGET_MS)
    private fun remainingMs(deadlineNs: Long): Long = TimeUnit.NANOSECONDS.toMillis(deadlineNs - System.nanoTime())
}
