package com.seekerclaw.app.bridge

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * BAT-1409 P1-D (contract v3.2) — who may become the owner through the bridge's
 * `/config/save-owner` route. Called only from that route: Settings keeps saving the owner
 * directly (`ConfigManager.saveOwnerIdToFile`), which a source-guard test pins.
 *
 * - The channel must be `telegram` or `discord` (else 400) and equal to the channel `:node`
 *   booted with (else 409).
 * - "Set" means the `owner_ids` entry for that channel is non-blank. The same id is an idempotent
 *   200 with no write; a different id is a 409. An `owner_ids` that cannot be parsed refuses the
 *   claim (the record is not trustworthy, so it is never overwritten from the bridge).
 *
 * Guardrail-level: `owner_ids` is protected from the agent's file tools, js_eval and shell
 * (P1-E/F/G); real integrity is Phase 2 (P2-J).
 */
object OwnerClaimPolicy {

    val CHANNELS = setOf("telegram", "discord")

    sealed class Decision {
        /** No owner set for the channel: persist the claim. */
        object Save : Decision()

        /** The same owner is already set: 200, nothing written. */
        object AlreadyOwner : Decision()

        /** Unknown channel: 400. */
        data class BadChannel(val channel: String) : Decision()

        /** Not the channel this `:node` booted with: 409. */
        data class InactiveChannel(val channel: String, val bootChannel: String) : Decision()

        /** A different owner is already set: 409. */
        object DifferentOwner : Decision()

        /** `owner_ids` exists but cannot be parsed: refused, nothing written. */
        object Unreadable : Decision()
    }

    /** [ownerFileJson] is the `owner_ids` text, or null when the file does not exist. */
    fun decide(ownerFileJson: String?, ownerId: String, requestedChannel: String, bootChannel: String): Decision {
        if (requestedChannel !in CHANNELS) return Decision.BadChannel(requestedChannel)
        if (requestedChannel != bootChannel.trim().lowercase()) return Decision.InactiveChannel(requestedChannel, bootChannel)
        val current = currentOwner(ownerFileJson, requestedChannel) ?: return Decision.Unreadable
        if (current.isBlank()) return Decision.Save
        return if (current == ownerId) Decision.AlreadyOwner else Decision.DifferentOwner
    }

    /**
     * The bridge's reply to [decision]: HTTP status and JSON body. [saved] is whether persisting a
     * [Decision.Save] succeeded and is ignored for every other decision. A refusal carries a
     * `code` that `message-handler.js` (`OWNER_CLAIM_REFUSED`) reads as "not the owner"; a success
     * or a failed save carries none, so Node keeps the claim for this run.
     */
    fun response(decision: Decision, saved: Boolean = true): Pair<Int, Map<String, Any>> = when (decision) {
        is Decision.BadChannel -> 400 to mapOf("error" to "unknown channel", "code" to "bad_channel")
        is Decision.InactiveChannel -> 409 to mapOf("error" to "channel changed; restart required", "code" to "inactive_channel")
        Decision.DifferentOwner -> 409 to mapOf("error" to "owner already set", "code" to "owner_already_set")
        Decision.Unreadable -> 500 to mapOf("error" to "Owner record unreadable", "code" to "owner_unreadable")
        Decision.AlreadyOwner -> 200 to mapOf("success" to true)
        Decision.Save -> if (saved) 200 to mapOf("success" to true) else 500 to mapOf("error" to "Failed to persist owner ID")
    }

    /**
     * True when the SharedPreferences owner [prefsOwner] is set and differs from the [claimed] id.
     * That record is re-derived from the file on every saveConfig, so it is compared and logged
     * only (P1-D), never a lock-out.
     */
    fun prefsMismatch(prefsOwner: String, claimed: String): Boolean = prefsOwner.isNotBlank() && prefsOwner != claimed

    /**
     * The owner for [channel] in [ownerFileJson]: "" when the file or the entry is absent, blank or
     * null; a number reads as its text (as the loader's `optString` does); null when the file is not
     * a JSON object or the entry is not a plain value.
     */
    fun currentOwner(ownerFileJson: String?, channel: String): String? {
        if (ownerFileJson == null) return ""
        val root = try {
            Json.parseToJsonElement(ownerFileJson)
        } catch (_: Exception) {
            return null
        }
        if (root !is JsonObject) return null
        return when (val v = root[channel]) {
            null, JsonNull -> ""
            is JsonPrimitive -> v.content.trim()
            else -> null
        }
    }
}
