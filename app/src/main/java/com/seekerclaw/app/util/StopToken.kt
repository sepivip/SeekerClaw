package com.seekerclaw.app.util

import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.NoSuchFileException
import java.nio.file.Path
import java.nio.file.attribute.BasicFileAttributes
import java.security.SecureRandom

/**
 * BAT-1409 P1-A (amendment v3.3 M2, correction v3.4) — the cross-process stop token,
 * `filesDir/service_stop_request`.
 *
 * Every companion `stop()`/`restart()` writes a fresh token before the xAI durability gate. A
 * start records the token it began with (its baseline); its continuation proceeds only when the
 * current state is exactly that baseline, so a start can never run its side effects after a stop
 * that began later. Only those stops, and the `Failed(STOP_TOKEN_UNREADABLE)` repair, write it.
 *
 * Pure JVM (no `android.*`).
 */
object StopToken {
    const val FILE_NAME = "service_stop_request"

    /** A token is exactly 32 lowercase hex characters. */
    private val TOKEN = Regex("^[0-9a-f]{32}$")
    private const val MAX_BYTES = 64

    sealed class State {
        /** The file does not exist (fresh install, or the first start after this upgrade). */
        object Absent : State() {
            override fun toString() = "Absent"
        }

        data class Token(val value: String) : State()

        /** An I/O error, a link, a non-regular file, or a size or parse failure. */
        object Unreadable : State() {
            override fun toString() = "Unreadable"
        }
    }

    /** Reads the tagged state without following a link at any depth. Never throws. */
    fun read(filesDir: Path): State {
        val p = filesDir.resolve(FILE_NAME)
        return try {
            val a = try {
                Files.readAttributes(p, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
            } catch (_: NoSuchFileException) {
                return State.Absent
            }
            if (!a.isRegularFile || a.size() > MAX_BYTES) return State.Unreadable
            val text = String(SafeFs.readBytesNoFollow(filesDir, p), Charsets.US_ASCII).trim()
            if (TOKEN.matches(text)) State.Token(text) else State.Unreadable
        } catch (_: NoSuchFileException) {
            State.Absent
        } catch (_: Exception) {
            State.Unreadable
        }
    }

    /** True only for `Absent`→`Absent` and `Token(v)`→`Token(v)`. `Unreadable` never matches. */
    fun matches(baseline: State, current: State): Boolean = when (baseline) {
        State.Absent -> current == State.Absent
        is State.Token -> current is State.Token && current.value == baseline.value
        State.Unreadable -> false
    }

    /**
     * Writes a fresh random token, durably. A directory or other non-file planted at the name is
     * removed first (no-follow, bounded), so the `Failed(STOP_TOKEN_UNREADABLE)` repair always
     * converges; a link is simply replaced by the rename. False on failure (the stop proceeds).
     */
    fun writeFresh(filesDir: Path, random: SecureRandom = SecureRandom()): Boolean = try {
        val p = filesDir.resolve(FILE_NAME)
        val a = try {
            Files.readAttributes(p, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
        } catch (_: NoSuchFileException) {
            null
        }
        if (a != null && !a.isRegularFile && !a.isSymbolicLink) {
            SafeFs.deleteTreeNoFollow(filesDir, p, 10_000L, System.nanoTime() + 1_000_000_000L)
        }
        val bytes = ByteArray(16).also { random.nextBytes(it) }
        val hex = bytes.joinToString("") { "%02x".format(java.util.Locale.ROOT, it.toInt() and 0xff) }
        SafeFs.writeAtomicText(filesDir, p, hex, durable = true)
        true
    } catch (_: Exception) {
        false
    }
}
