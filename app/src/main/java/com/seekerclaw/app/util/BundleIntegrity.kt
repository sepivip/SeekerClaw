package com.seekerclaw.app.util

import java.io.IOException
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.NoSuchFileException
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.BasicFileAttributes
import java.util.Locale

/**
 * BAT-1409 P1-A (contract v3.2) — verify the extracted Node bundle against the APK's assets
 * before every start, and repair it when it differs. Node starts only on [Outcome.Verified] or
 * [Outcome.Repaired], after a final verify of the live tree has passed; the verified bytes
 * decide, never log severity or timestamps (S5).
 *
 * Pure JVM (no `android.*`; source guard in `BundleIntegrityTest`). The APK side comes through
 * [AssetSource]; Android passes an `AssetManager` adapter and an `Os.lstat` `nlink`.
 *
 * Boundary, as classified in the contract: it repairs persistent changes at the next start. It
 * does not protect in-memory handlers, the module cache or state files during the current
 * session (S6′).
 */
class BundleIntegrity(
    private val assets: AssetSource,
    private val filesDir: Path,
    private val dataDir: Path,
    private val usableSpace: () -> Long,
    private val log: (LogLevel, String) -> Unit,
    private val nlink: (Path) -> Long? = ::unixNlink,
    private val nanoTime: () -> Long = System::nanoTime,
    private val wallClockMs: () -> Long = System::currentTimeMillis,
    private val nonce: () -> String = { java.util.UUID.randomUUID().toString().substring(0, 8) },
    private val budgets: Budgets = Budgets(),
) {
    /** The APK's `assets/` tree, read-only. Paths are `/`-separated and relative to `assets/`. */
    interface AssetSource {
        /** Child names of [dir]; empty for a file (as `AssetManager.list`). */
        fun list(dir: String): List<String>

        fun open(path: String): InputStream
    }

    enum class Mode { TMP, IN_PLACE }

    enum class Reason { VERIFY_IO, VERIFY_BUDGET, ANCESTOR_MODULES, NO_SPACE, REPAIR_IO }

    sealed class Outcome {
        object Verified : Outcome() {
            override fun toString() = "Verified"
        }

        data class Repaired(val mode: Mode, val changed: List<String>) : Outcome()

        data class Failed(val stage: String, val reason: Reason) : Outcome()
    }

    /** Signed-off bounds (v3.2 P1-A). */
    data class Budgets(
        val totalNanos: Long = 10_000_000_000L,
        val ancestorDeleteNanos: Long = 2_000_000_000L,
        val ancestorDeleteEntries: Long = 50_000L,
        val sweepNanos: Long = 1_000_000_000L,
        val sweepEntries: Long = 10_000L,
    )

    /** Thrown inside a run when the 10 s budget is spent; becomes `Failed(VERIFY_BUDGET)`. */
    private class BudgetSpent : RuntimeException()

    /** A read error on either side: `Failed(VERIFY_IO)`, never a mismatch. */
    private class VerifyIo(cause: Throwable) : IOException(cause)

    private var deadline = 0L

    private val live: Path get() = filesDir.resolve(BUNDLE)

    /**
     * Runs the whole sequence: ancestor hygiene, the leftover sweep, verify, and repair when
     * needed. [updated] says the APK changed since the last persisted update time: a mismatch
     * is then logged as an update, otherwise as a tamper event naming only relative paths.
     * [persistUpdateTime] runs only after a final verify passes. Never throws.
     */
    fun run(updated: Boolean, persistUpdateTime: () -> Unit): Outcome {
        val start = nanoTime()
        deadline = start + budgets.totalNanos
        val outcome = try {
            runChecked(updated)
        } catch (_: BudgetSpent) {
            Outcome.Failed("budget", Reason.VERIFY_BUDGET)
        } catch (e: Exception) {
            log(LogLevel.ERROR, "[Bundle] unexpected ${e.javaClass.simpleName}")
            Outcome.Failed("unexpected", Reason.REPAIR_IO)
        }
        if (outcome !is Outcome.Failed && updated) {
            try {
                persistUpdateTime()
            } catch (e: Exception) {
                log(LogLevel.WARN, "[Bundle] could not persist the update time: ${e.javaClass.simpleName}")
            }
        }
        val ms = (nanoTime() - start) / 1_000_000
        val summary = when (outcome) {
            Outcome.Verified -> "verified"
            is Outcome.Repaired -> "repaired (${outcome.mode}, ${outcome.changed.size} change(s))"
            is Outcome.Failed -> "failed at ${outcome.stage}: ${outcome.reason}"
        }
        log(if (outcome is Outcome.Failed) LogLevel.ERROR else LogLevel.INFO, "[Bundle] $summary in ${ms}ms")
        return outcome
    }

    private fun runChecked(updated: Boolean): Outcome {
        if (!ancestorHygiene()) return Outcome.Failed("ancestor", Reason.ANCESTOR_MODULES)
        sweepLeftovers()
        val expected = expectedFiles()
        val first = try {
            verify(live, expected)
        } catch (e: VerifyIo) {
            log(LogLevel.ERROR, "[Bundle] verify read error: ${e.cause?.javaClass?.simpleName}")
            return Outcome.Failed("verify", Reason.VERIFY_IO)
        }
        if (first.isEmpty()) return Outcome.Verified
        // Names come from the tree on disk, so they are escaped: a planted name cannot forge log lines.
        val shown = first.take(10).joinToString(", ") { LinkHygiene.escape(it) } +
            if (first.size > 10) " (+${first.size - 10} more)" else ""
        if (updated) {
            log(LogLevel.INFO, "[Bundle] app update: re-extracting (${first.size} change(s))")
        } else {
            log(LogLevel.ERROR, "[Bundle] bundle differs from the app's copy, repairing: $shown")
        }
        return repair(expected, first)
    }

    // ------------------------------------------------------------------ ancestor hygiene

    /**
     * `filesDir/node_modules` and `dataDir/node_modules` sit on Node's module search path above
     * the bundle. Each is renamed into `filesDir/quarantine/<ts>/`; only if that fails is it
     * deleted no-follow within its bound. False when one could be neither moved nor deleted.
     */
    private fun ancestorHygiene(): Boolean {
        for (p in listOf(filesDir.resolve(NODE_MODULES), dataDir.resolve(NODE_MODULES))) {
            checkBudget()
            if (!existsNoFollow(p)) continue
            val moved = try {
                val q = filesDir.resolve(QUARANTINE)
                SafeFs.ensureRealDir(filesDir, q)
                val dir = SafeFs.ensureRealDir(filesDir, q.resolve(String.format(Locale.ROOT, "%013d-modules", wallClockMs())))
                Files.move(p, dir.resolve("${p.parent.fileName}-$NODE_MODULES"), StandardCopyOption.ATOMIC_MOVE)
                true
            } catch (_: Exception) {
                false
            }
            if (moved) {
                log(LogLevel.ERROR, "[Bundle] quarantined a planted ${rel(p)}")
                continue
            }
            val res = try {
                SafeFs.deleteTreeNoFollow(
                    rootOf(p), p, budgets.ancestorDeleteEntries,
                    minOf(deadline, nanoTime() + budgets.ancestorDeleteNanos), nanoTime,
                )
            } catch (_: Exception) {
                null
            }
            if (res != null && res.clean && !existsNoFollow(p)) {
                log(LogLevel.ERROR, "[Bundle] deleted a planted ${rel(p)}")
                continue
            }
            log(LogLevel.ERROR, "[Bundle] cannot remove a planted ${rel(p)}; Node does not start")
            return false
        }
        return true
    }

    /** Leftover `nodejs-project.tmp-*` / `.old-*` from an interrupted repair. Not fatal. */
    private fun sweepLeftovers() {
        val sweepDeadline = minOf(deadline, nanoTime() + budgets.sweepNanos)
        var entriesLeft = budgets.sweepEntries
        val leftovers = try {
            Files.newDirectoryStream(filesDir) { p ->
                val n = p.fileName.toString()
                n.startsWith("$BUNDLE.tmp-") || n.startsWith("$BUNDLE.old-")
            }.use { s -> s.toList() }
        } catch (e: Exception) {
            log(LogLevel.WARN, "[Bundle] leftover sweep could not list: ${e.javaClass.simpleName}")
            return
        }
        // The entry bound is shared: each leftover gets an equal part of it.
        val perLeftover = if (leftovers.isEmpty()) 0L else maxOf(1L, entriesLeft / leftovers.size)
        for (p in leftovers) {
            if (nanoTime() >= sweepDeadline || entriesLeft <= 0) {
                log(LogLevel.WARN, "[Bundle] leftover sweep stopped on its bound; continues next start")
                return
            }
            try {
                val r = SafeFs.deleteTreeNoFollow(filesDir, p, minOf(perLeftover, entriesLeft), sweepDeadline, nanoTime)
                entriesLeft -= perLeftover
                if (!r.clean) log(LogLevel.WARN, "[Bundle] leftover ${LinkHygiene.escape(p.fileName.toString())} partly removed (${r.residue} left)")
            } catch (e: Exception) {
                log(LogLevel.WARN, "[Bundle] leftover ${LinkHygiene.escape(p.fileName.toString())} not removed: ${e.javaClass.simpleName}")
            }
        }
    }

    // ------------------------------------------------------------------------------ verify

    /** Every directory that holds an expected file (`/`-separated, relative), for the exact-tree check. */
    private fun expectedDirs(expected: Map<String, String>): Set<String> {
        val dirs = HashSet<String>()
        for (rel in expected.keys) {
            var i = rel.lastIndexOf('/')
            while (i > 0) {
                if (!dirs.add(rel.substring(0, i))) break
                i = rel.lastIndexOf('/', i - 1)
            }
        }
        return dirs
    }

    /** Relative file path (`/`-separated) → asset path, for every file under `assets/nodejs-project`. */
    private fun expectedFiles(): Map<String, String> {
        val out = linkedMapOf<String, String>()
        fun walk(assetDir: String, rel: String) {
            checkBudget()
            val children = try {
                assets.list(assetDir)
            } catch (e: Exception) {
                throw VerifyIo(e)
            }
            if (children.isEmpty()) {
                out[rel] = assetDir
                return
            }
            for (c in children) walk("$assetDir/$c", if (rel.isEmpty()) c else "$rel/$c")
        }
        walk(BUNDLE, "")
        return out
    }

    /**
     * Compares [root] with [expected]. Returns the differing relative paths (empty = identical).
     * A link, a non-regular entry, an extra file or directory, a missing file, a file with
     * `nlink > 1`, and the first differing byte or an early EOF are all differences. A read error
     * on either side throws [VerifyIo].
     */
    private fun verify(root: Path, expected: Map<String, String>): List<String> {
        val diffs = mutableListOf<String>()
        val dirsExpected = expectedDirs(expected)
        val rootAttrs = lstat(root)
        if (rootAttrs == null || rootAttrs.isSymbolicLink || !rootAttrs.isDirectory) {
            return listOf(".")
        }
        val seen = HashSet<String>()
        val dirs = ArrayDeque<Pair<Path, String>>()
        dirs.addLast(root to "")
        while (dirs.isNotEmpty()) {
            val (dir, relDir) = dirs.removeFirst()
            val children = try {
                Files.newDirectoryStream(dir).use { s -> s.toList() }
            } catch (e: Exception) {
                throw VerifyIo(e)
            }
            for (child in children) {
                checkBudget()
                val rel = if (relDir.isEmpty()) child.fileName.toString() else "$relDir/${child.fileName}"
                val a = lstat(child) ?: continue
                when {
                    a.isSymbolicLink -> diffs += rel
                    a.isDirectory -> {
                        if (rel !in dirsExpected) diffs += rel
                        dirs.addLast(child to rel)
                    }
                    !a.isRegularFile -> diffs += rel
                    rel !in expected -> diffs += rel
                    else -> {
                        seen += rel
                        val n = try {
                            nlink(child)
                        } catch (e: Exception) {
                            throw VerifyIo(e)
                        }
                        if ((n != null && n > 1) || !sameBytes(child, expected.getValue(rel))) diffs += rel
                    }
                }
            }
        }
        expected.keys.filter { it !in seen }.forEach { diffs += it }
        return diffs.sorted()
    }

    /** Byte-for-byte comparison; stops at the first differing byte or at EOF on either side. */
    private fun sameBytes(file: Path, asset: String): Boolean {
        val a = try {
            assets.open(asset)
        } catch (e: Exception) {
            throw VerifyIo(e)
        }
        a.use { ain ->
            val f = try {
                SafeFs.openReadNoFollow(filesDir, file)
            } catch (e: Exception) {
                throw VerifyIo(e)
            }
            f.use { fin ->
                val ba = ByteArray(BUF)
                val bf = ByteArray(BUF)
                while (true) {
                    checkBudget()
                    val na = readFully(ain, ba)
                    val nf = readFully(fin, bf)
                    if (na != nf) return false
                    if (na == 0) return true
                    for (i in 0 until na) if (ba[i] != bf[i]) return false
                }
            }
        }
    }

    private fun readFully(input: InputStream, buf: ByteArray): Int {
        var off = 0
        try {
            while (off < buf.size) {
                val n = input.read(buf, off, buf.size - off)
                if (n < 0) break
                off += n
            }
        } catch (e: IOException) {
            throw VerifyIo(e)
        }
        return off
    }

    // ------------------------------------------------------------------------------ repair

    private fun repair(expected: Map<String, String>, changed: List<String>): Outcome {
        val bundleBytes = expectedBytes(expected)
        var mode = if (usableSpace() >= 2 * bundleBytes) Mode.TMP else Mode.IN_PLACE
        if (mode == Mode.TMP) {
            when (val r = repairTmp(expected, changed)) {
                is TmpResult.Done -> return r.outcome
                TmpResult.NoSpace -> {
                    mode = if (usableSpace() >= 2 * bundleBytes) Mode.TMP else Mode.IN_PLACE
                    if (mode == Mode.TMP) return Outcome.Failed("tmp-copy", Reason.NO_SPACE)
                    log(LogLevel.WARN, "[Bundle] out of space for a side copy; repairing in place")
                }
            }
        }
        return repairInPlace(expected, changed)
    }

    private sealed class TmpResult {
        data class Done(val outcome: Outcome) : TmpResult()
        object NoSpace : TmpResult()
    }

    /**
     * TMP mode, one attempt: copy into `.tmp-<nonce>` → verify → live → `.old-<nonce>` →
     * tmp → live → verify live → delete `.old`. A copy or verify failure because the device is
     * out of space returns [TmpResult.NoSpace]; any other failure is `Failed(REPAIR_IO)` with the
     * live tree untouched. A failure after a rename is `Failed` with no rollback: the next start
     * verifies and repairs again.
     */
    private fun repairTmp(expected: Map<String, String>, changed: List<String>): TmpResult {
        val n = nonce()
        val tmp = filesDir.resolve("$BUNDLE.tmp-$n")
        val old = filesDir.resolve("$BUNDLE.old-$n")
        try {
            copyTree(expected, tmp)
            if (verify(tmp, expected).isNotEmpty()) {
                deleteQuietly(tmp)
                return TmpResult.Done(Outcome.Failed("tmp-verify", Reason.REPAIR_IO))
            }
        } catch (e: VerifyIo) {
            deleteQuietly(tmp)
            if (isNoSpace(e)) return TmpResult.NoSpace
            return TmpResult.Done(Outcome.Failed("tmp-verify", Reason.VERIFY_IO))
        } catch (e: BudgetSpent) {
            deleteQuietly(tmp)
            throw e
        } catch (e: Exception) {
            deleteQuietly(tmp)
            if (isNoSpace(e)) return TmpResult.NoSpace
            log(LogLevel.ERROR, "[Bundle] side copy failed: ${e.javaClass.simpleName}")
            return TmpResult.Done(Outcome.Failed("tmp-copy", Reason.REPAIR_IO))
        }
        try {
            if (existsNoFollow(live)) Files.move(live, old, StandardCopyOption.ATOMIC_MOVE)
            Files.move(tmp, live, StandardCopyOption.ATOMIC_MOVE)
        } catch (e: Exception) {
            log(LogLevel.ERROR, "[Bundle] swap failed: ${e.javaClass.simpleName}")
            deleteQuietly(tmp)
            return TmpResult.Done(Outcome.Failed("swap", Reason.REPAIR_IO))
        }
        val after = try {
            verify(live, expected)
        } catch (_: VerifyIo) {
            return TmpResult.Done(Outcome.Failed("final-verify", Reason.VERIFY_IO))
        }
        if (after.isNotEmpty()) return TmpResult.Done(Outcome.Failed("final-verify", Reason.REPAIR_IO))
        deleteQuietly(old)
        return TmpResult.Done(Outcome.Repaired(Mode.TMP, changed))
    }

    /**
     * IN_PLACE mode, only when the capacity policy selects it: no-follow delete of the live
     * tree → `lstat` confirms it is gone (otherwise `Failed`, with no copy into a partly deleted
     * path) → copy → verify.
     */
    private fun repairInPlace(expected: Map<String, String>, changed: List<String>): Outcome {
        val res = try {
            SafeFs.deleteTreeNoFollow(filesDir, live, Long.MAX_VALUE, deadline, nanoTime)
        } catch (e: Exception) {
            log(LogLevel.ERROR, "[Bundle] in-place delete refused: ${e.javaClass.simpleName}")
            return Outcome.Failed("in-place-delete", Reason.REPAIR_IO)
        }
        if (!res.clean && nanoTime() >= deadline) throw BudgetSpent()
        if (!res.clean || existsNoFollow(live)) {
            log(LogLevel.ERROR, "[Bundle] in-place delete left ${res.residue} entries; not copying")
            return Outcome.Failed("in-place-delete", Reason.REPAIR_IO)
        }
        try {
            copyTree(expected, live)
        } catch (e: BudgetSpent) {
            throw e
        } catch (e: Exception) {
            log(LogLevel.ERROR, "[Bundle] in-place copy failed: ${e.javaClass.simpleName}")
            return Outcome.Failed("in-place-copy", if (isNoSpace(e)) Reason.NO_SPACE else Reason.REPAIR_IO)
        }
        val after = try {
            verify(live, expected)
        } catch (_: VerifyIo) {
            return Outcome.Failed("final-verify", Reason.VERIFY_IO)
        }
        return if (after.isEmpty()) Outcome.Repaired(Mode.IN_PLACE, changed) else Outcome.Failed("final-verify", Reason.REPAIR_IO)
    }

    /** Copies every expected file into [dest], which must not exist yet. Never follows a link. */
    private fun copyTree(expected: Map<String, String>, dest: Path) {
        SafeFs.checkAncestors(filesDir, dest)
        Files.createDirectory(dest)
        for ((rel, asset) in expected) {
            checkBudget()
            val target = dest.resolve(rel)
            assets.open(asset).use { input ->
                SafeFs.createNewFrom(filesDir, target) { out ->
                    val buf = ByteArray(BUF)
                    while (true) {
                        checkBudget()
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                    }
                }
            }
        }
    }

    private fun expectedBytes(expected: Map<String, String>): Long {
        var total = 0L
        for (asset in expected.values) {
            checkBudget()
            assets.open(asset).use { input ->
                val buf = ByteArray(BUF)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    total += n
                }
            }
        }
        return total
    }

    // ----------------------------------------------------------------------------- helpers

    private fun checkBudget() {
        if (nanoTime() >= deadline) throw BudgetSpent()
    }

    private fun lstat(p: Path): BasicFileAttributes? = try {
        Files.readAttributes(p, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
    } catch (_: NoSuchFileException) {
        null
    } catch (e: IOException) {
        throw VerifyIo(e)
    }

    private fun existsNoFollow(p: Path) = SafeFs.existsNoFollow(p)

    private fun deleteQuietly(p: Path) {
        try {
            if (existsNoFollow(p)) SafeFs.deleteTreeNoFollow(filesDir, p, Long.MAX_VALUE, null, nanoTime)
        } catch (_: Exception) {
        }
    }

    private fun rootOf(p: Path): Path = if (p.startsWith(filesDir)) filesDir else dataDir

    private fun rel(p: Path): String = when {
        p.startsWith(filesDir) -> "files/" + filesDir.relativize(p)
        p.startsWith(dataDir) -> dataDir.relativize(p).toString()
        else -> p.toString()
    }

    companion object {
        const val BUNDLE = "nodejs-project"
        const val NODE_MODULES = "node_modules"
        const val QUARANTINE = "quarantine"
        private const val BUF = 64 * 1024

        /** `ENOSPC`/`EDQUOT` anywhere in the cause chain, or the JDK's "No space left" text. */
        fun isNoSpace(e: Throwable): Boolean {
            var t: Throwable? = e
            var depth = 0
            while (t != null && depth < 10) {
                val m = t.message ?: ""
                if (m.contains("ENOSPC") || m.contains("EDQUOT") || m.contains("No space left") ||
                    m.contains("Disk quota exceeded")
                ) return true
                t = t.cause
                depth++
            }
            return false
        }

        fun unixNlink(p: Path): Long? = try {
            (Files.getAttribute(p, "unix:nlink", LinkOption.NOFOLLOW_LINKS) as Number).toLong()
        } catch (_: UnsupportedOperationException) {
            null
        } catch (_: IllegalArgumentException) {
            null
        }
    }
}
