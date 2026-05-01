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
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Singleton store for [AgentPreferences] (BAT-515). Mirror of
 * [RuntimeStateStore]'s shape with simpler invariants:
 *  - No matrix gate (no two fields whose combination must be valid)
 *  - Context-sensitive validation: existing-preserved fields skip the
 *    cap; only newly-changing fields go through the cap check (BAT-515
 *    v3 §1 + Codex final implementation guard).
 *  - Migration preserves existing long agent names verbatim with WARN
 *    rather than throwing/truncating.
 *
 * ## First-launch / install-over-existing behaviour
 *
 * 1. [init] runs once from `SeekerClawApplication.onCreate` (main
 *    process only).
 * 2. [seedFromPrefs] reads `KEY_AGENT_NAME` and `KEY_SEARCH_PROVIDER`
 *    from SharedPreferences (the legacy storage). For an upgrade, the
 *    user's existing values are preserved here — including over-cap
 *    `agentName` (BAT-515 v3 §1: never truncate during migration).
 * 3. The CrossProcessStore is constructed with `seeded` as the initial
 *    value, so [state] immediately exposes the seed even before the
 *    file lands on disk.
 * 4. The migration write (file absent → write seeded value) runs on
 *    the owned IO scope so `Application.onCreate` doesn't block on
 *    disk.
 * 5. The observe-and-mirror collector kicks in after migration. On
 *    every emission of a valid observed file value:
 *    - The wrapper `_state` updates.
 *    - If the observed value differs from current prefs, the prefs
 *      mirror runs (KEY_AGENT_NAME + KEY_SEARCH_PROVIDER) AND
 *      `ConfigManager.signalConfigChanged` fires so existing
 *      `loadConfig`-based UI surfaces recompose.
 *    - Redundant emissions skip both steps. Invalid observations
 *      (corrupt JSON, wrong types) are filtered before any mirror so
 *      the UI / prefs never see a transiently-bad value.
 *
 * ## Visible-state contract (BAT-515 v3 §2)
 *
 * If `agent_preferences.json` is missing OR corrupt, [state] continues
 * to expose the seeded value (from prefs/config). It NEVER falls back
 * to hardcoded defaults if any persisted source has a valid prior
 * value — corruption shouldn't silently reset a user's name to
 * "MyAgent".
 *
 * ## Cross-process broadcast (BAT-515 v3 §3)
 *
 * The mirror calls
 * [com.seekerclaw.app.config.ConfigManager.signalConfigChanged] only
 * when a valid observation actually changed prefs. Redundant or
 * invalid observations skip the broadcast. Mirrors [RuntimeStateStore]'s
 * pattern so existing Compose surfaces that recompose on
 * `configVersion` (Dashboard, System, Settings summary) auto-refresh
 * after a Node-side write.
 */
object AgentPreferencesStore {

    private const val TAG = "AgentPreferencesStore"
    // PREFS_NAME and the legacy keys MUST match
    // [com.seekerclaw.app.config.ConfigManager]. They are duplicated
    // here so AgentPreferencesStore stays self-contained for tests
    // (no Context required to resolve the constants). If ConfigManager
    // ever changes any of these, change them here too. R11 Copilot:
    // `AgentPreferencesStoreTest` exercises behavior against these
    // literal keys but does NOT independently assert parity with
    // `ConfigManager`'s constants — a hypothetical edit to either
    // side's strings would not fail the test suite. Drift is caught
    // by code review and the warning above; a future refactor that
    // pulls the keys into a shared object on [AgentPreferences] (the
    // schema) would let both files reference one source of truth and
    // make the drift impossible.
    private const val PREFS_NAME = "seekerclaw_prefs"
    private const val FILE_NAME = "agent_preferences.json"
    private const val KEY_AGENT_NAME = "agent_name"
    private const val KEY_SEARCH_PROVIDER = "search_provider"

    private val initialized = AtomicBoolean(false)
    private val _state = MutableStateFlow(AgentPreferences())
    private var appContext: Context? = null

    // R1 Copilot: lenient `Json` mirroring `CrossProcessStore`'s
    // `ignoreUnknownKeys = true`. Used by the strict file-parse path
    // in the collector so a forward-build's extra fields don't fail
    // the parse on a downgrade.
    private val strictJson = Json { ignoreUnknownKeys = true }

    /**
     * Last valid [AgentPreferences] observed. UI binds to this;
     * invalid file content (manual edit, corrupted JSON, future-build
     * fields with unknown types) is filtered out so the UI never sees
     * a transiently-bad state.
     */
    val state: StateFlow<AgentPreferences> = _state.asStateFlow()

    /**
     * `true` once [init] has wired up the cross-process store. Callers
     * that run in BOTH processes (e.g., `:node` reconcile) gate
     * main-only work on this — the `:node` process never calls
     * [init], so [write] would always return `false` there.
     */
    val isInitialized: Boolean get() = store != null

    private var ownedScope: CoroutineScope? = null
    private var store: CrossProcessStore<AgentPreferences>? = null

    /**
     * Idempotent. Call once from `SeekerClawApplication.onCreate`.
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
            serializer = AgentPreferences.serializer(),
            initial = seeded,
            parentScope = scope,
        )
        store = cps
        scope.launch {
            // First-launch migration: if the file is absent (fresh
            // install OR pre-BAT-515 build that never wrote it), seed
            // it from the prefs/in-memory seed. Failure is non-fatal:
            // _state already holds the seed, so UI proceeds with a
            // valid value; a later user-driven save will retry.
            val file = File(app.filesDir, FILE_NAME)
            if (!file.exists() && !cps.write(seeded)) {
                Log.w(
                    TAG,
                    "first-launch migration write to $FILE_NAME failed — " +
                        "app proceeds with in-memory seed; a later save will retry",
                )
            }
            // R1 Copilot: use cps.state emissions as a TRIGGER, not a
            // source of truth. CrossProcessStore.read() returns the
            // construction-time `initialSnapshot` on JSON decode
            // failure — so a corrupted `agent_preferences.json` would
            // surface as a "valid" seeded value, regress `_state`
            // from the user's actual chosen value back to the
            // launch-time seed, and overwrite prefs (BAT-515 v3 §2
            // contract violation: corruption MUST NOT silently reset
            // a user's name).
            //
            // Fix: re-parse the file ourselves with strict semantics
            // matching `agent-preferences.js` `readLiveOrNull` — null
            // on absent / unreadable / parse-fail / wrong-type /
            // unknown-provider / blank-name / missing-field. On null,
            // skip the dispatch entirely so `_state` and prefs stay
            // at the last valid value.
            cps.state.collect { _ ->
                val strict = parseFileStrictOrNull(File(app.filesDir, FILE_NAME))
                if (strict != null) {
                    observeFromCollector(strict, sp)
                }
                // null = corrupt or absent → keep last valid state,
                // skip mirror, skip broadcast (BAT-515 v3 §2 + §3).
            }
        }
    }

    /**
     * Strict file parse mirroring `agent-preferences.js`
     * `readLiveOrNull` — returns the parsed value only if the file
     * exists, parses as a JSON object, has both string fields, the
     * `searchProvider` is in the allowlist, and the `agentName` is
     * non-blank. Migration paths legitimately carry over-cap names,
     * so the cap is NOT enforced here (mirrors v3 §1).
     *
     * Returns null in every other case so the collector path can
     * skip dispatch and avoid regressing live state on corruption.
     *
     * `internal` so unit tests can pin the parse contract directly
     * — the corruption-doesn't-regress invariant is the whole point
     * of this function existing, so it needs explicit test coverage.
     */
    internal fun parseFileStrictOrNull(file: File): AgentPreferences? {
        if (!file.exists()) return null
        val text = try { file.readText() } catch (_: Exception) { return null }
        if (text.isBlank()) return null
        val element = try { strictJson.parseToJsonElement(text) } catch (_: Exception) { return null }
        val obj = element as? JsonObject ?: return null
        // Both fields must be PRESENT and STRING — an empty `{}` or a
        // missing field would deserialize to AgentPreferences defaults
        // via kotlinx.serialization, which is exactly the "silent
        // reset" we're trying to avoid. Pull primitives manually so a
        // partial-shape file is rejected up front.
        val sp = (obj["searchProvider"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            ?: return null
        val an = (obj["agentName"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            ?: return null
        if (sp !in AgentPreferences.KNOWN_SEARCH_PROVIDERS) return null
        if (an.isBlank()) return null
        return AgentPreferences(searchProvider = sp, agentName = an)
    }

    /**
     * Production-side wrapper that fires
     * [com.seekerclaw.app.config.ConfigManager.signalConfigChanged]
     * when the mirror actually changed prefs (BAT-515 v3 §3). Mirror
     * + broadcast are no-ops on redundant or invalid observations.
     */
    private fun observeFromCollector(observed: AgentPreferences, sp: SharedPreferences) {
        val applied = onObserved(observed, sp)
        if (applied) {
            appContext?.let { com.seekerclaw.app.config.ConfigManager.signalConfigChanged(it) }
        }
    }

    /**
     * Returns the last valid [AgentPreferences] (the same value [state]
     * exposes).
     */
    fun read(): AgentPreferences = _state.value

    /**
     * Persist [value] atomically. Throws [IllegalArgumentException]
     * BEFORE persisting if any field that DIFFERS from the current
     * value fails validation:
     *  - `searchProvider`: must be in [AgentPreferences.KNOWN_SEARCH_PROVIDERS]
     *  - `agentName`: must be non-blank AND ≤ [AgentPreferences.AGENT_NAME_MAX]
     *
     * Per the BAT-515 v3 + final-guard contract: if a field is
     * UNCHANGED from the current persisted value, validation skips
     * that field even if it's over-cap (existing migrated long names
     * survive snapshots that don't touch them).
     *
     * Returns the underlying [CrossProcessStore.write] result —
     * `true` on persisted-and-published, `false` on caught FS failure.
     * Returns `false` if [init] wasn't called (`:node` process).
     */
    fun write(value: AgentPreferences): Boolean {
        // R8 Copilot: gate on `store` BEFORE validating. KDoc promises
        // `:node`-process callers (where init never ran) get a quiet
        // `false` — running `validateForWrite` first would throw
        // `IllegalArgumentException` for any invalid value even when
        // there's no store to write to, breaking the documented
        // contract. Same shape as [update]'s `val s = store ?: return
        // false` early-out.
        val initializedStore = store ?: return false
        validateForWrite(value, _state.value)
        val ok = initializedStore.write(value)
        // R3 Copilot: sync-update [_state] on successful persistence so
        // same-process callers reading via [read] (= `_state.value`)
        // see the new value immediately. Pre-fix the collector path
        // was the only writer to `_state`, leaving a brief window
        // where [read] returned stale — a hazard for
        // `ConfigManager.loadConfig` (which now overlays `read()`)
        // when called by code that just performed an update.
        //
        // The collector still fires its own update later via
        // [parseFileStrictOrNull] → [observeFromCollector]; it'll
        // observe the same value already in `_state`, so
        // [mirrorIfChanged]'s redundancy guard skips the prefs mirror
        // and broadcast (no double-mirror).
        if (ok) _state.value = value
        return ok
    }

    /**
     * Read-modify-write under the underlying [CrossProcessStore]'s
     * `synchronized(writeLock)` block — atomic w.r.t. both concurrent
     * `update {}` calls AND concurrent `write()` calls in the same
     * process.
     *
     * The "current" value passed to the transform is re-derived from
     * the file via [parseFileStrictOrNull] inside the writeLock,
     * NOT from the lambda's `current` arg. CrossProcessStore.read()
     * (which feeds the lambda's `current`) returns its
     * construction-time `initialSnapshot` on JSON decode failure —
     * so a corrupted `agent_preferences.json` would feed the
     * launch-time seed into the transform, and a partial update
     * (e.g., changing only `searchProvider`) would silently regress
     * the user's chosen `agentName` to the seed (R4 Copilot caught
     * this as a regression vector matching the collector-path bug
     * R1.3 already fixed).
     *
     * Falls back to `_state.value` (this wrapper's last-valid
     * snapshot, kept fresh by the R3 sync-update path) when the
     * file is corrupt or absent. Concurrent in-process updates
     * still serialize correctly: the writeLock guarantees update2
     * enters AFTER update1's persist completes, so update2's
     * `parseFileStrictOrNull` reads update1's just-persisted value
     * — no lost-update.
     */
    suspend fun update(transform: (AgentPreferences) -> AgentPreferences): Boolean {
        val s = store ?: return false
        val ctx = appContext ?: return false
        // R3 Copilot: capture the value persisted by the transform (the
        // `next` returned inside the writeLock) so we can sync-update
        // `_state` after the underlying write succeeds. Without this,
        // [update]'s same-process callers see a stale [read] result
        // until the collector path fires (~50-200ms later) — same race
        // [write] had pre-fix.
        var persisted: AgentPreferences? = null
        val ok = s.update { _ ->
            // R4 Copilot: re-derive `current` via strict file parse
            // (with `_state.value` fallback for corrupt/absent files)
            // to bypass CrossProcessStore.read()'s decode-failure →
            // initialSnapshot regression. See KDoc above.
            val current = parseFileStrictOrNull(File(ctx.filesDir, FILE_NAME))
                ?: _state.value
            val next = transform(current)
            validateForWrite(next, current)
            persisted = next
            next
        }
        if (ok) persisted?.let { _state.value = it }
        return ok
    }

    /**
     * Validate [next] against [current]. Throws
     * [IllegalArgumentException] if any field that ACTUALLY CHANGES
     * (`next.field != current.field`) violates its rule. Unchanged
     * fields skip validation — this is what allows a saveConfig call
     * carrying an existing migrated long agentName to succeed
     * (BAT-515 v3 §1 + Codex final guard).
     *
     * Public so `ConfigManager.saveConfig` can pre-validate before
     * any persistence (BAT-515 v3 §4) without first needing to call
     * [write].
     */
    fun validateForWrite(next: AgentPreferences, current: AgentPreferences) {
        if (next.searchProvider != current.searchProvider) {
            require(next.searchProvider in AgentPreferences.KNOWN_SEARCH_PROVIDERS) {
                "Invalid searchProvider=${next.searchProvider} — must be one of " +
                    AgentPreferences.KNOWN_SEARCH_PROVIDERS
            }
        }
        if (next.agentName != current.agentName) {
            require(next.agentName.isNotBlank()) { "agentName must not be blank" }
            require(next.agentName.length <= AgentPreferences.AGENT_NAME_MAX) {
                "agentName length ${next.agentName.length} exceeds max " +
                    "${AgentPreferences.AGENT_NAME_MAX}"
            }
        }
    }

    /**
     * Build the seed [AgentPreferences] from the legacy SharedPreferences
     * keys. Existing values are preserved verbatim — including
     * over-cap `agentName` (BAT-515 v3 §1: migration NEVER truncates).
     * Logs a single WARN if a long name is detected so future triage
     * can correlate.
     *
     * If both keys are absent, returns the data class defaults
     * (fresh-install path).
     */
    internal fun seedFromPrefs(prefs: SharedPreferences): AgentPreferences {
        val rawName = prefs.getString(KEY_AGENT_NAME, null)
        val rawSearch = prefs.getString(KEY_SEARCH_PROVIDER, null)
        val agentName = if (!rawName.isNullOrBlank()) {
            if (rawName.length > AgentPreferences.AGENT_NAME_MAX) {
                Log.w(
                    TAG,
                    "seedFromPrefs: existing agentName length ${rawName.length} > " +
                        "${AgentPreferences.AGENT_NAME_MAX} — preserving verbatim, no truncation " +
                        "(BAT-515 v3 §1)",
                )
            }
            rawName
        } else {
            AgentPreferences.DEFAULT_AGENT_NAME
        }
        val searchProvider = if (!rawSearch.isNullOrBlank()
            && rawSearch in AgentPreferences.KNOWN_SEARCH_PROVIDERS
        ) {
            rawSearch
        } else {
            // Unknown / corrupt prefs value falls back to default rather
            // than poisoning the file. The user's next Settings save
            // (with the picker constraining to the allowlist) will
            // produce a valid value.
            if (rawSearch != null) {
                Log.w(
                    TAG,
                    "seedFromPrefs: unknown searchProvider=$rawSearch — falling back to default",
                )
            }
            AgentPreferences.DEFAULT_SEARCH_PROVIDER
        }
        return AgentPreferences(searchProvider = searchProvider, agentName = agentName)
    }

    /**
     * Apply the validity gate AND the redundancy guard, then update
     * the wrapper StateFlow + mirror to prefs. Extracted from the
     * collector so unit tests can drive it directly without spinning
     * up a CrossProcessStore.
     *
     * Returns `true` iff the mirror to prefs actually applied (i.e.
     * the observed state was valid AND differed from current prefs
     * values). The production [observeFromCollector] uses this signal
     * to decide whether to fire `signalConfigChanged`.
     *
     * "Valid" here means the persisted shape parses, AND
     * `searchProvider` is a known provider. An unknown searchProvider
     * is treated as invalid (visible state stays at last-valid; no
     * mirror) because letting it through would write garbage into
     * prefs and let `tools/web.js` route to a non-existent provider.
     * `agentName` length is NOT validated at the observation gate —
     * an over-cap name is allowed to reach state because migration
     * paths legitimately carry over-cap values.
     */
    internal fun onObserved(observed: AgentPreferences, prefs: SharedPreferences): Boolean {
        if (observed.searchProvider !in AgentPreferences.KNOWN_SEARCH_PROVIDERS) {
            Log.w(
                TAG,
                "observed invalid searchProvider=${observed.searchProvider} — " +
                    "UI keeps last valid; prefs unchanged",
            )
            return false
        }
        if (observed.agentName.isBlank()) {
            Log.w(TAG, "observed blank agentName — UI keeps last valid; prefs unchanged")
            return false
        }
        _state.value = observed
        return mirrorIfChanged(prefs, observed)
    }

    /**
     * Mirror prefs iff at least one field of [observed] differs from
     * the current prefs value. Returns `true` iff anything was written
     * (used by the redundancy-guard + broadcast-gate logic).
     */
    internal fun mirrorIfChanged(prefs: SharedPreferences, observed: AgentPreferences): Boolean {
        val curName = prefs.getString(KEY_AGENT_NAME, null)
        val curSearch = prefs.getString(KEY_SEARCH_PROVIDER, null)
        if (curName == observed.agentName && curSearch == observed.searchProvider) return false
        val editor = prefs.edit()
        if (curName != observed.agentName) editor.putString(KEY_AGENT_NAME, observed.agentName)
        if (curSearch != observed.searchProvider) editor.putString(KEY_SEARCH_PROVIDER, observed.searchProvider)
        editor.apply()
        return true
    }

    /**
     * Test seam: bypass [init]'s real CrossProcessStore wiring and
     * just seed [_state] so unit tests can assert the collector path
     * without a [Context]. Production code MUST NOT call this.
     */
    internal fun initForTest(injectedSeed: AgentPreferences) {
        if (!initialized.compareAndSet(false, true)) return
        _state.value = injectedSeed
    }

    /**
     * Test seam: drop all state so the next test case can re-init
     * from scratch.
     */
    internal fun resetForTest() {
        ownedScope?.cancel()
        ownedScope = null
        store?.close()
        store = null
        appContext = null
        _state.value = AgentPreferences()
        initialized.set(false)
    }
}
