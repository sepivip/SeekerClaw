package com.seekerclaw.app.util

import org.junit.After
import org.junit.Assert.assertArrayEquals
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

/**
 * BAT-1409 P1-J — Kotlin never writes (or reads) through a link, at any depth. Every link case
 * plants a link to a sentinel outside the writer root and asserts the sentinel's bytes survive.
 */
class SafeFsWriteTest {

    private lateinit var tmp: Path
    private lateinit var root: Path
    private lateinit var outside: Path

    @Before
    fun setUp() {
        tmp = Files.createTempDirectory("safefs-write")
        root = Files.createDirectories(tmp.resolve("files"))
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

    private fun sentinel(): Path = Files.write(outside.resolve("sentinel.txt"), "sentinel".toByteArray())

    private fun noTempLeft() =
        assertTrue(
            ".kwrite must be empty after the write",
            !Files.exists(root.resolve(SafeFs.KWRITE_DIR)) ||
                Files.list(root.resolve(SafeFs.KWRITE_DIR)).use { it.count() } == 0L,
        )

    @Test
    fun writesAndReplacesAtomically() {
        val t = root.resolve("workspace/config.json")
        SafeFs.writeAtomicText(root, t, "one")
        SafeFs.writeAtomicText(root, t, "two")
        assertEquals("two", SafeFs.readTextNoFollow(root, t))
        noTempLeft()
    }

    @Test
    fun finalComponentLinkIsReplacedNotFollowed() {
        assumeTrue(canLink())
        val s = sentinel()
        Files.createDirectories(root.resolve("workspace"))
        val t = root.resolve("workspace/agent_settings.json")
        Files.createSymbolicLink(t, s)
        SafeFs.writeAtomicText(root, t, "{}")
        assertFalse("the link is replaced by a regular file", Files.isSymbolicLink(t))
        assertEquals("{}", SafeFs.readTextNoFollow(root, t))
        assertEquals("sentinel", String(Files.readAllBytes(s)))
    }

    @Test
    fun danglingLinkIsReplacedNotFollowed() {
        assumeTrue(canLink())
        Files.createDirectories(root.resolve("workspace"))
        val t = root.resolve("workspace/owner_ids")
        val target = outside.resolve("would-be-created.txt")
        Files.createSymbolicLink(t, target)
        SafeFs.writeAtomicText(root, t, "{}")
        assertFalse("nothing may be created at the dangling link's target", Files.exists(target))
    }

    @Test
    fun linkedIntermediateParentIsRefused() {
        assumeTrue(canLink())
        val s = sentinel()
        Files.createDirectories(root.resolve("workspace"))
        Files.createSymbolicLink(root.resolve("workspace/memory"), outside)
        try {
            SafeFs.writeAtomicText(root, root.resolve("workspace/memory/sentinel.txt"), "pwned")
            fail("expected UnsafePathException")
        } catch (_: SafeFs.UnsafePathException) {
        }
        assertEquals("sentinel", String(Files.readAllBytes(s)))
    }

    @Test
    fun plantedKwriteLinkIsReplacedBeforeUse() {
        assumeTrue(canLink())
        val s = sentinel()
        Files.createSymbolicLink(root.resolve(SafeFs.KWRITE_DIR), outside)
        SafeFs.writeAtomicText(root, root.resolve("service_state"), "RUNNING")
        assertTrue(SafeFs.isRealDir(root.resolve(SafeFs.KWRITE_DIR)))
        assertEquals("sentinel", String(Files.readAllBytes(s)))
        assertEquals(1L, Files.list(outside).use { it.count() }) // nothing staged outside
    }

    @Test
    fun failureInsideWriterLeavesTargetAndNoTemp() {
        val t = root.resolve("workspace/MEMORY.md")
        SafeFs.writeAtomicText(root, t, "keep")
        try {
            SafeFs.writeAtomicFrom(root, t) { out ->
                out.write("partial".toByteArray())
                throw IllegalStateException("limit exceeded")
            }
            fail("expected the writer's exception")
        } catch (_: IllegalStateException) {
        }
        assertEquals("keep", SafeFs.readTextNoFollow(root, t))
        noTempLeft()
    }

    @Test
    fun durableWriteSyncsTheParentDirectoryAfterTheMove() {
        val t = root.resolve("workspace/skill_state.json")
        SafeFs.writeAtomicText(root, t, "old")
        val saved = SafeFs.dirSync
        // What each directory sync sees: the directory, and the target's bytes at that moment.
        val syncs = mutableListOf<Pair<Path, String>>()
        SafeFs.dirSync = { dir -> syncs += dir to SafeFs.readTextNoFollow(root, t) }
        try {
            SafeFs.writeAtomicText(root, t, "new", durable = true)
            assertEquals("exactly the parent, after the rename landed", listOf(t.parent to "new"), syncs)
            syncs.clear()
            SafeFs.writeAtomicText(root, t, "newer")
            assertEquals("a non-durable write syncs nothing", emptyList<Pair<Path, String>>(), syncs)
        } finally {
            SafeFs.dirSync = saved
        }
        assertEquals("newer", SafeFs.readTextNoFollow(root, t))
    }

    @Test
    fun moveFailureLeavesNoConfigOrSettingsLeftoversAndThePriorTargetUnchanged() {
        val ws = root.resolve("workspace")
        val settings = ws.resolve("agent_settings.json")
        SafeFs.writeAtomicText(root, settings, "{\"prior\":true}")
        val saved = SafeFs.beforeMove
        SafeFs.beforeMove = { _, target ->
            if (target.fileName.toString() in setOf("config.json", "agent_settings.json")) {
                throw java.io.IOException("injected move failure")
            }
        }
        try {
            for (name in listOf("config.json", "agent_settings.json")) {
                try {
                    SafeFs.writeAtomicText(root, ws.resolve(name), "{\"botToken\":\"secret\"}")
                    fail("the injected move failure must surface: $name")
                } catch (e: java.io.IOException) {
                    assertEquals("injected move failure", e.message)
                }
            }
        } finally {
            SafeFs.beforeMove = saved
        }
        val names = Files.list(ws).use { s -> s.map { it.fileName.toString() }.sorted().toList() }
        assertEquals("no config.json* and no agent_settings.json* leftovers", listOf("agent_settings.json"), names)
        assertEquals("{\"prior\":true}", SafeFs.readTextNoFollow(root, settings))
        noTempLeft()
    }

    @Test
    fun appendDoesNotFollowAFinalLink() {
        assumeTrue(canLink())
        val s = sentinel()
        val t = root.resolve("service_logs")
        Files.createSymbolicLink(t, s)
        try {
            SafeFs.appendNoFollow(root, t, "x\n".toByteArray())
            fail("expected an exception for the link")
        } catch (_: Exception) {
        }
        assertEquals("sentinel", String(Files.readAllBytes(s)))
    }

    @Test
    fun readsDoNotFollowLinks() {
        assumeTrue(canLink())
        val s = sentinel()
        Files.createDirectories(root.resolve("workspace"))
        val t = root.resolve("workspace/owner_ids")
        Files.createSymbolicLink(t, s)
        try {
            SafeFs.readTextNoFollow(root, t)
            fail("expected an exception for the link")
        } catch (_: Exception) {
        }
        try {
            SafeFs.readRangeNoFollow(root, t, 0, 1)
            fail("expected an exception for the link")
        } catch (_: Exception) {
        }
    }

    @Test
    fun readRangeReadsExactBytes() {
        val t = root.resolve("service_logs")
        SafeFs.writeAtomicText(root, t, "0123456789")
        assertArrayEquals("3456".toByteArray(), SafeFs.readRangeNoFollow(root, t, 3, 4))
    }

    @Test
    fun lockChannelDoesNotFollowALink() {
        assumeTrue(canLink())
        val s = sentinel()
        val t = root.resolve("xai_oauth.lock")
        Files.createSymbolicLink(t, s)
        try {
            SafeFs.openLockChannelNoFollow(root, t).close()
            fail("expected an exception for the link")
        } catch (_: Exception) {
        }
        assertEquals("sentinel", String(Files.readAllBytes(s)))
    }

    @Test
    fun moveReplacesALinkAtTheDestination() {
        assumeTrue(canLink())
        val s = sentinel()
        val dir = Files.createDirectories(root.resolve("workspace/skills/x"))
        val src = Files.write(root.resolve("workspace/skills/.x.staging-file"), "new".toByteArray())
        val dst = dir.resolve("helper.md")
        Files.createSymbolicLink(dst, s)
        SafeFs.moveNoFollow(root, src, dst)
        assertFalse(Files.isSymbolicLink(dst))
        assertEquals("new", SafeFs.readTextNoFollow(root, dst))
        assertEquals("sentinel", String(Files.readAllBytes(s)))
    }

    @Test
    fun rootForPrefersFilesRoot() {
        val saved = SafeFs.filesRoot
        try {
            SafeFs.filesRoot = root
            assertEquals(root, SafeFs.rootFor(root.resolve("workspace/skills-manifest.json")))
            SafeFs.filesRoot = null
            assertEquals(root.resolve("workspace"), SafeFs.rootFor(root.resolve("workspace/skills-manifest.json")))
        } finally {
            SafeFs.filesRoot = saved
        }
    }

    /**
     * Source guard: raw Kotlin file writes are gone from app/src/main — every write goes through
     * SafeFs (the bundle extraction too, since P1-A: SafeFs.createNewFrom).
     */
    @Test
    fun noRawFileWritesInMainSources() {
        val src = File("src/main/java")
        assertTrue("run from the app module", src.isDirectory)
        // Each banned form, with the only files allowed to use it:
        // - SafeFs.kt is the writer itself;
        // - EncryptedPrefsKeyVault.wipe overwrites a regular file with NOFOLLOW;
        // - ProviderConfigScreen writes an HTTP request body (conn.outputStream), not a file.
        val rules = listOf(
            Regex("""\.writeText\(|\.writeBytes\(|\.appendText\(|\.appendBytes\(|\.renameTo\(|\.createNewFile\(""") to setOf("SafeFs.kt"),
            Regex("""FileOutputStream\(|RandomAccessFile\(|FileWriter\(|PrintWriter\(|\.printWriter\(""") to setOf("SafeFs.kt"),
            Regex("""\.outputStream\(\)|\.bufferedWriter\(""") to setOf("SafeFs.kt", "ProviderConfigScreen.kt"),
            Regex("""Files\.write\(|Files\.copy\(|Files\.newOutputStream\(|Files\.newBufferedWriter\(|FileChannel\.open\(""") to
                setOf("SafeFs.kt", "EncryptedPrefsKeyVault.kt"),
        )
        val offenders = mutableListOf<String>()
        src.walkTopDown().filter { it.isFile && it.name.endsWith(".kt") }.forEach { f ->
            f.readLines().forEachIndexed { i, line ->
                val t = line.trimStart()
                if (t.startsWith("//") || t.startsWith("*")) return@forEachIndexed
                for ((rx, allowed) in rules) {
                    if (f.name !in allowed && rx.containsMatchIn(line)) {
                        offenders += "${f.path}:${i + 1}: ${line.trim()}"
                    }
                }
            }
        }
        assertTrue("raw file writes found:\n" + offenders.joinToString("\n"), offenders.isEmpty())
    }

    /**
     * R3: a refused write ends in "the caller's existing failure path… Never a crash." The two
     * pre-Node writers that throw (writeConfigJson, seedWorkspace) run on the service's main looper,
     * where an uncaught IOException would kill `:node` with no Logs-screen line; the start
     * continuation catches it and ends the start through failBeforeNode. (writeAgentSettingsJson
     * and writePlatformMd catch their own failures.)
     */
    @Test
    fun startPathWriteFailuresEndOnTheErrorPathNotACrash() {
        val service = File("src/main/java/com/seekerclaw/app/service/SeekerClawService.kt").readText()
            .replace("\r\n", "\n")
        val body = service.substringAfter("private fun continueStart(").substringBefore("\n    private fun ")
        for ((call, reason) in listOf("ConfigManager.writeConfigJson(" to "CONFIG_WRITE", "ConfigManager.seedWorkspace(" to "WORKSPACE_SEED")) {
            val at = body.indexOf(call)
            assertTrue("continueStart calls $call", at >= 0)
            val tryAt = body.lastIndexOf("try {", at)
            assertTrue("$call is inside a try block", tryAt >= 0 && body.substring(tryAt, at).none { it == '}' })
            val catchAt = body.indexOf("catch (e: java.io.IOException)", at)
            assertTrue("$call has an IOException handler", catchAt > at)
            val handler = body.substring(catchAt, body.indexOf("\n        }", catchAt))
            assertTrue("$call failure goes to failBeforeNode($reason)", handler.contains("return failBeforeNode(\"$reason"))
        }
        val config = File("src/main/java/com/seekerclaw/app/config/ConfigManager.kt").readText().replace("\r\n", "\n")
        for (fn in listOf("fun writeAgentSettingsJson(", "fun writePlatformMd(")) {
            val fnBody = config.substringAfter(fn).substringBefore("\n    fun ")
            assertTrue("$fn catches its own failures", fnBody.contains("catch (e: Exception)"))
        }
    }
}
