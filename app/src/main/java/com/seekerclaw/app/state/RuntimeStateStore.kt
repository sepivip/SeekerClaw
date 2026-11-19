package com.seekerclaw.app.state

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import com.seekerclaw.app.config.MainPrefs
import com.seekerclaw.app.config.ModelRegistry
import com.seekerclaw.app.config.ModelSelectionLock
import com.seekerclaw.app.util.CrossProcessStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Singleton that owns the cross-process [RuntimeState] (BAT-513,
 * BAT-511 family).
 *
 * Wraps [CrossProcessStore] with three responsibilities:
 *
 *  1. **Validity gate.** The provider/authType matrix is enforced at
 *     [write] / [update] (throws [IllegalArgumentException] BEFORE
 *     persistence) AND on every observed emission from the underlying
 *     store (`:node`-side writes, manual file edits — anything we don't
 *     control). An invalid state never reaches [state] and never reaches
 *     [SharedPreferences]; the file-on-disk keeps the bad value (Node's
 *     responsibility to fix at its write site), prefs and UI stay at the
 *     last-valid value, the event is logged at WARN.
 *
 *  2. **Rollback-shadow mirror to legacy [SharedPreferences].** Pre-
 *     BAT-513 builds (and the not-yet-migrated parts of the BAT-513
 *     build) read provider/auth_type/model from prefs. The mirror keeps
 *     prefs in sync with the file so a downgrade doesn't lose a value
 *     the user changed under BAT-513 — including changes that
 *     originated on the Node side via Telegram `/provider` or `/model`.
 *     The mirror is one-directional (prefs are never written back to
 *     the file), so no loop is possible. Redundancy guard: identical
 *     mirrors collapse to a no-op so observing the same value 100×
 *     doesn't generate 100 prefs writes.
 *
 *  3. **UI-safe StateFlow.** [state] is a wrapper StateFlow, NOT a
 *     direct alias of the underlying store's StateFlow. Invalid
 *     observed values are filtered out so the UI never sees a
 *     transiently-corrupt file; it sticks with the last valid value
 *     until a fresh valid one lands.
 *
 * ## Init ordering
 *
 *  1. Read prefs FIRST (the BAT-513 build's source of truth on
 *     upgrade — prefs were written by the pre-BAT-513 code path).
 *  2. If `runtime_state.json` is missing, write the prefs values into
 *     it (the upgrade migration). This is a one-shot — subsequent
 *     launches see the file and skip this step.
 *  3. THEN start the observe-and-mirror collector.
 *
 * ## First-emission behaviour by install path
 *
 *  - **Upgrade path** (prefs already populated by pre-BAT-513 code):
 *    seedFromPrefs returns the persisted values; the migration
 *    write puts the same values into the file; the first observed
 *    emission equals current prefs; [mirrorIfChanged]'s redundancy
 *    guard yields `false → false → false` and no `apply()` runs.
 *    Clean — no spurious prefs write or signalConfigChanged.
 *  - **Fresh-install path** (prefs absent): `prefs.getString(KEY_*,
 *    null)` returns `null`; seedFromPrefs uses defaults
 *    (the `RuntimeState()` defaults) since no key is present;
 *    the migration write puts those defaults into the file; the
 *    first observed emission compares default strings against
 *    `null` prefs values → mismatch → ONE prefs `apply()` runs +
 *    ONE signalConfigChanged broadcast fires to seed the legacy
 *    keys. This is correct, idempotent (subsequent launches hit
 *    the upgrade path), and matches what saveConfig would do on
 *    the first user-initiated save anyway. NOT a spurious write.
 *
 * The "subsequent launches" steady state always yields zero
 * apply()s.
 *
 * ## What this does NOT do
 *
 *  - Does NOT manage credentials. API keys / OAuth tokens / setup
 *    tokens stay in [com.seekerclaw.app.config.KeystoreHelper]-backed
 *    prefs for now (BAT-516 will migrate those with an encryption
 *    layer).
 *  - Does NOT trigger service restart on provider change. Callers own
 *    that (Settings save handler, `/provider` Telegram command). Live
 *    provider switching would require per-turn provider resolution in
 *    every adapter — explicitly out of scope for BAT-513.
 *  - Does NOT replace [com.seekerclaw.app.config.ConfigManager] as the
 *    general broadcaster for app-wide config changes. The collector
 *    DOES call [com.seekerclaw.app.config.ConfigManager.signalConfigChanged]
 *    when a runtime-state mirror lands (so in-process Compose screens
 *    that read prefs via `loadConfig` recompose, and other-process
 *    observers receive `ACTION_CONFIG_CHANGED`) — that's the narrow
 *    cross-process refresh path for the three runtime fields, NOT a
 *    catch-all. Existing
 *    [com.seekerclaw.app.config.ConfigManager.broadcastConfigChanged]
 *    paths still apply for everything else (saveConfig writes,
 *    reconcile, OAuth saves, individual setters).
 */
object RuntimeStateStore {
    private const val TAG = "RuntimeStateStore"
    private const val FILE_NAME = "runtime_state.json"
    private const val KEY_PROVIDER = "provider"
    private const val KEY_AUTH_TYPE = "auth_type"
    private const val KEY_MODEL = "model"

    /** BAT-1661: bumped by [commitModelChecked] so its commit is always a real disk write. */
    private const val KEY_MODEL_COMMIT_SEQ = "model_commit_seq"

    /** BAT-1661: the collector's mirror waits this long for the model-selection lock (IO thread). */
    private const val MIRROR_LOCK_TIMEOUT_MS = 5_000L

    private val initialized = AtomicBoolean(false)
    private val _state = MutableStateFlow(RuntimeState())
    private var appContext: Context? = null

    /**
     * Last valid [RuntimeState] observed. UI binds to this; invalid
     * file content (Node-side bug, manual edit, future-build values
     * with an unknown provider/authType combo) is filtered out so the
     * UI never sees a transiently-bad state.
     */
    val state: StateFlow<RuntimeState> = _state.asStateFlow()

    /**
     * `true` once [init] has wired up the cross-process store. Callers
     * that run in BOTH processes (e.g. ConfigManager.reconcileWithAgentSettings
     * fires in main AND `:node`) can gate work that's main-only — the
     * `:node` process never calls [init], so [write] would always
     * return `false` there, producing log noise + a no-op write.
     * Telegram-originated writes from `:node` go directly to
     * runtime_state.json via runtime-state.js, so the reconcile path
     * is genuinely a main-process-only mirror.
     */
    val isInitialized: Boolean get() = store != null

    private var ownedScope: CoroutineScope? = null
    private var store: CrossProcessStore<RuntimeState>? = null

    /** `filesDir`, for the pending-repair check in [mirrorFromDisk] (BAT-1661). */
    private var filesDir: File? = null

    /**
     * BAT-1661: MAIN's prefs, for the field-local toggles' seed ([updateInOwnTransaction]) — the
     * same handle [init] hands to the collector. Null before [init] and in `:node`.
     */
    private var prefs: SharedPreferences? = null
    // No `prefs` field — internal helpers (seedFromPrefs, mirrorIfChanged,
    // onObserved) take SharedPreferences as a parameter so unit tests can
    // inject a fake without instantiating the singleton's full graph. The
    // production [init] captures `sp` locally and threads it into the
    // collector lambda directly.

    /**
     * Idempotent. Call once from `SeekerClawApplication.onCreate`.
     *
     * Re-calling does nothing — the `initialized` flag guards against
     * double-init in unit tests that share the singleton across cases
     * and against a future caller mistakenly invoking it twice.
     */
    fun init(context: Context) {
        if (!initialized.compareAndSet(false, true)) return
        val app = context.applicationContext
        appContext = app
        filesDir = app.filesDir
        // BAT-1157: MAIN-only (see SeekerClawApplication); the collector mirror writes prefs.
        val sp = MainPrefs.forWrite(app, "RuntimeStateStore.init") ?: return
        prefs = sp
        // BAT-1661: init runs on the main thread — no credential I/O here. The in-memory seed takes
        // prefs as stored (no xAI H5 decision, which decrypts; the on-disk seed applies it, on IO),
        // and its first projection uses the stored auth. The credential-aware projection follows
        // off the main thread ([refreshDisplay] in the coroutine below, then every emission).
        val seeded = seedFromPrefs(sp, gateXai = false)
        publish(seeded, withCredentials = false)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        ownedScope = scope
        val cps = CrossProcessStore(
            context = app,
            fileName = FILE_NAME,
            serializer = RuntimeState.serializer(),
            initial = seeded,
            parentScope = scope,
        )
        store = cps
        // BAT-513 round-17: migration write moves to the owned IO
        // scope. init() runs on Application.onCreate (main thread);
        // CrossProcessStore.write does disk I/O (tmp write +
        // Files.move) which would trip StrictMode and add startup
        // jank if invoked synchronously here.
        //
        // Sequencing inside the launch:
        //   1. Migration: if runtime_state.json is missing, write the
        //      seeded value (from prefs, or defaults on fresh
        //      install).
        //   2. Start the observe-and-mirror collector AFTER the
        //      migration completes. On UPGRADE paths the first
        //      emission equals prefs (redundancy guard yields no-op
        //      apply); on FRESH-INSTALL paths the first emission
        //      equals defaults but prefs are absent, so the
        //      redundancy guard fires ONE apply() to seed legacy
        //      keys + ONE signalConfigChanged broadcast (correct,
        //      idempotent — see class KDoc "First-emission behaviour
        //      by install path" for the full breakdown).
        //
        // Trade-off: there's a brief window between Application.onCreate
        // and the migration landing where runtime_state.json doesn't
        // exist on first install. _state is already seeded
        // synchronously above (line 131) so UI bound to
        // RuntimeStateStore.state sees the right value immediately;
        // the `:node` side falls back to config.json (same values
        // from prefs as the seed), so no functional regression.
        //
        // Migration failure is logged but non-fatal: the app proceeds
        // with the seeded in-memory state, and a later user-initiated
        // save (Settings UI / Telegram /provider /model) retries the
        // file write.
        scope.launch {
            // The first credential-aware projection, on IO: the usable-key signal (it decrypts),
            // then the projection.
            noteOpenAIKeyUsable(com.seekerclaw.app.config.ConfigManager.openaiKeyUsable(MainPrefs.view(sp)))
            refreshDisplay()
            if (!seedIfMissing(app.filesDir, sp) { cps.write(it) }) {
                Log.w(
                    TAG,
                    "first-launch migration write to $FILE_NAME failed — " +
                        "app proceeds with in-memory seed; :node will fall back to config.json " +
                        "until a later write succeeds (Settings save / Telegram /provider /model)",
                )
            }
            cps.state.collect { observed -> observeFromCollector(observed, sp) }
        }
    }

    /**
     * First-launch migration: create runtime_state.json from prefs when it is missing. Returns
     * false only when the write was attempted and failed.
     *
     * BAT-1661 (Codex diff review #4): a runtime_state.json write, so it runs under the
     * model-selection lock and decides from what is there NOW — the file is re-checked and prefs
     * re-read inside the transaction, never a tuple captured earlier (which can predate a start-up
     * repair in `:node`). A busy lock defers the seed: a later launch or the first save creates the
     * file, and until then `:node` falls back to config.json.
     *
     * Contract v2.8 §3 / v2.9 §3: the repair intent is classified first.
     *  - `pending` — the repair owns the stores: nothing is seeded.
     *  - handed off (`awaiting_main` / `converged`) and still holding (Holds or EvidenceLost, so the
     *    target is proven) — seeded from the intent's (provider, authType, target) with a checked
     *    write, never from the retired prefs model. Not while the OpenAI transport is not the
     *    sign-in (MAIN does not finalise then).
     *  - Superseded, Unproven, Corrupt — nothing is seeded; the next locked load deals with it.
     */
    internal fun seedIfMissing(filesDir: File, sp: SharedPreferences, write: (RuntimeState) -> Boolean): Boolean {
        val r = ModelSelectionLock.transaction(MIRROR_LOCK_TIMEOUT_MS) { tx ->
            if (File(filesDir, FILE_NAME).exists()) return@transaction true
            seedInTx(tx, filesDir, sp, write)
        }
        return when (r) {
            is ModelSelectionLock.Result.Acquired -> r.value
            is ModelSelectionLock.Result.Busy -> {
                Log.w(TAG, "first-launch seed deferred: model-selection lock busy (${r.reason})")
                true
            }
        }
    }

    /**
     * The seed decision of [seedIfMissing] (contract v2.8 §3), inside [tx], whatever is on disk now.
     * Returns false only when a write was attempted and failed; a skipped seed returns true.
     */
    private fun seedInTx(
        tx: ModelSelectionLock.Tx,
        filesDir: File,
        sp: SharedPreferences,
        write: (RuntimeState) -> Boolean,
    ): Boolean {
        tx.requireOpen()
        val dir = filesDir.toPath()
        return when (val intent = com.seekerclaw.app.config.ModelRepair.readIntent(dir)) {
            com.seekerclaw.app.config.ModelRepair.IntentRead.Absent -> write(seedNoIntent(sp, dir))
            is com.seekerclaw.app.config.ModelRepair.IntentRead.Present -> seedFromIntent(tx, dir, sp, intent.intent)
            is com.seekerclaw.app.config.ModelRepair.IntentRead.Corrupt -> {
                Log.i(TAG, "first-launch seed skipped: the model repair record is unreadable")
                true
            }
        }
    }

    /**
     * Contract v2.8 ("No intent: today's seed order, overlay then prefs"), Codex Q8 (58e426b6): the
     * provider and auth from prefs, the model from an APPLICABLE overlay when it holds a non-blank
     * string model (no registry check: an off-list custom id is kept, as Node's dispatch keeps it) —
     * else prefs'. Applicable: its `provider` absent or equal to prefs', and its `authType` absent or
     * equal to prefs' (the selected auth). A foreign, unreadable or model-less overlay, or prefs
     * whose pair is invalid, fall back to [seedFromPrefs]. The H5 auth rule applies to the tuple
     * either way ([seedFromPrefs]). Runs inside the caller's transaction.
     */
    internal fun seedNoIntent(sp: SharedPreferences, dir: java.nio.file.Path): RuntimeState {
        val base = seedFromPrefs(sp)
        val provider = sp.getString(KEY_PROVIDER, null) ?: return base
        val auth = sp.getString(KEY_AUTH_TYPE, null) ?: return base
        // CodeRabbit on aefe5f82: an invalid prefs pair keeps the FULL default (seedFromPrefs), never
        // the default provider with an overlay's model. A valid xAI OAuth pair still takes the overlay
        // model, with the H5 auth seedFromPrefs applied.
        if (!isValidPair(provider, auth)) return base
        val ov = (com.seekerclaw.app.config.AgentSettingsFile.read(dir) as? com.seekerclaw.app.config.AgentSettingsFile.Read.Present)?.obj
            ?: return base
        val p = com.seekerclaw.app.config.AgentSettingsFile.stringField(ov, "provider")
        val a = com.seekerclaw.app.config.AgentSettingsFile.stringField(ov, "authType")
        val m = com.seekerclaw.app.config.AgentSettingsFile.stringField(ov, "model") ?: return base
        if (p != null && p != provider) return base
        if (a != null && a != auth) return base
        return base.copy(model = m)
    }

    /** [seedIfMissing] with a repair intent on disk; see its KDoc. */
    private fun seedFromIntent(
        tx: ModelSelectionLock.Tx,
        dir: java.nio.file.Path,
        sp: SharedPreferences,
        i: com.seekerclaw.app.config.ModelRepair.RepairIntent,
    ): Boolean {
        tx.requireOpen()
        if (i.state == com.seekerclaw.app.config.ModelRepair.STATE_PENDING) {
            Log.i(TAG, "first-launch seed skipped: a model repair is pending")
            return true
        }
        val s = com.seekerclaw.app.config.ConfigManager.modelSnapshotFrom(dir, MainPrefs.view(sp))
        val c = com.seekerclaw.app.config.ModelRepair.classifyIntent(i, s, main = true)
        val holds = c is com.seekerclaw.app.config.ModelRepair.IntentClass.Holds ||
            c is com.seekerclaw.app.config.ModelRepair.IntentClass.EvidenceLost
        if (!holds || s.transport != i.scope) {
            Log.i(TAG, "first-launch seed skipped: the model repair record is left to the next load ($c)")
            return true
        }
        return try {
            com.seekerclaw.app.config.RuntimeStateFile.writeTupleVerified(
                tx,
                dir,
                com.seekerclaw.app.config.ModelTuple(i.provider, i.authType, i.target),
            )
            true
        } catch (e: Exception) {
            Log.w(TAG, "first-launch seed from the model repair failed: ${e.message}")
            false
        }
    }

    /**
     * Production-side wrapper around [onObserved]: also fires
     * [com.seekerclaw.app.config.ConfigManager.signalConfigChanged]
     * when the mirror actually changed prefs, so existing Compose
     * screens that read prefs via `ConfigManager.loadConfig` (and
     * recompose on `configVersion`) auto-refresh after a
     * `:node`-originated write. The broadcast is a no-op for
     * redundant emissions (mirrorIfChanged returned false → nothing
     * to refresh).
     */
    /**
     * The collector's mirror, under the lock: the record on disk now, never a fallback. When the
     * file is missing or does not decode, [CrossProcessStore.read] would return the launch-time
     * seed, and mirroring that would revert newer prefs; nothing is mirrored then (CodeRabbit,
     * PR #465). Returns true when prefs changed.
     *
     * While a model repair is pending in the record's scope, prefs are written only when the
     * record already holds the repair's target — the same rule as the load's same-scope sync
     * ([syncPrefsFromFile] `onlyTo`). Otherwise mirroring would overwrite the retired prefs model
     * the repair decides from (CodeRabbit on f943231d). The display still follows the record.
     */
    internal fun mirrorFromDisk(tx: ModelSelectionLock.Tx, sp: SharedPreferences): Boolean {
        tx.requireOpen()
        val onDisk = store?.readOrNull() ?: return false
        // CodeRabbit on 444ba220: the decoder fills a missing field with its default, so a partial
        // record (e.g. only `reasoningEnabled`) decodes to the DEFAULT model tuple. Mirror only a
        // tuple the file really holds — the one Node's config.js would read (RuntimeStateFile).
        val dir = filesDir?.toPath()
        if (dir != null) {
            val raw = (com.seekerclaw.app.config.RuntimeStateFile.read(dir) as? com.seekerclaw.app.config.RuntimeStateFile.Read.Present)?.tuple
            if (raw == null || raw != com.seekerclaw.app.config.ModelTuple(onDisk.provider, onDisk.authType, onDisk.model)) {
                Log.w(TAG, "prefs mirror skipped: $FILE_NAME holds no complete model selection")
                return false
            }
        }
        val pending = pendingRepair(sp)
        if (pending != null && onDisk.provider == pending.provider && onDisk.authType == pending.authType &&
            onDisk.model != pending.target
        ) {
            if (isValidPair(onDisk.provider, onDisk.authType)) publish(onDisk)
            Log.i(TAG, "prefs mirror held: a model repair is pending (target ${pending.target})")
            return false
        }
        // BAT-1661 (CodeRabbit on ca06bb79 / ab6385bd, Codex Q12): a record whose auth is only the
        // BAT-1124 H5 guard image of the prefs selection is the SAME selection: mirroring its auth
        // would undo the user's oauth choice. Keep prefs' auth. ONE rule decides it, the one
        // ConfigManager.bootSelection uses: ConfigManager.isXaiGuardImage — a guard image unless
        // agent_settings.json explicitly holds xai/api_key (Node's `/provider xai api_key` writes it
        // before runtime_state, so that choice IS mirrored). Token state is not consulted, so a
        // sign-in landing before this mirror cannot turn the old guard into an "explicit" choice.
        // (syncPrefsFromFile is stricter: any auth difference is a mismatch and syncs nothing.)
        val curProvider = sp.getString(KEY_PROVIDER, null)
        val curAuth = sp.getString(KEY_AUTH_TYPE, null)
        // Only for an xAI prefs selection: another provider's pair is never mixed with the xAI guard
        // (isXaiGuardImage may also read a fresh xai/oauth overlay as the selection). A guard image
        // IS the OAuth selection, so `oauth` is mirrored.
        val guardImage = curProvider == "xai" && curAuth != null && dir != null &&
            com.seekerclaw.app.config.ConfigManager.isXaiGuardImage(dir, curProvider, curAuth, onDisk.provider, onDisk.authType)
        return onObserved(if (guardImage) onDisk.copy(authType = "oauth") else onDisk, sp)
    }

    /**
     * [com.seekerclaw.app.config.ModelRepair.pendingRepair] from the stores as they are now (the
     * intent classified first, read-only; contract v2.9 §3); null when none.
     */
    private fun pendingRepair(sp: SharedPreferences): com.seekerclaw.app.config.ModelRepair.RepairIntent? {
        val dir = filesDir?.toPath() ?: return null
        return try {
            com.seekerclaw.app.config.ModelRepair.pendingRepair(
                dir,
                com.seekerclaw.app.config.ConfigManager.modelSnapshotFrom(dir, MainPrefs.view(sp)),
                main = true,
            )
        } catch (_: IllegalStateException) {
            null // registry not initialised (unit tests)
        }
    }

    private fun observeFromCollector(observed: RuntimeState, sp: SharedPreferences) {
        // Single chokepoint via onObserved (BAT-513 round-14): the
        // pure-logic gate (validity check, _state update, prefs
        // mirror, redundancy guard) lives in onObserved so unit tests
        // and production share the exact same code path. This wrapper
        // adds only the production-side concern: cross-process
        // broadcast on a successful mirror. If onObserved drifts in
        // the future, both paths drift together.
        //
        // BAT-1661: the mirror writes prefs provider/auth_type/model, so it runs under the
        // model-selection lock, and mirrors the file as it is NOW (re-read under the lock), not
        // the possibly older emission — a stale emission must never revert a newer save. This
        // runs on the collector's IO thread, so it may wait longer than a UI save would.
        val r = ModelSelectionLock.transaction(MIRROR_LOCK_TIMEOUT_MS) { tx -> mirrorFromDisk(tx, sp) }
        val applied = when (r) {
            is ModelSelectionLock.Result.Acquired -> r.value
            is ModelSelectionLock.Result.Busy -> {
                // Display still follows the file; prefs catch up on the next emission, or on the
                // next locked load (ConfigManager syncs prefs from the file before reconciling).
                if (isValidPair(observed.provider, observed.authType)) publish(observed)
                Log.w(TAG, "prefs mirror deferred: model-selection lock busy (${r.reason})")
                false
            }
        }
        if (applied) {
            appContext?.let { com.seekerclaw.app.config.ConfigManager.signalConfigChanged(it) }
        }
    }

    /**
     * BAT-1661: inside a locked load (main process), bring the prefs MODEL up to date from
     * runtime_state.json before reconcile reads it. Main-process prefs are a per-process cache
     * that a `:node` write (the start-up repair) never refreshes; a stale prefs model would make
     * reconcile treat the repaired overlay model as an outside change and clamp it.
     *
     * Narrow on purpose (Codex diff review #3):
     *  - the model only, and only when the file's provider AND auth type equal the ones in prefs.
     *    runtime_state's auth may differ by design (the xAI oauth-without-token → api_key boot
     *    guard, [com.seekerclaw.app.config.ConfigManager.runtimeAuthTypeFor]); copying it into
     *    prefs would undo the user's selected auth, and reconcile would write it back on every
     *    load — a write and Settings-reload loop;
     *  - only from a record actually read from the file: no file, an unparsable one, or an invalid
     *    pair syncs nothing (never the in-memory fallback seed);
     *  - a blank model is never synced (Node treats it as absent);
     *  - committed synchronously; a failed commit flags [tx] ([ModelSelectionLock.Tx.writeFailed])
     *    and puts the old value back in the cache ([MainPrefs.commitOrRestore]), so the next load
     *    sees the difference and retries;
     *  - [onlyTo] non-null (a model repair is pending, decided by the caller before this sync):
     *    only a sync TO that target runs. Any other value would overwrite the retired prefs model
     *    the repair decides from (CodeRabbit on PR #465).
     *
     * Returns true when the prefs model changed.
     */
    fun syncPrefsFromFile(
        tx: ModelSelectionLock.Tx,
        filesDir: java.nio.file.Path,
        prefs: SharedPreferences,
        onlyTo: String? = null,
    ): Boolean {
        tx.requireOpen()
        val file = com.seekerclaw.app.config.RuntimeStateFile.readTuple(filesDir) ?: return false
        if (file.provider != prefs.getString(KEY_PROVIDER, null)) return false
        if (file.authType != prefs.getString(KEY_AUTH_TYPE, null)) return false
        // Node treats a blank runtime model as absent (it falls back), so it is never synced.
        if (file.model.isBlank()) return false
        if (file.model == prefs.getString(KEY_MODEL, null)) return false
        if (onlyTo != null && file.model != onlyTo) return false
        if (!MainPrefs.commitOrRestore(MainPrefs.edit(prefs).putString(KEY_MODEL, file.model))) {
            tx.markWriteFailed()
            Log.w(TAG, "prefs model sync from $FILE_NAME not committed")
            return false
        }
        return true
    }

    /**
     * BAT-1661 (review Minor 1): a REAL, checked commit of the prefs model. After a failed
     * `commit()` the in-memory map already holds the new value, so a later commit that changes
     * nothing may be skipped and a read-back sees memory, not disk. The model is re-put with a
     * bumped [KEY_MODEL_COMMIT_SEQ] (the `KEY_LEGACY_SWEEP_SEQ` pattern), so the commit always writes.
     * Returns the commit's result; false also marks [tx].
     */
    fun commitModelChecked(tx: ModelSelectionLock.Tx, prefs: SharedPreferences, model: String): Boolean {
        tx.requireOpen()
        val seq = prefs.getLong(KEY_MODEL_COMMIT_SEQ, 0L) + 1L
        val ok = MainPrefs.commitOrRestore(MainPrefs.edit(prefs).putString(KEY_MODEL, model).putLong(KEY_MODEL_COMMIT_SEQ, seq))
        if (!ok) {
            tx.markWriteFailed()
            Log.w(TAG, "prefs model commit before convergence failed")
        }
        return ok
    }

    /**
     * BAT-1661 (contract v2.4 §0): the state the UI shows. A model the transport can no longer use
     * shows as the provider default — what Node actually sends. Display only: the prefs mirror and
     * every write use the stored value.
     *
     * Codex review of ca06bb79 #4: the retirement scope is the TRANSPORT (Node's `_EFFECTIVE_AUTH`),
     * which for OpenAI oauth depends on credentials the tuple does not hold — a usable sign-in
     * (OpenAIOAuthTokenStore) and a saved API key (MAIN prefs). Read here, not inferred from the
     * tuple; [refreshDisplay] re-projects when they change.
     */
    internal fun forDisplay(s: RuntimeState): RuntimeState {
        val shown = try {
            ModelRegistry.applyRetiredModelRule(s.provider, displayAuthOf(s), s.model)
        } catch (_: IllegalStateException) {
            s.model // registry not initialised (unit tests)
        }
        return if (shown == s.model) s else s.copy(model = shown)
    }

    /** [com.seekerclaw.app.config.ConfigManager.displayAuth] with the credentials as they are now. */
    private fun displayAuthOf(s: RuntimeState): String {
        if (s.provider != "openai" || s.authType != "oauth") return s.authType
        return try {
            // The sign-in Node can use: the load's own resolution, legacy fallback included (shared).
            val usable = prefs?.let { com.seekerclaw.app.config.ConfigManager.openAIOAuthUsableReadOnly(MainPrefs.view(it)) } ?: false
            // Codex 7ec40d8b #1: the key Node can USE (decrypted, normalised), as AppConfig.displayModel
            // reads it — recorded by the load / save / the background read ([noteOpenAIKeyUsable]),
            // never the ciphertext's presence (a key that does not decrypt is no key for Node).
            val key = openaiKeyUsable == true
            com.seekerclaw.app.config.ConfigManager.displayAuth(s.provider, s.authType, usable, key)
        } catch (e: Exception) {
            Log.w(TAG, "display transport not decided (${e.javaClass.simpleName}) — selected auth used")
            s.authType
        }
    }

    /**
     * BAT-1661 (Codex 7ec40d8b #1): whether the stored OpenAI API key is one Node can use; null until
     * known. Set by [noteOpenAIKeyUsable] (ConfigManager's load and save, and [init]'s background read).
     */
    @Volatile private var openaiKeyUsable: Boolean? = null

    /**
     * Re-derives the key flag with [compute] (it decrypts): on the store's IO scope in production,
     * inline when there is none (tests, or before [init]). Then [noteOpenAIKeyUsable].
     */
    fun rederiveOpenAIKeyUsable(compute: () -> Boolean) {
        // CodeRabbit on 3240d3c9: the check is tied to the key revision it started at. A newer
        // note (a save that landed) or check supersedes it, and its result is then dropped.
        val gen = synchronized(keyLock) { keyGen.incrementAndGet() }
        val scope = ownedScope
        if (scope != null) {
            scope.launch {
                val usable = try { compute() } catch (e: Exception) {
                    Log.w(TAG, "OpenAI key check failed (${e.javaClass.simpleName})")
                    false
                }
                storeKeyFlag(usable, gen)
            }
        } else {
            storeKeyFlag(try { compute() } catch (_: Exception) { false }, gen)
        }
    }

    /** Records [usable] (a newer revision than any check in flight) and re-projects when it changed. */
    fun noteOpenAIKeyUsable(usable: Boolean) {
        val gen = synchronized(keyLock) { keyGen.incrementAndGet() }
        storeKeyFlag(usable, gen)
    }

    /** The key flag's revision ([rederiveOpenAIKeyUsable], [noteOpenAIKeyUsable]); [keyLock] guards the compare-and-set. */
    private val keyGen = java.util.concurrent.atomic.AtomicLong()
    private val keyLock = Any()

    /** Stores [usable] only while [gen] is still the latest revision; re-projects on a change. */
    private fun storeKeyFlag(usable: Boolean, gen: Long) {
        val changed = synchronized(keyLock) {
            if (keyGen.get() != gen) return // superseded by a newer note or check
            if (openaiKeyUsable == usable) false else { openaiKeyUsable = usable; true }
        }
        if (changed) refreshDisplay()
    }

    /**
     * BAT-1661 (CodeRabbit on aefe5f82): bumped whenever the credentials the projection reads may
     * have changed ([refreshDisplay] — every credential change ends in one). A projection computed
     * under an older generation is never stored ([publish], [refreshDisplay]).
     */
    private val credentialGen = java.util.concurrent.atomic.AtomicLong()

    /** Test seam: runs between each [publish] projection and its store. Production never sets it. */
    @Volatile internal var beforeDisplayStoreForTest: (() -> Unit)? = null

    /** The last record projected into [state] (raw, before [forDisplay]); for [refreshDisplay]. */
    private var lastProjected: RuntimeState? = null

    /**
     * Guards ONLY the read/assignment of [lastProjected] and [_state] in [publish] and
     * [refreshDisplay]. The projection itself (credential reads) runs outside it, and it is never
     * held across a ModelSelectionLock transaction or any other call.
     */
    private val displayLock = Any()

    /**
     * Projects [s] into [state] and remembers it for [refreshDisplay]. [withCredentials] false: the
     * stored auth decides the display — no credential I/O (the main-thread first publish in [init]).
     */
    private fun publish(s: RuntimeState, withCredentials: Boolean = true) {
        // Credential reads stay outside displayLock. A projection computed before a credential
        // change (the generation moved) is recomputed, never stored over a newer refresh.
        repeat(MAX_PROJECTION_TRIES) {
            val gen = credentialGen.get()
            val shown = if (withCredentials) forDisplay(s) else forDisplayStoredAuth(s)
            beforeDisplayStoreForTest?.invoke()
            synchronized(displayLock) {
                if (credentialGen.get() == gen) {
                    lastProjected = s
                    _state.value = shown
                    return
                }
            }
        }
        // CodeRabbit on 3240d3c9: the credentials changed during every attempt. Never store a stale
        // projection; remember the record and let [refreshDisplay] project it with the credentials
        // as they are now (a further change ends in another refresh, so the latest one wins).
        synchronized(displayLock) { lastProjected = s }
        refreshDisplay()
    }

    /**
     * BAT-1661 (Codex review of ca06bb79 #4): re-project the last record after the credentials the
     * display transport depends on changed (an OpenAI sign-in or sign-out, a saved API key). No-op
     * before anything was projected. Never overwrites a newer [publish]: the result is stored only
     * while the record it was computed from is still the last one projected.
     */
    fun refreshDisplay() {
        val gen = credentialGen.incrementAndGet()
        val s = synchronized(displayLock) { lastProjected } ?: return
        val shown = forDisplay(s)
        synchronized(displayLock) {
            if (lastProjected === s && credentialGen.get() == gen) _state.value = shown
        }
    }

    /** Bound on [publish]'s recompute loop (credential changes while projecting are rare). */
    private const val MAX_PROJECTION_TRIES = 3

    /** [forDisplay] with the stored auth as the scope (no credential reads). */
    private fun forDisplayStoredAuth(s: RuntimeState): RuntimeState {
        val shown = try {
            ModelRegistry.applyRetiredModelRule(s.provider, s.authType, s.model)
        } catch (_: IllegalStateException) {
            s.model
        }
        return if (shown == s.model) s else s.copy(model = shown)
    }

    /**
     * Returns the last valid [RuntimeState] (the same value [state]
     * exposes). Filtering of invalid observed states is the same as
     * for [state].
     */
    fun read(): RuntimeState = _state.value

    /**
     * Persist [value] atomically. Throws [IllegalArgumentException]
     * BEFORE persisting if the (provider, authType) pair isn't valid
     * per [isValidPair] — keeps the matrix as a precondition rather
     * than relying on the collector to drop the state silently after
     * a successful disk write.
     *
     * Returns the underlying [CrossProcessStore.write] result —
     * `true` on persisted-and-published, `false` on caught FS failure
     * (caller surfaces via Snackbar/Telegram-reply per the BAT-513
     * failure-UX contract). Returns `false` if [init] wasn't called.
     */
    fun write(tx: ModelSelectionLock.Tx, value: RuntimeState): Boolean {
        tx.requireOpen()
        require(isValidPair(value.provider, value.authType)) {
            "Invalid (provider=${value.provider}, authType=${value.authType})"
        }
        return store?.write(value) ?: false
    }

    /**
     * Read-modify-write under the underlying [CrossProcessStore]'s
     * `synchronized(writeLock)` block — atomic w.r.t. both concurrent
     * `update {}` calls AND concurrent `write()` calls in the same
     * process (round-13 review caught a Mutex-only design that missed
     * update-vs-write contention). [transform] receives the current
     * value (a fresh deserialized instance) and returns the value to
     * persist; the resulting (provider, authType) pair is validated
     * INSIDE the lock so a transform that produces an invalid
     * combination throws [IllegalArgumentException] without poisoning
     * the file.
     *
     * BAT-1661: [write] and [update] take the [ModelSelectionLock] transaction token. Every
     * record they persist carries provider/authType/model — even a field-local reasoning toggle —
     * so an unlocked write could put an old model back over a `:node` repair. The caller opens the
     * transaction (or passes the one it holds); these never acquire it themselves, so a caller
     * that hops threads (saveConfig's `runBlocking(Dispatchers.IO)`) keeps ownership.
     */
    suspend fun update(tx: ModelSelectionLock.Tx, transform: (RuntimeState) -> RuntimeState): Boolean {
        tx.requireOpen()
        val s = store ?: return false
        return s.update { current ->
            val next = transform(current)
            require(isValidPair(next.provider, next.authType)) {
                "Invalid (provider=${next.provider}, authType=${next.authType})"
            }
            next
        }
    }

    /**
     * BAT-1661: [update] inside its own [ModelSelectionLock] transaction, for field-local UI
     * toggles (reasoning, custom echo). Call from an IO dispatcher — it may wait for the lock.
     * Returns false when the lock is busy (the caller's existing "save failed" path) or the write
     * failed. [IllegalArgumentException] from [transform] propagates, as from [update].
     */
    fun updateInOwnTransaction(transform: (RuntimeState) -> RuntimeState): Boolean {
        val r = ModelSelectionLock.transaction { tx -> updateOrSeedLocked(tx, transform) }
        return r is ModelSelectionLock.Result.Acquired && r.value
    }

    /**
     * [updateInOwnTransaction]'s body. A field-local toggle never creates a record out of the
     * launch-time seed (CodeRabbit on 444ba220): that seed can predate a selection or a repair,
     * and a record built from it would put an old model in front of Node. With no complete record
     * on disk, the first-launch seed rule runs first ([seedInTx], contract v2.8 §3): no repair
     * intent → seeded from prefs as they are now; a handed-off repair that still holds → seeded
     * from its target; a `pending` or unreadable one → nothing is seeded and the toggle fails.
     *
     * The seed sets the selection only. A file that is there but is not a complete selection (e.g.
     * `{"reasoningEnabled":true,"reasoningDisplayInChat":true}`) keeps every other field it holds:
     * the record is decoded leniently and only provider / authType / model are replaced.
     */
    private fun updateOrSeedLocked(tx: ModelSelectionLock.Tx, transform: (RuntimeState) -> RuntimeState): Boolean {
        tx.requireOpen()
        val s = store ?: return false
        val dir = filesDir ?: return false
        if (com.seekerclaw.app.config.RuntimeStateFile.read(dir.toPath()) !is com.seekerclaw.app.config.RuntimeStateFile.Read.Present) {
            val sp = prefs ?: return false
            // The tuple from the seed rule; every other field from the file as it decodes, if it does.
            val seedWrite = { v: RuntimeState ->
                val base = s.readOrNull() ?: RuntimeState()
                s.write(base.copy(provider = v.provider, authType = v.authType, model = v.model))
            }
            if (!seedInTx(tx, dir, sp, seedWrite)) return false
            if (com.seekerclaw.app.config.RuntimeStateFile.read(dir.toPath()) !is com.seekerclaw.app.config.RuntimeStateFile.Read.Present) {
                Log.w(TAG, "toggle not saved: no $FILE_NAME record, and the model repair owns the stores")
                return false
            }
        }
        return updateExisting(tx, transform) == CrossProcessStore.UpdateOutcome.WRITTEN
    }

    /**
     * BAT-1661: [update] over the record ON DISK only — never one built from the launch-time
     * seed that [CrossProcessStore.read] falls back to. A missing file, or one Node's config.js
     * would not read as a complete selection ([com.seekerclaw.app.config.RuntimeStateFile.read]:
     * a partial object decodes here with DEFAULT fields), is [CrossProcessStore.UpdateOutcome.ABSENT]
     * and is left alone. [transform] returning null writes nothing. The resulting pair is validated
     * inside the lock, as in [update].
     */
    fun updateExisting(
        tx: ModelSelectionLock.Tx,
        transform: (RuntimeState) -> RuntimeState?,
    ): CrossProcessStore.UpdateOutcome {
        tx.requireOpen()
        val s = store ?: return CrossProcessStore.UpdateOutcome.FAILED
        val dir = filesDir?.toPath()
        var notARecord = false
        val out = s.updateExisting { current ->
            if (dir != null &&
                com.seekerclaw.app.config.RuntimeStateFile.read(dir) !is com.seekerclaw.app.config.RuntimeStateFile.Read.Present
            ) {
                notARecord = true
                return@updateExisting null
            }
            transform(current)?.also { next ->
                require(isValidPair(next.provider, next.authType)) {
                    "Invalid (provider=${next.provider}, authType=${next.authType})"
                }
            }
        }
        return if (notARecord) CrossProcessStore.UpdateOutcome.ABSENT else out
    }

    /**
     * Provider/authType matrix gate. The Node side's
     * `_SUPPORTED_PROVIDERS` and per-provider authType handling
     * (`config.js:168-203`) are the source of truth this mirrors.
     * Mismatches between the two sides are caught by the
     * `RuntimeStateStoreTest` matrix tests, NOT by this function
     * silently — keep them in sync at every BAT-511-family change.
     */
    internal fun isValidPair(provider: String, authType: String): Boolean = when (provider) {
        "claude" -> authType == "api_key" || authType == "setup_token"
        "openai" -> authType == "api_key" || authType == "oauth"
        // BAT-1124: xai mirrors openai's api_key|oauth pair. NOTE the H5 boot-loop guard
        // lives at the WRITE site (ConfigManager.runtimeAuthTypeFor) — (xai, oauth) with a
        // blank token is downgraded to api_key BEFORE it reaches this validator, so
        // runtime_state.json never advertises an unstartable oauth pair. This function only
        // answers "is the (provider, authType) combination legal per Node's matrix?".
        "xai" -> authType == "api_key" || authType == "oauth"
        "openrouter" -> authType == "api_key"
        "custom" -> authType == "api_key"
        else -> false
    }

    /**
     * Pure helper: build the seed [RuntimeState] from the legacy
     * pref keys. If the persisted (provider, authType) pair is
     * invalid (corrupt prefs from an unknown source), fall back to
     * the FULL default `RuntimeState()` — including resetting model
     * to the build's default — rather than seeding bad state into
     * the file. Resetting model in this case is intentional: the
     * persisted model is likely tied to the now-rejected provider
     * and would itself be invalid for the new default provider.
     * Users who hit this path are recovering from corrupt prefs;
     * a clean default is the safer landing.
     *
     * Note: invalid model IDs alone (with a valid provider/authType
     * pair) are accepted at this layer — Node's per-provider
     * default-model logic handles unknown IDs at startup, and the
     * UI's model picker normalizes them on next save.
     */
    /**
     * [com.seekerclaw.app.config.ConfigManager.runtimeAuthTypeForStored]; the stored value if it
     * cannot be decided (logged to Logcat). `ExceptionInInitializerError` is caught too: the xAI
     * store or ConfigManager failing to initialise must not take the seed or the mirror down.
     */
    private fun runtimeAuthOf(provider: String, authType: String): String = try {
        com.seekerclaw.app.config.ConfigManager.runtimeAuthTypeForStored(provider, authType)
    } catch (e: Exception) {
        Log.w(TAG, "runtime auth for ($provider, $authType) not decided (${e.javaClass.simpleName}) — kept as stored")
        authType
    } catch (e: ExceptionInInitializerError) {
        Log.w(TAG, "runtime auth for ($provider, $authType) not decided (${e.javaClass.simpleName}) — kept as stored")
        authType
    }

    internal fun seedFromPrefs(prefs: SharedPreferences, gateXai: Boolean = true): RuntimeState {
        // BAT-1315: these fell back to hardcoded literals — "claude-opus-4-8" written
        // twice on one line — which made this a THIRD place the shipped default lived,
        // silently diverging from model-registry.json and RuntimeState. Derive them
        // from RuntimeState instead, so the default has one definition and updating it
        // cannot leave a stale copy behind here.
        val fallback = RuntimeState()
        val provider = prefs.getString(KEY_PROVIDER, fallback.provider) ?: fallback.provider
        val authType = prefs.getString(KEY_AUTH_TYPE, fallback.authType) ?: fallback.authType
        val model = prefs.getString(KEY_MODEL, fallback.model) ?: fallback.model
        // BAT-1661 (CodeRabbit on ca06bb79): the same BAT-1124 H5 gate every other runtime_state
        // writer applies — (xai, oauth) with no usable token and no reauth is stored as api_key —
        // so the seed (first launch, a toggle's seed) never advertises an unstartable oauth pair
        // that Node reads before config.json. Prefs keep the user's oauth selection; the mirror
        // recognises this image as the same selection ([mirrorFromDisk]).
        val runtimeAuth = if (gateXai) runtimeAuthOf(provider, authType) else authType
        val candidate = RuntimeState(provider = provider, authType = runtimeAuth, model = model)
        return if (isValidPair(candidate.provider, candidate.authType)) candidate else RuntimeState()
    }

    /**
     * Apply the validity gate AND the redundancy guard, then update
     * the wrapper StateFlow + mirror to prefs. Extracted from the
     * collector so unit tests can drive it directly without spinning
     * up a CrossProcessStore.
     *
     * Returns `true` iff a mirror to prefs actually applied (i.e. the
     * observed state was valid AND differed from current prefs values).
     * The production [observeFromCollector] uses this signal to decide
     * whether to fire [com.seekerclaw.app.config.ConfigManager.signalConfigChanged]
     * — invalid observations and redundant emissions don't trigger a
     * cross-process broadcast.
     */
    internal fun onObserved(observed: RuntimeState, prefs: SharedPreferences): Boolean {
        if (!isValidPair(observed.provider, observed.authType)) {
            Log.w(
                TAG,
                "observed invalid (provider=${observed.provider}, authType=${observed.authType}) " +
                    "— UI keeps last valid; prefs unchanged",
            )
            return false
        }
        publish(observed)
        return mirrorIfChanged(prefs, observed)
    }

    /**
     * Mirror a single field iff its prefs value differs from
     * [observed]. Returns `true` iff at least one field was actually
     * written (used by the redundancy-guard test).
     */
    internal fun mirrorIfChanged(prefs: SharedPreferences, observed: RuntimeState): Boolean {
        val curProvider = prefs.getString(KEY_PROVIDER, null)
        val curAuth = prefs.getString(KEY_AUTH_TYPE, null)
        val curModel = prefs.getString(KEY_MODEL, null)
        if (curProvider == observed.provider && curAuth == observed.authType && curModel == observed.model) {
            return false
        }
        val editor = MainPrefs.edit(prefs)
        if (curProvider != observed.provider) editor.putString(KEY_PROVIDER, observed.provider)
        if (curAuth != observed.authType) editor.putString(KEY_AUTH_TYPE, observed.authType)
        if (curModel != observed.model) editor.putString(KEY_MODEL, observed.model)
        // BAT-1661 (Codex diff review #4): commit(), not apply(). The caller holds the
        // model-selection lock; apply() would queue the disk write to land after it is released.
        // A failed commit puts the old values back in the cache, so the next emission retries.
        if (!MainPrefs.commitOrRestore(editor)) {
            Log.w(TAG, "prefs mirror not committed (disk write failed)")
            return false
        }
        return true
    }

    /**
     * Test seam: bypass [init]'s real CrossProcessStore wiring and
     * just seed [_state] so unit tests can assert the collector
     * path without a [Context]. Tests pass their fake
     * SharedPreferences directly to [onObserved] / [mirrorIfChanged]
     * — no prefs field is kept on the singleton (round-15 dead-code
     * removal). Production code MUST NOT call this.
     */
    internal fun initForTest(injectedSeed: RuntimeState) {
        if (!initialized.compareAndSet(false, true)) return
        publish(injectedSeed)
    }

    /**
     * BAT-1661 test seam: wire a REAL [CrossProcessStore] on [filesDir] (no FileObserver, no
     * broadcast), so `saveConfig` and reconcile run their production runtime-state writes in JVM
     * tests. Production MUST NOT call this.
     */
    internal fun initWithStoreForTest(filesDir: File, seed: RuntimeState = RuntimeState(), prefs: SharedPreferences? = null) {
        if (!initialized.compareAndSet(false, true)) return
        val cps = CrossProcessStore(filesDir, FILE_NAME, RuntimeState.serializer(), seed)
        store = cps
        this.filesDir = filesDir
        this.prefs = prefs
        publish(cps.read())
    }

    /**
     * Test seam: drop all state so the next test case can re-init
     * from scratch. Mirrors [com.seekerclaw.app.util.ServiceState.resetForTest].
     */
    internal fun resetForTest() {
        ownedScope?.cancel()
        ownedScope = null
        store?.close()
        store = null
        appContext = null
        filesDir = null
        prefs = null
        lastProjected = null
        openaiKeyUsable = null
        beforeDisplayStoreForTest = null
        _state.value = RuntimeState()
        initialized.set(false)
    }
}
