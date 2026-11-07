package com.seekerclaw.app.config

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.channels.FileChannel
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * BAT-1661 (contract v2.3 §2, v2.4 §4) — [ModelSelectionLock]: bounded, never throws on
 * contention, token-owned (survives the `runBlocking(Dispatchers.IO)` hop in `saveConfig`),
 * refuses same-thread nesting, and excludes another PROCESS through the sidecar file lock.
 */
class ModelSelectionLockTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var dir: Path

    @Before
    fun setUp() {
        dir = tmp.newFolder("files").toPath()
        ModelSelectionLock.initForTest(dir)
    }

    @After
    fun tearDown() {
        ModelSelectionLock.initForTest(null)
    }

    private fun <T> acquired(r: ModelSelectionLock.Result<T>): T {
        if (r !is ModelSelectionLock.Result.Acquired) fail("expected the lock, got $r")
        return (r as ModelSelectionLock.Result.Acquired).value
    }

    @Test
    fun `not initialised - busy, block never runs`() {
        ModelSelectionLock.initForTest(null)
        val ran = AtomicBoolean(false)
        assertTrue(ModelSelectionLock.transaction { ran.set(true) } is ModelSelectionLock.Result.Busy)
        assertFalse(ran.get())
    }

    @Test
    fun `nested transaction on the same thread is refused at once, not after the bound`() {
        val inner = acquired(
            ModelSelectionLock.transaction(timeoutMs = 5_000) {
                val t0 = System.nanoTime()
                val r = ModelSelectionLock.transaction(timeoutMs = 5_000) { }
                r to (System.nanoTime() - t0) / 1_000_000
            },
        )
        assertEquals(ModelSelectionLock.Result.Busy("nested"), inner.first)
        assertTrue("refused in ${inner.second} ms", inner.second < 1_000)
        // And the outer one released normally.
        acquired(ModelSelectionLock.transaction { })
    }

    @Test
    fun `the token works across the IO hop and is dead after the transaction`() {
        var kept: ModelSelectionLock.Tx? = null
        acquired(
            ModelSelectionLock.transaction { tx ->
                kept = tx
                runBlocking { withContext(Dispatchers.IO) { tx.requireOpen() } }
            },
        )
        try {
            kept!!.requireOpen()
            fail("a token used after its transaction must throw")
        } catch (_: IllegalStateException) {
        }
    }

    @Test
    fun `an exception from the block propagates and releases the lock`() {
        try {
            ModelSelectionLock.transaction { throw java.io.IOException("emit failed") }
            fail("expected the IOException")
        } catch (e: java.io.IOException) {
            assertEquals("emit failed", e.message)
        }
        acquired(ModelSelectionLock.transaction { })
    }

    @Test
    fun `a holder on another thread makes a second caller busy within the bound`() {
        val held = CountDownLatch(1)
        val release = CountDownLatch(1)
        val holder = Thread {
            ModelSelectionLock.transaction(timeoutMs = 5_000) {
                held.countDown()
                release.await(10, TimeUnit.SECONDS)
            }
        }.apply { start() }
        try {
            assertTrue(held.await(5, TimeUnit.SECONDS))
            val ran = AtomicBoolean(false)
            val t0 = System.nanoTime()
            val r = ModelSelectionLock.transaction(timeoutMs = 200) { ran.set(true) }
            val ms = (System.nanoTime() - t0) / 1_000_000
            assertTrue(r is ModelSelectionLock.Result.Busy)
            assertFalse("a busy caller writes nothing", ran.get())
            assertTrue("bounded: $ms ms", ms in 150..3_000)
        } finally {
            release.countDown()
            holder.join(10_000)
        }
        acquired(ModelSelectionLock.transaction { })
    }

    @Test
    fun `an OS lock held in this JVM outside the semaphore makes the caller busy`() {
        FileChannel.open(dir.resolve(ModelSelectionLock.LOCK_NAME), StandardOpenOption.CREATE, StandardOpenOption.WRITE).use { ch ->
            ch.lock().use {
                assertEquals(ModelSelectionLock.Result.Busy("file lock timeout"), ModelSelectionLock.transaction(timeoutMs = 100) { })
            }
        }
        acquired(ModelSelectionLock.transaction { })
    }

    @Test
    fun `another process holding the lock file makes the caller busy until it lets go`() {
        val javaBin = File(System.getProperty("java.home"), "bin/java").path
        val cp = listOf(LockHolderMain::class.java, Unit::class.java)
            .map { File(it.protectionDomain.codeSource.location.toURI()).path }
            .distinct()
            .joinToString(File.pathSeparator)
        val p = ProcessBuilder(javaBin, "-cp", cp, LockHolderMain::class.java.name, dir.resolve(ModelSelectionLock.LOCK_NAME).toString())
            .redirectErrorStream(true)
            .start()
        try {
            // Bounded: a child that never prints must fail the test, not hang the build.
            val reader = java.util.concurrent.Executors.newSingleThreadExecutor()
            val line = try {
                reader.submit<String?> { p.inputStream.bufferedReader().readLine() }.get(20, TimeUnit.SECONDS)
            } finally {
                reader.shutdownNow()
            }
            assertEquals("LOCKED", line)
            assertEquals(ModelSelectionLock.Result.Busy("file lock timeout"), ModelSelectionLock.transaction(timeoutMs = 300) { })
        } finally {
            p.outputStream.close() // the holder exits on EOF, releasing its lock
            assertTrue(p.waitFor(10, TimeUnit.SECONDS))
        }
        acquired(ModelSelectionLock.transaction { })
    }
}
