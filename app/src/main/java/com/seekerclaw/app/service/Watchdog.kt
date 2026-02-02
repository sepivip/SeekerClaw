package com.seekerclaw.app.service

import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

object Watchdog {
    // Timing constants — easy to tune later
    const val CHECK_INTERVAL_MS = 30_000L
    const val DEAD_AFTER_CHECKS = 2 // Kill after this many consecutive failed checks

    private var watchdogJob: Job? = null
    private val scope = CoroutineScope(Dispatchers.IO)
    private var missedChecks = 0

    fun start(onDead: () -> Unit) {
        stop()
        missedChecks = 0
        LogCollector.append("[Watchdog] Started (interval=${CHECK_INTERVAL_MS / 1000}s, deadAfter=$DEAD_AFTER_CHECKS missed checks)")

        watchdogJob = scope.launch {
            // Wait for initial startup before checking
            delay(CHECK_INTERVAL_MS * 2)

            while (isActive) {
                delay(CHECK_INTERVAL_MS)

                if (!NodeBridge.isAlive()) {
                    missedChecks++
                    LogCollector.append("[Watchdog] Node.js not running (missed=$missedChecks/$DEAD_AFTER_CHECKS)", LogLevel.WARN)
                    if (missedChecks >= DEAD_AFTER_CHECKS) {
                        LogCollector.append("[Watchdog] Node.js unresponsive, triggering restart...", LogLevel.ERROR)
                        onDead()
                        missedChecks = 0
                    }
                } else {
                    if (missedChecks > 0) {
                        LogCollector.append("[Watchdog] Node.js recovered after $missedChecks missed checks")
                    }
                    missedChecks = 0
                }
            }
        }
    }

    fun stop() {
        watchdogJob?.cancel()
        watchdogJob = null
    }
}
