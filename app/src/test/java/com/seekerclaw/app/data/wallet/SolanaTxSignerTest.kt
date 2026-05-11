package com.seekerclaw.app.data.wallet

import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayOutputStream

/**
 * Pure JVM tests for SolanaTxSigner — shortvec parity with the Node
 * helper, legacy + v0 tx parse + sign + insert-signature, reject paths.
 *
 * Phase 2 of BAT-582. Transactions in these tests are minimal but
 * valid-shape — they exercise the parser's compact-u16 + signer-slot
 * logic without needing a real on-chain blockhash or program.
 */
class SolanaTxSignerTest {

    private val testSeed: ByteArray = ByteArray(32) { (it + 1).toByte() }
    private val burnerPubkey: ByteArray
        get() = KeyImporter.derivePubkey(testSeed)

    // --- shortvec ---

    @Test
    fun `shortvec decodes single byte under 128`() {
        for (n in 0..127) {
            val buf = byteArrayOf(n.toByte())
            val (value, next) = SolanaTxSigner.decodeShortvec(buf, 0)
            assertEquals(n, value)
            assertEquals(1, next)
        }
    }

    @Test
    fun `shortvec decodes 2-byte values 128 to 16383`() {
        val cases = listOf(128, 129, 200, 1000, 16383)
        for (n in cases) {
            val encoded = encodeShortvec(n)
            assertEquals("two bytes for $n", 2, encoded.size)
            val (value, next) = SolanaTxSigner.decodeShortvec(encoded, 0)
            assertEquals(n, value)
            assertEquals(2, next)
        }
    }

    @Test
    fun `shortvec decodes 3-byte values 16384 to 65535`() {
        val cases = listOf(16384, 30000, 65535)
        for (n in cases) {
            val encoded = encodeShortvec(n)
            assertEquals("three bytes for $n", 3, encoded.size)
            val (value, next) = SolanaTxSigner.decodeShortvec(encoded, 0)
            assertEquals(n, value)
            assertEquals(3, next)
        }
    }

    @Test
    fun `shortvec parity with node helper for 100 random lengths`() {
        // Mirror the JS helper exactly:
        //   while (pos < buf.length) {
        //     const byte = buf[pos]; pos++;
        //     value |= (byte & 0x7F) << shift;
        //     if ((byte & 0x80) === 0) break;
        //     shift += 7;
        //   }
        // We test by encoding via our reference encoder, then comparing
        // the JS-equivalent decode to our Kotlin decode for matching
        // outputs.
        val rng = java.util.Random(42)
        for (i in 0 until 100) {
            val n = rng.nextInt(65536)  // 0..65535
            val encoded = encodeShortvec(n)
            val jsValue = decodeShortvecLikeJs(encoded, 0)
            val (kotlinValue, _) = SolanaTxSigner.decodeShortvec(encoded, 0)
            assertEquals("parity at n=$n", jsValue, kotlinValue)
            assertEquals(n, kotlinValue)
        }
    }

    @Test
    fun `shortvec rejects bogus 4-byte continuation`() {
        // Four bytes all with continuation bit set — invalid per spec.
        val bogus = byteArrayOf(0x80.toByte(), 0x80.toByte(), 0x80.toByte(), 0x01)
        try {
            SolanaTxSigner.decodeShortvec(bogus, 0)
            fail("Expected SigningException(bogus_shortvec)")
        } catch (e: SigningException) {
            assertEquals("bogus_shortvec", e.code)
        }
    }

    @Test
    fun `shortvec rejects truncated continuation`() {
        // First byte has continuation bit but buffer ends.
        val bogus = byteArrayOf(0x80.toByte())
        try {
            SolanaTxSigner.decodeShortvec(bogus, 0)
            fail("Expected SigningException(bogus_shortvec)")
        } catch (e: SigningException) {
            assertEquals("bogus_shortvec", e.code)
        }
    }

    @Test
    fun `R11 - shortvec rejects 3-byte encoding above 0xFFFF (compact-u16 contract)`() {
        // BAT-582 R11: the compact-u16 wire format caps values at 0xFFFF
        // by spec, but a 3-byte encoding has 21 payload bits — there is
        // physical room for 0x10000..0x1FFFFF. Pre-fix, decodeShortvec
        // accepted these silently, contradicting the KDoc claim "Values
        // 0..127 fit in 1 byte; 128..16383 in 2; 16384..65535 in 3".
        //
        // For 0x10000 = 65536 (one above the u16 max), the LSB-first 7-bit
        // payload split is: byte 0 = bits 0..6 = 0; byte 1 = bits 7..13 = 0;
        // byte 2 = bits 14..20 = 0b0000100 = 4. With continuation bits on
        // bytes 0 + 1: [0x80, 0x80, 0x04].
        val encoded = byteArrayOf(0x80.toByte(), 0x80.toByte(), 0x04.toByte())
        // Reference (pre-R11 lenient) decode would return 0x10000.
        val refValue = decodeShortvecLikeJs(encoded, 0)
        assertEquals("reference decoder returns 0x10000 for these bytes", 0x10000, refValue)

        // Production decoder must now REJECT this as bogus_shortvec.
        try {
            SolanaTxSigner.decodeShortvec(encoded, 0)
            fail("Expected SigningException(bogus_shortvec) for value 0x10000 above u16 max")
        } catch (e: SigningException) {
            assertEquals("bogus_shortvec", e.code)
            assertTrue(
                "error message must mention u16 / 0xFFFF / value: ${e.message}",
                e.message?.contains("0xFFFF") == true || e.message?.contains("65535") == true,
            )
        }
    }

    @Test
    fun `R11 - shortvec accepts max u16 value 0xFFFF`() {
        // Sanity: the boundary case (exactly 0xFFFF) MUST still decode.
        val encoded = encodeShortvec(0xFFFF)
        assertEquals("max u16 is 3 bytes", 3, encoded.size)
        val (value, _) = SolanaTxSigner.decodeShortvec(encoded, 0)
        assertEquals(0xFFFF, value)
    }

    @Test
    fun `R11 - shortvec rejects 3-byte encoding for largest 21-bit value`() {
        // 0x1FFFFF — the maximum representable in 3 × 7-bit payload bytes.
        // Pre-fix this would silently decode; post-fix it's rejected.
        val encoded = byteArrayOf(0xFF.toByte(), 0xFF.toByte(), 0x7F.toByte())
        val refValue = decodeShortvecLikeJs(encoded, 0)
        assertEquals("reference decoder returns 0x1FFFFF", 0x1FFFFF, refValue)
        try {
            SolanaTxSigner.decodeShortvec(encoded, 0)
            fail("Expected SigningException for 0x1FFFFF (>u16 max)")
        } catch (e: SigningException) {
            assertEquals("bogus_shortvec", e.code)
        }
    }

    // --- legacy tx parse + sign ---

    @Test
    fun `legacy single-signer tx parses and signs`() {
        val tx = buildLegacyTx(
            signerPubkey = burnerPubkey,
            blockhash = ByteArray(32) { it.toByte() },
        )
        val parsed = SolanaTxSigner.parse(tx)
        assertEquals(1, parsed.numRequiredSignatures)
        assertEquals(1, parsed.signatures.size)
        assertEquals(1, parsed.accountKeys.size)
        assertArrayEquals(burnerPubkey, parsed.accountKeys[0])
        // Canonical message bytes start at the legacy 3-byte header (no version byte).
        // First byte should be numRequiredSignatures = 1.
        assertEquals(1, parsed.canonicalMessageBytes[0].toInt())

        // Sign with BC, insert signature
        val signature = signWithBc(parsed.canonicalMessageBytes, testSeed)
        val signed = SolanaTxSigner.insertSignature(tx, parsed, burnerPubkey, signature)

        // Verify by re-parsing and checking the signature was inserted at slot 0
        val reparsed = SolanaTxSigner.parse(signed)
        assertArrayEquals(signature, reparsed.signatures[0])

        // Verify the signature actually validates against canonical message
        assertTrue(verifyWithBc(parsed.canonicalMessageBytes, signature, burnerPubkey))
    }

    @Test
    fun `v0 single-signer tx parses with version byte preserved in canonical message`() {
        val tx = buildV0Tx(
            signerPubkey = burnerPubkey,
            blockhash = ByteArray(32) { it.toByte() },
        )
        val parsed = SolanaTxSigner.parse(tx)
        assertEquals(1, parsed.numRequiredSignatures)
        // Canonical message must start with version byte 0x80
        assertEquals(
            "v0 canonical bytes must START with 0x80 (version byte)",
            0x80.toByte(),
            parsed.canonicalMessageBytes[0],
        )

        val signature = signWithBc(parsed.canonicalMessageBytes, testSeed)
        val signed = SolanaTxSigner.insertSignature(tx, parsed, burnerPubkey, signature)

        // Re-parsing the signed tx — version byte still there
        val reparsed = SolanaTxSigner.parse(signed)
        assertEquals(0x80.toByte(), reparsed.canonicalMessageBytes[0])
        assertTrue(verifyWithBc(parsed.canonicalMessageBytes, signature, burnerPubkey))
    }

    @Test
    fun `tx without burner as required signer is rejected`() {
        val notBurner = KeyImporter.derivePubkey(ByteArray(32) { (it + 99).toByte() })
        val tx = buildLegacyTx(signerPubkey = notBurner, blockhash = ByteArray(32))
        val parsed = SolanaTxSigner.parse(tx)
        try {
            SolanaTxSigner.insertSignature(tx, parsed, burnerPubkey, ByteArray(64))
            fail("Expected burner_not_required_signer")
        } catch (e: SigningException) {
            assertEquals("burner_not_required_signer", e.code)
        }
    }

    @Test
    fun `multi-signer tx with unsigned cosigner is rejected`() {
        val cosigner = KeyImporter.derivePubkey(ByteArray(32) { (it + 7).toByte() })
        val tx = buildLegacyTxMultiSigner(
            signerPubkeys = listOf(burnerPubkey, cosigner),
            preSignedSignatures = listOf(null, null),  // both empty
            blockhash = ByteArray(32),
        )
        val parsed = SolanaTxSigner.parse(tx)
        assertEquals(2, parsed.numRequiredSignatures)
        try {
            SolanaTxSigner.insertSignature(tx, parsed, burnerPubkey, ByteArray(64))
            fail("Expected additional_signers_required")
        } catch (e: SigningException) {
            assertEquals("additional_signers_required", e.code)
        }
    }

    @Test
    fun `multi-signer tx with cosigner already signed is accepted`() {
        val cosigner = KeyImporter.derivePubkey(ByteArray(32) { (it + 7).toByte() })
        val cosignerSig = ByteArray(64) { ((it + 1) and 0xFF).toByte() }  // non-zero
        val tx = buildLegacyTxMultiSigner(
            signerPubkeys = listOf(burnerPubkey, cosigner),
            preSignedSignatures = listOf(null, cosignerSig),
            blockhash = ByteArray(32),
        )
        val parsed = SolanaTxSigner.parse(tx)
        val signature = signWithBc(parsed.canonicalMessageBytes, testSeed)
        val signed = SolanaTxSigner.insertSignature(tx, parsed, burnerPubkey, signature)
        val reparsed = SolanaTxSigner.parse(signed)
        assertArrayEquals(signature, reparsed.signatures[0])
        // Cosigner signature preserved
        assertArrayEquals(cosignerSig, reparsed.signatures[1])
    }

    @Test
    fun `empty buffer is rejected`() {
        try {
            SolanaTxSigner.parse(ByteArray(0))
            fail("Expected unsupported_tx_format")
        } catch (e: SigningException) {
            assertEquals("unsupported_tx_format", e.code)
        }
    }

    @Test
    fun `truncated tx is rejected`() {
        // Just a sigcount byte, nothing else
        val truncated = byteArrayOf(0x01)
        try {
            SolanaTxSigner.parse(truncated)
            fail("Expected unsupported_tx_format")
        } catch (e: SigningException) {
            assertEquals("unsupported_tx_format", e.code)
        }
    }

    @Test
    fun `tx with signature count mismatching numRequiredSignatures is rejected`() {
        // Build a tx where header says 1 required signer but signature
        // array claims 2. Impossible to construct via builder, so do
        // it manually.
        val out = ByteArrayOutputStream()
        out.write(0x02)  // 2 signatures
        out.write(ByteArray(64))
        out.write(ByteArray(64))
        // Header says only 1 required signer
        out.write(0x01)  // numRequiredSignatures = 1
        out.write(0x00)
        out.write(0x00)
        out.write(0x01)  // 1 account key
        out.write(burnerPubkey)
        out.write(ByteArray(32))  // blockhash
        out.write(0x00)  // 0 instructions
        try {
            SolanaTxSigner.parse(out.toByteArray())
            fail("Expected unsupported_tx_format")
        } catch (e: SigningException) {
            assertEquals("unsupported_tx_format", e.code)
        }
    }

    @Test
    fun `tx with bogus shortvec for sig count is rejected`() {
        // 4 bytes all with continuation bit — bogus shortvec
        val bogus = byteArrayOf(0x80.toByte(), 0x80.toByte(), 0x80.toByte(), 0x80.toByte())
        try {
            SolanaTxSigner.parse(bogus)
            fail("Expected bogus_shortvec")
        } catch (e: SigningException) {
            assertEquals("bogus_shortvec", e.code)
        }
    }

    @Test
    fun `unsupported v0 version is rejected`() {
        // Version 1 (0x81) is reserved/future — reject cleanly.
        val out = ByteArrayOutputStream()
        out.write(0x01)  // 1 signature
        out.write(ByteArray(64))
        out.write(0x81)  // v1, unsupported
        out.write(0x01); out.write(0x00); out.write(0x00)
        out.write(0x01)
        out.write(burnerPubkey)
        out.write(ByteArray(32))
        out.write(0x00)
        try {
            SolanaTxSigner.parse(out.toByteArray())
            fail("Expected unsupported_tx_format")
        } catch (e: SigningException) {
            assertEquals("unsupported_tx_format", e.code)
        }
    }

    // --- helpers ---

    /**
     * Encode a u16 (0..65535) as Solana compact-u16 (shortvec). Used as
     * fixture input for parity tests.
     */
    private fun encodeShortvec(value: Int): ByteArray {
        require(value in 0..65535) { "shortvec range exceeded" }
        var v = value
        val out = ByteArrayOutputStream()
        while (true) {
            var b = v and 0x7F
            v = v ushr 7
            if (v == 0) {
                out.write(b)
                break
            }
            b = b or 0x80
            out.write(b)
        }
        return out.toByteArray()
    }

    /**
     * Reference decode that mirrors the Node `readCompactU16` helper
     * exactly. Used to verify Kotlin parity.
     */
    private fun decodeShortvecLikeJs(buf: ByteArray, offset: Int): Int {
        var value = 0
        var shift = 0
        var pos = offset
        while (pos < buf.size) {
            val byte = buf[pos].toInt() and 0xFF
            pos++
            value = value or ((byte and 0x7F) shl shift)
            if ((byte and 0x80) == 0) break
            shift += 7
        }
        return value
    }

    /**
     * Build a minimal legacy single-signer Solana transaction:
     *   [shortvec(1) + 64-byte zero signature]
     *   [header: 1, 0, 0]
     *   [shortvec(1) + 32-byte pubkey]
     *   [32-byte blockhash]
     *   [shortvec(0) instructions]
     */
    private fun buildLegacyTx(signerPubkey: ByteArray, blockhash: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(0x01)  // shortvec(1) sig count
        out.write(ByteArray(64))  // empty signature slot
        out.write(0x01); out.write(0x00); out.write(0x00)  // header
        out.write(0x01)  // shortvec(1) account keys
        out.write(signerPubkey)
        out.write(blockhash)
        out.write(0x00)  // shortvec(0) instructions
        return out.toByteArray()
    }

    /**
     * Build a minimal v0 single-signer tx — same as legacy but with the
     * version byte (0x80) preceding the header.
     */
    private fun buildV0Tx(signerPubkey: ByteArray, blockhash: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(0x01)
        out.write(ByteArray(64))
        out.write(0x80)  // version byte (v0)
        out.write(0x01); out.write(0x00); out.write(0x00)
        out.write(0x01)
        out.write(signerPubkey)
        out.write(blockhash)
        out.write(0x00)  // 0 instructions
        out.write(0x00)  // 0 address-table-lookups
        return out.toByteArray()
    }

    /**
     * Build a multi-signer legacy tx. preSignedSignatures[i] = null
     * leaves slot i as 64 zeros.
     */
    private fun buildLegacyTxMultiSigner(
        signerPubkeys: List<ByteArray>,
        preSignedSignatures: List<ByteArray?>,
        blockhash: ByteArray,
    ): ByteArray {
        require(signerPubkeys.size == preSignedSignatures.size)
        val n = signerPubkeys.size
        val out = ByteArrayOutputStream()
        out.write(n)  // shortvec(n) sig count (n < 128)
        for (sig in preSignedSignatures) {
            out.write(sig ?: ByteArray(64))
        }
        out.write(n); out.write(0x00); out.write(0x00)  // header
        out.write(n)  // shortvec(n) account keys
        for (pk in signerPubkeys) out.write(pk)
        out.write(blockhash)
        out.write(0x00)
        return out.toByteArray()
    }

    private fun signWithBc(message: ByteArray, seed: ByteArray): ByteArray {
        val priv = Ed25519PrivateKeyParameters(seed, 0)
        val signer = Ed25519Signer()
        signer.init(true, priv)
        signer.update(message, 0, message.size)
        return signer.generateSignature()
    }

    private fun verifyWithBc(message: ByteArray, signature: ByteArray, pubkey: ByteArray): Boolean {
        val pub = Ed25519PublicKeyParameters(pubkey, 0)
        val verifier = Ed25519Signer()
        verifier.init(false, pub)
        verifier.update(message, 0, message.size)
        return verifier.verifySignature(signature)
    }
}
