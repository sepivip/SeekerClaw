package com.seekerclaw.app.util

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
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
        // could clobber another's mid-move, producing a final file
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
                // Mirror the live class's atomic move (BAT-512 Copilot
                // review fix): NIO Files.move with REPLACE_EXISTING +
                // ATOMIC_MOVE, no delete+rename fallback that would
                // open a DELETE-event window.
                java.nio.file.Files.move(
                    tmp.toPath(),
                    file.toPath(),
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                    java.nio.file.StandardCopyOption.ATOMIC_MOVE,
                )
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

    // --- fileName validation (BAT-512 Copilot review fix #1, refined in fix #2) ---

    @Test
    fun `isValidFileName accepts plain basenames`() {
        // Pure-function validation lives in the companion as
        // `CrossProcessStore.isValidFileName(...)`. Tests can target
        // it directly without needing a Context, so the production
        // contract is what's actually validated (not a tautological
        // mirror).
        assertTrue(CrossProcessStore.isValidFileName("runtime_state.json"))
        assertTrue(CrossProcessStore.isValidFileName("config.json"))
        assertTrue(CrossProcessStore.isValidFileName("dot.containing.name.json"))
    }

    @Test
    fun `isValidFileName rejects empty input`() {
        assertFalse(CrossProcessStore.isValidFileName(""))
    }

    @Test
    fun `isValidFileName rejects path separators (forward and back slash)`() {
        assertFalse("forward-slash separator escapes filesDir",
            CrossProcessStore.isValidFileName("subdir/file.json"))
        assertFalse("absolute path escapes filesDir",
            CrossProcessStore.isValidFileName("/etc/passwd"))
        assertFalse("backslash separator (Windows-style) rejected too",
            CrossProcessStore.isValidFileName("subdir\\file.json"))
    }

    @Test
    fun `isValidFileName rejects parent-directory traversal`() {
        assertFalse("'..' anywhere is a traversal attempt",
            CrossProcessStore.isValidFileName(".."))
        assertFalse("'../foo.json' would escape filesDir",
            CrossProcessStore.isValidFileName("../foo.json"))
        assertFalse("'foo/..' would still be ambiguous; reject",
            CrossProcessStore.isValidFileName("foo/.."))
    }

    // --- BAT-512 round-3 Copilot review fixes ---

    @Test
    fun `drift live source uses Channel CONFLATED to coalesce reload signals`() {
        // BAT-512 (Copilot review fix #2+3): the FileObserver and
        // broadcast receiver paths must funnel events into a single
        // CONFLATED channel + drain coroutine, not launch concurrent
        // reload coroutines. Concurrent reloads can finish out of
        // order and publish a stale on-disk value AFTER a newer one
        // — a real race that regresses _state.
        val src = locateLiveSource()
        val text = src.readText()
        assertTrue("must declare a Channel for reload coalescing",
            Regex("""reloadChannel\s*:\s*Channel<Unit>""").containsMatchIn(text) ||
                Regex("""reloadChannel\s*=\s*Channel\s*\(\s*Channel\.CONFLATED""").containsMatchIn(text))
        assertTrue("channel capacity must be CONFLATED so bursts coalesce",
            text.contains("Channel.CONFLATED"))
        assertTrue("FileObserver path must trySend on the channel, not launch directly",
            Regex("""reloadChannel\.trySend""").containsMatchIn(text))
        // Negative pin: the OLD pattern (launching reload directly
        // INSIDE FileObserver.onEvent / BroadcastReceiver.onReceive)
        // must be gone — that's the path that introduced the
        // concurrent-reload race.
        //
        // Round-6 added a launch{reload()} in the init block (deferred
        // catch-up read off the caller thread); that's a different
        // use case and is allowed. Pin scoped to the two callback
        // bodies so init's pattern doesn't trip this guard.
        val onEventBody = Regex("""override\s+fun\s+onEvent\b[\s\S]*?\n\s{12}\}""")
            .find(text)?.value ?: error("FileObserver.onEvent body not found")
        val onReceiveBody = Regex("""override\s+fun\s+onReceive\b[\s\S]*?\n\s{12}\}""")
            .find(text)?.value ?: error("BroadcastReceiver.onReceive body not found")
        assertFalse(
            "FileObserver.onEvent must NOT launch reload directly",
            Regex("""coroutineScope\.launch\s*\{\s*reload\s*\(\s*\)\s*\}""").containsMatchIn(onEventBody),
        )
        assertFalse(
            "BroadcastReceiver.onReceive must NOT launch reload directly",
            Regex("""coroutineScope\.launch\s*\{\s*reload\s*\(\s*\)\s*\}""").containsMatchIn(onReceiveBody),
        )
    }

    @Test
    fun `drift live source declares closed flag for post-close reload suppression`() {
        // BAT-512 (Copilot review fix #1): even with an external scope
        // we don't cancel, reload() must short-circuit when closed
        // so a coroutine in flight at close-time can't publish
        // afterwards.
        val src = locateLiveSource()
        val text = src.readText()
        assertTrue("must declare a closed: AtomicBoolean flag",
            Regex("""closed\s*=\s*AtomicBoolean""").containsMatchIn(text))
        assertTrue("reload() must short-circuit on closed",
            Regex("""fun\s+reload\s*\([^)]*\)\s*\{[\s\S]*?closed\.get\s*\(\s*\)""").containsMatchIn(text))
        assertTrue("close() must set the flag to true",
            Regex("""closed\.set\s*\(\s*true\s*\)""").containsMatchIn(text))
    }

    @Test
    fun `drift live source deep-clones the initial value on read`() {
        // BAT-512 (Copilot review fix #4 + round-5 + round-7): if T is
        // mutable, returning the constructor's `initial` reference
        // (or the in-class `initialSnapshot` reference directly)
        // would let a caller's mutation poison the store. The
        // production contract is:
        //   1) clone `initial` once into `initialSnapshot` at
        //      construction (round-5)
        //   2) read() returns `cloneSafe(initialSnapshot)` on
        //      missing/malformed paths so each caller gets a fresh
        //      copy
        // Pin both ends of the contract — and scope the read() check
        // to the read() function body so an unrelated mention of
        // `cloneSafe(initialSnapshot)` elsewhere can't satisfy the
        // assertion (the round-7 broken-guard lesson applies here too).
        val src = locateLiveSource()
        val text = src.readText()
        assertTrue(
            "store must snapshot the constructor initial via cloneSafe(initial)",
            Regex("""initialSnapshot\s*:\s*T\s*=\s*cloneSafe\s*\(\s*initial\s*\)""").containsMatchIn(text),
        )
        val readBlock = Regex(
            """fun\s+read\s*\(\s*\)\s*:\s*T\s*\{[\s\S]*?(?=\n\s{4}\}\n)""",
        ).find(text)?.value ?: error("read() function body not found")
        assertTrue(
            "read() must call cloneSafe(initialSnapshot) on missing/malformed paths",
            Regex("""cloneSafe\s*\(\s*initialSnapshot\s*\)""").containsMatchIn(readBlock),
        )
        assertTrue(
            "cloneSafe must round-trip via JSON encode/decode",
            Regex("""json\.decodeFromString\s*\(\s*serializer\s*,\s*json\.encodeToString""").containsMatchIn(text),
        )
    }

    @Test
    fun `drift live source clones T on the WRITE boundary too (mutation symmetry)`() {
        // BAT-512 (Copilot review fixes #4 + round-4 + round-7):
        // write() must clone `value` ONCE up-front and use the
        // resulting `snapshot` for both `encodeToString` (the disk
        // write) AND `_state.value` (the in-memory publish). Without
        // the up-front clone, a caller mutating `value` from another
        // thread between the encode and the assignment could cause
        // disk and `_state` to publish different snapshots.
        //
        // Pin the production contract:
        //   1) `val snapshot: T = cloneSafe(value)` at top of write
        //   2) `_state.value = snapshot` (NOT `cloneSafe(value)` again,
        //      which would cost an extra round-trip and re-introduce
        //      the race window)
        //   3) `encodeToString(serializer, snapshot)` uses the same
        //      stable snapshot for the disk write
        val src = locateLiveSource()
        val text = src.readText()
        val writeBlock = Regex(
            """fun\s+write\s*\(\s*value\s*:\s*T\s*\)\s*\{[\s\S]*?(?=\n\s{4}\}\n)""",
        ).find(text)?.value ?: error("write() function body not found")
        assertTrue(
            "write() must capture `val snapshot: T = cloneSafe(value)` up-front",
            Regex("""val\s+snapshot\s*:\s*T\s*=\s*cloneSafe\s*\(\s*value\s*\)""").containsMatchIn(writeBlock),
        )
        assertTrue(
            "_state.value must be assigned the up-front snapshot (not re-cloned)",
            Regex("""_state\.value\s*=\s*snapshot\b""").containsMatchIn(writeBlock),
        )
        assertTrue(
            "disk encode must use the same `snapshot`, not the raw `value`",
            Regex("""encodeToString\s*\(\s*serializer\s*,\s*snapshot\s*\)""").containsMatchIn(writeBlock),
        )
        // Negative pin: the OLD pattern (re-cloning value at the
        // _state assignment) must be gone.
        assertFalse(
            "_state assignment must NOT re-clone value (round-7 fix consolidated to single up-front clone)",
            Regex("""_state\.value\s*=\s*cloneSafe\s*\(\s*value\s*\)""").containsMatchIn(writeBlock),
        )
    }

    @Test
    fun `drift initial reload is dispatched off the caller thread (round-6 threading)`() {
        // BAT-512 (Copilot review fix round-6): the constructor must
        // NOT call reload() synchronously — that does file I/O on
        // whatever thread constructs the store, and BAT-513+ will
        // construct from SeekerClawApplication.onCreate (main).
        // Pin that the catch-up read goes through coroutineScope.
        val src = locateLiveSource()
        val text = src.readText()
        // Find the trailing init block (the one with the drain
        // coroutine, NOT the basename-validation init).
        val initBlocks = Regex("""\binit\s*\{[\s\S]*?\n\s{4}\}""").findAll(text).map { it.value }.toList()
        val mainInit = initBlocks.firstOrNull { it.contains("reloadChannel") || it.contains("reload()") }
            ?: error("main init block not found")
        // BAT-512 (Copilot review fix round-7): the previous version
        // of this guard discarded the regex's match result and
        // returned `wrapped < 1`, which only enforced "at least one
        // launched reload" — NOT "no synchronous reload". Rewritten
        // to actually check what the message claims.
        //
        // Strategy: strip every `coroutineScope.launch { ... reload()
        // ... }` block (including the drain loop's launch) from the
        // init source, then assert no `reload()` call survives in
        // the residue. Anything left is a synchronous call on the
        // caller thread — the regression we're guarding against.
        val mainInitSansComments = mainInit.replace(Regex("""//[^\n]*"""), "")
        val mainInitSansLaunches = mainInitSansComments.replace(
            Regex("""coroutineScope\.launch\s*\{[\s\S]*?\breload\s*\(\s*\)[\s\S]*?\}"""),
            "",
        )
        assertFalse(
            "init must NOT call reload() synchronously on the caller thread",
            Regex("""\breload\s*\(\s*\)""").containsMatchIn(mainInitSansLaunches),
        )
        assertTrue(
            "init must dispatch initial catch-up via coroutineScope.launch { reload() }",
            Regex("""coroutineScope\.launch\s*\{\s*reload\s*\(\s*\)\s*\}""").containsMatchIn(mainInit),
        )
    }

    @Test
    fun `drift broadcastChanged is invoked OUTSIDE synchronized writeLock (round-6 lock contention)`() {
        // BAT-512 (Copilot review fix round-6): sendBroadcast is
        // system IPC and shouldn't be inside the critical section.
        // Pin that broadcastChanged is called AFTER the
        // synchronized(writeLock) block, not inside it.
        val src = locateLiveSource()
        val text = src.readText()
        val writeBlock = Regex(
            """fun\s+write\s*\(\s*value\s*:\s*T\s*\)\s*\{[\s\S]*?(?=\n\s{4}\}\n)""",
        ).find(text)?.value ?: error("write() body not found")
        // Find the synchronized block boundaries.
        val syncStart = writeBlock.indexOf("synchronized(writeLock)")
        assertTrue("synchronized(writeLock) block must exist", syncStart >= 0)
        // Locate the closing brace of the synchronized block — it's
        // the `}` at the same indent depth as the `synchronized`
        // line. Heuristic: find the line `        }` that follows the
        // try/catch/finally and isn't followed by `.something`.
        val syncBlockEnd = writeBlock.indexOf("\n        }\n", syncStart)
        assertTrue("synchronized block close not found", syncBlockEnd >= 0)
        val outsideTheLock = writeBlock.substring(syncBlockEnd)
        assertTrue(
            "broadcastChanged() must be called outside the synchronized block",
            Regex("""broadcastChanged\s*\(\s*\)""").containsMatchIn(outsideTheLock),
        )
        val insideTheLock = writeBlock.substring(syncStart, syncBlockEnd)
        assertFalse(
            "broadcastChanged() must NOT remain inside the synchronized block",
            Regex("""broadcastChanged\s*\(\s*\)""").containsMatchIn(insideTheLock),
        )
    }

    @Test
    fun `drift live source snapshots initial at construction (round-5)`() {
        // BAT-512 (Copilot review fix round-5): the `initial`
        // constructor parameter must be cloned ONCE at construction
        // into `initialSnapshot`. Without this, the caller's
        // original `initial` reference (if T is mutable) could be
        // mutated post-construction and the next missing/malformed
        // read would clone the mutated state.
        val src = locateLiveSource()
        val text = src.readText()
        assertTrue(
            "constructor must NOT store `initial` as a property (must be a non-stored param so the original reference goes out of scope)",
            !Regex("""private\s+val\s+initial\s*:\s*T""").containsMatchIn(text),
        )
        assertTrue(
            "must declare initialSnapshot via cloneSafe(initial) at construction",
            Regex("""initialSnapshot\s*:\s*T\s*=\s*cloneSafe\s*\(\s*initial\s*\)""").containsMatchIn(text),
        )
        assertTrue(
            "read() missing/malformed paths must clone from initialSnapshot",
            Regex("""cloneSafe\s*\(\s*initialSnapshot\s*\)""").containsMatchIn(text),
        )
        // Negative: must not still call cloneSafe(initial) anywhere
        // EXCEPT in the snapshot initializer itself.
        val cloneInitialCount = Regex("""cloneSafe\s*\(\s*initial\s*\)""")
            .findAll(text).count()
        assertEquals(
            "cloneSafe(initial) must appear exactly once — in the initialSnapshot initializer",
            1,
            cloneInitialCount,
        )
    }

    @Test
    fun `drift class-level KDoc declares Mutation safety contract`() {
        // BAT-512 (Copilot review fix round-4 contract): the boundary
        // contract is explicit at the class level so a future
        // maintainer can't accidentally drop one side of the symmetry.
        val src = locateLiveSource()
        val text = src.readText()
        assertTrue(
            "class KDoc must contain the 'Mutation safety' section",
            text.contains("## Mutation safety"),
        )
    }

    @Test
    fun `read returns a fresh instance on missing file (mutating it does not contaminate next read)`() {
        // Mirrors the Node-side contract test. We can't call the live
        // class without a Context, but we can verify the JSON round-
        // trip behaviour the live cloneSafe relies on: deserialising
        // a serialised value yields a new object graph.
        val original = Sample(provider = "anthropic", model = "claude-opus-4-7")
        val cloned = json.decodeFromString(
            Sample.serializer(),
            json.encodeToString(Sample.serializer(), original),
        )
        // Same content...
        assertEquals(original, cloned)
        // ...but cloned is a fresh data class instance. Data classes
        // are immutable by default in Kotlin (val), so mutation isn't
        // a hazard for THIS Sample type — but the JSON round-trip is
        // what cloneSafe relies on for any T (including types with
        // mutable fields). This test pins the round-trip itself.
        assertTrue("clone is a separate instance — round-trip produces fresh object",
            cloned !== original)
    }

    private fun locateLiveSource(): File {
        return File("src/main/java/com/seekerclaw/app/util/CrossProcessStore.kt")
            .takeIf { it.exists() }
            ?: File("../app/src/main/java/com/seekerclaw/app/util/CrossProcessStore.kt")
                .takeIf { it.exists() }
            ?: File("app/src/main/java/com/seekerclaw/app/util/CrossProcessStore.kt")
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
        // BAT-512 (Copilot review fix #1+#2): fileName must be
        // validated as a basename to prevent path traversal. After fix
        // #2 the literal check moved into a `isValidFileName` companion
        // function so tests can target it directly; the init block
        // calls that helper. Pin both ends of the contract.
        assertTrue("isValidFileName companion helper must remain (fix #2 — testability)",
            Regex("""fun\s+isValidFileName\s*\(""").containsMatchIn(text))
        assertTrue("init block must invoke isValidFileName(fileName)",
            Regex("""require\s*\(\s*isValidFileName\s*\(\s*fileName\s*\)\s*\)""").containsMatchIn(text))
        // The helper itself must compare against File(...).name — the
        // canonical basename check.
        assertTrue("isValidFileName must compare against File(fileName).name",
            Regex("""fileName\s*!=\s*File\s*\(\s*fileName\s*\)\s*\.\s*name""").containsMatchIn(text))
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
        // Mirror the live class's atomic move (BAT-512 Copilot review
        // fix): NIO Files.move with REPLACE_EXISTING + ATOMIC_MOVE.
        // No delete+rename fallback — that path was rejected because
        // it created a DELETE-event window where observers briefly
        // saw `initial`.
        val tmp = File(file.parentFile, file.name + ".tmp")
        val text = json.encodeToString(Sample.serializer(), value)
        tmp.writeText(text)
        java.nio.file.Files.move(
            tmp.toPath(),
            file.toPath(),
            java.nio.file.StandardCopyOption.REPLACE_EXISTING,
            java.nio.file.StandardCopyOption.ATOMIC_MOVE,
        )
    }
}
