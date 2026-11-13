package com.seekerclaw.app.config

import android.content.ContextWrapper
import android.content.SharedPreferences
import com.seekerclaw.app.state.RuntimeState
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
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption

/**
 * BAT-1661 (contract v2.5 §1) — the REAL [ModelRepair.serviceStart] when the model-selection lock
 * is busy at start: a read-only boot. No decision, no intent, no repair, no reconcile commit, no
 * prefs / runtime_state / overlay write; config.json is emitted from the raw stored model; one WARN.
 *
 * Prefs are read-only here ([FakeContext.edit] throws), so any prefs write on this path fails the
 * test. No encrypted keys are stored, so the load never reaches the Android Keystore.
 */
class ModelRepairBootTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var dir: Path
    private val savedDirSync = SafeFs.dirSyncChecked

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
                    models = listOf(ModelInfo("gpt-6.1-sol", "GPT-6.1 Sol", "yes")),
                    retiredForAuth = mapOf("oauth" to listOf("gpt-5.5", "gpt-5.4", "gpt-5.4-mini")),
                ),
            ),
        )
    }

    @After
    fun tearDown() {
        SafeFs.dirSyncChecked = savedDirSync
        ModelSelectionLock.initForTest(null)
        ModelRegistry.resetForTest()
    }

    @Test
    fun `lock busy at start - read-only boot writes no shared store`() {
        val seed = RuntimeState(provider = "openai", authType = "api_key", model = "gpt-5.4", reasoningEnabled = true)
        CrossProcessStore(dir.toFile(), RuntimeStateFile.NAME, RuntimeState.serializer(), seed).write(seed)
        val overlay = AgentSettingsFile.path(dir)
        overlay.toFile().writeText("""{"heartbeatIntervalMinutes":45,"provider":"openai","model":"gpt-5.4"}""")
        val runtime = dir.resolve(RuntimeStateFile.NAME)
        val before = listOf(runtime, overlay).associateWith { Files.readAllBytes(it) to Files.getLastModifiedTime(it) }

        val ctx = FakeContext(
            dir.toFile(),
            mapOf("setup_complete" to true, "provider" to "openai", "auth_type" to "api_key", "model" to "gpt-5.4"),
        )
        var emitted: AppConfig? = null
        val channel = FileChannel.open(dir.resolve(ModelSelectionLock.LOCK_NAME), StandardOpenOption.CREATE, StandardOpenOption.WRITE).use { ch ->
            ch.lock().use {
                ModelRepair.serviceStart(ctx) { cfg ->
                    emitted = cfg
                    "telegram"
                }
            }
        }

        assertEquals("the boot still proceeds", "telegram", channel)
        assertNotNull(emitted)
        assertEquals("raw stored model carried, never rewritten", "gpt-5.4", emitted!!.model)
        before.forEach { (p, v) ->
            assertArrayEquals("$p bytes", v.first, Files.readAllBytes(p))
            assertEquals("$p mtime", v.second, Files.getLastModifiedTime(p))
        }
        assertFalse("no intent", Files.exists(ModelRepair.intentPath(dir)))
        val last = LogCollector.logs.value.lastOrNull()
        assertTrue("one WARN: $last", last != null && last.level == LogLevel.WARN && last.message == ModelRepair.BUSY_WARNING)
    }

    @Test
    fun `a failed repair write - no publish, the intent stays for the next start`() {
        // CodeRabbit R2 (PR #465): runtime on a valid newer model, prefs still retired, no overlay.
        // The decision keeps runtime's gpt-6-astra. If the overlay write fails and the boot then
        // published, the overlay would get prefs' retired gpt-5.4: the agent would run the default
        // and the next resume would cancel over that "newer" value, losing gpt-6-astra.
        val seed = RuntimeState(provider = "openai", authType = "oauth", model = "gpt-6-astra", reasoningEnabled = true)
        CrossProcessStore(dir.toFile(), RuntimeStateFile.NAME, RuntimeState.serializer(), seed).write(seed)
        val runtime = dir.resolve(RuntimeStateFile.NAME)
        val runtimeBefore = Files.readAllBytes(runtime) to Files.getLastModifiedTime(runtime)
        val overlay = AgentSettingsFile.path(dir)

        val ctx = FakeContext(
            dir.toFile(),
            mapOf(
                "setup_complete" to true,
                "provider" to "openai",
                "auth_type" to "oauth",
                "model" to "gpt-5.4",
                // rawPrefsModelTuple downgrades oauth without a stored token to api_key.
                "openai_oauth_token_enc" to "present",
            ),
        )
        val anchor = LogCollector.logs.value.lastOrNull()
        var emitted: AppConfig? = null
        var repairCalls = 0
        val channel = ModelRepair.serviceStart(
            ctx,
            repair = { _, _, _ ->
                repairCalls++
                false // the overlay write failed
            },
        ) { cfg ->
            emitted = cfg
            "telegram"
        }

        assertEquals(1, repairCalls)
        assertEquals("the boot still proceeds", "telegram", channel)
        assertNotNull(emitted)
        assertFalse("no overlay published from the retired prefs model", Files.exists(overlay))
        assertArrayEquals("runtime_state bytes", runtimeBefore.first, Files.readAllBytes(runtime))
        assertEquals("runtime_state mtime", runtimeBefore.second, Files.getLastModifiedTime(runtime))
        val intent = ModelRepair.readIntent(dir)
        assertTrue("intent kept for resume: $intent", intent is ModelRepair.IntentRead.Present)
        assertEquals("gpt-6-astra", (intent as ModelRepair.IntentRead.Present).intent.target)
        // The fake token makes the (compute-only) load log a decrypt line too, so find the WARN
        // among the lines this start logged rather than taking the last one.
        val all = LogCollector.logs.value
        val logged = all.drop(if (anchor == null) 0 else all.indexOfFirst { it === anchor } + 1)
        assertTrue("repair-incomplete WARN: ${logged.map { it.message }}", logged.any { it.level == LogLevel.WARN && it.message == ModelRepair.REPAIR_FAILED_BOOT_WARNING })
    }

    @Test
    fun `intent persistence fails - no publish, no repair this start`() {
        // CodeRabbit R3 (PR #465): a failed writeIntent used to look like "nothing to repair"
        // (Plan.NONE), and the boot published the retired prefs model into a new overlay.
        val seed = RuntimeState(provider = "openai", authType = "oauth", model = "gpt-6-astra", reasoningEnabled = true)
        CrossProcessStore(dir.toFile(), RuntimeStateFile.NAME, RuntimeState.serializer(), seed).write(seed)
        val runtime = dir.resolve(RuntimeStateFile.NAME)
        val runtimeBefore = Files.readAllBytes(runtime) to Files.getLastModifiedTime(runtime)
        val ctx = FakeContext(
            dir.toFile(),
            mapOf(
                "setup_complete" to true,
                "provider" to "openai",
                "auth_type" to "oauth",
                "model" to "gpt-5.4",
                "openai_oauth_token_enc" to "present",
            ),
        )
        // writeIntent's checked directory fsync fails; the read-only path calls nothing that uses it.
        SafeFs.dirSyncChecked = { throw java.io.IOException("injected fsync failure") }
        var repairCalls = 0
        var emitted: AppConfig? = null
        val channel = ModelRepair.serviceStart(ctx, repair = { _, _, _ -> repairCalls++; true }) { cfg ->
            emitted = cfg
            "telegram"
        }

        assertEquals("the boot still proceeds", "telegram", channel)
        assertNotNull(emitted)
        assertEquals("no repair without a persisted intent", 0, repairCalls)
        assertFalse("no overlay published from the retired prefs model", Files.exists(AgentSettingsFile.path(dir)))
        assertArrayEquals("runtime_state bytes", runtimeBefore.first, Files.readAllBytes(runtime))
        assertEquals("runtime_state mtime", runtimeBefore.second, Files.getLastModifiedTime(runtime))
        // The atomic rename landed before the checked fsync failed, so the file can exist. It then
        // holds this start's own decision, which the next start resumes; never a different target.
        val left = ModelRepair.readIntent(dir)
        if (left is ModelRepair.IntentRead.Present) assertEquals("gpt-6-astra", left.intent.target)
    }

    /** `Context` backed by [filesDir] and one read-only in-memory prefs file. */
    private class FakeContext(private val filesDir: File, private val prefs: Map<String, Any>) : ContextWrapper(null) {
        override fun getFilesDir(): File = filesDir
        override fun getSharedPreferences(name: String?, mode: Int): SharedPreferences = object : SharedPreferences {
            override fun getAll(): MutableMap<String, *> = prefs.toMutableMap()
            override fun getString(key: String?, defValue: String?): String? = prefs[key] as? String ?: defValue
            override fun getStringSet(key: String?, defValues: MutableSet<String>?): MutableSet<String>? = defValues
            override fun getInt(key: String?, defValue: Int) = prefs[key] as? Int ?: defValue
            override fun getLong(key: String?, defValue: Long) = prefs[key] as? Long ?: defValue
            override fun getFloat(key: String?, defValue: Float) = defValue
            override fun getBoolean(key: String?, defValue: Boolean) = prefs[key] as? Boolean ?: defValue
            override fun contains(key: String?) = prefs.containsKey(key)
            override fun edit(): SharedPreferences.Editor = throw UnsupportedOperationException("read-only boot must not write prefs")
            override fun registerOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
            override fun unregisterOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
        }
    }
}
