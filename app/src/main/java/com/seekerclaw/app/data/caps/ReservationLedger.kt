package com.seekerclaw.app.data.caps

import java.math.BigInteger

/**
 * ReservationLedger — persistence for in-flight cap reservations (BAT-582).
 *
 * Backed by CrossProcessStore so spend ledger + active reservations are
 * coherent across the Settings UI process and the Node service process.
 *
 * Phase 1: type signatures. Phase 2 fills implementation:
 *   - atomic-write JSON (pattern from BAT-514 CrossProcessStore migration)
 *   - daily window rollover at 00:00 UTC
 *   - atomic-unit storage (BigInteger toString) — no Number math
 *   - sweep recovers cleanly across crashes mid-reserve
 */
class ReservationLedger {

    data class Reservation(
        val id: String,
        val name: String,
        val atomicAmount: BigInteger,
        val createdAtMs: Long,
        val expiresAtMs: Long,
    )

    /** Append a new reservation. Caller (CapEnforcer.reserve) holds the mutex. */
    suspend fun add(@Suppress("unused") reservation: Reservation) {
        throw NotImplementedError("ReservationLedger.add — Phase 2")
    }

    /** Move a reservation from "pending" to "spent" — counts against daily total. */
    suspend fun commit(@Suppress("unused") reservationId: String, @Suppress("unused") signature: String?) {
        throw NotImplementedError("ReservationLedger.commit — Phase 2")
    }

    /** Idempotent: removes from "pending" without affecting daily spent total. */
    suspend fun release(@Suppress("unused") reservationId: String) {
        throw NotImplementedError("ReservationLedger.release — Phase 2")
    }

    /** Sum of pending + committed amounts in the current 24h window. */
    suspend fun spentInWindow(@Suppress("unused") name: String, @Suppress("unused") nowMs: Long): BigInteger {
        throw NotImplementedError("ReservationLedger.spentInWindow — Phase 2")
    }

    /** Release any reservation older than its TTL. Returns count released. */
    suspend fun sweepStale(@Suppress("unused") nowMs: Long): Int {
        throw NotImplementedError("ReservationLedger.sweepStale — Phase 2")
    }
}
