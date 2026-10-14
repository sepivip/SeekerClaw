package com.seekerclaw.app.util

import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.FileVisitOption
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.NoSuchFileException
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
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

    // ---------------------------------------------------------------- P1-J: writes and reads

    /** Name of the Kotlin-only staging directory, a direct child of the writer root. */
    const val KWRITE_DIR = ".kwrite"

    /**
     * The app's `filesDir`, set once per process at startup (`SeekerClawApplication`). Writers
     * that only know a target file use it as the ancestor-rule root via [rootFor]. Pure unit tests
     * leave it null and pass roots explicitly.
     */
    @Volatile
    var filesRoot: Path? = null

    /**
     * Directory fsync after a rename, for [writeAtomic] with `durable = true`. The JVM default
     * opens the directory read-only and forces it; Android may replace it with an
     * `Os.open(O_RDONLY | O_DIRECTORY)` + `Os.fsync` implementation. Failures are swallowed: the
     * rename itself has already happened and is atomic.
     */
    @Volatile
    var dirSync: (Path) -> Unit = { dir ->
        try {
            FileChannel.open(dir, StandardOpenOption.READ).use { it.force(true) }
        } catch (_: Exception) {
        }
    }

    /** The ancestor-rule root for [target]: [filesRoot] when it contains [target], else its parent. */
    fun rootFor(target: Path): Path {
        val t = target.toAbsolutePath().normalize()
        val fr = filesRoot?.toAbsolutePath()?.normalize()
        return if (fr != null && t.startsWith(fr) && t != fr) fr else t.parent
    }

    /**
     * P1-J — the one Kotlin writer. Writes [bytes] to [target] without ever writing through a
     * link:
     * 1. the ancestor rule from [root] (missing parents are created, no-follow);
     * 2. a temp file is created with `CREATE_NEW` (`O_CREAT | O_EXCL`, fails on any existing
     *    entry, including a dangling link) in `<root>/.kwrite/`, validated on every use;
     * 3. the bytes are written and forced;
     * 4. `Files.move(tmp, target, ATOMIC_MOVE)`: `rename(2)` replaces a final-component link and
     *    never follows it;
     * 5. with [durable], the target's directory is fsynced ([dirSync]) for callers whose later
     *    step depends on this write.
     * The temp file is deleted on any failure.
     */
    fun writeAtomic(root: Path, target: Path, bytes: ByteArray, durable: Boolean = false) {
        writeAtomicFrom(root, target, durable) { out -> out.write(bytes) }
    }

    fun writeAtomicText(root: Path, target: Path, text: String, durable: Boolean = false) =
        writeAtomic(root, target, text.toByteArray(Charsets.UTF_8), durable)

    /** Streaming form of [writeAtomic] (asset copies, ZIP extraction). */
    fun writeAtomicFrom(root: Path, target: Path, durable: Boolean = false, write: (OutputStream) -> Unit) {
        checkAncestors(root, target, createParents = true)
        if (isRealDir(target)) throw UnsafePathException("target is a directory: $target")
        val kwrite = ensureRealDir(root, root.resolve(KWRITE_DIR))
        val tmp = Files.createTempFile(kwrite, ".sc-", ".tmp")
        try {
            FileChannel.open(tmp, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS).use { ch ->
                val out = java.nio.channels.Channels.newOutputStream(ch)
                write(out)
                out.flush()
                ch.force(true)
            }
            moveReplacing(tmp, target)
            if (durable) dirSync(target.toAbsolutePath().parent)
        } finally {
            try {
                Files.deleteIfExists(tmp)
            } catch (_: IOException) {
            }
        }
    }

    /** `rename(2)` [src] over [dst], replacing a file or link at [dst] without following it. */
    private fun moveReplacing(src: Path, dst: Path) {
        try {
            Files.move(src, dst, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (_: AtomicMoveNotSupportedException) {
            // Same filesystem in practice; the non-atomic form is still a single rename.
            Files.move(src, dst, StandardCopyOption.REPLACE_EXISTING)
        }
    }

    /**
     * Moves a regular file [src] onto [dst] (staging promotion). Both paths obey the ancestor
     * rule; [src] must be a regular file (`lstat`), and a link at [dst] is replaced, not followed.
     */
    fun moveNoFollow(root: Path, src: Path, dst: Path) {
        checkAncestors(root, src)
        checkAncestors(root, dst, createParents = true)
        if (!Files.isRegularFile(src, *NOFOLLOW)) throw UnsafePathException("move source is not a regular file: $src")
        if (isRealDir(dst)) throw UnsafePathException("move target is a directory: $dst")
        moveReplacing(src, dst)
    }

    /**
     * Creates [target], which must not exist, and streams its content (P1-A bundle extraction into
     * a fresh tree). `CREATE_NEW` fails on any existing entry, a dangling link included, so nothing
     * is ever written through a link. No fsync: the bundle is verified before every start instead.
     */
    fun createNewFrom(root: Path, target: Path, write: (OutputStream) -> Unit) {
        checkAncestors(root, target, createParents = true)
        Files.newOutputStream(
            target,
            StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS,
        ).use { write(it) }
    }

    /** Appends [bytes] to [target] (created if missing) without following a link at any depth. */
    fun appendNoFollow(root: Path, target: Path, bytes: ByteArray) {
        checkAncestors(root, target, createParents = true)
        Files.newOutputStream(
            target,
            StandardOpenOption.CREATE, StandardOpenOption.APPEND, StandardOpenOption.WRITE,
            LinkOption.NOFOLLOW_LINKS,
        ).use { it.write(bytes) }
    }

    /** Opens [target] for reading without following a link at any depth. */
    fun openReadNoFollow(root: Path, target: Path): InputStream {
        checkAncestors(root, target)
        return Files.newInputStream(target, LinkOption.NOFOLLOW_LINKS)
    }

    /** Opens a read channel on [target] (seekable reads) without following a link at any depth. */
    fun openReadChannelNoFollow(root: Path, target: Path): FileChannel {
        checkAncestors(root, target)
        return FileChannel.open(target, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)
    }

    /** Reads exactly [len] bytes at [pos] of [target] without following a link at any depth. */
    fun readRangeNoFollow(root: Path, target: Path, pos: Long, len: Int): ByteArray =
        openReadChannelNoFollow(root, target).use { ch ->
            val buf = ByteBuffer.allocate(len)
            var p = pos
            while (buf.hasRemaining()) {
                val n = ch.read(buf, p)
                if (n < 0) throw java.io.EOFException("short read at $p")
                p += n
            }
            buf.array()
        }

    fun readBytesNoFollow(root: Path, target: Path): ByteArray =
        openReadNoFollow(root, target).use { it.readBytes() }

    fun readTextNoFollow(root: Path, target: Path): String =
        String(readBytesNoFollow(root, target), Charsets.UTF_8)

    /**
     * Opens (creating if missing) a lock file's channel without following a link at any depth.
     * Replaces `RandomAccessFile(lockFile, "rw")`, which follows a link (Codex R3).
     */
    fun openLockChannelNoFollow(root: Path, target: Path): FileChannel {
        checkAncestors(root, target, createParents = true)
        return FileChannel.open(
            target,
            StandardOpenOption.READ, StandardOpenOption.WRITE, StandardOpenOption.CREATE,
            LinkOption.NOFOLLOW_LINKS,
        )
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
