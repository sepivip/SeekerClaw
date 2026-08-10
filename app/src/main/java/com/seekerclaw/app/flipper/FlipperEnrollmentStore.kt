package com.seekerclaw.app.flipper

import android.content.Context
import com.seekerclaw.app.util.CrossProcessStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/**
 * The on-disk envelope. Holds the Base64 blob produced by [FlipperEnrollmentCodec].
 *
 * A wrapper rather than a `@Serializable` mirror of the domain types, so the binary codec — with
 * its fail-closed decoding and its own tests — stays the single source of truth for what a record
 * means. `kotlinx.serialization` here only moves an opaque string between processes.
 */
@Serializable
internal data class FlipperRecord(val blob: String = "")

/**
 * Persists which Flipper is enrolled and which `(remote, button)` pairs the agent may fire.
 *
 * ### Why [CrossProcessStore] and not SharedPreferences
 *
 * The first version of this used `MODE_PRIVATE` SharedPreferences, reasoning that contract §3
 * (blocker B3) forbids storing the allowlist anywhere the agent can write. That reasoning was
 * right about the threat and wrong about the mechanism, and it produced a security control that
 * did not work:
 *
 * **The UI runs in the main process; enforcement runs in `:node`** (`SeekerClawService` declares
 * `android:process=":node"`). SharedPreferences is per-process cached and is not cross-process —
 * the repo's own [CrossProcessStore] KDoc names this exact bug class (BAT-509). So revoking a
 * button, or switching the master kill switch **off**, never reached the process that enforces it
 * until the service happened to restart. A kill switch that does not take effect is worse than no
 * kill switch, because the user believes they have stopped it.
 *
 * [CrossProcessStore] writes to `filesDir/<name>`, which is the **parent** of `workDir`
 * (`filesDir/workspace`). `safePath()` in `security.js` resolves and prefix-checks against
 * `workDir`, rejecting anything that escapes it — so this file is still outside every path
 * `tools/file.js` can reach, and is still never mirrored into `agent_settings.json` or the
 * reconcile path. B3's requirements are met; only the mechanism changed.
 */
class FlipperEnrollmentStore(context: Context) {

    private companion object {
        const val FILE_NAME = "flipper_enrollment.json"
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val cps = CrossProcessStore(
        context = context.applicationContext,
        fileName = FILE_NAME,
        serializer = FlipperRecord.serializer(),
        initial = FlipperRecord(),
        parentScope = scope,
    )

    private val _state = MutableStateFlow(FlipperEnrollmentCodec.decode(cps.state.value.blob))

    /** Current enrollment, for the Settings UI to observe. */
    val state: StateFlow<FlipperEnrollment> = _state.asStateFlow()

    init {
        // Mirror cross-process changes into the decoded view, so a revocation made in the UI
        // reaches the enforcing process without waiting for a service restart.
        scope.launch {
            cps.state.collect { record ->
                _state.value = FlipperEnrollmentCodec.decode(record.blob)
            }
        }
    }

    /**
     * The authoritative record for a permission decision.
     *
     * Reads through the store rather than the cached flow: a press must never be authorised
     * against a snapshot that predates a revocation the user just made in another process.
     */
    val current: FlipperEnrollment
        get() = FlipperEnrollmentCodec.decode(cps.state.value.blob)

    /**
     * Writes the record and publishes it.
     *
     * [_state] is set synchronously so the UI reflects a toggle immediately; the durable write is
     * dispatched to the store's own scope. The permission decision reads through [current] rather
     * than this flow, so a press can never be authorised against the optimistic value — it always
     * sees what actually landed on disk.
     */
    private fun persist(next: FlipperEnrollment) {
        val blob = FlipperEnrollmentCodec.encode(next)
        _state.value = next
        scope.launch { cps.update { FlipperRecord(blob) } }
    }

    /**
     * Records the chosen device. Enrolling a **different** device clears the allowlist — the
     * entries name paths and fingerprints on the previous Flipper and mean nothing on this one.
     */
    fun enroll(device: EnrolledFlipper) {
        val prev = current
        val sameDevice = prev.device?.address == device.address
        persist(
            FlipperEnrollment(
                device = device,
                allowed = if (sameDevice) prev.allowed else emptyList(),
                enabled = if (sameDevice) prev.enabled else false,
            ),
        )
    }

    /** Forgets everything. Used when the user unenrolls or picks a different Flipper. */
    fun clear() = persist(FlipperEnrollment())

    /** Records that the user saw and accepted a non-OK security posture. */
    fun acknowledgeSecurity(atMillis: Long) {
        val d = current.device ?: return
        persist(current.copy(device = d.copy(acknowledgedAt = atMillis)))
    }

    /**
     * Re-classifies after reading the firmware version again.
     *
     * A firmware **upgrade** can move a device from LEGACY to OK, which should clear the warning.
     * A move in the other direction — or to UNKNOWN — invalidates a previous acknowledgement,
     * because the user accepted a posture that no longer describes the device.
     */
    fun updateSecurity(securityClass: SecurityClass, firmwareVersion: String) {
        val d = current.device ?: return
        val keepAck = securityClass == d.securityClass
        persist(
            current.copy(
                device = d.copy(
                    securityClass = securityClass,
                    firmwareVersion = firmwareVersion,
                    acknowledgedAt = if (keepAck) d.acknowledgedAt else 0L,
                ),
            ),
        )
    }

    /** The master switch. Off disables every press regardless of the allowlist. */
    fun setEnabled(enabled: Boolean) = persist(current.copy(enabled = enabled))

    /**
     * Replaces the allowlist wholesale with what the user selected.
     *
     * Wholesale rather than incremental so the UI's checkbox state is always exactly what is
     * stored — an incremental API invites a partial write that leaves a button enabled the user
     * just unticked.
     */
    fun setAllowed(allowed: List<AllowedButton>) = persist(current.copy(allowed = allowed))
}
