package com.seekerclaw.app.config

import com.seekerclaw.app.state.OpenAIOAuthTokenStore
import com.seekerclaw.app.testing.TwoProcessPrefs
import com.seekerclaw.app.util.ProcessRole
import com.seekerclaw.app.util.SafeFs
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File

/**
 * BAT-1157 (D12 / BAT-1661 D6.1): only MAIN writes `seekerclaw_prefs`.
 *
 * Uses [TwoProcessPrefs], where each process caches prefs once and every commit writes that
 * process's WHOLE cached map — Android's real behaviour, and the root cause of the bug: a `:node`
 * write puts back settings MAIN changed since `:node` loaded its cache.
 */
class MainPrefsProcessTest {
    private lateinit var dir: File
    private lateinit var prefs: TwoProcessPrefs

    private val codec = object : SecretCodec {
        override fun seal(plain: String) = "enc:$plain"
        override fun open(sealed: String) = sealed.removePrefix("enc:")
    }

    @Before
    fun setUp() {
        dir = File.createTempFile("bat1157-prefs", "").apply { delete(); mkdirs() }
        SafeFs.filesRoot = dir.toPath()
        prefs = TwoProcessPrefs(dir)
        prefs.disk["model"] = "A"
        prefs.disk["agent_name"] = "Old"
        OpenAIOAuthTokenStore.initForTest(dir, codec)
    }

    @After
    fun tearDown() {
        ProcessRole.setForTest(null)
        OpenAIOAuthTokenStore.resetForTest()
        SafeFs.filesRoot = null
        dir.deleteRecursively()
    }

    @Test
    fun `negative control — a node commit from a stale cache puts back the old settings`() {
        val nodeView = prefs.context("node").getSharedPreferences(PrefsNames.MAIN, 0)
        assertEquals("A", nodeView.getString("model", null)) // :node caches A
        prefs.context("main").getSharedPreferences(PrefsNames.MAIN, 0).edit().putString("model", "B").commit()
        assertEquals("B", prefs.disk["model"])
        // Any :node write — even of an unrelated key — writes its whole stale map back.
        nodeView.edit().putString("owner_id", "123").commit()
        assertEquals("the race the gate exists for", "A", prefs.disk["model"])
    }

    @Test
    fun `negative control — a node that only OPENED prefs before a MAIN save still clobbers it on commit`() {
        val nodeView = prefs.context("node").getSharedPreferences(PrefsNames.MAIN, 0) // opened, never read
        prefs.context("main").getSharedPreferences(PrefsNames.MAIN, 0).edit().putString("model", "B").commit()
        nodeView.edit().putString("owner_id", "123").commit()
        assertEquals("the cache loaded at open is written back whole", "A", prefs.disk["model"])
    }

    @Test
    fun `in node, forWrite refuses and the read view has no way to edit`() {
        ProcessRole.setForTest(true)
        val node = prefs.context("node")
        assertNull(MainPrefs.forWrite(node, "test"))
        assertEquals("A", MainPrefs.read(node).getString("model", null))
        ProcessRole.setForTest(false)
        assertNotNull(MainPrefs.forWrite(prefs.context("main"), "test"))
    }

    @Test
    fun `MAIN saves a new model, node rotates the sign-in — both survive (contract v1 test 1)`() {
        ProcessRole.setForTest(true)
        prefs.context("node").getSharedPreferences(PrefsNames.MAIN, 0) // :node has a cache from before the save
        val signed = OpenAIOAuthTokenStore.signIn("acc", "ref", "", "t") as OpenAIOAuthTokenStore.Result.Ok
        ProcessRole.setForTest(false)
        MainPrefs.forWrite(prefs.context("main"), "settings")!!.edit().putString("model", "B").putString("agent_name", "New").commit()
        ProcessRole.setForTest(true)
        // The :node rotation goes to the store only; no prefs write is even possible from :node.
        val rotated = OpenAIOAuthTokenStore.rotate(signed.record.familyId, signed.record.epoch, "r1", "acc2", "ref2", "t2")
        assertTrue(rotated is OpenAIOAuthTokenStore.Result.Ok)
        assertNull(MainPrefs.forWrite(prefs.context("node"), "rotation"))
        // A fresh read keeps both the new settings and the rotated pair.
        prefs.restart("main")
        val main = MainPrefs.read(prefs.context("main"))
        assertEquals("B", main.getString("model", null))
        assertEquals("New", main.getString("agent_name", null))
        val live = OpenAIOAuthTokenStore.livePair(OpenAIOAuthTokenStore.snapshot())!!
        assertEquals("acc2", live.access)
        assertEquals("ref2", live.refresh)
    }

    /**
     * Codex diff review #2 (ed09115a): Android drops removed keys from the cache before writing the
     * file, so after a failed commit `contains()` already says the legacy keys are gone. The sweep
     * must stay pending and retry with a real write. Negative control: make the sweep trust
     * `contains()` (drop the `pending` check) and no retry is ever sent, so the cold read still
     * finds the legacy token. ([TwoProcessPrefs] models AOSP's disk/memory generations, so the
     * counter bump in `commitLegacySweep` is defence in depth, not what this test pins.)
     */
    @Test
    fun `a failed legacy sweep commit is retried by a later load with a real write (Codex #2)`() {
        ConfigManager.resetLegacySweepForTest()
        try {
            prefs.disk["openai_oauth_token_enc"] = "enc:acc"
            prefs.disk["openai_oauth_refresh_enc"] = "enc:ref"
            ProcessRole.setForTest(false)
            val main = prefs.context("main")
            assertEquals(OpenAIOAuthTokenStore.MigrateOutcome.DONE,
                OpenAIOAuthTokenStore.migrateIfNeeded { OpenAIOAuthTokenStore.LegacyPair("enc:acc", "enc:ref", "", "", "") })

            prefs.failNextCommits = 1
            ConfigManager.sweepLegacyOpenAIOAuthKeysIfConfirmed(main, MainPrefs.read(main))
            assertEquals("the file still holds the token", "enc:acc", prefs.disk["openai_oauth_token_enc"])
            assertFalse("…while the cache already lacks it", MainPrefs.read(main).contains("openai_oauth_token_enc"))
            assertTrue(ConfigManager.legacySweepPendingForTest("openai_oauth_token_enc"))

            // Another load in the same process, after the back-off.
            ConfigManager.skipLegacySweepBackoffForTest()
            ConfigManager.sweepLegacyOpenAIOAuthKeysIfConfirmed(main, MainPrefs.read(main))
            assertFalse(ConfigManager.legacySweepPendingForTest("openai_oauth_token_enc"))
            assertEquals("the retry reached the file", 1, prefs.diskWrites)

            prefs.restart("main") // cold read
            val cold = MainPrefs.read(prefs.context("main"))
            assertFalse("swept on disk", cold.contains("openai_oauth_token_enc"))
            assertFalse(cold.contains("openai_oauth_refresh_enc"))
            assertEquals("unrelated settings untouched", "A", cold.getString("model", null))
        } finally {
            ConfigManager.resetLegacySweepForTest()
        }
    }

    /**
     * Reviewer finding (KEEP_LEGACY latch): a legacy access token kept because the store was Absent
     * under its marker must be swept by the NEXT sign-in in the same process, not only after a
     * restart. Negative control: drop `rearmOpenAILegacySweep()` from `signInOpenAI`.
     */
    @Test
    fun `a sign-in after KEEP_LEGACY sweeps the kept legacy copy in the same process`() {
        ConfigManager.resetLegacySweepForTest()
        try {
            prefs.disk["openai_oauth_token_enc"] = "enc:old"
            ProcessRole.setForTest(false)
            val main = prefs.context("main")
            File(dir, OpenAIOAuthTokenStore.MARKER_NAME).writeText("1") // adopted, record lost
            ConfigManager.sweepLegacyOpenAIOAuthKeysIfConfirmed(main, MainPrefs.read(main))
            assertEquals("KEEP_LEGACY: kept", "enc:old", prefs.disk["openai_oauth_token_enc"])

            assertTrue(ConfigManager.signInOpenAI(main, "acc", "ref", "", "t"))
            assertFalse("swept by the sign-in", prefs.disk.containsKey("openai_oauth_token_enc"))
        } finally {
            ConfigManager.resetLegacySweepForTest()
        }
    }

    @Test
    fun `node rotates, then MAIN commits from a stale cache — the store pair survives (contract v1 test 2)`() {
        val mainView = MainPrefs.forWrite(prefs.context("main"), "settings")!!
        mainView.getString("model", null) // MAIN cached before the rotation
        val signed = OpenAIOAuthTokenStore.signIn("acc", "ref", "", "t") as OpenAIOAuthTokenStore.Result.Ok
        OpenAIOAuthTokenStore.rotate(signed.record.familyId, signed.record.epoch, "r1", "acc2", "ref2", "t2")
        mainView.edit().putString("model", "C").commit()
        assertEquals("C", prefs.disk["model"])
        assertEquals("the pair lives outside prefs, so a stale prefs commit cannot undo the rotation",
            "acc2", OpenAIOAuthTokenStore.livePair(OpenAIOAuthTokenStore.snapshot())!!.access)
    }
}
