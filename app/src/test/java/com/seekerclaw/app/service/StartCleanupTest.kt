package com.seekerclaw.app.service

import com.seekerclaw.app.util.SafeFs
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

/**
 * BAT-1409 P1-A — the `Failed` / teardown cleanup ([StartCleanup.deleteEphemeralConfig]) removes
 * the ephemeral `workspace/config.json` (and the legacy `.tmp`) and never follows a link: a link
 * there is unlinked and its target keeps its bytes.
 */
class StartCleanupTest {

    private lateinit var tmp: Path
    private lateinit var files: Path
    private lateinit var ws: Path
    private lateinit var outside: Path
    private val logs = mutableListOf<String>()

    @Before
    fun setUp() {
        tmp = Files.createTempDirectory("start-cleanup")
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

    private fun cleanup() = StartCleanup.deleteEphemeralConfig(files) { logs += it }

    private fun text(p: Path) = String(Files.readAllBytes(p))

    @Test
    fun configAndLegacyTmpAreRemovedAndNothingElse() {
        Files.write(ws.resolve("config.json"), "{\"botToken\":\"secret\"}".toByteArray())
        Files.write(ws.resolve("config.json.tmp"), "{\"botToken\":\"secret\"}".toByteArray())
        Files.write(ws.resolve("owner_ids"), "{}".toByteArray())
        cleanup()
        assertFalse(SafeFs.existsNoFollow(ws.resolve("config.json")))
        assertFalse(SafeFs.existsNoFollow(ws.resolve("config.json.tmp")))
        assertEquals("{}", text(ws.resolve("owner_ids")))
        assertTrue(logs.isEmpty())
    }

    @Test
    fun nothingThereIsANoOp() {
        cleanup()
        assertTrue(logs.isEmpty())
        assertEquals(0L, Files.list(ws).use { it.count() })
    }

    @Test
    fun configLinksAreUnlinkedAndTheirTargetsKeepTheirBytes() {
        assumeTrue(canLink())
        val sentinel = Files.write(outside.resolve("sentinel.json"), "sentinel".toByteArray())
        val sentinelDir = Files.createDirectories(outside.resolve("dir"))
        Files.write(sentinelDir.resolve("keep.txt"), "sentinel".toByteArray())
        Files.createSymbolicLink(ws.resolve("config.json"), sentinel)
        Files.createSymbolicLink(ws.resolve("config.json.tmp"), sentinelDir)
        cleanup()
        assertFalse(SafeFs.existsNoFollow(ws.resolve("config.json")))
        assertFalse(SafeFs.existsNoFollow(ws.resolve("config.json.tmp")))
        assertEquals("sentinel", text(sentinel))
        assertEquals("sentinel", text(sentinelDir.resolve("keep.txt")))
        assertTrue(logs.isEmpty())
    }

    @Test
    fun aLinkedWorkspaceIsRefusedLoggedAndNeverThrows() {
        assumeTrue(canLink())
        val elsewhere = Files.createDirectories(outside.resolve("ws"))
        Files.write(elsewhere.resolve("config.json"), "sentinel".toByteArray())
        Files.delete(ws)
        Files.createSymbolicLink(ws, elsewhere)
        cleanup()
        assertEquals("sentinel", text(elsewhere.resolve("config.json")))
        assertEquals(
            listOf(
                "[Service] Could not remove workspace/config.json: UnsafePathException",
                "[Service] Could not remove workspace/config.json.tmp: UnsafePathException",
            ),
            logs,
        )
    }
}
