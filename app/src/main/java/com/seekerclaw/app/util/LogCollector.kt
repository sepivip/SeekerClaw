package com.seekerclaw.app.util

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
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
    private var pollingJob: Job? = null
    @Volatile private var lastReadPosition = 0L
    private val scope = CoroutineScope(Dispatchers.IO)

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
     * Start polling the log file for cross-process updates.
     * Call this from the UI process (Application.onCreate).
     */
    fun startPolling(context: Context) {
        init(context)

        // Guard: skip if a polling loop is already running (mirrors ServiceState BAT-217 fix).
        if (pollingJob?.isActive == true) {
            Log.d(TAG, "startPolling: already active, skipping")
            return
        }

        // Read existing logs from file so the UI has data immediately
        readAllFromFile()
        Log.d(TAG, "startPolling: launched, loaded ${_logs.value.size} entries from file")

        pollingJob?.cancel()
        pollingJob = scope.launch {
            while (isActive) {
                delay(1000)
                readNewFromFile()
            }
        }
    }

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

    private fun readNewFromFile() {
        val file = logFile ?: return
        try {
            if (!file.exists()) return
            val currentLength = file.length()
            val pos = lastReadPosition
            if (currentLength <= pos) return

            val delta = currentLength - pos
            // Cap per-poll read to prevent OOM after long background gaps.
            // If delta exceeds our tail budget, fall back to full tail read.
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
            }
            lastReadPosition = currentLength
        } catch (e: Exception) {
            Log.w(TAG, "Failed to read new log entries from file", e)
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
