package com.seekerclaw.app.flipper

import android.content.Context
import com.seekerclaw.app.util.CrossProcessStore
import android.util.Log
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import java.util.concurrent.atomic.AtomicInteger

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
class FlipperEnrollmentStore private constructor(context: Context) {

    companion object {
        private const val TAG = "FlipperIr"
        private const val FILE_NAME = "flipper_enrollment.json"

        @Volatile private var instance: FlipperEnrollmentStore? = null

        /**
         * The one store for this process.
         *
         * ### Why a singleton and not one per caller
         *
         * [CrossProcessStore] registers a `FileObserver` **on the parent directory** plus a
         * broadcast receiver, and filters events by basename. So every instance is another observer
         * on `filesDir`, and the repo's rule is one FileObserver per directory per process. The
         * Settings UI previously built a store per composition of the Flipper section, so each
         * visit added a pair — and the disposal path that tried to fix that could cancel a durable
         * write still in flight, which for a `setEnabled(false)` meant the user switched Flipper
         * control off, watched the toggle move, and left it on.
         *
         * A process-scoped instance removes both problems rather than balancing them, and matches
         * every other `CrossProcessStore` consumer in the app (`AgentPreferencesStore`,
         * `RuntimeStateStore`, `McpServersStore`). Both processes construct their own: the UI in
         * `main`, enforcement in `:node`.
         */
        fun get(context: Context): FlipperEnrollmentStore =
            instance ?: synchronized(this) {
                instance ?: FlipperEnrollmentStore(context.applicationContext).also { instance = it }
            }
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
        // The single consumer. Sequential by construction, so a failed write cannot stall the
        // queue behind it — each one reports its own outcome and the next proceeds.
        scope.launch {
            for (w in writes) {
                val ok = try {
                    cps.update { record ->
                        FlipperRecord(
                            FlipperEnrollmentCodec.encode(
                                w.transform(FlipperEnrollmentCodec.decode(record.blob)),
                            ),
                        )
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "[Flipper] enrollment write failed: ${e.message}")
                    false
                }
                val remaining = queued.decrementAndGet()
                // A failed write leaves [_state] holding an optimistic value that never happened.
                // Left alone, Settings would show Flipper control as off while the persisted record
                // — the one `:node` enforces against — still says enabled.
                //
                // Resynced only once the queue has drained, and only after a failure. Doing it
                // immediately would clobber the optimistic values of transforms still queued behind
                // this one, replacing a stale view with an equally wrong older one. If a later write
                // succeeds instead, the `cps.state` collector above republishes from disk anyway, so
                // this path exists for the case where the failure is the last word.
                if (!ok && remaining == 0) {
                    _state.value = FlipperEnrollmentCodec.decode(cps.state.value.blob)
                }
                w.done.complete(ok)
            }
        }
    }

    /**
     * The record a permission decision is made against.
     *
     * Reads [CrossProcessStore.state] rather than [_state]. That is the important distinction, and
     * it is not the one an earlier version of this comment claimed: `_state` carries **optimistic**
     * values, set before the durable write and possibly never persisted at all, so authorising a
     * press against it could fire on a permission that only ever existed in the UI.
     *
     * It is **not** a synchronous disk read, and does not pretend to be. `cps.state` is an
     * in-memory view refreshed from disk by a `FileObserver` and a broadcast, so a revocation made
     * in the *other* process becomes visible here after that propagates — quickly, but not
     * instantly. The mid-press re-check in `FlipperIrController` exists because of that window;
     * this property is the freshest value available without blocking, not a guarantee of currency.
     */
    val current: FlipperEnrollment
        get() = FlipperEnrollmentCodec.decode(cps.state.value.blob)

    /** One queued mutation and the handle that reports whether it reached disk. */
    private class Write(
        val transform: (FlipperEnrollment) -> FlipperEnrollment,
        val done: CompletableDeferred<Boolean>,
    )

    /**
     * Durable writes, applied strictly in the order they were requested.
     *
     * ### Why a queue and not a `Mutex`
     *
     * The first attempt guarded `cps.update` with a `Mutex`, which does not do the job. `Mutex` is
     * FIFO among *acquirers*, but a coroutine only becomes an acquirer once it has been dispatched
     * and has run as far as the lock — so two `scope.launch` calls can reach it in either order.
     * `setEnabled(true)` followed by `setEnabled(false)` could therefore persist `false` and then
     * `true`, leaving the kill switch on after the user turned it off.
     *
     * Enqueueing establishes the order at **call** time, on the caller's thread, before any
     * dispatch happens. One consumer drains it, so submission order is execution order.
     */
    private val writes = Channel<Write>(Channel.UNLIMITED)

    /** Outstanding queue depth, so the worker knows when its failure is the final state. */
    private val queued = AtomicInteger(0)

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
     * [_state] is set synchronously so the UI can reflect a toggle on the next frame instead of
     * after a disk round-trip. It is chained off its own previous value rather than off [current],
     * so a second mutation requested before the first write lands still composes correctly. The
     * permission decision reads [current], never this — an optimistic value must never authorise a
     * press.
     *
     * @return completes with `true` once the change is durable, `false` if the write failed. A
     * caller revoking access should await it before telling the user it took effect.
     */
    private fun persist(transform: (FlipperEnrollment) -> FlipperEnrollment): Deferred<Boolean> {
        // `update` and not `_state.value = transform(_state.value)`: the latter is a
        // read-modify-write, so two callers racing here lose one of the two optimistic values —
        // the same defect this whole class has been hardened against on the durable side. `update`
        // is a CAS loop, so the transforms compose.
        _state.update(transform)
        val done = CompletableDeferred<Boolean>()
        // Counted before the send so the worker can tell "I am the last one" without racing a
        // producer. UNLIMITED never suspends and never rejects, so this cannot drop a revocation;
        // the isSuccess guard covers only the post-close case, where reporting failure is correct.
        queued.incrementAndGet()
        if (!writes.trySend(Write(transform, done)).isSuccess) {
            queued.decrementAndGet()
            done.complete(false)
        }
        return done
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

    /**
     * The master switch. Off disables every press regardless of the allowlist.
     *
     * The returned handle matters for the **off** direction: the UI must not tell the user Flipper
     * control is off until the change is actually on disk, because that is the file the enforcing
     * process reads. Await it and report a failure rather than leaving a switch that looks off and
     * a Flipper that still fires.
     */
    fun setEnabled(enabled: Boolean): Deferred<Boolean> = persist { it.copy(enabled = enabled) }

    /**
     * Replaces the allowlist wholesale with what the user selected.
     *
     * Wholesale rather than incremental so the UI's checkbox state is always exactly what is
     * stored — an incremental API invites a partial write that leaves a button enabled the user
     * just unticked.
     */
    fun setAllowed(allowed: List<AllowedButton>) = persist { it.copy(allowed = allowed) }
}
