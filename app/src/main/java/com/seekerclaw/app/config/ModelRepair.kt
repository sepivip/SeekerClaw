package com.seekerclaw.app.config

import android.content.Context
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
import com.seekerclaw.app.util.SafeFs
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.nio.file.Path

/**
 * BAT-1661 — the durable repair of a ChatGPT-sign-in user whose stored OpenAI model is no
 * longer served for that sign-in (contract v2.3 – v2.10; v2.7 – v2.10 signed in `8161bc04`).
 *
 * The read rule ([ModelRegistry.applyRetiredModelRule], Node `applyRetiredModelRule`) already
 * keeps every request and screen safe. This makes the STORED value converge, so the agent,
 * Settings and Telegram agree and the read rule stops having to mask anything.
 *
 * **The intent is the durable handoff** (v2.8). Its [RepairIntent.state] moves
 * `pending` → `awaiting_main` → `converged`:
 *  - **`pending`** — written by `:node`'s boot transaction ([plan]), before any repair write, with
 *    [SafeFs.writeAtomicVerified]. A pending intent found at a later start is confirmed again with
 *    a byte-exact [SafeFs.rewriteVerified] before any repair write (v2.10 §2).
 *  - **`awaiting_main`** — `:node` repaired runtime_state.json and the overlay (the files Node
 *    dispatches from; `:node` never writes `seekerclaw_prefs`), proved the dispatch file durable
 *    with a confirmed rewrite, and only then rewrote the intent ([handoff]). The notice is logged
 *    right after that confirmed rewrite, once.
 *  - **`converged`** — MAIN brought prefs to the target under the lock ([mainLoad]). It stays, so a
 *    still-alive `:node` process with a stale prefs cache never reopens the repair. It is deleted
 *    only when [classifyIntent] says `Superseded` (under the lock) or by a Settings selection
 *    ([cancelAfterSelection]).
 *
 * **One classifier** ([classifyIntent]) runs first in every caller: [plan] (`:node`, boot
 * transaction), [pendingRepair] (read-only: loads without the lock, the collector mirror),
 * [mainLoad] (MAIN, locked load) and the first-launch seed. Only [plan] and [mainLoad] act on it,
 * and both run under [ModelSelectionLock].
 *
 * **Scope** (v2.9 §1): the snapshot carries the SELECTED (provider, auth) — runtime_state first,
 * then prefs, as stored — and the TRANSPORT Node will actually use ([OpenAIAuth]). The transport
 * decides whether a new repair may open (the retired ids fail only on the oauth transport); the
 * selection decides supersession, so a sign-out never erases a handed-off intent.
 *
 * On a lock timeout the start is a **read-only boot**: no shared store is written.
 */
object ModelRepair {
    const val INTENT_NAME = "model_repair_intent.json"

    /**
     * v2.10 §0: 2. Nothing earlier ever shipped (`ModelRepair` is not on `main`), so a dev-build
     * leftover of another version reads as Corrupt: WARN, delete, then a fresh decision.
     */
    const val INTENT_VERSION = 2

    const val STATE_PENDING = "pending"
    const val STATE_AWAITING_MAIN = "awaiting_main"
    const val STATE_CONVERGED = "converged"
    private val STATES = setOf(STATE_PENDING, STATE_AWAITING_MAIN, STATE_CONVERGED)

    /** The transport auth of OpenAI oauth with no usable sign-in and no key ([OpenAIAuth.Effective.RECONNECT]). */
    const val TRANSPORT_RECONNECT = "oauth-reconnect"

    const val BUSY_WARNING = "[ModelRepair] lock busy at start — read-only boot, repair deferred"

    const val REPAIR_FAILED_BOOT_WARNING = "[ModelRepair] repair incomplete — model settings left as they are this start, retry next start"

    /** A settings write after the repair (the overlay publish) failed. */
    const val PUBLISH_FAILED_WARNING = "[ModelRepair] model settings not fully saved this start — repair stays pending, retry next start"

    /** v2.10 §2: a visible pending intent could not be confirmed on disk, so this start makes no repair write. */
    const val CONFIRM_FAILED_WARNING = "[ModelRepair] repair record not confirmed on disk — model settings left as they are this start, retry next start"

    /** v2.9 §1: a pending repair while the OpenAI transport is not the ChatGPT sign-in. */
    const val TRANSPORT_DEFERRED_WARNING = "[ModelRepair] repair waits for a usable ChatGPT sign-in — model settings left as they are this start"

    /** A boot left an overlay that names another provider exactly as it is. */
    const val FOREIGN_OVERLAY_KEPT = "[Config] agent_settings.json names another provider — left as it is this start"

    /** A boot left an unreadable overlay exactly as it is. */
    const val UNREADABLE_OVERLAY_KEPT = "[Config] agent_settings.json unreadable — left as it is this start"

    /**
     * BAT-1661 v2.7 §2: the overlay names a provider other than the boot's [provider]. An unreadable
     * overlay is not foreign.
     */
    internal fun overlayIsForeign(filesDir: Path, provider: String): Boolean {
        val r = AgentSettingsFile.read(filesDir) as? AgentSettingsFile.Read.Present ?: return false
        val p = AgentSettingsFile.stringField(r.obj, "provider") ?: return false
        return p != provider
    }

    /**
     * BAT-1661: the boot publisher leaves the overlay byte for byte (every boot, repair or not), and
     * this returns the INFO line to log, when the overlay is
     *  - foreign ([overlayIsForeign]): it may be the only record of an in-flight `/provider` choice
     *    (the overlay is written first, runtime_state second); or
     *  - unreadable: rewriting it would drop whatever it still holds (e.g. `apiKeys`) and turn it
     *    into an applicable overlay mid-repair (review Minor 2, settling contract question 5).
     * Null: publish as usual. config.json still follows the files (D7.3), and Node's dispatch skips
     * both kinds of overlay.
     */
    internal fun overlayLeftAsIs(filesDir: Path, provider: String): String? = when {
        AgentSettingsFile.read(filesDir) is AgentSettingsFile.Read.Unreadable -> UNREADABLE_OVERLAY_KEPT
        overlayIsForeign(filesDir, provider) -> FOREIGN_OVERLAY_KEPT
        else -> null
    }

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    /** The overlay as captured when it participated in the decision. */
    @Serializable
    data class CapturedOverlay(
        /** false: there was no overlay file; the repair creates one holding only `model`. */
        val present: Boolean,
        val provider: String? = null,
        val model: String? = null,
    )

    /**
     * v2.10 §1: the overlay as captured when it did NOT participate — another provider's
     * ([FOREIGN], with its provider and model) or [UNREADABLE].
     */
    @Serializable
    data class OutsideOverlay(
        val state: String,
        val provider: String? = null,
        val model: String? = null,
    ) {
        companion object {
            const val FOREIGN = "foreign"
            const val UNREADABLE = "unreadable"
        }
    }

    /**
     * The decision, persisted before any store changes. A file store participates when its field
     * is non-null; its captured value is what the repair may replace. Everything else is left alone.
     *
     * [prefs] and [defaultAtDecision] are the rest of what [decide] saw, so [provenTarget] can
     * recompute the decision later without depending on today's registry (v2.9 §2).
     */
    @Serializable
    data class RepairIntent(
        val version: Int = INTENT_VERSION,
        val state: String = STATE_PENDING,
        val provider: String,
        val authType: String,
        val target: String,
        val defaultAtDecision: String,
        /** Retired ids seen when deciding — the notice text, and [provenTarget]'s retired set. */
        val retired: List<String> = emptyList(),
        val runtime: ModelTuple? = null,
        val overlay: CapturedOverlay? = null,
        val overlayOutside: OutsideOverlay? = null,
        val prefs: ModelTuple? = null,
    ) {
        val scope: Scope get() = Scope(provider, authType)
    }

    /** What the boot transaction hands to reconcile (contract v2.4 §2). */
    data class ApprovedTarget(val provider: String, val authType: String, val model: String)

    /**
     * The stores' model-relevant content, read under the lock.
     *
     * [prefs] is `seekerclaw_prefs` as stored (auth normalised, never lowered for a missing token;
     * v2.9 §1). [runtime] is runtime_state.json when it is [RuntimeStateFile.Read.Present];
     * [runtimeRead] keeps the three states. [oauthUsable] / [apiKeySaved] feed the OpenAI
     * transport ([OpenAIAuth]).
     */
    data class Snapshot(
        val prefs: ModelTuple,
        val runtime: ModelTuple?,
        val overlay: AgentSettingsFile.Read,
        val runtimeRead: RuntimeStateFile.Read =
            runtime?.let { RuntimeStateFile.Read.Present(it) } ?: RuntimeStateFile.Read.Missing,
        val oauthUsable: Boolean = true,
        val apiKeySaved: Boolean = false,
    ) {
        init {
            require(runtime == (runtimeRead as? RuntimeStateFile.Read.Present)?.tuple) { "runtime and runtimeRead disagree" }
        }

        /** The provider and auth as stored: runtime_state first, then prefs — the order Node reads them. */
        val selected: Scope get() = Scope(runtime?.provider ?: prefs.provider, runtime?.authType ?: prefs.authType)

        /** The (provider, auth) requests actually use: [selected], with OpenAI's auth resolved by [OpenAIAuth]. */
        val transport: Scope get() = transportOf(selected, oauthUsable, apiKeySaved)
    }

    /**
     * v2.9 §1: Node's transport rule (`config.js` `OPENAI_AUTH_TYPE` / `OPENAI_OAUTH_RECONNECT_REQUIRED`).
     * Other providers' transport is their selected auth.
     */
    fun transportOf(selected: Scope, oauthUsable: Boolean, apiKeySaved: Boolean): Scope {
        if (selected.provider != "openai") return selected
        val auth = when (OpenAIAuth.effective(selected.authType, oauthUsable, apiKeySaved)) {
            OpenAIAuth.Effective.OAUTH -> "oauth"
            OpenAIAuth.Effective.API_KEY -> "api_key"
            OpenAIAuth.Effective.RECONNECT -> TRANSPORT_RECONNECT
        }
        return Scope(selected.provider, auth)
    }

    /** Registry lookups, injectable so the decision table is testable without assets. */
    interface Rules {
        fun retired(provider: String, authType: String): List<String>
        fun default(provider: String, authType: String): String

        object Registry : Rules {
            override fun retired(provider: String, authType: String) = ModelRegistry.retiredModelsFor(provider, authType)
            override fun default(provider: String, authType: String) = ModelRegistry.defaultModelForProvider(provider, authType)
        }
    }

    // ------------------------------------------------------------------------------ decision

    data class Scope(val provider: String, val authType: String)

    /** The overlay's (provider, model) when it applies to [scope]: no provider, or the same one. */
    private fun applicableOverlay(read: AgentSettingsFile.Read, scope: Scope): CapturedOverlay? = when (read) {
        is AgentSettingsFile.Read.Absent -> CapturedOverlay(present = false)
        is AgentSettingsFile.Read.Unreadable -> null
        is AgentSettingsFile.Read.Present -> {
            val p = AgentSettingsFile.stringField(read.obj, "provider")
            if (p != null && p != scope.provider) null
            else CapturedOverlay(present = true, provider = p, model = AgentSettingsFile.stringField(read.obj, "model"))
        }
    }

    /** v2.10 §1: the overlay when it does not participate; null when it does. */
    private fun outsideOverlay(read: AgentSettingsFile.Read, scope: Scope): OutsideOverlay? = when (read) {
        is AgentSettingsFile.Read.Absent -> null
        is AgentSettingsFile.Read.Unreadable -> OutsideOverlay(OutsideOverlay.UNREADABLE)
        is AgentSettingsFile.Read.Present -> {
            val p = AgentSettingsFile.stringField(read.obj, "provider")
            if (p != null && p != scope.provider) {
                OutsideOverlay(OutsideOverlay.FOREIGN, p, AgentSettingsFile.stringField(read.obj, "model"))
            } else {
                null
            }
        }
    }

    /**
     * v2.1 shared definitions + v2.2 §2 qualification. Returns the intent to persist, or null when
     * nothing qualifies. Pure.
     *
     * - **Scope:** the TRANSPORT (v2.9 §1) has a retired list (today: openai + oauth with a usable
     *   sign-in). A signed-out user on the API-key fallback, or one who must reconnect, is not
     *   repaired; the selection is kept and their next boot with a usable sign-in repairs them.
     * - **Effective model:** an applicable overlay's model, else runtime_state's, else prefs',
     *   else the default — the same precedence as Node's `resolveActiveModel`.
     * - **Qualifies:** the effective model is retired, or a store in scope holds a retired id.
     *   A disagreement between valid models alone never qualifies.
     * - **Target:** the default when the effective model is retired; otherwise the effective
     *   model itself (a valid newer choice — even one no longer listed — is kept).
     */
    fun decide(s: Snapshot, rules: Rules = Rules.Registry): RepairIntent? {
        val scope = s.selected
        if (s.transport != scope) return null
        val retired = rules.retired(scope.provider, scope.authType)
        if (retired.isEmpty()) return null
        fun isRetired(m: String?) = m != null && m.trim() in retired

        val overlay = applicableOverlay(s.overlay, scope)
        val runtime = s.runtime // when present, it IS the scope source, so it is in scope
        val prefsInScope = s.prefs.provider == scope.provider && s.prefs.authType == scope.authType
        val default = rules.default(scope.provider, scope.authType)
        val effective = overlay?.model
            ?: runtime?.model?.trim()?.ifBlank { null }
            ?: s.prefs.model.trim().ifBlank { null }
            ?: default

        val seen = listOfNotNull(
            effective.takeIf { isRetired(it) },
            runtime?.model?.takeIf { isRetired(it) },
            overlay?.model?.takeIf { isRetired(it) },
            s.prefs.model.takeIf { prefsInScope && isRetired(it) },
        ).map { it.trim() }.distinct()
        if (seen.isEmpty()) return null

        val target = if (isRetired(effective)) default.ifBlank { return null } else effective.trim()
        return RepairIntent(
            provider = scope.provider,
            authType = scope.authType,
            target = target,
            defaultAtDecision = default,
            retired = seen,
            runtime = runtime,
            overlay = overlay,
            overlayOutside = if (overlay == null) outsideOverlay(s.overlay, scope) else null,
            prefs = s.prefs,
        )
    }

    /**
     * v2.9 §2: the target is proven by recomputing [decide] over the intent's captured values and
     * [RepairIntent.defaultAtDecision] (never today's registry), and — for a target other than that
     * default — by a current applicable file that holds it now. The intent alone is never proof.
     */
    fun provenTarget(intent: RepairIntent, s: Snapshot): Boolean {
        val effective = intent.overlay?.takeIf { it.present }?.model?.trim()?.ifBlank { null }
            ?: intent.runtime?.model?.trim()?.ifBlank { null }
            ?: intent.prefs?.model?.trim()?.ifBlank { null }
            ?: intent.defaultAtDecision
        val expected = if (effective in intent.retired) intent.defaultAtDecision else effective
        if (intent.target != expected) return false
        if (intent.target == intent.defaultAtDecision) return true
        return currentFileHolds(intent, s)
    }

    /** runtime_state, or an overlay applicable to the intent's provider, holds the target now. */
    private fun currentFileHolds(intent: RepairIntent, s: Snapshot): Boolean {
        val rt = (s.runtimeRead as? RuntimeStateFile.Read.Present)?.tuple
        if (rt != null && rt.provider == intent.provider && rt.authType == intent.authType && rt.model.trim() == intent.target) {
            return true
        }
        val ov = applicableOverlay(s.overlay, intent.scope)
        return ov != null && ov.present && ov.model == intent.target
    }

    /** The result of [classifyIntent] (v2.9 §3, v2.10 §1). */
    sealed class IntentClass {
        /** A newer selection, or a scope change, superseded the whole decision. Deleted under the lock. */
        data class Superseded(val reason: String) : IntentClass()

        /** The target is no longer proven ([provenTarget]): the corrupt path — never seeded, a fresh decision follows. */
        data class Unproven(val reason: String) : IntentClass()

        /** A captured file is Missing or Unreadable (or no file holds the target), with no third value anywhere. */
        data class EvidenceLost(val reason: String) : IntentClass()

        /** `awaiting_main` / `converged`: every participating file holds the target, and so does the dispatch file. */
        object Holds : IntentClass()

        /** Run the repair (always so for a `pending` intent; idempotent). */
        object Pending : IntentClass()
    }

    /** How the overlay looks now, relative to the intent's provider. */
    private sealed class OverlayNow {
        data class Applicable(val model: String?) : OverlayNow()
        data class Foreign(val provider: String, val model: String?) : OverlayNow()
        object Unreadable : OverlayNow()
        object Absent : OverlayNow()
    }

    private fun overlayNow(read: AgentSettingsFile.Read, provider: String): OverlayNow = when (read) {
        AgentSettingsFile.Read.Absent -> OverlayNow.Absent
        is AgentSettingsFile.Read.Unreadable -> OverlayNow.Unreadable
        is AgentSettingsFile.Read.Present -> {
            val p = AgentSettingsFile.stringField(read.obj, "provider")
            val m = AgentSettingsFile.stringField(read.obj, "model")
            if (p != null && p != provider) OverlayNow.Foreign(p, m) else OverlayNow.Applicable(m)
        }
    }

    /**
     * The one classifier (v2.9 §3, v2.10 §1). Pure. Outcomes, in this order:
     *
     * 1. **Superseded** — the selected scope differs from the intent's; or a file holds a value that
     *    is neither the target nor that file's captured value (a blank or retired one counts); or
     *    the overlay changed per v2.10's table (a participating one now names another provider; a
     *    foreign or unreadable one now applies; a foreign one changed provider or model; an
     *    unreadable one became foreign); or, with [main], prefs hold a newer Settings choice
     *    (`:node`'s prefs cache may be stale, so `:node` never applies that check).
     * 2. **Unproven** — [provenTarget] fails.
     * 3. **EvidenceLost** — a captured file is Missing or Unreadable; for a handed-off intent also
     *    "no file holds the target any more" (Node would dispatch from config.json).
     * 4. **Pending** for a `pending` intent; for a handed-off one whose files went back to their
     *    captured values.
     * 5. **Holds** — handed off, and every participating file and the dispatch file hold the target.
     *
     * Ignored (v2.10 §1): an unchanged foreign overlay, an unreadable one that stays unreadable, a
     * non-participating one that is deleted, and a foreign one that becomes unreadable (not in the
     * table; Node's dispatch skips both, so it is treated like "unreadable stays unreadable").
     */
    fun classifyIntent(intent: RepairIntent, s: Snapshot, main: Boolean = false): IntentClass {
        val sel = s.selected
        if (sel != intent.scope) {
            return IntentClass.Superseded("provider/auth changed to ${sel.provider}/${sel.authType}")
        }
        val lost = mutableListOf<String>()

        when (val r = s.runtimeRead) {
            is RuntimeStateFile.Read.Present -> {
                val m = r.tuple.model
                if (m != intent.target && (intent.runtime == null || m != intent.runtime.model)) {
                    return IntentClass.Superseded("runtime_state holds a newer model")
                }
            }
            RuntimeStateFile.Read.Missing -> if (intent.runtime != null) lost += "runtime_state missing"
            is RuntimeStateFile.Read.Unreadable -> if (intent.runtime != null) lost += "runtime_state unreadable"
        }

        val now = overlayNow(s.overlay, intent.provider)
        val cap = intent.overlay
        if (cap != null) {
            when (now) {
                is OverlayNow.Foreign -> return IntentClass.Superseded("agent_settings.json now names another provider")
                OverlayNow.Unreadable -> lost += "agent_settings.json unreadable"
                OverlayNow.Absent -> if (cap.present) lost += "agent_settings.json deleted"
                is OverlayNow.Applicable -> {
                    val captured = if (cap.present) cap.model?.trim()?.ifBlank { null } else null
                    val ok = now.model == intent.target || (cap.present && now.model == captured)
                    if (!ok) return IntentClass.Superseded("agent_settings.json holds a newer model")
                }
            }
        } else {
            val out = intent.overlayOutside
            when (now) {
                is OverlayNow.Applicable -> return IntentClass.Superseded("agent_settings.json now applies to ${intent.provider}")
                is OverlayNow.Foreign -> when {
                    out?.state != OutsideOverlay.FOREIGN ->
                        return IntentClass.Superseded("agent_settings.json now names another provider")
                    now.provider != out.provider || now.model != out.model ->
                        return IntentClass.Superseded("agent_settings.json now holds another provider's newer model")
                }
                OverlayNow.Unreadable, OverlayNow.Absent -> Unit
            }
        }

        if (main) {
            val cp = intent.prefs
            if (cp != null && (s.prefs.provider != cp.provider || s.prefs.authType != cp.authType)) {
                return IntentClass.Superseded("Settings holds a newer provider or sign-in type")
            }
            val pm = s.prefs.model.trim()
            if (pm != intent.target && pm != cp?.model?.trim()) {
                return IntentClass.Superseded("Settings holds a newer model")
            }
        }

        if (!provenTarget(intent, s)) return IntentClass.Unproven("target ${intent.target} is not proven")
        if (lost.isNotEmpty()) return IntentClass.EvidenceLost(lost.joinToString(", "))
        if (intent.state == STATE_PENDING) return IntentClass.Pending

        val dispatch = NodeDispatch.winner(s.runtimeRead, s.overlay, s.prefs.provider, s.prefs.model)
        if (dispatch.source == NodeDispatch.Source.CONFIG) {
            return IntentClass.EvidenceLost("no file holds ${intent.target}")
        }
        val runtimeHolds = intent.runtime == null ||
            (s.runtimeRead as? RuntimeStateFile.Read.Present)?.tuple?.model == intent.target
        val overlayHolds = cap == null || (now as? OverlayNow.Applicable)?.model == intent.target
        return if (runtimeHolds && overlayHolds && dispatch.model == intent.target) IntentClass.Holds else IntentClass.Pending
    }

    private fun IntentClass.dropsIntent() = this is IntentClass.Superseded || this is IntentClass.Unproven

    /**
     * The repair that governs the stores as things stand now, read-only (v2.9 §3): a standing
     * intent (any state that is not Superseded or Unproven), else a fresh decision; null when there
     * is none. Writes nothing. [main]: the caller holds MAIN's prefs, so the newer-Settings check
     * applies.
     *
     * Codex re-review of 29ed3c72 (#1): an ordinary load must not destroy the repair's input. With
     * prefs and runtime_state on a retired id and the overlay on a valid unlisted model, reconcile
     * would clamp the overlay model to the default and commit it; the start would then see nothing
     * retired, and the user's model would be lost. Reconcile asks this first and, while a repair
     * is pending in its scope, leaves the stored model alone ([ConfigManager] reconcile).
     */
    fun pendingRepair(filesDir: Path, s: Snapshot, rules: Rules = Rules.Registry, main: Boolean = false): RepairIntent? {
        val existing = readIntent(filesDir)
        if (existing is IntentRead.Present && !classifyIntent(existing.intent, s, main).dropsIntent()) {
            return existing.intent
        }
        return decide(s, rules)
    }

    // ---------------------------------------------------------------------------- intent file

    sealed class IntentRead {
        object Absent : IntentRead()
        data class Corrupt(val reason: String) : IntentRead()
        data class Present(val intent: RepairIntent) : IntentRead()
    }

    fun intentPath(filesDir: Path): Path = filesDir.resolve(INTENT_NAME)

    private fun decodeIntent(text: String): IntentRead = try {
        val i = json.decodeFromString(RepairIntent.serializer(), text)
        when {
            i.version != INTENT_VERSION -> IntentRead.Corrupt("version ${i.version}")
            i.state !in STATES -> IntentRead.Corrupt("state ${i.state}")
            else -> IntentRead.Present(i)
        }
    } catch (e: Exception) {
        IntentRead.Corrupt(e.message ?: e.javaClass.simpleName)
    }

    fun readIntent(filesDir: Path): IntentRead {
        val p = intentPath(filesDir)
        if (!SafeFs.existsNoFollow(p)) return IntentRead.Absent
        return try {
            decodeIntent(SafeFs.readTextNoFollow(filesDir, p))
        } catch (e: Exception) {
            IntentRead.Corrupt(e.message ?: e.javaClass.simpleName)
        }
    }

    /** Checked: temp + force + ATOMIC_MOVE + checked dir fsync + no-follow read-back. Throws. */
    fun writeIntent(filesDir: Path, intent: RepairIntent) {
        SafeFs.writeAtomicVerified(
            filesDir,
            intentPath(filesDir),
            json.encodeToString(RepairIntent.serializer(), intent).toByteArray(Charsets.UTF_8),
        )
    }

    /**
     * v2.10 §2: a visible intent confirmed in THIS start — rewritten byte for byte with
     * [SafeFs.rewriteVerified] (full byte equality), and the confirmed bytes still decode to
     * [intent]. Returns false on any failure; the caller then makes no repair write.
     */
    internal fun confirmIntent(filesDir: Path, intent: RepairIntent): Boolean = try {
        val bytes = SafeFs.rewriteVerified(filesDir, intentPath(filesDir))
        (decodeIntent(String(bytes, Charsets.UTF_8)) as? IntentRead.Present)?.intent == intent
    } catch (e: Exception) {
        LogCollector.append("[ModelRepair] could not confirm the repair record (${e.message})", LogLevel.WARN)
        false
    }

    /** Checked delete. Throws. */
    fun deleteIntent(filesDir: Path) = SafeFs.deleteChecked(filesDir, intentPath(filesDir))

    private fun deleteDropped(filesDir: Path) {
        try {
            deleteIntent(filesDir)
        } catch (e: Exception) {
            LogCollector.append("[ModelRepair] could not clear a cancelled repair intent: ${e.message}", LogLevel.WARN)
        }
    }

    private fun logDropped(c: IntentClass) {
        when (c) {
            is IntentClass.Superseded -> LogCollector.append("[ModelRepair] pending repair cancelled: ${c.reason}")
            is IntentClass.Unproven -> LogCollector.append("[ModelRepair] repair intent no longer proven (${c.reason}) — ignored", LogLevel.WARN)
            else -> Unit
        }
    }

    /**
     * v2.5 §2 / v2.9 §5: a successful explicit selection cancels the intent, whatever its state.
     * Called by `saveConfig` with the transaction still held. Best-effort: a failure is logged, and
     * the next MAIN load classifies the newer prefs choice as Superseded anyway.
     */
    fun cancelAfterSelection(tx: ModelSelectionLock.Tx, filesDir: Path) {
        tx.requireOpen()
        if (readIntent(filesDir) is IntentRead.Absent) return
        try {
            deleteIntent(filesDir)
            LogCollector.append("[ModelRepair] pending repair cancelled by a new model selection")
        } catch (e: Exception) {
            LogCollector.append(
                "[ModelRepair] could not clear the repair intent after a selection (${e.message}) — the next start cancels it",
                LogLevel.WARN,
            )
        }
    }

    // -------------------------------------------------------------------------------- planning

    /** What the boot transaction does this start ([plan]). */
    data class Plan(val intent: RepairIntent?, val kind: Kind) {
        enum class Kind {
            /** No repair: an ordinary boot. */
            NONE,

            /** A confirmed intent: run [applyRepair], publish, then [handoff]. */
            REPAIR,

            /** Handed off and still holding (or rebuilt): no repair, no intent write, no notice. */
            AWAITING_MAIN,

            /** Leave the model stores alone this start ([ConfigManager.loadConfigReadOnlyForBoot]). */
            READ_ONLY,
        }

        /** True when this start must not write the model stores. */
        val persistFailed: Boolean get() = kind == Kind.READ_ONLY

        /** The target reconcile and the boot publish carry, when the plan has one. */
        val approved: ApprovedTarget?
            get() = intent?.takeIf { kind == Kind.REPAIR || kind == Kind.AWAITING_MAIN }
                ?.let { ApprovedTarget(it.provider, it.authType, it.target) }

        companion object {
            val NONE = Plan(null, Kind.NONE)
            val PERSIST_FAILED = Plan(null, Kind.READ_ONLY)
        }
    }

    /**
     * Steps 1–2 under the lock, in `:node`'s boot transaction. Never throws; every failure ends in
     * "change nothing this start".
     *
     * An existing intent is classified FIRST ([classifyIntent]), before any fast path:
     *  - Superseded / Unproven / Corrupt: logged, then replaced by a fresh decision's checked write
     *    (or deleted with a checked delete when nothing qualifies).
     *  - `pending` (Pending or EvidenceLost): confirmed in this start ([confirmIntent]) before any
     *    repair write; if that fails, read-only. While the transport is not the sign-in, deferred
     *    (read-only, the intent kept).
     *  - handed off + Holds: [Plan.Kind.AWAITING_MAIN].
     *  - handed off + EvidenceLost: runtime_state rebuilt with [RuntimeStateFile.writeTupleVerified]
     *    (the target is proven), state and suppression kept, no notice.
     *  - handed off + Pending: confirmed, then repaired again; no second notice.
     */
    fun plan(tx: ModelSelectionLock.Tx, filesDir: Path, s: Snapshot, rules: Rules = Rules.Registry): Plan {
        tx.requireOpen()
        var stale = false // an intent file exists that this start replaces or deletes
        when (val existing = readIntent(filesDir)) {
            is IntentRead.Present -> {
                val i = existing.intent
                val c = classifyIntent(i, s, main = false)
                if (c.dropsIntent()) {
                    logDropped(c)
                    stale = true
                } else {
                    return planFor(tx, filesDir, i, c, s)
                }
            }
            is IntentRead.Corrupt -> {
                LogCollector.append("[ModelRepair] repair intent unreadable (${existing.reason}) — ignored", LogLevel.WARN)
                stale = true
            }
            IntentRead.Absent -> Unit
        }
        val fresh = decide(s, rules)
        if (fresh == null) {
            if (stale) deleteDropped(filesDir)
            return Plan.NONE
        }
        return try {
            writeIntent(filesDir, fresh) // replaces a cancelled or corrupt one
            Plan(fresh, Plan.Kind.REPAIR)
        } catch (e: Exception) {
            LogCollector.append(
                "[ModelRepair] could not persist the repair intent (${e.message}) — stores left as they are, retry next start",
                LogLevel.WARN,
            )
            Plan.PERSIST_FAILED
        }
    }

    private fun planFor(tx: ModelSelectionLock.Tx, filesDir: Path, i: RepairIntent, c: IntentClass, s: Snapshot): Plan {
        val handedOff = i.state != STATE_PENDING
        if (handedOff && c is IntentClass.Holds) return Plan(i, Plan.Kind.AWAITING_MAIN)
        if (handedOff && c is IntentClass.EvidenceLost) {
            // v2.9 §3: rebuild, keep the state, no notice. The target is proven (Unproven drops it).
            return try {
                RuntimeStateFile.writeTupleVerified(tx, filesDir, ModelTuple(i.provider, i.authType, i.target))
                LogCollector.append("[ModelRepair] runtime_state rebuilt on ${i.target} (${c.reason})")
                Plan(i, Plan.Kind.AWAITING_MAIN)
            } catch (e: Exception) {
                LogCollector.append(
                    "[ModelRepair] could not rebuild runtime_state (${e.message}) — model settings left as they are this start, retry next start",
                    LogLevel.WARN,
                )
                Plan(i, Plan.Kind.READ_ONLY)
            }
        }
        // Pending, or EvidenceLost on a pending intent: a repair write follows.
        if (s.transport != i.scope) {
            LogCollector.append(TRANSPORT_DEFERRED_WARNING, LogLevel.WARN)
            return Plan(i, Plan.Kind.READ_ONLY)
        }
        // v2.10 §2 + binding clarification 1 (8161bc04): confirmed in THIS start before any repair write.
        if (!confirmIntent(filesDir, i)) {
            LogCollector.append(CONFIRM_FAILED_WARNING, LogLevel.WARN)
            return Plan(i, Plan.Kind.READ_ONLY)
        }
        return Plan(i, Plan.Kind.REPAIR)
    }

    /**
     * Step 3: runtime_state, then the overlay, `model` only. Stops at the first failure (the
     * intent keeps the decision; the next start resumes). Returns true when every write landed.
     *
     * A captured runtime_state that is now Missing or Unreadable (EvidenceLost) is rebuilt with a
     * checked write. A participating overlay that is now unreadable is skipped: Node's dispatch
     * skips it too, and [handoff] makes sure runtime_state carries the target.
     */
    fun applyRepair(tx: ModelSelectionLock.Tx, filesDir: Path, intent: RepairIntent): Boolean {
        tx.requireOpen()
        return try {
            if (intent.runtime != null) {
                when (val r = RuntimeStateFile.read(filesDir)) {
                    is RuntimeStateFile.Read.Present ->
                        if (r.tuple.model != intent.target) RuntimeStateFile.writeModel(filesDir, intent.target)
                    else -> RuntimeStateFile.writeTupleVerified(tx, filesDir, ModelTuple(intent.provider, intent.authType, intent.target))
                }
            }
            if (intent.overlay != null) {
                val obj = when (val r = AgentSettingsFile.read(filesDir)) {
                    is AgentSettingsFile.Read.Present -> r.obj
                    AgentSettingsFile.Read.Absent -> JsonObject(emptyMap())
                    is AgentSettingsFile.Read.Unreadable -> null
                }
                if (obj != null && AgentSettingsFile.stringField(obj, "model") != intent.target) {
                    AgentSettingsFile.write(filesDir, AgentSettingsFile.with(obj, "model", JsonPrimitive(intent.target)))
                }
            }
            true
        } catch (e: Exception) {
            LogCollector.append("[ModelRepair] repair write failed (${e.message}) — will resume next start", LogLevel.WARN)
            false
        }
    }

    /** The notice (v2.10 §2): logged once, right after the confirmed `pending` → `awaiting_main` rewrite. */
    internal fun notice(intent: RepairIntent): String {
        val from = intent.retired.joinToString("/").ifBlank { "a retired model" }
        return "[ModelRepair] ${intent.provider} model $from is not available with ChatGPT sign-in — now ${intent.target}"
    }

    /**
     * Step 5 (v2.8 §2, v2.9 §4, v2.10 §3): hand the repair to MAIN on a DURABLE file.
     *  1. Node's dispatch file ([NodeDispatch]) must be a file holding the target. When it would
     *     be config.json (the boot payload is never the handoff), runtime_state is written first
     *     with [RuntimeStateFile.writeTupleVerified], and the winner re-evaluated.
     *  2. The winner is proven durable by a confirmed rewrite ([SafeFs.rewriteVerified]); the
     *     read-back must hold the target (and the intent's provider, when it names one).
     *  3. The intent is rewritten as `awaiting_main` ([writeIntent]). Only a confirmed rewrite from
     *     `pending` logs the notice.
     * Any failure leaves the intent as it is; config.json carries the target and the next start
     * retries. Returns true when the `awaiting_main` rewrite was confirmed.
     */
    fun handoff(tx: ModelSelectionLock.Tx, filesDir: Path, intent: RepairIntent, s: Snapshot): Boolean {
        tx.requireOpen()
        fun winner() = NodeDispatch.winner(
            RuntimeStateFile.read(filesDir),
            AgentSettingsFile.read(filesDir),
            s.prefs.provider,
            s.prefs.model,
        )
        var w = winner()
        if (w.source == NodeDispatch.Source.CONFIG) {
            try {
                RuntimeStateFile.writeTupleVerified(tx, filesDir, ModelTuple(intent.provider, intent.authType, intent.target))
            } catch (e: Exception) {
                LogCollector.append("[ModelRepair] runtime_state not saved (${e.message}) — repair stays pending, retry next start", LogLevel.WARN)
                return false
            }
            w = winner()
        }
        if (w.source == NodeDispatch.Source.CONFIG || w.model != intent.target) {
            LogCollector.append("[ModelRepair] the agent's model file is not on ${intent.target} — repair stays pending, retry next start", LogLevel.WARN)
            return false
        }
        val file = if (w.source == NodeDispatch.Source.OVERLAY) AgentSettingsFile.path(filesDir) else RuntimeStateFile.path(filesDir)
        try {
            val back = SafeFs.rewriteVerified(filesDir, file)
            val o = Json.parseToJsonElement(String(back, Charsets.UTF_8)) as? JsonObject
                ?: throw java.io.IOException("read-back is not a JSON object")
            val p = AgentSettingsFile.stringField(o, "provider")
            if (AgentSettingsFile.stringField(o, "model") != intent.target || (p != null && p != intent.provider)) {
                throw java.io.IOException("read-back does not hold ${intent.target}")
            }
        } catch (e: Exception) {
            LogCollector.append(
                "[ModelRepair] could not confirm ${file.fileName} on disk (${e.message}) — repair stays pending, retry next start",
                LogLevel.WARN,
            )
            return false
        }
        try {
            writeIntent(filesDir, intent.copy(state = STATE_AWAITING_MAIN))
        } catch (e: SafeFs.WriteUnconfirmed) {
            LogCollector.append("[ModelRepair] handoff to the app not confirmed (${e.message}) — the next start checks again", LogLevel.WARN)
            return false
        } catch (e: Exception) {
            LogCollector.append("[ModelRepair] could not record the handoff (${e.message}) — repair stays pending, retry next start", LogLevel.WARN)
            return false
        }
        if (intent.state == STATE_PENDING) LogCollector.append(notice(intent))
        return true
    }

    // ---------------------------------------------------------------------------- service start

    /** What a boot step that loads, emits and publishes returns ([boot]). */
    data class Published<R>(val result: R, val published: Boolean)

    /**
     * The boot transaction's body (v2.4 §1, v2.8 – v2.10), with the config-specific steps injected
     * so the order is testable on real files: [plan], the repair, then [publish] (load with the
     * approved target, emit config.json, publish the overlay), then [handoff].
     *
     * [publish] gets `publishModelFields = false` when the intent's overlay does not participate
     * (binding clarification 2, `8161bc04`): a foreign overlay keeps its own tuple, so it stays
     * foreign through the real publisher, and the repair rests on runtime_state.
     */
    internal fun <R> boot(
        tx: ModelSelectionLock.Tx,
        filesDir: Path,
        s: Snapshot,
        repair: (ModelSelectionLock.Tx, Path, RepairIntent) -> Boolean,
        readOnly: () -> R?,
        publish: (approved: ApprovedTarget?, publishModelFields: Boolean) -> Published<R>?,
        rules: Rules = Rules.Registry,
    ): R? {
        val plan = plan(tx, filesDir, s, rules)
        val repaired = when (plan.kind) {
            Plan.Kind.READ_ONLY -> false
            Plan.Kind.REPAIR -> repair(tx, filesDir, plan.intent!!)
            else -> true
        }
        if (!repaired) {
            LogCollector.append(REPAIR_FAILED_BOOT_WARNING, LogLevel.WARN)
            return readOnly()
        }
        val intent = plan.intent
        val out = publish(plan.approved, intent == null || intent.overlay != null) ?: return null
        if (plan.kind == Plan.Kind.REPAIR && intent != null) {
            // A write under this transaction that did not reach disk, or a failed publish: the stores
            // are not known to hold the target, so the intent stays pending for the next start.
            if (!out.published || tx.writeFailed) {
                LogCollector.append(PUBLISH_FAILED_WARNING, LogLevel.WARN)
            } else {
                handoff(tx, filesDir, intent, s)
            }
        }
        return out.result
    }

    /**
     * The service-start transaction. Replaces the separate config.json and agent_settings.json
     * writes in `SeekerClawService.continueStart`.
     *
     * [emit] writes config.json from the given config and returns the boot channel; production
     * passes [ConfigManager.emitConfigJson]. Throws what [emit] throws (the service ends the
     * start through failBeforeNode). Returns null when no config could be loaded.
     *
     * A repair write that fails, an intent that could not be persisted or confirmed, or a repair
     * waiting for the sign-in ends the model work for this start: the boot continues read-only
     * for the model stores (compute-only reconcile, config.json only, no overlay publish), and
     * the intent stays for the next start.
     */
    fun serviceStart(
        context: Context,
        /** The repair step; injectable only so a failed repair write is testable. */
        repair: (ModelSelectionLock.Tx, Path, RepairIntent) -> Boolean = ::applyRepair,
        emit: (AppConfig) -> String,
    ): String? {
        val filesDir = context.filesDir.toPath()
        val r = ModelSelectionLock.transaction { tx ->
            boot(
                tx,
                filesDir,
                ConfigManager.modelSnapshot(context),
                repair,
                readOnly = { ConfigManager.loadConfigReadOnlyForBoot(context)?.let(emit) },
                publish = { approved, publishModelFields ->
                    val config = ConfigManager.loadConfigForBoot(context, tx, approved)
                    if (config == null) {
                        LogCollector.append("[Config] service start: no config to publish (setup incomplete?)", LogLevel.WARN)
                        null
                    } else {
                        val channel = emit(config)
                        val leftAsIs = overlayLeftAsIs(filesDir, config.provider)
                        if (leftAsIs != null) {
                            LogCollector.append(leftAsIs)
                            Published(channel, true)
                        } else {
                            Published(channel, ConfigManager.writeAgentSettingsJson(context, tx, config, publishModelFields))
                        }
                    }
                },
            )
        }
        return when (r) {
            is ModelSelectionLock.Result.Acquired -> r.value
            is ModelSelectionLock.Result.Busy -> {
                // v2.5 §1: no decision, no intent, no repair, no reconcile commit, no runtime or
                // overlay write. config.json is this boot's own file; the raw model is carried.
                LogCollector.append(BUSY_WARNING, LogLevel.WARN)
                ConfigManager.loadConfigReadOnlyForBoot(context)?.let(emit)
            }
        }
    }

    // ------------------------------------------------------------------------------- MAIN load

    /** What [mainLoad] leaves for reconcile: the repair governing the stores, and whether prefs changed. */
    data class MainLoad(val pending: RepairIntent?, val prefsChanged: Boolean)

    /**
     * MAIN's locked load (v2.8 §3, v2.9 §3–§5), before reconcile. [snapshot] reads the stores
     * fresh (MAIN's prefs); [sync] is the same-scope prefs sync from runtime_state
     * ([com.seekerclaw.app.state.RuntimeStateStore.syncPrefsFromFile]) moving prefs only to
     * `onlyTo` when it is non-null, returning true when prefs changed; a failed commit marks [tx].
     *
     *  - **No intent:** a fresh [decide], then the sync limited to its target (today's rule).
     *  - **Corrupt / Unproven:** WARN, checked delete, then as "no intent". Never used for seeding.
     *  - **Superseded:** as "no intent" (the newer selection is synced), then the intent is
     *    deleted with a checked delete once the prefs commit succeeded.
     *  - **Pending** (and EvidenceLost on a `pending` intent): the sync may move prefs only to the
     *    target; the intent is left to `:node`.
     *  - **Handed off, Holds or EvidenceLost:** a missing runtime_state is seeded from the intent
     *    ([RuntimeStateFile.writeTupleVerified]); prefs are synced to the target, then the model is
     *    committed with a forced, checked write ([commitModel]); only then is `awaiting_main`
     *    rewritten as `converged`. Any failure leaves the intent
     *    `awaiting_main` for the next load. Not while the transport is not the sign-in (MAIN does
     *    not finalise then).
     */
    fun mainLoad(
        tx: ModelSelectionLock.Tx,
        filesDir: Path,
        snapshot: () -> Snapshot,
        sync: (onlyTo: String?) -> Boolean,
        /**
         * A real, checked commit of the prefs model ([com.seekerclaw.app.state.RuntimeStateStore.commitModelChecked]).
         * After a failed commit the in-memory prefs already hold the target, so neither [sync] nor a
         * read-back can tell disk from memory; only a forced write that returns true can.
         */
        commitModel: (model: String) -> Boolean,
        rules: Rules = Rules.Registry,
    ): MainLoad {
        tx.requireOpen()
        fun fresh(): MainLoad {
            val d = try {
                decide(snapshot(), rules)
            } catch (_: IllegalStateException) {
                null // registry not initialised (unit tests); production inits it in Application.onCreate
            }
            return MainLoad(d, sync(d?.target))
        }
        val i = when (val e = readIntent(filesDir)) {
            IntentRead.Absent -> return fresh()
            is IntentRead.Corrupt -> {
                LogCollector.append("[ModelRepair] repair intent unreadable (${e.reason}) — ignored", LogLevel.WARN)
                deleteDropped(filesDir)
                return fresh()
            }
            is IntentRead.Present -> e.intent
        }
        val s = snapshot()
        val c = classifyIntent(i, s, main = true)
        if (c is IntentClass.Unproven) {
            logDropped(c)
            deleteDropped(filesDir)
            return fresh()
        }
        if (c is IntentClass.Superseded) {
            logDropped(c)
            val out = fresh()
            if (tx.writeFailed) {
                LogCollector.append("[ModelRepair] settings not saved — the cancelled repair record is kept until the next load", LogLevel.WARN)
            } else {
                deleteDropped(filesDir)
            }
            return out
        }
        val handedOff = i.state != STATE_PENDING
        if (!handedOff || c is IntentClass.Pending || s.transport != i.scope) {
            return MainLoad(i, sync(i.target))
        }
        // Handed off: Holds or EvidenceLost. Bring prefs to the proven target.
        if (s.runtimeRead !is RuntimeStateFile.Read.Present) {
            try {
                RuntimeStateFile.writeTupleVerified(tx, filesDir, ModelTuple(i.provider, i.authType, i.target))
            } catch (e: Exception) {
                LogCollector.append("[ModelRepair] could not restore runtime_state (${e.message}) — the app retries on its next load", LogLevel.WARN)
                return MainLoad(i, false)
            }
        }
        val changed = sync(i.target)
        val after = snapshot()
        if (tx.writeFailed || after.prefs.model.trim() != i.target) {
            LogCollector.append("[ModelRepair] app settings not yet on ${i.target} — the app retries on its next load", LogLevel.WARN)
            return MainLoad(i, changed)
        }
        if (i.state == STATE_AWAITING_MAIN) {
            // The read-back above may be MAIN's memory after an earlier failed commit: force a real,
            // checked write of the model before `converged` can be recorded.
            if (!commitModel(i.target)) {
                LogCollector.append("[ModelRepair] app settings not yet on ${i.target} — the app retries on its next load", LogLevel.WARN)
                return MainLoad(i, changed)
            }
            try {
                writeIntent(filesDir, i.copy(state = STATE_CONVERGED))
            } catch (e: Exception) {
                LogCollector.append("[ModelRepair] could not record the finished repair (${e.message}) — the app retries on its next load", LogLevel.WARN)
            }
        }
        return MainLoad(i, changed)
    }
}
