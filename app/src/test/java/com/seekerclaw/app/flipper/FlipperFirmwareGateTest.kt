package com.seekerclaw.app.flipper

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Firmware-classification tests.
 *
 * The constant `"1.4.0-rc"` and the six-string allowlist come from an adversarial verification pass
 * against the pinned firmware: `git tag --contains` on the fix commit, the GitHub compare API, and
 * exhaustive content classification of `gap.c` at all 303 tags. Two traps make the obvious
 * comparison wrong in both directions, and both are pinned here.
 */
class FlipperFirmwareGateTest {

    private fun rev(version: String) = "8622f1a2 $version 0 05-12-2025"

    // ------------------------------------------------------------ the six tags

    @Test fun `every secure release classifies as OK`() {
        for (v in FlipperFirmwareGate.SECURE_VERSIONS) {
            assertEquals("$v must be OK", SecurityClass.OK, FlipperFirmwareGate.classify(rev(v)))
        }
    }

    @Test fun `the allowlist is exactly the six known releases`() {
        // 1.4.0 and 1.4.1 have never existed as tags — the line is
        // 1.4.0-rc -> 1.4.1-rc -> 1.4.2-rc -> 1.4.2 -> 1.4.3-rc -> 1.4.3.
        assertEquals(
            setOf("1.4.0-rc", "1.4.1-rc", "1.4.2-rc", "1.4.2", "1.4.3-rc", "1.4.3"),
            FlipperFirmwareGate.SECURE_VERSIONS,
        )
    }

    @Test fun `the prerelease trap does not bite`() {
        // A `>= "1.4.0"` SemVer bound would reject these two, because a prerelease sorts below its
        // release — and 1.4.0 was never published, so the bound is unsatisfiable in the right way.
        assertEquals(SecurityClass.OK, FlipperFirmwareGate.classify(rev("1.4.0-rc")))
        assertEquals(SecurityClass.OK, FlipperFirmwareGate.classify(rev("1.4.1-rc")))
    }

    @Test fun `the RC channel is not locked out`() {
        // `semver.satisfies(v, '>=1.4.0-rc')` returns false for these; a range only admits
        // prereleases sharing its exact version tuple. release-candidate currently points at 1.4.3-rc.
        assertEquals(SecurityClass.OK, FlipperFirmwareGate.classify(rev("1.4.2-rc")))
        assertEquals(SecurityClass.OK, FlipperFirmwareGate.classify(rev("1.4.3-rc")))
    }

    // --------------------------------------------------------------- legacy

    @Test fun `releases before the fix classify as legacy`() {
        for (v in listOf("1.3.4", "1.3.3", "1.2.0", "1.1.2", "1.0.1", "0.98.3")) {
            assertEquals("$v must be legacy", SecurityClass.LEGACY, FlipperFirmwareGate.classify(rev(v)))
        }
    }

    @Test fun `legacy and unknown are distinguishable in copy`() {
        // The user should hear "your firmware predates the fix", not the vaguer "we could not
        // identify it" — they send someone looking for different problems.
        val legacy = FlipperFirmwareGate.warningFor(SecurityClass.LEGACY)
        val unknown = FlipperFirmwareGate.warningFor(SecurityClass.UNKNOWN)
        assertNotNull(legacy)
        assertNotNull(unknown)
        assertTrue(legacy != unknown)
        assertNull("an OK device gets no warning", FlipperFirmwareGate.warningFor(SecurityClass.OK))
    }

    // -------------------------------------------------------------- unknown

    @Test fun `development builds are unknown not ok`() {
        for (v in listOf("dev", "HEAD", "hedger/ble_keys_migration", "release-candidate")) {
            assertEquals("$v must be unknown", SecurityClass.UNKNOWN, FlipperFirmwareGate.classify(rev(v)))
        }
    }

    @Test fun `fork tags are unknown`() {
        // Unleashed and Momentum have adopted the fix, so this over-blocks them — a deliberate,
        // accepted trade, since 0x2A28 carries no origin field and a version string is never
        // an attestation.
        for (v in listOf("unlshd-090", "mntm-012", "RM0630-0154-0.420.0-ed15916")) {
            assertEquals("$v must be unknown", SecurityClass.UNKNOWN, FlipperFirmwareGate.classify(rev(v)))
        }
    }

    @Test fun `an embedded version is never regex-extracted from a fork tag`() {
        // RogueMaster's tag contains "0.420.0". A regex hunting for x.y.z anywhere in the field
        // would pull that out and compare a fork's internal number against our allowlist. The rule
        // is "the whole field or nothing": a value not beginning with a digit is not a version, so
        // extraction yields null and classification falls to UNKNOWN.
        val forkTag = rev("RM0630-0154-0.420.0-ed15916")
        assertNull(FlipperFirmwareGate.extractVersion(forkTag))
        assertEquals(SecurityClass.UNKNOWN, FlipperFirmwareGate.classify(forkTag))

        // Contrast: a well-formed official tag extracts whole.
        assertEquals("1.4.3", FlipperFirmwareGate.extractVersion(rev("1.4.3")))
    }

    @Test fun `a future official release is unknown until classified`() {
        // Fails closed. Upstream cutting 1.5.0 should trigger a review, not silent acceptance.
        assertEquals(SecurityClass.UNKNOWN, FlipperFirmwareGate.classify(rev("1.5.0")))
    }

    // ----------------------------------------------------------- malformed

    @Test fun `wrong field count is unknown`() {
        assertEquals(SecurityClass.UNKNOWN, FlipperFirmwareGate.classify("8622f1a2 1.4.3 0"))
        assertEquals(SecurityClass.UNKNOWN, FlipperFirmwareGate.classify("8622f1a2 1.4.3 0 05-12-2025 extra"))
        assertEquals(SecurityClass.UNKNOWN, FlipperFirmwareGate.classify("1.4.3"))
    }

    @Test fun `null blank and empty are unknown`() {
        assertEquals(SecurityClass.UNKNOWN, FlipperFirmwareGate.classify(null))
        assertEquals(SecurityClass.UNKNOWN, FlipperFirmwareGate.classify(""))
        assertEquals(SecurityClass.UNKNOWN, FlipperFirmwareGate.classify("   "))
    }

    @Test fun `extraction returns the whole second field`() {
        assertEquals("1.4.3", FlipperFirmwareGate.extractVersion(rev("1.4.3")))
        assertNull(FlipperFirmwareGate.extractVersion("only two fields"))
        assertNull(FlipperFirmwareGate.extractVersion(null))
    }

    // ---------------------------------------------------------- remediation

    @Test fun `remediation names the reboot explicitly`() {
        // The forget handler does not re-init the BLE profile, so unpair-then-immediately-re-pair
        // leaves the old root keys in place with no error and no signal. Skipping the reboot makes
        // the whole remediation a no-op.
        val steps = FlipperFirmwareGate.REMEDIATION
        assertTrue(steps.any { it.contains("Restart", ignoreCase = true) })
        val unpairAt = steps.indexOfFirst { it.contains("Unpair", ignoreCase = true) }
        val rebootAt = steps.indexOfFirst { it.contains("Restart", ignoreCase = true) }
        val pairAt = steps.indexOfFirst { it.contains("Pair it", ignoreCase = true) }
        assertTrue("unpair must come before reboot", unpairAt < rebootAt)
        assertTrue("reboot must come before re-pairing", rebootAt < pairAt)
    }
}
