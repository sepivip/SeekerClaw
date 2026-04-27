package com.seekerclaw.app.util

import android.content.Context
import android.os.FileObserver
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File

data class LogEntry(
    val timestamp: Long = System.currentTimeMillis(),
    val message: String,
    val level: LogLevel = LogLevel.INFO,
)

enum class LogLevel { DEBUG, INFO, WARN, ERROR }

object LogCollector {
    private const val TAG = "LogCollector"
    private const val MAX_LINES = 300
    private const val LOG_FILE_NAME = "service_logs"

    private val _logs = MutableStateFlow<List<LogEntry>>(emptyList())
    val logs: StateFlow<List<LogEntry>> = _logs

    /** Total entries in the buffer (pre-filter). UI can read this for diagnostics. */
    val bufferedCount: Int get() = _logs.value.size

    /** Timestamp of the most recent log entry, or null if empty. */
    val lastTimestamp: Long? get() = _logs.value.lastOrNull()?.timestamp

    private var logFile: File? = null
    private var fileObserver: FileObserver? = null
    @Volatile private var lastReadPosition = 0L
    private val scope = CoroutineScope(Dispatchers.IO)

    // Serializes concurrent readNewFromFile invocations triggered by
    // overlapping FileObserver events. FileObserver commonly emits both
    // MODIFY and CLOSE_WRITE for a single write — without this mutex,
    // both events would launch on Dispatchers.IO, both would read
    // lastReadPosition, both would parse overlapping byte ranges,
    // and append() would emit duplicate log entries. (Copilot R1.)
    private val readMutex = Mutex()

    // Lock for all in-memory _logs mutations to prevent TOCTOU races.
    // Multiple threads (Watchdog IO, ServiceState IO, file polling IO) call append()
    // concurrently — without this lock, concurrent read-modify-write on _logs.value
    // silently drops entries (the primary cause of the "empty console" bug).
    private val logsLock = Any()

    fun init(context: Context) {
        logFile = File(context.filesDir, LOG_FILE_NAME)
    }

    fun append(message: String, level: LogLevel = LogLevel.INFO) {
        val entry = LogEntry(message = message, level = level)

        // Thread-safe update of in-memory list
        synchronized(logsLock) {
            val current = _logs.value.toMutableList()
            current.add(entry)
            if (current.size > MAX_LINES) {
                current.removeAt(0)
            }
            _logs.value = current
        }

        // Also write to shared file (for cross-process access)
        writeToFile(entry)
    }

    fun clear() {
        synchronized(logsLock) {
            _logs.value = emptyList()
            try {
                logFile?.writeText("")
                lastReadPosition = 0L
            } catch (e: Exception) {
                Log.w(TAG, "Failed to clear log file", e)
            }
        }
    }

    /**
     * Start watching the log file for cross-process updates.
     * Call this from the UI process (Application.onCreate).
     *
     * BAT-518: replaced the prior 1s coroutine polling loop with kernel-
     * level inotify (`FileObserver`). Same external contract — the
     * `_logs` StateFlow updates when the underlying file is appended —
     * but with zero idle CPU cost. Previously this method ran 86,400
     * disk reads per day in main process even when no new logs arrived.
     *
     * Append-aware: the existing `readNewFromFile` already tracks
     * `lastReadPosition` and only reads new bytes from that offset.
     * FileObserver triggers it; the byte-tracking logic is unchanged.
     *
     * Watching the parent directory rather than the file itself so we
     * still receive events if the file is recreated (e.g. clear() →
     * subsequent append from another process).
     */
    fun startWatching(context: Context) {
        init(context)

        // Guard: skip if observer already attached (mirrors the BAT-217 fix).
        if (fileObserver != null) {
            Log.d(TAG, "startWatching: already active, skipping")
            return
        }

        // Read existing logs from file so the UI has data immediately
        readAllFromFile()
        Log.d(TAG, "startWatching: loaded ${_logs.value.size} entries from file; attaching FileObserver")

        val parent = logFile?.parentFile ?: run {
            Log.w(TAG, "startWatching: no parent dir, skipping FileObserver")
            return
        }

        // Watch the parent dir, dispatch on `service_logs` filename. Mask
        // covers append-style writes (MODIFY / CLOSE_WRITE), atomic-rename
        // writes (MOVED_TO), and re-creation after clear() (CREATE).
        // Constants are qualified (Java statics not auto-imported into
        // Kotlin function bodies). (Copilot R1.)
        fileObserver = object : FileObserver(
            parent,
            FileObserver.MODIFY or FileObserver.CLOSE_WRITE or FileObserver.MOVED_TO or FileObserver.CREATE,
        ) {
            override fun onEvent(event: Int, path: String?) {
                if (path == LOG_FILE_NAME) {
                    // Dispatch off the FileObserver thread. readNewFromFile
                    // serializes via readMutex internally so concurrent
                    // dispatches (FileObserver often emits MODIFY +
                    // CLOSE_WRITE for one write) don't double-read the
                    // same byte range.
                    scope.launch { readNewFromFile() }
                }
            }
        }.also { it.startWatching() }
    }

    /**
     * Backwards-compat alias. Same behavior, FileObserver-driven instead
     * of polling. Removable in a follow-up once all call sites are
     * migrated to `startWatching`.
     */
    @Deprecated(
        "Renamed to startWatching after BAT-518; this alias forwards for compat",
        replaceWith = ReplaceWith("startWatching(context)"),
    )
    fun startPolling(context: Context) = startWatching(context)

    private fun writeToFile(entry: LogEntry) {
        val file = logFile ?: return
        try {
            file.appendText("${entry.timestamp}|${entry.level.name}|${entry.message}\n")
        } catch (e: Exception) {
            Log.w(TAG, "Failed to write log entry to file", e)
        }
    }

    private fun readAllFromFile() {
        val file = logFile ?: return
        try {
            if (!file.exists()) return
            val fileLength = file.length()
            if (fileLength == 0L) return
            // Only read the tail of the file to avoid OOM on large logs
            // ~200 bytes per log line × MAX_LINES = ~60KB is plenty
            val tailBytes = minOf(fileLength, MAX_LINES * 200L)
            val bytes = java.io.RandomAccessFile(file, "r").use { raf ->
                raf.seek(fileLength - tailBytes)
                ByteArray(tailBytes.toInt()).also { raf.readFully(it) }
            }
            val seekedMidFile = tailBytes < fileLength
            val lines = String(bytes).lines()
                .filter { it.isNotBlank() }
                .let { if (seekedMidFile) it.drop(1) else it } // drop partial first line only when we seeked mid-file
            val entries = lines.mapNotNull { parseLine(it) }.takeLast(MAX_LINES)
            synchronized(logsLock) {
                _logs.value = entries
            }
            lastReadPosition = fileLength
        } catch (e: Exception) {
            Log.w(TAG, "Failed to read log file (full)", e)
        }
    }

    private suspend fun readNewFromFile() {
        // Serialize concurrent invocations. FileObserver often delivers
        // MODIFY and CLOSE_WRITE for a single write, and both dispatch
        // through scope.launch independently. Without this mutex, both
        // would read lastReadPosition, both would parse overlapping
        // byte ranges, and append() would emit duplicate log entries.
        // (Copilot R1.)
        readMutex.withLock {
            val file = logFile ?: return
            try {
                if (!file.exists()) return
                val currentLength = file.length()
                val pos = lastReadPosition
                if (currentLength <= pos) return

                val delta = currentLength - pos
                // Cap per-call read to prevent OOM after long background gaps
                // (e.g. Doze mode coalesced events). If delta exceeds budget,
                // fall back to full tail read.
                val maxDelta = MAX_LINES * 200L
                if (delta > maxDelta) {
                    readAllFromFile()
                    return
                }

                // Read only new bytes
                val newBytes = java.io.RandomAccessFile(file, "r").use { raf ->
                    raf.seek(pos)
                    ByteArray(delta.toInt()).also { raf.readFully(it) }
                }

                val newLines = String(newBytes).lines().filter { it.isNotBlank() }
                val newEntries = newLines.mapNotNull { parseLine(it) }
                if (newEntries.isEmpty()) {
                    lastReadPosition = currentLength
                    return
                }

                synchronized(logsLock) {
                    val current = _logs.value.toMutableList()
                    current.addAll(newEntries)
                    while (current.size > MAX_LINES) {
                        current.removeAt(0)
                    }
                    _logs.value = current
                    lastReadPosition = currentLength
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to read new log entries from file", e)
            }
        }
    }

    private fun parseLine(line: String): LogEntry? {
        val parts = line.split("|", limit = 3)
        if (parts.size < 3) return null
        val timestamp = parts[0].toLongOrNull() ?: return null
        val level = try { LogLevel.valueOf(parts[1]) } catch (_: Exception) { LogLevel.INFO }
        return LogEntry(timestamp = timestamp, message = parts[2], level = level)
    }
}
