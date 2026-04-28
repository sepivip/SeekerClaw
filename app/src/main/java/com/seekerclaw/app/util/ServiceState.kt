package com.seekerclaw.app.util

import android.content.Context
import android.os.FileObserver
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File
import java.util.Calendar

private const val TAG = "ServiceState"

enum class ServiceStatus { STOPPED, STARTING, RUNNING, ERROR }

/** Agent API health state read from Node.js health file (BAT-134). */
data class AgentHealth(
    val apiStatus: String = "unknown", // unknown, healthy, degraded, error, stale
    val lastErrorType: String? = null, // auth, billing, rate_limit, server, network, etc.
    val lastErrorStatus: Int? = null, // HTTP status code (-1 for network)
    val lastErrorMessage: String? = null,
    val consecutiveFailures: Int = 0,
    val isStale: Boolean = false,
)

sealed class ApiUsageData {
    abstract val updatedAt: Long
    abstract val error: String?

    data class OAuthUsage(
        val fiveHourUtilization: Float,
        val fiveHourResetsAt: String,
        val sevenDayUtilization: Float,
        val sevenDayResetsAt: String,
        override val updatedAt: Long,
        override val error: String? = null,
) : ApiUsageData()

    data class ApiKeyUsage(
        val requestsLimit: Int,
        val requestsRemaining: Int,
        val requestsReset: String,
        val tokensLimit: Long,
        val tokensRemaining: Long,
        val tokensReset: String,
        override val updatedAt: Long,
        override val error: String? = null,
) : ApiUsageData()
}

object ServiceState {
    private val _status = MutableStateFlow(ServiceStatus.STOPPED)
    val status: StateFlow<ServiceStatus> = _status

    // BAT-522 (phase 2): replaces the old `_uptime` StateFlow that was
    // re-written every 1s by SeekerClawService.uptimeJob. Now the service
    // writes this once on transition to RUNNING and zeroes it on STOPPED.
    // UI derives displayed uptime as `now - serviceStartTimeMs.value`,
    // ticking once per second for display only (no disk write).
    private val _serviceStartTimeMs = MutableStateFlow(0L)
    val serviceStartTimeMs: StateFlow<Long> = _serviceStartTimeMs

    private val _messageCount = MutableStateFlow(0)
    val messageCount: StateFlow<Int> = _messageCount

    private val _messagesToday = MutableStateFlow(0)
    val messagesToday: StateFlow<Int> = _messagesToday

    private val _lastActivityTime = MutableStateFlow(0L)
    val lastActivityTime: StateFlow<Long> = _lastActivityTime

    private val _tokensToday = MutableStateFlow(0L)
    val tokensToday: StateFlow<Long> = _tokensToday

    private val _tokensTotal = MutableStateFlow(0L)
    val tokensTotal: StateFlow<Long> = _tokensTotal

    private val _apiUsage = MutableStateFlow<ApiUsageData?>(null)
    val apiUsage: StateFlow<ApiUsageData?> = _apiUsage

    private val _agentHealth = MutableStateFlow(AgentHealth())
    val agentHealth: StateFlow<AgentHealth> = _agentHealth

    // Private lock for health transition logging.
    // Originally prevented TOCTOU between overlapping polling coroutines.
    // Post-BAT-518 (FileObserver), inotify event delivery on the
    // FileObserver thread is ordered, but the handler work is
    // dispatched to Dispatchers.IO via scope.launch and CAN run
    // concurrently. lastLoggedStale tracks the last-logged direction
    // so duplicate same-direction logs are suppressed even when two
    // dispatches race the synchronized block.
    private val healthTransitionLock = Any()
    @Volatile private var lastLoggedStale: Boolean? = null

    // Per-boot bridge auth token — persisted to file for cross-process access.
    // Set by SeekerClawService (:node process), read by UI (main process) via polling.
    @Volatile
    var bridgeToken: String? = null
        private set

    private var stateFile: File? = null

    /** App files directory — exposed for cross-process file reads (e.g. stats). */
    val filesDir: File? get() = stateFile?.parentFile
    private val scope = CoroutineScope(Dispatchers.IO)
    // @Volatile + check-then-set under initLock: ensures only one
    // thread runs the disk-restore work even if init() / startWatching
    // are called concurrently from main and Dispatchers.IO. Without
    // this, the worker thread might not observe `initialized = true`
    // set by another thread, OR the check-then-set could double-fire
    // restoreFromDisk.
    @Volatile private var initialized = false
    private val initLock = Any()
    private val startWatchingLock = Any()
    private val stalenessTickerStarted = java.util.concurrent.atomic.AtomicBoolean(false)

    /**
     * Initialize state file path AND restore persisted counters.
     * Must be called before any updateStatus/incrementMessages/addTokens.
     *
     * Performs synchronous disk I/O on the calling thread (file read +
     * daily-reset write). `restoreFromDisk` is single-flighted via
     * `initLock` and gated on `initialized`, so repeat calls within a
     * process are no-ops after the first.
     *
     * Known callers (treat as potentially blocking):
     * • `SeekerClawService.onStartCommand` — runs on :node process
     * main thread during service start. A few ms of disk I/O at
     * service start is fine.
     * • `SeekerClawService.stop(context)` companion — runs on whatever
     * process invoked stop (typically main UI when user taps Stop).
     * The first call from main UI may incur the disk I/O;
     * subsequent calls are no-ops since `initialized` is set.
     *
     * Main-process callers in latency-sensitive paths should prefer
     * `startWatching`, which dispatches the restore work to
     * `Dispatchers.IO`.
     *
     * No `@WorkerThread` annotation: both known callers are component
     * callbacks that may run on the main thread, and Android Lint
     * correctly flags @WorkerThread mismatches there. Marking this
     * would force a SuppressLint at the call site without actually
     * preventing misuse — this doc comment is the clearer contract.
     *
     */
    fun init(context: Context) {
        initFileRefs(context)
        restoreFromDisk() // Idempotent — single-flight via initLock
    }

    /** Sync, no I/O. Sets the file path reference so disk reads can find it. */
    private fun initFileRefs(context: Context) {
        stateFile = File(context.filesDir, "service_state")
    }

    /**
     * Disk I/O — file restore + daily reset check.
     *
     * Single-flight: takes `initLock` and double-checks `initialized`
     * inside the lock so concurrent callers (e.g. `init()` on main
     * thread + `startWatching()`'s scope.launch on Dispatchers.IO)
     * run the restore exactly once, regardless of memory ordering.
     *
     */
    private fun restoreFromDisk() {
        if (initialized) return // Fast path — no lock if already done
        synchronized(initLock) {
            if (initialized) return // Double-check inside lock
            readFromFile()
            checkDailyReset()
            initialized = true
            Log.i(TAG, "init: restored msgs=${_messageCount.value} today=${_messagesToday.value} tokens=${_tokensTotal.value}")
        }
    }

    /**
     * Persist the bridge auth token to a file so the UI process can read it.
     * Called by SeekerClawService in the :node process after generating the token.
     */
    fun writeBridgeToken(token: String) {
        bridgeToken = token
        val parent = stateFile?.parentFile ?: return
        try {
            File(parent, "bridge_token").writeText(token)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to write bridge token file: ${e.message}")
        }
    }

    /** Delete the bridge token file so stale tokens don't linger after service shutdown. */
    fun clearBridgeToken() {
        bridgeToken = null
        val parent = stateFile?.parentFile ?: return
        try {
            File(parent, "bridge_token").delete()
        } catch (_: Exception) {}
    }

    private fun readBridgeToken() {
        val parent = stateFile?.parentFile ?: return
        try {
            val file = File(parent, "bridge_token")
            if (!file.exists()) {
                bridgeToken = null
                return
            }
            val token = file.readText().trim()
            bridgeToken = token.ifEmpty { null }
        } catch (_: Exception) {}
    }

    fun updateStatus(s: ServiceStatus) {
        _status.value = s
        writeToFile()
    }

    /**
     * Persist the service start timestamp. Called once when the service
     * transitions to RUNNING, and again with 0L on STOPPED/ERROR/shutdown.
     *
     * Replaces the BAT-518-era `updateUptime(millis)` writer that was
     * called once per second from SeekerClawService.uptimeJob. The 1s
     * write loop generated 86,400 disk writes/day even when nothing
     * changed; deriving uptime from a one-shot start timestamp eliminates
     * that I/O entirely (BAT-522, BAT-518 phase 2).
     */
    fun setServiceStartTimeMs(ms: Long) {
        _serviceStartTimeMs.value = ms
        writeToFile()
    }

    fun incrementMessages() {
        checkDailyReset()
        _messageCount.value++
        _messagesToday.value++
        _lastActivityTime.value = System.currentTimeMillis()
        writeToFile()
        Log.d(TAG, "incrementMessages: total=${_messageCount.value} today=${_messagesToday.value}")
    }

    fun addTokens(count: Long) {
        checkDailyReset()
        _tokensToday.value += count
        _tokensTotal.value += count
        writeToFile()
        Log.d(TAG, "addTokens: +$count today=${_tokensToday.value} total=${_tokensTotal.value}")
    }

    fun reset() {
        _status.value = ServiceStatus.STOPPED
        _serviceStartTimeMs.value = 0L
        _messageCount.value = 0
        _messagesToday.value = 0
        _lastActivityTime.value = 0L
        _tokensToday.value = 0L
        _tokensTotal.value = 0L
        clearBridgeToken()
        writeToFile()
    }

    /**
     * Start watching the state files for cross-process updates.
     * Call this from the UI process (Application.onCreate).
     *
     * BAT-518: replaced the prior 1s coroutine polling loop with kernel-
     * level inotify (`FileObserver`). Same external contract — the
     * StateFlow values still update when the underlying files change —
     * but event-driven instead of 1Hz polling. Previously this method ran
     * 86,400 disk-read cycles per day even when nothing changed.
     *
     * One FileObserver is attached: on `filesDir/workspace`, for
     * `agent_health_state` and `api_usage_state`. Updates for
     * `service_state` and `bridge_token` (which live directly in
     * `filesDir`) flow through `LogCollector`'s FileObserver via
     * `handleFilesDirEvent(path)` — see that method's KDoc for why.
     * Briefly: registering two FileObservers in the same process on the
     * same directory proved fragile on the Solana Seeker (one of two
     * silently never received events), so we consolidate onto one.
     *
     * Initial reads are dispatched ASYNCHRONOUSLY to Dispatchers.IO.
     * The first-time restore (read from
     * service_state, daily reset check) is also dispatched.
     *
     * Caller-thread disk I/O caveat : `workspaceDir.mkdirs()`
     * still runs on the caller thread because the FileObserver attach
     * needs the directory to exist BEFORE startWatching() returns.
     * `mkdirs()` is a no-op stat on existing directories (the common
     * case); only fresh installs incur an actual directory creation.
     * StrictMode's diskIo policy may flag this; for a 24/7 service
     * that runs onCreate exactly once per process, it's acceptable.
     *
     * UI screens that compose before the dispatched reads complete may
     * see default StateFlow values (STOPPED / 0 / 0 / 0) briefly —
     * observers also fire on subsequent writes, so eventual consistency
     * holds.
     */
    fun startWatching(context: Context) {
        // Sync setup: just file path refs, no I/O. The actual disk reads
        // (first-time restore, file content reads) happen in the launch
        // block below so the main thread caller (Application.onCreate)
        // returns fast. Previously, `init(context)` was called here and
        // did synchronous disk I/O on its first invocation.
        initFileRefs(context)

        // Guard + attach are wrapped in startWatchingLock :
        // even though Application.onCreate is the only intended caller and
        // runs once on the main thread, the synchronized block costs nothing
        // for an uncontended lock and documents the contract — future callers
        // can't race the field check + assignment to attach two observers.
        synchronized(startWatchingLock) {
            // Guard: skip if workspace observer is already attached. After
            // BAT-518 device-fix consolidation, filesDir is no longer
            // independently observed by ServiceState — LogCollector's
            // observer drives those reads via handleFilesDirEvent(). So
            // the only ServiceState-owned observer is the workspace one.
            if (workspaceDirObserver != null) {
                Log.d(TAG, "startWatching: workspace observer already active, skipping")
                return
            }

            val parent = stateFile?.parentFile
            if (parent == null) {
                Log.w(TAG, "startWatching: no parent dir, skipping")
                return
            }

            // workspace/ may not exist yet on a fresh install before the service
            // first starts. Create it so FileObserver can attach without racing
            // service startup. Idempotent. mkdirs is fast (single stat) so OK
            // on caller thread; the slow part is the file reads below, which
            // are dispatched.
            //
            // Defensive: validate the result. mkdirs() returns false on failure
            // (filesystem error, permission, OR a non-directory file at that
            // path blocking creation). Without this check, FileObserver
            // attachment to a missing/non-dir path silently no-ops and the UI
            // never receives updates for the workspace files.
            val workspaceDir = File(parent, "workspace")
            if (!workspaceDir.isDirectory) {
                workspaceDir.mkdirs()
            }
            val workspaceUsable = workspaceDir.isDirectory

            Log.d(TAG, "startWatching: attaching workspace FileObserver")

            // BAT-518 device-fix: do NOT register a separate FileObserver for
            // filesDir. LogCollector already watches that directory for
            // service_logs and its observer fires reliably; on the Solana
            // Seeker, registering a SECOND FileObserver in the same process
            // on the same directory caused this observer to silently never
            // receive events even though API 29+ docs claim List<WeakReference>
            // supports it. LogCollector now calls ServiceState.handleFilesDirEvent()
            // on every event, keeping cross-process state in sync via the
            // single working observer. workspaceDir is a different directory
            // and remains observed separately here — no conflict.
            if (workspaceUsable) {
                // Filter by basename in onEvent : workspace/ also contains high-
                // frequency files (node_debug.log from :node, daily
                // memory files, etc.) that aren't ours. Filtering at
                // makeDirObserver's onEvent — BEFORE coroutine launch —
                // means those events cost only a Set lookup, not a
                // coroutine schedule.
                workspaceDirObserver = makeDirObserver(
                    workspaceDir,
                    watchedFiles = setOf("agent_health_state", "api_usage_state"),
) { path ->
                    when (path) {
                        "agent_health_state" -> readAgentHealthFile()
                        "api_usage_state" -> readApiUsageFile()
                        // null = directory-level event without filename
                        // (also signals Q_OVERFLOW); re-read both defensively.
                        null -> { readAgentHealthFile(); readApiUsageFile() }
                    }
                }.also { it.startWatching() }
            } else {
                Log.w(
                    TAG,
                    "startWatching: workspace dir not usable (${workspaceDir.absolutePath}) — " +
                        "skipping workspace FileObserver. agent_health_state and api_usage_state " +
                        "will not auto-refresh; rely on initial dispatched read only.",
)
            }
        } // end synchronized(startWatchingLock)

        // Initial reads on Dispatchers.IO — startWatching is invoked from
        // Application.onCreate (main thread); doing 4 disk reads there
        // risks StrictMode violations and startup jank. The first-time
        // restore (readFromFile + checkDailyReset, gated on `initialized`)
        // is also done here so we don't sneak sync I/O in via init().
        // StateFlow is pre-populated with sane defaults so UI screens
        // that compose before the dispatched reads complete won't show
        // garbage — they just see "STOPPED / 0 / 0 / 0" briefly until
        // the IO dispatch lands a few ms later. Observers also fire on
        // subsequent writes, so eventual consistency holds.
        //
        scope.launch {
            restoreFromDisk()
            readBridgeToken()
            readApiUsageFile()
            readAgentHealthFile()
        }

        startStalenessTicker()
    }

    /**
     * Re-evaluate `_agentHealth.isStale` every 30s by re-reading
     * `agent_health_state` from disk. Necessary because BAT-518 replaced
     * 1s polling with FileObserver — the previous polling loop ALSO
     * refreshed staleness on every tick even when the file hadn't changed.
     * Without this ticker, an agent that crashes and stops writing
     * `agent_health_state` would never trigger the UI's "stale" transition:
     * no file event → no read → `isStale` stuck at its last value (false,
     * if the agent was healthy before crashing). That's a safety-relevant
     * regression: the user would think the agent is healthy when it has
     * actually died.
     *
     * Cost: 1 small file read every 30s (~2,880/day) — vastly cheaper than
     * the prior 1Hz poll's 86,400/day, but not "no I/O" as an earlier
     * iteration of this comment claimed.
     *
     * Once-only via AtomicBoolean.compareAndSet so concurrent startWatching
     * calls (theoretical, defensive) don't double-start the ticker.
     */
    private fun startStalenessTicker() {
        if (!stalenessTickerStarted.compareAndSet(false, true)) return
        scope.launch {
            while (isActive) {
                delay(30_000L)
                // readAgentHealthFile re-derives `stale = (now - fileTime
                // > 120_000)` on every call, so a 30s tick converges
                // staleness within ≤30s of the 120s threshold even when
                // no file events fire. Reading a ~few-hundred-byte file
                // every 30s is 2,880 reads/day — 30× less than the prior
                // 1Hz poll's 86,400 — so we keep most of BAT-518's I/O
                // savings while restoring the safety property.
                readAgentHealthFile()
            }
        }
    }

    /**
     * Called by LogCollector's FileObserver for events in `filesDir`
     * matching ServiceState's files (BAT-518 device-fix consolidation).
     *
     * LogCollector filters by basename BEFORE calling this — only
     * `service_state`, `bridge_token`, or `null` (directory-level events
     * with no attributable filename) reach here. That filter is critical:
     * without it, every `service_logs` append would launch a coroutine
     * just to no-op on the `when`, partially undoing the I/O savings
     * BAT-518 set out to win.
     *
     * Idempotent + cheap: each re-read is ~80 bytes; StateFlow only
     * emits when values actually change.
     */
    fun handleFilesDirEvent(path: String?) {
        scope.launch {
            when (path) {
                "service_state" -> readFromFile()
                "bridge_token" -> readBridgeToken()
                null -> {
                    // Directory-level event with no attributable filename.
                    // Read both — defensive, very rare.
                    readFromFile()
                    readBridgeToken()
                }
                // Any other path means LogCollector's filter let something
                // through unexpectedly — silently ignore.
            }
        }
    }

    /**
     * Backwards-compat alias. Older call sites (and any external code)
     * that still call `startPolling` continue to work — same behavior,
     * just no actual polling underneath. Removable in a follow-up once
     * all call sites are migrated.
     */
    @Deprecated(
        "Renamed to startWatching after BAT-518; this alias forwards for compat",
        replaceWith = ReplaceWith("startWatching(context)"),
)
    fun startPolling(context: Context) = startWatching(context)

    private var workspaceDirObserver: FileObserver? = null

    private fun makeDirObserver(
        dir: File,
        watchedFiles: Set<String>,
        onChange: (path: String?) -> Unit,
): FileObserver {
        // FileObserver(File) is API 29+; we target min SDK 34 so this is safe.
        // Mask covers:
        // • CLOSE_WRITE / MODIFY: writeText / appendText style writes
        // • MOVED_TO: atomic .tmp + rename writes
        // • CREATE: initial creation when file didn't exist at attach
        // • DELETE: file removal in the watched dir, so the reader
        // refreshes when one of the watched files disappears (not
        // only on create/write). Defense-in-depth against external
        // removal — covers the cases the polling code used to catch
        // by re-stat'ing every tick.
        // MOVED_FROM is also covered by MOVED_TO + CREATE on the
        // destination dir; we don't need it here.
        //
        // Constants are qualified (FileObserver.MODIFY etc.) because
        // they're Java static fields, not auto-importable into Kotlin
        // function bodies.
        //
        // The callback receives `path` (basename of changed file, or
        // null for directory-level events). The caller is responsible
        // for filtering — the workspace observer in particular needs
        // it because workspace/ contains high-frequency files like
        // node_debug.log that would otherwise launch a no-op coroutine
        // per event.
        return object : FileObserver(
            dir,
            FileObserver.MODIFY or FileObserver.CLOSE_WRITE or
                FileObserver.MOVED_TO or FileObserver.CREATE or
                FileObserver.DELETE,
) {
            override fun onEvent(event: Int, path: String?) {
                val fileName = LogCollector.fileNameFromObserverPath(path)
                // Filter BEFORE launching : the
                // watched dir contains high-frequency files (e.g. node_debug.log
                // in workspace/, written multiple times per second by :node)
                // that aren't ours. Filtering inside the coroutine wastes
                // scheduling. path == null is always forwarded — that's the
                // only signal Android gives us for inotify queue overflow,
                // and we want a forced resync in that case.
                if (fileName != null && fileName !in watchedFiles) return
                // Dispatch to scope so the FileObserver thread (a single
                // shared thread named "FileObserver" in Android) doesn't
                // do file I/O. The reader functions are idempotent — if
                // multiple events fire for the same write, re-reading is
                // cheap and produces the same StateFlow values.
                scope.launch { onChange(fileName) }
            }
        }
    }

    /**
     * Reset "today" counters if the last activity was on a different day.
     * Uses the stored lastResetDay in the state file to track.
     */
    private fun checkDailyReset() {
        val file = stateFile ?: return
        try {
            val dayFile = File(file.parentFile, "service_state_day")
            val todayDay = Calendar.getInstance().get(Calendar.DAY_OF_YEAR)
            val todayYear = Calendar.getInstance().get(Calendar.YEAR)
            val todayKey = "${todayYear}_${todayDay}"

            val lastDay = if (dayFile.exists()) dayFile.readText().trim() else ""
            if (lastDay != todayKey) {
                _messagesToday.value = 0
                _tokensToday.value = 0
                dayFile.writeText(todayKey)
            }
        } catch (_: Exception) {}
    }

    /**
     * File format (one value per line):
     * 0: status name
     * 1: (DEPRECATED, BAT-522) was uptime millis. Always written as 0
     *    so old builds reading the new file see uptime=0 (acceptable
     *    degradation — BAT-522 stops updating it; old build can't show
     *    a live ticker anymore but won't misinterpret garbage).
     * 2: messageCount (all-time)
     * 3: messagesToday
     * 4: lastActivityTime
     * 5: tokensToday
     * 6: tokensTotal
     * 7: serviceStartTimeMs (BAT-522, phase 2). New builds derive
     *    displayed uptime as `now - serviceStartTimeMs` while RUNNING,
     *    no live disk writes. Missing on pre-BAT-522 files → defaults
     *    to 0L on read; the next service start populates it.
     */
    private fun writeToFile() {
        val file = stateFile ?: return
        try {
            val data = buildString {
                appendLine(_status.value.name)
                // Line 1 is intentionally always 0L (BAT-522 — see file
                // format docblock). Kept so old pre-BAT-522 builds
                // running on a freshly-written file still find every
                // line they expect at the same index.
                appendLine(0L)
                appendLine(_messageCount.value)
                appendLine(_messagesToday.value)
                appendLine(_lastActivityTime.value)
                appendLine(_tokensToday.value)
                appendLine(_tokensTotal.value)
                append(_serviceStartTimeMs.value)
            }
            file.writeText(data)
        } catch (_: Exception) {}
    }

    private fun readFromFile() {
        val file = stateFile ?: return
        try {
            if (!file.exists()) return
            val lines = file.readLines()
            if (lines.size >= 5) {
                val fileStatus = try { ServiceStatus.valueOf(lines[0]) } catch (_: Exception) { return }
                // lines[1] is the deprecated uptime field — read but
                // ignore. BAT-522 derives uptime from line 7 instead.
                val fileMsgCount = lines[2].toIntOrNull() ?: return
                val fileMsgToday = lines[3].toIntOrNull() ?: return
                val fileLastActivity = lines[4].toLongOrNull() ?: return

                if (_status.value != fileStatus) _status.value = fileStatus
                if (_messageCount.value != fileMsgCount) _messageCount.value = fileMsgCount
                if (_messagesToday.value != fileMsgToday) _messagesToday.value = fileMsgToday
                if (_lastActivityTime.value != fileLastActivity) _lastActivityTime.value = fileLastActivity

                // Token fields (backwards compatible - may not exist in older files)
                if (lines.size >= 7) {
                    val fileTokensToday = lines[5].toLongOrNull() ?: 0L
                    val fileTokensTotal = lines[6].toLongOrNull() ?: 0L
                    if (_tokensToday.value != fileTokensToday) _tokensToday.value = fileTokensToday
                    if (_tokensTotal.value != fileTokensTotal) _tokensTotal.value = fileTokensTotal
                }

                // Service start time (BAT-522). Pre-BAT-522 files lack
                // line 7 — default to 0L; the next service start writes
                // a fresh value, after which uptime tracking resumes
                // normally. While 0L is in effect, the UI shows
                // "00h 00m 00s" — same as the STOPPED display, which
                // matches user expectation for the moment of upgrade.
                val fileStartTime = if (lines.size >= 8) {
                    lines[7].toLongOrNull() ?: 0L
                } else 0L
                if (_serviceStartTimeMs.value != fileStartTime) _serviceStartTimeMs.value = fileStartTime
            }
        } catch (_: Exception) {}
    }

    private fun readAgentHealthFile() {
        val parent = stateFile?.parentFile ?: return
        val file = File(parent, "workspace/agent_health_state")
        try {
            if (!file.exists()) {
                // File deleted (rotation, cleanup, user wipe, etc.). Reset
                // to default AgentHealth with isStale=true rather than
                // silently leaving the UI showing the last known status —
                // a missing source-of-truth file is itself a "stale"
                // signal.
                val missing = AgentHealth(apiStatus = "stale", isStale = true)
                synchronized(healthTransitionLock) {
                    if (_agentHealth.value != missing) {
                        _agentHealth.value = missing
                        lastLoggedStale = true
                    }
                }
                return
            }
            val json = JSONObject(file.readText())
            val apiStatus = json.optString("apiStatus", "unknown")
            val updatedAt = json.optString("updatedAt", "")

            // Staleness check: if file > 120s old, agent may have crashed
            val stale = if (updatedAt.isNotEmpty()) {
                try {
                    val fileTime = java.time.Instant.parse(updatedAt).toEpochMilli()
                    System.currentTimeMillis() - fileTime > 120_000
                } catch (_: Exception) { true }
            } else true

            val lastErr = if (json.has("lastError") && !json.isNull("lastError"))
                json.getJSONObject("lastError") else null

            val health = AgentHealth(
                apiStatus = if (stale) "stale" else apiStatus,
                lastErrorType = lastErr?.optString("type"),
                lastErrorStatus = lastErr?.optInt("status"),
                lastErrorMessage = lastErr?.optString("message"),
                consecutiveFailures = json.optInt("consecutiveFailures", 0),
                isStale = stale,
)
            // Determine log entry inside a private lock (state mutation only, no I/O).
            // Lock hold time is kept short; LogCollector.append() is called after release.
            var logEntry: Pair<String, LogLevel>? = null
            synchronized(healthTransitionLock) {
                if (_agentHealth.value != health) {
                    val prevStale = _agentHealth.value.isStale
                    if (!prevStale && stale && lastLoggedStale != true) {
                        logEntry = Pair("[Health] Agent health file became stale — Node.js may have lost network", LogLevel.WARN)
                        lastLoggedStale = true
                    } else if (prevStale && !stale && lastLoggedStale != false) {
                        logEntry = Pair("[Health] Agent health recovered", LogLevel.INFO)
                        lastLoggedStale = false
                    }
                    _agentHealth.value = health
                }
            }
            logEntry?.let { (msg, level) -> LogCollector.append(msg, level) }
        } catch (_: Exception) {}
    }

    private fun readApiUsageFile() {
        val parent = stateFile?.parentFile ?: return
        val file = File(parent, "workspace/api_usage_state")
        try {
            if (!file.exists()) {
                // File deleted (cleanup, rotation, user wipe). Clear
                // the in-memory usage so the UI doesn't continue showing
                // stale counts that no longer have a backing source.
                if (_apiUsage.value != null) _apiUsage.value = null
                return
            }
            val json = JSONObject(file.readText())
            val type = json.optString("type", "")
            val updatedAt = try {
                java.time.Instant.parse(json.optString("updated_at", "")).toEpochMilli()
            } catch (_: Exception) {
                System.currentTimeMillis()
            }
            val error = json.optString("error", "").ifBlank { null }

            val usage = if (type == "oauth") {
                val fh = json.optJSONObject("five_hour")
                val sd = json.optJSONObject("seven_day")
                ApiUsageData.OAuthUsage(
                    fiveHourUtilization = fh?.optDouble("utilization", 0.0)?.toFloat() ?: 0f,
                    fiveHourResetsAt = fh?.optString("resets_at", "") ?: "",
                    sevenDayUtilization = sd?.optDouble("utilization", 0.0)?.toFloat() ?: 0f,
                    sevenDayResetsAt = sd?.optString("resets_at", "") ?: "",
                    updatedAt = updatedAt,
                    error = error,
)
            } else if (type == "api_key") {
                val req = json.optJSONObject("requests")
                val tok = json.optJSONObject("tokens")
                ApiUsageData.ApiKeyUsage(
                    requestsLimit = req?.optInt("limit", 0) ?: 0,
                    requestsRemaining = req?.optInt("remaining", 0) ?: 0,
                    requestsReset = req?.optString("reset", "") ?: "",
                    tokensLimit = tok?.optLong("limit", 0) ?: 0,
                    tokensRemaining = tok?.optLong("remaining", 0) ?: 0,
                    tokensReset = tok?.optString("reset", "") ?: "",
                    updatedAt = updatedAt,
                    error = error,
)
            } else {
                return
            }

            if (_apiUsage.value != usage) _apiUsage.value = usage
        } catch (_: Exception) {}
    }

    // ── Testing hooks ────────────────────────────────────────────────
    // Internal-visibility hooks for unit tests. Same convention as
    // LogCollector — kept in-class (not via androidx @VisibleForTesting)
    // because we don't want to pull in the runtime dependency for what
    // is fundamentally just a controlled test seam.

    internal fun setStateFileForTest(file: File?) {
        stateFile = file
    }

    internal fun resetForTest() {
        _status.value = ServiceStatus.STOPPED
        _serviceStartTimeMs.value = 0L
        _messageCount.value = 0
        _messagesToday.value = 0
        _lastActivityTime.value = 0L
        _tokensToday.value = 0L
        _tokensTotal.value = 0L
        _apiUsage.value = null
        _agentHealth.value = AgentHealth()
        bridgeToken = null
        initialized = false
    }

    internal fun writeToFileForTest() = writeToFile()

    internal fun readFromFileForTest() = readFromFile()
}
