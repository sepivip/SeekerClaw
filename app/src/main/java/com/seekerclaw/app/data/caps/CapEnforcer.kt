package com.seekerclaw.app.data.caps

import android.content.Context
import com.seekerclaw.app.util.CrossProcessStore
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.math.BigInteger
import java.util.UUID

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
 * **Singleton scope.** The mutex must guard reservations across every
 * caller in the host process. Use [CapEnforcer.get(context)] to obtain
 * the canonical instance — never construct directly outside tests.
 */
class CapEnforcer internal constructor(
    private val ledger: ReservationLedger,
    private val clock: () -> Long = { System.currentTimeMillis() },
) {

    /**
     * Mutex around the entire reserve() read-modify-write — the cap-math
     * check and the ledger.add must be atomic w.r.t. each other so two
     * concurrent reservations cannot both pass the under-cap check and
     * land. commit/release/sweep do NOT take this mutex; they go straight
     * to the ledger which serializes its own writes via CrossProcessStore.
     *
     * NOTE: must NOT be held across the actual signing call — holding a
     * single device-wide mutex through an Ed25519 sign would serialize
     * all signing work. CapEnforcer.reserve returns once the reservation
     * lands; the signer then runs unblocked, and commit/release happen
     * after.
     */
    private val mutex = Mutex()

    sealed class ReserveResult {
        data class Ok(val reservationId: String) : ReserveResult()
        data class Rejected(val reason: String) : ReserveResult()
    }

    /**
     * Atomic check+reserve. Mutex-guarded so batched tool calls cannot
     * race past the cap. Default TTL is 60s.
     *
     * Cap config is read live from CrossProcessStore at call time —
     * Settings UI / chat-side `/config/burner-caps` writes take effect
     * immediately for the next reserve.
     *
     * Stable rejection reasons (mirrored in DIAGNOSTICS.md):
     *   - "burner_not_configured"
     *   - "over_per_tx_cap"
     *   - "over_daily_cap"
     */
    suspend fun reserve(
        name: String,
        atomicAmount: BigInteger,
        ttlMs: Long = 60_000L,
    ): ReserveResult = mutex.withLock {
        if (atomicAmount <= BigInteger.ZERO) {
            return@withLock ReserveResult.Rejected("invalid_amount")
        }

        val now = clock()
        val state = ledger.snapshot()

        // Pull the cap value for this name. "0" / unset means burner is
        // not configured for this asset.
        val perTxCap = perTxCapFor(state, name)
        val dailyCap = dailyCapFor(state, name)

        if (perTxCap == null || perTxCap == BigInteger.ZERO) {
            // No per-tx cap configured for this asset → burner can't
            // spend it. Surface as "burner_not_configured" rather than
            // "over_per_tx_cap" so the agent gets the right diagnostic.
            return@withLock ReserveResult.Rejected("burner_not_configured")
        }

        if (atomicAmount > perTxCap) {
            return@withLock ReserveResult.Rejected("over_per_tx_cap")
        }

        // Daily cap check: spent_in_window + atomicAmount must be ≤ dailyCap.
        // dailyCap == 0 means "no daily cap configured" → also treat as
        // burner_not_configured for the asset (per-tx cap alone isn't
        // a meaningful spend bound).
        if (dailyCap == null || dailyCap == BigInteger.ZERO) {
            return@withLock ReserveResult.Rejected("burner_not_configured")
        }

        val dailyName = toDailyCapName(name)
        if (dailyName != null) {
            val spent = ledger.spentInWindow(dailyName, now)
            if (spent + atomicAmount > dailyCap) {
                return@withLock ReserveResult.Rejected("over_daily_cap")
            }
        }

        val reservationId = UUID.randomUUID().toString()
        val ok = ledger.add(
            ReservationLedger.Reservation(
                id = reservationId,
                name = name,
                atomicAmount = atomicAmount,
                createdAtMs = now,
                expiresAtMs = now + ttlMs,
            )
        )
        if (!ok) return@withLock ReserveResult.Rejected("ledger_write_failed")
        ReserveResult.Ok(reservationId)
    }

    /** Idempotent. Marks a reservation as committed (counts toward daily total). */
    suspend fun commit(reservationId: String, @Suppress("unused") signature: String? = null) {
        // We don't persist the signature — it's not needed to enforce
        // caps and storing it would only enlarge the ledger. The
        // parameter is kept on the interface for future audit-log use.
        ledger.commit(reservationId, clock())
    }

    /** Idempotent. Releases a reservation without spending it. */
    suspend fun release(reservationId: String, @Suppress("unused") reason: String) {
        ledger.release(reservationId)
    }

    /** Sweep stale reservations (called by periodic timer in service). */
    suspend fun sweepStale(): Int {
        return ledger.sweepStale(clock())
    }

    /**
     * Status snapshot for `/burner/status`. Reads live state via the
     * ledger (rolling the daily window if needed) and returns
     * everything the bridge endpoint needs.
     */
    suspend fun status(): CapStatus {
        val now = clock()
        val raw = ledger.snapshot()
        val rolled = ledger.rolloverIfNeeded(raw, now)
        return CapStatus(
            capPerTxSol = rolled.capPerTxSol,
            capPerTxUsdc = rolled.capPerTxUsdc,
            capDailySol = rolled.capDailySol,
            capDailyUsdc = rolled.capDailyUsdc,
            spentTodaySol = ledger.spentInWindow("burner.daily.sol", now).toString(),
            spentTodayUsdc = ledger.spentInWindow("burner.daily.usdc", now).toString(),
        )
    }

    /**
     * Update cap configuration (Settings UI + chat tool). Takes effect
     * immediately for the next reserve(). Null arguments leave that
     * field unchanged.
     *
     * Caps are stored as atomic-unit decimal strings — caller (the
     * `/config/burner-caps` bridge endpoint, the Settings save) is
     * responsible for parsing user-decimal input into atomic units.
     */
    suspend fun setCaps(
        capPerTxSol: String? = null,
        capPerTxUsdc: String? = null,
        capDailySol: String? = null,
        capDailyUsdc: String? = null,
    ): Boolean {
        // Validate every supplied field parses as a non-negative BigInteger.
        // A bad value would silently leave the cap at "0" (= burner_not_configured)
        // which masks the user error. Better to surface the failure to
        // the caller via false return.
        listOfNotNull(capPerTxSol, capPerTxUsdc, capDailySol, capDailyUsdc).forEach {
            try {
                if (BigInteger(it) < BigInteger.ZERO) return false
            } catch (_: Exception) {
                return false
            }
        }
        return ledger.updateCaps(
            capPerTxSol = capPerTxSol,
            capPerTxUsdc = capPerTxUsdc,
            capDailySol = capDailySol,
            capDailyUsdc = capDailyUsdc,
        )
    }

    data class CapStatus(
        val capPerTxSol: String,
        val capPerTxUsdc: String,
        val capDailySol: String,
        val capDailyUsdc: String,
        val spentTodaySol: String,
        val spentTodayUsdc: String,
    )

    // --- helpers ---

    private fun perTxCapFor(state: BurnerCapsState, name: String): BigInteger? {
        return when {
            name.contains("pertx") || name.contains("daily") -> when {
                name.endsWith(".sol") -> safeBigInt(state.capPerTxSol)
                name.endsWith(".usdc") -> safeBigInt(state.capPerTxUsdc)
                else -> null
            }
            else -> null
        }
    }

    private fun dailyCapFor(state: BurnerCapsState, name: String): BigInteger? {
        return when {
            name.endsWith(".sol") -> safeBigInt(state.capDailySol)
            name.endsWith(".usdc") -> safeBigInt(state.capDailyUsdc)
            else -> null
        }
    }

    /**
     * Parse a stored cap string. Returns BigInteger.ZERO for empty /
     * malformed values (treats them as "not configured") so a corrupt
     * file can never produce a cap-bypass; the worst case is the
     * burner appears unconfigured and falls back to MWA.
     */
    private fun safeBigInt(s: String): BigInteger {
        if (s.isBlank()) return BigInteger.ZERO
        return try { BigInteger(s) } catch (_: Exception) { BigInteger.ZERO }
    }

    private fun toDailyCapName(name: String): String? {
        // burner.pertx.sol → burner.daily.sol  (we always check daily window
        // even when the caller passed a per-tx cap name)
        return when {
            name.endsWith(".sol") -> "burner.daily.sol"
            name.endsWith(".usdc") -> "burner.daily.usdc"
            else -> null
        }
    }

    companion object {
        @Volatile
        private var instance: CapEnforcer? = null

        /**
         * Get the canonical CapEnforcer for this process. Single instance
         * so the mutex actually serializes across every caller.
         */
        fun get(context: Context): CapEnforcer {
            val existing = instance
            if (existing != null) return existing
            return synchronized(this) {
                val again = instance
                if (again != null) return@synchronized again
                val store = CrossProcessStore(
                    context = context.applicationContext,
                    fileName = BurnerCapsState.FILE_NAME,
                    serializer = BurnerCapsState.serializer(),
                    initial = BurnerCapsState(),
                )
                val ledger = ReservationLedger(store)
                val enforcer = CapEnforcer(ledger)
                instance = enforcer
                enforcer
            }
        }

        /** Test seam: drop the singleton so the next test case can rebuild. */
        @androidx.annotation.VisibleForTesting
        internal fun resetForTest() {
            instance = null
        }
    }
}
