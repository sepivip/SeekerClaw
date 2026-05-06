package com.seekerclaw.app.data.wallet

import android.content.Context
import android.util.Log
import com.seekerclaw.app.config.KeystoreHelper
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import java.io.File
import java.util.Arrays

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
        // KeystoreHelper.encrypt operates on String; encode raw bytes via
        // Latin1 so every byte 0x00-0xFF round-trips losslessly. Base64
        // would work too but adds 33% size for no security gain — the
        // ciphertext still goes to the same encrypted file.
        val encoded = String(expanded64, Charsets.ISO_8859_1)
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
            // Reverse of the Latin1 encoding in [store].
            plain.toByteArray(Charsets.ISO_8859_1)
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
