package com.seekerclaw.app.flipper

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.pm.PackageManager
import androidx.annotation.RequiresPermission
import androidx.core.content.ContextCompat

/** A device already paired in Android Settings, as offered to the user during enrollment. */
data class BondedDevice(
    val address: String,
    val name: String,
    /** Heuristic only — it sorts the list. Identity comes from the post-connect service check. */
    val looksLikeFlipper: Boolean,
)

/** Why the bonded list could not be produced. Each maps to distinct user-facing copy. */
enum class BluetoothUnavailable { NO_ADAPTER, DISABLED, PERMISSION_DENIED }

/**
 * Enumerates bonded devices for the enrollment picker.
 *
 * **This never scans.** The user pairs their Flipper in Android Settings and we read the OS bond
 * list, so the app holds `BLUETOOTH_CONNECT` alone and never builds a nearby-device inventory
 * (contract §4). Pairing itself is not ours to do either: the Flipper uses Passkey Entry with the
 * code shown on its own screen, and Android exposes no public API to submit a passkey.
 *
 * The name prefix is a **sorting hint, not identification**. Names come from the Flipper's OTP and
 * are not user-editable on stock firmware, but third-party firmware can change them freely, and
 * any device can call itself whatever it likes. Real identification is the expected-service check
 * after connecting, which [FlipperRpcClient.connect] performs.
 */
class FlipperDeviceManager(private val context: Context) {

    private companion object {
        /** Stock firmware advertises `Flipper <name>`, with the suffix burned at the factory. */
        const val NAME_PREFIX = "Flipper "
    }

    private val adapter: BluetoothAdapter?
        get() = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

    fun hasConnectPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) ==
            PackageManager.PERMISSION_GRANTED

    /**
     * The bonded devices, Flipper-shaped ones first.
     *
     * Returns [Result.failure] carrying a [BluetoothUnavailable] rather than an empty list — "no
     * paired devices" and "Bluetooth is off" need different things said to the user, and collapsing
     * them sends someone hunting for a pairing problem that does not exist.
     */
    @RequiresPermission(Manifest.permission.BLUETOOTH_CONNECT)
    fun bondedDevices(): Result<List<BondedDevice>> {
        if (!hasConnectPermission()) {
            return Result.failure(BluetoothUnavailableException(BluetoothUnavailable.PERMISSION_DENIED))
        }
        val a = adapter ?: return Result.failure(BluetoothUnavailableException(BluetoothUnavailable.NO_ADAPTER))
        if (!a.isEnabled) {
            return Result.failure(BluetoothUnavailableException(BluetoothUnavailable.DISABLED))
        }

        val bonded = try {
            a.bondedDevices ?: emptySet()
        } catch (e: SecurityException) {
            // Permission can be revoked between the check above and the call.
            return Result.failure(BluetoothUnavailableException(BluetoothUnavailable.PERMISSION_DENIED))
        }

        val devices = bonded.map { d ->
            val name = try { d.name } catch (e: SecurityException) { null } ?: ""
            BondedDevice(d.address, name, looksLikeFlipper(name))
        }
        // Flipper-shaped first, then alphabetical — the user's device should be at the top without
        // hiding anything, since the prefix is only a hint.
        return Result.success(devices.sortedWith(compareByDescending<BondedDevice> { it.looksLikeFlipper }.thenBy { it.name }))
    }

    /** Resolves an enrolled address back to a connectable handle. */
    @RequiresPermission(Manifest.permission.BLUETOOTH_CONNECT)
    fun deviceFor(address: String): BluetoothDevice? =
        try {
            adapter?.getRemoteDevice(address)
        } catch (e: IllegalArgumentException) {
            null // malformed address in a stored record
        }

    /** True when the address is still in the OS bond list — a cleared bond invalidates enrollment. */
    @RequiresPermission(Manifest.permission.BLUETOOTH_CONNECT)
    fun isStillBonded(address: String): Boolean =
        bondedDevices().getOrNull()?.any { it.address == address } == true

    /** Exposed so the same rule is testable and used in exactly one place. */
    fun looksLikeFlipper(name: String?): Boolean = name?.startsWith(NAME_PREFIX) == true
}

/** Carries the reason so the UI can say something specific rather than "Bluetooth error". */
class BluetoothUnavailableException(val reason: BluetoothUnavailable) :
    Exception("bluetooth unavailable: $reason")
