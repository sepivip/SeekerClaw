package com.seekerclaw.app.solana

import android.net.Uri
import android.util.Log
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import com.solana.mobilewalletadapter.clientlib.ConnectionIdentity
import com.solana.mobilewalletadapter.clientlib.MobileWalletAdapter
import com.solana.mobilewalletadapter.clientlib.TransactionResult

object SolanaWalletManager {
    private const val TAG = "SolanaWallet"

    private val walletAdapter = MobileWalletAdapter(
        connectionIdentity = ConnectionIdentity(
            identityUri = Uri.parse("https://seekerclaw.xyz"),
            iconUri = Uri.parse("favicon.ico"),
            identityName = "SeekerClaw",
        )
    )

    // NOTE: Must be called from Dispatchers.Main — MWA's ActivityResultLauncher
    // requires the main thread. The SDK handles its own IO threading internally.

    suspend fun authorize(
        sender: ActivityResultSender,
    ): Result<String> {
        return try {
            val result = walletAdapter.transact(sender) { authResult ->
                authResult.accounts.firstOrNull()?.publicKey
            }
            when (result) {
                is TransactionResult.Success -> {
                    val pubKey = result.payload
                    if (pubKey != null) {
                        val base58 = org.sol4k.PublicKey(pubKey).toBase58()
                        Log.i(TAG, "Wallet authorized: $base58")
                        Result.success(base58)
                    } else {
                        Result.failure(Exception("No account returned from wallet"))
                    }
                }
                is TransactionResult.NoWalletFound -> {
                    Result.failure(Exception("No MWA-compatible wallet found. Install Phantom or Solflare."))
                }
                is TransactionResult.Failure -> {
                    Result.failure(Exception(result.message))
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "MWA authorize failed", e)
            Result.failure(e)
        }
    }

    /**
     * Sign AND broadcast a transaction via MWA.
     * The wallet handles both signing and submitting to the network.
     * Returns the raw transaction signature bytes (64 bytes).
     */
    suspend fun signAndSendTransaction(
        sender: ActivityResultSender,
        unsignedTransaction: ByteArray,
    ): Result<ByteArray> {
        return try {
            val result = walletAdapter.transact(sender) { authResult ->
                signAndSendTransactions(arrayOf(unsignedTransaction)).signatures.firstOrNull()
            }
            when (result) {
                is TransactionResult.Success -> {
                    val sig = result.payload
                    if (sig != null) {
                        Log.i(TAG, "Transaction signed and sent (${sig.size} bytes)")
                        Result.success(sig)
                    } else {
                        Result.failure(Exception("No signature returned"))
                    }
                }
                is TransactionResult.NoWalletFound -> {
                    Result.failure(Exception("No MWA-compatible wallet found"))
                }
                is TransactionResult.Failure -> {
                    Log.e(TAG, "MWA signAndSend failed: ${result.message}")
                    Result.failure(Exception(result.message))
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "MWA signAndSend failed", e)
            Result.failure(e)
        }
    }

    /**
     * Sign a transaction via MWA WITHOUT broadcasting.
     * Returns the full signed transaction bytes (for Jupiter Ultra flow
     * where Jupiter handles broadcasting via /execute).
     */
    suspend fun signTransaction(
        sender: ActivityResultSender,
        unsignedTransaction: ByteArray,
    ): Result<ByteArray> {
        return try {
            val result = walletAdapter.transact(sender) { authResult ->
                signTransactions(arrayOf(unsignedTransaction)).signedPayloads.firstOrNull()
            }
            when (result) {
                is TransactionResult.Success -> {
                    val signed = result.payload
                    if (signed != null) {
                        Log.i(TAG, "Transaction signed (${signed.size} bytes)")
                        Result.success(signed)
                    } else {
                        Result.failure(Exception("No signed transaction returned"))
                    }
                }
                is TransactionResult.NoWalletFound -> {
                    Result.failure(Exception("No MWA-compatible wallet found"))
                }
                is TransactionResult.Failure -> {
                    Log.e(TAG, "MWA sign failed: ${result.message}")
                    Result.failure(Exception(result.message))
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "MWA sign failed", e)
            Result.failure(e)
        }
    }
}
