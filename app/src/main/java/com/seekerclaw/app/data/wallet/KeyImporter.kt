package com.seekerclaw.app.data.wallet

import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import java.util.Arrays

/**
 * KeyImporter — parses user-pasted private keys and normalizes them to the
 * canonical 64-byte expanded Ed25519 secret form (BAT-582).
 *
 * **Accepted input formats (V1):**
 *   - Base58 string (Phantom export)
 *   - JSON byte array `[1, 2, 3, ...]` (Solana CLI export)
 *
 * **Length cases:**
 *   - **32 bytes** → treat as Ed25519 seed; expand to 64-byte secret
 *     (standard Ed25519 derivation: seed || derived_pubkey).
 *   - **64 bytes** → expanded form (32-byte seed prefix + 32-byte pubkey
 *     suffix). Verify: derive pubkey from seed prefix, assert it equals
 *     the trailing 32 bytes. Reject (`invalid_keypair_pubkey_mismatch`)
 *     if not — this catches Phantom-export-style corruption.
 *   - Any other length → reject (`invalid_key_length`).
 *
 * Output: canonical 64-byte expanded form, ready for KeyVault.store().
 *
 * **Heap-residence contract (R1 follow-up):** every intermediate buffer
 * holding seed material is zeroed in a `finally` block before this
 * function returns, regardless of which code path executed. The only
 * key bytes that outlive the call are the [Result.Ok.expanded64] copy
 * the caller receives — and the caller (`KeyVault.store`) is bound by
 * its own contract to wipe that buffer too. Net effect: the seed lives
 * in memory only long enough for BC to derive the pubkey + for the
 * caller to encrypt-and-persist, then it's gone.
 *
 * Phase 2: implementation — BC Ed25519 derivation.
 */
object KeyImporter {

    /**
     * BAT-582 R11: paste-DoS defense (same-class sweep companion to
     * [WalletAmountFormat.MAX_DECIMAL_INPUT_LEN]). Legitimate inputs
     * are ~88 chars (base58 of 64 raw bytes) or ~256 chars (JSON byte
     * array `[255,255,...]`). 1024 is a generous ceiling that still
     * bounds the worst-case base58 decode (which is O(n²)).
     */
    internal const val MAX_KEY_INPUT_LEN = 1024

    sealed class Result {
        data class Ok(val expanded64: ByteArray, val pubkey: ByteArray) : Result()
        data class Err(val code: String, val message: String) : Result()
    }

    /**
     * Parse + normalize. Returns Ok with canonical 64-byte expanded form
     * and derived 32-byte pubkey, or Err with a stable error code.
     *
     * Stable error codes (mirrored in DIAGNOSTICS.md):
     *   - "invalid_key_length"
     *   - "invalid_key_format"
     *   - "invalid_keypair_pubkey_mismatch"
     *
     * The returned [Result.Ok.expanded64] is a fresh copy — the caller
     * owns it and must wipe it after use (KeyVault.store does this in
     * its own `finally`). Every internal buffer holding seed material
     * (the parsed input, the `seed` slice, the original `bytes`) is
     * zeroed before return on every path.
     */
    fun import(input: String): Result {
        // BAT-582 R11: same-class sweep companion to WalletAmountFormat's
        // input-length cap. A user-pasted private key is ALWAYS small —
        // 64 raw bytes serialized as base58 is ~88 chars; as a JSON byte
        // array it's at most ~256 chars (3-digit + comma per byte).
        // Reject anything wildly larger than the legitimate ceiling so a
        // multi-MB paste can't DoS the Settings UI thread on `parseBytes`
        // (base58 decoding is O(n²) on the input length; JSON array
        // parsing allocates one Int per comma).
        //
        // 1024 is generous (~5x the JSON-array ceiling) but small enough
        // that base58 decode of even an adversarial input completes in
        // single-digit microseconds.
        if (input.length > MAX_KEY_INPUT_LEN) {
            return Result.Err("invalid_key_length", "Input too large (max $MAX_KEY_INPUT_LEN chars)")
        }
        val trimmed = input.trim()
        if (trimmed.isEmpty()) {
            return Result.Err("invalid_key_format", "Empty input")
        }

        val bytes = parseBytes(trimmed)
            ?: return Result.Err("invalid_key_format", "Could not parse as base58 or JSON byte array")

        try {
            return when (bytes.size) {
                32 -> {
                    val pubkey = derivePubkey(bytes)
                    val expanded = ByteArray(64)
                    System.arraycopy(bytes, 0, expanded, 0, 32)
                    System.arraycopy(pubkey, 0, expanded, 32, 32)
                    Result.Ok(expanded, pubkey)
                }
                64 -> {
                    // `seed` holds the 32-byte secret prefix; wipe in finally.
                    // `storedPubkey` is technically non-secret (just the
                    // declared public key) but we wipe it for consistency
                    // with the seed-handling pattern — saves a future
                    // reviewer from having to re-litigate which slices
                    // are sensitive. The output [Result.Ok.expanded64] is
                    // a fresh copy via [bytes.copyOf]; the caller (KeyVault
                    // .store) wipes that buffer per its contract.
                    val seed = bytes.copyOfRange(0, 32)
                    val storedPubkey = bytes.copyOfRange(32, 64)
                    try {
                        val derivedPubkey = derivePubkey(seed)
                        if (!derivedPubkey.contentEquals(storedPubkey)) {
                            return Result.Err(
                                "invalid_keypair_pubkey_mismatch",
                                "Derived public key does not match the trailing 32 bytes",
                            )
                        }
                        Result.Ok(bytes.copyOf(), derivedPubkey)
                    } finally {
                        Arrays.fill(seed, 0.toByte())
                        Arrays.fill(storedPubkey, 0.toByte())
                    }
                }
                else -> Result.Err(
                    "invalid_key_length",
                    "Expected 32 or 64 bytes, got ${bytes.size}",
                )
            }
        } finally {
            // Wipe the parsed input buffer regardless of which branch
            // ran. In the 32-byte path, `bytes` IS the seed and was
            // already copied into `expanded`. In the 64-byte path,
            // `bytes` was sliced into `seed`+`storedPubkey` (both wiped
            // in the inner finally) and then `bytes.copyOf()` made a
            // fresh return buffer — so wiping `bytes` here is safe.
            // In the wrong-length path, `bytes` may still be small but
            // we wipe it anyway for uniform handling.
            Arrays.fill(bytes, 0.toByte())
        }
    }

    /**
     * Try parsing [input] as either a JSON byte array `[1,2,3,...]` or a
     * base58 string. Returns the decoded bytes or null if neither format
     * applies.
     */
    private fun parseBytes(input: String): ByteArray? {
        // JSON byte array: starts with '[', ends with ']'
        if (input.startsWith("[") && input.endsWith("]")) {
            val inner = input.substring(1, input.length - 1).trim()
            if (inner.isEmpty()) return null
            val parts = inner.split(",")
            val out = ByteArray(parts.size)
            // Wipe `out` on every failure path — pre-fix the early-return
            // branches (`toIntOrNull` returning null, range check failing)
            // could leave some bytes already filled into `out` from earlier
            // iterations. Even though the failure-mode input is malformed
            // (parser rejected it), the partial bytes could be the prefix
            // of a real key on a typo'd paste. Caller treats null as "not a
            // key" and never attempts to wipe — so the wipe is OUR
            // responsibility before returning the null.
            var ok = false
            try {
                for (i in parts.indices) {
                    val n = parts[i].trim().toIntOrNull() ?: return null
                    if (n < 0 || n > 255) return null
                    out[i] = n.toByte()
                }
                ok = true
                return out
            } finally {
                if (!ok) Arrays.fill(out, 0.toByte())
            }
        }
        // Base58
        return try {
            org.sol4k.Base58.decode(input)
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Derive the 32-byte Ed25519 public key from a 32-byte seed using
     * BouncyCastle. Standard Ed25519 derivation: SHA-512(seed)[0..32]
     * with bit-clamp, then point multiplication by base — BC handles
     * all of this internally via Ed25519PrivateKeyParameters.
     */
    internal fun derivePubkey(seed32: ByteArray): ByteArray {
        require(seed32.size == 32) { "seed must be 32 bytes" }
        val priv = Ed25519PrivateKeyParameters(seed32, 0)
        val pub: Ed25519PublicKeyParameters = priv.generatePublicKey()
        val out = ByteArray(32)
        pub.encode(out, 0)
        return out
    }
}
