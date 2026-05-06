package com.seekerclaw.app.data.caps

import java.math.BigInteger

/**
 * CapEnforcer — Android-side, single canonical writer for burner spending
 * caps and reservations (BAT-582).
 *
 * **Architecture (per contract v1.4):**
 *   - Android is the SOLE writer to cap state in CrossProcessStore.
 *   - Node has a read-only preflight (`caps/preflight.js`); it never reserves.
 *   - All bridge endpoints `/burner/reserve`, `/burner/sign-*`, `/burner/commit`,
 *     `/burner/release` go through this class.
 *   - reserve() is mutex-guarded; commit/release are idempotent.
 *
 * **State machine:**
 *   1. reserve(name, atomicAmount, ttlMs) → reservationId  (mutex-guarded check+add)
 *   2. caller signs + broadcasts
 *   3a. on success → commit(reservationId, signature?)
 *   3b. on error/timeout → release(reservationId, reason)
 *   4. periodic sweep auto-releases reservations older than ttlMs
 *
 * Cap math is BigInteger (atomic units: lamports / USDC microunits).
 * No Float/Double anywhere in this module.
 *
 * Phase 1: type signatures pinned. Phase 2 fills implementation against
 * CrossProcessStore + `ReservationLedger`.
 */
class CapEnforcer {

    sealed class ReserveResult {
        data class Ok(val reservationId: String) : ReserveResult()
        data class Rejected(val reason: String) : ReserveResult()
    }

    /**
     * Atomic check+reserve. Mutex-guarded so batched tool calls cannot
     * race past the cap. Default TTL is 60s; sweep runs every 30s.
     *
     * Stable rejection reasons (mirrored in DIAGNOSTICS.md):
     *   - "burner_not_configured"
     *   - "over_per_tx_cap"
     *   - "over_daily_cap"
     */
    suspend fun reserve(
        @Suppress("unused") name: String,
        @Suppress("unused") atomicAmount: BigInteger,
        @Suppress("unused") ttlMs: Long = 60_000L,
    ): ReserveResult {
        throw NotImplementedError("CapEnforcer.reserve — Phase 2")
    }

    /** Idempotent. Marks a reservation as committed (counts toward daily total). */
    suspend fun commit(@Suppress("unused") reservationId: String, @Suppress("unused") signature: String? = null) {
        throw NotImplementedError("CapEnforcer.commit — Phase 2")
    }

    /** Idempotent. Releases a reservation without spending it. */
    suspend fun release(@Suppress("unused") reservationId: String, @Suppress("unused") reason: String) {
        throw NotImplementedError("CapEnforcer.release — Phase 2")
    }

    /** Sweep stale reservations (called by periodic timer in service). */
    suspend fun sweepStale() {
        throw NotImplementedError("CapEnforcer.sweepStale — Phase 2")
    }
}
