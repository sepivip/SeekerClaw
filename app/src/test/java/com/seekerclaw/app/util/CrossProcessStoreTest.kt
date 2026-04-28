package com.seekerclaw.app.util

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Pure JVM tests for CrossProcessStore's file I/O + serialization
 * contract. The Android-specific surfaces (FileObserver, BroadcastReceiver)
 * are validated by device test, not here — same convention
 * LogCollectorTest and ServiceStateTest follow.
 *
 * The tests exercise the read/write/atomic/serialization invariants
 * directly against a temp directory rather than instantiating
 * CrossProcessStore (which needs a Context). The logic under test is
 * the file format + atomicity + idempotency contract that the class
 * promises; we mirror it here and pin the live class's structural
 * shape via grep at the end so the mirror can't drift silently.
 */
class CrossProcessStoreTest {

    @Serializable
    data class Sample(
        val provider: String = "anthropic",
        val model: String = "claude-sonnet-4-6",
        val authType: String = "api_key",
    )

    private lateinit var workDir: File
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    @Before
    fun setUp() {
        workDir = File.createTempFile("bat512-store", "").apply {
            delete()
            mkdirs()
        }
    }

    @After
    fun tearDown() {
        workDir.deleteRecursively()
    }

    // --- read ---

    @Test
    fun `read returns initial when file does not exist`() {
        val file = File(workDir, "absent.json")
        val initial = Sample()
        val value = readOrInitial(file, initial)
        assertEquals(initial, value)
    }

    @Test
    fun `read returns initial when file is malformed JSON`() {
        val file = File(workDir, "broken.json")
        file.writeText("{ this is not json")
        val initial = Sample(provider = "fallback")
        val value = readOrInitial(file, initial)
        assertEquals(initial, value)
    }

    @Test
    fun `read returns parsed value when file is well-formed`() {
        val file = File(workDir, "ok.json")
        val payload = Sample(provider = "openai", model = "gpt-5.2", authType = "oauth")
        file.writeText(json.encodeToString(Sample.serializer(), payload))
        val value = readOrInitial(file, Sample())
        assertEquals(payload, value)
    }

    @Test
    fun `read tolerates unknown keys (ignoreUnknownKeys)`() {
        // BAT-511 family must survive forward-compatibility — a future
        // build that adds a new field shouldn't make the current build
        // crash on its own data. ignoreUnknownKeys=true is the
        // configured behaviour we're pinning.
        val file = File(workDir, "extra.json")
        file.writeText("""{"provider":"anthropic","model":"claude-sonnet-4-6","authType":"api_key","futureField":"unknown"}""")
        val value = readOrInitial(file, Sample())
        assertEquals(Sample(), value)
    }

    @Test
    fun `read is idempotent — same file yields same value`() {
        val file = File(workDir, "idem.json")
        val payload = Sample(provider = "openai")
        file.writeText(json.encodeToString(Sample.serializer(), payload))
        val a = readOrInitial(file, Sample())
        val b = readOrInitial(file, Sample())
        val c = readOrInitial(file, Sample())
        assertEquals(a, b)
        assertEquals(b, c)
    }

    // --- write ---

    @Test
    fun `write produces a parseable JSON file`() {
        val file = File(workDir, "out.json")
        val payload = Sample(provider = "openai", model = "gpt-5.3", authType = "oauth")
        atomicWrite(file, payload)
        assertTrue(file.exists())
        val roundTripped = readOrInitial(file, Sample())
        assertEquals(payload, roundTripped)
    }

    @Test
    fun `write then read round-trips exactly`() {
        val file = File(workDir, "rt.json")
        val original = Sample(provider = "openai", model = "gpt-5.5", authType = "api_key")
        atomicWrite(file, original)
        val readBack = readOrInitial(file, Sample())
        assertEquals(original, readBack)
    }

    @Test
    fun `write is atomic — leftover tmp file does not corrupt the main file`() {
        // Simulate a crash partway through `tmpFile.writeText` then
        // `renameTo`: the tmp file exists with a partial payload, but
        // the main file still contains the previous good value. A
        // reader (which only ever opens the main file path) sees the
        // intact prior state.
        val file = File(workDir, "atomic.json")
        val tmp = File(workDir, "atomic.json.tmp")
        val good = Sample(provider = "anthropic", model = "claude-opus-4-7")
        atomicWrite(file, good)

        // Write a partial/garbage payload to the tmp file but DON'T
        // rename. Mirrors a process kill mid-write.
        tmp.writeText("{ partial...")

        // Reader still sees the good value.
        val seen = readOrInitial(file, Sample())
        assertEquals(good, seen)
        assertTrue("tmp file leaked but is harmless", tmp.exists())
    }

    @Test
    fun `concurrent writes from same process serialize via lock`() {
        // Spawn N threads all writing distinct values. The final file
        // contents must match exactly one of the writers' values
        // (last-write-wins) — never a corrupted blend.
        val file = File(workDir, "concurrent.json")
        val payloads = (1..20).map { Sample(provider = "p$it", model = "m$it") }
        val executor = Executors.newFixedThreadPool(8)
        val latch = CountDownLatch(payloads.size)
        val lock = Any()

        for (p in payloads) {
            executor.submit {
                try {
                    synchronized(lock) {
                        atomicWrite(file, p)
                    }
                } finally {
                    latch.countDown()
                }
            }
        }
        assertTrue("threads finished in time", latch.await(5, TimeUnit.SECONDS))
        executor.shutdown()

        val final = readOrInitial(file, Sample())
        assertNotNull(final)
        assertTrue("final value matches one of the writers",
            payloads.contains(final))
    }

    @Test
    fun `write to a fresh path creates the file`() {
        val file = File(workDir, "fresh.json")
        assertFalse(file.exists())
        atomicWrite(file, Sample())
        assertTrue(file.exists())
    }

    // --- structural drift guard ---
    // The mirrored helpers in this test must stay in sync with the
    // live class's behaviour. If a future refactor changes the JSON
    // config (e.g. ignoreUnknownKeys flips to false), the live source
    // grep should fail loudly so this mirror gets updated.

    @Test
    fun `drift live CrossProcessStore class declares ignoreUnknownKeys true`() {
        val src = File(
            "src/main/java/com/seekerclaw/app/util/CrossProcessStore.kt"
        ).takeIf { it.exists() } ?: File(
            "../app/src/main/java/com/seekerclaw/app/util/CrossProcessStore.kt"
        ).takeIf { it.exists() } ?: File(
            "app/src/main/java/com/seekerclaw/app/util/CrossProcessStore.kt"
        )
        assertTrue("CrossProcessStore.kt locatable from test cwd", src.exists())
        val text = src.readText()
        assertTrue("ignoreUnknownKeys must remain true (forward-compat invariant)",
            Regex("""ignoreUnknownKeys\s*=\s*true""").containsMatchIn(text))
        assertTrue("Json must encodeDefaults so first-write hydrate stays stable",
            Regex("""encodeDefaults\s*=\s*true""").containsMatchIn(text))
        assertTrue("atomic write must use tmp + renameTo",
            Regex("""tmpFile\s*\.\s*renameTo""").containsMatchIn(text))
        assertTrue("FileObserver mask must include the BAT-518 set",
            Regex("""FileObserver\.MODIFY[\s\S]*FileObserver\.CLOSE_WRITE[\s\S]*FileObserver\.MOVED_TO""").containsMatchIn(text))
        assertTrue("ACTION_STORE_CHANGED is the broadcast action",
            text.contains("ACTION_STORE_CHANGED"))
    }

    // --- helpers (mirror the live class) ---

    private fun readOrInitial(file: File, initial: Sample): Sample {
        if (!file.exists()) return initial
        return try {
            json.decodeFromString(Sample.serializer(), file.readText())
        } catch (_: Exception) {
            initial
        }
    }

    private fun atomicWrite(file: File, value: Sample) {
        val tmp = File(file.parentFile, file.name + ".tmp")
        val text = json.encodeToString(Sample.serializer(), value)
        tmp.writeText(text)
        if (!tmp.renameTo(file)) {
            file.delete()
            tmp.renameTo(file)
        }
    }
}
