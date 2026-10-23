package com.seekerclaw.app.service

import android.content.Context
import android.content.pm.PackageManager
import com.seekerclaw.app.config.PrefsNames
import com.seekerclaw.app.util.BundleIntegrity
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
import com.seekerclaw.app.util.ServiceState
import com.seekerclaw.app.util.ServiceStatus
import java.io.File
import java.io.InputStream
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Real nodejs-mobile bridge via JNI.
 *
 * Node.js can only be started ONCE per process. To restart Node.js,
 * the entire service process must be killed and restarted.
 */
object NodeBridge {
    private val running = AtomicBoolean(false)
    private var _startedNodeAlready = false
    private val executor = Executors.newSingleThreadExecutor()

    @Volatile
    var lastHeartbeatResponse: Long = 0L
        private set

    private var nativeLoaded = false
    private var nativeLoadError: String? = null

    private fun ensureNativeLoaded(): Boolean {
        if (nativeLoaded) return true
        if (nativeLoadError != null) return false
        return try {
            System.loadLibrary("native-lib")
            System.loadLibrary("node")
            nativeLoaded = true
            LogCollector.append("[NodeBridge] Native libraries loaded successfully")
            true
        } catch (e: UnsatisfiedLinkError) {
            nativeLoadError = e.message
            LogCollector.append("[NodeBridge] Failed to load native libraries: ${e.message}", LogLevel.ERROR)
            false
        }
    }

    // JNI function — implemented in native-lib.cpp
    private external fun startNodeWithArguments(arguments: Array<String>): Int

    /**
     * BAT-1409 P1-A: verifies `filesDir/nodejs-project` byte for byte against the APK's
     * `assets/nodejs-project` and repairs it when it differs (see [BundleIntegrity]). Runs on the
     * start worker before any secret is written; Node starts only on `Verified` or `Repaired`.
     * Replaces the old extraction, which re-copied only after an APK update.
     */
    fun verifyBundle(context: Context): BundleIntegrity.Outcome {
        val am = context.assets
        val source = object : BundleIntegrity.AssetSource {
            override fun list(dir: String): List<String> = am.list(dir)?.toList() ?: emptyList()
            override fun open(path: String): InputStream = am.open(path)
        }
        val files = context.filesDir
        return BundleIntegrity(
            assets = source,
            filesDir = files.toPath(),
            dataDir = context.dataDir.toPath(),
            usableSpace = { files.usableSpace },
            log = { level, msg -> LogCollector.append(msg, level) },
            nlink = { p -> android.system.Os.lstat(p.toString()).st_nlink },
        ).run(updated = wasAPKUpdated(context), persistUpdateTime = { saveLastUpdateTime(context) })
    }

    /**
     * Start Node.js with the entry script.
     * Can only be called ONCE per app process.
     */
    fun start(workDir: String, openclawDir: String) {
        if (_startedNodeAlready) {
            LogCollector.append("[NodeBridge] Node.js already started (single-start limitation)", LogLevel.WARN)
            return
        }
        if (!ensureNativeLoaded()) {
            LogCollector.append("[NodeBridge] Cannot start — native libraries not available: $nativeLoadError", LogLevel.ERROR)
            ServiceState.updateStatus(ServiceStatus.ERROR)
            return
        }
        if (running.getAndSet(true)) return

        _startedNodeAlready = true
        lastHeartbeatResponse = System.currentTimeMillis()
        // BAT-1409 P1-A (v3.3 M2): the service writes the start status (STARTING in onStartCommand,
        // RUNNING at the end of the start continuation); NodeBridge no longer does, so a start that
        // is aborted or failed never shows RUNNING.

        LogCollector.append("[NodeBridge] Starting Node.js runtime...")
        LogCollector.append("[NodeBridge] workDir=$workDir")
        LogCollector.append("[NodeBridge] openclawDir=$openclawDir")

        val entryPoint = "$openclawDir/main.js"
        if (!File(entryPoint).exists()) {
            LogCollector.append("[NodeBridge] Entry point not found: $entryPoint", LogLevel.ERROR)
            running.set(false)
            _startedNodeAlready = false
            ServiceState.updateStatus(ServiceStatus.ERROR)
            return
        }

        executor.submit {
            try {
                LogCollector.append("[NodeBridge] Entry: $entryPoint")

                // This call BLOCKS the thread until Node.js exits
                val exitCode = startNodeWithArguments(
                    arrayOf("node", entryPoint, workDir)
                )

                LogCollector.append("[NodeBridge] Node.js exited with code $exitCode")
                running.set(false)
                ServiceState.updateStatus(ServiceStatus.STOPPED)
            } catch (e: Exception) {
                LogCollector.append("[NodeBridge] Failed to start: ${e.message}", LogLevel.ERROR)
                running.set(false)
                ServiceState.updateStatus(ServiceStatus.ERROR)
            }
        }
    }

    fun stop() {
        if (!running.getAndSet(false)) return
        LogCollector.append("[NodeBridge] Stop requested (Node.js can only be killed by process restart)", LogLevel.WARN)
        ServiceState.updateStatus(ServiceStatus.STOPPED)
    }

    fun restart() {
        LogCollector.append("[NodeBridge] Restart requested — requires service process restart", LogLevel.WARN)
    }

    fun isAlive(): Boolean = running.get()

    /**
     * Check if Node.js is alive.
     * Phase 2a: Just checks running state (no direct IPC yet — stdout goes to logcat).
     * Phase 2b: Will use real IPC heartbeat.
     */
    fun checkHeartbeat(timeoutMs: Long): Boolean {
        return running.get()
    }

    // --- APK update bookkeeping (BundleIntegrity logs a mismatch after an update as an update, not a tamper) ---

    private fun wasAPKUpdated(context: Context): Boolean {
        val prefs = context.getSharedPreferences(PrefsNames.NODEJS_MOBILE, Context.MODE_PRIVATE)
        val previousLastUpdateTime = prefs.getLong("NODEJS_MOBILE_APK_LastUpdateTime", 0)
        var lastUpdateTime: Long = 1
        try {
            val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
            lastUpdateTime = packageInfo.lastUpdateTime
        } catch (e: PackageManager.NameNotFoundException) {
            e.printStackTrace()
        }
        return lastUpdateTime != previousLastUpdateTime
    }

    private fun saveLastUpdateTime(context: Context) {
        val prefs = context.getSharedPreferences(PrefsNames.NODEJS_MOBILE, Context.MODE_PRIVATE)
        var lastUpdateTime: Long = 1
        try {
            val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
            lastUpdateTime = packageInfo.lastUpdateTime
        } catch (e: PackageManager.NameNotFoundException) {
            e.printStackTrace()
        }
        prefs.edit().putLong("NODEJS_MOBILE_APK_LastUpdateTime", lastUpdateTime).apply()
    }
}
