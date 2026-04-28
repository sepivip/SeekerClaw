package com.seekerclaw.app.util

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
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
 * Pure JVM tests for LogCollector's in-memory behavior.
 * Most tests run without file I/O (logFile stays null when init() isn't called).
 * The offset-based reader tests use a temp file via setLogFileForTest().
 */
class LogCollectorTest {

    @Before
    fun setUp() {
        LogCollector.clear()
    }

    @After
    fun tearDown() {
        LogCollector.clear()
    }

    // --- Basic append/read ---

    @Test
    fun `append adds entry to buffer`() {
        LogCollector.append("hello", LogLevel.INFO)

        val logs = LogCollector.logs.value
        assertEquals(1, logs.size)
        assertEquals("hello", logs[0].message)
        assertEquals(LogLevel.INFO, logs[0].level)
    }

    @Test
    fun `append respects MAX_LINES (300) eviction`() {
        repeat(350) { i ->
            LogCollector.append("msg-$i", LogLevel.INFO)
        }

        val logs = LogCollector.logs.value
        assertEquals(300, logs.size)
        // Oldest 50 should be evicted; first entry should be msg-50
        assertEquals("msg-50", logs.first().message)
        assertEquals("msg-349", logs.last().message)
    }

    @Test
    fun `clear empties the buffer`() {
        LogCollector.append("test")
        assertEquals(1, LogCollector.logs.value.size)

        LogCollector.clear()
        assertTrue(LogCollector.logs.value.isEmpty())
    }

    // --- Diagnostics ---

    @Test
    fun `bufferedCount reflects current size`() {
        assertEquals(0, LogCollector.bufferedCount)
        LogCollector.append("a")
        assertEquals(1, LogCollector.bufferedCount)
        LogCollector.append("b")
        assertEquals(2, LogCollector.bufferedCount)
    }

    @Test
    fun `lastTimestamp is null when empty, populated when non-empty`() {
        assertNull(LogCollector.lastTimestamp)
        LogCollector.append("x")
        assertNotNull(LogCollector.lastTimestamp)
    }

    // --- Log level mapping ---

    @Test
    fun `all log levels are preserved through append`() {
        LogLevel.entries.forEach { level ->
            LogCollector.append("msg-${level.name}", level)
        }

        val logs = LogCollector.logs.value
        assertEquals(4, logs.size)
        assertEquals(LogLevel.DEBUG, logs[0].level)
        assertEquals(LogLevel.INFO, logs[1].level)
        assertEquals(LogLevel.WARN, logs[2].level)
        assertEquals(LogLevel.ERROR, logs[3].level)
    }

    @Test
    fun `default log level is INFO`() {
        LogCollector.append("default-level")
        assertEquals(LogLevel.INFO, LogCollector.logs.value[0].level)
    }

    // --- Thread safety (the primary bug fix) ---

    @Test
    fun `concurrent appends do not lose entries`() {
        val threadCount = 8
        val entriesPerThread = 100
        val totalExpected = threadCount * entriesPerThread
        val latch = CountDownLatch(threadCount)
        val executor = Executors.newFixedThreadPool(threadCount)

        repeat(threadCount) { t ->
            executor.submit {
                repeat(entriesPerThread) { i ->
                    LogCollector.append("t$t-$i", LogLevel.INFO)
                }
                latch.countDown()
            }
        }

        assertTrue("Threads did not complete in time", latch.await(10, TimeUnit.SECONDS))
        executor.shutdown()

        // With MAX_LINES=300 and 800 total appends, we should have exactly 300
        val logs = LogCollector.logs.value
        assertEquals(300, logs.size)

        // Verify no duplicates by timestamp (each entry gets a unique System.currentTimeMillis,
        // but under high concurrency some may share the same ms — so verify by message uniqueness)
        val messages = logs.map { it.message }.toSet()
        // All 300 remaining messages should be unique
        assertEquals(300, messages.size)
    }

    @Test
    fun `concurrent appends with low count preserve all entries`() {
        // Under MAX_LINES — no eviction, so every entry must survive
        val threadCount = 4
        val entriesPerThread = 20
        val totalExpected = threadCount * entriesPerThread
        val latch = CountDownLatch(threadCount)
        val executor = Executors.newFixedThreadPool(threadCount)

        repeat(threadCount) { t ->
            executor.submit {
                repeat(entriesPerThread) { i ->
                    LogCollector.append("t$t-$i", LogLevel.INFO)
                }
                latch.countDown()
            }
        }

        assertTrue("Threads did not complete in time", latch.await(10, TimeUnit.SECONDS))
        executor.shutdown()

        val logs = LogCollector.logs.value
        assertEquals(totalExpected, logs.size)
    }

    // --- Filter logic (mirrors LogsScreen filtering) ---

    @Test
    fun `filtering by level works correctly`() {
        LogCollector.append("debug-msg", LogLevel.DEBUG)
        LogCollector.append("info-msg", LogLevel.INFO)
        LogCollector.append("warn-msg", LogLevel.WARN)
        LogCollector.append("error-msg", LogLevel.ERROR)

        val logs = LogCollector.logs.value

        // Simulate default filters: DEBUG=off, others=on
        val filtered = logs.filter { entry ->
            when (entry.level) {
                LogLevel.DEBUG -> false
                LogLevel.INFO -> true
                LogLevel.WARN -> true
                LogLevel.ERROR -> true
            }
        }

        assertEquals(3, filtered.size)
        assertTrue(filtered.none { it.level == LogLevel.DEBUG })
    }

    @Test
    fun `all filters off produces empty filtered list from non-empty buffer`() {
        LogCollector.append("a", LogLevel.INFO)
        LogCollector.append("b", LogLevel.DEBUG)

        val logs = LogCollector.logs.value
        assertEquals(2, logs.size)

        // All filters disabled
        val filtered = logs.filter { entry ->
            when (entry.level) {
                LogLevel.DEBUG -> false
                LogLevel.INFO -> false
                LogLevel.WARN -> false
                LogLevel.ERROR -> false
            }
        }

        assertTrue(filtered.isEmpty())
        // But buffer is NOT empty — this is the "all filtered out" case
        assertTrue(logs.isNotEmpty())
    }

    @Test
    fun `search filter is case-insensitive`() {
        LogCollector.append("Connection established", LogLevel.INFO)
        LogCollector.append("Error: timeout", LogLevel.ERROR)
        LogCollector.append("connection lost", LogLevel.WARN)

        val logs = LogCollector.logs.value
        val query = "connection"
        val filtered = logs.filter { it.message.contains(query, ignoreCase = true) }

        assertEquals(2, filtered.size)
    }

    // --- Offset-based reader (BAT-518 FileObserver path) ---
    //
    // FileObserver typically delivers MODIFY and CLOSE_WRITE for one
    // write. Both events dispatch readNewFromFile concurrently via
    // scope.launch. `readLock` serializes the file read +
    // lastReadPosition update; `logsLock` is held only briefly inside
    // for the in-memory _logs mutation. Together they ensure no
    // duplicate entries land in the buffer and lastReadPosition
    // stays correct.

    @Test
    fun `offset reader picks up incremental writes correctly`() = runBlocking {
        val tmp = File.createTempFile("bat518-log", ".test")
        try {
            LogCollector.setLogFileForTest(tmp)
            LogCollector.resetForTest()

            // First write
            val ts1 = System.currentTimeMillis()
            tmp.writeText("$ts1|INFO|first\n")
            LogCollector.readNewFromFileForTest()

            assertEquals(1, LogCollector.logs.value.size)
            assertEquals("first", LogCollector.logs.value[0].message)
            assertEquals(tmp.length(), LogCollector.lastReadPositionForTest)

            // Second incremental write
            val ts2 = ts1 + 1
            tmp.appendText("$ts2|WARN|second\n")
            LogCollector.readNewFromFileForTest()

            assertEquals(2, LogCollector.logs.value.size)
            assertEquals("second", LogCollector.logs.value[1].message)
            assertEquals(LogLevel.WARN, LogCollector.logs.value[1].level)
            assertEquals(tmp.length(), LogCollector.lastReadPositionForTest)
        } finally {
            LogCollector.setLogFileForTest(null)
            LogCollector.resetForTest()
            tmp.delete()
        }
    }

    @Test
    fun `concurrent readNewFromFile invocations don't duplicate entries`() = runBlocking {
        // Simulates FileObserver's MODIFY + CLOSE_WRITE dual-dispatch:
        // multiple coroutines all see the file in the same state and
        // race to consume it. `readLock` must ensure exactly one of
        // them does the file read + lastReadPosition advance; the others
        // find the offset already advanced and return cleanly.
        // (Production locking: readLock guards file/offset, logsLock
        // guards in-memory _logs only — see LogCollector header.)
        val tmp = File.createTempFile("bat518-concurrent", ".test")
        try {
            LogCollector.setLogFileForTest(tmp)
            LogCollector.resetForTest()

            // Write 100 lines
            val baseTs = System.currentTimeMillis()
            val sb = StringBuilder()
            for (i in 0 until 100) {
                sb.append("${baseTs + i}|INFO|line-$i\n")
            }
            tmp.writeText(sb.toString())

            // Launch 10 concurrent readers on Dispatchers.IO so they can
            // actually run in parallel. With the default runBlocking
            // dispatcher (single-threaded), `async { ... }` blocks all
            // run sequentially since readNewFromFileForTest does
            // synchronous file I/O — the test would be effectively
            // serialized and wouldn't exercise the readLock contract.
            //
            val tasks = List(10) {
                async(Dispatchers.IO) { LogCollector.readNewFromFileForTest() }
            }
            tasks.awaitAll()

            // Exactly 100 entries, no duplicates, in order.
            val logs = LogCollector.logs.value
            assertEquals("Expected 100 entries; found ${logs.size}", 100, logs.size)
            assertEquals("line-0", logs.first().message)
            assertEquals("line-99", logs.last().message)
            // Offset advanced to EOF.
            assertEquals(tmp.length(), LogCollector.lastReadPositionForTest)
        } finally {
            LogCollector.setLogFileForTest(null)
            LogCollector.resetForTest()
            tmp.delete()
        }
    }

    @Test
    fun `offset reader handles file truncation by resetting position`() = runBlocking {
        // Simulates rotation: write content, read it, then replace the
        // file with a smaller one (e.g. log rotated out). Without the
        // `currentLength < pos` guard, lastReadPosition would stay at
        // the old length and the new (smaller) file would never be read.
        //
        val tmp = File.createTempFile("bat518-rotate", ".test")
        try {
            LogCollector.setLogFileForTest(tmp)
            LogCollector.resetForTest()

            val ts = System.currentTimeMillis()
            // Initial 5 lines
            tmp.writeText((0 until 5).joinToString("") { "${ts + it}|INFO|first-$it\n" })
            LogCollector.readNewFromFileForTest()
            assertEquals(5, LogCollector.logs.value.size)
            val origPos = LogCollector.lastReadPositionForTest
            assertTrue("offset should advance past initial write", origPos > 0)

            // Simulate rotation: truncate file, write smaller content
            tmp.writeText("${ts + 100}|WARN|after-rotate\n")
            assertTrue("rotation must shrink file", tmp.length() < origPos)

            LogCollector.readNewFromFileForTest()

            // The rotated content was forwarded (in addition to the
            // pre-rotation 5). Buffer holds 6 entries total.
            assertEquals(6, LogCollector.logs.value.size)
            assertEquals("after-rotate", LogCollector.logs.value.last().message)
            assertEquals(LogLevel.WARN, LogCollector.logs.value.last().level)
            // Offset now matches the rotated file's length.
            assertEquals(tmp.length(), LogCollector.lastReadPositionForTest)
        } finally {
            LogCollector.setLogFileForTest(null)
            LogCollector.resetForTest()
            tmp.delete()
        }
    }

    @Test
    fun `offset reader leaves partial trailing line for next read`() = runBlocking {
        // Simulates FileObserver firing CLOSE_WRITE while a writer is
        // mid-line. Without line-boundary advancement, parseLine would
        // drop the partial line AND lastReadPosition would skip past
        // it — losing the rest of the line forever once the writer
        // finishes.
        val tmp = File.createTempFile("bat518-partial", ".test")
        try {
            LogCollector.setLogFileForTest(tmp)
            LogCollector.resetForTest()

            val ts = System.currentTimeMillis()
            // One complete line + partial trailing (no \n)
            tmp.writeText("$ts|INFO|complete-line\n${ts + 1}|INFO|part-")
            val partialEndPos = tmp.length()

            LogCollector.readNewFromFileForTest()

            // Only the complete line should be forwarded; partial held back.
            assertEquals(1, LogCollector.logs.value.size)
            assertEquals("complete-line", LogCollector.logs.value[0].message)
            // Offset advanced only past the first complete line, NOT to EOF.
            // (If we advanced to EOF, the partial line would be lost when
            // the writer finishes.)
            assertTrue(
                "offset should be past first newline but before partial line end",
                LogCollector.lastReadPositionForTest < partialEndPos,
)

            // Writer finishes the partial line.
            tmp.appendText("ial-line\n")
            LogCollector.readNewFromFileForTest()

            // The previously-partial line is now complete and forwarded.
            assertEquals(2, LogCollector.logs.value.size)
            assertEquals("part-ial-line", LogCollector.logs.value[1].message)
            assertEquals(tmp.length(), LogCollector.lastReadPositionForTest)
        } finally {
            LogCollector.setLogFileForTest(null)
            LogCollector.resetForTest()
            tmp.delete()
        }
    }

    @Test
    fun `offset reader skips writes already at EOF`() = runBlocking {
        val tmp = File.createTempFile("bat518-eof", ".test")
        try {
            LogCollector.setLogFileForTest(tmp)
            LogCollector.resetForTest()

            tmp.writeText("${System.currentTimeMillis()}|INFO|once\n")
            LogCollector.readNewFromFileForTest()
            val sizeAfterFirst = LogCollector.logs.value.size
            val posAfterFirst = LogCollector.lastReadPositionForTest

            // Spurious second call with no new content (FileObserver may
            // emit duplicate events for a single write).
            LogCollector.readNewFromFileForTest()

            assertEquals(sizeAfterFirst, LogCollector.logs.value.size)
            assertEquals(posAfterFirst, LogCollector.lastReadPositionForTest)
        } finally {
            LogCollector.setLogFileForTest(null)
            LogCollector.resetForTest()
            tmp.delete()
        }
    }

    @Test
    fun `append compacts oversized service log file`() {
        val tmp = File.createTempFile("bat518-compact", ".test")
        try {
            LogCollector.setLogFileForTest(tmp)
            LogCollector.resetForTest()

            val line = "${System.currentTimeMillis()}|INFO|${"x".repeat(180)}\n"
            val builder = StringBuilder()
            while (builder.length < 1_100_000) {
                builder.append(line)
            }
            tmp.writeText(builder.toString())

            LogCollector.append("after-compaction", LogLevel.INFO)

            assertTrue("service_logs should be compacted below 700KB", tmp.length() < 700_000)
            assertTrue("new append should survive compaction", tmp.readText().contains("after-compaction"))
        } finally {
            LogCollector.setLogFileForTest(null)
            LogCollector.resetForTest()
            tmp.delete()
        }
    }

    @Test
    fun `observer path normalization accepts relative and absolute paths`() {
        assertEquals("service_logs", LogCollector.fileNameFromObserverPath("service_logs"))
        assertEquals(
            "service_logs",
            LogCollector.fileNameFromObserverPath("/data/user/0/com.seekerclaw.app/files/service_logs"),
        )
        assertEquals("agent_health_state", LogCollector.fileNameFromObserverPath("workspace/agent_health_state"))
        assertNull(LogCollector.fileNameFromObserverPath(null))
    }
}
