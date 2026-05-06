package com.seekerclaw.app.data.wallet

import android.content.Context

/**
 * EncryptedPrefsKeyVault — V1 KeyVault impl.
 *
 * Phase 1: stub. Phase 2 wires:
 *   - KeystoreHelper-backed AES-256-GCM encryption of the 64-byte secret
 *   - BouncyCastle Ed25519 signing inside the vault (key never leaves)
 *   - SolanaTxSigner pipeline (parse → sign canonical message bytes → insert signature)
 *   - ADB backup exclusion (data_extraction_rules.xml entry)
 *
 * The class signature, constructor shape, and method contract are pinned
 * here so Phase 2 can implement against this skeleton without reshaping
 * callers (BurnerBridgeEndpoints, BurnerWalletScreen).
 */
class EncryptedPrefsKeyVault(
    @Suppress("unused") private val context: Context,
) : KeyVault {

    override suspend fun store(id: String, expanded64: ByteArray) {
        throw NotImplementedError("EncryptedPrefsKeyVault.store — Phase 2")
    }

    override suspend fun signTransaction(id: String, txBytes: ByteArray): ByteArray {
        throw NotImplementedError("EncryptedPrefsKeyVault.signTransaction — Phase 2")
    }

    override suspend fun getPubkey(id: String): String? {
        // Phase 2: derive Ed25519 pubkey from stored 64-byte expanded key
        // (last 32 bytes of the expanded form == public key suffix).
        return null
    }

    override suspend fun wipe(id: String) {
        // Phase 2: remove the encrypted blob + zero any in-memory caches.
    }
}
