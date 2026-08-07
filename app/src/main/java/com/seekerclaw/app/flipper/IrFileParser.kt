package com.seekerclaw.app.flipper

/**
 * Parser for Flipper `.ir` remote files.
 *
 * **This must replicate `flipper_format`'s tokenisation exactly.** The firmware resolves a button
 * by `strcmp` against names it parsed with its own scanner, so any difference between our parse
 * and theirs means the press silently does nothing — the RPC succeeds, no signal is emitted, and
 * the user is told it worked. Contract BAT-1201 §6 G4: one parse, zero subsequent transforms.
 *
 * Verified against flipperdevices/flipperzero-firmware@8622f1a2 (tag 1.4.3),
 * `lib/flipper_format/flipper_format_stream.c`. `flipper_format_read_string` is
 * `seek_to_key` followed by `read_line` — note it is **not** `read_value`, which terminates at the
 * first space and would give a different answer for names containing spaces.
 *
 * The rules, from source:
 *
 * | Input                | Firmware yields    | Why |
 * |----------------------|--------------------|-----|
 * | `name: Power`        | `Power`            | seek_to_key seeks **+2** from the `:` |
 * | `name:Power`         | `ower`             | the same +2 eats `:` and `P` |
 * | `name: Vol Up `      | `Vol Up `          | read_line keeps inner and trailing spaces |
 * | `name: Power\r\n`    | `Power`            | every `\r` is dropped |
 * | `# name: Power`      | *(skipped)*        | `#` at line start stops accumulation |
 * | ` name: Power`       | *(no match)*       | the leading space is part of the key |
 */
object IrFileParser {

    private const val LF = '\n'.code.toByte()
    private const val CR = '\r'.code.toByte()
    private const val COMMENT = '#'.code.toByte()
    private const val DELIMITER = ':'.code.toByte()

    /** The `Filetype` a remote file must declare. Library files under `assets/` differ. */
    const val REMOTE_FILETYPE = "IR signals file"

    /** One key/value pair, in file order, with the exact bytes the firmware would see. */
    data class Entry(val key: String, val value: String)

    /**
     * Parses every key/value pair in file order.
     *
     * Returns Strings because that is what we compare and display, but they are built byte-by-byte
     * from the file rather than decoded wholesale — see [parseButtonNames] for why that matters.
     */
    fun parse(bytes: ByteArray): List<Entry> {
        val out = mutableListOf<Entry>()
        val key = StringBuilder()
        var accumulate = true
        var newLine = true
        var i = 0

        while (i < bytes.size) {
            when (val b = bytes[i]) {
                LF -> {
                    key.setLength(0)
                    accumulate = true
                    newLine = true
                    i++
                }

                CR -> i++ // ignored everywhere, in keys and values alike

                COMMENT -> {
                    if (newLine) {
                        // A comment line: stop accumulating until the next newline resets us.
                        accumulate = false
                        newLine = false
                    } else if (accumulate) {
                        key.append(b.toInt().toChar())
                    }
                    i++
                }

                DELIMITER -> {
                    if (newLine) {
                        // A line beginning with ':' is not a key — firmware resets and skips it.
                        key.setLength(0)
                        accumulate = false
                        newLine = false
                        i++
                    } else if (accumulate) {
                        // Key complete. seek_to_key positions at the ':' then seeks +2, so the
                        // value begins two bytes on — normally past ':' and its following space.
                        val valueStart = i + 2
                        val (value, nextIndex) = readLine(bytes, valueStart)
                        out += Entry(key.toString(), value)
                        key.setLength(0)
                        accumulate = true
                        newLine = true
                        i = nextIndex // positioned at the '\n', consumed on the next iteration
                    } else {
                        i++
                    }
                }

                else -> {
                    newLine = false
                    if (accumulate) key.append((b.toInt() and 0xFF).toChar())
                    i++
                }
            }
        }
        return out
    }

    /**
     * `read_line`: every byte up to `\n`, dropping every `\r`. No trimming of any kind.
     * Returns the value and the index of the terminating `\n` (or the end of input).
     */
    private fun readLine(bytes: ByteArray, from: Int): Pair<String, Int> {
        if (from >= bytes.size) return "" to bytes.size
        val sb = StringBuilder()
        var i = from
        while (i < bytes.size) {
            val b = bytes[i]
            if (b == LF) break
            if (b != CR) sb.append((b.toInt() and 0xFF).toChar())
            i++
        }
        return sb.toString() to i
    }

    /**
     * The ordered button names, deduped to first occurrence.
     *
     * Order and dedupe both matter. The firmware `strcmp`s down the list it built from the same
     * file and takes the **first** match, and duplicate names are ordinary rather than adversarial
     * — IRDB and universal packs repeat `name: POWER` by construction. Deduping to first occurrence
     * here keeps our display, our allowlist and the firmware's resolution pointing at the same
     * signal (§8).
     */
    fun parseButtonNames(bytes: ByteArray): List<String> {
        val seen = LinkedHashSet<String>()
        for (e in parse(bytes)) {
            if (e.key == "name") seen.add(e.value)
        }
        return seen.toList()
    }

    /**
     * True when this is a remote file the Infrared app will accept.
     *
     * Library files under `/ext/infrared/assets/` parse fine client-side but `infrared_remote_load`
     * rejects them with `WrongFileType` — so without this check they would enumerate happily and
     * then fail forever at press time.
     */
    fun isRemoteFile(bytes: ByteArray): Boolean =
        parse(bytes).firstOrNull { it.key == "Filetype" }?.value == REMOTE_FILETYPE
}
