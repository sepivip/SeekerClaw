package com.seekerclaw.app.flipper

/**
 * Classifies a Flipper's BLE security posture from its `0x2A28` Software Revision string.
 *
 * **Informational, never a hard gate.** Codex ruled detect-and-inform on BAT-1205: a Flipper with
 * legacy root keys is compromised whether or not SeekerClaw exists, and the official Flipper app
 * does not gate on it either. The user is told and decides.
 *
 * ### Why an explicit allowlist rather than a version comparison
 *
 * The contract's verified constant is the exact string **`"1.4.0-rc"`** — the first release with
 * per-device random BLE root keys. Two traps make a naive comparison wrong:
 *
 * - **`1.4.0` has never existed as a tag.** The line runs
 *   `1.4.0-rc → 1.4.1-rc → 1.4.2-rc → 1.4.2 → 1.4.3-rc → 1.4.3`, and in SemVer a prerelease sorts
 *   *below* its release — so a `>= "1.4.0"` bound rejects the first two secure releases.
 * - **A SemVer *range* only admits prereleases sharing its exact version tuple.** `>=1.4.0-rc`
 *   excludes `1.4.1-rc`, `1.4.2-rc` and `1.4.3-rc`, silently locking out the entire RC channel.
 *
 * Six known-good strings sidestep both, need no comparator, and add no dependency. The cost is a
 * review trigger when upstream cuts a new tag — noted in the contract, and preferable to a
 * comparison that is wrong in two directions.
 *
 * Verified against flipperdevices/flipperzero-firmware@8622f1a2; fix commit `0d5beedb` (PR #4240).
 */
object FlipperFirmwareGate {

    /** Every official release containing per-device random BLE root keys, exhaustively. */
    val SECURE_VERSIONS = setOf(
        "1.4.0-rc",
        "1.4.1-rc",
        "1.4.2-rc",
        "1.4.2",
        "1.4.3-rc",
        "1.4.3",
    )

    /**
     * Official releases known to ship the hardcoded root keys.
     *
     * Listing them separately lets the UI say *"your firmware predates the fix"* rather than the
     * vaguer *"we could not identify your firmware"*, which sends users looking for the wrong
     * problem. Anything not in either set is [SecurityClass.UNKNOWN].
     */
    private val KNOWN_LEGACY_PREFIXES = listOf("0.", "1.0", "1.1", "1.2", "1.3")

    /**
     * Classifies a raw `0x2A28` value.
     *
     * Format is `<githash> <branch> <branchnum> <builddate>`, built into a 40-byte buffer. On a
     * tag-triggered CI build field 2 is the tag name verbatim, `-rc` included.
     *
     * Everything that is not positively identifiable fails closed to [SecurityClass.UNKNOWN],
     * which requires the same acknowledgement as [SecurityClass.LEGACY]. Never treated as safe.
     */
    fun classify(softwareRevision: String?): SecurityClass {
        val version = extractVersion(softwareRevision) ?: return SecurityClass.UNKNOWN
        if (version in SECURE_VERSIONS) return SecurityClass.OK
        if (KNOWN_LEGACY_PREFIXES.any { version == it || version.startsWith("$it.") || version.startsWith(it) }) {
            return SecurityClass.LEGACY
        }
        // A newer official release we have not classified yet, a fork, or something unparseable.
        return SecurityClass.UNKNOWN
    }

    /**
     * Pulls field 2 out, or null when the string is not the shape we expect.
     *
     * Requires **exactly four** space-separated fields and returns the second **whole**. Never
     * regex-extracts an embedded `x.y.z`: RogueMaster ships tags like `RM0630-0154-0.420.0-ed15916`,
     * and substring extraction would compare a fork's internal number against our allowlist.
     */
    fun extractVersion(softwareRevision: String?): String? {
        if (softwareRevision.isNullOrBlank()) return null
        val parts = softwareRevision.split(" ")
        if (parts.size != 4) return null
        val version = parts[1]
        if (version.isBlank()) return null
        // `dev`, `HEAD`, and branch paths are development builds, not releases. Treating them as
        // unclassifiable is correct — we genuinely do not know what is in them.
        if (!version.first().isDigit()) return null
        return version
    }

    /** Copy for the enrollment warning, so the UI and the audit record say the same thing. */
    fun warningFor(securityClass: SecurityClass): String? = when (securityClass) {
        SecurityClass.OK -> null
        SecurityClass.LEGACY ->
            "This Flipper's firmware predates the Bluetooth security fix. Bonds made with it use " +
                "key material shared across every unit of that firmware version. This affects any " +
                "app that connects to it, not just SeekerClaw."
        SecurityClass.UNKNOWN ->
            "SeekerClaw could not identify this Flipper's firmware version, so it cannot tell " +
                "whether its Bluetooth bond uses per-device keys. This affects any app that " +
                "connects to it, not just SeekerClaw."
    }

    /** The remediation, in the order it must be performed. The reboot is not optional. */
    val REMEDIATION = listOf(
        "Update the Flipper's firmware",
        "On the Flipper: Settings → Bluetooth → Unpair All Devices",
        "Restart the Flipper — new keys do not take effect until it reboots",
        "Pair it with this phone again in Android Settings",
    )
}
