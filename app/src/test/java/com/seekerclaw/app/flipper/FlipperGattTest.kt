package com.seekerclaw.app.flipper

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Transport-layer regression tests.
 *
 * These pin the two behaviours that fail *silently* on hardware rather than loudly: flow-control
 * accounting (wrong semantics deadlock around the ninth press, past every slice gate) and frame
 * reassembly (a dropped second frame strands a reply forever).
 */
class FlipperGattTest {

    // ------------------------------------------------------------------- UUIDs

    @Test fun `characteristic uuids match the firmware-derived values`() {
        // Regression guard. A scanner capture rendered TX as `19e82ae-…` — seven hex digits where
        // a UUID needs eight. Hardcoding the observed value fails every lookup with no clear cause.
        // These are the byte-reversed forms of serial_service_uuid.inc @ firmware 8622f1a2.
        assertEquals("8fe5b3d5-2e7f-4a98-2a48-7acc60fe0000", FlipperUuids.SERVICE.toString())
        assertEquals("19ed82ae-ed21-4c9d-4145-228e61fe0000", FlipperUuids.TX.toString())
        assertEquals("19ed82ae-ed21-4c9d-4145-228e62fe0000", FlipperUuids.RX.toString())
        assertEquals("19ed82ae-ed21-4c9d-4145-228e63fe0000", FlipperUuids.FLOW_CONTROL.toString())
        assertEquals("19ed82ae-ed21-4c9d-4145-228e64fe0000", FlipperUuids.RPC_STATUS.toString())
    }

    @Test fun `all four characteristics share a base and differ only in the fe6x byte`() {
        // Structural sanity: they are one family, so a typo in any single one stands out.
        val suffixes = listOf(FlipperUuids.TX, FlipperUuids.RX, FlipperUuids.FLOW_CONTROL, FlipperUuids.RPC_STATUS)
            .map { it.toString().substringAfterLast('-') }
        assertEquals(listOf("228e61fe0000", "228e62fe0000", "228e63fe0000", "228e64fe0000"), suffixes)
    }

    // ------------------------------------------------------------ flow control

    @Test fun `credit notification sets the absolute value rather than accumulating`() {
        // The firmware reports remaining room, not a delta. Adding drifts the accounting until
        // writes are refused (or worse, accepted when there is no room).
        val full = FlipperGattConfig.INITIAL_CREDIT
        val fc = FlowControl(initial = full)
        fc.tryConsume(600)
        assertEquals(full - 600, fc.available)

        fc.onCreditNotified(full) // buffer drained on the device
        assertEquals("must be set to the notified value, not added to it", full, fc.available)
    }

    @Test fun `consuming beyond the credit is refused rather than going negative`() {
        val fc = FlowControl(initial = 100)
        assertTrue(fc.tryConsume(100))
        assertEquals(0, fc.available)
        assertFalse("no room left", fc.tryConsume(1))
        assertEquals(0, fc.available)
    }

    @Test fun `a client that never receives a refill exhausts after the buffer size`() {
        // This is the deadlock the contract warns about: it surfaces around the ninth press of a
        // long session, long after slice 1's ping gate would have passed.
        val fc = FlowControl()
        var written = 0
        while (fc.tryConsume(128)) written += 128
        assertEquals(FlipperGattConfig.INITIAL_CREDIT, written)
        assertFalse(fc.tryConsume(1))
    }

    @Test fun `negative notified credit is clamped`() {
        val fc = FlowControl()
        fc.onCreditNotified(-5) // byte-reversed uint32 misread would look like this
        assertEquals(0, fc.available)
    }

    @Test fun `a notified credit above the buffer size is clamped down`() {
        // The dangerous direction, and the one that was unguarded. This value comes off the BLE
        // link, which the contract treats as untrusted: a mis-decoded width or a corrupt frame can
        // report more room than the device physically has, and tryConsume would then authorise
        // writes past RPC_BUFFER_SIZE — the overrun this class exists to prevent. Too LITTLE credit
        // merely stalls, which is why only the floor being clamped looked sufficient.
        val fc = FlowControl()
        fc.onCreditNotified(Int.MAX_VALUE)
        assertEquals(FlipperGattConfig.INITIAL_CREDIT, fc.available)

        fc.onCreditNotified(65_535) // a plausible width mis-decode
        assertEquals(FlipperGattConfig.INITIAL_CREDIT, fc.available)
    }

    @Test fun `a clamped credit cannot authorise a write past the buffer`() {
        // The consequence, stated as behaviour rather than as a number.
        val fc = FlowControl()
        fc.onCreditNotified(Int.MAX_VALUE)
        assertTrue(fc.tryConsume(FlipperGattConfig.INITIAL_CREDIT))
        assertFalse("not one byte past the firmware buffer", fc.tryConsume(1))
    }

    @Test fun `reset restores a full buffer for a new session`() {
        val fc = FlowControl()
        fc.tryConsume(1000)
        fc.reset()
        assertEquals(FlipperGattConfig.INITIAL_CREDIT, fc.available)
    }

    @Test fun `releasing returns credit reserved for bytes that never went out`() {
        // onCreditNotified is absolute, so a reservation lost to a failed write is not recovered by
        // the next notification's arithmetic — it stays missing until the device happens to refill.
        // Repeated write failures would then surface as NO_CREDIT on commands the device had room for.
        val fc = FlowControl(initial = 1000)
        assertTrue(fc.tryConsume(400))
        assertEquals(600, fc.available)

        fc.release(400)
        assertEquals(1000, fc.available)
    }

    @Test fun `releasing cannot invent credit beyond the buffer size`() {
        // A double-release, or a release racing a fresh absolute notification, must not leave the
        // client believing it has more room than the firmware's buffer physically holds.
        val fc = FlowControl()
        fc.tryConsume(100)
        fc.release(100)
        fc.release(100)
        assertEquals(FlipperGattConfig.INITIAL_CREDIT, fc.available)
    }

    @Test fun `a partial write returns only the unsent remainder`() {
        // What `send` does on a mid-frame failure: bytes the device received are its to account
        // for, so returning the whole frame would over-credit and risk the overrun this prevents.
        val fc = FlowControl(initial = 1000)
        val frame = 300
        val written = 120
        assertTrue(fc.tryConsume(frame))
        fc.release(frame - written)
        assertEquals("only the 180 B that never reached the wire come back", 880, fc.available)
    }

    // --------------------------------------------------------------- reassembly

    private fun frame(body: ByteArray): ByteArray =
        ProtoWriter().apply { writeVarint(body.size.toLong()) }.toByteArray() + body

    @Test fun `single complete frame in one indication`() {
        val body = byteArrayOf(1, 2, 3)
        val out = FrameAssembler().append(frame(body))
        assertEquals(1, out.size)
        assertArrayEquals(body, out[0])
    }

    @Test fun `two frames arriving in one indication are both returned`() {
        // Returning only the first would strand the second reply forever.
        val a = byteArrayOf(1)
        val b = byteArrayOf(2, 2)
        val out = FrameAssembler().append(frame(a) + frame(b))
        assertEquals(2, out.size)
        assertArrayEquals(a, out[0])
        assertArrayEquals(b, out[1])
    }

    @Test fun `frame spanning several indications resolves once complete`() {
        val body = ByteArray(500) { (it % 251).toByte() }
        val full = frame(body)
        val asm = FrameAssembler()

        var emitted: List<ByteArray> = emptyList()
        for (chunk in full.toList().chunked(64).map { it.toByteArray() }) {
            val got = asm.append(chunk)
            if (got.isNotEmpty()) emitted = got
        }
        assertEquals(1, emitted.size)
        assertArrayEquals(body, emitted[0])
        assertEquals("buffer must be drained after emitting", 0, asm.pending)
    }

    @Test fun `indication carrying a tail plus a head keeps the partial frame buffered`() {
        // The awkward real-world case: one indication ends mid-frame.
        val a = byteArrayOf(9, 9)
        val b = ByteArray(100) { 7 }
        val stream = frame(a) + frame(b)
        val cut = frame(a).size + 10 // partway into b's frame

        val asm = FrameAssembler()
        val first = asm.append(stream.copyOfRange(0, cut))
        assertEquals("only the complete frame emerges", 1, first.size)
        assertArrayEquals(a, first[0])
        assertTrue("remainder must be retained", asm.pending > 0)

        val second = asm.append(stream.copyOfRange(cut, stream.size))
        assertEquals(1, second.size)
        assertArrayEquals(b, second[0])
        assertEquals(0, asm.pending)
    }

    @Test fun `a long session of partial indications reuses the buffer correctly`() {
        // Guards the growable-buffer rewrite. The assembler keeps capacity separate from content
        // and compacts the unparsed tail in place, so an off-by-one in the compaction would corrupt
        // a later frame rather than fail immediately — and only after enough traffic to wrap. Each
        // frame here is deliberately cut so a tail is always left pending across the boundary.
        val asm = FrameAssembler()
        val received = mutableListOf<ByteArray>()
        val expected = mutableListOf<ByteArray>()

        var carry = ByteArray(0)
        for (i in 0 until 200) {
            val body = ByteArray(37 + (i % 23)) { ((i + it) % 251).toByte() }
            expected += body
            val stream = carry + frame(body)
            // Withhold the last 3 bytes so the next iteration completes them.
            val cut = stream.size - 3
            received += asm.append(stream.copyOfRange(0, cut))
            carry = stream.copyOfRange(cut, stream.size)
        }
        received += asm.append(carry)

        assertEquals(expected.size, received.size)
        for (i in expected.indices) {
            assertArrayEquals("frame $i must survive compaction intact", expected[i], received[i])
        }
        assertEquals(0, asm.pending)
    }

    @Test fun `growth is refused past the cap and the buffer is dropped`() {
        // Refusing before allocating is the point: a corrupt length prefix must not be able to make
        // us reserve the memory it claims.
        val asm = FrameAssembler(maxBuffered = 256)
        try {
            asm.append(ByteArray(300))
            throw AssertionError("expected ProtoDecodeException")
        } catch (e: ProtoDecodeException) {
            assertEquals("the session is unrecoverable, so nothing is retained", 0, asm.pending)
        }
    }

    @Test fun `reset drops capacity so one huge frame cannot pin memory`() {
        val asm = FrameAssembler()
        // A length prefix claiming far more than follows, so everything stays buffered. A bare
        // ByteArray would not: a leading 0 byte is a valid zero-length frame and drains instantly.
        val header = ProtoWriter().apply { writeVarint(100_000L) }.toByteArray()
        asm.append(header + ByteArray(64_000) { 1 })
        assertTrue(asm.pending > 0)
        asm.reset()
        assertEquals(0, asm.pending)
        // Still usable afterwards, at the small capacity.
        val body = byteArrayOf(4, 5, 6)
        assertArrayEquals(body, asm.append(frame(body))[0])
    }

    @Test fun `incomplete frame emits nothing and does not throw`() {
        val asm = FrameAssembler()
        assertEquals(0, asm.append(byteArrayOf(0x80.toByte())).size) // partial length varint
        assertTrue(asm.pending > 0)
    }

    @Test fun `runaway buffer is rejected rather than grown without bound`() {
        val asm = FrameAssembler(maxBuffered = 256)
        // A length prefix claiming more than we will ever buffer, followed by filler.
        val lengthPrefix = ProtoWriter().apply { writeVarint(100_000L) }.toByteArray()
        assertThrows(ProtoDecodeException::class.java) {
            asm.append(lengthPrefix + ByteArray(300))
        }
    }

    @Test fun `reset clears a partial frame`() {
        val asm = FrameAssembler()
        asm.append(byteArrayOf(0x80.toByte()))
        asm.reset()
        assertEquals(0, asm.pending)
    }

    // ------------------------------------------------------------------ chunking

    @Test fun `frame smaller than the payload is a single write`() {
        val frame = ByteArray(10)
        assertEquals(1, chunkForMtu(frame, 414).size)
    }

    @Test fun `chunk size is mtu minus the three byte ATT header`() {
        val mtu = 414
        val chunks = chunkForMtu(ByteArray(1000), mtu)
        assertEquals(mtu - 3, chunks[0].size)
        assertTrue("no chunk may exceed the ATT payload", chunks.all { it.size <= mtu - 3 })
    }

    @Test fun `chunks reassemble to the original frame`() {
        val frame = ByteArray(1000) { (it % 256).toByte() }
        val joined = chunkForMtu(frame, 185).reduce { a, b -> a + b }
        assertArrayEquals(frame, joined)
    }

    @Test fun `exact payload boundary does not produce a trailing empty chunk`() {
        val mtu = 100
        val chunks = chunkForMtu(ByteArray(mtu - 3), mtu)
        assertEquals(1, chunks.size)
    }

    @Test fun `implausible mtu is rejected`() {
        assertThrows(IllegalArgumentException::class.java) { chunkForMtu(ByteArray(10), 20) }
    }
}
