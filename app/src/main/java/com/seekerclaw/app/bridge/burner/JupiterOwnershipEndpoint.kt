package com.seekerclaw.app.bridge.burner

import android.content.Context
import android.util.Log
import com.seekerclaw.app.util.CrossProcessStore

/**
 * JupiterOwnershipEndpoint — handles `POST /jupiter/order-owner/set`
 * (BAT-582).
 *
 * **Why this exists:** Jupiter limit / DCA orders persist on-chain and can
 * be cancelled later. Cancel mutates financial state. The agent must route
 * a cancel to the wallet that CREATED the order (burner-owned → silent
 * burner cancel; main-owned → MWA confirmation popup).
 *
 * **Write path:** the Node tool calls this endpoint AFTER successful
 * broadcast (any signer — burner OR main) but BEFORE returning to the
 * agent. This ensures ownership is recorded before any subsequent cancel
 * can route. Failure of this endpoint after a successful create does NOT
 * unwind the create — tool logs a diagnostic and the cancel falls back
 * to the "unknown order → main + confirm + diagnostic" path.
 *
 * **Storage:** [CrossProcessStore]<[JupiterOwnershipState]> — non-cap,
 * doesn't share the single-writer constraint that `/burner/<x>` endpoints
 * have. Map shape: `{orderId → "burner" | "main"}`.
 */
class JupiterOwnershipEndpoint internal constructor(
    private val store: CrossProcessStore<JupiterOwnershipState>,
) {

    /**
     * Set ownership for an order id. Idempotent: re-setting the same
     * orderId to the same role is a TRUE no-op — a fast-path read
     * before update() short-circuits without touching disk or
     * broadcasting. Re-setting to a DIFFERENT role overwrites with a
     * diagnostic log (shouldn't happen in V1 — indicates a bug,
     * tampering, or a re-used orderId).
     *
     * Returns true on successful write (or no-op same-role re-set);
     * false on filesystem failure.
     */
    suspend fun set(orderId: String, role: String): Boolean {
        if (orderId.isBlank()) return false
        if (role != "burner" && role != "main") return false

        // R3 review fix (Copilot): CrossProcessStore.update() does NOT
        // short-circuit when next == current — it always persists and
        // broadcasts. Without this fast-path, every same-role re-set
        // (idempotent retry, replay) would rewrite the file and fire
        // a cross-process FileObserver notify for no logical change.
        // The race window between read() and update() is acceptable in
        // V1: the Node tool is the only writer of Jupiter ownership and
        // doesn't issue concurrent same-orderId writes.
        val current = store.read()
        if (current.orders[orderId] == role) return true

        return store.update { state ->
            val existing = state.orders[orderId]
            if (existing != null && existing != role) {
                Log.w(
                    TAG,
                    "Jupiter ownership conflict for $orderId: $existing → $role (overwriting)",
                )
            }
            state.copy(orders = state.orders + (orderId to role))
        }
    }

    /**
     * Read ownership for an order id. Null if unknown — cancel falls
     * back to "main + confirm + diagnostic" per contract v1.4.
     */
    fun get(orderId: String): String? {
        if (orderId.isBlank()) return null
        return store.read().orders[orderId]
    }

    companion object {
        private const val TAG = "JupiterOwnership"

        @Volatile
        private var instance: JupiterOwnershipEndpoint? = null

        fun get(context: Context): JupiterOwnershipEndpoint {
            val existing = instance
            if (existing != null) return existing
            return synchronized(this) {
                val again = instance
                if (again != null) return@synchronized again
                val store = CrossProcessStore(
                    context = context.applicationContext,
                    fileName = JupiterOwnershipState.FILE_NAME,
                    serializer = JupiterOwnershipState.serializer(),
                    initial = JupiterOwnershipState(),
                )
                val endpoint = JupiterOwnershipEndpoint(store)
                instance = endpoint
                endpoint
            }
        }

        @androidx.annotation.VisibleForTesting
        internal fun resetForTest() {
            instance = null
        }
    }
}
