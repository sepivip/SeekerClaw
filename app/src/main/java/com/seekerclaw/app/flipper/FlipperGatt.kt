package com.seekerclaw.app.flipper

import java.util.UUID

/**
 * BLE identifiers for the Flipper Zero serial/RPC service.
 *
 * Resolved from firmware source, **not** from a scanner screenshot. The ST BLE stack stores
 * 128-bit UUIDs little-endian, so `serial_service_uuid.inc` lists them reversed; these are the
 * byte-reversed (standard big-endian) forms.
 *
 * Source: flipperdevices/flipperzero-firmware@8622f1a2 (tag 1.4.3),
 * `targets/f7/ble_glue/services/serial_service_uuid.inc`.
 *
 * This mattered: a capture from nRF Connect rendered the TX characteristic as
 * `19e82ae-…` — seven hex digits where a UUID needs eight. The true first group is `19ed82ae`.
 * Hardcoding the observed value would have failed every characteristic lookup with no clear cause.
 */
object FlipperUuids {
    val SERVICE: UUID = UUID.fromString("8fe5b3d5-2e7f-4a98-2a48-7acc60fe0000")

    /** Firmware-side "TX" — the Flipper writes, we receive. **INDICATE**, not notify. */
    val TX: UUID = UUID.fromString("19ed82ae-ed21-4c9d-4145-228e61fe0000")

    /** Firmware-side "RX" — we write, the Flipper receives. */
    val RX: UUID = UUID.fromString("19ed82ae-ed21-4c9d-4145-228e62fe0000")

    /** Remaining credit, notified only when it reaches exactly zero. */
    val FLOW_CONTROL: UUID = UUID.fromString("19ed82ae-ed21-4c9d-4145-228e63fe0000")

    /** RPC session status. Subscribed for observation; **never written** — see [RPC_STATUS]. */
    val RPC_STATUS: UUID = UUID.fromString("19ed82ae-ed21-4c9d-4145-228e64fe0000")

    /** Client Characteristic Configuration Descriptor — standard 16-bit UUID. */
    val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
}

/**
 * Names here are **device-perspective**. The firmware's "TX" is our RX and vice versa; wiring
 * from the Android side's intuition instead of the firmware's names gets the transport backwards.
 */
object FlipperGattConfig {
    /**
     * Requested ATT MTU. The device ceiling is `CFG_BLE_MAX_ATT_MTU` = 414, giving firmware
     * chunks of 411, so this will negotiate down — we ask high and use whatever we are granted.
     */
    const val REQUESTED_MTU = 517

    /**
     * Below this, something is wrong with the link and continuing would produce confusing
     * failures deeper in. Fail closed instead.
     */
    const val MIN_USABLE_MTU = 64

    /**
     * `RPC_BUFFER_SIZE` on the firmware. Flow control seeds here, decrements per byte we write,
     * and is re-notified **only** on reaching exactly zero.
     */
    const val INITIAL_CREDIT = 1024
}

/**
 * Tracks the Flipper's receive credit.
 *
 * The firmware notifies an **absolute remaining value**, not a delta. A client that adds the
 * notified number to a running total drifts, and one that never subscribes deadlocks after about
 * 1024 cumulative bytes — roughly the ninth press of a long session, well past every slice gate.
 * Hence [onCreditNotified] assigns rather than accumulates.
 */
class FlowControl(initial: Int = FlipperGattConfig.INITIAL_CREDIT) {
    private var credit: Int = initial

    /**
     * Every accessor takes the instance monitor, including the two that only read.
     *
     * The writers are genuinely different threads by construction: the FLOW_CONTROL indication is
     * delivered on the GATT callback thread, while [tryConsume] runs on whichever thread is driving
     * the write. `@Volatile` alone was not enough — it publishes a write but does not make
     * `credit -= n` atomic against a concurrent assignment, so one of the two updates is lost, and
     * both loss directions hurt:
     *
     * - **The refill is lost.** Credit stays at the post-consume value and the link stalls earlier
     *   than the firmware's buffer actually requires.
     * - **The consumption is lost.** Credit stays at the notified value after bytes were already
     *   written, so we write past what `RPC_BUFFER_SIZE` has room for — the firmware buffer overrun
     *   this class exists to prevent.
     */
    val available: Int @Synchronized get() = credit

    /** The firmware told us how much room is left. Absolute — set, never add. */
    @Synchronized
    fun onCreditNotified(remaining: Int) {
        credit = remaining.coerceAtLeast(0)
    }

    /** Reserve [n] bytes for a write we are about to make. Returns false if there is no room. */
    @Synchronized
    fun tryConsume(n: Int): Boolean {
        if (n > credit) return false
        credit -= n
        return true
    }

    /**
     * Hands [n] bytes back after a write that never happened.
     *
     * Needed because [onCreditNotified] is absolute: a reservation dropped on a failed write is not
     * recovered by the next notification's arithmetic, it simply stays missing until the firmware
     * happens to send a refill. Repeated failures otherwise surface as `NO_CREDIT` on commands the
     * device had room for. Capped at the buffer size so a double-release cannot invent credit.
     */
    @Synchronized
    fun release(n: Int) {
        credit = (credit + n).coerceAtMost(FlipperGattConfig.INITIAL_CREDIT)
    }

    /** A fresh session starts with a full buffer. */
    @Synchronized
    fun reset() {
        credit = FlipperGattConfig.INITIAL_CREDIT
    }
}

/**
 * Accumulates indication payloads and yields complete `PB_Main` frames.
 *
 * The firmware splits one frame across however many indications the negotiated MTU requires, with
 * **no per-indication framing**. So a frame may span N indications, and one indication may carry
 * the tail of one frame plus the head of the next. The only structure on the wire is the varint
 * length prefix, which is what [readDelimitedFrame] looks for.
 *
 * Not thread-safe by itself — callers must confine it to the GATT callback thread, which is also
 * why nothing here blocks.
 */
class FrameAssembler(private val maxBuffered: Int = 1 shl 20) {
    private var buf = ByteArray(0)

    /**
     * Appends [chunk] and returns every frame that is now complete, in arrival order.
     *
     * Returning a list rather than one frame matters: a single indication can complete more than
     * one frame, and dropping the extras would strand a reply forever.
     */
    fun append(chunk: ByteArray): List<ByteArray> {
        buf = if (buf.isEmpty()) chunk.copyOf() else buf + chunk
        if (buf.size > maxBuffered) {
            // A frame this large means a corrupt length prefix or a desynchronised stream.
            // Reset rather than grow without bound; the session is not recoverable anyway.
            buf = ByteArray(0)
            throw ProtoDecodeException("reassembly buffer exceeded $maxBuffered bytes")
        }

        val out = mutableListOf<ByteArray>()
        var offset = 0
        while (true) {
            val slice = readDelimitedFrame(buf, offset, buf.size) ?: break
            out += buf.copyOfRange(slice.start, slice.end)
            offset = slice.nextOffset
        }
        if (offset > 0) {
            buf = if (offset >= buf.size) ByteArray(0) else buf.copyOfRange(offset, buf.size)
        }
        return out
    }

    /** Bytes held pending more data. Exposed for diagnostics and tests, not for control flow. */
    val pending: Int get() = buf.size

    fun reset() {
        buf = ByteArray(0)
    }
}

/**
 * Splits an encoded frame into MTU-sized writes for the RX characteristic.
 *
 * ATT payload is `mtu - 3` (opcode + handle). Undersizing wastes round trips; oversizing gets the
 * write silently truncated or rejected depending on the stack, so this is derived, never assumed.
 */
fun chunkForMtu(frame: ByteArray, mtu: Int): List<ByteArray> {
    require(mtu >= FlipperGattConfig.MIN_USABLE_MTU) { "implausible MTU $mtu" }
    val payload = mtu - 3
    if (frame.size <= payload) return listOf(frame)
    val out = ArrayList<ByteArray>((frame.size + payload - 1) / payload)
    var i = 0
    while (i < frame.size) {
        val end = minOf(i + payload, frame.size)
        out += frame.copyOfRange(i, end)
        i = end
    }
    return out
}
