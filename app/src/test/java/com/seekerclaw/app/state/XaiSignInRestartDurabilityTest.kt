package com.seekerclaw.app.state

import com.seekerclaw.app.bridge.NodeControlClient
import com.seekerclaw.app.util.ServiceState
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket

/**
 * BAT-1155 soak-brick regression (found on-device 2026-07-14).
 *
 * ## The bug
 * `/shutdown/flush` computed the brick-critical `diskUnsafe` durability signal fast (xAI drain,
 * ~300ms) but USED to block its HTTP response behind the best-effort session summary (up to
 * 1200ms). On a loaded device the summary times out and the endpoint answers past the durability
 * gate's per-round read budget → the gate reads `null`, interprets it as "Node unreachable", and
 * FAIL-CLOSES by CAS-marking the freshly-signed-in family `reauthRequired`. `ConfigManager` then
 * blanks the token ("credential missing") and the UI reverts to "Sign in with Grok". Every retry
 * re-runs the trap.
 *
 * ## The fix and what THIS test pins
 * The gate (and the onDestroy guard's re-probe) now send `durabilityOnly:true`, so Node answers
 * the durability question WITHOUT waiting on the summary. This test pins the Kotlin **routing**:
 * both the gate and [NodeControlClient.flushShutdown] must request the fast `durabilityOnly`
 * path, never the summary-blocking full flush. If the decoupling is reverted, the recorded
 * request no longer carries `durabilityOnly` and the assertions fail.
 *
 * NOTE ON SCOPE: `org.json` is stubbed in JVM unit tests (returns defaults), so
 * [NodeControlClient.flushShutdown] cannot parse a real response here — it returns `null`
 * regardless of the server. The behavioral guarantee ("durabilityOnly returns diskUnsafe fast and
 * SKIPS the summary") is therefore pinned in the Node test
 * `tests/nodejs-project/shutdown-flush.test.js`; the real Kotlin response-parse runs on-device.
 * This test asserts the request contract, which is exactly the piece the fix changed on the
 * Kotlin side.
 */
class XaiSignInRestartDurabilityTest {

    private lateinit var workDir: File
    private lateinit var server: ServerSocket
    private lateinit var acceptThread: Thread
    private val requests = java.util.Collections.synchronizedList(mutableListOf<String>())

    @Before
    fun setUp() {
        workDir = File.createTempFile("bat1155-signin", "").apply { delete(); mkdirs() }
        XaiOAuthTokenStore.initForTest(workDir)
        ServiceState.setBridgeTokenForTest("test-token")

        // Fake internal-control-server on 127.0.0.1:8766 (same socket approach as LeaseRenewalTest).
        // It records each request body and answers 200 fast; the client can't parse the stubbed
        // JSON, but these tests assert on what was REQUESTED, not on the parsed response.
        server = ServerSocket(8766, 16, InetAddress.getByName("127.0.0.1"))
        acceptThread = Thread {
            try {
                while (!server.isClosed) {
                    val sock = server.accept()
                    Thread { handle(sock) }.apply { isDaemon = true }.start()
                }
            } catch (_: Exception) { /* closed */ }
        }.apply { isDaemon = true; start() }
    }

    @After
    fun tearDown() {
        ServiceState.setBridgeTokenForTest(null)
        XaiOAuthTokenStore.resetForTest()
        runCatching { server.close() }
        workDir.deleteRecursively()
    }

    private fun handle(sock: java.net.Socket) {
        try {
            // Accumulate until the full request (headers + Content-Length body) has arrived — a
            // single read() can race and capture only the header segment before the body lands.
            val input = sock.getInputStream()
            val sb = StringBuilder()
            val buf = ByteArray(4096)
            while (true) {
                val n = input.read(buf)
                if (n <= 0) break
                sb.append(String(buf, 0, n, Charsets.UTF_8))
                val headerEnd = sb.indexOf("\r\n\r\n")
                if (headerEnd >= 0) {
                    val cl = Regex("(?i)content-length:\\s*(\\d+)").find(sb)?.groupValues?.get(1)?.toIntOrNull() ?: 0
                    if (sb.length - (headerEnd + 4) >= cl) break
                }
            }
            val full = sb.toString()
            requests.add(full.substringAfter("\r\n\r\n", full))
            val body = """{"ok":true,"diskUnsafe":false,"pendingPersist":false,"notifyPending":false}"""
                .toByteArray(Charsets.UTF_8)
            val head = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" +
                "Content-Length: ${body.size}\r\nConnection: close\r\n\r\n"
            sock.getOutputStream().apply { write(head.toByteArray()); write(body); flush() }
        } catch (_: Exception) {
            /* ignore */
        } finally {
            runCatching { sock.close() }
        }
    }

    // ---------------------------------------------------------------------------------------

    @Test
    fun `flushShutdown routes the durabilityOnly flag but the full flush does not`() {
        runBlocking { NodeControlClient.flushShutdown(maxTotalMs = 1_000, durabilityOnly = true) }
        assertTrue(
            "durabilityOnly=true must transmit the flag so Node skips the summary (was: ${requests.lastOrNull()})",
            requests.isNotEmpty() && requests.last().contains("\"durabilityOnly\":true"),
        )

        requests.clear()
        runBlocking { NodeControlClient.flushShutdown(maxTotalMs = 1_000, durabilityOnly = false) }
        assertTrue("full flush must still reach the endpoint", requests.isNotEmpty())
        assertFalse(
            "the default (shutdown) flush must NOT set durabilityOnly — it still flushes the summary",
            requests.last().contains("durabilityOnly"),
        )
    }

    @Test
    fun `durability gate resolves a fresh sign-in from the durable store with NO Node round-trip`() {
        // The soak-brick regression, now under the stop-fence protocol: a freshly-signed-in family
        // (state after XaiOAuthActivity's token exchange) with NO rotation in flight. The gate arms
        // the stop fence + probes the durable rotation marker — a pure sidecar-locked store op —
        // and finds "fenced + nothing in flight = positively safe". So it NEVER contacts Node and
        // can NEVER fail-close on a null/slow control probe (the exact soak brick). Independent of
        // :node reachability, and org.json is not on the path at all.
        val signIn = XaiOAuthTokenStore.signIn("enc-access", "enc-refresh", "enc-email", "2099-01-01T00:00:00Z")
        assertTrue("sign-in must persist a live family", signIn is XaiOAuthTokenStore.Result.Ok)

        val durable = XaiOAuthDurabilityGate.ensureDurableBeforeStop()

        assertTrue("gate must report durable for a safe fresh sign-in", durable)
        assertFalse("REGRESSION: a fresh sign-in with nothing in flight must NEVER be bricked", XaiOAuthTokenStore.read().reauthRequired)
        assertTrue(
            "the gate must decide a safe family from the durable store alone — NO drain round-trip (was: $requests)",
            requests.isEmpty(),
        )
    }
}
