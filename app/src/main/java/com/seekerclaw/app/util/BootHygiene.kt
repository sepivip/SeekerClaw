package com.seekerclaw.app.util

import android.util.Log
import com.seekerclaw.app.config.PrefsNames
import java.io.File
import java.nio.file.Path

/**
 * BAT-1409 P1-C — Android wiring for [LinkHygiene]: step 1 at process start, its outcome for this
 * process, and the log lines it buffers until [LogCollector] is ready.
 */
object BootHygiene {
    private const val TAG = "LinkHygiene"

    /**
     * Step 1's unsafe paths in this process, fixed once step 1 has run. Non-empty in `:node`
     * means the start ends as `Failed(LINK_HYGIENE)`: nothing reads, constructs or writes a store.
     */
    @Volatile
    var unsafe: Set<Path> = emptySet()
        private set

    private val pending = mutableListOf<LinkHygiene.Line>()

    /** `nlink` through `Os.lstat` (contract §6): `java.nio`'s `unix:` view is not relied on here. */
    fun hygiene(): LinkHygiene = LinkHygiene(LinkHygiene.Ops(nlinkOf = { p -> android.system.Os.lstat(p.toString()).st_nlink }))

    /** `dataDir/files`, built the way `ContextImpl.getFilesDir` builds it but without its mkdir. */
    fun filesDirOf(dataDir: File): Path = dataDir.toPath().resolve("files")

    /**
     * Step 1 over the exact list (amendment v3.3 M1). Never throws: an unexpected failure marks
     * `filesDir` unsafe, so `:node` fails closed instead of crash-looping in `Application.onCreate`.
     */
    fun runStep1(dataDir: File): Set<Path> {
        val data = dataDir.toPath()
        val files = filesDirOf(dataDir)
        val (lines, bad) = try {
            val r = hygiene().step1(LinkHygiene.criticalPaths(files, data, PrefsNames.ALL), data)
            r.log to r.unsafe
        } catch (t: Throwable) {
            listOf(LinkHygiene.Line(LogLevel.ERROR, "[LinkHygiene] step 1 failed: ${t.javaClass.simpleName}")) to setOf(files)
        }
        lines.forEach { Log.e(TAG, it.message) }
        synchronized(pending) { pending += lines }
        unsafe = bad
        return bad
    }

    /**
     * Step 2's retry of [unsafe] (v3.3 M1), on the `Failed(LINK_HYGIENE)` branch: it cleans up so
     * the next start can proceed; this start fails either way. Logcat only: `service_logs` may be
     * one of the unsafe paths. Returns the paths still unsafe.
     */
    fun retryUnsafe(dataDir: File): Set<Path> {
        val current = unsafe
        if (current.isEmpty()) return emptySet()
        return try {
            val r = hygiene().step1(current.sortedBy { it.nameCount }, dataDir.toPath())
            r.log.forEach { Log.e(TAG, it.message) }
            r.unsafe
        } catch (t: Throwable) {
            Log.e(TAG, "[LinkHygiene] retry failed: ${t.javaClass.simpleName}")
            current
        }
    }

    /** Hands the buffered step-1 lines to [LogCollector]; call once it is initialised. */
    fun flushLog() {
        val lines = synchronized(pending) { pending.toList().also { pending.clear() } }
        lines.forEach { LogCollector.append(it.message, it.level) }
    }
}
