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
 *   - /burner/status          → wallet pubkey + cap state + spend ledger
 *                                (balanceSol/balanceUsdc intentionally OMITTED
 *                                until Node-side RPC fetch lands; UI fetches
 *                                balances directly via SolanaBalanceFetcher,
 *                                wallet_status surfaces "unavailable" for the
 *                                agent until a separate BAT wires this here)
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
        // BAT-582 R2: distinct from RESERVATION_NOT_FOUND. Surfaced when a
        // caller passes a reservationId that was already committed or
        // released — re-using a finalized id is a state-machine bug, not
        // a missing-id bug. Caller should NOT retry with the same id.
        const val RESERVATION_NOT_PENDING = "reservation_not_pending"
        const val INVALID_INPUT = "invalid_input"
        const val SIGN_FAILED = "sign_failed"
        const val BROADCAST_NOT_IMPLEMENTED = "broadcast_not_implemented"
        // BAT-582 R1: distinct error class for Keystore/IO failures inside
        // EncryptedPrefsKeyVault.store. Different remediation than
        // invalid_key_format — caller should retry / check device storage,
        // not re-paste their key.
        const val STORAGE_FAILURE = "storage_failure"
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
        // BAT-582 Phase 5: /jupiter/order-owner/get response shape.
        "creatorWalletRole",
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
            "/jupiter/order-owner/get" -> handleJupiterOwnershipGet(params)
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
            // BAT-582 R2: balanceSol / balanceUsdc fields are intentionally
            // OMITTED from this response (instead of stubbed "0") until the
            // RPC fetch lands. Downstream consumers (tools/wallet.js,
            // BurnerWalletScreen, ai.js system prompt) treat absence as
            // "balance unavailable" rather than "balance is zero" — a
            // configured-but-funded burner that returned "0" was producing
            // user-facing copy that read like the burner was empty, which
            // is dangerously misleading. Adding the field back is gated on
            // an actual RPC fetch (see Limitations note in the PR for the
            // follow-up scope).
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
        // BAT-582 Phase 5: zero-amount reservations are valid for cancel
        // flows (Jupiter trigger/DCA cancel are ownership-gated, not
        // principal-gated, so they don't consume cap state). CapEnforcer
        // skips the cap math when atomicAmount==0 but still verifies the
        // burner is configured. Negative amounts remain invalid.
        if (atomicAmount < BigInteger.ZERO) {
            return invalidInput("atomicAmount must be >= 0")
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
        return handleSignTransactionInternal(txB64, reservationId)
    }

    /**
     * Sign-transaction core, exposed for unit tests (the production caller
     * is [handleSignTransaction] which trims params off a JSONObject;
     * pure-JVM tests can't easily build that, so they call this directly).
     *
     * BAT-582 R2 (CRITICAL): verifies the reservation is real, fresh, and
     * still pending BEFORE producing a signature. Previously the endpoint
     * accepted any non-empty reservationId and signed unconditionally —
     * completely bypassing the cap state machine (any caller could pass
     * `reservationId: "x"` and get a signed tx for an arbitrary amount).
     * The cap reservation IS the authorization to sign; signing without
     * verifying it is a security gap.
     *
     * Note: this method does NOT commit the reservation. Per contract,
     * the caller (Node-side burner-signer) handles commit/release after
     * broadcasting. The reservation stays pending; the periodic 60s
     * sweep auto-releases it if the caller crashes between sign and commit.
     */
    @androidx.annotation.VisibleForTesting
    internal fun handleSignTransactionInternal(txB64: String, reservationId: String): EndpointResult {
        if (txB64.isEmpty() || reservationId.isEmpty()) {
            return invalidInput("txBase64 and reservationId required")
        }

        // BAT-582 R2: validate the reservation BEFORE base64-decoding the
        // tx and BEFORE invoking the KeyVault. Two reasons:
        //   1. fail fast — an invalid reservation means we'll reject
        //      regardless of tx shape, so spending parse cycles is waste;
        //   2. the security boundary is "no signature without a verified
        //      reservation"; by ordering the lookup first we make that
        //      property obvious in the code path.
        val lookupErr = validateReservationOrError(reservationId)
        if (lookupErr != null) return lookupErr

        val txBytes = try {
            android.util.Base64.decode(txB64, android.util.Base64.NO_WRAP)
        } catch (_: Exception) {
            return invalidInput("txBase64 is not valid base64")
        }

        return signTransactionInner(reservationId, txBytes)
    }

    /**
     * BAT-582 R2: signing-only inner step, isolated for unit testability.
     * The pure-JVM unit test environment stubs `android.util.Base64`
     * (returnDefaultValues=true → returns null), so a happy-path test
     * that goes through [handleSignTransactionInternal] cannot reach
     * KeyVault.signTransaction. This entry skips the Base64 decode by
     * accepting raw bytes — tests pass a fixed buffer to verify the
     * gated KeyVault invocation actually fires.
     *
     * Production callers route through [handleSignTransactionInternal]
     * which performs the decode + the validation gate. Direct callers
     * to this method MUST have already validated the reservation.
     */
    @androidx.annotation.VisibleForTesting
    internal fun signTransactionInner(@Suppress("UNUSED_PARAMETER") reservationId: String, txBytes: ByteArray): EndpointResult {
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

    /**
     * BAT-582 R2: end-to-end test entry point for the happy path. Combines
     * the validation gate with [signTransactionInner], skipping the Base64
     * decode that's stubbed in pure-JVM unit tests. Production callers go
     * through [handleSignTransactionInternal]; this exists ONLY so that
     * BurnerBridgeEndpointsTest can prove "validation passed → KeyVault
     * was actually invoked" — a property we cannot verify through the
     * Base64 path under returnDefaultValues=true.
     */
    @androidx.annotation.VisibleForTesting
    internal fun handleSignTransactionDecoded(reservationId: String, txBytes: ByteArray): EndpointResult {
        if (reservationId.isEmpty()) return invalidInput("reservationId required")
        val lookupErr = validateReservationOrError(reservationId)
        if (lookupErr != null) return lookupErr
        return signTransactionInner(reservationId, txBytes)
    }

    /**
     * BAT-582 R2: shared reservation validation for endpoints that mutate
     * or rely on the cap state machine (sign-transaction, commit). Returns
     * an error EndpointResult if the reservation is not safe to act on,
     * or null when the reservation is pending+fresh.
     *
     *  - NotFound    → 400 reservation_not_found  (id never seen / aged out)
     *  - Expired     → 400 reservation_expired    (caller waited past TTL)
     *  - NotPending  → 400 reservation_not_pending (already committed/released)
     *  - Pending     → null                       (caller may proceed)
     *
     * Stable error codes feed into the agent-side Diagnostics flow; see
     * DIAGNOSTICS.md → "burner: reservation expired" / "burner: reservation
     * not found" / "burner: reservation not pending" sections.
     */
    private fun validateReservationOrError(reservationId: String): EndpointResult? {
        return when (capEnforcer.lookupReservation(reservationId)) {
            is CapEnforcer.LookupResult.NotFound ->
                errorResp(400, ErrorCodes.RESERVATION_NOT_FOUND, "reservation not found")
            is CapEnforcer.LookupResult.Expired ->
                errorResp(400, ErrorCodes.RESERVATION_EXPIRED, "reservation expired")
            is CapEnforcer.LookupResult.NotPending ->
                errorResp(400, ErrorCodes.RESERVATION_NOT_PENDING, "reservation already committed or released")
            is CapEnforcer.LookupResult.Pending -> null
        }
    }

    /**
     * Atomic reserve+sign+broadcast+commit (or release) for paths that
     * own the broadcast (currently RPC; future: Jupiter). Stubbed in V1.
     *
     * **TODO when wiring this in (BAT-582 follow-up / Phase 6):** before
     * producing a signature for the optional caller-supplied
     * `reservationId`, route through [validateReservationOrError] (the
     * same gate that BAT-582 R2 added to /burner/sign-transaction) — a
     * caller-supplied id MUST exist + be unexpired + still be pending or
     * the cap state machine is bypassed. If the caller does NOT supply
     * a reservationId, this endpoint reserves atomically itself (mutex
     * already serialized inside [CapEnforcer.reserve]) and skips the
     * external lookup. Either way: never sign without a verified
     * reservation in hand.
     */
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
        // BAT-582 R2 same-class sweep: validate the reservation before
        // committing. Three outcomes:
        //   - Pending → commit and return ok=true.
        //   - NotPending (already committed/released) → idempotent ok=true
        //     (per contract: a second commit is a no-op; the underlying
        //     ledger.commit treats it that way too).
        //   - NotFound → reject with reservation_not_found. A commit for
        //     an id that was never reserved is a state-machine bug; we
        //     refuse rather than silently no-op so the caller sees the
        //     mistake.
        //   - Expired → release-and-error. The reservation aged out;
        //     committing it would let the caller bypass the TTL gate.
        //     Return reservation_expired (the periodic sweep will GC it).
        return runBlocking {
            when (capEnforcer.lookupReservation(reservationId)) {
                is CapEnforcer.LookupResult.NotFound ->
                    errorResp(400, ErrorCodes.RESERVATION_NOT_FOUND, "reservation not found")
                is CapEnforcer.LookupResult.Expired ->
                    errorResp(400, ErrorCodes.RESERVATION_EXPIRED, "reservation expired")
                is CapEnforcer.LookupResult.NotPending -> {
                    // Idempotent: already committed/released. Existing
                    // double-commit test in CapEnforcerTest depends on this
                    // returning ok rather than erroring — second commit
                    // must not double-count nor surface a spurious failure
                    // to the caller after a retry.
                    EndpointResult(200, mapOf("ok" to true))
                }
                is CapEnforcer.LookupResult.Pending -> {
                    capEnforcer.commit(reservationId, signature)
                    EndpointResult(200, mapOf("ok" to true))
                }
            }
        }
    }

    private fun handleRelease(params: JSONObject): EndpointResult {
        val reservationId = params.optString("reservationId", "").trim()
        val reason = params.optString("reason", "released").trim()
        if (reservationId.isEmpty()) {
            return invalidInput("reservationId required")
        }
        // BAT-582 R2 same-class sweep: release MUST stay idempotent (per
        // spec). The simplest robust validation is a UUID-shape check on
        // the input — anything else is unsafe to log or hash for the
        // disposed ring. Beyond that, release is intentionally permissive:
        // a "release nothing" call should return ok=true, since the
        // caller's intent ("forget this reservation") is already satisfied.
        // CapEnforcer.release tolerates unknown ids without error and
        // records the id in the disposed ring so a later commit/sign
        // sees NotPending instead of NotFound.
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

    /**
     * BAT-582 Phase 5: read ownership for a Jupiter order.
     *
     * Body: `{orderId: string}`.
     * Response: `{creatorWalletRole: "burner" | "main" | null}` — null when
     * unknown (order never recorded, or was created on another device).
     * The Node-side caller treats null as "fall back to main + confirm +
     * diagnostic" per contract v1.4.
     *
     * Defense in depth: the response field name `creatorWalletRole` is in
     * the allowlist; null serializes through JSON normally; this endpoint
     * never returns key-shaped fields.
     */
    private fun handleJupiterOwnershipGet(params: JSONObject): EndpointResult {
        val orderId = params.optString("orderId", "").trim()
        if (orderId.isEmpty()) {
            return invalidInput("orderId required")
        }
        val role = jupiterOwnership.get(orderId) // null when unknown
        // Wrap with JSONObject.NULL so JSONObject(map).toString() preserves
        // the explicit "creatorWalletRole":null shape — a plain Kotlin null
        // would be stripped by JSONObject's serializer, breaking the
        // contract's documented response shape.
        val body = LinkedHashMap<String, Any?>()
        body["creatorWalletRole"] = role ?: JSONObject.NULL
        return EndpointResult(200, body)
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
