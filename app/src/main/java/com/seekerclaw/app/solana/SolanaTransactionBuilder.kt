package com.seekerclaw.app.solana

import android.util.Log

/**
 * Solana transaction builder — currently a stub.
 * Full implementation requires verifying sol4k API compatibility
 * with the project's build setup. Transaction sending works via
 * the MWA sign flow (SolanaAuthActivity).
 */
object SolanaTransactionBuilder {
    private const val TAG = "SolanaTxBuilder"

    fun buildSolTransfer(from: String, to: String, amountSol: Double): ByteArray {
        // TODO: Implement with verified sol4k API or raw transaction construction
        // For now, this is handled by returning an error from the bridge
        Log.w(TAG, "buildSolTransfer not yet implemented — needs sol4k API verification")
        throw UnsupportedOperationException(
            "Transaction building requires sol4k integration. " +
            "Please connect a wallet app that supports MWA transaction construction."
        )
    }

    fun broadcastTransaction(signedTxBase64: String): String? {
        // TODO: Implement RPC broadcast via sendTransaction
        Log.w(TAG, "broadcastTransaction not yet implemented")
        return null
    }
}
