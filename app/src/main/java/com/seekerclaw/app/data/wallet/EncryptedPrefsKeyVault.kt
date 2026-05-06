package com.seekerclaw.app.data.wallet

import android.content.Context
import android.util.Log
import com.seekerclaw.app.config.KeystoreHelper
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import java.io.File
import java.util.Arrays
import java.util.Base64

/**
 * EncryptedPrefsKeyVault — V1 KeyVault impl (BAT-582).
 *
 *   - KeystoreHelper-backed AES-256-GCM encryption of the 64-byte secret
 *   - BouncyCastle Ed25519 signing INSIDE the vault (key never leaves)
 *   - SolanaTxSigner pipeline: parse → sign canonical message bytes →
 *     insert signature
 *   - Storage at `filesDir/burner_keys/<id>` — one file per id (V1 only
 *     uses id="burner"). Atomic writes via tmp + Files.move.
 *
 * **Backup safety:** the app's manifest sets `android:allowBackup="false"`
 * already (verified during Phase 2 implementation), so no separate
 * `data_extraction_rules.xml` entry is required. If `allowBackup` is ever
 * flipped to true in the future, a `data_extraction_rules.xml` `<exclude
 * domain="file" path="burner_keys/" />` entry MUST be added in the same
 * change.
 */
class EncryptedPrefsKeyVault(
    private val context: Context,
) : KeyVault {

    companion object {
        private const val TAG = "EncryptedPrefsKeyVault"
        private const val DIR_NAME = "burner_keys"
        // Same alphabet pattern as McpTokenStore — defense against path
        // traversal even though V1 only uses id="burner".
        private val ID_REGEX = Regex("^[A-Za-z0-9_-]+$")

        /**
         * BAT-582 R4: encode raw key bytes for the KeystoreHelper String
         * boundary using Base64 (RFC 4648, no wrap). Pure function —
         * exposed for round-trip unit tests that must run without
         * Android Keystore.
         *
         * Use [java.util.Base64] (Java 8+, available on minSdk 34) rather
         * than [android.util.Base64] so this helper is callable from pure
         * JVM tests without Robolectric.
         */
        internal fun encodeForVault(bytes: ByteArray): String =
            Base64.getEncoder().encodeToString(bytes)

        /**
         * BAT-582 R4: reverse of [encodeForVault]. Returns the original
         * raw bytes. Throws [IllegalArgumentException] on malformed
         * Base64 — caller catches via the surrounding decrypt try/catch
         * and returns null.
         */
        internal fun decodeFromVault(s: String): ByteArray =
            Base64.getDecoder().decode(s)
    }

    private fun dir(): File {
        val d = File(context.applicationContext.filesDir, DIR_NAME)
        if (!d.exists()) d.mkdirs()
        return d
    }

    private fun fileFor(id: String): File? {
        if (!ID_REGEX.matches(id)) return null
        return File(dir(), id)
    }

    override suspend fun store(id: String, expanded64: ByteArray) {
        require(expanded64.size == 64) { "expanded64 must be 64 bytes" }
        val file = fileFor(id) ?: throw IllegalArgumentException("invalid id")
        val tmp = File(file.parentFile, "${file.name}.tmp")
        // BAT-582 R4 (CRITICAL CORRECTNESS): KeystoreHelper.encrypt operates
        // on String and INTERNALLY encodes via UTF-8. Earlier rounds used
        // `String(bytes, ISO_8859_1)` here, relying on a two-charset hop
        // (ISO-8859-1 in / UTF-8 across the cipher / ISO-8859-1 out) to
        // round-trip the raw bytes. Even when the JDK happens to make
        // that round-trip work, mixing two charsets at a single boundary
        // is fragile — small implementation differences (JDK version,
        // codec choice, future stdlib changes) can silently corrupt key
        // material that the user can never recover from.
        //
        // Base64 output is pure ASCII (0x20-0x7E), so every char is a
        // single-byte UTF-8 sequence whose byte value equals the char
        // value. That makes the round-trip trivially correct — no
        // charset surprises possible regardless of platform. The 33%
        // size cost is acceptable; ciphertext lands in the same encrypted
        // file either way. Pinned by EncryptedPrefsKeyVaultTest.
        //
        // Heap-residence-time tradeoff: the Base64 String itself contains
        // key material in plaintext (just Base64-encoded). Strings are
        // immutable in Kotlin — we cannot zero them. The GC will eventually
        // clear the reference, but during its lifetime the encoded key
        // lives in heap. Acceptable for V1; for V2, switching KeystoreHelper
        // to take ByteArray would close this gap (bigger refactor — touches
        // every other API key/token caller). Tracked for follow-up.
        val encoded = encodeForVault(expanded64)
        try {
            val enc = KeystoreHelper.encrypt(encoded)
            tmp.writeBytes(enc)
            try {
                java.nio.file.Files.move(
                    tmp.toPath(),
                    file.toPath(),
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                    java.nio.file.StandardCopyOption.ATOMIC_MOVE,
                )
            } catch (_: java.nio.file.AtomicMoveNotSupportedException) {
                java.nio.file.Files.move(
                    tmp.toPath(),
                    file.toPath(),
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                )
            }
        } catch (e: Exception) {
            Log.e(TAG, "store($id) failed: ${e.message}", e)
            // Don't include any byte from the secret in the thrown msg.
            throw SigningException("invalid_key_format", "Failed to persist key")
        } finally {
            if (tmp.exists()) tmp.delete()
            // Best-effort scrub of the encoded string is impossible
            // (Strings are immutable), but the ENCRYPTED bytes are
            // what land on disk; the plaintext String only lived in
            // this method's frame.
            Arrays.fill(expanded64, 0.toByte())
        }
    }

    /**
     * Load + decrypt the stored 64-byte expanded secret. Returns null
     * if no key is stored for [id] or if decryption fails.
     *
     * INTERNAL: only called by signTransaction / getPubkey / wipe inside
     * this class. NEVER called from outside the file. The byte array
     * MUST be zeroed by the caller after use.
     */
    private fun loadKey(id: String): ByteArray? {
        val file = fileFor(id) ?: return null
        if (!file.exists()) return null
        return try {
            val plain = KeystoreHelper.decrypt(file.readBytes())
            // Reverse of the Base64 encoding in [store]. See R4 comment
            // there for why we use Base64 instead of ISO-8859-1.
            decodeFromVault(plain)
        } catch (e: Exception) {
            Log.w(TAG, "loadKey($id) decrypt failed: ${e.message}")
            null
        }
    }

    override suspend fun signTransaction(id: String, txBytes: ByteArray): ByteArray {
        val expanded = loadKey(id)
            ?: throw SigningException("burner_not_configured", "No burner key stored")
        if (expanded.size != 64) {
            Arrays.fill(expanded, 0.toByte())
            throw SigningException("invalid_key_format", "Stored key is not 64 bytes")
        }
        try {
            val parsed = SolanaTxSigner.parse(txBytes)
            val burnerPubkey = expanded.copyOfRange(32, 64)
            // Sign the canonical message bytes with Ed25519.
            val seed = expanded.copyOfRange(0, 32)
            val signature: ByteArray = try {
                val priv = Ed25519PrivateKeyParameters(seed, 0)
                val signer = Ed25519Signer()
                signer.init(true, priv)
                signer.update(parsed.canonicalMessageBytes, 0, parsed.canonicalMessageBytes.size)
                signer.generateSignature()
            } finally {
                Arrays.fill(seed, 0.toByte())
            }
            try {
                return SolanaTxSigner.insertSignature(txBytes, parsed, burnerPubkey, signature)
            } finally {
                // Pubkey isn't a secret; signature isn't a secret. No
                // wipe needed for those.
            }
        } finally {
            Arrays.fill(expanded, 0.toByte())
        }
    }

    override suspend fun getPubkey(id: String): String? {
        val expanded = loadKey(id) ?: return null
        return try {
            if (expanded.size != 64) return null
            val pubBytes = expanded.copyOfRange(32, 64)
            org.sol4k.Base58.encode(pubBytes)
        } catch (e: Exception) {
            Log.w(TAG, "getPubkey($id) failed: ${e.message}")
            null
        } finally {
            Arrays.fill(expanded, 0.toByte())
        }
    }

    override suspend fun wipe(id: String) {
        val file = fileFor(id) ?: return
        if (file.exists()) {
            try {
                // Overwrite then delete — defense-in-depth against undeleted
                // sectors. The file content is ciphertext + GCM tag, so this
                // is moderately paranoid; do it anyway.
                val len = file.length().toInt().coerceAtLeast(0)
                if (len > 0) {
                    file.writeBytes(ByteArray(len))
                }
            } catch (_: Exception) {
                // Best-effort; the delete below is the actual erase.
            }
            try {
                file.delete()
            } catch (e: Exception) {
                Log.w(TAG, "wipe($id) delete failed: ${e.message}")
            }
        }
        // Tmp leftover from a failed store() — clean it up too.
        val tmp = File(file.parentFile, "${file.name}.tmp")
        if (tmp.exists()) {
            try { tmp.delete() } catch (_: Exception) {}
        }
    }
}
