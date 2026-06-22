package com.seekerclaw.app.state

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
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
 *    (`claude/api_key/claude-opus-4-8`) since no key is present;
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
    private const val PREFS_NAME = "seekerclaw_prefs"
    private const val FILE_NAME = "runtime_state.json"
    private const val KEY_PROVIDER = "provider"
    private const val KEY_AUTH_TYPE = "auth_type"
    private const val KEY_MODEL = "model"

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
        val sp = app.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val seeded = seedFromPrefs(sp)
        _state.value = seeded
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
            val file = File(app.filesDir, FILE_NAME)
            if (!file.exists() && !cps.write(seeded)) {
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
     * Production-side wrapper around [onObserved]: also fires
     * [com.seekerclaw.app.config.ConfigManager.signalConfigChanged]
     * when the mirror actually changed prefs, so existing Compose
     * screens that read prefs via `ConfigManager.loadConfig` (and
     * recompose on `configVersion`) auto-refresh after a
     * `:node`-originated write. The broadcast is a no-op for
     * redundant emissions (mirrorIfChanged returned false → nothing
     * to refresh).
     */
    private fun observeFromCollector(observed: RuntimeState, sp: SharedPreferences) {
        // Single chokepoint via onObserved (BAT-513 round-14): the
        // pure-logic gate (validity check, _state update, prefs
        // mirror, redundancy guard) lives in onObserved so unit tests
        // and production share the exact same code path. This wrapper
        // adds only the production-side concern: cross-process
        // broadcast on a successful mirror. If onObserved drifts in
        // the future, both paths drift together.
        val applied = onObserved(observed, sp)
        if (applied) {
            appContext?.let { com.seekerclaw.app.config.ConfigManager.signalConfigChanged(it) }
        }
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
    fun write(value: RuntimeState): Boolean {
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
     */
    suspend fun update(transform: (RuntimeState) -> RuntimeState): Boolean {
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
    internal fun seedFromPrefs(prefs: SharedPreferences): RuntimeState {
        val provider = prefs.getString(KEY_PROVIDER, "claude") ?: "claude"
        val authType = prefs.getString(KEY_AUTH_TYPE, "api_key") ?: "api_key"
        val model = prefs.getString(KEY_MODEL, "claude-opus-4-8") ?: "claude-opus-4-8"
        val candidate = RuntimeState(provider = provider, authType = authType, model = model)
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
        _state.value = observed
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
        val editor = prefs.edit()
        if (curProvider != observed.provider) editor.putString(KEY_PROVIDER, observed.provider)
        if (curAuth != observed.authType) editor.putString(KEY_AUTH_TYPE, observed.authType)
        if (curModel != observed.model) editor.putString(KEY_MODEL, observed.model)
        editor.apply()
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
        _state.value = injectedSeed
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
        _state.value = RuntimeState()
        initialized.set(false)
    }
}
