package com.seekerclaw.app.bridge.burner

import kotlinx.serialization.Serializable

/**
 * Persistent shape for the Jupiter order ownership map (BAT-582).
 *
 * Tracks `{orderId → "burner" | "main"}` so cancel routing can pick the
 * right wallet (burner-owned → silent; main-owned → MWA confirmation).
 *
 * Lives at `filesDir/jupiter_ownership.json` via
 * [com.seekerclaw.app.util.CrossProcessStore]. Non-cap mutation; doesn't
 * share the single-writer constraint that `/burner/<x>` endpoints have.
 */
@Serializable
data class JupiterOwnershipState(
    val orders: Map<String, String> = emptyMap(),
) {
    companion object {
        const val FILE_NAME = "jupiter_ownership.json"
    }
}
