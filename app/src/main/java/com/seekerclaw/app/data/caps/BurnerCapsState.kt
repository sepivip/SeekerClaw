package com.seekerclaw.app.data.caps

import kotlinx.serialization.Serializable

/**
 * Persistent shape for burner cap configuration + spend ledger + active
 * reservations (BAT-582).
 *
 * Lives at `filesDir/burner_caps.json` via [com.seekerclaw.app.util.CrossProcessStore].
 *
 * Money fields are atomic-unit decimal strings (BigInt-compatible) — never
 * Long or Double. Reasons:
 *   - lamports caps can exceed Long range trivially with enthusiastic
 *     decimal entry (still fine, but BigInteger keeps types consistent
 *     across SOL and USDC),
 *   - JSON numbers in some toolchains lose precision past 2^53,
 *   - matches the Node-side preflight ([CAP_MAP][caps/preflight.js])
 *     which uses BigInt.
 *
 * The four cap fields hold the user's configured limits. The `spentSol` /
 * `spentUsdc` fields are running totals for the current 24h window
 * (window key = floor(nowMs / 86_400_000) under UTC) and roll over
 * automatically the first time [CapEnforcer] processes a request after
 * 00:00 UTC.
 *
 * @property capPerTxSol per-transaction SOL cap, atomic lamports as
 *           decimal string. "0" or empty means burner disabled for SOL.
 * @property capPerTxUsdc per-tx USDC cap, microunits decimal string.
 * @property capDailySol 24h SOL cap, atomic lamports.
 * @property capDailyUsdc 24h USDC cap, microunits.
 * @property windowStartMs epoch-ms aligned to UTC midnight for the
 *           current spend window. Rolls forward when the wall clock
 *           crosses into the next 24h window.
 * @property spentSol committed SOL spend (atomic) inside [windowStartMs].
 * @property spentUsdc committed USDC spend (atomic) inside [windowStartMs].
 * @property pending in-flight reservations (not yet committed). Each
 *           reservation is also counted toward cap math while it's
 *           pending, then promoted to spent on commit, dropped on
 *           release.
 */
@Serializable
data class BurnerCapsState(
    val capPerTxSol: String = "0",
    val capPerTxUsdc: String = "0",
    val capDailySol: String = "0",
    val capDailyUsdc: String = "0",
    val windowStartMs: Long = 0L,
    val spentSol: String = "0",
    val spentUsdc: String = "0",
    val pending: List<PendingReservation> = emptyList(),
) {
    companion object {
        const val FILE_NAME = "burner_caps.json"
        const val WINDOW_MS = 86_400_000L
    }
}

/**
 * One in-flight reservation. Persisted by [CapEnforcer] / [ReservationLedger].
 *
 * @property id unique reservation identifier (UUID).
 * @property name cap name from the Node-side CAP_MAP (e.g.
 *           "burner.daily.sol", "burner.pertx.usdc").
 * @property atomicAmount atomic-unit amount as a decimal string.
 * @property createdAtMs epoch-ms at reservation time.
 * @property expiresAtMs epoch-ms after which sweepStale will release this.
 */
@Serializable
data class PendingReservation(
    val id: String,
    val name: String,
    val atomicAmount: String,
    val createdAtMs: Long,
    val expiresAtMs: Long,
)
