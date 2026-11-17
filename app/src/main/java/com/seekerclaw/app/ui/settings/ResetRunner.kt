package com.seekerclaw.app.ui.settings

import android.content.Context
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.solana.SolanaWalletManager
import com.seekerclaw.app.util.Analytics
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
import java.util.concurrent.atomic.AtomicBoolean

/**
 * BAT-1157: runs Reset Config in a PROCESS-scoped coroutine, not the Settings screen's composition
 * scope, so leaving the screen or rotating the device mid-reset cannot drop the result.
 *
 * The cleanup a finished reset requires happens here, not in the UI: on [ConfigManager.ResetResult.Done]
 * the wallet authorization cache is cleared (the reset cleared the wallet address with the rest of
 * prefs — BAT-1021). Every outcome is logged to analytics. The result is then published on [result]
 * for whichever Settings screen is showing; the screen calls [consume] once it has acted on it. A
 * result published while no Settings screen is showing is kept until one is: Reset is only started
 * from Settings, and a Done reset has cleared setup, so the next Settings visit routes to setup.
 */
object ResetRunner {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val running = AtomicBoolean(false)

    private val _result = MutableStateFlow<ConfigManager.ResetResult?>(null)
    val result: StateFlow<ConfigManager.ResetResult?> = _result

    private val _isRunning = MutableStateFlow(false)
    val isRunning: StateFlow<Boolean> = _isRunning

    /** Starts a reset unless one is already running. */
    fun start(context: Context) {
        if (!running.compareAndSet(false, true)) return
        val app = context.applicationContext
        _isRunning.value = true
        scope.launch {
            try {
                val r = try {
                    ConfigManager.resetConfig(app)
                } catch (e: Exception) {
                    ConfigManager.ResetResult.Failed(e.javaClass.simpleName)
                }
                // The follow-up steps never change what the reset reports: a cleanup failure after
                // Done must not turn into "nothing was changed".
                // SolanaWalletManager requires the main thread (it asserts it): run there and wait,
                // so the cache is really cleared before the result is published.
                if (r == ConfigManager.ResetResult.Done) {
                    runCatching { withContext(Dispatchers.Main) { SolanaWalletManager.clearAuthToken() } }
                        .onFailure { LogCollector.append("[Config] Reset: wallet authorization cache not cleared (${it.javaClass.simpleName})", LogLevel.WARN) }
                }
                val outcome = when (r) {
                    ConfigManager.ResetResult.Done -> "done"
                    is ConfigManager.ResetResult.Partial -> "partial"
                    is ConfigManager.ResetResult.Failed -> "failed"
                }
                runCatching { Analytics.featureUsed("config_reset", mapOf("outcome" to outcome)) }
                _result.value = r
            } finally {
                _isRunning.value = false
                running.set(false)
            }
        }
    }

    /** The screen has shown or acted on the current result. */
    fun consume() {
        _result.value = null
    }
}
