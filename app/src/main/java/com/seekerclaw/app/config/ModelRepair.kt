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
 * longer served for that sign-in (contract v2.3 – v2.5, Codex sign-off `bd90691a`).
 *
 * The read rule ([ModelRegistry.applyRetiredModelRule], Node `applyRetiredModelRule`) already
 * keeps every request and screen safe. This makes the STORED value converge, so the agent,
 * Settings and Telegram agree and the read rule stops having to mask anything.
 *
 * Shape (all inside ONE [ModelSelectionLock] transaction, in the `:node` pre-Node segment):
 *  1. **Decide** from the raw stores, or **resume** a persisted intent ([classifyResume]).
 *  2. **Persist the intent, checked** ([SafeFs.writeAtomicVerified]). Any failure → no store is
 *     changed in this start; the retired id stays on disk as the trigger for the next start.
 *  3. **Repair** runtime_state.json, then the overlay — `model` only.
 *  4. **Publish** config.json and the overlay, with [ApprovedTarget] carried into reconcile.
 *  5. **Verify** every participating store, then clear the intent (checked delete).
 * On a lock timeout the start is a **read-only boot**: no shared store is written.
 *
 * Only two things change a stored model: this repair and an explicit user selection. Every
 * other writer carries the stored model through unchanged (v2.4 §0).
 */
object ModelRepair {
    const val INTENT_NAME = "model_repair_intent.json"
    const val INTENT_VERSION = 1

    const val BUSY_WARNING = "[ModelRepair] lock busy at start — read-only boot, repair deferred"

    const val REPAIR_FAILED_BOOT_WARNING = "[ModelRepair] repair incomplete — model settings left as they are this start, retry next start"

    /** A settings write after the repair (prefs commit, runtime_state, the overlay publish) failed. */
    const val PUBLISH_FAILED_WARNING = "[ModelRepair] model settings not fully saved this start — repair stays pending, retry next start"

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    /** The overlay as captured when the intent was created. */
    @Serializable
    data class CapturedOverlay(
        /** false: there was no overlay file; the repair creates one holding only `model`. */
        val present: Boolean,
        val provider: String? = null,
        val model: String? = null,
    )

    /**
     * The decision, persisted before any store changes. A store participates when its field is
     * non-null; its captured value is what the repair may replace. Everything else is left alone.
     */
    @Serializable
    data class RepairIntent(
        val version: Int = INTENT_VERSION,
        val provider: String,
        val authType: String,
        val target: String,
        /** Retired ids seen when deciding — for the INFO line only. */
        val retired: List<String> = emptyList(),
        val runtime: ModelTuple? = null,
        val overlay: CapturedOverlay? = null,
    )

    /** What the boot transaction hands to reconcile (contract v2.4 §2). */
    data class ApprovedTarget(val provider: String, val authType: String, val model: String)

    /** The three stores' model-relevant content, read under the lock. */
    data class Snapshot(
        /** Prefs, with the auth Node would run on when runtime_state is absent. */
        val prefs: ModelTuple,
        val runtime: ModelTuple?,
        val overlay: AgentSettingsFile.Read,
    )

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

    /** The provider and auth Node runs with: runtime_state first, then prefs (config.json). */
    fun runningScope(s: Snapshot): Scope =
        Scope(s.runtime?.provider ?: s.prefs.provider, s.runtime?.authType ?: s.prefs.authType)

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

    /**
     * v2.1 shared definitions + v2.2 §2 qualification. Returns the intent to persist, or null when
     * nothing qualifies. Pure.
     *
     * - **Scope:** the running (provider, auth) has a retired list (today: openai + oauth).
     * - **Effective model:** an applicable overlay's model, else runtime_state's, else prefs',
     *   else the default — the same precedence as Node's `resolveActiveModel`.
     * - **Qualifies:** the effective model is retired, or a store in scope holds a retired id.
     *   A disagreement between valid models alone never qualifies.
     * - **Target:** the default when the effective model is retired; otherwise the effective
     *   model itself (a valid newer choice — even one no longer listed — is kept).
     */
    fun decide(s: Snapshot, rules: Rules = Rules.Registry): RepairIntent? {
        val scope = runningScope(s)
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
            retired = seen,
            runtime = runtime,
            overlay = overlay,
        )
    }

    sealed class Resume {
        /** Every participating store holds its captured value or the target: finish it. */
        data class Finish(val intent: RepairIntent) : Resume()

        /** A newer selection (or a scope change) superseded the whole decision. */
        data class Cancel(val reason: String) : Resume()
    }

    /**
     * v2.4 §3. Each participating store must hold exactly its captured value or the target; a
     * third value anywhere, or a scope change, cancels the WHOLE old decision (its target is
     * written nowhere). There is no per-store "superseded, finish the rest". Pure.
     */
    fun classifyResume(intent: RepairIntent, s: Snapshot): Resume {
        val scope = runningScope(s)
        if (scope.provider != intent.provider || scope.authType != intent.authType) {
            return Resume.Cancel("provider/auth changed to ${scope.provider}/${scope.authType}")
        }
        intent.runtime?.let { cap ->
            val cur = s.runtime ?: return Resume.Cancel("runtime_state no longer readable")
            if (cur.model != cap.model && cur.model != intent.target) {
                return Resume.Cancel("runtime_state holds a newer model")
            }
        }
        intent.overlay?.let { cap ->
            if (!overlayMatches(cap, intent.target, s.overlay, scope)) {
                return Resume.Cancel("agent_settings.json holds a newer model")
            }
        }
        // The overlay did not participate (unreadable, or another provider's) but now applies:
        // the publisher rewrote it, possibly from a still-retired prefs model. Finishing would leave
        // it and prefs unrepaired with the intent stuck; a fresh decision captures it instead.
        if (intent.overlay == null && applicableOverlay(s.overlay, scope) != null) {
            return Resume.Cancel("agent_settings.json now applies to ${scope.provider}")
        }
        return Resume.Finish(intent)
    }

    /**
     * Whether the overlay, as it is now, still belongs to the captured decision: it holds the
     * captured value, or the repair already moved it to [target].
     */
    internal fun overlayMatches(
        cap: CapturedOverlay,
        target: String,
        now: AgentSettingsFile.Read,
        scope: Scope,
    ): Boolean {
        // When unsure, cancel: a fresh decision runs right after, so a cancel is always safe;
        // finishing wrongly would overwrite a model the user chose in between.
        return when (now) {
            is AgentSettingsFile.Read.Unreadable -> false
            AgentSettingsFile.Read.Absent -> !cap.present
            is AgentSettingsFile.Read.Present -> {
                // The repair writes only `model`; the publisher fills `provider` later. A missing
                // provider is still ours; one naming another provider is not.
                val p = AgentSettingsFile.stringField(now.obj, "provider")
                if (p != null && p != scope.provider) return false
                val m = AgentSettingsFile.stringField(now.obj, "model")
                m == target || (cap.present && m == cap.model?.trim()?.ifBlank { null })
            }
        }
    }

    // ---------------------------------------------------------------------------- intent file

    sealed class IntentRead {
        object Absent : IntentRead()
        data class Corrupt(val reason: String) : IntentRead()
        data class Present(val intent: RepairIntent) : IntentRead()
    }

    fun intentPath(filesDir: Path): Path = filesDir.resolve(INTENT_NAME)

    fun readIntent(filesDir: Path): IntentRead {
        val p = intentPath(filesDir)
        if (!SafeFs.existsNoFollow(p)) return IntentRead.Absent
        return try {
            val i = json.decodeFromString(RepairIntent.serializer(), SafeFs.readTextNoFollow(filesDir, p))
            if (i.version != INTENT_VERSION) IntentRead.Corrupt("version ${i.version}") else IntentRead.Present(i)
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

    /** Checked delete. Throws. */
    fun deleteIntent(filesDir: Path) = SafeFs.deleteChecked(filesDir, intentPath(filesDir))

    /**
     * v2.5 §2: a successful explicit selection cancels a pending repair. Called by `saveConfig`
     * with the transaction still held. A failure is logged: on the next start the new selection
     * is a third value, so the old intent cancels itself there anyway.
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

    /**
     * The outcome of step 1–2: the intent to carry out (persisted), or none. [persistFailed]: a
     * repair was needed but its intent could not be written — distinct from "nothing to repair",
     * because the start must then leave the model stores alone ([serviceStart]).
     */
    data class Plan(val intent: RepairIntent?, val persistFailed: Boolean = false) {
        val approved: ApprovedTarget? get() = intent?.let { ApprovedTarget(it.provider, it.authType, it.target) }

        companion object {
            val NONE = Plan(null)
            val PERSIST_FAILED = Plan(null, persistFailed = true)
        }
    }

    /** Steps 1–2 under the lock. Never throws; every failure ends in "change nothing this start". */
    fun plan(tx: ModelSelectionLock.Tx, filesDir: Path, s: Snapshot, rules: Rules = Rules.Registry): Plan {
        tx.requireOpen()
        var stale = false // an intent file exists that this start will not carry out
        when (val existing = readIntent(filesDir)) {
            is IntentRead.Present -> when (val r = classifyResume(existing.intent, s)) {
                is Resume.Finish -> return Plan(r.intent)
                is Resume.Cancel -> {
                    LogCollector.append("[ModelRepair] pending repair cancelled: ${r.reason}")
                    stale = true
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
            if (stale) {
                try {
                    deleteIntent(filesDir)
                } catch (e: Exception) {
                    LogCollector.append("[ModelRepair] could not clear a cancelled repair intent: ${e.message}", LogLevel.WARN)
                }
            }
            return Plan.NONE
        }
        return try {
            writeIntent(filesDir, fresh) // replaces a cancelled or corrupt one
            Plan(fresh)
        } catch (e: Exception) {
            LogCollector.append(
                "[ModelRepair] could not persist the repair intent (${e.message}) — stores left as they are, retry next start",
                LogLevel.WARN,
            )
            Plan.PERSIST_FAILED
        }
    }

    /**
     * Step 3: runtime_state, then the overlay, `model` only. Stops at the first failure (the
     * intent keeps the decision; the next start resumes). Returns true when every write landed.
     */
    fun applyRepair(tx: ModelSelectionLock.Tx, filesDir: Path, intent: RepairIntent): Boolean {
        tx.requireOpen()
        return try {
            if (intent.runtime != null && RuntimeStateFile.readTuple(filesDir)?.model != intent.target) {
                RuntimeStateFile.writeModel(filesDir, intent.target)
            }
            if (intent.overlay != null) {
                val obj = when (val r = AgentSettingsFile.read(filesDir)) {
                    is AgentSettingsFile.Read.Present -> r.obj
                    AgentSettingsFile.Read.Absent -> JsonObject(emptyMap())
                    is AgentSettingsFile.Read.Unreadable -> throw java.io.IOException("overlay unreadable: ${r.reason}")
                }
                if (AgentSettingsFile.stringField(obj, "model") != intent.target) {
                    AgentSettingsFile.write(filesDir, AgentSettingsFile.with(obj, "model", JsonPrimitive(intent.target)))
                }
            }
            true
        } catch (e: Exception) {
            LogCollector.append("[ModelRepair] repair write failed (${e.message}) — will resume next start", LogLevel.WARN)
            false
        }
    }

    /**
     * Step 5: every participating store, and prefs when in scope, holds the target → clear the
     * intent. Returns true when the intent was cleared.
     */
    fun verifyAndClear(tx: ModelSelectionLock.Tx, filesDir: Path, intent: RepairIntent, prefs: ModelTuple): Boolean {
        tx.requireOpen()
        val runtimeOk = intent.runtime == null || RuntimeStateFile.readTuple(filesDir)?.model == intent.target
        val overlayOk = intent.overlay == null ||
            (AgentSettingsFile.read(filesDir) as? AgentSettingsFile.Read.Present)
                ?.let { AgentSettingsFile.stringField(it.obj, "model") } == intent.target
        val prefsInScope = prefs.provider == intent.provider && prefs.authType == intent.authType
        val prefsOk = !prefsInScope || prefs.model.trim() == intent.target
        if (!(runtimeOk && overlayOk && prefsOk)) {
            LogCollector.append(
                "[ModelRepair] stores not yet on ${intent.target} (runtime=$runtimeOk overlay=$overlayOk prefs=$prefsOk) — will resume next start",
                LogLevel.WARN,
            )
            return false
        }
        return try {
            deleteIntent(filesDir)
            val from = intent.retired.joinToString("/").ifBlank { "a retired model" }
            LogCollector.append("[ModelRepair] ${intent.provider} model $from is not available with ChatGPT sign-in — now ${intent.target}")
            true
        } catch (e: Exception) {
            LogCollector.append("[ModelRepair] stores repaired but the intent could not be cleared (${e.message})", LogLevel.WARN)
            false
        }
    }

    // ---------------------------------------------------------------------------- service start

    /**
     * The service-start transaction (v2.4 §1, v2.5 §1). Replaces the
     * separate config.json and agent_settings.json writes in `SeekerClawService.continueStart`.
     *
     * [emit] writes config.json from the given config and returns the boot channel; production
     * passes [ConfigManager.emitConfigJson]. Throws what [emit] throws (the service ends the
     * start through failBeforeNode). Returns null when no config could be loaded.
     *
     * A repair write that fails, or an intent that could not be persisted, ends the model work
     * for this start: the boot continues
     * read-only for the model stores (compute-only reconcile, config.json only, no overlay
     * publish), and the intent stays for the next start. Publishing would write the still-retired
     * prefs model into the overlay, which the next resume would then read as a newer selection
     * and cancel the decision over, losing a valid target such as one kept from runtime_state.
     */
    fun serviceStart(
        context: Context,
        /** The repair step; injectable only so a failed repair write is testable. */
        repair: (ModelSelectionLock.Tx, Path, RepairIntent) -> Boolean = ::applyRepair,
        emit: (AppConfig) -> String,
    ): String? {
        val filesDir = context.filesDir.toPath()
        val r = ModelSelectionLock.transaction { tx ->
            val plan = plan(tx, filesDir, ConfigManager.modelSnapshot(context))
            val repaired = !plan.persistFailed && (plan.intent?.let { repair(tx, filesDir, it) } ?: true)
            if (!repaired) {
                LogCollector.append(REPAIR_FAILED_BOOT_WARNING, LogLevel.WARN)
                return@transaction ConfigManager.loadConfigReadOnly(context)?.let(emit)
            }
            val config = ConfigManager.loadConfigForBoot(context, tx, plan.approved)
            if (config == null) {
                LogCollector.append("[Config] service start: no config to publish (setup incomplete?)", LogLevel.WARN)
                return@transaction null
            }
            val channel = emit(config)
            val published = ConfigManager.writeAgentSettingsJson(context, tx, config, publishModelFields = true)
            plan.intent?.let { intent ->
                // A write under this transaction that did not reach disk (a failed prefs commit
                // keeps the new value in memory, where a re-read would see it) or a failed publish:
                // the stores are not known to be repaired, so the intent stays for the next start.
                if (!published || tx.writeFailed) {
                    LogCollector.append(PUBLISH_FAILED_WARNING, LogLevel.WARN)
                } else {
                    verifyAndClear(tx, filesDir, intent, ConfigManager.modelSnapshot(context).prefs)
                }
            }
            channel
        }
        return when (r) {
            is ModelSelectionLock.Result.Acquired -> r.value
            is ModelSelectionLock.Result.Busy -> {
                // v2.5 §1: no decision, no intent, no repair, no reconcile commit, no runtime or
                // overlay write. config.json is this boot's own file; the raw model is carried.
                LogCollector.append(BUSY_WARNING, LogLevel.WARN)
                ConfigManager.loadConfigReadOnly(context)?.let(emit)
            }
        }
    }
}
