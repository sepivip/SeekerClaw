package com.seekerclaw.app.config

import com.seekerclaw.app.state.RuntimeState
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
 * BAT-1661 phase 2 — the durable model repair (contract v2.3 – v2.5, Codex sign-off `bd90691a`).
 *
 * Two layers:
 *  - the pure decision table ([ModelRepair.decide], [ModelRepair.classifyResume]);
 *  - real files in a temp `filesDir`, driven through [boot], which runs the same steps in the
 *    same order as [ModelRepair.serviceStart] (plan → repair → publish → verify) with prefs held
 *    as a value instead of SharedPreferences, and reconcile reduced to the real
 *    [ConfigManager.resolveModelForReconcile]. A [Crash] thrown after any step models the
 *    process dying there; the next [boot] must converge.
 *
 * The registry is a fixture with the real shape of the retired list (openai + oauth).
 */
class ModelRepairTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var dir: Path
    private val savedDirSync = SafeFs.dirSyncChecked

    /** prefs `provider`/`auth_type`/`model`, as the boot would read them. */
    private var prefs = ModelTuple("openai", "oauth", "gpt-5.4")

    private val retired = listOf("gpt-5.5", "gpt-5.4", "gpt-5.4-mini")

    private val fixture = listOf(
        ProviderInfo(
            id = "openai",
            displayName = "OpenAI",
            authTypes = listOf("api_key", "oauth"),
            keyHint = "sk-proj-…",
            consoleUrl = "https://platform.openai.com",
            keysUrl = "https://platform.openai.com/api-keys",
            freeform = false,
            defaultModel = "gpt-6.1-sol",
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
        ModelRegistry.initForTest(fixture)
    }

    @After
    fun tearDown() {
        SafeFs.dirSyncChecked = savedDirSync
        ModelSelectionLock.initForTest(null)
        ModelRegistry.resetForTest()
    }

    // ------------------------------------------------------------------------------ fixtures

    /**
     * runtime_state.json as the REAL producer writes it: [CrossProcessStore] with
     * [RuntimeState.serializer], carrying non-default reasoning fields that must survive.
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

    private fun snapshot() = ModelRepair.Snapshot(prefs, RuntimeStateFile.readTuple(dir), AgentSettingsFile.read(dir))

    private fun intentPresent() = ModelRepair.readIntent(dir) is ModelRepair.IntentRead.Present

    private class Crash(step: String) : RuntimeException("crash after $step")

    private enum class Step { PLAN, REPAIR, PUBLISH }

    /**
     * One service start: [ModelRepair.serviceStart]'s steps against real files. Publish is the
     * reconcile commit followed by the overlay
     * publisher (provider/authType/model). In `:node` the RuntimeStateStore is never initialised,
     * so reconcile commits prefs only; runtime_state is written by the repair alone.
     */
    private fun boot(crashAfter: Step? = null) {
        val r = ModelSelectionLock.transaction { tx ->
            val plan = ModelRepair.plan(tx, dir, snapshot())
            if (crashAfter == Step.PLAN) throw Crash("plan")
            plan.intent?.let { ModelRepair.applyRepair(tx, dir, it) }
            if (crashAfter == Step.REPAIR) throw Crash("repair")

            val runtime = RuntimeStateFile.readTuple(dir)
            val provider = runtime?.provider ?: prefs.provider
            val auth = runtime?.authType ?: prefs.authType
            val reconciled = ConfigManager.resolveModelForReconcile(
                providerChanged = provider != prefs.provider,
                authChanged = auth != prefs.authType,
                newModel = overlayModel(),
                prefsModel = prefs.model,
                effectiveProvider = provider,
                effectiveAuth = auth,
                approvedTarget = plan.approved,
            )
            prefs = ModelTuple(provider, auth, reconciled)
            val o = (AgentSettingsFile.read(dir) as? AgentSettingsFile.Read.Present)?.obj ?: JsonObject(emptyMap())
            AgentSettingsFile.write(
                dir,
                AgentSettingsFile.with(
                    AgentSettingsFile.with(AgentSettingsFile.with(o, "provider", JsonPrimitive(provider)), "authType", JsonPrimitive(auth)),
                    "model",
                    JsonPrimitive(reconciled),
                ),
            )
            if (crashAfter == Step.PUBLISH) throw Crash("publish")
            plan.intent?.let { ModelRepair.verifyAndClear(tx, dir, it, prefs) }
        }
        assertTrue("boot must get the lock", r is ModelSelectionLock.Result.Acquired)
    }

    private fun bootCrashing(step: Step) {
        try {
            boot(step)
            throw AssertionError("expected a crash after $step")
        } catch (_: Crash) {
        }
    }

    private fun assertAllOn(model: String) {
        assertEquals("prefs", model, prefs.model)
        assertEquals("runtime_state", model, runtimeModel())
        assertEquals("overlay", model, overlayModel())
        assertFalse("intent cleared", intentPresent())
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
    fun `overlay for another provider does not count as the effective model`() {
        val i = ModelRepair.decide(snap("gpt-5.4", "gpt-5.4", present("claude-opus-5", provider = "claude")))!!
        assertEquals("gpt-6.1-sol", i.target)
        assertNull("not a participating store", i.overlay)
    }

    @Test
    fun `unreadable overlay does not participate`() {
        val i = ModelRepair.decide(snap("gpt-5.4", "gpt-5.4", AgentSettingsFile.Read.Unreadable("x")))!!
        assertNull(i.overlay)
    }

    @Test
    fun `resume finishes when every store holds its captured value or the target`() {
        val i = ModelRepair.decide(snap("gpt-5.4", "gpt-5.4", present("gpt-5.4")))!!
        listOf("gpt-5.4" to "gpt-5.4", "gpt-6.1-sol" to "gpt-5.4", "gpt-5.4" to "gpt-6.1-sol", "gpt-6.1-sol" to "gpt-6.1-sol")
            .forEach { (rt, ov) ->
                val r = ModelRepair.classifyResume(i, snap("gpt-5.4", rt, present(ov, provider = "openai")))
                assertTrue("runtime=$rt overlay=$ov", r is ModelRepair.Resume.Finish)
            }
    }

    @Test
    fun `resume cancels the whole intent on any third value or scope change`() {
        val i = ModelRepair.decide(snap("gpt-5.4", "gpt-5.4", present("gpt-5.4")))!!
        val cases = mapOf(
            "runtime third value" to snap("gpt-5.4", "gpt-6-astra", present("gpt-5.4")),
            "overlay third value" to snap("gpt-5.4", "gpt-5.4", present("gpt-6-astra")),
            "overlay now another provider" to snap("gpt-5.4", "gpt-5.4", present("gpt-5.4", provider = "claude")),
            "overlay now unreadable" to snap("gpt-5.4", "gpt-5.4", AgentSettingsFile.Read.Unreadable("x")),
            "overlay deleted" to snap("gpt-5.4", "gpt-5.4", AgentSettingsFile.Read.Absent),
            "runtime gone" to snap("gpt-5.4", null, present("gpt-5.4")),
            "auth changed" to ModelRepair.Snapshot(
                ModelTuple("openai", "api_key", "gpt-5.4"),
                ModelTuple("openai", "api_key", "gpt-5.4"),
                present("gpt-5.4"),
            ),
        )
        cases.forEach { (name, s) -> assertTrue(name, ModelRepair.classifyResume(i, s) is ModelRepair.Resume.Cancel) }
    }

    @Test
    fun `overlay captured absent - absent or the target finish, anything else cancels`() {
        val cap = ModelRepair.CapturedOverlay(present = false)
        val scope = ModelRepair.Scope("openai", "oauth")
        assertTrue(ModelRepair.overlayMatches(cap, "gpt-6.1-sol", AgentSettingsFile.Read.Absent, scope))
        assertTrue(ModelRepair.overlayMatches(cap, "gpt-6.1-sol", present("gpt-6.1-sol"), scope))
        assertTrue("publisher filled the provider", ModelRepair.overlayMatches(cap, "gpt-6.1-sol", present("gpt-6.1-sol", "openai"), scope))
        assertFalse(ModelRepair.overlayMatches(cap, "gpt-6.1-sol", present("gpt-6-astra"), scope))
        assertFalse("created without a model", ModelRepair.overlayMatches(cap, "gpt-6.1-sol", present(null), scope))
    }

    // ------------------------------------------------------------------ sequences on real files

    @Test
    fun `retired everywhere - one start repairs every store and clears the intent`() {
        writeRuntime("gpt-5.4")
        writeOverlay(overlayWithModel("gpt-5.4"))
        boot()
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
        boot()
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
            assertTrue("intent survives a crash after $step", intentPresent())
            boot()
            assertAllOn("gpt-6.1-sol")
        }
    }

    @Test
    fun `resume finishes even after the last retired id is gone`() {
        // Crash after publish: every store is on the target, only the intent remains. A fresh
        // decision would see nothing to do; the resume must still verify and clear it.
        writeRuntime("gpt-5.4")
        writeOverlay(overlayWithModel("gpt-5.4"))
        bootCrashing(Step.PUBLISH)
        assertNull(ModelRepair.decide(snapshot()))
        assertTrue(intentPresent())
        // The log is a 300-entry ring shared across the JVM: anchor on the newest entry by
        // identity, not on a count that an eviction would throw off.
        val anchor = com.seekerclaw.app.util.LogCollector.logs.value.lastOrNull()
        boot()
        assertAllOn("gpt-6.1-sol")
        // The resume (not a silent stale-delete) is what reports the repair to the user.
        val all = com.seekerclaw.app.util.LogCollector.logs.value
        val from = if (anchor == null) 0 else all.indexOfFirst { it === anchor } + 1
        assertTrue("anchor still in the ring", anchor == null || from > 0)
        val logged = all.drop(from).map { it.message }
        assertTrue(
            "INFO line on resume: $logged",
            logged.any { it.contains("openai model gpt-5.4 is not available with ChatGPT sign-in — now gpt-6.1-sol") },
        )
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
    fun `unreadable overlay at decision time - converges once the publisher rewrites it`() {
        // Reviewer finding: the overlay does not participate, reconcile keeps the retired prefs
        // model, and the publisher writes it back into a now-readable overlay. Resume must not
        // Finish there (the intent would never clear); it cancels and re-decides.
        writeRuntime("gpt-5.4")
        writeOverlay("{not json")
        boot()
        assertEquals("runtime repaired first", "gpt-6.1-sol", runtimeModel())
        assertTrue("prefs not yet repaired → intent kept", intentPresent())
        boot()
        assertAllOn("gpt-6.1-sol")
    }

    @Test
    fun `a non-participating overlay that now applies cancels the resume - one still unreadable does not`() {
        // Decided while the overlay was unreadable or scoped to another provider: it did not participate.
        val i = ModelRepair.decide(snap("gpt-5.4", "gpt-5.4", AgentSettingsFile.Read.Unreadable("x")))!!
        assertNull(i.overlay)
        val other = ModelRepair.decide(snap("gpt-5.4", "gpt-5.4", present("claude-opus-5", provider = "claude")))!!
        assertNull(other.overlay)
        for (intent in listOf(i, other)) {
            val applies = listOf(present("gpt-5.4", provider = "openai"), present("gpt-5.4"), AgentSettingsFile.Read.Absent)
            applies.forEach { ov ->
                assertTrue("$ov now applies", ModelRepair.classifyResume(intent, snap("gpt-5.4", "gpt-6.1-sol", ov)) is ModelRepair.Resume.Cancel)
            }
            val stillOut = listOf(AgentSettingsFile.Read.Unreadable("x"), present("claude-opus-5", provider = "claude"))
            stillOut.forEach { ov ->
                assertTrue("$ov still out", ModelRepair.classifyResume(intent, snap("gpt-5.4", "gpt-6.1-sol", ov)) is ModelRepair.Resume.Finish)
            }
        }
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
    fun `cancelled intent with nothing left to do is deleted`() {
        writeRuntime("gpt-5.4")
        writeOverlay(overlayWithModel("gpt-5.4"))
        bootCrashing(Step.PLAN)
        // A full user selection landed everywhere (no retired id left, a third value).
        prefs = ModelTuple("openai", "oauth", "gpt-6-astra")
        writeRuntime("gpt-6-astra")
        writeOverlay(overlayWithModel("gpt-6-astra", provider = "openai"))
        boot()
        assertAllOn("gpt-6-astra")
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
