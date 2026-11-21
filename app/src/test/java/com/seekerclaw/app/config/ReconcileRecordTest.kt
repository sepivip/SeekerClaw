package com.seekerclaw.app.config

import com.seekerclaw.app.config.ModelSelectionSaveTest.FakeContext
import com.seekerclaw.app.config.ModelSelectionSaveTest.FakePrefs
import com.seekerclaw.app.state.AgentPreferencesStore
import com.seekerclaw.app.state.CustomConfigSignature
import com.seekerclaw.app.state.OpenAIOAuthTokenStore
import com.seekerclaw.app.state.RuntimeState
import com.seekerclaw.app.state.RuntimeStateStore
import com.seekerclaw.app.state.XaiOAuthTokenStore
import com.seekerclaw.app.state.XaiOAuthTokens
import com.seekerclaw.app.testing.PowerLossFs
import com.seekerclaw.app.util.CrossProcessStore
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogEntry
import com.seekerclaw.app.util.LogLevel
import com.seekerclaw.app.util.ProcessRole
import com.seekerclaw.app.util.SafeFs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.Executors

/**
 * BAT-1661 contract v2.12 (Q16) — the durable retry record of an interrupted reconcile, with Codex's
 * five binding folds (`2c3b07c1`). Every test runs the REAL load / mirror / seed / save / reset /
 * service-start paths on real files, with [ModelSelectionSaveTest]'s [FakePrefs] (memory and disk
 * kept apart, `restartProcess()` = a new process).
 *
 * The base transaction: prefs and runtime_state on P = R0 = openai/oauth/gpt-6-astra, and the
 * overlay on I = xai/api_key/grok-4.6 (a `/provider xai` from chat). A MAIN load reconciles to I.
 * Pins are named after draft §6 (S*, F*, N*, P*, I*, X*, B*, M1, SD*, C*, R*) and the folds.
 */
class ReconcileRecordTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var dir: Path
    private lateinit var prefs: FakePrefs
    private lateinit var ctx: FakeContext
    private val savedDirSync = SafeFs.dirSyncChecked
    private val savedBeforeMove = SafeFs.beforeMove
    private val sealer = SecretSealer { plain -> "sealed:$plain" }
    private val testCodec = object : SecretCodec {
        override fun seal(plain: String) = "sealed:$plain"
        override fun open(sealed: String) = sealed.removePrefix("sealed:")
    }
    private val savedKeyUsableOf = ConfigManager.keyUsableOf

    private class Crash : Error("injected process death")

    private val P = ModelTuple("openai", "oauth", "gpt-6-astra")
    private val I = ModelTuple("xai", "api_key", "grok-4.6")

    @Before
    fun setUp() = fresh()

    /** A fresh files dir, prefs and process (also used to run one pin through H1 and H2). */
    private fun fresh() {
        dir = tmp.newFolder().toPath()
        Files.createDirectories(dir.resolve("workspace"))
        SafeFs.dirSyncChecked = {}
        SafeFs.beforeMove = savedBeforeMove
        ModelSelectionLock.initForTest(dir)
        ModelRegistry.resetForTest()
        ModelRegistry.initForTest(
            listOf(
                ProviderInfo(
                    id = "openai", displayName = "OpenAI", authTypes = listOf("api_key", "oauth"), keyHint = "sk-",
                    consoleUrl = "https://platform.openai.com", keysUrl = "https://platform.openai.com/api-keys",
                    freeform = false, defaultModel = "gpt-6.1-sol",
                    models = listOf(ModelInfo("gpt-6.1-sol", "GPT-6.1 Sol", "yes"), ModelInfo("gpt-6-astra", "GPT-6 Astra", "yes")),
                    retiredForAuth = mapOf("oauth" to listOf("gpt-5.5", "gpt-5.4", "gpt-5.4-mini")),
                ),
                ProviderInfo(
                    id = "xai", displayName = "xAI", authTypes = listOf("api_key", "oauth"), keyHint = "xai-",
                    consoleUrl = "https://console.x.ai", keysUrl = "https://console.x.ai", freeform = false,
                    defaultModel = "grok-4.6",
                    models = listOf(ModelInfo("grok-4.6", "Grok 4.6", "yes"), ModelInfo("grok-4.6-fast", "Grok 4.6 Fast", "yes")),
                ),
                ProviderInfo(
                    id = "custom", displayName = "Custom", authTypes = listOf("api_key"), keyHint = "",
                    consoleUrl = "", keysUrl = "", freeform = true, defaultModel = "", models = emptyList(),
                ),
            ),
        )
        RuntimeStateStore.resetForTest()
        AgentPreferencesStore.resetForTest()
        XaiOAuthTokenStore.resetForTest()
        OpenAIOAuthTokenStore.resetForTest()
        OpenAIOAuthTokenStore.initForTest(dir.toFile(), testCodec)
        assertTrue(OpenAIOAuthTokenStore.signIn("old-access", "old-refresh", "", "") is OpenAIOAuthTokenStore.Result.Ok)
        prefs = FakePrefs()
        ctx = FakeContext(dir.toFile(), prefs)
        MainPrefs.resetProcessStateForTest()
        ReconcileRecord.resetForTest()
        RestartNotice.execute = { it.run() } // ReconcileRecord.resetForTest reset the notice store
        ConfigManager.keyUsableOf = savedKeyUsableOf
        ConfigManager.afterSaveLockForTest = null
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
        ConfigManager.keyUsableOf = savedKeyUsableOf
        ConfigManager.afterSaveLockForTest = null
        ConfigManager.deleteKeystoreKey = { KeystoreHelper.deleteKey() }
    }

    // ------------------------------------------------------------------------------ fixtures

    private fun seedPrefs(t: ModelTuple = P) {
        prefs.seed("setup_complete" to true, "provider" to t.provider, "auth_type" to t.authType, "model" to t.model)
    }

    private fun writeRuntime(t: ModelTuple = P, base: RuntimeState = RuntimeState(reasoningEnabled = true)) {
        val s = base.copy(provider = t.provider, authType = t.authType, model = t.model)
        CrossProcessStore(dir.toFile(), RuntimeStateFile.NAME, RuntimeState.serializer(), s).write(s)
    }

    private fun writeOverlay(t: ModelTuple = I) = writeOverlayRaw(
        """{"heartbeatIntervalMinutes":30,"provider":"${t.provider}","authType":"${t.authType}","model":"${t.model}","apiKeys":{}}""",
    )

    private fun writeOverlayRaw(text: String) = AgentSettingsFile.path(dir).toFile().writeText(text)

    private fun runtimePath() = dir.resolve(RuntimeStateFile.NAME)
    private fun runtimeTuple() = RuntimeStateFile.readTuple(dir)
    private fun runtimeRecord(): RuntimeState =
        Json { ignoreUnknownKeys = true }.decodeFromString(RuntimeState.serializer(), String(Files.readAllBytes(runtimePath()), Charsets.UTF_8))
    private fun recordBytes(): ByteArray = Files.readAllBytes(ReconcileRecord.path(dir))
    private fun recordPresent() = ReconcileRecord.read(dir) is ReconcileRecord.Read.Present

    private fun mainProcess(seed: RuntimeState = RuntimeState()) {
        ProcessRole.setForTest(false)
        RuntimeStateStore.resetForTest()
        RuntimeStateStore.initWithStoreForTest(dir.toFile(), seed, prefs)
    }

    /** MAIN exits; a new MAIN process reads the disk (the sticky taint is gone, D12.2). */
    private fun restart() {
        prefs.restartProcess()
        mainProcess()
    }

    private fun nodeProcess() {
        ProcessRole.setForTest(true)
        RuntimeStateStore.resetForTest()
        prefs.restartProcess()
    }

    private fun load() = ConfigManager.loadConfig(ctx)

    private fun mirror() = ModelSelectionLock.transaction { tx -> RuntimeStateStore.mirrorFromDisk(tx, prefs) }

    private fun resolveNow(): ReconcileRecord.Outcome {
        val r = ModelSelectionLock.transaction { tx -> ReconcileRecord.resolve(tx, dir, MainPrefs.view(prefs)) }
        return (r as ModelSelectionLock.Result.Acquired).value
    }

    private fun seedNow() = RuntimeStateStore.seedIfMissing(dir.toFile(), prefs) { st ->
        CrossProcessStore(dir.toFile(), RuntimeStateFile.NAME, RuntimeState.serializer(), st).write(st)
    }

    private fun serviceStart(): AppConfig {
        var emitted: AppConfig? = null
        val wasNode = ProcessRole.isNode
        ProcessRole.setForTest(true)
        try {
            ModelRepair.serviceStart(ctx) { cfg -> emitted = cfg; "telegram" }
        } finally {
            ProcessRole.setForTest(wasNode)
        }
        return emitted!!
    }

    private fun form(loaded: ModelTuple, edit: (AppConfig) -> AppConfig = { it }) = edit(
        AppConfig(
            anthropicApiKey = "", telegramBotToken = "bot", telegramOwnerId = "1", agentName = "MyAgent",
            provider = loaded.provider, authType = loaded.authType, model = loaded.model,
            openaiOAuthToken = "old-access", loadedModelTuple = loaded,
        ),
    )

    private fun save(cfg: AppConfig) = ConfigManager.saveConfigWith(ctx, cfg, ModelSelectionLock.LOCK_TIMEOUT_MS, sealer)

    private fun anchor() = LogCollector.logs.value.lastOrNull()
    private fun logsSince(anchor: LogEntry?): List<LogEntry> {
        val all = LogCollector.logs.value
        return all.drop(if (anchor == null) 0 else all.indexOfFirst { it === anchor } + 1)
    }
    private fun List<LogEntry>.has(msg: String) = any { it.message == msg }
    private fun List<LogEntry>.count(msg: String) = count { it.message == msg }
    private fun List<LogEntry>.recordLines() = filter { it.message.startsWith("[Config] Reconcile: retry") || it.message.startsWith("[Config] Reconcile finished") || it.message.startsWith("[Config] Reconcile not finished") }

    private val RECOVERED_I = ReconcileRecord.recovered("xai", "api_key", "grok-4.6")
    private val DROPPED_NOT_COMMITTED = ReconcileRecord.recordDropped(ReconcileRecord.DROP_NOT_COMMITTED)
    private val DROPPED_OVERLAY = ReconcileRecord.recordDropped(ReconcileRecord.DROP_OVERLAY_NEWER)

    private fun disarm() {
        SafeFs.beforeMove = savedBeforeMove
        prefs.beforeNextCommit = null
        prefs.failCommits = false
        ReconcileRecord.beforeClearForTest = null
        ReconcileRecord.beforeReadForTest = null
        RuntimeStateStore.beforeWriteVerifiedForTest = null
    }

    private fun expectCrash(block: () -> Unit) {
        var crashed = false
        try {
            block()
        } catch (_: Crash) {
            crashed = true
        } finally {
            disarm()
        }
        assertTrue("the injected process death happened", crashed)
    }

    private fun isRuntime(t: Path) = t.fileName.toString() == RuntimeStateFile.NAME
    private fun isRecord(t: Path) = t.fileName.toString() == ReconcileRecord.NAME

    /** The base user, MAIN, the overlay on I. */
    private fun base(runtime: ModelTuple? = P, overlay: ModelTuple = I, rt: RuntimeState = RuntimeState(reasoningEnabled = true)) {
        seedPrefs(P)
        if (runtime != null) writeRuntime(runtime, rt)
        writeOverlay(overlay)
        mainProcess()
    }

    /**
     * Q16's failure: the reconcile's runtime_state write fails AND its rollback commit fails. On disk,
     * prefs and the overlay hold the change; runtime_state the old selection. The process is tainted.
     */
    private fun doubleFailure() {
        SafeFs.beforeMove = { _, t ->
            if (isRuntime(t)) {
                prefs.failCommits = true
                throw IOException("injected runtime_state write failure")
            }
        }
        try {
            load()
        } finally {
            disarm()
        }
        assertTrue("the retry record survived", recordPresent())
    }

    /** Counts runtime_state renames while [block] runs. */
    private fun runtimeRenames(block: () -> Unit): Int {
        var n = 0
        val prev = SafeFs.beforeMove
        SafeFs.beforeMove = { tmpf, t -> prev(tmpf, t); if (isRuntime(t)) n++ }
        try {
            block()
        } finally {
            SafeFs.beforeMove = prev
        }
        return n
    }

    private fun assertEndsOnI() {
        load()
        assertEquals(I, runtimeTuple())
        assertEquals("xai", prefs.disk["provider"])
        assertEquals("api_key", prefs.disk["auth_type"])
        assertEquals("grok-4.6", prefs.disk["model"])
        assertEquals(ReconcileRecord.Read.Absent, ReconcileRecord.read(dir))
    }

    private enum class Hook { H1, H2 }

    private fun runHook(h: Hook) {
        when (h) {
            Hook.H1 -> load()
            Hook.H2 -> mirror()
        }
    }

    /** Runs [pin] once through H1 (the locked load) and once through H2 (the collector mirror), each on fresh files. */
    private fun bothHooks(pin: (Hook) -> Unit) {
        for (h in Hook.values()) {
            fresh()
            try {
                pin(h)
            } catch (e: AssertionError) {
                throw AssertionError("[$h] ${e.message}", e)
            }
        }
    }

    // ------------------------------------------------------------- Q16-T1 and process death S0–S6

    @Test
    fun `Q16-T1 via the stage table - double failure then a cold MAIN load recovers`() {
        base()
        doubleFailure()
        assertEquals("prefs on disk hold the change", "xai", prefs.disk["provider"])
        assertEquals("runtime_state kept the old selection", P, runtimeTuple())
        restart()
        val a = anchor()
        load()
        assertEquals(I, runtimeTuple())
        assertEquals(1, logsSince(a).count(RECOVERED_I))
        assertEquals(ReconcileRecord.Read.Absent, ReconcileRecord.read(dir))
        assertEquals("the four other fields are kept (fold 2)", true, runtimeRecord().reasoningEnabled)
    }

    @Test
    fun `S0 - death before the record write - the ordinary reconcile`() = bothHooks { h ->
        base()
        SafeFs.beforeMove = { _, t -> if (isRecord(t)) throw Crash() }
        expectCrash { load() }
        assertEquals(ReconcileRecord.Read.Absent, ReconcileRecord.read(dir))
        assertEquals("openai", prefs.disk["provider"])
        restart()
        val a = anchor()
        runHook(h)
        assertTrue(logsSince(a).recordLines().toString(), logsSince(a).recordLines().isEmpty())
        assertEndsOnI()
    }

    @Test
    fun `S1 - death after the confirmed record write, before the commit - NotCommitted, then the ordinary reconcile`() = bothHooks { h ->
        base()
        SafeFs.beforeMove = { _, t -> if (isRecord(t)) prefs.beforeNextCommit = { throw Crash() } }
        expectCrash { load() }
        assertTrue(recordPresent())
        assertEquals("the commit never ran", "openai", prefs.disk["provider"])
        restart()
        val runtimeBefore = Files.readAllBytes(runtimePath())
        val a = anchor()
        val renames = runtimeRenames { runHook(h) }
        assertTrue(logsSince(a).has(DROPPED_NOT_COMMITTED))
        assertFalse("the record never writes runtime_state", logsSince(a).has(RECOVERED_I))
        if (h == Hook.H2) {
            assertEquals("no runtime_state rename by the record", 0, renames)
            assertArrayEquals(runtimeBefore, Files.readAllBytes(runtimePath()))
        } else {
            assertEquals("only the ordinary reconcile's own write", 1, renames)
        }
        assertEndsOnI()
    }

    @Test
    fun `S1b - as S1, then Node provider X before the restart - Superseded, X everywhere, never I`() = bothHooks { h ->
        base()
        SafeFs.beforeMove = { _, t -> if (isRecord(t)) prefs.beforeNextCommit = { throw Crash() } }
        expectCrash { load() }
        val x = ModelTuple("openai", "api_key", "gpt-6.1-sol")
        writeOverlay(x) // Node /provider: the overlay first, then runtime_state
        writeRuntime(x)
        restart()
        val a = anchor()
        runHook(h)
        assertTrue(logsSince(a).has(DROPPED_OVERLAY))
        load()
        assertEquals(x, runtimeTuple())
        assertEquals("api_key", prefs.disk["auth_type"])
        assertEquals("gpt-6.1-sol", prefs.disk["model"])
        assertEquals(ReconcileRecord.Read.Absent, ReconcileRecord.read(dir))
    }

    @Test
    fun `S1c - as S1, then the overlay is deleted - P and R0 stay, nothing holds I`() = bothHooks { h ->
        base()
        SafeFs.beforeMove = { _, t -> if (isRecord(t)) prefs.beforeNextCommit = { throw Crash() } }
        expectCrash { load() }
        Files.delete(AgentSettingsFile.path(dir))
        restart()
        val a = anchor()
        runHook(h)
        assertTrue(logsSince(a).has(DROPPED_NOT_COMMITTED))
        load()
        assertEquals(P, runtimeTuple())
        assertEquals("openai", prefs.disk["provider"])
        assertEquals("gpt-6-astra", prefs.disk["model"])
        assertEquals(ReconcileRecord.Read.Absent, ReconcileRecord.read(dir))
    }

    @Test
    fun `S2 - death after the commit, before the runtime write - Recovered`() = bothHooks { h ->
        base()
        SafeFs.beforeMove = { _, t -> if (isRuntime(t)) throw Crash() }
        expectCrash { load() }
        assertEquals("xai", prefs.disk["provider"])
        assertEquals(P, runtimeTuple())
        restart()
        val a = anchor()
        runHook(h)
        assertEquals(1, logsSince(a).count(RECOVERED_I))
        assertEquals("prefs are never R0 (disk)", "xai", prefs.disk["provider"])
        assertEquals("prefs are never R0 (memory)", "xai", prefs.memory["provider"])
        assertEndsOnI()
    }

    @Test
    fun `S2b - death in the rollback commit with prefs still on I - Recovered`() = bothHooks { h ->
        base()
        SafeFs.beforeMove = { _, t ->
            if (isRuntime(t)) {
                prefs.beforeNextCommit = { throw Crash() }
                throw IOException("injected runtime_state write failure")
            }
        }
        expectCrash { load() }
        assertEquals("the rollback never reached disk", "xai", prefs.disk["provider"])
        restart()
        val a = anchor()
        runHook(h)
        assertEquals(1, logsSince(a).count(RECOVERED_I))
        assertEndsOnI()
    }

    @Test
    fun `S2b and F3 - the rollback landed (prefs on P), then death - NotCommitted, then the ordinary reconcile`() = bothHooks { h ->
        base()
        SafeFs.beforeMove = { _, t -> if (isRuntime(t)) throw IOException("injected runtime_state write failure") }
        try { load() } finally { disarm() }
        assertEquals("rolled back", "openai", prefs.disk["provider"])
        assertTrue(recordPresent())
        restart()
        val a = anchor()
        runHook(h)
        assertTrue(logsSince(a).has(DROPPED_NOT_COMMITTED))
        assertEndsOnI()
    }

    @Test
    fun `S3 - death after the runtime write, before the clear - Completed with the confirm rewrite only`() = bothHooks { h ->
        base()
        ReconcileRecord.beforeClearForTest = { throw Crash() }
        expectCrash { load() }
        assertEquals(I, runtimeTuple())
        assertTrue(recordPresent())
        restart()
        val a = anchor()
        val renames = runtimeRenames { runHook(h) }
        assertEquals("the confirm rewrite only", 1, renames)
        assertFalse(logsSince(a).has(RECOVERED_I))
        assertTrue(logsSince(a).none { it.message.startsWith("[Config] Reconcile: retry record dropped") })
        assertEquals(ReconcileRecord.Read.Absent, ReconcileRecord.read(dir))
        assertEndsOnI()
    }

    @Test
    fun `S4 - death after the clear - nothing`() = bothHooks { h ->
        base()
        load()
        restart()
        val a = anchor()
        val renames = runtimeRenames { runHook(h) }
        assertEquals(0, renames)
        assertTrue(logsSince(a).recordLines().isEmpty())
        assertEndsOnI()
    }

    @Test
    fun `S5 - death inside recovery before its runtime write - Recovered next time`() = bothHooks { h ->
        base()
        SafeFs.beforeMove = { _, t -> if (isRuntime(t)) throw Crash() }
        expectCrash { load() }
        restart()
        SafeFs.beforeMove = { _, t -> if (isRuntime(t)) throw Crash() }
        expectCrash { runHook(h) }
        assertTrue(recordPresent())
        assertEquals(P, runtimeTuple())
        restart()
        val a = anchor()
        runHook(h)
        assertEquals(1, logsSince(a).count(RECOVERED_I))
        assertEndsOnI()
    }

    @Test
    fun `S6 - death inside recovery after its write and before the delete - Completed`() = bothHooks { h ->
        base()
        SafeFs.beforeMove = { _, t -> if (isRuntime(t)) throw Crash() }
        expectCrash { load() }
        restart()
        ReconcileRecord.beforeClearForTest = { throw Crash() }
        expectCrash { runHook(h) }
        assertEquals(I, runtimeTuple())
        assertTrue(recordPresent())
        restart()
        val a = anchor()
        assertEquals("the confirm rewrite only", 1, runtimeRenames { runHook(h) })
        assertFalse(logsSince(a).has(RECOVERED_I))
        assertEndsOnI()
    }

    // ---------------------------------------------------------------------- failures, no crash

    /** A locked MAIN load that exposes its transaction's write-failed flag. */
    private fun lockedLoadFlag(): Boolean {
        val r = ModelSelectionLock.transaction { tx -> ConfigManager.loadConfigForBoot(ctx, tx, null); tx.writeFailed }
        return (r as ModelSelectionLock.Result.Acquired).value
    }

    @Test
    fun `F1 - the record write is not applied - no mutation, tx flagged, ERROR`() {
        base()
        val writes = prefs.modelKeyWrites
        val runtimeBefore = Files.readAllBytes(runtimePath())
        val a = anchor()
        SafeFs.beforeMove = { _, t -> if (isRecord(t)) throw IOException("injected record write failure") }
        val flagged = try { lockedLoadFlag() } finally { disarm() }
        assertTrue("tx flagged", flagged)
        assertEquals("no modelKeyWrites delta", writes, prefs.modelKeyWrites)
        assertArrayEquals("no runtime_state write", runtimeBefore, Files.readAllBytes(runtimePath()))
        assertEquals("openai", prefs.disk["provider"])
        val err = logsSince(a).single { it.message.startsWith("[Config] Reconcile: retry record not saved — model or provider change not applied to the app's settings this time (") }
        assertEquals(LogLevel.ERROR, err.level)
        assertEquals(ReconcileRecord.Read.Absent, ReconcileRecord.read(dir))
        assertEndsOnI()
    }

    @Test
    fun `F1b - the record write is unconfirmed - no mutation, the visible record is harmless`() {
        base()
        val writes = prefs.modelKeyWrites
        val runtimeBefore = Files.readAllBytes(runtimePath())
        val pl = PowerLossFs()
        pl.install()
        pl.syncFails = true
        val a = anchor()
        val flagged = try { lockedLoadFlag() } finally { pl.syncFails = false; pl.uninstall(); disarm() }
        assertTrue(flagged)
        assertEquals(writes, prefs.modelKeyWrites)
        assertArrayEquals(runtimeBefore, Files.readAllBytes(runtimePath()))
        assertTrue(logsSince(a).any { it.level == LogLevel.ERROR && it.message.startsWith("[Config] Reconcile: retry record not saved") })
        assertTrue("the unconfirmed record is visible", recordPresent())
        val b = anchor()
        load()
        assertTrue("prefs are still on prefsBefore: NotCommitted", logsSince(b).has(DROPPED_NOT_COMMITTED))
        assertEndsOnI()
    }

    @Test
    fun `F2 - the prefs commit fails - record kept, cache restored, cold NotCommitted then the ordinary reconcile`() {
        base()
        prefs.failCommits = true
        try { load() } finally { disarm() }
        assertTrue(recordPresent())
        assertEquals("openai", prefs.memory["provider"])
        restart()
        val a = anchor()
        load()
        assertTrue(logsSince(a).has(DROPPED_NOT_COMMITTED))
        assertEndsOnI()
    }

    @Test
    fun `F3b - the runtime write is unconfirmed - no rollback, the mirror holds, power loss, restart recovers - no split`() {
        base()
        val pl = PowerLossFs()
        pl.install()
        val inner = SafeFs.beforeMove
        SafeFs.beforeMove = { tmpf, t -> inner(tmpf, t); if (isRuntime(t)) pl.syncFails = true }
        val a = anchor()
        load()
        SafeFs.beforeMove = inner
        assertTrue(logsSince(a).any { it.level == LogLevel.WARN && it.message == ReconcileRecord.RUNTIME_UNCONFIRMED })
        assertEquals("no rollback: prefs stay on the change", "xai", prefs.disk["provider"])
        assertEquals("the new bytes are visible", I, runtimeTuple())
        assertTrue(recordPresent())
        // The collector mirror while the disk still fails: the confirm rewrite fails, so it holds.
        assertEquals(ModelSelectionLock.Result.Acquired(false), mirror())
        assertEquals("xai", prefs.disk["provider"])
        assertTrue(recordPresent())
        pl.powerLoss()
        pl.syncFails = false
        pl.uninstall()
        assertEquals("the unconfirmed runtime write did not survive", P, runtimeTuple())
        assertEquals("prefs never split from the change", "xai", prefs.disk["provider"])
        restart()
        val b = anchor()
        load()
        assertEquals(1, logsSince(b).count(RECOVERED_I))
        assertEndsOnI()
    }

    @Test
    fun `F5 - the clear fails - the reconcile succeeds, Completed next, then nothing`() {
        base()
        ReconcileRecord.beforeClearForTest = { throw IOException("injected delete failure") }
        val a = anchor()
        try { load() } finally { disarm() }
        assertEquals(I, runtimeTuple())
        assertTrue(logsSince(a).any { it.level == LogLevel.WARN && it.message.startsWith("[Config] Reconcile: retry record not cleared (") })
        assertTrue(logsSince(a).any { it.message.startsWith("[Config] Reconciled from agent_settings.json") })
        assertTrue(recordPresent())
        assertEquals("Completed: the confirm rewrite", 1, runtimeRenames { load() })
        assertEquals(ReconcileRecord.Read.Absent, ReconcileRecord.read(dir))
        assertEquals("then nothing", 0, runtimeRenames { load() })
    }

    /** A model-only change P → openai/oauth/gpt-6.1-sol, double failure, a new process. */
    private fun modelOnlyDoubleFailure() {
        base(overlay = ModelTuple("openai", "oauth", "gpt-6.1-sol"))
        doubleFailure()
        assertEquals("gpt-6.1-sol", prefs.disk["model"])
        restart()
    }

    @Test
    fun `F6 and F6b - recovery's runtime write fails - Failed, record kept, mirror held, mainLoad skipped`() {
        modelOnlyDoubleFailure()
        val recordBefore = recordBytes()
        SafeFs.beforeMove = { _, t -> if (isRuntime(t)) throw IOException("injected recovery write failure") }
        val a = anchor()
        try {
            load()
            assertEquals("the mirror holds", ModelSelectionLock.Result.Acquired(false), mirror())
        } finally {
            disarm()
        }
        assertTrue(logsSince(a).any { it.level == LogLevel.WARN && it.message.startsWith("[Config] Reconcile not finished after a restart: runtime_state.json not saved (") })
        assertArrayEquals(recordBefore, recordBytes())
        assertEquals("gpt-6-astra", runtimeTuple()?.model)
        assertEquals("F6b: prefs keep the change - no sync from runtime_state", "gpt-6.1-sol", prefs.disk["model"])
        assertEquals("gpt-6.1-sol", prefs.memory["model"])
    }

    // ---------------------------------------------------------- newer choices before recovery

    @Test
    fun `N1 - a Settings selection in a fresh process deletes the record and wins`() {
        base()
        doubleFailure()
        restart()
        val s = ModelTuple("openai", "api_key", "gpt-6.1-sol")
        assertTrue(save(form(I) { it.copy(provider = s.provider, authType = s.authType, model = s.model) }))
        assertEquals("H5 deleted the record", ReconcileRecord.Read.Absent, ReconcileRecord.read(dir))
        load()
        assertEquals(s, runtimeTuple())
        assertEquals("api_key", prefs.disk["auth_type"])
        assertEquals("gpt-6.1-sol", prefs.disk["model"])
    }

    @Test
    fun `N1b - the selection's delete fails - Superseded at the next load`() {
        base()
        doubleFailure()
        restart()
        val s = ModelTuple("openai", "api_key", "gpt-6.1-sol")
        ReconcileRecord.beforeClearForTest = { throw IOException("injected delete failure") }
        val a = anchor()
        try {
            assertTrue(save(form(I) { it.copy(provider = s.provider, authType = s.authType, model = s.model) }))
        } finally {
            disarm()
        }
        assertTrue(logsSince(a).any { it.message.startsWith("[Config] Reconcile: retry record not cleared (") })
        assertTrue(recordPresent())
        val b = anchor()
        load()
        assertTrue(logsSince(b).has(DROPPED_OVERLAY))
        assertEquals(s, runtimeTuple())
        assertEquals(ReconcileRecord.Read.Absent, ReconcileRecord.read(dir))
    }

    @Test
    fun `N2 - Node provider X - Superseded`() {
        base()
        doubleFailure()
        val x = ModelTuple("openai", "api_key", "gpt-6.1-sol")
        writeOverlay(x)
        writeRuntime(x)
        restart()
        val a = anchor()
        load()
        assertTrue(logsSince(a).has(DROPPED_OVERLAY))
        assertEquals(x, runtimeTuple())
        assertEquals("api_key", prefs.disk["auth_type"])
    }

    @Test
    fun `N3 - Node model on the overlay only - Superseded, and the ordinary reconcile adopts it`() {
        base()
        doubleFailure()
        writeOverlay(ModelTuple("xai", "api_key", "grok-4.6-fast"))
        restart()
        val a = anchor()
        load()
        assertTrue(logsSince(a).has(DROPPED_OVERLAY))
        assertEquals(ModelTuple("xai", "api_key", "grok-4.6-fast"), runtimeTuple())
        assertEquals("grok-4.6-fast", prefs.disk["model"])
    }

    @Test
    fun `N4 - the overlay becomes model-less (Q15) - Recovered, an auth-only change is Superseded`() {
        base()
        doubleFailure()
        writeOverlayRaw("""{"heartbeatIntervalMinutes":45,"maxStepsPerTurn":35,"apiKeys":{}}""")
        restart()
        val a = anchor()
        load()
        assertEquals("D12.7: no selection keys carry no selection", 1, logsSince(a).count(RECOVERED_I))
        assertEquals(I, runtimeTuple())
        // Counterexample, on fresh files: an authType-only change of the overlay is a newer choice.
        fresh()
        base()
        doubleFailure()
        writeOverlay(ModelTuple("xai", "oauth", "grok-4.6"))
        restart()
        val b = anchor()
        load()
        assertTrue(logsSince(b).has(DROPPED_OVERLAY))
        assertFalse(logsSince(b).has(RECOVERED_I))
    }

    // ------------------------------------------------------------- MAIN's cache is not proof

    @Test
    fun `P1 - same-process loads after the double failure are Deferred and change nothing, a restart recovers`() {
        base()
        doubleFailure()
        assertTrue("the failed rollback tainted the process", MainPrefs.commitFailedThisProcess)
        val recordBefore = recordBytes()
        val runtimeBefore = Files.readAllBytes(runtimePath())
        val disk = LinkedHashMap(prefs.disk)
        val memory = LinkedHashMap(prefs.memory)
        // A rerun's record write would fail too: it must never be reached.
        SafeFs.beforeMove = { _, t -> if (isRecord(t)) throw IOException("injected record write failure") }
        val a = anchor()
        try {
            repeat(2) { load() }
        } finally {
            disarm()
        }
        assertArrayEquals("the old record survives", recordBefore, recordBytes())
        assertArrayEquals(runtimeBefore, Files.readAllBytes(runtimePath()))
        assertEquals(disk, prefs.disk)
        assertEquals(memory, prefs.memory)
        assertEquals("RECORD_DEFERRED once per process", 1, logsSince(a).count(ReconcileRecord.RECORD_DEFERRED))
        restart()
        val b = anchor()
        load()
        assertEquals(1, logsSince(b).count(RECOVERED_I))
        assertEquals(I, runtimeTuple())
    }

    @Test
    fun `P2 - a failed commit and a model-key apply() set the sticky flag, other applies do not`() {
        mainProcess()
        val w = MainPrefs.forWrite(ctx, "test")!!
        w.edit().putBoolean("auto_start_on_boot", false).apply()
        assertFalse(MainPrefs.commitFailedThisProcess)
        prefs.failCommits = true
        val a = anchor()
        try {
            w.edit().putString(ConfigManager.KEY_MODEL, "gpt-6.1-sol").apply()
        } finally {
            disarm()
        }
        assertTrue("a model-key apply() taints the process", MainPrefs.commitFailedThisProcess)
        assertTrue(logsSince(a).any { it.level == LogLevel.ERROR && it.message == ReconcileRecord.APPLY_MODEL_KEYS })
        MainPrefs.resetProcessStateForTest()
        val b = anchor()
        w.edit().remove(ConfigManager.KEY_PROVIDER).apply()
        assertTrue("remove(KEY_PROVIDER) then apply() too", MainPrefs.commitFailedThisProcess)
        assertTrue(logsSince(b).has(ReconcileRecord.APPLY_MODEL_KEYS))
        MainPrefs.resetProcessStateForTest()
        prefs.failCommits = true
        try {
            assertFalse(w.edit().putBoolean("auto_start_on_boot", true).commit())
        } finally {
            disarm()
        }
        assertTrue("any failed MAIN commit taints the process", MainPrefs.commitFailedThisProcess)
    }

    // ---------------------------------------------------------------- fold 1 (binding)

    private fun intentFile(): ByteArray? = ModelRepair.intentPath(dir).toFile().takeIf { it.exists() }?.readBytes()

    /** An intent a non-held MAIN load would delete (its scope is not the selection). */
    private fun foreignScopeIntent() = ModelRepair.writeIntent(
        dir,
        ModelRepair.RepairIntent(provider = "claude", authType = "api_key", target = "claude-opus-5-5", defaultAtDecision = "claude-opus-5-5"),
    )

    @Test
    fun `fold 1 - repeated same-process loads after a failed rollback hold the WHOLE selection load`() {
        base()
        doubleFailure()
        foreignScopeIntent()
        // The cache is back on P (the failed rollback), the overlay on I: an unheld load would reconcile
        // and replace the record. (A NEWER overlay would supersede it instead — steps 1–4 need no proof.)
        assertEquals("openai", prefs.memory["provider"])
        val recordBefore = recordBytes()
        val runtimeBefore = Files.readAllBytes(runtimePath())
        val intentBefore = intentFile()
        val disk = LinkedHashMap(prefs.disk)
        val memory = LinkedHashMap(prefs.memory)
        val writes = prefs.modelKeyWrites
        repeat(3) { load() }
        assertEquals(ModelSelectionLock.Result.Acquired(false), mirror())
        assertArrayEquals("record bytes", recordBefore, recordBytes())
        assertArrayEquals("runtime_state bytes", runtimeBefore, Files.readAllBytes(runtimePath()))
        assertArrayEquals("intent bytes", intentBefore, intentFile())
        assertEquals("prefs on disk", disk, prefs.disk)
        assertEquals("prefs in memory", memory, prefs.memory)
        assertEquals("no model-key write at all", writes, prefs.modelKeyWrites)
    }

    @Test
    fun `fold 1 - an Unavailable record holds every automatic writer and is never replaced`() {
        base()
        doubleFailure()
        restart() // a clean process: only the unreadable record holds
        foreignScopeIntent()
        writeOverlay(ModelTuple("openai", "api_key", "gpt-6.1-sol"))
        val recordBefore = recordBytes()
        val runtimeBefore = Files.readAllBytes(runtimePath())
        val intentBefore = intentFile()
        val disk = LinkedHashMap(prefs.disk)
        val writes = prefs.modelKeyWrites
        ReconcileRecord.beforeReadForTest = { throw IOException("injected read failure") }
        try {
            assertTrue(ReconcileRecord.read(dir) is ReconcileRecord.Read.Unavailable)
            repeat(3) { load() }
            assertEquals(ModelSelectionLock.Result.Acquired(false), mirror())
        } finally {
            disarm()
        }
        assertArrayEquals(recordBefore, recordBytes())
        assertArrayEquals(runtimeBefore, Files.readAllBytes(runtimePath()))
        assertArrayEquals(intentBefore, intentFile())
        assertEquals(disk, prefs.disk)
        assertEquals(writes, prefs.modelKeyWrites)
    }

    @Test
    fun `fold 1 - a record whose delete failed is never overwritten by a new committing reconcile`() {
        base()
        doubleFailure()
        val x = ModelTuple("openai", "api_key", "gpt-6.1-sol")
        writeOverlay(x) // a newer choice: Superseded, and a reconcile toward it would commit
        restart()
        val recordBefore = recordBytes()
        val disk = LinkedHashMap(prefs.disk)
        ReconcileRecord.beforeClearForTest = { throw IOException("injected delete failure") }
        try {
            load()
        } finally {
            disarm()
        }
        assertArrayEquals("the unresolved record is not replaced", recordBefore, recordBytes())
        assertEquals("nothing committed over it", disk, prefs.disk)
        load()
        assertEquals("once the record is gone the reconcile lands", x, runtimeTuple())
        assertEquals(ReconcileRecord.Read.Absent, ReconcileRecord.read(dir))
    }

    // ---------------------------------------------------------------- fold 2 (binding)

    private val rich = RuntimeState(reasoningEnabled = true, reasoningDisplayInChat = true, customEchoReasoning = true, customConfigSignature = "sig-x")

    private fun assertRichKept(r: RuntimeState) {
        assertTrue("reasoningEnabled", r.reasoningEnabled)
        assertTrue("reasoningDisplayInChat", r.reasoningDisplayInChat)
        assertTrue("customEchoReasoning", r.customEchoReasoning)
        assertEquals("customConfigSignature", "sig-x", r.customConfigSignature)
    }

    @Test
    fun `fold 2 - an ordinary reconcile patches the selection only - all four other fields kept`() {
        base(rt = rich)
        load()
        val r = runtimeRecord()
        assertEquals(I, ModelTuple(r.provider, r.authType, r.model))
        assertRichKept(r)
    }

    @Test
    fun `fold 2 - recovery patches the selection only - all four other fields kept`() {
        base(rt = rich)
        doubleFailure()
        restart()
        load()
        val r = runtimeRecord()
        assertEquals(I, ModelTuple(r.provider, r.authType, r.model))
        assertRichKept(r)
    }

    @Test
    fun `fold 2 - Custom signature policy - a new Custom identity resets the echo override, the same one keeps it`() {
        val m1 = ModelTuple("custom", "api_key", "m1")
        val m2 = ModelTuple("custom", "api_key", "m2")
        // Reconcile (the signature is known): a different identity resets the override.
        seedPrefs(m1)
        writeRuntime(m1, rich)
        writeOverlay(m2)
        mainProcess()
        load()
        var r = runtimeRecord()
        assertEquals("m2", r.model)
        assertFalse("override not carried into a new Custom identity", r.customEchoReasoning)
        assertEquals(CustomConfigSignature.compute("m2", "", "chat_completions", ""), r.customConfigSignature)
        assertTrue("reasoning kept", r.reasoningEnabled && r.reasoningDisplayInChat)
        // Switching back to the SAME Custom identity keeps the override (saveConfig's rule).
        fresh()
        val sig = CustomConfigSignature.compute("m2", "", "chat_completions", "")
        seedPrefs(ModelTuple("openai", "api_key", "gpt-6.1-sol"))
        writeRuntime(ModelTuple("openai", "api_key", "gpt-6.1-sol"), rich.copy(customConfigSignature = sig))
        writeOverlay(m2)
        mainProcess()
        load()
        r = runtimeRecord()
        assertEquals("custom", r.provider)
        assertTrue("same identity: the override is kept", r.customEchoReasoning)
        assertEquals(sig, r.customConfigSignature)
        // Recovery (the signature is not computed under the lock): a different identity resets it.
        fresh()
        seedPrefs(m1)
        writeRuntime(m1, rich)
        writeOverlay(m2)
        mainProcess()
        doubleFailure()
        restart()
        load()
        r = runtimeRecord()
        assertEquals("m2", r.model)
        assertFalse(r.customEchoReasoning)
        assertNull("recomputed by the next save", r.customConfigSignature)
        assertTrue(r.reasoningEnabled && r.reasoningDisplayInChat)
    }

    // ---------------------------------------------------------------- fold 3 (binding)

    /** Double failure with [overlayText], a new process, then the overlay replaced by [now]. */
    private fun resolveAfterOverlay(overlayText: String, now: String?): ReconcileRecord.Outcome {
        seedPrefs(P)
        writeRuntime(P)
        writeOverlayRaw(overlayText)
        mainProcess()
        doubleFailure()
        restart()
        if (now != null) writeOverlayRaw(now)
        return resolveNow()
    }

    @Test
    fun `fold 3 - raw evidence - unchanged, model-less, provider-only, introduced blank or malformed, auth change`() {
        val full = """{"heartbeatIntervalMinutes":30,"provider":"xai","authType":"api_key","model":"grok-4.6"}"""
        assertTrue("unchanged raw selection", resolveAfterOverlay(full, full.replace("30", "45")) is ReconcileRecord.Outcome.Recovered)
        fresh()
        assertTrue("model-less", resolveAfterOverlay(full, """{"heartbeatIntervalMinutes":30}""") is ReconcileRecord.Outcome.Recovered)
        // Captured provider-only (no model key): the reconcile took the provider default.
        val providerOnly = """{"heartbeatIntervalMinutes":30,"provider":"xai","authType":"api_key"}"""
        fresh()
        assertTrue("captured provider-only, unchanged", resolveAfterOverlay(providerOnly, providerOnly) is ReconcileRecord.Outcome.Recovered)
        for (introduced in listOf("\"\"", "7", "null", "\"  \"")) {
            fresh()
            val out = resolveAfterOverlay(providerOnly, providerOnly.replace("}", ""","model":$introduced}"""))
            assertEquals("introduced model $introduced", ReconcileRecord.Outcome.Superseded(ReconcileRecord.DROP_OVERLAY_NEWER), out)
        }
        fresh()
        val authChange = resolveAfterOverlay(full, full.replace("\"api_key\"", "\"oauth\""))
        assertEquals("a real auth change with the model unchanged", ReconcileRecord.Outcome.Superseded(ReconcileRecord.DROP_OVERLAY_NEWER), authChange)
        fresh()
        val blankProvider = resolveAfterOverlay(full, full.replace("\"xai\"", "\"\""))
        assertEquals("a provider key made blank", ReconcileRecord.Outcome.Superseded(ReconcileRecord.DROP_OVERLAY_NEWER), blankProvider)
    }

    @Test
    fun `fold 3 - the record captures the raw selection apart from the normalised tuple`() {
        base()
        doubleFailure()
        val rec = (ReconcileRecord.read(dir) as ReconcileRecord.Read.Present).record
        assertEquals(mapOf("provider" to "\"xai\"", "authType" to "\"api_key\"", "model" to "\"grok-4.6\""), rec.overlaySelection)
        assertEquals(ReconcileRecord.RawTuple("xai", "api_key", "grok-4.6"), rec.overlay)
        assertEquals(ReconcileRecord.RawTuple("openai", "oauth", "gpt-6-astra"), rec.prefsBefore)
        assertEquals(ReconcileRecord.RawTuple("xai", "api_key", "grok-4.6"), rec.prefsAfter)
        assertEquals(ReconcileRecord.RuntimeCapture(ReconcileRecord.STATE_PRESENT, P), rec.runtime)
    }

    // ---------------------------------------------------------------- fold 4 (binding)

    @Test
    fun `fold 4 - an exception after the prefs commit keeps the record and holds the writers`() {
        base()
        RuntimeStateStore.beforeWriteVerifiedForTest = { throw IllegalArgumentException("injected validation failure") }
        val a = anchor()
        load()
        assertTrue(logsSince(a).any { it.level == LogLevel.WARN && it.message.startsWith("[Config] Reconcile produced invalid RuntimeState") })
        assertTrue("the record is KEPT", recordPresent())
        assertEquals("xai", prefs.disk["provider"])
        assertEquals(P, runtimeTuple())
        val recordBefore = recordBytes()
        // Still throwing: the next load's recovery is Failed, the record unchanged, nothing written.
        val b = anchor()
        load()
        assertTrue(logsSince(b).any { it.message.startsWith("[Config] Reconcile not finished after a restart:") })
        assertArrayEquals(recordBefore, recordBytes())
        assertEquals(P, runtimeTuple())
        RuntimeStateStore.beforeWriteVerifiedForTest = null
        val c = anchor()
        load()
        assertEquals(1, logsSince(c).count(RECOVERED_I))
        assertEquals(I, runtimeTuple())
    }

    // ---------------------------------------------------------------- fold 5 (binding)

    // ===================================================== review round (fold 5 hazards, m1–m4, SAB)

    @Test
    fun `m3 and m7 - the xAI sync while a record is held is HELD - record and runtime_state unchanged`() {
        signedIn()
        val p = ModelTuple("xai", "api_key", "grok-4.6")
        seedPrefs(p)
        writeRuntime(p)
        writeOverlay(XO)
        mainProcess()
        doubleFailure() // the process is tainted: Deferred
        val recordBefore = recordBytes()
        val runtimeBefore = Files.readAllBytes(runtimePath())
        val a = anchor()
        assertEquals(ConfigManager.XaiAuthSync.HELD, ConfigManager.syncXaiRuntimeAuthType(ctx, lockTimeoutMs = 50, attempts = 1))
        assertTrue(logsSince(a).any { it.level == LogLevel.WARN && it.message == ReconcileRecord.XAI_SYNC_HELD })
        assertFalse("not reported as a storage failure", logsSince(a).any { it.message.startsWith("[Config] xAI OAuth runtime_state sync failed") })
        assertArrayEquals(recordBefore, recordBytes())
        assertArrayEquals(runtimeBefore, Files.readAllBytes(runtimePath()))
    }

    @Test
    fun `m4 - recovery's Custom policy is deliberately stricter than the reconcile's`() {
        val m2 = ModelTuple("custom", "api_key", "m2")
        val sig = CustomConfigSignature.compute("m2", "", "chat_completions", "")
        val from = ModelTuple("openai", "api_key", "gpt-6.1-sol")
        // The reconcile proves the identity by its signature and keeps the override (pinned above);
        // recovery cannot compute it under the lock, so the same switch resets it.
        seedPrefs(from)
        writeRuntime(from, rich.copy(customConfigSignature = sig))
        writeOverlay(m2)
        mainProcess()
        doubleFailure()
        restart()
        load()
        val r = runtimeRecord()
        assertEquals("custom", r.provider)
        assertFalse("recovery resets the override: it cannot prove the same gateway", r.customEchoReasoning)
        assertNull(r.customConfigSignature)
        assertTrue("the reasoning toggles are still kept", r.reasoningEnabled && r.reasoningDisplayInChat)
    }

    @Test
    fun `SAB v54 - an Unavailable record is a Logs-screen WARN, once per process`() {
        base()
        doubleFailure()
        restart()
        ReconcileRecord.beforeReadForTest = { throw IOException("injected read failure") }
        val a = anchor()
        try {
            repeat(3) { load() }
            assertEquals(1, logsSince(a).count { it.level == LogLevel.WARN && it.message.startsWith("[Config] Reconcile: retry record not readable (") })
            restart()
            ReconcileRecord.beforeReadForTest = { throw IOException("injected read failure") }
            repeat(2) { load() }
        } finally {
            disarm()
        }
        assertEquals("once more in the next process", 2, logsSince(a).count { it.message.startsWith("[Config] Reconcile: retry record not readable (") })
    }

    @Test
    fun `SAB v54 - a failed runtime_state confirm is a Logs-screen WARN, once per process`() {
        base()
        ReconcileRecord.beforeClearForTest = { throw Crash() }
        expectCrash { load() }
        restart()
        val pl = PowerLossFs()
        pl.install()
        pl.syncFails = true
        val a = anchor()
        try {
            repeat(3) { load() }
        } finally {
            pl.syncFails = false
            pl.uninstall()
        }
        val warns = logsSince(a).filter { it.message.startsWith("[Config] Reconcile: runtime_state.json not confirmed on disk (") }
        assertEquals(1, warns.size)
        assertEquals(LogLevel.WARN, warns.single().level)
        assertTrue("held, record kept", recordPresent())
    }

    // ============================================= CodeRabbit on 8a477a47 (round 13)

    @Test
    fun `CR 4628273764 - a reconcile in the xAI sync's own load that leaves a record is HELD, never SYNCED`() {
        xaiTokens(XaiOAuthTokens()) // no token yet: runtime_state holds the H5 guard image
        seedPrefs(XO)
        writeRuntime(ModelTuple("xai", "api_key", "grok-4.6"))
        writeOverlay(ModelTuple("xai", "oauth", "grok-4.6-fast")) // Node /model B
        mainProcess()
        signedIn() // the sign-in lands: a sync would now patch the auth to oauth
        var firstRuntimeMove = true
        SafeFs.beforeMove = { _, t ->
            if (isRuntime(t) && firstRuntimeMove) {
                firstRuntimeMove = false
                throw IOException("injected runtime_state write failure") // the reconcile's own write
            }
        }
        val runtimeBefore = Files.readAllBytes(runtimePath())
        val sync = try {
            ConfigManager.syncXaiRuntimeAuthType(ctx, lockTimeoutMs = 50, attempts = 1)
        } finally {
            disarm()
        }
        assertEquals("the load's reconcile left its record unresolved", ConfigManager.XaiAuthSync.HELD, sync)
        assertTrue(recordPresent())
        assertArrayEquals("the old runtime record's auth was not patched", runtimeBefore, Files.readAllBytes(runtimePath()))
    }

    @Test
    fun `CR 4628273773 - a held reconcile projecting another provider is HELD before any early success`() {
        signedIn()
        seedPrefs(ModelTuple("xai", "api_key", "grok-4.6"))
        writeRuntime(ModelTuple("xai", "api_key", "grok-4.6"))
        writeOverlay(ModelTuple("openai", "api_key", "gpt-6.1-sol")) // the overlay projects another provider
        mainProcess()
        doubleFailure() // tainted: Deferred, held
        val runtimeBefore = Files.readAllBytes(runtimePath())
        val recordBefore = recordBytes()
        assertEquals(ConfigManager.XaiAuthSync.HELD, ConfigManager.syncXaiRuntimeAuthType(ctx, lockTimeoutMs = 50, attempts = 1))
        assertArrayEquals(runtimeBefore, Files.readAllBytes(runtimePath()))
        assertArrayEquals(recordBefore, recordBytes())
    }

    @Test
    fun `CR ff5fc5be - a held xAI sync with NO xai runtime record (non-xai or missing) is HELD, the hold comes before the disk shortcut`() {
        for (missing in listOf(false, true)) {
            fresh()
            signedIn()
            base() // prefs P (openai), runtime_state P (openai), the overlay on I (xai)
            doubleFailure() // tainted: Deferred, held; runtime_state still holds openai
            if (missing) Files.delete(runtimePath())
            val runtimeBefore = if (missing) null else Files.readAllBytes(runtimePath())
            val recordBefore = recordBytes()
            val a = anchor()
            assertEquals("missing=$missing", ConfigManager.XaiAuthSync.HELD, ConfigManager.syncXaiRuntimeAuthType(ctx, lockTimeoutMs = 50, attempts = 1))
            assertTrue(logsSince(a).any { it.level == LogLevel.WARN && it.message == ReconcileRecord.XAI_SYNC_HELD })
            if (missing) assertFalse("nothing seeded", Files.exists(runtimePath())) else assertArrayEquals(runtimeBefore, Files.readAllBytes(runtimePath()))
            assertArrayEquals(recordBefore, recordBytes())
        }
    }

    @Test
    fun `CR 4628273784 - a scope key changed to the scope value next to the OLD model supersedes`() {
        val captured = """{"provider":"openai","authType":"api_key","model":"gpt-5.4"}"""
        val authOnly = """{"provider":"openai","authType":"oauth","model":"gpt-5.4"}"""
        assertTrue(ModelRepair.classifyIntent(repairIntent(captured), snapshot(authOnly)) is ModelRepair.IntentClass.Superseded)
        // The repair's own write — the target model, then its scope — is still accepted.
        val own = """{"provider":"openai","authType":"oauth","model":"gpt-6.1-sol"}"""
        assertTrue(ModelRepair.classifyIntent(repairIntent(captured), snapshot(own)) is ModelRepair.IntentClass.Pending)
    }

    // ============================ review of the CodeRabbit round: a marked restart is never lost

    // ======================================== Codex a5c902b6 (finding 4) and the D12.7/Q15 guard

    @Test
    fun `Codex finding 4 - recovery onto the same Custom model id at another gateway resets the echo override`() {
        // Gateway A's record holds the echo override; the user's Custom settings now name gateway B
        // with the SAME model id. The runtime record is unreadable to Node (an invalid pair), so
        // recovery rebuilds it from the decoded fields: the override must not survive.
        val sigA = CustomConfigSignature.compute("m1", "https://gateway-a.example/v1", "chat_completions", "")
        val sigB = CustomConfigSignature.compute("m1", "https://gateway-b.example/v1", "chat_completions", "")
        assertNotEquals("two gateway identities, one model id", sigA, sigB)
        val target = ModelTuple("custom", "api_key", "m1")
        prefs.seed(
            "setup_complete" to true, "provider" to "custom", "auth_type" to "api_key", "model" to "m1",
            "custom_base_url" to "https://gateway-b.example/v1", "custom_format" to "chat_completions",
        )
        Files.write(
            runtimePath(),
            ("""{"provider":"custom","authType":"oauth","model":"m1","reasoningEnabled":true,""" +
                """"reasoningDisplayInChat":true,"customEchoReasoning":true,"customConfigSignature":"$sigA"}""").toByteArray(),
        )
        assertTrue(RuntimeStateFile.read(dir) is RuntimeStateFile.Read.Unreadable)
        writeOverlay(target)
        val obj = (AgentSettingsFile.read(dir) as AgentSettingsFile.Read.Present).obj
        Files.write(
            ReconcileRecord.path(dir),
            enc.encodeToString(
                ReconcileRecord.Record.serializer(),
                ReconcileRecord.Record(
                    prefsBefore = ReconcileRecord.RawTuple("openai", "api_key", "gpt-6.1-sol"),
                    prefsAfter = ReconcileRecord.RawTuple("custom", "api_key", "m1"),
                    target = target,
                    runtime = ReconcileRecord.RuntimeCapture(ReconcileRecord.STATE_UNREADABLE),
                    overlay = ReconcileRecord.RawTuple("custom", "api_key", "m1"),
                    overlaySelection = ModelRepair.rawSelection(obj),
                ),
            ).toByteArray(),
        )
        val recordText = String(recordBytes(), Charsets.UTF_8)
        assertFalse("no gateway or secret in the record", recordText.contains("gateway-") || recordText.contains("sig"))
        mainProcess()
        assertTrue(resolveNow() is ReconcileRecord.Outcome.Recovered)
        val r = runtimeRecord()
        assertEquals(target, ModelTuple(r.provider, r.authType, r.model))
        assertFalse("the override is not carried to gateway B", r.customEchoReasoning)
        assertNull("the signature is recomputed by the next save", r.customConfigSignature)
        assertTrue("the reasoning toggles are kept", r.reasoningEnabled && r.reasoningDisplayInChat)
    }

    @Test
    fun `D12_7 and Q15 - a readable metadata-only overlay carries no selection, changed or invalid selection keys do`() {
        val full = """{"heartbeatIntervalMinutes":30,"provider":"xai","authType":"api_key","model":"grok-4.6"}"""
        // A readable object with none of provider / authType / model: no selection evidence, whatever else changed.
        for (metadataOnly in listOf("""{"heartbeatIntervalMinutes":45}""", """{"maxStepsPerTurn":20,"apiKeys":{"brave":"x"}}""", "{}")) {
            fresh()
            assertTrue("metadata-only $metadataOnly", resolveAfterOverlay(full, metadataOnly) is ReconcileRecord.Outcome.Recovered)
        }
        // Counterexamples: an introduced invalid or changed selection key supersedes.
        for (newer in listOf(
            """{"heartbeatIntervalMinutes":45,"authType":7}""",
            """{"heartbeatIntervalMinutes":45,"provider":null}""",
            """{"heartbeatIntervalMinutes":45,"model":"grok-4.6-fast"}""",
        )) {
            fresh()
            assertEquals(newer, ReconcileRecord.Outcome.Superseded(ReconcileRecord.DROP_OVERLAY_NEWER), resolveAfterOverlay(full, newer))
        }
    }

    // ===================================== fold 5′ (Codex 90fed4d6): the "restart to apply" notice

    private fun notice(): RestartNotice.Notice? = (RestartNotice.read(dir) as? RestartNotice.Read.Present)?.notice

    /** The P → I change (a provider and sign-in change) left half-done: record kept, prefs on I, runtime on R0. */
    private fun interruptedProviderChange() {
        base()
        doubleFailure()
        restart()
    }

    @Test
    fun `5p - Recovered saves a notice for the SELECTION before the record goes, and logs it`() {
        interruptedProviderChange()
        val a = anchor()
        load()
        assertEquals(I, notice()?.selection)
        assertEquals(ReconcileRecord.Read.Absent, ReconcileRecord.read(dir))
        assertTrue(logsSince(a).has(RestartNotice.noticeSaved("xai", "api_key", "grok-4.6")))
        assertEquals("the UI was told after the release", I, RestartNotice.state.value?.selection)
    }

    @Test
    fun `5p - a model-only correction saves no notice`() {
        modelOnlyDoubleFailure()
        load()
        assertNull(notice())
    }

    @Test
    fun `5p - the notice holds the selection, not the H5 runtime image`() {
        xaiTokens(XaiOAuthTokens()) // no token: runtime_state gets the api_key guard image
        base(overlay = XO)
        doubleFailure()
        restart()
        load()
        assertEquals(ModelTuple("xai", "api_key", "grok-4.6"), runtimeTuple())
        assertEquals("what a boot consumes as its config", XO, notice()?.selection)
    }

    @Test
    fun `5p - crash before the notice is saved - the record survives, the next load saves it`() {
        interruptedProviderChange()
        RestartNotice.beforeWriteForTest = { throw Crash() }
        expectCrash { load() }
        RestartNotice.beforeWriteForTest = null
        assertEquals("runtime_state was written", I, runtimeTuple())
        assertNull(notice())
        assertTrue("the evidence is kept", recordPresent())
        restart()
        load()
        assertEquals(I, notice()?.selection)
        assertEquals(ReconcileRecord.Read.Absent, ReconcileRecord.read(dir))
    }

    // ============ Codex 54dc46e5 (fix 1): a visible notice is re-proved before the record may go

    private fun isNotice(t: Path) = t.fileName.toString() == RestartNotice.NAME

    /**
     * PowerLossFs, with the checked directory fsync failing right after a notice rename (and only
     * then) while [noticeSyncFails] says so. Every other rename's fsync succeeds.
     */
    private fun <T> withNoticeSyncFailure(noticeSyncFails: () -> Boolean, block: (PowerLossFs) -> T): T {
        val pl = PowerLossFs()
        pl.install()
        val inner = SafeFs.beforeMove
        SafeFs.beforeMove = { tmpf, t -> inner(tmpf, t); pl.syncFails = isNotice(t) && noticeSyncFails() }
        try {
            return block(pl)
        } finally {
            SafeFs.beforeMove = inner
            pl.syncFails = false
            pl.uninstall()
        }
    }

    @Test
    fun `Codex 54dc46e5 - a notice visible behind a failed fsync is re-proved by a rewrite before the record goes, and survives power loss`() {
        interruptedProviderChange()
        val noticePath = RestartNotice.path(dir)
        var failNext = true
        withNoticeSyncFailure({ failNext.also { failNext = false } }) { pl ->
            load() // Recovered: runtime_state confirmed on I; the notice rename is visible, its fsync fails
            assertEquals("runtime_state is confirmed", I, runtimeTuple())
            assertTrue("runtime_state is durable", pl.isDurable(runtimePath()))
            val first = notice()
            assertEquals("visible", I, first?.selection)
            assertFalse("not durable", pl.isDurable(noticePath))
            assertTrue("the recovery evidence is kept while the notice is unconfirmed", recordPresent())
            // The record may go only once the notice is durable.
            ReconcileRecord.beforeClearForTest = {
                assertTrue("never discarded while the notice is unconfirmed", pl.isDurable(noticePath))
            }
            try {
                load() // I/O restored: Completed — the existing notice is rewritten byte for byte
            } finally {
                ReconcileRecord.beforeClearForTest = null
            }
            assertEquals(ReconcileRecord.Read.Absent, ReconcileRecord.read(dir))
            assertTrue(pl.isDurable(noticePath))
            pl.powerLoss()
            assertEquals("same identity and timestamp, and it survived", first, notice())
            assertEquals(I, runtimeTuple())
        }
    }

    @Test
    fun `Codex 54dc46e5 - repeated notice confirmation failure keeps the record every time, power loss loses only the notice, the next load restores it`() {
        interruptedProviderChange()
        val noticePath = RestartNotice.path(dir)
        val a = anchor()
        val first = withNoticeSyncFailure({ true }) { pl ->
            load()
            val n = notice()
            assertNotNull(n)
            repeat(3) {
                load()
                assertTrue("the record is kept after confirmation failure ${it + 1}", recordPresent())
                assertFalse(pl.isDurable(noticePath))
                assertEquals("identity and timestamp stable", n, notice())
            }
            pl.powerLoss()
            n
        }
        assertEquals("WARN once per process", 1, logsSince(a).count { it.level == LogLevel.WARN && it.message.startsWith("[Config] Reconcile: restart notice not saved (") })
        assertNull("the unconfirmed notice did not survive", notice())
        assertTrue("the evidence survived", recordPresent())
        assertEquals("runtime_state was confirmed", I, runtimeTuple())
        load()
        assertEquals(I, notice()?.selection)
        assertNotEquals("a new notice", first!!.id, notice()!!.id)
        assertEquals(ReconcileRecord.Read.Absent, ReconcileRecord.read(dir))
    }

    // ===== Codex 54dc46e5 (fix 2): an explicit xAI API-key choice is a newer selection, not the guard

    /** Notice XO (xai/oauth) with runtime_state on its H5 guard image (xai, api_key, grok-4.6). */
    private fun xaiOAuthNoticeOnGuardImage() {
        xaiTokens(XaiOAuthTokens()) // the empty OAuth family: the guard image
        base(overlay = XO)
        doubleFailure()
        restart()
        load()
        assertEquals(ModelTuple("xai", "api_key", "grok-4.6"), runtimeTuple())
        assertEquals(XO, notice()?.selection)
    }

    /** Node's `/provider xai api_key`: the overlay first, then runtime_state. */
    private fun chatXaiApiKey() {
        writeOverlay(ModelTuple("xai", "api_key", "grok-4.6"))
        writeRuntime(ModelTuple("xai", "api_key", "grok-4.6"))
    }

    @Test
    fun `Codex 54dc46e5 - a genuine OAuth guard image keeps the xAI OAuth notice current`() {
        xaiOAuthNoticeOnGuardImage()
        val n = notice()!!
        mirror()
        invalidateNow()
        load()
        assertEquals("kept: the guard image is the OAuth selection", n, notice())
        assertTrue(RestartNotice.isCurrent(n, null, dir))
        // Prefs lagging (still the old selection) and only runtime_state's guard image holding it.
        assertTrue(RestartNotice.isCurrent(n, MainPrefs.view(FakePrefs()), dir))
        assertTrue(RestartNotice.visible(n, running = true, healthStale = false, MainPrefs.view(prefs), dir))
    }

    @Test
    fun `Codex 54dc46e5 - an explicit chat API-key choice, then the mirror and the load, invalidate the OAuth notice, and the start leaves none`() {
        xaiOAuthNoticeOnGuardImage()
        chatXaiApiKey()
        mirror() // MAIN adopts the API-key choice
        assertEquals("api_key", prefs.disk["auth_type"])
        assertNull("invalidated: a newer selection", notice())
        load()
        assertNull(notice())
        // A successful start on the API-key selection: no notice to clear, none left, no Settings or Reset needed.
        nodeProcess()
        val consumed = serviceStart()
        assertEquals(ModelTuple("xai", "api_key", "grok-4.6"), ModelTuple(consumed.provider, consumed.authType, consumed.model))
        assertFalse(RestartNotice.clearIfStartedOn(dir, ModelTuple(consumed.provider, consumed.authType, consumed.model)))
        mainProcess()
        assertNull(notice())
    }

    @Test
    fun `Codex 54dc46e5 - an explicit chat API-key choice whose notice delete fails hides the notice, the next load removes it`() {
        xaiOAuthNoticeOnGuardImage()
        chatXaiApiKey()
        RestartNotice.beforeDeleteForTest = { throw IOException("injected notice delete failure") }
        val a = anchor()
        try {
            mirror()
        } finally {
            RestartNotice.beforeDeleteForTest = null
        }
        assertTrue(logsSince(a).any { it.level == LogLevel.WARN && it.message == RestartNotice.noticeInvalidateFailed("injected notice delete failure") })
        val stale = notice()!!
        assertFalse("hidden: obsolete", RestartNotice.visible(stale, running = true, healthStale = false, MainPrefs.view(prefs), dir))
        load()
        assertNull(notice())
    }

    @Test
    fun `5p - crash after the notice is saved, before or during the record clear - the notice is reused`() {
        interruptedProviderChange()
        ReconcileRecord.beforeClearForTest = { throw Crash() }
        expectCrash { load() }
        val first = notice()
        assertNotNull("the notice came first", first)
        assertTrue(recordPresent())
        restart()
        load() // Completed
        assertEquals("same identity and timestamp", first, notice())
        assertEquals(ReconcileRecord.Read.Absent, ReconcileRecord.read(dir))
    }

    @Test
    fun `5p - repeated Completed outcomes reuse one notice (identity and timestamp stable)`() {
        interruptedProviderChange()
        ReconcileRecord.beforeClearForTest = { throw IOException("injected delete failure") } // the record stays Completed
        var t = 1_000L
        RestartNotice.clock = { t++ }
        try {
            load()
            val first = notice()!!
            repeat(3) { load(); mirror() }
            assertEquals(first, notice())
        } finally {
            disarm()
        }
    }

    @Test
    fun `5p - a failed notice write keeps the record, never rolls back runtime_state, and retries`() {
        interruptedProviderChange()
        RestartNotice.beforeWriteForTest = { throw IOException("injected notice write failure") }
        val a = anchor()
        try {
            repeat(2) { load() }
        } finally {
            RestartNotice.beforeWriteForTest = null
        }
        assertEquals("the confirmed runtime bytes stay", I, runtimeTuple())
        assertTrue("the recovery evidence is kept", recordPresent())
        assertNull(notice())
        assertEquals("WARN once per process", 1, logsSince(a).count { it.level == LogLevel.WARN && it.message.startsWith("[Config] Reconcile: restart notice not saved (") })
        load()
        assertEquals(I, notice()?.selection)
        assertEquals(ReconcileRecord.Read.Absent, ReconcileRecord.read(dir))
    }

    @Test
    fun `5p - a failed notice clear at start logs a WARN, and the next start on the selection clears it`() {
        interruptedProviderChange()
        load()
        RestartNotice.beforeDeleteForTest = { throw IOException("injected notice delete failure") }
        val a = anchor()
        try {
            assertFalse(RestartNotice.clearIfStartedOn(dir, I))
        } finally {
            RestartNotice.beforeDeleteForTest = null
        }
        assertTrue(logsSince(a).any { it.level == LogLevel.WARN && it.message.startsWith("[Config] restart notice not cleared at start (") })
        assertNotNull("kept: the agent runs it, so it is still current", notice())
        assertTrue("checked again at the next start", RestartNotice.clearIfStartedOn(dir, I))
        assertNull(notice())
    }

    @Test
    fun `5p - a failed invalidation is hidden at once, kept while a load is held, removed by the next unheld load`() {
        interruptedProviderChange()
        load()
        val b = ModelTuple("openai", "api_key", "gpt-6.1-sol")
        RestartNotice.beforeDeleteForTest = { throw IOException("injected notice delete failure") }
        val a = anchor()
        try {
            assertTrue(save(form(I) { it.copy(provider = b.provider, authType = b.authType, model = b.model) }))
        } finally {
            RestartNotice.beforeDeleteForTest = null
        }
        assertTrue(logsSince(a).any { it.level == LogLevel.WARN && it.message == RestartNotice.noticeInvalidateFailed("injected notice delete failure") })
        val stale = notice()!!
        assertFalse("hidden now: neither store holds it", RestartNotice.visible(stale, running = true, healthStale = false, MainPrefs.view(prefs), dir))
        // A held load (an unreadable retry record) is compute-only: it keeps the file.
        Files.write(ReconcileRecord.path(dir), validRecordJson().toByteArray())
        ReconcileRecord.beforeReadForTest = { throw IOException("injected read failure") }
        try {
            load()
        } finally {
            ReconcileRecord.beforeReadForTest = null
        }
        assertEquals("kept while held", stale, notice())
        // The next unheld load removes it.
        load()
        assertNull("removed the next time the app loads", notice())
    }

    @Test
    fun `5p - a newer selection invalidates the notice, an older resolve cannot recreate it, a queued UI update cannot revive it`() {
        interruptedProviderChange()
        val b = ModelTuple("openai", "api_key", "gpt-6.1-sol")
        var once = true
        RestartNotice.beforeStoreForTest = {
            if (once) {
                once = false
                // The load's UI update has read notice A; before it stores, selection B lands
                // (invalidating A) and B's own UI update runs.
                assertTrue(save(form(I) { it.copy(provider = b.provider, authType = b.authType, model = b.model) }))
            }
        }
        try {
            load()
        } finally {
            RestartNotice.beforeStoreForTest = null
        }
        assertNull("invalidated by the newer selection", notice())
        assertNull("the queued older update did not revive A", RestartNotice.state.value)
        load()
        assertNull("no resolve can recreate A after B", notice())
        assertEquals(b, runtimeTuple())
    }

    @Test
    fun `5p - a stale boot completion cannot clear a newer notice, a start on its selection clears it`() {
        interruptedProviderChange()
        load()
        val a = anchor()
        assertFalse("a boot that consumed the OLD selection", RestartNotice.clearIfStartedOn(dir, P))
        assertFalse("another model", RestartNotice.clearIfStartedOn(dir, I.copy(model = "grok-4.6-fast")))
        assertNotNull(notice())
        assertTrue("a successful start on the notice's selection", RestartNotice.clearIfStartedOn(dir, I))
        assertNull(notice())
        assertTrue(logsSince(a).has(RestartNotice.noticeCleared("xai", "api_key", "grok-4.6")))
    }

    @Test
    fun `CR fold 5p - the node delete at RUNNING reaches MAIN through the filesDir event, after a read that ran before it`() {
        interruptedProviderChange()
        load()
        assertEquals("MAIN shows I (its RUNNING-triggered read ran before the delete)", I, RestartNotice.state.value?.selection)
        nodeProcess()
        assertTrue(RestartNotice.clearIfStartedOn(dir, I)) // :node, at RUNNING
        mainProcess()
        assertEquals("no in-process signal: the cache is stale", I, RestartNotice.state.value?.selection)
        RestartNotice.handleFilesDirEvent(dir, "service_logs") // another file's event changes nothing
        assertEquals(I, RestartNotice.state.value?.selection)
        RestartNotice.handleFilesDirEvent(dir, RestartNotice.NAME) // the DELETE event on the notice file
        assertNull("re-read after the delete: hidden", RestartNotice.state.value)
        assertFalse(RestartNotice.visible(RestartNotice.state.value, running = true, healthStale = false, MainPrefs.view(prefs), dir))
    }

    @Test
    fun `CR 00a3a05a - a MISSED filesDir event - the foreground catch-up re-read still hides the cleared notice`() {
        interruptedProviderChange()
        load()
        assertEquals(I, RestartNotice.state.value?.selection)
        nodeProcess()
        assertTrue(RestartNotice.clearIfStartedOn(dir, I)) // :node, at RUNNING
        mainProcess()
        // The DELETE event is dropped (BAT-513): no handleFilesDirEvent call. The cache is stale.
        assertEquals(I, RestartNotice.state.value?.selection)
        // The dashboard's 1.5 s catch-up re-read (the same call the loop makes).
        RestartNotice.refreshAsync(dir)
        assertNull("the catch-up re-read hides it without the event", RestartNotice.state.value)
        assertFalse(RestartNotice.visible(RestartNotice.state.value, running = true, healthStale = false, MainPrefs.view(prefs), dir))
    }

    @Test
    fun `5p - a completed Reset invalidates the notice`() {
        xaiTokens(XaiOAuthTokens())
        interruptedProviderChange()
        load()
        assertNotNull(notice())
        ConfigManager.deleteKeystoreKey = {}
        assertEquals(ConfigManager.ResetResult.Done, ConfigManager.resetConfig(ctx))
        assertNull(notice())
    }

    @Test
    fun `5p - the notice survives an app reopen`() {
        interruptedProviderChange()
        load()
        val n = notice()
        RestartNotice.resetForTest() // a new MAIN process: nothing in memory
        RestartNotice.execute = { it.run() }
        assertNull(RestartNotice.state.value)
        RestartNotice.refreshAsync(dir)
        assertEquals(n, RestartNotice.state.value)
    }

    @Test
    fun `5p - the notice is shown only while the agent is proven live`() {
        interruptedProviderChange()
        load()
        val n = notice()!!
        val v = MainPrefs.view(prefs)
        assertTrue(RestartNotice.visible(n, running = true, healthStale = false, v, dir))
        assertFalse("stopped", RestartNotice.visible(n, running = false, healthStale = false, v, dir))
        assertFalse("a stale persisted RUNNING", RestartNotice.visible(n, running = true, healthStale = true, v, dir))
        assertFalse("no notice", RestartNotice.visible(null, running = true, healthStale = false, v, dir))
    }

    // ================= fold 5′ review: every selection writer invalidates an orphaned notice

    private fun invalidateNow() = ModelSelectionLock.transaction { tx -> RestartNotice.invalidateIfOrphaned(tx, dir, MainPrefs.view(prefs)) }

    private val B = ModelTuple("openai", "api_key", "gpt-6.1-sol")

    @Test
    fun `chat provider B while notice A is pending - the real reconcile path invalidates A, no notice for B`() {
        interruptedProviderChange()
        load()
        assertEquals(I, notice()?.selection)
        writeOverlay(B) // Node /provider B: the overlay, then runtime_state
        writeRuntime(B)
        load() // MAIN reconciles B into prefs
        assertEquals("openai", prefs.disk["provider"])
        assertNull("A is no longer stored: invalidated", notice())
        assertEquals(B, runtimeTuple())
    }

    @Test
    fun `chat provider B while notice A is pending - the real mirror path invalidates A, no notice for B`() {
        interruptedProviderChange()
        load()
        writeOverlay(B)
        writeRuntime(B)
        assertEquals(ModelSelectionLock.Result.Acquired(true), mirror()) // the collector mirrors B into prefs
        assertEquals("api_key", prefs.disk["auth_type"])
        assertNull(notice())
    }

    @Test
    fun `the reconcile that creates notice A does not invalidate A`() {
        interruptedProviderChange()
        load()
        assertEquals(I, notice()?.selection)
        invalidateNow()
        assertEquals("still current", I, notice()?.selection)
    }

    @Test
    fun `a busy start-clear logs the WARN, never silent`() {
        interruptedProviderChange()
        load()
        val a = anchor()
        // Called from inside a transaction on this thread: every try is refused (nested).
        val r = ModelSelectionLock.transaction { RestartNotice.clearIfStartedOn(dir, I) }
        assertEquals(ModelSelectionLock.Result.Acquired(false), r)
        assertTrue(logsSince(a).any { it.level == LogLevel.WARN && it.message == RestartNotice.noticeClearFailed("busy") })
        assertNotNull(notice())
    }

    @Test
    fun `a model repair that changes the boot model - after MAIN converges prefs the notice is gone, not stuck`() {
        // A provider change to openai/oauth on a retired model: recovery saves notice (openai, oauth, gpt-5.4).
        val target = ModelTuple("openai", "oauth", "gpt-5.4")
        seedPrefs(target)
        writeRuntime(ModelTuple("xai", "api_key", "grok-4.6"))
        val overlay = """{"heartbeatIntervalMinutes":30,"provider":"openai","authType":"oauth","model":"gpt-5.4"}"""
        writeOverlayRaw(overlay)
        Files.write(
            ReconcileRecord.path(dir),
            enc.encodeToString(
                ReconcileRecord.Record.serializer(),
                ReconcileRecord.Record(
                    prefsBefore = ReconcileRecord.RawTuple("xai", "api_key", "grok-4.6"),
                    prefsAfter = ReconcileRecord.RawTuple("openai", "oauth", "gpt-5.4"),
                    target = target,
                    runtime = ReconcileRecord.RuntimeCapture(ReconcileRecord.STATE_PRESENT, ModelTuple("xai", "api_key", "grok-4.6")),
                    overlay = ReconcileRecord.RawTuple("openai", "oauth", "gpt-5.4"),
                    overlaySelection = ModelRepair.rawSelection(Json.parseToJsonElement(overlay).jsonObject),
                ),
            ).toByteArray(),
        )
        mainProcess()
        load()
        assertEquals(target, notice()?.selection)
        // The agent's boot repairs the retired model: it consumes gpt-6.1-sol, not the notice's model.
        nodeProcess()
        val consumed = serviceStart()
        assertEquals("gpt-6.1-sol", consumed.model)
        assertFalse(RestartNotice.clearIfStartedOn(dir, ModelTuple(consumed.provider, consumed.authType, consumed.model)))
        assertNotNull("not cleared by that start", notice())
        mainProcess()
        load() // MAIN converges prefs on the repaired model
        assertEquals("gpt-6.1-sol", prefs.disk["model"])
        assertNull("the notice's selection is stored nowhere: gone, not stuck", notice())
    }

    /**
     * The Completed-with-prefs-behind window: the resolve saves notice I while prefs still hold P and
     * runtime_state already holds I. It must survive (visible, and the chokepoint keeps it) until the
     * mirror commits I — and afterwards, because prefs then hold I.
     */
    private fun assertSurvivesWindowThenMirror() {
        assertEquals("P", "openai", prefs.memory["provider"]) // prefs behind
        val n = notice()
        assertEquals(I, n?.selection)
        assertTrue("visible in the window", RestartNotice.visible(n, running = true, healthStale = false, MainPrefs.view(prefs), dir))
        invalidateNow()
        assertEquals("the chokepoint keeps it in the window", n, notice())
        assertEquals(ModelSelectionLock.Result.Acquired(true), mirror()) // the mirror commits I
        assertEquals("xai", prefs.memory["provider"])
        assertEquals("kept after the mirror: prefs hold I", n, notice())
        assertTrue(RestartNotice.visible(n, running = true, healthStale = false, MainPrefs.view(prefs), dir))
        load()
        assertEquals(n, notice())
    }

    @Test
    fun `Completed with prefs behind - after a prefs commit that returned false - notice I survives`() {
        base()
        prefs.failCommits = true
        try { load() } finally { disarm() } // prefs stay on P; the record is kept
        restart()
        writeRuntime(I) // runtime_state then holds the target (e.g. Node wrote it)
        assertTrue(resolveNow() is ReconcileRecord.Outcome.Completed)
        assertSurvivesWindowThenMirror()
    }

    @Test
    fun `Completed with prefs behind - in a tainted MAIN process - notice I survives`() {
        base()
        doubleFailure() // tainted: cache P, disk I, runtime_state R0
        writeRuntime(I)
        assertTrue(resolveNow() is ReconcileRecord.Outcome.Completed)
        assertSurvivesWindowThenMirror()
    }

    @Test
    fun `CR isCurrent - prefs behind and runtime_state unreadable - notice I is kept and shown, never deleted on doubt`() {
        base()
        doubleFailure() // tainted: cache P, disk I, runtime_state R0
        writeRuntime(I)
        assertTrue(resolveNow() is ReconcileRecord.Outcome.Completed)
        assertEquals("P", "openai", prefs.memory["provider"]) // prefs behind
        val n = notice()!!
        assertEquals(I, n.selection)
        // A read failure of runtime_state (here: bytes that do not parse) — undecidable.
        Files.write(RuntimeStateFile.path(dir), "{not json".toByteArray())
        assertTrue(RuntimeStateFile.read(dir) is RuntimeStateFile.Read.Unreadable)
        invalidateNow()
        assertEquals("kept: not proven orphaned", n, notice())
        assertTrue("shown: a missing restart prompt is worse than a redundant one", RestartNotice.visible(n, running = true, healthStale = false, MainPrefs.view(prefs), dir))
        // Once both stores are readable and neither holds I, it goes.
        writeRuntime(B)
        invalidateNow()
        assertNull("proven orphaned", notice())
    }

    // ------------------------------------------------------------------ Q17 = (b) (Codex 90fed4d6)

    @Test
    fun `Q17 - deleting captured selection keys gives no replacement choice, each key separately`() {
        val full = """{"heartbeatIntervalMinutes":30,"provider":"xai","authType":"api_key","model":"grok-4.6"}"""
        for (removed in listOf(
            """{"heartbeatIntervalMinutes":30,"authType":"api_key","model":"grok-4.6"}""", // provider removed
            """{"heartbeatIntervalMinutes":30,"provider":"xai","model":"grok-4.6"}""", // authType removed
            """{"heartbeatIntervalMinutes":30,"provider":"xai","authType":"api_key"}""", // model removed
            """{"heartbeatIntervalMinutes":30}""", // all selection keys removed
        )) {
            fresh()
            assertTrue("removal only: $removed", resolveAfterOverlay(full, removed) is ReconcileRecord.Outcome.Recovered)
        }
    }

    @Test
    fun `Q17 - a removed key next to a blank, null or malformed replacement, or a changed remaining key, supersedes`() {
        val full = """{"heartbeatIntervalMinutes":30,"provider":"xai","authType":"api_key","model":"grok-4.6"}"""
        val newer = ReconcileRecord.Outcome.Superseded(ReconcileRecord.DROP_OVERLAY_NEWER)
        for (now in listOf(
            // provider removed, another key replaced by blank / null / malformed
            """{"authType":"","model":"grok-4.6"}""",
            """{"authType":"api_key","model":null}""",
            """{"authType":7,"model":"grok-4.6"}""",
            // authType removed, provider blank / model null / provider malformed
            """{"provider":"","model":"grok-4.6"}""",
            """{"provider":"xai","model":null}""",
            """{"provider":["xai"],"model":"grok-4.6"}""",
            // model removed, a replaced scope key
            """{"provider":"xai","authType":""}""",
            """{"provider":null,"authType":"api_key"}""",
            // a key removed and a remaining key CHANGED
            """{"provider":"xai","model":"grok-4.6-fast"}""",
            """{"authType":"oauth","model":"grok-4.6"}""",
        )) {
            fresh()
            assertEquals(now, newer, resolveAfterOverlay(full, now))
        }
    }

    // ------------------------------------------------------------------ ModelRepair intents

    /** The I1/I3 stores: a model-only record (gpt-6-astra → gpt-5.4) next to a standing repair. */
    private fun repairNeighbour(intentTarget: String, state: String = ModelRepair.STATE_PENDING) {
        val after = ModelTuple("openai", "oauth", "gpt-5.4")
        seedPrefs(after)
        writeRuntime(P)
        val overlay = """{"heartbeatIntervalMinutes":30,"provider":"openai","authType":"oauth","model":"gpt-5.4"}"""
        writeOverlayRaw(overlay)
        val obj = Json.parseToJsonElement(overlay).jsonObject
        Files.write(
            ReconcileRecord.path(dir),
            enc.encodeToString(
                ReconcileRecord.Record.serializer(),
                ReconcileRecord.Record(
                    prefsBefore = ReconcileRecord.RawTuple("openai", "oauth", "gpt-6-astra"),
                    prefsAfter = ReconcileRecord.RawTuple("openai", "oauth", "gpt-5.4"),
                    target = after,
                    runtime = ReconcileRecord.RuntimeCapture(ReconcileRecord.STATE_PRESENT, P),
                    overlay = ReconcileRecord.RawTuple("openai", "oauth", "gpt-5.4"),
                    overlaySelection = ModelRepair.rawSelection(obj),
                ),
            ).toByteArray(),
        )
        ModelRepair.writeIntent(
            dir,
            ModelRepair.RepairIntent(
                state = state, provider = "openai", authType = "oauth", target = intentTarget,
                defaultAtDecision = "gpt-6.1-sol", retired = listOf("gpt-5.4"), runtime = P,
                overlay = ModelRepair.CapturedOverlay(true, "openai", "gpt-5.4", ModelRepair.rawSelection(obj)),
                prefs = after,
            ),
        )
        mainProcess()
    }

    @Test
    fun `I1 - a standing repair in the target's scope with another target - Yielded, the intent intact`() {
        for (state in listOf(ModelRepair.STATE_PENDING, ModelRepair.STATE_AWAITING_MAIN)) {
            fresh()
            repairNeighbour("gpt-6.1-sol", state)
            val intentBefore = intentFile()
            val runtimeBefore = Files.readAllBytes(runtimePath())
            val out = resolveNow()
            assertEquals(state, ReconcileRecord.Outcome.Yielded(ReconcileRecord.dropRepairGoverns("openai", "oauth")), out)
            assertArrayEquals(intentBefore, intentFile())
            assertArrayEquals("recovery never fights the repair", runtimeBefore, Files.readAllBytes(runtimePath()))
            assertEquals(ReconcileRecord.Read.Absent, ReconcileRecord.read(dir))
        }
    }

    @Test
    fun `I2 - a provider-change record next to an intent in R0's scope - Recovered, then mainLoad deletes the intent`() {
        base()
        doubleFailure()
        ModelRepair.writeIntent(
            dir,
            ModelRepair.RepairIntent(provider = "openai", authType = "oauth", target = "gpt-6.1-sol", defaultAtDecision = "gpt-6.1-sol", runtime = P, prefs = P),
        )
        restart()
        val a = anchor()
        load()
        assertEquals(1, logsSince(a).count(RECOVERED_I))
        assertNull("mainLoad: Superseded, deleted", intentFile())
    }

    @Test
    fun `I3 - a PROVEN intent with the same target - Recovered`() {
        // CodeRabbit 4628273857: the intent must govern (proven, Pending), so only the same-target
        // rule lets the record recover. The overlay model gpt-6-astra (not retired) is both targets;
        // the retired id is in the captured runtime_state.
        val before = ModelTuple("openai", "oauth", "gpt-6.1-sol")
        val after = ModelTuple("openai", "oauth", "gpt-6-astra")
        val r0 = ModelTuple("openai", "oauth", "gpt-5.4")
        seedPrefs(after)
        writeRuntime(r0)
        val overlay = """{"heartbeatIntervalMinutes":30,"provider":"openai","authType":"oauth","model":"gpt-6-astra"}"""
        writeOverlayRaw(overlay)
        val obj = Json.parseToJsonElement(overlay).jsonObject
        Files.write(
            ReconcileRecord.path(dir),
            enc.encodeToString(
                ReconcileRecord.Record.serializer(),
                ReconcileRecord.Record(
                    prefsBefore = ReconcileRecord.RawTuple(before.provider, before.authType, before.model),
                    prefsAfter = ReconcileRecord.RawTuple(after.provider, after.authType, after.model),
                    target = after,
                    runtime = ReconcileRecord.RuntimeCapture(ReconcileRecord.STATE_PRESENT, r0),
                    overlay = ReconcileRecord.RawTuple("openai", "oauth", "gpt-6-astra"),
                    overlaySelection = ModelRepair.rawSelection(obj),
                ),
            ).toByteArray(),
        )
        val intent = ModelRepair.RepairIntent(
            provider = "openai", authType = "oauth", target = "gpt-6-astra", defaultAtDecision = "gpt-6.1-sol",
            retired = listOf("gpt-5.4"), runtime = r0,
            overlay = ModelRepair.CapturedOverlay(true, "openai", "gpt-6-astra", ModelRepair.rawSelection(obj)),
            prefs = after,
        )
        ModelRepair.writeIntent(dir, intent)
        mainProcess()
        val c = ModelRepair.classifyIntent(intent, ConfigManager.modelSnapshotFrom(dir, MainPrefs.view(prefs)), main = true)
        assertTrue("precondition: the repair governs the selection ($c)", c is ModelRepair.IntentClass.Pending)
        assertTrue(ModelRepair.provenTarget(intent, ConfigManager.modelSnapshotFrom(dir, MainPrefs.view(prefs))))
        assertTrue("the same target: no yield", resolveNow() is ReconcileRecord.Outcome.Recovered)
        assertEquals(after, runtimeTuple())
    }

    @Test
    fun `I4 - runtime_state Missing, a provider-change record, an intent in the target's scope - Yielded, config_json carries prefs`() {
        seedPrefs(P)
        writeOverlay(I)
        mainProcess()
        doubleFailure() // runtime_state was missing: captured Missing
        assertEquals(ReconcileRecord.STATE_MISSING, (ReconcileRecord.read(dir) as ReconcileRecord.Read.Present).record.runtime.state)
        val obj = (AgentSettingsFile.read(dir) as AgentSettingsFile.Read.Present).obj
        ModelRepair.writeIntent(
            dir,
            ModelRepair.RepairIntent(
                provider = "xai", authType = "api_key", target = "grok-4.6-fast", defaultAtDecision = "grok-4.6-fast",
                retired = listOf("grok-4.6"), overlay = ModelRepair.CapturedOverlay(true, "xai", "grok-4.6", ModelRepair.rawSelection(obj)),
                prefs = I,
            ),
        )
        restart()
        assertEquals(ReconcileRecord.Outcome.Yielded(ReconcileRecord.dropRepairGoverns("xai", "api_key")), resolveNow())
        assertNull(runtimeTuple())
        nodeProcess()
        assertEquals("config.json carries prefs", "xai", serviceStart().provider)
    }

    // ------------------------------------------------------------------------------- xAI

    private fun xaiTokens(t: XaiOAuthTokens) {
        File(dir.toFile(), "xai_oauth.migrated").createNewFile()
        CrossProcessStore(dir.toFile(), XaiOAuthTokenStore.FILE_NAME, XaiOAuthTokens.serializer(), XaiOAuthTokens()).write(t)
        XaiOAuthTokenStore.resetForTest()
        XaiOAuthTokenStore.initForTest(dir.toFile())
    }

    /** A stored sign-in (it does not decrypt on the JVM: read as reauth, so the H5 rule keeps oauth). */
    private fun signedIn() = xaiTokens(XaiOAuthTokens(accessTokenEnc = "c2VhbGVk", refreshTokenEnc = "c2VhbGVk", epoch = 1))

    private val XO = ModelTuple("xai", "oauth", "grok-4.6")

    @Test
    fun `X1 - an xai-oauth target with no token - runtime holds the guard image, mirror and boot keep oauth`() {
        xaiTokens(XaiOAuthTokens())
        base(overlay = XO)
        doubleFailure()
        restart()
        load()
        assertEquals(ModelTuple("xai", "api_key", "grok-4.6"), runtimeTuple())
        assertEquals(ModelSelectionLock.Result.Acquired(false), mirror())
        assertEquals("oauth", prefs.disk["auth_type"])
        assertEquals("oauth", ConfigManager.bootSelection(dir, form(XO)).authType)
    }

    @Test
    fun `X2 - runtime_state already the guard image - Completed by the confirm rewrite`() {
        xaiTokens(XaiOAuthTokens())
        base(overlay = XO)
        doubleFailure()
        writeRuntime(ModelTuple("xai", "api_key", "grok-4.6"))
        restart()
        val a = anchor()
        assertEquals("one rename: the confirm", 1, runtimeRenames { assertTrue(resolveNow() is ReconcileRecord.Outcome.Completed) })
        assertTrue(logsSince(a).none { it.message.startsWith("[Config] Reconcile: retry record dropped") })
    }

    @Test
    fun `X3 - a token arrives before recovery - oauth is written`() {
        xaiTokens(XaiOAuthTokens())
        base(overlay = XO)
        doubleFailure()
        signedIn()
        restart()
        load()
        assertEquals(XO, runtimeTuple())
    }

    @Test
    fun `X4 - an xai-oauth target over an explicit xai-api_key R0, on the reauth path - Recovered`() {
        // CodeRabbit 4628273866: signedIn() does not decrypt here, so this is the REAUTH path (the H5
        // rule keeps oauth for a dead family). The usable-token path is the next pin.
        signedIn()
        val r0 = ModelTuple("xai", "api_key", "grok-4.6")
        seedPrefs(r0)
        writeRuntime(r0)
        writeOverlay(XO)
        mainProcess()
        doubleFailure()
        restart()
        val a = anchor()
        load()
        assertTrue(logsSince(a).has(ReconcileRecord.recovered("xai", "oauth", "grok-4.6")))
        assertEquals(XO, runtimeTuple())
        assertEquals("the auth changed: a restart-to-apply notice for the selection", XO, notice()?.selection)
    }

    @Test
    fun `X4b - an xai-oauth target with a USABLE token over an explicit xai-api_key R0 - Recovered`() {
        ConfigManager.xaiCiphertextOpenerForTest = { enc -> "tok-$enc" }
        try {
            signedIn()
            val view = ConfigManager.xaiSignInView(XaiOAuthTokenStore.read())
            assertTrue("precondition: a usable token, no reauth", view.token.isNotBlank() && !view.effectiveReauth)
            assertEquals("oauth", ConfigManager.runtimeAuthTypeForStored("xai", "oauth"))
            val r0 = ModelTuple("xai", "api_key", "grok-4.6")
            seedPrefs(r0)
            writeRuntime(r0)
            writeOverlay(XO)
            mainProcess()
            doubleFailure()
            restart()
            val a = anchor()
            load()
            assertTrue(logsSince(a).has(ReconcileRecord.recovered("xai", "oauth", "grok-4.6")))
            assertEquals(XO, runtimeTuple())
            assertEquals("a restart-to-apply notice for the selection", XO, notice()?.selection)
        } finally {
            ConfigManager.xaiCiphertextOpenerForTest = null
        }
    }

    @Test
    fun `X5 - the H5 rule throws - Failed, no write, never xai-oauth with a blank token`() {
        xaiTokens(XaiOAuthTokens())
        base(overlay = XO)
        doubleFailure()
        restart()
        ReconcileRecord.runtimeAuthOf = { _, _ -> throw IllegalStateException("injected H5 failure") }
        val out = resolveNow()
        assertTrue("$out", out is ReconcileRecord.Outcome.Failed)
        assertEquals(P, runtimeTuple())
        assertTrue(recordPresent())
        load()
        assertNotEquals(XO, runtimeTuple())
    }

    // --------------------------------------------------------------------------------- :node

    @Test
    fun `B1 - a node start with a present record is read-only, after a MAIN load the next start is ordinary`() {
        base()
        doubleFailure()
        val overlay = AgentSettingsFile.path(dir)
        val bytes = Files.readAllBytes(overlay)
        val mtime = Files.getLastModifiedTime(overlay)
        nodeProcess()
        val a = anchor()
        val cfg = serviceStart()
        assertTrue(logsSince(a).has(ReconcileRecord.BOOT_HELD))
        assertArrayEquals(bytes, Files.readAllBytes(overlay))
        assertEquals(mtime, Files.getLastModifiedTime(overlay))
        assertNull("no intent write", intentFile())
        assertEquals("config.json from bootSelection (runtime_state first)", "openai", cfg.provider)
        assertTrue("node never deletes it", recordPresent())
        mainProcess()
        load()
        nodeProcess()
        val b = anchor()
        assertEquals("xai", serviceStart().provider)
        assertFalse(logsSince(b).has(ReconcileRecord.BOOT_HELD))
    }

    @Test
    fun `B2 - a corrupt record - an ordinary boot, and node does not delete it`() {
        seedPrefs(P)
        writeRuntime(P)
        Files.write(ReconcileRecord.path(dir), "{garbage".toByteArray())
        nodeProcess()
        val a = anchor()
        serviceStart()
        assertFalse(logsSince(a).has(ReconcileRecord.BOOT_HELD))
        assertArrayEquals("{garbage".toByteArray(), recordBytes())
    }

    @Test
    fun `B3 - an auth-only record and a node start before MAIN - the overlay keeps api_key, MAIN then recovers`() {
        signedIn()
        val p = XO
        seedPrefs(p)
        writeRuntime(p)
        writeOverlay(ModelTuple("xai", "api_key", "grok-4.6"))
        mainProcess()
        doubleFailure()
        nodeProcess()
        serviceStart()
        assertEquals("the boot did not publish runtime_state's auth", "api_key", (AgentSettingsFile.read(dir) as AgentSettingsFile.Read.Present).obj["authType"].toString().trim('"'))
        mainProcess()
        load()
        assertEquals(ModelTuple("xai", "api_key", "grok-4.6"), runtimeTuple())
        assertEquals("api_key", prefs.disk["auth_type"])
    }

    // --------------------------------------------------------------------- the other hooks

    @Test
    fun `M1 - the collector mirror takes the lock first at a cold start - Recovered inside it, prefs never R0`() {
        base()
        doubleFailure()
        restart()
        val a = anchor()
        assertEquals("Recovered: signalled", ModelSelectionLock.Result.Acquired(true), mirror())
        assertEquals(1, logsSince(a).count(RECOVERED_I))
        assertEquals("xai", prefs.disk["provider"])
        assertEquals("xai", prefs.memory["provider"])
        assertEquals(I, runtimeTuple())
    }

    private fun missingRuntimeDoubleFailure() {
        seedPrefs(P)
        writeOverlay(I)
        mainProcess()
        doubleFailure()
        assertNull(runtimeTuple())
    }

    @Test
    fun `SD1 - the record and a Missing runtime_state at a cold start - H3 recovers, the seed is skipped`() {
        missingRuntimeDoubleFailure()
        restart()
        val a = anchor()
        assertTrue(seedNow())
        assertEquals(1, logsSince(a).count(RECOVERED_I))
        assertEquals(ReconcileRecord.Read.Absent, ReconcileRecord.read(dir))
        assertEquals(I, runtimeTuple())
    }

    @Test
    fun `SD2 - the toggle path while Deferred fails with the selection-change reason`() {
        missingRuntimeDoubleFailure()
        assertFalse(RuntimeStateStore.updateInOwnTransaction { it.copy(reasoningEnabled = true) })
        assertEquals(RuntimeStateStore.TOGGLE_HELD_REASON, RuntimeStateStore.lastToggleRefusal)
        assertNull("nothing seeded", runtimeTuple())
        assertTrue(recordPresent())
    }

    private val enc = Json { encodeDefaults = true }

    private fun validRecordJson(edit: (ReconcileRecord.Record) -> ReconcileRecord.Record = { it }): String =
        enc.encodeToString(
            ReconcileRecord.Record.serializer(),
            edit(
                ReconcileRecord.Record(
                    prefsBefore = ReconcileRecord.RawTuple("openai", "oauth", "gpt-6-astra"),
                    prefsAfter = ReconcileRecord.RawTuple("xai", "api_key", "grok-4.6"),
                    target = I,
                    runtime = ReconcileRecord.RuntimeCapture(ReconcileRecord.STATE_PRESENT, P),
                    overlay = ReconcileRecord.RawTuple("xai", "api_key", "grok-4.6"),
                    overlaySelection = mapOf("provider" to "\"xai\"", "authType" to "\"api_key\"", "model" to "\"grok-4.6\""),
                ),
            ),
        )

    @Test
    fun `C1 - a corrupt record is WARNed, deleted and never written into a store`() {
        val variants = listOf(
            "garbage" to "{not json",
            "version 2" to validRecordJson().replace("\"version\":1", "\"version\":2"),
            "invalid pair" to validRecordJson { it.copy(target = ModelTuple("openai", "setup_token", "grok-4.6"), prefsAfter = ReconcileRecord.RawTuple("openai", "setup_token", "grok-4.6")) },
            "target not the projection" to validRecordJson { it.copy(target = I.copy(model = "grok-4.6-fast")) },
            "unknown runtime state" to validRecordJson { it.copy(runtime = ReconcileRecord.RuntimeCapture("maybe")) },
            "no prefs change" to validRecordJson { it.copy(prefsBefore = it.prefsAfter) },
        )
        for ((name, text) in variants) {
            fresh()
            seedPrefs(I)
            writeRuntime(P)
            writeOverlay(I)
            mainProcess()
            Files.write(ReconcileRecord.path(dir), text.toByteArray())
            val runtimeBefore = Files.readAllBytes(runtimePath())
            val a = anchor()
            assertEquals(name, ReconcileRecord.Outcome.None, resolveNow())
            assertTrue(name, logsSince(a).any { it.level == LogLevel.WARN && it.message.startsWith("[Config] Reconcile: retry record unreadable (") })
            assertEquals(name, ReconcileRecord.Read.Absent, ReconcileRecord.read(dir))
            assertArrayEquals(name, runtimeBefore, Files.readAllBytes(runtimePath()))
        }
        // The valid record itself is Present (the variants differ from it in one rule each).
        fresh()
        Files.write(ReconcileRecord.path(dir), validRecordJson().toByteArray())
        assertTrue(recordPresent())
    }

    @Test
    fun `C1 - a link at the record path is unlinked, never followed`() {
        val outside = tmp.newFolder().toPath().resolve("target.json")
        Files.write(outside, validRecordJson().toByteArray())
        val linked = try {
            Files.createSymbolicLink(ReconcileRecord.path(dir), outside)
            true
        } catch (_: Exception) {
            false
        }
        assumeTrue("symbolic links are not available here", linked)
        mainProcess()
        assertTrue(ReconcileRecord.read(dir) is ReconcileRecord.Read.Corrupt)
        assertEquals(ReconcileRecord.Outcome.None, resolveNow())
        assertFalse(Files.exists(ReconcileRecord.path(dir), java.nio.file.LinkOption.NOFOLLOW_LINKS))
        assertArrayEquals("the link's target is untouched", validRecordJson().toByteArray(), Files.readAllBytes(outside))
    }

    @Test
    fun `C2 - a corrupt record whose delete fails - a WARN each load, never a store write`() {
        seedPrefs(I)
        writeRuntime(P)
        writeOverlay(I)
        mainProcess()
        Files.write(ReconcileRecord.path(dir), "{not json".toByteArray())
        ReconcileRecord.beforeClearForTest = { throw IOException("injected delete failure") }
        val runtimeBefore = Files.readAllBytes(runtimePath())
        val a = anchor()
        try {
            repeat(2) { resolveNow() }
        } finally {
            disarm()
        }
        assertEquals(2, logsSince(a).count { it.message.startsWith("[Config] Reconcile: retry record unreadable (") })
        assertEquals(2, logsSince(a).count { it.message.startsWith("[Config] Reconcile: retry record not cleared (") })
        assertArrayEquals(runtimeBefore, Files.readAllBytes(runtimePath()))
        assertTrue(ReconcileRecord.read(dir) is ReconcileRecord.Read.Corrupt)
    }

    @Test
    fun `C3 - an IOException on read - Unavailable - kept in MAIN, read-only in node`() {
        base()
        doubleFailure()
        restart()
        ReconcileRecord.beforeReadForTest = { throw IOException("injected read failure") }
        try {
            assertTrue(resolveNow() is ReconcileRecord.Outcome.Failed)
            nodeProcess()
            val a = anchor()
            serviceStart()
            assertTrue(logsSince(a).has(ReconcileRecord.BOOT_HELD))
        } finally {
            disarm()
        }
        assertTrue(recordPresent())
    }

    @Test
    fun `R1 - Reset Done deletes the record`() {
        xaiTokens(XaiOAuthTokens())
        base()
        doubleFailure()
        restart()
        ConfigManager.deleteKeystoreKey = {}
        assertEquals(ConfigManager.ResetResult.Done, ConfigManager.resetConfig(ctx))
        assertEquals("H6", ReconcileRecord.Read.Absent, ReconcileRecord.read(dir))
    }

    @Test
    fun `R2 - Reset Partial keeps the record, and a cold restart recovers`() {
        xaiTokens(XaiOAuthTokens())
        base()
        doubleFailure()
        restart()
        ConfigManager.deleteKeystoreKey = { throw IllegalStateException("injected Keystore failure") }
        assertTrue(ConfigManager.resetConfig(ctx) is ConfigManager.ResetResult.Partial)
        assertTrue(recordPresent())
        restart()
        val a = anchor()
        load()
        assertEquals(1, logsSince(a).count(RECOVERED_I))
        assertEquals(I, runtimeTuple())
    }

    // ------------------------------------------------- round-10 reviewer gaps (a), (b), (c)

    private fun obj(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

    private fun snapshot(overlay: String, runtime: ModelTuple = ModelTuple("openai", "oauth", "gpt-5.4")) = ModelRepair.Snapshot(
        prefs = ModelTuple("openai", "oauth", "gpt-5.4"),
        runtime = runtime,
        overlay = AgentSettingsFile.Read.Present(obj(overlay)),
    )

    private fun repairIntent(captured: String?, selection: Boolean = true) = ModelRepair.RepairIntent(
        provider = "openai", authType = "oauth", target = "gpt-6.1-sol", defaultAtDecision = "gpt-6.1-sol",
        retired = listOf("gpt-5.4"), runtime = ModelTuple("openai", "oauth", "gpt-5.4"),
        overlay = captured?.let { c ->
            val o = obj(c)
            ModelRepair.CapturedOverlay(true, AgentSettingsFile.stringField(o, "provider"), AgentSettingsFile.stringField(o, "model"), if (selection) ModelRepair.rawSelection(o) else null)
        },
        prefs = ModelTuple("openai", "oauth", "gpt-5.4"),
    )

    @Test
    fun `round-10 a - a legacy intent (selection null) keeps the strict rule`() {
        val providerOnly = """{"provider":"openai","authType":"oauth"}"""
        assertTrue("with raw evidence: unchanged is Pending", ModelRepair.classifyIntent(repairIntent(providerOnly), snapshot(providerOnly)) is ModelRepair.IntentClass.Pending)
        assertTrue(
            "legacy: an unchanged provider-only overlay is still Superseded (strict)",
            ModelRepair.classifyIntent(repairIntent(providerOnly, selection = false), snapshot(providerOnly)) is ModelRepair.IntentClass.Superseded,
        )
    }

    @Test
    fun `round-10 b - CapturedOverlay selection is exact - number vs string, null vs absent, JSON round-trip`() {
        assertEquals(mapOf("model" to "7"), ModelRepair.rawSelection(obj("""{"model":7}""")))
        assertEquals(mapOf("model" to "\"7\""), ModelRepair.rawSelection(obj("""{"model":"7"}""")))
        assertEquals(mapOf("model" to "null"), ModelRepair.rawSelection(obj("""{"model":null}""")))
        assertEquals(emptyMap<String, String>(), ModelRepair.rawSelection(obj("""{"heartbeatIntervalMinutes":30}""")))
        // Round trip through the intent file, the null encoding included.
        val i = repairIntent("""{"provider":"openai","authType":"oauth","model":null}""")
        assertEquals(mapOf("provider" to "\"openai\"", "authType" to "\"oauth\"", "model" to "null"), i.overlay?.selection)
        ModelRepair.writeIntent(dir, i)
        assertEquals(i, (ModelRepair.readIntent(dir) as ModelRepair.IntentRead.Present).intent)
        // The classifier keeps them apart.
        val num = """{"provider":"openai","authType":"oauth","model":7}"""
        assertTrue(ModelRepair.classifyIntent(repairIntent(num), snapshot(num)) is ModelRepair.IntentClass.Pending)
        assertTrue("7 vs \"7\"", ModelRepair.classifyIntent(repairIntent(num), snapshot(num.replace("7", "\"7\""))) is ModelRepair.IntentClass.Superseded)
        val nul = """{"provider":"openai","authType":"oauth","model":null}"""
        assertTrue(ModelRepair.classifyIntent(repairIntent(nul), snapshot(nul)) is ModelRepair.IntentClass.Pending)
        assertTrue("null vs absent", ModelRepair.classifyIntent(repairIntent(nul), snapshot("""{"provider":"openai","authType":"oauth"}""")) is ModelRepair.IntentClass.Superseded)
    }

    @Test
    fun `round-10 c - loadConfig derives the key flag after the model transaction`() {
        seedPrefs(ModelTuple("openai", "oauth", "gpt-5.4"))
        mainProcess()
        val heldDuringDerive = mutableListOf<Boolean>()
        ConfigManager.keyUsableOf = { heldDuringDerive += ModelSelectionLock.heldForTest(); false }
        load()
        assertTrue("the load derives the key flag", heldDuringDerive.isNotEmpty())
        assertEquals("no derive runs inside the model transaction", listOf(false), heldDuringDerive.distinct())
    }

    @Test
    fun `round-10 c - the derive and its credential projection run on the store's IO scope, not the caller's thread`() {
        seedPrefs(ModelTuple("openai", "oauth", "gpt-5.4"))
        mainProcess()
        RuntimeStateStore.onObserved(RuntimeState(provider = "openai", authType = "oauth", model = "gpt-5.4"), prefs)
        RuntimeStateStore.noteOpenAIKeyUsable(true)
        val exec = Executors.newSingleThreadExecutor()
        try {
            RuntimeStateStore.useScopeForTest(CoroutineScope(exec.asCoroutineDispatcher()))
            val caller = Thread.currentThread()
            var deriveThread: Thread? = null
            var projectionThread: Thread? = null
            var heldDuringProjection: Boolean? = null
            ConfigManager.keyUsableOf = { deriveThread = Thread.currentThread(); false }
            RuntimeStateStore.beforeCredentialReadForTest = {
                projectionThread = Thread.currentThread()
                heldDuringProjection = ModelSelectionLock.heldForTest()
            }
            load()
            repeat(3) { exec.submit {}.get() } // drain: derive, then the projection it launches
            assertNotNull(deriveThread)
            assertNotEquals("the decrypt is off the caller's thread", caller, deriveThread)
            assertNotNull("the flag changed, so the display re-projected", projectionThread)
            assertNotEquals(caller, projectionThread)
            assertEquals(false, heldDuringProjection)
        } finally {
            RuntimeStateStore.useScopeForTest(null)
            exec.shutdownNow()
        }
    }

    // ------------------------------------------- CodeRabbit 4626795862: key revision first

    private fun keyIs(value: String): (PrefsReader) -> Boolean = { p -> p.getString(ConfigManager.KEY_OPENAI_API_KEY_ENC, null) == "sealed:$value" }

    /** Signed out of OpenAI, oauth selected, a 5.4 record: a usable key shows 5.4, no key the default. */
    private fun keyDisplayUser() {
        seedPrefs(ModelTuple("openai", "oauth", "gpt-5.4"))
        writeRuntime(ModelTuple("openai", "oauth", "gpt-5.4"))
        writeOverlay(ModelTuple("openai", "oauth", "gpt-5.4"))
        mainProcess()
        assertTrue(ConfigManager.signOutOpenAI(ctx))
        RuntimeStateStore.onObserved(RuntimeState(provider = "openai", authType = "oauth", model = "gpt-5.4"), prefs)
        RuntimeStateStore.noteOpenAIKeyUsable(false)
        assertEquals("gpt-6.1-sol", RuntimeStateStore.read().model)
    }

    @Test
    fun `key revision - a save landing between init's read and its store - the save's newer key wins`() {
        keyDisplayUser()
        val newKey = keyIs("sk-new")
        var first = true
        ConfigManager.keyUsableOf = { p ->
            val v = newKey(p) // init reads: no key yet
            if (first) {
                first = false
                // ...and a save of a usable key lands before init stores what it read.
                assertTrue(save(form(ModelTuple("openai", "oauth", "gpt-5.4")) { it.copy(openaiApiKey = "sk-new") }))
            }
            v
        }
        RuntimeStateStore.deriveKeyFlagAtInit(prefs)
        assertEquals("the newer key: the api_key fallback shows 5.4", "gpt-5.4", RuntimeStateStore.read().model)
    }

    @Test
    fun `key revision - two saves whose derives run in reverse order publish the newer key`() {
        keyDisplayUser()
        ConfigManager.keyUsableOf = keyIs("sk-new")
        assertTrue(save(form(ModelTuple("openai", "oauth", "gpt-5.4")) { it.copy(openaiApiKey = "sk-old") }))
        // Save A removes the key; before A's derive runs, save B stores a usable key and derives.
        ConfigManager.afterSaveLockForTest = {
            ConfigManager.afterSaveLockForTest = null
            assertTrue(save(form(ModelTuple("openai", "oauth", "gpt-5.4")) { it.copy(openaiApiKey = "sk-new") }))
        }
        assertTrue(save(form(ModelTuple("openai", "oauth", "gpt-5.4")) { it.copy(openaiApiKey = "") }))
        assertEquals("B committed last", "sealed:sk-new", prefs.disk[ConfigManager.KEY_OPENAI_API_KEY_ENC])
        assertEquals("A's late derive reads B's key: 5.4 via the API key", "gpt-5.4", RuntimeStateStore.read().model)
    }

    // ------------------------------------------- CodeRabbit on 7de1e77c (Major): scope keys first

    private val capturedFull = """{"provider":"openai","authType":"oauth","model":"gpt-5.4"}"""

    @Test
    fun `CR 7de1e77c - an auth change written with the target model supersedes the intent`() {
        val now = """{"provider":"openai","authType":"api_key","model":"gpt-6.1-sol"}"""
        assertTrue(ModelRepair.classifyIntent(repairIntent(capturedFull), snapshot(now)) is ModelRepair.IntentClass.Superseded)
    }

    @Test
    fun `CR 7de1e77c - a provider change written with the target model supersedes the intent`() {
        for (now in listOf(
            """{"provider":"","authType":"oauth","model":"gpt-6.1-sol"}""",
            """{"provider":7,"authType":"oauth","model":"gpt-6.1-sol"}""",
            """{"authType":"oauth","model":"gpt-6.1-sol"}""",
        )) {
            assertTrue(now, ModelRepair.classifyIntent(repairIntent(capturedFull), snapshot(now)) is ModelRepair.IntentClass.Superseded)
        }
    }

    @Test
    fun `CR 7de1e77c - the repair's own overlay write is still accepted`() {
        // The repair's model write, plus the boot publish of the intent's own scope.
        val own = """{"provider":"openai","authType":"oauth","model":"gpt-6.1-sol"}"""
        assertTrue(ModelRepair.classifyIntent(repairIntent(capturedFull), snapshot(own)) is ModelRepair.IntentClass.Pending)
        val modelOnly = """{"heartbeatIntervalMinutes":30,"model":"gpt-5.4"}"""
        assertTrue(ModelRepair.classifyIntent(repairIntent(modelOnly), snapshot(own)) is ModelRepair.IntentClass.Pending)
    }

    @Test
    fun `CR 7de1e77c - end to end - a model-only overlay is repaired, handed off and converged`() {
        seedPrefs(ModelTuple("openai", "oauth", "gpt-5.4"))
        writeRuntime(ModelTuple("openai", "oauth", "gpt-5.4"))
        writeOverlayRaw("""{"heartbeatIntervalMinutes":30,"model":"gpt-5.4"}""")
        nodeProcess()
        serviceStart()
        val i = (ModelRepair.readIntent(dir) as ModelRepair.IntentRead.Present).intent
        assertEquals("the handoff completed", ModelRepair.STATE_AWAITING_MAIN, i.state)
        assertEquals("the boot published the intent's own scope", "oauth", AgentSettingsFile.stringField((AgentSettingsFile.read(dir) as AgentSettingsFile.Read.Present).obj, "authType"))
        mainProcess()
        load()
        assertEquals("MAIN converged", ModelRepair.STATE_CONVERGED, (ModelRepair.readIntent(dir) as ModelRepair.IntentRead.Present).intent.state)
        assertEquals("gpt-6.1-sol", prefs.disk["model"])
    }

    @Test
    fun `CR 7de1e77c - a legacy intent with an auth change supersedes, its own scope does not`() {
        val now = """{"provider":"openai","authType":"api_key","model":"gpt-6.1-sol"}"""
        assertTrue(ModelRepair.classifyIntent(repairIntent(capturedFull, selection = false), snapshot(now)) is ModelRepair.IntentClass.Superseded)
        val own = """{"provider":"openai","authType":"oauth","model":"gpt-6.1-sol"}"""
        assertTrue(ModelRepair.classifyIntent(repairIntent(capturedFull, selection = false), snapshot(own)) is ModelRepair.IntentClass.Pending)
    }
}
