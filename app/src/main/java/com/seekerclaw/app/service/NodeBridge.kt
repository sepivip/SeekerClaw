package com.seekerclaw.app.service

import android.content.Context
import android.content.pm.PackageManager
import android.content.res.AssetManager
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
import com.seekerclaw.app.util.ServiceState
import com.seekerclaw.app.util.ServiceStatus
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
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

    private const val NODE_DIR_NAME = "nodejs-project"

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
     * Copy bundled Node.js project from APK assets to internal storage.
     * Only re-copies when APK is updated (new install or app update).
     */
    fun extractBundle(context: Context) {
        LogCollector.append("[Service] Extracting OpenClaw bundle...")

        val nodeDir = context.filesDir.absolutePath + "/" + NODE_DIR_NAME
        val entryFile = File(nodeDir, "main.js")

        // Re-extract if APK was updated OR if main.js is missing/corrupt (e.g. created as directory)
        if (wasAPKUpdated(context) || !entryFile.isFile) {
            LogCollector.append("[Service] Copying assets/$NODE_DIR_NAME to $nodeDir")
            val nodeDirRef = File(nodeDir)
            if (nodeDirRef.exists()) {
                deleteFolderRecursively(nodeDirRef)
            }
            val result = copyAssetFolder(context.assets, NODE_DIR_NAME, nodeDir)
            LogCollector.append("[Service] copyAssetFolder result: $result")
            saveLastUpdateTime(context)

            val fileCount = File(nodeDir).walk().count { it.isFile }
            LogCollector.append("[Service] OpenClaw bundle extracted ($fileCount files)")

            if (!entryFile.isFile) {
                LogCollector.append("[Service] WARNING: main.js still missing after extraction!", LogLevel.ERROR)
            }
        } else {
            LogCollector.append("[Service] Bundle up to date, skipping extraction")
        }
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
        ServiceState.updateStatus(ServiceStatus.STARTING)

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

                ServiceState.updateStatus(ServiceStatus.RUNNING)

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

    // --- Asset extraction helpers ---

    private fun wasAPKUpdated(context: Context): Boolean {
        val prefs = context.getSharedPreferences("NODEJS_MOBILE_PREFS", Context.MODE_PRIVATE)
        val previousLastUpdateTime = prefs.getLong("NODEJS_MOBILE_APK_LastUpdateTime", 0)
        var lastUpdateTime: Long = 1
        try {
            val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
            lastUpdateTime = packageInfo.lastUpdateTime
        } catch (e: PackageManager.NameNotFoundException) {
            LogCollector.append("[NodeBridge] ${e.message}", LogLevel.ERROR)
        }
        return lastUpdateTime != previousLastUpdateTime
    }

    private fun saveLastUpdateTime(context: Context) {
        val prefs = context.getSharedPreferences("NODEJS_MOBILE_PREFS", Context.MODE_PRIVATE)
        var lastUpdateTime: Long = 1
        try {
            val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
            lastUpdateTime = packageInfo.lastUpdateTime
        } catch (e: PackageManager.NameNotFoundException) {
            LogCollector.append("[NodeBridge] ${e.message}", LogLevel.ERROR)
        }
        prefs.edit().putLong("NODEJS_MOBILE_APK_LastUpdateTime", lastUpdateTime).apply()
    }

    private fun deleteFolderRecursively(file: File): Boolean {
        return try {
            var res = true
            val childFiles = file.listFiles() ?: return file.delete()
            for (childFile in childFiles) {
                res = if (childFile.isDirectory) {
                    res and deleteFolderRecursively(childFile)
                } else {
                    res and childFile.delete()
                }
            }
            res and file.delete()
        } catch (e: Exception) {
            LogCollector.append("[NodeBridge] ${e.message}", LogLevel.ERROR)
            false
        }
    }

    private fun copyAssetFolder(assetManager: AssetManager, fromAssetPath: String, toPath: String): Boolean {
        return try {
            val files = assetManager.list(fromAssetPath) ?: return false

            if (files.isEmpty()) {
                // It's a file, not a directory — copy it
                copyAsset(assetManager, fromAssetPath, toPath)
            } else {
                // It's a directory — create it, then recurse
                val toDir = File(toPath)
                val success = toDir.mkdirs() || toDir.isDirectory
                for (file in files) {
                    copyAssetFolder(assetManager, "$fromAssetPath/$file", "$toPath/$file")
                }
                success
            }
        } catch (e: Exception) {
            LogCollector.append("[NodeBridge] ${e.message}", LogLevel.ERROR)
            false
        }
    }

    private fun copyAsset(assetManager: AssetManager, fromAssetPath: String, toPath: String): Boolean {
        var inputStream: InputStream? = null
        var outputStream: OutputStream? = null
        return try {
            inputStream = assetManager.open(fromAssetPath)
            File(toPath).parentFile?.mkdirs()
            outputStream = FileOutputStream(toPath)
            val buffer = ByteArray(8192)
            var read: Int
            while (inputStream.read(buffer).also { read = it } != -1) {
                outputStream.write(buffer, 0, read)
            }
            true
        } catch (e: IOException) {
            LogCollector.append("[NodeBridge] ${e.message}", LogLevel.ERROR)
            false
        } finally {
            inputStream?.close()
            outputStream?.close()
        }
    }
}
