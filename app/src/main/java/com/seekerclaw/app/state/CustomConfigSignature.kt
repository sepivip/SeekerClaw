package com.seekerclaw.app.state

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import java.security.MessageDigest
import java.util.Locale

/**
 * Deterministic signature for the "Custom" provider configuration
 * tuple (model | baseUrl | format | sortedHeaderKeys) — BAT-549
 * Commit 3d. Mirrors the Node-side algorithm in
 * `app/src/main/assets/nodejs-project/custom-config-signature.js`.
 * Dual-side equivalence is pinned by [CustomConfigSignatureTest] and
 * its Node counterpart in `tests/nodejs-project/custom-config-signature.test.js`.
 *
 * Used by [com.seekerclaw.app.config.ConfigManager.saveConfig] to
 * detect when a user has changed their Custom gateway. When the new
 * signature differs from the persisted [RuntimeState.customConfigSignature],
 * the per-Custom advanced override [RuntimeState.customEchoReasoning] is
 * reset to `false` (user must re-enable on the new gateway because
 * echo behavior is gateway-specific).
 *
 * ## What's IN the signature
 *  - customModel (trimmed)
 *  - customBaseUrl (trimmed)
 *  - customFormat (trimmed)
 *  - sorted lowercased header KEYS (trimmed; non-empty; not
 *    `__proto__` / `constructor` / `prototype`)
 *
 * ## What's NOT in the signature (and why)
 *  - apiKey: rotation is common; hashing would falsely flag every
 *    key change as a config change and reset the override.
 *  - header VALUES: may carry secret material; hashing them would
 *    persist a leakable digest of secrets on disk.
 *
 * ## Output
 *  - Full SHA-256 hex (64 lowercase chars) when ANY of model/baseUrl/
 *    format are non-blank OR parsed headers have at least one valid key
 *  - `null` when ALL inputs are blank/empty (user not on Custom)
 */
object CustomConfigSignature {

    /**
     * Compute the BAT-549 customConfigSignature for the provided
     * Custom-config inputs. Returns `null` when the user has no
     * Custom config to track, otherwise a 64-char lowercase hex
     * SHA-256 digest.
     *
     * [customHeaders] is the raw JSON string as persisted by
     * [com.seekerclaw.app.config.ConfigManager] (e.g.,
     * `{"X-API-Key":"sk-..."}` ). Malformed JSON is treated as
     * "no headers" rather than throwing — the signature is a
     * best-effort change-detector, not a config validator.
     */
    fun compute(
        customModel: String,
        customBaseUrl: String,
        customFormat: String,
        customHeaders: String,
    ): String? {
        val model = customModel.trim()
        val baseUrl = customBaseUrl.trim()
        val format = customFormat.trim()
        val headerKeys = sortedHeaderKeys(customHeaders)

        if (model.isEmpty() && baseUrl.isEmpty() && format.isEmpty() && headerKeys.isEmpty()) {
            return null
        }

        // Canonical input: stable across Kotlin and Node implementations.
        // Pipe + comma separators chosen because they're not valid
        // characters in HTTP token names, eliminating any inputs-
        // interchange ambiguity.
        val canonical = "$model|$baseUrl|$format|${headerKeys.joinToString(",")}"
        return sha256Hex(canonical)
    }

    /**
     * Parse the customHeaders JSON string and return sorted, lowercased,
     * de-duplicated header keys. Empty list for invalid/empty input.
     * Mirrors `_sortedHeaderKeys` in the Node module.
     *
     * Internal so the dual-side test can pin the parser semantic
     * directly without going through the full hash.
     *
     * Uses [kotlinx.serialization.json.Json] (not `org.json.JSONObject`)
     * because Android's `org.json` is provided as a stub JAR in JVM
     * unit-test classpath where `JSONObject.keys()` returns null —
     * which would NPE every header-parsing test. kotlinx-serialization
     * works the same in JVM unit tests and on-device.
     */
    internal fun sortedHeaderKeys(customHeaders: String): List<String> {
        val trimmed = customHeaders.trim()
        if (trimmed.isEmpty()) return emptyList()
        val parsed = try {
            Json.parseToJsonElement(trimmed)
        } catch (_: Exception) {
            return emptyList()
        }
        val obj: JsonObject = try {
            parsed.jsonObject
        } catch (_: Exception) {
            // Top-level wasn't an object (array, primitive, null) — treat
            // as no headers, mirroring the Node side's "non-object" guard.
            // R10 R1 Copilot: `JsonElement.jsonObject` actually throws
            // IllegalStateException (via `error(...)`), not
            // IllegalArgumentException. Catch broadly so any non-object
            // shape resolves to empty rather than crashing the signature
            // computation. The signature is a best-effort change-
            // detector — never let it bubble exceptions to the saveConfig
            // hot path.
            return emptyList()
        }
        val seen = LinkedHashSet<String>()
        for (key in obj.keys) {
            // R17 R1 Copilot: use Locale.ROOT so Turkish-locale devices
            // don't produce a different signature than other devices and
            // the Node side. Kotlin's `String.lowercase()` defaults to
            // the device locale, which would lower-case "I" → "ı"
            // (dotless) on Turkish locale, diverging from Node's
            // `String.toLowerCase()` (which is locale-invariant). The
            // mismatch would silently flag a config "change" and reset
            // the override every time a Turkish-locale user looked at
            // their gateway, even though nothing actually changed.
            val k = key.trim().lowercase(Locale.ROOT)
            if (k.isEmpty()) continue
            if (k == "__proto__" || k == "constructor" || k == "prototype") continue
            seen.add(k)
        }
        return seen.sorted()
    }

    private fun sha256Hex(input: String): String {
        val bytes = MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.UTF_8))
        val sb = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xff
            sb.append(HEX_CHARS[v ushr 4])
            sb.append(HEX_CHARS[v and 0x0f])
        }
        return sb.toString()
    }

    private val HEX_CHARS = "0123456789abcdef".toCharArray()
}
