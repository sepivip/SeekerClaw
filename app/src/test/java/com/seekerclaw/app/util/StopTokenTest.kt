package com.seekerclaw.app.util

import com.seekerclaw.app.util.StopToken.State
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

/** BAT-1409 P1-A (correction v3.4) — the stop token is read as a tagged state. */
class StopTokenTest {

    private lateinit var tmp: Path
    private lateinit var files: Path
    private val token get() = files.resolve(StopToken.FILE_NAME)

    @Before
    fun setUp() {
        tmp = Files.createTempDirectory("stop-token")
        files = Files.createDirectories(tmp.resolve("files"))
    }

    @After
    fun tearDown() {
        try { SafeFs.deleteTreeNoFollow(tmp.parent, tmp) } catch (_: Exception) {}
    }

    @Test
    fun missingFileIsAbsent() = assertEquals(State.Absent, StopToken.read(files))

    @Test
    fun freshTokenReadsBackAsThatToken() {
        assertTrue(StopToken.writeFresh(files))
        val s = StopToken.read(files)
        assertTrue(s is State.Token)
        assertEquals(32, (s as State.Token).value.length)
        assertTrue("written durably through SafeFs, so no temp is left", Files.list(files.resolve(SafeFs.KWRITE_DIR)).use { it.count() } == 0L)
    }

    @Test
    fun twoFreshTokensDiffer() {
        StopToken.writeFresh(files)
        val a = StopToken.read(files)
        StopToken.writeFresh(files)
        assertFalse(StopToken.matches(a, StopToken.read(files)))
    }

    @Test
    fun malformedContentIsUnreadable() {
        for (bad in listOf("", "xyz", "ABCDEF0123456789ABCDEF0123456789", "0".repeat(31), "0".repeat(33), "0".repeat(100))) {
            Files.write(token, bad.toByteArray())
            assertEquals("content '$bad'", State.Unreadable, StopToken.read(files))
        }
    }

    @Test
    fun trailingNewlineIsTolerated() {
        Files.write(token, ("a".repeat(32) + "\n").toByteArray())
        assertEquals(State.Token("a".repeat(32)), StopToken.read(files))
    }

    @Test
    fun directoryAtTheNameIsUnreadable() {
        Files.createDirectory(token)
        assertEquals(State.Unreadable, StopToken.read(files))
    }

    @Test
    fun directoryAtTheNameIsRemovedByTheRepairWrite() {
        Files.createDirectories(token.resolve("nested"))
        Files.write(token.resolve("nested/f"), "x".toByteArray())
        assertTrue("the repair must converge", StopToken.writeFresh(files))
        assertTrue(StopToken.read(files) is State.Token)
    }

    @Test
    fun linkAtTheNameIsReplacedByTheRepairWriteAndItsTargetSurvives() {
        val target = Files.write(tmp.resolve("target"), "keep".toByteArray())
        val ok = try { Files.createSymbolicLink(token, target); true } catch (_: Exception) { false }
        assumeTrue(ok)
        assertTrue(StopToken.writeFresh(files))
        assertTrue(StopToken.read(files) is State.Token)
        assertEquals("keep", String(Files.readAllBytes(target)))
    }

    @Test
    fun linkAtTheNameIsUnreadableAndNotFollowed() {
        val target = Files.write(tmp.resolve("target"), "b".repeat(32).toByteArray())
        val ok = try { Files.createSymbolicLink(token, target); true } catch (_: Exception) { false }
        assumeTrue(ok)
        assertEquals(State.Unreadable, StopToken.read(files))
    }

    @Test
    fun onlyAnExactMatchProceeds() {
        val v = State.Token("a".repeat(32))
        val w = State.Token("b".repeat(32))
        assertTrue(StopToken.matches(State.Absent, State.Absent))
        assertTrue(StopToken.matches(v, State.Token("a".repeat(32))))
        assertFalse(StopToken.matches(State.Absent, v))
        assertFalse(StopToken.matches(v, w))
        assertFalse(StopToken.matches(v, State.Absent))
        for (s in listOf(State.Absent, v, State.Unreadable)) {
            assertFalse(StopToken.matches(s, State.Unreadable))
            assertFalse(StopToken.matches(State.Unreadable, s))
        }
    }
}
