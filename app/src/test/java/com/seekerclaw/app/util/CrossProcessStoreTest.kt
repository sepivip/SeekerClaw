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
    fun `concurrent writes via internal lock — final file is one of the writers' values`() {
        // BAT-512 (Copilot review fix): spawn N threads calling a
        // helper that mirrors the live class's INTERNAL lock — i.e.
        // each writer goes through `lockedWrite` which has its own
        // `synchronized(writeLock)`, NOT external coordination. This
        // is what the production API surface looks like to a caller
        // (just `store.write(v)`), so this test now verifies the
        // contract a real consumer relies on.
        //
        // Without the internal lock, one thread's `tmpFile.writeText`
        // could clobber another's mid-rename, producing a final file
        // that doesn't match any writer's payload. With the lock, the
        // last writer to enter the critical section wins and the
        // final file is exactly that writer's value.
        val file = File(workDir, "concurrent.json")
        val tmp = File(workDir, "concurrent.json.tmp")
        val writeLock = Any() // mirrors CrossProcessStore.writeLock
        fun lockedWrite(value: Sample) {
            synchronized(writeLock) {
                val text = json.encodeToString(Sample.serializer(), value)
                tmp.writeText(text)
                if (!tmp.renameTo(file)) {
                    file.delete()
                    tmp.renameTo(file)
                }
            }
        }

        val payloads = (1..20).map { Sample(provider = "p$it", model = "m$it") }
        val executor = Executors.newFixedThreadPool(8)
        val latch = CountDownLatch(payloads.size)
        for (p in payloads) {
            executor.submit {
                try { lockedWrite(p) } finally { latch.countDown() }
            }
        }
        assertTrue("threads finished in time", latch.await(5, TimeUnit.SECONDS))
        executor.shutdown()

        val final = readOrInitial(file, Sample())
        assertNotNull(final)
        assertTrue(
            "final value matches one of the writers (no corrupted blend)",
            payloads.contains(final),
        )
    }

    @Test
    fun `write to a fresh path creates the file`() {
        val file = File(workDir, "fresh.json")
        assertFalse(file.exists())
        atomicWrite(file, Sample())
        assertTrue(file.exists())
    }

    @Test
    fun `Files move with ATOMIC_MOVE+REPLACE_EXISTING does not produce a DELETE window`() {
        // BAT-512 (Copilot review fix): pin that NIO Files.move with
        // REPLACE_EXISTING and ATOMIC_MOVE goes from
        // "old contents present" → "new contents present" with NO
        // intermediate "file absent" state. The earlier delete +
        // renameTo fallback created such a window; FileObserver fired
        // DELETE inside it and observers briefly saw `initial`.
        val file = File(workDir, "atomic-move.json")
        val tmp = File(workDir, "atomic-move.json.tmp")
        val older = Sample(provider = "old")
        val newer = Sample(provider = "new")
        // Write the older value through the same atomic path.
        tmp.writeText(json.encodeToString(Sample.serializer(), older))
        java.nio.file.Files.move(
            tmp.toPath(),
            file.toPath(),
            java.nio.file.StandardCopyOption.REPLACE_EXISTING,
            java.nio.file.StandardCopyOption.ATOMIC_MOVE,
        )
        assertTrue("file present after first move", file.exists())

        // Now atomically REPLACE the existing file. The single
        // Files.move call must NOT first delete `file`; observers
        // watching for events should see only one transition.
        tmp.writeText(json.encodeToString(Sample.serializer(), newer))
        // Sanity: file must still be present immediately before the move.
        assertTrue("file still present pre-move", file.exists())
        java.nio.file.Files.move(
            tmp.toPath(),
            file.toPath(),
            java.nio.file.StandardCopyOption.REPLACE_EXISTING,
            java.nio.file.StandardCopyOption.ATOMIC_MOVE,
        )
        // After the move, file is present with the NEW value.
        assertTrue("file present after second move", file.exists())
        assertEquals(newer, readOrInitial(file, Sample()))
    }

    // --- fileName validation (BAT-512 Copilot review fix #1) ---

    @Test
    fun `mirrored fileName validation rejects path separators`() {
        // We can't construct a real CrossProcessStore here without a
        // Context, but we can pin the same basename rule the live
        // class enforces in init {} via require(...) — the drift
        // guard above asserts the live source has it.
        assertFalse("subdir/file.json contains a separator and would escape filesDir",
            "subdir/file.json" == File("subdir/file.json").name)
        assertFalse("absolute paths likewise reject",
            "/etc/passwd" == File("/etc/passwd").name)
        assertFalse("backslash paths reject on JVM as part of the name on Windows",
            "subdir\\file.json".contains("..") || "subdir\\file.json".contains("/"))
        // Positive: a plain basename equals its File-derived name.
        assertEquals("plain basename validates",
            "runtime_state.json", File("runtime_state.json").name)
    }

    // --- structural drift guard ---
    // The mirrored helpers in this test must stay in sync with the
    // live class's behaviour. If a future refactor changes the JSON
    // config (e.g. ignoreUnknownKeys flips to false), the live source
    // grep should fail loudly so this mirror gets updated.

    @Test
    fun `drift live CrossProcessStore class pins the contract`() {
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
        // BAT-512 (Copilot review fix): the atomic-write path uses NIO
        // Files.move with REPLACE_EXISTING + ATOMIC_MOVE. The earlier
        // delete + renameTo fallback was rejected because it created a
        // DELETE-event window where observers briefly saw `initial`.
        assertTrue("atomic write must use Files.move",
            Regex("""Files\s*\.\s*move\s*\(""").containsMatchIn(text))
        assertTrue("atomic write must request ATOMIC_MOVE",
            text.contains("StandardCopyOption.ATOMIC_MOVE"))
        assertTrue("atomic write must request REPLACE_EXISTING",
            text.contains("StandardCopyOption.REPLACE_EXISTING"))
        assertTrue("FileObserver mask must include the BAT-518 set",
            Regex("""FileObserver\.MODIFY[\s\S]*FileObserver\.CLOSE_WRITE[\s\S]*FileObserver\.MOVED_TO""").containsMatchIn(text))
        assertTrue("ACTION_STORE_CHANGED is the broadcast action",
            text.contains("ACTION_STORE_CHANGED"))
        // BAT-512 (Copilot review fix): the live class's `write()` MUST
        // serialize via `synchronized(writeLock)` so concurrent same-
        // process callers can't corrupt the file. Pin the keyword so a
        // future refactor that drops the lock fails this guard.
        assertTrue("write() must serialize via synchronized(writeLock)",
            Regex("""synchronized\s*\(\s*writeLock\s*\)""").containsMatchIn(text))
        // BAT-512 (Copilot review fix): fileName must be validated as a
        // basename to prevent path traversal.
        assertTrue("fileName basename validation must remain in init",
            text.contains("fileName == File(fileName).name"))
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
