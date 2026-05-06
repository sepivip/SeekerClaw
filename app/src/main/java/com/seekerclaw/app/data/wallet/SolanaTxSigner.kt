package com.seekerclaw.app.data.wallet

/**
 * SolanaTxSigner — parses legacy/v0 Solana transactions and inserts a
 * burner signature into the correct required-signer slot (BAT-582).
 *
 * **Wire format (CRITICAL):** Solana uses compact-u16 (shortvec) encoding
 * for vector lengths — signature count, account-key count, instruction
 * count. The parser MUST implement shortvec decoding (1–3 bytes, MSB
 * continuation bit), NOT assume fixed-byte counts.
 *
 * **Signed bytes:**
 *   - Legacy: serialized message bytes starting with the 3-byte header
 *   - v0:     serialized message bytes starting with the version byte
 *             `0x80 | version` — the version byte IS PART OF the signed
 *             payload, do NOT strip it.
 *
 * **Validation rules (Phase 2 implementation):**
 *   - Parse signature array (shortvec count + N × 64-byte signatures)
 *   - Detect legacy vs v0 by first byte after signature array
 *   - Read account-keys (shortvec K + K × 32-byte pubkeys)
 *   - Burner pubkey MUST be in first numRequiredSignatures account slots
 *     (rejected: "burner_not_required_signer")
 *   - V1 supports single-signer OR co-signed where all other signers
 *     have already populated their slots; reject otherwise
 *     ("additional_signers_required")
 *
 * Phase 1: type signatures pinned. Phase 2 fills implementation.
 *
 * Reference: existing solana.js shortvec helpers should be ported to
 * Kotlin (or shared via JNI bridge) with parity tests.
 */
object SolanaTxSigner {

    data class ParsedTx(
        val signatures: List<ByteArray>,
        val numRequiredSignatures: Int,
        val accountKeys: List<ByteArray>,
        /** Canonical message bytes — exactly what gets Ed25519-signed. */
        val canonicalMessageBytes: ByteArray,
        /** Where the canonical message starts within the original buffer. */
        val messageStartOffset: Int,
    )

    /**
     * Parse a serialized Solana transaction. Phase 2 implements; throws
     * `SigningException("unsupported_tx_format", ...)` on parse failure.
     */
    fun parse(@Suppress("unused") txBytes: ByteArray): ParsedTx {
        throw NotImplementedError("SolanaTxSigner.parse — Phase 2")
    }

    /**
     * Insert a 64-byte signature into the burner's signer slot in
     * [original] and return the updated transaction bytes. Preserves any
     * pre-existing signatures from co-signers.
     */
    fun insertSignature(
        @Suppress("unused") original: ByteArray,
        @Suppress("unused") parsed: ParsedTx,
        @Suppress("unused") burnerPubkey: ByteArray,
        @Suppress("unused") signature: ByteArray,
    ): ByteArray {
        throw NotImplementedError("SolanaTxSigner.insertSignature — Phase 2")
    }

    /** Compact-u16 (shortvec) decoder — Phase 2; parity test against solana.js. */
    fun decodeShortvec(@Suppress("unused") buf: ByteArray, @Suppress("unused") offset: Int): Pair<Int, Int> {
        throw NotImplementedError("SolanaTxSigner.decodeShortvec — Phase 2")
    }
}
