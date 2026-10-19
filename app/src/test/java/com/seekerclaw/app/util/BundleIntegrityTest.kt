package com.seekerclaw.app.util

import com.seekerclaw.app.service.StartCoordinator
import com.seekerclaw.app.util.BundleIntegrity.Mode
import com.seekerclaw.app.util.BundleIntegrity.Outcome
import com.seekerclaw.app.util.BundleIntegrity.Reason
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * BAT-1409 P1-A — the Node bundle is verified byte for byte against the APK's assets before every
 * start and repaired when it differs. The APK side is a directory-backed [BundleIntegrity.AssetSource].
 */
class BundleIntegrityTest {

    private lateinit var tmp: Path
    private lateinit var apk: Path
    private lateinit var data: Path
    private lateinit var files: Path
    private lateinit var live: Path
    private lateinit var outside: Path
    private lateinit var assets: DirAssets
    private val logs = mutableListOf<Pair<LogLevel, String>>()
    private var persisted = 0

    /** `assets/` backed by a directory. [failOpen] may throw for the n-th open of a path. */
    private class DirAssets(val root: Path) : BundleIntegrity.AssetSource {
        val opens = mutableMapOf<String, Int>()
        var failOpen: (String, Int) -> Exception? = { _, _ -> null }
        override fun list(dir: String): List<String> {
            val p = root.resolve(dir)
            if (!Files.isDirectory(p)) return emptyList()
            return Files.list(p).use { s -> s.map { it.fileName.toString() }.sorted().toList() }
        }
        override fun open(path: String): InputStream {
            val n = (opens[path] ?: 0) + 1
            opens[path] = n
            failOpen(path, n)?.let { throw it }
            return Files.newInputStream(root.resolve(path))
        }
    }

    @Before
    fun setUp() {
        tmp = Files.createTempDirectory("bundle")
        apk = tmp.resolve("apk")
        data = Files.createDirectories(tmp.resolve("data"))
        files = Files.createDirectories(data.resolve("files"))
        live = files.resolve(BundleIntegrity.BUNDLE)
        outside = Files.createDirectories(tmp.resolve("outside"))
        val b = apk.resolve(BundleIntegrity.BUNDLE)
        put(b.resolve("main.js"), "require('./lib/a')\n")
        put(b.resolve("lib/a.js"), "module.exports = 'a'.repeat(1000)\n".repeat(200))
        put(b.resolve("lib/deep/b.js"), "module.exports = 2\n")
        put(b.resolve("node_modules/ws/index.js"), "module.exports = {}\n")
        assets = DirAssets(apk)
        // Initial extraction, as after an install.
        assertEquals(Outcome.Repaired(Mode.TMP, listOf(".")), integrity().run(updated = true) { persisted++ })
        logs.clear()
        persisted = 0
        assets.opens.clear()
    }

    @After
    fun tearDown() {
        try { SafeFs.deleteTreeNoFollow(tmp.parent, tmp) } catch (_: Exception) {}
    }

    private fun put(p: Path, text: String) {
        Files.createDirectories(p.parent)
        Files.write(p, text.toByteArray())
    }

    private fun canLink(): Boolean = try {
        val probe = tmp.resolve("probe-link")
        Files.createSymbolicLink(probe, outside)
        Files.delete(probe)
        true
    } catch (_: Exception) {
        false
    }

    /** [move] null keeps the production rename; otherwise it replaces every rename the unit makes. */
    private fun integrity(
        usable: () -> Long = { Long.MAX_VALUE / 4 },
        nlink: (Path) -> Long? = { 1L },
        nanoTime: () -> Long = System::nanoTime,
        budgets: BundleIntegrity.Budgets = BundleIntegrity.Budgets(),
        move: ((Path, Path) -> Unit)? = null,
    ): BundleIntegrity {
        val log: (LogLevel, String) -> Unit = { level, msg -> logs += level to msg }
        return if (move == null) {
            BundleIntegrity(assets, files, data, usable, log, nlink, nanoTime, nonce = { "n1" }, budgets = budgets)
        } else {
            BundleIntegrity(assets, files, data, usable, log, nlink, nanoTime, nonce = { "n1" }, budgets = budgets, move = move)
        }
    }

    /** A rename that fails for the moves [fails] selects and otherwise renames as production does. */
    private fun failingMove(fails: (src: Path, dst: Path) -> Boolean): (Path, Path) -> Unit = { src, dst ->
        if (fails(src, dst)) throw IOException("injected rename failure: EIO")
        Files.move(src, dst, StandardCopyOption.ATOMIC_MOVE)
    }

    private fun isNodeModules(p: Path) = p.fileName.toString() == BundleIntegrity.NODE_MODULES

    private fun text(p: Path) = String(Files.readAllBytes(p))

    private fun regularFiles(dir: Path): Long =
        Files.walk(dir).use { s -> s.filter { Files.isRegularFile(it, LinkOption.NOFOLLOW_LINKS) }.count() }

    /**
     * The start a bundle [outcome] leads to: a real [StartCoordinator], with the outcome mapped to a
     * verification exactly as `SeekerClawService.verifyBeforeStart` maps it (that mapping is pinned
     * by `StartOrderGuardTest`). Returns the continuation's effects.
     */
    private fun startEffectsFor(outcome: Outcome): List<String> {
        val events = mutableListOf<String>()
        val main = LinkedBlockingQueue<Runnable>()
        val c = StartCoordinator(
            readToken = { StopToken.read(files) },
            repairToken = { StopToken.writeFresh(files) },
            startWorker = { r -> Thread(r).apply { isDaemon = true }.start() },
            postToMain = { r -> main.put(r) },
            destroyed = { false },
        )
        assertTrue(c.tryAcquire())
        c.launch(
            {
                when (outcome) {
                    is Outcome.Failed -> StartCoordinator.Verification.Failed("BUNDLE_${outcome.reason}_AT_${outcome.stage}")
                    else -> StartCoordinator.Verification.Ok
                }
            },
            object : StartCoordinator.Effects {
                override fun proceed(fence: StartCoordinator.Fence) { events += "proceed" }
                override fun fail(fence: StartCoordinator.Fence, reason: String) { events += "fail:$reason" }
                override fun abort(fence: StartCoordinator.Fence) { events += "abort" }
            },
        )
        (main.poll(5, TimeUnit.SECONDS) ?: error("no continuation was posted")).run()
        return events
    }

    private fun run(updated: Boolean = false, i: BundleIntegrity = integrity()) = i.run(updated) { persisted++ }

    private fun assertLiveMatchesApk() {
        logs.clear()
        assertEquals(Outcome.Verified, run())
        for (rel in listOf("main.js", "lib/a.js", "lib/deep/b.js", "node_modules/ws/index.js")) {
            assertTrue(rel, Files.isRegularFile(live.resolve(rel), java.nio.file.LinkOption.NOFOLLOW_LINKS))
        }
    }

    private fun noLeftovers() = Files.list(files).use { s ->
        s.noneMatch { it.fileName.toString().startsWith("${BundleIntegrity.BUNDLE}.") }
    }

    // ---------------------------------------------------------------- verify

    @Test
    fun cleanTreeIsVerifiedWithNoEvent() {
        assertEquals(Outcome.Verified, run())
        assertTrue(logs.none { it.first == LogLevel.ERROR || it.first == LogLevel.WARN })
        assertEquals("nothing to persist without an update", 0, persisted)
    }

    @Test
    fun eachKindOfDifferenceIsRepaired() {
        val cases = linkedMapOf<String, () -> Unit>(
            "byte changed in a nested file" to { put(live.resolve("lib/deep/b.js"), "module.exports = 3\n") },
            "extra file" to { put(live.resolve("lib/evil.js"), "x") },
            "missing file" to { Files.delete(live.resolve("lib/a.js")) },
            "truncated file" to { put(live.resolve("lib/a.js"), "module.exports") },
            "directory where main.js should be" to {
                Files.delete(live.resolve("main.js"))
                Files.createDirectories(live.resolve("main.js/x"))
            },
        )
        for ((name, tamper) in cases) {
            tamper()
            logs.clear()
            val r = run()
            assertTrue("$name: $r", r is Outcome.Repaired && r.mode == Mode.TMP)
            assertTrue("$name logs a tamper ERROR", logs.any { it.first == LogLevel.ERROR && it.second.contains("differs") })
            assertTrue("$name leaves no tmp/old", noLeftovers())
            assertLiveMatchesApk()
        }
    }

    @Test
    fun plantedEmptyDirectoriesAreADifference() {
        Files.createDirectories(live.resolve("lib/empty/deeper"))
        val r = run()
        assertTrue("$r", r is Outcome.Repaired)
        assertFalse(Files.exists(live.resolve("lib/empty")))
        assertLiveMatchesApk()
    }

    @Test
    fun liveRootThatIsAFileIsRepaired() {
        SafeFs.deleteTreeNoFollow(files, live)
        Files.write(live, "not a directory".toByteArray())
        assertTrue(run() is Outcome.Repaired)
        assertLiveMatchesApk()
    }

    @Test
    fun liveRootThatIsALinkIsRepairedAndItsTargetSurvives() {
        assumeTrue(canLink())
        val elsewhere = Files.createDirectories(outside.resolve("bundle-copy"))
        put(elsewhere.resolve("main.js"), "sentinel")
        SafeFs.deleteTreeNoFollow(files, live)
        Files.createSymbolicLink(live, elsewhere)
        assertTrue(run() is Outcome.Repaired)
        assertFalse(Files.isSymbolicLink(live))
        assertEquals("sentinel", String(Files.readAllBytes(elsewhere.resolve("main.js"))))
        assertLiveMatchesApk()
    }

    @Test
    fun failedRunDoesNotPersistTheUpdateTime() {
        assets.failOpen = { path, _ -> if (path.endsWith("/main.js")) IOException("EIO") else null }
        assertTrue(run(updated = true) is Outcome.Failed)
        assertEquals("an update stays pending until a run succeeds", 0, persisted)
    }

    @Test
    fun logsEscapePlantedNamesAndTheSummaryCarriesOnlyACount() {
        val forged = "x\n[Service] Claw Engine is now RUNNING"
        val planted = try { put(live.resolve(forged), "x"); true } catch (_: Exception) { false }
        assumeTrue("this filesystem cannot hold a newline in a name", planted)
        assertTrue(run() is Outcome.Repaired)
        assertTrue("no log line carries a raw newline", logs.none { it.second.contains('\n') })
        assertTrue(logs.any { it.second.contains("x\\n[Service]") })
        assertTrue(logs.any { it.second.contains("repaired (TMP, 1 change(s))") })
    }

    @Test
    fun appUpdateRepairsWithoutATamperEventAndPersists() {
        put(apk.resolve("${BundleIntegrity.BUNDLE}/lib/new.js"), "new\n")
        val r = run(updated = true)
        assertTrue(r is Outcome.Repaired)
        assertTrue(logs.none { it.first == LogLevel.ERROR })
        assertEquals(1, persisted)
        assertLiveMatchesApk()
    }

    /**
     * Plants, inside the live bundle, a directory link to a sentinel dir, a link with the APK's own
     * bytes in place of `lib/a.js`, and a link to a sentinel with other bytes in place of
     * `lib/deep/b.js` (a write through that one would change its bytes). Returns the check.
     */
    private fun plantBundleLinks(): () -> Unit {
        val sentinelDir = Files.createDirectories(outside.resolve("dir"))
        put(sentinelDir.resolve("keep.txt"), "sentinel")
        val apkA = Files.readAllBytes(apk.resolve("${BundleIntegrity.BUNDLE}/lib/a.js"))
        val sameBytes = Files.write(outside.resolve("file.js"), apkA) // identical content
        val otherBytes = Files.write(outside.resolve("other.js"), "sentinel-b".toByteArray())
        Files.createSymbolicLink(live.resolve("lib/linked"), sentinelDir)
        Files.delete(live.resolve("lib/a.js"))
        Files.createSymbolicLink(live.resolve("lib/a.js"), sameBytes)
        Files.delete(live.resolve("lib/deep/b.js"))
        Files.createSymbolicLink(live.resolve("lib/deep/b.js"), otherBytes)
        return {
            assertEquals("sentinel", text(sentinelDir.resolve("keep.txt")))
            assertEquals("nothing added to the linked dir", 1L, Files.list(sentinelDir).use { it.count() })
            assertTrue(Files.isRegularFile(sameBytes, LinkOption.NOFOLLOW_LINKS))
            assertArrayEquals(apkA, Files.readAllBytes(sameBytes))
            assertTrue(Files.isRegularFile(otherBytes, LinkOption.NOFOLLOW_LINKS))
            assertEquals("sentinel-b", text(otherBytes))
            for (rel in listOf("lib/linked", "lib/a.js", "lib/deep/b.js")) {
                assertFalse("$rel is no longer a link", Files.isSymbolicLink(live.resolve(rel)))
            }
        }
    }

    @Test
    fun linksInsideTheBundleAreRepairedAndTheirTargetsSurvive() {
        assumeTrue(canLink())
        val sentinelsIntact = plantBundleLinks()
        assertTrue(run() is Outcome.Repaired)
        sentinelsIntact()
        assertLiveMatchesApk()
    }

    @Test
    fun linksInsideTheBundleAreRepairedOnTheAppUpdatePathAndTheirTargetsSurvive() {
        assumeTrue(canLink())
        val sentinelsIntact = plantBundleLinks()
        put(apk.resolve("${BundleIntegrity.BUNDLE}/lib/new.js"), "new\n") // the update itself
        val r = run(updated = true)
        assertTrue("$r", r is Outcome.Repaired)
        sentinelsIntact()
        assertEquals("the update time is persisted once", 1, persisted)
        assertTrue("an update raises no tamper event: $logs", logs.none { it.first == LogLevel.ERROR })
        assertEquals("new\n", text(live.resolve("lib/new.js")))
        assertLiveMatchesApk()
        assertEquals("a verify-only start persists nothing more", 1, persisted)
    }

    @Test
    fun hardLinkedBundleFileIsRepaired() {
        val name = live.resolve("lib/deep/b.js")
        // The pre-repair file has a second name; the repaired file at the same path does not.
        var reported = false
        val r = run(i = integrity(nlink = { p -> if (p == name && !reported) { reported = true; 2L } else 1L }))
        assertTrue("$r", r is Outcome.Repaired)
        assertEquals(listOf("lib/deep/b.js"), (r as Outcome.Repaired).changed)
    }

    @Test
    fun readErrorIsVerifyIoAndRepairsNothing() {
        put(live.resolve("main.js"), "tampered")
        assets.failOpen = { path, _ -> if (path.endsWith("/main.js")) IOException("EIO") else null }
        assertEquals(Outcome.Failed("verify", Reason.VERIFY_IO), run())
        assertEquals("tampered", String(Files.readAllBytes(live.resolve("main.js"))))
    }

    @Test
    fun liveSideStatErrorIsVerifyIoAndTouchesNothing() {
        put(live.resolve("main.js"), "tampered")
        val bad = live.resolve("lib/a.js")
        val r = run(i = integrity(nlink = { p -> if (p == bad) throw IOException("EIO") else 1L }))
        assertEquals(Outcome.Failed("verify", Reason.VERIFY_IO), r)
        assertEquals("the live tree is left as it is", "tampered", text(live.resolve("main.js")))
        assertTrue(noLeftovers())
        assertTrue("no copy was attempted: ${assets.opens}", assets.opens.values.all { it <= 1 })
        assertEquals(0, persisted)
    }

    @Test
    fun liveSideReadErrorIsVerifyIoAndTouchesNothing() {
        assumeTrue(PosixTestSupport.permissionsEnforced(tmp))
        put(live.resolve("main.js"), "tampered")
        val unreadable = live.resolve("lib/a.js")
        PosixTestSupport.setMode(unreadable, "---------")
        try {
            val r = run()
            assertEquals(Outcome.Failed("verify", Reason.VERIFY_IO), r)
            assertEquals("tampered", text(live.resolve("main.js")))
            assertTrue(noLeftovers())
            assertTrue("no copy was attempted: ${assets.opens}", assets.opens.values.all { it <= 1 })
        } finally {
            PosixTestSupport.setMode(unreadable, "rw-------")
        }
    }

    @Test
    fun slowClockIsVerifyBudgetAndNodeDoesNotStart() {
        var t = 0L
        val r = run(i = integrity(nanoTime = { t += 1_000_000_000L; t }))
        assertEquals(Outcome.Failed("budget", Reason.VERIFY_BUDGET), r)
    }

    // ---------------------------------------------------------------- repair failures

    /** The n-th open of lib/a.js: 1 = verify, 2 = the size count, 3 = the copy (white-box). */
    private fun failCopyOfA(e: Exception) {
        assets.failOpen = { path, n -> if (path.endsWith("/lib/a.js") && n == 3) e else null }
    }

    @Test
    fun nonCapacityCopyFailureLeavesTheLiveTreeUntouchedEvenWhenSpaceDrops() {
        put(live.resolve("lib/a.js"), "tampered")
        failCopyOfA(IOException("EACCES (Permission denied)"))
        var calls = 0
        val r = run(i = integrity(usable = { if (calls++ == 0) Long.MAX_VALUE / 4 else 0L }))
        assertEquals(Outcome.Failed("tmp-copy", Reason.REPAIR_IO), r)
        assertEquals("no delete of the live tree", "tampered", String(Files.readAllBytes(live.resolve("lib/a.js"))))
        assertTrue(noLeftovers())
        assertEquals(0, persisted)
    }

    @Test
    fun outOfSpaceSideCopyFallsBackToOneInPlaceRepair() {
        put(live.resolve("lib/a.js"), "tampered")
        failCopyOfA(IOException("write failed: ENOSPC (No space left on device)"))
        var calls = 0
        val r = run(i = integrity(usable = { if (calls++ == 0) Long.MAX_VALUE / 4 else 0L }))
        assertTrue("$r", r is Outcome.Repaired && r.mode == Mode.IN_PLACE)
        assertTrue(noLeftovers())
        assertLiveMatchesApk()
    }

    @Test
    fun lowSpaceUpFrontRepairsInPlace() {
        put(live.resolve("lib/a.js"), "tampered")
        val r = run(i = integrity(usable = { 0L }))
        assertTrue("$r", r is Outcome.Repaired && r.mode == Mode.IN_PLACE)
        assertLiveMatchesApk()
    }

    @Test
    fun inPlaceDeleteThatLeavesResidueFailsWithoutCopying() {
        assumeTrue(PosixTestSupport.permissionsEnforced(tmp))
        put(live.resolve("lib/a.js"), "tampered")
        val locked = Files.createDirectories(live.resolve("lib/locked"))
        put(locked.resolve("keep.js"), "residue")
        PosixTestSupport.setMode(locked, "r-x------") // listable, but its entries cannot be removed
        try {
            val r = run(i = integrity(usable = { 0L })) // below 2x the bundle: IN_PLACE
            assertEquals(Outcome.Failed("in-place-delete", Reason.REPAIR_IO), r)
            assertEquals("the residue is still there", "residue", text(locked.resolve("keep.js")))
            // White-box (see failCopyOfA): verify is open 1 and the size count open 2; a copy is open 3.
            assertTrue("no copy into a partly deleted tree: ${assets.opens}", assets.opens.values.all { it <= 2 })
            assertFalse("nothing was copied back", SafeFs.existsNoFollow(live.resolve("main.js")))
            assertEquals(0, persisted)
        } finally {
            PosixTestSupport.setMode(locked, "rwx------")
        }
    }

    @Test
    fun firstSwapRenameFailureLeavesTheLiveTreeAndNoTmp() {
        put(live.resolve("lib/a.js"), "tampered")
        val r = run(i = integrity(move = failingMove { src, _ -> src == live })) // live -> .old
        assertEquals(Outcome.Failed("swap", Reason.REPAIR_IO), r)
        assertEquals("the live tree is unchanged", "tampered", text(live.resolve("lib/a.js")))
        assertTrue("the side copy is removed", noLeftovers())
        assertEquals(0, persisted)
        // The next start repairs it.
        val next = run()
        assertTrue("$next", next is Outcome.Repaired)
        assertTrue(noLeftovers())
        assertLiveMatchesApk()
    }

    @Test
    fun secondSwapRenameFailureFailsAndTheNextStartRepairs() {
        put(live.resolve("lib/a.js"), "tampered")
        val r = run(i = integrity(move = failingMove { _, dst -> dst == live })) // .tmp -> live
        assertEquals("a half-swapped tree never verifies", Outcome.Failed("swap", Reason.REPAIR_IO), r)
        assertFalse("rename 1 emptied the live name", SafeFs.existsNoFollow(live))
        assertFalse("the side copy is removed", SafeFs.existsNoFollow(files.resolve("${BundleIntegrity.BUNDLE}.tmp-n1")))
        assertEquals("tampered", text(files.resolve("${BundleIntegrity.BUNDLE}.old-n1/lib/a.js")))
        assertEquals(0, persisted)
        // The next start, with no injection: the leftover is swept and the bundle is re-extracted.
        logs.clear()
        val next = run()
        assertEquals(Outcome.Repaired(Mode.TMP, listOf(".")), next)
        assertTrue(noLeftovers())
        assertLiveMatchesApk()
    }

    @Test
    fun leftoversFromAnInterruptedRepairAreSwept() {
        put(files.resolve("${BundleIntegrity.BUNDLE}.tmp-old/main.js"), "x")
        put(files.resolve("${BundleIntegrity.BUNDLE}.old-old/main.js"), "y")
        assertEquals(Outcome.Verified, run())
        assertTrue(noLeftovers())
    }

    // ---------------------------------------------------------------- ancestor hygiene

    @Test
    fun plantedAncestorNodeModulesAreQuarantinedAndTheStartProceeds() {
        put(files.resolve("node_modules/evil/index.js"), "pwn")
        put(data.resolve("node_modules/evil2/index.js"), "pwn")
        assertEquals(Outcome.Verified, run())
        assertFalse(SafeFs.existsNoFollow(files.resolve("node_modules")))
        assertFalse(SafeFs.existsNoFollow(data.resolve("node_modules")))
        val q = files.resolve(BundleIntegrity.QUARANTINE)
        val moved = Files.walk(q).use { s -> s.filter { it.fileName.toString() == "index.js" }.count() }
        assertEquals("both planted trees are kept in quarantine, not deleted", 2L, moved)
        assertTrue(logs.count { it.first == LogLevel.ERROR && it.second.contains("quarantined") } == 2)
    }

    @Test
    fun ancestorThatCanBeNeitherMovedNorDeletedInItsBoundFailsTheStart() {
        put(files.resolve("node_modules/evil/index.js"), "pwn")
        put(files.resolve("node_modules/evil/lib.js"), "pwn")
        var t = 0L
        val r = run(
            i = integrity(
                nanoTime = { t++ }, // one tick per reading: a zero delete bound is spent at the first entry
                budgets = BundleIntegrity.Budgets(ancestorDeleteNanos = 0),
                move = failingMove { src, _ -> isNodeModules(src) },
            ),
        )
        assertEquals(Outcome.Failed("ancestor", Reason.ANCESTOR_MODULES), r)
        assertEquals("the planted tree is still there", 2L, regularFiles(files.resolve("node_modules")))
        assertTrue(logs.any { it.first == LogLevel.ERROR && it.second.contains("cannot remove a planted") })
        assertEquals(0, persisted)
        assertEquals("the start fails; Node never starts", listOf("fail:BUNDLE_ANCESTOR_MODULES_AT_ancestor"), startEffectsFor(r))
    }

    @Test
    fun ancestorThatCanBeNeitherMovedNorDeletedFailsTheStart() {
        assumeTrue(PosixTestSupport.permissionsEnforced(tmp))
        val locked = files.resolve("node_modules/locked")
        put(locked.resolve("index.js"), "pwn")
        PosixTestSupport.setMode(locked, "r-x------")
        try {
            val r = run(i = integrity(move = failingMove { src, _ -> isNodeModules(src) }))
            assertEquals(Outcome.Failed("ancestor", Reason.ANCESTOR_MODULES), r)
            assertEquals("pwn", text(locked.resolve("index.js")))
            assertEquals(listOf("fail:BUNDLE_ANCESTOR_MODULES_AT_ancestor"), startEffectsFor(r))
        } finally {
            PosixTestSupport.setMode(locked, "rwx------")
        }
    }

    @Test
    fun oversizedPlantedAncestorWithAFailingRenameStopsOnItsEntryBound() {
        for (i in 0 until 200) put(data.resolve("node_modules/big/f$i.js"), "x")
        val r = run(
            i = integrity(
                budgets = BundleIntegrity.Budgets(ancestorDeleteEntries = 50),
                move = failingMove { src, _ -> isNodeModules(src) },
            ),
        )
        assertEquals(Outcome.Failed("ancestor", Reason.ANCESTOR_MODULES), r)
        val left = regularFiles(data.resolve("node_modules"))
        assertTrue("the delete stopped on its 50-entry bound: $left of 200 files left", left >= 150)
    }

    @Test
    fun ancestorLinkIsMovedNotFollowed() {
        assumeTrue(canLink())
        put(outside.resolve("mods/x/index.js"), "sentinel")
        Files.createSymbolicLink(files.resolve("node_modules"), outside.resolve("mods"))
        assertEquals(Outcome.Verified, run())
        assertFalse(SafeFs.existsNoFollow(files.resolve("node_modules")))
        assertEquals("sentinel", String(Files.readAllBytes(outside.resolve("mods/x/index.js"))))
    }

    // ---------------------------------------------------------------- pins

    @Test
    fun noSpaceDetectionReadsTheCauseChain() {
        assertTrue(BundleIntegrity.isNoSpace(IOException("x", IOException("write failed: ENOSPC"))))
        assertTrue(BundleIntegrity.isNoSpace(IOException("EDQUOT")))
        assertTrue(BundleIntegrity.isNoSpace(java.nio.file.FileSystemException("f: No space left on device")))
        assertFalse(BundleIntegrity.isNoSpace(IOException("EACCES (Permission denied)")))
    }

    @Test
    fun defaultBudgetsAreTheSignedOffValues() {
        val b = BundleIntegrity.Budgets()
        assertEquals(10_000_000_000L, b.totalNanos)
        assertEquals(2_000_000_000L, b.ancestorDeleteNanos)
        assertEquals(50_000L, b.ancestorDeleteEntries)
        assertEquals(1_000_000_000L, b.sweepNanos)
        assertEquals(10_000L, b.sweepEntries)
    }

    @Test
    fun bundleIntegrityUsesNoAndroidApi() {
        val src = File("src/main/java/com/seekerclaw/app/util/BundleIntegrity.kt")
        assertTrue("run from the app module", src.isFile)
        val code = src.readLines().filterNot { it.trimStart().let { t -> t.startsWith("*") || t.startsWith("/*") || t.startsWith("//") } }
        assertTrue(code.none { Regex("""\bandroid\.""").containsMatchIn(it) })
    }
}
