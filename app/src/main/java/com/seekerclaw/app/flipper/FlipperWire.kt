package com.seekerclaw.app.flipper

/**
 * Minimal protobuf wire-format codec for the Flipper Zero RPC link.
 *
 * Deliberately hand-written rather than generated. The contract (BAT-1201 §7) requires the
 * encoder to be *incapable* of emitting any command outside an eight-tag allowlist — "an absent
 * capability, not a filtered one". Generated code would define all ~75 `Main.content` fields and
 * reduce that guarantee to a runtime check somebody has to remember to apply. Here the other
 * sixty-seven simply do not exist.
 *
 * Scope is only what the Flipper actually sends and receives on this link: varints, length-
 * delimited fields, and enough of the other two wire types to *skip* them safely. There is no
 * support for packed repeated fields, groups, or zigzag ints because nothing in the message set
 * uses them; adding one later is a deliberate act, not an accident.
 *
 * Field numbers verified against flipperdevices/flipperzero-protobuf@1c84fa48 (tag 0.25), the
 * exact schema on the pinned firmware. Not vendored — cited, so it is obvious nothing here is
 * generated or compiled from a .proto.
 */

/** Thrown on any malformed input. Always fail closed; never guess at a truncated frame. */
class ProtoDecodeException(message: String) : Exception(message)

internal object WireType {
    const val VARINT = 0
    const val FIXED64 = 1
    const val LENGTH_DELIMITED = 2
    const val START_GROUP = 3 // deprecated in proto3; we reject rather than skip
    const val END_GROUP = 4 // deprecated in proto3; we reject rather than skip
    const val FIXED32 = 5
}

/**
 * Varints are little-endian base-128 with a continuation bit. Protobuf caps them at ten bytes
 * (64 bits + continuation overhead); anything longer is corrupt, not merely large.
 */
private const val MAX_VARINT_BYTES = 10

/** Guards against a corrupt length prefix asking us to allocate an absurd buffer. */
private const val MAX_FIELD_BYTES = 1 shl 20

class ProtoWriter {
    private val buf = java.io.ByteArrayOutputStream(64)

    fun toByteArray(): ByteArray = buf.toByteArray()

    val size: Int get() = buf.size()

    fun writeVarint(value: Long) {
        var v = value
        // Kotlin has no unsigned shift on the signed path we want, so mask explicitly.
        while (true) {
            val bits = (v and 0x7FL).toInt()
            v = v ushr 7
            if (v == 0L) {
                buf.write(bits)
                return
            }
            buf.write(bits or 0x80)
        }
    }

    fun writeTag(fieldNumber: Int, wireType: Int) {
        require(fieldNumber > 0) { "field number must be positive, got $fieldNumber" }
        writeVarint(((fieldNumber.toLong() shl 3) or wireType.toLong()))
    }

    fun writeUint32(fieldNumber: Int, value: Int) {
        if (value == 0) return // proto3: default values are not serialised
        writeTag(fieldNumber, WireType.VARINT)
        writeVarint(value.toLong() and 0xFFFFFFFFL)
    }

    fun writeEnum(fieldNumber: Int, value: Int) {
        if (value == 0) return
        writeTag(fieldNumber, WireType.VARINT)
        writeVarint(value.toLong())
    }

    /** 64-bit varint field, for timestamps. Negative values are not expected and not supported. */
    fun writeInt64(fieldNumber: Int, value: Long) {
        if (value == 0L) return
        require(value > 0L) { "negative int64 not supported (field $fieldNumber, value $value)" }
        writeTag(fieldNumber, WireType.VARINT)
        writeVarint(value)
    }

    fun writeBool(fieldNumber: Int, value: Boolean) {
        if (!value) return
        writeTag(fieldNumber, WireType.VARINT)
        writeVarint(1L)
    }

    fun writeBytes(fieldNumber: Int, value: ByteArray) {
        if (value.isEmpty()) return
        writeTag(fieldNumber, WireType.LENGTH_DELIMITED)
        writeVarint(value.size.toLong())
        buf.write(value, 0, value.size)
    }

    /**
     * Strings go out as UTF-8. Note the Flipper compares button names with `strcmp` over bytes it
     * tokenised itself, so callers must hand us the exact parsed bytes — see BAT-1201 §6 G4.
     */
    fun writeString(fieldNumber: Int, value: String) {
        if (value.isEmpty()) return
        writeBytes(fieldNumber, value.toByteArray(Charsets.UTF_8))
    }

    /** Writes a nested message, always emitted even when empty — `Empty` bodies carry meaning. */
    fun writeMessage(fieldNumber: Int, body: ByteArray) {
        writeTag(fieldNumber, WireType.LENGTH_DELIMITED)
        writeVarint(body.size.toLong())
        buf.write(body, 0, body.size)
    }
}

class ProtoReader(private val src: ByteArray, private var pos: Int = 0, private val end: Int = src.size) {

    val hasMore: Boolean get() = pos < end

    val position: Int get() = pos

    private fun require(n: Int) {
        if (pos + n > end) {
            throw ProtoDecodeException("truncated: need $n byte(s) at offset $pos, limit $end")
        }
    }

    fun readVarint(): Long {
        var result = 0L
        var shift = 0
        var consumed = 0
        while (true) {
            require(1)
            val b = src[pos++].toInt() and 0xFF
            consumed++
            if (consumed > MAX_VARINT_BYTES) {
                throw ProtoDecodeException("varint longer than $MAX_VARINT_BYTES bytes at offset $pos")
            }
            result = result or ((b and 0x7F).toLong() shl shift)
            if (b and 0x80 == 0) return result
            shift += 7
        }
    }

    /** Returns the raw tag. Callers derive field number and wire type via [fieldOf] / [wireTypeOf]. */
    fun readTag(): Int {
        val tag = readVarint()
        if (tag == 0L || tag > Int.MAX_VALUE) {
            throw ProtoDecodeException("invalid tag $tag at offset $pos")
        }
        val t = tag.toInt()
        if (fieldOf(t) == 0) throw ProtoDecodeException("field number 0 is not valid at offset $pos")
        return t
    }

    fun readBool(): Boolean = readVarint() != 0L

    fun readUint32(): Int = (readVarint() and 0xFFFFFFFFL).toInt()

    fun readEnum(): Int = readVarint().toInt()

    fun readBytes(): ByteArray {
        val len = readVarint()
        if (len < 0 || len > MAX_FIELD_BYTES) {
            throw ProtoDecodeException("implausible field length $len at offset $pos")
        }
        val n = len.toInt()
        require(n)
        val out = src.copyOfRange(pos, pos + n)
        pos += n
        return out
    }

    fun readString(): String = String(readBytes(), Charsets.UTF_8)

    /** Returns a reader scoped to a nested message, and advances this reader past it. */
    fun readMessage(): ProtoReader {
        val len = readVarint()
        if (len < 0 || len > MAX_FIELD_BYTES) {
            throw ProtoDecodeException("implausible message length $len at offset $pos")
        }
        val n = len.toInt()
        require(n)
        val sub = ProtoReader(src, pos, pos + n)
        pos += n
        return sub
    }

    /**
     * Skips a field we do not handle.
     *
     * This is the load-bearing half of the decoder. The `Main.content` oneof has ~75 members and
     * we deliberately implement about ten; everything else must pass through without disturbing
     * the read position. Unknown *field numbers* are ordinary and expected. Unknown *wire types*
     * are not — those mean the stream is corrupt or desynchronised, so we fail rather than
     * resynchronise on a guess.
     */
    fun skipField(tag: Int) {
        when (wireTypeOf(tag)) {
            WireType.VARINT -> readVarint()
            WireType.FIXED64 -> { require(8); pos += 8 }
            WireType.LENGTH_DELIMITED -> readBytes()
            WireType.FIXED32 -> { require(4); pos += 4 }
            WireType.START_GROUP, WireType.END_GROUP ->
                throw ProtoDecodeException("groups are not supported (tag $tag at offset $pos)")
            else -> throw ProtoDecodeException("unknown wire type ${wireTypeOf(tag)} at offset $pos")
        }
    }

    companion object {
        fun fieldOf(tag: Int): Int = tag ushr 3
        fun wireTypeOf(tag: Int): Int = tag and 0x07
    }
}

/**
 * Reads a single varint-length-delimited frame out of [buf] starting at [offset].
 *
 * The Flipper splits one `PB_Main` across however many BLE indications it takes, with no
 * per-indication framing — so the transport appends every payload to a rolling buffer and calls
 * this repeatedly. One frame may span N indications; one indication may hold the tail of one
 * frame and the head of the next (BAT-1201 §4).
 *
 * Returns null when the buffer does not yet hold a complete frame, which is the normal case
 * mid-reassembly and must not be treated as an error.
 */
fun readDelimitedFrame(buf: ByteArray, offset: Int, limit: Int): FrameSlice? {
    if (offset >= limit) return null
    var p = offset
    var length = 0L
    var shift = 0
    var consumed = 0
    while (true) {
        if (p >= limit) return null // length prefix itself is still incomplete
        val b = buf[p++].toInt() and 0xFF
        consumed++
        if (consumed > MAX_VARINT_BYTES) {
            throw ProtoDecodeException("frame length varint longer than $MAX_VARINT_BYTES bytes")
        }
        length = length or ((b and 0x7F).toLong() shl shift)
        if (b and 0x80 == 0) break
        shift += 7
    }
    if (length < 0 || length > MAX_FIELD_BYTES) {
        throw ProtoDecodeException("implausible frame length $length")
    }
    val n = length.toInt()
    if (p + n > limit) return null // body not fully arrived yet
    return FrameSlice(start = p, end = p + n, nextOffset = p + n)
}

/** A complete frame located inside the reassembly buffer, without copying it out. */
data class FrameSlice(val start: Int, val end: Int, val nextOffset: Int)
