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
import androidx.core.app.NotificationManagerCompat
import com.seekerclaw.app.MainActivity
import com.seekerclaw.app.R
import com.seekerclaw.app.SeekerClawApplication
import com.seekerclaw.app.bridge.AndroidBridge
import com.seekerclaw.app.bridge.NodeControlClient
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.state.XaiOAuthDurabilityGate
import com.seekerclaw.app.state.XaiOAuthTokenStore
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
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File
import java.util.UUID

// ── BAT-1161 P1A: node_debug.log line parser (the Kotlin half of the one-wire contract) ──
// config.js log() writes `LEVEL|epochMs|message` (epochMs = Node Date.now(), 13 digits).
// Backward compatible with the legacy `LEVEL|message` (and raw) format.

internal data class ParsedNodeLine(
    val level: LogLevel,
    val message: String,
    val eventTimeMs: Long?,   // Node event time for new-format lines; null ⇒ receipt time
    val malformedEpoch: Boolean = false, // 2nd token looked epoch-shaped but was out of range
)

private const val LOG_EPOCH_FLOOR_MS = 1_600_000_000_000L // 2020-09-13; older ⇒ not an epoch we emit
private const val LOG_EPOCH_SKEW_MS = 5 * 60 * 1000L      // tolerate 5 min of device clock skew

// Pure, unit-testable. `nowMs` is injected so the range check is deterministic in tests.
internal fun parseNodeDebugLine(line: String, nowMs: Long): ParsedNodeLine {
    val firstPipe = line.indexOf('|')
    if (firstPipe <= 0) return ParsedNodeLine(LogLevel.INFO, line, null) // raw / no level
    val level = when (line.substring(0, firstPipe)) {
        "ERROR" -> LogLevel.ERROR
        "WARN" -> LogLevel.WARN
        "DEBUG" -> LogLevel.DEBUG
        "INFO" -> LogLevel.INFO
        else -> null
    } ?: return ParsedNodeLine(LogLevel.INFO, line, null) // unknown prefix ⇒ whole line as INFO
    val secondPipe = line.indexOf('|', firstPipe + 1)
    // Absent 2nd pipe ⇒ UNCONDITIONAL legacy: everything after the level is the message.
    // (Critical: a bare `WARN|1784100000000` must NOT adopt the epoch and drop its message.)
    if (secondPipe < 0) return ParsedNodeLine(level, line.substring(firstPipe + 1), null)
    val token = line.substring(firstPipe + 1, secondPipe)
    val epochShaped = token.length in 12..14 && token.all { it in '0'..'9' }
    if (epochShaped) {
        val v = token.toLongOrNull()
        if (v != null && v >= LOG_EPOCH_FLOOR_MS && v <= nowMs + LOG_EPOCH_SKEW_MS) {
            // New format. Message = everything after the 2nd pipe (later `|` preserved).
            return ParsedNodeLine(level, line.substring(secondPipe + 1), v)
        }
        // Epoch-shaped but out of range ⇒ corruption: receipt-time, and flag a (throttled) warn.
        return ParsedNodeLine(level, line.substring(firstPipe + 1), null, malformedEpoch = true)
    }
    // 2nd pipe present but not epoch-shaped ⇒ a LEGACY message that merely contains a pipe.
    // Keep the whole remainder as the message, receipt time, and DO NOT warn (no false positive).
    return ParsedNodeLine(level, line.substring(firstPipe + 1), null)
}

// ── BAT-1161 P1A gate 3: pure rotation-decision matrix (unit-tested) ──
// Given the inode currently at node_debug.log, the inode we were tracking, and (on a rotation)
// the inode of node_debug.log.old, decide what the forwarder does. Split top-level vs. rotate
// sub-decision so the drain only stats `.old` on an actual rotation.

internal enum class NodeLogTopAction { MISSING, ROTATED, ADOPT_FIRST, CONTINUE }

internal fun nodeDebugTopAction(currentInode: Long, trackedInode: Long): NodeLogTopAction = when {
    currentInode == -1L -> NodeLogTopAction.MISSING
    trackedInode != -1L && currentInode != trackedInode -> NodeLogTopAction.ROTATED
    trackedInode == -1L -> NodeLogTopAction.ADOPT_FIRST
    else -> NodeLogTopAction.CONTINUE
}

internal enum class NodeLogRotateAction { DRAIN_OLD_TAIL, GAP_EVICTED, GAP_NONE }

internal fun nodeDebugRotateAction(oldInode: Long, trackedInode: Long): NodeLogRotateAction = when {
    oldInode == trackedInode -> NodeLogRotateAction.DRAIN_OLD_TAIL // `.old` IS our generation
    oldInode == -1L -> NodeLogRotateAction.GAP_NONE                // `.old` already gone
    else -> NodeLogRotateAction.GAP_EVICTED                        // `.old` is a newer gen (≥2 rotations)
}

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
    // BAT-1161 P1A gate 3: inode of the node_debug.log generation we're tracking (-1 = unknown).
    // Rotation is detected when the file at the path has a DIFFERENT inode than this — robust
    // under Doze-delayed forwarding, where `length < pos` misses a rotation whose fresh current
    // has already grown past the stale cursor.
    @Volatile private var nodeDebugInode = -1L
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

    // BAT-1161 P1A: throttle the "corrupt epoch token" forward diagnostic to >=60s.
    @Volatile private var lastMalformedEpochWarnMs = 0L

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

    /** inode of a path via Os.stat, or -1 if missing/inaccessible (the rotation identity signal). */
    private fun statInode(path: String): Long = try {
        android.system.Os.stat(path).st_ino
    } catch (_: Exception) { -1L } // ErrnoException (ENOENT, …) or SecurityException

    /**
     * Forward a byte-run of COMPLETE lines to LogCollector — shared by the current-file drain and
     * the `.old`-generation drain — parsing each physical line per the one-wire format.
     */
    private fun forwardBytesToCollector(forwardBytes: ByteArray) {
        val lines = String(forwardBytes, Charsets.UTF_8).lines().filter { it.isNotBlank() }
        val nowMs = System.currentTimeMillis()
        var malformedEpochSeen = false
        for (line in lines) {
            val parsed = parseNodeDebugLine(line, nowMs)
            if (parsed.malformedEpoch) malformedEpochSeen = true
            LogCollector.append("[Node] ${parsed.message}", parsed.level, parsed.eventTimeMs)
        }
        if (malformedEpochSeen && nowMs - lastMalformedEpochWarnMs >= 60_000L) {
            lastMalformedEpochWarnMs = nowMs
            LogCollector.append("[Service] node_debug.log: out-of-range epoch token in a forwarded line (using receipt time)", LogLevel.WARN)
        }
    }

    /**
     * BAT-1161 P1A gate 3: drain a ROTATED-OUT generation (node_debug.log.old) from `fromPos` to
     * EOF, holding ONE stable file descriptor for the whole drain — never reopening by path per
     * chunk (a later rotation could replace the path mid-drain). `.old` is immutable after the
     * rename, so a trailing partial line is force-flushed (no more bytes are coming).
     */
    private fun drainOldGeneration(oldFile: java.io.File, fromPos: Long) {
        if (!oldFile.exists()) return
        try {
            java.io.RandomAccessFile(oldFile, "r").use { raf ->
                val end = raf.length()
                var p = fromPos.coerceIn(0L, end)
                var carry = ByteArray(0)
                while (p < end) {
                    val readSize = minOf(end - p, nodeDebugMaxDeltaBytes).toInt()
                    raf.seek(p)
                    val buf = ByteArray(readSize)
                    raf.readFully(buf)
                    p += readSize
                    val data = if (carry.isEmpty()) buf else carry + buf
                    var lastNl = -1
                    for (i in data.size - 1 downTo 0) { if (data[i] == 0x0A.toByte()) { lastNl = i; break } }
                    if (lastNl >= 0) {
                        forwardBytesToCollector(data.copyOfRange(0, lastNl + 1))
                        carry = data.copyOfRange(lastNl + 1, data.size)
                    } else {
                        carry = data
                    }
                }
                if (carry.isNotEmpty()) forwardBytesToCollector(carry) // immutable → flush the last partial
            }
        } catch (e: Exception) {
            LogCollector.append("[Service] node_debug.log.old drain error: ${e.javaClass.simpleName}", LogLevel.WARN)
        }
    }

    /**
     * Single iteration of the node-debug drain loop. Returns true if there's likely more content
     * to drain (caller should re-invoke); false otherwise. Caller holds `nodeDebugMutex`.
     *
     * BAT-1161 P1A gate 3: rotation is detected by IDENTITY (inode), not `length < pos`. On an
     * inode change the renamed `.old` generation is drained to EOF (stable FD) before the cursor
     * resets to the fresh current. Exact-once for RETAINED generations; a ≥2-rotation burst evicts
     * the single archive → the gap is detected and WARNed rather than silently lost.
     */
    private fun drainOneNodeDebugChunk(debugLogFile: java.io.File): Boolean {
        try {
            val currentInode = statInode(debugLogFile.path)
            when (nodeDebugTopAction(currentInode, nodeDebugInode)) {
                NodeLogTopAction.MISSING -> {
                    // Missing (cold boot before Node writes, or rotation deleted before re-creating).
                    nodeDebugLastPos = 0L
                    nodeDebugInode = -1L
                    return false
                }
                NodeLogTopAction.ROTATED -> {
                    // The file we were reading was renamed to `.old`.
                    val oldFile = java.io.File(debugLogFile.path + ".old")
                    when (nodeDebugRotateAction(statInode(oldFile.path), nodeDebugInode)) {
                        NodeLogRotateAction.DRAIN_OLD_TAIL ->
                            // Normal single rotation — our generation is now `.old`; drain its tail to EOF.
                            drainOldGeneration(oldFile, nodeDebugLastPos)
                        NodeLogRotateAction.GAP_NONE ->
                            LogCollector.append("[Service] node_debug.log: rotation gap — previous generation unavailable", LogLevel.WARN)
                        NodeLogRotateAction.GAP_EVICTED -> {
                            // ≥2 rotations before we drained: our generation was evicted (one archive).
                            // Recover the surviving intermediate generation; the evicted tail stays
                            // only in the authoritative node_debug.log on disk.
                            LogCollector.append("[Service] node_debug.log: rotation gap — a log generation was evicted before forwarding (still on disk in node_debug.log)", LogLevel.WARN)
                            drainOldGeneration(oldFile, 0L)
                        }
                    }
                    nodeDebugLastPos = 0L
                    nodeDebugInode = currentInode
                    // fall through: drain the fresh current from 0
                }
                NodeLogTopAction.ADOPT_FIRST ->
                    // First drain for this file — adopt its identity, keep the (watermark) cursor.
                    nodeDebugInode = currentInode
                NodeLogTopAction.CONTINUE -> { /* same generation — fall through to the read below */ }
            }

            val length = debugLogFile.length()
            var pos = nodeDebugLastPos
            // Defensive only: Node rotates by rename (new inode), never truncates in place, so a
            // same-inode shrink shouldn't happen — but reset rather than stall if it ever does.
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

            forwardBytesToCollector(forwardBytes)

            // Capped the read and there's still more in the file? Tell
            // caller to keep draining. The drain loop releases + reacquires
            // the mutex between iterations so concurrent writers can
            // interleave.
            return delta > readSize
        } catch (e: Exception) {
            // Surface failures so silent forwarding stops are diagnosable.
            // Previously: catch (_) {} which made "Node logs stopped
            // appearing" impossible to attribute.
            // BAT-1161 gate 6b: class only, never ${e.message} (a file path/errno could carry
            // a token-adjacent string; the class name is enough to attribute a forwarding stall).
            LogCollector.append(
                "[Service] node_debug.log forward error: ${e.javaClass.simpleName}",
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

        // BAT-1155 boot reconcile (amendment 3): convert an armed rotation marker to durable reauth
        // and clear a stale stop fence — MUST run BEFORE writeConfigJson so the emitted token reflects
        // the conversion (a potentially-consumed refresh token is never handed to the provider).
        reconcileXaiOAuthOnBoot()

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

        // BAT-1161 P1A gate 3: startup watermark. Capture the retained node_debug.log's identity
        // (inode) + EOF BEFORE Node starts, so this :node session forwards only its OWN new lines
        // (no replay of the whole retained log into the 1 MB mirror on every routine restart) and
        // correctly follows a rotation that happens during startup — the pre-Node EOF is the
        // session boundary. Only runs on a fresh process start; a re-fired onStartCommand with
        // NodeBridge already alive returned earlier and keeps the live cursor.
        val nodeDebugAtStart = File(workDir, "node_debug.log")
        nodeDebugInode = statInode(nodeDebugAtStart.path)
        nodeDebugLastPos = if (nodeDebugAtStart.exists()) nodeDebugAtStart.length() else 0L

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

        // BAT-582 Phase 3: periodic sweep of stale Burner Wallet cap
        // reservations. Every 30s, any reservation whose expiresAtMs has
        // passed is auto-released so its committed-to-cap bytes don't
        // permanently consume the daily window. The coroutine lives on
        // [scope] (SupervisorJob), so it's cancelled atomically with the
        // service in onDestroy.
        //
        // BAT-582 R1 (PR #364 review): the sweep is gated on the burner
        // KEY file existing — not on `burner_caps.json`. The previous
        // version used the caps file as a configured-proxy, which was
        // wrong: `wipe()` zeros caps but didn't (until this commit)
        // delete the caps file itself, so a wiped wallet would still
        // pass the gate and run sweepStale + allocate CapEnforcer
        // forever. The KEY file is the actual ground truth for "burner
        // is configured" — the wipe flow deletes it (KeyVault.wipe),
        // so post-wipe the gate goes false within one tick. The wipe
        // flow ALSO deletes burner_caps.json now (defense-in-depth +
        // reclaims a few hundred bytes), but the gate's correctness
        // doesn't depend on that.
        //
        //   (a) Gate via [EncryptedPrefsKeyVault.isConfigured]. Two
        //       `fstat` calls: parent dir + key file in
        //       `filesDir/burner_keys/burner`. Pure read — no mkdirs,
        //       so a never-configured install never grows the dir as
        //       a side effect of the gate (R4 fix). Pre-import the file
        //       is absent → gate is false → no CapEnforcer allocation.
        //       Post-import the file exists → gate is true → sweep runs
        //       every 30s. Post-wipe the file is gone → gate goes false
        //       → sweep stops within 30s of wipe completing.
        //   (b) Once we DO touch CapEnforcer.get(applicationContext),
        //       cache the reference so subsequent ticks skip the
        //       singleton-getter overhead. The first call pays for
        //       CrossProcessStore + FileObserver allocation; subsequent
        //       calls were already O(1) but the cache makes that
        //       explicit and makes the optimization survive any future
        //       refactor of CapEnforcer.get's hot path.
        val burnerKeyVault = com.seekerclaw.app.data.wallet.EncryptedPrefsKeyVault(
            applicationContext,
        )
        var cachedCapEnforcer: com.seekerclaw.app.data.caps.CapEnforcer? = null
        scope.launch {
            while (isActive) {
                try {
                    // isConfigured is two fstats (parent dir + key file)
                    // in the app's private dir — same cost class as the
                    // previous capsFile.exists() check, but tracks the
                    // actual configured state instead of leftover state.
                    // Pure read: does NOT mkdirs the parent as a side
                    // effect (R4 fix — earlier impl created
                    // burner_keys/ on every tick for never-configured
                    // installs).
                    if (burnerKeyVault.isConfigured(
                            com.seekerclaw.app.bridge.burner.BurnerBridgeEndpoints.BURNER_ID,
                        )
                    ) {
                        val enforcer = cachedCapEnforcer
                            ?: com.seekerclaw.app.data.caps.CapEnforcer
                                .get(applicationContext)
                                .also { cachedCapEnforcer = it }
                        enforcer.sweepStale()
                    }
                } catch (e: Exception) {
                    // Sweep failures should never bring the service down.
                    // Log and keep going; next iteration retries.
                    LogCollector.append(
                        "[Service] Burner cap sweepStale error: ${e.javaClass.simpleName}: ${e.message}",
                        LogLevel.WARN,
                    )
                }
                delay(30_000L)
            }
        }

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
        // BAT-525 / BAT-1155: flush Node BEFORE everything else — the bridge token + Node process
        // must both still be alive for the loopback POST /shutdown/flush to land, and it precedes
        // scope cancel / observer stop / NodeBridge.stop / clearBridgeToken. The work (the stop-fence
        // durability gate = network I/O + a disk CAS drain, then a best-effort session summary) must
        // NOT run on the service main thread (the gate's own off-main contract / StrictMode / ANR —
        // CodeRabbit). Dispatch it to [stopExecutor] and bounded-WAIT here so the terminal killProcess
        // below still happens only AFTER durability is resolved — or the bound elapses, in which case
        // the durable fence/rotation marker already on disk protects the next boot regardless.
        try {
            stopExecutor.submit { flushNodeBeforeProcessKill() }
                .get(ONDESTROY_FLUSH_WAIT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
        } catch (e: Exception) {
            LogCollector.append("[Shutdown] durability flush did not complete off-thread within ${ONDESTROY_FLUSH_WAIT_MS}ms (${e.javaClass.simpleName})", LogLevel.WARN)
        }
        // Cancel the service scope before stopping the FileObserver
        // below. This stops any in-flight forwardNewNodeDebugLines or
        // observer reattach coroutines that would otherwise race
        // observer.stopWatching() — they hold nodeDebugMutex while
        // reading the file, and could land a stale lastPos write or
        // trigger the now-stopped observer's unrelated event handler.
        // cancel() is non-blocking and synchronous; in-flight launches
        // reach a suspension point and exit.
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

    /**
     * BAT-525: ask `:node` to flush pending session summaries + dirty
     * SQL.js mutations BEFORE [killProcess]. Without this hook, the
     * last ~60s of `api_request_log` rows in BAT-523's debounce
     * window are lost on every user-initiated Stop.
     *
     * Bounded by [timeoutMs] (default 2s) so a hung Node can't
     * deadlock the service teardown — the unconditional [killProcess]
     * call below this still fires either way.
     *
     * R3 Copilot: delegates to [NodeControlClient.flushShutdown] so
     * the shared `X-Bridge-Token` auth + JSON body + response-drain
     * + connect/read-timeout logic stays in one place. Pre-fix this
     * rolled its own [HttpURLConnection] client without setting the
     * auth header, which would have 401'd at the bridge-token gate
     * `/shutdown/flush` enforces — the flush would never have run
     * in production.
     */
    private fun flushNodeBeforeProcessKill(timeoutMs: Long = 2_500L) {
        // (1) xAI OAuth durability (BAT-1155 stop-fence protocol). The gate decides on DURABLE STORE
        //     state — arm the stop fence, probe the rotation marker, drain an in-flight rotation, and
        //     conditionally fail-close — so it is correct even when :node is unreachable during
        //     teardown (the original soak brick was fail-closing on a null control probe). This is the
        //     TERMINAL path (we can't keep the service alive), so the boolean is ignored: the durable
        //     fence / reauth mark it leaves is what the next boot honours. Idempotent with the pre-stop
        //     gate — if stopWithDurability already resolved durability, this returns fast.
        try {
            XaiOAuthDurabilityGate.ensureDurableBeforeStop()
        } catch (e: Exception) {
            LogCollector.append("[Shutdown] xAI durability guard threw: ${e.message}", LogLevel.WARN)
        }
        // (2) Best-effort session summary + SQL.js flush (BAT-525). NOT durability-critical — a slow or
        //     failed summary is acceptable (the durable state above is independent of it). Skipped when
        //     Node is already gone.
        if (NodeBridge.isAlive()) {
            runBlocking { withTimeoutOrNull(timeoutMs) { NodeControlClient.flushShutdown() } }
        }
    }

    /**
     * BAT-1155 boot reconcile (Codex amendment 3), run in the `:node` process BEFORE the config is
     * emitted / the provider is activated:
     *  1. If a rotation marker is armed for the current live epoch, a refresh POST was in flight when
     *     the prior process died → the on-disk refresh token is POTENTIALLY CONSUMED → durably convert
     *     it to `reauthRequired` (which also clears the marker) so the provider can never POST it.
     *     (Belt: `ConfigManager.loadConfig` also blanks the token when the marker is armed, so even a
     *     failed conversion emits no usable token this boot; the next boot re-tries.)
     *  2. Clear a stale stop fence left by the prior stop generation so the reborn process is never
     *     wedged (fences never carry across a process boundary).
     */
    private fun reconcileXaiOAuthOnBoot() {
        if (!XaiOAuthTokenStore.isInitialized) return
        val rec = XaiOAuthTokenStore.read()
        val live = !rec.tombstone && !rec.reauthRequired && rec.accessTokenEnc.isNotEmpty()
        if (live && rec.rotationInFlightEpoch == rec.epoch) {
            when (val r = XaiOAuthTokenStore.markReauth(rec.epoch)) {
                is XaiOAuthTokenStore.Result.Ok ->
                    LogCollector.append("[Boot] xAI rotation marker armed at boot → durably converted to reauth (epoch=${r.record.epoch})", LogLevel.WARN)
                is XaiOAuthTokenStore.Result.Conflict ->
                    LogCollector.append("[Boot] xAI rotation marker: epoch advanced (${rec.epoch}→${r.currentEpoch}) — winning family intact", LogLevel.INFO)
                else ->
                    LogCollector.append("[Boot] xAI rotation marker conversion could not persist ($r) — loadConfig will still blank the token this boot", LogLevel.WARN)
            }
        }
        XaiOAuthTokenStore.clearStopFence()
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
        // onDestroy dispatches the terminal durability flush to [stopExecutor] and bounded-waits this
        // long. Covers the worst case (gate BUDGET_MS 2500 + summary flush 2500) with margin; if it
        // elapses, the durable on-disk fence/marker still protects the next boot.
        private const val ONDESTROY_FLUSH_WAIT_MS = 6_000L
        private val restartHandler = Handler(Looper.getMainLooper())

        // BAT-1155 blocker-1: the pre-stop durability gate does blocking loopback I/O
        // (Node flush) + a disk CAS, so it MUST run off the main thread or it ANRs.
        // Single-thread so concurrent Stop/Restart presses serialize instead of racing
        // the store. Daemon so it never blocks process exit.
        private val stopExecutor = java.util.concurrent.Executors.newSingleThreadExecutor { r ->
            Thread(r, "xai-stop-durability").apply { isDaemon = true }
        }

        /**
         * Max times a non-durable Stop keeps the service ALIVE and retries (Codex
         * blocker-1: prefer keep-alive over killing a family we couldn't save). Bounded
         * so a truly-broken disk can't wedge Stop forever — after this we OS-fallback stop.
         */
        private const val MAX_KEEPALIVE_STOP_ATTEMPTS = 2
        private const val KEEPALIVE_RETRY_MS = 1_500L

        /**
         * Absolute ceiling on total [stopWithDurability] attempts, including the abandoned-stop
         * fence-clear retries beyond [MAX_KEEPALIVE_STOP_ATTEMPTS] (BAT-1155 CodeRabbit round-2). A
         * fence that cannot be cleared must NOT resume `:node` (a completing rotation would leave a
         * live-but-fenced family); we retry instead — a marked reauth makes the retry resolve as a
         * durable clean kill. Bounded so a broken disk can't retry forever; the ~15s quiesce-lease
         * lapse is the ultimate backstop past this. Stays well under that lease at KEEPALIVE_RETRY_MS.
         */
        private const val MAX_STOP_ATTEMPTS = 6

        /** Bounded best-effort /unquiesce retries for an abandoned Stop; the Node lease backstops the rest. */
        private const val MAX_UNQUIESCE_ATTEMPTS = 5
        private const val UNQUIESCE_RETRY_MS = 1_500L

        // BAT-1155 Codex re-review blocker: renew the Node quiesce lease from an INDEPENDENT thread
        // (not the main looper) from the moment durability is proven until kill, so a delayed
        // main-looper handoff can't let the lease expire and admit a rotation before teardown.
        // RENEW well under quiesce.js LEASE_MS (15s).
        private const val LEASE_RENEW_MS = 5_000L
        @Volatile private var leaseRenewMs = LEASE_RENEW_MS // shortened in tests to observe the cadence
        internal fun setLeaseRenewMsForTest(ms: Long) { leaseRenewMs = ms }
        // Renewal is LIFECYCLE-bound, not failure/time-bound: it runs until an EXPLICIT
        // stopLeaseRenewal() (or a newer start) supersedes it, or the process dies (the thread is
        // daemon). A failed renew POST is NOT evidence :node is dead — keep retrying so a transient
        // outage can't let the lease lapse while teardown is still pending. A GENERATION token
        // (not a reusable boolean) ensures a stale in-flight renewer can never observe a later
        // "active" and rejoin a newer lifecycle.
        private val leaseRenewGen = java.util.concurrent.atomic.AtomicInteger(0)

        fun start(context: Context) {
            restartHandler.removeCallbacksAndMessages(null)
            // Cancel any lingering lease renewer (esp. from a restart's stop phase) BEFORE booting
            // a new :node, so an old renewer can never re-quiesce the freshly-started process.
            stopLeaseRenewal()
            val intent = Intent(context, SeekerClawService::class.java)
            context.startForegroundService(intent)
        }

        /**
         * User-initiated Stop. Runs the xAI OAuth pre-stop durability gate BEFORE
         * teardown so a mid-flight token rotation is either persisted or fail-closed
         * marked — never killed into a family-revoking replay (BAT-1155 blocker-1).
         */
        fun stop(context: Context) {
            restartHandler.removeCallbacksAndMessages(null)
            stopLeaseRenewal() // cancel any renewer from a prior stop before starting a new gate
            stopWithDurability(context.applicationContext, attempt = 0, onStopped = null)
        }

        fun restart(context: Context, delayMs: Long = 1200L) {
            restartHandler.removeCallbacksAndMessages(null)
            stopLeaseRenewal()
            val appCtx = context.applicationContext
            // Gate durability BEFORE the stop, then schedule start on the main looper.
            // A restart of a live oauth family is just as capable of stranding a rotation
            // as a plain Stop, so it goes through the same gate.
            stopWithDurability(appCtx, attempt = 0) {
                restartHandler.postDelayed({ start(appCtx) }, delayMs)
            }
        }

        /**
         * Run the durability gate off-main; on success (or exhausted keep-alive budget)
         * finish the stop and fire [onStopped]; otherwise keep the service alive and
         * retry after a short delay. All teardown/status writes happen in [finishStop].
         */
        private fun stopWithDurability(appCtx: Context, attempt: Int, onStopped: (() -> Unit)?) {
            stopExecutor.execute {
                val durable = try {
                    XaiOAuthDurabilityGate.ensureDurableBeforeStop()
                } catch (e: Exception) {
                    // CodeRabbit: fail CLOSED, not open. A gate exception means durability is
                    // UNCONFIRMED — treat it as not-durable so the stop keeps the service alive
                    // and retries (or OS-fallback stops after the bounded attempts), instead of
                    // blindly killing into a possibly-consumed-token replay.
                    LogCollector.append(
                        "[Shutdown] durability gate threw (${e.javaClass.simpleName}: ${e.message}) — treating as NOT durable",
                        LogLevel.ERROR,
                    )
                    false
                }
                when {
                    // Durable → tear down for real. Start the lease renewer FIRST (Codex re-review
                    // blocker) so quiescence stays armed across the main-looper handoff to the kill.
                    durable -> {
                        startLeaseRenewal()
                        restartHandler.post {
                            clearDurabilityStuckNotice(appCtx)
                            finishStop(appCtx)
                            onStopped?.invoke()
                        }
                    }
                    // Not durable, budget remaining → keep alive, surface the state, retry.
                    attempt < MAX_KEEPALIVE_STOP_ATTEMPTS -> {
                        LogCollector.append(
                            "[Shutdown] finishing secure session save — keeping service alive, retry ${attempt + 1}/$MAX_KEEPALIVE_STOP_ATTEMPTS",
                            LogLevel.WARN,
                        )
                        restartHandler.post { postDurabilityStuckNotice(appCtx) }
                        restartHandler.postDelayed({ stopWithDurability(appCtx, attempt + 1, onStopped) }, KEEPALIVE_RETRY_MS)
                    }
                    // Codex re-review blocker-1: a controlled Stop must NEVER call stopService
                    // without positive durability. Retries exhausted → keep the service ALIVE
                    // (only an actual OS force-stop may bypass the gate) and leave the notice up;
                    // do NOT finishStop and do NOT fire onStopped — a restart that can't durably
                    // save the rotated token must not proceed into a consumed-token replay either.
                    // Relabeling a blind kill "OS fallback" does not make a broken disk safe.
                    else -> {
                        LogCollector.append(
                            "[Shutdown] durability UNCONFIRMED after ${attempt + 1} attempts — service kept ALIVE " +
                                "(the session token could not be safely saved; force-stop from system settings to override)",
                            LogLevel.ERROR,
                        )
                        // BAT-1155 M1 (+ CodeRabbit round-2): the durability gate armed a durable stop
                        // fence as its FIRST action. Abandoning the stop (keeping :node alive) WITHOUT
                        // clearing that fence would leave the resumed process's next refresh silently
                        // Fenced→skip (no POST, no reconnect) until a full restart. resolveAbandonedStop
                        // returns true ONLY when the fence is durably cleared — a reauth mark alone is
                        // insufficient (a completing in-flight rotation clears reauth AND rebases the
                        // still-armed fence forward). Resume ONLY behind a cleared fence.
                        val fenceCleared = try {
                            XaiOAuthDurabilityGate.resolveAbandonedStop()
                        } catch (e: Exception) {
                            LogCollector.append(
                                "[Shutdown] resolveAbandonedStop threw (${e.javaClass.simpleName}: ${e.message})",
                                LogLevel.ERROR,
                            )
                            false
                        }
                        // The notice is managed PER-BRANCH below (CodeRabbit round-3): a RESUME path
                        // (fence cleared / last-resort) puts :node back to normal → CLEAR the
                        // dismiss-resistant "force-stop to override" notice; a RETRY path stays
                        // stopped → keep it posted. (A blanket re-post here would strand it on the
                        // resume paths, showing "stuck" forever after the agent already recovered.)
                        when {
                            // Fence durably cleared → safe to resume: CANCEL lease renewal (let the
                            // lease lapse) and unquiesce so :node resumes. A completing rotation can no
                            // longer rebase an already-cleared fence, so no live-but-fenced family.
                            fenceCleared -> {
                                stopLeaseRenewal()
                                restartHandler.post { clearDurabilityStuckNotice(appCtx) }
                                unquiesceUntilConfirmed(appCtx, 0)
                            }
                            // Fence NOT cleared → do NOT resume into it. Retry the stop (bounded): if
                            // resolveAbandonedStop marked reauth, the retry's gate sees a not-live
                            // family → durable → a CLEAN kill (boot blanks the token + clears the
                            // fence) — this resolves within one retry, well inside the quiesce lease.
                            // If reauth could NOT be marked either (store I/O broken for the mark too),
                            // the disk gets more chances; and if the ~15s quiesce lease lapses before we
                            // finish (each gate attempt can take up to BUDGET_MS), :node self-resumes
                            // FENCED on its own. That is FAIL-CLOSED (a Fenced refresh returns 'skip'
                            // and cannot present the token to xAI → no consumption, no revocation) and
                            // boot-recoverable — the same terminal state as the last-resort branch
                            // below. We do NOT re-arm the lease here (startLeaseRenewal is the
                            // durability-PROVEN-kill mechanism); actively re-quiescing each retry is a
                            // flagged hardening follow-up (Codex), not a safety gate.
                            attempt < MAX_STOP_ATTEMPTS -> {
                                LogCollector.append(
                                    "[Shutdown] xAI stop fence not yet cleared — staying stopped, retry ${attempt + 1}/$MAX_STOP_ATTEMPTS",
                                    LogLevel.WARN,
                                )
                                // Still stopped/retrying → keep the notice up.
                                restartHandler.post { postDurabilityStuckNotice(appCtx) }
                                restartHandler.postDelayed({ stopWithDurability(appCtx, attempt + 1, onStopped) }, KEEPALIVE_RETRY_MS)
                            }
                            // Store I/O broken past the retry ceiling (couldn't clear the fence OR mark
                            // reauth). Least-bad: resume — the quiesce lease would lapse and resume
                            // fenced anyway, and the still-armed fence is boot-recoverable once the disk
                            // recovers (reconcileXaiOAuthOnBoot clears it; loadConfig blanks a token
                            // whose family is marker/reauth-flagged).
                            else -> {
                                LogCollector.append(
                                    "[Shutdown] xAI stop fence UNCLEARABLE after $MAX_STOP_ATTEMPTS attempts (store I/O broken) — " +
                                        "resuming; boot reconcile is the backstop",
                                    LogLevel.ERROR,
                                )
                                stopLeaseRenewal()
                                // We ARE resuming :node here → clear the "stuck" notice (the xAI-fenced
                                // degradation surfaces separately via the reconnect path, not this notice).
                                restartHandler.post { clearDurabilityStuckNotice(appCtx) }
                                unquiesceUntilConfirmed(appCtx, 0)
                            }
                        }
                    }
                }
            }
        }

        /** Terminal teardown: status/uptime reset + [Context.stopService]. Runs on the main looper. */
        private fun finishStop(appCtx: Context) {
            runCatching {
                ServiceState.init(appCtx)
                // Mirror the same guard as onDestroy() — don't wipe ERROR status on a user-stop.
                if (ServiceState.status.value != ServiceStatus.ERROR) {
                    ServiceState.updateStatus(ServiceStatus.STOPPED)
                }
                // BAT-522: clear the persisted start timestamp so the next UI
                // launch derives uptime=0 until the service is started again.
                ServiceState.setServiceStartTimeMs(0L)
            }
            appCtx.stopService(Intent(appCtx, SeekerClawService::class.java))
        }

        // BAT-1155 blocker-1: a dismiss-resistant notice shown while a controlled Stop is
        // held open because the xAI OAuth token could not yet be durably saved. It tells the
        // user the agent is deliberately still running (and that a system force-stop is the
        // override) rather than silently ignoring their Stop. Best-effort (POST_NOTIFICATIONS
        // may be denied) — the durability invariant does not depend on it landing.
        private const val DURABILITY_NOTICE_ID = 3

        private fun postDurabilityStuckNotice(appCtx: Context) {
            runCatching {
                val pi = PendingIntent.getActivity(
                    appCtx, 0,
                    Intent(appCtx, MainActivity::class.java),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
                val notification = NotificationCompat.Builder(appCtx, SeekerClawApplication.ERROR_CHANNEL_ID)
                    .setContentTitle("Finishing secure session save")
                    .setContentText("Keeping the agent running until your Grok sign-in is safely saved.")
                    .setStyle(
                        NotificationCompat.BigTextStyle().bigText(
                            "Keeping the agent running until your Grok sign-in is safely saved, so it isn't " +
                                "lost on the next restart. If this persists, force-stop the app from system settings.",
                        ),
                    )
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentIntent(pi)
                    .setOngoing(true)
                    .build()
                NotificationManagerCompat.from(appCtx).notify(DURABILITY_NOTICE_ID, notification)
            }
        }

        private fun clearDurabilityStuckNotice(appCtx: Context) {
            runCatching { NotificationManagerCompat.from(appCtx).cancel(DURABILITY_NOTICE_ID) }
        }

        /**
         * Codex re-review major-2: keep trying to unquiesce an abandoned (kept-alive) Stop with
         * bounded backoff until a POST is confirmed, so a single transient failure can't leave the
         * agent frozen. If all attempts fail, the Node quiesce lease still auto-resumes — this only
         * shortens that window. Runs on [stopExecutor]; scheduling on [restartHandler] is cancelled
         * by the next start()/stop() (removeCallbacksAndMessages).
         */
        /**
         * Codex re-review blocker: start renewing the Node quiesce lease from an independent daemon
         * thread. Called the instant durability is proven (before finishStop), it keeps the lease
         * armed across the main-looper handoff to onDestroy/kill — so quiescence can't lapse and
         * admit a rotation in that window. LIFECYCLE-bound: it runs until an EXPLICIT
         * [stopLeaseRenewal] (or a newer lifecycle supersedes its generation) or the process dies.
         * It does NOT exit on a renew POST failure or any iteration/time cap — a failed POST is not
         * proof :node is dead, so a transient outage must not let the lease lapse mid-Stop.
         */
        internal fun startLeaseRenewal() {
            val myGen = leaseRenewGen.incrementAndGet() // claim a generation; supersedes any prior renewer
            Thread {
                // Renew until THIS generation is superseded (explicit stop or a newer lifecycle) or
                // the process dies. A failed POST is ignored — quiescence must not lapse on a
                // transient outage while a controlled Stop is still pending.
                while (leaseRenewGen.get() == myGen) {
                    try { Thread.sleep(leaseRenewMs) } catch (e: InterruptedException) { break }
                    if (leaseRenewGen.get() != myGen) break
                    runCatching { runBlocking { NodeControlClient.quiesce() } }
                }
            }.apply { isDaemon = true; name = "xai-lease-renewer"; start() }
        }

        /** Supersede any active renewer generation so it exits on its next check. */
        internal fun stopLeaseRenewal() {
            leaseRenewGen.incrementAndGet()
        }

        private fun unquiesceUntilConfirmed(appCtx: Context, attempt: Int) {
            stopExecutor.execute {
                val ok = runCatching { runBlocking { NodeControlClient.unquiesce() } }.getOrDefault(false)
                if (ok) return@execute
                if (attempt < MAX_UNQUIESCE_ATTEMPTS) {
                    restartHandler.postDelayed({ unquiesceUntilConfirmed(appCtx, attempt + 1) }, UNQUIESCE_RETRY_MS)
                } else {
                    LogCollector.append(
                        "[Shutdown] unquiesce not confirmed after ${attempt + 1} tries — Node quiesce lease will auto-resume",
                        LogLevel.WARN,
                    )
                }
            }
        }
    }
}
