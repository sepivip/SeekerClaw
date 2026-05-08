package com.seekerclaw.app.data.wallet

import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters

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
 * Phase 2: implementation — BC Ed25519 derivation.
 */
object KeyImporter {

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
     */
    fun import(input: String): Result {
        val trimmed = input.trim()
        if (trimmed.isEmpty()) {
            return Result.Err("invalid_key_format", "Empty input")
        }

        val bytes = parseBytes(trimmed)
            ?: return Result.Err("invalid_key_format", "Could not parse as base58 or JSON byte array")

        return when (bytes.size) {
            32 -> {
                val pubkey = derivePubkey(bytes)
                val expanded = ByteArray(64)
                System.arraycopy(bytes, 0, expanded, 0, 32)
                System.arraycopy(pubkey, 0, expanded, 32, 32)
                Result.Ok(expanded, pubkey)
            }
            64 -> {
                val seed = bytes.copyOfRange(0, 32)
                val storedPubkey = bytes.copyOfRange(32, 64)
                val derivedPubkey = derivePubkey(seed)
                if (!derivedPubkey.contentEquals(storedPubkey)) {
                    return Result.Err(
                        "invalid_keypair_pubkey_mismatch",
                        "Derived public key does not match the trailing 32 bytes",
                    )
                }
                Result.Ok(bytes.copyOf(), derivedPubkey)
            }
            else -> Result.Err(
                "invalid_key_length",
                "Expected 32 or 64 bytes, got ${bytes.size}",
            )
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
            for (i in parts.indices) {
                val n = parts[i].trim().toIntOrNull() ?: return null
                if (n < 0 || n > 255) return null
                out[i] = n.toByte()
            }
            return out
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
