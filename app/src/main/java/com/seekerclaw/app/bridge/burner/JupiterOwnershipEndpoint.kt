package com.seekerclaw.app.bridge.burner

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
 * **Storage:** CrossProcessStore — non-cap, doesn't share the
 * single-writer constraint that `/burner/*` endpoints have. Map shape:
 * `{orderId → "burner" | "main"}`.
 *
 * Phase 1: file skeleton. Phase 2/5 wires into AndroidBridge.kt.
 */
class JupiterOwnershipEndpoint {

    /**
     * Set ownership for an order id. Idempotent: re-setting the same
     * orderId to the same role is a no-op; re-setting to a different
     * role overwrites with a diagnostic log (shouldn't happen in V1 —
     * indicates a bug or tampering).
     */
    suspend fun set(@Suppress("unused") orderId: String, @Suppress("unused") role: String) {
        throw NotImplementedError("JupiterOwnershipEndpoint.set — Phase 2/5")
    }

    /** Read ownership for an order id. Null if unknown (cancel falls back to main + confirm). */
    suspend fun get(@Suppress("unused") orderId: String): String? {
        throw NotImplementedError("JupiterOwnershipEndpoint.get — Phase 2/5")
    }
}
