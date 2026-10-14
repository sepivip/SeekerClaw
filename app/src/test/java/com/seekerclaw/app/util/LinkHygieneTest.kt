package com.seekerclaw.app.util

import com.seekerclaw.app.config.PrefsNames
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.attribute.FileTime
import java.util.Locale

/**
 * BAT-1409 P1-C — boot link hygiene. Every link case plants a link to a sentinel outside the
 * app's directories and asserts the sentinel's bytes survive. Large-tree cases use scaled
 * budgets ([LinkHygiene.Budgets]); [defaultBudgetsAreTheSignedOffValues] pins the real ones.
 */
class LinkHygieneTest {

    private lateinit var tmp: Path
    private lateinit var data: Path
    private lateinit var files: Path
    private lateinit var ws: Path
    private lateinit var outside: Path

    @Before
    fun setUp() {
        tmp = Files.createTempDirectory("link-hygiene")
        data = Files.createDirectories(tmp.resolve("data"))
        files = Files.createDirectories(data.resolve("files"))
        ws = Files.createDirectories(files.resolve("workspace"))
        outside = Files.createDirectories(tmp.resolve("outside"))
    }

    @After
    fun tearDown() {
        try { SafeFs.deleteTreeNoFollow(tmp.parent, tmp) } catch (_: Exception) {}
    }

    private fun canLink(): Boolean = try {
        val probe = tmp.resolve("probe-link")
        Files.createSymbolicLink(probe, outside)
        Files.delete(probe)
        true
    } catch (_: Exception) {
        false
    }

    private fun sentinel(name: String = "sentinel.txt"): Path =
        Files.write(outside.resolve(name), "sentinel".toByteArray())

    private fun assertSentinel(p: Path) = assertEquals("sentinel", String(Files.readAllBytes(p)))

    private fun critical() = LinkHygiene.criticalPaths(files, data, PrefsNames.ALL)

    /** Counts `lstat` calls and fails the ones [failLstat] selects; [failUnlink]/[failRename] likewise. */
    private class TestOps(
        val failLstat: (Path) -> Boolean = { false },
        val failUnlink: (Path) -> Boolean = { false },
        val failRename: (Path) -> Boolean = { false },
        nlink: ((Path) -> Long)? = null,
    ) : LinkHygiene.Ops(nlink) {
        val lstatted = mutableListOf<Path>()
        override fun lstat(p: Path): BasicFileAttributes? {
            lstatted.add(p)
            if (failLstat(p)) throw IOException("injected lstat failure")
            return super.lstat(p)
        }
        override fun unlink(p: Path) {
            if (failUnlink(p)) throw IOException("injected unlink failure")
            super.unlink(p)
        }
        override fun rename(src: Path, dst: Path) {
            if (failRename(src)) throw IOException("injected rename failure")
            super.rename(src, dst)
        }
    }

    private fun quarantineDirs(): List<Path> {
        val q = files.resolve(LinkHygiene.QUARANTINE)
        if (!Files.isDirectory(q)) return emptyList()
        return Files.list(q).use { s -> s.sorted().toList() }
    }

    private fun fill(dir: Path, n: Int) {
        Files.createDirectories(dir)
        for (i in 0 until n) Files.createFile(dir.resolve("f$i"))
    }

    // ------------------------------------------------------------------------------- step 1

    @Test
    fun criticalListFitsTheCapAndCoversEveryPrefsName() {
        val list = critical()
        assertTrue("exact list has ${list.size} paths", list.size <= LinkHygiene.STEP1_MAX_LSTAT)
        for (n in PrefsNames.ALL) {
            assertTrue(data.resolve("shared_prefs/$n.xml") in list)
            assertTrue(data.resolve("shared_prefs/$n.xml.bak") in list)
        }
        // Parents before children: no path is listed before a listed ancestor of it.
        list.forEachIndexed { i, p ->
            list.forEachIndexed { j, q -> if (p != q && p.startsWith(q)) assertTrue("$q must precede $p", j < i) }
        }
    }

    @Test
    fun step1DoesNotEnumerateLargeTrees() {
        fill(ws.resolve("memory"), 300)
        fill(ws.resolve("media"), 1_000)
        val ops = TestOps()
        val r = LinkHygiene(ops).step1(critical())
        assertTrue("step 1 made ${r.lstatCalls} lstat calls", r.lstatCalls <= LinkHygiene.STEP1_MAX_LSTAT)
        assertEquals(r.lstatCalls, ops.lstatted.size)
        assertTrue(ops.lstatted.none { it.startsWith(ws.resolve("media")) || it.parent == ws.resolve("memory") })
    }

    @Test
    fun step1UnlinksCriticalLinksAndSentinelsSurvive() {
        assumeTrue(canLink())
        val s = sentinel()
        Files.createSymbolicLink(files.resolve("bridge_token"), s)
        Files.createSymbolicLink(files.resolve("burner_caps.json"), s)
        Files.createDirectories(data.resolve("shared_prefs"))
        Files.createSymbolicLink(data.resolve("shared_prefs/${PrefsNames.MAIN}.xml.bak"), s)
        val r = LinkHygiene().step1(critical(), data)
        assertTrue(r.unsafe.isEmpty())
        assertEquals(3, r.removed.size)
        assertFalse(SafeFs.existsNoFollow(files.resolve("bridge_token")))
        assertFalse(SafeFs.existsNoFollow(files.resolve("burner_caps.json")))
        assertFalse(SafeFs.existsNoFollow(data.resolve("shared_prefs/${PrefsNames.MAIN}.xml.bak")))
        assertSentinel(s)
        assertTrue(r.log.all { it.level == LogLevel.ERROR })
    }

    @Test
    fun fixedNameLinksGoInStep1EvenWithAZeroStep2Budget() {
        assumeTrue(canLink())
        val s = sentinel()
        Files.createDirectories(ws.resolve("notes"))
        Files.write(ws.resolve("notes/o.json"), "{}".toByteArray())
        Files.createDirectories(files.resolve("burner_keys"))
        Files.write(files.resolve("burner_keys/x"), "key".toByteArray())
        Files.createSymbolicLink(ws.resolve("owner_ids"), ws.resolve("notes/o.json"))
        Files.createSymbolicLink(ws.resolve("node_debug.log"), files.resolve("burner_keys/x"))
        Files.createSymbolicLink(ws.resolve("agent_settings.json"), s)
        val h = LinkHygiene()
        assertTrue(h.step1(critical(), data).unsafe.isEmpty())
        h.step2(files, data, budgets = LinkHygiene.Budgets(nodeReadMaxEntries = 0, walkMaxEntries = 0))
        for (n in listOf("owner_ids", "node_debug.log", "agent_settings.json")) {
            assertFalse("$n must be gone", SafeFs.existsNoFollow(ws.resolve(n)))
        }
        assertEquals("key", String(Files.readAllBytes(files.resolve("burner_keys/x"))))
        // After boot, the next settings write creates a regular file and the old target is untouched.
        SafeFs.writeAtomicText(files, ws.resolve("agent_settings.json"), "{}")
        assertTrue(Files.isRegularFile(ws.resolve("agent_settings.json"), java.nio.file.LinkOption.NOFOLLOW_LINKS))
        assertSentinel(s)
    }

    @Test
    fun step1LstatFailureIsUnsafeAndNeverThrows() {
        val bad = files.resolve("bridge_token")
        val r = LinkHygiene(TestOps(failLstat = { it == bad })).step1(critical())
        assertEquals(setOf(bad), r.unsafe)
    }

    @Test
    fun step1UnlinkFailureIsUnsafe() {
        assumeTrue(canLink())
        val s = sentinel()
        val link = files.resolve("service_state")
        Files.createSymbolicLink(link, s)
        val r = LinkHygiene(TestOps(failUnlink = { it == link })).step1(critical())
        assertEquals(setOf(link), r.unsafe)
        assertSentinel(s)
    }

    @Test
    fun step1NeverLooksThroughAnUnverifiedParent() {
        val ops = TestOps(failLstat = { it == ws })
        val r = LinkHygiene(ops).step1(critical())
        val wsChildren = critical().filter { it != ws && it.startsWith(ws) }
        assertTrue(wsChildren.isNotEmpty())
        assertTrue("children of an unverified parent are unsafe", r.unsafe.containsAll(wsChildren))
        assertTrue("and never looked up", ops.lstatted.none { it in wsChildren })
    }

    // ------------------------------------------------------------------------------- step 2

    @Test
    fun linkIsQuarantinedWithManifestAndTargetIntact() {
        assumeTrue(canLink())
        val s = sentinel()
        Files.createDirectories(ws.resolve("notes"))
        val link = ws.resolve("notes/today.md")
        Files.createSymbolicLink(link, s)
        val r = LinkHygiene(wallClockMs = { 1_700_000_000_000L }).step2(files, data)
        assertEquals(1, r.quarantined)
        assertFalse(SafeFs.existsNoFollow(link))
        val q = quarantineDirs().single()
        assertEquals("1700000000000", q.fileName.toString())
        assertTrue("the link itself moved, not its target", Files.isSymbolicLink(q.resolve("0")))
        val rows = String(Files.readAllBytes(q.resolve(LinkHygiene.MANIFEST))).trimEnd('\n').split('\n')
        assertEquals(1, rows.size)
        val row = rows.single().split('\t')
        assertEquals(listOf("0", LinkHygiene.escape(files.relativize(link).toString()), LinkHygiene.escape(s.toString())), row)
        assertSentinel(s)
    }

    @Test
    fun walkIsBreadthFirstSoAShallowLinkBeatsALargeSubtree() {
        assumeTrue(canLink())
        val s = sentinel()
        fill(ws.resolve("media/inbound"), 1_500)
        Files.createDirectories(ws.resolve("notes"))
        Files.createSymbolicLink(ws.resolve("notes/link"), s)
        val r = LinkHygiene().step2(files, data, budgets = LinkHygiene.Budgets(walkMaxEntries = 500))
        assertEquals(1, r.quarantined)
        assertTrue("workspace" in r.exhausted)
        assertTrue(r.log.any { it.level == LogLevel.ERROR && it.message.contains("not certified") && it.message.contains("inbound") })
        assertSentinel(s)
    }

    @Test
    fun nodeReadDirectoriesAreWalkedFirstAndCompletely() {
        assumeTrue(canLink())
        val s = sentinel()
        fill(ws.resolve("memory"), 300)
        Files.createDirectories(ws.resolve("memory/a/b"))
        Files.createSymbolicLink(ws.resolve("memory/a/b/deep-link.md"), s)
        fill(ws.resolve("media"), 1_000)
        val r = LinkHygiene().step2(files, data, budgets = LinkHygiene.Budgets(nodeReadMaxEntries = 1_000, walkMaxEntries = 50))
        assertEquals(1, r.quarantined)
        assertFalse("Node-read directories" in r.exhausted)
        assertTrue("workspace" in r.exhausted)
        assertSentinel(s)
    }

    @Test
    fun symlinkedWorkspaceRootIsReplacedByAFreshDirectory() {
        assumeTrue(canLink())
        val s = sentinel()
        Files.delete(ws)
        Files.createSymbolicLink(ws, outside)
        val r = LinkHygiene().step2(files, data)
        assertTrue(r.unsafe.isEmpty())
        assertTrue(SafeFs.isRealDir(ws))
        assertEquals(0L, Files.list(ws).use { it.count() })
        assertSentinel(s)
    }

    @Test
    fun linkedRootThatCannotBeRemovedFailsClosedAndIsNotWalked() {
        assumeTrue(canLink())
        val s = sentinel()
        Files.createSymbolicLink(outside.resolve("memory"), outside)
        Files.delete(ws)
        Files.createSymbolicLink(ws, outside)
        val ops = TestOps(failUnlink = { it == ws }, failRename = { it == ws })
        val r = LinkHygiene(ops).step2(files, data)
        assertTrue(ws in r.unsafe)
        assertTrue("nothing is looked up through the linked root", ops.lstatted.none { it != ws && it.startsWith(ws) })
        assertTrue(Files.isSymbolicLink(outside.resolve("memory")))
        assertSentinel(s)
    }

    /** Replaces the real `files` dir with a link to `real/`, which holds a workspace with a planted link. */
    private fun linkedFilesDir(s: Path): Path {
        SafeFs.deleteTreeNoFollow(data, files)
        val real = Files.createDirectories(tmp.resolve("real"))
        Files.createDirectories(real.resolve("workspace/notes"))
        Files.createSymbolicLink(real.resolve("workspace/notes/link"), s)
        Files.createSymbolicLink(files, real)
        return real
    }

    @Test
    fun stillUnsafeAfterTheRetryWalksNothing() {
        assumeTrue(canLink())
        val s = sentinel()
        val real = linkedFilesDir(s)
        val ops = TestOps(failUnlink = { it == files })
        val r = LinkHygiene(ops).step2(files, data, retry = setOf(files))
        assertTrue(files in r.unsafe)
        assertTrue("nothing looked up through the linked files dir", ops.lstatted.none { it != files && it.startsWith(files) })
        assertTrue(Files.isSymbolicLink(real.resolve("workspace/notes/link")))
        assertSentinel(s)
    }

    @Test
    fun linkedStorageRootWithoutARetryWalksNothing() {
        assumeTrue(canLink())
        val s = sentinel()
        val real = linkedFilesDir(s)
        val ops = TestOps()
        val r = LinkHygiene(ops).step2(files, data)
        assertTrue(files in r.unsafe)
        assertTrue(ops.lstatted.none { it != files && it.startsWith(files) })
        assertTrue(Files.isSymbolicLink(real.resolve("workspace/notes/link")))
        assertSentinel(s)
    }

    @Test
    fun linkIsUnlinkedWhenTheQuarantineMoveFails() {
        assumeTrue(canLink())
        val s = sentinel()
        Files.createDirectories(ws.resolve("notes"))
        val link = ws.resolve("notes/link")
        Files.createSymbolicLink(link, s)
        val r = LinkHygiene(TestOps(failRename = { it == link })).step2(files, data)
        assertEquals(0, r.quarantined)
        assertEquals(1, r.unlinked)
        assertFalse(SafeFs.existsNoFollow(link))
        assertTrue(r.unsafe.isEmpty())
        assertSentinel(s)
    }

    @Test
    fun hardLinkedWorkspaceNameIsRemovedAndTheOtherNameStays() {
        Files.write(files.resolve("bridge_token"), "token".toByteArray())
        Files.createDirectories(ws.resolve("memory"))
        val name = ws.resolve("memory/h.md")
        try {
            Files.createLink(name, files.resolve("bridge_token"))
        } catch (_: Exception) {
            Files.write(name, "token".toByteArray()) // no hard links here: the injected nlink stands in
        }
        val ops = TestOps(nlink = { p -> if (p == name) 2L else 1L })
        val r = LinkHygiene(ops).step2(files, data)
        assertEquals(1, r.hardLinksRemoved)
        assertFalse(Files.exists(name))
        assertEquals("token", String(Files.readAllBytes(files.resolve("bridge_token"))))
    }

    @Test
    fun budgetExhaustionLeavesAnUnwalkedLinkThatWritersAndDeletesStillRefuse() {
        assumeTrue(canLink())
        val s = sentinel()
        Files.createDirectories(ws.resolve("deep"))
        Files.createSymbolicLink(ws.resolve("deep/dirlink"), outside)
        val r = LinkHygiene().step2(files, data, budgets = LinkHygiene.Budgets(walkMaxEntries = 0))
        assertTrue("workspace" in r.exhausted)
        assertTrue("left unwalked", Files.isSymbolicLink(ws.resolve("deep/dirlink")))
        assertWriterAndDeleteRefused(s)
    }

    @Test
    fun hygieneErrorInStep2LeavesALinkThatWritersAndDeletesStillRefuse() {
        assumeTrue(canLink())
        val s = sentinel()
        Files.createDirectories(ws.resolve("deep"))
        val link = ws.resolve("deep/dirlink")
        Files.createSymbolicLink(link, outside)
        val r = LinkHygiene(TestOps(failLstat = { it == link })).step2(files, data)
        assertTrue(r.errors > 0)
        assertTrue(Files.isSymbolicLink(link))
        assertWriterAndDeleteRefused(s)
    }

    private fun assertWriterAndDeleteRefused(s: Path) {
        try {
            SafeFs.writeAtomicText(files, ws.resolve("deep/dirlink/sentinel.txt"), "pwned")
            fail("the writer must refuse a linked parent")
        } catch (_: SafeFs.UnsafePathException) {
        }
        try {
            SafeFs.deleteTreeNoFollow(files, ws.resolve("deep/dirlink/sentinel.txt"))
            fail("the delete must refuse a linked parent")
        } catch (_: SafeFs.UnsafePathException) {
        }
        SafeFs.deleteTreeNoFollow(files, ws.resolve("deep")) // removes the link itself
        assertFalse(SafeFs.existsNoFollow(ws.resolve("deep")))
        assertSentinel(s)
    }

    @Test
    fun deeperThanMaxDepthIsReportedNotWalked() {
        assumeTrue(canLink())
        val s = sentinel()
        val deep = Files.createDirectories(ws.resolve("a/b/c/d"))
        Files.createSymbolicLink(deep.resolve("link"), s)
        val r = LinkHygiene().step2(files, data, budgets = LinkHygiene.Budgets(maxDepth = 3))
        assertEquals(0, r.quarantined)
        assertTrue(r.log.any { it.level == LogLevel.ERROR && it.message.contains("deeper than 3") })
        assertSentinel(s)
    }

    @Test
    fun kotlinOwnedEntriesAreCheckedButDataDirLibIsLeftAlone() {
        assumeTrue(canLink())
        val s = sentinel()
        Files.createDirectories(data.resolve("shared_prefs"))
        Files.createSymbolicLink(data.resolve("shared_prefs/other.xml"), s)
        Files.createSymbolicLink(data.resolve("planted"), outside)
        Files.createSymbolicLink(files.resolve("mcp_servers.json.tmp"), s)
        Files.createSymbolicLink(data.resolve("lib"), outside)
        val r = LinkHygiene().step2(files, data)
        assertEquals(3, r.quarantined)
        assertFalse(SafeFs.existsNoFollow(data.resolve("shared_prefs/other.xml")))
        assertFalse(SafeFs.existsNoFollow(data.resolve("planted")))
        assertFalse(SafeFs.existsNoFollow(files.resolve("mcp_servers.json.tmp")))
        assertTrue("the system's native-library link stays", Files.isSymbolicLink(data.resolve("lib")))
        assertSentinel(s)
    }

    @Test
    fun quarantinePruneKeepsTheNewestFiveIncludingThisRun() {
        assumeTrue(canLink())
        val s = sentinel()
        fun ts(i: Int) = String.format(Locale.ROOT, "%013d", i)
        for (i in 1..7) {
            val d = Files.createDirectories(files.resolve("quarantine/${ts(i)}"))
            Files.createSymbolicLink(d.resolve("0"), s)
        }
        Files.createSymbolicLink(ws.resolve("new-link"), s)
        LinkHygiene(wallClockMs = { 100L }).step2(files, data)
        assertEquals(
            listOf(4, 5, 6, 7, 100).map { ts(it) },
            quarantineDirs().map { it.fileName.toString() },
        )
        assertSentinel(s)
    }

    @Test
    fun kwriteSweepRemovesOnlyStaleTemps() {
        val kw = Files.createDirectories(files.resolve(SafeFs.KWRITE_DIR))
        val old = Files.write(kw.resolve(".sc-old.tmp"), "x".toByteArray())
        val fresh = Files.write(kw.resolve(".sc-new.tmp"), "y".toByteArray())
        val now = 1_700_000_000_000L
        Files.setLastModifiedTime(old, FileTime.fromMillis(now - 60 * 60_000L))
        Files.setLastModifiedTime(fresh, FileTime.fromMillis(now - 1_000L))
        LinkHygiene(wallClockMs = { now }).step2(files, data)
        assertFalse(Files.exists(old))
        assertTrue("an in-flight temp of another process is kept", Files.exists(fresh))
    }

    @Test
    fun cleanTreeIsANoOp() {
        Files.createDirectories(ws.resolve("memory"))
        Files.write(ws.resolve("memory/2026-10-14.md"), "note".toByteArray())
        val h = LinkHygiene()
        assertTrue(h.step1(critical()).let { it.unsafe.isEmpty() && it.removed.isEmpty() && it.log.isEmpty() })
        val r = h.step2(files, data)
        assertEquals(0, r.quarantined + r.unlinked + r.hardLinksRemoved + r.errors)
        assertTrue(r.exhausted.isEmpty())
        assertTrue(r.log.isEmpty())
        assertTrue(quarantineDirs().isEmpty())
    }

    // --------------------------------------------------------------------------- pins

    @Test
    fun defaultBudgetsAreTheSignedOffValues() {
        val b = LinkHygiene.Budgets()
        assertEquals(64, LinkHygiene.STEP1_MAX_LSTAT)
        assertEquals(50_000, b.nodeReadMaxEntries)
        assertEquals(20_000, b.walkMaxEntries)
        assertEquals(3_000_000_000L, b.walkMaxNanos)
        assertEquals(24, b.maxDepth)
        assertEquals(1_000_000_000L, b.pruneMaxNanos)
        assertEquals(5, b.keepQuarantines)
    }

    @Test
    fun escapeKeepsManifestRowsOnOneLine() {
        assertEquals("a\\tb\\nc\\\\d\\x01", LinkHygiene.escape("a\tb\nc\\d\u0001"))
        assertEquals("x\\u2028y\\u202ez\\u0085", LinkHygiene.escape("x y‮z\u0085"))
        assertTrue(LinkHygiene.escape("x".repeat(500)).length <= 201)
    }

    @Test
    fun linkHygieneUsesNoAndroidApi() {
        val src = File("src/main/java/com/seekerclaw/app/util/LinkHygiene.kt")
        assertTrue("run from the app module", src.isFile)
        val code = src.readLines().filterNot { it.trimStart().let { t -> t.startsWith("*") || t.startsWith("/*") || t.startsWith("//") } }
        assertTrue(code.none { Regex("""\bandroid\.""").containsMatchIn(it) })
    }
}
