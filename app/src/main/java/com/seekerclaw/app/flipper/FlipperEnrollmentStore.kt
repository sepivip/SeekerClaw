package com.seekerclaw.app.flipper

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Persists which Flipper is enrolled and which `(remote, button)` pairs the agent may fire.
 *
 * ### Why this is deliberately not the repo's usual store shape
 *
 * Most user-settable, agent-visible settings here live in a [com.seekerclaw.app.util.CrossProcessStore]
 * file under `workDir` and reconcile back into SharedPreferences. **That shape is wrong for this
 * data.** `tools/file.js`'s `write` handler has no secrets check on its write path, and
 * `ConfigManager` reconciles `agent_settings.json` back into preferences — so a workspace-backed
 * allowlist would be an allowlist the agent could edit. Contract §3 (blocker B3) requires:
 *
 * - persisted **only** by Kotlin, **outside `workDir`**
 * - never mirrored into `agent_settings.json` or `config.json`
 * - no Node module or file path reaches it
 * - both `/flipper` bridge endpoints read/execute only, with no mutation endpoint
 *
 * Plain `MODE_PRIVATE` preferences satisfy that. The requirement is **integrity, not
 * confidentiality**, so Keystore would be over-specification — `ConfigManager` reserves that for
 * actual secrets.
 */
class FlipperEnrollmentStore(context: Context) {

    private companion object {
        /** Its own file, so nothing here can be reached by a wildcard over the app's main prefs. */
        const val PREFS_NAME = "flipper_enrollment"
        const val KEY_RECORD = "record"
    }

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private val _state = MutableStateFlow(load())

    /** Current enrollment, for the Settings UI to observe. */
    val state: StateFlow<FlipperEnrollment> = _state.asStateFlow()

    val current: FlipperEnrollment get() = _state.value

    private fun load(): FlipperEnrollment =
        FlipperEnrollmentCodec.decode(prefs.getString(KEY_RECORD, null))

    private fun persist(next: FlipperEnrollment) {
        prefs.edit().putString(KEY_RECORD, FlipperEnrollmentCodec.encode(next)).apply()
        _state.value = next
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
