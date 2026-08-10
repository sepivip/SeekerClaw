package com.seekerclaw.app.flipper

/**
 * `PB.Main` envelope codec for the Flipper Zero RPC link.
 *
 * Message and field numbers verified against flipperdevices/flipperzero-protobuf@1c84fa48
 * (tag 0.25) — the exact schema on firmware 1.4.3.
 *
 * **The encoder allowlist is structural, not a filter.** BAT-1201 §7 requires the eight permitted
 * commands to be the only ones we are *capable* of emitting. [RpcRequest] is a sealed hierarchy
 * with exactly eight subclasses, so there is no value that could encode `Gui.SendInputEvent` (23),
 * `Desktop.Unlock` (67), `Storage.Write` (11) or any of the other sixty-seven — the code to build
 * them does not exist. Widening this is an explicit act: add a subclass, and the contract
 * amendment that justifies it.
 *
 * Two tags are called out because their absence is load-bearing rather than incidental:
 * `AppButtonPress` (49) and `AppButtonRelease` (50) route through `infrared_tx_start()`, which
 * carries the 50 ms guard and the silent-`void` early return behind the firmware's false-OK. Tag
 * 75 avoids that path entirely, and only because 49/50 are never sent (§6 G1). If either is ever
 * added here, `sent` must be downgraded to `dispatched` in the same change.
 *
 * The decoder is deliberately asymmetric: it accepts anything and understands a subset. Applying
 * the allowlist inbound would break §5 step 5, which blocks on an *unsolicited* `AppStateResponse`.
 */

/** Outbound content tags. These eight are the complete set of commands we can construct. */
internal object OutTag {
    const val SYSTEM_PING = 5
    const val STORAGE_LIST = 7
    const val STORAGE_READ = 9
    const val APP_START = 16
    const val SYSTEM_PROTOBUF_VERSION = 39
    const val APP_EXIT = 47
    const val APP_LOAD_FILE = 48
    const val APP_BUTTON_PRESS_RELEASE = 75

    /** Every tag this codec can emit. Asserted by test; used for nothing at runtime but clarity. */
    val ALL = intArrayOf(5, 7, 9, 16, 39, 47, 48, 75)
}

/** Inbound content tags we understand. Anything else is skipped, not rejected. */
internal object InTag {
    const val EMPTY = 4 // App.Start / LoadFile / PressRelease / Exit all confirm with this
    const val SYSTEM_PING_RESPONSE = 6
    const val STORAGE_LIST_RESPONSE = 8
    const val STORAGE_READ_RESPONSE = 10
    const val SYSTEM_PROTOBUF_VERSION_RESPONSE = 40
    const val APP_STATE_RESPONSE = 58
}

/** Envelope field numbers on `PB.Main`. */
private object MainField {
    const val COMMAND_ID = 1
    const val COMMAND_STATUS = 2
    const val HAS_NEXT = 3
}

/**
 * `PB.CommandStatus`. Only the values we map to user-facing errors are named; anything else
 * surfaces as [Unknown] carrying its raw code so a log never loses information.
 */
enum class CommandStatus(val code: Int) {
    OK(0),
    ERROR(1),
    ERROR_DECODE(2),
    ERROR_NOT_IMPLEMENTED(3),
    ERROR_BUSY(4),
    ERROR_STORAGE_NOT_READY(5),
    ERROR_STORAGE_NOT_EXIST(7),
    ERROR_STORAGE_DENIED(9),
    ERROR_STORAGE_INTERNAL(11),
    ERROR_INVALID_PARAMETERS(15),
    ERROR_APP_CANT_START(16),
    ERROR_APP_SYSTEM_LOCKED(17),
    ERROR_APP_NOT_RUNNING(21),
    ERROR_APP_CMD_ERROR(22),
    Unknown(-1);

    companion object {
        fun from(code: Int): CommandStatus = entries.firstOrNull { it.code == code } ?: Unknown
    }
}

/** `PB_App.AppState`. Note `APP_CLOSED` is 0, so an unset field decodes as it (§5 R3). */
enum class AppState { APP_CLOSED, APP_STARTED, UNKNOWN }

/** A `PB_Storage.File` entry. `isDir` matters: `Storage.List` returns both. */
data class StorageFile(
    val isDir: Boolean,
    val name: String,
    val size: Int,
    val data: ByteArray,
) {
    // ByteArray breaks data-class equality; only `name` identifies an entry for our purposes.
    override fun equals(other: Any?): Boolean =
        other is StorageFile && isDir == other.isDir && name == other.name && size == other.size

    override fun hashCode(): Int = (if (isDir) 1 else 0) * 31 * 31 + name.hashCode() * 31 + size
}

// ---------------------------------------------------------------------- requests

/**
 * The complete set of commands this client can send.
 *
 * Sealed on purpose — see the file header. Adding a subclass widens the app's capability against
 * the user's Flipper, so it is a contract change, not a refactor.
 */
sealed class RpcRequest {
    internal abstract val tag: Int
    internal abstract fun encodeBody(): ByteArray

    /** `System.PingRequest`. Slice-1 liveness probe; `data` echoes back in the response. */
    data class Ping(val data: ByteArray = ByteArray(0)) : RpcRequest() {
        override val tag = OutTag.SYSTEM_PING
        override fun encodeBody() = ProtoWriter().apply { writeBytes(1, data) }.toByteArray()
        override fun equals(other: Any?) = other is Ping && data.contentEquals(other.data)
        override fun hashCode() = data.contentHashCode()
    }

    /** `System.ProtobufVersionRequest`. Mandatory capability check — tag 75 needs ≥ 0.25 (§5). */
    object ProtobufVersion : RpcRequest() {
        override val tag = OutTag.SYSTEM_PROTOBUF_VERSION
        override fun encodeBody() = ByteArray(0)
    }

    /**
     * `Storage.ListRequest`. Scoped to the infrared directory by [FlipperPaths]; `..` is rejected.
     * `includeMd5` stays false — we fingerprint locally over the bytes we already read (§8).
     */
    data class StorageList(val path: String) : RpcRequest() {
        init { FlipperPaths.requireInfraredPath(path) }
        override val tag = OutTag.STORAGE_LIST
        override fun encodeBody() = ProtoWriter().apply { writeString(1, path) }.toByteArray()
    }

    /** `Storage.ReadRequest`. Response is `has_next`-chunked; buffer fully before parsing (§5). */
    data class StorageRead(val path: String) : RpcRequest() {
        init { FlipperPaths.requireInfraredPath(path) }
        override val tag = OutTag.STORAGE_READ
        override fun encodeBody() = ProtoWriter().apply { writeString(1, path) }.toByteArray()
    }

    /**
     * `App.StartRequest`. Only ever the Infrared app, only ever in RPC mode.
     *
     * `name` is the app's *display* name — `"Infrared"`, not the appid `"infrared"`. The loader
     * matches on `.name` only, so the lowercase form returns `ERROR_INVALID_PARAMETERS` (§5).
     */
    object StartInfraredRpc : RpcRequest() {
        override val tag = OutTag.APP_START
        override fun encodeBody() = ProtoWriter().apply {
            writeString(1, "Infrared")
            writeString(2, "RPC")
        }.toByteArray()
    }

    /** `App.AppLoadFileRequest`. One file per session — a second load never confirms (§5 R2). */
    data class LoadFile(val path: String) : RpcRequest() {
        init { FlipperPaths.requireInfraredPath(path) }
        override val tag = OutTag.APP_LOAD_FILE
        override fun encodeBody() = ProtoWriter().apply { writeString(1, path) }.toByteArray()
    }

    /**
     * `App.AppButtonPressReleaseRequest` — the transmit.
     *
     * `args` carries the button name and **must never be empty**: the firmware dispatches on
     * `strlen(args) != 0`, so an empty string falls through to *index* addressing, where proto3's
     * default of 0 fires an arbitrary button (§6 G2). The `index` field (2) exists in the schema
     * and is deliberately never written — it has no bounds check and reaches an out-of-bounds read
     * (§6 G3).
     *
     * [button] must be the bytes parsed from the `.ir` file, unmodified — the firmware `strcmp`s
     * against its own tokenisation (§6 G4).
     */
    data class PressRelease(val button: String) : RpcRequest() {
        init {
            require(button.isNotEmpty()) {
                "button name must not be empty — empty args falls through to index addressing " +
                    "and fires an arbitrary button (BAT-1201 §6 G2)"
            }
        }
        override val tag = OutTag.APP_BUTTON_PRESS_RELEASE

        /**
         * Encoded **Latin-1, not UTF-8**.
         *
         * [IrFileParser] maps each file byte to one char deliberately, so a `.ir` byte of `0xFF`
         * becomes `U+00FF`. Re-encoding that as UTF-8 emits two bytes, and the firmware's `strcmp`
         * — which compares against the single byte it read from the same file — never matches.
         * The result is a permanent `unknown_button` on any remote whose name contains a byte
         * above 0x7F, with nothing in the logs to explain it.
         *
         * ISO-8859-1 is the exact inverse of the parser's byte-to-char mapping, so the bytes we
         * send are the bytes the firmware parsed. This is what §6 G4's "one parse, zero subsequent
         * transforms" means at the wire.
         */
        override fun encodeBody() = ProtoWriter().apply {
            writeBytes(1, button.toByteArray(Charsets.ISO_8859_1))
        }.toByteArray()
    }

    /**
     * `App.AppExitRequest`.
     *
     * Callers must satisfy both gates in §5 R1 before sending: zero outstanding `App.*` commands
     * (R1a) **and** established ownership of the Infrared app in this session (R1b). Sending it
     * without R1a double-confirms into a `furi_check` crash that reboots the device; without R1b
     * it closes whatever app the user had open. Neither is enforceable here — the session state
     * lives in [FlipperRpcClient].
     */
    object Exit : RpcRequest() {
        override val tag = OutTag.APP_EXIT
        override fun encodeBody() = ByteArray(0)
    }
}

/** Path guard for the two Storage commands. Read cannot be denied, so it is bounded instead. */
internal object FlipperPaths {
    const val INFRARED_DIR = "/ext/infrared"

    fun requireInfraredPath(path: String) {
        require(path == INFRARED_DIR || path.startsWith("$INFRARED_DIR/")) {
            "storage access is scoped to $INFRARED_DIR (BAT-1201 §7), got: $path"
        }
        require(!path.split('/').contains("..")) { "path traversal rejected: $path" }
    }
}

// --------------------------------------------------------------------- responses

/** What we understood from an inbound frame. Unknown content decodes to [Other]. */
sealed class RpcContent {
    /** `Empty` (4) — how App.Start, LoadFile, PressRelease and Exit all confirm. */
    object Empty : RpcContent()

    data class Pong(val data: ByteArray) : RpcContent() {
        override fun equals(other: Any?) = other is Pong && data.contentEquals(other.data)
        override fun hashCode() = data.contentHashCode()
    }

    data class ProtobufVersion(val major: Int, val minor: Int) : RpcContent() {
        /** Tag 75 does not exist below 0.24; §5 step 1 requires ≥ 0.25 and fails closed. */
        fun atLeast(reqMajor: Int, reqMinor: Int): Boolean =
            major > reqMajor || (major == reqMajor && minor >= reqMinor)
    }

    data class StorageList(val files: List<StorageFile>) : RpcContent()
    data class StorageRead(val file: StorageFile?) : RpcContent()
    data class AppStateChanged(val state: AppState) : RpcContent()

    /** A content tag we do not implement. Carried, not dropped, so logs stay useful. */
    data class Other(val tag: Int) : RpcContent()

    /** No content field at all — legal, and how some bare status replies arrive. */
    object None : RpcContent()
}

/**
 * A decoded `PB.Main`.
 *
 * [commandId] is only meaningful on solicited replies. `AppStateResponse` is malloc'd with only
 * `which_content` and `state` set, so its `commandId`, `status` **and [hasNext]** are uninitialised
 * heap — route unsolicited frames by content type, never by id (§5 R3).
 */
data class RpcFrame(
    val commandId: Int,
    val status: CommandStatus,
    val hasNext: Boolean,
    val content: RpcContent,
) {
    /** True for frames that arrive without us having asked — never resolve a pending call on one. */
    val isUnsolicited: Boolean get() = content is RpcContent.AppStateChanged
}

// ----------------------------------------------------------------------- codec

object FlipperRpc {

    /** Encodes one `PB.Main`, length-delimited and ready to chunk onto the RX characteristic. */
    fun encode(commandId: Int, request: RpcRequest): ByteArray {
        require(commandId > 0) { "command_id must be positive (0 means unset on the wire)" }
        val main = ProtoWriter().apply {
            writeUint32(MainField.COMMAND_ID, commandId)
            // command_status and has_next stay at their proto3 defaults on requests.
            writeMessage(request.tag, request.encodeBody())
        }.toByteArray()

        return ProtoWriter().apply {
            writeVarint(main.size.toLong())
        }.toByteArray() + main
    }

    /** Decodes one complete `PB.Main` body — the caller has already stripped the length prefix. */
    fun decode(buf: ByteArray, start: Int = 0, end: Int = buf.size): RpcFrame {
        var commandId = 0
        var status = CommandStatus.OK
        var hasNext = false
        var content: RpcContent = RpcContent.None

        val r = ProtoReader(buf, start, end)
        while (r.hasMore) {
            val tag = r.readTag()
            when (ProtoReader.fieldOf(tag)) {
                MainField.COMMAND_ID -> commandId = r.readUint32()
                MainField.COMMAND_STATUS -> status = CommandStatus.from(r.readEnum())
                MainField.HAS_NEXT -> hasNext = r.readBool()
                InTag.EMPTY -> { r.readMessage(); content = RpcContent.Empty }
                InTag.SYSTEM_PING_RESPONSE -> content = RpcContent.Pong(decodePing(r.readMessage()))
                InTag.SYSTEM_PROTOBUF_VERSION_RESPONSE -> content = decodeVersion(r.readMessage())
                InTag.STORAGE_LIST_RESPONSE -> content = decodeList(r.readMessage())
                InTag.STORAGE_READ_RESPONSE -> content = decodeRead(r.readMessage())
                InTag.APP_STATE_RESPONSE -> content = decodeAppState(r.readMessage())
                else -> {
                    // An unimplemented oneof member, or a field from a newer firmware. Both are
                    // ordinary; record the tag and move on rather than failing the frame.
                    val field = ProtoReader.fieldOf(tag)
                    r.skipField(tag)
                    if (content is RpcContent.None) content = RpcContent.Other(field)
                }
            }
        }
        return RpcFrame(commandId, status, hasNext, content)
    }

    private fun decodePing(r: ProtoReader): ByteArray {
        var data = ByteArray(0)
        while (r.hasMore) {
            val tag = r.readTag()
            if (ProtoReader.fieldOf(tag) == 1) data = r.readBytes() else r.skipField(tag)
        }
        return data
    }

    private fun decodeVersion(r: ProtoReader): RpcContent.ProtobufVersion {
        var major = 0
        var minor = 0
        while (r.hasMore) {
            val tag = r.readTag()
            when (ProtoReader.fieldOf(tag)) {
                1 -> major = r.readUint32()
                2 -> minor = r.readUint32()
                else -> r.skipField(tag)
            }
        }
        return RpcContent.ProtobufVersion(major, minor)
    }

    private fun decodeList(r: ProtoReader): RpcContent.StorageList {
        val files = mutableListOf<StorageFile>()
        while (r.hasMore) {
            val tag = r.readTag()
            if (ProtoReader.fieldOf(tag) == 1) files += decodeFile(r.readMessage()) else r.skipField(tag)
        }
        return RpcContent.StorageList(files)
    }

    private fun decodeRead(r: ProtoReader): RpcContent.StorageRead {
        var file: StorageFile? = null
        while (r.hasMore) {
            val tag = r.readTag()
            if (ProtoReader.fieldOf(tag) == 1) file = decodeFile(r.readMessage()) else r.skipField(tag)
        }
        return RpcContent.StorageRead(file)
    }

    private fun decodeFile(r: ProtoReader): StorageFile {
        var isDir = false
        var name = ""
        var size = 0
        var data = ByteArray(0)
        while (r.hasMore) {
            val tag = r.readTag()
            when (ProtoReader.fieldOf(tag)) {
                1 -> isDir = r.readEnum() == 1 // FileType: FILE=0, DIR=1
                2 -> name = r.readString()
                3 -> size = r.readUint32()
                4 -> data = r.readBytes()
                else -> r.skipField(tag) // md5sum (5) — unused, we fingerprint locally
            }
        }
        return StorageFile(isDir, name, size, data)
    }

    private fun decodeAppState(r: ProtoReader): RpcContent.AppStateChanged {
        var state = AppState.APP_CLOSED // proto3 default; an unset field legitimately decodes as it
        while (r.hasMore) {
            val tag = r.readTag()
            if (ProtoReader.fieldOf(tag) == 1) {
                state = when (r.readEnum()) {
                    0 -> AppState.APP_CLOSED
                    1 -> AppState.APP_STARTED
                    else -> AppState.UNKNOWN
                }
            } else {
                r.skipField(tag)
            }
        }
        return RpcContent.AppStateChanged(state)
    }
}
