package com.seekerclaw.app.data.wallet

import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File

/**
 * Pure JVM tests for the [EncryptedPrefsKeyVault] byte/String encoding
 * boundary (BAT-582 R4).
 *
 * **Why this test exists (CRITICAL CORRECTNESS pin):** Earlier rounds of
 * BAT-582 used `String(bytes, Charsets.ISO_8859_1)` to bridge the raw
 * 64-byte secret key into KeystoreHelper.encrypt(plaintext: String).
 * KeystoreHelper internally re-encodes via UTF-8 before AES-GCM, then
 * the decrypt side reverses with UTF-8 + ISO-8859-1.
 *
 * **The R4 finding:** Copilot flagged this byte/String hop as a
 * CORRECTNESS RISK because mixing two charsets at a single boundary is
 * fragile — small implementation differences (JDK version, locale,
 * future Kotlin stdlib codec changes) can silently corrupt key material.
 * Even if a particular JDK happens to round-trip ISO-8859-1 → UTF-8 →
 * ISO-8859-1 cleanly today, that's not a contract we should rely on for
 * key storage that the user can never recover from corruption.
 *
 * **The fix:** Base64-encode the bytes BEFORE passing to
 * KeystoreHelper.encrypt, Base64-decode AFTER KeystoreHelper.decrypt.
 * Base64 output is pure ASCII (0x20–0x7E), so it round-trips through
 * UTF-8 trivially — every Base64 char is a 1-byte UTF-8 sequence whose
 * byte value equals the char value. No charset surprises possible.
 *
 * **Test strategy:** the actual KeystoreHelper requires Android Keystore
 * (instrumented test territory). We simulate the KeystoreHelper round-
 * trip exactly — a String → UTF-8 ByteArray → UTF-8 String — and verify
 * the encode/decode helpers in [EncryptedPrefsKeyVault.Companion] survive
 * it. AES-GCM is byte-exact, so we don't model encryption — only the
 * codec hop, which is where any corruption would happen.
 *
 * The end-to-end Ed25519 signing test ([`simulated end-to-end persistence
 * yields byte-exact signatures`]) is the strongest possible regression
 * pin: a single-byte corruption in the seed would derive a different
 * pubkey, and the signature would not verify against the original
 * pubkey. If that test ever fails, the byte path is corrupting key data.
 */
class EncryptedPrefsKeyVaultTest {

    // --- Encode/decode round-trip ---

    @Test
    fun `Base64 encoding produces ASCII-only output`() {
        // The whole point of the Base64 fix is that the encoded String
        // is ASCII — every char < 0x80, so UTF-8 encoding is the
        // identity transform on the byte values. Verify the property
        // holds for a representative key.
        val expanded64 = ByteArray(64) { ((it * 31) and 0xFF).toByte() }
        val encoded = EncryptedPrefsKeyVault.encodeForVault(expanded64)
        for ((idx, c) in encoded.withIndex()) {
            assertTrue(
                "char at $idx is non-ASCII (U+${c.code.toString(16)}) — Base64 contract violated",
                c.code < 0x80,
            )
        }
    }

    @Test
    fun `Base64 round-trip survives Keystore UTF-8 hop (the R4 fix)`() {
        // A representative Solana-shape key: 64 bytes with ~half ≥ 0x80,
        // including 0xC3 specifically because that's the byte from the
        // bug write-up.
        val expanded64 = byteArrayOf(
            // Seed (32 bytes) — heavy on bytes ≥ 0x80
            0xC3.toByte(), 0xFF.toByte(), 0x80.toByte(), 0x81.toByte(),
            0x7F, 0x00, 0xA0.toByte(), 0xB5.toByte(),
            0xDE.toByte(), 0xAD.toByte(), 0xBE.toByte(), 0xEF.toByte(),
            0xCA.toByte(), 0xFE.toByte(), 0xBA.toByte(), 0xBE.toByte(),
            0xF0.toByte(), 0x9F.toByte(), 0x98.toByte(), 0x80.toByte(),
            0x01, 0x02, 0x03, 0x04,
            0xE2.toByte(), 0x82.toByte(), 0xAC.toByte(), 0x21,
            0xC2.toByte(), 0xA9.toByte(), 0xC2.toByte(), 0xAE.toByte(),
            // Pubkey (32 bytes) — also mixed
            0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C,
            0x0D, 0x0E, 0x0F, 0x10, 0x11, 0x12, 0x13, 0x14,
            0x90.toByte(), 0x91.toByte(), 0x92.toByte(), 0x93.toByte(),
            0x94.toByte(), 0x95.toByte(), 0x96.toByte(), 0x97.toByte(),
            0xF8.toByte(), 0xF9.toByte(), 0xFA.toByte(), 0xFB.toByte(),
            0xFC.toByte(), 0xFD.toByte(), 0xFE.toByte(), 0xFF.toByte(),
        )
        assertEquals("fixture must be 64 bytes", 64, expanded64.size)

        // Encode using the production helper (Base64).
        val encoded = EncryptedPrefsKeyVault.encodeForVault(expanded64)
        // Simulate KeystoreHelper.encrypt → decrypt: the String round-trips
        // through UTF-8 bytes inside the cipher.
        val afterKeystoreSimulation = simulateKeystoreUtf8RoundTrip(encoded)
        assertEquals(
            "Base64 must be ASCII-safe — UTF-8 hop must not alter the String",
            encoded,
            afterKeystoreSimulation,
        )

        // Decode and verify byte-exact round-trip.
        val decoded = EncryptedPrefsKeyVault.decodeFromVault(afterKeystoreSimulation)
        assertArrayEquals(
            "Base64 round-trip must preserve every byte, including those ≥ 0x80",
            expanded64,
            decoded,
        )
    }

    @Test
    fun `Base64 round-trip preserves all-zero key`() {
        val zeros = ByteArray(64)
        val encoded = EncryptedPrefsKeyVault.encodeForVault(zeros)
        val afterKeystore = simulateKeystoreUtf8RoundTrip(encoded)
        val decoded = EncryptedPrefsKeyVault.decodeFromVault(afterKeystore)
        assertArrayEquals(zeros, decoded)
    }

    @Test
    fun `Base64 round-trip preserves all-FF key`() {
        // 64 bytes all 0xFF — every byte ≥ 0x80, the worst case for any
        // charset mismatch.
        val ffs = ByteArray(64) { 0xFF.toByte() }
        val encoded = EncryptedPrefsKeyVault.encodeForVault(ffs)
        val afterKeystore = simulateKeystoreUtf8RoundTrip(encoded)
        val decoded = EncryptedPrefsKeyVault.decodeFromVault(afterKeystore)
        assertArrayEquals(ffs, decoded)
    }

    @Test
    fun `Base64 round-trip preserves 1000 random 64-byte keys`() {
        // Fuzz — 1000 random keys (deterministic seed for repro).
        // Solana keys are uniformly random 64 bytes; if the codec hop
        // misbehaved on any byte pattern, this would surface it.
        val rng = java.util.Random(582L) // BAT-582 — deterministic seed for repro
        for (i in 0 until 1000) {
            val key = ByteArray(64).also { rng.nextBytes(it) }
            val encoded = EncryptedPrefsKeyVault.encodeForVault(key)
            val afterKeystore = simulateKeystoreUtf8RoundTrip(encoded)
            val decoded = EncryptedPrefsKeyVault.decodeFromVault(afterKeystore)
            assertArrayEquals("round-trip mismatch on random key #$i", key, decoded)
        }
    }

    // --- End-to-end signing proof ---

    @Test
    fun `simulated end-to-end persistence yields byte-exact signatures`() {
        // The strongest possible pure-JVM proof: build a fixture key,
        // compute its pubkey via Ed25519, then simulate the full
        // store-then-load cycle (encode → KeystoreHelper UTF-8 hop → decode)
        // and verify (a) the loaded bytes equal the original, (b) signing
        // a transaction with the loaded key produces a signature that
        // verifies against the SAME pubkey.
        //
        // If the encode/decode boundary corrupted even one byte of the
        // seed, the derived pubkey would be different and signature
        // verification would fail with overwhelming probability. This
        // is the test that pins the contract: a green here proves the
        // on-device path is byte-exact through the codec hop.
        val seed = byteArrayOf(
            // Heavy on bytes ≥ 0x80 to exercise the charset surface.
            0xC3.toByte(), 0x80.toByte(), 0xFF.toByte(), 0x7F,
            0xA5.toByte(), 0x5A, 0xC2.toByte(), 0xA9.toByte(),
            0xDE.toByte(), 0xAD.toByte(), 0xBE.toByte(), 0xEF.toByte(),
            0x01, 0x02, 0x03, 0x04,
            0xCA.toByte(), 0xFE.toByte(), 0xBA.toByte(), 0xBE.toByte(),
            0xE2.toByte(), 0x82.toByte(), 0xAC.toByte(), 0xC2.toByte(),
            0xAE.toByte(), 0x90.toByte(), 0x91.toByte(), 0x92.toByte(),
            0xF0.toByte(), 0xF1.toByte(), 0xFE.toByte(), 0xFF.toByte(),
        )
        val pubkey = derivePubkey(seed)
        val expanded64 = seed + pubkey
        assertEquals(64, expanded64.size)

        // Simulate the full vault round-trip (encode + UTF-8 hop + decode).
        val encoded = EncryptedPrefsKeyVault.encodeForVault(expanded64)
        val afterKeystore = simulateKeystoreUtf8RoundTrip(encoded)
        val loaded = EncryptedPrefsKeyVault.decodeFromVault(afterKeystore)
        assertArrayEquals("loaded key must match stored key byte-for-byte", expanded64, loaded)

        // Sign a fixed canonical message with the LOADED seed and verify
        // against the ORIGINAL pubkey. A single-byte corruption in the
        // seed would derive a different pubkey, and Ed25519 verification
        // would fail with overwhelming probability.
        val canonicalMessage = "BAT-582 R4 round-trip proof".toByteArray(Charsets.UTF_8)
        val loadedSeed = loaded.copyOfRange(0, 32)
        val loadedPubkey = loaded.copyOfRange(32, 64)
        assertArrayEquals("loaded pubkey suffix must match", pubkey, loadedPubkey)

        val signature = signEd25519(canonicalMessage, loadedSeed)
        assertTrue(
            "Signature from loaded seed MUST verify against original pubkey — " +
                "a failure here proves the encode/decode boundary corrupted bytes",
            verifyEd25519(canonicalMessage, signature, pubkey),
        )
    }

    @Test
    fun `decodeFromVault rejects malformed Base64`() {
        // Sanity: garbage input must surface as an exception so the
        // caller's try/catch returns null on tampered/corrupt files.
        try {
            EncryptedPrefsKeyVault.decodeFromVault("!@#$%^ not base64")
            org.junit.Assert.fail("Expected IllegalArgumentException for malformed Base64")
        } catch (_: IllegalArgumentException) {
            // Expected — caller-side try/catch in loadKey() turns this
            // into a null return.
        }
    }

    // --- isConfiguredAt: no-side-effect contract (R4 review fix) ---
    //
    // The periodic sweep gate in SeekerClawService calls isConfigured()
    // every 30 seconds. Pre-fix, that path went through fileFor() →
    // dir() → mkdirs(), so a never-configured install grew
    // `filesDir/burner_keys/` as a side effect of the gate check —
    // unnecessary directory creation, flash wear, false signal that
    // the dir matters. The R4 fix routes through [isConfiguredAt],
    // a pure helper that does NOT mkdirs the parent.
    //
    // The tests below pin the no-side-effect contract so a future
    // refactor can't reintroduce the mkdirs.

    private lateinit var sideEffectTmpDir: File

    @Before
    fun setUpSideEffectTmpDir() {
        sideEffectTmpDir = File.createTempFile("bat582-isConfigured", "").apply {
            delete()
            mkdirs()
        }
    }

    @After
    fun tearDownSideEffectTmpDir() {
        if (::sideEffectTmpDir.isInitialized) {
            sideEffectTmpDir.deleteRecursively()
        }
    }

    @Test
    fun `isConfiguredAt returns false on fresh state — no parent dir`() {
        // Setup: tmp filesDir exists but `burner_keys/` does NOT.
        val burnerKeysDir = File(sideEffectTmpDir, "burner_keys")
        assertFalse("setup: burner_keys must not exist yet", burnerKeysDir.exists())

        val configured = EncryptedPrefsKeyVault.isConfiguredAt(sideEffectTmpDir, "burner")

        assertFalse("isConfiguredAt must return false on fresh state", configured)
    }

    @Test
    fun `isConfiguredAt does NOT create burner_keys as a side effect`() {
        // **The R4 review-finding regression pin.** Pre-fix, calling
        // isConfigured("burner") on a never-configured install
        // mkdir'd `filesDir/burner_keys/` because the path went
        // through dir() → mkdirs(). Post-fix the call is a pure
        // read — two `fstat`s, no writes.
        //
        // If a future refactor reintroduces the mkdirs (e.g. by
        // routing through fileFor(), which still calls dir()),
        // this assertion fails.
        val burnerKeysDir = File(sideEffectTmpDir, "burner_keys")
        assertFalse("setup: burner_keys must not exist yet", burnerKeysDir.exists())

        EncryptedPrefsKeyVault.isConfiguredAt(sideEffectTmpDir, "burner")

        assertFalse(
            "isConfiguredAt must NOT create burner_keys/ as a side effect — " +
                "the periodic sweep gate runs every 30s and would otherwise " +
                "produce an empty directory + flash wear on every install " +
                "where the burner is never configured",
            burnerKeysDir.exists(),
        )
    }

    @Test
    fun `pre-fix path (dir + mkdirs) DID create burner_keys — bug evidence`() {
        // Documents the BUGGY pre-fix behavior so a future reader can
        // see what the R4 fix prevents. We replicate the pre-fix path
        // inline — `dir()` was a private helper that called `mkdirs()`,
        // and `fileFor()` routed through it. So calling `fileFor("burner")`
        // followed by `.exists()` on the result both checked AND created.
        //
        // After running this buggy path, `burner_keys/` exists on disk
        // even though no key was ever stored — exactly the bug we
        // patched. This test exists to make the regression visible if
        // anyone later asks "what was the bug, exactly?"
        val burnerKeysDir = File(sideEffectTmpDir, "burner_keys")
        assertFalse("setup: burner_keys must not exist yet", burnerKeysDir.exists())

        // Pre-fix logic (buggy): mkdirs the parent then check the file.
        val d = File(sideEffectTmpDir, "burner_keys")
        if (!d.exists()) d.mkdirs()
        val f = File(d, "burner")
        val configuredViaBuggyPath = f.exists()

        assertFalse("the buggy path still returned the right boolean", configuredViaBuggyPath)
        assertTrue(
            "pre-fix BUG evidence: the gate check itself created burner_keys/ — " +
                "this is exactly what the R4 fix avoids by routing through " +
                "isConfiguredAt instead of fileFor()/dir()",
            burnerKeysDir.exists(),
        )
    }

    @Test
    fun `isConfiguredAt returns true when key file is present`() {
        // Sanity: the post-fix contract still produces the right answer
        // when a burner IS configured. `true` necessary-but-not-sufficient
        // (per the KDoc) — the file could still fail to decrypt — but
        // that's the gate's contract.
        val burnerKeysDir = File(sideEffectTmpDir, "burner_keys").apply { mkdirs() }
        val keyFile = File(burnerKeysDir, "burner")
        keyFile.writeBytes(ByteArray(80) { it.toByte() })

        val configured = EncryptedPrefsKeyVault.isConfiguredAt(sideEffectTmpDir, "burner")

        assertTrue("isConfiguredAt must return true when key file exists", configured)
    }

    @Test
    fun `isConfiguredAt rejects path-traversal ids`() {
        // ID_REGEX guard from the companion: must reject `..`, `/`,
        // any non-[A-Za-z0-9_-] char. Even though V1 only ever calls
        // with id="burner", the gate must defend against future code
        // that might pass through user input.
        val malformed = listOf("..", "../escape", "/abs", "burner/sub", "burner.tmp", "")
        for (id in malformed) {
            assertFalse(
                "isConfiguredAt must reject malformed id `$id`",
                EncryptedPrefsKeyVault.isConfiguredAt(sideEffectTmpDir, id),
            )
        }
    }

    // --- helpers ---

    /**
     * Simulates the String → UTF-8 ByteArray → UTF-8 String hop that
     * KeystoreHelper performs internally on the plaintext. AES-GCM is
     * byte-exact, so we don't model encryption — only the codec hop.
     *
     * For ASCII strings (Base64 output), this is the identity transform.
     */
    private fun simulateKeystoreUtf8RoundTrip(s: String): String {
        val utf8 = s.toByteArray(Charsets.UTF_8)
        return String(utf8, Charsets.UTF_8)
    }

    private fun derivePubkey(seed: ByteArray): ByteArray {
        val priv = Ed25519PrivateKeyParameters(seed, 0)
        return priv.generatePublicKey().encoded
    }

    private fun signEd25519(message: ByteArray, seed: ByteArray): ByteArray {
        val priv = Ed25519PrivateKeyParameters(seed, 0)
        val signer = Ed25519Signer()
        signer.init(true, priv)
        signer.update(message, 0, message.size)
        return signer.generateSignature()
    }

    private fun verifyEd25519(message: ByteArray, signature: ByteArray, pubkey: ByteArray): Boolean {
        val pub = Ed25519PublicKeyParameters(pubkey, 0)
        val verifier = Ed25519Signer()
        verifier.init(false, pub)
        verifier.update(message, 0, message.size)
        return verifier.verifySignature(signature)
    }
}
