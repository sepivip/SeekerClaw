package com.seekerclaw.app.config

import android.util.Base64

/**
 * BAT-1157: how an OAuth token store turns a secret into the string it keeps at rest, and back:
 * Android Keystore AES-GCM ([KeystoreHelper]), then Base64 without line wraps. The same format the
 * legacy prefs keys use, so a migration copies ciphertext verbatim.
 *
 * The store takes it at init time: production always uses [Keystore]; a JVM test passes its own
 * through the store's `initForTest` (there is no Android Keystore on the JVM, and
 * `android.util.Base64` is a stub there). It is not a switch on [KeystoreHelper], so nothing in
 * production can turn encryption off.
 */
internal interface SecretCodec {
    /** Encrypts [plain]. Throws on a Keystore failure. */
    fun seal(plain: String): String

    /** Decrypts [sealed]. Throws when it does not decrypt (corruption, a deleted key). */
    fun open(sealed: String): String

    companion object {
        val Keystore: SecretCodec = object : SecretCodec {
            override fun seal(plain: String): String =
                Base64.encodeToString(KeystoreHelper.encrypt(plain), Base64.NO_WRAP)

            override fun open(sealed: String): String =
                KeystoreHelper.decrypt(Base64.decode(sealed, Base64.NO_WRAP))
        }
    }
}
