package com.seekerclaw.app.flipper

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Envelope-codec regression tests.
 *
 * The most important test here is [encoder cannot construct any command outside the eight-tag
 * allowlist] — it pins the structural guarantee BAT-1201 §7 rests on, and fails if anyone adds a
 * ninth [RpcRequest] subclass without amending the contract.
 */
class FlipperRpcTest {

    // ------------------------------------------------- the structural guarantee

    @Test fun `encoder cannot construct any command outside the eight-tag allowlist`() {
        // Plain Java reflection over the nested subclasses — `sealedSubclasses` would drag in
        // kotlin-reflect, and the whole point of hand-rolling this codec was zero new dependencies.
        val subclasses = RpcRequest::class.java.declaredClasses
            .filter { RpcRequest::class.java.isAssignableFrom(it) }
        assertEquals(
            "RpcRequest gained or lost a subclass — BAT-1201 §7 requires a contract amendment",
            8, subclasses.size,
        )

        val instances = listOf(
            RpcRequest.Ping(),
            RpcRequest.ProtobufVersion,
            RpcRequest.StorageList(FlipperPaths.INFRARED_DIR),
            RpcRequest.StorageRead("${FlipperPaths.INFRARED_DIR}/tv.ir"),
            RpcRequest.StartInfraredRpc,
            RpcRequest.LoadFile("${FlipperPaths.INFRARED_DIR}/tv.ir"),
            RpcRequest.PressRelease("Power"),
            RpcRequest.Exit,
        )
        assertEquals("every subclass must be represented here", subclasses.size, instances.size)
        assertEquals(
            OutTag.ALL.toSortedSet(),
            instances.map { it.tag }.toSortedSet(),
        )
    }

    @Test fun `button press and release tags are absent from the allowlist`() {
        // 49 and 50 route through infrared_tx_start(), which carries the false-OK path. Tag 75 is
        // honest only because these are never sent (BAT-1201 §6 G1).
        assertFalse("tag 49 (AppButtonPress) must never be encodable", OutTag.ALL.contains(49))
        assertFalse("tag 50 (AppButtonRelease) must never be encodable", OutTag.ALL.contains(50))
    }

    @Test fun `dangerous commands have no tag in the allowlist`() {
        // Desktop.Unlock (67) opens a PIN-locked Flipper with no PIN; Gui.SendInputEvent (23) is
        // ungated UI injection; Storage.Write (11) can rewrite the RF region policy.
        for (tag in listOf(11, 12, 23, 43, 67, 71)) {
            assertFalse("tag $tag must not be encodable", OutTag.ALL.contains(tag))
        }
    }

    // --------------------------------------------------------- G2 / G3 / naming

    @Test fun `empty button name is rejected at construction`() {
        // Empty args falls through to index addressing, where proto3's default of 0 fires an
        // arbitrary button (§6 G2).
        assertThrows(IllegalArgumentException::class.java) { RpcRequest.PressRelease("") }
    }

    @Test fun `press-release never writes the index field`() {
        // index (field 2) has no bounds check and reaches an out-of-bounds read (§6 G3).
        val body = RpcRequest.PressRelease("Power").encodeBody()
        val fields = mutableListOf<Int>()
        val r = ProtoReader(body)
        while (r.hasMore) {
            val tag = r.readTag()
            fields += ProtoReader.fieldOf(tag)
            r.skipField(tag)
        }
        assertEquals("only args (field 1) may be present", listOf(1), fields)
    }

    @Test fun `app start uses the display name not the appid`() {
        // The loader matches on .name only; "infrared" returns ERROR_INVALID_PARAMETERS (§5).
        val body = RpcRequest.StartInfraredRpc.encodeBody()
        val r = ProtoReader(body)
        r.readTag()
        assertEquals("Infrared", r.readString())
        r.readTag()
        assertEquals("RPC", r.readString())
    }

    @Test fun `button name bytes pass through unmodified`() {
        // The firmware strcmp's against its own tokenisation; we must not normalise (§6 G4).
        val awkward = "Vol Up " // trailing space is legitimate and load-bearing
        val body = RpcRequest.PressRelease(awkward).encodeBody()
        val r = ProtoReader(body)
        r.readTag()
        assertEquals(awkward, r.readString())
    }

    @Test fun `high bytes are sent latin1 not utf8`() {
        // Regression. IrFileParser maps each file byte to one char, so a 0xFF byte in a .ir
        // becomes U+00FF. Encoding that as UTF-8 emits TWO bytes and the firmware's strcmp —
        // comparing against the single byte it read from the same file — never matches, giving a
        // permanent unknown_button with nothing in the logs to explain it.
        val name = "ÿþ"
        val body = RpcRequest.PressRelease(name).encodeBody()
        val r = ProtoReader(body)
        r.readTag()
        val onWire = r.readBytes()
        assertEquals("must be one byte per char", 2, onWire.size)
        assertEquals(0xFF, onWire[0].toInt() and 0xFF)
        assertEquals(0xFE, onWire[1].toInt() and 0xFF)
    }

    @Test fun `ascii names are unaffected by the latin1 encoding`() {
        val body = RpcRequest.PressRelease("Power").encodeBody()
        val r = ProtoReader(body)
        r.readTag()
        assertArrayEquals("Power".toByteArray(Charsets.US_ASCII), r.readBytes())
    }

    @Test fun `a parsed name round-trips from file bytes to the wire`() {
        // End-to-end on the byte path: what the parser produces from a .ir file must be exactly
        // what leaves on the wire, for any byte value.
        val header = "Filetype: IR signals file\nVersion: 1\nname: ".toByteArray(Charsets.US_ASCII)
        val fileBytes = header + byteArrayOf(0x80.toByte(), 0x41, 0xFE.toByte()) + byteArrayOf(0x0A)
        val parsed = IrFileParser.parseButtonNames(fileBytes).single()
        val body = RpcRequest.PressRelease(parsed).encodeBody()
        val r = ProtoReader(body)
        r.readTag()
        assertArrayEquals(byteArrayOf(0x80.toByte(), 0x41, 0xFE.toByte()), r.readBytes())
    }

    // ------------------------------------------------------------ path scoping

    @Test fun `storage access outside the infrared directory is rejected`() {
        for (bad in listOf("/int/.bt.keys", "/ext/subghz/gate.sub", "/ext", "/ext/infraredX/a.ir")) {
            assertThrows("must reject $bad", IllegalArgumentException::class.java) {
                RpcRequest.StorageRead(bad)
            }
        }
    }

    @Test fun `path traversal is rejected`() {
        assertThrows(IllegalArgumentException::class.java) {
            RpcRequest.StorageRead("${FlipperPaths.INFRARED_DIR}/../../int/.bt.keys")
        }
    }

    @Test fun `the infrared directory itself is a valid list target`() {
        RpcRequest.StorageList(FlipperPaths.INFRARED_DIR) // must not throw
        RpcRequest.StorageList("${FlipperPaths.INFRARED_DIR}/sub") // nested is fine too
    }

    // ------------------------------------------------------------------ framing

    @Test fun `encode emits a length-prefixed frame that reads back`() {
        val bytes = FlipperRpc.encode(1, RpcRequest.ProtobufVersion)
        val slice = readDelimitedFrame(bytes, 0, bytes.size)
        assertNotNull("encoded output must be a complete delimited frame", slice)
        assertEquals("frame must consume the whole buffer", bytes.size, slice!!.nextOffset)
    }

    @Test fun `command id must be positive`() {
        // 0 is proto3's default and would not be serialised — the reply could not be correlated.
        assertThrows(IllegalArgumentException::class.java) {
            FlipperRpc.encode(0, RpcRequest.ProtobufVersion)
        }
    }

    private fun roundTrip(commandId: Int, req: RpcRequest): RpcFrame {
        val framed = FlipperRpc.encode(commandId, req)
        val slice = readDelimitedFrame(framed, 0, framed.size)!!
        return FlipperRpc.decode(framed, slice.start, slice.end)
    }

    @Test fun `encoded request round-trips with its command id`() {
        val frame = roundTrip(7, RpcRequest.LoadFile("${FlipperPaths.INFRARED_DIR}/tv.ir"))
        assertEquals(7, frame.commandId)
        assertEquals(CommandStatus.OK, frame.status)
        assertFalse(frame.hasNext)
    }

    // ----------------------------------------------------------------- decoding

    /** Builds a Main body directly, the way the firmware would send one. */
    private fun mainBody(
        commandId: Int = 0,
        status: Int = 0,
        hasNext: Boolean = false,
        contentTag: Int? = null,
        contentBody: ByteArray = ByteArray(0),
    ): ByteArray = ProtoWriter().apply {
        writeUint32(1, commandId)
        writeEnum(2, status)
        writeBool(3, hasNext)
        if (contentTag != null) writeMessage(contentTag, contentBody)
    }.toByteArray()

    @Test fun `empty content decodes as the App command confirm`() {
        // App.Start / LoadFile / PressRelease / Exit all confirm with Empty (tag 4). A decoder
        // that did not handle it would find every App confirm unparseable.
        val frame = FlipperRpc.decode(mainBody(commandId = 3, contentTag = InTag.EMPTY))
        assertEquals(RpcContent.Empty, frame.content)
        assertEquals(3, frame.commandId)
    }

    @Test fun `unknown content tag decodes as Other rather than throwing`() {
        // Firmware may send any of ~75 oneof members; we implement about ten.
        val frame = FlipperRpc.decode(mainBody(commandId = 9, contentTag = 62)) // property_get_response
        assertEquals(RpcContent.Other(62), frame.content)
        assertEquals(9, frame.commandId)
    }

    @Test fun `error status is preserved with its raw code`() {
        val frame = FlipperRpc.decode(mainBody(commandId = 2, status = 17)) // ERROR_APP_SYSTEM_LOCKED
        assertEquals(CommandStatus.ERROR_APP_SYSTEM_LOCKED, frame.status)
    }

    @Test fun `unmapped status code surfaces as Unknown without losing the frame`() {
        val frame = FlipperRpc.decode(mainBody(commandId = 2, status = 58)) // ERROR_GPIO_MODE_INCORRECT
        assertEquals(CommandStatus.Unknown, frame.status)
    }

    @Test fun `app state response is flagged unsolicited`() {
        val body = ProtoWriter().apply { writeEnum(1, 1) }.toByteArray() // APP_STARTED
        val frame = FlipperRpc.decode(mainBody(contentTag = InTag.APP_STATE_RESPONSE, contentBody = body))
        assertEquals(RpcContent.AppStateChanged(AppState.APP_STARTED), frame.content)
        assertTrue("must never resolve a pending call (§5 R3)", frame.isUnsolicited)
    }

    @Test fun `app state response with garbage envelope fields is still routed by tag`() {
        // send_state_response mallocs PB_Main and sets only which_content and state, so
        // command_id, command_status and has_next are uninitialised heap.
        val body = ProtoWriter().apply { writeEnum(1, 1) }.toByteArray()
        val frame = FlipperRpc.decode(
            mainBody(commandId = 999, status = 22, hasNext = true,
                contentTag = InTag.APP_STATE_RESPONSE, contentBody = body),
        )
        assertTrue("routing must not depend on command_id or has_next", frame.isUnsolicited)
        assertEquals(RpcContent.AppStateChanged(AppState.APP_STARTED), frame.content)
    }

    @Test fun `app closed decodes from an unset state field`() {
        // APP_CLOSED is 0, so proto3 omits it — an empty body legitimately means closed.
        val frame = FlipperRpc.decode(mainBody(contentTag = InTag.APP_STATE_RESPONSE))
        assertEquals(RpcContent.AppStateChanged(AppState.APP_CLOSED), frame.content)
    }

    @Test fun `ping response echoes its payload`() {
        val payload = byteArrayOf(1, 2, 3, 4)
        val body = ProtoWriter().apply { writeBytes(1, payload) }.toByteArray()
        val frame = FlipperRpc.decode(mainBody(commandId = 1, contentTag = InTag.SYSTEM_PING_RESPONSE, contentBody = body))
        assertArrayEquals(payload, (frame.content as RpcContent.Pong).data)
    }

    @Test fun `protobuf version comparison honours the 0_25 floor`() {
        fun v(major: Int, minor: Int) = RpcContent.ProtobufVersion(major, minor)
        assertTrue(v(0, 25).atLeast(0, 25))
        assertTrue(v(0, 26).atLeast(0, 25))
        assertTrue(v(1, 0).atLeast(0, 25))
        assertFalse("0.24 lacks tag 75 entirely", v(0, 24).atLeast(0, 25))
        assertFalse(v(0, 0).atLeast(0, 25))
    }

    @Test fun `storage list decodes files and directories`() {
        fun file(isDir: Boolean, name: String, size: Int) = ProtoWriter().apply {
            writeEnum(1, if (isDir) 1 else 0)
            writeString(2, name)
            writeUint32(3, size)
        }.toByteArray()

        val body = ProtoWriter().apply {
            writeMessage(1, file(false, "tv.ir", 512))
            writeMessage(1, file(true, "assets", 0))
        }.toByteArray()

        val frame = FlipperRpc.decode(mainBody(commandId = 4, contentTag = InTag.STORAGE_LIST_RESPONSE, contentBody = body))
        val files = (frame.content as RpcContent.StorageList).files
        assertEquals(2, files.size)
        assertEquals("tv.ir", files[0].name)
        assertFalse(files[0].isDir)
        assertTrue("directories must be distinguishable — assets/ holds library files", files[1].isDir)
    }

    @Test fun `storage read carries the file bytes`() {
        val content = "Filetype: IR signals file\nname: Power\n".toByteArray()
        val fileMsg = ProtoWriter().apply {
            writeString(2, "tv.ir")
            writeUint32(3, content.size)
            writeBytes(4, content)
        }.toByteArray()
        val body = ProtoWriter().apply { writeMessage(1, fileMsg) }.toByteArray()

        val frame = FlipperRpc.decode(mainBody(commandId = 5, contentTag = InTag.STORAGE_READ_RESPONSE, contentBody = body))
        val file = (frame.content as RpcContent.StorageRead).file!!
        assertArrayEquals(content, file.data)
    }

    @Test fun `has_next survives decode for chunked reads`() {
        val frame = FlipperRpc.decode(mainBody(commandId = 5, hasNext = true, contentTag = InTag.STORAGE_READ_RESPONSE))
        assertTrue("chunked Storage.Read must be reassembled before parsing", frame.hasNext)
    }

    @Test fun `frame with no content field decodes without throwing`() {
        val frame = FlipperRpc.decode(mainBody(commandId = 6, status = 1))
        assertEquals(RpcContent.None, frame.content)
        assertEquals(CommandStatus.ERROR, frame.status)
    }

    @Test fun `unknown envelope field is skipped`() {
        // Forward compatibility: a newer firmware adding a Main field must not break decoding.
        val body = ProtoWriter().apply {
            writeUint32(1, 11)
            writeUint32(99, 1234) // does not exist in 0.25
            writeMessage(InTag.EMPTY, ByteArray(0))
        }.toByteArray()
        val frame = FlipperRpc.decode(body)
        assertEquals(11, frame.commandId)
        assertEquals(RpcContent.Empty, frame.content)
    }
}
