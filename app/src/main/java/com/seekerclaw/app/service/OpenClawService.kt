package com.seekerclaw.app.service

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.seekerclaw.app.Constants
import com.seekerclaw.app.MainActivity
import com.seekerclaw.app.R
import com.seekerclaw.app.SeekerClawApplication
import com.seekerclaw.app.bridge.AndroidBridge
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
import com.seekerclaw.app.util.Result
import com.seekerclaw.app.util.ServiceState
import com.seekerclaw.app.util.ServiceStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File
import java.io.RandomAccessFile
import java.util.UUID

class OpenClawService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null
    private var screenWakeLock: PowerManager.WakeLock? = null
    private var uptimeJob: Job? = null
    private var nodeDebugJob: Job? = null
    private val scope = CoroutineScope(Dispatchers.IO)
    private var startTimeMs = 0L
    private var androidBridge: AndroidBridge? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Init cross-process file bridge (this runs in :node process)
        ServiceState.init(applicationContext)
        LogCollector.init(applicationContext)

        val notification = createNotification("SeekerClaw is running")
        startForeground(Constants.NOTIFICATION_ID, notification)

        // Acquire partial wake lock (CPU stays on)
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, Constants.WAKE_LOCK_TAG)
        wakeLock?.acquire()

        // Optional server mode: keep screen awake for camera-driven automation.
        if (ConfigManager.getKeepScreenOn(this)) {
            @Suppress("DEPRECATION")
            val flags = PowerManager.FULL_WAKE_LOCK or
                PowerManager.ACQUIRE_CAUSES_WAKEUP or
                PowerManager.ON_AFTER_RELEASE
            screenWakeLock = pm.newWakeLock(flags, Constants.SCREEN_WAKE_LOCK_TAG)
            screenWakeLock?.acquire()
            LogCollector.append("[Service] Server mode enabled: keeping screen awake")
        }

        // Crash loop protection: if we've restarted too many times quickly, stop trying
        val prefs = getSharedPreferences("seekerclaw_crash", MODE_PRIVATE)
        val lastStart = prefs.getLong("last_start", 0L)
        val crashCount = prefs.getInt("crash_count", 0)
        val now = System.currentTimeMillis()
        if (now - lastStart < Constants.CRASH_WINDOW_MS && crashCount >= Constants.MAX_CRASH_COUNT) {
            LogCollector.append("[Service] Crash loop detected ($crashCount restarts in ${Constants.CRASH_WINDOW_MS}ms) — stopping", LogLevel.ERROR)
            ServiceState.updateStatus(ServiceStatus.ERROR)
            stopSelf()
            return START_NOT_STICKY
        }
        val newCrashCount = if (now - lastStart < Constants.CRASH_WINDOW_MS) crashCount + 1 else 0
        prefs.edit().putLong("last_start", now).putInt("crash_count", newCrashCount).apply()

        LogCollector.append("[Service] Starting OpenClaw service... (attempt ${newCrashCount + 1})")
        ServiceState.updateStatus(ServiceStatus.STARTING)

        // Generate per-boot auth token for bridge security
        val bridgeToken = UUID.randomUUID().toString()

        // Write config from encrypted storage (includes bridge token for Node.js)
        when (val result = ConfigManager.writeConfigJson(this, bridgeToken)) {
            is Result.Failure -> {
                LogCollector.append("[Service] Failed to write config.json: ${result.error}", LogLevel.ERROR)
                ServiceState.updateStatus(ServiceStatus.ERROR)
                stopSelf()
                return START_NOT_STICKY
            }
            is Result.Success -> {
                LogCollector.append("[Service] Config written successfully")
            }
        }

        // Seed workspace if first run
        ConfigManager.seedWorkspace(this)

        // Extract nodejs-project assets to internal storage
        NodeBridge.extractBundle(applicationContext)

        // Setup workspace and node project directories
        val workDir = File(filesDir, "workspace").apply { mkdirs() }
        val nodeProjectDir = filesDir.absolutePath + "/nodejs-project"

        // Start Node.js runtime
        NodeBridge.start(workDir = workDir.absolutePath, openclawDir = nodeProjectDir)

        // Delete config.json after Node.js has had time to read it (ephemeral credentials)
        scope.launch {
            delay(Constants.CONFIG_DELETE_DELAY_MS)
            val configFile = File(workDir, "config.json")
            if (configFile.exists()) {
                configFile.delete()
                LogCollector.append("[Service] Deleted ephemeral config.json")
            }
        }

        // Start Android Bridge (HTTP server for Node.js <-> Kotlin IPC)
        // Bound to 127.0.0.1 only, requires per-boot auth token
        try {
            androidBridge = AndroidBridge(applicationContext, bridgeToken)
            androidBridge?.start()
            LogCollector.append("[Service] AndroidBridge started on 127.0.0.1:${Constants.BRIDGE_PORT} (auth required)")
        } catch (e: Exception) {
            LogCollector.append("[Service] Failed to start AndroidBridge: ${e.message}", LogLevel.ERROR)
        }

        // Mark as running
        ServiceState.updateStatus(ServiceStatus.RUNNING)
        LogCollector.append("[Service] OpenClaw service is now RUNNING")

        // Start watchdog
        // Note: Node.js can only start once per process. If it dies,
        // we need to kill this :node process and let Android restart it (START_STICKY).
        Watchdog.start(
            onDead = {
                LogCollector.append("[Service] Watchdog detected Node.js death — killing process for restart", LogLevel.ERROR)
                NodeBridge.stop()
                // Kill this process so Android restarts the :node service process
                android.os.Process.killProcess(android.os.Process.myPid())
            }
        )

        // Poll Node.js debug log and forward to LogCollector
        val debugLogFile = File(workDir, "node_debug.log")
        nodeDebugJob = scope.launch {
            var lastPos = 0L
            while (isActive) {
                try {
                    if (debugLogFile.exists() && debugLogFile.length() > lastPos) {
                        val raf = RandomAccessFile(debugLogFile, "r")
                        raf.seek(lastPos)
                        val newBytes = ByteArray((debugLogFile.length() - lastPos).toInt())
                        raf.readFully(newBytes)
                        raf.close()
                        lastPos = debugLogFile.length()
                        val lines = String(newBytes).lines().filter { it.isNotBlank() }
                        for (line in lines) {
                            val level = if (line.contains("UNCAUGHT") || line.contains("ERROR")) LogLevel.ERROR
                                else if (line.contains("WARN")) LogLevel.WARN
                                else LogLevel.INFO
                            LogCollector.append("[Node] $line", level)
                        }
                    }
                } catch (_: Exception) {}
                delay(500)
            }
        }

        // Track uptime
        startTimeMs = System.currentTimeMillis()
        uptimeJob = scope.launch {
            while (isActive) {
                val elapsed = System.currentTimeMillis() - startTimeMs
                ServiceState.updateUptime(elapsed)
                delay(1000)
            }
        }

        LogCollector.append("[Service] OpenClaw service started")

        return START_STICKY
    }

    override fun onDestroy() {
        LogCollector.append("[Service] Stopping OpenClaw service...")
        nodeDebugJob?.cancel()
        uptimeJob?.cancel()
        Watchdog.stop()
        androidBridge?.shutdown()
        NodeBridge.stop()
        wakeLock?.let {
            if (it.isHeld) it.release()
        }
        screenWakeLock?.let {
            if (it.isHeld) it.release()
        }
        ServiceState.updateStatus(ServiceStatus.STOPPED)
        ServiceState.updateUptime(0)
        LogCollector.append("[Service] OpenClaw service stopped")
        super.onDestroy()
    }

    private fun createNotification(text: String): Notification {
        val pendingIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return NotificationCompat.Builder(this, SeekerClawApplication.CHANNEL_ID)
            .setContentTitle("SeekerClaw")
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setSilent(true)
            .build()
    }

    companion object {
        fun start(context: Context) {
            val intent = Intent(context, OpenClawService::class.java)
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, OpenClawService::class.java)
            context.stopService(intent)
        }
    }
}
