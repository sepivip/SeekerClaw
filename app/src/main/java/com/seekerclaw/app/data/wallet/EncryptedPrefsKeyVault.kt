package com.seekerclaw.app.data.wallet

import android.content.Context
import android.util.Log
import com.seekerclaw.app.config.KeystoreHelper
import com.seekerclaw.app.util.SafeFs
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
 *
 * **V2 follow-ups** (consolidated for grep-ability — referenced by the
 * inline R4 comment in [store] and the heap-residence note there):
 *   1. Switch [KeystoreHelper] to a ByteArray-taking API. The current
 *      String boundary forces a Base64 hop whose intermediate plaintext
 *      lives in the immutable String heap until GC. A ByteArray API would
 *      let us zero the encoded buffer in `finally`. Refactor scope:
 *      every existing caller (anthropic key, OAuth tokens, MCP tokens,
 *      etc.) — non-trivial but the win is uniform across callers.
 *   2. Hardware-backed Keystore key. The current `KeystoreHelper` AES key
 *      is software-backed by default. On Seeker hardware the StrongBox /
 *      hardware-backed keystore is available and would tie key extraction
 *      to the secure element. Cost: minSdk + device feature gating.
 *   3. SeedVaultKeyVault impl. The `KeyVault` interface is the seam; V2
 *      adds a new impl that stores the burner secret in the Solana
 *      Seeker Seed Vault. No interface change required — pure addition.
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

        /**
         * BAT-582 R4 (R4 review fix): pure-function variant of [isConfigured].
         *
         * **Why this exists:** the periodic sweep in
         * [com.seekerclaw.app.service.SeekerClawService] gates on
         * `isConfigured("burner")` every 30s. The earlier impl routed
         * through `fileFor()` → `dir()` which calls `mkdirs()` if the
         * parent doesn't exist — so the gate created `filesDir/burner_keys/`
         * for users who never configured a burner. Cheap, but: unnecessary
         * directory creation, flash wear on a 30s loop, and a false signal
         * to anyone auditing the device that the dir "matters" when it's
         * actually empty.
         *
         * Routed through this pure helper instead — no `mkdirs()`, no
         * `dir()` call, just two `fstat` calls (parent + file). Exposed
         * `internal` so [EncryptedPrefsKeyVaultTest] can verify the
         * no-side-effect contract without standing up a Robolectric
         * Context (we have JUnit + coroutines-test in the test classpath
         * but no Android instrumentation framework).
         *
         * Returns false if [id] is malformed (path traversal defense),
         * if the parent directory doesn't exist (= burner never
         * configured on this install), or if the key file itself is
         * absent. See the instance-method KDoc for the necessary-but-
         * not-sufficient caveat (a `true` here doesn't guarantee
         * decryption will succeed; it just rules out the WIPED case).
         */
        internal fun isConfiguredAt(filesDir: File, id: String): Boolean {
            if (!ID_REGEX.matches(id)) return false
            // BAT-1409 P1-J: lstat-based — a link is not a configured key.
            val parent = File(filesDir, DIR_NAME)
            if (!SafeFs.isRealDir(parent.toPath())) return false
            return java.nio.file.Files.isRegularFile(
                File(parent, id).toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS,
            )
        }
    }

    private fun root() = context.applicationContext.filesDir.toPath()

    // BAT-1409 P1-J: created and validated without following links.
    private fun dir(): File {
        val d = File(context.applicationContext.filesDir, DIR_NAME)
        SafeFs.ensureRealDir(root(), d.toPath())
        return d
    }

    private fun fileFor(id: String): File? {
        if (!ID_REGEX.matches(id)) return null
        return File(dir(), id)
    }

    /** BAT-1409 P1-J: [fileFor] for readers — an unsafe directory reads as "not configured". */
    private fun fileForOrNull(id: String): File? = try {
        fileFor(id)
    } catch (e: Exception) {
        Log.w(TAG, "burner_keys directory unavailable: ${e.message}")
        null
    }

    /**
     * Cheap "is this id configured" probe for the periodic sweep gate.
     * Does NOT decrypt or read the file, AND does NOT create the parent
     * directory as a side effect — just two `fstat` calls (parent +
     * file). Used by SeekerClawService to decide whether to allocate
     * CapEnforcer + run sweepStale on a wiped wallet's empty pending
     * queue.
     *
     * Returns false if [id] is malformed (path traversal defense), if
     * the parent directory doesn't exist, or if the key file itself is
     * absent. A `true` here is necessary-but-not-sufficient — the file
     * could still fail to decrypt (corrupt ciphertext, Keystore
     * reinitialized, etc.) — but that's acceptable for a sweep gate
     * because the sweep iteration is harmless when there's no pending
     * work, just wasted CPU. The gate's job is ruling out the WIPED
     * case where there's no key AND no caps state.
     *
     * **R4 review fix:** the earlier impl went through `fileFor()` →
     * `dir()` which called `mkdirs()`. That meant calling `isConfigured`
     * on a never-configured install created `filesDir/burner_keys/` as
     * a side effect of the sweep gate (called every 30s). Routes through
     * the pure [Companion.isConfiguredAt] helper now — no directory
     * creation. See its KDoc for the rationale + the JVM test that
     * pins the no-side-effect contract.
     */
    fun isConfigured(id: String): Boolean =
        isConfiguredAt(context.applicationContext.filesDir, id)

    override suspend fun store(id: String, expanded64: ByteArray) {
        require(expanded64.size == 64) { "expanded64 must be 64 bytes" }
        val file = fileFor(id) ?: throw IllegalArgumentException("invalid id")
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
            // BAT-1409 P1-J: staged in filesDir/.kwrite, renamed into place, never written
            // through a link; durable because a stored key must survive a crash.
            SafeFs.writeAtomic(root(), file.toPath(), enc, durable = true)
        } catch (e: Exception) {
            Log.e(TAG, "store($id) failed: ${e.message}", e)
            // BAT-582 R1: surface the actual failure class. The key has
            // already been parsed + normalized + pubkey-verified by
            // KeyImporter at this point, so a failure here is a
            // Keystore / IO / encryption error, NOT an "invalid format."
            // Misreporting it as `invalid_key_format` would tell the
            // user to fix their key when the actual problem is device
            // storage or Keystore. Don't include any byte from the
            // secret in the thrown msg.
            throw SigningException("storage_failure", "Failed to persist key")
        } finally {
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
        val file = fileForOrNull(id) ?: return null
        if (!SafeFs.existsNoFollow(file.toPath())) return null
        return try {
            val plain = KeystoreHelper.decrypt(SafeFs.readBytesNoFollow(root(), file.toPath()))
            // Reverse of the Base64 encoding in [store]. See R4 comment
            // there for why we use Base64 instead of ISO-8859-1.
            decodeFromVault(plain)
        } catch (e: Exception) {
            Log.w(TAG, "loadKey($id) decrypt failed: ${e.message}")
            null
        }
    }

    override suspend fun signTransaction(id: String, txBytes: ByteArray, allowPartiallySigned: Boolean): ByteArray {
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
                return SolanaTxSigner.insertSignature(txBytes, parsed, burnerPubkey, signature, allowPartiallySigned)
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
        val file = fileForOrNull(id) ?: return
        if (SafeFs.existsNoFollow(file.toPath())) {
            try {
                // Overwrite then delete — defense-in-depth against undeleted
                // sectors. The file content is ciphertext + GCM tag, so this
                // is moderately paranoid; do it anyway.
                // BAT-1409 P1-J: only a regular file is overwritten, opened with NOFOLLOW, so
                // a link here can never zero its target.
                val p = file.toPath()
                if (java.nio.file.Files.isRegularFile(p, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
                    val len = file.length().toInt().coerceAtLeast(0)
                    if (len > 0) {
                        java.nio.file.Files.newOutputStream(
                            p,
                            java.nio.file.StandardOpenOption.WRITE,
                            java.nio.file.LinkOption.NOFOLLOW_LINKS,
                        ).use { it.write(ByteArray(len)) }
                    }
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
