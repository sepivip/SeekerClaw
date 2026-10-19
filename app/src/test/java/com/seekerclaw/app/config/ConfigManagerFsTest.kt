package com.seekerclaw.app.config

import android.content.ContextWrapper
import android.content.SharedPreferences
import com.seekerclaw.app.SourceText
import com.seekerclaw.app.config.ConfigManager.OwnerIdFile
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
import com.seekerclaw.app.util.SafeFs
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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
 * BAT-1409 P1-M / P1-J / P1-C — ConfigManager's filesystem paths, through their Context-free
 * seams: `clearMemory`, skill-seeding promotion, and the `owner_ids` read and write. Every link
 * case points at a sentinel outside the app's files and asserts its bytes survive.
 */
class ConfigManagerFsTest {

    private lateinit var tmp: Path
    private lateinit var files: Path
    private lateinit var ws: Path
    private lateinit var outside: Path

    @Before
    fun setUp() {
        tmp = Files.createTempDirectory("config-fs")
        files = Files.createDirectories(tmp.resolve("files"))
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

    private fun text(p: Path) = String(Files.readAllBytes(p))

    private fun sentinelFile(name: String = "sentinel.txt", body: String = "sentinel"): Path =
        Files.write(outside.resolve(name), body.toByteArray())

    /** A sentinel directory holding one file; returns the check that it is exactly as planted. */
    private fun sentinelDir(name: String = "dir"): Pair<Path, () -> Unit> {
        val d = Files.createDirectories(outside.resolve(name))
        Files.write(d.resolve("keep.txt"), "sentinel".toByteArray())
        return d to {
            assertEquals("sentinel", text(d.resolve("keep.txt")))
            assertEquals("nothing added to or removed from $name", 1L, Files.list(d).use { it.count() })
        }
    }

    private fun isRegular(p: Path) = Files.isRegularFile(p, LinkOption.NOFOLLOW_LINKS)

    // ------------------------------------------------------------------------------ clearMemory

    @Test
    fun clearMemoryEmptiesMemoryMdAndLeavesAnEmptyRealMemoryDir() {
        Files.write(ws.resolve("MEMORY.md"), "remember this".toByteArray())
        Files.createDirectories(ws.resolve("memory/2026"))
        Files.write(ws.resolve("memory/2026/10-14.md"), "note".toByteArray())
        Files.write(ws.resolve("SOUL.md"), "keep".toByteArray())
        ConfigManager.clearMemory(files)
        assertTrue(isRegular(ws.resolve("MEMORY.md")))
        assertEquals(0L, Files.size(ws.resolve("MEMORY.md")))
        assertTrue(SafeFs.isRealDir(ws.resolve("memory")))
        assertEquals(0L, Files.list(ws.resolve("memory")).use { it.count() })
        assertEquals("other workspace files are untouched", "keep", text(ws.resolve("SOUL.md")))
    }

    @Test
    fun clearMemoryDoesNotCreateAMissingMemoryMd() {
        ConfigManager.clearMemory(files)
        assertFalse(SafeFs.existsNoFollow(ws.resolve("MEMORY.md")))
        assertTrue(SafeFs.isRealDir(ws.resolve("memory")))
    }

    @Test
    fun clearMemoryNeverFollowsLinksInsideMemoryOrAtMemoryMd() {
        assumeTrue(canLink())
        val (dir, dirIntact) = sentinelDir()
        val memoryTarget = sentinelFile("MEMORY-target.md", "sentinel-memory")
        Files.createDirectories(ws.resolve("memory"))
        Files.write(ws.resolve("memory/note.md"), "note".toByteArray())
        Files.createSymbolicLink(ws.resolve("memory/x"), dir)
        Files.createSymbolicLink(ws.resolve("MEMORY.md"), memoryTarget)
        ConfigManager.clearMemory(files)
        dirIntact()
        assertEquals("sentinel-memory", text(memoryTarget))
        assertTrue("MEMORY.md is now a regular file", isRegular(ws.resolve("MEMORY.md")))
        assertEquals(0L, Files.size(ws.resolve("MEMORY.md")))
        assertTrue(SafeFs.isRealDir(ws.resolve("memory")))
        assertEquals(0L, Files.list(ws.resolve("memory")).use { it.count() })
    }

    @Test
    fun clearMemoryUnlinksALinkedMemoryDirAndRecreatesARealOne() {
        assumeTrue(canLink())
        val (dir, dirIntact) = sentinelDir()
        Files.createSymbolicLink(ws.resolve("memory"), dir)
        ConfigManager.clearMemory(files)
        dirIntact()
        assertTrue(SafeFs.isRealDir(ws.resolve("memory")))
        assertEquals(0L, Files.list(ws.resolve("memory")).use { it.count() })
    }

    // ------------------------------------------------------------------------- skill promotion

    @Test
    fun promoteStagingReplacesLinksAtTheLiveDestinationWithoutFollowingThem() {
        assumeTrue(canLink())
        val target = sentinelFile()
        val (dir, dirIntact) = sentinelDir()
        val live = Files.createDirectories(ws.resolve("skills/paysh"))
        val staging = Files.createDirectories(ws.resolve("skills/.paysh.staging"))
        Files.write(staging.resolve("catalog.json"), "new".toByteArray())
        Files.createDirectories(staging.resolve("services"))
        Files.write(staging.resolve("services/a.json"), "svc".toByteArray())
        Files.createSymbolicLink(live.resolve("catalog.json"), target)
        Files.createSymbolicLink(live.resolve("services"), dir)
        ConfigManager.promoteStaging(files, staging.toFile(), live.toFile())
        assertEquals("sentinel", text(target))
        dirIntact()
        assertTrue("the file link is replaced by a regular file", isRegular(live.resolve("catalog.json")))
        assertEquals("new", text(live.resolve("catalog.json")))
        assertTrue("the dir link is replaced by a real dir", SafeFs.isRealDir(live.resolve("services")))
        assertEquals("svc", text(live.resolve("services/a.json")))
    }

    @Test
    fun promoteStagingRefusesALinkInStaging() {
        assumeTrue(canLink())
        val target = sentinelFile()
        val (dir, dirIntact) = sentinelDir()
        val live = Files.createDirectories(ws.resolve("skills/paysh"))
        val staging = Files.createDirectories(ws.resolve("skills/.paysh.staging"))
        for ((name, to) in listOf("catalog.json" to target, "services" to dir)) {
            val link = staging.resolve(name)
            Files.createSymbolicLink(link, to)
            try {
                ConfigManager.promoteStaging(files, staging.toFile(), live.toFile())
                fail("a link in staging must be refused: $name")
            } catch (_: SafeFs.UnsafePathException) {
            }
            assertFalse("nothing was promoted for $name", SafeFs.existsNoFollow(live.resolve(name)))
            Files.delete(link)
        }
        assertEquals("sentinel", text(target))
        dirIntact()
    }

    // ------------------------------------------------------------------------------- owner_ids

    /** org.json is a stub on the JVM (every call returns a default), so the JSON lookup is injected. */
    private val lookup: (String, String) -> String? = { json, channel ->
        Regex("\"$channel\"\\s*:\\s*\"([^\"]*)\"").find(json)?.groupValues?.get(1)
    }

    @Test
    fun regularOwnerIdsFileIsFound() {
        Files.write(ws.resolve("owner_ids"), "{\"telegram\": \"123\"}".toByteArray())
        assertEquals(OwnerIdFile.Found("123"), ConfigManager.ownerIdFromFile(files, "telegram", lookup))
        assertEquals("no entry for the channel", OwnerIdFile.Absent, ConfigManager.ownerIdFromFile(files, "discord", lookup))
    }

    @Test
    fun missingOwnerIdsIsAbsent() {
        assertEquals(OwnerIdFile.Absent, ConfigManager.ownerIdFromFile(files, "telegram", lookup))
        assertEquals(OwnerIdFile.Absent, ConfigManager.ownerIdFromFile(files, "telegram"))
    }

    @Test
    fun unparseableOwnerIdsIsUnreadable() {
        Files.write(ws.resolve("owner_ids"), "{not json".toByteArray())
        val r = ConfigManager.ownerIdFromFile(files, "telegram") { _, _ -> throw IllegalArgumentException("parse") }
        assertEquals(OwnerIdFile.Unreadable, r)
    }

    @Test
    fun ownerIdsLinkIsUnreadableAndItsTargetIsUntouched() {
        assumeTrue(canLink())
        val target = sentinelFile("o.json", "{\"telegram\": \"999\"}")
        Files.createSymbolicLink(ws.resolve("owner_ids"), target)
        assertEquals(OwnerIdFile.Unreadable, ConfigManager.ownerIdFromFile(files, "telegram", lookup))
        assertEquals("the default lookup never reaches the parser", OwnerIdFile.Unreadable, ConfigManager.ownerIdFromFile(files, "telegram"))
        assertEquals("{\"telegram\": \"999\"}", text(target))
        assertTrue(Files.isSymbolicLink(ws.resolve("owner_ids")))
    }

    @Test
    fun ownerIdsUnderALinkedWorkspaceIsUnreadable() {
        assumeTrue(canLink())
        val elsewhere = Files.createDirectories(outside.resolve("ws"))
        Files.write(elsewhere.resolve("owner_ids"), "{\"telegram\": \"999\"}".toByteArray())
        Files.delete(ws)
        Files.createSymbolicLink(ws, elsewhere)
        assertEquals(OwnerIdFile.Unreadable, ConfigManager.ownerIdFromFile(files, "telegram", lookup))
    }

    /** `Context` backed by [filesDir] and one in-memory prefs file; nothing else is used. */
    private class FakeContext(private val filesDir: File, private val prefs: Map<String, String>) : ContextWrapper(null) {
        override fun getFilesDir(): File = filesDir
        override fun getSharedPreferences(name: String?, mode: Int): SharedPreferences = object : SharedPreferences {
            override fun getAll(): MutableMap<String, *> = prefs.toMutableMap()
            override fun getString(key: String?, defValue: String?): String? = prefs[key] ?: defValue
            override fun getStringSet(key: String?, defValues: MutableSet<String>?): MutableSet<String>? = defValues
            override fun getInt(key: String?, defValue: Int) = defValue
            override fun getLong(key: String?, defValue: Long) = defValue
            override fun getFloat(key: String?, defValue: Float) = defValue
            override fun getBoolean(key: String?, defValue: Boolean) = defValue
            override fun contains(key: String?) = prefs.containsKey(key)
            override fun edit(): SharedPreferences.Editor = throw UnsupportedOperationException("read-only")
            override fun registerOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
            override fun unregisterOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
        }
    }

    private fun unreadableWarnings() = LogCollector.logs.value.count {
        it.level == LogLevel.WARN && it.message.startsWith("[Config] owner_ids unreadable")
    }

    /**
     * The deliberate decision (P1-C): an unreadable `owner_ids` falls back to the owner in Settings,
     * never to "no owner" (which would reopen Node's first-sender auto-claim), and says so in a WARN.
     */
    @Test
    fun unreadableOwnerIdsFallsBackToTheSettingsOwnerWithAWarning() {
        assumeTrue(canLink())
        val target = sentinelFile("o.json", "{\"telegram\": \"999\"}")
        Files.createSymbolicLink(ws.resolve("owner_ids"), target)
        val ctx = FakeContext(files.toFile(), mapOf("owner_id" to "4242"))
        val before = unreadableWarnings()
        assertEquals("4242", ConfigManager.loadOwnerIdFromFile(ctx, "telegram"))
        assertEquals(before + 1, unreadableWarnings())
        assertEquals("{\"telegram\": \"999\"}", text(target))
    }

    @Test
    fun absentOwnerIdsFallsBackToTheSettingsOwnerSilently() {
        val ctx = FakeContext(files.toFile(), mapOf("owner_id" to "4242", "discord_owner_id" to "77"))
        val before = unreadableWarnings()
        assertEquals("4242", ConfigManager.loadOwnerIdFromFile(ctx, "telegram"))
        assertEquals("77", ConfigManager.loadOwnerIdFromFile(ctx, "discord"))
        assertEquals("a missing file is not a warning", before, unreadableWarnings())
    }

    // ------------------------------------------------------------------------- owner_ids.tmp

    @Test
    fun ownerIdsWriteNeverGoesThroughAPlantedTmpLink() {
        assumeTrue(canLink())
        val target = sentinelFile()
        Files.createSymbolicLink(ws.resolve("owner_ids.tmp"), target)
        SafeFs.writeAtomicText(files, ws.resolve("owner_ids"), "{\"telegram\":\"1\"}")
        assertEquals("sentinel", text(target))
        assertTrue(isRegular(ws.resolve("owner_ids")))
        assertEquals("{\"telegram\":\"1\"}", text(ws.resolve("owner_ids")))
    }

    /** Violations of "no `owner_ids.tmp` in Kotlin code, and saveOwnerIdToFile writes through SafeFs". */
    private fun ownerIdsTmpViolations(sources: List<Pair<String, String>>, config: String): List<String> {
        val out = mutableListOf<String>()
        for ((path, src) in sources) {
            val code = SourceText.withoutComments(src) // string literals kept: they are what is banned
            Regex("""owner_ids\.tmp""").findAll(code).forEach { out += "$path:${SourceText.lineOf(code, it.range.first)}: owner_ids.tmp" }
        }
        val code = SourceText.withoutComments(config)
        val body = SourceText.flat(code.substring(SourceText.functionBody(SourceText.codeOnly(config), "saveOwnerIdToFile")))
        if (!body.contains("SafeFs.writeAtomicText(filesDir.toPath(), file.toPath(),")) out += "saveOwnerIdToFile must write through SafeFs.writeAtomicText"
        if (Regex("""\.tmp"|renameTo\(|Files\.move\(""").containsMatchIn(body)) out += "saveOwnerIdToFile must not stage its own tmp"
        return out
    }

    @Test
    fun noOwnerIdsTmpInKotlinAndTheOwnerWriteIsAtomic() {
        val config = SourceText.main("com/seekerclaw/app/config/ConfigManager.kt")
        assertEquals(emptyList<String>(), ownerIdsTmpViolations(SourceText.allMain(), config))
        // Negative controls: a fixed tmp name in code, or a writer that stages its own tmp, is rejected.
        val planted = listOf("x/A.kt" to "val t = File(dir, \"owner_ids.tmp\")")
        assertNotEquals(emptyList<String>(), ownerIdsTmpViolations(planted, config))
        assertEquals("a comment is not code", emptyList<String>(), ownerIdsTmpViolations(listOf("x/A.kt" to "// owner_ids.tmp"), config))
        val ownTmp = config.replace(
            "SafeFs.writeAtomicText(filesDir.toPath(), file.toPath(), existing.toString())",
            "File(workspaceDir, \"owner_ids\" + \".tmp\").renameTo(file)",
        )
        assertNotEquals(config, ownTmp)
        assertNotEquals(emptyList<String>(), ownerIdsTmpViolations(emptyList(), ownTmp))
    }
}
