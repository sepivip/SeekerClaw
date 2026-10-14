package com.seekerclaw.app.util

import java.io.IOException
import java.nio.file.FileVisitOption
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.NoSuchFileException
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.attribute.PosixFilePermission
import java.util.EnumSet

/**
 * BAT-1409 P1-J / P1-M — link-safe filesystem helpers for Kotlin-owned paths.
 *
 * Pure JVM (`java.nio.file` only, no `android.*`) so every rule is unit-testable on the host.
 *
 * Guarantee (contract v3.2, classified per Codex R3): planted links — left by an earlier
 * escaped `js_eval` session or a compromise from before the upgrade — are never followed by
 * these helpers, at any path depth. The guarantee assumes no escaped code is *concurrently*
 * swapping a parent directory between the check and the operation (quiescence). That race is
 * owner-accepted residual risk S6′; a race-free version needs descriptor-relative operations
 * (Phase 2, P2-E).
 */
object SafeFs {

    /** Thrown when a path component that must be a real directory is a link or a non-directory. */
    class UnsafePathException(message: String) : IOException(message)

    private val NOFOLLOW = arrayOf(LinkOption.NOFOLLOW_LINKS)

    /** `lstat`-based: true only for a real directory (a link to a directory is false). */
    fun isRealDir(p: Path): Boolean = Files.isDirectory(p, *NOFOLLOW)

    /** `lstat`-based existence: true for a dangling link too. */
    fun existsNoFollow(p: Path): Boolean = Files.exists(p, *NOFOLLOW)

    /**
     * The ancestor rule (Codex R3). [root] must be a real directory, and every component from
     * [root] down to [target]'s parent must be a real directory, never a link. [target] itself
     * is not checked here — callers decide what a link at the final component means.
     *
     * Missing intermediate directories are created one segment at a time when [createParents]
     * is true. `Files.createDirectory` never follows a link: if a link appears at that name the
     * call fails and the re-check below refuses it.
     *
     * @throws UnsafePathException when a component is a link or not a directory, or when
     *   [target] is not strictly inside [root].
     */
    fun checkAncestors(root: Path, target: Path, createParents: Boolean = false) {
        val r = root.toAbsolutePath().normalize()
        val t = target.toAbsolutePath().normalize()
        if (Files.isSymbolicLink(r) || !isRealDir(r)) {
            throw UnsafePathException("root is not a real directory: $r")
        }
        if (!t.startsWith(r) || t == r) {
            throw UnsafePathException("target is not inside root: $t")
        }
        val rel = r.relativize(t)
        var cur = r
        // Every element except the last is a directory that must be real.
        for (i in 0 until rel.nameCount - 1) {
            cur = cur.resolve(rel.getName(i))
            if (!existsNoFollow(cur)) {
                if (!createParents) return // nothing further exists below a missing segment
                try {
                    Files.createDirectory(cur)
                } catch (_: java.nio.file.FileAlreadyExistsException) {
                    // A concurrent creator, or a link that appeared: re-checked below.
                }
            }
            if (Files.isSymbolicLink(cur) || !isRealDir(cur)) {
                throw UnsafePathException("ancestor is a link or not a directory: $cur")
            }
        }
    }

    /**
     * Ensures [dir] is a real directory, creating it (and missing parents) without following
     * links. Used for Kotlin-only helper roots (`.kwrite/`, `quarantine/<ts>/`), which are
     * validated on every use and never certified by a boot sweep (Codex R3), and for directories
     * Kotlin recreates (`workspace/memory/`). A link or non-directory at that name is removed
     * without following it, then the directory is recreated and re-checked.
     */
    fun ensureRealDir(root: Path, dir: Path): Path {
        checkAncestors(root, dir, createParents = true)
        if (existsNoFollow(dir) && (Files.isSymbolicLink(dir) || !isRealDir(dir))) {
            Files.delete(dir) // unlinks a link; never touches its target
        }
        if (!existsNoFollow(dir)) {
            try {
                Files.createDirectory(dir)
            } catch (_: java.nio.file.FileAlreadyExistsException) {
                // re-checked below
            }
        }
        if (Files.isSymbolicLink(dir) || !isRealDir(dir)) {
            throw UnsafePathException("helper directory is not a real directory: $dir")
        }
        return dir
    }

    /**
     * Visits every regular file under [start] without following links. Links and unreadable
     * entries are skipped (an unreadable directory or a file that vanishes mid-walk does not
     * abort the walk, matching the old `walkTopDown` tolerance). Exceptions thrown by [action]
     * propagate to the caller.
     */
    fun forEachRegularFileNoFollow(start: Path, action: (Path, BasicFileAttributes) -> Unit) {
        if (!existsNoFollow(start)) return
        Files.walkFileTree(
            start,
            EnumSet.noneOf(FileVisitOption::class.java),
            Int.MAX_VALUE,
            object : SimpleFileVisitor<Path>() {
                override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                    if (attrs.isRegularFile) action(file, attrs)
                    return FileVisitResult.CONTINUE
                }

                override fun visitFileFailed(file: Path, exc: IOException): FileVisitResult =
                    FileVisitResult.CONTINUE
            },
        )
    }

    /** Outcome of [deleteTreeNoFollow]. `residue` counts entries that could not be removed. */
    data class DeleteResult(val residue: Int, val completed: Boolean) {
        val clean: Boolean get() = residue == 0 && completed
    }

    /**
     * P1-M — the one recursive delete for Kotlin. It never follows a link:
     * 1. the ancestor rule applies to [target] (from [root]);
     * 2. a link at [target] itself is unlinked and nothing else happens;
     * 3. a tree is walked without `FOLLOW_LINKS`, so links inside it are deleted as files.
     *
     * A directory that cannot be opened reaches `visitFileFailed` (the walker opens it before
     * `preVisitDirectory`). If `lstat` shows a real directory, owner `rwx` is restored by path
     * (safe under quiescence) and the directory is walked once more; a second failure counts as
     * residue. Boot-time callers pass a bound; an unfinished delete reports `completed = false`
     * and never throws for that reason.
     *
     * @param maxEntries stop after this many entries (bounded boot callers); default unbounded.
     * @param deadlineNanos absolute [System.nanoTime] deadline, or null for none.
     */
    fun deleteTreeNoFollow(
        root: Path,
        target: Path,
        maxEntries: Long = Long.MAX_VALUE,
        deadlineNanos: Long? = null,
        nanoTime: () -> Long = System::nanoTime,
    ): DeleteResult {
        checkAncestors(root, target)
        if (!existsNoFollow(target)) return DeleteResult(0, true)
        if (Files.isSymbolicLink(target) || !isRealDir(target)) {
            Files.delete(target)
            return DeleteResult(0, true)
        }
        val walker = NoFollowDeleter(maxEntries, deadlineNanos, nanoTime)
        walker.deleteFrom(target)
        if (walker.unopened.isEmpty() || walker.stopped) {
            return DeleteResult(walker.residue, !walker.stopped)
        }
        // Second and final pass: restore owner rwx on each directory that could not be opened
        // (by path, after an lstat check), then walk the whole remaining tree once more. Only
        // this pass's failures count as residue.
        for (dir in walker.unopened) {
            if (Files.isSymbolicLink(dir) || !isRealDir(dir)) continue
            try {
                Files.setPosixFilePermissions(
                    dir,
                    EnumSet.of(
                        PosixFilePermission.OWNER_READ,
                        PosixFilePermission.OWNER_WRITE,
                        PosixFilePermission.OWNER_EXECUTE,
                    ),
                )
            } catch (_: Exception) {
                // the second walk records it as residue
            }
        }
        walker.unopened.clear()
        walker.residue = 0
        walker.retrying = true
        if (existsNoFollow(target)) walker.deleteFrom(target)
        return DeleteResult(walker.residue, !walker.stopped)
    }

    private class NoFollowDeleter(
        private val maxEntries: Long,
        private val deadlineNanos: Long?,
        private val nanoTime: () -> Long,
    ) : SimpleFileVisitor<Path>() {
        var residue = 0
        var stopped = false
        var retrying = false
        val unopened = mutableListOf<Path>()
        private var seen = 0L

        fun deleteFrom(start: Path) {
            Files.walkFileTree(start, EnumSet.noneOf(FileVisitOption::class.java), Int.MAX_VALUE, this)
        }

        private fun overBudget(): Boolean {
            seen++
            if (seen > maxEntries) return true
            val d = deadlineNanos
            return d != null && nanoTime() - d > 0
        }

        override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
            if (overBudget()) { stopped = true; return FileVisitResult.TERMINATE }
            // Without FOLLOW_LINKS a link (to a file or a directory) arrives here: delete the link.
            try {
                Files.delete(file)
            } catch (_: NoSuchFileException) {
            } catch (_: Exception) {
                residue++
            }
            return FileVisitResult.CONTINUE
        }

        override fun visitFileFailed(file: Path, exc: IOException): FileVisitResult {
            if (overBudget()) { stopped = true; return FileVisitResult.TERMINATE }
            if (!retrying && !Files.isSymbolicLink(file) && isRealDir(file)) {
                unopened.add(file)
            } else if (existsNoFollow(file)) {
                residue++
            }
            return FileVisitResult.CONTINUE
        }

        override fun postVisitDirectory(dir: Path, exc: IOException?): FileVisitResult {
            if (overBudget()) { stopped = true; return FileVisitResult.TERMINATE }
            try {
                Files.delete(dir)
            } catch (_: NoSuchFileException) {
            } catch (_: Exception) {
                // Non-empty because a child was residue or an unopened directory awaits its retry.
                if (!unopened.any { it.startsWith(dir) }) residue++
            }
            return FileVisitResult.CONTINUE
        }
    }
}
