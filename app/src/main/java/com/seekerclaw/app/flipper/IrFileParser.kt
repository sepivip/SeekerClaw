package com.seekerclaw.app.flipper

/**
 * Parser for Flipper `.ir` remote files.
 *
 * **This emulates a positional read head, not a flat key/value sweep.** `flipper_format` is a
 * stream: it consumes the header first, applies its `+2` value-seek only to the key it actually
 * matched, and terminates the whole enumeration on the first read failure. A parser that scans the
 * file once from offset 0 and collects every `key: value` pair agrees with it on ordinary files
 * and disagrees on several real ones — see the divergences below, each of which produced a button
 * list that did not match the device.
 *
 * Verified against flipperdevices/flipperzero-firmware@8622f1a2 (tag 1.4.3):
 * `lib/flipper_format/flipper_format_stream.c`, `lib/flipper_format/flipper_format.c`,
 * `lib/infrared/signal/infrared_signal.c`, `applications/main/infrared/infrared_remote.c`.
 *
 * ### Tokenisation, from source
 *
 * | Input | Firmware yields | Why |
 * |---|---|---|
 * | `name: Power` | `Power` | `seek_to_key` seeks **+2** from the `:` |
 * | `name:Power` | `ower` | the same +2 eats `:` and `P` |
 * | `name: Vol Up ` | `Vol Up ` | `read_line` keeps inner and trailing spaces |
 * | `name: Power\r\n` | `Power` | every `\r` is dropped |
 * | `# name: Power` | *(skipped)* | `#` stops accumulation, but only at line start |
 * | ` name: Power` | *(no match)* | the leading space is part of the key |
 *
 * ### Positional behaviour, which a flat sweep gets wrong
 *
 * - **An empty value ends the enumeration.** `read_line` reports failure on a zero-length result,
 *   which propagates up and breaks `infrared_remote_load`'s loop. Every name after `name: ` is
 *   invisible to the device, so listing them would advertise buttons that cannot be pressed.
 * - **The `+2` seek applies only to the matched key.** On a non-match the stream stays *on* the
 *   `:`, so `command:` immediately followed by a newline does not swallow the next line.
 * - **The header is consumed before enumeration begins.** `Filetype` then `Version` are read
 *   sequentially with no rewind, so any `name:` above the `Version:` line is behind the read head
 *   forever.
 * - **`Version` must be exactly 1**, present, and parseable, or the remote does not load at all.
 *
 * ### On the harm model
 *
 * An unresolvable name is **not** a silent success: `infrared_scene_rpc.c` leaves `result = false`
 * and the RPC returns `ERROR_APP_CMD_ERROR`. The damage from getting this wrong is a **wrong
 * button list** — offering buttons the device cannot press, or hiding ones it has. The silent-OK
 * failure mode exists only for *index*-addressed presses, which [RpcRequest.PressRelease] never
 * emits. Never derive an index or a count from this list (contract §6 G3).
 */
object IrFileParser {

    private const val LF = '\n'.code.toByte()
    private const val CR = '\r'.code.toByte()
    private const val SPACE = ' '.code.toByte()
    private const val COMMENT = '#'.code.toByte()
    private const val DELIMITER = ':'.code.toByte()

    /** The `Filetype` a remote file must declare. Library files under `assets/` differ. */
    const val REMOTE_FILETYPE = "IR signals file"

    /** `INFRARED_FILE_VERSION` in `infrared_remote.c`. Anything else fails to load. */
    const val INFRARED_FILE_VERSION = 1

    /** A value and the offset immediately after it — the stream position the firmware would hold. */
    private data class Read(val value: String, val next: Int)

    // ------------------------------------------------------------ stream primitives

    /**
     * `read_valid_key` — accumulates a key and stops **on** the `:` that terminates it.
     *
     * The firmware seeks back onto the delimiter rather than past it, which is what makes a
     * non-matching key harmless: re-entering the scanner sees the `:` at "new line" and resets.
     *
     * Returns the key and the delimiter's index, or null at end of input.
     */
    private fun readValidKey(bytes: ByteArray, from: Int): Pair<String, Int>? {
        val key = StringBuilder()
        var accumulate = true
        var newLine = true
        var i = from
        while (i < bytes.size) {
            when (bytes[i]) {
                LF -> {
                    key.setLength(0)
                    accumulate = true
                    newLine = true
                }

                CR -> {} // ignored outright; does not clear the new-line flag

                COMMENT -> {
                    if (newLine) {
                        accumulate = false
                        newLine = false
                    } else {
                        // Mid-line, '#' is an ordinary byte and falls through the firmware's
                        // final else branch.
                        newLine = false
                        if (accumulate) key.append('#')
                    }
                }

                DELIMITER -> {
                    if (newLine) {
                        // A line beginning with ':' is not a key.
                        key.setLength(0)
                        accumulate = false
                        newLine = false
                    } else if (accumulate) {
                        return key.toString() to i
                    }
                }

                else -> {
                    newLine = false
                    if (accumulate) key.append((bytes[i].toInt() and 0xFF).toChar())
                }
            }
            i++
        }
        return null
    }

    /**
     * `seek_to_key` with `strict_mode = false` — which infrared never overrides, and which this
     * depends on: under strict mode a non-matching key would abort the search instead of retrying.
     *
     * The unconditional `+2` is applied **only on a match**. Returns the value's start offset, or
     * null when the key is unreachable (including a `:` as the file's final byte, where the seek
     * itself fails).
     */
    private fun seekToKey(bytes: ByteArray, from: Int, key: String): Int? {
        var i = from
        while (true) {
            val (found, colon) = readValidKey(bytes, i) ?: return null
            if (found == key) return (colon + 2).takeIf { it <= bytes.size }
            i = colon // non-match: stay ON the ':', exactly as the stream does
        }
    }

    /**
     * `read_line` — bytes up to `\n`, dropping every `\r`, no trimming.
     *
     * **Returns null on an empty result.** The firmware treats a zero-length accumulation as a
     * failure even though a well-formed line was consumed, and that failure is what terminates
     * `infrared_remote_load`'s enumeration loop.
     */
    private fun readLineOrNull(bytes: ByteArray, from: Int): Read? {
        val sb = StringBuilder()
        var i = from
        while (i < bytes.size) {
            val b = bytes[i]
            if (b == LF) break
            if (b != CR) sb.append((b.toInt() and 0xFF).toChar())
            i++
        }
        return if (sb.isEmpty()) null else Read(sb.toString(), i)
    }

    /** `flipper_format_read_string` = `seek_to_key` + `read_line`. */
    private fun readString(bytes: ByteArray, from: Int, key: String): Read? =
        seekToKey(bytes, from, key)?.let { readLineOrNull(bytes, it) }

    /**
     * `read_value` + `strint_to_uint32` — space-delimited, **not** `read_line`.
     *
     * Skips leading spaces, stops at the first space after data, and fails outright on reaching
     * end-of-line before any data. `Version: 1 extra` is therefore accepted; `Version:1` is not,
     * because the `+2` lands on the newline.
     */
    private fun readUint32(bytes: ByteArray, from: Int, key: String): Pair<Long, Int>? {
        var i = seekToKey(bytes, from, key) ?: return null
        val sb = StringBuilder()
        while (i < bytes.size) {
            val b = bytes[i]
            if (b == LF) break
            if (b == CR) { i++; continue }
            if (b == SPACE) {
                if (sb.isNotEmpty()) break
                i++
                continue
            }
            sb.append((b.toInt() and 0xFF).toChar())
            i++
        }
        if (sb.isEmpty()) return null
        val v = sb.toString().toLongOrNull()?.takeIf { it in 0..0xFFFF_FFFFL } ?: return null
        return v to i
    }

    // ------------------------------------------------------------------ header

    /**
     * `flipper_format_read_header` followed by `infrared_remote_load`'s version gate.
     *
     * Sequential on one stream with no rewind, so **order matters**: anything before the `Version`
     * value is behind the read head and can never be enumerated.
     *
     * Returns the offset where name enumeration begins, or null when the remote will not load.
     */
    private fun headerEnd(bytes: ByteArray): Int? {
        val filetype = readString(bytes, 0, "Filetype") ?: return null // FileOperationFailed
        if (filetype.value != REMOTE_FILETYPE) return null             // WrongFileType
        val (version, after) = readUint32(bytes, filetype.next, "Version") ?: return null
        if (version != INFRARED_FILE_VERSION.toLong()) return null     // WrongFileVersion
        return after
    }

    // ------------------------------------------------------------------- public

    /**
     * The ordered button names, built exactly as `infrared_remote_load` builds `signal_names`.
     *
     * The loop **stops on the first read failure**, as the firmware's does — a name listed past
     * that point does not exist on the device, and offering it would produce a button that always
     * fails. Deduped to first occurrence, matching the firmware's first-match `strcmp` (§8).
     */
    fun parseButtonNames(bytes: ByteArray): List<String> {
        var pos = headerEnd(bytes) ?: return emptyList()
        val seen = LinkedHashSet<String>()
        while (true) {
            val r = readString(bytes, pos, "name") ?: break
            seen.add(r.value)
            pos = r.next
        }
        return seen.toList()
    }

    /** True when the Infrared app will actually load this file — Filetype *and* Version. */
    fun isRemoteFile(bytes: ByteArray): Boolean = headerEnd(bytes) != null

    // -------------------------------------------------------------- diagnostics

    /** One key/value pair as a flat sweep would see it. */
    data class Entry(val key: String, val value: String)

    /**
     * A flat dump of every `key: value` pair, for logging and diagnostics only.
     *
     * **Not authoritative and not used by [parseButtonNames] or [isRemoteFile].** It applies the
     * `+2` seek to every delimiter, which is correct only for a key you are actually seeking — on
     * a key whose colon is immediately followed by a newline it swallows the following line. Use
     * it to show a human what is in a file, never to decide what the device will do.
     */
    fun parse(bytes: ByteArray): List<Entry> {
        val out = mutableListOf<Entry>()
        var pos = 0
        while (true) {
            val (key, colon) = readValidKey(bytes, pos) ?: break
            val valueStart = colon + 2
            if (valueStart > bytes.size) break
            val sb = StringBuilder()
            var i = valueStart
            while (i < bytes.size) {
                val b = bytes[i]
                if (b == LF) break
                if (b != CR) sb.append((b.toInt() and 0xFF).toChar())
                i++
            }
            out += Entry(key, sb.toString())
            pos = i
            if (pos >= bytes.size) break
        }
        return out
    }
}
