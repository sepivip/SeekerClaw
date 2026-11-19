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

    /**
     * `ConfigManager.broadcastConfigChanged` calls since [anchor]. On the JVM (android.jar stubs with
     * returnDefaultValues) `Intent.setPackage` returns null, so every call fails the same way and
     * logs exactly one `[Config] broadcastConfigChanged failed: …` WARN: a deterministic count.
     */
    private fun broadcastsSince(anchor: com.seekerclaw.app.util.LogEntry?) =
        logsSince(anchor).count { it.message.startsWith("[Config] broadcastConfigChanged failed: ") }

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

    // --------- CodeRabbit on ca06bb79: the seed applies the H5 gate; the mirror keeps the selection

    private fun seedNow() = RuntimeStateStore.seedIfMissing(dir.toFile(), prefs) { st ->
        CrossProcessStore(dir.toFile(), RuntimeStateFile.NAME, RuntimeState.serializer(), st).write(st)
    }

    @Test
    fun `H5 - first-launch seed for xAI oauth with no token stores api_key, never the unstartable oauth pair`() {
        xaiUser(runtimeAuth = null) // xAI + OAuth selected, no token, no reauth
        assertTrue(seedNow())
        assertEquals(ModelTuple("xai", "api_key", "grok-4.6"), RuntimeStateFile.readTuple(dir))
        assertEquals("prefs keep the user's oauth selection", "oauth", prefs.disk["auth_type"])
    }

    @Test
    fun `H5 - a toggle's seed for xAI oauth with no token stores api_key`() {
        xaiUser(runtimeAuth = null)
        assertTrue(RuntimeStateStore.updateInOwnTransaction { it.copy(reasoningEnabled = true) })
        assertEquals(ModelTuple("xai", "api_key", "grok-4.6"), RuntimeStateFile.readTuple(dir))
    }

    @Test
    fun `H5 - a dead xAI family (reauth) is seeded as oauth so the agent boots into reconnect`() {
        prefs.seed("setup_complete" to true, "provider" to "xai", "auth_type" to "oauth", "model" to "grok-4.6")
        File(dir.toFile(), "xai_oauth.migrated").createNewFile()
        CrossProcessStore(dir.toFile(), XaiOAuthTokenStore.FILE_NAME, XaiOAuthTokens.serializer(), XaiOAuthTokens())
            .write(XaiOAuthTokens(reauthRequired = true))
        XaiOAuthTokenStore.initForTest(dir.toFile())
        mainProcess()
        assertTrue(seedNow())
        assertEquals(ModelTuple("xai", "oauth", "grok-4.6"), RuntimeStateFile.readTuple(dir))
    }

    @Test
    fun `H5 - the collector mirror keeps prefs' oauth when the record holds only its guard image`() {
        xaiUser(runtimeAuth = "api_key") // the guard image of (xai, oauth) with no token
        val r = ModelSelectionLock.transaction { tx -> RuntimeStateStore.mirrorFromDisk(tx, prefs) }
        assertEquals(ModelSelectionLock.Result.Acquired(false), r)
        assertEquals("the user's oauth selection is kept", "oauth", prefs.disk["auth_type"])
    }

    @Test
    fun `Q12 - a chat api_key choice (overlay explicitly xai-api_key) IS mirrored over stale oauth prefs`() {
        xaiUser(runtimeAuth = "api_key")
        writeOverlay("grok-4.6", provider = "xai", auth = "api_key") // Node /provider xai api_key
        val r = ModelSelectionLock.transaction { tx -> RuntimeStateStore.mirrorFromDisk(tx, prefs) }
        assertEquals(ModelSelectionLock.Result.Acquired(true), r)
        assertEquals("api_key", prefs.disk["auth_type"])
    }

    private fun signInXai() {
        // A stored sign-in. It does not decrypt on the JVM, which the boot reads as reauth: the H5
        // rule then keeps oauth, as for a live token.
        CrossProcessStore(dir.toFile(), XaiOAuthTokenStore.FILE_NAME, XaiOAuthTokens.serializer(), XaiOAuthTokens())
            .write(XaiOAuthTokens(accessTokenEnc = "c2VhbGVk", refreshTokenEnc = "c2VhbGVk", epoch = 1))
        XaiOAuthTokenStore.resetForTest()
        XaiOAuthTokenStore.initForTest(dir.toFile())
    }

    @Test
    fun `CR1 - a sign-in landing before the mirror does not turn the seeded guard into an api_key choice`() {
        xaiUser(runtimeAuth = null)
        assertTrue(seedNow())
        assertEquals("the seed wrote the H5 guard", "api_key", RuntimeStateFile.readTuple(dir)?.authType)
        signInXai() // the token is saved; the collector has not mirrored yet
        val r = ModelSelectionLock.transaction { tx -> RuntimeStateStore.mirrorFromDisk(tx, prefs) }
        assertEquals(ModelSelectionLock.Result.Acquired(false), r)
        assertEquals("the user's oauth selection survives", "oauth", prefs.disk["auth_type"])
        // Then the sign-in's sync lands oauth in runtime_state, and a boot runs oauth.
        assertEquals(ConfigManager.XaiAuthSync.SYNCED, ConfigManager.syncXaiRuntimeAuthType(ctx, lockTimeoutMs = 50, attempts = 1))
        assertEquals("oauth", RuntimeStateFile.readTuple(dir)?.authType)
        nodeProcess()
        assertEquals("oauth", serviceStart().authType)
    }

    @Test
    fun `Q12 - stale oauth prefs, both fresh files on xai-api_key - boot keeps the newer api_key choice`() {
        xaiUser(runtimeAuth = "api_key")
        writeOverlay("grok-4.6", provider = "xai", auth = "api_key")
        nodeProcess()
        assertEquals("the boot takes the newer explicit choice", "api_key", serviceStart().authType)
    }

    @Test
    fun `Q12 - pending xAI sign-in (overlay on oauth) - boot keeps OAuth over the no-token guard`() {
        xaiUser(runtimeAuth = "api_key")
        nodeProcess()
        assertEquals("oauth", serviceStart().authType)
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
    fun `T3b - a reconcile whose runtime_state write failed is retried by the next load`() {
        // CodeRabbit on ca06bb79: prefs commit OK, then runtime_state.json is not written. Prefs and
        // the overlay then agree, so without a rollback no later load re-runs the reconcile, and
        // Node's dispatch (runtime_state first) stays on the old provider.
        seedPrefs("gpt-6-astra")
        writeRuntime("gpt-6-astra")
        writeOverlay("grok-4.6", provider = "xai", auth = "api_key") // Node /provider xai
        mainProcess(seed = RuntimeState(provider = "openai", authType = "oauth", model = "gpt-6-astra"))
        SafeFs.beforeMove = { _, target ->
            if (target.fileName.toString() == RuntimeStateFile.NAME) throw IOException("injected runtime_state write failure")
        }
        val anchor = LogCollector.logs.value.lastOrNull()
        val version0 = ConfigManager.configVersion.intValue
        val first = try {
            ConfigManager.loadConfig(ctx)!!
        } finally {
            SafeFs.beforeMove = savedBeforeMove
        }
        assertEquals("no config-version bump for a reconcile that did not land", version0, ConfigManager.configVersion.intValue)
        assertEquals("no broadcast for a reconcile that did not land", 0, broadcastsSince(anchor))
        assertEquals("runtime_state still on the old provider", "openai", RuntimeStateFile.readTuple(dir)?.provider)
        assertEquals("prefs rolled back with it (disk)", "openai", prefs.disk["provider"])
        assertEquals("prefs rolled back with it (cache)", "openai", prefs.memory["provider"])
        assertEquals("this load reports what is stored", "openai", first.provider)
        assertTrue(logsSince(anchor).any { it.level == LogLevel.WARN && it.message.startsWith("[Config] Reconcile: runtime_state.json not saved — ") })
        assertFalse("no 'Reconciled' line for a reconcile that did not land", logsSince(anchor).any { it.message.startsWith("[Config] Reconciled from agent_settings.json") })

        // The next load retries, and this time both stores land — and only now signal the change
        // (the positive control: the harness does see the bump and the broadcast).
        val version1 = ConfigManager.configVersion.intValue
        val retry = LogCollector.logs.value.lastOrNull()
        assertEquals("xai", ConfigManager.loadConfig(ctx)!!.provider)
        assertEquals("xai", prefs.disk["provider"])
        assertEquals(ModelTuple("xai", "api_key", "grok-4.6"), RuntimeStateFile.readTuple(dir))
        assertTrue("the landed reconcile bumps the config version", ConfigManager.configVersion.intValue > version1)
        assertEquals("and broadcasts once", 1, broadcastsSince(retry))
    }

    @Test
    fun `T3b - the rollback commit fails too - the cache keeps the stored tuple and the next load retries`() {
        seedPrefs("gpt-6-astra")
        writeRuntime("gpt-6-astra")
        writeOverlay("grok-4.6", provider = "xai", auth = "api_key") // Node /provider xai
        mainProcess(seed = RuntimeState(provider = "openai", authType = "oauth", model = "gpt-6-astra"))
        // The prefs commit lands; then runtime_state.json fails, and from there storage fails
        // every prefs commit as well — the rollback's included.
        SafeFs.beforeMove = { _, target ->
            if (target.fileName.toString() == RuntimeStateFile.NAME) {
                prefs.failCommits = true
                throw IOException("injected runtime_state write failure")
            }
        }
        val anchor = LogCollector.logs.value.lastOrNull()
        val version0 = ConfigManager.configVersion.intValue
        try {
            ConfigManager.loadConfig(ctx)
        } finally {
            SafeFs.beforeMove = savedBeforeMove
            prefs.failCommits = false
        }
        assertEquals("the reconcile's own commit reached disk", "xai", prefs.disk["provider"])
        assertEquals("the cache holds the stored tuple (provider)", "openai", prefs.memory["provider"])
        assertEquals("(auth)", "oauth", prefs.memory["auth_type"])
        assertEquals("(model)", "gpt-6-astra", prefs.memory["model"])
        val warn = logsSince(anchor).single { it.message.startsWith("[Config] Reconcile: runtime_state.json not saved — ") }
        assertEquals(LogLevel.WARN, warn.level)
        assertTrue(warn.message, warn.message.contains("commit_ok=false"))
        assertEquals("no config-version bump", version0, ConfigManager.configVersion.intValue)
        assertEquals("no broadcast", 0, broadcastsSince(anchor))

        // Same process, next load: the cache differs from the overlay again, so it retries and
        // lands the overlay in both stores.
        assertEquals("xai", ConfigManager.loadConfig(ctx)!!.provider)
        assertEquals("xai", prefs.disk["provider"])
        assertEquals("api_key", prefs.disk["auth_type"])
        assertEquals("grok-4.6", prefs.disk["model"])
        assertEquals(ModelTuple("xai", "api_key", "grok-4.6"), RuntimeStateFile.readTuple(dir))
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
        // Another key written while the failed edit is in flight is kept as well.
        prefs.beforeNextCommit = { prefs.externalWrite("lastCustomModel_openai", "theirs") }
        prefs.failCommits = true
        assertFalse(MainPrefs.commitOrRestore(MainPrefs.edit(prefs).putString("agent_name", "Mine")))
        prefs.failCommits = false
        assertEquals("theirs", prefs.memory["lastCustomModel_openai"])
        assertEquals(null, prefs.memory["agent_name"])
    }

    @Test
    fun `commitOrRestore - a same-key same-value write in the failure window is the user's and survives`() {
        // CodeRabbit on ca06bb79: the failed edit writes auto_start=true; the user's Auto-start
        // toggle writes auto_start=true right after the failure, before the restore. The two are
        // indistinguishable by value, so only serialising the writer against the restore keeps it.
        mainProcess()
        seedPrefs("gpt-6-astra")
        prefs.seed("auto_start" to false)
        val writer = MainPrefs.forWrite(ctx, "test.autoStart")!!
        var user: Thread? = null
        prefs.afterNextFailedCommit = {
            prefs.failCommits = false
            user = thread { writer.edit().putBoolean("auto_start", true).apply() }
            user!!.join(300) // unguarded, it lands now — inside the window
        }
        prefs.failCommits = true
        assertFalse(MainPrefs.commitOrRestore(MainPrefs.edit(writer).putBoolean("auto_start", true)))
        user!!.join(5_000)
        assertFalse("the user's writer finished", user!!.isAlive)
        assertEquals("the user's toggle survives the restore (cache)", true, prefs.memory["auto_start"])
        assertEquals("and on disk", true, prefs.disk["auto_start"])
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

    // ---------------------------------- Codex Q15 (58e426b6 / dd73a0e2): metadata-only overlays

    private fun corruptOverlay() = AgentSettingsFile.path(dir).toFile().writeText("{not json")

    private fun planNow() {
        nodeProcess()
        ModelSelectionLock.transaction { tx -> ModelRepair.plan(tx, dir, ConfigManager.modelSnapshot(ctx)) }
        assertEquals(ModelRepair.STATE_PENDING, intent()?.state)
    }

    private fun heartbeatSave() {
        mainProcess(seed = RuntimeState(provider = "openai", authType = "oauth", model = "gpt-5.4"))
        assertTrue(save(form(ModelTuple("openai", "oauth", "gpt-5.4")) { it.copy(heartbeatIntervalMinutes = 45) }))
        assertEquals("the save recovered the file", "45", overlayInt("heartbeatIntervalMinutes"))
        assertEquals("with no selection keys", null, overlayModel())
    }

    @Test
    fun `Q15 repro 1 - unreadable-at-decision overlay, unrelated save, then boot and MAIN converge`() {
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        corruptOverlay()
        planNow()
        val pending = intent()!!
        assertEquals(ModelRepair.OutsideOverlay.UNREADABLE, pending.overlayOutside?.state)
        heartbeatSave()
        assertEquals("intent kept", pending, intent())
        assertTrue("still Pending, not Superseded: ${classify()}", classify() is ModelRepair.IntentClass.Pending)
        nodeProcess()
        serviceStart()
        assertEquals("gpt-6.1-sol", runtimeModel())
        assertMainLoadConverges(retired = "gpt-5.4", target = "gpt-6.1-sol")
    }

    @Test
    fun `Q15 repro 2 - participating overlay lost, unrelated save - EvidenceLost, boot repairs, MAIN converges`() {
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        writeOverlay("gpt-5.4")
        planNow()
        val pending = intent()!!
        assertEquals("gpt-5.4", pending.overlay?.model)
        corruptOverlay()
        heartbeatSave()
        assertEquals("intent kept", pending, intent())
        assertTrue("EvidenceLost, not Superseded: ${classify()}", classify() is ModelRepair.IntentClass.EvidenceLost)
        nodeProcess()
        serviceStart()
        assertEquals("gpt-6.1-sol", runtimeModel())
        assertEquals("the overlay gets the target back", "gpt-6.1-sol", overlayModel())
        assertEquals("its other keys kept", "45", overlayInt("heartbeatIntervalMinutes"))
        assertMainLoadConverges(retired = "gpt-5.4", target = "gpt-6.1-sol")
    }

    private fun afterModelLessSave(overlayText: String): ModelRepair.IntentClass? {
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        corruptOverlay()
        planNow()
        heartbeatSave()
        AgentSettingsFile.path(dir).toFile().writeText(overlayText)
        return classify()
    }

    @Test
    fun `Q15 counterexample - a real newer model choice still supersedes`() {
        val c = afterModelLessSave("""{"heartbeatIntervalMinutes":45,"provider":"openai","authType":"oauth","model":"gpt-6-astra"}""")
        assertTrue("$c", c is ModelRepair.IntentClass.Superseded)
    }

    @Test
    fun `Q15 counterexample - a real provider change still supersedes`() {
        val c = afterModelLessSave("""{"heartbeatIntervalMinutes":45,"provider":"xai","authType":"api_key","model":"grok-4.6"}""")
        assertTrue("$c", c is ModelRepair.IntentClass.Superseded)
    }

    @Test
    fun `Q15 raw keys - a supplied blank model is not excused`() {
        val c = afterModelLessSave("""{"heartbeatIntervalMinutes":45,"model":""}""")
        assertTrue("$c", c is ModelRepair.IntentClass.Superseded)
    }

    @Test
    fun `Q15 raw keys - a supplied auth with no provider or model is not excused`() {
        val c = afterModelLessSave("""{"heartbeatIntervalMinutes":45,"authType":"api_key"}""")
        assertTrue("$c", c is ModelRepair.IntentClass.Superseded)
    }

    @Test
    fun `Q15 raw keys - a captured participating model lost to a supplied blank model still supersedes`() {
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        writeOverlay("gpt-5.4")
        planNow()
        mainProcess()
        AgentSettingsFile.path(dir).toFile().writeText("""{"heartbeatIntervalMinutes":45,"model":"  "}""")
        assertTrue("${classify()}", classify() is ModelRepair.IntentClass.Superseded)
    }

    // ----------------------------- Codex Q8 (58e426b6): no intent - seed overlay, then prefs

    @Test
    fun `Q8 - runtime_state missing, off-list applicable overlay - seed, MAIN load and boot keep it`() {
        seedPrefs("gpt-6-astra")
        writeOverlay("gpt-6.9-preview") // a working off-list choice (Settings > Custom model)
        mainProcess()
        assertTrue(seedNow())
        assertEquals("seeded from the overlay", ModelTuple("openai", "oauth", "gpt-6.9-preview"), RuntimeStateFile.readTuple(dir))
        assertEquals("the MAIN load keeps it (not clamped)", "gpt-6.9-preview", ConfigManager.loadConfig(ctx)!!.model)
        assertEquals("gpt-6.9-preview", prefs.disk["model"])
        assertEquals("gpt-6.9-preview", overlayModel())
        nodeProcess()
        assertEquals("the boot keeps it", "gpt-6.9-preview", serviceStart().model)
        assertEquals("gpt-6.9-preview", runtimeModel())
    }

    @Test
    fun `Q8 - a foreign, model-less or unreadable overlay falls back to prefs`() {
        seedPrefs("gpt-6-astra")
        mainProcess()
        for (text in listOf(
            """{"provider":"xai","authType":"api_key","model":"grok-4.6"}""",
            """{"provider":"openai","authType":"api_key","model":"gpt-6.9-preview"}""",
            """{"heartbeatIntervalMinutes":30}""",
            "{not json",
        )) {
            Files.deleteIfExists(runtimePath())
            AgentSettingsFile.path(dir).toFile().writeText(text)
            assertTrue(seedNow())
            assertEquals(text, ModelTuple("openai", "oauth", "gpt-6-astra"), RuntimeStateFile.readTuple(dir))
        }
    }

    @Test
    fun `Q8 - a provider-only overlay falls back to prefs, a model-only overlay is applicable`() {
        seedPrefs("gpt-6-astra")
        mainProcess()
        AgentSettingsFile.path(dir).toFile().writeText("""{"provider":"openai"}""")
        assertTrue(seedNow())
        assertEquals("provider only: prefs' model", ModelTuple("openai", "oauth", "gpt-6-astra"), RuntimeStateFile.readTuple(dir))
        Files.delete(runtimePath())
        AgentSettingsFile.path(dir).toFile().writeText("""{"model":"gpt-6.9-preview"}""")
        assertTrue(seedNow())
        assertEquals("model only: applicable", ModelTuple("openai", "oauth", "gpt-6.9-preview"), RuntimeStateFile.readTuple(dir))
    }

    @Test
    fun `Q8 + H5 - the overlay's model with the H5 auth for xAI oauth with no token`() {
        xaiUser(runtimeAuth = null)
        writeOverlay("grok-4.5", provider = "xai", auth = "oauth")
        assertTrue(seedNow())
        assertEquals(ModelTuple("xai", "api_key", "grok-4.5"), RuntimeStateFile.readTuple(dir))
    }

    @Test
    fun `Q12 through the real producer - a Settings OAuth selection flips the overlay, boot and mirror keep oauth`() {
        // The user was on xAI API key everywhere; then selects xAI OAuth in Settings (not signed in yet).
        prefs.seed("setup_complete" to true, "provider" to "xai", "auth_type" to "api_key", "model" to "grok-4.6")
        writeOverlay("grok-4.6", provider = "xai", auth = "api_key")
        writeRuntime("grok-4.6", provider = "xai", auth = "api_key")
        File(dir.toFile(), "xai_oauth.migrated").createNewFile()
        CrossProcessStore(dir.toFile(), XaiOAuthTokenStore.FILE_NAME, XaiOAuthTokens.serializer(), XaiOAuthTokens()).write(XaiOAuthTokens())
        XaiOAuthTokenStore.initForTest(dir.toFile())
        mainProcess()
        assertTrue(save(form(ModelTuple("xai", "api_key", "grok-4.6")) { it.copy(authType = "oauth") }))
        assertEquals("the producer publishes the SELECTED auth to the overlay", "oauth", overlayInt("authType"))
        assertEquals("runtime_state holds the H5 guard image", "api_key", RuntimeStateFile.readTuple(dir)?.authType)
        val r = ModelSelectionLock.transaction { tx -> RuntimeStateStore.mirrorFromDisk(tx, prefs) }
        assertEquals(ModelSelectionLock.Result.Acquired(false), r)
        assertEquals("the mirror keeps oauth", "oauth", prefs.disk["auth_type"])
        nodeProcess()
        assertEquals("the boot keeps oauth", "oauth", serviceStart().authType)
    }

    @Test
    fun `display - an undecryptable stored key is no key, as for Node - both views show the oauth read rule's default`() {
        // Codex 7ec40d8b #1 (inverts the aefe5f82 pin): config.json carries no key that did not decrypt,
        // so Node boots reconnect-required and serves the default (model-dispatch-parity display rows).
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        prefs.seed("openai_api_key_enc" to "c2VhbGVk") // stored, but it does not decrypt on the JVM
        mainProcess()
        assertTrue(ConfigManager.signOutOpenAI(ctx)) // no usable sign-in
        val cfg = ConfigManager.loadConfig(ctx)!!
        assertEquals("the key does not decrypt here", "", cfg.openaiApiKey)
        RuntimeStateStore.onObserved(RuntimeState(provider = "openai", authType = "oauth", model = "gpt-5.4"), prefs)
        assertEquals("projection: reconnect-required, the default", "gpt-6.1-sol", RuntimeStateStore.read().model)
        assertEquals("Settings agrees with the projection", RuntimeStateStore.read().model, cfg.displayModel)
    }

    // ------------- Codex 7ec40d8b #2: a captured model-less overlay never excuses a supplied selection

    private val metadataOnly = """{"heartbeatIntervalMinutes":30,"maxStepsPerTurn":35,"apiKeys":{}}"""

    private fun capturedModelLess() {
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        AgentSettingsFile.path(dir).toFile().writeText(metadataOnly)
        planNow()
        val cap = intent()!!.overlay!!
        assertTrue("captured present", cap.present)
        assertEquals("captured model-less", null, cap.model)
    }

    @Test
    fun `7ec40d8b #2 - captured model-less, then an auth-only, blank or non-string model is a newer selection`() {
        for (now in listOf(
            """{"heartbeatIntervalMinutes":30,"authType":"api_key"}""",
            """{"heartbeatIntervalMinutes":30,"model":""}""",
            """{"heartbeatIntervalMinutes":30,"model":7}""",
        )) {
            Files.deleteIfExists(ModelRepair.intentPath(dir))
            capturedModelLess()
            mainProcess()
            AgentSettingsFile.path(dir).toFile().writeText(now)
            assertTrue("$now: ${classify()}", classify() is ModelRepair.IntentClass.Superseded)
        }
    }

    @Test
    fun `7ec40d8b #2 - captured model-less, unchanged model-less - still Pending, the boot repairs`() {
        capturedModelLess()
        mainProcess()
        AgentSettingsFile.path(dir).toFile().writeText("""{"heartbeatIntervalMinutes":45,"maxStepsPerTurn":35,"apiKeys":{}}""")
        assertTrue("${classify()}", classify() is ModelRepair.IntentClass.Pending)
        nodeProcess()
        serviceStart()
        assertEquals("gpt-6.1-sol", runtimeModel())
        assertEquals("gpt-6.1-sol", overlayModel())
    }

    @Test
    fun `7ec40d8b #2 - captured model-less, then an auth change - MAIN adopts it and the next boot does not repair over it`() {
        capturedModelLess()
        mainProcess()
        AgentSettingsFile.path(dir).toFile().writeText("""{"heartbeatIntervalMinutes":30,"authType":"api_key"}""")
        ConfigManager.loadConfig(ctx)
        assertEquals("the stale repair record is dropped", null, intent())
        assertEquals("the auth change is adopted", "api_key", prefs.disk["auth_type"])
        assertEquals("api_key", RuntimeStateFile.readTuple(dir)?.authType)
        nodeProcess()
        val boot = serviceStart()
        assertEquals("the boot runs the newer selection", "api_key", boot.authType)
        assertEquals("and makes no repair over it", null, intent())
    }

    // ------------- Codex 7ec40d8b (Q8): an overlay with another auth is not merged into the prefs tuple

    @Test
    fun `Q8 - an overlay with an explicit other auth - seed keeps the prefs tuple, MAIN load and boot take the change`() {
        seedPrefs("gpt-6-astra") // openai / oauth
        writeOverlay("gpt-6.1-sol", provider = "openai", auth = "api_key")
        mainProcess()
        assertTrue(seedNow())
        assertEquals("not merged into the oauth tuple", ModelTuple("openai", "oauth", "gpt-6-astra"), RuntimeStateFile.readTuple(dir))
        val loaded = ConfigManager.loadConfig(ctx)!!
        assertEquals("an ordinary reconcile: the auth change lands", "api_key", loaded.authType)
        assertEquals("api_key", prefs.disk["auth_type"])
        assertEquals(ModelTuple("openai", "api_key", "gpt-6.1-sol"), RuntimeStateFile.readTuple(dir))
        nodeProcess()
        val boot = serviceStart()
        assertEquals("api_key", boot.authType)
        assertEquals("gpt-6.1-sol", boot.model)
    }

    // ------------------------------------------------------------- CodeRabbit on aefe5f82

    @Test
    fun `CR aefe5f82 #3 - an invalid prefs pair keeps the full default - never the default provider with an overlay model`() {
        prefs.seed("setup_complete" to true, "provider" to "claude", "auth_type" to "oauth", "model" to "claude-opus-5-5")
        AgentSettingsFile.path(dir).toFile().writeText("""{"model":"gpt-6.9-preview"}""")
        mainProcess()
        assertTrue(seedNow())
        val d = RuntimeState()
        assertEquals(ModelTuple(d.provider, d.authType, d.model), RuntimeStateFile.readTuple(dir))
    }

    @Test
    fun `CR aefe5f82 #4 - the projection uses the load's sign-in resolution - legacy pair only with no record and no marker`() {
        seedPrefs("gpt-5.4")
        mainProcess()
        RuntimeStateStore.noteOpenAIKeyUsable(true) // a usable API key is saved
        // No record, no marker: #466's legacy pair is what config.json carries — a usable sign-in.
        OpenAIOAuthTokenStore.resetForTest()
        val tokDir = tmp.newFolder("tok")
        OpenAIOAuthTokenStore.initForTest(tokDir, testCodec)
        prefs.seed("openai_oauth_token_enc" to "sealed:legacy-access")
        val rec = RuntimeState(provider = "openai", authType = "oauth", model = "gpt-5.4")
        RuntimeStateStore.onObserved(rec, prefs)
        assertEquals("legacy sign-in: oauth, the default (as AppConfig shows it)", "gpt-6.1-sol", RuntimeStateStore.read().model)
        assertEquals(form(ModelTuple("openai", "oauth", "gpt-5.4")) { it.copy(openaiOAuthToken = "legacy-access", openaiApiKey = "sk") }.displayModel,
            RuntimeStateStore.read().model)
        // A migration marker (a completed or signed-out family): the legacy pair is never used.
        File(tokDir, OpenAIOAuthTokenStore.MARKER_NAME).createNewFile()
        RuntimeStateStore.refreshDisplay()
        assertEquals("no sign-in: the api_key fallback", "gpt-5.4", RuntimeStateStore.read().model)
    }

    @Test
    fun `CR aefe5f82 #5 - a projection computed before a credential change is never stored over it`() {
        seedPrefs("gpt-5.4")
        mainProcess()
        RuntimeStateStore.noteOpenAIKeyUsable(true)
        // The collector projects with the sign-in usable (the default); before it stores, a sign-out lands.
        RuntimeStateStore.beforeDisplayStoreForTest = {
            RuntimeStateStore.beforeDisplayStoreForTest = null // once
            assertTrue(ConfigManager.signOutOpenAI(ctx))
        }
        RuntimeStateStore.onObserved(RuntimeState(provider = "openai", authType = "oauth", model = "gpt-5.4"), prefs)
        assertEquals("the post-sign-out projection wins (api_key fallback)", "gpt-5.4", RuntimeStateStore.read().model)
    }

    // ---------------------------------------------------------------- CodeRabbit on 3240d3c9

    @Test
    fun `projection - credentials change during every attempt - nothing stale is stored, the latest record and credentials win`() {
        seedPrefs("gpt-5.4")
        mainProcess()
        assertTrue(ConfigManager.signOutOpenAI(ctx)) // the key flag decides the transport now
        RuntimeStateStore.noteOpenAIKeyUsable(true)
        RuntimeStateStore.onObserved(RuntimeState(provider = "openai", authType = "oauth", model = "gpt-6-astra"), prefs)
        var changes = 0
        RuntimeStateStore.beforeDisplayStoreForTest = {
            changes++
            RuntimeStateStore.noteOpenAIKeyUsable(changes % 2 == 0) // a credential change on EVERY attempt
        }
        try {
            RuntimeStateStore.onObserved(RuntimeState(provider = "openai", authType = "oauth", model = "gpt-5.4"), prefs)
        } finally {
            RuntimeStateStore.beforeDisplayStoreForTest = null
        }
        assertEquals("all three attempts were invalidated", 3, changes)
        // After three changes the key is unusable: reconnect-required, so the read rule's default —
        // for the NEW record (5.4 stored), not a stale attempt's api_key projection of it.
        assertEquals("gpt-6.1-sol", RuntimeStateStore.read().model)
        RuntimeStateStore.noteOpenAIKeyUsable(true)
        assertEquals("the remembered record is the newest one", "gpt-5.4", RuntimeStateStore.read().model)
    }

    @Test
    fun `save, emit and display agree - a key Kotlin drops as blank (U+001C) is no key on the display either`() {
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        writeOverlay("gpt-5.4")
        prefs.seed("openai_api_key_enc" to "sealed:sk-old")
        mainProcess()
        RuntimeStateStore.noteOpenAIKeyUsable(true)
        assertTrue(ConfigManager.signOutOpenAI(ctx))
        RuntimeStateStore.onObserved(RuntimeState(provider = "openai", authType = "oauth", model = "gpt-5.4"), prefs)
        assertEquals("api-key fallback", "gpt-5.4", RuntimeStateStore.read().model)
        val key = "\u001C  "
        assertTrue(save(form(ModelTuple("openai", "oauth", "gpt-5.4")) { it.copy(openaiApiKey = key) }))
        // The real save dropped it (keepsSecret), so emitConfigJson omits it (the same predicate) and
        // Node has no key: reconnect-required, the default.
        assertEquals("the save removed the key", null, prefs.disk["openai_api_key_enc"])
        assertFalse("emitConfigJson's rule omits it", ConfigManager.keepsSecret(key))
        assertTrue("though config.js alone would keep it", ConfigManager.isNodeUsableSecret(key))
        assertEquals("the projection agrees with Node", "gpt-6.1-sol", RuntimeStateStore.read().model)
        assertEquals("and so does Settings", "gpt-6.1-sol",
            form(ModelTuple("openai", "oauth", "gpt-5.4")) { it.copy(openaiOAuthToken = "", openaiApiKey = key) }.displayModel)
    }

    @Test
    fun `key flag - a check superseded by a newer note is dropped`() {
        seedPrefs("gpt-5.4")
        mainProcess()
        assertTrue(ConfigManager.signOutOpenAI(ctx))
        RuntimeStateStore.noteOpenAIKeyUsable(false)
        RuntimeStateStore.onObserved(RuntimeState(provider = "openai", authType = "oauth", model = "gpt-5.4"), prefs)
        // A check reads "no key"; before it publishes, a save that installed a usable key notes it.
        RuntimeStateStore.rederiveOpenAIKeyUsable {
            RuntimeStateStore.noteOpenAIKeyUsable(true)
            false
        }
        assertEquals("the newer note wins: the api_key fallback", "gpt-5.4", RuntimeStateStore.read().model)
    }

    // ---------------------------------------------------------------- review of round 8

    @Test
    fun `key flag - a FAILED save that removed the key re-derives it - the projection follows`() {
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        writeOverlay("gpt-5.4")
        prefs.seed("openai_api_key_enc" to "sealed:sk-old")
        mainProcess()
        RuntimeStateStore.noteOpenAIKeyUsable(true)
        assertTrue(ConfigManager.signOutOpenAI(ctx))
        RuntimeStateStore.onObserved(RuntimeState(provider = "openai", authType = "oauth", model = "gpt-5.4"), prefs)
        assertEquals("api-key fallback", "gpt-5.4", RuntimeStateStore.read().model)
        // The key is removed in an unrelated save whose overlay write then fails: the prefs commit
        // landed (the key is gone), the save reports false.
        SafeFs.beforeMove = { _, target -> if (target.fileName.toString() == AgentSettingsFile.NAME) throw IOException("injected") }
        val ok = try {
            save(form(ModelTuple("openai", "oauth", "gpt-5.4")) { it.copy(openaiApiKey = "", heartbeatIntervalMinutes = 45) })
        } finally {
            SafeFs.beforeMove = savedBeforeMove
        }
        assertFalse(ok)
        assertEquals("the key is gone from prefs", null, prefs.disk["openai_api_key_enc"])
        assertEquals("the projection follows: reconnect, the default", "gpt-6.1-sol", RuntimeStateStore.read().model)
    }

    @Test
    fun `key flag - after Reset the projection no longer shows an API-key fallback`() {
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        prefs.seed("openai_api_key_enc" to "sealed:sk-old")
        mainProcess()
        RuntimeStateStore.noteOpenAIKeyUsable(true)
        assertTrue(ConfigManager.signOutOpenAI(ctx))
        RuntimeStateStore.onObserved(RuntimeState(provider = "openai", authType = "oauth", model = "gpt-5.4"), prefs)
        assertEquals("gpt-5.4", RuntimeStateStore.read().model)
        ConfigManager.resetConfig(ctx)
        assertEquals("no key after Reset: the default", "gpt-6.1-sol", RuntimeStateStore.read().model)
    }

    @Test
    fun `mirror - a guard image is never paired with another provider's prefs selection`() {
        prefs.seed("setup_complete" to true, "provider" to "claude", "auth_type" to "setup_token", "model" to "claude-opus-5-5")
        writeOverlay("grok-4.6", provider = "xai", auth = "oauth") // a fresh xai/oauth overlay
        writeRuntime("grok-4.6", provider = "xai", auth = "api_key")
        mainProcess()
        val r = ModelSelectionLock.transaction { tx -> RuntimeStateStore.mirrorFromDisk(tx, prefs) }
        assertEquals(ModelSelectionLock.Result.Acquired(true), r)
        assertEquals("xai", prefs.disk["provider"])
        assertEquals("the record's own auth, never claude's setup_token", "api_key", prefs.disk["auth_type"])
    }

    @Test
    fun `decision record (Codex 7ec40d8b fold 2, superseded by CodeRabbit on 3240d3c9) - an unchanged captured provider-only overlay stays Pending`() {
        // Round 9 pinned the accepted side effect (Superseded). The intent now captures the raw
        // selection keys, so an UNCHANGED provider-only overlay is recognised as unchanged.
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        AgentSettingsFile.path(dir).toFile().writeText("""{"heartbeatIntervalMinutes":30,"provider":"openai","authType":"oauth"}""")
        planNow()
        val cap = intent()!!.overlay!!
        assertEquals("captured with no model", null, cap.model)
        assertEquals(mapOf("provider" to "\"openai\"", "authType" to "\"oauth\""), cap.selection)
        mainProcess()
        assertTrue("${classify()}", classify() is ModelRepair.IntentClass.Pending)
        // A newly added or changed raw key is still a newer selection.
        AgentSettingsFile.path(dir).toFile().writeText("""{"heartbeatIntervalMinutes":30,"provider":"openai","authType":"api_key"}""")
        assertTrue("${classify()}", classify() is ModelRepair.IntentClass.Superseded)
        AgentSettingsFile.path(dir).toFile().writeText("""{"heartbeatIntervalMinutes":30,"provider":"openai","authType":"oauth","model":""}""")
        assertTrue("${classify()}", classify() is ModelRepair.IntentClass.Superseded)
    }

    @Test
    fun `CR 3240d3c9 #1 - repair, then the overlay write fails - the next boot resumes and confirms the handoff`() {
        seedPrefs("gpt-6-astra") // the retired id is only in runtime_state
        writeRuntime("gpt-5.4")
        AgentSettingsFile.path(dir).toFile().writeText("""{"heartbeatIntervalMinutes":30,"provider":"openai","authType":"oauth"}""")
        nodeProcess()
        SafeFs.beforeMove = { _, target -> if (target.fileName.toString() == AgentSettingsFile.NAME) throw IOException("injected overlay write failure") }
        try {
            serviceStart()
        } finally {
            SafeFs.beforeMove = savedBeforeMove
        }
        assertEquals("runtime_state took the target", "gpt-6.1-sol", runtimeModel())
        assertEquals("the repair stays pending", ModelRepair.STATE_PENDING, intent()?.state)
        val anchor = LogCollector.logs.value.lastOrNull()
        serviceStart()
        assertEquals("the next boot resumed and handed off", ModelRepair.STATE_AWAITING_MAIN, intent()?.state)
        assertEquals("gpt-6.1-sol", overlayModel())
        assertTrue(logsSince(anchor).any { it.message.contains("is not available with ChatGPT sign-in — now gpt-6.1-sol") })
    }

    // ------------- CodeRabbit on ab6385bd (CR2): a reconcile retry across a COLD restart — Codex question

    @Test
    fun `CR2 KNOWN GAP pending Codex - runtime write and rollback both failed, then a cold restart - not retried`() {
        // Documents today's behaviour (decision pending with Codex: write runtime_state before the
        // prefs commit, or a durable marker). Prefs and the overlay agree on xai on disk, so a cold
        // load does not reconcile, and runtime_state — which Node reads first — stays on openai.
        // When the gap is closed this test must be inverted, not deleted.
        seedPrefs("gpt-6-astra")
        writeRuntime("gpt-6-astra")
        writeOverlay("grok-4.6", provider = "xai", auth = "api_key")
        mainProcess(seed = RuntimeState(provider = "openai", authType = "oauth", model = "gpt-6-astra"))
        SafeFs.beforeMove = { _, target ->
            if (target.fileName.toString() == RuntimeStateFile.NAME) {
                prefs.failCommits = true
                throw IOException("injected runtime_state write failure")
            }
        }
        try {
            ConfigManager.loadConfig(ctx)
        } finally {
            SafeFs.beforeMove = savedBeforeMove
            prefs.failCommits = false
        }
        prefs.restartProcess() // MAIN exits; the next process reads the disk
        mainProcess(seed = RuntimeState(provider = "xai", authType = "api_key", model = "grok-4.6"))
        ConfigManager.loadConfig(ctx)
        assertEquals("xai", prefs.disk["provider"])
        assertEquals("KNOWN GAP: runtime_state not retried", "openai", RuntimeStateFile.readTuple(dir)?.provider)
    }

    // ------------------- Codex review of ca06bb79 #4: the display follows the effective transport

    @Test
    fun `display - AppConfig shows the model the transport sends`() {
        val stored = ModelTuple("openai", "oauth", "gpt-5.4")
        assertEquals("usable sign-in: the default", "gpt-6.1-sol", form(stored).displayModel)
        assertEquals("no sign-in, usable key: api_key keeps 5.4", "gpt-5.4",
            form(stored) { it.copy(openaiOAuthToken = "", openaiApiKey = "sk-test") }.displayModel)
        assertEquals("no sign-in, a key Node normalises to empty: reconnect, the default", "gpt-6.1-sol",
            form(stored) { it.copy(openaiOAuthToken = "", openaiApiKey = " \r\n ") }.displayModel)
        assertEquals("reconnect-required: oauth, the default", "gpt-6.1-sol",
            form(stored) { it.copy(openaiOAuthToken = "", openaiApiKey = "") }.displayModel)
        assertEquals("stored model never changes", "gpt-5.4", form(stored) { it.copy(openaiOAuthToken = "") }.model)
    }

    @Test
    fun `display - the RuntimeState projection uses credentials and refreshes when they change`() {
        seedPrefs("gpt-5.4")
        mainProcess()
        val rec = RuntimeState(provider = "openai", authType = "oauth", model = "gpt-5.4")
        RuntimeStateStore.onObserved(rec, prefs)
        assertEquals("usable sign-in", "gpt-6.1-sol", RuntimeStateStore.read().model)
        // A load or save that decrypted a usable key records it (no Keystore on the JVM to decrypt one).
        RuntimeStateStore.noteOpenAIKeyUsable(true)
        assertTrue(ConfigManager.signOutOpenAI(ctx)) // no usable sign-in now; a usable key is saved
        assertEquals("api-key fallback shows 5.4 at once", "gpt-5.4", RuntimeStateStore.read().model)
        assertEquals("the selected auth is untouched", "oauth", RuntimeStateStore.read().authType)
        RuntimeStateStore.noteOpenAIKeyUsable(false) // the key no longer decrypts / was removed
        assertEquals("reconnect-required, re-projected at once", "gpt-6.1-sol", RuntimeStateStore.read().model)
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

        /** Runs once, right after the next commit() that FAILS, outside this fake's own lock. */
        @Volatile var afterNextFailedCommit: (() -> Unit)? = null

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

            override fun commit(): Boolean {
                val ok = commitLocked()
                if (!ok) afterNextFailedCommit?.let { hook -> afterNextFailedCommit = null; hook() }
                return ok
            }

            private fun commitLocked(): Boolean = synchronized(this@FakePrefs) {
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
