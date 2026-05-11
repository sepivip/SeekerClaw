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
     * Result of [lookupReservation] used by `/burner/sign-transaction` and
     * `/burner/commit` to validate the cap state machine BEFORE producing
     * a signature or counting a spend.
     *
     * - [NotFound] — reservation id was never seen, or has aged out of
     *   the disposed-id ring (treated identically by callers).
     * - [Expired] — reservation exists in `pending` but its `expiresAtMs`
     *   has passed; sweep will release it shortly.
     * - [NotPending] — reservation was previously committed or released;
     *   re-using the id is a state-machine violation, not a missing-id
     *   bug. Distinct from NotFound so callers can surface a different
     *   error code (and so logs distinguish "rotten id" from "wrong id").
     * - [Pending] — reservation is live and signable.
     *
     * BAT-582 R2: gates the sign-transaction endpoint, which previously
     * accepted any non-empty reservationId and produced a signature
     * unconditionally — bypassing the cap state machine entirely.
     */
    sealed class LookupResult {
        object NotFound : LookupResult()
        object Expired : LookupResult()
        object NotPending : LookupResult()
        data class Pending(val name: String, val atomicAmount: BigInteger) : LookupResult()
    }

    /**
     * In-memory ring of recently-disposed reservation ids (committed or
     * released). Lets [lookupReservation] return [LookupResult.NotPending]
     * instead of [LookupResult.NotFound] for ids that have already been
     * through the state machine. Bounded: capped at [DISPOSED_RING_MAX]
     * so a long-running process can't grow it without bound. Eviction is
     * FIFO by insertion order — a caller that re-uses a very old id will
     * see NotFound rather than NotPending, which is fine: NotFound is the
     * conservative answer (caller cannot proceed in either case).
     *
     * Synchronized on `this` ring instance — the operations are O(1) so
     * a process-wide lock is cheap. Not persisted across process restarts:
     * after a restart, callers see NotFound for any id that had been
     * disposed, which matches the contract (the id was never going to
     * sign anyway).
     */
    private val disposedIds: java.util.LinkedHashSet<String> = java.util.LinkedHashSet()

    private fun rememberDisposed(reservationId: String) {
        synchronized(disposedIds) {
            // LinkedHashSet preserves insertion order — re-adding moves
            // to end. We don't want that: oldest-first eviction is the
            // intended behavior, so remove-then-add (a no-op if absent).
            disposedIds.remove(reservationId)
            disposedIds.add(reservationId)
            while (disposedIds.size > DISPOSED_RING_MAX) {
                val oldest = disposedIds.iterator()
                if (oldest.hasNext()) {
                    oldest.next()
                    oldest.remove()
                } else break
            }
        }
    }

    private fun wasDisposed(reservationId: String): Boolean {
        synchronized(disposedIds) {
            return disposedIds.contains(reservationId)
        }
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
        // BAT-582 Phase 5: zero-amount reservations are valid for cancel
        // flows (Jupiter trigger/DCA cancel). Cancels are ownership-gated,
        // not principal-gated, so they don't consume cap state — but they
        // DO need to verify the burner is configured (the cancel has to
        // route to a real burner signer). We short-circuit the cap math
        // and produce a reservationId that commit/release can dispose of.
        // Negative amounts are still rejected.
        if (atomicAmount < BigInteger.ZERO) {
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

        // Skip per-tx and daily window math for zero-amount cancels —
        // there's nothing to charge against the cap. We still ran the
        // perTxCap=null check above so cancels don't slip through on
        // unconfigured burners.
        if (atomicAmount > BigInteger.ZERO) {
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
        // BAT-582 R2: record the id in the disposed ring so a later
        // /burner/sign-transaction or /burner/commit lookup with the
        // same id distinguishes "already committed" from "never existed".
        rememberDisposed(reservationId)
    }

    /** Idempotent. Releases a reservation without spending it. */
    suspend fun release(reservationId: String, @Suppress("unused") reason: String) {
        ledger.release(reservationId)
        // BAT-582 R2: track disposed ids (see commit() comment).
        rememberDisposed(reservationId)
    }

    /**
     * BAT-582 R2: validate a reservation before signing.
     *
     * Three-way classification:
     *   - found in pending and not yet expired    → [LookupResult.Pending]
     *   - found in pending but past expiresAtMs    → [LookupResult.Expired]
     *   - not in pending and id is in disposed ring → [LookupResult.NotPending]
     *   - otherwise                                → [LookupResult.NotFound]
     *
     * Pure read — does NOT mutate state. The sweep timer auto-releases
     * expired reservations every 30s; this lookup returns Expired without
     * forcing a sweep so /burner/sign-transaction can return a stable
     * error code immediately and the next sweep cycle handles cleanup.
     *
     * Must be called BEFORE [com.seekerclaw.app.data.wallet.KeyVault.signTransaction]
     * by the sign-transaction bridge endpoint — the contract is "the
     * reservation is the cap state machine's authorization to sign;
     * signing without one is a security gap".
     */
    fun lookupReservation(reservationId: String): LookupResult {
        val pending = ledger.findPending(reservationId)
        if (pending != null) {
            return if (pending.expiresAtMs <= clock()) {
                LookupResult.Expired
            } else {
                val amt = try { BigInteger(pending.atomicAmount) } catch (_: Exception) { BigInteger.ZERO }
                LookupResult.Pending(name = pending.name, atomicAmount = amt)
            }
        }
        // Not in pending. If we recently disposed of it (commit/release),
        // surface NotPending — the caller is reusing a finalized id.
        return if (wasDisposed(reservationId)) LookupResult.NotPending else LookupResult.NotFound
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
        /**
         * Cap on the in-memory disposed-id ring. Sized for "many days of
         * normal device usage" — the burner is expected to do a few txs
         * per day, so 1024 is comfortably oversized but still trivial for
         * memory (~64 KB at 64 bytes per UUID string entry). Aging out
         * the oldest entries first means a long-running process never
         * grows this without bound; old ids that age out fall back to
         * NotFound, which is conservative (callers can't proceed either way).
         */
        private const val DISPOSED_RING_MAX = 1024

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
