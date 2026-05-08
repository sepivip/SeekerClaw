package com.seekerclaw.app.data.wallet

/**
 * SolanaTxSigner — parses legacy/v0 Solana transactions and inserts a
 * burner signature into the correct required-signer slot (BAT-582).
 *
 * **Wire format (CRITICAL):** Solana uses compact-u16 (shortvec) encoding
 * for vector lengths — signature count, account-key count, instruction
 * count. The parser implements shortvec decoding (1–3 bytes, MSB
 * continuation bit), NOT fixed-byte counts.
 *
 * **Signed bytes:**
 *   - Legacy: serialized message bytes starting with the 3-byte header
 *   - v0:     serialized message bytes starting with the version byte
 *             `0x80 | version` — the version byte IS PART OF the signed
 *             payload, NOT stripped.
 *
 * Phase 2 implementation. Reference: existing solana.js shortvec
 * helpers (lines ~735-747) — Kotlin port + parity test.
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
        /** Where the leading signature array starts (always 0). Kept for clarity. */
        val signaturesStartOffset: Int = 0,
        /** Where each individual signature byte-slot begins, inside the signature array. */
        val signatureSlotOffsets: List<Int>,
    )

    /**
     * Parse a serialized Solana transaction. Throws
     * `SigningException("unsupported_tx_format", ...)` on parse failure
     * and `SigningException("bogus_shortvec", ...)` for malformed
     * shortvec encodings.
     */
    fun parse(txBytes: ByteArray): ParsedTx {
        if (txBytes.isEmpty()) {
            throw SigningException("unsupported_tx_format", "Empty transaction bytes")
        }

        // 1. Read leading signature array: shortvec(N) followed by N x 64-byte sigs.
        val (numSigs, afterSigCountOffset) = decodeShortvec(txBytes, 0)
        if (numSigs < 0 || numSigs > 256) {
            // Solana txs realistically have ≤ a handful of signers.
            throw SigningException("unsupported_tx_format", "Unreasonable signature count: $numSigs")
        }
        val sigSlotOffsets = ArrayList<Int>(numSigs)
        var cursor = afterSigCountOffset
        val signatures = ArrayList<ByteArray>(numSigs)
        for (i in 0 until numSigs) {
            if (cursor + 64 > txBytes.size) {
                throw SigningException("unsupported_tx_format", "Signature array truncated")
            }
            sigSlotOffsets.add(cursor)
            signatures.add(txBytes.copyOfRange(cursor, cursor + 64))
            cursor += 64
        }

        // 2. Detect legacy vs v0 by the first byte of the message portion.
        // v0: bit 7 set (0x80 | version). Legacy: bit 7 clear.
        val messageStart = cursor
        if (messageStart >= txBytes.size) {
            throw SigningException("unsupported_tx_format", "Missing message body after signatures")
        }
        val firstMsgByte = txBytes[messageStart].toInt() and 0xFF
        val isV0 = (firstMsgByte and 0x80) != 0
        val headerStart: Int
        if (isV0) {
            // The version byte is part of the canonical message bytes.
            // Header begins at messageStart + 1.
            val version = firstMsgByte and 0x7F
            if (version != 0) {
                throw SigningException(
                    "unsupported_tx_format",
                    "Unsupported transaction version: $version",
                )
            }
            headerStart = messageStart + 1
        } else {
            headerStart = messageStart
        }

        // 3. Read message header (3 bytes: numRequiredSignatures,
        //    numReadonlySignedAccounts, numReadonlyUnsignedAccounts).
        if (headerStart + 3 > txBytes.size) {
            throw SigningException("unsupported_tx_format", "Truncated message header")
        }
        val numRequiredSignatures = txBytes[headerStart].toInt() and 0xFF
        // (header bytes 2 and 3 unused at this layer; sol4k/Node need them
        // for instruction parsing — not needed for our signer slot logic.)

        if (numRequiredSignatures != numSigs) {
            // Wire format invariant: signature array length must equal
            // numRequiredSignatures from the header.
            throw SigningException(
                "unsupported_tx_format",
                "Signature array length ($numSigs) != numRequiredSignatures ($numRequiredSignatures)",
            )
        }

        // 4. Read account-keys vector: shortvec(K) followed by K x 32-byte pubkeys.
        val accountKeysCountStart = headerStart + 3
        val (numAccountKeys, afterKeyCountOffset) = decodeShortvec(txBytes, accountKeysCountStart)
        if (numAccountKeys < 0 || numAccountKeys > 1024) {
            throw SigningException("unsupported_tx_format", "Unreasonable account-keys count: $numAccountKeys")
        }
        val accountKeys = ArrayList<ByteArray>(numAccountKeys)
        cursor = afterKeyCountOffset
        for (i in 0 until numAccountKeys) {
            if (cursor + 32 > txBytes.size) {
                throw SigningException("unsupported_tx_format", "Account-keys vector truncated")
            }
            accountKeys.add(txBytes.copyOfRange(cursor, cursor + 32))
            cursor += 32
        }

        if (numRequiredSignatures > numAccountKeys) {
            throw SigningException(
                "unsupported_tx_format",
                "numRequiredSignatures ($numRequiredSignatures) > numAccountKeys ($numAccountKeys)",
            )
        }

        // 5. Canonical message bytes = everything from messageStart to end of buffer.
        val canonicalMessageBytes = txBytes.copyOfRange(messageStart, txBytes.size)

        return ParsedTx(
            signatures = signatures,
            numRequiredSignatures = numRequiredSignatures,
            accountKeys = accountKeys,
            canonicalMessageBytes = canonicalMessageBytes,
            messageStartOffset = messageStart,
            signaturesStartOffset = 0,
            signatureSlotOffsets = sigSlotOffsets,
        )
    }

    /**
     * Insert a 64-byte signature into the burner's signer slot in
     * [original] and return the updated transaction bytes. Preserves any
     * pre-existing signatures from co-signers.
     *
     * Throws [SigningException]:
     *   - `burner_not_required_signer` if [burnerPubkey] is not in the
     *     first numRequiredSignatures account-key slots.
     *   - `additional_signers_required` when numRequiredSignatures > 1
     *     AND any other signer slot is still all-zeros.
     */
    fun insertSignature(
        original: ByteArray,
        parsed: ParsedTx,
        burnerPubkey: ByteArray,
        signature: ByteArray,
    ): ByteArray {
        require(burnerPubkey.size == 32) { "burnerPubkey must be 32 bytes" }
        require(signature.size == 64) { "signature must be 64 bytes" }

        // Find burner index in the first numRequiredSignatures slots.
        var burnerIndex = -1
        for (i in 0 until parsed.numRequiredSignatures) {
            if (parsed.accountKeys[i].contentEquals(burnerPubkey)) {
                burnerIndex = i
                break
            }
        }
        if (burnerIndex < 0) {
            throw SigningException(
                "burner_not_required_signer",
                "Burner pubkey is not among the required signers",
            )
        }

        // V1 co-sign rule: if there are additional required signers, they
        // must already have non-zero signatures present. We don't attempt
        // any kind of multi-party signing.
        if (parsed.numRequiredSignatures > 1) {
            for (i in 0 until parsed.numRequiredSignatures) {
                if (i == burnerIndex) continue
                if (isZero(parsed.signatures[i])) {
                    throw SigningException(
                        "additional_signers_required",
                        "Slot $i has no signature (V1 supports single or pre-cosigned only)",
                    )
                }
            }
        }

        val out = original.copyOf()
        val slotOffset = parsed.signatureSlotOffsets[burnerIndex]
        System.arraycopy(signature, 0, out, slotOffset, 64)
        return out
    }

    private fun isZero(bytes: ByteArray): Boolean {
        for (b in bytes) if (b.toInt() != 0) return false
        return true
    }

    /**
     * Compact-u16 (shortvec) decoder. Mirrors the Node helper at
     * `solana.js` `readCompactU16` (lines ~735-747).
     *
     * Spec: 1-3 bytes, low 7 bits payload, high bit (0x80) is the
     * continuation flag. Values 0..127 fit in 1 byte; 128..16383 in 2;
     * 16384..65535 in 3. The 4th byte (if any) MUST NOT have the
     * continuation bit set in valid encodings — we reject it as
     * `bogus_shortvec`.
     *
     * @return Pair(value, nextOffset). nextOffset is the byte index
     *         immediately after the consumed shortvec.
     */
    fun decodeShortvec(buf: ByteArray, offset: Int): Pair<Int, Int> {
        var value = 0
        var shift = 0
        var pos = offset
        var consumed = 0
        while (pos < buf.size) {
            val byte = buf[pos].toInt() and 0xFF
            pos++
            consumed++
            value = value or ((byte and 0x7F) shl shift)
            if ((byte and 0x80) == 0) {
                // 16-bit shortvec is at most 3 bytes. Reject longer.
                if (consumed > 3) {
                    throw SigningException("bogus_shortvec", "shortvec length exceeds 3 bytes")
                }
                // BAT-582 R11: enforce the documented compact-u16 range.
                // A 3-byte encoding can technically hold 21 bits of payload
                // (3 × 7), which extends to 0x1FFFFF — but the Solana
                // wire-format spec caps the value at 0xFFFF (u16). Without
                // this check we silently accept values 0x10000..0x1FFFFF
                // as valid lengths, which would let a malformed tx claim
                // an account-key vector of e.g. 0x1FFFFF entries; the
                // downstream `numAccountKeys > 1024` guard would reject
                // it later, but only after we've parsed past the bogus
                // shortvec. Reject here instead so the contract documented
                // in the KDoc above ("Values 0..127 fit in 1 byte; 128..16383
                // in 2; 16384..65535 in 3") is enforced byte-for-byte.
                if (value > 0xFFFF) {
                    throw SigningException("bogus_shortvec", "compact-u16 value $value exceeds 0xFFFF")
                }
                return Pair(value, pos)
            }
            shift += 7
            if (consumed >= 3) {
                // A 4th byte would mean shift >= 21, beyond u16 range.
                throw SigningException("bogus_shortvec", "shortvec continuation past byte 3")
            }
        }
        throw SigningException("bogus_shortvec", "shortvec truncated at end of buffer")
    }
}
