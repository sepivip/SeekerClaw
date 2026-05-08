package com.seekerclaw.app.data.wallet

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Pure JVM tests for KeyImporter — exercises parse, length-case
 * handling, format cross-equivalence, and reject paths.
 *
 * Phase 2 of BAT-582. Uses BouncyCastle Ed25519 for derivation, which
 * is in JVM-test classpath via the `bcprov-jdk18on` dependency.
 */
class KeyImporterTest {

    // Deterministic test seed — DO NOT use this as a real key.
    // 32 bytes of 0x01..0x20 — every byte distinct so sign/verify
    // bugs around byte-order produce different output, easier to
    // debug.
    private val testSeed: ByteArray = ByteArray(32) { (it + 1).toByte() }

    @Test
    fun `32-byte base58 seed parses and expands correctly`() {
        val base58 = org.sol4k.Base58.encode(testSeed)
        val result = KeyImporter.import(base58)
        assertTrue("Expected Ok, got $result", result is KeyImporter.Result.Ok)
        result as KeyImporter.Result.Ok
        assertEquals(64, result.expanded64.size)
        assertEquals(32, result.pubkey.size)
        // Seed prefix matches input
        assertArrayEquals(testSeed, result.expanded64.copyOfRange(0, 32))
        // Pubkey suffix matches derived pubkey
        assertArrayEquals(result.pubkey, result.expanded64.copyOfRange(32, 64))
    }

    @Test
    fun `32-byte JSON byte array seed parses and expands correctly`() {
        val json = "[" + testSeed.joinToString(",") { (it.toInt() and 0xFF).toString() } + "]"
        val result = KeyImporter.import(json)
        assertTrue("Expected Ok, got $result", result is KeyImporter.Result.Ok)
        result as KeyImporter.Result.Ok
        assertEquals(64, result.expanded64.size)
    }

    @Test
    fun `same fixture in base58 and JSON produces identical canonical output`() {
        val base58 = org.sol4k.Base58.encode(testSeed)
        val json = "[" + testSeed.joinToString(",") { (it.toInt() and 0xFF).toString() } + "]"
        val r1 = KeyImporter.import(base58) as KeyImporter.Result.Ok
        val r2 = KeyImporter.import(json) as KeyImporter.Result.Ok
        assertArrayEquals(r1.expanded64, r2.expanded64)
        assertArrayEquals(r1.pubkey, r2.pubkey)
    }

    @Test
    fun `64-byte valid expanded form is accepted`() {
        // First derive the canonical 64-byte form via a 32-byte seed import.
        val seed32B58 = org.sol4k.Base58.encode(testSeed)
        val seedResult = KeyImporter.import(seed32B58) as KeyImporter.Result.Ok
        val expanded64 = seedResult.expanded64

        // Now feed the 64-byte form back in — should round-trip.
        val expandedB58 = org.sol4k.Base58.encode(expanded64)
        val result = KeyImporter.import(expandedB58)
        assertTrue("Expected Ok, got $result", result is KeyImporter.Result.Ok)
        result as KeyImporter.Result.Ok
        assertArrayEquals(expanded64, result.expanded64)
    }

    @Test
    fun `64-byte form with corrupted pubkey suffix is rejected`() {
        val seedResult = KeyImporter.import(org.sol4k.Base58.encode(testSeed)) as KeyImporter.Result.Ok
        val corrupted = seedResult.expanded64.copyOf()
        // Flip a byte in the pubkey suffix
        corrupted[40] = (corrupted[40].toInt() xor 0xFF).toByte()
        val b58 = org.sol4k.Base58.encode(corrupted)
        val result = KeyImporter.import(b58)
        assertTrue("Expected Err, got $result", result is KeyImporter.Result.Err)
        result as KeyImporter.Result.Err
        assertEquals("invalid_keypair_pubkey_mismatch", result.code)
    }

    @Test
    fun `wrong length input is rejected`() {
        // 16 bytes — neither 32 nor 64
        val short = ByteArray(16) { it.toByte() }
        val b58 = org.sol4k.Base58.encode(short)
        val result = KeyImporter.import(b58)
        assertTrue("Expected Err, got $result", result is KeyImporter.Result.Err)
        result as KeyImporter.Result.Err
        assertEquals("invalid_key_length", result.code)
    }

    @Test
    fun `100-byte input is rejected`() {
        val big = ByteArray(100) { it.toByte() }
        val b58 = org.sol4k.Base58.encode(big)
        val result = KeyImporter.import(b58)
        assertTrue("Expected Err, got $result", result is KeyImporter.Result.Err)
        assertEquals("invalid_key_length", (result as KeyImporter.Result.Err).code)
    }

    @Test
    fun `unparseable input is rejected with format error`() {
        val result = KeyImporter.import("not a base58 string with !@#$ chars")
        assertTrue("Expected Err, got $result", result is KeyImporter.Result.Err)
        assertEquals("invalid_key_format", (result as KeyImporter.Result.Err).code)
    }

    @Test
    fun `empty input is rejected with format error`() {
        val result = KeyImporter.import("   ")
        assertTrue("Expected Err, got $result", result is KeyImporter.Result.Err)
        assertEquals("invalid_key_format", (result as KeyImporter.Result.Err).code)
    }

    @Test
    fun `JSON byte array with out-of-range value is rejected`() {
        val json = "[1, 2, 999, 4]"
        val result = KeyImporter.import(json)
        assertTrue(result is KeyImporter.Result.Err)
        assertEquals("invalid_key_format", (result as KeyImporter.Result.Err).code)
    }

    @Test
    fun `JSON byte array with negative value is rejected`() {
        val json = "[1, -1, 2, 3]"
        val result = KeyImporter.import(json)
        assertTrue(result is KeyImporter.Result.Err)
        assertEquals("invalid_key_format", (result as KeyImporter.Result.Err).code)
    }

    @Test
    fun `derived pubkey is deterministic for same seed`() {
        val pub1 = KeyImporter.derivePubkey(testSeed)
        val pub2 = KeyImporter.derivePubkey(testSeed.copyOf())
        assertArrayEquals(pub1, pub2)
    }
}
