package com.seekerclaw.app.bridge

import android.util.Log
import com.seekerclaw.app.util.ServiceState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Main-process HTTP client for the Node-side internal control server
 * (`internal-control-server.js`, port 8766) introduced in BAT-514.
 *
 * The reverse direction of [com.seekerclaw.app.bridge.AndroidBridge]:
 * AndroidBridge runs in `:node` and accepts requests from JS callers;
 * this client lives in main and POSTs to `:node` after Settings writes
 * land. Both ends use the same per-boot `BRIDGE_TOKEN` (read from the
 * `bridge_token` file via [ServiceState]) for auth.
 *
 * ## Bridge-down behaviour
 *
 * If the service isn't running (port not bound, connect-refused,
 * timeout), [reconcile] / [healthz] return `false` — they NEVER throw.
 * The caller (typically [com.seekerclaw.app.state.McpServersStore])
 * already persisted the file write, so a missed reconcile signal is
 * NOT a failure mode the user should see: the next service start reads
 * `mcp_servers.json` fresh and reconciles.
 *
 * ## Auth token resolution
 *
 * [ServiceState.bridgeToken] is hydrated by the BAT-518 file-observer
 * pattern. If it's null at call time (service has never started this
 * boot), this client returns `false` immediately without making a
 * request — there's no auth token to send and the server isn't
 * listening anyway.
 */
object NodeControlClient {
    private const val TAG = "NodeControlClient"
    private const val BASE_URL = "http://127.0.0.1:8766"
    private const val AUTH_HEADER = "X-Bridge-Token"
    // BAT-525 R4 Copilot: HttpURLConnection is NOT cooperatively
    // cancellable — a `withTimeoutOrNull` on the calling coroutine
    // can't interrupt an in-flight blocking connect/read. The
    // underlying timeouts MUST therefore sum to a wall-time that
    // fits within every caller's outer budget. The strictest caller
    // today is [flushShutdown] (BAT-525, called from
    // SeekerClawService.onDestroy under withTimeoutOrNull(2000)).
    //
    // Loopback connect is essentially instant (<5ms in practice on
    // the device); 250ms is generous defense-in-depth. BAT-1155 D6:
    // the read budget is 2000ms to cover the shutdown-flush path now
    // that Node drains the xAI token persist FIRST (300ms) THEN the
    // session summary (1200ms), plus buffer for JSON encode + socket
    // write.
    //
    // Total worst-case wall time: 250 + 2000 = 2250ms — fits the
    // 2500ms outer service-teardown budget with 250ms margin.
    private const val CONNECT_TIMEOUT_MS = 250
    private const val READ_TIMEOUT_MS = 2000

    /**
     * Tell the `:node` MCP manager to reconcile the active server set.
     * Pass [id] = `null` for a full-list reconcile (after bulk add /
     * remove / enable-toggle), or a specific server id when the change
     * is scoped to one entry (e.g. token edit).
     *
     * Returns `true` on a 2xx response. Returns `false` on any
     * transport / auth / status failure — caller treats that as
     * best-effort, not fatal.
     */
    suspend fun reconcile(id: String? = null): Boolean = withContext(Dispatchers.IO) {
        val body = JSONObject().apply {
            if (id != null) put("id", id)
        }.toString()
        post("/mcp/reconcile", body)
    }

    /** Best-effort liveness probe (`POST /healthz`). Mirrors [reconcile]'s failure shape. */
    suspend fun healthz(): Boolean = withContext(Dispatchers.IO) {
        post("/healthz", "{}")
    }

    /**
     * Drive Node's graceful-shutdown flush before
     * [com.seekerclaw.app.service.SeekerClawService] kills the
     * `:node` process (BAT-525). Persists pending session summaries
     * + dirty SQL.js mutations so the last ~60s of `api_request_log`
     * activity isn't lost on user-initiated Stop.
     *
     * Returns `true` on a 2xx response (Node confirmed flush
     * complete). Returns `false` on connect-refused (service
     * already down), 401 (bridge token rotated), 500
     * (`flushForShutdown` rejected), or transport timeout — in
     * every case the caller proceeds with the unconditional
     * `killProcess()` fallback. Bridge-token auth is provided by
     * the shared [post] helper so the endpoint's POST-auth gate
     * doesn't 401 every Stop event.
     *
     * ## Cancellation semantics (R4 Copilot — not the soft "outer
     * timeout cancels everything" simplification it might first
     * appear to be)
     *
     * `HttpURLConnection` is NOT cooperatively cancellable —
     * `withTimeoutOrNull` on the calling coroutine fires a
     * CancellationException at the next suspend point, but it
     * cannot interrupt an in-flight blocking
     * `connect()` / `responseCode` / `inputStream.readBytes()`.
     * The hard upper bound therefore comes from the underlying
     * connect+read timeouts, NOT the outer coroutine timeout.
     *
     * - [CONNECT_TIMEOUT_MS] = 250ms (loopback is near-instant; 250
     *   is defensive padding).
     * - [READ_TIMEOUT_MS] = 2000ms (BAT-1155 D6: covers the Node-side
     *   token-drain 300ms + `summaryTimeoutMs: 1200` + buffer so a
     *   real flush response always lands).
     * - Worst-case wall time: 2250ms.
     *
     * SeekerClawService still wraps the suspend call in
     * `withTimeoutOrNull(2500)` — that timeout primarily exists so
     * the Kotlin-side suspension releases promptly when the underlying
     * I/O eventually returns/throws within its bounded budget. It
     * does NOT directly interrupt the I/O; the 1750ms worst case is
     * the actual ceiling.
     */
    /**
     * BAT-1155 verify major-2: tri-state so the caller's fail-closed durability
     * gate fires ONLY on a genuinely stranded rotation, not on a benign summary
     * hiccup. Returns:
     *  - `true`  = Node reached; a rotated xAI token pair is STILL unpersisted
     *              (`pendingPersist:true`) → the caller must fail-closed;
     *  - `false` = Node reached; nothing stranded (even if the summary flush
     *              itself failed) → do NOT force a re-pair;
     *  - `null`  = flush did not reach/parse Node (connect-refused, 401, timeout,
     *              malformed body) → the caller fail-closes on the unknown.
     */
    suspend fun flushShutdown(): Boolean? = withContext(Dispatchers.IO) {
        val body = postForBody("/shutdown/flush", "{}") ?: return@withContext null
        try {
            val json = JSONObject(body)
            if (json.has("pendingPersist")) json.getBoolean("pendingPersist") else null
        } catch (e: Exception) {
            // CodeRabbit: don't swallow silently — a malformed /shutdown/flush body must be
            // distinguishable from a transport failure when debugging (both map to null).
            Log.d(TAG, "flushShutdown: malformed response body: ${e.message}")
            null
        }
    }

    /**
     * Like [post] but returns the response body (from the input OR error stream,
     * so a 500 that still carries `{pendingPersist}` is parseable) on any completed
     * HTTP exchange, or `null` on a transport failure / missing bridge token.
     */
    private fun postForBody(path: String, body: String): String? {
        val token = ServiceState.bridgeToken
        if (token.isNullOrBlank()) return null
        var conn: HttpURLConnection? = null
        return try {
            val url = URL(BASE_URL + path)
            conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty(AUTH_HEADER, token)
            }
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            stream?.use { String(it.readBytes(), Charsets.UTF_8) } ?: ""
        } catch (e: Exception) {
            Log.d(TAG, "POST $path failed: ${e.javaClass.simpleName}: ${e.message}")
            null
        } finally {
            conn?.disconnect()
        }
    }

    private fun post(path: String, body: String): Boolean {
        val token = ServiceState.bridgeToken
        if (token.isNullOrBlank()) {
            // No bridge token = service has never started this boot,
            // so the control server isn't listening either. Skip the
            // round-trip and the noisy connect-refused log.
            return false
        }
        var conn: HttpURLConnection? = null
        return try {
            val url = URL(BASE_URL + path)
            conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty(AUTH_HEADER, token)
            }
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            // Drain the response stream so the underlying socket can
            // be returned to the keep-alive pool cleanly.
            (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.use { it.readBytes() }
            code in 200..299
        } catch (e: Exception) {
            // Bridge-down, connect-refused, timeout — all the same as
            // far as caller is concerned. Log at DEBUG via Android
            // Log.d so it doesn't pollute LogCollector when the user
            // edits a server while the service is stopped.
            Log.d(TAG, "POST $path failed: ${e.javaClass.simpleName}: ${e.message}")
            false
        } finally {
            conn?.disconnect()
        }
    }
}
