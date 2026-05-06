package com.seekerclaw.app.bridge.burner

/**
 * BurnerBridgeEndpoints — HTTP endpoints exposed on the Android Bridge
 * (port 8765, X-Bridge-Token auth) for burner wallet operations (BAT-582).
 *
 * **Endpoints (all POST, all return JSON):**
 *   - /burner/status          → wallet pubkey + balances + cap state + spend ledger
 *   - /burner/reserve         → atomic check+reserve a slot, returns reservationId
 *   - /burner/sign-transaction → sign-only (caller broadcasts), needs reservationId
 *   - /burner/sign-and-send   → atomic reserve+sign+broadcast+commit (or release)
 *   - /burner/commit          → mark reserved slot as committed (idempotent)
 *   - /burner/release         → release reserved slot without spending (idempotent)
 *   - /config/burner-caps     → update cap settings (Settings UI + chat both call this)
 *
 * **Hard rules:**
 *   - Response schemas are allowlist-only — fields named `key`, `seed`,
 *     `secret`, `private*` are stripped before send (defense in depth).
 *   - Error responses contain stable codes only, never key material or
 *     stack traces with key bytes.
 *   - Existing `X-Bridge-Token` auth (bridge is localhost-only) — V1
 *     keeps static token (per Codex resolution).
 *
 * Phase 1: file/class skeleton. Phase 2 wires this into AndroidBridge.kt
 * with full request handling, schema validation, and the response-allowlist
 * test (no key material in any success or error response).
 */
class BurnerBridgeEndpoints {

    /**
     * Stable error codes returned in `{error, reason}` responses. Mirror
     * of DIAGNOSTICS.md vocabulary.
     */
    object ErrorCodes {
        const val INVALID_KEY_FORMAT = "invalid_key_format"
        const val INVALID_KEYPAIR_PUBKEY_MISMATCH = "invalid_keypair_pubkey_mismatch"
        const val BURNER_NOT_CONFIGURED = "burner_not_configured"
        const val UNSUPPORTED_TX_FORMAT = "unsupported_tx_format"
        const val BURNER_NOT_REQUIRED_SIGNER = "burner_not_required_signer"
        const val ADDITIONAL_SIGNERS_REQUIRED = "additional_signers_required"
        const val BOGUS_SHORTVEC = "bogus_shortvec"
        const val OVER_PER_TX_CAP = "over_per_tx_cap"
        const val OVER_DAILY_CAP = "over_daily_cap"
        const val RESERVATION_EXPIRED = "reservation_expired"
        const val RESERVATION_NOT_FOUND = "reservation_not_found"
        const val INVALID_INPUT = "invalid_input"
    }

    // Phase 2: handlers will be invoked from AndroidBridge.serve() via
    // a routing table extension. See ARCHITECTURE.md for the full request
    // /response shape per endpoint.
}
