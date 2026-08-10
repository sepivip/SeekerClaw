package com.seekerclaw.app.flipper

import android.Manifest
import android.content.Context
import android.util.Log
import androidx.annotation.RequiresPermission
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

/** Typed outcomes. Every one carries a `reason` so nothing surfaces as a bare code (§10). */
data class FlipperError(val error: String, val reason: String)

/**
 * How a request reached us.
 *
 * ### ⚠️ Known contract gap — §4b is not implementable as written
 *
 * The contract requires this to be *"enforced bridge-side via an invocation-context value Kotlin
 * sets from the message pipeline"*. **Kotlin has no message pipeline.** Telegram polling, cron and
 * the heartbeat all live in Node (`cron.js`, driven from `main.js`); the Kotlin side sees only an
 * authenticated HTTP call on the bridge and cannot tell a user-driven turn from a scheduled one.
 *
 * So this value is supplied by Node, and Node is exactly the layer the contract distrusts —
 * `shell_exec` can run curl and `js_eval` has `require('http')`, so a sufficiently injected agent
 * can set it. Treat it as **defence in depth, not a boundary**.
 *
 * What *is* genuinely enforceable in Kotlin, and therefore also applied:
 * - the allowlist (the model cannot name anything outside it)
 * - the master switch
 * - [FlipperIrController.MAX_PRESSES_PER_HOUR], which bounds the damage a runaway or injected
 *   loop can do regardless of what it claims about its own origin
 *
 * Needs a contract amendment. Filed on BAT-1201.
 */
enum class InvocationContext {
    USER_MESSAGE,

    /** Also the fail-closed default when the field is missing or unrecognised. */
    AUTOMATED,
}

/**
 * Owns the Flipper session and enforces every rule that stands between a chat message and an
 * appliance actually changing state.
 *
 * ### Enforcement lives here, not in the prompt
 *
 * A fully prompt-injected agent must be *incapable* of exceeding the allowlist, not merely
 * instructed not to. So the allowlist check, the invocation-context check, the single-in-flight
 * mutex and the result string are all evaluated in Kotlin. The model supplies a label and a button
 * name; it never supplies a path, a tag, or a timeout.
 *
 * ### Session ownership — contract §5 R1
 *
 * `App.Exit` needs **both** gates:
 *
 * - **R1a** zero outstanding `App.*` commands. Sending one while a press is in flight double-confirms
 *   into a `furi_check` that crashes and reboots the user's device.
 * - **R1b** ownership established — a successful Infrared `App.Start` *and* the matching
 *   `APP_STARTED` observed in this session. Without it, `App.Exit` closes whatever app the user had
 *   open, from a press that never happened.
 *
 * Ownership is per-session and cleared on any link drop, so a stale cleanup path cannot exit into
 * a session it does not own.
 */
class FlipperIrController(
    private val context: Context,
    private val store: FlipperEnrollmentStore,
    private val devices: FlipperDeviceManager = FlipperDeviceManager(context),
    private val audit: FlipperAuditLog = FlipperAuditLog(context),
) {
    private companion object {
        const val TAG = "FlipperIr"

        /** Tag 75 does not exist below protobuf 0.24; §5 step 1 requires ≥ 0.25 and fails closed. */
        const val MIN_PROTOBUF_MAJOR = 0
        const val MIN_PROTOBUF_MINOR = 25

        /**
         * Total budget for a press. Must stay strictly under the timeout `tools/flipper.js` passes
         * to the bridge, or a press that succeeded reports as a transport error and the model may
         * retry — firing a toggle-coded appliance back off (§4a).
         */
        const val PRESS_DEADLINE_MS = 25_000L

        /**
         * Ceiling on presses in a rolling hour, enforced in Kotlin regardless of what the caller
         * claims about its origin.
         *
         * This is the part of §4b that is actually enforceable — see [InvocationContext]. It does
         * not stop a single injected press, but it bounds a runaway loop or a poisoned schedule to
         * something a user would notice and could switch off, rather than something that runs all
         * night. Set well above real use: channel entry is several presses in a row, and "turn the
         * volume up a lot" is inherently repeated.
         */
        const val MAX_PRESSES_PER_HOUR = 60
        const val RATE_WINDOW_MS = 3_600_000L

        /** How long to wait for the unsolicited APP_STARTED after App.Start's own response. */
        const val APP_STARTED_GRACE_MS = 3_000L
    }

    /** Timestamps of recent accepted presses, for [MAX_PRESSES_PER_HOUR]. */
    private val recentPresses = ArrayDeque<Long>()

    @Synchronized
    private fun withinRateLimit(nowMillis: Long): Boolean {
        while (recentPresses.isNotEmpty() && nowMillis - recentPresses.first() > RATE_WINDOW_MS) {
            recentPresses.removeFirst()
        }
        if (recentPresses.size >= MAX_PRESSES_PER_HOUR) return false
        recentPresses.addLast(nowMillis)
        return true
    }



    /** What the model may name. Labels and buttons only — never a path (§8). */
    fun listRemotes(): Map<String, Any?> {
        val e = store.current
        if (e.device == null) return err("not_enrolled", "No Flipper is enrolled. Open SeekerClaw settings to set one up.")
        if (!e.enabled) return err("disabled_by_user", "Flipper control is switched off in settings.")
        if (e.device.securityClass.needsAcknowledgement && e.device.acknowledgedAt == 0L) {
            return err("legacy_security", "The Flipper's firmware security notice has not been acknowledged yet. Open SeekerClaw settings.")
        }
        val remotes = e.visibleRemotes()
        if (remotes.isEmpty()) {
            return err("none_allowlisted", "No remotes have been enabled for the agent. Choose them in SeekerClaw settings.")
        }
        return mapOf(
            "remotes" to remotes.map { (label, buttons) -> mapOf("remote" to label, "buttons" to buttons) },
        )
    }

    /**
     * Fires one allowlisted button.
     *
     * Returns `sent` — never `on`, `off` or `succeeded`. `OK` on tag 75 means the signal loaded and
     * the transmit call returned; IR is one-way with no return path, so whether the appliance
     * reacted is unknowable and must never be claimed (§9).
     */
    @RequiresPermission(Manifest.permission.BLUETOOTH_CONNECT)
    suspend fun press(
        remoteLabel: String,
        button: String,
        invocation: InvocationContext,
    ): Map<String, Any?> {
        // Rejected before anything else so a poisoned turn cannot reach the hardware at all.
        // cron_create already exists, so without this one bad turn could install a schedule that
        // actuates hardware indefinitely with no user present.
        if (invocation != InvocationContext.USER_MESSAGE) {
            audit.record(remoteLabel, button, "rejected:automated", invocation)
            return err(
                "automation_not_allowed",
                "Flipper control only runs from a message you send. Scheduled and background triggers are not permitted.",
            )
        }

        val entry = store.current.resolve(remoteLabel, button)
            ?: run {
                audit.record(remoteLabel, button, "rejected:not_allowed", invocation)
                return notAllowedReason(remoteLabel, button)
            }

        // Enforced in Kotlin, so it holds whatever the caller claims about its own origin.
        if (!withinRateLimit(System.currentTimeMillis())) {
            audit.record(remoteLabel, button, "rejected:rate_limited", invocation)
            return err(
                "rate_limited",
                "Too many Flipper commands in the last hour. Nothing was sent. If you did not expect this, turn Flipper control off in SeekerClaw settings.",
            )
        }

        if (!devices.hasConnectPermission()) {
            return err("bluetooth_unavailable", "SeekerClaw does not have Bluetooth permission. Grant it in settings.")
        }
        val address = store.current.device?.address
            ?: return err("not_enrolled", "No Flipper is enrolled.")
        if (!devices.isStillBonded(address)) {
            return err("bond_lost", "The Flipper is no longer paired with this phone. Pair it again in Android settings, then re-enroll.")
        }
        val device = devices.deviceFor(address)
            ?: return err("bond_lost", "The enrolled Flipper could not be resolved. Re-enroll it in settings.")

        // Serialised: one link, one firmware pending-command slot. Never queued — telling an agent
        // to wait trains it to retry immediately against a 6-10 second sequence.
        if (!FlipperLinkLock.mutex.tryLock()) {
            return err("busy_local", "Another Flipper operation is already in progress. This one was not sent.")
        }

        // R1b needs the unsolicited APP_STARTED, which arrives outside the command/response
        // correlation. The default no-op callback silently discarded it, so ownership was being
        // inferred from App.Start's status alone — weaker than the contract states.
        var sawAppStarted = false
        val client = FlipperRpcClient(context) { frame ->
            val state = (frame.content as? RpcContent.AppStateChanged)?.state
            if (state == AppState.APP_STARTED) sawAppStarted = true
            if (state == AppState.APP_CLOSED) sawAppStarted = false
        }
        var startOk = false
        try {
            client.connect(device)

            val version = client.send(RpcRequest.ProtobufVersion, 5_000L)
                .firstNotNullOfOrNull { it.content as? RpcContent.ProtobufVersion }
                ?: return err("unsupported_protocol", "The Flipper did not report its RPC version.")
            if (!version.atLeast(MIN_PROTOBUF_MAJOR, MIN_PROTOBUF_MINOR)) {
                return err(
                    "unsupported_protocol",
                    "This Flipper's firmware is too old for one-shot button presses. Update it to use SeekerClaw.",
                )
            }

            val started = client.send(RpcRequest.StartInfraredRpc, 8_000L)
            startError(started)?.let { return it }
            startOk = true

            // §5 step 5: App.Start's response and the unsolicited APP_STARTED may arrive in either
            // order, so wait briefly for the latter if it has not landed yet.
            if (!sawAppStarted) {
                withTimeoutOrNull(APP_STARTED_GRACE_MS) {
                    while (!sawAppStarted) delay(50)
                }
            }
            if (!sawAppStarted) {
                return err(
                    "transport_error",
                    "The Flipper accepted the request but never reported its Infrared app as running.",
                )
            }

            // §8 staleness check. The fingerprint was stored when the user approved this entry;
            // without comparing it, it is dead data and a swapped .ir file with a same-named
            // button actuates a different appliance under an approval the user never gave.
            //
            // Read before LoadFile rather than after: LoadFile is one-per-session (§5 R2), so a
            // mismatch discovered afterwards could not be undone without tearing the session down.
            val readFrames = client.send(RpcRequest.StorageRead(entry.remotePath), 15_000L)
            readFrames.firstOrNull { it.status != CommandStatus.OK }?.let {
                return err(
                    "remote_missing",
                    "That remote is no longer on the Flipper. Re-scan in SeekerClaw settings.",
                )
            }
            val bytes = readFrames
                .mapNotNull { (it.content as? RpcContent.StorageRead)?.file?.data }
                .fold(ByteArray(0)) { acc, chunk -> acc + chunk }
            val actual = sha256(bytes)
            if (actual != entry.remoteSha256) {
                audit.record(remoteLabel, button, "rejected:remote_changed", invocation)
                return err(
                    "remote_changed",
                    "The \"$remoteLabel\" remote has changed on the Flipper since you approved it. " +
                        "Nothing was sent. Re-scan and re-approve it in SeekerClaw settings.",
                )
            }

            client.send(RpcRequest.LoadFile(entry.remotePath), 15_000L).let { frames ->
                frames.firstOrNull { it.status != CommandStatus.OK }?.let {
                    return err("remote_missing", "The remote file could not be loaded from the Flipper. It may have been moved or deleted.")
                }
            }

            val pressed = client.send(RpcRequest.PressRelease(entry.button), PRESS_DEADLINE_MS)
            pressed.firstOrNull { it.status != CommandStatus.OK }?.let {
                audit.record(remoteLabel, button, "failed:${it.status}", invocation)
                return err("unknown_button", "The Flipper did not recognise that button on this remote.")
            }

            audit.record(remoteLabel, button, "sent", invocation)
            return mapOf(
                "sent" to true,
                "remote" to remoteLabel,
                "button" to button,
                // Ships in-band so it survives into the model's context rather than living only in
                // a tool description it may have forgotten by round 30.
                "note" to "IR is one-way — this confirms the signal was transmitted, not that the appliance reacted.",
            )
        } catch (e: FlipperTransportException) {
            audit.record(remoteLabel, button, "error:${e.kind}", invocation)
            return transportError(e)
        } finally {
            // R1a + R1b. Exiting without ownership closes the user's own app; exiting with a
            // command outstanding crashes the device. Dropping the link is always safe.
            try {
                // R1b: both halves. App.Start succeeded AND we observed APP_STARTED in this
                // session. Without ownership, App.Exit closes whatever app the user had open.
                if (startOk && sawAppStarted && client.isConnected) client.send(RpcRequest.Exit, 3_000L)
            } catch (e: Exception) {
                Log.w(TAG, "[Flipper] exit failed, dropping link: ${e.message}")
            }
            client.close()
            FlipperLinkLock.mutex.unlock()
        }
    }

    /** Distinguishes "you never allowed this" from "you allowed it, but not that button". */
    private fun notAllowedReason(remoteLabel: String, button: String): Map<String, Any?> {
        val e = store.current
        // Check the device-level gates first. visibleRemotes() ignores them, so an unacknowledged
        // security posture would otherwise produce "'Power' is not an enabled button on 'TV'.
        // Enabled: Power." — which is both wrong and impossible to act on.
        if (e.device == null) {
            return err("not_enrolled", "No Flipper is enrolled. Open SeekerClaw settings to set one up.")
        }
        if (!e.enabled) {
            return err("disabled_by_user", "Flipper control is switched off in settings.")
        }
        if (e.device.securityClass.needsAcknowledgement && e.device.acknowledgedAt == 0L) {
            return err(
                "legacy_security",
                "The Flipper's firmware security notice has not been acknowledged yet. Open SeekerClaw settings.",
            )
        }
        val known = e.visibleRemotes()
        return when {
            known.isEmpty() ->
                err("none_allowlisted", "No remotes have been enabled for the agent. Choose them in SeekerClaw settings.")
            !known.containsKey(remoteLabel) ->
                err("not_allowed", "There is no enabled remote called \"$remoteLabel\". Enabled: ${known.keys.joinToString(", ")}.")
            else ->
                err("not_allowed", "\"$button\" is not an enabled button on \"$remoteLabel\". Enabled: ${known[remoteLabel]?.joinToString(", ")}.")
        }
    }

    private fun startError(frames: List<RpcFrame>): Map<String, Any?>? {
        val bad = frames.firstOrNull { it.status != CommandStatus.OK } ?: return null
        return when (bad.status) {
            CommandStatus.ERROR_APP_SYSTEM_LOCKED ->
                err("device_busy", "The Flipper is busy with another app. Close it on the device and try again.")
            CommandStatus.ERROR_APP_CANT_START ->
                err("ir_app_missing", "The Flipper could not start its Infrared app. Check that its SD card is inserted.")
            CommandStatus.ERROR_INVALID_PARAMETERS ->
                err("ir_app_not_found", "The Flipper does not have the Infrared app installed.")
            else ->
                err("transport_error", "The Flipper refused to start its Infrared app (${bad.status}).")
        }
    }

    private fun transportError(e: FlipperTransportException): Map<String, Any?> = when (e.kind) {
        FlipperTransportException.Kind.SERVICE_NOT_FOUND ->
            err("not_a_flipper", "That paired device does not look like a Flipper Zero.")
        FlipperTransportException.Kind.CONNECT_FAILED,
        FlipperTransportException.Kind.LINK_LOST,
        FlipperTransportException.Kind.TIMEOUT ->
            // Deliberately ambiguous: on a timeout we genuinely do not know whether the signal
            // went out, and IR power codes are toggles, so never auto-retry (§9).
            err("transport_error", "Lost contact with the Flipper. The command may or may not have been sent — check the appliance before trying again.")
        FlipperTransportException.Kind.NO_CREDIT ->
            err("busy_local", "The Flipper's receive buffer is full. Nothing was sent.")
        else ->
            err("transport_error", "Could not talk to the Flipper (${e.kind}).")
    }

    private fun err(code: String, reason: String): Map<String, Any?> =
        mapOf("error" to code, "reason" to reason)
}
