package com.seekerclaw.app.config

import android.util.Base64

/**
 * BAT-1661: turns a secret into the string [ConfigManager] stores in prefs: Android Keystore
 * AES-GCM ([KeystoreHelper.encrypt]), then Base64 without line wraps.
 *
 * It is a PARAMETER of the internal save entry points, never a global or a switch. Production
 * always passes [Keystore] (the public `saveConfig` and the bridge's OAuth save take no sealer).
 * A JVM test passes its own for that one call — there is no Android Keystore on the JVM, and
 * `android.util.Base64` is a stub there — so the real save path runs in unit tests. This is the
 * instance-scoped seam at the save boundary the BAT-1661 Codex diff review allowed, in place of a
 * production-switchable bypass in [KeystoreHelper].
 */
internal fun interface SecretSealer {
    fun seal(plain: String): String

    companion object {
        val Keystore = SecretSealer { plain -> Base64.encodeToString(KeystoreHelper.encrypt(plain), Base64.NO_WRAP) }
    }
}
