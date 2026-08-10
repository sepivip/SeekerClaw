package com.seekerclaw.app.flipper

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.os.Build
import android.util.Log
import androidx.annotation.RequiresPermission
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import java.util.concurrent.atomic.AtomicInteger

/** Every failure mode the transport can produce, so nothing surfaces as a bare exception. */
class FlipperTransportException(val kind: Kind, message: String) : Exception(message) {
    enum class Kind {
        CONNECT_FAILED,
        SERVICE_NOT_FOUND,
        CHARACTERISTIC_NOT_FOUND,
        MTU_TOO_SMALL,
        SUBSCRIBE_FAILED,
        WRITE_FAILED,
        TIMEOUT,
        LINK_LOST,
        NOT_CONNECTED,
        DECODE_FAILED,
        NO_CREDIT,
    }
}

/**
 * BLE transport for the Flipper Zero RPC link.
 *
 * Scope is slice 1 of BAT-1202: establish a link to an already-bonded Flipper and exchange
 * `PB.Main` frames. It deliberately knows nothing about the Infrared app, allowlists, or session
 * ownership — those belong to `FlipperIrController` and its own §5 R1a/R1b gates.
 *
 * **We never initiate bonding.** Android has no public API to submit a BLE passkey, and the
 * Flipper uses Passkey Entry with the Flipper displaying the code. Enrollment happens in Android
 * Settings, in a foreground session; this class only connects to what is already bonded.
 *
 * Threading: GATT callbacks arrive on a binder thread. Nothing here blocks in a callback — each
 * one completes a deferred and returns. Callers suspend.
 */
class FlipperRpcClient(
    private val context: Context,
    private val onUnsolicited: (RpcFrame) -> Unit = {},
) : RpcTransport {
    private companion object {
        const val TAG = "FlipperRpc"

        // Per-step deadlines. Provisional — BAT-1201 §4a fixes the invariants now and the numbers
        // during slice 3, once cold-sequence latency has actually been measured on the Seeker.
        const val CONNECT_TIMEOUT_MS = 15_000L
        const val MTU_TIMEOUT_MS = 5_000L
        const val DISCOVER_TIMEOUT_MS = 10_000L
        const val SUBSCRIBE_TIMEOUT_MS = 5_000L
        const val DEFAULT_COMMAND_TIMEOUT_MS = 10_000L

        /** Standard SIG services, read directly rather than over RPC. */
        val DEVICE_INFO_SERVICE: java.util.UUID = java.util.UUID.fromString("0000180a-0000-1000-8000-00805f9b34fb")
        val SOFTWARE_REVISION: java.util.UUID = java.util.UUID.fromString("00002a28-0000-1000-8000-00805f9b34fb")
    }

    @Volatile private var gatt: BluetoothGatt? = null
    @Volatile private var rxChar: BluetoothGattCharacteristic? = null
    @Volatile private var negotiatedMtu: Int = 23 // BLE default until onMtuChanged says otherwise

    private val assembler = FrameAssembler()
    private val flowControl = FlowControl()
    private val commandIds = AtomicInteger(0)

    /** One outstanding GATT operation at a time — the stack silently drops concurrent ones. */
    private val gattLock = Mutex()

    /** One in-flight RPC command at a time; the firmware holds exactly one pending-command slot. */
    private val commandLock = Mutex()

    // Handshake steps, each completed from its callback.
    //
    // Every field below is written by one thread and read by another with no lock spanning the two:
    // the Android BLE stack delivers all callbacks on a binder thread, while `connect` and `send`
    // run on coroutine threads. `CompletableDeferred` is itself thread-safe, but the *reference* to
    // it still needs safe publication — without it a callback can observe a stale (or null) slot and
    // complete nothing, leaving the handshake to time out for no visible reason. `@Volatile` is the
    // cheapest correct fix here; these are single-writer fields, so no read-modify-write is at risk.
    @Volatile private var connectSignal: CompletableDeferred<Unit>? = null
    @Volatile private var mtuSignal: CompletableDeferred<Int>? = null
    @Volatile private var discoverSignal: CompletableDeferred<Unit>? = null
    @Volatile private var descriptorSignal: CompletableDeferred<Unit>? = null
    @Volatile private var writeSignal: CompletableDeferred<Unit>? = null
    @Volatile private var readSignal: CompletableDeferred<String?>? = null

    /**
     * The reply we are waiting for.
     *
     * A response may arrive as several frames: the firmware sets `has_next` on every frame but the
     * last, and `Storage.List` and `Storage.Read` both use it routinely. Completing on the first
     * frame would return a truncated answer and strand the remainder — so frames accumulate here
     * and the deferred completes only when `has_next` is finally false.
     */
    private class Pending(
        val commandId: Int,
        val frames: MutableList<RpcFrame> = mutableListOf(),
        val done: CompletableDeferred<List<RpcFrame>> = CompletableDeferred(),
    )

    // Written by `send` on a coroutine thread, read and mutated by `dispatch`/`failPending` on
    // the BLE binder thread. Volatile so a reply is never appended to a slot that has already been
    // cleared, and so `failPending` cannot miss a call that is genuinely outstanding.
    @Volatile private var pending: Pending? = null

    @Volatile private var connected = false

    val isConnected: Boolean get() = connected

    /** Negotiated ATT MTU. Expect 414 on stock firmware; recorded for diagnostics. */
    val mtu: Int get() = negotiatedMtu

    // ------------------------------------------------------------------ connect

    /**
     * Brings the link up in the order the firmware requires.
     *
     * `connect → requestMtu → onMtuChanged → discoverServices → write CCCDs` is mandatory, not
     * advisory: discovering before the MTU settles caches the wrong ATT sizes, and writing RPC
     * bytes before the CCCDs are in place means replies are simply never delivered.
     */
    @RequiresPermission(Manifest.permission.BLUETOOTH_CONNECT)
    suspend fun connect(device: BluetoothDevice) {
        check(gatt == null) { "already connected or connecting; call close() first" }

        connectSignal = CompletableDeferred()
        gatt = device.connectGatt(context, /* autoConnect = */ false, callback, BluetoothDevice.TRANSPORT_LE)
            ?: throw FlipperTransportException(FlipperTransportException.Kind.CONNECT_FAILED, "connectGatt returned null")

        await(connectSignal!!, CONNECT_TIMEOUT_MS, "connect")

        mtuSignal = CompletableDeferred()
        gatt!!.requestMtu(FlipperGattConfig.REQUESTED_MTU)
        negotiatedMtu = await(mtuSignal!!, MTU_TIMEOUT_MS, "requestMtu")
        if (negotiatedMtu < FlipperGattConfig.MIN_USABLE_MTU) {
            throw FlipperTransportException(
                FlipperTransportException.Kind.MTU_TOO_SMALL,
                "negotiated MTU $negotiatedMtu is below the usable floor ${FlipperGattConfig.MIN_USABLE_MTU}",
            )
        }
        Log.i(TAG, "[Flipper] negotiated MTU=$negotiatedMtu")

        discoverSignal = CompletableDeferred()
        gatt!!.discoverServices()
        await(discoverSignal!!, DISCOVER_TIMEOUT_MS, "discoverServices")

        val service = gatt!!.getService(FlipperUuids.SERVICE)
            ?: throw FlipperTransportException(
                FlipperTransportException.Kind.SERVICE_NOT_FOUND,
                "serial service ${FlipperUuids.SERVICE} absent — device is not a Flipper, or not in serial mode",
            )

        rxChar = service.getCharacteristic(FlipperUuids.RX)
            ?: throw FlipperTransportException(
                FlipperTransportException.Kind.CHARACTERISTIC_NOT_FOUND, "RX characteristic missing",
            )

        // TX is INDICATE. Subscribing as notify leaves the firmware blocked forever in
        // FuriWaitForever awaiting a confirmation the stack will never send — recoverable only by
        // physically rebooting the Flipper. This single value is the difference (BAT-1201 §4).
        subscribe(service, FlipperUuids.TX, BluetoothGattDescriptor.ENABLE_INDICATION_VALUE)
        subscribe(service, FlipperUuids.FLOW_CONTROL, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
        subscribe(service, FlipperUuids.RPC_STATUS, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)

        flowControl.reset()
        assembler.reset()
        connected = true
        Log.i(TAG, "[Flipper] link ready")
    }

    @RequiresPermission(Manifest.permission.BLUETOOTH_CONNECT)
    @SuppressLint("MissingPermission") // annotated on the public entry points
    private suspend fun subscribe(
        service: android.bluetooth.BluetoothGattService,
        uuid: java.util.UUID,
        cccdValue: ByteArray,
    ) {
        val g = gatt ?: throw FlipperTransportException(FlipperTransportException.Kind.NOT_CONNECTED, "no gatt")
        val ch = service.getCharacteristic(uuid)
            ?: throw FlipperTransportException(
                FlipperTransportException.Kind.CHARACTERISTIC_NOT_FOUND, "characteristic $uuid missing",
            )
        if (!g.setCharacteristicNotification(ch, true)) {
            throw FlipperTransportException(
                FlipperTransportException.Kind.SUBSCRIBE_FAILED, "setCharacteristicNotification failed for $uuid",
            )
        }
        val cccd = ch.getDescriptor(FlipperUuids.CCCD)
            ?: throw FlipperTransportException(
                FlipperTransportException.Kind.SUBSCRIBE_FAILED, "CCCD missing on $uuid",
            )

        gattLock.withLock {
            descriptorSignal = CompletableDeferred()
            @Suppress("DEPRECATION")
            val ok = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                g.writeDescriptor(cccd, cccdValue) == BluetoothGatt.GATT_SUCCESS
            } else {
                cccd.value = cccdValue
                g.writeDescriptor(cccd)
            }
            if (!ok) {
                throw FlipperTransportException(
                    FlipperTransportException.Kind.SUBSCRIBE_FAILED, "writeDescriptor rejected for $uuid",
                )
            }
            await(descriptorSignal!!, SUBSCRIBE_TIMEOUT_MS, "writeDescriptor($uuid)")
        }
    }

    // --------------------------------------------------------------------- send

    /**
     * Sends one command and waits for the complete reply.
     *
     * Returns **every** frame of the response, in arrival order — usually one, but `Storage.List`
     * and `Storage.Read` chunk with `has_next` and callers must see all of them. Use
     * [sendSingle] when exactly one frame is expected.
     *
     * Correlation is on command id **and** content type: an unsolicited `AppStateResponse` carries
     * uninitialised heap in `command_id`, `command_status` and `has_next`, so letting it resolve a
     * pending call would return garbage as a success (§5 R3).
     */
    @RequiresPermission(Manifest.permission.BLUETOOTH_CONNECT)
    override suspend fun send(request: RpcRequest, timeoutMs: Long): List<RpcFrame> =
        commandLock.withLock {
            if (!connected) {
                throw FlipperTransportException(FlipperTransportException.Kind.NOT_CONNECTED, "link is down")
            }
            val id = nextCommandId()
            val frame = FlipperRpc.encode(id, request)

            if (!flowControl.tryConsume(frame.size)) {
                // The device buffer is full and has not yet notified a refill. Surfacing this is
                // better than writing into a full buffer and losing the frame silently.
                throw FlipperTransportException(
                    FlipperTransportException.Kind.NO_CREDIT,
                    "device buffer full (${flowControl.available} B free, need ${frame.size} B)",
                )
            }

            val p = Pending(id)
            pending = p
            var written = 0
            try {
                for (chunk in chunkForMtu(frame, negotiatedMtu)) {
                    writeChunk(chunk)
                    written += chunk.size
                }
                return@withLock await(p.done, timeoutMs, "reply to command $id")
            } finally {
                pending = null
                // Hand back only what never reached the wire. The reservation above is taken before
                // the first write, and `onCreditNotified` is ABSOLUTE — so credit spent on a frame
                // that failed mid-write is not recovered by the next notification's arithmetic, it
                // simply stays missing until the device happens to send a refill. Repeated write
                // failures then surface as NO_CREDIT on commands the device had room for.
                //
                // Bytes that DID go out are deliberately not returned, including on a timeout: the
                // device received them and its own accounting is the truth. Over-crediting there
                // would write past the buffer this reservation exists to protect.
                val unsent = frame.size - written
                if (unsent > 0) flowControl.release(unsent)
            }
        }

    @RequiresPermission(Manifest.permission.BLUETOOTH_CONNECT)
    @SuppressLint("MissingPermission")
    private suspend fun writeChunk(chunk: ByteArray) {
        val g = gatt ?: throw FlipperTransportException(FlipperTransportException.Kind.NOT_CONNECTED, "no gatt")
        val ch = rxChar ?: throw FlipperTransportException(FlipperTransportException.Kind.NOT_CONNECTED, "no rx char")

        gattLock.withLock {
            writeSignal = CompletableDeferred()
            @Suppress("DEPRECATION")
            val ok = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                g.writeCharacteristic(ch, chunk, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) ==
                    BluetoothGatt.GATT_SUCCESS
            } else {
                ch.value = chunk
                ch.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                g.writeCharacteristic(ch)
            }
            if (!ok) {
                throw FlipperTransportException(
                    FlipperTransportException.Kind.WRITE_FAILED, "writeCharacteristic rejected (${chunk.size} B)",
                )
            }
            await(writeSignal!!, DEFAULT_COMMAND_TIMEOUT_MS, "characteristic write")
        }
    }

    /** command_id 0 is proto3's default and would not be serialised, so ids start at 1. */
    private fun nextCommandId(): Int = commandIds.updateAndGet { if (it >= Int.MAX_VALUE - 1) 1 else it + 1 }

    // ------------------------------------------------------- device information

    /**
     * Reads `0x2A28` (Software Revision) from the standard Device Information service.
     *
     * A plain GATT characteristic read, not an RPC call — so it works before the Infrared app is
     * involved and never touches the encoder allowlist. Used once at enrollment to classify the
     * BLE security posture; never exposed to the agent.
     *
     * Returns null when the service, the characteristic, or the read is unavailable. The caller
     * treats that as unclassifiable, which fails closed.
     */
    @RequiresPermission(Manifest.permission.BLUETOOTH_CONNECT)
    @SuppressLint("MissingPermission")
    suspend fun readSoftwareRevision(): String? {
        val g = gatt ?: return null
        val service = g.getService(DEVICE_INFO_SERVICE) ?: return null
        val ch = service.getCharacteristic(SOFTWARE_REVISION) ?: return null

        return gattLock.withLock {
            readSignal = CompletableDeferred()
            if (!g.readCharacteristic(ch)) return@withLock null
            try {
                await(readSignal!!, SUBSCRIBE_TIMEOUT_MS, "read 0x2A28")
            } catch (e: FlipperTransportException) {
                null
            }
        }
    }

    // -------------------------------------------------------------------- close

    /**
     * Tears the link down.
     *
     * Note this does **not** send `App.Exit` — that requires both §5 R1 gates and knowledge of
     * session ownership, which lives a layer up. Dropping the link is always safe; `App.Exit`
     * without ownership closes whatever app the user had open.
     */
    @RequiresPermission(Manifest.permission.BLUETOOTH_CONNECT)
    fun close() {
        connected = false
        pending?.done?.completeExceptionally(
            FlipperTransportException(FlipperTransportException.Kind.LINK_LOST, "client closed"),
        )
        pending = null
        try {
            gatt?.disconnect()
            gatt?.close()
        } catch (e: SecurityException) {
            Log.w(TAG, "[Flipper] close failed: ${e.message}")
        }
        gatt = null
        rxChar = null
        assembler.reset()
    }

    private suspend fun <T> await(signal: CompletableDeferred<T>, timeoutMs: Long, what: String): T =
        try {
            withTimeout(timeoutMs) { signal.await() }
        } catch (e: TimeoutCancellationException) {
            throw FlipperTransportException(FlipperTransportException.Kind.TIMEOUT, "$what timed out after ${timeoutMs}ms")
        }

    // ----------------------------------------------------------------- callbacks

    private val callback = object : BluetoothGattCallback() {

        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            when {
                newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS ->
                    connectSignal?.complete(Unit)

                newState == BluetoothProfile.STATE_DISCONNECTED -> {
                    connected = false
                    val err = FlipperTransportException(
                        FlipperTransportException.Kind.LINK_LOST, "disconnected (status=$status)",
                    )
                    connectSignal?.completeExceptionally(err)
                    pending?.done?.completeExceptionally(err)
                    pending = null
                    // Any link drop invalidates all session state (§4).
                    assembler.reset()
                }
            }
        }

        override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                mtuSignal?.complete(mtu)
            } else {
                mtuSignal?.completeExceptionally(
                    FlipperTransportException(FlipperTransportException.Kind.MTU_TOO_SMALL, "MTU request failed ($status)"),
                )
            }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                discoverSignal?.complete(Unit)
            } else {
                discoverSignal?.completeExceptionally(
                    FlipperTransportException(FlipperTransportException.Kind.SERVICE_NOT_FOUND, "discovery failed ($status)"),
                )
            }
        }

        override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                descriptorSignal?.complete(Unit)
            } else {
                descriptorSignal?.completeExceptionally(
                    FlipperTransportException(FlipperTransportException.Kind.SUBSCRIBE_FAILED, "descriptor write failed ($status)"),
                )
            }
        }

        @Deprecated("Superseded by the value-carrying overload on API 33+")
        @Suppress("DEPRECATION")
        override fun onCharacteristicRead(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
            val value = if (status == BluetoothGatt.GATT_SUCCESS) c.value else null
            readSignal?.complete(value?.toString(Charsets.UTF_8))
        }

        override fun onCharacteristicRead(
            g: BluetoothGatt,
            c: BluetoothGattCharacteristic,
            value: ByteArray,
            status: Int,
        ) {
            readSignal?.complete(
                if (status == BluetoothGatt.GATT_SUCCESS) value.toString(Charsets.UTF_8) else null,
            )
        }

        override fun onCharacteristicWrite(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                writeSignal?.complete(Unit)
            } else {
                writeSignal?.completeExceptionally(
                    FlipperTransportException(FlipperTransportException.Kind.WRITE_FAILED, "write failed ($status)"),
                )
            }
        }

        // Android 13+ delivers the value as a parameter; older versions read characteristic.value.
        override fun onCharacteristicChanged(
            g: BluetoothGatt,
            c: BluetoothGattCharacteristic,
            value: ByteArray,
        ) = handleInbound(c.uuid, value)

        @Deprecated("Superseded by the value-carrying overload on API 33+")
        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic) {
            handleInbound(c.uuid, c.value ?: return)
        }
    }

    /**
     * Callback-thread work only — parse and dispatch, never block. Anything expensive here stalls
     * the whole BLE stack for the process.
     */
    private fun handleInbound(uuid: java.util.UUID, value: ByteArray) {
        when (uuid) {
            FlipperUuids.FLOW_CONTROL -> {
                // uint32, byte-reversed on the wire. Absolute remaining credit — set, never add.
                if (value.size >= 4) {
                    val remaining = (value[0].toInt() and 0xFF) or
                        ((value[1].toInt() and 0xFF) shl 8) or
                        ((value[2].toInt() and 0xFF) shl 16) or
                        ((value[3].toInt() and 0xFF) shl 24)
                    flowControl.onCreditNotified(remaining)
                }
            }

            FlipperUuids.RPC_STATUS -> {
                // Observed only. Writing a falsy value here triggers a firmware-side BLE session
                // reset, so this characteristic is read-only to us by policy.
                Log.d(TAG, "[Flipper] rpc status notify (${value.size} B)")
            }

            FlipperUuids.TX -> {
                val frames = try {
                    assembler.append(value)
                } catch (e: ProtoDecodeException) {
                    // Reset before returning. Without this the corrupt bytes stay buffered and
                    // every subsequent indication re-throws, wedging a link that still reports
                    // connected == true — so the next press fails with no route to recovery.
                    Log.e(TAG, "[Flipper] reassembly failed, resetting buffer: ${e.message}")
                    assembler.reset()
                    failPending(FlipperTransportException.Kind.DECODE_FAILED, e.message ?: "reassembly failed")
                    return
                }
                for (body in frames) dispatch(body)
            }
        }
    }

    private fun dispatch(body: ByteArray) {
        val frame = try {
            FlipperRpc.decode(body)
        } catch (e: ProtoDecodeException) {
            // ERROR_DECODE from our side is a client framing bug and always precedes a
            // firmware-initiated disconnect. Log loudly; it is never expected traffic.
            // Reset for the same reason as above — a desynchronised stream cannot be recovered
            // by re-parsing the same bytes.
            Log.e(TAG, "[Flipper] frame decode failed, resetting buffer: ${e.message}")
            assembler.reset()
            failPending(FlipperTransportException.Kind.DECODE_FAILED, e.message ?: "decode failed")
            return
        }

        // Unsolicited frames must never retire an in-flight command, regardless of what their
        // uninitialised command_id happens to contain.
        if (frame.isUnsolicited) {
            onUnsolicited(frame)
            return
        }

        val p = pending
        if (p == null || p.commandId != frame.commandId) {
            Log.w(TAG, "[Flipper] unmatched frame id=${frame.commandId} content=${frame.content::class.simpleName}")
            return
        }

        p.frames += frame

        // `has_next` marks every frame but the last. Completing early truncates Storage.List and
        // Storage.Read; never completing would hang, so a non-OK status also ends the sequence —
        // the firmware stops sending after an error.
        if (!frame.hasNext || frame.status != CommandStatus.OK) {
            p.done.complete(p.frames.toList())
        }
    }

    private fun failPending(kind: FlipperTransportException.Kind, message: String) {
        pending?.done?.completeExceptionally(FlipperTransportException(kind, message))
        pending = null
    }
}
