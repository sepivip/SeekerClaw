package com.seekerclaw.app.ui.settings

import android.Manifest
import android.content.Context
import androidx.annotation.RequiresPermission
import com.seekerclaw.app.flipper.AllowedButton
import com.seekerclaw.app.flipper.BluetoothUnavailable
import com.seekerclaw.app.flipper.BluetoothUnavailableException
import com.seekerclaw.app.flipper.BondedDevice
import com.seekerclaw.app.flipper.CommandStatus
import com.seekerclaw.app.flipper.EnrolledFlipper
import com.seekerclaw.app.flipper.FlipperAuditLog
import com.seekerclaw.app.flipper.FlipperDeviceManager
import com.seekerclaw.app.flipper.FlipperEnrollmentStore
import com.seekerclaw.app.flipper.FlipperFirmwareGate
import com.seekerclaw.app.flipper.FlipperLimits
import com.seekerclaw.app.flipper.FlipperLinkLock
import com.seekerclaw.app.flipper.FlipperRemoteReader
import com.seekerclaw.app.flipper.FlipperRpcClient
import com.seekerclaw.app.flipper.FlipperTransportException
import com.seekerclaw.app.flipper.RemoteDetail
import com.seekerclaw.app.flipper.SecurityClass
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** One remote and its buttons, with the user's current selection. */
data class RemoteChoice(
    val label: String,
    val path: String,
    val sha256: String,
    val buttons: List<String>,
    val selected: Set<String>,
)

/** Everything the Flipper settings section renders. */
data class FlipperUiState(
    val hasPermission: Boolean = false,
    val bonded: List<BondedDevice> = emptyList(),
    val bondedError: BluetoothUnavailable? = null,
    val enrolledAddress: String? = null,
    val enrolledLabel: String = "",
    val securityClass: SecurityClass = SecurityClass.OK,
    val securityAcknowledged: Boolean = false,
    val firmwareVersion: String = "",
    val enabled: Boolean = false,
    val remotes: List<RemoteChoice> = emptyList(),
    val busy: Boolean = false,
    val status: String? = null,
    val error: String? = null,
    /** Non-null when the last scan skipped files or hit the cap, so the UI can say so. */
    val scanNote: String? = null,
)

/**
 * Drives the Flipper section of Settings.
 *
 * Kept out of the composable so the connect-read-parse sequence is written once, in one place,
 * rather than spread across button handlers. Everything here runs in a foreground session, which is
 * the only place enrollment can happen — Android has no public API to submit a BLE passkey, so the
 * pairing itself belongs to Android Settings and this only ever works with what is already bonded.
 */
class FlipperSettingsState(private val context: Context) {

    private val store = FlipperEnrollmentStore.get(context)
    private val devices = FlipperDeviceManager(context)
    private val auditLog = FlipperAuditLog.get(context)

    private val _ui = MutableStateFlow(FlipperUiState())
    val ui: StateFlow<FlipperUiState> = _ui.asStateFlow()

    /**
     * The audit log, observable.
     *
     * Exposed as the flow rather than a snapshot because the writer is the other process — the
     * controller in `:node` records a press while this screen is open, and a value read once during
     * composition would never show it.
     */
    val auditEntries = auditLog.entries

    /** Re-reads permission state and the stored enrollment. Cheap; safe to call on every resume. */
    @RequiresPermission(Manifest.permission.BLUETOOTH_CONNECT)
    fun refresh() {
        val granted = devices.hasConnectPermission()
        var bonded = emptyList<BondedDevice>()
        var bondedError: BluetoothUnavailable? = null
        if (granted) {
            devices.bondedDevices()
                .onSuccess { bonded = it }
                .onFailure { bondedError = (it as? BluetoothUnavailableException)?.reason }
        }
        _ui.value = _ui.value.copy(
            hasPermission = granted,
            bonded = bonded,
            bondedError = bondedError,
        )
        reconcileWithStore()
    }

    /**
     * Re-derives every store-backed field of [_ui] from the authoritative record.
     *
     * Used after a failed write, in preference to restoring a snapshot captured before the attempt.
     * A snapshot is the wrong thing to restore: with several mutations in flight, an earlier failure
     * would roll the screen back over a *later* change that did land — the same overwrite-a-newer-
     * value defect the store itself was hardened against. Reconciling against `store.current`
     * cannot do that, because it shows what is actually on disk.
     *
     * The remote list itself is left alone — that comes from the last scan, not from the record.
     * Only the selection is re-derived, so the checkboxes can never drift from the enforced
     * allowlist.
     */
    private fun reconcileWithStore() {
        val e = store.current
        _ui.value = _ui.value.copy(
            enrolledAddress = e.device?.address,
            enrolledLabel = e.device?.label ?: "",
            securityClass = e.device?.securityClass ?: SecurityClass.OK,
            securityAcknowledged = (e.device?.acknowledgedAt ?: 0L) > 0L,
            firmwareVersion = e.device?.firmwareVersion ?: "",
            enabled = e.enabled,
            remotes = _ui.value.remotes.map { r ->
                r.copy(selected = e.allowed.filter { it.remotePath == r.path }.map { it.button }.toSet())
            },
        )
    }

    /**
     * Flips the master switch, and only confirms it once the change is on disk.
     *
     * The **off** direction is why this suspends. The record is what the enforcing process reads,
     * so until the write lands the switch showing off means nothing — and if the write fails, a
     * user who believes they have stopped the agent has not. On failure the switch springs back and
     * says so, which is the honest state, rather than leaving a control that lies about the device.
     *
     * The optimistic update still happens first so the toggle animates immediately; it is only the
     * *confirmation* that waits.
     */
    suspend fun setEnabled(enabled: Boolean) {
        _ui.value = _ui.value.copy(enabled = enabled, error = null)
        if (store.setEnabled(enabled).await()) return
        reconcileWithStore()
        _ui.value = _ui.value.copy(
            error = if (enabled) {
                "Could not save that change — Flipper control is still off."
            } else {
                "Could not save that change — Flipper control is still ON. Try again."
            },
        )
    }

    /**
     * Records the acknowledgement. Awaited so the UI does not claim a state it does not have.
     *
     * This one fails *safe* rather than unsafe — a lost acknowledgement leaves the agent blocked,
     * not loosed — but a screen that says "acknowledged" while every press keeps returning
     * `legacy_security` is its own kind of broken, and the user has no way to tell why.
     */
    suspend fun acknowledgeSecurity() {
        _ui.value = _ui.value.copy(securityAcknowledged = true, error = null)
        if (store.acknowledgeSecurity(System.currentTimeMillis()).await()) return
        reconcileWithStore()
        _ui.value = _ui.value.copy(error = "Could not save that. Try again.")
    }

    /**
     * Forgets the enrolled Flipper — the strongest revocation here, so it awaits durability.
     *
     * The stored record is what `:node` enforces against. If the write fails and the UI has already
     * reset, the user is told the Flipper is forgotten while the agent can still resolve and fire
     * every button on it. On failure the previous screen state is restored and the failure is named.
     */
    suspend fun unenroll() {
        val previous = _ui.value
        _ui.value = FlipperUiState(hasPermission = previous.hasPermission, bonded = previous.bonded)
        if (store.clear().await()) return
        // Put the scanned remote list back before reconciling — the clear wiped it from the view,
        // and it is scan output rather than stored state, so nothing else would restore it.
        _ui.value = _ui.value.copy(remotes = previous.remotes)
        reconcileWithStore()
        _ui.value = _ui.value.copy(
            error = "Could not forget that Flipper — it is still enrolled. Try again.",
        )
    }

    /**
     * Connects to the chosen device, classifies its firmware, and reads its remotes.
     *
     * This is the whole enrollment sequence in one call because the steps are not independently
     * useful: a device we can reach but cannot enumerate is not enrollable, and stopping halfway
     * would leave a record pointing at a Flipper we know nothing about.
     */
    @RequiresPermission(Manifest.permission.BLUETOOTH_CONNECT)
    suspend fun enrollAndScan(device: BondedDevice) {
        _ui.value = _ui.value.copy(busy = true, error = null, status = "Connecting…", scanNote = null)
        val handle = devices.deviceFor(device.address)
        if (handle == null) {
            _ui.value = _ui.value.copy(busy = false, error = "Could not resolve that device. Try pairing it again.")
            return
        }

        // Both locks, in that order — see FlipperLinkLock. This path previously took neither, so a
        // press arriving from Telegram while the user was scanning put two RPC streams on one
        // firmware command slot. The agent's press path holds the same pair, so whichever starts
        // second is cleanly refused rather than interleaved.
        if (!FlipperLinkLock.mutex.tryLock()) {
            _ui.value = _ui.value.copy(busy = false, error = "Another Flipper operation is already in progress.")
            return
        }
        val lease = FlipperLinkLock.tryAcquire(context)
        if (lease == null) {
            FlipperLinkLock.mutex.unlock()
            _ui.value = _ui.value.copy(
                busy = false,
                error = "The agent is using the Flipper right now. Try again in a moment.",
            )
            return
        }

        val client = FlipperRpcClient(context)
        try {
            client.connect(handle)

            _ui.value = _ui.value.copy(status = "Checking firmware…")
            val firmware = readFirmwareVersion(client)
            val securityClass = FlipperFirmwareGate.classify(firmware)

            _ui.value = _ui.value.copy(status = "Reading remotes…")
            val reader = FlipperRemoteReader(client)
            val listing = reader.listRemotes()

            val choices = mutableListOf<RemoteChoice>()
            var unreadable = 0
            var overlong = 0
            for (ref in listing.remotes) {
                // Only a per-file refusal may be skipped. COMMAND_FAILED means the Flipper answered
                // about *this* path — missing, denied, not a readable file — so counting it as
                // unreadable and moving on is right.
                //
                // Every other kind is session-level: a LINK_LOST or TIMEOUT partway through means
                // the remaining files were never actually examined. Swallowing those turned a lost
                // link into a scan that looked complete, and the commit below would then replace the
                // enrollment with a truncated allowlist — on a *different* device, wiping the
                // working one. Re-throwing lands in the catch below, which reports the error and
                // leaves the previous enrollment untouched.
                val detail: RemoteDetail? = try {
                    reader.readRemote(ref)
                } catch (e: FlipperTransportException) {
                    if (e.kind != FlipperTransportException.Kind.COMMAND_FAILED) throw e
                    null
                }
                if (detail == null) { unreadable++; continue }
                if (detail.isEmpty) continue

                // Never offer what the bridge would refuse. The press endpoint bounds both names at
                // FlipperLimits.MAX_NAME_CHARS, so a longer one could be scanned, shown, ticked and
                // stored — and then failed every time with `invalid_request`, before enforcement
                // ran. An approved button that can never be pressed is worse than one that was
                // never offered, so the entry is dropped here and the count is surfaced below
                // rather than being silently trimmed to fit.
                if (ref.displayName.length > FlipperLimits.MAX_NAME_CHARS) { overlong++; continue }
                val usable = detail.buttons.filter { it.length <= FlipperLimits.MAX_NAME_CHARS }
                overlong += detail.buttons.size - usable.size
                if (usable.isEmpty()) continue

                choices += RemoteChoice(
                    label = ref.displayName,
                    path = ref.path,
                    sha256 = detail.sha256,
                    buttons = usable,
                    selected = emptySet(),
                )
            }

            val notes = buildList {
                if (listing.skipped > 0) add("${listing.skipped} file(s) with non-ASCII names were skipped")
                if (listing.capped) add("only the first ${FlipperRemoteReader.MAX_FILES} files were read")
                if (unreadable > 0) add("$unreadable file(s) were not usable remotes")
                if (overlong > 0) {
                    add("$overlong name(s) longer than ${FlipperLimits.MAX_NAME_CHARS} characters were skipped")
                }
            }

            val found = disambiguate(choices)

            // ── Commit ────────────────────────────────────────────────────────
            // Nothing above this line touches the store. Enrolling before the scan meant any
            // failure after it — a LINK_LOST partway through reading remotes is the ordinary case —
            // left the record on disk anyway, contradicting the invariant in this method's KDoc.
            // Worse, enrolling a *different* Flipper clears the allowlist as part of the write, so
            // trying a second device and losing the link mid-scan destroyed the working allowlist
            // of the first and left an unscannable device enrolled in its place.
            //
            // `acknowledgedAt` is not ours to set: the store keeps an existing acknowledgement when
            // the device and its security class are both unchanged, so re-scanning for new remotes
            // does not silently revoke agent access. See FlipperEnrollmentStore.enroll.
            store.enroll(
                EnrolledFlipper(
                    address = device.address,
                    label = device.name.ifBlank { device.address },
                    securityClass = securityClass,
                    acknowledgedAt = 0L,
                    firmwareVersion = firmware,
                ),
            )

            // Intersect the stored allowlist with what this scan actually found. Without this,
            // entries for remotes the user deleted stay allowlisted and advertised to the agent
            // while disappearing from the UI — approved, invisible, and impossible to revoke.
            // A changed fingerprint drops the entry too: the approval was for those bytes.
            //
            // Read through `state` rather than `current`: the enroll above publishes to the flow
            // synchronously but its durable write is dispatched, so `current` can still return the
            // pre-enroll record here — and for a different device that is the OLD Flipper's
            // allowlist, which this filter would then write back over the cleared one.
            val allowedNow = store.state.value.allowed
            val stillValid = allowedNow.filter { a ->
                found.any { it.path == a.remotePath && it.sha256 == a.remoteSha256 && a.button in it.buttons }
            }
            val dropped = allowedNow.size - stillValid.size
            if (dropped > 0) store.setAllowed(stillValid)

            _ui.value = _ui.value.copy(
                busy = false,
                status = null,
                remotes = found,
                scanNote = (notes + listOfNotNull(
                    if (dropped > 0) "$dropped previously enabled button(s) no longer exist and were removed" else null,
                )).takeIf { it.isNotEmpty() }?.joinToString("; "),
            )
            refresh()
        } catch (e: FlipperTransportException) {
            _ui.value = _ui.value.copy(busy = false, status = null, error = describe(e))
        } catch (e: Exception) {
            _ui.value = _ui.value.copy(busy = false, status = null, error = e.message ?: "Something went wrong.")
        } finally {
            client.close()
            lease.close()
            FlipperLinkLock.mutex.unlock()
        }
    }

    /**
     * Toggles one button and writes the whole allowlist, so the stored set always matches the UI.
     *
     * Awaited in both directions. Unticking is a revocation — a checkbox that clears while the
     * stored allowlist keeps the entry tells the user they have withdrawn permission they still
     * grant. Ticking is awaited too, for the plainer reason that a checkbox which silently fails to
     * save sends them to the agent wondering why it will not press a button they can see enabled.
     */
    suspend fun toggleButton(remote: RemoteChoice, button: String, on: Boolean) {
        val updated = _ui.value.remotes.map { r ->
            if (r.path != remote.path) r
            else r.copy(selected = if (on) r.selected + button else r.selected - button)
        }
        _ui.value = _ui.value.copy(remotes = updated, error = null)
        val saved = store.setAllowed(
            updated.flatMap { r ->
                r.selected.map { AllowedButton(r.path, r.label, r.sha256, it) }
            },
        ).await()
        if (saved) return
        reconcileWithStore()
        _ui.value = _ui.value.copy(
            error = if (on) {
                "Could not enable \"$button\" — it is still off."
            } else {
                "Could not disable \"$button\" — it is still ENABLED. Try again."
            },
        )
    }

    /**
     * Reads `0x2A28` from the Device Information service.
     *
     * A plain GATT read, not an RPC call — done once at enrollment and never exposed to the agent.
     * An unreadable value classifies as UNKNOWN, which fails closed.
     */
    private suspend fun readFirmwareVersion(client: FlipperRpcClient): String =
        try {
            client.readSoftwareRevision() ?: ""
        } catch (e: Exception) {
            ""
        }

    /** Two files can share a display name; the allowlist keys on label, so make them unique. */
    private fun disambiguate(choices: List<RemoteChoice>): List<RemoteChoice> {
        val counts = choices.groupingBy { it.label }.eachCount()
        val seen = mutableMapOf<String, Int>()
        return choices.map { c ->
            if (counts[c.label] == 1) c
            else {
                val n = (seen[c.label] ?: 0) + 1
                seen[c.label] = n
                c.copy(label = "${c.label} ($n)")
            }
        }
    }

    private fun describe(e: FlipperTransportException): String = when (e.kind) {
        FlipperTransportException.Kind.SERVICE_NOT_FOUND ->
            "That device does not look like a Flipper Zero, or its Bluetooth is not in the default mode."
        FlipperTransportException.Kind.TIMEOUT ->
            "The Flipper did not respond. Check it is switched on and nearby."
        FlipperTransportException.Kind.LINK_LOST, FlipperTransportException.Kind.CONNECT_FAILED ->
            "Could not connect. Check the Flipper is on, in range, and not connected to another app."
        // The Flipper answered and refused. Naming the storage cases specifically is worth it: they
        // are by far the most common, and "could not talk to it" would send the user looking at
        // Bluetooth when the actual problem is an SD card.
        FlipperTransportException.Kind.COMMAND_FAILED -> when (e.status) {
            CommandStatus.ERROR_STORAGE_NOT_READY ->
                "The Flipper's SD card is not ready. Check it is inserted, then try again."
            CommandStatus.ERROR_STORAGE_NOT_EXIST ->
                "The Flipper has no /ext/infrared folder yet — save a remote on it first."
            else ->
                "The Flipper refused the request (${e.status ?: "unknown"})."
        }
        else -> "Could not talk to the Flipper (${e.kind})."
    }
}
