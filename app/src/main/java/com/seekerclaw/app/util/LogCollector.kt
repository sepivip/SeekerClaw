package com.seekerclaw.app.util

import android.content.Context
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

enum class LogLevel { INFO, WARN, ERROR }

object LogCollector {
    private const val MAX_LINES = 300
    private const val LOG_FILE_NAME = "service_logs"

    private val _logs = MutableStateFlow<List<LogEntry>>(emptyList())
    val logs: StateFlow<List<LogEntry>> = _logs

    private var logFile: File? = null
    private var pollingJob: Job? = null
    private var lastReadPosition = 0L
    private val scope = CoroutineScope(Dispatchers.IO)

    fun init(context: Context) {
        logFile = File(context.filesDir, LOG_FILE_NAME)
    }

    fun append(message: String, level: LogLevel = LogLevel.INFO) {
        val entry = LogEntry(message = message, level = level)

        // Update in-memory list (for same-process access)
        val current = _logs.value.toMutableList()
        current.add(entry)
        if (current.size > MAX_LINES) {
            current.removeAt(0)
        }
        _logs.value = current

        // Also write to shared file (for cross-process access)
        writeToFile(entry)
    }

    fun clear() {
        _logs.value = emptyList()
        try {
            logFile?.writeText("")
            lastReadPosition = 0L
        } catch (_: Exception) {}
    }

    /**
     * Start polling the log file for cross-process updates.
     * Call this from the UI process (Application.onCreate).
     */
    fun startPolling(context: Context) {
        init(context)
        // Read existing logs on start
        readAllFromFile()
        pollingJob?.cancel()
        pollingJob = scope.launch {
            while (isActive) {
                readNewFromFile()
                delay(1000)
            }
        }
    }

    private fun writeToFile(entry: LogEntry) {
        val file = logFile ?: return
        try {
            file.appendText("${entry.timestamp}|${entry.level.name}|${entry.message}\n")
        } catch (_: Exception) {}
    }

    private fun readAllFromFile() {
        val file = logFile ?: return
        try {
            if (!file.exists()) return
            val fileLength = file.length()
            // Only read the tail of the file to avoid OOM on large logs
            // ~200 bytes per log line × MAX_LINES = ~60KB is plenty
            val tailBytes = minOf(fileLength, MAX_LINES * 200L)
            val raf = java.io.RandomAccessFile(file, "r")
            raf.seek(fileLength - tailBytes)
            val bytes = ByteArray(tailBytes.toInt())
            raf.readFully(bytes)
            raf.close()
            val lines = String(bytes).lines()
                .filter { it.isNotBlank() }
                .drop(1) // first line may be partial (we seeked mid-line)
            val entries = lines.mapNotNull { parseLine(it) }.takeLast(MAX_LINES)
            _logs.value = entries
            lastReadPosition = fileLength
        } catch (_: Exception) {}
    }

    private fun readNewFromFile() {
        val file = logFile ?: return
        try {
            if (!file.exists()) return
            val currentLength = file.length()
            if (currentLength <= lastReadPosition) return

            // Read only new bytes
            val raf = java.io.RandomAccessFile(file, "r")
            raf.seek(lastReadPosition)
            val newBytes = ByteArray((currentLength - lastReadPosition).toInt())
            raf.readFully(newBytes)
            raf.close()
            lastReadPosition = currentLength

            val newLines = String(newBytes).lines().filter { it.isNotBlank() }
            val newEntries = newLines.mapNotNull { parseLine(it) }
            if (newEntries.isEmpty()) return

            val current = _logs.value.toMutableList()
            current.addAll(newEntries)
            while (current.size > MAX_LINES) {
                current.removeAt(0)
            }
            _logs.value = current
        } catch (_: Exception) {}
    }

    private fun parseLine(line: String): LogEntry? {
        val parts = line.split("|", limit = 3)
        if (parts.size < 3) return null
        val timestamp = parts[0].toLongOrNull() ?: return null
        val level = try { LogLevel.valueOf(parts[1]) } catch (_: Exception) { LogLevel.INFO }
        return LogEntry(timestamp = timestamp, message = parts[2], level = level)
    }
}
