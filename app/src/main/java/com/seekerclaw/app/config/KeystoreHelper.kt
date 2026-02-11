package com.seekerclaw.app.config

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.seekerclaw.app.Constants
import com.seekerclaw.app.util.Result
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
 *
 * All operations return Result<T> for type-safe error handling.
 */
object KeystoreHelper {
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"

    private fun getOrCreateKey(): Result<SecretKey> {
        return try {
            val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

            // Return existing key if present, otherwise create new one
            val existingEntry = keyStore.getEntry(Constants.KEYSTORE_ALIAS, null)
            if (existingEntry != null) {
                return Result.Success((existingEntry as KeyStore.SecretKeyEntry).secretKey)
            }

            // Create new key
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
            Result.Success(keyGenerator.generateKey())
        } catch (e: Exception) {
            Result.Failure("Failed to access keystore: ${e.message}", e)
        }
    }

    fun encrypt(data: String): Result<ByteArray> {
        return try {
            when (val keyResult = getOrCreateKey()) {
                is Result.Success -> {
                    val cipher = Cipher.getInstance(TRANSFORMATION)
                    cipher.init(Cipher.ENCRYPT_MODE, keyResult.data)
                    val iv = cipher.iv
                    val ciphertext = cipher.doFinal(data.toByteArray(Charsets.UTF_8))
                    // Prepend IV to ciphertext: [IV (12 bytes)][ciphertext+tag]
                    Result.Success(iv + ciphertext)
                }
                is Result.Failure -> Result.Failure(keyResult.error, keyResult.exception)
            }
        } catch (e: Exception) {
            Result.Failure("Encryption failed: ${e.message}", e)
        }
    }

    fun decrypt(encrypted: ByteArray): Result<String> {
        return try {
            if (encrypted.size < Constants.GCM_IV_LENGTH_BYTES) {
                return Result.Failure("Invalid encrypted data: too short")
            }

            when (val keyResult = getOrCreateKey()) {
                is Result.Success -> {
                    val iv = encrypted.copyOfRange(0, Constants.GCM_IV_LENGTH_BYTES)
                    val ciphertext = encrypted.copyOfRange(Constants.GCM_IV_LENGTH_BYTES, encrypted.size)
                    val cipher = Cipher.getInstance(TRANSFORMATION)
                    cipher.init(
                        Cipher.DECRYPT_MODE,
                        keyResult.data,
                        GCMParameterSpec(Constants.GCM_TAG_LENGTH_BITS, iv),
                    )
                    Result.Success(String(cipher.doFinal(ciphertext), Charsets.UTF_8))
                }
                is Result.Failure -> Result.Failure(keyResult.error, keyResult.exception)
            }
        } catch (e: Exception) {
            Result.Failure("Decryption failed: ${e.message}", e)
        }
    }

    fun deleteKey(): Result<Unit> {
        return try {
            val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
            if (keyStore.containsAlias(Constants.KEYSTORE_ALIAS)) {
                keyStore.deleteEntry(Constants.KEYSTORE_ALIAS)
            }
            Result.Success(Unit)
        } catch (e: Exception) {
            Result.Failure("Failed to delete key: ${e.message}", e)
        }
    }
}

