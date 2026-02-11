package com.seekerclaw.app.config

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.seekerclaw.app.Constants
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * KeystoreHelper - Android Keystore wrapper for secure encryption
 *
 * Uses AES-256-GCM encryption backed by Android Keystore hardware/TEE.
 * Keys are automatically generated and stored securely, never exposed to app code.
 */
object KeystoreHelper {
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        keyStore.getEntry(Constants.KEYSTORE_ALIAS, null)?.let { entry ->
            return (entry as KeyStore.SecretKeyEntry).secretKey
        }
        val keyGenerator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            ANDROID_KEYSTORE,
        )
        keyGenerator.init(
            KeyGenParameterSpec.Builder(
                Constants.KEYSTORE_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(Constants.AES_KEY_SIZE_BITS)
                .setUserAuthenticationRequired(false)
                .build()
        )
        return keyGenerator.generateKey()
    }

    fun encrypt(data: String): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val iv = cipher.iv
        val ciphertext = cipher.doFinal(data.toByteArray(Charsets.UTF_8))
        // Prepend IV to ciphertext: [IV (12 bytes)][ciphertext+tag]
        return iv + ciphertext
    }

    fun decrypt(encrypted: ByteArray): String {
        val iv = encrypted.copyOfRange(0, Constants.GCM_IV_LENGTH_BYTES)
        val ciphertext = encrypted.copyOfRange(Constants.GCM_IV_LENGTH_BYTES, encrypted.size)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(
            Cipher.DECRYPT_MODE,
            getOrCreateKey(),
            GCMParameterSpec(Constants.GCM_TAG_LENGTH_BITS, iv),
        )
        return String(cipher.doFinal(ciphertext), Charsets.UTF_8)
    }

    fun deleteKey() {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        if (keyStore.containsAlias(Constants.KEYSTORE_ALIAS)) {
            keyStore.deleteEntry(Constants.KEYSTORE_ALIAS)
        }
    }
}
