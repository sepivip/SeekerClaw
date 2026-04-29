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
    private const val CONNECT_TIMEOUT_MS = 1500
    private const val READ_TIMEOUT_MS = 1500

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
