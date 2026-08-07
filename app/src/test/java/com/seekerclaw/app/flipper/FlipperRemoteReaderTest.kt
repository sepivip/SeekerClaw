package com.seekerclaw.app.flipper

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Enumeration and read tests, driven through a fake transport.
 *
 * Everything here is logic that would otherwise only ever run against hardware: the `.ir` filter,
 * the directory exclusion, and the `has_next` chunk join. The chunk join in particular has to be
 * right — a `name:` line straddling a chunk boundary is ordinary, and joining incorrectly produces
 * a button list that silently differs from the device.
 */
class FlipperRemoteReaderTest {

    /**
     * Replays one scripted response per request, so no BLE stack is involved.
     *
     * Each element is a whole response — `client.send` returns every frame of a `has_next`
     * sequence, so a chunked reply is one element containing several frames.
     */
    private class FakeTransport(vararg responses: List<RpcFrame>) : RpcTransport {
        private val queue = responses.toMutableList()
        val sent = mutableListOf<RpcRequest>()
        override suspend fun send(request: RpcRequest, timeoutMs: Long): List<RpcFrame> {
            sent += request
            return queue.removeAt(0)
        }
    }

    private fun listFrame(
        files: List<StorageFile>,
        hasNext: Boolean = false,
        status: CommandStatus = CommandStatus.OK,
    ) = RpcFrame(1, status, hasNext, RpcContent.StorageList(files))

    private fun readFrame(
        data: ByteArray,
        hasNext: Boolean = false,
        status: CommandStatus = CommandStatus.OK,
    ) = RpcFrame(1, status, hasNext, RpcContent.StorageRead(StorageFile(false, "tv.ir", data.size, data)))

    private fun file(name: String, isDir: Boolean = false) = StorageFile(isDir, name, 100, ByteArray(0))

    private val tvRef = RemoteRef("tv.ir", "/ext/infrared/tv.ir")
    private val remoteBytes = "Filetype: IR signals file\nVersion: 1\nname: Power\nname: Vol_up\n".toByteArray()

    /** `assertThrows` cannot take a suspend lambda, so failures are caught explicitly. */
    private inline fun assertFlipperThrows(block: () -> Unit) {
        try {
            block()
        } catch (e: FlipperTransportException) {
            return
        }
        throw AssertionError("expected FlipperTransportException, none thrown")
    }

    // ---------------------------------------------------------------- listing

    @Test fun `only dot-ir files are listed`() = runTest {
        val t = FakeTransport(listOf(listFrame(listOf(
            file("tv.ir"), file("notes.txt"), file("ac.ir"), file("readme.md"),
        ))))
        assertEquals(listOf("tv.ir", "ac.ir"), FlipperRemoteReader(t).listRemotes().remotes.map { it.fileName })
    }

    @Test fun `extension matching is case sensitive`() = runTest {
        // The firmware's own matching is case-sensitive, so listing tv.IR would offer a file that
        // then fails to load.
        val t = FakeTransport(listOf(listFrame(listOf(file("tv.IR"), file("ac.ir")))))
        assertEquals(listOf("ac.ir"), FlipperRemoteReader(t).listRemotes().remotes.map { it.fileName })
    }

    @Test fun `directories are excluded which drops the assets library for free`() = runTest {
        // /ext/infrared/assets holds the shipped universal library — parses fine, but
        // infrared_remote_load rejects it with WrongFileType.
        val t = FakeTransport(listOf(listFrame(listOf(file("assets", isDir = true), file("tv.ir")))))
        assertEquals(listOf("tv.ir"), FlipperRemoteReader(t).listRemotes().remotes.map { it.fileName })
    }

    @Test fun `chunked listing frames are all consumed`() = runTest {
        // Storage.List returns 8 files per frame with has_next; dropping later frames would hide
        // most of the user's remotes.
        val t = FakeTransport(listOf(
            listFrame(listOf(file("a.ir"), file("b.ir")), hasNext = true),
            listFrame(listOf(file("c.ir"))),
        ))
        assertEquals(listOf("a.ir", "b.ir", "c.ir"), FlipperRemoteReader(t).listRemotes().remotes.map { it.fileName })
    }

    @Test fun `non-ascii names are counted as skipped rather than silently dropped`() = runTest {
        val t = FakeTransport(listOf(listFrame(listOf(file("tv.ir"), file("té.ir")))))
        val listing = FlipperRemoteReader(t).listRemotes()
        assertEquals(listOf("tv.ir"), listing.remotes.map { it.fileName })
        assertEquals("the UI must be able to say something was skipped", 1, listing.skipped)
    }

    @Test fun `file cap is reported rather than silently truncating`() = runTest {
        val many = (1..FlipperRemoteReader.MAX_FILES + 10).map { file("r$it.ir") }
        val listing = FlipperRemoteReader(FakeTransport(listOf(listFrame(many)))).listRemotes()
        assertEquals(FlipperRemoteReader.MAX_FILES, listing.remotes.size)
        assertTrue(listing.capped)
    }

    @Test fun `paths are scoped to the infrared directory`() = runTest {
        val t = FakeTransport(listOf(listFrame(listOf(file("tv.ir")))))
        assertEquals("/ext/infrared/tv.ir", FlipperRemoteReader(t).listRemotes().remotes[0].path)
    }

    @Test fun `display name drops the extension`() {
        assertEquals("tv", tvRef.displayName)
    }

    @Test fun `a list error surfaces rather than yielding an empty list`() = runTest {
        // An empty list and a failed list are very different things to the user.
        val t = FakeTransport(listOf(listFrame(emptyList(), status = CommandStatus.ERROR_STORAGE_NOT_EXIST)))
        assertFlipperThrows { FlipperRemoteReader(t).listRemotes() }
    }

    // ------------------------------------------------------------------ read

    @Test fun `single frame read parses buttons`() = runTest {
        val t = FakeTransport(listOf(readFrame(remoteBytes)))
        val d = FlipperRemoteReader(t).readRemote(tvRef)
        assertNotNull(d)
        assertEquals(listOf("Power", "Vol_up"), d!!.buttons)
    }

    @Test fun `chunked read joins before parsing`() = runTest {
        // The split is placed mid-file deliberately: parsing per-chunk would produce a different
        // button list than the device's.
        val cut = remoteBytes.size / 2
        val t = FakeTransport(listOf(
            readFrame(remoteBytes.copyOfRange(0, cut), hasNext = true),
            readFrame(remoteBytes.copyOfRange(cut, remoteBytes.size)),
        ))
        assertEquals(listOf("Power", "Vol_up"), FlipperRemoteReader(t).readRemote(tvRef)!!.buttons)
    }

    @Test fun `chunk split inside a name value still parses correctly`() = runTest {
        val body = "Filetype: IR signals file\nVersion: 1\nname: Power\n".toByteArray()
        val cut = String(body).indexOf("Power") + 2 // mid-"Power"
        val t = FakeTransport(listOf(
            readFrame(body.copyOfRange(0, cut), hasNext = true),
            readFrame(body.copyOfRange(cut, body.size)),
        ))
        assertEquals(listOf("Power"), FlipperRemoteReader(t).readRemote(tvRef)!!.buttons)
    }

    @Test fun `a library file is rejected rather than offered`() = runTest {
        val library = "Filetype: IR library file\nVersion: 1\nname: Power\n".toByteArray()
        val t = FakeTransport(listOf(readFrame(library)))
        assertNull(FlipperRemoteReader(t).readRemote(RemoteRef("lib.ir", "/ext/infrared/lib.ir")))
    }

    @Test fun `a wrong-version file is rejected`() = runTest {
        val v2 = "Filetype: IR signals file\nVersion: 2\nname: Power\n".toByteArray()
        val t = FakeTransport(listOf(readFrame(v2)))
        assertNull(FlipperRemoteReader(t).readRemote(RemoteRef("v2.ir", "/ext/infrared/v2.ir")))
    }

    @Test fun `a remote with no buttons is returned but flagged empty`() = runTest {
        val header = "Filetype: IR signals file\nVersion: 1\n".toByteArray()
        val t = FakeTransport(listOf(readFrame(header)))
        val d = FlipperRemoteReader(t).readRemote(RemoteRef("empty.ir", "/ext/infrared/empty.ir"))
        assertNotNull("a loadable file with no buttons differs from an unloadable one", d)
        assertTrue(d!!.isEmpty)
    }

    @Test fun `a read error surfaces rather than parsing a truncated file`() = runTest {
        val t = FakeTransport(listOf(
            readFrame(remoteBytes.copyOfRange(0, 10), hasNext = true),
            readFrame(ByteArray(0), status = CommandStatus.ERROR_STORAGE_INTERNAL),
        ))
        assertFlipperThrows { FlipperRemoteReader(t).readRemote(tvRef) }
    }

    // ----------------------------------------------------------- fingerprint

    @Test fun `fingerprint covers the raw bytes`() = runTest {
        val t = FakeTransport(listOf(readFrame(remoteBytes)))
        val d = FlipperRemoteReader(t).readRemote(tvRef)!!
        assertEquals(sha256(remoteBytes), d.sha256)
        assertEquals(64, d.sha256.length)
    }

    @Test fun `same names and size but a different signal changes the fingerprint`() {
        // The case Codex rejected a names+size fingerprint over: swap the signal, keep the names
        // and the byte count, and a weaker fingerprint would fire an unapproved appliance.
        val a = "Filetype: IR signals file\nVersion: 1\nname: Power\ncommand: 08 00 00 00\n".toByteArray()
        val b = "Filetype: IR signals file\nVersion: 1\nname: Power\ncommand: 09 00 00 00\n".toByteArray()
        assertEquals("both files must be the same length for this to be a fair test", a.size, b.size)
        assertFalse(sha256(a) == sha256(b))
    }
}
