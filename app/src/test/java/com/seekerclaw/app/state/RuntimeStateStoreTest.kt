package com.seekerclaw.app.state

import android.content.SharedPreferences
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Pure JVM tests for RuntimeStateStore's validity gate, prefs mirror,
 * and migration behaviour (BAT-513). Same convention CrossProcessStoreTest
 * follows: the Android-specific surfaces (FileObserver,
 * BroadcastReceiver) are validated by device test, not here.
 *
 * The collector path is exercised via the internal
 * [RuntimeStateStore.onObserved] entry point — driving the singleton
 * directly without spinning up a real [com.seekerclaw.app.util.CrossProcessStore]
 * (which needs a Context).
 */
class RuntimeStateStoreTest {

    private lateinit var prefs: FakePrefs

    @Before
    fun setUp() {
        prefs = FakePrefs()
        RuntimeStateStore.resetForTest()
    }

    @After
    fun tearDown() {
        RuntimeStateStore.resetForTest()
    }

    // --- isValidPair matrix ---

    @Test
    fun `claude accepts api_key and setup_token, rejects oauth`() {
        assertTrue(RuntimeStateStore.isValidPair("claude", "api_key"))
        assertTrue(RuntimeStateStore.isValidPair("claude", "setup_token"))
        assertFalse(RuntimeStateStore.isValidPair("claude", "oauth"))
        assertFalse(RuntimeStateStore.isValidPair("claude", ""))
    }

    @Test
    fun `openai accepts api_key and oauth, rejects setup_token`() {
        assertTrue(RuntimeStateStore.isValidPair("openai", "api_key"))
        assertTrue(RuntimeStateStore.isValidPair("openai", "oauth"))
        // The Node side aliases "setup_token" → "api_key" for legacy
        // OpenAI installs as a defensive runtime fix; on the Kotlin
        // side we keep the matrix tight so a fresh write of the
        // unaliased value can't slip through.
        assertFalse(RuntimeStateStore.isValidPair("openai", "setup_token"))
    }

    @Test
    fun `openrouter and custom only accept api_key`() {
        assertTrue(RuntimeStateStore.isValidPair("openrouter", "api_key"))
        assertFalse(RuntimeStateStore.isValidPair("openrouter", "oauth"))
        assertFalse(RuntimeStateStore.isValidPair("openrouter", "setup_token"))
        assertTrue(RuntimeStateStore.isValidPair("custom", "api_key"))
        assertFalse(RuntimeStateStore.isValidPair("custom", "oauth"))
    }

    @Test
    fun `unknown providers are rejected (anthropic display alias is NOT a valid persisted ID)`() {
        // Persisting "anthropic" instead of "claude" was the mistake
        // v4 caught — the Node side resets unknown providers to
        // "claude" silently. Pin that the Kotlin matrix rejects it
        // up-front so the persisted file never contains "anthropic".
        assertFalse(RuntimeStateStore.isValidPair("anthropic", "api_key"))
        assertFalse(RuntimeStateStore.isValidPair("Claude", "api_key"))
        assertFalse(RuntimeStateStore.isValidPair("", "api_key"))
    }

    // --- seedFromPrefs ---

    @Test
    fun `seedFromPrefs returns defaults when prefs are empty`() {
        val seed = RuntimeStateStore.seedFromPrefs(prefs)
        assertEquals(RuntimeState(), seed)
    }

    // ---- BAT-549 Commit 3b: RuntimeState reasoning fields ---------------

    @Test
    fun `RuntimeState defaults — new BAT-549 fields`() {
        val state = RuntimeState()
        // Existing BAT-513 fields preserved
        assertEquals("claude", state.provider)
        assertEquals("api_key", state.authType)
        assertEquals("claude-opus-4-7", state.model)
        // New BAT-549 fields default to safe-off so existing users don't
        // silently flip on reasoning capability when they update the app.
        assertEquals(false, state.reasoningEnabled)
        assertEquals(false, state.reasoningDisplayInChat)
        assertEquals(false, state.customEchoReasoning)
        assertEquals(null, state.customConfigSignature)
    }

    @Test
    fun `RuntimeState data class equality includes new fields`() {
        // Two instances with same originals + different reasoning fields
        // must NOT be equal — the data class auto-generated equals/hashCode
        // must include the new fields so observe-and-mirror change detection
        // (RuntimeStateStore.mirrorIfChanged) sees toggle flips.
        val baseline = RuntimeState("claude", "api_key", "claude-opus-4-7")
        val flippedReasoning = baseline.copy(reasoningEnabled = true)
        val flippedDisplay = baseline.copy(reasoningDisplayInChat = true)
        val flippedCustom = baseline.copy(customEchoReasoning = true)
        val flippedSig = baseline.copy(customConfigSignature = "abc123")

        assertNotEquals(baseline, flippedReasoning)
        assertNotEquals(baseline, flippedDisplay)
        assertNotEquals(baseline, flippedCustom)
        assertNotEquals(baseline, flippedSig)
        // copy without changes still equal
        assertEquals(baseline, baseline.copy())
    }

    @Test
    fun `RuntimeState constructor accepts all 7 fields`() {
        val state = RuntimeState(
            provider = "custom",
            authType = "api_key",
            model = "deepseek-v4-pro",
            reasoningEnabled = true,
            reasoningDisplayInChat = true,
            customEchoReasoning = true,
            customConfigSignature = "sha256-stub",
        )
        assertEquals("custom", state.provider)
        assertEquals(true, state.reasoningEnabled)
        assertEquals(true, state.reasoningDisplayInChat)
        assertEquals(true, state.customEchoReasoning)
        assertEquals("sha256-stub", state.customConfigSignature)
    }

    @Test
    fun `seedFromPrefs reads existing prefs values`() {
        prefs.edit().putString("provider", "openai")
            .putString("auth_type", "oauth")
            .putString("model", "gpt-5.4")
            .apply()
        val seed = RuntimeStateStore.seedFromPrefs(prefs)
        assertEquals(RuntimeState("openai", "oauth", "gpt-5.4"), seed)
    }

    @Test
    fun `seedFromPrefs falls back to default on invalid persisted combo`() {
        // Corrupt prefs (provider=openrouter, authType=oauth — invalid
        // under the matrix) MUST NOT seed the file with bad state.
        // The defaults take over so the rest of the system is in a
        // known-good state until the user explicitly changes settings.
        prefs.edit().putString("provider", "openrouter")
            .putString("auth_type", "oauth")
            .putString("model", "claude-haiku-4-5")
            .apply()
        val seed = RuntimeStateStore.seedFromPrefs(prefs)
        assertEquals(RuntimeState(), seed)
    }

    // --- mirrorIfChanged (redundancy guard) ---

    @Test
    fun `mirrorIfChanged is a no-op when all three fields already match`() {
        prefs.edit().putString("provider", "claude")
            .putString("auth_type", "api_key")
            .putString("model", "claude-opus-4-7")
            .apply()
        prefs.applyCount = 0
        val applied = RuntimeStateStore.mirrorIfChanged(
            prefs,
            RuntimeState("claude", "api_key", "claude-opus-4-7"),
        )
        assertFalse("mirror must skip the apply() entirely on identical input", applied)
        assertEquals(0, prefs.applyCount)
    }

    @Test
    fun `mirrorIfChanged updates only the differing field(s)`() {
        prefs.edit().putString("provider", "claude")
            .putString("auth_type", "api_key")
            .putString("model", "claude-opus-4-7")
            .apply()
        prefs.applyCount = 0
        prefs.putCounts.clear()
        val applied = RuntimeStateStore.mirrorIfChanged(
            prefs,
            RuntimeState("claude", "api_key", "claude-haiku-4-5"),
        )
        assertTrue("mirror must apply when at least one field differs", applied)
        assertEquals(1, prefs.applyCount)
        // Only `model` was different; `provider` and `auth_type`
        // should NOT have been re-written.
        assertEquals(1, prefs.putCounts["model"] ?: 0)
        assertEquals(0, prefs.putCounts["provider"] ?: 0)
        assertEquals(0, prefs.putCounts["auth_type"] ?: 0)
    }

    @Test
    fun `mirrorIfChanged collapses repeated identical writes to a single apply`() {
        // The collector observes the same value many times during a
        // burst (FileObserver fires multiple events per write +
        // broadcast). Without the guard, every observation generates
        // a prefs write; with the guard, only the first one (which
        // changes prefs) writes — the rest are no-ops.
        val target = RuntimeState("openai", "api_key", "gpt-5.4")
        RuntimeStateStore.mirrorIfChanged(prefs, target) // first write — actually applies
        prefs.applyCount = 0
        for (i in 1..5) RuntimeStateStore.mirrorIfChanged(prefs, target)
        assertEquals(
            "five identical observations after the first must collapse to zero apply()s",
            0,
            prefs.applyCount,
        )
    }

    // --- onObserved (collector path) ---

    @Test
    fun `onObserved with valid state updates state and mirrors to prefs`() {
        RuntimeStateStore.initForTest(RuntimeState())
        // Observe a Node-originated write (simulated — in production
        // this lands via CrossProcessStore's StateFlow emission after
        // a FileObserver reload).
        RuntimeStateStore.onObserved(
            RuntimeState("openrouter", "api_key", "anthropic/claude-sonnet-4-6"),
            prefs,
        )
        assertEquals(
            RuntimeState("openrouter", "api_key", "anthropic/claude-sonnet-4-6"),
            RuntimeStateStore.state.value,
        )
        assertEquals("openrouter", prefs.getString("provider", null))
        assertEquals("api_key", prefs.getString("auth_type", null))
        assertEquals("anthropic/claude-sonnet-4-6", prefs.getString("model", null))
    }

    @Test
    fun `onObserved with invalid (provider, authType) does NOT update state OR prefs`() {
        // Plant initial valid state, then simulate Node writing an
        // invalid combo (provider=openrouter, authType=oauth — not
        // in the matrix). Both the StateFlow AND prefs must keep the
        // last valid value; the file-on-disk is none of our business
        // (Node owns its bug at the write site).
        prefs.edit().putString("provider", "claude")
            .putString("auth_type", "api_key")
            .putString("model", "claude-opus-4-7")
            .apply()
        RuntimeStateStore.initForTest(RuntimeState("claude", "api_key", "claude-opus-4-7"))
        prefs.applyCount = 0

        RuntimeStateStore.onObserved(RuntimeState("openrouter", "oauth", "gpt-5.4"), prefs)

        assertEquals(
            "UI keeps last valid state",
            RuntimeState("claude", "api_key", "claude-opus-4-7"),
            RuntimeStateStore.state.value,
        )
        assertEquals("prefs.provider unchanged", "claude", prefs.getString("provider", null))
        assertEquals("prefs.auth_type unchanged", "api_key", prefs.getString("auth_type", null))
        assertEquals("prefs.model unchanged", "claude-opus-4-7", prefs.getString("model", null))
        assertEquals("no apply() ran", 0, prefs.applyCount)
    }

    @Test
    fun `onObserved redundant valid emission does not write to prefs`() {
        prefs.edit().putString("provider", "openai")
            .putString("auth_type", "oauth")
            .putString("model", "gpt-5.4")
            .apply()
        RuntimeStateStore.initForTest(RuntimeState("openai", "oauth", "gpt-5.4"))
        prefs.applyCount = 0
        // Observed value matches both prefs and the seeded StateFlow.
        // No-op everywhere.
        RuntimeStateStore.onObserved(RuntimeState("openai", "oauth", "gpt-5.4"), prefs)
        assertEquals(0, prefs.applyCount)
    }

    // --- write / update validation ---

    @Test(expected = IllegalArgumentException::class)
    fun `write rejects invalid combo BEFORE persisting (matrix violation throws)`() {
        // initForTest leaves `store` null, so a successful require()
        // would still return false from write(). The require() must
        // fire first — the test asserts the throw, not the return
        // value. Catching the throw proves the precondition
        // protects the persistence layer.
        RuntimeStateStore.initForTest(RuntimeState())
        RuntimeStateStore.write(RuntimeState("openrouter", "oauth", "x"))
    }

    @Test
    fun `write returns false when init was skipped (defensive, no NPE)`() {
        // Guard against an accidental call before init() — production
        // calls init() in SeekerClawApplication.onCreate, so this is
        // really a "do not crash if order ever drifts" case.
        // resetForTest left store == null. Validity check passes →
        // store?.write(value) ?: false short-circuits to false.
        assertFalse(RuntimeStateStore.write(RuntimeState("claude", "api_key", "claude-opus-4-7")))
    }

    // --- in-memory SharedPreferences fake ---
    // Minimal — implements only what RuntimeStateStore exercises.
    // Tracks apply() count and per-key putString() count so the
    // redundancy-guard tests can assert "exactly N writes".
    private class FakePrefs : SharedPreferences {
        private val map = mutableMapOf<String, String?>()
        var applyCount = 0
        val putCounts = mutableMapOf<String, Int>()

        override fun getAll(): MutableMap<String, *> = map.toMutableMap()
        override fun getString(key: String, defValue: String?): String? = map[key] ?: defValue
        override fun getStringSet(key: String, defValues: MutableSet<String>?): MutableSet<String>? = defValues
        override fun getInt(key: String, defValue: Int): Int = defValue
        override fun getLong(key: String, defValue: Long): Long = defValue
        override fun getFloat(key: String, defValue: Float): Float = defValue
        override fun getBoolean(key: String, defValue: Boolean): Boolean = defValue
        override fun contains(key: String): Boolean = map.containsKey(key)
        override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) {}
        override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) {}

        override fun edit(): SharedPreferences.Editor = FakeEditor()

        private inner class FakeEditor : SharedPreferences.Editor {
            private val pending = mutableMapOf<String, String?>()
            private val removals = mutableSetOf<String>()
            private var clearAll = false
            override fun putString(key: String, value: String?): SharedPreferences.Editor {
                pending[key] = value
                putCounts[key] = (putCounts[key] ?: 0) + 1
                return this
            }
            override fun putStringSet(key: String, values: MutableSet<String>?): SharedPreferences.Editor = this
            override fun putInt(key: String, value: Int): SharedPreferences.Editor = this
            override fun putLong(key: String, value: Long): SharedPreferences.Editor = this
            override fun putFloat(key: String, value: Float): SharedPreferences.Editor = this
            override fun putBoolean(key: String, value: Boolean): SharedPreferences.Editor = this
            override fun remove(key: String): SharedPreferences.Editor { removals += key; return this }
            override fun clear(): SharedPreferences.Editor { clearAll = true; return this }
            override fun commit(): Boolean { apply(); return true }
            override fun apply() {
                if (clearAll) map.clear()
                for (k in removals) map.remove(k)
                map.putAll(pending)
                applyCount++
            }
        }
    }
}
