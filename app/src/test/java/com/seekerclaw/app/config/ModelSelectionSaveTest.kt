package com.seekerclaw.app.config

import android.content.ContextWrapper
import android.content.SharedPreferences
import com.seekerclaw.app.state.AgentPreferencesStore
import com.seekerclaw.app.state.OpenAIOAuthTokenStore
import com.seekerclaw.app.state.RuntimeState
import com.seekerclaw.app.state.RuntimeStateStore
import com.seekerclaw.app.state.XaiOAuthTokenStore
import com.seekerclaw.app.state.XaiOAuthTokens
import com.seekerclaw.app.util.CrossProcessStore
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
import com.seekerclaw.app.util.ProcessRole
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

    /** The token store's codec: reversible, no Keystore on the JVM. */
    private val testCodec = object : SecretCodec {
        override fun seal(plain: String) = "sealed:$plain"
        override fun open(sealed: String) = sealed.removePrefix("sealed:")
    }

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
        // BAT-1157: the ChatGPT sign-in lives in the token store, not prefs. rawPrefsModelTuple
        // downgrades OpenAI oauth without a usable stored sign-in to api_key, so every fixture
        // user is signed in.
        OpenAIOAuthTokenStore.initForTest(dir.toFile(), testCodec)
        assertTrue(OpenAIOAuthTokenStore.signIn("old-access", "old-refresh", "", "") is OpenAIOAuthTokenStore.Result.Ok)
        prefs = FakePrefs()
        ctx = FakeContext(dir.toFile(), prefs)
    }

    @After
    fun tearDown() {
        SafeFs.dirSyncChecked = savedDirSync
        SafeFs.beforeMove = savedBeforeMove
        RuntimeStateStore.resetForTest()
        XaiOAuthTokenStore.resetForTest()
        OpenAIOAuthTokenStore.resetForTest()
        ProcessRole.setForTest(null)
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
            // The sign-in itself is in OpenAIOAuthTokenStore (setUp), not prefs (BAT-1157).
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

    /** MAIN, with its RuntimeStateStore on [seed] — the launch-time fallback, as `init` builds it. */
    private fun mainProcess(seed: RuntimeState = RuntimeState()) {
        ProcessRole.setForTest(false)
        RuntimeStateStore.resetForTest()
        RuntimeStateStore.initWithStoreForTest(dir.toFile(), seed, prefs)
    }

    private fun nodeProcess() {
        ProcessRole.setForTest(true)
        RuntimeStateStore.resetForTest()
        prefs.restartProcess()
    }

    /**
     * One service start as `:node` runs it; returns the config handed to the config.json emit.
     * BAT-1157 (contract v2.7 §1): it runs with the `:node` role, so it writes no prefs.
     */
    private fun serviceStart(): AppConfig {
        var emitted: AppConfig? = null
        val wasNode = ProcessRole.isNode
        ProcessRole.setForTest(true)
        val channel = try {
            ModelRepair.serviceStart(ctx) { cfg ->
                emitted = cfg
                "telegram"
            }
        } finally {
            ProcessRole.setForTest(wasNode)
        }
        assertEquals("the boot proceeds", "telegram", channel)
        return emitted!!
    }

    /**
     * Contract v2.8 §2–§3 (v2.7 §3 pin 1): a `:node` boot writes no prefs, so prefs still hold
     * [retired], and it handed off (`awaiting_main`). MAIN brings prefs to [target] on its next
     * locked load and marks `converged`; the start after that keeps the target, rewrites no intent
     * and logs no notice.
     */
    private fun assertMainLoadConverges(retired: String, target: String) {
        assertEquals("`:node` writes no prefs (v2.7 §1)", retired, prefs.disk["model"])
        assertEquals("handed off to MAIN", ModelRepair.STATE_AWAITING_MAIN, intent()?.state)
        mainProcess()
        ConfigManager.loadConfig(ctx)
        assertEquals("a MAIN load brings prefs to the target", target, prefs.disk["model"])
        assertEquals("MAIN converged", ModelRepair.STATE_CONVERGED, intent()?.state)
        val intentBytes = Files.readAllBytes(ModelRepair.intentPath(dir))
        nodeProcess()
        val anchor = LogCollector.logs.value.lastOrNull()
        assertEquals(target, serviceStart().model)
        assertArrayEquals("the next start writes no intent", intentBytes, Files.readAllBytes(ModelRepair.intentPath(dir)))
        assertFalse("no second notice", logsSince(anchor).any { it.message.contains("is not available with ChatGPT sign-in") })
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
        assertEquals("gpt-6.1-sol", runtimeModel())
        assertEquals("gpt-6.1-sol", overlayModel())
        assertMainLoadConverges(retired = "gpt-5.4", target = "gpt-6.1-sol")
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
        assertEquals("handed off", ModelRepair.STATE_AWAITING_MAIN, intent()?.state)
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

    // Contract v2.7 §4: "boot reconcile commit fails" no longer applies — `:node` never commits
    // prefs. Its successor is MAIN-side (v2.8 pin 8): the commit that brings prefs to the target
    // happens in MAIN's load, and a failure there must leave the intent `awaiting_main`.
    @Test
    fun `v2_8 pin 8 - MAIN prefs commit returns false - the intent stays awaiting_main, nothing retired is published`() {
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        writeOverlay("gpt-5.4")
        nodeProcess()
        serviceStart()
        assertEquals(ModelRepair.STATE_AWAITING_MAIN, intent()?.state)

        mainProcess()
        prefs.failCommits = true
        val anchor = LogCollector.logs.value.lastOrNull()
        ConfigManager.loadConfig(ctx)
        prefs.failCommits = false
        // CodeRabbit on 444ba220: the failed commit's value is taken back out of the cache
        // (MainPrefs.commitOrRestore), so no later commit of another key can flush it.
        assertEquals("the cache was restored", "gpt-5.4", prefs.memory["model"])
        assertEquals("disk did not take the write", "gpt-5.4", prefs.disk["model"])
        assertEquals("the intent stays awaiting_main", ModelRepair.STATE_AWAITING_MAIN, intent()?.state)
        assertTrue(logsSince(anchor).any { it.level == LogLevel.WARN && it.message == "[ModelRepair] app settings not yet on gpt-6.1-sol — the app retries on its next load" })
        assertEquals("nothing retired published: runtime_state", "gpt-6.1-sol", runtimeModel())
        assertEquals("nothing retired published: overlay", "gpt-6.1-sol", overlayModel())

        prefs.restartProcess() // MAIN restarts and reads 5.4 from disk; the next load retries
        ConfigManager.loadConfig(ctx)
        assertEquals("gpt-6.1-sol", prefs.disk["model"])
        assertEquals(ModelRepair.STATE_CONVERGED, intent()?.state)
    }

    @Test
    fun `v2_8 pin 8 - a SAME-process retry after a failed commit does a real write before converged`() {
        // Review Minor 1: on Android, after load N's failed commit the in-memory prefs hold the
        // target, so load N+1's sync would see nothing to change and a read-back would see memory.
        // Two guards now: commitOrRestore takes the value back out of the cache (CodeRabbit on
        // 444ba220), and the forced commitModelChecked write before `converged` stays.
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        writeOverlay("gpt-5.4")
        nodeProcess()
        serviceStart()
        assertEquals(ModelRepair.STATE_AWAITING_MAIN, intent()?.state)

        mainProcess()
        prefs.failCommits = true
        ConfigManager.loadConfig(ctx) // load N
        prefs.failCommits = false
        assertEquals("the cache was restored", "gpt-5.4", prefs.memory["model"])
        assertEquals("disk does not hold the target", "gpt-5.4", prefs.disk["model"])
        assertEquals(ModelRepair.STATE_AWAITING_MAIN, intent()?.state)

        // Load N+1 in the SAME process: no restartProcess().
        ConfigManager.loadConfig(ctx)
        assertEquals(ModelRepair.STATE_CONVERGED, intent()?.state)
        assertEquals("a cold read shows the target on disk", "gpt-6.1-sol", prefs.disk["model"])
    }

    @Test
    fun `v2_8 pin 8 - MAIN seed fails - the intent stays awaiting_main, nothing retired is published`() {
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        writeOverlay("gpt-5.4")
        nodeProcess()
        serviceStart()
        assertEquals(ModelRepair.STATE_AWAITING_MAIN, intent()?.state)
        Files.delete(dir.resolve(RuntimeStateFile.NAME)) // runtime_state lost after the handoff

        mainProcess()
        SafeFs.beforeMove = { _, target -> if (target.fileName.toString() == RuntimeStateFile.NAME) throw IOException("injected seed failure") }
        val anchor = LogCollector.logs.value.lastOrNull()
        ConfigManager.loadConfig(ctx)
        SafeFs.beforeMove = savedBeforeMove
        assertEquals("the intent stays awaiting_main", ModelRepair.STATE_AWAITING_MAIN, intent()?.state)
        assertEquals("prefs not moved without a durable runtime_state", "gpt-5.4", prefs.disk["model"])
        assertEquals("no runtime_state with the retired id", null, runtimeModel())
        assertEquals("the overlay keeps the target", "gpt-6.1-sol", overlayModel())
        assertTrue(logsSince(anchor).any { it.level == LogLevel.WARN && it.message.startsWith("[ModelRepair] could not restore runtime_state (") })

        ConfigManager.loadConfig(ctx) // the next load retries
        assertEquals("seeded from the intent", "gpt-6.1-sol", runtimeModel())
        assertEquals("gpt-6.1-sol", prefs.disk["model"])
        assertEquals(ModelRepair.STATE_CONVERGED, intent()?.state)
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
        assertMainLoadConverges(retired = "gpt-5.4", target = "gpt-5.6")

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
        assertMainLoadConverges(retired = "gpt-5.4", target = "gpt-5.6")
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
        assertMainLoadConverges(retired = "gpt-5.4", target = "gpt-5.6")

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
        assertMainLoadConverges(retired = "gpt-5.4", target = "gpt-5.6")
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
        assertEquals("`:node` writes no prefs (v2.7 §1)", "gpt-5.4", prefs.disk["model"])

        // Once runtime_state holds the target, the collector mirrors again (MAIN converges prefs).
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
    fun `v2_8 §3 - first-launch seed after the handoff seeds the proven target, never the retired prefs model`() {
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        writeOverlay("gpt-5.4")
        nodeProcess()
        serviceStart()
        assertEquals(ModelRepair.STATE_AWAITING_MAIN, intent()?.state)
        Files.delete(dir.resolve(RuntimeStateFile.NAME))
        prefs.restartProcess() // MAIN's cache: still the retired 5.4
        val seeded = RuntimeStateStore.seedIfMissing(dir.toFile(), prefs) { s ->
            CrossProcessStore(dir.toFile(), RuntimeStateFile.NAME, RuntimeState.serializer(), s).write(s)
        }
        assertTrue(seeded)
        assertEquals("seeded from the intent's target", "gpt-6.1-sol", runtimeModel())
        // Negative: a corrupt record is never used for seeding.
        Files.delete(dir.resolve(RuntimeStateFile.NAME))
        ModelRepair.intentPath(dir).toFile().writeText("{not json")
        assertTrue(RuntimeStateStore.seedIfMissing(dir.toFile(), prefs) { error("must not seed from prefs while a record exists") })
        assertFalse(Files.exists(dir.resolve(RuntimeStateFile.NAME)))
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


    // ----------------------- CodeRabbit on 444ba220: no runtime_state record out of the launch seed

    private fun classify() =
        intent()?.let { ModelRepair.classifyIntent(it, ConfigManager.modelSnapshot(ctx, migrate = false), main = true) }

    private fun runtimePath() = dir.resolve(RuntimeStateFile.NAME)

    /** A `:node` start's decision only: the intent is written `pending`, no store is touched. */
    private fun pendingRepairWithoutRuntime() {
        seedPrefs("gpt-5.4")
        writeOverlay("gpt-5.4")
        nodeProcess()
        ModelSelectionLock.transaction { tx -> ModelRepair.plan(tx, dir, ConfigManager.modelSnapshot(ctx)) }
        assertEquals(ModelRepair.STATE_PENDING, intent()?.state)
        assertFalse(Files.exists(runtimePath()))
    }

    @Test
    fun `T1 - unrelated save with no runtime_state record writes none - never the launch seed`() {
        seedPrefs("gpt-6-astra")
        writeOverlay("gpt-6-astra")
        mainProcess() // the launch seed is RuntimeState(): Claude, as after a fresh install
        assertTrue(save(form(ModelTuple("openai", "oauth", "gpt-6-astra")) { it.copy(heartbeatIntervalMinutes = 45) }))
        assertEquals("the save landed", "45", overlayInt("heartbeatIntervalMinutes"))
        assertFalse("no record built from the seed (Node would run Claude)", Files.exists(runtimePath()))
        assertEquals("openai", prefs.disk["provider"])
        assertEquals("gpt-6-astra", prefs.disk["model"])
    }

    @Test
    fun `T1 - unrelated save during a pending repair with runtime_state missing keeps the repair pending`() {
        pendingRepairWithoutRuntime()
        val pending = intent()
        mainProcess(seed = RuntimeState(provider = "openai", authType = "oauth", model = "gpt-5.4"))
        assertTrue("still Pending before: ${classify()}", classify() is ModelRepair.IntentClass.Pending)
        assertTrue(save(form(ModelTuple("openai", "oauth", "gpt-5.4")) { it.copy(heartbeatIntervalMinutes = 45) }))
        assertFalse("no record from the seed", Files.exists(runtimePath()))
        assertEquals("intent kept", pending, intent())
        assertTrue("an unrelated save never cancels the repair (v2.5 §2): ${classify()}", classify() is ModelRepair.IntentClass.Pending)
    }

    @Test
    fun `T1 - unrelated save over a record on disk still carries its own fields and keeps the selection`() {
        seedPrefs("gpt-6-astra")
        writeRuntime("gpt-6-astra") // reasoningEnabled = true
        writeOverlay("gpt-6-astra")
        mainProcess()
        assertTrue(save(form(ModelTuple("openai", "oauth", "gpt-6-astra")) { it.copy(heartbeatIntervalMinutes = 45) }))
        val rec = CrossProcessStore(dir.toFile(), RuntimeStateFile.NAME, RuntimeState.serializer(), RuntimeState()).read()
        assertEquals(ModelTuple("openai", "oauth", "gpt-6-astra"), ModelTuple(rec.provider, rec.authType, rec.model))
        assertTrue("reasoning toggle preserved", rec.reasoningEnabled)
    }

    @Test
    fun `T1 sibling - a reasoning toggle during a pending repair with runtime_state missing is refused`() {
        pendingRepairWithoutRuntime()
        mainProcess(seed = RuntimeState(provider = "openai", authType = "oauth", model = "gpt-5.4"))
        assertFalse(RuntimeStateStore.updateInOwnTransaction { it.copy(reasoningEnabled = true) })
        assertFalse("no record from the seed", Files.exists(runtimePath()))
        assertTrue("the repair is still pending: ${classify()}", classify() is ModelRepair.IntentClass.Pending)
    }

    @Test
    fun `T1 sibling - a reasoning toggle with no record and no repair seeds from prefs as they are now`() {
        seedPrefs("gpt-6-astra")
        mainProcess() // the launch seed is Claude; prefs say OpenAI
        assertTrue(RuntimeStateStore.updateInOwnTransaction { it.copy(reasoningEnabled = true) })
        assertEquals(ModelTuple("openai", "oauth", "gpt-6-astra"), RuntimeStateFile.readTuple(dir))
        val rec = CrossProcessStore(dir.toFile(), RuntimeStateFile.NAME, RuntimeState.serializer(), RuntimeState()).read()
        assertTrue("the toggle landed on the seeded record", rec.reasoningEnabled)
    }

    @Test
    fun `T1 sibling - a toggle over a partial record seeds only the selection, other fields kept`() {
        seedPrefs("gpt-6-astra")
        runtimePath().toFile().writeText("""{"reasoningEnabled":true,"reasoningDisplayInChat":true}""")
        mainProcess() // the launch seed is Claude; prefs say OpenAI
        assertTrue(RuntimeStateStore.updateInOwnTransaction { it.copy(reasoningEnabled = false) })
        assertEquals(ModelTuple("openai", "oauth", "gpt-6-astra"), RuntimeStateFile.readTuple(dir))
        val rec = CrossProcessStore(dir.toFile(), RuntimeStateFile.NAME, RuntimeState.serializer(), RuntimeState()).read()
        assertTrue("reasoningDisplayInChat kept from the partial record", rec.reasoningDisplayInChat)
        assertFalse("the toggle landed", rec.reasoningEnabled)
    }

    private fun xaiUser(runtimeAuth: String?) {
        prefs.seed("setup_complete" to true, "provider" to "xai", "auth_type" to "oauth", "model" to "grok-4.6")
        writeOverlay("grok-4.6", provider = "xai", auth = "oauth")
        if (runtimeAuth != null) writeRuntime("grok-4.6", provider = "xai", auth = runtimeAuth)
        File(dir.toFile(), "xai_oauth.migrated").createNewFile()
        CrossProcessStore(dir.toFile(), XaiOAuthTokenStore.FILE_NAME, XaiOAuthTokens.serializer(), XaiOAuthTokens()).write(XaiOAuthTokens())
        XaiOAuthTokenStore.initForTest(dir.toFile())
        mainProcess()
    }

    @Test
    fun `T1 sibling - xAI auth sync with no runtime_state record writes none and reports success`() {
        xaiUser(runtimeAuth = null)
        assertEquals(ConfigManager.XaiAuthSync.SYNCED, ConfigManager.syncXaiRuntimeAuthType(ctx))
        assertFalse("no record from the seed", Files.exists(runtimePath()))
    }

    @Test
    fun `T4 - xAI auth sync with the lock busy reports failure after its bounded retries`() {
        xaiUser(runtimeAuth = "oauth")
        val before = Files.readAllBytes(runtimePath())
        val held = CountDownLatch(1)
        val release = CountDownLatch(1)
        val holder = thread {
            ModelSelectionLock.transaction { _ ->
                held.countDown()
                release.await(10, TimeUnit.SECONDS)
            }
        }
        assertTrue(held.await(5, TimeUnit.SECONDS))
        val anchor = LogCollector.logs.value.lastOrNull()
        val ok = ConfigManager.syncXaiRuntimeAuthType(ctx, lockTimeoutMs = 50, attempts = 2)
        release.countDown()
        holder.join(5_000)
        assertEquals("a skipped sync is BUSY: the caller must not restart :node", ConfigManager.XaiAuthSync.BUSY, ok)
        assertTrue(logsSince(anchor).any { it.message.startsWith("[Config] xAI OAuth runtime_state sync skipped: lock busy (") })
        assertArrayEquals("runtime_state untouched", before, Files.readAllBytes(runtimePath()))
        // Once the lock is free it syncs: no token, so the H5 guard image api_key is written.
        assertEquals(ConfigManager.XaiAuthSync.SYNCED, ConfigManager.syncXaiRuntimeAuthType(ctx, lockTimeoutMs = 50, attempts = 2))
        assertEquals("api_key", RuntimeStateFile.readTuple(dir)?.authType)
    }

    @Test
    fun `T4 - a storage failure in the xAI auth sync is NOT_SAVED, never reported as busy`() {
        xaiUser(runtimeAuth = "oauth")
        SafeFs.beforeMove = { _, target ->
            if (target.fileName.toString() == RuntimeStateFile.NAME) throw IOException("injected runtime_state write failure")
        }
        val anchor = LogCollector.logs.value.lastOrNull()
        val r = try {
            ConfigManager.syncXaiRuntimeAuthType(ctx, lockTimeoutMs = 50, attempts = 2)
        } finally {
            SafeFs.beforeMove = savedBeforeMove
        }
        assertEquals(ConfigManager.XaiAuthSync.NOT_SAVED, r)
        val lines = logsSince(anchor).map { it.message }
        assertTrue(lines.toString(), lines.any { it == "[Config] xAI OAuth runtime_state sync failed: runtime_state.json not written" })
        assertFalse("not called busy", lines.any { it.contains("lock busy") })
    }

    @Test
    fun `T4 - the xAI sync waits about 5 s in all - a Reset behind its ResetGate read waits no longer`() {
        // The sign-in runs the sync inside ResetGate.commit (the read side); Reset Config takes the
        // write side. Three attempts must stay near the earlier single 5 s bound.
        val total = ConfigManager.XAI_SYNC_LOCK_TIMEOUT_MS * ConfigManager.XAI_SYNC_ATTEMPTS
        assertTrue("total xAI sync wait $total ms", total in 4_500L..5_100L)
    }

    // ------------------- CodeRabbit on 444ba220 (overflow ModelRepair:879): the busy start uses D7.3

    @Test
    fun `busy start emits the D7_3 boot selection - never a foreign overlay's provider`() {
        // Prefs on Claude, no runtime_state, an OpenAI overlay left by an interrupted /provider.
        seedPrefs("claude-opus-5-5", provider = "claude", auth = "api_key")
        writeOverlay("gpt-6-astra", provider = "openai", auth = "oauth")
        val held = CountDownLatch(1)
        val release = CountDownLatch(1)
        val holder = thread {
            ModelSelectionLock.transaction { _ ->
                held.countDown()
                release.await(10, TimeUnit.SECONDS)
            }
        }
        assertTrue(held.await(5, TimeUnit.SECONDS))
        nodeProcess()
        val anchor = LogCollector.logs.value.lastOrNull()
        val busy = try {
            serviceStart()
        } finally {
            release.countDown()
            holder.join(5_000)
        }
        assertTrue(logsSince(anchor).any { it.message == ModelRepair.BUSY_WARNING })
        assertEquals("the busy start runs the provider Node's dispatch runs", "claude", busy.provider)
        assertEquals("claude-opus-5-5", busy.model)
        // Control: the ordinary start, same files, emits the same selection.
        val ordinary = serviceStart()
        assertEquals(busy.provider, ordinary.provider)
        assertEquals(busy.model, ordinary.model)
    }

    // ----------------------- CodeRabbit on 444ba220: a failed commit must not stay in the prefs cache

    @Test
    fun `T8 - a failed selection then an unrelated commit - the rejected model never reaches disk`() {
        seedPrefs("gpt-6-astra")
        writeRuntime("gpt-6-astra")
        writeOverlay("gpt-6-astra")
        mainProcess()
        prefs.failCommits = true
        assertFalse(save(form(ModelTuple("openai", "oauth", "gpt-6-astra")) { it.copy(model = "gpt-6.1-sol") }))
        prefs.failCommits = false
        assertEquals("the cache is back on the stored model", "gpt-6-astra", prefs.memory["model"])
        // Any later successful commit writes the whole cached map (e.g. an Auto-start toggle).
        assertTrue(prefs.edit().putBoolean("auto_start", true).commit())
        assertEquals("gpt-6-astra", prefs.disk["model"])
        assertEquals(true, prefs.disk["auto_start"])
        assertEquals("runtime_state untouched", "gpt-6-astra", runtimeModel())
        assertEquals("overlay untouched", "gpt-6-astra", overlayModel())
    }

    @Test
    fun `T3 - a reconcile whose prefs commit failed is retried by the next load`() {
        seedPrefs("gpt-6-astra")
        writeRuntime("gpt-6-astra")
        writeOverlay("grok-4.6", provider = "xai", auth = "api_key") // Node /provider xai
        mainProcess(seed = RuntimeState(provider = "openai", authType = "oauth", model = "gpt-6-astra"))
        prefs.failCommits = true
        ConfigManager.loadConfig(ctx)
        prefs.failCommits = false
        assertEquals("the cache is back on the stored provider", "openai", prefs.memory["provider"])
        assertEquals("xai", ConfigManager.loadConfig(ctx)!!.provider)
        assertEquals("the retry reached disk", "xai", prefs.disk["provider"])
        assertEquals("and runtime_state", "xai", RuntimeStateFile.readTuple(dir)?.provider)
    }

    @Test
    fun `prefs sync whose commit failed is retried by the next sync`() {
        seedPrefs("gpt-6-astra")
        writeRuntime("gpt-6.1-sol")
        mainProcess()
        val synced = { ModelSelectionLock.transaction { tx -> RuntimeStateStore.syncPrefsFromFile(tx, dir, prefs) } }
        prefs.failCommits = true
        assertEquals(ModelSelectionLock.Result.Acquired(false), synced())
        prefs.failCommits = false
        assertEquals("gpt-6-astra", prefs.memory["model"])
        assertEquals(ModelSelectionLock.Result.Acquired(true), synced())
        assertEquals("gpt-6.1-sol", prefs.disk["model"])
    }

    @Test
    fun `collector mirror whose commit failed is retried by the next emission`() {
        seedPrefs("gpt-6-astra")
        mainProcess()
        writeRuntime("gpt-6.1-sol")
        val mirror = { ModelSelectionLock.transaction { tx -> RuntimeStateStore.mirrorFromDisk(tx, prefs) } }
        prefs.failCommits = true
        assertEquals(ModelSelectionLock.Result.Acquired(false), mirror())
        prefs.failCommits = false
        assertEquals("gpt-6-astra", prefs.memory["model"])
        assertEquals(ModelSelectionLock.Result.Acquired(true), mirror())
        assertEquals("gpt-6.1-sol", prefs.disk["model"])
    }

    @Test
    fun `commitOrRestore - a failed commit puts every changed key back, of every type`() {
        prefs.seed("s" to "old", "b" to false, "i" to 1, "l" to 2L, "f" to 1.5f, "set" to setOf("a"), "gone" to "keep")
        val e = MainPrefs.edit(prefs).putString("s", "new").putBoolean("b", true).putInt("i", 9).putLong("l", 9L)
            .putFloat("f", 9.5f).putStringSet("set", mutableSetOf("b", "c")).putString("added", "x").remove("gone")
        prefs.failCommits = true
        assertFalse(MainPrefs.commitOrRestore(e))
        prefs.failCommits = false
        assertEquals(
            mapOf("s" to "old", "b" to false, "i" to 1, "l" to 2L, "f" to 1.5f, "set" to setOf("a"), "gone" to "keep"),
            prefs.memory.toMap(),
        )
        assertTrue(MainPrefs.commitOrRestore(MainPrefs.edit(prefs).putString("s", "new")))
        assertEquals("new", prefs.disk["s"])
    }

    @Test
    fun `commitOrRestore - another writer's key that lands meanwhile survives a failed commit`() {
        // An unlocked apply() in MAIN (lastCustomModel_*, lastAuthType_*, the auto-start toggle)
        // lands after the restore's snapshot and before the failure. It is not this edit's key, so
        // it must not be "restored" away.
        seedPrefs("gpt-6-astra")
        prefs.seed("lastCustomModel_openai" to "old-custom", "auto_start" to false)
        prefs.beforeNextCommit = {
            prefs.externalWrite("lastCustomModel_openai", "new-custom")
            prefs.externalWrite("auto_start", true)
        }
        prefs.failCommits = true
        assertFalse(MainPrefs.commitOrRestore(MainPrefs.edit(prefs).putString("model", "gpt-6.1-sol")))
        prefs.failCommits = false
        assertEquals("this edit's key is restored", "gpt-6-astra", prefs.memory["model"])
        assertEquals("the other writer's key is kept", "new-custom", prefs.memory["lastCustomModel_openai"])
        assertEquals(true, prefs.memory["auto_start"])
        // The same key, rewritten by another writer meanwhile: theirs is kept too.
        prefs.beforeNextCommit = { prefs.externalWrite("lastCustomModel_openai", "theirs") }
        prefs.failCommits = true
        // (the hook runs inside commit, after this edit was recorded, before it lands)
        assertFalse(MainPrefs.commitOrRestore(MainPrefs.edit(prefs).putString("agent_name", "Mine")))
        prefs.failCommits = false
        assertEquals("theirs", prefs.memory["lastCustomModel_openai"])
        assertEquals(null, prefs.memory["agent_name"])
    }

    // ---------------------------------------------------------- CodeRabbit on 444ba220: hardening

    @Test
    fun `T6a - the collector never mirrors a partial record decoded with default fields`() {
        seedPrefs("gpt-6-astra")
        mainProcess()
        runtimePath().toFile().writeText("""{"reasoningEnabled":true}""")
        val r = ModelSelectionLock.transaction { tx -> RuntimeStateStore.mirrorFromDisk(tx, prefs) }
        assertEquals(ModelSelectionLock.Result.Acquired(false), r)
        assertEquals("openai", prefs.disk["provider"])
        assertEquals("oauth", prefs.disk["auth_type"])
        assertEquals("gpt-6-astra", prefs.disk["model"])
    }

    @Test
    fun `RSS 411 - a blank runtime model is never synced into prefs`() {
        seedPrefs("gpt-6-astra")
        writeRuntime("   ")
        mainProcess()
        val r = ModelSelectionLock.transaction { tx -> RuntimeStateStore.syncPrefsFromFile(tx, dir, prefs) }
        assertEquals(ModelSelectionLock.Result.Acquired(false), r)
        assertEquals("gpt-6-astra", prefs.disk["model"])
    }

    @Test
    fun `T2 - a failed selection's undo leaves a newer runtime_state selection in place`() {
        seedPrefs("gpt-6-astra")
        writeRuntime("gpt-6-astra")
        writeOverlay("gpt-6-astra")
        mainProcess()
        // Node's /provider xai lands after this save's runtime write and before its overlay write,
        // and that overlay write then fails.
        SafeFs.beforeMove = { _, target ->
            if (target.fileName.toString() == AgentSettingsFile.NAME) {
                SafeFs.beforeMove = savedBeforeMove
                writeRuntime("grok-4.6", provider = "xai", auth = "api_key")
                throw IOException("injected overlay write failure")
            }
        }
        val anchor = LogCollector.logs.value.lastOrNull()
        val ok = save(form(ModelTuple("openai", "oauth", "gpt-6-astra")) { it.copy(model = "gpt-6.1-sol") })
        SafeFs.beforeMove = savedBeforeMove
        assertFalse(ok)
        assertEquals("the newer selection is kept", ModelTuple("xai", "api_key", "grok-4.6"), RuntimeStateFile.readTuple(dir))
        assertEquals("prefs rolled back", "gpt-6-astra", prefs.disk["model"])
        val line = logsSince(anchor).single { it.message.startsWith("[Config] agent_settings.json write failed — rolled back") }
        assertTrue("the log says the newer record was kept: ${line.message}", line.message.contains("runtime_undone=true, runtime_kept_newer=true,"))
    }

    private fun runtimeRecord() =
        CrossProcessStore(dir.toFile(), RuntimeStateFile.NAME, RuntimeState.serializer(), RuntimeState()).read()

    private fun rewriteRuntime(edit: (RuntimeState) -> RuntimeState) {
        val cps = CrossProcessStore(dir.toFile(), RuntimeStateFile.NAME, RuntimeState.serializer(), RuntimeState())
        cps.write(edit(cps.read()))
    }

    /** A selection whose overlay write fails, with [between] landing after its runtime_state write. */
    private fun failedSelection(between: () -> Unit): List<com.seekerclaw.app.util.LogEntry> {
        seedPrefs("gpt-6-astra")
        writeRuntime("gpt-6-astra") // reasoningEnabled = true
        writeOverlay("gpt-6-astra")
        mainProcess()
        SafeFs.beforeMove = { _, target ->
            if (target.fileName.toString() == AgentSettingsFile.NAME) {
                SafeFs.beforeMove = savedBeforeMove
                between()
                throw IOException("injected overlay write failure")
            }
        }
        val anchor = LogCollector.logs.value.lastOrNull()
        try {
            assertFalse(save(form(ModelTuple("openai", "oauth", "gpt-6-astra")) { it.copy(model = "gpt-6.1-sol") }))
        } finally {
            SafeFs.beforeMove = savedBeforeMove
        }
        return logsSince(anchor)
    }

    @Test
    fun `T2 - a concurrent reasoning toggle survives the undo, which puts back only the save's fields`() {
        val logs = failedSelection { rewriteRuntime { it.copy(reasoningEnabled = false) } } // /think off
        val rec = runtimeRecord()
        assertEquals("the save's tuple is undone", ModelTuple("openai", "oauth", "gpt-6-astra"), ModelTuple(rec.provider, rec.authType, rec.model))
        assertFalse("the concurrent /think off is kept", rec.reasoningEnabled)
        assertTrue(logs.any { it.message.contains("runtime_undone=true, agent_prefs_undone=") })
    }

    @Test
    fun `T2 - the undo's compare covers customEchoReasoning`() {
        failedSelection { rewriteRuntime { it.copy(customEchoReasoning = true) } }
        assertEquals("changed echo: the record is not this save's, so it is kept",
            ModelTuple("openai", "oauth", "gpt-6.1-sol"), RuntimeStateFile.readTuple(dir))
        assertTrue(runtimeRecord().customEchoReasoning)
    }

    @Test
    fun `T2 - the undo's compare covers customConfigSignature`() {
        failedSelection { rewriteRuntime { it.copy(customConfigSignature = "newer-gateway") } }
        assertEquals("changed signature: kept", ModelTuple("openai", "oauth", "gpt-6.1-sol"), RuntimeStateFile.readTuple(dir))
        assertEquals("newer-gateway", runtimeRecord().customConfigSignature)
    }

    // ------------------------------------------------------------------------------ fakes

    /**
     * SharedPreferences with Android's commit semantics: the edit reaches [memory] first; the
     * disk write may fail ([failCommits]), and then commit() returns false. [restartProcess]
     * reloads [memory] from [disk], as a new process would.
     *
     * It models ONE process's cache. As on Android (`SharedPreferencesImpl`), a successful
     * commit() writes the process's WHOLE cached map, not only the edited keys: a value a failed
     * commit left in memory reaches disk with the next successful commit of any key (CodeRabbit on
     * 444ba220). Tests here switch processes only through [restartProcess]; two-process
     * interleavings are modelled by `TwoProcessPrefs`.
     */
    class FakePrefs : SharedPreferences {
        val disk = LinkedHashMap<String, Any?>()
        var memory = LinkedHashMap<String, Any?>()
            private set
        @Volatile var failCommits = false

        /** Runs at the start of the next commit() only: another in-process writer landing then. */
        @Volatile var beforeNextCommit: (() -> Unit)? = null

        /** Another writer's change, already committed (memory and disk), e.g. an apply() of its own key. */
        @Synchronized fun externalWrite(key: String, value: Any?) {
            if (value == null) { memory.remove(key); disk.remove(key) } else { memory[key] = value; disk[key] = value }
        }

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
                beforeNextCommit?.let { hook -> beforeNextCommit = null; hook() }
                removes.forEach { memory.remove(it) }
                memory.putAll(puts)
                modelKeyWrites += puts.keys.count { it == "provider" || it == "auth_type" || it == "model" }
                if (failCommits) return false
                disk.clear()
                disk.putAll(memory)
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
