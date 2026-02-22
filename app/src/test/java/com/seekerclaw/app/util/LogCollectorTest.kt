package com.seekerclaw.app.util

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Pure JVM tests for LogCollector's in-memory behavior.
 * File I/O is skipped because logFile stays null (init() not called).
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
}
