package com.seekerclaw.app.flipper

import android.content.Context
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** One recorded operation, as shown in Settings. */
data class AuditEntry(
    val timestampMillis: Long,
    val remoteLabel: String,
    val button: String,
    /** `sent`, `rejected:not_allowed`, `error:TIMEOUT`, and so on. Normalised, never free text. */
    val outcome: String,
    val invocation: InvocationContext,
) {
    fun formattedTime(): String =
        SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date(timestampMillis))
}

/**
 * Serialisation for the audit log, split out so it is testable without an Android context.
 *
 * Same primitives as the rest of the package. A corrupt record decodes to empty rather than
 * throwing — a damaged log must never become a reason a press fails.
 */
object FlipperAuditCodec {

    // Field numbers for the same protobuf primitives the rest of this package uses.
    private const val F_ENTRY = 1
    private const val E_TIME = 1
    private const val E_REMOTE = 2
    private const val E_BUTTON = 3
    private const val E_OUTCOME = 4
    private const val E_INVOCATION = 5

    fun encode(entries: List<AuditEntry>): String {
        val w = ProtoWriter()
        for (e in entries) {
            w.writeMessage(
                F_ENTRY,
                ProtoWriter().apply {
                    writeInt64(E_TIME, e.timestampMillis)
                    writeString(E_REMOTE, e.remoteLabel)
                    writeString(E_BUTTON, e.button)
                    writeString(E_OUTCOME, e.outcome)
                    // ordinal + 1 so USER_MESSAGE (ordinal 0) is not dropped by proto3's
                    // zero-omission and misread as AUTOMATED, misattributing a real press.
                    writeEnum(E_INVOCATION, e.invocation.ordinal + 1)
                }.toByteArray(),
            )
        }
        return java.util.Base64.getEncoder().encodeToString(w.toByteArray())
    }

    fun decode(encoded: String?): List<AuditEntry> {
        if (encoded.isNullOrBlank()) return emptyList()
        return try {
            val r = ProtoReader(java.util.Base64.getDecoder().decode(encoded.trim()))
            val out = mutableListOf<AuditEntry>()
            while (r.hasMore) {
                val tag = r.readTag()
                if (ProtoReader.fieldOf(tag) != F_ENTRY) { r.skipField(tag); continue }
                out += decodeEntry(r.readMessage())
            }
            out
        } catch (e: Exception) {
            emptyList()
        }
    }

    private fun decodeEntry(r: ProtoReader): AuditEntry {
        var time = 0L
        var remote = ""
        var button = ""
        var outcome = ""
        var invocation = InvocationContext.AUTOMATED
        while (r.hasMore) {
            val tag = r.readTag()
            when (ProtoReader.fieldOf(tag)) {
                E_TIME -> time = r.readVarint()
                E_REMOTE -> remote = r.readString()
                E_BUTTON -> button = r.readString()
                E_OUTCOME -> outcome = r.readString()
                E_INVOCATION -> invocation =
                    InvocationContext.entries.getOrNull(r.readEnum() - 1) ?: InvocationContext.AUTOMATED
                else -> r.skipField(tag)
            }
        }
        return AuditEntry(time, remote, button, outcome, invocation)
    }
}

/**
 * Append-only record of every Flipper operation, surfaced in Settings.
 *
 * This is **observability, not a confirmation prompt** — Codex approved it explicitly as a separate
 * control, and it does not reopen the settled decision against per-action confirmation.
 *
 * Deliberately outside `workDir` and Kotlin-only, for the same reason as the allowlist: the agent
 * must not be able to write, delete, or read-and-suppress its own record of what it did. A log the
 * subject can edit is not a log.
 *
 * Never records raw BLE payloads, prompt content, or the `.ir` file's signal data — only what was
 * asked for and what happened.
 */
class FlipperAuditLog(context: Context) {

    private companion object {
        const val PREFS_NAME = "flipper_audit"
        const val KEY_ENTRIES = "entries"

        /**
         * Kept small on purpose. This exists so a user can check what the agent did recently, not
         * to be a forensic archive, and an unbounded list in preferences would grow without limit.
         */
        const val MAX_ENTRIES = 200
    }

    private val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /** Newest first. */
    fun entries(): List<AuditEntry> = FlipperAuditCodec.decode(prefs.getString(KEY_ENTRIES, null))

    fun record(
        remoteLabel: String,
        button: String,
        outcome: String,
        invocation: InvocationContext,
        atMillis: Long = System.currentTimeMillis(),
    ) {
        val next = (listOf(AuditEntry(atMillis, remoteLabel, button, outcome, invocation)) + entries())
            .take(MAX_ENTRIES)
        prefs.edit().putString(KEY_ENTRIES, FlipperAuditCodec.encode(next)).apply()
    }

    fun clear() = prefs.edit().remove(KEY_ENTRIES).apply()
}
