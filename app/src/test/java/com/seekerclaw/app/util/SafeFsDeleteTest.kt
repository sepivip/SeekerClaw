package com.seekerclaw.app.util

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermissions

/**
 * BAT-1409 P1-M — the no-follow recursive delete. Every case plants a link to a sentinel outside
 * the delete root and asserts the sentinel's bytes survive. Link cases need symlink support on the
 * host (Linux CI); they are skipped, not failed, where the OS refuses to create links.
 */
class SafeFsDeleteTest {

    private lateinit var tmp: Path
    private lateinit var root: Path      // stands in for filesDir
    private lateinit var outside: Path   // sentinel area outside root

    @Before
    fun setUp() {
        tmp = Files.createTempDirectory("safefs-del")
        root = Files.createDirectories(tmp.resolve("files"))
        outside = Files.createDirectories(tmp.resolve("outside"))
    }

    @After
    fun tearDown() {
        tmp.toFile().walkBottomUpNoFollowForTest()
    }

    private fun canLink(): Boolean = try {
        val probe = tmp.resolve("probe-link")
        Files.createSymbolicLink(probe, outside)
        Files.delete(probe)
        true
    } catch (_: Exception) {
        false
    }

    private fun sentinelDir(): Path {
        val d = Files.createDirectories(outside.resolve("sentinel-dir"))
        Files.write(d.resolve("keep.txt"), "sentinel".toByteArray())
        return d
    }

    private fun sentinelFile(): Path = Files.write(outside.resolve("sentinel.txt"), "sentinel".toByteArray())

    @Test
    fun deletesPlainTree() {
        val t = Files.createDirectories(root.resolve("ws/memory/sub"))
        Files.write(t.resolve("a.md"), byteArrayOf(1))
        val res = SafeFs.deleteTreeNoFollow(root, root.resolve("ws/memory"))
        assertTrue(res.clean)
        assertFalse(Files.exists(root.resolve("ws/memory"), LinkOption.NOFOLLOW_LINKS))
    }

    @Test
    fun missingTargetIsClean() {
        assertTrue(SafeFs.deleteTreeNoFollow(root, root.resolve("nope")).clean)
    }

    @Test
    fun directoryLinkInsideTreeIsUnlinkedNotDescended() {
        assumeTrue(canLink())
        val s = sentinelDir()
        val t = Files.createDirectories(root.resolve("ws/memory"))
        Files.createSymbolicLink(t.resolve("x"), s)
        val res = SafeFs.deleteTreeNoFollow(root, t)
        assertTrue(res.clean)
        assertEquals("sentinel", String(Files.readAllBytes(s.resolve("keep.txt"))))
    }

    @Test
    fun fileLinkInsideTreeIsUnlinkedNotFollowed() {
        assumeTrue(canLink())
        val s = sentinelFile()
        val t = Files.createDirectories(root.resolve("nodejs-project"))
        Files.createSymbolicLink(t.resolve("main.js"), s)
        assertTrue(SafeFs.deleteTreeNoFollow(root, t).clean)
        assertEquals("sentinel", String(Files.readAllBytes(s)))
    }

    @Test
    fun targetThatIsALinkIsUnlinkedOnly() {
        assumeTrue(canLink())
        val s = sentinelDir()
        Files.createDirectories(root.resolve("ws"))
        val link = root.resolve("ws/memory")
        Files.createSymbolicLink(link, s)
        assertTrue(SafeFs.deleteTreeNoFollow(root, link).clean)
        assertFalse(Files.exists(link, LinkOption.NOFOLLOW_LINKS))
        assertEquals("sentinel", String(Files.readAllBytes(s.resolve("keep.txt"))))
    }

    @Test
    fun linkedAncestorIsRefused() {
        assumeTrue(canLink())
        val s = sentinelDir()
        Files.createDirectories(s.resolve("memory"))
        Files.createSymbolicLink(root.resolve("ws"), s)
        try {
            SafeFs.deleteTreeNoFollow(root, root.resolve("ws/memory"))
            fail("expected UnsafePathException")
        } catch (_: SafeFs.UnsafePathException) {
        }
        assertTrue(Files.isDirectory(s.resolve("memory")))
        assertEquals("sentinel", String(Files.readAllBytes(s.resolve("keep.txt"))))
    }

    @Test
    fun targetOutsideRootIsRefused() {
        try {
            SafeFs.deleteTreeNoFollow(root, outside)
            fail("expected UnsafePathException")
        } catch (_: SafeFs.UnsafePathException) {
        }
    }

    @Test
    fun rootThatIsALinkIsRefused() {
        assumeTrue(canLink())
        val linkedRoot = tmp.resolve("files-link")
        Files.createSymbolicLink(linkedRoot, root)
        Files.createDirectories(root.resolve("ws"))
        try {
            SafeFs.deleteTreeNoFollow(linkedRoot, linkedRoot.resolve("ws"))
            fail("expected UnsafePathException")
        } catch (_: SafeFs.UnsafePathException) {
        }
    }

    @Test
    fun unreadableDirectoryIsOpenedByPathAndRemoved() {
        assumeTrue(File.separatorChar == '/') // POSIX permissions
        val t = Files.createDirectories(root.resolve("ws/memory/locked"))
        Files.write(t.resolve("f.md"), byteArrayOf(1))
        Files.setPosixFilePermissions(t, PosixFilePermissions.fromString("---------"))
        val res = SafeFs.deleteTreeNoFollow(root, root.resolve("ws/memory"))
        assertTrue("residue=${res.residue}", res.clean)
        assertFalse(Files.exists(root.resolve("ws/memory"), LinkOption.NOFOLLOW_LINKS))
    }

    @Test
    fun readOnlySubdirIsResidueNotACrash() {
        assumeTrue(PosixTestSupport.permissionsEnforced(tmp))
        val t = Files.createDirectories(root.resolve("ws/memory"))
        val ro = Files.createDirectories(t.resolve("ro"))
        Files.write(ro.resolve("f.md"), byteArrayOf(1))
        Files.write(t.resolve("other.md"), byteArrayOf(2))
        PosixTestSupport.setMode(ro, "r-x------") // listable, but its entries cannot be removed
        try {
            val res = SafeFs.deleteTreeNoFollow(root, t)
            assertFalse(res.clean)
            assertTrue("residue=${res.residue}", res.residue > 0)
            assertTrue("the walk finished; only removal failed", res.completed)
            assertTrue(Files.exists(ro.resolve("f.md")))
            assertFalse("the rest of the tree is removed", Files.exists(t.resolve("other.md")))
        } finally {
            PosixTestSupport.setMode(ro, "rwx------")
        }
    }

    @Test
    fun unopenableDirectoryWhoseModeCannotBeRestoredIsResidueNotACrash() {
        assumeTrue(PosixTestSupport.permissionsEnforced(tmp))
        val t = Files.createDirectories(root.resolve("ws/memory"))
        val locked = Files.createDirectories(t.resolve("locked"))
        Files.write(locked.resolve("f.md"), byteArrayOf(1))
        PosixTestSupport.setMode(locked, "---------")
        val saved = SafeFs.restoreOwnerRwx
        val asked = mutableListOf<Path>()
        SafeFs.restoreOwnerRwx = { dir -> asked.add(dir) } // the chmod has no effect
        try {
            val res = SafeFs.deleteTreeNoFollow(root, t)
            assertEquals("the restore is tried once, on the unopenable dir", listOf(locked), asked)
            assertFalse(res.clean)
            assertTrue("residue=${res.residue}", res.residue > 0)
            assertTrue(SafeFs.isRealDir(locked))
        } finally {
            SafeFs.restoreOwnerRwx = saved
            PosixTestSupport.setMode(locked, "rwx------")
        }
    }

    @Test
    fun boundStopsWithoutThrowing() {
        val t = Files.createDirectories(root.resolve("ws/big"))
        repeat(50) { Files.write(t.resolve("f$it"), byteArrayOf(1)) }
        val res = SafeFs.deleteTreeNoFollow(root, t, maxEntries = 10)
        assertFalse(res.completed)
        assertFalse(res.clean)
    }

    @Test
    fun ensureRealDirReplacesALinkWithoutTouchingItsTarget() {
        assumeTrue(canLink())
        val s = sentinelDir()
        Files.createDirectories(root.resolve("ws"))
        val d = root.resolve("ws/memory")
        Files.createSymbolicLink(d, s)
        SafeFs.ensureRealDir(root, d)
        assertTrue(Files.isDirectory(d, LinkOption.NOFOLLOW_LINKS))
        assertFalse(Files.isSymbolicLink(d))
        assertEquals("sentinel", String(Files.readAllBytes(s.resolve("keep.txt"))))
    }

    /** Following deletes and walks, and any `FileVisitOption.FOLLOW_LINKS` (`Files.walk`/`find`/`walkFileTree`). */
    // `.walk(` on any receiver except `Files` (Kotlin's File.walk() follows directory links;
    // Files.walk does not unless given FOLLOW_LINKS, which the last alternative catches).
    private val followingWalk = Regex("""\.deleteRecursively\(|walkBottomUp\(|walkTopDown\(|(?<!\bFiles)\.walk\(|\bFOLLOW_LINKS\b""")

    @Test
    fun followingWalkPatternCatchesFollowLinksButNotNoFollow() {
        // Kotlin File.walk() on any receiver name, including ones ending in "s" (CodeRabbit on #459).
        assertTrue(followingWalk.containsMatchIn("dirs.walk().forEach { }"))
        assertTrue(followingWalk.containsMatchIn("dir.walk().forEach { }"))
        assertTrue(followingWalk.containsMatchIn("File(x).walk()"))
        assertFalse(followingWalk.containsMatchIn("Files.walk(p).use { }"))
        assertTrue(followingWalk.containsMatchIn("Files.walk(p, FileVisitOption.FOLLOW_LINKS)"))
        assertTrue(followingWalk.containsMatchIn("Files.walkFileTree(p, EnumSet.of(FOLLOW_LINKS), 8, v)"))
        assertFalse(followingWalk.containsMatchIn("Files.readAttributes(p, A::class.java, LinkOption.NOFOLLOW_LINKS)"))
        assertFalse(followingWalk.containsMatchIn("Files.walkFileTree(p, EnumSet.noneOf(FileVisitOption::class.java), 8, v)"))
    }

    /** Source guard: no link-following recursive delete or walk remains in app/src/main. */
    @Test
    fun noLinkFollowingRecursiveDeleteOrWalkInMainSources() {
        val src = File("src/main/java")
        assertTrue("run from the app module", src.isDirectory)
        val banned = followingWalk
        val offenders = src.walkTopDown()
            .filter { it.isFile && it.name.endsWith(".kt") }
            .flatMap { f ->
                f.readLines().mapIndexedNotNull { i, line ->
                    if (banned.containsMatchIn(line) && !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*")) {
                        "${f.path}:${i + 1}: ${line.trim()}"
                    } else null
                }
            }
            .toList()
        assertTrue("link-following recursive delete/walk found:\n" + offenders.joinToString("\n"), offenders.isEmpty())
    }
}

/** Test-only cleanup that never follows links out of the temp dir. */
private fun File.walkBottomUpNoFollowForTest() {
    try {
        SafeFs.deleteTreeNoFollow(toPath().parent, toPath())
    } catch (_: Exception) {
    }
}

class SafeFsVisitTest {
    @Test
    fun visitsRegularFilesSkipsLinksAndContinuesPastUnreadableDirs() {
        val tmp = Files.createTempDirectory("safefs-visit")
        val outside = Files.createDirectories(tmp.resolve("outside"))
        Files.write(outside.resolve("secret.txt"), "secret".toByteArray())
        val dir = Files.createDirectories(tmp.resolve("files/skills/a"))
        Files.write(dir.resolve("SKILL.md"), "x".toByteArray())
        val linked = try {
            Files.createSymbolicLink(dir.resolve("leak.md"), outside.resolve("secret.txt")); true
        } catch (_: Exception) { false }
        val posix = File.separatorChar == '/'
        if (posix) {
            val locked = Files.createDirectories(tmp.resolve("files/skills/locked"))
            Files.write(locked.resolve("f.md"), byteArrayOf(1))
            Files.setPosixFilePermissions(locked, PosixFilePermissions.fromString("---------"))
        }
        val seen = mutableListOf<String>()
        SafeFs.forEachRegularFileNoFollow(tmp.resolve("files")) { p, _ -> seen += p.fileName.toString() }
        assertTrue(seen.contains("SKILL.md"))
        if (linked) assertFalse("a link must not be visited as a file", seen.contains("leak.md"))
        if (posix) {
            Files.setPosixFilePermissions(tmp.resolve("files/skills/locked"), PosixFilePermissions.fromString("rwx------"))
        }
        try { SafeFs.deleteTreeNoFollow(tmp.parent, tmp) } catch (_: Exception) {}
    }
}
