package com.seekerclaw.app.data.wallet

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
 * Phase 1: type signatures + error vocabulary. Phase 2 fills implementation
 * with BouncyCastle Ed25519.
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
    fun import(@Suppress("unused") input: String): Result {
        throw NotImplementedError("KeyImporter.import — Phase 2")
    }
}
