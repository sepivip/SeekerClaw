package com.seekerclaw.app.flipper


/**
 * How trustworthy the BLE bond to this Flipper is.
 *
 * Informational only — never a hard gate. A Flipper carrying legacy root keys is compromised
 * whether or not SeekerClaw exists, and the official Flipper app does not gate on it either; the
 * user is told and decides. Codex ruled detect-and-inform on BAT-1205.
 */
enum class SecurityClass {
    /** Firmware at or above the first release with per-device random BLE root keys. */
    OK,

    /** Below that release. Bonds use key material shared across every unit of that firmware. */
    LEGACY,

    /** Version missing, malformed, non-SemVer, `dev`, a branch path, or a fork tag. */
    UNKNOWN;

    /** Both non-OK states require the same explicit acknowledgement before IR control is enabled. */
    val needsAcknowledgement: Boolean get() = this != OK
}

/**
 * The Flipper the user chose, and what we know about it.
 *
 * [address] is the Android bonded-device address. It is a **transport hint**, not identity — the
 * enrollment record plus the OS bond is the identity (contract §11). The Flipper uses a public,
 * non-rotating address so this happens to be stable, but nothing should depend on that.
 */
data class EnrolledFlipper(
    val address: String,
    val label: String,
    val securityClass: SecurityClass,
    /** Epoch millis the user acknowledged a non-OK [securityClass]; 0 when never acknowledged. */
    val acknowledgedAt: Long = 0L,
    /** `0x2A28` field 2 verbatim, for diagnostics and for re-classifying after a firmware update. */
    val firmwareVersion: String = "",
) {
    /** True when IR control may run — the security posture has been seen and accepted. */
    val isUsable: Boolean get() = !securityClass.needsAcknowledgement || acknowledgedAt > 0L
}

/**
 * One `(remote, button)` pair the agent may fire.
 *
 * The tuple is matched **as a unit**. Two independent membership checks would let
 * `{remote: "Garage", button: "Power"}` pass by borrowing a button name from another remote — a
 * complete cross-remote bypass (contract §8).
 *
 * [remoteSha256] fingerprints the file's raw bytes at approval time. Names and size are not enough:
 * a user can replace a file with a different signal while preserving both, and the allowlist would
 * never notice.
 */
data class AllowedButton(
    val remotePath: String,
    val remoteLabel: String,
    val remoteSha256: String,
    val button: String,
) {
    /** Identity for matching. Deliberately excludes the label, which is cosmetic. */
    fun matches(remotePath: String, button: String): Boolean =
        this.remotePath == remotePath && this.button == button
}

/** Everything the enrollment store holds. Default is enrolled-nothing, allow-nothing. */
data class FlipperEnrollment(
    val device: EnrolledFlipper? = null,
    val allowed: List<AllowedButton> = emptyList(),
    /** User-facing master switch, independent of agent state. Default off until enrollment. */
    val enabled: Boolean = false,
) {
    /**
     * Whether a specific press is permitted.
     *
     * Every condition is checked here rather than at the call site so there is one place to audit:
     * a device enrolled, its security posture accepted, the switch on, and the exact tuple present.
     */
    fun permits(remotePath: String, button: String): Boolean =
        enabled &&
            device?.isUsable == true &&
            allowed.any { it.matches(remotePath, button) }
}

/**
 * Codec for the enrollment record.
 *
 * Serialised with the project's own protobuf primitives rather than JSON, for two reasons. First,
 * `org.json` is a non-functional stub under unit tests — `JSONObject.toString()` returns null — so
 * a JSON codec could not be round-trip tested without adding a test dependency, and this data
 * decides whether a physical action happens. Second, length-delimited fields carry arbitrary bytes
 * safely: button names may contain spaces, tabs and any byte the firmware's tokeniser preserves,
 * which a delimiter-based text format would have to escape and could get wrong.
 *
 * The wire helpers are the same ones the RPC layer uses, already covered by their own tests.
 *
 * **Forward compatibility matters here.** An older build reading a newer record must not silently
 * drop allowlist entries and then decide a press is permitted on a partial set — so anything
 * unparseable, or written by a newer version, decodes to the empty default: allow nothing.
 */
object FlipperEnrollmentCodec {

    private const val CURRENT_VERSION = 1

    // Root fields
    private const val F_VERSION = 1
    private const val F_ENABLED = 2
    private const val F_DEVICE = 3
    private const val F_ALLOWED = 4

    // Device fields
    private const val D_ADDRESS = 1
    private const val D_LABEL = 2
    private const val D_SECURITY = 3
    private const val D_ACK_AT = 4
    private const val D_FIRMWARE = 5

    // Allowed-button fields
    private const val A_PATH = 1
    private const val A_LABEL = 2
    private const val A_SHA = 3
    private const val A_BUTTON = 4

    /** Base64 so the result fits a `SharedPreferences` string. `java.util.Base64` works in tests. */
    fun encode(e: FlipperEnrollment): String {
        val root = ProtoWriter().apply {
            writeUint32(F_VERSION, CURRENT_VERSION)
            writeBool(F_ENABLED, e.enabled)
            e.device?.let { d ->
                writeMessage(
                    F_DEVICE,
                    ProtoWriter().apply {
                        writeString(D_ADDRESS, d.address)
                        writeString(D_LABEL, d.label)
                        // Stored as ordinal + 1: proto3 omits zero-valued fields, so a raw
                        // ordinal would drop OK (ordinal 0) and decode it back as UNKNOWN,
                        // silently demanding acknowledgement again after every restart. With the
                        // shift, an absent field reads as 0 -> UNKNOWN, which fails closed.
                        writeEnum(D_SECURITY, d.securityClass.ordinal + 1)
                        writeInt64(D_ACK_AT, d.acknowledgedAt)
                        writeString(D_FIRMWARE, d.firmwareVersion)
                    }.toByteArray(),
                )
            }
            for (a in e.allowed) {
                writeMessage(
                    F_ALLOWED,
                    ProtoWriter().apply {
                        writeString(A_PATH, a.remotePath)
                        writeString(A_LABEL, a.remoteLabel)
                        writeString(A_SHA, a.remoteSha256)
                        writeString(A_BUTTON, a.button)
                    }.toByteArray(),
                )
            }
        }.toByteArray()
        return java.util.Base64.getEncoder().encodeToString(root)
    }

    fun decode(encoded: String?): FlipperEnrollment {
        if (encoded.isNullOrBlank()) return FlipperEnrollment()
        return try {
            val bytes = java.util.Base64.getDecoder().decode(encoded.trim())
            var version = 0
            var enabled = false
            var device: EnrolledFlipper? = null
            val allowed = mutableListOf<AllowedButton>()

            val r = ProtoReader(bytes)
            while (r.hasMore) {
                val tag = r.readTag()
                when (ProtoReader.fieldOf(tag)) {
                    F_VERSION -> version = r.readUint32()
                    F_ENABLED -> enabled = r.readBool()
                    F_DEVICE -> device = decodeDevice(r.readMessage())
                    F_ALLOWED -> decodeAllowed(r.readMessage())?.let { allowed += it }
                    else -> r.skipField(tag)
                }
            }

            if (version > CURRENT_VERSION) {
                // Written by a newer build. Reading it partially could permit a press the user
                // revoked in a field we cannot see, so fail closed.
                return FlipperEnrollment()
            }
            FlipperEnrollment(device, allowed, enabled)
        } catch (e: Exception) {
            // Corrupt record: allow nothing. Never fall back to a permissive default.
            FlipperEnrollment()
        }
    }

    private fun decodeDevice(r: ProtoReader): EnrolledFlipper {
        var address = ""
        var label = ""
        var security = SecurityClass.UNKNOWN
        var ackAt = 0L
        var firmware = ""
        while (r.hasMore) {
            val tag = r.readTag()
            when (ProtoReader.fieldOf(tag)) {
                D_ADDRESS -> address = r.readString()
                D_LABEL -> label = r.readString()
                // An ordinal we do not recognise is a newer class we cannot reason about — treat
                // it as UNKNOWN, which requires acknowledgement, rather than as OK.
                D_SECURITY -> security = SecurityClass.entries.getOrNull(r.readEnum() - 1) ?: SecurityClass.UNKNOWN
                D_ACK_AT -> ackAt = r.readVarint()
                D_FIRMWARE -> firmware = r.readString()
                else -> r.skipField(tag)
            }
        }
        return EnrolledFlipper(address, label, security, ackAt, firmware)
    }

    /** Returns null for a partial entry — it cannot be matched safely, so it is dropped. */
    private fun decodeAllowed(r: ProtoReader): AllowedButton? {
        var path = ""
        var label = ""
        var sha = ""
        var button = ""
        while (r.hasMore) {
            val tag = r.readTag()
            when (ProtoReader.fieldOf(tag)) {
                A_PATH -> path = r.readString()
                A_LABEL -> label = r.readString()
                A_SHA -> sha = r.readString()
                A_BUTTON -> button = r.readString()
                else -> r.skipField(tag)
            }
        }
        if (path.isEmpty() || button.isEmpty()) return null
        return AllowedButton(path, label, sha, button)
    }
}
