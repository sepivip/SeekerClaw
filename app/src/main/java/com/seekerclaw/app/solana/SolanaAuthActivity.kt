package com.seekerclaw.app.solana

import android.os.Bundle
import android.util.Base64
import android.util.Log
import androidx.activity.ComponentActivity
import com.seekerclaw.app.config.ConfigManager
import com.solana.mobilewalletadapter.clientlib.ActivityResultSender
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File

/**
 * Transparent Activity that handles MWA authorization and signing.
 * Launched from AndroidBridge (cross-process) or SettingsScreen (main process).
 * Results are communicated via files (reliable cross-process).
 */
class SolanaAuthActivity : ComponentActivity() {
    companion object {
        private const val TAG = "SolanaAuth"
        const val RESULTS_DIR = "solana_results"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val action = intent.getStringExtra("action") ?: run {
            Log.w(TAG, "No action specified")
            finish()
            return
        }
        val requestId = intent.getStringExtra("requestId") ?: run {
            Log.w(TAG, "No requestId specified")
            finish()
            return
        }

        Log.i(TAG, "Starting MWA action: $action (request: $requestId)")

        val sender = ActivityResultSender(this)

        CoroutineScope(Dispatchers.Main).launch {
            when (action) {
                "authorize" -> {
                    val result = SolanaWalletManager.authorize(sender)
                    val address = result.getOrNull()
                    val error = result.exceptionOrNull()?.message

                    if (address != null) {
                        ConfigManager.setWalletAddress(this@SolanaAuthActivity, address)
                    }

                    writeResultFile(requestId, JSONObject().apply {
                        put("address", address ?: "")
                        put("error", error ?: "")
                    })
                }

                "sign" -> {
                    val txBytes = intent.getByteArrayExtra("transaction")
                    if (txBytes == null) {
                        writeResultFile(requestId, JSONObject().apply {
                            put("error", "No transaction data provided")
                        })
                        finish()
                        return@launch
                    }

                    val result = SolanaWalletManager.signAndSendTransaction(sender, txBytes)
                    val sigBytes = result.getOrNull()
                    val error = result.exceptionOrNull()?.message

                    writeResultFile(requestId, JSONObject().apply {
                        put("signature", if (sigBytes != null) Base64.encodeToString(sigBytes, Base64.NO_WRAP) else "")
                        put("error", error ?: "")
                    })
                }

                "signOnly" -> {
                    val txBytes = intent.getByteArrayExtra("transaction")
                    if (txBytes == null) {
                        writeResultFile(requestId, JSONObject().apply {
                            put("error", "No transaction data provided")
                        })
                        finish()
                        return@launch
                    }

                    val result = SolanaWalletManager.signTransaction(sender, txBytes)
                    val signedBytes = result.getOrNull()
                    val error = result.exceptionOrNull()?.message

                    writeResultFile(requestId, JSONObject().apply {
                        put("signedTransaction", if (signedBytes != null) Base64.encodeToString(signedBytes, Base64.NO_WRAP) else "")
                        put("error", error ?: "")
                    })
                }
            }
            finish()
        }
    }

    private fun writeResultFile(requestId: String, result: JSONObject) {
        val resultDir = File(filesDir, RESULTS_DIR).apply { mkdirs() }
        // Atomic write: write to .tmp then rename to .json
        val tmpFile = File(resultDir, "$requestId.tmp")
        val jsonFile = File(resultDir, "$requestId.json")
        tmpFile.writeText(result.toString())
        tmpFile.renameTo(jsonFile)
        Log.d(TAG, "Result written: ${jsonFile.absolutePath}")
    }
}
