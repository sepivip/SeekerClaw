package com.seekerclaw.app.util

import android.content.Context
import android.os.FileObserver
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
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
    private const val MAX_LOG_FILE_BYTES = 1_000_000L
    private const val COMPACT_LOG_FILE_BYTES = 512_000L

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
    private var drainChannel: Channel<Unit>? = null

    // Locking scheme :
    // - `readLock` guards EVERY file operation: reads (readNewFromFile,
    // readAllFromFile), the file-truncating side of clear(), the
    // appendText() in writeToFile(), and all `lastReadPosition`
    // updates. Held DURING disk I/O. Ensures clear() can't race a
    // concurrent append and lose data.
    // - `logsLock` guards in-memory `_logs` read-modify-write sequences.
    // Held briefly during the append-to-list / take-snapshot only.
    //
    // Lock order is ALWAYS readLock → logsLock when both are needed;
    // never the reverse — no deadlock. logsLock is held briefly enough
    // (microseconds for in-memory list ops) that holding readLock during
    // a write doesn't block UI's append() append-to-list path
    // measurably. The file write inside readLock is also fast
    // (single open-write-close cycle).
    //
    // Multiple threads call append() concurrently (Watchdog IO,
    // ServiceState IO, FileObserver-driven tail reads, UI). Without
    // logsLock, concurrent read-modify-write on `_logs.value` silently
    // drops entries (the primary cause of the original "empty console"
    // bug).
    private val logsLock = Any()
    private val readLock = Any()
    private val startWatchingLock = Any()

    // Generation token, bumped on every clear(). Captured under readLock
    // when a read starts, re-checked under readLock when the read tries
    // to publish to _logs. If a clear() ran between the read and the
    // publish (the decode/parse phase happens outside the lock), the
    // generation will have advanced and the publish is discarded —
    // otherwise stale entries from before the clear would be re-added
    // to _logs after _logs was reset to empty.
    @Volatile private var clearGeneration = 0L

    // Set true after the initial readAllFromFile completes. Until then,
    // FileObserver-driven log drains are skipped to avoid racing
    // readAllFromFile's REPLACE semantics. ServiceState dispatches still
    // fire immediately — they have their own StateFlow ordering and
    // depend on observer-liveness for cross-process state events
    // (e.g. bridge_token CREATE).
    @Volatile private var initialReadComplete = false

    // FileObserver can emit multiple events per write. A conflated
    // channel gives us one serialized drain worker: events are cheap to
    // signal, overlapping drains cannot happen, and events arriving
    // during a drain are coalesced into the next channel receive instead
    // of depending on custom atomic owner/state transitions.

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
        // Take readLock for the file truncate + offset reset (serializes
        // against any in-flight readNewFromFile / readAllFromFile). Take
        // logsLock briefly inside for the in-memory list reset. Lock order
        // matches readNewFromFile's: readLock outer, logsLock inner.
        //
        // Bump clearGeneration BEFORE clearing _logs so any in-flight
        // read that decoded under generation N sees N+1 at publish time
        // and discards its stale entries.
        synchronized(readLock) {
            try {
                logFile?.writeText("")
                lastReadPosition = 0L
                clearGeneration++
            } catch (e: Exception) {
                Log.w(TAG, "Failed to clear log file", e)
            }
            synchronized(logsLock) {
                _logs.value = emptyList()
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
     * but now event-driven with near-zero idle disk I/O. Previously
     * this method ran 86,400 disk reads per day in main process even
     * when no new logs arrived; now work happens only on relevant
     * filesystem events. The observer also dispatches ServiceState
     * reads for cross-process state files in the same dir, so per-
     * event work is non-zero — it's just no longer a constant 1Hz
     * background poll.
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
        // Sync setup — set logFile reference, no I/O. Don't do disk
        // reads on the caller thread; Application.onCreate is main
        // thread.
        init(context)

        // Guard + attach inside startWatchingLock :
        // synchronized check-then-set so concurrent callers can't race
        // and attach two observers. uncontended in practice — only
        // Application.onCreate calls this — but the cost is nil and
        // documents the contract for future callers.
        synchronized(startWatchingLock) {
            // Guard: skip if observer already attached (mirrors the BAT-217 fix).
            if (fileObserver != null) {
                Log.d(TAG, "startWatching: already active, skipping")
                return
            }

            ensureDrainWorkerLocked()

            val parent = logFile?.parentFile ?: run {
                Log.w(TAG, "startWatching: no parent dir, skipping FileObserver")
                return
            }

            // Activate observer IMMEDIATELY at construction (R-latest+6 fix).
            // ServiceState's cross-process state files (service_state,
            // bridge_token) are watched via THIS observer too — a
            // bridge_token CREATE that lands before observer activation
            // would be permanently missed (no later writes guaranteed
            // to re-trigger).
            //
            // To still avoid the readAllFromFile (REPLACE) vs
            // readNewFromFile (APPEND) race on the log file itself,
            // we gate ONLY the log-drain dispatch on `initialReadComplete`,
            // set true after the initial readAllFromFile publishes.
            // Events arriving before that flag flips drop the LOG_FILE_NAME
            // drain (readAllFromFile will read everything currently in
            // the file anyway) but STILL fire ServiceState dispatches.
            //
            // Watch the parent dir, dispatch on `service_logs` filename. Mask
            // covers append-style writes (MODIFY / CLOSE_WRITE), atomic-rename
            // writes (MOVED_TO), re-creation after clear() (CREATE), and
            // file removal (DELETE). DELETE is critical so the reader can
            // reset lastReadPosition when the file is removed externally
            // (cleanup, rotation, manual rm) — otherwise the offset would
            // stay past the new EOF after recreation, missing initial
            // writes until lastReadPosition's stale value was passed.
            // Constants are qualified (Java statics not
            // auto-imported into Kotlin function bodies).
            fileObserver = object : FileObserver(
                parent,
                FileObserver.MODIFY or FileObserver.CLOSE_WRITE or
                    FileObserver.MOVED_TO or FileObserver.CREATE or
                    FileObserver.DELETE,
) {
                override fun onEvent(event: Int, path: String?) {
                    val fileName = fileNameFromObserverPath(path)
                    // path == null signals either Q_OVERFLOW (kernel inotify
                    // queue overflowed and some events were dropped) or a
                    // directory-level event without a filename. Either way,
                    // treat as forced resync — drain from current
                    // lastReadPosition. Without this, log lines could go
                    // unforwarded until the next write happens to fire a
                    // normal named event. NOTE:
                    // Q_OVERFLOW is not a public FileObserver constant in
                    // the Android SDK — null path is the only signal we
                    // get, so we trigger resync on any null-path event.
                    if ((fileName == LOG_FILE_NAME || path == null) && initialReadComplete) {
                        // Gated on initialReadComplete: events that fire
                        // during initial catch-up are dropped here —
                        // readAllFromFile reads the full current file
                        // (incl. any in-flight writes) before flipping
                        // the flag, so no log lines are lost.
                        requestDrain()
                    }
                    // BAT-518 device-fix consolidation: ServiceState no
                    // longer owns its own filesDir observer (multi-observer-
                    // per-dir is fragile on this device). LogCollector
                    // dispatches to ServiceState ONLY for paths that are
                    // ServiceState's files. Filtering here (instead of
                    // inside handleFilesDirEvent) means every service_logs
                    // append doesn't even launch a coroutine on the
                    // ServiceState side, preserving BAT-518's I/O savings.
                    //
                    if (path == null || fileName == "service_state" || fileName == "bridge_token") {
                        ServiceState.handleFilesDirEvent(fileName)
                    }
                }
            }.also { it.startWatching() }
        } // end synchronized(startWatchingLock)

        // Initial catch-up read on Dispatchers.IO so the main-thread
        // caller (Application.onCreate) doesn't block on disk I/O.
        // _logs StateFlow holds emptyList until this lands; UI screens
        // that compose before see no log entries briefly.
        //
        // After the read publishes, flip initialReadComplete = true so
        // FileObserver-driven log drains start firing. Observer is
        // already live (activated synchronously above) so cross-process
        // state-file events (bridge_token, service_state) have been
        // dispatching to ServiceState all along.
        scope.launch {
            readAllFromFile()
            initialReadComplete = true
            // Trigger one drain in case writes landed between
            // readAllFromFile's read and the flag flip — those events
            // were dropped by the gate above. Idempotent if no new bytes.
            requestDrain()
            Log.d(TAG, "startWatching: initial read complete, drains enabled")
        }
    }

    private fun ensureDrainWorkerLocked() {
        if (drainChannel != null) return
        val channel = Channel<Unit>(Channel.CONFLATED)
        drainChannel = channel
        scope.launch {
            for (ignored in channel) {
                if (!isActive) break
                drainUntilSettled()
            }
        }
    }

    private fun requestDrain() {
        drainChannel?.trySend(Unit)
    }

    private fun drainUntilSettled() {
        while (true) {
            val before = lastReadPosition
            readNewFromFile()
            val advanced = lastReadPosition > before
            val moreBytes = (logFile?.length() ?: 0L) > lastReadPosition
            if (!advanced || !moreBytes) break
        }
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

    /**
     * One-shot, user-visible catch-up path. This is intentionally not a
     * background poll: LogsScreen calls it when opened so the UI can
     * recover from process restarts, Doze-batched events, or a missed
     * observer notification without reintroducing 24/7 disk reads.
     */
    fun refreshFromFile() {
        scope.launch {
            readAllFromFile()
            initialReadComplete = true
            requestDrain()
        }
    }

    private fun writeToFile(entry: LogEntry) {
        // Take readLock to serialize the append against:
        // • clear() — which truncates the file and resets
        // lastReadPosition. Without this lock, an append landing
        // between clear()'s writeText("") and the offset reset
        // would be lost (next read sees lastReadPosition=0 but
        // the file has been truncated to ""), or the file would
        // contain "X" while readers think it's empty.
        // • readAllFromFile / readNewFromFile — which depend on a
        // consistent file-length-vs-lastReadPosition relationship
        // while reading. An interleaved append between length-read
        // and seek+read could yield surprising mid-buffer writes.
        //
        //
        // append() is called from many threads (Watchdog IO,
        // ServiceState IO, FileObserver dispatch, UI). file.appendText
        // is a single open-write-close cycle (microseconds) so the
        // contention envelope is small. JVM synchronized is reentrant,
        // so re-entry from a path that already holds readLock is a
        // no-op.
        synchronized(readLock) {
            val file = logFile ?: return
            try {
                file.appendText("${entry.timestamp}|${entry.level.name}|${entry.message}\n")
                compactLogFileIfNeededLocked(file)
            } catch (e: Exception) {
                Log.w(TAG, "Failed to write log entry to file", e)
            }
        }
    }

    private fun compactLogFileIfNeededLocked(file: File) {
        if (!file.exists() || file.length() <= MAX_LOG_FILE_BYTES) return

        val keepBytes = minOf(file.length(), COMPACT_LOG_FILE_BYTES)
        val tail = java.io.RandomAccessFile(file, "r").use { raf ->
            raf.seek(file.length() - keepBytes)
            ByteArray(keepBytes.toInt()).also { raf.readFully(it) }
        }

        var start = 0
        while (start < tail.size && tail[start] != 0x0A.toByte()) start++
        val compacted = if (start < tail.size) tail.copyOfRange(start + 1, tail.size) else tail
        file.writeBytes(compacted)
        if (lastReadPosition > file.length()) {
            lastReadPosition = file.length()
        }
    }

    private fun readAllFromFile() {
        // Lock-narrowing pattern : same as
        // readNewFromFile — readLock holds the file ops + offset
        // advancement only; UTF-8 decode + parsing happen outside the
        // lock as pure-CPU work. Keeps the readLock critical section
        // microsecond-scale so UI-thread append() (which contends on
        // readLock to serialize against clear()) doesn't wait through
        // a parse.
        var capturedBytes: ByteArray? = null
        var capturedSeekedMidFile = false
        var generationAtRead = 0L
        synchronized(readLock) {
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

                // Line-boundary safety: same three-case logic as
                // readNewFromFile. (A) newline found, (B) small file
                // mid-write — wait, (C) pathological huge single line —
                // force-advance.
                var lastNewlineIdx = -1
                for (i in bytes.size - 1 downTo 0) {
                    if (bytes[i] == 0x0A.toByte()) { lastNewlineIdx = i; break }
                }

                val (completeBytes, advanceTo) = when {
                    lastNewlineIdx >= 0 -> {
                        val complete = bytes.copyOfRange(0, lastNewlineIdx + 1)
                        val bufStartInFile = fileLength - bytes.size
                        complete to (bufStartInFile + lastNewlineIdx + 1)
                    }
                    !seekedMidFile -> {
                        // Case B: small file, no newlines anywhere — wait.
                        return
                    }
                    else -> {
                        // Case C: pathological huge single line — force-advance.
                        bytes to fileLength
                    }
                }

                lastReadPosition = advanceTo
                capturedBytes = completeBytes
                capturedSeekedMidFile = seekedMidFile
                generationAtRead = clearGeneration
            } catch (e: Exception) {
                Log.w(TAG, "Failed to read log file (full)", e)
            }
        }

        // Decode + parse OUTSIDE readLock — pure CPU.
        // Explicit UTF-8 — see readNewFromFile note .
        val bytes = capturedBytes ?: return
        val entries = String(bytes, Charsets.UTF_8).lines()
.filter { it.isNotBlank() }
.let { if (capturedSeekedMidFile) it.drop(1) else it } // drop partial first line only when we seeked mid-file
.mapNotNull { parseLine(it) }
.takeLast(MAX_LINES)

        // Re-acquire readLock to gate the publish on the clear-generation
        // check. If a clear() ran during decode, the generation will have
        // advanced and we discard these stale entries — otherwise we'd
        // re-populate _logs with entries from before the clear, undoing
        // the user's clear-logs action. logsLock nested inside readLock
        // keeps the documented lock order (readLock outer, logsLock
        // inner) and makes the check + publish atomic w.r.t. clear().
        synchronized(readLock) {
            if (clearGeneration != generationAtRead) return
            synchronized(logsLock) {
                _logs.value = entries
            }
        }
    }

    private fun readNewFromFile() {
        // Lock-narrowing pattern : readLock guards
        // ONLY the file ops + offset advancement (microsecond critical
        // section). UTF-8 decoding and line parsing happen OUTSIDE the
        // lock — they're pure CPU and can be ms-scale on big chunks.
        // Holding readLock during decode would force a UI-thread
        // append() (which also takes readLock to serialize against
        // clear()) to wait through the parse, causing potential UI jank.
        var capturedBytes: ByteArray? = null
        var needFullRead = false
        var generationAtRead = 0L
        synchronized(readLock) {
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
                //
                if (currentLength < pos) {
                    pos = 0L
                    lastReadPosition = 0L
                }

                if (currentLength <= pos) return

                val delta = currentLength - pos
                // Cap per-call read to prevent OOM after long background gaps
                // (e.g. Doze mode coalesced events). If delta exceeds budget,
                // signal that the caller should dispatch readAllFromFile
                // OUTSIDE the readLock — calling it here would hold our
                // outer readLock through readAllFromFile's decode/parse
                // phase (synchronized is reentrant), undermining the
                // lock-narrowing goal.
                val maxDelta = MAX_LINES * 200L
                if (delta > maxDelta) {
                    needFullRead = true
                    return
                }

                // Read only new bytes (still under readLock; logsLock NOT held)
                val newBytes = java.io.RandomAccessFile(file, "r").use { raf ->
                    raf.seek(pos)
                    ByteArray(delta.toInt()).also { raf.readFully(it) }
                }

                // Line-boundary safety : if a CLOSE_WRITE event
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

                val complete = newBytes.copyOfRange(0, lastNewlineIdx + 1)
                // Advance past the last complete line. Trailing partial
                // bytes (if any) stay unread for next call.
                lastReadPosition = pos + complete.size
                capturedBytes = complete
                generationAtRead = clearGeneration
            } catch (e: Exception) {
                Log.w(TAG, "Failed to read new log entries from file", e)
            }
        }

        // Huge-delta fallback: dispatched OUTSIDE the readLock so
        // readAllFromFile takes its own (separate) critical section
        // rather than reentering ours and holding it through decode.
        if (needFullRead) {
            readAllFromFile()
            return
        }

        // Decode + parse OUTSIDE readLock — pure CPU, no shared state needed.
        // Explicit UTF-8 — File.appendText defaults to UTF-8 but String(bytes)
        // without a charset uses the platform default, which can mojibake
        // non-ASCII messages on devices where the JVM default differs.
        //
        val bytes = capturedBytes ?: return
        val newEntries = String(bytes, Charsets.UTF_8).lines()
.filter { it.isNotBlank() }
.mapNotNull { parseLine(it) }
        if (newEntries.isEmpty()) return

        // Re-acquire readLock to gate the publish on the clear-generation
        // check. If a clear() ran during decode, the generation will have
        // advanced and we discard these stale entries — otherwise we'd
        // re-publish entries from before the clear, partially undoing
        // the user's clear-logs action. logsLock nested inside readLock
        // matches the documented lock order (readLock outer, logsLock
        // inner) and makes the check + publish atomic w.r.t. clear().
        // The block is microseconds-scale (in-memory ops only) — no
        // material change to UI-thread append() contention.
        synchronized(readLock) {
            if (clearGeneration != generationAtRead) return
            synchronized(logsLock) {
                val current = _logs.value.toMutableList()
                current.addAll(newEntries)
                while (current.size > MAX_LINES) {
                    current.removeAt(0)
                }
                _logs.value = current
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

    internal fun fileNameFromObserverPath(path: String?): String? =
        path?.substringAfterLast('/')

    // ── Testing hooks ────────────────────────────────────────────────
    // Internal-visibility hooks for unit tests. Intentionally NOT marked
    // @VisibleForTesting via androidx because that pulls in a runtime
    // dep we don't otherwise need; the `internal` modifier already
    // restricts call sites to the same module.

    /** TEST ONLY: inject a file path so concurrency tests can simulate cross-process writes. */
    internal fun setLogFileForTest(file: File?) {
        logFile = file
    }

    /** TEST ONLY: reset the singleton's offset + buffer between tests.
     * Mirrors production locking: readLock for the offset, logsLock
     * for the in-memory list. */
    internal fun resetForTest() {
        synchronized(readLock) {
            lastReadPosition = 0L
            synchronized(logsLock) {
                _logs.value = emptyList()
            }
        }
    }

    /** TEST ONLY: invoke the offset-based reader directly (it's `private` for production use). */
    internal fun readNewFromFileForTest() = readNewFromFile()

    /** TEST ONLY: read the current offset to assert correct advancement. */
    internal val lastReadPositionForTest: Long get() = lastReadPosition
}
