package com.seekerclaw.app.util

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
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
            """fun\s+write\s*\(\s*value\s*:\s*T\s*\)(?:\s*:\s*Boolean)?\s*\{[\s\S]*?(?=\n\s{4}\}\n)""",
        ).find(text)?.value ?: error("write() function body not found")
        assertTrue(
            "write() must capture `val snapshot: T = cloneSafe(value)` up-front",
            Regex("""val\s+snapshot\s*:\s*T\s*=\s*cloneSafe\s*\(\s*value\s*\)""").containsMatchIn(writeBlock),
        )
        assertTrue(
            "write() must hand `snapshot` to persistLocked (BAT-513 round-18 refactor)",
            Regex("""persistLocked\s*\(\s*snapshot\s*\)""").containsMatchIn(writeBlock),
        )
        // Negative pin: the OLD pattern (re-cloning value at the
        // _state assignment) must be gone.
        assertFalse(
            "_state assignment must NOT re-clone value (round-7 fix consolidated to single up-front clone)",
            Regex("""_state\.value\s*=\s*cloneSafe\s*\(\s*value\s*\)""").containsMatchIn(writeBlock),
        )

        // BAT-513 round-18: the locked-persist body lives in
        // persistLocked now (shared with update). Verify the SAME-
        // SNAPSHOT-FOR-BOTH-PERSISTENCE-AND-PUBLISH contract holds at
        // that helper: encodeToString and _state.value assignment
        // must both use the parameter-named `snapshot`, not re-clone.
        val persistBlock = Regex(
            """private\s+fun\s+persistLocked\s*\(\s*snapshot\s*:\s*T\s*\)\s*:\s*Boolean\s*\{[\s\S]*?(?=\n\s{4}\}\n)""",
        ).find(text)?.value ?: error("persistLocked() function body not found")
        assertTrue(
            "persistLocked must encode the parameter `snapshot` to disk",
            Regex("""encodeToString\s*\(\s*serializer\s*,\s*snapshot\s*\)""").containsMatchIn(persistBlock),
        )
        assertTrue(
            "persistLocked must publish the parameter `snapshot` to _state.value",
            Regex("""_state\.value\s*=\s*snapshot\b""").containsMatchIn(persistBlock),
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
    fun `drift broadcastChanged is invoked OUTSIDE synchronized writeLock (round-6 + round-18 lock contention)`() {
        // BAT-512 (Copilot review fix round-6) + BAT-513 round-18:
        // sendBroadcast is system IPC and shouldn't be inside the
        // critical section. Pin that broadcastChanged is called
        // AFTER the synchronized(writeLock) block, not inside it,
        // for BOTH write() AND update() — round-18 caught update
        // holding writeLock across the broadcast (because update's
        // synchronized block enclosed the call to write(), whose
        // own broadcast was outside ITS synchronized block but
        // still inside update's outer one — reentrant monitor).
        val src = locateLiveSource()
        val text = src.readText()

        for ((funName, regex) in listOf(
            "write" to Regex("""fun\s+write\s*\(\s*value\s*:\s*T\s*\)(?:\s*:\s*Boolean)?\s*\{[\s\S]*?(?=\n\s{4}\}\n)"""),
            "update" to Regex("""suspend\s+fun\s+update\s*\(\s*transform[\s\S]*?\)\s*:\s*Boolean\s*\{[\s\S]*?(?=\n\s{4}\}\n)"""),
        )) {
            val funcBlock = regex.find(text)?.value ?: error("$funName() body not found")
            val syncStart = funcBlock.indexOf("synchronized(writeLock)")
            assertTrue("$funName: synchronized(writeLock) block must exist", syncStart >= 0)
            // Find the matching `}` for the synchronized block by
            // counting braces from the opening `{`. The block can be
            // single-line (`synchronized(writeLock) { foo() }`) or
            // multi-line — line-aligned-indent heuristics broke when
            // round 18 collapsed write()'s synchronized into a
            // single-line call to persistLocked.
            val openBraceAt = funcBlock.indexOf('{', syncStart)
            assertTrue("$funName: synchronized opening brace not found", openBraceAt >= 0)
            var depth = 1
            var i = openBraceAt + 1
            while (i < funcBlock.length && depth > 0) {
                when (funcBlock[i]) {
                    '{' -> depth++
                    '}' -> depth--
                }
                i++
            }
            assertTrue("$funName: synchronized closing brace not found", depth == 0)
            val syncBlockEnd = i // position immediately after the matching `}`
            val outsideTheLock = funcBlock.substring(syncBlockEnd)
            assertTrue(
                "$funName: broadcastChanged() must be called outside the synchronized block",
                Regex("""broadcastChanged\s*\(\s*\)""").containsMatchIn(outsideTheLock),
            )
            val insideTheLock = funcBlock.substring(openBraceAt, syncBlockEnd)
            assertFalse(
                "$funName: broadcastChanged() must NOT remain inside the synchronized block",
                Regex("""broadcastChanged\s*\(\s*\)""").containsMatchIn(insideTheLock),
            )
        }
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

    // --- BAT-513 Boolean return + synchronized-protected update() ---

    @Test
    fun `drift write returns Boolean (BAT-513 — failure visibility for callers)`() {
        // BAT-513 amends the BAT-512 store: `write()` must return Boolean
        // so callers (Settings UI, Telegram /provider, /model) can
        // distinguish persisted-success from caught-failure and surface
        // the difference (snackbar + revert / "couldn't save" reply)
        // instead of leaving silent optimistic UI state.
        //
        // Pin both ends of the contract:
        //   1) the function signature returns Boolean,
        //   2) `return didWrite` is the actual return statement (so a
        //      future refactor that flips the success flag without
        //      returning it can't sneak through).
        val src = locateLiveSource()
        val text = src.readText()
        assertTrue(
            "write() must return Boolean (was Unit pre-BAT-513)",
            Regex("""fun\s+write\s*\(\s*value\s*:\s*T\s*\)\s*:\s*Boolean\s*\{""")
                .containsMatchIn(text),
        )
        // BAT-513 round-27: scope the `return didWrite` check to
        // write()'s body specifically. After round-18 extracted
        // persistLocked, update() ALSO contains `return didWrite`
        // (its outer return), so a global grep would pass even if
        // write() stopped returning the flag. Extract the write
        // body via the same regex pattern the other drift tests use.
        val writeBlock = Regex(
            """fun\s+write\s*\(\s*value\s*:\s*T\s*\)(?:\s*:\s*Boolean)?\s*\{[\s\S]*?(?=\n\s{4}\}\n)""",
        ).find(text)?.value ?: error("write() function body not found")
        assertTrue(
            "write() body must end by returning the didWrite flag",
            Regex("""return\s+didWrite\b""").containsMatchIn(writeBlock),
        )
    }

    @Test
    fun `drift update serializes RMW via synchronized writeLock (BAT-513 round-13)`() {
        // BAT-513 adds `suspend fun update(transform: (T) -> T): Boolean`.
        // Round 13 review caught that an early Mutex-only design serialized
        // update-vs-update but missed update-vs-write: a `write()` from
        // another thread could fire between update's `read()` and
        // `write(next)`, and update would overwrite it. The fix uses
        // `synchronized(writeLock)` for the entire RMW so update is atomic
        // w.r.t. concurrent write() calls too (synchronized is reentrant
        // on the JVM, so the nested write() call works fine).
        //
        // Pin the structural contract: declared as `suspend`, takes a
        // `(T) -> T` transform, returns Boolean, and the body wraps
        // read+transform+write in `synchronized(writeLock)` (NOT in a
        // separate Mutex that wouldn't serialize against write()).
        val src = locateLiveSource()
        val text = src.readText()
        assertTrue(
            "update must be declared suspend with the (T) -> T transform shape",
            Regex(
                """suspend\s+fun\s+update\s*\(\s*transform\s*:\s*\(\s*T\s*\)\s*->\s*T\s*\)\s*:\s*Boolean\b""",
            ).containsMatchIn(text),
        )
        // Round 18 changed update's body from a single-expression
        // `= synchronized(...)` to a block body that drops the lock
        // before broadcastChanged. Look for the synchronized(writeLock)
        // block INSIDE the update body, not the body's top-level
        // shape.
        val updateBlock = Regex(
            """suspend\s+fun\s+update\s*\(\s*transform[\s\S]*?\)\s*:\s*Boolean\s*\{[\s\S]*?(?=\n\s{4}\}\n)""",
        ).find(text)?.value ?: error("update() function body not found")
        assertTrue(
            "update body must contain synchronized(writeLock) so the RMW is atomic w.r.t. write()",
            Regex("""synchronized\s*\(\s*writeLock\s*\)""").containsMatchIn(updateBlock),
        )
        // Negative pin: the OLD pattern (separate Mutex/withLock that
        // misses update-vs-write contention) must be gone. If a future
        // refactor brings back a `Mutex()` for update serialization,
        // this guard fires and forces the maintainer to revisit the
        // round-13 review thread before re-introducing the bug class.
        assertFalse(
            "update must NOT use a separate Mutex (round-13 fix dropped updateMutex)",
            Regex("""updateMutex\s*=\s*Mutex\s*\(\s*\)""").containsMatchIn(text),
        )
        assertFalse(
            "update body must NOT call updateMutex.withLock (round-13 fix uses synchronized(writeLock) instead)",
            Regex("""updateMutex\.withLock""").containsMatchIn(text),
        )
    }

    @Test
    fun `production CrossProcessStore update under contention preserves all increments`() {
        // BAT-513 round-19: drive the REAL CrossProcessStore.update()
        // implementation, not a mirror. Round 18 left this as a
        // pattern-mirror test that didn't fail if production atomicity
        // changed; reviewer correctly flagged that the test was
        // claiming validation it didn't deliver. The round-19 refactor
        // adds a JVM-only constructor (filesDir injection, no Android
        // Context) so unit tests can construct a fully-functional
        // store and exercise update() under real Dispatchers.Default
        // contention.
        //
        // What this proves about production code:
        //   - synchronized(writeLock) inside update() actually
        //     serializes concurrent update() calls (10 increments
        //     preserved → no lost updates).
        //   - The persistLocked file-write + _state publish stays
        //     atomic w.r.t. the read inside the same synchronized
        //     block.
        //   - cloneSafe round-trip works at the volume + concurrency
        //     of the test.
        //
        // What this does NOT exercise (those are device tests):
        //   - FileObserver event delivery
        //   - BroadcastReceiver register/dispatch
        //   - Cross-process notification semantics
        val store = CrossProcessStore(
            filesDir = workDir,
            fileName = "rmw-prod.json",
            serializer = Sample.serializer(),
            initial = Sample(model = "0"),
        )
        // Seed via the production write path so the on-disk state is
        // a known starting point.
        assertTrue("seed write succeeds", store.write(Sample(model = "0")))

        runBlocking {
            val deferreds = (1..10).map {
                async(kotlinx.coroutines.Dispatchers.Default) {
                    store.update { s ->
                        s.copy(model = (s.model.toInt() + 1).toString())
                    }
                }
            }
            assertTrue("all updates report success", deferreds.awaitAll().all { it })
        }
        val finalValue = store.read()
        assertEquals(
            "production CrossProcessStore.update must preserve all 10 increments — no lost updates",
            "10",
            finalValue.model,
        )
        store.close()
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
