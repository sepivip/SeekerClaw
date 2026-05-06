package com.seekerclaw.app.data.wallet

/**
 * KeyVault — Android-held private key storage and signing surface (BAT-582).
 *
 * Design constraints:
 *   - Key bytes never leave Android. The interface intentionally has no
 *     `getKey()` — Node side cannot retrieve the secret under any code path.
 *   - Signing happens INSIDE the vault (BouncyCastle Ed25519 — see Phase 2).
 *   - Implementations: EncryptedPrefsKeyVault (V1, KeystoreHelper-backed).
 *     SeedVaultKeyVault (V2) plugs in by implementing this interface.
 *
 * Phase 1: interface only. Phase 2 fills in EncryptedPrefsKeyVault behavior
 * with BC Ed25519 + the SolanaTxSigner pipeline.
 */
interface KeyVault {

    /**
     * Store a 64-byte expanded Ed25519 secret key under the given id
     * (V1: id is always "burner"). Replaces any existing key.
     * Caller is KeyImporter — it normalizes 32-byte seeds and verifies
     * 64-byte pubkey-match before invoking this.
     */
    suspend fun store(id: String, expanded64: ByteArray)

    /**
     * Sign Solana transaction bytes per SolanaTxSigner semantics:
     *   - parses legacy/v0 transactions (compact-u16 / shortvec)
     *   - signs the canonical message bytes (v0 keeps the version byte)
     *   - inserts the 64-byte signature into the burner's signer slot
     *
     * Returns the full base64-encoded transaction with signature inserted,
     * or throws SigningException with a stable error code (see
     * BurnerBridgeEndpoints for the public error vocabulary).
     */
    suspend fun signTransaction(id: String, txBytes: ByteArray): ByteArray

    /**
     * Derive and return the 32-byte Ed25519 public key as a base58 string.
     * Returns null if no key is stored under [id].
     */
    suspend fun getPubkey(id: String): String?

    /**
     * Wipe the key + any cached metadata under [id]. Idempotent.
     * Callers (BurnerWalletScreen wipe button) MUST also clear the
     * spend ledger and Jupiter ownership map for the wiped wallet.
     */
    suspend fun wipe(id: String)
}

/**
 * Stable error vocabulary surfaced through bridge endpoint responses.
 * Keep in sync with DIAGNOSTICS.md.
 */
class SigningException(val code: String, message: String) : Exception(message)
