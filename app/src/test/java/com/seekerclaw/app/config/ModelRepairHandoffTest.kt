package com.seekerclaw.app.config

import com.seekerclaw.app.state.AgentPreferencesStore
import com.seekerclaw.app.state.OpenAIOAuthTokenStore
import com.seekerclaw.app.state.RuntimeState
import com.seekerclaw.app.state.RuntimeStateStore
import com.seekerclaw.app.state.XaiOAuthTokenStore
import com.seekerclaw.app.testing.PowerLossFs
import com.seekerclaw.app.testing.TwoProcessPrefs
import com.seekerclaw.app.util.CrossProcessStore
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogEntry
import com.seekerclaw.app.util.LogLevel
import com.seekerclaw.app.util.ProcessRole
import com.seekerclaw.app.util.SafeFs
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
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * BAT-1661 contract v2.7 §1, v2.8 – v2.10 (signed `8161bc04`): the handoff from `:node` to MAIN,
 * on the REAL paths — [ModelRepair.serviceStart] (the `:node` boot), [ConfigManager.loadConfig]
 * (MAIN's locked load), [ConfigManager.saveConfigWith], [ConfigManager.resetConfig] — against real
 * files and [TwoProcessPrefs]: `seekerclaw_prefs` with one cache per process, where a commit writes
 * that process's whole map, as Android does.
 *
 * Process roles: MAIN has [RuntimeStateStore] initialised and may write prefs; `:node` has neither.
 */
class ModelRepairHandoffTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var dir: Path
    private lateinit var tp: TwoProcessPrefs
    private val savedDirSync = SafeFs.dirSyncChecked
    private val savedBeforeMove = SafeFs.beforeMove

    private val sealer = SecretSealer { plain -> "sealed:$plain" }
    private val codec = object : SecretCodec {
        override fun seal(plain: String) = "sealed:$plain"
        override fun open(sealed: String) = sealed.removePrefix("sealed:")
    }

    private val main get() = tp.context("main")
    private val node get() = tp.context("node")

    @Before
    fun setUp() {
        dir = tmp.newFolder().toPath()
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
                    retiredForAuth = mapOf("oauth" to listOf("gpt-5.5", "gpt-5.4", "gpt-5.4-mini")),
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
            ),
        )
        RuntimeStateStore.resetForTest()
        AgentPreferencesStore.resetForTest()
        XaiOAuthTokenStore.resetForTest()
        OpenAIOAuthTokenStore.initForTest(dir.toFile(), codec)
        tp = TwoProcessPrefs(dir.toFile())
        MainPrefs.resetProcessStateForTest()
        ReconcileRecord.resetForTest()
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
        MainPrefs.resetProcessStateForTest()
        ReconcileRecord.resetForTest()
    }

    // ------------------------------------------------------------------------------ fixtures

    private fun signIn() {
        assertTrue(OpenAIOAuthTokenStore.signIn("access", "refresh", "", "") is OpenAIOAuthTokenStore.Result.Ok)
    }

    /** A configured OpenAI ChatGPT sign-in user (prefs on disk, before either process opens them). */
    private fun seedPrefs(model: String, vararg extra: Pair<String, Any?>) {
        tp.disk.putAll(mapOf("setup_complete" to true, "provider" to "openai", "auth_type" to "oauth", "model" to model))
        extra.forEach { (k, v) -> tp.disk[k] = v }
    }

    private fun writeRuntime(model: String, provider: String = "openai", auth: String = "oauth") {
        val s = RuntimeState(provider = provider, authType = auth, model = model, reasoningEnabled = true)
        CrossProcessStore(dir.toFile(), RuntimeStateFile.NAME, RuntimeState.serializer(), s).write(s)
    }

    private fun writeOverlay(model: String, provider: String = "openai", auth: String? = "oauth") {
        val a = if (auth != null) ""","authType":"$auth"""" else ""
        AgentSettingsFile.path(dir).toFile().writeText(
            """{"heartbeatIntervalMinutes":30,"provider":"$provider"$a,"model":"$model","apiKeys":{}}""",
        )
    }

    /** A foreign overlay as Node's `/provider` leaves it, with no authType (see the class KDoc). */
    private fun writeForeignOverlay() = writeOverlay("claude-opus-5", provider = "claude", auth = null)

    private val runtimePath get() = dir.resolve(RuntimeStateFile.NAME)
    private fun runtimeModel() = RuntimeStateFile.readTuple(dir)?.model
    private fun overlayField(k: String) =
        (AgentSettingsFile.read(dir) as? AgentSettingsFile.Read.Present)?.let { AgentSettingsFile.stringField(it.obj, k) }

    private fun intent() = (ModelRepair.readIntent(dir) as? ModelRepair.IntentRead.Present)?.intent
    private fun state() = intent()?.state
    private fun intentBytes(): ByteArray? = ModelRepair.intentPath(dir).toFile().takeIf { it.exists() }?.readBytes()

    private fun anchor(): LogEntry? = LogCollector.logs.value.lastOrNull()
    private fun logsSince(anchor: LogEntry?): List<LogEntry> {
        val all = LogCollector.logs.value
        return all.drop(if (anchor == null) 0 else all.indexOfFirst { it === anchor } + 1)
    }
    private fun notices(anchor: LogEntry?) = logsSince(anchor).count { it.message.contains("is not available with ChatGPT sign-in — now") }

    /** One `:node` service start in [ctx]'s process (its prefs cache as it is); the emitted config. */
    private fun nodeStart(ctx: android.content.Context = node): AppConfig {
        ProcessRole.setForTest(true)
        RuntimeStateStore.resetForTest()
        var emitted: AppConfig? = null
        val channel = ModelRepair.serviceStart(ctx) { cfg ->
            emitted = cfg
            "telegram"
        }
        assertEquals("the boot proceeds", "telegram", channel)
        return emitted!!
    }

    /** One MAIN locked load. */
    private fun mainLoad(): AppConfig {
        ProcessRole.setForTest(false)
        if (!RuntimeStateStore.isInitialized) RuntimeStateStore.initWithStoreForTest(dir.toFile())
        return ConfigManager.loadConfig(main)!!
    }

    private fun mainSave(loaded: ModelTuple, edit: (AppConfig) -> AppConfig): Boolean {
        ProcessRole.setForTest(false)
        if (!RuntimeStateStore.isInitialized) RuntimeStateStore.initWithStoreForTest(dir.toFile())
        val cfg = edit(
            AppConfig(
                anthropicApiKey = "",
                telegramBotToken = "bot",
                telegramOwnerId = "1",
                agentName = "MyAgent",
                provider = loaded.provider,
                authType = loaded.authType,
                model = loaded.model,
                openaiOAuthToken = "access",
                loadedModelTuple = loaded,
            ),
        )
        return ConfigManager.saveConfigWith(main, cfg, ModelSelectionLock.LOCK_TIMEOUT_MS, sealer)
    }

    // ------------------------------------------- v2.8 pin 2 + v2.10 §1 pin 1 + clarification 2

    @Test
    fun `v2_8 pin 2, v2_10 §1 pin 1, binding clarification 2 - no runtime_state, a foreign overlay, prefs retired`() {
        signIn()
        seedPrefs("gpt-5.4")
        writeForeignOverlay()
        val a = anchor()

        val c1 = nodeStart()
        assertEquals("config.json carries the target", "gpt-6.1-sol", c1.model)
        assertEquals("in the selected scope", "openai", c1.provider)
        assertEquals("boot 1 writes runtime_state on the target (checked)", "gpt-6.1-sol", runtimeModel())
        assertEquals(ModelRepair.STATE_AWAITING_MAIN, state())
        assertEquals("the real publisher keeps the foreign overlay's tuple", "claude", overlayField("provider"))
        assertEquals("claude-opus-5", overlayField("model"))
        assertNull("no authType published into it", overlayField("authType"))

        val rt = Files.readAllBytes(runtimePath)
        val ib = intentBytes()
        repeat(2) { n ->
            val c = nodeStart()
            assertEquals("boot ${n + 2}: config.json", "gpt-6.1-sol", c.model)
            assertArrayEquals("boot ${n + 2}: no model written to runtime_state", rt, Files.readAllBytes(runtimePath))
            assertArrayEquals("boot ${n + 2}: no intent written", ib, intentBytes())
            assertEquals("claude", overlayField("provider"))
            assertEquals("claude-opus-5", overlayField("model"))
        }
        // ... and across a `:node` process restart (a fresh prefs cache).
        tp.restart("node")
        nodeStart()
        assertArrayEquals(ib, intentBytes())
        assertEquals("claude-opus-5", overlayField("model"))
        assertEquals("one notice in total", 1, notices(a))
        assertFalse("neither cancelled nor reopened", logsSince(a).any { it.message.startsWith("[ModelRepair] pending repair cancelled") })

        mainLoad()
        assertEquals("a MAIN load brings prefs to the target", "gpt-6.1-sol", tp.disk["model"])
        assertEquals(ModelRepair.STATE_CONVERGED, state())
        assertEquals("claude-opus-5", overlayField("model"))
    }

    @Test
    fun `v2_8 pin 3 - boot 1's runtime_state write fails - pending, config_json carries the target, boot 2 finishes`() {
        signIn()
        seedPrefs("gpt-5.4")
        writeForeignOverlay()
        SafeFs.beforeMove = { _, target -> if (target.fileName.toString() == RuntimeStateFile.NAME) throw IOException("injected") }
        val a = anchor()
        val c1 = nodeStart()
        SafeFs.beforeMove = savedBeforeMove
        assertEquals("config.json carries the target", "gpt-6.1-sol", c1.model)
        assertEquals("the intent stays pending", ModelRepair.STATE_PENDING, state())
        assertNull(runtimeModel())
        assertEquals("no notice yet", 0, notices(a))

        nodeStart()
        assertEquals(ModelRepair.STATE_AWAITING_MAIN, state())
        assertEquals("gpt-6.1-sol", runtimeModel())
        assertEquals(1, notices(a))
    }

    // ------------------------------------------------------ v2.8 pin 4 and v2.9 pin 4

    @Test
    fun `v2_8 pin 4 - runtime_state deleted after the handoff, no overlay participating - rebuilt, never the retired id`() {
        signIn()
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        writeForeignOverlay()
        nodeStart()
        assertEquals(ModelRepair.STATE_AWAITING_MAIN, state())
        Files.delete(runtimePath)

        val a = anchor()
        val c = nodeStart()
        assertEquals("config.json never takes the retired prefs id", "gpt-6.1-sol", c.model)
        assertEquals("runtime_state rebuilt on the target", "gpt-6.1-sol", runtimeModel())
        assertEquals("the state is kept", ModelRepair.STATE_AWAITING_MAIN, state())
        assertEquals("no second notice", 0, notices(a))
        assertTrue(logsSince(a).any { it.message == "[ModelRepair] runtime_state rebuilt on gpt-6.1-sol (runtime_state missing)" })
        assertEquals("claude-opus-5", overlayField("model"))
    }

    @Test
    fun `v2_9 pin 4 - the captured runtime_state goes missing, overlay on the target - EvidenceLost, rebuilt, no second notice`() {
        signIn()
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        writeOverlay("gpt-5.4")
        nodeStart()
        mainLoad()
        assertEquals(ModelRepair.STATE_CONVERGED, state())
        Files.delete(runtimePath)
        tp.restart("node")

        val a = anchor()
        nodeStart()
        assertEquals("gpt-6.1-sol", runtimeModel())
        assertEquals("converged is kept", ModelRepair.STATE_CONVERGED, state())
        assertEquals(0, notices(a))
        assertEquals("gpt-6.1-sol", overlayField("model"))
        assertFalse("the retired id is published nowhere", listOf(runtimeModel(), overlayField("model")).contains("gpt-5.4"))
    }

    // ---------------------------------------- v2.8 pin 5 + v2.9 pin 8: a stale `:node` cache

    @Test
    fun `v2_8 pin 5 and v2_9 pin 8 - a stale node cache after MAIN converged - no new intent, no second notice`() {
        signIn()
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        writeOverlay("gpt-5.4")
        val a = anchor()
        nodeStart() // `:node` opens its prefs cache here: model gpt-5.4
        mainLoad()
        assertEquals(ModelRepair.STATE_CONVERGED, state())
        mainLoad() // MAIN loads again
        assertEquals("gpt-6.1-sol", tp.disk["model"])
        val ib = intentBytes()

        // The same, still-alive `:node` process starts the service again, from its old cache.
        assertEquals("the stale cache", "gpt-5.4", node.getSharedPreferences(PrefsNames.MAIN, 0).getString("model", null))
        nodeStart()
        nodeStart()
        assertEquals(ModelRepair.STATE_CONVERGED, state())
        assertArrayEquals("no new intent", ib, intentBytes())
        assertEquals("one notice in total", 1, notices(a))
        assertEquals("gpt-6.1-sol", tp.disk["model"])
    }

    // ------------------------------------------------------------------ v2.8 pin 6: Superseded

    @Test
    fun `v2_8 pin 6 - a Node model choice after the repair - MAIN syncs prefs to it, deletes the intent, never seeds the target`() {
        signIn()
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        writeOverlay("gpt-5.4")
        nodeStart()
        assertEquals(ModelRepair.STATE_AWAITING_MAIN, state())
        // Node /model gpt-6-astra (message-handler.js): the overlay, then runtime_state.
        writeOverlay("gpt-6-astra")
        writeRuntime("gpt-6-astra")

        val a = anchor()
        mainLoad()
        assertTrue(logsSince(a).any { it.message == "[ModelRepair] pending repair cancelled: runtime_state holds a newer model" })
        assertNull("deleted under the lock", intent())
        assertEquals("prefs follow the newer choice", "gpt-6-astra", tp.disk["model"])
        assertEquals("never seeded with the target", "gpt-6-astra", runtimeModel())
        assertEquals("gpt-6-astra", overlayField("model"))
    }

    // ------------------------------------------------- v2.8 pin 7: corrupt or unproven intents

    @Test
    fun `v2_8 pin 7 - a corrupt intent is never seeded - WARN, deleted, a fresh decision follows`() {
        signIn()
        seedPrefs("gpt-5.4")
        writeOverlay("gpt-5.4")
        ModelRepair.intentPath(dir).toFile().writeText("{not json")
        val a = anchor()
        mainLoad()
        assertTrue(logsSince(a).any { it.level == LogLevel.WARN && it.message.startsWith("[ModelRepair] repair intent unreadable (") })
        assertNull("deleted", intent())
        assertNull("nothing seeded", runtimeModel())
        assertEquals("prefs keep their evidence", "gpt-5.4", tp.disk["model"])
        nodeStart()
        assertEquals("the fresh decision's target", "gpt-6.1-sol", intent()?.target)
    }

    @Test
    fun `v2_8 pin 7 - a target that is not proven (a retired or a tampered id) is never seeded`() {
        for (bad in listOf("gpt-5.5", "gpt-6-astra", "not-a-model")) {
            setUp()
            signIn()
            seedPrefs("gpt-5.4")
            writeRuntime("gpt-5.4")
            writeOverlay("gpt-5.4")
            nodeStart()
            val good = intent()!!
            ModelRepair.writeIntent(dir, good.copy(target = bad))
            // The overlay holds the tampered id too (else it is a third value, Superseded first),
            // and runtime_state is gone, so MAIN would seed it from the intent.
            writeOverlay(bad)
            Files.delete(runtimePath)
            val a = anchor()
            mainLoad()
            assertTrue("$bad: ${logsSince(a).map { it.message }}", logsSince(a).any { it.message.startsWith("[ModelRepair] repair intent no longer proven") })
            assertFalse("$bad never seeded", runtimeModel() == bad)
            assertFalse("$bad never in prefs", tp.disk["model"] == bad)
            assertNull("$bad: deleted", intent())
            tearDown()
        }
    }

    // ------------------------------------------------- v2.8 pin 10: two caches, the publisher

    @Test
    fun `v2_8 pin 10 - two caches, the file publisher - node's cache holds A, MAIN saves B, every file ends on B`() {
        signIn()
        seedPrefs("gpt-6-astra")
        writeRuntime("gpt-6-astra")
        writeOverlay("gpt-6-astra")
        assertEquals("`:node` caches A", "gpt-6-astra", node.getSharedPreferences(PrefsNames.MAIN, 0).getString("model", null))
        mainLoad()
        assertTrue(mainSave(ModelTuple("openai", "oauth", "gpt-6-astra")) { it.copy(model = "gpt-6.1-sol") })
        assertEquals("gpt-6.1-sol", tp.disk["model"])

        val c = nodeStart()
        assertEquals("config.json", "gpt-6.1-sol", c.model)
        assertEquals("runtime_state", "gpt-6.1-sol", runtimeModel())
        assertEquals("overlay", "gpt-6.1-sol", overlayField("model"))
        assertEquals("prefs", "gpt-6.1-sol", tp.disk["model"])
        assertNull("nothing to repair", intent())
    }

    // ------------------------------------------- v2.8 pins 11–12, v2.9 pin 10: the transport

    @Test
    fun `v2_8 pin 11 - Node-first upgrade of a signed-in user - the sign-in migration runs before the snapshot`() {
        // The pre-BAT-1157 sign-in is still in the legacy prefs keys; the token store is empty.
        seedPrefs("gpt-5.4", "openai_oauth_token_enc" to "sealed:legacy-access", "openai_oauth_refresh_enc" to "sealed:legacy-refresh")
        writeRuntime("gpt-5.4")
        assertFalse(OpenAIOAuthTokenStore.hasUsableToken())
        val c = nodeStart()
        assertTrue("migrated", OpenAIOAuthTokenStore.hasUsableToken())
        assertEquals("decide() saw the oauth transport", ModelRepair.STATE_AWAITING_MAIN, state())
        assertEquals("gpt-6.1-sol", runtimeModel())
        assertEquals("gpt-6.1-sol", c.model)
    }

    @Test
    fun `v2_8 pin 12 - signed out with a saved key on a retired id - no repair, the selection kept, a new sign-in repairs`() {
        seedPrefs("gpt-5.4", "openai_api_key_enc" to "sealed:sk-key")
        writeRuntime("gpt-5.4")
        val rt = Files.readAllBytes(runtimePath)
        nodeStart()
        assertNull("no repair on the API-key fallback", intent())
        assertArrayEquals("runtime_state untouched", rt, Files.readAllBytes(runtimePath))
        assertEquals("selected auth kept", "oauth", RuntimeStateFile.readTuple(dir)?.authType)
        assertEquals("oauth", tp.disk["auth_type"])

        signIn()
        nodeStart()
        assertEquals("the next boot with a usable sign-in repairs", ModelRepair.STATE_AWAITING_MAIN, state())
        assertEquals("gpt-6.1-sol", runtimeModel())
        assertEquals("oauth", RuntimeStateFile.readTuple(dir)?.authType)
    }

    @Test
    fun `v2_9 pin 10 - awaiting_main survives a sign-out - boots, a new sign-in, a MAIN load - the target is kept`() {
        signIn()
        seedPrefs("gpt-5.4", "openai_api_key_enc" to "sealed:sk-key")
        writeRuntime("gpt-5.4")
        writeOverlay("gpt-5.4")
        nodeStart()
        assertEquals(ModelRepair.STATE_AWAITING_MAIN, state())

        assertTrue(OpenAIOAuthTokenStore.signOut() is OpenAIOAuthTokenStore.Result.Ok)
        repeat(2) { nodeStart() }
        assertEquals("the intent survives a sign-out", ModelRepair.STATE_AWAITING_MAIN, state())
        mainLoad()
        assertEquals("MAIN does not finalise without the sign-in transport", ModelRepair.STATE_AWAITING_MAIN, state())

        signIn()
        mainLoad()
        assertEquals(ModelRepair.STATE_CONVERGED, state())
        assertEquals("gpt-6.1-sol", tp.disk["model"])
        assertEquals("gpt-6.1-sol", runtimeModel())
        assertEquals("oauth", tp.disk["auth_type"])
    }

    // ----------------------------------------------------------------- v2.9 pins 1, 2, 6, 7

    @Test
    fun `v2_9 pin 1 - 5_6 all the way through - mixed state, repair, handoff, MAIN converges, again, and a restart`() {
        signIn()
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-6-astra")
        writeOverlay("gpt-5.6")
        assertEquals("5.6", "gpt-5.6", nodeStart().model)
        assertEquals(ModelRepair.STATE_AWAITING_MAIN, state())
        assertEquals("gpt-5.6", mainLoad().model)
        assertEquals(ModelRepair.STATE_CONVERGED, state())
        assertEquals("gpt-5.6", mainLoad().model)
        tp.restart("node")
        assertEquals("gpt-5.6", nodeStart().model)
        for ((what, v) in listOf("prefs" to tp.disk["model"], "runtime_state" to runtimeModel(), "overlay" to overlayField("model"))) {
            assertEquals("$what keeps the unlisted 5.6, never clamped", "gpt-5.6", v)
        }
        assertEquals(ModelRepair.STATE_CONVERGED, state())
    }

    @Test
    fun `v2_9 pin 2 - a partial first boot - boot 2 does not take Holds, it repairs, confirms and hands off`() {
        signIn()
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        writeOverlay("gpt-5.6") // the overlay is already on the target
        SafeFs.beforeMove = { _, target -> if (target.fileName.toString() == RuntimeStateFile.NAME) throw IOException("injected") }
        nodeStart()
        SafeFs.beforeMove = savedBeforeMove
        assertEquals(ModelRepair.STATE_PENDING, state())
        assertEquals("gpt-5.4", runtimeModel())

        val a = anchor()
        nodeStart()
        assertEquals("runtime_state on 5.6", "gpt-5.6", runtimeModel())
        assertEquals(ModelRepair.STATE_AWAITING_MAIN, state())
        assertEquals(1, notices(a))
        mainLoad()
        assertEquals(ModelRepair.STATE_CONVERGED, state())
        assertEquals("gpt-5.6", tp.disk["model"])
    }

    @Test
    fun `v2_9 pin 6 - the dispatch-file rewrite fails under the power-loss fake - pending, and a later handoff is durable`() {
        signIn()
        seedPrefs("gpt-5.4")
        writeForeignOverlay() // the dispatch file will be runtime_state
        val fs = PowerLossFs()
        fs.install()
        val powerLossHook = SafeFs.beforeMove
        try {
            // Boot 1: the sync fails from the runtime_state write on (the intent is already durable).
            SafeFs.beforeMove = { tmp, target ->
                powerLossHook(tmp, target)
                if (target.fileName.toString() == RuntimeStateFile.NAME) fs.syncFails = true
            }
            val a = anchor()
            nodeStart()
            assertEquals("the intent stays pending", ModelRepair.STATE_PENDING, state())
            assertEquals("no notice", 0, notices(a))
            assertEquals("visible", "gpt-6.1-sol", runtimeModel())
            assertFalse("not durable", fs.isDurable(runtimePath))

            // Boot 2: the sync works again. A re-sync alone would never make that rename durable.
            SafeFs.beforeMove = powerLossHook
            fs.syncFails = false
            nodeStart()
            assertEquals(ModelRepair.STATE_AWAITING_MAIN, state())
            fs.powerLoss()
            assertEquals("handed off", ModelRepair.STATE_AWAITING_MAIN, state())
            assertEquals("the dispatch file survives a power cut", "gpt-6.1-sol", runtimeModel())
        } finally {
            fs.uninstall()
            SafeFs.beforeMove = savedBeforeMove
            SafeFs.dirSyncChecked = {}
        }
    }

    @Test
    fun `v2_9 pin 7 - MAIN with runtime_state on another same-scope model - no convergence to it`() {
        signIn()
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        writeOverlay("gpt-5.4")
        nodeStart()
        val ib = intentBytes()

        // (a) runtime_state back on its captured value: not the target, so nothing is finalised.
        writeRuntime("gpt-5.4")
        mainLoad()
        assertArrayEquals("still awaiting_main, untouched", ib, intentBytes())
        assertEquals("prefs not moved to 5.4's runtime value or anywhere", "gpt-5.4", tp.disk["model"])

        // (b) a third value: Superseded, deleted, never marked converged.
        writeRuntime("gpt-6-astra")
        mainLoad()
        assertNull(intent())
        assertFalse(state() == ModelRepair.STATE_CONVERGED)
    }

    // ------------------------------------------------- v2.9 pin 9: a failed Settings-hook delete

    @Test
    fun `v2_9 pin 9 - a Settings choice whose intent delete failed - MAIN classifies Superseded and deletes`() {
        signIn()
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.4")
        writeOverlay("gpt-5.4")
        nodeStart()
        val record = intentBytes()!!
        assertTrue(mainSave(ModelTuple("openai", "oauth", "gpt-5.4")) { it.copy(model = "gpt-6-astra") })
        // The best-effort delete in cancelAfterSelection "failed": the record is still there.
        ModelRepair.intentPath(dir).toFile().writeBytes(record)
        val a = anchor()
        mainLoad()
        assertTrue(logsSince(a).any { it.message.startsWith("[ModelRepair] pending repair cancelled:") })
        assertNull(intent())
        assertEquals("gpt-6-astra", tp.disk["model"])
        assertEquals("gpt-6-astra", runtimeModel())
    }

    // ------------------------------------------------------------- v2.7 §1: `:node` reads only

    @Test
    fun `v2_7 §1 - MAIN saves B, then Node's provider reads credentials - prefs still hold B, runtime_state unchanged, no lock`() {
        signIn()
        seedPrefs("gpt-6-astra")
        writeRuntime("gpt-6-astra")
        writeOverlay("gpt-6-astra")
        node.getSharedPreferences(PrefsNames.MAIN, 0) // `:node` caches A before the save
        mainLoad()
        assertTrue(mainSave(ModelTuple("openai", "oauth", "gpt-6-astra")) { it.copy(model = "gpt-6.1-sol") })
        val rt = Files.readAllBytes(runtimePath)
        val writes = tp.diskWrites

        ProcessRole.setForTest(true)
        RuntimeStateStore.resetForTest()
        val entries = ModelSelectionLock.entriesForTest()
        val creds = ConfigManager.loadConfigReadOnly(node) // what /config/credentials runs
        assertNotNull(creds)
        assertEquals("the read-only load takes no lock", entries, ModelSelectionLock.entriesForTest())
        assertEquals("prefs still hold B", "gpt-6.1-sol", tp.disk["model"])
        assertEquals("no prefs write from `:node`", writes, tp.diskWrites)
        assertArrayEquals("runtime_state unchanged", rt, Files.readAllBytes(runtimePath))
    }

    @Test
    fun `v2_7 §1 - a node loadConfig never opens a model-selection transaction`() {
        signIn()
        seedPrefs("gpt-6-astra")
        ProcessRole.setForTest(true)
        val before = ModelSelectionLock.entriesForTest()
        ConfigManager.loadConfig(node)
        ConfigManager.loadConfigOrBootstrap(node)
        assertEquals(before, ModelSelectionLock.entriesForTest())
        // Control: MAIN's load does take it.
        ProcessRole.setForTest(false)
        RuntimeStateStore.initWithStoreForTest(dir.toFile())
        ConfigManager.loadConfig(main)
        assertTrue(ModelSelectionLock.entriesForTest() > before)
    }

    @Test
    fun `v2_7 §1 - the credentials endpoint uses the read-only load`() {
        val src = listOf("src/main/java", "app/src/main/java").map { File(it) }.first { it.isDirectory }
        val bridge = File(src, "com/seekerclaw/app/bridge/AndroidBridge.kt").readText()
        val body = bridge.substringAfter("private fun handleConfigCredentials(): Response {").substringBefore("\n    }\n")
        assertTrue(body.contains("ConfigManager.loadConfigReadOnly(context)"))
        assertFalse(body.contains("ConfigManager.loadConfig(context)"))
    }

    // ------------------------------------------------------------- v2.8 §4: Reset Config

    @Test
    fun `v2_8 §4 - Reset Config with the model lock busy - Failed, nothing reset`() {
        signIn()
        seedPrefs("gpt-6-astra")
        ProcessRole.setForTest(false)
        val held = CountDownLatch(1)
        val release = CountDownLatch(1)
        val holder = thread {
            ModelSelectionLock.transaction { _ ->
                held.countDown()
                release.await(10, TimeUnit.SECONDS)
            }
        }
        assertTrue(held.await(5, TimeUnit.SECONDS))
        val r = try {
            ConfigManager.resetConfig(main)
        } finally {
            release.countDown()
            holder.join(5_000)
        }
        assertEquals(ConfigManager.ResetResult.Failed(ConfigManager.RESET_MODEL_BUSY), r)
        assertTrue("the sign-in is not tombstoned", OpenAIOAuthTokenStore.hasUsableToken())
        assertEquals("prefs intact", "gpt-6-astra", tp.disk["model"])
    }

    @Test
    fun `v2_8 §4 - Reset Config holds the model lock while it tombstones - a model transaction cannot interleave`() {
        signIn()
        seedPrefs("gpt-6-astra")
        ProcessRole.setForTest(false)
        var during: ModelSelectionLock.Result<Unit>? = null
        SafeFs.beforeMove = { _, target ->
            if (during == null && target.fileName.toString() == OpenAIOAuthTokenStore.FILE_NAME) {
                // Another thread (a Settings save, the collector mirror) tries a model transaction.
                var r: ModelSelectionLock.Result<Unit>? = null
                thread { r = ModelSelectionLock.transaction(100) { _ -> } }.join(5_000)
                during = r
            }
        }
        ConfigManager.resetConfig(main)
        SafeFs.beforeMove = savedBeforeMove
        assertTrue("the tombstone ran under the model lock: $during", during is ModelSelectionLock.Result.Busy)
        assertTrue("released afterwards", ModelSelectionLock.transaction(100) { _ -> } is ModelSelectionLock.Result.Acquired)
    }

    @Test
    fun `v2_8 §4 - lock order in source - the model lock before the OpenAI and xAI store locks`() {
        val src = listOf("src/main/java", "app/src/main/java").map { File(it) }.first { it.isDirectory }
        val cm = File(src, "com/seekerclaw/app/config/ConfigManager.kt").readText()
        val reset = cm.substringAfter("fun resetConfig(context: Context): ResetResult").substringBefore("fun runtimeAuthTypeFor(")
        val model = reset.indexOf("ModelSelectionLock.transaction")
        val openai = reset.indexOf("OpenAIOAuthTokenStore.withLockForReset")
        val xai = reset.indexOf("XaiOAuthTokenStore.withLockForReset")
        assertTrue("all three present", model >= 0 && openai >= 0 && xai >= 0)
        assertTrue("model, then OpenAI, then xAI", model < openai && openai < xai)
    }

    // ------------------------------- v2.7 §2 (D7.3): the boot selection comes from the files

    @Test
    fun `v2_7 §2 pin 1 - stale snapshot - node caches A, MAIN saves B, config_json, runtime_state and the overlay end on B`() {
        signIn()
        seedPrefs("gpt-6-astra")
        writeRuntime("gpt-6-astra")
        writeOverlay("gpt-6-astra")
        assertEquals("`:node` caches A", "gpt-6-astra", node.getSharedPreferences(PrefsNames.MAIN, 0).getString("model", null))
        mainLoad()
        assertTrue(mainSave(ModelTuple("openai", "oauth", "gpt-6-astra")) { it.copy(provider = "claude", authType = "api_key", model = "claude-opus-5") })

        val c = nodeStart()
        assertEquals("config.json provider", "claude", c.provider)
        assertEquals("config.json auth", "api_key", c.authType)
        assertEquals("config.json model", "claude-opus-5", c.model)
        assertEquals(ModelTuple("claude", "api_key", "claude-opus-5"), RuntimeStateFile.readTuple(dir))
        assertEquals("claude", overlayField("provider"))
        assertEquals("claude-opus-5", overlayField("model"))
        assertEquals("`:node` still holds A in its cache", "openai", node.getSharedPreferences(PrefsNames.MAIN, 0).getString("provider", null))
    }

    @Test
    fun `v2_7 §2 pin 1b - stale snapshot with an unreadable overlay - the provider still comes from runtime_state`() {
        // Reconcile skips an unreadable overlay, so only the files' selection can carry B here.
        signIn()
        seedPrefs("gpt-6-astra")
        writeRuntime("gpt-6-astra")
        writeOverlay("gpt-6-astra")
        node.getSharedPreferences(PrefsNames.MAIN, 0)
        mainLoad()
        assertTrue(mainSave(ModelTuple("openai", "oauth", "gpt-6-astra")) { it.copy(provider = "claude", authType = "api_key", model = "claude-opus-5") })
        AgentSettingsFile.path(dir).toFile().writeText("{not json")

        val c = nodeStart()
        assertEquals("claude", c.provider)
        assertEquals("api_key", c.authType)
        assertEquals("claude-opus-5", c.model)
    }

    @Test
    fun `v2_7 §2 strict - no runtime_state, a foreign overlay - config_json keeps the prefs provider, auth and model`() {
        // The signed text: "provider and auth: runtime_state, then prefs". A foreign overlay (here an
        // in-flight /provider openai whose runtime_state write never happened) contributes nothing.
        tp.disk.putAll(mapOf("setup_complete" to true, "provider" to "claude", "auth_type" to "api_key", "model" to "claude-opus-5"))
        writeOverlay("gpt-6.2-sol", provider = "openai", auth = "api_key")
        assertNull("no runtime_state", runtimeModel())
        val c = nodeStart()
        assertEquals("provider from prefs", "claude", c.provider)
        assertEquals("auth from prefs", "api_key", c.authType)
        assertEquals("model from prefs, not the foreign overlay's", "claude-opus-5", c.model)
    }

    @Test
    fun `v2_7 §2 - an in-flight provider crash - the foreign overlay is never overwritten, config_json follows runtime_state`() {
        // /provider openai wrote the overlay, then the process died before runtime_state.
        tp.disk.putAll(mapOf("setup_complete" to true, "provider" to "claude", "auth_type" to "api_key", "model" to "claude-opus-5"))
        writeRuntime("claude-opus-5", provider = "claude", auth = "api_key")
        writeOverlay("gpt-6.2-sol", provider = "openai", auth = "api_key")
        val overlay = AgentSettingsFile.path(dir)
        val ov = Files.readAllBytes(overlay)
        val rt = Files.readAllBytes(runtimePath)
        val a = anchor()

        val c = nodeStart()
        assertEquals("config.json on claude", "claude", c.provider)
        assertEquals("api_key", c.authType)
        assertEquals("claude-opus-5", c.model)
        assertArrayEquals("the overlay bytes are unchanged", ov, Files.readAllBytes(overlay))
        assertNull("the intent state is unaffected (none)", intentBytes())
        assertTrue(logsSince(a).any { it.message == ModelRepair.FOREIGN_OVERLAY_KEPT })

        val c2 = nodeStart()
        assertEquals("a second boot changes nothing", c, c2)
        assertArrayEquals(ov, Files.readAllBytes(overlay))
        assertArrayEquals(rt, Files.readAllBytes(runtimePath))
        assertNull(intentBytes())
    }

    @Test
    fun `v2_7 §2 pin 2 - the files agree on an unlisted model, prefs retired - no clamp, none published`() {
        signIn()
        seedPrefs("gpt-5.4")
        writeRuntime("gpt-5.6-sol")
        writeOverlay("gpt-5.6-sol")
        val c = nodeStart()
        assertEquals("config.json", "gpt-5.6-sol", c.model)
        assertEquals("overlay", "gpt-5.6-sol", overlayField("model"))
        assertEquals("runtime_state", "gpt-5.6-sol", runtimeModel())
        mainLoad()
        assertEquals("gpt-5.6-sol", tp.disk["model"])
    }

    @Test
    fun `v2_7 §2 pin 2b - the files agree on an unlisted model, a stale listed prefs model, no repair - no clamp`() {
        // No retired id anywhere, so no repair target protects 5.6-sol: only the boot selection does.
        signIn()
        seedPrefs("gpt-6-astra")
        writeRuntime("gpt-5.6-sol")
        writeOverlay("gpt-5.6-sol")
        val c = nodeStart()
        assertNull("nothing to repair", intent())
        assertEquals("config.json not clamped to the default", "gpt-5.6-sol", c.model)
        assertEquals("no clamp published to the overlay", "gpt-5.6-sol", overlayField("model"))
        assertEquals("gpt-5.6-sol", runtimeModel())
    }

    @Test
    fun `v2_7 §2 pin 3 - a Node model choice in the overlay survives a boot whose runtime_state is older`() {
        signIn()
        seedPrefs("gpt-6.1-sol")
        writeRuntime("gpt-6.1-sol")
        writeOverlay("gpt-6-astra") // Node /model wrote the overlay; runtime_state not yet
        val rt = Files.readAllBytes(runtimePath)
        val c = nodeStart()
        assertEquals("config.json", "gpt-6-astra", c.model)
        assertEquals("overlay kept", "gpt-6-astra", overlayField("model"))
        assertArrayEquals("the boot writes no older model anywhere", rt, Files.readAllBytes(runtimePath))
        assertEquals(
            "Node dispatches the overlay's choice",
            NodeDispatch.Winner(NodeDispatch.Source.OVERLAY, "gpt-6-astra"),
            NodeDispatch.winner(RuntimeStateFile.read(dir), AgentSettingsFile.read(dir), "openai", "gpt-6.1-sol"),
        )
    }

    @Test
    fun `v2_7 §2 pin 4 - failed rollback - the runtime_state write and its rollback both fail, the boot follows the files`() {
        signIn()
        seedPrefs("gpt-6-astra")
        writeRuntime("gpt-6-astra") // no overlay: reconcile has nothing to adopt from
        mainLoad()
        SafeFs.beforeMove = { _, target ->
            if (target.fileName.toString() == RuntimeStateFile.NAME) {
                tp.failNextCommits = 1 // the rollback commit that follows fails too
                throw IOException("injected runtime_state failure")
            }
        }
        val a = anchor()
        val saved = mainSave(ModelTuple("openai", "oauth", "gpt-6-astra")) { it.copy(model = "gpt-6.1-sol") }
        SafeFs.beforeMove = savedBeforeMove
        assertFalse(saved)
        assertTrue(
            "the ERROR line",
            logsSince(a).any { it.level == LogLevel.ERROR && it.message.startsWith("[Config] Rollback commit() returned false") },
        )
        assertEquals("prefs kept the unsaved B", "gpt-6.1-sol", tp.disk["model"])
        assertEquals("runtime_state kept A", "gpt-6-astra", runtimeModel())

        tp.restart("node")
        val c = nodeStart()
        assertEquals("config.json follows the files", "gpt-6-astra", c.model)
        assertEquals("the overlay is published from the files", "gpt-6-astra", overlayField("model"))
        assertEquals("gpt-6-astra", runtimeModel())
    }

    @Test
    fun `v2_8 pin 10 unlisted - node's cache holds A, MAIN saves an unlisted B, every file ends on B`() {
        signIn()
        seedPrefs("gpt-6-astra")
        writeRuntime("gpt-6-astra")
        writeOverlay("gpt-6-astra")
        node.getSharedPreferences(PrefsNames.MAIN, 0)
        mainLoad()
        assertTrue(mainSave(ModelTuple("openai", "oauth", "gpt-6-astra")) { it.copy(model = "gpt-5.6-sol") })

        val c = nodeStart()
        assertEquals("config.json", "gpt-5.6-sol", c.model)
        assertEquals("runtime_state", "gpt-5.6-sol", runtimeModel())
        assertEquals("overlay", "gpt-5.6-sol", overlayField("model"))
        assertEquals("prefs", "gpt-5.6-sol", tp.disk["model"])
        assertNull(intent())
    }

    @Test
    fun `CR aefe5f82 #1 - a Settings xAI OAuth selection survives a boot whose node prefs cache still says api_key`() {
        val ps = ModelRegistry.providers
        ModelRegistry.resetForTest()
        ModelRegistry.initForTest(
            ps + ProviderInfo(
                id = "xai", displayName = "xAI", authTypes = listOf("api_key", "oauth"), keyHint = "xai-…",
                consoleUrl = "https://console.x.ai", keysUrl = "https://console.x.ai", freeform = false,
                defaultModel = "grok-4.6", models = listOf(ModelInfo("grok-4.6", "Grok 4.6", "yes")),
            ),
        )
        tp.disk.putAll(mapOf("setup_complete" to true, "provider" to "xai", "auth_type" to "api_key", "model" to "grok-4.6"))
        writeOverlay("grok-4.6", provider = "xai", auth = "api_key")
        writeRuntime("grok-4.6", provider = "xai", auth = "api_key")
        File(dir.toFile(), "xai_oauth.migrated").createNewFile()
        CrossProcessStore(dir.toFile(), XaiOAuthTokenStore.FILE_NAME, com.seekerclaw.app.state.XaiOAuthTokens.serializer(), com.seekerclaw.app.state.XaiOAuthTokens())
            .write(com.seekerclaw.app.state.XaiOAuthTokens())
        XaiOAuthTokenStore.initForTest(dir.toFile())
        assertEquals("node caches api_key", "api_key", nodeStart().authType)
        // Settings switches xAI to OAuth (not signed in yet): overlay xai/oauth, runtime the H5 guard.
        assertTrue(mainSave(ModelTuple("xai", "api_key", "grok-4.6")) { it.copy(authType = "oauth") })
        assertEquals("oauth", overlayField("authType"))
        assertEquals("api_key", RuntimeStateFile.readTuple(dir)?.authType)
        // The next boot, WITHOUT refreshing `:node`'s prefs cache (still api_key).
        val c = nodeStart()
        assertEquals("the boot keeps the newer OAuth selection", "oauth", c.authType)
        assertEquals("and never republishes api_key into the overlay", "oauth", overlayField("authType"))
        // MAIN's collector mirror (MAIN's store wired: nodeStart reset it) and load keep it.
        ProcessRole.setForTest(false)
        RuntimeStateStore.resetForTest()
        val mainPrefs = main.getSharedPreferences("seekerclaw_prefs", 0)
        RuntimeStateStore.initWithStoreForTest(dir.toFile(), prefs = mainPrefs)
        val r = ModelSelectionLock.transaction { tx -> RuntimeStateStore.mirrorFromDisk(tx, mainPrefs) }
        assertEquals("nothing to change", ModelSelectionLock.Result.Acquired(false), r)
        assertEquals("the mirror read the record", "xai", RuntimeStateStore.read().provider)
        assertEquals("and kept the OAuth selection", "oauth", RuntimeStateStore.read().authType)
        assertEquals("prefs still oauth before any reconcile", "oauth", tp.disk["auth_type"])
        mainLoad()
        assertEquals("MAIN keeps the user's OAuth choice", "oauth", tp.disk["auth_type"])
    }

    @Test
    fun `v2_7 §2 - the xAI boot-guard auth in runtime_state is the prefs selection - OAuth is kept in the overlay`() {
        // BAT-1124 H5: xAI oauth with no token is stored in runtime_state as api_key.
        tp.disk.putAll(mapOf("setup_complete" to true, "provider" to "xai", "auth_type" to "oauth", "model" to "grok-4.6"))
        writeRuntime("grok-4.6", provider = "xai", auth = "api_key")
        File(dir.toFile(), "xai_oauth.migrated").createNewFile()
        CrossProcessStore(dir.toFile(), XaiOAuthTokenStore.FILE_NAME, com.seekerclaw.app.state.XaiOAuthTokens.serializer(), com.seekerclaw.app.state.XaiOAuthTokens())
            .write(com.seekerclaw.app.state.XaiOAuthTokens())
        XaiOAuthTokenStore.initForTest(dir.toFile())
        val c = nodeStart()
        assertEquals("the selection keeps oauth", "oauth", c.authType)
        assertEquals("published into the overlay as oauth, never api_key", "oauth", overlayField("authType"))
        mainLoad()
        assertEquals("MAIN keeps the user's OAuth choice", "oauth", tp.disk["auth_type"])
    }
}
