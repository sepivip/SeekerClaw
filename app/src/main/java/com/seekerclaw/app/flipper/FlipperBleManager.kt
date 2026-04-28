package com.seekerclaw.app.flipper

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

data class FlipperScanDevice(
    val name: String,
    val address: String,
    val rssi: Int,
    val bonded: Boolean,
)

data class FlipperConnectionStatus(
    val connected: Boolean,
    val name: String?,
    val address: String?,
    val serviceUuids: List<String>,
)

/**
 * Minimal BLE transport for user-paired Flipper Zero devices.
 *
 * This intentionally stops at scan/connect/status. Flipper RPC is protobuf-over-BLE
 * and should be layered on top once connection behavior is verified on-device.
 */
object FlipperBleManager {
    private const val DEFAULT_SCAN_TIMEOUT_MS = 8_000L
    private const val DEFAULT_CONNECT_TIMEOUT_MS = 15_000L

    private val lock = Any()
    private var gatt: BluetoothGatt? = null
    private var connectedDevice: BluetoothDevice? = null
    private var discoveredServices: List<BluetoothGattService> = emptyList()

    fun status(context: Context): FlipperConnectionStatus {
        synchronized(lock) {
            val device = connectedDevice
            return FlipperConnectionStatus(
                connected = gatt != null && device != null,
                name = device?.safeName(context),
                address = device?.address,
                serviceUuids = discoveredServices.map { it.uuid.toString() }.sorted(),
            )
        }
    }

    @SuppressLint("MissingPermission")
    fun scan(context: Context, timeoutMs: Long = DEFAULT_SCAN_TIMEOUT_MS): List<FlipperScanDevice> {
        val adapter = bluetoothManager(context).adapter
            ?: throw IllegalStateException("Bluetooth adapter unavailable")
        if (!adapter.isEnabled) throw IllegalStateException("Bluetooth is disabled")
        val scanner = adapter.bluetoothLeScanner
            ?: throw IllegalStateException("BLE scanner unavailable")

        val found = Collections.synchronizedMap(linkedMapOf<String, FlipperScanDevice>())
        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                record(result)
            }

            override fun onBatchScanResults(results: MutableList<ScanResult>) {
                results.forEach { record(it) }
            }

            private fun record(result: ScanResult) {
                val device = result.device ?: return
                val advertisedName = result.scanRecord?.deviceName
                val name = advertisedName ?: device.safeName(context) ?: return
                if (!name.contains("flipper", ignoreCase = true)) return

                found[device.address] = FlipperScanDevice(
                    name = name,
                    address = device.address,
                    rssi = result.rssi,
                    bonded = device.bondState == BluetoothDevice.BOND_BONDED,
                )
            }
        }

        scanner.startScan(callback)
        try {
            Thread.sleep(timeoutMs.coerceIn(1_000L, 30_000L))
        } finally {
            scanner.stopScan(callback)
        }

        return found.values.sortedByDescending { it.rssi }
    }

    @SuppressLint("MissingPermission")
    fun connect(context: Context, address: String?, timeoutMs: Long = DEFAULT_CONNECT_TIMEOUT_MS): FlipperConnectionStatus {
        val adapter = bluetoothManager(context).adapter
            ?: throw IllegalStateException("Bluetooth adapter unavailable")
        if (!adapter.isEnabled) throw IllegalStateException("Bluetooth is disabled")

        val targetAddress = address?.takeIf { it.isNotBlank() }
            ?: scan(context, DEFAULT_SCAN_TIMEOUT_MS).firstOrNull()?.address
            ?: throw IllegalStateException("No Flipper Zero BLE device found")

        val device = adapter.getRemoteDevice(targetAddress)
        val latch = CountDownLatch(1)
        val error = AtomicReference<String?>(null)

        synchronized(lock) {
            gatt?.close()
            gatt = null
            connectedDevice = null
            discoveredServices = emptyList()
        }

        val callback = object : BluetoothGattCallback() {
            override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    error.set("GATT connection failed with status $status")
                    latch.countDown()
                    return
                }
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    gatt.discoverServices()
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    synchronized(lock) {
                        if (this@FlipperBleManager.gatt == gatt) {
                            this@FlipperBleManager.gatt = null
                            connectedDevice = null
                            discoveredServices = emptyList()
                        }
                    }
                    latch.countDown()
                }
            }

            override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    synchronized(lock) {
                        this@FlipperBleManager.gatt = gatt
                        connectedDevice = gatt.device
                        discoveredServices = gatt.services.orEmpty()
                    }
                } else {
                    error.set("GATT service discovery failed with status $status")
                }
                latch.countDown()
            }
        }

        val newGatt = device.connectGatt(context.applicationContext, false, callback, BluetoothDevice.TRANSPORT_LE)
            ?: throw IllegalStateException("Failed to create BLE GATT connection")
        synchronized(lock) { gatt = newGatt }

        val completed = latch.await(timeoutMs.coerceIn(3_000L, 45_000L), TimeUnit.MILLISECONDS)
        if (!completed) {
            disconnect()
            throw IllegalStateException("Timed out connecting to Flipper Zero")
        }
        error.get()?.let {
            disconnect()
            throw IllegalStateException(it)
        }
        return status(context)
    }

    @SuppressLint("MissingPermission")
    fun disconnect(): FlipperConnectionStatus {
        synchronized(lock) {
            gatt?.disconnect()
            gatt?.close()
            gatt = null
            connectedDevice = null
            discoveredServices = emptyList()
        }
        return FlipperConnectionStatus(false, null, null, emptyList())
    }

    private fun bluetoothManager(context: Context): BluetoothManager =
        context.getSystemService(BluetoothManager::class.java)
            ?: throw IllegalStateException("BluetoothManager unavailable")

    private fun BluetoothDevice.safeName(context: Context): String? {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) !=
            PackageManager.PERMISSION_GRANTED) {
            return null
        }
        return try { name } catch (_: SecurityException) { null }
    }
}
