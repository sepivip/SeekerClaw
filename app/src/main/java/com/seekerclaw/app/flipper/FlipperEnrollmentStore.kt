package com.seekerclaw.app.flipper

import android.content.Context
import com.seekerclaw.app.util.CrossProcessStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.cancel
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
     * Applies [transform] to the record and publishes the result.
     *
     * ### Every mutation is a transform, never a pre-computed record
     *
     * Taking a finished `FlipperEnrollment` looks simpler and is wrong. [CrossProcessStore.update]
     * applies its lambda to the state it re-reads under its own write lock; passing a value
     * computed earlier discards whatever landed in between, so two mutations that overlap lose one
     * of the two. That matters more here than in most stores because the losable field can be the
     * master switch or the allowlist — a `setEnabled(false)` silently reverted by a concurrent
     * `setAllowed` is a kill switch that did not kill anything.
     *
     * It also removes a sharper failure: reading `current` to build the next value and reading it
     * again inside the same method gave two different snapshots. Unenrolling between those reads
     * let `acknowledgeSecurity` write the old device back over a cleared record, resurrecting an
     * unenrolled Flipper. A transform sees one snapshot by construction, so the `?: return it`
     * guards below cannot be raced.
     *
     * [_state] is still set synchronously, so the UI reflects a toggle on the next frame instead of
     * after a disk round-trip. It is chained off its own previous value rather than off [current],
     * so a second mutation dispatched before the first write lands still composes correctly. The
     * permission decision reads [current], never this — an optimistic value must never authorise a
     * press.
     */
    private fun persist(transform: (FlipperEnrollment) -> FlipperEnrollment) {
        _state.value = transform(_state.value)
        scope.launch {
            cps.update { record ->
                FlipperRecord(FlipperEnrollmentCodec.encode(transform(FlipperEnrollmentCodec.decode(record.blob))))
            }
        }
    }

    /**
     * Records the chosen device.
     *
     * The rules — a different Flipper clears the allowlist, an acknowledgement survives a re-scan
     * at an unchanged posture — live in [FlipperEnrollment.withEnrolled], which is pure and
     * therefore directly testable. This method is only the read-modify-write around them.
     */
    fun enroll(device: EnrolledFlipper) = persist { it.withEnrolled(device) }

    /** Forgets everything. Used when the user unenrolls or picks a different Flipper. */
    fun clear() = persist { FlipperEnrollment() }

    /** Records that the user saw and accepted a non-OK security posture. */
    fun acknowledgeSecurity(atMillis: Long) = persist {
        val d = it.device ?: return@persist it
        it.copy(device = d.copy(acknowledgedAt = atMillis))
    }

    /**
     * Re-classifies after reading the firmware version again.
     *
     * A firmware **upgrade** can move a device from LEGACY to OK, which should clear the warning.
     * A move in the other direction — or to UNKNOWN — invalidates a previous acknowledgement,
     * because the user accepted a posture that no longer describes the device.
     */
    fun updateSecurity(securityClass: SecurityClass, firmwareVersion: String) = persist {
        val d = it.device ?: return@persist it
        val keepAck = securityClass == d.securityClass
        it.copy(
            device = d.copy(
                securityClass = securityClass,
                firmwareVersion = firmwareVersion,
                acknowledgedAt = if (keepAck) d.acknowledgedAt else 0L,
            ),
        )
    }

    /** The master switch. Off disables every press regardless of the allowlist. */
    fun setEnabled(enabled: Boolean) = persist { it.copy(enabled = enabled) }

    /**
     * Replaces the allowlist wholesale with what the user selected.
     *
     * Wholesale rather than incremental so the UI's checkbox state is always exactly what is
     * stored — an incremental API invites a partial write that leaves a button enabled the user
     * just unticked.
     */
    fun setAllowed(allowed: List<AllowedButton>) = persist { it.copy(allowed = allowed) }

    /**
     * Releases the store's FileObserver, broadcast receiver and drain coroutine.
     *
     * Each instance registers OS-level observers, and the Settings UI builds one per composition of
     * the Flipper section — so without this, every visit to Settings leaves another observer
     * waking the process for a record nobody reads.
     */
    fun close() {
        cps.close()
        scope.cancel()
    }
}
