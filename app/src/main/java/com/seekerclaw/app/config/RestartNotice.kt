package com.seekerclaw.app.config

import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
import com.seekerclaw.app.util.ProcessRole
import com.seekerclaw.app.util.SafeFs
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.NoSuchFileException
import java.nio.file.Path
import java.nio.file.attribute.BasicFileAttributes
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * BAT-1661 contract v2.12 fold 5′ (Codex `90fed4d6`): the "Restart the agent to apply the change"
 * notice that replaces the automatic restart after a finished reconcile retry.
 *
 * When a reconcile retry ([ReconcileRecord]) finishes a provider or sign-in change (Recovered or
 * Completed), a running agent may still use the old one: Node reads its provider once, at start.
 * Nothing stops or starts the agent automatically. Instead this durable notice targets the saved
 * selection (provider, authType, model), and the dashboard shows it inline with the existing
 * Restart action while the agent is live.
 *
 * - **Created** only inside the model-selection transaction, by the resolver, BEFORE the retry record
 *   is disposed of ([ensure]). A write failure keeps the record (idempotent retry); repeated
 *   Completed outcomes reuse the same notice (identity and timestamp unchanged).
 * - **Invalidated** by a newer explicit Settings selection or a completed Reset, in their
 *   transactions ([invalidate]).
 * - **Cleared** only by a successful agent start whose consumed config selection equals the notice's
 *   ([clearIfStartedOn], `:node`, at the RUNNING transition, under the same lock). A Restart click,
 *   STARTING, or a failed or aborted boot never clears it; a start on another selection keeps it.
 * - The UI re-reads the file after the writer's transaction is released ([refresh]); a queued
 *   older read never overwrites a newer one (revision first).
 *
 * File: `filesDir/model_restart_notice.json`, JSON [Notice] (no secrets: the selection ids only).
 */
object RestartNotice {
    const val NAME = "model_restart_notice.json"
    const val NOTICE_VERSION = 1

    // ------------------------------------------------------------------- log lines (exact)

    /** INFO: a finished change is saved; the running agent needs a restart to use it. */
    fun noticeSaved(provider: String, authType: String, model: String) =
        "[Config] Reconcile finished: the new selection is saved (provider=$provider, authType=$authType, model=$model) — restart the agent to apply it"

    /** WARN, once per process: the notice could not be saved; the retry record is kept and the next load tries again. */
    fun noticeWriteFailed(reason: String) =
        "[Config] Reconcile: restart notice not saved ($reason) — checked again on the next load"

    /**
     * WARN: a notice whose selection is no longer stored (a newer selection, a Reset, a chat
     * `/provider`) could not be removed. It is hidden at once ([visible] uses [isCurrent]) and removed
     * by the next unheld app load ([invalidateIfOrphaned]).
     */
    fun noticeInvalidateFailed(reason: String) =
        "[Config] restart notice not cleared ($reason) — hidden now, removed the next time the app loads"

    /** INFO (`:node`): the agent started on the notice's selection, so the notice is gone. */
    fun noticeCleared(provider: String, authType: String, model: String) =
        "[Config] restart notice cleared: the agent started with provider=$provider, authType=$authType, model=$model"

    /** WARN (`:node`): the agent started on the notice's selection, but the notice could not be removed. */
    fun noticeClearFailed(reason: String) =
        "[Config] restart notice not cleared at start ($reason) — checked again at the next start"

    // ------------------------------------------------------------------------------ shape

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    @Serializable
    data class Notice(
        val version: Int = NOTICE_VERSION,
        /** Stable identity: the same notice across repeated Completed outcomes. */
        val id: String,
        val provider: String,
        val authType: String,
        val model: String,
        val createdAtMs: Long,
    ) {
        val selection: ModelTuple get() = ModelTuple(provider, authType, model)
    }

    sealed class Read {
        object Absent : Read()
        data class Present(val notice: Notice) : Read()
        data class Corrupt(val reason: String) : Read()
        data class Unavailable(val reason: String) : Read()
    }

    fun path(filesDir: Path): Path = filesDir.resolve(NAME)

    /** No lock. Never throws. */
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
            SafeFs.readTextNoFollow(filesDir, p)
        } catch (_: NoSuchFileException) {
            return Read.Absent
        } catch (e: Exception) {
            return Read.Unavailable(e.javaClass.simpleName)
        }
        val n = try {
            json.decodeFromString(Notice.serializer(), text)
        } catch (e: Exception) {
            return Read.Corrupt(e.javaClass.simpleName)
        }
        return if (n.version != NOTICE_VERSION) Read.Corrupt("version ${n.version}") else Read.Present(n)
    }

    // ------------------------------------------------------------------------ test seams

    /** Runs before each checked notice write; a test throws here (a failed notice write). */
    @Volatile internal var beforeWriteForTest: (() -> Unit)? = null

    /** Runs before each checked notice delete; a test throws here (a failed notice clear). */
    @Volatile internal var beforeDeleteForTest: (() -> Unit)? = null

    @Volatile internal var clock: () -> Long = { System.currentTimeMillis() }

    // --------------------------------------------------------------------- the writers

    private val writeFailedLogged = AtomicBoolean(false)

    /**
     * Inside the model-selection transaction, BEFORE the retry record is disposed of: make sure a
     * notice targets [selection]. An existing notice for the same selection is reused unchanged
     * (stable identity and timestamp); any other is replaced. Returns false (WARN once per process)
     * when the checked write failed — the caller then keeps the retry record. MAIN only.
     */
    fun ensure(tx: ModelSelectionLock.Tx, filesDir: Path, selection: ModelTuple): Boolean {
        tx.requireOpen()
        if (ProcessRole.isNode) return false
        val existing = (read(filesDir) as? Read.Present)?.notice
        if (existing != null && existing.selection == selection) return true
        val now = clock()
        val n = Notice(
            id = java.util.UUID.randomUUID().toString(),
            provider = selection.provider,
            authType = selection.authType,
            model = selection.model,
            createdAtMs = now,
        )
        return try {
            beforeWriteForTest?.invoke()
            SafeFs.writeAtomicVerified(filesDir, path(filesDir), json.encodeToString(Notice.serializer(), n).toByteArray(Charsets.UTF_8))
            LogCollector.append(noticeSaved(n.provider, n.authType, n.model))
            true
        } catch (e: Exception) {
            if (writeFailedLogged.compareAndSet(false, true)) {
                LogCollector.append(noticeWriteFailed(e.message ?: e.javaClass.simpleName), LogLevel.WARN)
            }
            false
        }
    }

    /**
     * THE predicate (one function for [visible], [invalidateIfOrphaned] and the MAIN load's self-heal;
     * pinned by ModelSelectionSourceGuardTest): is the notice's selection still STORED? Current while
     * prefs (projected exactly as [ConfigManager.rawPrefsModelTuple] / `projectPrefsTuple` does) OR
     * runtime_state.json (read with the resolver's own rule, [ReconcileRecord.holdsTarget], so its H5
     * guard image counts) hold it. Orphaned only when neither does — e.g. after a chat `/provider B`.
     * Both stores are needed: a Completed resolve can save the notice while prefs are still behind
     * (a failed commit, a tainted process) and runtime_state already holds the change.
     *
     * Orphaned only when PROVEN: both stores were read and neither holds the selection. Anything
     * undecidable — runtime_state [RuntimeStateFile.Read.Unreadable] (a transient read failure as
     * much as bad content), no prefs reader, an exception — counts as current: the notice is kept
     * and shown, never deleted on doubt (a missing restart prompt is worse than a redundant one).
     */
    internal fun isCurrent(n: Notice, prefs: PrefsReader?, filesDir: Path): Boolean = try {
        if (prefs != null && ConfigManager.rawPrefsModelTuple(prefs) == n.selection) {
            true
        } else {
            when (val r = RuntimeStateFile.read(filesDir)) {
                // Known cosmetic residual: a notice for (xai, oauth, m) stays current while runtime_state holds its H5 guard image (xai, api_key, m), also after a chat `/provider xai api_key`; it clears on the next Settings selection or Reset.
                is RuntimeStateFile.Read.Present -> ReconcileRecord.holdsTarget(r.tuple, n.selection) || prefs == null
                // No runtime_state: a boot consumes the prefs selection, which is not the notice's.
                RuntimeStateFile.Read.Missing -> prefs == null
                // Not proven orphaned (often a transient read failure): keep it.
                is RuntimeStateFile.Read.Unreadable -> true
            }
        }
    } catch (_: Exception) {
        true
    }

    /**
     * The selection-writer chokepoint (Codex 90fed4d6 rule 3): after MAIN committed a selection —
     * the end of every unheld locked load (which includes every reconcile commit) and the collector
     * mirror — a notice whose selection neither store holds any more is
     * removed in that same transaction. A notice the same transaction just created is current, so it
     * is never removed by it. Best-effort: a failed delete is the WARN [noticeInvalidateFailed]; the
     * notice is hidden meanwhile ([visible]). MAIN only.
     */
    fun invalidateIfOrphaned(tx: ModelSelectionLock.Tx, filesDir: Path, prefs: PrefsReader) {
        tx.requireOpen()
        if (ProcessRole.isNode) return
        val n = (read(filesDir) as? Read.Present)?.notice ?: return
        if (isCurrent(n, prefs, filesDir)) return
        try {
            beforeDeleteForTest?.invoke()
            SafeFs.deleteChecked(filesDir, path(filesDir))
        } catch (e: Exception) {
            LogCollector.append(noticeInvalidateFailed(e.message ?: e.javaClass.simpleName), LogLevel.WARN)
        }
    }

    /**
     * A newer explicit selection or a completed Reset supersedes any notice (in that writer's
     * transaction). Best-effort: a failure is the WARN [noticeInvalidateFailed]. MAIN only.
     */
    fun invalidate(tx: ModelSelectionLock.Tx, filesDir: Path) {
        tx.requireOpen()
        if (ProcessRole.isNode) return
        if (!SafeFs.existsNoFollow(path(filesDir))) return
        try {
            beforeDeleteForTest?.invoke()
            SafeFs.deleteChecked(filesDir, path(filesDir))
        } catch (e: Exception) {
            LogCollector.append(noticeInvalidateFailed(e.message ?: e.javaClass.simpleName), LogLevel.WARN)
        }
    }

    /**
     * `:node`, at the service's RUNNING transition (a SUCCESSFUL start): clear the notice when the
     * config selection this boot consumed ([consumed]) is the notice's. Under the model-selection lock
     * (bounded; busy = nothing cleared, the next start checks again). A notice for another selection —
     * a newer one created after this boot consumed its config — is never cleared by it. Returns true
     * when a notice was removed.
     */
    fun clearIfStartedOn(filesDir: Path, consumed: ModelTuple): Boolean {
        // Bounded like the xAI sync: three tries; still busy is a WARN, never silent.
        repeat(CLEAR_ATTEMPTS) {
            val r = ModelSelectionLock.transaction { tx -> clearLocked(tx, filesDir, consumed) }
            if (r is ModelSelectionLock.Result.Acquired) return r.value
        }
        LogCollector.append(noticeClearFailed("busy"), LogLevel.WARN)
        return false
    }

    /** [clearIfStartedOn]'s lock attempts (each [ModelSelectionLock.LOCK_TIMEOUT_MS]). */
    internal const val CLEAR_ATTEMPTS = 3

    internal fun clearLocked(tx: ModelSelectionLock.Tx, filesDir: Path, consumed: ModelTuple): Boolean {
        tx.requireOpen()
        val n = (read(filesDir) as? Read.Present)?.notice ?: return false
        if (n.selection != consumed) return false
        return try {
            beforeDeleteForTest?.invoke()
            SafeFs.deleteChecked(filesDir, path(filesDir))
            LogCollector.append(noticeCleared(n.provider, n.authType, n.model))
            true
        } catch (e: Exception) {
            LogCollector.append(noticeClearFailed(e.message ?: e.javaClass.simpleName), LogLevel.WARN)
            false
        }
    }

    // --------------------------------------------------------------------------- the UI

    private val _state = MutableStateFlow<Notice?>(null)

    /** The notice as last read from disk (MAIN). The dashboard collects it. */
    val state: StateFlow<Notice?> = _state.asStateFlow()

    private val revision = AtomicLong()
    private val stateLock = Any()

    /** Test seam: runs between a refresh's read and its store. */
    @Volatile internal var beforeStoreForTest: (() -> Unit)? = null

    /**
     * Re-read the notice for the UI — called after a writer's transaction is released, at app start
     * and when the dashboard's inputs change. Revision first: a refresh whose read is older than a
     * newer refresh's is dropped, so a queued update can never revive a notice a newer selection
     * removed. Reads only the small notice file (no lock).
     */
    fun refresh(filesDir: Path) {
        val rev = revision.incrementAndGet()
        val n = (read(filesDir) as? Read.Present)?.notice
        beforeStoreForTest?.invoke()
        synchronized(stateLock) {
            if (revision.get() == rev) _state.value = n
        }
    }

    /** Where [refreshAsync] reads: a background thread in production; tests run it inline. */
    @Volatile internal var execute: (Runnable) -> Unit = { r -> executor.execute(r) }

    private val executor by lazy {
        java.util.concurrent.Executors.newSingleThreadExecutor { r -> Thread(r, "restart-notice").apply { isDaemon = true } }
    }

    /**
     * [refresh] off the calling thread (callers include main-thread loads). The revision is taken
     * NOW, so a refresh asked for later always wins over this one.
     */
    fun refreshAsync(filesDir: Path) {
        val rev = revision.incrementAndGet()
        execute(Runnable {
            val n = (read(filesDir) as? Read.Present)?.notice
            beforeStoreForTest?.invoke()
            synchronized(stateLock) {
                if (revision.get() == rev) _state.value = n
            }
        })
    }

    /**
     * The cross-process signal (MAIN): `:node` removes the notice at RUNNING ([clearIfStartedOn]) with
     * no message to MAIN, so the dashboard's RUNNING-triggered read can run before that delete and
     * keep showing it. MAIN's one filesDir FileObserver ([com.seekerclaw.app.util.LogCollector])
     * passes every event here; an event on the notice file (its delete, or its atomic write's rename)
     * or an overflow (null name) re-reads it. Takes no lock: [refreshAsync] only reads the file.
     */
    fun handleFilesDirEvent(filesDir: Path, fileName: String?) {
        if (fileName == null || fileName == NAME) refreshAsync(filesDir)
    }

    /**
     * After a model-selection writer released its transaction: re-read the notice for the UI when its
     * resolve finished a change (Recovered or Completed may have created or reused one).
     */
    fun afterRelease(filesDir: Path?, outcome: ReconcileRecord.Outcome?) {
        if (filesDir == null) return
        if (outcome is ReconcileRecord.Outcome.Recovered || outcome is ReconcileRecord.Outcome.Completed) refreshAsync(filesDir)
    }

    /**
     * Fold 5′ UX: shown only while the agent is proven live — RUNNING with a fresh health file (a
     * persisted RUNNING alone can be stale after a crash or reboot) — and only while its selection is
     * still stored ([isCurrent]), so a notice whose delete failed is never shown. A stopped agent
     * picks the saved selection up at its next start, which clears the notice. Reads files: call it
     * off the main thread.
     */
    fun visible(notice: Notice?, running: Boolean, healthStale: Boolean, prefs: PrefsReader?, filesDir: Path): Boolean =
        notice != null && running && !healthStale && isCurrent(notice, prefs, filesDir)

    internal fun resetForTest() {
        beforeWriteForTest = null
        beforeDeleteForTest = null
        beforeStoreForTest = null
        execute = { r -> executor.execute(r) }
        clock = { System.currentTimeMillis() }
        writeFailedLogged.set(false)
        _state.value = null
    }

    /** A new process: the once-per-process WARN gate. */
    internal fun resetProcessMemory() {
        writeFailedLogged.set(false)
    }
}
