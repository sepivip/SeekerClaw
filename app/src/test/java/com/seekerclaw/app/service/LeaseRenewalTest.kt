package com.seekerclaw.app.service

import com.seekerclaw.app.util.ServiceState
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicInteger

/**
 * BAT-1155 Codex re-review — behavioral regression for the quiesce-lease renewer. The renewer
 * must be LIFECYCLE-bound: it renews the lease (POST /quiesce) continuously from durability-proof
 * until an EXPLICIT cancel or process death — a transient renew failure is NOT proof :node is
 * dead and must not stop renewal, and there is no iteration/time cap. Drives the REAL renewer
 * against a fake control server that counts requests and can inject a failure window.
 */
class LeaseRenewalTest {

    private lateinit var server: ServerSocket
    private val calls = AtomicInteger(0)
    @Volatile private var failMode = false
    private lateinit var acceptThread: Thread

    @Before
    fun setUp() {
        server = ServerSocket(8766, 16, InetAddress.getByName("127.0.0.1"))
        acceptThread = Thread {
            try {
                while (!server.isClosed) {
                    val sock = server.accept() // sequential — the renewer POSTs one at a time
                    try {
                        sock.getInputStream().read(ByteArray(8192))
                        calls.incrementAndGet() // count EVERY request, success or injected failure
                        val status = if (failMode) "500 Internal Server Error" else "200 OK"
                        val body = "{\"ok\":${!failMode}}".toByteArray()
                        val head = "HTTP/1.1 $status\r\nContent-Type: application/json\r\n" +
                            "Content-Length: ${body.size}\r\nConnection: close\r\n\r\n"
                        sock.getOutputStream().apply { write(head.toByteArray()); write(body); flush() }
                    } finally {
                        runCatching { sock.close() }
                    }
                }
            } catch (_: Exception) { /* closed */ }
        }.apply { isDaemon = true; start() }
        ServiceState.setBridgeTokenForTest("test-token")
        SeekerClawService.setLeaseRenewMsForTest(30L) // shorten the cadence so the test is fast
    }

    @After
    fun tearDown() {
        SeekerClawService.stopLeaseRenewal()
        SeekerClawService.setLeaseRenewMsForTest(5_000L)
        ServiceState.setBridgeTokenForTest(null)
        runCatching { server.close() }
    }

    @Test
    fun `renewal is lifecycle-bound — survives failures, runs past the old cap, stops only on cancel`() {
        SeekerClawService.startLeaseRenewal()
        Thread.sleep(200)
        val afterStart = calls.get()
        assertTrue("renewer must POST /quiesce repeatedly (was $afterStart)", afterStart >= 2)

        // A transient failure window must NOT stop renewal (a failed POST is not proof :node died).
        failMode = true
        Thread.sleep(300)
        val duringFail = calls.get()
        assertTrue("renewal must CONTINUE across a failure window ($afterStart → $duringFail)", duringFail >= afterStart + 3)
        failMode = false

        // Run well beyond the FORMER 24-iteration cap (24 × 30ms ≈ 720ms) — there is no cap now.
        Thread.sleep(1500)
        val pastCap = calls.get()
        assertTrue("renewal must run past the former 24-iteration cap (was $pastCap)", pastCap > 24)

        // Explicit cancel → renewal stops (and stays stopped).
        SeekerClawService.stopLeaseRenewal()
        Thread.sleep(120)
        val afterStop = calls.get()
        Thread.sleep(150)
        assertEquals("no renew POSTs after explicit stopLeaseRenewal", afterStop, calls.get())
    }
}
