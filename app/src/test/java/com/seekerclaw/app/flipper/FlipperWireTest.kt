package com.seekerclaw.app.flipper

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Wire-format regression tests for the hand-written Flipper RPC codec.
 *
 * The decoder is the load-bearing half: the `Main.content` oneof has ~75 members and we implement
 * about ten, so unknown fields are the normal case rather than the exception. These pin the
 * behaviour that keeps a partially-understood stream readable — and the behaviour that refuses to
 * guess when it is genuinely corrupt.
 */
class FlipperWireTest {

    // ---------------------------------------------------------------- varints

    @Test fun `varint round-trips across boundary widths`() {
        // 127/128 and 16383/16384 are the one-to-two and two-to-three byte boundaries.
        val values = listOf(0L, 1L, 127L, 128L, 300L, 16383L, 16384L, 0xFFFFFFFFL, Long.MAX_VALUE)
        for (v in values) {
            val w = ProtoWriter()
            w.writeVarint(v)
            assertEquals("round-trip of $v", v, ProtoReader(w.toByteArray()).readVarint())
        }
    }

    @Test fun `single byte varint is one byte`() {
        val w = ProtoWriter()
        w.writeVarint(127L)
        assertEquals(1, w.toByteArray().size)
    }

    @Test fun `varint continuing past ten bytes is rejected`() {
        // All-continuation bits: a decoder without a cap would spin or overflow silently.
        val corrupt = ByteArray(12) { 0x80.toByte() }
        assertThrows(ProtoDecodeException::class.java) { ProtoReader(corrupt).readVarint() }
    }

    @Test fun `truncated varint throws rather than returning a partial value`() {
        val truncated = byteArrayOf(0x80.toByte()) // continuation set, nothing follows
        assertThrows(ProtoDecodeException::class.java) { ProtoReader(truncated).readVarint() }
    }

    // ------------------------------------------------------------------- tags

    @Test fun `tag encodes field number and wire type`() {
        val w = ProtoWriter()
        w.writeTag(75, WireType.LENGTH_DELIMITED) // app_button_press_release_request
        val tag = ProtoReader(w.toByteArray()).readTag()
        assertEquals(75, ProtoReader.fieldOf(tag))
        assertEquals(WireType.LENGTH_DELIMITED, ProtoReader.wireTypeOf(tag))
    }

    @Test fun `high field numbers survive round-trip`() {
        // 75 is our highest real tag but the oneof reaches past it; make sure nothing truncates.
        for (field in listOf(1, 4, 5, 39, 47, 48, 58, 75, 1000, 100_000)) {
            val w = ProtoWriter()
            w.writeTag(field, WireType.VARINT)
            assertEquals(field, ProtoReader.fieldOf(ProtoReader(w.toByteArray()).readTag()))
        }
    }

    @Test fun `field number zero is rejected`() {
        val corrupt = byteArrayOf(0x00) // tag 0 -> field 0
        assertThrows(ProtoDecodeException::class.java) { ProtoReader(corrupt).readTag() }
    }

    // ------------------------------------------------- proto3 default omission

    @Test fun `proto3 defaults are not serialised`() {
        val w = ProtoWriter()
        w.writeUint32(1, 0)
        w.writeBool(3, false)
        w.writeString(2, "")
        w.writeBytes(4, ByteArray(0))
        assertEquals("default-valued fields must occupy zero bytes", 0, w.toByteArray().size)
    }

    @Test fun `non-default scalars round-trip`() {
        val w = ProtoWriter()
        w.writeUint32(1, 42)
        w.writeBool(3, true)
        val r = ProtoReader(w.toByteArray())
        assertEquals(1, ProtoReader.fieldOf(r.readTag()))
        assertEquals(42, r.readUint32())
        assertEquals(3, ProtoReader.fieldOf(r.readTag()))
        assertTrue(r.readBool())
    }

    @Test fun `empty message body is still emitted`() {
        // Empty (tag 4) is how App.Start/LoadFile/PressRelease/Exit confirm success. An encoder
        // that dropped a zero-length body would make every App confirm unparseable.
        val w = ProtoWriter()
        w.writeMessage(4, ByteArray(0))
        val bytes = w.toByteArray()
        assertEquals("tag + zero length", 2, bytes.size)
        val r = ProtoReader(bytes)
        assertEquals(4, ProtoReader.fieldOf(r.readTag()))
        assertEquals(0, r.readMessage().let { if (it.hasMore) 1 else 0 })
    }

    @Test fun `string round-trips as utf8`() {
        val w = ProtoWriter()
        w.writeString(1, "Vol_up")
        val r = ProtoReader(w.toByteArray())
        r.readTag()
        assertEquals("Vol_up", r.readString())
    }

    @Test fun `bytes round-trip exactly`() {
        val payload = byteArrayOf(0x00, 0x7F, 0x80.toByte(), 0xFF.toByte())
        val w = ProtoWriter()
        w.writeBytes(9, payload)
        val r = ProtoReader(w.toByteArray())
        r.readTag()
        assertArrayEquals(payload, r.readBytes())
    }

    // -------------------------------------------------- unknown field skipping

    @Test fun `unknown fields of every supported wire type are skipped`() {
        // Simulates a Main carrying a oneof member we do not implement, followed by one we do.
        val w = ProtoWriter()
        w.writeTag(61, WireType.VARINT); w.writeVarint(999L)          // property_get_request-ish
        w.writeTag(62, WireType.FIXED64); repeat(8) { w.writeVarint(0) }
        w.writeTag(63, WireType.LENGTH_DELIMITED); w.writeVarint(3); w.writeVarint(0x41); w.writeVarint(0x42); w.writeVarint(0x43)
        w.writeTag(64, WireType.FIXED32); repeat(4) { w.writeVarint(0) }
        w.writeUint32(1, 7) // the field we actually want

        val r = ProtoReader(w.toByteArray())
        var found = -1
        while (r.hasMore) {
            val tag = r.readTag()
            if (ProtoReader.fieldOf(tag) == 1) { found = r.readUint32(); break }
            r.skipField(tag)
        }
        assertEquals("must reach the known field after skipping four unknown ones", 7, found)
    }

    @Test fun `group wire types are rejected rather than skipped`() {
        // proto3 has no groups. Seeing one means desynchronisation, so resynchronising on a guess
        // would be worse than failing.
        val w = ProtoWriter()
        w.writeTag(10, WireType.START_GROUP)
        val r = ProtoReader(w.toByteArray())
        val tag = r.readTag()
        assertThrows(ProtoDecodeException::class.java) { r.skipField(tag) }
    }

    @Test fun `skipping a truncated length-delimited field throws`() {
        val w = ProtoWriter()
        w.writeTag(20, WireType.LENGTH_DELIMITED)
        w.writeVarint(50) // claims 50 bytes
        val r = ProtoReader(w.toByteArray()) // but none follow
        val tag = r.readTag()
        assertThrows(ProtoDecodeException::class.java) { r.skipField(tag) }
    }

    @Test fun `implausible field length is rejected before allocating`() {
        val w = ProtoWriter()
        w.writeTag(1, WireType.LENGTH_DELIMITED)
        w.writeVarint(Int.MAX_VALUE.toLong())
        val r = ProtoReader(w.toByteArray())
        r.readTag()
        assertThrows(ProtoDecodeException::class.java) { r.readBytes() }
    }

    // ------------------------------------------------------ nested submessages

    @Test fun `nested message reader is bounded to its own body`() {
        val inner = ProtoWriter().apply { writeUint32(1, 5); writeUint32(2, 6) }.toByteArray()
        val outer = ProtoWriter().apply { writeMessage(16, inner); writeUint32(3, 9) }.toByteArray()

        val r = ProtoReader(outer)
        r.readTag()
        val sub = r.readMessage()
        var count = 0
        while (sub.hasMore) { sub.readTag(); sub.readUint32(); count++ }
        assertEquals("sub-reader must stop at the nested body's end", 2, count)

        // Outer reader must be positioned after the nested message, not inside it.
        assertEquals(3, ProtoReader.fieldOf(r.readTag()))
        assertEquals(9, r.readUint32())
    }

    // ------------------------------------------------------------- reassembly

    /** Wraps each body in the varint length prefix the Flipper uses to delimit frames. */
    private fun framed(vararg bodies: ByteArray): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        for (b in bodies) {
            val lengthPrefix = ProtoWriter().apply { writeVarint(b.size.toLong()) }.toByteArray()
            out.write(lengthPrefix)
            out.write(b)
        }
        return out.toByteArray()
    }

    @Test fun `complete frame is located without copying`() {
        val body = ProtoWriter().apply { writeUint32(1, 3) }.toByteArray()
        val buf = framed(body)
        val slice = readDelimitedFrame(buf, 0, buf.size)!!
        assertArrayEquals(body, buf.copyOfRange(slice.start, slice.end))
        assertEquals(buf.size, slice.nextOffset)
    }

    @Test fun `two frames in one buffer are read in sequence`() {
        // One BLE indication can hold the tail of one frame and the head of the next.
        val a = ProtoWriter().apply { writeUint32(1, 1) }.toByteArray()
        val b = ProtoWriter().apply { writeUint32(1, 2) }.toByteArray()
        val buf = framed(a, b)

        val first = readDelimitedFrame(buf, 0, buf.size)!!
        assertArrayEquals(a, buf.copyOfRange(first.start, first.end))
        val second = readDelimitedFrame(buf, first.nextOffset, buf.size)!!
        assertArrayEquals(b, buf.copyOfRange(second.start, second.end))
        assertNull(readDelimitedFrame(buf, second.nextOffset, buf.size))
    }

    @Test fun `incomplete body returns null instead of throwing`() {
        // Mid-reassembly is the normal case, not an error — a throw here would drop live frames.
        val body = ProtoWriter().apply { writeBytes(1, ByteArray(200) { 0x41 }) }.toByteArray()
        val full = framed(body)
        for (cut in listOf(1, 5, full.size / 2, full.size - 1)) {
            assertNull("partial buffer of $cut byte(s) must yield null", readDelimitedFrame(full, 0, cut))
        }
    }

    @Test fun `incomplete length prefix returns null`() {
        // A multi-byte length varint split across two indications.
        val buf = byteArrayOf(0x80.toByte()) // continuation set, remainder not yet arrived
        assertNull(readDelimitedFrame(buf, 0, buf.size))
    }

    @Test fun `frame spanning several indications assembles once complete`() {
        val body = ProtoWriter().apply { writeBytes(1, ByteArray(500) { 0x42 }) }.toByteArray()
        val full = framed(body)
        val chunks = full.toList().chunked(64).map { it.toByteArray() }

        val acc = java.io.ByteArrayOutputStream()
        var slice: FrameSlice? = null
        for (c in chunks) {
            acc.write(c)
            val snapshot = acc.toByteArray()
            slice = readDelimitedFrame(snapshot, 0, snapshot.size)
            if (slice != null) {
                assertArrayEquals(body, snapshot.copyOfRange(slice.start, slice.end))
                break
            }
        }
        assertTrue("frame must resolve once all chunks have arrived", slice != null)
    }

    @Test fun `implausible frame length is rejected`() {
        val lw = ProtoWriter(); lw.writeVarint(Int.MAX_VALUE.toLong())
        val buf = lw.toByteArray() + ByteArray(4)
        assertThrows(ProtoDecodeException::class.java) { readDelimitedFrame(buf, 0, buf.size) }
    }

    @Test fun `zero length frame is a valid empty body`() {
        val buf = framed(ByteArray(0))
        val slice = readDelimitedFrame(buf, 0, buf.size)!!
        assertEquals(slice.start, slice.end)
        assertEquals(buf.size, slice.nextOffset)
    }
}
