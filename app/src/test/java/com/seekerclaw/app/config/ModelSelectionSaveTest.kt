package com.seekerclaw.app.config

import android.content.ContextWrapper
import android.content.SharedPreferences
import com.seekerclaw.app.state.AgentPreferencesStore
import com.seekerclaw.app.state.RuntimeState
import com.seekerclaw.app.state.RuntimeStateStore
import com.seekerclaw.app.state.XaiOAuthTokenStore
import com.seekerclaw.app.state.XaiOAuthTokens
import com.seekerclaw.app.util.CrossProcessStore
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
import com.seekerclaw.app.util.SafeFs
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * BAT-1661 — the REAL save, start, load and seed paths on the JVM (Codex diff review of
 * 09e0614c, comment 8248fb2c): `ConfigManager.saveConfigWith`, `ModelRepair.serviceStart`,
 * `ConfigManager.loadConfig`, `RuntimeStateStore.seedIfMissing` and the OpenAI OAuth rotation
 * writer, against real files in a temp `filesDir`.
 *
 * Two seams, both instance-scoped: a [SecretSealer] passed to the call (there is no Android
 * Keystore on the JVM), and [FakePrefs], which keeps what a process sees ("memory") apart from
 * what is on disk, as Android does: `commit()` updates memory first and returns false when the
 * disk write fails, and [FakePrefs.restartProcess] models a new process reading the disk.
 *
 * Process roles: the main process has [RuntimeStateStore] initialised; `:node` (service start)
 * does not. Tests switch with [mainProcess] / [nodeProcess].
 */
class ModelSelectionSaveTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var dir: Path
    private lateinit var prefs: FakePrefs
    private lateinit var ctx: FakeContext
    private val savedDirSync = SafeFs.dirSyncChecked
    private val savedBeforeMove = SafeFs.beforeMove

    /** Marks a value as sealed without holding anything secret. */
    private val sealer = SecretSealer { plain -> "sealed:$plain" }

    private val retired = listOf("gpt-5.5", "gpt-5.4", "gpt-5.4-mini")

    @Before
    fun setUp() {
        dir = tmp.newFolder("files").toPath()
        Files.createDirectories(dir.resolve("workspace"))
        SafeFs.dirSyncChecked = {}
        ModelSelectionLock.initForTest(dir)
        ModelRegistry.resetForTest()
        ModelRegistry.initForTest(
            listOf(
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
                    ),
                    retiredForAuth = mapOf("oauth" to retired),
                ),
                ProviderInfo(
                    id = "xai",
                    displayName = "xAI",
                    authTypes = listOf("api_key", "oauth"),
                    keyHint = "xai-…",
                    consoleUrl = "https://console.x.ai",
                    keysUrl = "https://console.x.ai",
                    freeform = false,
                    defaultModel = "grok-4.6",
                    models = listOf(ModelInfo("grok-4.6", "Grok 4.6", "yes")),
                ),
            ),
        )
        RuntimeStateStore.resetForTest()
        AgentPreferencesStore.resetForTest()
        XaiOAuthTokenStore.resetForTest()
        prefs = FakePrefs()
        ctx = FakeContext(dir.toFile(), prefs)
    }

    @After
    fun tearDown() {
        SafeFs.dirSyncChecked = savedDirSync
        SafeFs.beforeMove = savedBeforeMove
        RuntimeStateStore.resetForTest()
        XaiOAuthTokenStore.resetForTest()
        ModelSelectionLock.initForTest(null)
        ModelRegistry.resetForTest()
    }

    // ------------------------------------------------------------------------------ fixtures

    /** A configured OpenAI ChatGPT sign-in user on [model] (prefs on disk). */
    private fun seedPrefs(model: String, provider: String = "openai", auth: String = "oauth") {
        prefs.seed(
            "setup_complete" to true,
            "provider" to provider,
            "auth_type" to auth,
            "model" to model,
            // rawPrefsModelTuple downgrades OpenAI oauth without a stored token to api_key.
            "openai_oauth_token_enc" to "sealed:old-access",
        )
    }

    private fun writeRuntime(model: String, provider: String = "openai", auth: String = "oauth") {
        val s = RuntimeState(provider = provider, authType = auth, model = model, reasoningEnabled = true)
        CrossProcessStore(dir.toFile(), RuntimeStateFile.NAME, RuntimeState.serializer(), s).write(s)
    }

    private fun writeOverlay(model: String, provider: String = "openai", auth: String = "oauth") {
        AgentSettingsFile.path(dir).toFile().writeText(
            """{"heartbeatIntervalMinutes":30,"provider":"$provider","authType":"$auth","model":"$model","apiKeys":{}}""",
        )
    }

    private fun runtimeModel() = RuntimeStateFile.readTuple(dir)?.model
    private fun overlayModel() =
        (AgentSettingsFile.read(dir) as? AgentSettingsFile.Read.Present)?.let { AgentSettingsFile.stringField(it.obj, "model") }
    private fun overlayInt(key: String) =
        ((AgentSettingsFile.read(dir) as? AgentSettingsFile.Read.Present)?.obj?.get(key) as? kotlinx.serialization.json.JsonPrimitive)?.content
    private fun intent() = (ModelRepair.readIntent(dir) as? ModelRepair.IntentRead.Present)?.intent

    private fun mainProcess() {
        RuntimeStateStore.resetForTest()
        RuntimeStateStore.initWithStoreForTest(dir.toFile())
    }

    private fun nodeProcess() {
        RuntimeStateStore.resetForTest()
        prefs.restartProcess()
    }

    /** One service start as `:node` runs it; returns the config handed to the config.json emit. */
    private fun serviceStart(): AppConfig {
        var emitted: AppConfig? = null
        val channel = ModelRepair.serviceStart(ctx) { cfg ->
            emitted = cfg
            "telegram"
        }
        assertEquals("the boot proceeds", "telegram", channel)
        return emitted!!
    }

    /** A Settings form loaded on [loaded], saved with [edit] applied. */
    private fun form(loaded: ModelTuple, edit: (AppConfig) -> AppConfig = { it }) = edit(
        AppConfig(
            anthropicApiKey = "",
            telegramBotToken = "bot",
            telegramOwnerId = "1",
            agentName = "MyAgent",
            provider = loaded.provider,
            authType = loaded.authType,
            model = loaded.model,
            openaiOAuthToken = "old-access",
            loadedModelTuple = loaded,
        ),
    )

    private fun save(cfg: AppConfig, s: SecretSealer = sealer) = ConfigManager.saveConfigWith(ctx, cfg, ModelSelectionLock.LOCK_TIMEOUT_MS, s)

    /** Runs a partial repair in `:node`: the decision and intent, then runtime_state only. */
    private fun partialRepair() {
        nodeProcess()
        val r = ModelSelectionLock.transaction { tx ->
            val plan = ModelRepair.plan(tx, dir, ConfigManager.modelSnapshot(ctx))
            RuntimeStateFile.writeModel(dir, plan.intent!!.target)
        }
        assertTrue(r is ModelSelectionLock.Result.Acquired)
    }

    private fun logsSince(anchor: com.seekerclaw.app.util.LogEntry?): List<com.seekerclaw.app.util.LogEntry> {
        val all = LogCollector.logs.value
        return all.drop(if (anchor == null) 0 else all.indexOfFirst { it === anchor } + 1)
    }

    // ---------------------------------------- v2.5 §1: a latched Settings writer across a start

    @Test
    fun `latched Settings selection across a service start - read-only boot, then its newer record survives`() {
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        writeOverlay("gpt-5.4")
        mainProcess()

        // The Settings save holds the lock from its first seal until released.
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val latched = SecretSealer { plain ->
            entered.countDown()
            release.await(10, TimeUnit.SECONDS)
            "sealed:$plain"
        }
        var saved: Boolean? = null
        val settings = thread {
            saved = save(form(ModelTuple("openai", "oauth", "gpt-5.4")) { it.copy(model = "gpt-6-astra") }, latched)
        }
        assertTrue("the save holds the lock", entered.await(5, TimeUnit.SECONDS))

        val files = listOf(dir.resolve(RuntimeStateFile.NAME), AgentSettingsFile.path(dir))
        val before = files.associateWith { Files.readAllBytes(it) to Files.getLastModifiedTime(it) }
        val prefsWrites = prefs.modelKeyWrites
        val anchor = LogCollector.logs.value.lastOrNull()
        val boot = serviceStart() // the lock stays busy past its bound: a read-only boot
        assertTrue(logsSince(anchor).any { it.message == ModelRepair.BUSY_WARNING })
        files.forEach { p ->
            assertArrayEquals("$p bytes", before.getValue(p).first, Files.readAllBytes(p))
            assertEquals("$p mtime", before.getValue(p).second, Files.getLastModifiedTime(p))
        }
        assertEquals("startup wrote no prefs model key", prefsWrites, prefs.modelKeyWrites)
        assertEquals("no intent", null, intent())
        // First dispatch is safe: the raw retired model is carried into config.json, and Node's
        // read rule (retired-model-read-rule.test.js) serves the default for it.
        assertEquals("gpt-5.4", boot.model)
        assertEquals("gpt-6.1-sol", ModelRegistry.applyRetiredModelRule(boot.provider, boot.authType, boot.model))

        release.countDown()
        settings.join(10_000)
        assertEquals(true, saved)
        assertEquals("prefs", "gpt-6-astra", prefs.disk["model"])
        assertEquals("runtime_state", "gpt-6-astra", runtimeModel())
        assertEquals("overlay", "gpt-6-astra", overlayModel())
    }

    // --------------------------------- v2.5 §2: an unrelated save during a partial repair

    @Test
    fun `unrelated save after a partial repair keeps every model and the intent - the next start finishes`() {
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        writeOverlay("gpt-5.4")
        partialRepair() // runtime on the target; overlay and prefs still on 5.4
        assertEquals("gpt-6.1-sol", runtimeModel())
        val pending = intent()
        assertNotNull(pending)

        mainProcess()
        val runtimeBytes = Files.readAllBytes(dir.resolve(RuntimeStateFile.NAME))
        assertTrue(save(form(ModelTuple("openai", "oauth", "gpt-5.4")) { it.copy(heartbeatIntervalMinutes = 45) }))

        assertEquals("the save landed", "45", overlayInt("heartbeatIntervalMinutes"))
        assertEquals("prefs model", "gpt-5.4", prefs.disk["model"])
        assertEquals("overlay model", "gpt-5.4", overlayModel())
        assertEquals("runtime_state model", "gpt-6.1-sol", runtimeModel())
        assertArrayEquals("runtime_state untouched byte for byte", runtimeBytes, Files.readAllBytes(dir.resolve(RuntimeStateFile.NAME)))
        assertEquals("intent kept", pending, intent())

        nodeProcess()
        serviceStart()
        assertEquals("gpt-6.1-sol", prefs.disk["model"])
        assertEquals("gpt-6.1-sol", runtimeModel())
        assertEquals("gpt-6.1-sol", overlayModel())
        assertEquals("intent cleared", null, intent())
    }

    @Test
    fun `unrelated save after the last retired id is gone keeps the intent - the next start clears it`() {
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        writeOverlay("gpt-5.4")
        partialRepair()
        // The rest of the repair landed (a crash before the verify step): only the intent remains.
        writeOverlay("gpt-6.1-sol")
        prefs.seed("model" to "gpt-6.1-sol")
        assertEquals("no fresh decision", null, ModelRepair.decide(ConfigManager.modelSnapshot(ctx)))
        val pending = intent()
        assertNotNull(pending)

        mainProcess()
        assertTrue(save(form(ModelTuple("openai", "oauth", "gpt-6.1-sol")) { it.copy(heartbeatIntervalMinutes = 45) }))
        assertEquals("intent kept", pending, intent())

        nodeProcess()
        val anchor = LogCollector.logs.value.lastOrNull()
        serviceStart()
        assertEquals("intent cleared", null, intent())
        assertTrue(
            "the resume reports the repair",
            logsSince(anchor).any { it.message.contains("is not available with ChatGPT sign-in — now gpt-6.1-sol") },
        )
    }

    // ------------------------------- v2.5 §2 + review #2: a selection cancels only on success

    @Test
    fun `a selection whose overlay write fails reports failure, rolls back and keeps the intent`() {
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        writeOverlay("gpt-5.4")
        partialRepair()
        mainProcess()
        val pending = intent()
        val runtimeBefore = runtimeModel()

        SafeFs.beforeMove = { _, target -> if (target.fileName.toString() == AgentSettingsFile.NAME) throw IOException("injected overlay write failure") }
        val anchor = LogCollector.logs.value.lastOrNull()
        val ok = save(form(ModelTuple("openai", "oauth", "gpt-5.4")) { it.copy(model = "gpt-6-astra") })
        SafeFs.beforeMove = savedBeforeMove

        assertFalse("the save is not acknowledged", ok)
        assertEquals("intent kept", pending, intent())
        assertEquals("prefs rolled back", "gpt-5.4", prefs.disk["model"])
        assertEquals("prefs memory rolled back too", "gpt-5.4", prefs.memory["model"])
        assertEquals("runtime_state rolled back", runtimeBefore, runtimeModel())
        assertEquals("overlay as it was", "gpt-5.4", overlayModel())
        assertTrue(logsSince(anchor).any { it.message.startsWith("[Config] agent_settings.json write failed — rolled back") })
    }

    @Test
    fun `a selection whose prefs commit fails reports failure and keeps the intent`() {
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        writeOverlay("gpt-5.4")
        partialRepair()
        mainProcess()
        val pending = intent()

        prefs.failCommits = true
        val ok = save(form(ModelTuple("openai", "oauth", "gpt-5.4")) { it.copy(model = "gpt-6-astra") })
        prefs.failCommits = false

        assertFalse(ok)
        assertEquals("intent kept", pending, intent())
        assertEquals("overlay untouched", "gpt-5.4", overlayModel())
        assertEquals("disk prefs untouched", "gpt-5.4", prefs.disk["model"])
    }

    @Test
    fun `a selection that lands everywhere cancels the pending repair`() {
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        writeOverlay("gpt-5.4")
        partialRepair()
        mainProcess()
        assertNotNull(intent())

        assertTrue(save(form(ModelTuple("openai", "oauth", "gpt-5.4")) { it.copy(model = "gpt-6-astra") }))
        assertEquals("intent cancelled", null, intent())
        assertEquals("gpt-6-astra", prefs.disk["model"])
        assertEquals("gpt-6-astra", runtimeModel())
        assertEquals("gpt-6-astra", overlayModel())

        // And the next start leaves the user's choice alone.
        nodeProcess()
        serviceStart()
        assertEquals("gpt-6-astra", overlayModel())
        assertEquals("gpt-6-astra", prefs.disk["model"])
    }

    // ------------------------------------------- review #2: the boot's own writes are checked

    @Test
    fun `boot reconcile commit fails - intent kept, the next start finishes`() {
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        writeOverlay("gpt-5.4")
        nodeProcess()

        prefs.failCommits = true
        val anchor = LogCollector.logs.value.lastOrNull()
        serviceStart()
        prefs.failCommits = false
        // The in-memory prefs hold the target, so a re-read would have "verified" the repair.
        assertEquals("memory took the write", "gpt-6.1-sol", prefs.memory["model"])
        assertEquals("disk did not", "gpt-5.4", prefs.disk["model"])
        assertNotNull("intent kept", intent())
        assertTrue(logsSince(anchor).any { it.level == LogLevel.WARN && it.message == ModelRepair.PUBLISH_FAILED_WARNING })

        nodeProcess() // a new process reads prefs from disk: still 5.4
        serviceStart()
        assertEquals("gpt-6.1-sol", prefs.disk["model"])
        assertEquals("gpt-6.1-sol", overlayModel())
        assertEquals("intent cleared", null, intent())
    }

    @Test
    fun `boot overlay publish fails - intent kept`() {
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        writeOverlay("gpt-5.4")
        nodeProcess()

        // The repair's own overlay write lands; the publish after reconcile fails.
        var overlayWrites = 0
        SafeFs.beforeMove = { _, target ->
            if (target.fileName.toString() == AgentSettingsFile.NAME && ++overlayWrites == 2) throw IOException("injected publish failure")
        }
        val anchor = LogCollector.logs.value.lastOrNull()
        serviceStart()
        SafeFs.beforeMove = savedBeforeMove

        assertEquals(2, overlayWrites)
        assertNotNull("intent kept", intent())
        assertTrue(logsSince(anchor).any { it.message == ModelRepair.PUBLISH_FAILED_WARNING })
    }

    // ---------------------------------- review #1: nothing reconciles before the repair runs

    /** What the service runs before `ModelRepair.serviceStart` (pinned by StartOrderGuardTest). */
    private val productionPreflight: (FakeContext) -> Unit = { c ->
        ConfigManager.loadOwnerIdFromFile(c, "telegram") // the owner-warning check
        ConfigManager.loadConfigReadOnly(c) // initAnalytics
    }

    private fun startFromInverseState(preflight: (FakeContext) -> Unit): AppConfig {
        // prefs on retired 5.4; runtime and an applicable overlay on the valid-but-unlisted 5.6.
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.6")
        writeOverlay("gpt-5.6")
        nodeProcess()
        preflight(ctx)
        return serviceStart()
    }

    @Test
    fun `service entry - retired prefs, unlisted 5_6 in runtime and overlay - 5_6 through first dispatch and restart`() {
        val first = startFromInverseState(productionPreflight)
        assertEquals("config.json", "gpt-5.6", first.model)
        assertEquals("overlay (Node's first dispatch reads it)", "gpt-5.6", overlayModel())
        assertEquals("not retired, so Node serves it", "gpt-5.6", ModelRegistry.applyRetiredModelRule("openai", "oauth", overlayModel()!!))
        assertEquals("runtime_state", "gpt-5.6", runtimeModel())
        assertEquals("prefs", "gpt-5.6", prefs.disk["model"])
        assertEquals("intent cleared", null, intent())

        nodeProcess()
        productionPreflight(ctx)
        assertEquals("restart", "gpt-5.6", serviceStart().model)
        assertEquals("gpt-5.6", overlayModel())
    }

    @Test
    fun `service entry - even a reconciling loadConfig before the start keeps 5_6`() {
        // 09e0614c's owner check called loadConfig first, which clamped 5.6 before the repair saw
        // 5.4. The service no longer does (StartOrderGuardTest), and since the Codex re-review of
        // 29ed3c72 the load itself leaves the model alone while a repair is pending — so a future
        // reconciling call here is safe too. Removing that reconcile guard fails this test.
        startFromInverseState { c -> ConfigManager.loadConfig(c) }
        assertEquals("gpt-5.6", overlayModel())
        assertEquals("gpt-5.6", runtimeModel())
        assertEquals("gpt-5.6", prefs.disk["model"])
    }

    @Test
    fun `production order - MAIN load, service start, first dispatch, restart - unlisted 5_6 kept`() {
        // Codex re-review of 29ed3c72, #1: prefs AND runtime on retired 5.4, an applicable overlay
        // on the valid unlisted 5.6, no intent. The same-scope sync is a no-op here, so before the
        // fix a MAIN load (Dashboard) clamped 5.6 to the default and committed it to prefs and
        // runtime; the start then saw nothing retired and published the default over 5.6.
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        writeOverlay("gpt-5.6")
        mainProcess()
        val writes = prefs.modelKeyWrites
        val runtimeBytes = Files.readAllBytes(dir.resolve(RuntimeStateFile.NAME))

        val shown = ConfigManager.loadConfig(ctx)!!
        assertEquals("the load shows the model the repair will keep", "gpt-5.6", shown.model)
        assertEquals("no prefs model-key write", writes, prefs.modelKeyWrites)
        assertArrayEquals("runtime_state untouched", runtimeBytes, Files.readAllBytes(dir.resolve(RuntimeStateFile.NAME)))
        assertEquals("overlay untouched", "gpt-5.6", overlayModel())
        // An unrelated Settings save from that form is not a selection and keeps the evidence.
        assertTrue(save(form(ModelTuple(shown.provider, shown.authType, shown.model)) { it.copy(heartbeatIntervalMinutes = 45) }))
        assertEquals("gpt-5.4", prefs.disk["model"])
        assertEquals("gpt-5.6", overlayModel())

        nodeProcess()
        assertEquals("config.json", "gpt-5.6", serviceStart().model)
        assertEquals("first dispatch reads the overlay", "gpt-5.6", overlayModel())
        assertEquals("gpt-5.6", ModelRegistry.applyRetiredModelRule("openai", "oauth", overlayModel()!!))
        assertEquals("gpt-5.6", runtimeModel())
        assertEquals("gpt-5.6", prefs.disk["model"])
        assertEquals("intent cleared", null, intent())

        nodeProcess()
        assertEquals("restart", "gpt-5.6", serviceStart().model)
        mainProcess()
        assertEquals("a MAIN load after the repair", "gpt-5.6", ConfigManager.loadConfig(ctx)!!.model)
        assertEquals("gpt-5.6", overlayModel())
    }

    @Test
    fun `mixed state - MAIN load keeps the overlay 5_6 though runtime holds another valid model`() {
        // CodeRabbit on f1607b5d: prefs on retired 5.4, runtime_state on a different valid model,
        // the overlay on unlisted 5.6. The same-scope sync used to copy runtime's model into prefs
        // first, erasing the retired id; reconcile then saw no pending repair and clamped 5.6.
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-6-astra")
        writeOverlay("gpt-5.6")
        mainProcess()
        val runtimeBytes = Files.readAllBytes(dir.resolve(RuntimeStateFile.NAME))

        assertEquals("shows the repair's target (the effective overlay model)", "gpt-5.6", ConfigManager.loadConfig(ctx)!!.model)
        assertEquals("the retired prefs model is kept as evidence", "gpt-5.4", prefs.disk["model"])
        assertArrayEquals("runtime_state untouched", runtimeBytes, Files.readAllBytes(dir.resolve(RuntimeStateFile.NAME)))
        assertEquals("gpt-5.6", overlayModel())

        nodeProcess()
        assertEquals("gpt-5.6", serviceStart().model)
        assertEquals("gpt-5.6", overlayModel())
        assertEquals("gpt-5.6", runtimeModel())
        assertEquals("gpt-5.6", prefs.disk["model"])
        assertEquals("intent cleared", null, intent())
    }

    @Test
    fun `mixed state - the collector mirror keeps the evidence too, then load and start keep 5_6`() {
        // CodeRabbit on f943231d: the MAIN collector mirrors runtime_state into prefs on its first
        // emission and on every change — the same erase as the load's sync, by another writer.
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-6-astra")
        writeOverlay("gpt-5.6")
        mainProcess()
        val mirrored = ModelSelectionLock.transaction { tx -> RuntimeStateStore.mirrorFromDisk(tx, prefs) }
        assertEquals("nothing mirrored while the repair is pending", ModelSelectionLock.Result.Acquired(false), mirrored)
        assertEquals("the retired prefs model is kept", "gpt-5.4", prefs.disk["model"])
        assertEquals("the display still follows runtime_state", "gpt-6-astra", RuntimeStateStore.read().model)

        assertEquals("gpt-5.6", ConfigManager.loadConfig(ctx)!!.model)
        nodeProcess()
        assertEquals("gpt-5.6", serviceStart().model)
        assertEquals("gpt-5.6", overlayModel())
        assertEquals("gpt-5.6", prefs.disk["model"])

        // Once runtime_state holds the target, the collector mirrors again.
        mainProcess()
        prefs.seed("model" to "gpt-5.4") // MAIN's stale cache after the :node repair
        assertEquals(ModelSelectionLock.Result.Acquired(true), ModelSelectionLock.transaction { tx -> RuntimeStateStore.mirrorFromDisk(tx, prefs) })
        assertEquals("gpt-5.6", prefs.disk["model"])
    }

    @Test
    fun `while a repair is pending, Node model and provider changes still reach prefs through the collector`() {
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        writeOverlay("gpt-5.4")
        mainProcess()
        val mirror = { ModelSelectionLock.transaction { tx -> RuntimeStateStore.mirrorFromDisk(tx, prefs) } }

        // Node /model gpt-6-astra writes the overlay, then runtime_state (message-handler.js).
        writeOverlay("gpt-6-astra")
        writeRuntime("gpt-6-astra")
        assertEquals(ModelSelectionLock.Result.Acquired(true), mirror())
        assertEquals("a valid /model choice reaches prefs", "gpt-6-astra", prefs.disk["model"])

        // Node /provider xai: a scope with no retired list.
        prefs.seed("model" to "gpt-5.4")
        writeOverlay("grok-4.6", provider = "xai", auth = "api_key")
        writeRuntime("grok-4.6", provider = "xai", auth = "api_key")
        assertEquals(ModelSelectionLock.Result.Acquired(true), mirror())
        assertEquals("xai", prefs.disk["provider"])
        assertEquals("grok-4.6", prefs.disk["model"])
    }

    @Test
    fun `a pending repair still lets the sync move prefs to the repair's target`() {
        // The sync's own job (contract v2.4 §2) survives: after a :node repair, MAIN's cached prefs
        // still say 5.4 while runtime_state and the overlay hold the target.
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.6")
        writeOverlay("gpt-5.6")
        mainProcess()
        assertEquals("gpt-5.6", ConfigManager.loadConfig(ctx)!!.model)
        assertEquals("prefs synced to the target", "gpt-5.6", prefs.disk["model"])
        assertEquals("gpt-5.6", runtimeModel())
    }

    @Test
    fun `a provider switch still reconciles in MAIN while a repair is pending`() {
        // The guard covers a model-only change in the repair's scope; /provider is a selection.
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        writeOverlay("grok-4.6", provider = "xai", auth = "api_key")
        mainProcess()
        val c = ConfigManager.loadConfig(ctx)!!
        assertEquals("xai", c.provider)
        assertEquals("xai", prefs.disk["provider"])
        assertEquals("grok-4.6", prefs.disk["model"])
    }

    // ------------------------------------ review #3: the prefs sync never moves the auth

    @Test
    fun `pending xAI sign-in - repeated loads write nothing and keep OAuth selected`() {
        // Settings selected xAI + OAuth; no token yet, so runtime_state holds the api_key
        // boot guard (runtimeAuthTypeFor) while prefs and the overlay keep oauth.
        prefs.seed("setup_complete" to true, "provider" to "xai", "auth_type" to "oauth", "model" to "grok-4.6")
        writeOverlay("grok-4.6", provider = "xai", auth = "oauth")
        writeRuntime("grok-4.6", provider = "xai", auth = "api_key")
        File(dir.toFile(), "xai_oauth.migrated").createNewFile()
        CrossProcessStore(dir.toFile(), XaiOAuthTokenStore.FILE_NAME, XaiOAuthTokens.serializer(), XaiOAuthTokens()).write(XaiOAuthTokens())
        XaiOAuthTokenStore.initForTest(dir.toFile())
        mainProcess()

        val writes = prefs.modelKeyWrites
        val runtimeBytes = Files.readAllBytes(dir.resolve(RuntimeStateFile.NAME))
        repeat(3) {
            val c = ConfigManager.loadConfig(ctx)!!
            assertEquals("load ${it + 1}: OAuth stays selected", "oauth", c.authType)
        }
        assertEquals("no prefs model-key write", writes, prefs.modelKeyWrites)
        assertEquals("oauth", prefs.disk["auth_type"])
        assertArrayEquals("runtime_state untouched", runtimeBytes, Files.readAllBytes(dir.resolve(RuntimeStateFile.NAME)))
    }

    @Test
    fun `prefs sync - same scope copies the model only, from a record on disk`() {
        seedPrefs("gpt-5.4")
        mainProcess() // no runtime_state.json: the store serves its in-memory seed
        val synced = { ModelSelectionLock.transaction { tx -> RuntimeStateStore.syncPrefsFromFile(tx, dir, prefs) } }
        assertEquals("no file, no sync", ModelSelectionLock.Result.Acquired(false), synced())

        writeRuntime("gpt-6.1-sol", auth = "api_key")
        assertEquals("another auth, no sync", ModelSelectionLock.Result.Acquired(false), synced())
        assertEquals("gpt-5.4", prefs.disk["model"])

        writeRuntime("gpt-6.1-sol")
        assertEquals(ModelSelectionLock.Result.Acquired(true), synced())
        assertEquals("gpt-6.1-sol", prefs.disk["model"])
        assertEquals("oauth", prefs.disk["auth_type"])
    }

    @Test
    fun `collector mirror - only a record on disk is mirrored, never the launch seed`() {
        seedPrefs("gpt-6-astra")
        mainProcess() // the store's fallback is RuntimeState(): a different provider and model
        val runtime = dir.resolve(RuntimeStateFile.NAME)
        val mirror = { ModelSelectionLock.transaction { tx -> RuntimeStateStore.mirrorFromDisk(tx, prefs) } }

        assertEquals("missing file", ModelSelectionLock.Result.Acquired(false), mirror())
        runtime.toFile().writeText("{not json")
        assertEquals("malformed file", ModelSelectionLock.Result.Acquired(false), mirror())
        assertEquals("prefs untouched", "openai", prefs.disk["provider"])
        assertEquals("gpt-6-astra", prefs.disk["model"])

        writeRuntime("gpt-6.1-sol")
        assertEquals(ModelSelectionLock.Result.Acquired(true), mirror())
        assertEquals("gpt-6.1-sol", prefs.disk["model"])
    }

    // ---------------------------- review #4: the first-launch seed runs under the lock

    @Test
    fun `first-launch seed waits for the lock and seeds prefs as they are then`() {
        seedPrefs("gpt-5.4")
        val held = CountDownLatch(1)
        val release = CountDownLatch(1)
        val holder = thread {
            ModelSelectionLock.transaction { _ ->
                held.countDown()
                release.await(10, TimeUnit.SECONDS)
            }
        }
        assertTrue(held.await(5, TimeUnit.SECONDS))
        var seeded: Boolean? = null
        val seeder = thread {
            seeded = RuntimeStateStore.seedIfMissing(dir.toFile(), prefs) { s ->
                CrossProcessStore(dir.toFile(), RuntimeStateFile.NAME, RuntimeState.serializer(), s).write(s)
            }
        }
        Thread.sleep(200)
        assertFalse("nothing seeded while the lock is held", Files.exists(dir.resolve(RuntimeStateFile.NAME)))
        prefs.seed("model" to "gpt-6.1-sol") // the holder (e.g. a repair) changed prefs
        release.countDown()
        holder.join(5_000)
        seeder.join(10_000)
        assertEquals(true, seeded)
        assertEquals("seeded from prefs read under the lock", "gpt-6.1-sol", runtimeModel())
    }

    @Test
    fun `first-launch seed is skipped while a repair is pending`() {
        seedPrefs("gpt-5.4")
        writeOverlay("gpt-5.4")
        nodeProcess()
        ModelSelectionLock.transaction { tx -> ModelRepair.plan(tx, dir, ConfigManager.modelSnapshot(ctx)) }
        assertNotNull(intent())
        val seeded = RuntimeStateStore.seedIfMissing(dir.toFile(), prefs) { s ->
            CrossProcessStore(dir.toFile(), RuntimeStateFile.NAME, RuntimeState.serializer(), s).write(s)
        }
        assertTrue(seeded)
        assertFalse(Files.exists(dir.resolve(RuntimeStateFile.NAME)))
    }

    // ----------------------------- review #5: a rotated OpenAI pair never waits on the lock

    @Test
    fun `rotated OpenAI pair persists while the model-selection lock is held, and survives a restart of the writing process`() {
        // Scope: the writer and its own process. A LATER commit from the other process can still
        // write its older cached pair back, because commit() persists a process's whole map —
        // the known gap that BAT-1157 (a token store outside the shared prefs file) closes.
        // FakePrefs models one process's cache, so it cannot show that case.
        seedPrefs("gpt-6.1-sol")
        prefs.seed("openai_oauth_refresh_enc" to "sealed:old-refresh", "openai_oauth_expires_at" to "2026-11-01")
        val held = CountDownLatch(1)
        val release = CountDownLatch(1)
        val holder = thread {
            ModelSelectionLock.transaction { _ ->
                held.countDown()
                release.await(10, TimeUnit.SECONDS)
            }
        }
        assertTrue(held.await(5, TimeUnit.SECONDS))
        val writes = prefs.modelKeyWrites
        val t0 = System.nanoTime()
        val ok = ConfigManager.saveOpenAIOAuthRotationWith(ctx, "new-access", "new-refresh", "2026-12-01", sealer)
        val tookMs = (System.nanoTime() - t0) / 1_000_000
        release.countDown()
        holder.join(5_000)

        assertTrue(ok)
        assertTrue("did not wait for the lock ($tookMs ms)", tookMs < ModelSelectionLock.LOCK_TIMEOUT_MS)
        assertEquals("no model key touched", writes, prefs.modelKeyWrites)
        prefs.restartProcess()
        assertEquals("sealed:new-access", prefs.memory["openai_oauth_token_enc"])
        assertEquals("sealed:new-refresh", prefs.memory["openai_oauth_refresh_enc"])
        assertEquals("2026-12-01", prefs.memory["openai_oauth_expires_at"])
        assertEquals("gpt-6.1-sol", prefs.memory["model"])
    }

    @Test
    fun `rotated OpenAI pair - blank refresh keeps the stored one, a failed commit reports false`() {
        seedPrefs("gpt-6.1-sol")
        prefs.seed("openai_oauth_refresh_enc" to "sealed:old-refresh")
        assertTrue(ConfigManager.saveOpenAIOAuthRotationWith(ctx, "new-access", "", "", sealer))
        assertEquals("sealed:old-refresh", prefs.disk["openai_oauth_refresh_enc"])

        prefs.failCommits = true
        assertFalse(ConfigManager.saveOpenAIOAuthRotationWith(ctx, "newer-access", "newer-refresh", "", sealer))
    }

    // ------------------------------------------------------------------------------ fakes

    /**
     * SharedPreferences with Android's commit semantics: the edit reaches [memory] first; the
     * disk write may fail ([failCommits]), and then commit() returns false. [restartProcess]
     * reloads [memory] from [disk], as a new process would.
     *
     * It models ONE process's cache, and commit() writes only the edited keys. Real Android
     * writes the process's whole map, so two processes caching the same file can undo each
     * other's keys; tests here switch processes only through [restartProcess] and never assert
     * on that interleaving.
     */
    class FakePrefs : SharedPreferences {
        val disk = LinkedHashMap<String, Any?>()
        var memory = LinkedHashMap<String, Any?>()
            private set
        @Volatile var failCommits = false

        /** Writes of provider / auth_type / model that reached memory. */
        @Volatile var modelKeyWrites = 0
            private set

        fun seed(vararg kv: Pair<String, Any?>) {
            kv.forEach { (k, v) -> disk[k] = v; memory[k] = v }
        }

        @Synchronized fun restartProcess() {
            memory = LinkedHashMap(disk)
        }

        @Synchronized override fun getAll(): MutableMap<String, *> = LinkedHashMap(memory)
        @Synchronized override fun getString(key: String?, defValue: String?) = memory[key] as? String ?: defValue
        override fun getStringSet(key: String?, defValues: MutableSet<String>?) = defValues
        @Synchronized override fun getInt(key: String?, defValue: Int) = memory[key] as? Int ?: defValue
        @Synchronized override fun getLong(key: String?, defValue: Long) = memory[key] as? Long ?: defValue
        @Synchronized override fun getFloat(key: String?, defValue: Float) = memory[key] as? Float ?: defValue
        @Synchronized override fun getBoolean(key: String?, defValue: Boolean) = memory[key] as? Boolean ?: defValue
        @Synchronized override fun contains(key: String?) = memory.containsKey(key)
        override fun registerOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
        override fun unregisterOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit

        override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
            private val puts = LinkedHashMap<String, Any?>()
            private val removes = mutableSetOf<String>()
            private fun put(k: String?, v: Any?) = apply { puts[k!!] = v; removes.remove(k) }
            override fun putString(key: String?, value: String?) = put(key, value)
            override fun putStringSet(key: String?, values: MutableSet<String>?) = put(key, values)
            override fun putInt(key: String?, value: Int) = put(key, value)
            override fun putLong(key: String?, value: Long) = put(key, value)
            override fun putFloat(key: String?, value: Float) = put(key, value)
            override fun putBoolean(key: String?, value: Boolean) = put(key, value)
            override fun remove(key: String?) = apply { removes += key!!; puts.remove(key) }
            override fun clear() = apply { removes += memory.keys }

            override fun commit(): Boolean = synchronized(this@FakePrefs) {
                removes.forEach { memory.remove(it) }
                memory.putAll(puts)
                modelKeyWrites += puts.keys.count { it == "provider" || it == "auth_type" || it == "model" }
                if (failCommits) return false
                removes.forEach { disk.remove(it) }
                disk.putAll(puts)
                true
            }

            override fun apply() {
                commit()
            }
        }
    }

    /** `Context` backed by [filesDir] and one [FakePrefs] for every prefs file. */
    class FakeContext(private val filesDir: File, private val prefs: FakePrefs) : ContextWrapper(null) {
        override fun getFilesDir(): File = filesDir
        override fun getSharedPreferences(name: String?, mode: Int): SharedPreferences = prefs
    }
}
