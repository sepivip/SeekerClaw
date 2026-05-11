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
     *
     * **Side effect contract (mandatory):** implementations MUST zero
     * (overwrite with `0x00`) every byte of the [expanded64] input
     * array before returning, regardless of whether persistence
     * succeeded or threw. Callers therefore MUST NOT reuse the buffer
     * after invoking [store] — its contents are guaranteed to be
     * destroyed. This is a security requirement: the only way to
     * minimize the in-memory lifetime of the secret bytes is to wipe
     * eagerly at the storage boundary, and callers can't retro-fit
     * that without a hook.
     *
     * Implementation note (V1 EncryptedPrefsKeyVault): the wipe runs
     * in the `finally` block of [store], so it persists across both
     * the success path and any KeystoreHelper / IO exception. Future
     * implementations (e.g. SeedVaultKeyVault in V2) MUST preserve this
     * contract or KeyImporter will leave plaintext secret bytes in
     * memory longer than necessary.
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
     *
     * **Side effects:** does NOT mutate the input [txBytes] array — the
     * signed payload is returned as a fresh ByteArray. The internally
     * loaded secret key bytes are zeroed before return. Callers may
     * safely reuse [txBytes] (in contrast to [store]'s [expanded64]).
     *
     * @param allowPartiallySigned BAT-582 v1.6 Phase 5d: when `true`,
     *   allows signing a multi-signer tx whose other required-signer
     *   slots are still empty. Used for x402 v2 where the facilitator
     *   co-signs server-side AFTER receiving the PAYMENT-SIGNATURE
     *   header — the wire tx that leaves the device is partially
     *   signed by design. When `false` (default — v1 behavior), all
     *   other signer slots must already contain a non-zero signature
     *   or the call rejects with `additional_signers_required`.
     */
    suspend fun signTransaction(id: String, txBytes: ByteArray, allowPartiallySigned: Boolean = false): ByteArray

    /**
     * Derive and return the 32-byte Ed25519 public key as a base58 string.
     * Returns null if no key is stored under [id].
     *
     * **Side effects:** none observable to the caller. The internally
     * loaded secret-key bytes are zeroed before return; the public key
     * itself is non-secret.
     */
    suspend fun getPubkey(id: String): String?

    /**
     * Wipe the key + any cached metadata under [id]. Idempotent.
     * Callers (BurnerWalletScreen wipe button) MUST also clear the
     * spend ledger and Jupiter ownership map for the wiped wallet.
     *
     * **Side effects:** removes the persisted key file (best-effort
     * overwrite-then-delete in the V1 impl). Returns even if the file
     * couldn't be deleted — wipe is best-effort by design; a stuck
     * file should not stop the user from re-importing.
     */
    suspend fun wipe(id: String)
}

/**
 * Stable error vocabulary surfaced through bridge endpoint responses.
 * Keep in sync with DIAGNOSTICS.md.
 */
class SigningException(val code: String, message: String) : Exception(message)
