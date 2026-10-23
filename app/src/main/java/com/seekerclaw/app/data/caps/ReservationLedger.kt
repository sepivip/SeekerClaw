package com.seekerclaw.app.data.caps

import com.seekerclaw.app.util.CrossProcessStore
import java.math.BigInteger

/**
 * ReservationLedger — persistence helper for in-flight cap reservations
 * and the rolling 24h spend window (BAT-582).
 *
 * Backed by a [CrossProcessStore] of [BurnerCapsState]. The store is the
 * single source of truth across processes (UI + `:node` service); writes
 * are atomic via tmp + ATOMIC_MOVE, observer-driven cross-process
 * notification (FileObserver + broadcast).
 *
 * **Single-writer contract:** only [CapEnforcer] is allowed to call this
 * class's mutators. CapEnforcer holds a process-local mutex around
 * `reserve()` so the read-modify-write sequence is atomic w.r.t. other
 * tool calls in the same process. Cross-process concurrent writes degrade
 * to last-writer-wins (filesystem move semantics) — there is exactly one
 * writer process by design (the main UI process via the bridge).
 *
 * Money math is BigInteger-only. Atomic-unit strings on disk; never
 * `Long` or `Double` for monetary values.
 */
class ReservationLedger(
    private val store: CrossProcessStore<BurnerCapsState>,
) {

    data class Reservation(
        val id: String,
        val name: String,
        val atomicAmount: BigInteger,
        val createdAtMs: Long,
        val expiresAtMs: Long,
    )

    /** Snapshot of the current persisted state. */
    fun snapshot(): BurnerCapsState = store.read()

    /**
     * Look up a pending reservation by id. Returns null if no reservation
     * with that id exists in the current pending set (i.e., either it
     * never existed, or it was already committed/released and removed).
     *
     * Caller (CapEnforcer.lookupReservation) layers a "previously disposed"
     * check on top so /burner/sign-transaction can return a different
     * error code when the id was committed/released vs. genuinely unknown.
     */
    fun findPending(reservationId: String): PendingReservation? {
        return store.read().pending.firstOrNull { it.id == reservationId }
    }

    /**
     * Append a new reservation. Caller (CapEnforcer.reserve) holds the
     * mutex AND has already verified the cap math. The transform here
     * is straight append — we don't second-guess the caller.
     *
     * Also rolls the 24h spend window if the wall clock has advanced
     * past it; new reservations after rollover see `spent*` = 0.
     */
    suspend fun add(reservation: Reservation): Boolean {
        return store.update { current ->
            val rolled = rolloverIfNeeded(current, reservation.createdAtMs)
            rolled.copy(
                pending = rolled.pending + PendingReservation(
                    id = reservation.id,
                    name = reservation.name,
                    atomicAmount = reservation.atomicAmount.toString(),
                    createdAtMs = reservation.createdAtMs,
                    expiresAtMs = reservation.expiresAtMs,
                ),
            )
        }
    }

    /**
     * Move a reservation from "pending" to "spent" — counts against the
     * daily total. Idempotent: a second commit with the same id is a
     * no-op (the reservation has already been removed from `pending`).
     *
     * Window rollover is applied before the spend lands so a commit
     * that crosses 00:00 UTC counts in the new window, not against
     * the old window's stale total.
     */
    suspend fun commit(reservationId: String, nowMs: Long = System.currentTimeMillis()): Boolean {
        return store.update { raw ->
            val current = rolloverIfNeeded(raw, nowMs)
            val reservation = current.pending.firstOrNull { it.id == reservationId }
                ?: return@update current  // already committed/released → no-op
            val newPending = current.pending.filterNot { it.id == reservationId }
            val (newSpentSol, newSpentUsdc) = applySpend(
                current = current,
                name = reservation.name,
                atomicAmount = BigInteger(reservation.atomicAmount),
            )
            current.copy(
                pending = newPending,
                spentSol = newSpentSol,
                spentUsdc = newSpentUsdc,
            )
        }
    }

    /**
     * Idempotent: removes from "pending" without affecting daily spent.
     * Returns true if a write happened; false if the reservation was
     * already gone (still considered success — release is idempotent).
     */
    suspend fun release(reservationId: String): Boolean {
        return store.update { current ->
            val present = current.pending.any { it.id == reservationId }
            if (!present) return@update current
            current.copy(pending = current.pending.filterNot { it.id == reservationId })
        }
    }

    /**
     * Update cap configuration fields. Non-null values overwrite; null
     * leaves the field unchanged. Single canonical writer (CapEnforcer)
     * is the only caller — bridge endpoints route through CapEnforcer
     * to enforce the contract that cap state is mutated through one path.
     */
    suspend fun updateCaps(
        capPerTxSol: String? = null,
        capPerTxUsdc: String? = null,
        capDailySol: String? = null,
        capDailyUsdc: String? = null,
    ): Boolean {
        return store.update { current ->
            current.copy(
                capPerTxSol = capPerTxSol ?: current.capPerTxSol,
                capPerTxUsdc = capPerTxUsdc ?: current.capPerTxUsdc,
                capDailySol = capDailySol ?: current.capDailySol,
                capDailyUsdc = capDailyUsdc ?: current.capDailyUsdc,
            )
        }
    }

    /** BAT-1409 P1-I: the outcome of [updateCapsNoRaise]. */
    sealed class NoRaiseResult {
        object Applied : NoRaiseResult()

        /** One or more fields would raise a cap: nothing was written. */
        data class Raised(val fields: List<String>) : NoRaiseResult()

        object Failed : NoRaiseResult()
    }

    /**
     * BAT-1409 P1-I — the bridge's cap write: like [updateCaps], but a request that would RAISE
     * any cap changes nothing. The comparison runs inside `store.update` on the current value, in
     * atomic BigInteger units; any positive value over a current 0 / blank / malformed cap counts
     * as a raise; equal and lower values are allowed. Raising caps is Settings-only.
     */
    suspend fun updateCapsNoRaise(
        capPerTxSol: String? = null,
        capPerTxUsdc: String? = null,
        capDailySol: String? = null,
        capDailyUsdc: String? = null,
    ): NoRaiseResult {
        var raised: List<String> = emptyList()
        val ok = store.update { current ->
            val r = mutableListOf<String>()
            if (isRaise(capPerTxSol, current.capPerTxSol)) r += "capPerTxSol"
            if (isRaise(capPerTxUsdc, current.capPerTxUsdc)) r += "capPerTxUsdc"
            if (isRaise(capDailySol, current.capDailySol)) r += "capDailySol"
            if (isRaise(capDailyUsdc, current.capDailyUsdc)) r += "capDailyUsdc"
            raised = r
            if (r.isNotEmpty()) {
                current
            } else {
                current.copy(
                    capPerTxSol = capPerTxSol ?: current.capPerTxSol,
                    capPerTxUsdc = capPerTxUsdc ?: current.capPerTxUsdc,
                    capDailySol = capDailySol ?: current.capDailySol,
                    capDailyUsdc = capDailyUsdc ?: current.capDailyUsdc,
                )
            }
        }
        return when {
            raised.isNotEmpty() -> NoRaiseResult.Raised(raised)
            ok -> NoRaiseResult.Applied
            else -> NoRaiseResult.Failed
        }
    }

    /** True when [requested] (null = unchanged) is above [current]; see [updateCapsNoRaise]. */
    private fun isRaise(requested: String?, current: String): Boolean {
        if (requested == null) return false
        val next = try { BigInteger(requested) } catch (_: Exception) { return true }
        val cur = try { if (current.isBlank()) null else BigInteger(current) } catch (_: Exception) { null }
        if (cur == null || cur.signum() <= 0) return next.signum() > 0
        return next > cur
    }

    /**
     * Sum of pending + committed amounts in the current 24h window for
     * the given cap [name]. The Node-side preflight uses similar math
     * via `/burner/status`; this method is the local Kotlin equivalent
     * for CapEnforcer.reserve()'s in-mutex check.
     *
     * Window-name resolution rules (matching the CAP_MAP shape):
     *   - "burner.daily.sol"  → spentSol + sum(pending where SOL-named)
     *   - "burner.daily.usdc" → spentUsdc + sum(pending where USDC-named)
     *   - per-tx caps are NOT tracked here; CapEnforcer compares the
     *     incoming amount alone against per-tx limits, no lookback.
     */
    fun spentInWindow(name: String, nowMs: Long): BigInteger {
        val current = rolloverIfNeeded(store.read(), nowMs)
        val isSol = name.endsWith(".sol")
        val isUsdc = name.endsWith(".usdc")
        if (!isSol && !isUsdc) return BigInteger.ZERO

        val committed = safeBigInt(if (isSol) current.spentSol else current.spentUsdc)
        val pendingSum = current.pending
            .filter { (isSol && it.name.endsWith(".sol")) || (isUsdc && it.name.endsWith(".usdc")) }
            .fold(BigInteger.ZERO) { acc, r -> acc + safeBigInt(r.atomicAmount) }
        return committed + pendingSum
    }

    private fun safeBigInt(s: String): BigInteger {
        if (s.isBlank()) return BigInteger.ZERO
        return try { BigInteger(s) } catch (_: Exception) { BigInteger.ZERO }
    }

    /**
     * Release any reservation older than its TTL. Returns count released.
     * Called by the periodic sweep timer in the service.
     */
    suspend fun sweepStale(nowMs: Long): Int {
        var released = 0
        store.update { current ->
            val (stale, fresh) = current.pending.partition { it.expiresAtMs <= nowMs }
            released = stale.size
            if (released == 0) return@update current
            current.copy(pending = fresh)
        }
        return released
    }

    // --- helpers ---

    /**
     * If [nowMs] has crossed into a new UTC 24h window, reset the
     * spend totals and update [windowStartMs]. Pending reservations
     * are NOT cleared — they belong to whichever window committed them.
     */
    internal fun rolloverIfNeeded(current: BurnerCapsState, nowMs: Long): BurnerCapsState {
        val newWindowStart = floorUtcDay(nowMs)
        if (current.windowStartMs == newWindowStart) return current
        // Crossing a window boundary always zeroes committed spend AND
        // updates windowStartMs. First-call case (windowStartMs == 0)
        // also lands here cleanly.
        return current.copy(
            windowStartMs = newWindowStart,
            spentSol = "0",
            spentUsdc = "0",
        )
    }

    /**
     * Apply a committed-spend delta to the appropriate field based on
     * cap name. Returns (newSpentSol, newSpentUsdc) decimal strings.
     */
    private fun applySpend(
        current: BurnerCapsState,
        name: String,
        atomicAmount: BigInteger,
    ): Pair<String, String> {
        val isSol = name.endsWith(".sol")
        val isUsdc = name.endsWith(".usdc")
        return when {
            isSol -> {
                val newSpent = safeBigInt(current.spentSol) + atomicAmount
                Pair(newSpent.toString(), current.spentUsdc)
            }
            isUsdc -> {
                val newSpent = safeBigInt(current.spentUsdc) + atomicAmount
                Pair(current.spentSol, newSpent.toString())
            }
            else -> Pair(current.spentSol, current.spentUsdc)
        }
    }

    companion object {
        /** Floor [ms] to UTC midnight (00:00:00.000) of the same day. */
        fun floorUtcDay(ms: Long): Long {
            return (ms / BurnerCapsState.WINDOW_MS) * BurnerCapsState.WINDOW_MS
        }
    }
}
