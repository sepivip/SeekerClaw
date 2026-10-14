package com.seekerclaw.app.util

import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.NoSuchFileException
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.BasicFileAttributes
import java.util.Locale

/**
 * BAT-1409 P1-C (contract v3.2, amendment v3.3 M1) — neutralise planted links at boot, before
 * any store is constructed and before Node starts.
 *
 * Pure JVM (`java.nio.file` only, no `android.*`; source guard in `LinkHygieneTest`). The
 * filesystem calls go through [Ops] so tests can inject `lstat`/`unlink` failures and `nlink`;
 * Android passes an `Os.lstat(path).st_nlink` adapter for `nlink` (contract §6).
 *
 * - **Step 1** ([step1] over [criticalPaths]) runs first in `Application.onCreate` of `:node`,
 *   and in `attachBaseContext` of the main process. An exact list, at most [STEP1_MAX_LSTAT]
 *   `lstat` calls, no directory enumeration. Each link is unlinked; a path that cannot be
 *   checked or unlinked goes into `unsafe`, and `:node` then ends the start as
 *   `Failed(LINK_HYGIENE)` without dereferencing it.
 * - **Step 2** ([step2]) runs on the start worker after `startForeground`, before Node starts.
 *   All variable-size enumeration happens here, within [Budgets]: the Node-read directories
 *   first and completely, then the Kotlin-owned directory entries, then the rest of the
 *   workspace breadth-first.
 *
 * Guarantee, stated as in the contract: within its budgets, step 2 leaves no symlink (and no
 * hard-linked regular file) in the workspace; an entry it did not reach is not certified, and
 * the ERROR it logs names that subtree. Kotlin writers refuse to write through such an entry
 * anyway (P1-J), and the agent-facing tools refuse to follow it out of the workspace.
 */
class LinkHygiene(
    private val ops: Ops = Ops(),
    private val nanoTime: () -> Long = System::nanoTime,
    private val wallClockMs: () -> Long = System::currentTimeMillis,
) {

    /** Filesystem calls, all no-follow. Open so tests can inject failures. */
    open class Ops(private val nlinkOf: ((Path) -> Long)? = null) {
        /** `lstat`; null when nothing exists at [p]. Throws on any other I/O error. */
        open fun lstat(p: Path): BasicFileAttributes? = try {
            Files.readAttributes(p, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
        } catch (_: NoSuchFileException) {
            null
        }

        open fun readLink(p: Path): String? = try {
            Files.readSymbolicLink(p).toString()
        } catch (_: Exception) {
            null
        }

        /** Removes the entry itself: for a link, the link, never its target. */
        open fun unlink(p: Path) = Files.delete(p)

        /** `rename(2)`: moves a link itself, never its target. */
        open fun rename(src: Path, dst: Path) {
            Files.move(src, dst, StandardCopyOption.ATOMIC_MOVE)
        }

        /** Iterates [dir]'s entries until [action] returns false. [dir] was verified real. */
        open fun forEachEntry(dir: Path, action: (Path) -> Boolean) {
            Files.newDirectoryStream(dir).use { s ->
                for (child in s) if (!action(child)) break
            }
        }

        /** Hard-link count, or null when this platform cannot report it. */
        open fun nlink(p: Path): Long? = nlinkOf?.invoke(p) ?: try {
            (Files.getAttribute(p, "unix:nlink", LinkOption.NOFOLLOW_LINKS) as Number).toLong()
        } catch (_: UnsupportedOperationException) {
            null
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    data class Line(val level: LogLevel, val message: String)

    data class Removed(val path: Path, val target: String?)

    data class Step1Result(
        val lstatCalls: Int,
        val removed: List<Removed>,
        /** Paths that could not be checked or unlinked. Non-empty means `Failed(LINK_HYGIENE)`. */
        val unsafe: Set<Path>,
        val log: List<Line>,
    )

    /** Step 2 bounds. Defaults are the signed-off values (v3.2 P1-C, v3.3 M1). */
    data class Budgets(
        val nodeReadMaxEntries: Int = 50_000,
        val kotlinDirsMaxEntries: Int = 20_000,
        val walkMaxEntries: Int = 20_000,
        val walkMaxNanos: Long = 3_000_000_000L,
        val maxDepth: Int = 24,
        val pruneMaxNanos: Long = 1_000_000_000L,
        val keepQuarantines: Int = 5,
        /** `.kwrite/` temps older than this are leftovers; younger ones may be in flight. */
        val kwriteStaleMs: Long = 10 * 60_000L,
    )

    data class Step2Result(
        /** Retried step-1 paths and linked roots still not neutralised: `Failed(LINK_HYGIENE)`. */
        val unsafe: Set<Path>,
        val quarantined: Int,
        val unlinked: Int,
        val hardLinksRemoved: Int,
        /** One description per phase whose budget ran out (already logged as ERROR). */
        val exhausted: List<String>,
        val errors: Int,
        val log: List<Line>,
        val elapsedMs: Long,
    )

    // ------------------------------------------------------------------------------- step 1

    /**
     * `lstat`s each path of [paths] once, in order. A link is unlinked after its target is
     * recorded. A path whose `lstat` or `unlink` fails goes into `unsafe`, and so does every
     * later path under it, without being looked up through it. Never throws for one path.
     */
    fun step1(paths: List<Path>, displayRoot: Path? = null): Step1Result {
        fun show(p: Path): String =
            escape(if (displayRoot != null && p.startsWith(displayRoot)) displayRoot.relativize(p).toString() else p.toString())
        val log = mutableListOf<Line>()
        val removed = mutableListOf<Removed>()
        val unsafe = LinkedHashSet<Path>()
        var calls = 0
        for (p in paths) {
            if (unsafe.any { p != it && p.startsWith(it) }) {
                unsafe.add(p)
                continue
            }
            val attrs = try {
                calls++
                ops.lstat(p)
            } catch (e: Exception) {
                unsafe.add(p)
                log += Line(LogLevel.ERROR, "[LinkHygiene] cannot check ${show(p)}: ${e.javaClass.simpleName}")
                continue
            }
            if (attrs == null || !attrs.isSymbolicLink) continue
            val target = ops.readLink(p)
            try {
                ops.unlink(p)
            } catch (_: NoSuchFileException) {
                // Already gone.
            } catch (e: Exception) {
                unsafe.add(p)
                log += Line(LogLevel.ERROR, "[LinkHygiene] cannot unlink link ${show(p)}: ${e.javaClass.simpleName}")
                continue
            }
            removed += Removed(p, target)
            log += Line(LogLevel.ERROR, "[LinkHygiene] unlinked link ${show(p)} -> ${escape(target ?: "?")}")
        }
        return Step1Result(calls, removed, unsafe, log)
    }

    // ------------------------------------------------------------------------------- step 2

    /**
     * Step 2, in the order amendment v3.3 M1 fixes:
     * 1. retry [retry] (step 1's unsafe paths). If any is still unsafe, or `filesDir`/`dataDir`
     *    is not a real directory, nothing else runs: the start fails anyway, and no entry may be
     *    looked up through an ancestor that is still a link;
     * 2. the workspace and `nodejs-project` roots: a link is moved aside and a fresh directory
     *    created (Kotlin re-seeds the workspace; P1-A re-extracts the bundle);
     * 3. `workspace/{memory,cron,tasks,skills}`, walked first and completely, up to
     *    [Budgets.nodeReadMaxEntries] entries; Node core reads these;
     * 4. the entries of `filesDir`, `dataDir`, `shared_prefs/`, `burner_keys/` and `databases/`,
     *    plus the `.kwrite/` leftover sweep;
     * 5. the rest of the workspace, breadth-first, within [Budgets.walkMaxEntries],
     *    [Budgets.walkMaxNanos] and [Budgets.maxDepth];
     * 6. the quarantine prune: the newest [Budgets.keepQuarantines] dirs are kept.
     *
     * Links are moved to `filesDir/quarantine/<ts>/<n>` with a `manifest.tsv` row; if the move
     * fails the link is unlinked. A workspace regular file with `nlink > 1` loses its workspace
     * name. A linked root that cannot be removed is `unsafe` (fail closed), and the workspace is
     * then not walked at all, so nothing is looked up through the link. Anywhere else, an entry
     * that cannot be checked or removed is logged as ERROR and the start continues (v3.2).
     * Never throws.
     */
    fun step2(filesDir: Path, dataDir: Path, retry: Set<Path> = emptySet(), budgets: Budgets = Budgets()): Step2Result {
        val start = nanoTime()
        val run = Run(filesDir, dataDir, budgets)
        try {
            run.all(retry)
        } catch (e: Exception) {
            // Defensive: every phase handles its own I/O errors. Anything else fails closed.
            run.unsafe.add(filesDir)
            run.log += Line(LogLevel.ERROR, "[LinkHygiene] step 2 aborted: ${e.javaClass.simpleName}")
        }
        return Step2Result(
            unsafe = run.unsafe,
            quarantined = run.quarantined,
            unlinked = run.unlinked,
            hardLinksRemoved = run.hardLinks,
            exhausted = run.exhausted,
            errors = run.errors,
            log = run.log,
            elapsedMs = (nanoTime() - start) / 1_000_000,
        )
    }

    private inner class Run(val filesDir: Path, val dataDir: Path, val b: Budgets) {
        val workspace: Path = filesDir.resolve(WORKSPACE)
        val log = mutableListOf<Line>()
        val unsafe = LinkedHashSet<Path>()
        val exhausted = mutableListOf<String>()
        var quarantined = 0
        var unlinked = 0
        var hardLinks = 0
        var errors = 0
        private var qDir: Path? = null
        private var qNext = 0

        fun all(retry: Set<Path>) {
            if (retry.isNotEmpty()) {
                val r = step1(retry.sortedBy { it.nameCount }, dataDir)
                log += r.log
                unsafe.addAll(r.unsafe)
            }
            // The start fails anyway while anything is unsafe, and walking on could look entries
            // up through an ancestor that is still a link. Stop here.
            if (unsafe.isNotEmpty()) return
            if (!isRealDir(filesDir) || !isRealDir(dataDir)) {
                unsafe.add(filesDir)
                log += Line(LogLevel.ERROR, "[LinkHygiene] app storage root is not a real directory; nothing walked")
                return
            }
            replaceLinkedRoot(workspace)
            replaceLinkedRoot(filesDir.resolve(NODE_PROJECT))
            // Never look up a workspace entry through a root that is still a link.
            val wsReal = isRealDir(workspace)

            // Phase 3: the Node-read directories, completely.
            if (wsReal) {
                val nodeRead = NODE_READ_DIRS.map { workspace.resolve(it) }.filter { realDirOrNeutralise(it) }
                walk("Node-read directories", nodeRead.map { it to 1 }, b.nodeReadMaxEntries, null, skip = emptySet())
            }

            // Phase 4: Kotlin-owned directory entries, one level each.
            kotlinOwnedEntries()
            sweepKwrite()

            // Phase 5: the rest of the workspace, breadth-first, within the walk budget.
            if (wsReal) {
                walk(
                    "workspace", listOf(workspace to 0), b.walkMaxEntries, nanoTime() + b.walkMaxNanos,
                    skip = NODE_READ_DIRS.map { workspace.resolve(it) }.toSet(),
                )
            }
            pruneQuarantine()
        }

        /**
         * A linked root is moved aside and replaced by a fresh directory; an ERROR is logged. A link
         * that cannot be removed is `unsafe`: the start fails closed.
         */
        private fun replaceLinkedRoot(root: Path) {
            val a = lstatOrError(root) ?: return
            if (!a.isSymbolicLink) return
            if (!neutralise(root, failClosed = true)) return
            try {
                Files.createDirectory(root)
                log += Line(LogLevel.ERROR, "[LinkHygiene] linked root ${show(root)} replaced by a fresh directory")
            } catch (e: Exception) {
                errors++
                log += Line(LogLevel.ERROR, "[LinkHygiene] cannot recreate ${show(root)}: ${e.javaClass.simpleName}")
            }
        }

        /** True when [dir] is a real directory to walk; a link there is neutralised. */
        private fun realDirOrNeutralise(dir: Path): Boolean {
            val a = lstatOrError(dir) ?: return false
            if (a.isSymbolicLink) {
                neutralise(dir, failClosed = false)
                return false
            }
            return a.isDirectory
        }

        private fun kotlinOwnedEntries() {
            var entries = 0
            val dirs = listOf(filesDir, dataDir) + KOTLIN_DIRS.map { (inData, name) ->
                if (inData) dataDir.resolve(name) else filesDir.resolve(name)
            }
            for (dir in dirs) {
                if (!isRealDir(dir)) continue
                var stopped = false
                try {
                    ops.forEachEntry(dir) { child ->
                        if (entries >= b.kotlinDirsMaxEntries) {
                            stopped = true
                            return@forEachEntry false
                        }
                        entries++
                        // `dataDir/lib` is the system's link to the native-library directory on
                        // many Android builds; installd owns it and nothing of ours reads it.
                        if (child == dataDir.resolve("lib")) return@forEachEntry true
                        val a = lstatOrError(child)
                        if (a != null && a.isSymbolicLink) neutralise(child, failClosed = false)
                        true
                    }
                } catch (e: Exception) {
                    // IOException, or the unchecked DirectoryIteratorException.
                    errors++
                    log += Line(LogLevel.ERROR, "[LinkHygiene] cannot list ${show(dir)}: ${e.javaClass.simpleName}")
                }
                if (stopped) {
                    exhausted += "Kotlin-owned directories"
                    log += Line(LogLevel.ERROR, "[LinkHygiene] budget exhausted after $entries entries; not certified: ${show(dir)} and later directories")
                    return
                }
            }
        }

        /** Deletes `.kwrite/` entries older than [Budgets.kwriteStaleMs]: temps a crash left behind. */
        private fun sweepKwrite() {
            val kw = filesDir.resolve(SafeFs.KWRITE_DIR)
            if (!isRealDir(kw)) return
            val cutoff = wallClockMs() - b.kwriteStaleMs
            val deadline = nanoTime() + b.pruneMaxNanos
            var swept = 0
            try {
                ops.forEachEntry(kw) { child ->
                    if (nanoTime() >= deadline) return@forEachEntry false
                    val a = lstatOrError(child) ?: return@forEachEntry true
                    if (a.lastModifiedTime().toMillis() <= cutoff) {
                        try {
                            if (a.isDirectory && !a.isSymbolicLink) {
                                SafeFs.deleteTreeNoFollow(filesDir, child, 1_000L, deadline, nanoTime)
                            } else {
                                ops.unlink(child)
                            }
                            swept++
                        } catch (e: Exception) {
                            errors++
                        }
                    }
                    true
                }
            } catch (e: Exception) {
                errors++
            }
            if (swept > 0) log += Line(LogLevel.INFO, "[LinkHygiene] removed $swept leftover .kwrite temp(s)")
        }

        /**
         * Breadth-first, no-follow walk from [starts] (path, depth). Directories at [Budgets.maxDepth]
         * are not listed. Stops at [maxEntries] or [deadline]; what it did not reach is named in
         * one ERROR line.
         */
        private fun walk(
            name: String,
            starts: List<Pair<Path, Int>>,
            maxEntries: Int,
            deadline: Long?,
            skip: Set<Path>,
        ) {
            val queue = ArrayDeque(starts)
            val tooDeep = mutableListOf<Path>()
            var entries = 0
            var stoppedIn: Path? = null
            fun over() = entries >= maxEntries || (deadline != null && nanoTime() >= deadline)
            while (queue.isNotEmpty()) {
                if (over()) break
                val (dir, depth) = queue.removeFirst()
                try {
                    ops.forEachEntry(dir) { child ->
                        if (over()) {
                            stoppedIn = dir
                            return@forEachEntry false
                        }
                        entries++
                        val a = lstatOrError(child) ?: return@forEachEntry true
                        when {
                            a.isSymbolicLink -> neutralise(child, failClosed = false)
                            a.isDirectory -> when {
                                child in skip -> Unit
                                depth + 1 >= b.maxDepth -> tooDeep.add(child)
                                else -> queue.addLast(child to depth + 1)
                            }
                            a.isRegularFile -> removeIfHardLinked(child)
                        }
                        true
                    }
                } catch (e: Exception) {
                    errors++
                    log += Line(LogLevel.ERROR, "[LinkHygiene] cannot list ${show(dir)}: ${e.javaClass.simpleName}")
                }
                if (stoppedIn != null) break
            }
            val unwalked = listOfNotNull(stoppedIn) + queue.map { it.first }
            if (unwalked.isNotEmpty()) {
                exhausted += name
                val shown = unwalked.take(5).joinToString(", ") { show(it) }
                val more = if (unwalked.size > 5) " (+${unwalked.size - 5} more)" else ""
                log += Line(LogLevel.ERROR, "[LinkHygiene] $name: budget exhausted after $entries entries; not certified: $shown$more")
            }
            if (tooDeep.isNotEmpty()) {
                log += Line(LogLevel.ERROR, "[LinkHygiene] $name: deeper than ${b.maxDepth} levels, not certified: ${tooDeep.take(5).joinToString(", ") { show(it) }}")
            }
        }

        private fun removeIfHardLinked(file: Path) {
            val n = try {
                ops.nlink(file)
            } catch (e: Exception) {
                errors++
                null
            } ?: return
            if (n <= 1) return
            try {
                ops.unlink(file)
                hardLinks++
                log += Line(LogLevel.ERROR, "[LinkHygiene] removed hard-linked workspace name ${show(file)} (nlink=$n)")
            } catch (e: Exception) {
                errors++
                log += Line(LogLevel.ERROR, "[LinkHygiene] cannot remove hard-linked ${show(file)}: ${e.javaClass.simpleName}")
            }
        }

        /** Moves the link at [link] into quarantine, or unlinks it. False when it is still there. */
        private fun neutralise(link: Path, failClosed: Boolean): Boolean {
            val target = ops.readLink(link)
            val n = try {
                val dir = quarantineDir()
                val n = qNext++
                ops.rename(link, dir.resolve(n.toString()))
                n
            } catch (_: Exception) {
                null
            }
            if (n != null) {
                quarantined++
                appendManifest(n, link, target)
                log += Line(LogLevel.ERROR, "[LinkHygiene] quarantined link ${show(link)} -> ${escape(target ?: "?")}")
                return true
            }
            return try {
                ops.unlink(link)
                unlinked++
                log += Line(LogLevel.ERROR, "[LinkHygiene] unlinked link ${show(link)} -> ${escape(target ?: "?")}")
                true
            } catch (_: NoSuchFileException) {
                true
            } catch (e: Exception) {
                errors++
                if (failClosed) unsafe.add(link)
                log += Line(LogLevel.ERROR, "[LinkHygiene] cannot remove link ${show(link)}: ${e.javaClass.simpleName}")
                false
            }
        }

        /** `filesDir/quarantine/<ts>/`; both levels validated on every use (SafeFs.ensureRealDir). */
        private fun quarantineDir(): Path {
            val q = filesDir.resolve(QUARANTINE)
            val d = qDir ?: q.resolve(String.format(Locale.ROOT, "%013d", wallClockMs()))
            SafeFs.ensureRealDir(filesDir, q)
            SafeFs.ensureRealDir(filesDir, d)
            qDir = d // only once it exists, so the prune never counts a directory that is not there
            return d
        }

        private fun appendManifest(n: Int, link: Path, target: String?) {
            val dir = qDir ?: return
            val row = "$n\t${escape(rel(link))}\t${escape(target ?: "?")}\n"
            try {
                SafeFs.appendNoFollow(filesDir, dir.resolve(MANIFEST), row.toByteArray(Charsets.UTF_8))
            } catch (e: Exception) {
                errors++
            }
        }

        private fun pruneQuarantine() {
            val q = filesDir.resolve(QUARANTINE)
            if (!isRealDir(q)) return
            val names = mutableListOf<Path>()
            try {
                ops.forEachEntry(q) { names.add(it); names.size < 10_000 }
            } catch (e: Exception) {
                errors++
                return
            }
            // This run's directory is always kept and counts toward the newest [keepQuarantines].
            val keepOthers = if (qDir != null) b.keepQuarantines - 1 else b.keepQuarantines
            val old = names.filter { it != qDir }.sortedBy { it.fileName.toString() }.dropLast(keepOthers.coerceAtLeast(0))
            val deadline = nanoTime() + b.pruneMaxNanos
            for (p in old) {
                if (nanoTime() >= deadline) {
                    log += Line(LogLevel.WARN, "[LinkHygiene] quarantine prune stopped on its time bound; continues next start")
                    break
                }
                try {
                    SafeFs.deleteTreeNoFollow(filesDir, p, 10_000L, deadline, nanoTime)
                } catch (e: Exception) {
                    errors++
                }
            }
        }

        private fun isRealDir(p: Path): Boolean = try {
            val a = ops.lstat(p)
            a != null && a.isDirectory && !a.isSymbolicLink
        } catch (_: Exception) {
            false
        }

        private fun lstatOrError(p: Path): BasicFileAttributes? = try {
            ops.lstat(p)
        } catch (e: Exception) {
            errors++
            log += Line(LogLevel.ERROR, "[LinkHygiene] cannot check ${show(p)}: ${e.javaClass.simpleName}")
            null
        }

        private fun rel(p: Path): String = when {
            p.startsWith(filesDir) -> filesDir.relativize(p).toString()
            p.startsWith(dataDir) -> dataDir.relativize(p).toString()
            else -> p.toString()
        }

        private fun show(p: Path): String = escape(rel(p))
    }

    companion object {
        /** A unit test enforces this cap on [step1] over [criticalPaths]. */
        const val STEP1_MAX_LSTAT = 64

        const val WORKSPACE = "workspace"
        const val NODE_PROJECT = "nodejs-project"
        const val QUARANTINE = "quarantine"
        const val MANIFEST = "manifest.tsv"

        /** `filesDir` directories checked as entries in step 1. */
        val FILES_DIRS = listOf("burner_keys", SafeFs.KWRITE_DIR, QUARANTINE, "skill_ops", WORKSPACE)

        /**
         * `filesDir` files checked in step 1, with the `.tmp` siblings a writer uses. Node writes
         * the `runtime_state`, `agent_preferences` and `mcp_servers` stores through a fixed `.tmp`
         * name (`cross-process-store.js`, `mcp-servers.js`).
         */
        val FILES_FILES = listOf(
            "bridge_token", "service_state", "service_state_day", "service_logs", "service_stop_request",
            "runtime_state.json", "runtime_state.json.tmp", "burner_caps.json", "burner_caps.json.tmp",
            "agent_preferences.json", "agent_preferences.json.tmp", "mcp_servers.json", "mcp_servers.json.tmp",
            "xai_oauth.json", "xai_oauth.lock", "xai_oauth.migrated",
            "skill_state.json", "skill_state.init", "skill_state.floor", "skill_state.lock",
        )

        /** Directories Node core reads; walked first and completely in step 2. */
        val NODE_READ_DIRS = listOf("memory", "cron", "tasks", "skills")

        /**
         * Workspace files checked in step 1, with the `.tmp` siblings Node writes. Node writes the
         * three UI state files by fixed name (`ai.js`, `database.js`); `api_usage_state` directly.
         */
        val WORKSPACE_FILES = listOf(
            "owner_ids", "agent_settings.json", "agent_settings.json.tmp", "config.json",
            "seekerclaw.db", "seekerclaw.db.tmp", "node_debug.log",
            "agent_health_state", "agent_health_state.tmp", "api_usage_state",
            "db_summary_state", "db_summary_state.tmp",
        )

        /** (inDataDir, name): directories whose entries step 2 checks, one level. */
        private val KOTLIN_DIRS = listOf(true to "shared_prefs", false to "burner_keys", true to "databases")

        /**
         * Step 1's exact list. Parents come before their children, so a child is never looked up
         * through a parent that is still a link. [prefsNames] comes from `PrefsNames.ALL`.
         */
        fun criticalPaths(filesDir: Path, dataDir: Path, prefsNames: Collection<String>): List<Path> {
            val ws = filesDir.resolve(WORKSPACE)
            val sp = dataDir.resolve("shared_prefs")
            return buildList {
                add(filesDir)
                add(sp)
                add(dataDir.resolve("databases"))
                FILES_DIRS.forEach { add(filesDir.resolve(it)) }
                FILES_FILES.forEach { add(filesDir.resolve(it)) }
                prefsNames.forEach {
                    add(sp.resolve("$it.xml"))
                    add(sp.resolve("$it.xml.bak"))
                }
                NODE_READ_DIRS.forEach { add(ws.resolve(it)) }
                WORKSPACE_FILES.forEach { add(ws.resolve(it)) }
            }
        }

        /**
         * Escapes control characters (C0, DEL, C1), line and paragraph separators, bidi controls,
         * tab, newline and backslash; caps the length at 200. Keeps a manifest row on one line and
         * a log line readable as written.
         */
        fun escape(s: String): String {
            val sb = StringBuilder()
            for (c in s) {
                when {
                    c == '\\' -> sb.append("\\\\")
                    c == '\t' -> sb.append("\\t")
                    c == '\n' -> sb.append("\\n")
                    c == '\r' -> sb.append("\\r")
                    c < ' ' || c == '\u007f' -> sb.append(String.format(Locale.ROOT, "\\x%02x", c.code))
                    c in '\u0080'..'\u009f' || c == ' ' || c == ' ' ||
                        c in '‪'..'‮' || c in '⁦'..'⁩' ->
                        sb.append(String.format(Locale.ROOT, "\\u%04x", c.code))
                    else -> sb.append(c)
                }
                if (sb.length >= 200) {
                    sb.append("…")
                    break
                }
            }
            return sb.toString()
        }
    }
}
