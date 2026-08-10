package com.seekerclaw.app.flipper

import java.security.MessageDigest

/** A remote file on the device, before its contents have been read. */
data class RemoteRef(val fileName: String, val path: String) {
    /** What the user sees — the file name without its extension, as the Flipper's own UI shows. */
    val displayName: String get() = fileName.removeSuffix(IR_EXTENSION)
}

/**
 * A remote that has been read and parsed.
 *
 * [sha256] fingerprints the **raw bytes**, not the names or size. Codex rejected a names+size
 * fingerprint because a user can replace a file with a different signal while preserving both,
 * which would fire an unapproved appliance with the allowlist never noticing (contract §8 B3).
 */
data class RemoteDetail(
    val ref: RemoteRef,
    val buttons: List<String>,
    val sha256: String,
) {
    val isEmpty: Boolean get() = buttons.isEmpty()
}

internal const val IR_EXTENSION = ".ir"

/**
 * The subset of the transport this layer needs.
 *
 * Exists so the filtering and chunk-joining logic can be tested without a BLE stack — those are
 * where the mistakes live, and requiring hardware to exercise them would mean never exercising
 * them. [FlipperRpcClient] is the only production implementation.
 */
interface RpcTransport {
    suspend fun send(request: RpcRequest, timeoutMs: Long): List<RpcFrame>
}

/**
 * Reads the user's saved IR remotes over the RPC link.
 *
 * Enumeration is **one level, non-recursive**. `/ext/infrared/assets/` holds the shipped universal
 * library, which parses fine but which `infrared_remote_load` rejects with `WrongFileType` — so a
 * recursive walk would surface hundreds of entries that all fail at press time. Restricting to
 * files at the top level excludes it for free, since `assets` enumerates as a directory.
 */
class FlipperRemoteReader(private val client: RpcTransport) {

    companion object {
        /**
         * Upper bound on files considered. A Flipper with thousands of remotes is unusual; a cap
         * keeps a pathological directory from stalling enrollment, and the UI reports when it bites
         * rather than silently truncating.
         */
        const val MAX_FILES = 500

        /** Provisional; slice 3 fixes real numbers once cold-sequence latency is measured. */
        const val LIST_TIMEOUT_MS = 15_000L

        /** A large .ir read is chunked and firmware-blocking, so this is the looser of the two. */
        const val READ_TIMEOUT_MS = 20_000L

        /** Non-ASCII file names are silently dropped by the firmware's own list filter. */
        private fun isAscii(s: String) = s.all { it.code in 0x20..0x7E }
    }

    /** Files whose names were skipped, so the UI can say so instead of quietly omitting them. */
    data class Listing(val remotes: List<RemoteRef>, val skipped: Int, val capped: Boolean)

    /**
     * Lists candidate `.ir` files in `/ext/infrared`.
     *
     * Filters to regular files with a case-sensitive `.ir` suffix — the firmware's own matching is
     * case-sensitive, so accepting `.IR` here would list a file that later fails to load.
     */
    suspend fun listRemotes(): Listing {
        val frames = client.send(RpcRequest.StorageList(FlipperPaths.INFRARED_DIR), LIST_TIMEOUT_MS)
        requireOk(frames, "Storage.List")

        val files = frames
            .mapNotNull { it.content as? RpcContent.StorageList }
            .flatMap { it.files }

        var skipped = 0
        val refs = mutableListOf<RemoteRef>()
        for (f in files) {
            if (f.isDir) continue // excludes assets/ without a special case
            if (!f.name.endsWith(IR_EXTENSION)) continue
            if (!isAscii(f.name)) { skipped++; continue }
            if (refs.size >= MAX_FILES) return Listing(refs, skipped, capped = true)
            refs += RemoteRef(f.name, "${FlipperPaths.INFRARED_DIR}/${f.name}")
        }
        return Listing(refs, skipped, capped = false)
    }

    /**
     * Reads one remote and parses its buttons.
     *
     * Returns null when the file is not a loadable remote — wrong `Filetype`, wrong `Version`, or
     * a malformed header. Those would enumerate happily and then fail forever at press time, so
     * they must not reach the allowlist (§8).
     */
    suspend fun readRemote(ref: RemoteRef): RemoteDetail? {
        val frames = client.send(RpcRequest.StorageRead(ref.path), READ_TIMEOUT_MS)
        requireOk(frames, "Storage.Read")

        val bytes = frames.storageReadBytes()

        if (!IrFileParser.isRemoteFile(bytes)) return null

        val buttons = IrFileParser.parseButtonNames(bytes)
        return RemoteDetail(ref, buttons, sha256(bytes))
    }

    /**
     * A non-OK status ends the response sequence, so the frames we hold are partial. Surfacing it
     * as the transport's own error keeps the caller from parsing a truncated file as a real one.
     */
    private fun requireOk(frames: List<RpcFrame>, what: String) {
        val bad = frames.firstOrNull { it.status != CommandStatus.OK } ?: return
        throw FlipperTransportException(
            FlipperTransportException.Kind.COMMAND_FAILED,
            "$what failed with ${bad.status} (code ${bad.status.code})",
            status = bad.status,
        )
    }
}

/** Lower-case hex SHA-256, used as the allowlist's content fingerprint. */
internal fun sha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes)
        .joinToString("") { "%02x".format(it) }
