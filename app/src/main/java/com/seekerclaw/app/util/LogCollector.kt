package com.seekerclaw.app.util

import android.content.Context
import android.os.FileObserver
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
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

    // BAT-518 R5: lastReadPosition + the log file are guarded by the
    // single shared `logsLock`. Three call sites mutate one or both:
    // readNewFromFile (FileObserver-triggered), readAllFromFile
    // (initial load + recovery from huge delta), and clear() (Settings
    // UI "clear logs" button). The earlier R1 fix used a separate
    // kotlinx.coroutines.Mutex for readNewFromFile, but that left
    // readAllFromFile and clear() racing it on the offset. Consolidating
    // to logsLock means: same lock everywhere, no possible offset drift.
    // synchronized blocks are fine on Dispatchers.IO (which is designed
    // for blocking I/O); the perf cost is identical to a Mutex but the
    // call sites stay non-suspend.

    // Lock for all in-memory _logs mutations to prevent TOCTOU races.
    // Multiple threads (Watchdog IO, ServiceState IO, FileObserver-driven
    // tail reads) call append() concurrently — without this lock, concurrent
    // read-modify-write on _logs.value silently drops entries (the primary
    // cause of the "empty console" bug).
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
        // R5: take logsLock to serialize against readNewFromFile and
        // clear(). Re-entrant — readNewFromFile may already hold it
        // when calling us as the "huge-delta fallback" path.
        synchronized(logsLock) {
            val file = logFile ?: return
            try {
                if (!file.exists()) {
                    lastReadPosition = 0L
                    return
                }
                val fileLength = file.length()
                if (fileLength == 0L) {
                    lastReadPosition = 0L
                    return
                }
                // Only read the tail of the file to avoid OOM on large logs
                // ~200 bytes per log line × MAX_LINES = ~60KB is plenty
                val tailBytes = minOf(fileLength, MAX_LINES * 200L)
                val bytes = java.io.RandomAccessFile(file, "r").use { raf ->
                    raf.seek(fileLength - tailBytes)
                    ByteArray(tailBytes.toInt()).also { raf.readFully(it) }
                }
                val seekedMidFile = tailBytes < fileLength
                // Explicit UTF-8 — see readNewFromFile note (Copilot R4).
                val lines = String(bytes, Charsets.UTF_8).lines()
                    .filter { it.isNotBlank() }
                    .let { if (seekedMidFile) it.drop(1) else it } // drop partial first line only when we seeked mid-file
                val entries = lines.mapNotNull { parseLine(it) }.takeLast(MAX_LINES)
                _logs.value = entries
                lastReadPosition = fileLength
            } catch (e: Exception) {
                Log.w(TAG, "Failed to read log file (full)", e)
            }
        }
    }

    private fun readNewFromFile() {
        // R5: serialize via logsLock — same lock used by readAllFromFile
        // and clear(). Earlier R1 fix used a separate kotlinx Mutex but
        // that left readAllFromFile and clear() racing on the offset.
        // synchronized is fine here: this is invoked from
        // Dispatchers.IO (FileObserver dispatch) which expects to block.
        synchronized(logsLock) {
            val file = logFile ?: return
            try {
                if (!file.exists()) {
                    // File rotated out / deleted. Reset offset so next
                    // CREATE event starts cleanly from 0.
                    lastReadPosition = 0L
                    return
                }
                val currentLength = file.length()
                var pos = lastReadPosition

                // Rotation/truncation: if file shrunk below our offset,
                // it was either truncated in place or replaced with a
                // smaller file. Without this guard, the early-return on
                // `currentLength <= pos` would silently never forward
                // again until the file grew past the stale offset.
                // (Copilot R3.)
                if (currentLength < pos) {
                    pos = 0L
                    lastReadPosition = 0L
                }

                if (currentLength <= pos) return

                val delta = currentLength - pos
                // Cap per-call read to prevent OOM after long background gaps
                // (e.g. Doze mode coalesced events). If delta exceeds budget,
                // fall back to full tail read.
                val maxDelta = MAX_LINES * 200L
                if (delta > maxDelta) {
                    // Note: readAllFromFile is called from inside the
                    // synchronized block. logsLock is a regular monitor
                    // (re-entrant) so the nested synchronized inside
                    // readAllFromFile is a no-op acquire.
                    readAllFromFile()
                    return
                }

                // Read only new bytes
                val newBytes = java.io.RandomAccessFile(file, "r").use { raf ->
                    raf.seek(pos)
                    ByteArray(delta.toInt()).also { raf.readFully(it) }
                }

                // Line-boundary safety (Copilot R3): if a CLOSE_WRITE event
                // arrives mid-write, the trailing bytes may be a partial
                // line. parseLine() returns null for it, but if we then
                // advanced lastReadPosition to currentLength, the partial
                // line would be lost forever once the rest arrives. Find
                // the last newline byte (0x0A — same in ASCII and UTF-8,
                // safe for multi-byte chars), forward only complete lines,
                // and leave any trailing partial in the file for the next
                // event to pick up.
                var lastNewlineIdx = -1
                for (i in newBytes.size - 1 downTo 0) {
                    if (newBytes[i] == 0x0A.toByte()) { lastNewlineIdx = i; break }
                }
                if (lastNewlineIdx < 0) {
                    // No complete line in this chunk. Leave lastReadPosition
                    // untouched so the next event re-reads with more bytes
                    // (which presumably include the newline).
                    return
                }

                val completeBytes = newBytes.copyOfRange(0, lastNewlineIdx + 1)
                // Explicit UTF-8 — File.appendText defaults to UTF-8 but
                // String(bytes) without a charset uses the platform
                // default, which can mojibake non-ASCII messages on
                // devices where the JVM default differs. (Copilot R4.)
                val newLines = String(completeBytes, Charsets.UTF_8).lines().filter { it.isNotBlank() }
                val newEntries = newLines.mapNotNull { parseLine(it) }
                // Advance past the last complete line. Trailing partial
                // bytes (if any) stay unread for next call.
                lastReadPosition = pos + completeBytes.size
                if (newEntries.isEmpty()) return

                val current = _logs.value.toMutableList()
                current.addAll(newEntries)
                while (current.size > MAX_LINES) {
                    current.removeAt(0)
                }
                _logs.value = current
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

    // ── Testing hooks ────────────────────────────────────────────────
    // Internal-visibility hooks for unit tests. Intentionally NOT marked
    // @VisibleForTesting via androidx because that pulls in a runtime
    // dep we don't otherwise need; the `internal` modifier already
    // restricts call sites to the same module. (Copilot R2 asked for
    // tests around the offset-based reader's concurrency behavior.)

    /** TEST ONLY: inject a file path so concurrency tests can simulate cross-process writes. */
    internal fun setLogFileForTest(file: File?) {
        logFile = file
    }

    /** TEST ONLY: reset the singleton's offset + buffer between tests. */
    internal fun resetForTest() {
        synchronized(logsLock) {
            _logs.value = emptyList()
        }
        lastReadPosition = 0L
    }

    /** TEST ONLY: invoke the offset-based reader directly (it's `private` for production use). */
    internal fun readNewFromFileForTest() = readNewFromFile()

    /** TEST ONLY: read the current offset to assert correct advancement. */
    internal val lastReadPositionForTest: Long get() = lastReadPosition
}
