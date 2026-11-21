package com.seekerclaw.app.config


import android.util.Log
import com.seekerclaw.app.state.RuntimeStateStore
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
import com.seekerclaw.app.util.ProcessRole
import com.seekerclaw.app.util.SafeFs
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.NoSuchFileException
import java.nio.file.Path
import java.nio.file.attribute.BasicFileAttributes
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * BAT-1661 contract v2.12 (Q16, Codex sign-off `2c3b07c1` with five binding folds): the durable
 * retry record of an interrupted reconcile.
 *
 * `reconcileWithAgentSettings` commits prefs to the overlay's selection and then writes
 * runtime_state.json. When that write and the prefs rollback both fail and MAIN exits, prefs and
 * the overlay agree on the new selection while runtime_state — which Node reads first — keeps the
 * old one, and no later load sees a difference to reconcile. The record describes the transaction
 * (the raw prefs before and after, the target, the captured runtime_state and the adopted overlay
 * evidence) so a later MAIN process can PROVE which state it is in and finish it — it never says
 * "copy prefs into runtime_state".
 *
 * - Written only by the reconcile, before its prefs commit, with a checked write; an unconfirmed
 *   record write means no mutation.
 * - Resolved ([resolve]) only in MAIN, under the [ModelSelectionLock] transaction: first in the
 *   locked load (H1), the collector mirror (H2) and the first-launch seed / toggle (H3). `:node`
 *   only reads it, and holds its start read-only while it is Present or Unavailable (H4).
 * - Deleted by the resolver on positive terminal evidence, after a successful Settings selection
 *   (H5) or a completed Reset (H6). Never because of an exception class (fold 4).
 *
 * Only this object writes or deletes the file.
 */
object ReconcileRecord {
    private const val TAG = "ReconcileRecord"

    const val NAME = "model_reconcile_record.json"
    const val RECORD_VERSION = 1

    const val STATE_PRESENT = "present"
    const val STATE_MISSING = "missing"
    const val STATE_UNREADABLE = "unreadable"
    private val STATES = setOf(STATE_PRESENT, STATE_MISSING, STATE_UNREADABLE)

    // ------------------------------------------------------------------- log lines (§7, exact)

    /** ERROR. The record could not be saved, so the reconcile changed nothing this time. */
    fun recordWriteFailed(reason: String) =
        "[Config] Reconcile: retry record not saved — model or provider change not applied to the app's settings this time ($reason)"

    /** WARN. The reconcile's runtime_state write became visible but was not confirmed durable. */
    const val RUNTIME_UNCONFIRMED =
        "[Config] Reconcile: runtime_state.json written but not confirmed on disk — checked again on the next load"

    /** WARN. A checked delete of the record failed; the next resolve finds it again (idempotent). */
    fun recordClearFailed(reason: String) = "[Config] Reconcile: retry record not cleared ($reason) — cleared on the next load"

    /** WARN. A Corrupt record (deleted, never used). */
    fun recordUnreadable(reason: String) = "[Config] Reconcile: retry record unreadable ($reason) — ignored"

    /** INFO, once per process. */
    const val RECORD_DEFERRED = "[Config] Reconcile: retry waits for the next app start — a settings write failed in this run"

    /** INFO. One of the [DROP_REASONS]. */
    fun recordDropped(reason: String) = "[Config] Reconcile: retry record dropped — $reason"

    const val DROP_NOT_COMMITTED = "the change never reached the app's settings"
    const val DROP_SETTINGS_NEWER = "Settings holds a newer choice"
    const val DROP_OVERLAY_NEWER = "agent_settings.json holds a newer choice"
    const val DROP_RUNTIME_NEWER = "runtime_state.json holds a newer choice"
    fun dropRepairGoverns(provider: String, authType: String) = "a model repair governs $provider/$authType"

    /** INFO. Recovery wrote runtime_state; a provider or sign-in change also saves a [RestartNotice] (fold 5′). */
    fun recovered(provider: String, authType: String, model: String) =
        "[Config] Reconcile finished after a restart: runtime_state.json now provider=$provider, authType=$authType, model=$model"

    /** WARN. */
    fun recoverFailed(reason: String) =
        "[Config] Reconcile not finished after a restart: runtime_state.json not saved ($reason) — retried on the next load"

    /** WARN, `:node` (H4). */
    const val BOOT_HELD =
        "[Config] a model selection change is not finished yet — model settings left as they are this start; opening the app finishes it"

    /** ERROR, a bug signal ([MainPrefs] GuardedEditor). */
    const val APPLY_MODEL_KEYS = "[Config] model selection written with apply()"

    /** WARN, once per process (SAB v54): the record exists but cannot be read; model settings are held. */
    fun recordUnavailable(reason: String) =
        "[Config] Reconcile: retry record not readable ($reason) — model settings left as they are until it can be read"

    /** WARN, once per process (SAB v54): runtime_state.json holds the change but could not be confirmed. */
    fun runtimeConfirmFailed(reason: String) =
        "[Config] Reconcile: runtime_state.json not confirmed on disk ($reason) — model settings left as they are, checked again on the next load"

    /** Once-per-process gates for the two hold WARNs above ([MainPrefs.resetProcessStateForTest] resets them). */
    private val unavailableLogged = AtomicBoolean(false)
    private val confirmFailedLogged = AtomicBoolean(false)

    /** A new process: the once-per-process log gates. */
    internal fun resetProcessMemory() {
        unavailableLogged.set(false)
        confirmFailedLogged.set(false)
        RestartNotice.resetProcessMemory()
    }

    /** WARN: the xAI sign-in sync did not touch runtime_state while a record is unresolved (fold 1). */
    const val XAI_SYNC_HELD =
        "[Config] xAI OAuth runtime_state sync held: a model selection change is not finished yet (or its retry record cannot be read) — force stop the app (Settings > Apps > SeekerClaw) or restart the phone, then sign out and sign in with Grok again; if this repeats after reopening, check Logs for the reconcile warning (often storage) first"

    // ------------------------------------------------------------------------------- shape

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    /** The three prefs selection keys as stored; null = absent. */
    @Serializable
    data class RawTuple(val provider: String?, val authType: String?, val model: String?)

    /** runtime_state.json just before the commit: [state] is present | missing | unreadable. */
    @Serializable
    data class RuntimeCapture(val state: String, val tuple: ModelTuple? = null)

    @Serializable
    data class Record(
        val version: Int = RECORD_VERSION,
        /** The three prefs keys as stored before the commit (null = absent). */
        val prefsBefore: RawTuple,
        /** The same keys as the commit leaves them. */
        val prefsAfter: RawTuple,
        /** The reconciled (provider, authType, model) — before the H5 runtime auth rule. */
        val target: ModelTuple,
        val runtime: RuntimeCapture,
        /** The overlay's `stringField` values the reconcile adopted. */
        val overlay: RawTuple,
        /**
         * Fold 3: the overlay's RAW selection keys at capture, each with its raw JSON text
         * ([ModelRepair.rawSelection]) — presence and value kept apart from the normalised tuple.
         */
        val overlaySelection: Map<String, String>,
    )

    sealed class Read {
        object Absent : Read()
        data class Present(val record: Record) : Read()

        /** Decodes to no valid record (or the path is not a regular file): WARN, deleted, never used. */
        data class Corrupt(val reason: String) : Read()

        /** An I/O failure reading a regular file: kept, never deleted. */
        data class Unavailable(val reason: String) : Read()
    }

    fun path(filesDir: Path): Path = filesDir.resolve(NAME)

    // ------------------------------------------------------------------------- test seams

    /** Runs before the record's bytes are read; a test throws an IOException here (Unavailable). */
    @Volatile internal var beforeReadForTest: (() -> Unit)? = null

    /** Runs before every checked delete of the record; a test throws a crash or an IOException. */
    @Volatile internal var beforeClearForTest: (() -> Unit)? = null

    /** The H5 runtime auth rule ([ConfigManager.runtimeAuthTypeForStored]); a test makes it throw (X5). */
    @Volatile internal var runtimeAuthOf: (String, String) -> String = { p, a -> ConfigManager.runtimeAuthTypeForStored(p, a) }

    // -------------------------------------------------------------------------- read/write

    /** No lock (as `readIntent`). Never throws. */
    fun read(filesDir: Path): Read {
        val p = path(filesDir)
        val attrs = try {
            Files.readAttributes(p, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
        } catch (_: NoSuchFileException) {
            return Read.Absent
        } catch (e: Exception) {
            return Read.Unavailable(e.javaClass.simpleName)
        }
        if (!attrs.isRegularFile) return Read.Corrupt("not a regular file")
        val text = try {
            beforeReadForTest?.invoke()
            SafeFs.readTextNoFollow(filesDir, p)
        } catch (_: NoSuchFileException) {
            return Read.Absent
        } catch (e: Exception) {
            return Read.Unavailable(e.message ?: e.javaClass.simpleName)
        }
        val r = try {
            json.decodeFromString(Record.serializer(), text)
        } catch (e: Exception) {
            return Read.Corrupt(e.javaClass.simpleName)
        }
        return invalidReason(r)?.let { Read.Corrupt(it) } ?: Read.Present(r)
    }

    /**
     * Why [r] is not a record a genuine reconcile writes, or null. A forged or buggy record is never
     * written into runtime_state.
     */
    internal fun invalidReason(r: Record): String? = when {
        r.version != RECORD_VERSION -> "version ${r.version}"
        r.runtime.state !in STATES -> "runtime state ${r.runtime.state}"
        (r.runtime.state == STATE_PRESENT) != (r.runtime.tuple != null) -> "runtime capture"
        r.prefsBefore == r.prefsAfter -> "no prefs change"
        !RuntimeStateStore.isValidPair(r.target.provider, r.target.authType) -> "invalid target pair"
        r.target != ConfigManager.projectPrefsTuple(r.prefsAfter.provider, r.prefsAfter.authType, r.prefsAfter.model) ->
            "target is not the stored selection"
        else -> null
    }

    /** Checked ([SafeFs.writeAtomicVerified]); throws its two types, or IllegalArgumentException for an invalid record. */
    fun write(tx: ModelSelectionLock.Tx, filesDir: Path, record: Record) {
        tx.requireOpen()
        if (ProcessRole.isNode) return
        invalidReason(record)?.let { throw IllegalArgumentException(it) }
        SafeFs.writeAtomicVerified(filesDir, path(filesDir), json.encodeToString(Record.serializer(), record).toByteArray(Charsets.UTF_8))
    }

    /** Checked delete (a link is unlinked, never followed). Throws. */
    fun clear(tx: ModelSelectionLock.Tx, filesDir: Path) {
        tx.requireOpen()
        if (ProcessRole.isNode) return
        beforeClearForTest?.invoke()
        SafeFs.deleteChecked(filesDir, path(filesDir))
    }

    /** [clear], best-effort: a failure is the WARN [recordClearFailed]. Returns true when the record is gone. */
    internal fun clearLogged(tx: ModelSelectionLock.Tx, filesDir: Path): Boolean = try {
        clear(tx, filesDir)
        true
    } catch (e: Exception) {
        LogCollector.append(recordClearFailed(e.message ?: e.javaClass.simpleName), LogLevel.WARN)
        false
    }

    /**
     * H5 / H6: an explicit successful Settings selection, or a fully cleared Reset, supersedes any
     * record. Best-effort: a leftover classifies Superseded (or Completed) at the next resolve.
     */
    fun clearSuperseded(tx: ModelSelectionLock.Tx, filesDir: Path) {
        tx.requireOpen()
        if (!SafeFs.existsNoFollow(path(filesDir))) return
        clearLogged(tx, filesDir)
    }

    // ---------------------------------------------------------------------------- resolve

    sealed class Outcome {
        object None : Outcome()
        data class Superseded(val reason: String) : Outcome()
        data class Completed(val runtime: ModelTuple) : Outcome()
        object NotCommitted : Outcome()
        data class Yielded(val reason: String) : Outcome()
        data class Recovered(val runtime: ModelTuple) : Outcome()

        /** A MAIN prefs commit failed in this process: its cache proves nothing. Nothing written or deleted. */
        object Deferred : Outcome()

        /** The record is kept; nothing else written. */
        data class Failed(val reason: String) : Outcome()

        /** Fold 1: the automatic model-selection work of the caller is held (compute-only). */
        val holds: Boolean get() = this is Deferred || this is Failed
    }

    /**
     * §3: classify the record from fresh evidence and act on it. MAIN only, under [tx]. Never
     * throws (an exception, including from `runtimeAuthTypeForStored`, is [Outcome.Failed] with the
     * record kept), never signals (the callers refresh the UI after their transaction), never marks
     * [tx], and never stops or starts the agent (fold 5′: a finished provider or sign-in change leaves
     * a durable [RestartNotice] instead, written before the record is disposed of).
     *
     * Order: Absent / Corrupt / Unavailable → the overlay holds a newer choice → runtime_state holds
     * the target (confirmed by a rewrite: Completed) → runtime_state holds a third value → Deferred
     * (a failed commit in this process) → NotCommitted (prefs on `prefsBefore`) → Settings holds a
     * newer choice → a model repair governs the target's model → Recover.
     */
    fun resolve(tx: ModelSelectionLock.Tx, filesDir: Path, prefs: PrefsReader): Outcome {
        tx.requireOpen()
        if (ProcessRole.isNode) return Outcome.None // `:node` never classifies: its prefs cache proves nothing
        return try {
            resolveLocked(tx, filesDir, prefs)
        } catch (e: Exception) {
            Outcome.Failed(e.message ?: e.javaClass.simpleName)
        } catch (e: ExceptionInInitializerError) {
            Outcome.Failed(e.javaClass.simpleName)
        }
    }

    private fun resolveLocked(tx: ModelSelectionLock.Tx, dir: Path, prefs: PrefsReader): Outcome {
        val rec = when (val r = read(dir)) {
            Read.Absent -> return Outcome.None
            is Read.Corrupt -> {
                LogCollector.append(recordUnreadable(r.reason), LogLevel.WARN)
                clearLogged(tx, dir)
                return Outcome.None
            }
            is Read.Unavailable -> {
                if (unavailableLogged.compareAndSet(false, true)) LogCollector.append(recordUnavailable(r.reason), LogLevel.WARN)
                return Outcome.Failed("retry record unreadable (${r.reason})")
            }
            is Read.Present -> r.record
        }
        // 2. A newer choice in the overlay (fold 3: raw evidence; D12.7: no selection keys = no evidence).
        if (overlayHoldsNewer(rec, AgentSettingsFile.read(dir))) return dropped(tx, dir, Outcome.Superseded(DROP_OVERLAY_NEWER), DROP_OVERLAY_NEWER)

        // 3–4. runtime_state.
        val rt = RuntimeStateFile.read(dir)
        if (rt is RuntimeStateFile.Read.Present) {
            if (holdsTarget(rt.tuple, rec.target)) return confirm(tx, dir, rec)
            val captured = rec.runtime.tuple.takeIf { rec.runtime.state == STATE_PRESENT }
            if (rt.tuple != captured) return dropped(tx, dir, Outcome.Superseded(DROP_RUNTIME_NEWER), DROP_RUNTIME_NEWER)
        }

        // 5. MAIN's cache counts as disk only while no MAIN prefs commit failed in this process.
        if (MainPrefs.commitFailedThisProcess) {
            if (MainPrefs.deferredLogged.compareAndSet(false, true)) LogCollector.append(RECORD_DEFERRED)
            return Outcome.Deferred
        }
        val now = RawTuple(
            prefs.getString(ConfigManager.KEY_PROVIDER, null),
            prefs.getString(ConfigManager.KEY_AUTH_TYPE, null),
            prefs.getString(ConfigManager.KEY_MODEL, null),
        )
        // 6–7.
        if (now == rec.prefsBefore) return dropped(tx, dir, Outcome.NotCommitted, DROP_NOT_COMMITTED)
        if (now != rec.prefsAfter) return dropped(tx, dir, Outcome.Superseded(DROP_SETTINGS_NEWER), DROP_SETTINGS_NEWER)

        // 8. A standing model repair in the target's scope settles the model itself.
        repairGoverns(dir, prefs, rec.target)?.let { return dropped(tx, dir, Outcome.Yielded(it), it) }

        // 9. Recover: runtime_state still holds the captured tuple, or is Missing / Unreadable.
        return recover(tx, dir, rec)
    }

    private fun dropped(tx: ModelSelectionLock.Tx, dir: Path, out: Outcome, reason: String): Outcome {
        LogCollector.append(recordDropped(reason))
        clearLogged(tx, dir)
        return out
    }

    /**
     * Fold 3 / D12.7: the overlay holds a newer choice when one of its selection keys is PRESENT
     * with raw JSON other than the captured raw value (a newly supplied blank, `null` or non-string
     * value included — never excused by null-equality). An unchanged raw selection is not newer; an
     * absent, unreadable or model-less overlay (no selection key) carries no selection. The
     * scope-changing keys are checked first; a model that equals the target excuses nothing.
     */
    internal fun overlayHoldsNewer(rec: Record, overlay: AgentSettingsFile.Read): Boolean {
        val obj = (overlay as? AgentSettingsFile.Read.Present)?.obj ?: return false
        val now = ModelRepair.rawSelection(obj)
        if (now.isEmpty() || now == rec.overlaySelection) return false
        return listOf("provider", "authType", "model").any { k -> now[k]?.let { it != rec.overlaySelection[k] } == true }
    }

    /** runtime_state holds the target: same provider and model, and the target's auth or its H5 image. */
    internal fun holdsTarget(t: ModelTuple, target: ModelTuple): Boolean {
        if (t.provider != target.provider || t.model != target.model) return false
        if (t.authType == target.authType) return true
        return t.authType == runtimeAuthOf(target.provider, target.authType)
    }

    /** Step 3: prove the visible target durable with a byte-identical rewrite, then Completed. */
    private fun confirm(tx: ModelSelectionLock.Tx, dir: Path, rec: Record): Outcome {
        return try {
            RuntimeStateStore.rewriteVerified(tx)
            val again = (RuntimeStateFile.read(dir) as? RuntimeStateFile.Read.Present)?.tuple
            if (again == null || !holdsTarget(again, rec.target)) throw IOException("runtime_state.json no longer holds the target")
            // Fold 5′: the notice BEFORE the record is disposed of. A notice that cannot be saved
            // keeps the record (Failed; the confirmed runtime bytes stay) — the next resolve retries.
            if (!noticeSaved(tx, dir, rec, again)) return Outcome.Failed("restart notice not saved")
            clearLogged(tx, dir)
            Log.i(TAG, "reconcile retry record completed: runtime_state.json already holds the change")
            Outcome.Completed(again)
        } catch (e: Exception) {
            val reason = e.message ?: e.javaClass.simpleName
            if (confirmFailedLogged.compareAndSet(false, true)) LogCollector.append(runtimeConfirmFailed(reason), LogLevel.WARN)
            Outcome.Failed("runtime_state.json not confirmed ($reason)")
        }
    }

    private fun repairGoverns(dir: Path, prefs: PrefsReader, target: ModelTuple): String? {
        val i = (ModelRepair.readIntent(dir) as? ModelRepair.IntentRead.Present)?.intent ?: return null
        if (i.scope != ModelRepair.Scope(target.provider, target.authType) || i.target == target.model) return null
        val c = ModelRepair.classifyIntent(i, ConfigManager.modelSnapshotFrom(dir, prefs), main = true)
        if (c is ModelRepair.IntentClass.Superseded || c is ModelRepair.IntentClass.Unproven) return null
        return dropRepairGoverns(target.provider, target.authType)
    }

    /** Step 9: write only runtime_state, only the target, with the H5 rule as of now, checked. */
    private fun recover(tx: ModelSelectionLock.Tx, dir: Path, rec: Record): Outcome {
        val t = rec.target
        val auth = runtimeAuthOf(t.provider, t.authType)
        if (!RuntimeStateStore.isValidPair(t.provider, auth)) {
            LogCollector.append(recoverFailed("invalid provider/authType ${t.provider}/$auth"), LogLevel.WARN)
            return Outcome.Failed("invalid pair")
        }
        val written = try {
            // BAT-1663 boundary (Codex v2.12 open question 4, accepted): Node cannot take the model
            // lock, so a Telegram `/provider` that lands between this resolve's checks and the write
            // below can be overwritten in runtime_state. The overlay keeps Node's value, so the next
            // load reconciles to it. No cross-language compare-and-swap is claimed here.
            // Fold 2: the selection fields only, on the current record; the other fields are kept.
            RuntimeStateStore.writeSelectionVerified(tx, t.provider, auth, t.model, customSignature = null)
        } catch (e: Exception) {
            LogCollector.append(recoverFailed(e.message ?: e.javaClass.simpleName), LogLevel.WARN)
            return Outcome.Failed(e.message ?: e.javaClass.simpleName)
        }
        val tuple = ModelTuple(written.provider, written.authType, written.model)
        LogCollector.append(recovered(tuple.provider, tuple.authType, tuple.model))
        // Fold 5′: the notice BEFORE the record is disposed of. Not saved: the record is kept and the
        // runtime_state just written stays (never rolled back); the next resolve finds it Completed
        // and retries the notice.
        if (!noticeSaved(tx, dir, rec, tuple)) return Outcome.Failed("restart notice not saved")
        clearLogged(tx, dir)
        return Outcome.Recovered(tuple)
    }

    /**
     * Fold 5′: does a running agent need a restart to use [now]? Compares the (provider, authType) it
     * may have started on while this record stood — runtime_state as captured (Node reads it first),
     * else the prefs selection before the commit (config.json is built from it) — with the pair
     * runtime_state now durably holds. A model-only correction needs none (the overlay's model reaches
     * Node without one).
     */
    private fun needsRestart(rec: Record, now: ModelTuple): Boolean {
        val from = rec.runtime.tuple?.takeIf { rec.runtime.state == STATE_PRESENT }?.let { it.provider to it.authType }
            ?: ConfigManager.projectPrefsTuple(rec.prefsBefore.provider, rec.prefsBefore.authType, rec.prefsBefore.model)
                .let { it.provider to it.authType }
        return from != (now.provider to now.authType)
    }

    /**
     * Fold 5′: when [now] needs a restart, the durable notice for the SELECTION ([Record.target]: the
     * provider, sign-in type and model the user chose — what a boot consumes as its config) is saved
     * before the record goes. Returns false when that write — or, for a notice already there, its
     * confirming byte-identical rewrite — failed: the record is then kept.
     */
    private fun noticeSaved(tx: ModelSelectionLock.Tx, dir: Path, rec: Record, now: ModelTuple): Boolean =
        !needsRestart(rec, now) || RestartNotice.ensure(tx, dir, rec.target)

    /** Test seam: this object's seams and its restart bookkeeping (`@Before` / `@After`). */
    internal fun resetForTest() {
        beforeReadForTest = null
        beforeClearForTest = null
        unavailableLogged.set(false)
        confirmFailedLogged.set(false)
        runtimeAuthOf = { p, a -> ConfigManager.runtimeAuthTypeForStored(p, a) }
        RestartNotice.resetForTest()
    }
}
