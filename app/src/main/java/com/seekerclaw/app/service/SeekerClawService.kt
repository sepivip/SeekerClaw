package com.seekerclaw.app.service

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.FileObserver
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.seekerclaw.app.MainActivity
import com.seekerclaw.app.R
import com.seekerclaw.app.SeekerClawApplication
import com.seekerclaw.app.bridge.AndroidBridge
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
import com.seekerclaw.app.util.ServiceState
import com.seekerclaw.app.util.ServiceStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File
import java.util.UUID

class SeekerClawService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null
    private var screenWakeLock: PowerManager.WakeLock? = null
    // BAT-522 (BAT-518 phase 2): the prior 1Hz `uptimeJob` coroutine that
    // wrote `service_state` every second has been deleted. Uptime is now
    // a derived quantity computed from `ServiceState.serviceStartTimeMs`,
    // which the service writes ONCE on transition to RUNNING (and zeros
    // on stop). UI ticks once per second for display only — no disk write.
    // BAT-518: replaced nodeDebugJob (500ms polling coroutine) with
    // FileObserver. lastPos tracks bytes already forwarded to LogCollector
    // so each event reads only new bytes. nodeDebugMutex serializes
    // overlapping reads (FileObserver often emits MODIFY + CLOSE_WRITE
    // for one write; without the mutex both dispatches would read the
    // same byte range and double-forward).
    private var nodeDebugObserver: FileObserver? = null
    @Volatile private var nodeDebugLastPos = 0L
    private val nodeDebugMutex = Mutex()
    private var nodeDebugDrainChannel: Channel<Unit>? = null
    // Per-chunk cap to prevent OOM if events are batched (e.g. Doze mode
    // releases queued events at once) or if Node writes a huge burst.
    // Larger than LogCollector's budget because Node debug writes can
    // include verbose tool-call traces. forwardNewNodeDebugLines drains
    // in a while loop within a single coroutine — each iteration reads
    // up to this cap, releases + reacquires the mutex, then loops until
    // either fully drained or the trailing partial-line case is hit.
    // The loop replaces a prior per-event recursive launch.
    private val nodeDebugMaxDeltaBytes = 256 * 1024L // 256 KB

    // SupervisorJob so a single coroutine failure doesn't cancel the
    // whole scope. Cancellable from onDestroy to ensure no in-flight
    // forwardNewNodeDebugLines / reattach coroutines run after the
    // observer is stopped — otherwise they'd race onDestroy's
    // observer.stopWatching() + null-out.
    private val scopeJob = SupervisorJob()
    private val scope = CoroutineScope(Dispatchers.IO + scopeJob)
    private var androidBridge: AndroidBridge? = null

    /**
     * Read any bytes appended to `node_debug.log` since `nodeDebugLastPos`,
     * parse each line's `LEVEL|message` prefix, and forward to LogCollector.
     *
     * Concurrency: serialized via `nodeDebugMutex`. FileObserver typically
     * delivers multiple events for a single write (MODIFY + CLOSE_WRITE);
     * without the mutex, two dispatches would read overlapping byte ranges
     * and double-forward each line.
     *
     * Drain loop : for large deltas exceeding
     * `nodeDebugMaxDeltaBytes`, we used to recursively `scope.launch`
     * one coroutine per chunk. That added needless dispatcher overhead
     * for huge backlogs (e.g. Doze release of queued events). Now: a
     * `while` loop within a single coroutine, releasing + reacquiring
     * the mutex between iterations so cancellation and other in-process
     * coroutines waiting on `nodeDebugMutex` (e.g. observer reattach
     * from a re-fired onStartCommand) can interleave while a large
     * backlog drains. The mutex serializes coroutines within :node
     * only — it does not (and cannot) block the :node Node.js writer
     * itself.
     *
     * OOM protection: caps the per-iteration read at
     * `nodeDebugMaxDeltaBytes`. Avoids the toInt() overflow + giant
     * ByteArray allocation that the original unbounded read would hit
     * on a large delta.
     *
     * Line-boundary safety : when chunked reads hit the
     * 256KB cap mid-line, we'd otherwise emit half a line as one entry
     * and the remainder as another, corrupting the log stream. Fix:
     * find the last newline byte in the chunk and only advance lastPos
     * to that boundary, leaving the partial trailing line for the next
     * read to pick up. Pathological case (single line > 256KB): we
     * forward the chunk anyway to avoid an infinite read loop — that
     * line is genuinely too long to handle cleanly, taking the split
     * is better than wedging.
     *
     * Rotation/truncation safety : if Node rotates the log
     * (replacement file + smaller length, or in-place truncate), the
     * file's length will drop below lastPos. Without a reset, the early
     * `length <= pos` guard would silently stop forwarding forever.
     * Detect `length < pos` and reset to 0 so new content is forwarded.
     *
     * Errors : IO/parse failures surface as a WARN log via
     * LogCollector rather than swallowed silently — "node debug log
     * forwarding stopped" was previously invisible to production
     * diagnostics.
     */
    private suspend fun forwardNewNodeDebugLines(debugLogFile: java.io.File) {
        // Drain in a while loop, releasing+reacquiring the mutex between
        // iterations so cancellation and other in-process coroutines
        // waiting on nodeDebugMutex can interleave while a backlog
        // drains. Each iteration reads up to nodeDebugMaxDeltaBytes;
        // loops until file is fully drained or we hit the "wait for
        // newline" partial-line case. Replaces the prior recursive
        // `scope.launch` per chunk which added unnecessary dispatcher
        // overhead for big backlogs.
        var keepDraining = true
        while (keepDraining) {
            keepDraining = nodeDebugMutex.withLock {
                drainOneNodeDebugChunk(debugLogFile)
            }
        }
    }

    private fun ensureNodeDebugDrainWorker(debugLogFile: File) {
        if (nodeDebugDrainChannel != null) return
        val channel = Channel<Unit>(Channel.CONFLATED)
        nodeDebugDrainChannel = channel
        scope.launch {
            for (ignored in channel) {
                if (!isActive) break
                forwardNewNodeDebugLines(debugLogFile)
            }
        }
    }

    private fun requestNodeDebugDrain() {
        nodeDebugDrainChannel?.trySend(Unit)
    }

    /**
     * Single iteration of the node-debug drain loop. Returns true if
     * there's likely more content to drain (caller should re-invoke);
     * false otherwise. Caller holds `nodeDebugMutex`.
     */
    private fun drainOneNodeDebugChunk(debugLogFile: java.io.File): Boolean {
        try {
            if (!debugLogFile.exists()) {
                // File doesn't exist yet (cold boot before Node writes,
                // OR rotation deleted it before re-creating). Reset
                // lastPos so the next CREATE event starts from 0.
                nodeDebugLastPos = 0L
                return false
            }
            val length = debugLogFile.length()
            var pos = nodeDebugLastPos

            // Rotation/truncation: file shrunk, reset to start. Either
            // Node truncated in place or rotation replaced it with a
            // smaller file — either way, lastPos points past the new
            // EOF and we'd silently never forward again without this.
            if (length < pos) {
                pos = 0L
                nodeDebugLastPos = 0L
            }

            if (length <= pos) return false

            val delta = length - pos
            val readSize = minOf(delta, nodeDebugMaxDeltaBytes).toInt()
            val newBytes = java.io.RandomAccessFile(debugLogFile, "r").use { raf ->
                raf.seek(pos)
                ByteArray(readSize).also { raf.readFully(it) }
            }

            // Find the last complete line boundary. Newline is byte 0x0A
            // in both ASCII and UTF-8, so byte-index scanning is safe
            // regardless of multi-byte chars in the line content.
            var lastNewlineIdx = -1
            for (i in newBytes.size - 1 downTo 0) {
                if (newBytes[i] == 0x0A.toByte()) { lastNewlineIdx = i; break }
            }

            // Decide forward strategy:
            // A) Newline found: forward complete lines, keep trailing partial.
            // B) No newline + chunking: single line >256KB. Force-advance
            // to avoid infinite re-read.
            // C) No newline + read whole delta: mid-write partial line.
            // Wait for next event with more bytes.
            val (forwardBytes, advanceBy) = if (lastNewlineIdx >= 0) {
                val complete = newBytes.copyOfRange(0, lastNewlineIdx + 1)
                complete to complete.size
            } else if (delta > readSize) {
                newBytes to newBytes.size
            } else {
                return false // Case C — wait for next event
            }
            nodeDebugLastPos = pos + advanceBy

            // Explicit UTF-8 — Node writes UTF-8; platform-default
            // decoding could mojibake non-ASCII messages on devices
            // where the JVM default differs.
            val lines = String(forwardBytes, Charsets.UTF_8).lines().filter { it.isNotBlank() }
            for (line in lines) {
                val pipeIdx = line.indexOf('|')
                val (level, message) = if (pipeIdx > 0) {
                    val lvl = line.substring(0, pipeIdx)
                    val msg = line.substring(pipeIdx + 1)
                    val parsed = when (lvl) {
                        "ERROR" -> LogLevel.ERROR
                        "WARN" -> LogLevel.WARN
                        "DEBUG" -> LogLevel.DEBUG
                        "INFO" -> LogLevel.INFO
                        else -> null
                    }
                    if (parsed != null) parsed to msg
                    else LogLevel.INFO to line // unknown prefix — treat whole line as INFO
                } else {
                    // Fallback for unparsed lines (old format, raw output)
                    LogLevel.INFO to line
                }
                LogCollector.append("[Node] $message", level)
            }

            // Capped the read and there's still more in the file? Tell
            // caller to keep draining. The drain loop releases + reacquires
            // the mutex between iterations so concurrent writers can
            // interleave.
            return delta > readSize
        } catch (e: Exception) {
            // Surface failures so silent forwarding stops are diagnosable.
            // Previously: catch (_) {} which made "Node logs stopped
            // appearing" impossible to attribute.
            LogCollector.append(
                "[Service] node_debug.log forward error: ${e.javaClass.simpleName}: ${e.message}",
                LogLevel.WARN,
)
            return false // Don't loop on a persistent error
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Init cross-process file bridge (this runs in :node process)
        ServiceState.init(applicationContext)
        LogCollector.init(applicationContext)

        val notification = createNotification("SeekerClaw is running")
        startForeground(NOTIFICATION_ID, notification)

        // Clear any lingering setup-required notification from a previous version.
        getSystemService(android.app.NotificationManager::class.java)
            ?.cancel(SETUP_NOTIFICATION_ID)

        // BAT-513 round-22 device-fix: idempotent re-entry. The
        // foreground service can be re-launched while still running
        // (Dashboard "Deploy Agent" tap when status display is stale,
        // BootReceiver re-firing after a timer wake, system re-binding
        // after the process re-attaches). Pre-fix this re-ran
        // NodeBridge.start() (which short-circuits internally with
        // "Node.js already started" — single-start JNI limitation)
        // AND AndroidBridge.start() / Watchdog.start() — those don't
        // short-circuit, so the second AndroidBridge bind fails with
        // EADDRINUSE on port 8765 and the running bridge from the
        // first start gets killed. The SECOND start's failure cascade
        // then leaves the UI thinking deploy failed even though
        // NodeBridge is still alive on the original instance.
        //
        // Guard: if NodeBridge is already alive, just re-publish
        // RUNNING (so any UI process that observed STARTING/STOPPED
        // catches up) and return. Don't touch NodeBridge / AndroidBridge
        // / Watchdog — they're all still running from the first
        // onStartCommand. Preserve the existing serviceStartTimeMs so
        // uptime is computed against the actual start, not this no-op
        // re-entry.
        if (NodeBridge.isAlive()) {
            ServiceState.updateStatus(ServiceStatus.RUNNING)
            if (ServiceState.serviceStartTimeMs.value == 0L) {
                // Defensive: if somehow the start time was cleared
                // while NodeBridge stayed alive (shouldn't happen, but
                // covers a stale-state scenario), set it to now.
                ServiceState.setServiceStartTimeMs(System.currentTimeMillis())
            }
            LogCollector.append("[Service] Start requested while already running; re-published RUNNING")
            return START_STICKY
        }

        // Owner ID may be blank on first run — this is expected. Node.js auto-detects
        // it from the first Telegram message and persists it via the /config/save-owner
        // bridge callback; the service logs a warning here rather than blocking startup.
        if (ConfigManager.loadConfig(this)?.telegramOwnerId.isNullOrBlank()) {
            LogCollector.append(
                "[Service] Owner ID not configured — first Telegram message will claim ownership.",
                LogLevel.WARN,
)
        }

        // Acquire partial wake lock (CPU stays on)
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SeekerClaw::Service")
        wakeLock?.acquire()

        // Optional server mode: keep screen awake for camera-driven automation.
        try {
            if (ConfigManager.getKeepScreenOn(this)) {
                @Suppress("DEPRECATION")
                val flags = PowerManager.FULL_WAKE_LOCK or
                    PowerManager.ACQUIRE_CAUSES_WAKEUP or
                    PowerManager.ON_AFTER_RELEASE
                screenWakeLock = pm.newWakeLock(flags, "SeekerClaw::ServerMode")
                screenWakeLock?.acquire()
                LogCollector.append("[Service] Server mode enabled: keeping screen awake")
            }
        } catch (e: Exception) {
            LogCollector.append("[Service] Could not read keepScreenOn pref: ${e.message}", LogLevel.WARN)
        }

        // Crash loop protection: if we've restarted too many times quickly, stop trying
        val prefs = getSharedPreferences("seekerclaw_crash", MODE_PRIVATE)
        val lastStart = prefs.getLong("last_start", 0L)
        val crashCount = prefs.getInt("crash_count", 0)
        val now = System.currentTimeMillis()
        if (now - lastStart < 30_000 && crashCount >= 3) {
            LogCollector.append("[Service] Crash loop detected ($crashCount restarts in 30s) — stopping", LogLevel.ERROR)
            ServiceState.updateStatus(ServiceStatus.ERROR)
            stopSelf()
            return START_NOT_STICKY
        }
        val newCrashCount = if (now - lastStart < 30_000) crashCount + 1 else 0
        prefs.edit().putLong("last_start", now).putInt("crash_count", newCrashCount).apply()

        LogCollector.append("[Service] Starting Claw Engine... (attempt ${newCrashCount + 1})")
        ServiceState.updateStatus(ServiceStatus.STARTING)

        // Generate per-boot auth token for bridge security
        val bridgeToken = UUID.randomUUID().toString()
        ServiceState.writeBridgeToken(bridgeToken)

        // Clean up stale config.json from previous crash (H-11 crash recovery)
        val staleConfig = File(File(filesDir, "workspace"), "config.json")
        if (staleConfig.exists()) staleConfig.delete()

        // Write config from encrypted storage (includes bridge token for Node.js)
        // Note: loadConfig() uses SharedPreferences which may be stale in :node process,
        // but writeConfigJson reads the XML file fresh on first access per process.
        ConfigManager.writeConfigJson(this, bridgeToken)
        ConfigManager.writeAgentSettingsJson(this) // non-ephemeral settings for live Node.js reads

        // Validate by checking the written file — more reliable than cross-process SharedPreferences
        val workDir = File(filesDir, "workspace").apply { mkdirs() }
        val configFile = File(workDir, "config.json")
        if (!configFile.exists()) {
            LogCollector.append("[Service] Config not available (config.json not written) — cannot start", LogLevel.ERROR)
            ServiceState.updateStatus(ServiceStatus.ERROR)
            stopSelf()
            return START_NOT_STICKY
        }

        // Seed workspace if first run
        ConfigManager.seedWorkspace(this)

        // Generate PLATFORM.md with current device state (fresh every boot)
        ConfigManager.writePlatformMd(this)

        // Extract nodejs-project assets to internal storage
        NodeBridge.extractBundle(applicationContext)

        // Setup node project directory (workDir already created above)
        val nodeProjectDir = filesDir.absolutePath + "/nodejs-project"

        // Start Node.js runtime
        NodeBridge.start(workDir = workDir.absolutePath, openclawDir = nodeProjectDir)
        if (!NodeBridge.isAlive()) {
            LogCollector.append("[Service] Node runtime failed to initialize", LogLevel.ERROR)
            ServiceState.updateStatus(ServiceStatus.ERROR)
            stopSelf()
            return START_NOT_STICKY
        }

        // Delete config.json after Node.js has had time to read it (ephemeral credentials)
        scope.launch {
            delay(5000) // Give Node.js 5s to read config
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
            LogCollector.append("[Service] AndroidBridge started on 127.0.0.1:8765 (auth required)")
        } catch (e: Exception) {
            LogCollector.append("[Service] Failed to start AndroidBridge: ${e.message}", LogLevel.ERROR)
        }

        // Mark as running
        ServiceState.updateStatus(ServiceStatus.RUNNING)
        LogCollector.append("[Service] Claw Engine is now RUNNING")

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

        // Watch Node.js debug log and forward new lines to LogCollector.
        //
        // BAT-518: replaced the prior 500ms coroutine polling loop with
        // kernel-level inotify (`FileObserver`). Previously this read
        // 172,800 times per day in the :node process even when Node.js
        // wrote nothing. Now event-driven — typical forwarding latency is
        // scheduler-scale (often well under 100ms, but not guaranteed;
        // Doze mode can batch deliveries).
        //
        // Append-aware: lastPos tracks bytes already forwarded; only new
        // bytes are read on each event.
        val debugLogFile = File(workDir, "node_debug.log")

        // Guard: stop any existing observer + start a new one atomically
        // with respect to in-flight forwarders.
        //
        // onStartCommand can fire multiple times in the same service
        // lifetime (START_STICKY redelivery, explicit start while already
        // running, etc.). Without dedup we'd attach multiple observers
        // and each FileObserver event would dispatch N forwarders →
        // duplicate log entries.
        //
        // nodeDebugLastPos is INTENTIONALLY NOT reset on reattach.
        // An earlier iteration reset it to file.length() to "avoid
        // replaying already-forwarded lines," but that was wrong: it
        // could skip un-forwarded bytes that the previous observer had
        // detected but whose forward coroutines hadn't yet run. The
        // correct behavior is to leave nodeDebugLastPos at whatever the
        // previous observer last advanced it to:
        // - First attach (clean process start): lastPos == 0 (default
        // field value), initial read forwards the entire log. This
        // is the same as the pre-BAT-518 polling code, which started
        // each onStartCommand with `var lastPos = 0L`.
        // - Within-process reattach: lastPos == previous value, so
        // initial read picks up exactly the bytes since the last
        // forward. No replay, no dropped bytes.
        //
        // The stop-existing + attach-new sequence happens under
        // nodeDebugMutex to serialize against any forwardNewNodeDebugLines
        // coroutines from the previous observer that are still running.
        // Without the mutex, an in-flight forwarder could see/clobber
        // the new state. The whole sequence is dispatched to scope so
        // onStartCommand returns fast.
        scope.launch {
            var observerAttached = false
            nodeDebugMutex.withLock {
                nodeDebugObserver?.stopWatching()
                nodeDebugObserver = null

                // Defensive: only attach FileObserver if workDir is
                // actually a directory. The earlier `mkdirs()` could have
                // failed silently (filesystem error / permission / a
                // non-directory file at the path). Without this check,
                // FileObserver attachment to a missing or non-directory
                // path silently no-ops and node debug forwarding stops
                // working with no diagnostic.
                if (!workDir.isDirectory) {
                    LogCollector.append(
                        "[Service] workDir not a directory (${workDir.absolutePath}) — node debug log forwarding disabled",
                        LogLevel.ERROR,
)
                    return@withLock
                }

                ensureNodeDebugDrainWorker(debugLogFile)

                // Constants qualified (Java statics not auto-imported into
                // Kotlin function bodies). Mask includes
                // DELETE so log rotation that removes
                // node_debug.log triggers the reader's lastPos reset
                // path, ensuring the next CREATE starts cleanly from 0.
                nodeDebugObserver = object : FileObserver(
                    workDir,
                    FileObserver.MODIFY or FileObserver.CLOSE_WRITE or
                        FileObserver.MOVED_TO or FileObserver.CREATE or
                        FileObserver.DELETE,
) {
                    override fun onEvent(event: Int, path: String?) {
                        // path == null signals either Q_OVERFLOW (kernel
                        // inotify queue overflow — events dropped) or a
                        // directory-level event without filename. Either
                        // way, treat as forced resync from nodeDebugLastPos
                        // so we don't silently miss bytes until the next
                        // write fires a named event.
                        // Q_OVERFLOW isn't a public FileObserver constant
                        // in the Android SDK — null path is the only
                        // signal we get.
                        if (path == "node_debug.log" || path == null) {
                            requestNodeDebugDrain()
                        }
                    }
                }.also { it.startWatching() }
                observerAttached = true
            }

            // Initial read drains any bytes from current lastPos to file
            // end. On first attach (lastPos==0), forwards entire log.
            // On reattach (lastPos > 0), forwards only what's new since
            // the previous observer's last advance. Function takes the
            // mutex internally; ordering with the attach above is
            // preserved because both sequence through the same launch.
            //
            // Skip when workDir was invalid — there's no observer to
            // pair this read with, and forwarding entries from a stale
            // log file we're not watching anymore would be misleading.
            // (R-latest+5 fix.)
            if (observerAttached) {
                requestNodeDebugDrain()
            }
        }

        // BAT-522 (BAT-518 phase 2): persist a one-shot start timestamp
        // instead of writing a recomputed uptime every second. UI derives
        // displayed uptime as `now - serviceStartTimeMs` and ticks
        // locally once per second for display only.
        ServiceState.setServiceStartTimeMs(System.currentTimeMillis())

        LogCollector.append("[Service] Claw Engine started")

        return START_STICKY
    }

    override fun onDestroy() {
        LogCollector.append("[Service] Stopping Claw Engine...")
        // Cancel the service scope FIRST. This stops any in-flight
        // forwardNewNodeDebugLines or observer reattach coroutines that
        // would otherwise race the observer.stopWatching() below — they
        // hold nodeDebugMutex while reading the file, and could land
        // a stale lastPos write or trigger the now-stopped observer's
        // unrelated event handler. cancel() is non-blocking and
        // synchronous; in-flight launches reach a suspension point and
        // exit.
        scopeJob.cancel()
        // Stop the node-debug FileObserver (BAT-518: was nodeDebugJob coroutine).
        nodeDebugObserver?.stopWatching()
        nodeDebugObserver = null
        Watchdog.stop()
        androidBridge?.shutdown()
        NodeBridge.stop()
        wakeLock?.let {
            if (it.isHeld) it.release()
        }
        screenWakeLock?.let {
            if (it.isHeld) it.release()
        }
        ServiceState.clearBridgeToken()
        // Preserve ERROR status (e.g., owner not configured) — only reset to STOPPED on clean exits.
        if (ServiceState.status.value != ServiceStatus.ERROR) {
            ServiceState.updateStatus(ServiceStatus.STOPPED)
        }
        // BAT-522: clear the persisted start timestamp so the next UI
        // launch derives uptime=0 until the service is started again.
        ServiceState.setServiceStartTimeMs(0L)

        // Clean shutdown should clear crash-loop counters. Unexpected deaths won't hit this path.
        // CRITICAL: use commit() not apply(). apply() is async — Android queues the disk
        // write to a worker thread and returns immediately. The killProcess(myPid()) call
        // below sends SIGKILL synchronously, terminating the process before the async
        // write can flush. Result: the reset is LOST. Next process start reads stale
        // crashCount, increments it, and after 3 rapid /provider switches the
        // crash-loop protection in onStartCommand fires and the service stops itself —
        // bricking the agent until the user restarts the app manually. commit() blocks
        // until the disk write completes, guaranteeing the reset persists across the
        // process kill.
        getSharedPreferences("seekerclaw_crash", MODE_PRIVATE)
.edit()
.putLong("last_start", 0L)
.putInt("crash_count", 0)
.commit()

        LogCollector.append("[Service] Claw Engine stopped")
        super.onDestroy()

        // Service is isolated in :node process. Kill process so Node runtime cannot linger.
        android.os.Process.killProcess(android.os.Process.myPid())
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

    // Dismissible notification for actionable setup errors (not tied to service lifetime).
    // Uses ERROR_CHANNEL_ID (IMPORTANCE_HIGH) so the alert is visually prominent.
    private fun createSetupNotification(text: String): Notification {
        val pendingIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
)
        return NotificationCompat.Builder(this, SeekerClawApplication.ERROR_CHANNEL_ID)
.setContentTitle("SeekerClaw")
.setContentText(text)
.setSmallIcon(R.drawable.ic_notification)
.setContentIntent(pendingIntent)
.setOngoing(false) // dismissible — user can swipe away once they open the app
.build()
    }

    companion object {
        private const val NOTIFICATION_ID = 1
        private const val SETUP_NOTIFICATION_ID = 2 // separate ID — persists after service stops
        private val restartHandler = Handler(Looper.getMainLooper())

        fun start(context: Context) {
            restartHandler.removeCallbacksAndMessages(null)
            val intent = Intent(context, SeekerClawService::class.java)
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            restartHandler.removeCallbacksAndMessages(null)
            runCatching {
                ServiceState.init(context.applicationContext)
                // Mirror the same guard as onDestroy() — don't wipe ERROR status on a user-stop.
                if (ServiceState.status.value != ServiceStatus.ERROR) {
                    ServiceState.updateStatus(ServiceStatus.STOPPED)
                }
                // BAT-522: clear the persisted start timestamp so the next UI
                // launch derives uptime=0 until the service is started again.
                ServiceState.setServiceStartTimeMs(0L)
            }
            val intent = Intent(context, SeekerClawService::class.java)
            context.stopService(intent)
        }

        fun restart(context: Context, delayMs: Long = 1200L) {
            stop(context)
            restartHandler.postDelayed(
                { start(context) },
                delayMs,
)
        }
    }
}
