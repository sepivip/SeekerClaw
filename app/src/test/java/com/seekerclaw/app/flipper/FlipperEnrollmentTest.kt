package com.seekerclaw.app.flipper

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Enrollment record and permission-gate tests.
 *
 * The `permits` gate is the single place that decides whether a physical action happens, and the
 * codec is what it reads from. Both fail closed on anything unexpected — a permissive default here
 * would let a corrupt record fire an appliance.
 */
class FlipperEnrollmentTest {

    private val tv = AllowedButton("/ext/infrared/tv.ir", "tv", "abc123", "Power")
    private val garage = AllowedButton("/ext/infrared/garage.ir", "garage", "def456", "Open")

    private fun okDevice(ack: Long = 0L) =
        EnrolledFlipper("80:E1:26:12:B7:E1", "Flipper Oytia", SecurityClass.OK, ack, "1.4.3")

    // ------------------------------------------------------------ the gate

    @Test fun `a permitted press passes every condition`() {
        val e = FlipperEnrollment(okDevice(), listOf(tv), enabled = true)
        assertTrue(e.permits("/ext/infrared/tv.ir", "Power"))
    }

    @Test fun `nothing is permitted by default`() {
        // Default is enrolled-nothing, allow-nothing — the day-one state must fire nothing.
        assertFalse(FlipperEnrollment().permits("/ext/infrared/tv.ir", "Power"))
    }

    @Test fun `the master switch overrides the allowlist`() {
        val e = FlipperEnrollment(okDevice(), listOf(tv), enabled = false)
        assertFalse(e.permits("/ext/infrared/tv.ir", "Power"))
    }

    @Test fun `an unacknowledged legacy device permits nothing`() {
        val d = EnrolledFlipper("aa", "f", SecurityClass.LEGACY, acknowledgedAt = 0L)
        assertFalse(FlipperEnrollment(d, listOf(tv), enabled = true).permits("/ext/infrared/tv.ir", "Power"))
    }

    @Test fun `an acknowledged legacy device is usable`() {
        // Detect-and-inform, not a hard gate — the user accepted the posture.
        val d = EnrolledFlipper("aa", "f", SecurityClass.LEGACY, acknowledgedAt = 1L)
        assertTrue(FlipperEnrollment(d, listOf(tv), enabled = true).permits("/ext/infrared/tv.ir", "Power"))
    }

    @Test fun `an unknown security class also requires acknowledgement`() {
        val d = EnrolledFlipper("aa", "f", SecurityClass.UNKNOWN, acknowledgedAt = 0L)
        assertFalse(FlipperEnrollment(d, listOf(tv), enabled = true).permits("/ext/infrared/tv.ir", "Power"))
        assertTrue(SecurityClass.UNKNOWN.needsAcknowledgement)
        assertFalse(SecurityClass.OK.needsAcknowledgement)
    }

    // -------------------------------------------- the cross-remote bypass

    @Test fun `the tuple is matched as a unit not per field`() {
        // Two independent membership checks would let this through by borrowing "Power" from tv.ir
        // and "garage.ir" from the other entry — a complete cross-remote bypass.
        val e = FlipperEnrollment(okDevice(), listOf(tv, garage), enabled = true)
        assertFalse(e.permits("/ext/infrared/garage.ir", "Power"))
        assertFalse(e.permits("/ext/infrared/tv.ir", "Open"))
        assertTrue(e.permits("/ext/infrared/tv.ir", "Power"))
        assertTrue(e.permits("/ext/infrared/garage.ir", "Open"))
    }

    @Test fun `matching is byte exact on both fields`() {
        val e = FlipperEnrollment(okDevice(), listOf(tv), enabled = true)
        assertFalse("case differs", e.permits("/ext/infrared/tv.ir", "power"))
        assertFalse("trailing space differs", e.permits("/ext/infrared/tv.ir", "Power "))
        assertFalse("path differs", e.permits("/ext/infrared/TV.ir", "Power"))
    }

    @Test fun `the label is cosmetic and not part of identity`() {
        val renamed = tv.copy(remoteLabel = "living room telly")
        assertTrue(renamed.matches("/ext/infrared/tv.ir", "Power"))
    }

    // ---------------------------------------------------------------- codec

    @Test fun `record round-trips`() {
        val e = FlipperEnrollment(okDevice(ack = 12345L), listOf(tv, garage), enabled = true)
        val back = FlipperEnrollmentCodec.decode(FlipperEnrollmentCodec.encode(e))
        assertEquals(e, back)
    }

    @Test fun `empty record round-trips`() {
        val back = FlipperEnrollmentCodec.decode(FlipperEnrollmentCodec.encode(FlipperEnrollment()))
        assertEquals(FlipperEnrollment(), back)
        assertNull(back.device)
    }

    @Test fun `null and blank decode to allow-nothing`() {
        assertEquals(FlipperEnrollment(), FlipperEnrollmentCodec.decode(null))
        assertEquals(FlipperEnrollment(), FlipperEnrollmentCodec.decode(""))
        assertEquals(FlipperEnrollment(), FlipperEnrollmentCodec.decode("   "))
    }

    @Test fun `corrupt data decodes to allow-nothing rather than throwing`() {
        val e = FlipperEnrollmentCodec.decode("!!!not base64 at all!!!")
        assertEquals(FlipperEnrollment(), e)
        assertFalse(e.permits("/ext/infrared/tv.ir", "Power"))
    }

    /** Hand-builds a record so forward/backward-compatibility can be exercised directly. */
    private fun raw(version: Int, enabled: Boolean, entries: List<Pair<String, String>>): String {
        val w = ProtoWriter().apply {
            writeUint32(1, version)
            writeBool(2, enabled)
            for ((path, button) in entries) {
                writeMessage(4, ProtoWriter().apply {
                    if (path.isNotEmpty()) writeString(1, path)
                    if (button.isNotEmpty()) writeString(4, button)
                }.toByteArray())
            }
        }.toByteArray()
        return java.util.Base64.getEncoder().encodeToString(w)
    }

    @Test fun `a record from a newer version fails closed`() {
        // Reading it partially could permit a press the user revoked in a field we cannot see.
        val future = raw(99, true, listOf("/ext/infrared/tv.ir" to "Power"))
        assertFalse(FlipperEnrollmentCodec.decode(future).permits("/ext/infrared/tv.ir", "Power"))
    }

    @Test fun `a partial allowlist entry is dropped rather than guessed`() {
        val partial = raw(1, true, listOf("/ext/infrared/tv.ir" to ""))
        assertEquals(0, FlipperEnrollmentCodec.decode(partial).allowed.size)
    }

    @Test fun `an unrecognised security ordinal decodes as unknown not ok`() {
        // A newer build's class we cannot reason about must require acknowledgement, not bypass it.
        val bytes = ProtoWriter().apply {
            writeUint32(1, 1)
            writeMessage(3, ProtoWriter().apply {
                writeString(1, "aa")
                writeEnum(3, 99) // no such SecurityClass
            }.toByteArray())
        }.toByteArray()
        val e = FlipperEnrollmentCodec.decode(java.util.Base64.getEncoder().encodeToString(bytes))
        assertEquals(SecurityClass.UNKNOWN, e.device!!.securityClass)
    }

    @Test fun `an absent security field fails closed as unknown`() {
        // Regression: SecurityClass.OK is ordinal 0 and proto3 omits zero-valued fields, so a raw
        // ordinal would drop OK on write and read back as UNKNOWN — quietly re-demanding
        // acknowledgement after every restart. Stored as ordinal + 1 for exactly this reason.
        val bytes = ProtoWriter().apply {
            writeUint32(1, 1)
            writeMessage(3, ProtoWriter().apply { writeString(1, "aa") }.toByteArray())
        }.toByteArray()
        val e = FlipperEnrollmentCodec.decode(java.util.Base64.getEncoder().encodeToString(bytes))
        assertEquals(SecurityClass.UNKNOWN, e.device!!.securityClass)
    }

    @Test fun `an OK device survives the round-trip as OK`() {
        val e = FlipperEnrollment(okDevice(ack = 0L), emptyList(), enabled = false)
        val back = FlipperEnrollmentCodec.decode(FlipperEnrollmentCodec.encode(e))
        assertEquals(SecurityClass.OK, back.device!!.securityClass)
        assertTrue("an OK device must not require acknowledgement after a restart", back.device!!.isUsable)
    }

    @Test fun `enabled defaults to false when absent`() {
        assertFalse(FlipperEnrollmentCodec.decode(raw(1, false, emptyList())).enabled)
    }

    @Test fun `an unknown future field is skipped rather than failing the record`() {
        val bytes = ProtoWriter().apply {
            writeUint32(1, 1)
            writeBool(2, true)
            writeString(77, "a field this build has never heard of")
            writeMessage(4, ProtoWriter().apply {
                writeString(1, "/ext/infrared/tv.ir")
                writeString(4, "Power")
            }.toByteArray())
        }.toByteArray()
        val e = FlipperEnrollmentCodec.decode(java.util.Base64.getEncoder().encodeToString(bytes))
        assertEquals(1, e.allowed.size)
    }

    @Test fun `button names with awkward bytes survive the round-trip`() {
        // Length-delimited fields carry these safely; a delimiter-based text format would not.
        val odd = AllowedButton("/ext/infrared/tv.ir", "tv", "sha", "Vol Up	")
        val back = FlipperEnrollmentCodec.decode(
            FlipperEnrollmentCodec.encode(FlipperEnrollment(okDevice(), listOf(odd), enabled = true)),
        )
        assertEquals(odd.button, back.allowed[0].button)
    }

    @Test fun `fingerprint survives the round-trip`() {
        // It is what detects a swapped .ir file, so losing it in serialisation would silently
        // disable staleness detection.
        val e = FlipperEnrollment(okDevice(), listOf(tv), enabled = true)
        val back = FlipperEnrollmentCodec.decode(FlipperEnrollmentCodec.encode(e))
        assertEquals("abc123", back.allowed[0].remoteSha256)
    }
}
