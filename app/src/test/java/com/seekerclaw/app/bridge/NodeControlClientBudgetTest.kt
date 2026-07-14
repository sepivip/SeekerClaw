package com.seekerclaw.app.bridge

import com.seekerclaw.app.util.ServiceState
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket

/**
 * BAT-1155 Codex re-review major-1 — wall-time proof that [NodeControlClient.flushShutdown]
 * honors the caller's remaining budget even against a real loopback endpoint that ACCEPTS but
 * STALLS. HttpURLConnection's blocking read is not cooperatively cancellable, so the ONLY real
 * bound is the underlying connect/read timeouts; the fix caps them to the passed budget. Without
 * it, a stalled round would block the full ~2250ms (250 connect + 2000 read) past the deadline.
 */
class NodeControlClientBudgetTest {

    private lateinit var server: ServerSocket
    private val accepted = mutableListOf<Socket>()
    private lateinit var acceptThread: Thread

    @Before
    fun setUp() {
        // NodeControlClient targets 127.0.0.1:8766. A stalling server accepts the connection
        // (so it is NOT a fast connect-refused) but never writes a response → the client's READ
        // is what must be bounded by the budget.
        server = ServerSocket(8766, 4, InetAddress.getByName("127.0.0.1"))
        acceptThread = Thread {
            try {
                while (!server.isClosed) {
                    val s = server.accept()
                    synchronized(accepted) { accepted.add(s) } // hold it open, never respond
                }
            } catch (_: Exception) { /* closed */ }
        }.apply { isDaemon = true; start() }
        ServiceState.setBridgeTokenForTest("test-token")
    }

    @After
    fun tearDown() {
        ServiceState.setBridgeTokenForTest(null)
        runCatching { server.close() }
        synchronized(accepted) { accepted.forEach { runCatching { it.close() } } }
    }

    @Test
    fun `flushShutdown honors the caller budget against a stalling endpoint`() {
        val budgetMs = 300
        val t0 = System.nanoTime()
        val r = runBlocking { NodeControlClient.flushShutdown(budgetMs) }
        val elapsedMs = (System.nanoTime() - t0) / 1_000_000L
        assertNull("a stalled endpoint yields no parseable body", r)
        assertTrue(
            "must return near the ${budgetMs}ms budget, NOT the ~2250ms uncapped worst case (was ${elapsedMs}ms)",
            elapsedMs < 1500,
        )
    }

    @Test
    fun `flushShutdown with no budget still returns (uncapped path stays functional)`() {
        // Sanity that the default (uncapped) path still completes against the stall — bounded by
        // the class's own READ_TIMEOUT_MS rather than a caller budget.
        val r = runBlocking { NodeControlClient.flushShutdown() }
        assertNull(r)
    }

    @Test
    fun `unquiesce returns false (not a throw) against a non-responsive endpoint`() {
        // Codex re-review major-2: the abandon path retries unquiesce until confirmed, so a failed
        // attempt must return a clean `false` (never throw) for the retry loop to act on — the Node
        // quiesce lease then backstops the rest.
        val r = runBlocking { NodeControlClient.unquiesce() }
        assertFalse("a non-responsive endpoint yields false so the abandon path keeps retrying", r)
    }
}
