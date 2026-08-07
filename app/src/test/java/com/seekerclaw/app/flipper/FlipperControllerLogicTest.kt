package com.seekerclaw.app.flipper

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Resolution and audit-record tests.
 *
 * The press path itself needs a BLE stack, but the decisions *around* it — what the model is
 * allowed to name, what it can never name, and what gets written down — are pure and belong under
 * test. These are the rules a prompt-injected agent would be trying to get past.
 */
class FlipperControllerLogicTest {

    private val tv = AllowedButton("/ext/infrared/tv.ir", "tv", "sha-tv", "Power")
    private val tvVol = AllowedButton("/ext/infrared/tv.ir", "tv", "sha-tv", "Vol_up")
    private val garage = AllowedButton("/ext/infrared/garage.ir", "garage", "sha-g", "Open")

    private fun enrolled(vararg allowed: AllowedButton, enabled: Boolean = true) =
        FlipperEnrollment(
            EnrolledFlipper("80:E1:26:12:B7:E1", "Flipper Oytia", SecurityClass.OK, 0L, "1.4.3"),
            allowed.toList(),
            enabled,
        )

    // ------------------------------------------------------------- resolution

    @Test fun `the model names a label and gets back a path it never supplied`() {
        // "Never accept a path from the model" is only meaningful if the path comes from the store.
        val e = enrolled(tv)
        assertEquals("/ext/infrared/tv.ir", e.resolve("tv", "Power")?.remotePath)
    }

    @Test fun `an unknown label resolves to nothing`() {
        assertNull(enrolled(tv).resolve("garage", "Power"))
    }

    @Test fun `a known label with an unknown button resolves to nothing`() {
        assertNull(enrolled(tv).resolve("tv", "Mute"))
    }

    @Test fun `a button from another remote cannot be grafted on`() {
        // The cross-remote bypass, at the resolution layer this time: "Open" exists, "garage"
        // exists, but not together.
        val e = enrolled(tv, garage)
        assertNull(e.resolve("tv", "Open"))
        assertNull(e.resolve("garage", "Power"))
        assertNotNull(e.resolve("tv", "Power"))
        assertNotNull(e.resolve("garage", "Open"))
    }

    @Test fun `resolution is byte exact`() {
        val e = enrolled(tv)
        assertNull("case", e.resolve("TV", "Power"))
        assertNull("trailing space", e.resolve("tv", "Power "))
        assertNotNull(e.resolve("tv", "Power"))
    }

    @Test fun `the master switch blocks resolution entirely`() {
        assertNull(enrolled(tv, enabled = false).resolve("tv", "Power"))
    }

    @Test fun `an unacknowledged legacy device blocks resolution`() {
        val e = FlipperEnrollment(
            EnrolledFlipper("aa", "f", SecurityClass.LEGACY, acknowledgedAt = 0L),
            listOf(tv),
            enabled = true,
        )
        assertNull(e.resolve("tv", "Power"))
    }

    // ------------------------------------------------------- what is exposed

    @Test fun `the listing groups buttons under their remote and hides paths`() {
        val visible = enrolled(tv, tvVol, garage).visibleRemotes()
        assertEquals(setOf("tv", "garage"), visible.keys)
        assertEquals(listOf("Power", "Vol_up"), visible["tv"])
        // The model never sees a filesystem path — nothing in the exposed structure carries one.
        assertFalse(visible.toString().contains("/ext/infrared"))
    }

    @Test fun `nothing allowlisted exposes nothing`() {
        assertTrue(enrolled().visibleRemotes().isEmpty())
    }

    // ------------------------------------------------------------ audit codec

    @Test fun `audit entries round-trip`() {
        val entries = listOf(
            AuditEntry(1_700_000_000_000L, "tv", "Power", "sent", InvocationContext.USER_MESSAGE),
            AuditEntry(1_700_000_001_000L, "garage", "Open", "rejected:not_allowed", InvocationContext.AUTOMATED),
        )
        assertEquals(entries, FlipperAuditCodec.decode(FlipperAuditCodec.encode(entries)))
    }

    @Test fun `user-message invocation survives the round-trip`() {
        // USER_MESSAGE is ordinal 0; proto3 omits zero values, so a raw ordinal would read back as
        // AUTOMATED and misattribute a legitimate press in the record.
        val one = listOf(AuditEntry(1L, "tv", "Power", "sent", InvocationContext.USER_MESSAGE))
        assertEquals(InvocationContext.USER_MESSAGE, FlipperAuditCodec.decode(FlipperAuditCodec.encode(one))[0].invocation)
    }

    @Test fun `a corrupt audit log decodes to empty rather than throwing`() {
        // A damaged log must never be a reason a press fails.
        assertTrue(FlipperAuditCodec.decode("!!!not base64!!!").isEmpty())
        assertTrue(FlipperAuditCodec.decode(null).isEmpty())
    }

    @Test fun `timestamps format without throwing`() {
        assertTrue(AuditEntry(1_700_000_000_000L, "tv", "Power", "sent", InvocationContext.USER_MESSAGE)
            .formattedTime().startsWith("20"))
    }
}
