package com.seekerclaw.app.flipper

import android.content.Context
import com.seekerclaw.app.util.CrossProcessStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
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
/** On-disk envelope, holding the Base64 blob from [FlipperAuditCodec]. */
@Serializable
internal data class FlipperAuditRecord(val blob: String = "")

class FlipperAuditLog private constructor(context: Context) {

    companion object {
        private const val FILE_NAME = "flipper_audit.json"

        @Volatile private var instance: FlipperAuditLog? = null

        /**
         * The one audit log for this process.
         *
         * Process-scoped for the same reason as [FlipperEnrollmentStore.get]: every
         * [CrossProcessStore] registers a `FileObserver` on `filesDir` plus a broadcast receiver,
         * and the log must outlive any one screen — the controller in `:node` writes to it whether
         * or not Settings is open.
         */
        fun get(context: Context): FlipperAuditLog =
            instance ?: synchronized(this) {
                instance ?: FlipperAuditLog(context.applicationContext).also { instance = it }
            }

        /**
         * Kept small on purpose. This exists so a user can check what the agent did recently, not
         * to be a forensic archive, and an unbounded list would grow without limit.
         */
        private const val MAX_ENTRIES = 200

        /**
         * Defensive caps on what a single entry may carry.
         *
         * Both fields originate in model-supplied tool input. They are already rejected by the
         * allowlist before a press happens, but a *rejected* attempt is recorded too — so without
         * a cap, a long label would be decoded and re-encoded on every subsequent operation.
         */
        private const val MAX_FIELD_CHARS = 64
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // Written by the controller in `:node`, read by Settings in the main process — so this has the
    // same cross-process requirement as the enrollment store, and for the same reason:
    // SharedPreferences would leave the UI showing a log that never gained the newest entries.
    private val cps = CrossProcessStore(
        context = context.applicationContext,
        fileName = FILE_NAME,
        serializer = FlipperAuditRecord.serializer(),
        initial = FlipperAuditRecord(),
        parentScope = scope,
    )

    /**
     * Newest first.
     *
     * Sorted on read rather than trusting insertion order. Each [record] is atomic against the
     * others, so no entry is lost — but the writes are independent coroutines, so two presses
     * landing close together can be *stored* in the opposite order to the one they happened in.
     * The timestamps are always right, so ordering by them is both cheap and authoritative, and it
     * avoids an audit log that quietly misrepresents the sequence of physical actions.
     */
    fun entries(): List<AuditEntry> =
        FlipperAuditCodec.decode(cps.state.value.blob).sortedByDescending { it.timestampMillis }

    /**
     * Appends one entry.
     *
     * ### The whole read-modify-write happens inside the transform
     *
     * The obvious shape — decode the current list here, prepend, encode, then hand the finished
     * blob to `update { }` — loses entries. [CrossProcessStore.update] applies its transform to the
     * state it re-reads under its own write lock; a transform that ignores that input and returns a
     * blob captured earlier overwrites whatever landed in between. Two overlapping presses would
     * both read the same base list and the second write would erase the first entry, so a press
     * that physically happened would have no record. `clear()` racing a `record()` could likewise
     * resurrect a cleared log.
     *
     * Doing the decode, prepend, cap and encode inside the lambda makes each append atomic against
     * every other mutation of this store. The cost is decoding on the IO thread instead of the
     * caller's, which is where it belonged anyway.
     */
    fun record(
        remoteLabel: String,
        button: String,
        outcome: String,
        invocation: InvocationContext,
        atMillis: Long = System.currentTimeMillis(),
    ) {
        val entry = AuditEntry(
            timestampMillis = atMillis,
            remoteLabel = remoteLabel.take(MAX_FIELD_CHARS),
            button = button.take(MAX_FIELD_CHARS),
            outcome = outcome,
            invocation = invocation,
        )
        scope.launch {
            cps.update { record ->
                val next = (listOf(entry) + FlipperAuditCodec.decode(record.blob)).take(MAX_ENTRIES)
                FlipperAuditRecord(FlipperAuditCodec.encode(next))
            }
        }
    }

    fun clear() {
        scope.launch { cps.update { FlipperAuditRecord() } }
    }
}
