package com.seekerclaw.app.config

import com.seekerclaw.app.state.RuntimeState
import com.seekerclaw.app.testing.PowerLossFs
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogEntry
import com.seekerclaw.app.util.SafeFs
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path

/**
 * BAT-1661 — the durable model repair (contract v2.3 – v2.10; v2.7 – v2.10 signed in `8161bc04`).
 *
 * Two layers:
 *  - the pure decision table and classifier ([ModelRepair.decide], [ModelRepair.classifyIntent],
 *    [ModelRepair.provenTarget]);
 *  - real files in a temp `filesDir`, driven through [boot], which runs the REAL boot orchestration
 *    ([ModelRepair.boot]: plan → repair → publish → handoff) with prefs held as a value instead of
 *    SharedPreferences, and the publish reduced to the real [ConfigManager.resolveModelForReconcile]
 *    plus the overlay write. [mainLoad] runs the REAL [ModelRepair.mainLoad]. A [Crash] thrown
 *    after a step models the process dying there; the next [boot] must converge.
 *
 * The registry is a fixture with the real shape of the retired list (openai + oauth).
 */
class ModelRepairTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var dir: Path
    private val savedDirSync = SafeFs.dirSyncChecked
    private val savedBeforeMove = SafeFs.beforeMove

    /** prefs `provider`/`auth_type`/`model`, as MAIN last wrote them. */
    private var prefs = ModelTuple("openai", "oauth", "gpt-5.4")

    /** The OpenAI transport inputs (v2.9 §1). */
    private var oauthUsable = true
    private var apiKeySaved = false

    private val retired = listOf("gpt-5.5", "gpt-5.4", "gpt-5.4-mini")

    private fun fixture(default: String = "gpt-6.1-sol") = listOf(
        ProviderInfo(
            id = "openai",
            displayName = "OpenAI",
            authTypes = listOf("api_key", "oauth"),
            keyHint = "sk-proj-…",
            consoleUrl = "https://platform.openai.com",
            keysUrl = "https://platform.openai.com/api-keys",
            freeform = false,
            defaultModel = default,
            models = listOf(
                ModelInfo("gpt-6.1-sol", "GPT-6.1 Sol", "yes"),
                ModelInfo("gpt-6-astra", "GPT-6 Astra", "yes"),
                ModelInfo("gpt-5.5", "GPT-5.5", "yes"),
                ModelInfo("gpt-5.4", "GPT-5.4", "yes"),
            ),
            retiredForAuth = mapOf("oauth" to retired),
        ),
        ProviderInfo(
            id = "claude",
            displayName = "Anthropic",
            authTypes = listOf("api_key", "setup_token"),
            keyHint = "sk-ant-api03-…",
            consoleUrl = "https://console.anthropic.com",
            keysUrl = "https://console.anthropic.com/settings/keys",
            freeform = false,
            defaultModel = "claude-opus-5",
            models = listOf(ModelInfo("claude-opus-5", "Opus 5", "yes")),
        ),
    )

    @Before
    fun setUp() {
        dir = tmp.newFolder("files").toPath()
        Files.createDirectories(dir.resolve("workspace"))
        // The production dir fsync opens a directory channel, which Windows JVMs refuse; the
        // seam is what the failure tests drive anyway.
        SafeFs.dirSyncChecked = {}
        ModelSelectionLock.initForTest(dir)
        ModelRegistry.resetForTest()
        ModelRegistry.initForTest(fixture())
    }

    @After
    fun tearDown() {
        SafeFs.dirSyncChecked = savedDirSync
        SafeFs.beforeMove = savedBeforeMove
        ModelSelectionLock.initForTest(null)
        ModelRegistry.resetForTest()
    }

    // ------------------------------------------------------------------------------ fixtures

    /**
     * runtime_state.json as the REAL producer writes it: [com.seekerclaw.app.util.CrossProcessStore]
     * with [RuntimeState.serializer], carrying non-default reasoning fields that must survive.
     */
    private fun writeRuntime(model: String, provider: String = "openai", auth: String = "oauth") {
        val seed = RuntimeState(
            provider = provider,
            authType = auth,
            model = model,
            reasoningEnabled = true,
            reasoningDisplayInChat = true,
        )
        com.seekerclaw.app.util.CrossProcessStore(dir.toFile(), RuntimeStateFile.NAME, RuntimeState.serializer(), seed).write(seed)
    }

    private fun writeOverlay(text: String) {
        writeText(AgentSettingsFile.path(dir), text)
    }

    private fun overlayWithModel(model: String, provider: String? = null) = buildString {
        append("""{"heartbeatIntervalMinutes":45,""")
        if (provider != null) append(""""provider":"$provider",""")
        append(""""model":"$model","apiKeys":{"brave":"KEY-BRAVE"},"custom":[1,2,3]}""")
    }

    private fun writeText(p: Path, text: String) = p.toFile().writeText(text)

    private fun runtimeModel(): String? = RuntimeStateFile.readTuple(dir)?.model

    private fun overlayModel(): String? =
        (AgentSettingsFile.read(dir) as? AgentSettingsFile.Read.Present)?.let { AgentSettingsFile.stringField(it.obj, "model") }

    private fun overlayProvider(): String? =
        (AgentSettingsFile.read(dir) as? AgentSettingsFile.Read.Present)?.let { AgentSettingsFile.stringField(it.obj, "provider") }

    private fun snapshot(p: ModelTuple = prefs): ModelRepair.Snapshot {
        val rr = RuntimeStateFile.read(dir)
        return ModelRepair.Snapshot(
            p,
            (rr as? RuntimeStateFile.Read.Present)?.tuple,
            AgentSettingsFile.read(dir),
            runtimeRead = rr,
            oauthUsable = oauthUsable,
            apiKeySaved = apiKeySaved,
        )
    }

    private fun intent(): ModelRepair.RepairIntent? = (ModelRepair.readIntent(dir) as? ModelRepair.IntentRead.Present)?.intent

    private fun intentPresent() = intent() != null

    private fun intentState() = intent()?.state

    private class Crash(step: String) : RuntimeException("crash after $step")

    private enum class Step { PLAN, REPAIR, PUBLISH }

    /** What one [boot] did. [configModel]: the model config.json carries; [readOnly]: the read-only path ran. */
    private data class BootOut(val configModel: String?, val readOnly: Boolean)

    /**
     * One service start: the REAL [ModelRepair.boot] against real files. The publish is the boot
     * load reduced to reconcile ([ConfigManager.resolveModelForReconcile]) plus the approved-target
     * carry ([ConfigManager] loadConfigUnchecked), then the overlay publisher (provider/authType/model
     * only when `publishModelFields`). In `:node` the RuntimeStateStore is never initialised and the
     * load is compute-only (v2.7 §1): the boot writes no prefs. [nodePrefs]: `:node`'s prefs cache,
     * which may be older than MAIN's.
     */
    private fun boot(crashAfter: Step? = null, nodePrefs: ModelTuple = prefs): BootOut {
        var out: BootOut? = null
        val r = ModelSelectionLock.transaction { tx ->
            ModelRepair.boot(
                tx,
                dir,
                snapshot(nodePrefs),
                repair = { t, d, i ->
                    if (crashAfter == Step.PLAN) throw Crash("plan")
                    val ok = ModelRepair.applyRepair(t, d, i)
                    if (crashAfter == Step.REPAIR) throw Crash("repair")
                    ok
                },
                readOnly = {
                    out = BootOut(nodePrefs.model, readOnly = true)
                    "read-only"
                },
                publish = { approved, publishModelFields ->
                    val runtime = RuntimeStateFile.readTuple(dir)
                    val provider = runtime?.provider ?: nodePrefs.provider
                    val auth = runtime?.authType ?: nodePrefs.authType
                    val reconciled = ConfigManager.resolveModelForReconcile(
                        providerChanged = provider != nodePrefs.provider,
                        authChanged = auth != nodePrefs.authType,
                        newModel = overlayModel(),
                        prefsModel = nodePrefs.model,
                        effectiveProvider = provider,
                        effectiveAuth = auth,
                        approvedTarget = approved,
                    )
                    val model = if (approved != null && approved.provider == provider && approved.authType == auth) approved.model else reconciled
                    out = BootOut(model, readOnly = false)
                    // The production rule: a foreign or unreadable overlay is left byte for byte.
                    val leftAsIs = ModelRepair.overlayLeftAsIs(dir, provider)
                    if (leftAsIs != null) {
                        LogCollector.append(leftAsIs) // as serviceStart's publish step logs it
                        if (crashAfter == Step.PUBLISH) throw Crash("publish")
                        return@boot ModelRepair.Published("telegram", true)
                    }
                    var o = (AgentSettingsFile.read(dir) as? AgentSettingsFile.Read.Present)?.obj ?: JsonObject(emptyMap())
                    o = AgentSettingsFile.with(o, "heartbeatIntervalMinutes", JsonPrimitive(45))
                    if (publishModelFields) {
                        o = AgentSettingsFile.with(o, "provider", JsonPrimitive(provider))
                        o = AgentSettingsFile.with(o, "authType", JsonPrimitive(auth))
                        o = AgentSettingsFile.with(o, "model", JsonPrimitive(model))
                    }
                    AgentSettingsFile.write(dir, o)
                    if (crashAfter == Step.PUBLISH) throw Crash("publish")
                    ModelRepair.Published("telegram", true)
                },
            )
        }
        assertTrue("boot must get the lock", r is ModelSelectionLock.Result.Acquired)
        return out!!
    }

    /**
     * Contract v2.8 §3: a MAIN locked load, through the REAL [ModelRepair.mainLoad]. The sync is
     * [com.seekerclaw.app.state.RuntimeStateStore.syncPrefsFromFile]'s rule: runtime_state's model
     * into prefs when its provider and auth equal prefs', only to `onlyTo` when set.
     */
    private fun mainLoad(failCommit: Boolean = false): ModelRepair.MainLoad {
        val r = ModelSelectionLock.transaction { tx ->
            ModelRepair.mainLoad(
                tx,
                dir,
                snapshot = { snapshot(prefs) },
                sync = { onlyTo ->
                    val rt = RuntimeStateFile.readTuple(dir)
                    if (rt == null || rt.provider != prefs.provider || rt.authType != prefs.authType || rt.model == prefs.model) {
                        false
                    } else if (onlyTo != null && rt.model != onlyTo) {
                        false
                    } else if (failCommit) {
                        tx.markWriteFailed()
                        false
                    } else {
                        prefs = prefs.copy(model = rt.model)
                        true
                    }
                },
                commitModel = { model ->
                    if (failCommit) {
                        tx.markWriteFailed()
                        false
                    } else {
                        prefs = prefs.copy(model = model)
                        true
                    }
                },
            )
        }
        return (r as ModelSelectionLock.Result.Acquired).value
    }

    private fun bootCrashing(step: Step) {
        try {
            boot(step)
            throw AssertionError("expected a crash after $step")
        } catch (_: Crash) {
        }
    }

    private fun anchor(): LogEntry? = LogCollector.logs.value.lastOrNull()

    /** The log is a 300-entry ring shared across the JVM: anchor on an entry by identity. */
    private fun logsSince(anchor: LogEntry?): List<String> {
        val all = LogCollector.logs.value
        val from = if (anchor == null) 0 else all.indexOfFirst { it === anchor } + 1
        assertTrue("anchor still in the ring", anchor == null || from > 0)
        return all.drop(from).map { it.message }
    }

    private fun notices(anchor: LogEntry?) = logsSince(anchor).count { it.contains("is not available with ChatGPT sign-in — now") }

    /**
     * Contract v2.8 §5: the `:node` boot just run left the files on [model] and handed off
     * (`awaiting_main`); a MAIN load brings prefs to it and marks `converged`; the next start
     * changes no model, writes no intent and logs no notice.
     */
    private fun assertAllOn(model: String) {
        assertEquals("overlay", model, overlayModel())
        assertEquals("handed off to MAIN", ModelRepair.STATE_AWAITING_MAIN, intentState())
        mainLoad()
        assertEquals("prefs", model, prefs.model)
        assertEquals("runtime_state", model, runtimeModel())
        assertEquals("MAIN converged", ModelRepair.STATE_CONVERGED, intentState())
        val intentBytes = Files.readAllBytes(ModelRepair.intentPath(dir))
        val a = anchor()
        boot()
        assertEquals("runtime_state after the next start", model, runtimeModel())
        assertEquals("overlay after the next start", model, overlayModel())
        assertEquals("prefs after the next start", model, prefs.model)
        assertArrayEquals("the next start writes no intent", intentBytes, Files.readAllBytes(ModelRepair.intentPath(dir)))
        assertEquals("no notice on the next start", 0, notices(a))
    }

    /** No repair governs: no intent, every store on [model], and a start changes nothing. */
    private fun assertSettledWithoutIntent(model: String) {
        assertFalse("no intent", intentPresent())
        mainLoad()
        assertEquals("prefs", model, prefs.model)
        assertEquals("runtime_state", model, runtimeModel())
        assertEquals("overlay", model, overlayModel())
        boot()
        assertFalse("still no intent", intentPresent())
        assertEquals(model, runtimeModel())
        assertEquals(model, overlayModel())
    }

    // ----------------------------------------------------------------------- decision table

    private fun snap(prefs: String, runtime: String?, overlay: AgentSettingsFile.Read) = ModelRepair.Snapshot(
        ModelTuple("openai", "oauth", prefs),
        runtime?.let { ModelTuple("openai", "oauth", it) },
        overlay,
    )

    private fun present(model: String?, provider: String? = null): AgentSettingsFile.Read.Present {
        val m = LinkedHashMap<String, kotlinx.serialization.json.JsonElement>()
        if (provider != null) m["provider"] = JsonPrimitive(provider)
        if (model != null) m["model"] = JsonPrimitive(model)
        return AgentSettingsFile.Read.Present(JsonObject(m))
    }

    @Test
    fun `no retired id in any store - no decision`() {
        assertNull(ModelRepair.decide(snap("gpt-6.1-sol", "gpt-6.1-sol", present("gpt-6-astra"))))
    }

    @Test
    fun `api-key users are out of scope even on a retired id`() {
        val s = ModelRepair.Snapshot(ModelTuple("openai", "api_key", "gpt-5.4"), ModelTuple("openai", "api_key", "gpt-5.4"), present("gpt-5.4"))
        assertNull(ModelRepair.decide(s))
    }

    @Test
    fun `effective retired model targets the default`() {
        val i = ModelRepair.decide(snap("gpt-5.4", "gpt-5.4", AgentSettingsFile.Read.Absent))!!
        assertEquals("gpt-6.1-sol", i.target)
        assertEquals(listOf("gpt-5.4"), i.retired)
        assertEquals(ModelRepair.CapturedOverlay(present = false), i.overlay)
        assertEquals("v2.9 §2: the default is recorded", "gpt-6.1-sol", i.defaultAtDecision)
        assertEquals("v2.9 §2: the prefs value is captured", ModelTuple("openai", "oauth", "gpt-5.4"), i.prefs)
        assertEquals("a new intent is pending", ModelRepair.STATE_PENDING, i.state)
        assertEquals("v2.10 §0", 2, i.version)
    }

    @Test
    fun `Codex headless sequence - prefs and overlay retired, runtime newer - overlay wins, default target`() {
        // Effective = the overlay (Node's precedence), which is retired → the default, everywhere.
        val i = ModelRepair.decide(snap("gpt-5.4", "gpt-5.6", present("gpt-5.4")))!!
        assertEquals("gpt-6.1-sol", i.target)
    }

    @Test
    fun `inverse - valid unlisted overlay is kept as the target`() {
        val i = ModelRepair.decide(snap("gpt-5.4", "gpt-5.4", present("gpt-5.6")))!!
        assertEquals("gpt-5.6", i.target)
    }

    @Test
    fun `overlay for another provider does not count as the effective model - captured as foreign`() {
        val i = ModelRepair.decide(snap("gpt-5.4", "gpt-5.4", present("claude-opus-5", provider = "claude")))!!
        assertEquals("gpt-6.1-sol", i.target)
        assertNull("not a participating store", i.overlay)
        assertEquals(ModelRepair.OutsideOverlay("foreign", "claude", "claude-opus-5"), i.overlayOutside)
    }

    @Test
    fun `unreadable overlay does not participate - captured as unreadable`() {
        val i = ModelRepair.decide(snap("gpt-5.4", "gpt-5.4", AgentSettingsFile.Read.Unreadable("x")))!!
        assertNull(i.overlay)
        assertEquals(ModelRepair.OutsideOverlay("unreadable"), i.overlayOutside)
    }

    // ------------------------------------------------- v2.9 §1: selection vs transport (D9.5)

    @Test
    fun `v2_9 transport - only the oauth transport opens a repair, the selection is kept`() {
        val s = snap("gpt-5.4", "gpt-5.4", present("gpt-5.4"))
        assertNotNull("signed in", ModelRepair.decide(s))
        val keyFallback = s.copy(oauthUsable = false, apiKeySaved = true)
        assertEquals("selected stays oauth", ModelRepair.Scope("openai", "oauth"), keyFallback.selected)
        assertEquals(ModelRepair.Scope("openai", "api_key"), keyFallback.transport)
        assertNull("signed out on the API-key fallback: no repair", ModelRepair.decide(keyFallback))
        val reconnect = s.copy(oauthUsable = false, apiKeySaved = false)
        assertEquals(ModelRepair.Scope("openai", ModelRepair.TRANSPORT_RECONNECT), reconnect.transport)
        assertNull("reconnect-required: no repair", ModelRepair.decide(reconnect))
    }

    @Test
    fun `v2_9 transport - rawPrefsModelTuple keeps the selected auth without a sign-in`() {
        val p = object : PrefsReader {
            val m = mapOf("provider" to "openai", "auth_type" to "oauth", "model" to "gpt-5.4")
            override fun getString(key: String, defValue: String?) = m[key] ?: defValue
            override fun getStringSet(key: String, defValues: Set<String>?) = defValues
            override fun getBoolean(key: String, defValue: Boolean) = defValue
            override fun getInt(key: String, defValue: Int) = defValue
            override fun getLong(key: String, defValue: Long) = defValue
            override fun getFloat(key: String, defValue: Float) = defValue
            override fun contains(key: String) = m.containsKey(key)
        }
        // No token store at all in this JVM: the pre-v2.9 code lowered this to api_key.
        assertEquals(ModelTuple("openai", "oauth", "gpt-5.4"), ConfigManager.rawPrefsModelTuple(p))
    }

    // ---------------------------------------------------------- v2.9 §3: the one classifier

    private fun classify(i: ModelRepair.RepairIntent, s: ModelRepair.Snapshot, main: Boolean = false) = ModelRepair.classifyIntent(i, s, main)

    @Test
    fun `classify - a pending intent whose stores hold the captured value or the target is Pending`() {
        val i = ModelRepair.decide(snap("gpt-5.4", "gpt-5.4", present("gpt-5.4")))!!
        listOf("gpt-5.4" to "gpt-5.4", "gpt-6.1-sol" to "gpt-5.4", "gpt-5.4" to "gpt-6.1-sol", "gpt-6.1-sol" to "gpt-6.1-sol")
            .forEach { (rt, ov) ->
                val c = classify(i, snap("gpt-5.4", rt, present(ov, provider = "openai")))
                assertEquals("runtime=$rt overlay=$ov", ModelRepair.IntentClass.Pending, c)
            }
    }

    @Test
    fun `classify - third values, scope changes and an overlay leaving the scope are Superseded, lost files are EvidenceLost`() {
        val i = ModelRepair.decide(snap("gpt-5.4", "gpt-5.4", present("gpt-5.4")))!!
        val superseded = mapOf(
            "runtime third value" to snap("gpt-5.4", "gpt-6-astra", present("gpt-5.4")),
            "runtime blank" to snap("gpt-5.4", " ", present("gpt-5.4")),
            "overlay third value" to snap("gpt-5.4", "gpt-5.4", present("gpt-6-astra")),
            "overlay now another provider" to snap("gpt-5.4", "gpt-5.4", present("gpt-5.4", provider = "claude")),
            "auth changed" to ModelRepair.Snapshot(
                ModelTuple("openai", "api_key", "gpt-5.4"),
                ModelTuple("openai", "api_key", "gpt-5.4"),
                present("gpt-5.4"),
            ),
        )
        superseded.forEach { (name, s) -> assertTrue(name, classify(i, s) is ModelRepair.IntentClass.Superseded) }
        // v2.9 §3: these used to cancel the whole intent; now the state is kept and the file rebuilt.
        val lost = mapOf(
            "overlay now unreadable" to snap("gpt-5.4", "gpt-5.4", AgentSettingsFile.Read.Unreadable("x")),
            "overlay deleted" to snap("gpt-5.4", "gpt-5.4", AgentSettingsFile.Read.Absent),
            "runtime gone" to snap("gpt-5.4", null, present("gpt-5.4")),
            "runtime unreadable" to ModelRepair.Snapshot(
                ModelTuple("openai", "oauth", "gpt-5.4"),
                null,
                present("gpt-5.4"),
                runtimeRead = RuntimeStateFile.Read.Unreadable("x"),
            ),
        )
        lost.forEach { (name, s) -> assertTrue("$name: ${classify(i, s)}", classify(i, s) is ModelRepair.IntentClass.EvidenceLost) }
    }

    @Test
    fun `classify - overlay captured absent - absent or the target hold, anything else is Superseded`() {
        val i = ModelRepair.decide(snap("gpt-5.4", "gpt-5.4", AgentSettingsFile.Read.Absent))!!
        assertEquals(ModelRepair.CapturedOverlay(present = false), i.overlay)
        val p = ModelRepair.IntentClass.Pending
        assertEquals(p, classify(i, snap("gpt-5.4", "gpt-5.4", AgentSettingsFile.Read.Absent)))
        assertEquals(p, classify(i, snap("gpt-5.4", "gpt-5.4", present("gpt-6.1-sol"))))
        assertEquals("publisher filled the provider", p, classify(i, snap("gpt-5.4", "gpt-5.4", present("gpt-6.1-sol", "openai"))))
        assertTrue(classify(i, snap("gpt-5.4", "gpt-5.4", present("gpt-6-astra"))) is ModelRepair.IntentClass.Superseded)
        // Codex Q15 (58e426b6): an overlay with no selection keys contributes no model evidence —
        // the same as absent (an unrelated Settings save creates exactly this file). v2.10 read it
        // as "absent → applicable" (Superseded); Q15 narrows that to files that carry a selection.
        assertEquals("created with no selection keys (Q15): still Pending", p, classify(i, snap("gpt-5.4", "gpt-5.4", present(null))))
        assertTrue("created with a supplied blank model: Superseded", classify(i, snap("gpt-5.4", "gpt-5.4", present(""))) is ModelRepair.IntentClass.Superseded)
        assertTrue("participating, now unreadable", classify(i, snap("gpt-5.4", "gpt-5.4", AgentSettingsFile.Read.Unreadable("x"))) is ModelRepair.IntentClass.EvidenceLost)
    }

    @Test
    fun `v2_10 table - a non-participating overlay - unreadable captured`() {
        val i = ModelRepair.decide(snap("gpt-5.4", "gpt-5.4", AgentSettingsFile.Read.Unreadable("x")))!!
        fun c(ov: AgentSettingsFile.Read) = classify(i, snap("gpt-5.4", "gpt-6.1-sol", ov))
        assertTrue("unreadable → applicable", c(present("gpt-5.4", "openai")) is ModelRepair.IntentClass.Superseded)
        assertTrue("unreadable → applicable, no provider", c(present("gpt-5.4")) is ModelRepair.IntentClass.Superseded)
        // v2.10 §1 pin 5.
        assertTrue("unreadable → foreign", c(present("claude-opus-5", "claude")) is ModelRepair.IntentClass.Superseded)
        assertEquals("unreadable → unreadable: ignored", ModelRepair.IntentClass.Pending, c(AgentSettingsFile.Read.Unreadable("y")))
        assertEquals("unreadable → absent: ignored", ModelRepair.IntentClass.Pending, c(AgentSettingsFile.Read.Absent))
    }

    @Test
    fun `v2_10 table - a non-participating overlay - foreign captured`() {
        val i = ModelRepair.decide(snap("gpt-5.4", "gpt-5.4", present("claude-opus-5", provider = "claude")))!!
        fun c(ov: AgentSettingsFile.Read) = classify(i, snap("gpt-5.4", "gpt-6.1-sol", ov))
        assertTrue("foreign → applicable", c(present("gpt-5.4", "openai")) is ModelRepair.IntentClass.Superseded)
        assertEquals("foreign, same {p, m}: ignored", ModelRepair.IntentClass.Pending, c(present("claude-opus-5", "claude")))
        assertTrue("foreign, another model", c(present("claude-opus-4", "claude")) is ModelRepair.IntentClass.Superseded)
        // Codex Q15: no selection keys at all — no model evidence, ignored.
        assertEquals("foreign → model-less: ignored", ModelRepair.IntentClass.Pending, c(present(null)))
        assertTrue("foreign, another provider", c(present("claude-opus-5", "xai")) is ModelRepair.IntentClass.Superseded)
        assertEquals("foreign → absent: ignored", ModelRepair.IntentClass.Pending, c(AgentSettingsFile.Read.Absent))
        // Not in v2.10's table; treated like "unreadable stays unreadable" (Node's dispatch skips both).
        assertEquals("foreign → unreadable: ignored", ModelRepair.IntentClass.Pending, c(AgentSettingsFile.Read.Unreadable("x")))
    }

    @Test
    fun `v2_9 pin 9 - in MAIN a newer Settings choice in prefs supersedes, in node it cannot`() {
        val i = ModelRepair.decide(snap("gpt-5.4", "gpt-5.4", present("gpt-5.4")))!!
            .copy(state = ModelRepair.STATE_AWAITING_MAIN)
        val files = snap("gpt-6-astra", "gpt-6.1-sol", present("gpt-6.1-sol", "openai"))
        assertTrue("MAIN: prefs hold neither the captured value nor the target", classify(i, files, main = true) is ModelRepair.IntentClass.Superseded)
        assertEquals("`:node` never reads its prefs cache as a newer choice", ModelRepair.IntentClass.Holds, classify(i, files, main = false))
        val captured = snap("gpt-5.4", "gpt-6.1-sol", present("gpt-6.1-sol", "openai"))
        assertEquals("MAIN, prefs on the captured value", ModelRepair.IntentClass.Holds, classify(i, captured, main = true))
        val target = snap("gpt-6.1-sol", "gpt-6.1-sol", present("gpt-6.1-sol", "openai"))
        assertEquals("MAIN, prefs on the target", ModelRepair.IntentClass.Holds, classify(i, target, main = true))
    }

    @Test
    fun `v2_9 pin 11 - a registry update that changes the default does not make an intent unproven`() {
        val i = ModelRepair.decide(snap("gpt-5.4", "gpt-5.4", AgentSettingsFile.Read.Absent))!!
            .copy(state = ModelRepair.STATE_AWAITING_MAIN)
        ModelRegistry.resetForTest()
        ModelRegistry.initForTest(fixture(default = "gpt-6-astra")) // a later release moved the default
        val s = snap("gpt-5.4", "gpt-6.1-sol", present("gpt-6.1-sol"))
        assertTrue(ModelRepair.provenTarget(i, s))
        assertEquals(ModelRepair.IntentClass.Holds, classify(i, s))
    }

    /**
     * v2.11 D11.1 — the OpenAI default moved from gpt-6.1-sol to gpt-6.2-sol. An intent written before
     * the update keeps its own target: `RepairIntent` persists `target`, and resume and verify use
     * `intent.target`, never the live default. Runs the update against the SHIPPED registry, so the
     * pin breaks if the real default or list stops matching the amendment.
     */
    @Test
    fun `v2_11 - a persisted intent targeting gpt-6_1-sol finishes on it after the default moves to gpt-6_2-sol`() {
        for (step in Step.values()) {
            setUpFresh()
            ModelRegistry.resetForTest()
            ModelRegistry.initForTest(fixture()) // the release that wrote the intent: default gpt-6.1-sol
            writeRuntime("gpt-5.4")
            writeOverlay(overlayWithModel("gpt-5.4"))
            bootCrashing(step)
            assertEquals("pending after a crash after $step", ModelRepair.STATE_PENDING, intentState())
            assertEquals("the persisted target ($step)", "gpt-6.1-sol", intent()!!.target)

            ModelRegistry.resetForTest()
            ModelRegistry.initForTest(shippedRegistry()) // the update
            assertEquals("precondition: the shipped default moved", "gpt-6.2-sol", ModelRegistry.defaultModelForProvider("openai", "oauth"))
            boot()
            assertAllOn("gpt-6.1-sol")
        }
    }

    @Test
    fun `v2_11 - a fresh decision after the update targets gpt-6_2-sol`() {
        ModelRegistry.resetForTest()
        ModelRegistry.initForTest(shippedRegistry())
        val i = ModelRepair.decide(snap("gpt-5.4", "gpt-5.4", AgentSettingsFile.Read.Absent))!!
        assertEquals("gpt-6.2-sol", i.target)
        assertEquals("gpt-6.2-sol", i.defaultAtDecision)
        writeRuntime("gpt-5.4")
        writeOverlay(overlayWithModel("gpt-5.4"))
        boot()
        assertAllOn("gpt-6.2-sol")
    }

    /** The bundled `model-registry.json`, parsed the way [ModelRegistryDefaultsTest] parses it. */
    private fun shippedRegistry(): List<ProviderInfo> {
        val text = listOf("src/main/assets/nodejs-project/model-registry.json", "app/src/main/assets/nodejs-project/model-registry.json")
            .map { java.io.File(it) }.first { it.exists() }.readText()
        val providers = Json { ignoreUnknownKeys = true }.parseToJsonElement(text).jsonObject["providers"]!!
        return Json { ignoreUnknownKeys = true }.decodeFromJsonElement(
            kotlinx.serialization.builtins.ListSerializer(ProviderInfo.serializer()),
            providers,
        )
    }

    @Test
    fun `v2_9 §2 - provenTarget recomputes the decision and needs a current file for a non-default target`() {
        val i = ModelRepair.decide(snap("gpt-5.4", "gpt-5.4", present("gpt-5.6")))!!
        assertEquals("gpt-5.6", i.target)
        assertTrue("the overlay holds it", ModelRepair.provenTarget(i, snap("gpt-5.4", "gpt-5.4", present("gpt-5.6"))))
        assertTrue("runtime_state holds it", ModelRepair.provenTarget(i, snap("gpt-5.4", "gpt-5.6", AgentSettingsFile.Read.Absent)))
        assertFalse("no current file holds 5.6", ModelRepair.provenTarget(i, snap("gpt-5.4", null, AgentSettingsFile.Read.Absent)))
        assertFalse("a tampered target", ModelRepair.provenTarget(i.copy(target = "gpt-6-astra"), snap("gpt-5.4", "gpt-6-astra", present("gpt-6-astra"))))
        assertFalse("a retired target", ModelRepair.provenTarget(i.copy(target = "gpt-5.4"), snap("gpt-5.4", "gpt-5.4", present("gpt-5.4"))))
        val d = ModelRepair.decide(snap("gpt-5.4", "gpt-5.4", AgentSettingsFile.Read.Absent))!!
        assertTrue("the default needs no file", ModelRepair.provenTarget(d, snap("gpt-5.4", null, AgentSettingsFile.Read.Absent)))
    }

    // ------------------------------------------------------------------ sequences on real files

    @Test
    fun `retired everywhere - one start repairs every store and hands off`() {
        writeRuntime("gpt-5.4")
        writeOverlay(overlayWithModel("gpt-5.4"))
        val a = anchor()
        boot()
        assertEquals("one notice, after the confirmed handoff", 1, notices(a))
        assertAllOn("gpt-6.1-sol")
    }

    @Test
    fun `no overlay file - the repair creates one and converges`() {
        writeRuntime("gpt-5.4")
        boot()
        assertAllOn("gpt-6.1-sol")
    }

    @Test
    fun `Codex headless sequence on files - prefs and overlay 5_4, runtime 5_6 - all on the default`() {
        writeRuntime("gpt-5.6")
        writeOverlay(overlayWithModel("gpt-5.4"))
        boot()
        assertAllOn("gpt-6.1-sol")
    }

    @Test
    fun `inverse on files - prefs and runtime 5_4, overlay 5_6 - 5_6 kept through reconcile`() {
        writeRuntime("gpt-5.4")
        writeOverlay(overlayWithModel("gpt-5.6"))
        val out = boot()
        assertEquals("config.json carries the target", "gpt-5.6", out.configModel)
        // Without approvedTarget reconcile would clamp the unlisted 5.6 to the default.
        assertAllOn("gpt-5.6")
    }

    @Test
    fun `nothing retired - a start changes no byte`() {
        prefs = ModelTuple("openai", "oauth", "gpt-6-astra")
        writeRuntime("gpt-6-astra")
        writeOverlay(overlayWithModel("gpt-6-astra", provider = "openai"))
        // The first start normalises to the publisher's format; the second must change nothing.
        boot()
        val rt = Files.readAllBytes(dir.resolve(RuntimeStateFile.NAME))
        val ov = Files.readAllBytes(AgentSettingsFile.path(dir))
        boot()
        assertArrayEquals(rt, Files.readAllBytes(dir.resolve(RuntimeStateFile.NAME)))
        assertArrayEquals(ov, Files.readAllBytes(AgentSettingsFile.path(dir)))
        assertFalse(intentPresent())
    }

    @Test
    fun `a crash after each step resumes and converges`() {
        for (step in Step.values()) {
            setUpFresh()
            writeRuntime("gpt-5.4")
            writeOverlay(overlayWithModel("gpt-5.4"))
            bootCrashing(step)
            assertEquals("intent pending after a crash after $step", ModelRepair.STATE_PENDING, intentState())
            val a = anchor()
            boot()
            assertEquals("one notice across the crash and the resume ($step)", 1, notices(a))
            assertAllOn("gpt-6.1-sol")
        }
    }

    @Test
    fun `resume finishes even after the last retired id is gone`() {
        // Crash after publish: every file is on the target, only the pending intent remains. A
        // fresh decision would see nothing to do; the resume must still confirm and hand off.
        writeRuntime("gpt-5.4")
        writeOverlay(overlayWithModel("gpt-5.4"))
        bootCrashing(Step.PUBLISH)
        // A MAIN load in between: the pending intent lets the sync move prefs only to the target.
        mainLoad()
        assertEquals("gpt-6.1-sol", prefs.model)
        assertNull(ModelRepair.decide(snapshot()))
        assertEquals(ModelRepair.STATE_PENDING, intentState())
        val a = anchor()
        boot()
        // The resume (not a silent stale-delete) is what reports the repair to the user.
        assertTrue(
            "INFO line on resume: ${logsSince(a)}",
            logsSince(a).any { it.contains("openai model gpt-5.4 is not available with ChatGPT sign-in — now gpt-6.1-sol") },
        )
        assertAllOn("gpt-6.1-sol")
    }

    @Test
    fun `partial model change after a crash cancels the old decision - its target is written nowhere`() {
        // Decision persisted (runtime and overlay captured on 5.4), then the process died.
        writeRuntime("gpt-5.4")
        writeOverlay(overlayWithModel("gpt-5.4"))
        bootCrashing(Step.PLAN)
        // Node's /model wrote only the overlay; runtime_state still holds the captured value.
        writeOverlay(overlayWithModel("gpt-6-astra", provider = "openai"))
        boot()
        // The old target (the default) appears nowhere; the user's choice wins in every store.
        assertAllOn("gpt-6-astra")
    }

    @Test
    fun `unrelated overlay keys, credentials and runtime fields survive the repair byte for byte`() {
        writeRuntime("gpt-5.4")
        writeOverlay(overlayWithModel("gpt-5.4"))
        val r = ModelSelectionLock.transaction { tx ->
            val plan = ModelRepair.plan(tx, dir, snapshot())
            ModelRepair.applyRepair(tx, dir, plan.intent!!)
        }
        assertEquals(ModelSelectionLock.Result.Acquired(true), r)
        val ov = Json.parseToJsonElement(AgentSettingsFile.path(dir).toFile().readText()).jsonObject
        assertEquals(listOf("heartbeatIntervalMinutes", "model", "apiKeys", "custom"), ov.keys.toList())
        assertEquals("""{"brave":"KEY-BRAVE"}""", ov["apiKeys"].toString())
        assertEquals("[1,2,3]", ov["custom"].toString())
        val rt = Json.parseToJsonElement(dir.resolve(RuntimeStateFile.NAME).toFile().readText()).jsonObject
        assertEquals("true", rt["reasoningEnabled"].toString())
        assertEquals("true", rt["reasoningDisplayInChat"].toString())
        assertEquals("\"gpt-6.1-sol\"", rt["model"].toString())
    }

    @Test
    fun `v2_7 pin 7 - unreadable overlay at decision time - one decision, one notice, the overlay bytes unchanged`() {
        // The overlay does not participate (unreadable) and no boot rewrites it (review Minor 2,
        // settling contract question 5): it keeps whatever it holds, and it never turns into an
        // applicable overlay mid-repair. runtime_state is the dispatch file and carries the handoff.
        writeRuntime("gpt-5.4")
        writeOverlay("{not json")
        val ov = Files.readAllBytes(AgentSettingsFile.path(dir))
        val a = anchor()
        val out1 = boot()
        assertEquals("runtime repaired first", "gpt-6.1-sol", runtimeModel())
        assertEquals("config.json carries the target", "gpt-6.1-sol", out1.configModel)
        assertEquals(ModelRepair.STATE_AWAITING_MAIN, intentState())
        assertTrue(logsSince(a).contains(ModelRepair.UNREADABLE_OVERLAY_KEPT))
        val decision = intent()!!.copy(state = ModelRepair.STATE_PENDING)

        repeat(2) { boot() } // restarts with no MAIN load in between
        assertFalse("never cancelled", logsSince(a).any { it.startsWith("[ModelRepair] pending repair cancelled") })
        assertEquals("the same decision", decision, intent()!!.copy(state = ModelRepair.STATE_PENDING))
        assertEquals(ModelRepair.STATE_AWAITING_MAIN, intentState())

        mainLoad()
        assertEquals("gpt-6.1-sol", prefs.model)
        assertEquals(ModelRepair.STATE_CONVERGED, intentState())
        boot()
        assertEquals("one decision, one notice across the restarts", 1, notices(a))
        assertArrayEquals("the overlay bytes are unchanged", ov, Files.readAllBytes(AgentSettingsFile.path(dir)))
        assertEquals("gpt-6.1-sol", runtimeModel())
    }

    // ------------------------------------------------- v2.9 §6 pins on the file harness

    @Test
    fun `v2_9 pin 3 - a third value in runtime_state while the overlay holds the target - Superseded, the old decision is not resumed`() {
        writeRuntime("gpt-5.4")
        writeOverlay(overlayWithModel("gpt-5.4"))
        bootCrashing(Step.PLAN)
        val old = intent()!!
        writeOverlay(overlayWithModel("gpt-6.1-sol", provider = "openai")) // the overlay already on the target
        writeRuntime("gpt-6-astra") // a third value in runtime_state
        assertEquals(
            ModelRepair.IntentClass.Superseded("runtime_state holds a newer model"),
            ModelRepair.classifyIntent(old, snapshot()),
        )
        val a = anchor()
        boot()
        assertTrue(logsSince(a).contains("[ModelRepair] pending repair cancelled: runtime_state holds a newer model"))
        // What follows is a FRESH decision over the stores as they are now (it captured astra), never
        // the old one resumed. Node's dispatch reads the overlay, so its value is the effective model.
        val fresh = intent()!!
        assertEquals("captured fresh", "gpt-6-astra", fresh.runtime?.model)
        assertFalse("not the old record", fresh == old.copy(state = fresh.state))
    }

    @Test
    fun `v2_9 pin 3 reversed - a third value in the overlay while runtime_state holds the target - Superseded`() {
        writeRuntime("gpt-5.4")
        writeOverlay(overlayWithModel("gpt-5.4"))
        bootCrashing(Step.PLAN)
        writeRuntime("gpt-6.1-sol")
        writeOverlay(overlayWithModel("gpt-6-astra", provider = "openai"))
        val a = anchor()
        boot()
        assertTrue(logsSince(a).any { it.startsWith("[ModelRepair] pending repair cancelled: agent_settings.json holds a newer model") })
        // The fresh decision keeps the user's astra (the effective overlay model).
        assertAllOn("gpt-6-astra")
    }

    @Test
    fun `v2_9 pin 5 - the captured overlay goes missing with target 5_6 and no other file holds it - a fresh decision`() {
        prefs = ModelTuple("openai", "oauth", "gpt-5.4")
        writeOverlay(overlayWithModel("gpt-5.6")) // no runtime_state: the overlay is the only 5.6
        bootCrashing(Step.PLAN)
        assertEquals("gpt-5.6", intent()!!.target)
        Files.delete(AgentSettingsFile.path(dir))
        val a = anchor()
        boot()
        assertTrue(
            "the target is no longer proven: ${logsSince(a)}",
            logsSince(a).any { it.startsWith("[ModelRepair] repair intent no longer proven (target gpt-5.6 is not proven)") },
        )
        // The fresh decision: prefs 5.4 is all that is left → the default.
        assertEquals("gpt-6.1-sol", intent()!!.target)
        assertNotEquals("5.6 is never seeded from the intent", "gpt-5.6", runtimeModel())
        assertAllOn("gpt-6.1-sol")
    }

    private fun assertNotEquals(msg: String, a: Any?, b: Any?) = assertFalse(msg, a == b)

    // ------------------------------------------------- v2.10 §1 pins on the file harness

    @Test
    fun `v2_10 §1 pin 2 - a participating overlay rewritten to another provider by an in-flight provider switch`() {
        writeRuntime("gpt-5.4")
        writeOverlay(overlayWithModel("gpt-5.4"))
        bootCrashing(Step.REPAIR) // runtime_state and the overlay on the target, the intent pending
        mainLoad() // MAIN moves prefs to the pending target, so nothing retired is left anywhere
        assertEquals("gpt-6.1-sol", prefs.model)
        // /provider writes the overlay first, then runtime_state — interrupted in between.
        writeOverlay(overlayWithModel("claude-opus-5", provider = "claude"))
        val rtBefore = Files.readAllBytes(dir.resolve(RuntimeStateFile.NAME))
        assertEquals(
            ModelRepair.IntentClass.Superseded("agent_settings.json now names another provider"),
            ModelRepair.classifyIntent(intent()!!, snapshot()),
        )
        val a = anchor()
        boot()
        assertTrue(logsSince(a).contains("[ModelRepair] pending repair cancelled: agent_settings.json now names another provider"))
        assertFalse("deleted under the lock", intentPresent())
        assertArrayEquals("no repair write to runtime_state", rtBefore, Files.readAllBytes(dir.resolve(RuntimeStateFile.NAME)))
        assertEquals("no notice for a cancelled decision", 0, notices(a))
    }

    @Test
    fun `v2_10 §1 pin 3 - a captured foreign overlay whose model changes - Superseded, then a stable next boot`() {
        writeRuntime("gpt-5.4")
        writeOverlay(overlayWithModel("claude-opus-5", provider = "claude"))
        boot()
        assertEquals(ModelRepair.OutsideOverlay("foreign", "claude", "claude-opus-5"), intent()!!.overlayOutside)
        writeOverlay(overlayWithModel("claude-opus-4", provider = "claude"))
        val a = anchor()
        boot()
        assertTrue(logsSince(a).any { it == "[ModelRepair] pending repair cancelled: agent_settings.json now holds another provider's newer model" })
        assertEquals("the fresh decision captures the new foreign value", ModelRepair.OutsideOverlay("foreign", "claude", "claude-opus-4"), intent()?.overlayOutside)
        val intentBytes = Files.readAllBytes(ModelRepair.intentPath(dir))
        val b = anchor()
        boot()
        assertArrayEquals("the next boot is stable", intentBytes, Files.readAllBytes(ModelRepair.intentPath(dir)))
        assertEquals(0, notices(b))
        assertEquals("claude-opus-4", overlayModel())
    }

    @Test
    fun `v2_10 §1 pin 4 - a captured foreign overlay that is then deleted is ignored and the repair proceeds`() {
        writeRuntime("gpt-5.4")
        writeOverlay(overlayWithModel("claude-opus-5", provider = "claude"))
        bootCrashing(Step.PLAN)
        Files.delete(AgentSettingsFile.path(dir))
        val a = anchor()
        boot()
        assertFalse(logsSince(a).any { it.startsWith("[ModelRepair] pending repair cancelled") })
        assertEquals(1, notices(a))
        assertEquals(ModelRepair.STATE_AWAITING_MAIN, intentState())
        assertEquals("gpt-6.1-sol", runtimeModel())
    }

    // ------------------------------------------- v2.10 §3: the boot payload is never the handoff

    @Test
    fun `v2_10 §3 - no runtime_state and no applicable overlay - runtime_state is written and the handoff rests on it`() {
        writeOverlay(overlayWithModel("claude-opus-5", provider = "claude")) // foreign: no participating overlay
        val out = boot()
        assertEquals("config.json carries the target", "gpt-6.1-sol", out.configModel)
        assertEquals("runtime_state written, checked", "gpt-6.1-sol", runtimeModel())
        val w = NodeDispatch.winner(RuntimeStateFile.read(dir), AgentSettingsFile.read(dir), prefs.provider, prefs.model)
        assertEquals(NodeDispatch.Winner(NodeDispatch.Source.RUNTIME, "gpt-6.1-sol"), w)
        assertEquals(ModelRepair.STATE_AWAITING_MAIN, intentState())
        assertEquals("the foreign overlay keeps its tuple", "claude-opus-5", overlayModel())
    }

    @Test
    fun `v2_10 §3 - an overlay and a runtime_state with blank models count for neither - the handoff writes runtime_state`() {
        writeRuntime("   ")
        writeOverlay("""{"model":"  ","heartbeatIntervalMinutes":45}""")
        assertEquals(
            "Node would dispatch from config.json",
            NodeDispatch.Source.CONFIG,
            NodeDispatch.winner(RuntimeStateFile.read(dir), AgentSettingsFile.read(dir), "openai", "gpt-5.4").source,
        )
        // A hand-built pending intent with neither file participating drives the handoff alone.
        val intent = ModelRepair.RepairIntent(
            provider = "openai", authType = "oauth", target = "gpt-6.1-sol", defaultAtDecision = "gpt-6.1-sol",
            retired = listOf("gpt-5.4"), prefs = prefs, overlayOutside = ModelRepair.OutsideOverlay("unreadable"),
        )
        ModelRepair.writeIntent(dir, intent)
        val r = ModelSelectionLock.transaction { tx -> ModelRepair.handoff(tx, dir, intent, snapshot()) }
        assertEquals(ModelSelectionLock.Result.Acquired(true), r)
        assertEquals("gpt-6.1-sol", runtimeModel())
        assertEquals(NodeDispatch.Source.RUNTIME, NodeDispatch.winner(RuntimeStateFile.read(dir), AgentSettingsFile.read(dir), "openai", "gpt-5.4").source)
        assertEquals(ModelRepair.STATE_AWAITING_MAIN, intentState())
        val rt = Json.parseToJsonElement(dir.resolve(RuntimeStateFile.NAME).toFile().readText()).jsonObject
        assertEquals("the record's other fields survive the checked tuple write", "true", rt["reasoningEnabled"].toString())
    }

    @Test
    fun `v2_10 §3 - the handoff fails when runtime_state cannot be written - the intent stays pending`() {
        writeOverlay(overlayWithModel("claude-opus-5", provider = "claude"))
        SafeFs.beforeMove = { _, target -> if (target.fileName.toString() == RuntimeStateFile.NAME) throw IOException("injected runtime_state failure") }
        val a = anchor()
        val out = boot()
        SafeFs.beforeMove = savedBeforeMove
        assertEquals("config.json still carries the target", "gpt-6.1-sol", out.configModel)
        assertEquals(ModelRepair.STATE_PENDING, intentState())
        assertEquals("no notice before the handoff", 0, notices(a))
        assertNull(runtimeModel())
        boot()
        assertEquals(ModelRepair.STATE_AWAITING_MAIN, intentState())
        assertEquals(1, notices(a))
    }

    // -------------------------------------------------------------- intent persistence failure

    @Test
    fun `checked fsync failure - no store changes, the retired id stays as the trigger`() {
        writeRuntime("gpt-5.4")
        writeOverlay(overlayWithModel("gpt-5.4"))
        val rt = Files.readAllBytes(dir.resolve(RuntimeStateFile.NAME))
        val ov = Files.readAllBytes(AgentSettingsFile.path(dir))
        SafeFs.dirSyncChecked = { throw IOException("injected fsync failure") }
        val plan = (ModelSelectionLock.transaction { tx -> ModelRepair.plan(tx, dir, snapshot()) } as ModelSelectionLock.Result.Acquired).value
        assertTrue("read-only this start", plan.persistFailed)
        assertNull("no intent → nothing to carry out", plan.intent)
        assertArrayEquals(rt, Files.readAllBytes(dir.resolve(RuntimeStateFile.NAME)))
        assertArrayEquals(ov, Files.readAllBytes(AgentSettingsFile.path(dir)))
        // Evidence survives: the next healthy start repairs.
        SafeFs.dirSyncChecked = {}
        assertNotNull(ModelRepair.decide(snapshot()))
        boot()
        assertAllOn("gpt-6.1-sol")
    }

    @Test
    fun `intent write failure - no store changes`() {
        writeRuntime("gpt-5.4")
        val rt = Files.readAllBytes(dir.resolve(RuntimeStateFile.NAME))
        Files.createDirectories(ModelRepair.intentPath(dir)) // the write target is a directory
        val plan = (ModelSelectionLock.transaction { tx -> ModelRepair.plan(tx, dir, snapshot()) } as ModelSelectionLock.Result.Acquired).value
        assertNull(plan.intent)
        assertArrayEquals(rt, Files.readAllBytes(dir.resolve(RuntimeStateFile.NAME)))
        assertFalse(Files.exists(AgentSettingsFile.path(dir)))
    }

    @Test
    fun `corrupt intent is ignored and replaced by a fresh decision`() {
        writeRuntime("gpt-5.4")
        writeText(ModelRepair.intentPath(dir), "{not json")
        boot()
        assertAllOn("gpt-6.1-sol")
    }

    @Test
    fun `D10_0 - an intent of another version reads as Corrupt and a fresh decision follows`() {
        writeRuntime("gpt-5.4")
        // A dev-build v1 intent (no state, no defaultAtDecision), with a target no decision makes.
        writeText(
            ModelRepair.intentPath(dir),
            """{"version":1,"provider":"openai","authType":"oauth","target":"gpt-6-astra","retired":["gpt-5.4"]}""",
        )
        assertTrue(ModelRepair.readIntent(dir) is ModelRepair.IntentRead.Corrupt)
        val a = anchor()
        boot()
        assertTrue(logsSince(a).any { it.startsWith("[ModelRepair] repair intent unreadable (") })
        assertEquals("the fresh decision, never the v1 target", "gpt-6.1-sol", intent()!!.target)
        assertAllOn("gpt-6.1-sol")
    }

    @Test
    fun `cancelled intent with nothing left to do is deleted`() {
        writeRuntime("gpt-5.4")
        writeOverlay(overlayWithModel("gpt-5.4"))
        bootCrashing(Step.PLAN)
        // A full user selection landed everywhere (no retired id left, a third value).
        prefs = ModelTuple("openai", "oauth", "gpt-6-astra")
        writeRuntime("gpt-6-astra")
        writeOverlay(overlayWithModel("gpt-6-astra", provider = "openai"))
        boot()
        assertSettledWithoutIntent("gpt-6-astra")
    }

    // ----------------------------------------------------------------- selection cancels intent

    @Test
    fun `cancelAfterSelection deletes a pending intent`() {
        writeRuntime("gpt-5.4")
        bootCrashing(Step.PLAN)
        assertTrue(intentPresent())
        ModelSelectionLock.transaction { tx -> ModelRepair.cancelAfterSelection(tx, dir) }
        assertFalse(intentPresent())
    }

    @Test
    fun `v2_9 §5 - cancelAfterSelection deletes a converged intent too`() {
        writeRuntime("gpt-5.4")
        boot()
        mainLoad()
        assertEquals(ModelRepair.STATE_CONVERGED, intentState())
        ModelSelectionLock.transaction { tx -> ModelRepair.cancelAfterSelection(tx, dir) }
        assertFalse(intentPresent())
    }

    @Test
    fun `selection detection - unrelated save is not a selection, a changed tuple is`() {
        val loaded = ModelTuple("openai", "oauth", "gpt-5.4")
        val cfg = cfg(loaded)
        assertFalse(ConfigManager.isModelSelection(cfg.copy(heartbeatIntervalMinutes = 10)))
        assertTrue(ConfigManager.isModelSelection(cfg.copy(model = "gpt-6-astra")))
        assertTrue(ConfigManager.isModelSelection(cfg.copy(authType = "api_key")))
        assertTrue("Setup builds a fresh config", ConfigManager.isModelSelection(cfg.copy(loadedModelTuple = null)))
    }

    @Test
    fun `displayModel applies the read rule without touching the stored model`() {
        val cfg = cfg(ModelTuple("openai", "oauth", "gpt-5.4"))
        assertEquals("gpt-6.1-sol", cfg.displayModel)
        assertEquals("gpt-5.4", cfg.model)
        assertFalse("showing it is not selecting it", ConfigManager.isModelSelection(cfg))
        assertEquals("gpt-5.4", cfg.copy(authType = "api_key").displayModel)
    }

    @Test
    fun `Custom signature on an unrelated save is computed for the stored model, not the form's`() {
        // CodeRabbit R2: /model moved Custom to model-b after the form loaded model-a.
        val form = cfg(ModelTuple("custom", "api_key", "model-a")).copy(
            provider = "custom", authType = "api_key", model = "model-a",
            customBaseUrl = "https://gw.example/v1", customFormat = "chat_completions",
        )
        val stored = RuntimeState(provider = "custom", authType = "api_key", model = "model-b", customConfigSignature = "old")
        fun sig(model: String) = com.seekerclaw.app.state.CustomConfigSignature.compute(model, form.customBaseUrl, form.customFormat, form.customHeaders)
        assertEquals("unrelated save → stored model", sig("model-b"), ConfigManager.customSignatureForSave(false, form, stored))
        assertEquals("selection → the form's model", sig("model-a"), ConfigManager.customSignatureForSave(true, form, stored))
        val offCustom = stored.copy(provider = "openai", model = "gpt-6.1-sol")
        assertEquals("stored provider not Custom → carried", "old", ConfigManager.customSignatureForSave(false, form, offCustom))
    }

    // ------------------------------------- v2.10 §2 + binding clarification 1: PowerLossFs

    /** Every rename this start made, by file name (the PowerLossFs hook chains to this). */
    private val renames = mutableListOf<String>()

    private fun withPowerLoss(block: (PowerLossFs) -> Unit) {
        val fs = PowerLossFs()
        fs.install()
        // PowerLossFs replaces the hook without chaining: record on top of it.
        val powerLossHook = SafeFs.beforeMove
        SafeFs.beforeMove = { tmp, target ->
            synchronized(renames) { renames += target.fileName.toString() }
            powerLossHook(tmp, target)
        }
        try {
            block(fs)
        } finally {
            fs.uninstall()
            SafeFs.beforeMove = savedBeforeMove
            SafeFs.dirSyncChecked = {}
        }
    }

    private fun repairWrites() = synchronized(renames) { renames.filter { it != ModelRepair.INTENT_NAME } }

    @Test
    fun `v2_10 §2 pins 1-3 - an unconfirmed intent makes no repair write until the sync recovers, then one notice`() {
        writeRuntime("gpt-5.4")
        writeOverlay(overlayWithModel("gpt-5.4"))
        val rt = Files.readAllBytes(dir.resolve(RuntimeStateFile.NAME))
        val ov = Files.readAllBytes(AgentSettingsFile.path(dir))
        val a = anchor()
        withPowerLoss { fs ->
            // Pin 1: the initial intent is unconfirmed.
            fs.syncFails = true
            val out1 = boot()
            assertTrue("read-only boot", out1.readOnly)
            assertEquals("no repair write", emptyList<String>(), repairWrites())
            assertArrayEquals(rt, Files.readAllBytes(dir.resolve(RuntimeStateFile.NAME)))
            assertArrayEquals(ov, Files.readAllBytes(AgentSettingsFile.path(dir)))
            assertTrue("the rename is visible, not durable", intentPresent())

            // Pin 2: a retry with the sync still broken; the pending intent is visible.
            val b2 = anchor()
            assertTrue(boot().readOnly)
            assertEquals("still no repair write", emptyList<String>(), repairWrites())
            assertTrue(logsSince(b2).contains(ModelRepair.CONFIRM_FAILED_WARNING))

            // Pin 1's power cut: no intent, the stores unchanged.
            fs.powerLoss()
            assertFalse("the unconfirmed intent is gone", intentPresent())
            assertArrayEquals(rt, Files.readAllBytes(dir.resolve(RuntimeStateFile.NAME)))
            assertArrayEquals(ov, Files.readAllBytes(AgentSettingsFile.path(dir)))

            // Pin 3: the sync recovers.
            fs.syncFails = false
            assertFalse(boot().readOnly)
            assertEquals(ModelRepair.STATE_AWAITING_MAIN, intentState())
            assertTrue("the handoff is durable", fs.isDurable(ModelRepair.intentPath(dir)))
        }
        assertEquals("exactly one notice across pins 1-3", 1, notices(a))
    }

    @Test
    fun `v2_10 §2 pin 2 variant - a visible pending intent is confirmed byte for byte before the repair`() {
        writeRuntime("gpt-5.4")
        writeOverlay(overlayWithModel("gpt-5.4"))
        bootCrashing(Step.PLAN) // a pending intent on disk
        withPowerLoss { fs ->
            fs.syncFails = true
            assertTrue(boot().readOnly)
            assertEquals(listOf(ModelRepair.INTENT_NAME), renames.toList())
            assertEquals("no repair write", emptyList<String>(), repairWrites())
            fs.syncFails = false
            renames.clear()
            boot()
            assertEquals("the intent is rewritten first", ModelRepair.INTENT_NAME, renames.first())
            assertEquals(ModelRepair.STATE_AWAITING_MAIN, intentState())
        }
    }

    @Test
    fun `binding clarification 1 - unconfirmed pending, a captured file disappears, the sync still failing - zero repair writes`() {
        writeRuntime("gpt-5.4")
        writeOverlay(overlayWithModel("gpt-5.4"))
        val ov = Files.readAllBytes(AgentSettingsFile.path(dir))
        withPowerLoss { fs ->
            fs.syncFails = true
            assertTrue(boot().readOnly) // the intent rename is visible but unconfirmed
            assertTrue(intentPresent())
            Files.delete(dir.resolve(RuntimeStateFile.NAME)) // the captured runtime_state goes
            assertTrue(
                "EvidenceLost on a pending intent",
                ModelRepair.classifyIntent(intent()!!, snapshot()) is ModelRepair.IntentClass.EvidenceLost,
            )
            renames.clear()
            val a = anchor()
            assertTrue("read-only: the intent could not be confirmed", boot().readOnly)
            assertEquals("zero repair writes", emptyList<String>(), repairWrites())
            assertFalse("runtime_state not rebuilt", Files.exists(dir.resolve(RuntimeStateFile.NAME)))
            assertArrayEquals("overlay untouched", ov, Files.readAllBytes(AgentSettingsFile.path(dir)))
            assertTrue(logsSince(a).contains(ModelRepair.CONFIRM_FAILED_WARNING))
        }
    }

    @Test
    fun `v2_10 §2 pin 4 - the fast path - a confirmed awaiting_main or converged intent gets no rewrite and no notice`() {
        writeRuntime("gpt-5.4")
        writeOverlay(overlayWithModel("gpt-5.4"))
        boot()
        withPowerLoss { _ ->
            val a = anchor()
            repeat(2) { boot() }
            assertFalse("no intent rewrite (awaiting_main)", renames.contains(ModelRepair.INTENT_NAME))
            mainLoad()
            renames.clear()
            repeat(2) { boot() }
            assertFalse("no intent rewrite (converged)", renames.contains(ModelRepair.INTENT_NAME))
            assertEquals(0, notices(a))
        }
    }

    @Test
    fun `v2_10 §2 pin 5 - the awaiting_main rewrite is unconfirmed and lost - the next start re-verifies, at most one notice`() {
        writeRuntime("gpt-5.4")
        writeOverlay(overlayWithModel("gpt-5.4"))
        val a = anchor()
        withPowerLoss { fs ->
            // Fail the sync exactly when the awaiting_main record is renamed into place.
            val chained = SafeFs.beforeMove
            SafeFs.beforeMove = { tmp, target ->
                chained(tmp, target)
                if (target.fileName.toString() == ModelRepair.INTENT_NAME &&
                    String(Files.readAllBytes(tmp)).contains(ModelRepair.STATE_AWAITING_MAIN)
                ) {
                    fs.syncFails = true
                }
            }
            boot()
            assertEquals("the window: no notice for an unconfirmed handoff", 0, notices(a))
            SafeFs.beforeMove = chained
            fs.syncFails = false
            fs.powerLoss() // the awaiting_main rewrite is lost; the confirmed pending one is back
            assertEquals(ModelRepair.STATE_PENDING, intentState())
            boot()
            assertEquals(ModelRepair.STATE_AWAITING_MAIN, intentState())
        }
        assertEquals("at most one notice", 1, notices(a))
        assertAllOn("gpt-6.1-sol")
    }

    @Test
    fun `v2_10 §2 pin 5 variant - the unconfirmed awaiting_main rewrite survives - the notice is missed, accepted`() {
        writeRuntime("gpt-5.4")
        writeOverlay(overlayWithModel("gpt-5.4"))
        val a = anchor()
        withPowerLoss { fs ->
            val chained = SafeFs.beforeMove
            SafeFs.beforeMove = { tmp, target ->
                chained(tmp, target)
                if (target.fileName.toString() == ModelRepair.INTENT_NAME &&
                    String(Files.readAllBytes(tmp)).contains(ModelRepair.STATE_AWAITING_MAIN)
                ) {
                    fs.syncFails = true
                }
            }
            boot()
            SafeFs.beforeMove = chained
            fs.syncFails = false
            assertEquals("visible", ModelRepair.STATE_AWAITING_MAIN, intentState())
            boot() // the fast path: the classifier finds the files holding
        }
        assertEquals("the missed notice (v2.10 §2, accepted)", 0, notices(a))
        assertAllOn("gpt-6.1-sol")
    }

    private fun cfg(loaded: ModelTuple?) = AppConfig(
        anthropicApiKey = "",
        authType = "oauth",
        telegramBotToken = "",
        telegramOwnerId = "",
        model = "gpt-5.4",
        agentName = "t",
        provider = "openai",
        loadedModelTuple = loaded,
    )

    /** For loops that need a clean store per iteration. */
    private fun setUpFresh() {
        dir = tmp.newFolder().toPath()
        Files.createDirectories(dir.resolve("workspace"))
        ModelSelectionLock.initForTest(dir)
        prefs = ModelTuple("openai", "oauth", "gpt-5.4")
    }
}
