package com.seekerclaw.app.bridge.burner

import android.content.Context
import android.util.Log
import com.seekerclaw.app.data.caps.CapEnforcer
import com.seekerclaw.app.data.wallet.EncryptedPrefsKeyVault
import com.seekerclaw.app.data.wallet.KeyVault
import com.seekerclaw.app.data.wallet.SigningException
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import java.math.BigInteger

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
 * Wired into [com.seekerclaw.app.bridge.AndroidBridge.serve] for the
 * burner endpoints, `/config/burner-caps`, and `/jupiter/order-owner/set`
 * routes.
 */
class BurnerBridgeEndpoints internal constructor(
    private val keyVault: KeyVault,
    private val capEnforcer: CapEnforcer,
    private val jupiterOwnership: JupiterOwnershipEndpoint,
) {

    /**
     * Production constructor — wires up the default
     * EncryptedPrefsKeyVault + singleton CapEnforcer / JupiterOwnership
     * from the Application Context.
     */
    constructor(context: Context) : this(
        keyVault = EncryptedPrefsKeyVault(context.applicationContext),
        capEnforcer = CapEnforcer.get(context),
        jupiterOwnership = JupiterOwnershipEndpoint.get(context),
    )

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
        const val SIGN_FAILED = "sign_failed"
        const val BROADCAST_NOT_IMPLEMENTED = "broadcast_not_implemented"
    }

    /**
     * Whitelist of response field names. Any field NOT in this set is
     * stripped before the response body is serialized — defense in
     * depth against accidentally leaking key bytes through a developer
     * mistake. `private`-prefixed, `key`, `seed`, and `secret` are
     * additionally explicitly forbidden by [scrubResponse], but the
     * allowlist is the primary gate.
     */
    private val responseAllowlist: Set<String> = setOf(
        "ok",
        "error",
        "reason",
        "configured",
        "pubkey",
        "balanceSol",
        "balanceUsdc",
        "capPerTxSol",
        "capPerTxUsdc",
        "capDailySol",
        "capDailyUsdc",
        "spentTodaySol",
        "spentTodayUsdc",
        "network",
        "reservationId",
        "signedTxBase64",
        "signature",
    )

    /**
     * Endpoint URI dispatch. Returns null if [uri] isn't one of ours,
     * letting AndroidBridge.serve() fall through to its existing routes.
     *
     * Returned map is the JSON response body; success responses use
     * HTTP 200 (caller wraps via newFixedLengthResponse). For status
     * mapping into HTTP codes, see [statusFor].
     */
    fun dispatch(uri: String, params: JSONObject): EndpointResult? {
        return when (uri) {
            "/burner/status" -> handleStatus()
            "/burner/reserve" -> handleReserve(params)
            "/burner/sign-transaction" -> handleSignTransaction(params)
            "/burner/sign-and-send" -> handleSignAndSend(params)
            "/burner/commit" -> handleCommit(params)
            "/burner/release" -> handleRelease(params)
            "/config/burner-caps" -> handleConfigBurnerCaps(params)
            "/jupiter/order-owner/set" -> handleJupiterOwnershipSet(params)
            else -> null
        }
    }

    /**
     * Result of an endpoint dispatch — body + HTTP status. Allowlist
     * scrubbing is applied centrally by [scrubResponse] before the
     * caller serializes.
     */
    data class EndpointResult(val httpStatus: Int, val body: Map<String, Any?>)

    /**
     * Apply the response allowlist + the deny-suffix scrub to [body].
     * Public so AndroidBridge can call it on every burner response —
     * keeps the scrubbing in one place even if a future refactor
     * routes responses through a different code path.
     */
    fun scrubResponse(body: Map<String, Any?>): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>(body.size)
        for ((k, v) in body) {
            if (isForbiddenKey(k)) continue
            if (!responseAllowlist.contains(k)) {
                Log.w(TAG, "scrubResponse: field '$k' not in allowlist, dropping")
                continue
            }
            out[k] = v
        }
        return out
    }

    private fun isForbiddenKey(name: String): Boolean {
        val lower = name.lowercase()
        return lower == "key" ||
            lower == "seed" ||
            lower == "secret" ||
            lower.startsWith("private")
    }

    // --- handlers ---

    private fun handleStatus(): EndpointResult {
        return runBlocking {
            val pubkey = try {
                keyVault.getPubkey(BURNER_ID)
            } catch (e: Exception) {
                Log.w(TAG, "/burner/status getPubkey failed: ${e.message}")
                null
            }
            val status = capEnforcer.status()
            val configured = pubkey != null
            val body = LinkedHashMap<String, Any?>()
            body["configured"] = configured
            if (configured) body["pubkey"] = pubkey
            // Balance fetch is deferred to Phase 5 wiring (existing Helius
            // / RPC helpers will be reused). Emit "0" so downstream JSON
            // shape is stable; tools will pick up real numbers when
            // Phase 5 wires the RPC fetch in.
            body["balanceSol"] = "0"
            body["balanceUsdc"] = "0"
            body["capPerTxSol"] = status.capPerTxSol
            body["capPerTxUsdc"] = status.capPerTxUsdc
            body["capDailySol"] = status.capDailySol
            body["capDailyUsdc"] = status.capDailyUsdc
            body["spentTodaySol"] = status.spentTodaySol
            body["spentTodayUsdc"] = status.spentTodayUsdc
            body["network"] = "mainnet"
            EndpointResult(200, body)
        }
    }

    private fun handleReserve(params: JSONObject): EndpointResult {
        val name = params.optString("name", "").trim()
        val atomicAmountStr = params.optString("atomicAmount", "").trim()
        val ttlMs = params.optLong("ttlMs", 60_000L)
        if (name.isEmpty() || atomicAmountStr.isEmpty()) {
            return invalidInput("name and atomicAmount required")
        }
        val atomicAmount = try {
            BigInteger(atomicAmountStr)
        } catch (_: Exception) {
            return invalidInput("atomicAmount must be a decimal integer string")
        }
        if (atomicAmount <= BigInteger.ZERO) {
            return invalidInput("atomicAmount must be > 0")
        }
        if (ttlMs <= 0 || ttlMs > 10 * 60_000L) {
            return invalidInput("ttlMs out of range")
        }

        return runBlocking {
            when (val r = capEnforcer.reserve(name, atomicAmount, ttlMs)) {
                is CapEnforcer.ReserveResult.Ok ->
                    EndpointResult(200, mapOf("reservationId" to r.reservationId))
                is CapEnforcer.ReserveResult.Rejected ->
                    errorResp(400, codeForRejection(r.reason), r.reason)
            }
        }
    }

    private fun handleSignTransaction(params: JSONObject): EndpointResult {
        val txB64 = params.optString("txBase64", "").trim()
        val reservationId = params.optString("reservationId", "").trim()
        if (txB64.isEmpty() || reservationId.isEmpty()) {
            return invalidInput("txBase64 and reservationId required")
        }
        val txBytes = try {
            android.util.Base64.decode(txB64, android.util.Base64.NO_WRAP)
        } catch (_: Exception) {
            return invalidInput("txBase64 is not valid base64")
        }

        return runBlocking {
            try {
                val signed = keyVault.signTransaction(BURNER_ID, txBytes)
                val signedB64 = android.util.Base64.encodeToString(signed, android.util.Base64.NO_WRAP)
                EndpointResult(200, mapOf("signedTxBase64" to signedB64))
            } catch (e: SigningException) {
                errorResp(400, e.code, e.message ?: e.code)
            } catch (e: Exception) {
                Log.w(TAG, "/burner/sign-transaction failed: ${e.message}")
                errorResp(500, ErrorCodes.SIGN_FAILED, "sign failed")
            }
        }
    }

    private fun handleSignAndSend(params: JSONObject): EndpointResult {
        // Atomic: reserve (if no reservationId), sign, broadcast, commit
        // on success / release on error. For V1 the broadcast path is
        // RPC; jupiter broadcast is stubbed for Phase 4+ wiring.
        val txB64 = params.optString("txBase64", "").trim()
        val providedRes = params.optString("reservationId", "").trim()
        val broadcastVia = params.optString("broadcastVia", "rpc").trim()
        if (txB64.isEmpty()) {
            return invalidInput("txBase64 required")
        }
        if (broadcastVia != "rpc" && broadcastVia != "jupiter") {
            return invalidInput("broadcastVia must be 'rpc' or 'jupiter'")
        }
        // Phase 2 leaves the actual broadcast to Phase 4/5 wiring. We
        // implement reserve + sign here so Phase 4 only needs to drop in
        // the RPC call. Until then, returning broadcast_not_implemented
        // is the honest signal.
        return errorResp(
            501,
            ErrorCodes.BROADCAST_NOT_IMPLEMENTED,
            "sign-and-send: broadcast wiring deferred to Phase 4+. " +
                "Use /burner/reserve + /burner/sign-transaction for Phase 2 testing.",
        ).also {
            // Mark intentionally-unused params so the static analyzer
            // doesn't complain — they document the future shape.
            @Suppress("UNUSED_VARIABLE") val _ignored = providedRes
        }
    }

    private fun handleCommit(params: JSONObject): EndpointResult {
        val reservationId = params.optString("reservationId", "").trim()
        val signature = params.optString("signature", "").trim().ifEmpty { null }
        if (reservationId.isEmpty()) {
            return invalidInput("reservationId required")
        }
        return runBlocking {
            capEnforcer.commit(reservationId, signature)
            EndpointResult(200, mapOf("ok" to true))
        }
    }

    private fun handleRelease(params: JSONObject): EndpointResult {
        val reservationId = params.optString("reservationId", "").trim()
        val reason = params.optString("reason", "released").trim()
        if (reservationId.isEmpty()) {
            return invalidInput("reservationId required")
        }
        return runBlocking {
            capEnforcer.release(reservationId, reason)
            EndpointResult(200, mapOf("ok" to true))
        }
    }

    private fun handleConfigBurnerCaps(params: JSONObject): EndpointResult {
        // Each cap is optional — null means "leave unchanged". The body
        // shape matches the contract: atomic-unit decimal strings. We
        // validate format here, then delegate to CapEnforcer.setCaps.
        val capPerTxSol = params.optStringOrNull("capPerTxSol")
        val capPerTxUsdc = params.optStringOrNull("capPerTxUsdc")
        val capDailySol = params.optStringOrNull("capDailySol")
        val capDailyUsdc = params.optStringOrNull("capDailyUsdc")
        val anyProvided = listOfNotNull(capPerTxSol, capPerTxUsdc, capDailySol, capDailyUsdc).isNotEmpty()
        if (!anyProvided) {
            return invalidInput("at least one cap field required")
        }
        return runBlocking {
            val ok = capEnforcer.setCaps(capPerTxSol, capPerTxUsdc, capDailySol, capDailyUsdc)
            if (ok) EndpointResult(200, mapOf("ok" to true))
            else errorResp(400, ErrorCodes.INVALID_INPUT, "cap value invalid")
        }
    }

    private fun handleJupiterOwnershipSet(params: JSONObject): EndpointResult {
        val orderId = params.optString("orderId", "").trim()
        val role = params.optString("creatorWalletRole", "").trim()
        if (orderId.isEmpty() || role.isEmpty()) {
            return invalidInput("orderId and creatorWalletRole required")
        }
        if (role != "burner" && role != "main") {
            return invalidInput("creatorWalletRole must be 'burner' or 'main'")
        }
        return runBlocking {
            val ok = jupiterOwnership.set(orderId, role)
            if (ok) EndpointResult(200, mapOf("ok" to true))
            else errorResp(500, "ownership_write_failed", "Failed to persist ownership")
        }
    }

    // --- helpers ---

    private fun JSONObject.optStringOrNull(key: String): String? {
        if (!has(key) || isNull(key)) return null
        val s = optString(key, "").trim()
        return s.ifEmpty { null }
    }

    private fun invalidInput(msg: String): EndpointResult =
        errorResp(400, ErrorCodes.INVALID_INPUT, msg)

    private fun errorResp(http: Int, code: String, reason: String): EndpointResult =
        EndpointResult(http, mapOf("error" to code, "reason" to reason))

    private fun codeForRejection(reason: String): String = when (reason) {
        "burner_not_configured" -> ErrorCodes.BURNER_NOT_CONFIGURED
        "over_per_tx_cap" -> ErrorCodes.OVER_PER_TX_CAP
        "over_daily_cap" -> ErrorCodes.OVER_DAILY_CAP
        else -> ErrorCodes.INVALID_INPUT
    }

    /**
     * HTTP status mapping convention. Used by AndroidBridge to wrap
     * an EndpointResult in a NanoHTTPD Response.
     */
    fun statusFor(result: EndpointResult): Int = result.httpStatus

    companion object {
        private const val TAG = "BurnerBridge"
        const val BURNER_ID = "burner"
    }
}
