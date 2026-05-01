package com.seekerclaw.app.state

import android.content.SharedPreferences
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Pure JVM tests for AgentPreferencesStore (BAT-515). Mirrors
 * RuntimeStateStoreTest's pattern: the Android-specific surfaces
 * (FileObserver, BroadcastReceiver) are validated by device test;
 * here we drive the singleton's internal helpers
 * ([AgentPreferencesStore.seedFromPrefs], [onObserved], [mirrorIfChanged],
 * [validateForWrite]) directly.
 *
 * Pinned contracts:
 *  - v3 §1: migration preserves over-cap agentName verbatim with WARN
 *  - v3 §2: missing/corrupt file → state stays at seeded value, never
 *    silently resets to hardcoded defaults if a persisted source had
 *    a valid prior value
 *  - v3 §3: mirror to prefs only when actually changed; broadcast
 *    only when mirror actually changed prefs
 *  - v3 §4: validateForWrite is context-sensitive (skips cap on
 *    unchanged fields) so saveConfig with an existing migrated long
 *    name doesn't fail just because some unrelated field changed
 *  - v3 §5: write/update validation matches
 */
class AgentPreferencesStoreTest {

    private lateinit var prefs: FakePrefs

    @Before
    fun setUp() {
        prefs = FakePrefs()
        AgentPreferencesStore.resetForTest()
    }

    @After
    fun tearDown() {
        AgentPreferencesStore.resetForTest()
    }

    // ── data class defaults ─────────────────────────────────────────

    @Test
    fun `defaults match expected user-visible values`() {
        val ap = AgentPreferences()
        assertEquals("MyAgent", ap.agentName)
        assertEquals("brave", ap.searchProvider)
    }

    @Test
    fun `companion AGENT_NAME_MAX is 64`() {
        assertEquals(64, AgentPreferences.AGENT_NAME_MAX)
    }

    @Test
    fun `companion KNOWN_SEARCH_PROVIDERS contains the 5 expected`() {
        val expected = setOf("brave", "perplexity", "exa", "tavily", "firecrawl")
        assertEquals(expected, AgentPreferences.KNOWN_SEARCH_PROVIDERS)
    }

    // ── seedFromPrefs (BAT-515 v3 §1, §2) ──────────────────────────

    @Test
    fun `seedFromPrefs uses defaults on fresh install (no prefs keys)`() {
        // Fresh install: no agent_name or search_provider in prefs
        val seed = AgentPreferencesStore.seedFromPrefs(prefs)
        assertEquals(AgentPreferences(), seed)
    }

    @Test
    fun `seedFromPrefs preserves existing prefs value (upgrade path)`() {
        prefs.edit()
            .putString("agent_name", "Cortana")
            .putString("search_provider", "exa")
            .apply()
        val seed = AgentPreferencesStore.seedFromPrefs(prefs)
        assertEquals("Cortana", seed.agentName)
        assertEquals("exa", seed.searchProvider)
    }

    @Test
    fun `seedFromPrefs preserves existing long agentName verbatim - never truncates (v3 §1)`() {
        // BAT-515 v3 §1 + Codex final guard: existing 100-char name MUST survive migration
        // unchanged. A previous truncate-with-WARN proposal was rejected by Codex as data loss.
        val longName = "A".repeat(100)
        prefs.edit().putString("agent_name", longName).apply()
        val seed = AgentPreferencesStore.seedFromPrefs(prefs)
        assertEquals(100, seed.agentName.length)
        assertEquals(longName, seed.agentName)
    }

    @Test
    fun `seedFromPrefs falls back to default for unknown searchProvider`() {
        // If prefs got corrupted with an unknown provider id (e.g., from a future
        // build that added a provider then rolled back), fall back rather than
        // poisoning the file.
        prefs.edit().putString("search_provider", "unknown-future-provider").apply()
        val seed = AgentPreferencesStore.seedFromPrefs(prefs)
        assertEquals("brave", seed.searchProvider)
    }

    @Test
    fun `seedFromPrefs falls back to default for blank agentName`() {
        prefs.edit().putString("agent_name", "").apply()
        val seed = AgentPreferencesStore.seedFromPrefs(prefs)
        assertEquals("MyAgent", seed.agentName)
    }

    // ── validateForWrite context-sensitive (BAT-515 v3 §1 final guard) ──

    @Test
    fun `validateForWrite accepts known searchProvider`() {
        AgentPreferences.KNOWN_SEARCH_PROVIDERS.forEach { provider ->
            val current = AgentPreferences()
            val next = current.copy(searchProvider = provider)
            // Should NOT throw
            AgentPreferencesStore.validateForWrite(next, current)
        }
    }

    @Test
    fun `validateForWrite rejects unknown searchProvider when changing`() {
        val current = AgentPreferences()
        val next = current.copy(searchProvider = "duckduckgo")
        try {
            AgentPreferencesStore.validateForWrite(next, current)
            fail("expected IllegalArgumentException")
        } catch (e: IllegalArgumentException) {
            assertTrue(
                "error message should mention searchProvider",
                e.message?.contains("searchProvider") == true,
            )
        }
    }

    @Test
    fun `validateForWrite rejects empty agentName when changing`() {
        val current = AgentPreferences(agentName = "Cortana")
        val next = current.copy(agentName = "")
        try {
            AgentPreferencesStore.validateForWrite(next, current)
            fail("expected IllegalArgumentException")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message?.contains("agentName") == true)
        }
    }

    @Test
    fun `validateForWrite rejects 65-char agentName when changing`() {
        val current = AgentPreferences(agentName = "Cortana")
        val next = current.copy(agentName = "A".repeat(65))
        try {
            AgentPreferencesStore.validateForWrite(next, current)
            fail("expected IllegalArgumentException")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message?.contains("length") == true)
        }
    }

    @Test
    fun `validateForWrite accepts existing long agentName when unchanged (Codex final guard)`() {
        // CRITICAL: this is the Codex final implementation guard.
        // A user with a pre-existing 100-char name calls saveConfig
        // changing some unrelated provider/auth field. The
        // saveConfig-built AgentPreferences carries the same 100-char
        // agentName. validateForWrite must NOT reject just because
        // the name is over-cap — it's unchanged.
        val longName = "A".repeat(100)
        val current = AgentPreferences(agentName = longName)
        val next = current.copy(searchProvider = "exa") // unrelated field changes
        // Must NOT throw
        AgentPreferencesStore.validateForWrite(next, current)
    }

    @Test
    fun `validateForWrite rejects new 65-char even when current is over-cap`() {
        // Existing name is 100 chars (migrated). User edits to a NEW 65-char name.
        // The new name IS a change, so it goes through the cap → rejected.
        val current = AgentPreferences(agentName = "A".repeat(100))
        val next = current.copy(agentName = "B".repeat(65))
        try {
            AgentPreferencesStore.validateForWrite(next, current)
            fail("expected IllegalArgumentException")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message?.contains("length") == true)
        }
    }

    @Test
    fun `validateForWrite accepts blank old searchProvider unchanged`() {
        // Defensive: if persisted state somehow has an empty searchProvider
        // (shouldn't happen — data class defaults to brave), unchanged-skip
        // means no validation. This proves the skip is purely on equality.
        val current = AgentPreferences(searchProvider = "")
        val next = current.copy(agentName = "NewName")
        // Must NOT throw on the (unchanged) blank searchProvider
        AgentPreferencesStore.validateForWrite(next, current)
    }

    // ── mirrorIfChanged (BAT-515 v3 §3 redundancy guard) ───────────

    @Test
    fun `mirrorIfChanged returns false when prefs already match`() {
        prefs.edit()
            .putString("agent_name", "Cortana")
            .putString("search_provider", "exa")
            .apply()
        val initialApplyCount = prefs.applyCount
        val observed = AgentPreferences(agentName = "Cortana", searchProvider = "exa")
        val applied = AgentPreferencesStore.mirrorIfChanged(prefs, observed)
        assertFalse("redundant emission should be no-op", applied)
        assertEquals(
            "no editor.apply() should fire on redundant emission",
            initialApplyCount, prefs.applyCount,
        )
    }

    @Test
    fun `mirrorIfChanged writes only changed field`() {
        prefs.edit()
            .putString("agent_name", "Cortana")
            .putString("search_provider", "exa")
            .apply()
        val observed = AgentPreferences(agentName = "Cortana", searchProvider = "tavily")
        // Reset put counts (FakePrefs accumulated them from the seed apply above)
        prefs.putCounts.clear()
        val applied = AgentPreferencesStore.mirrorIfChanged(prefs, observed)
        assertTrue(applied)
        assertEquals("agent_name unchanged → no write", null, prefs.putCounts["agent_name"])
        assertEquals("search_provider changed → 1 write", 1, prefs.putCounts["search_provider"])
    }

    @Test
    fun `mirrorIfChanged writes both when both differ`() {
        // Fresh prefs (no values yet)
        val observed = AgentPreferences(agentName = "Athena", searchProvider = "perplexity")
        val applied = AgentPreferencesStore.mirrorIfChanged(prefs, observed)
        assertTrue(applied)
        assertEquals("Athena", prefs.getString("agent_name", null))
        assertEquals("perplexity", prefs.getString("search_provider", null))
    }

    // ── onObserved validity gate (BAT-515 v3 §3) ───────────────────

    @Test
    fun `onObserved rejects unknown searchProvider - no state update no mirror`() {
        AgentPreferencesStore.initForTest(AgentPreferences()) // current state = defaults
        val invalid = AgentPreferences(searchProvider = "unknown")
        val applied = AgentPreferencesStore.onObserved(invalid, prefs)
        assertFalse(applied)
        // _state unchanged
        assertEquals(AgentPreferences(), AgentPreferencesStore.read())
    }

    @Test
    fun `onObserved rejects blank agentName - no state update`() {
        AgentPreferencesStore.initForTest(AgentPreferences())
        val invalid = AgentPreferences(agentName = "")
        val applied = AgentPreferencesStore.onObserved(invalid, prefs)
        assertFalse(applied)
        assertEquals(AgentPreferences(), AgentPreferencesStore.read())
    }

    @Test
    fun `onObserved accepts over-cap agentName from migration paths`() {
        // Migration legitimately carries over-cap names. The gate at
        // observation must not reject — only NEW user edits via
        // write/update enforce the cap.
        AgentPreferencesStore.initForTest(AgentPreferences())
        val migrated = AgentPreferences(agentName = "A".repeat(100), searchProvider = "exa")
        val applied = AgentPreferencesStore.onObserved(migrated, prefs)
        assertTrue(applied)
        assertEquals(100, AgentPreferencesStore.read().agentName.length)
    }

    @Test
    fun `onObserved valid unchanged emission updates state but mirror returns false`() {
        // Seed prefs to match the observation
        prefs.edit()
            .putString("agent_name", "Cortana")
            .putString("search_provider", "exa")
            .apply()
        AgentPreferencesStore.initForTest(AgentPreferences(agentName = "Cortana", searchProvider = "exa"))
        val same = AgentPreferences(agentName = "Cortana", searchProvider = "exa")
        val applied = AgentPreferencesStore.onObserved(same, prefs)
        assertFalse("redundant observation should not trigger mirror/broadcast", applied)
    }

    // ── parseFileStrictOrNull (R1 Copilot — collector strict gate) ─

    @Test
    fun `parseFileStrictOrNull returns null on absent file`() {
        val tmpDir = createTempDir()
        try {
            val absent = java.io.File(tmpDir, "agent_preferences.json")
            assertNull(AgentPreferencesStore.parseFileStrictOrNull(absent))
        } finally {
            tmpDir.deleteRecursively()
        }
    }

    @Test
    fun `parseFileStrictOrNull returns null on parse failure`() {
        val tmpDir = createTempDir()
        try {
            val file = java.io.File(tmpDir, "agent_preferences.json")
            file.writeText("{not valid json}")
            assertNull(AgentPreferencesStore.parseFileStrictOrNull(file))
        } finally {
            tmpDir.deleteRecursively()
        }
    }

    @Test
    fun `parseFileStrictOrNull returns null on empty object (missing fields)`() {
        // BAT-515 v3 §2 + R1 Copilot: kotlinx.serialization would
        // happily decode `{}` to AgentPreferences defaults via the
        // data class defaults. That's exactly the silent-reset path
        // we're guarding against — both fields must be PRESENT.
        val tmpDir = createTempDir()
        try {
            val file = java.io.File(tmpDir, "agent_preferences.json")
            file.writeText("{}")
            assertNull(AgentPreferencesStore.parseFileStrictOrNull(file))
        } finally {
            tmpDir.deleteRecursively()
        }
    }

    @Test
    fun `parseFileStrictOrNull returns null on JSON null`() {
        val tmpDir = createTempDir()
        try {
            val file = java.io.File(tmpDir, "agent_preferences.json")
            file.writeText("null")
            assertNull(AgentPreferencesStore.parseFileStrictOrNull(file))
        } finally {
            tmpDir.deleteRecursively()
        }
    }

    @Test
    fun `parseFileStrictOrNull returns null on JSON array`() {
        val tmpDir = createTempDir()
        try {
            val file = java.io.File(tmpDir, "agent_preferences.json")
            file.writeText("[1,2,3]")
            assertNull(AgentPreferencesStore.parseFileStrictOrNull(file))
        } finally {
            tmpDir.deleteRecursively()
        }
    }

    @Test
    fun `parseFileStrictOrNull returns null on non-string agentName`() {
        val tmpDir = createTempDir()
        try {
            val file = java.io.File(tmpDir, "agent_preferences.json")
            file.writeText("""{"searchProvider":"brave","agentName":12345}""")
            assertNull(AgentPreferencesStore.parseFileStrictOrNull(file))
        } finally {
            tmpDir.deleteRecursively()
        }
    }

    @Test
    fun `parseFileStrictOrNull returns null on unknown searchProvider`() {
        val tmpDir = createTempDir()
        try {
            val file = java.io.File(tmpDir, "agent_preferences.json")
            file.writeText("""{"searchProvider":"duckduckgo","agentName":"Cortana"}""")
            assertNull(AgentPreferencesStore.parseFileStrictOrNull(file))
        } finally {
            tmpDir.deleteRecursively()
        }
    }

    @Test
    fun `parseFileStrictOrNull returns null on blank agentName`() {
        val tmpDir = createTempDir()
        try {
            val file = java.io.File(tmpDir, "agent_preferences.json")
            file.writeText("""{"searchProvider":"brave","agentName":""}""")
            assertNull(AgentPreferencesStore.parseFileStrictOrNull(file))
        } finally {
            tmpDir.deleteRecursively()
        }
    }

    @Test
    fun `parseFileStrictOrNull accepts valid file with both fields`() {
        val tmpDir = createTempDir()
        try {
            val file = java.io.File(tmpDir, "agent_preferences.json")
            file.writeText("""{"searchProvider":"exa","agentName":"Cortana"}""")
            val parsed = AgentPreferencesStore.parseFileStrictOrNull(file)
            assertNotNull(parsed)
            assertEquals("exa", parsed!!.searchProvider)
            assertEquals("Cortana", parsed.agentName)
        } finally {
            tmpDir.deleteRecursively()
        }
    }

    @Test
    fun `parseFileStrictOrNull accepts over-cap agentName from migration paths`() {
        // v3 §1: migration paths legitimately carry over-cap names;
        // the cap only applies at the NEW-edit boundary. The strict
        // parse must allow them through so an existing user's long
        // name survives a downgrade or a service restart.
        val longName = "A".repeat(100)
        val tmpDir = createTempDir()
        try {
            val file = java.io.File(tmpDir, "agent_preferences.json")
            file.writeText("""{"searchProvider":"brave","agentName":"$longName"}""")
            val parsed = AgentPreferencesStore.parseFileStrictOrNull(file)
            assertNotNull(parsed)
            assertEquals(100, parsed!!.agentName.length)
        } finally {
            tmpDir.deleteRecursively()
        }
    }

    @Test
    fun `parseFileStrictOrNull tolerates unknown forward-build keys`() {
        // ignoreUnknownKeys = true mirrors CrossProcessStore — a
        // future build that adds new fields can roll back to current
        // build without crashing its own data.
        val tmpDir = createTempDir()
        try {
            val file = java.io.File(tmpDir, "agent_preferences.json")
            file.writeText("""{"searchProvider":"brave","agentName":"X","futureField":"v2"}""")
            val parsed = AgentPreferencesStore.parseFileStrictOrNull(file)
            assertNotNull(parsed)
            assertEquals("X", parsed!!.agentName)
        } finally {
            tmpDir.deleteRecursively()
        }
    }

    // --- helpers ---

    private fun fail(msg: String): Nothing = throw AssertionError(msg)

    private fun createTempDir(): java.io.File {
        val dir = java.io.File.createTempFile("bat515-test-", "")
        if (!dir.delete()) throw java.io.IOException("Failed to delete tmp file before mkdir")
        if (!dir.mkdir()) throw java.io.IOException("Failed to create tmp dir")
        return dir
    }

    private class FakePrefs : SharedPreferences {
        private val map = mutableMapOf<String, String?>()
        var applyCount = 0
        val putCounts = mutableMapOf<String, Int>()

        override fun getAll(): MutableMap<String, *> = map.toMutableMap()
        // R13 Copilot: distinguish "key absent" from "key present with
        // stored null" so the fake matches SharedPreferences contract.
        // `map[key] ?: defValue` would return `defValue` for both
        // cases, hiding bugs where a present-but-null value should
        // surface as null (the real platform never lets a key carry
        // null since putString(key, null) removes — see FakeEditor
        // putString below — but defensive symmetry costs nothing).
        override fun getString(key: String, defValue: String?): String? =
            if (map.containsKey(key)) map[key] else defValue
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
                // R13 Copilot: real `SharedPreferences.Editor.putString`
                // treats `value == null` as a remove. Mapping it the
                // same way here keeps `contains()` / `getString()`
                // semantics consistent between the fake and prod —
                // and matches how `mirrorIfChanged` would later
                // round-trip such a value.
                if (value == null) {
                    pending.remove(key)
                    removals += key
                } else {
                    removals.remove(key)
                    pending[key] = value
                }
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
