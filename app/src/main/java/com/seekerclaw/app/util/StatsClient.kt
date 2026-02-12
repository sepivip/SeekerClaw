package com.seekerclaw.app.util

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

private const val TAG = "StatsClient"

/**
 * Shared client for fetching DB summary stats from the Node.js bridge.
 * Used by both DashboardScreen and SystemScreen (BAT-32).
 */
data class DbSummary(
    val todayRequests: Int = 0,
    val todayInputTokens: Long = 0,
    val todayOutputTokens: Long = 0,
    val todayAvgLatencyMs: Int = 0,
    val todayErrors: Int = 0,
    val todayCacheHitRate: Float = 0f,
    val monthRequests: Int = 0,
    val monthInputTokens: Long = 0,
    val monthOutputTokens: Long = 0,
    val monthCostEstimate: Float = 0f,
    val memoryFilesIndexed: Int = 0,
    val memoryChunksCount: Int = 0,
    val memoryLastIndexed: String? = null,
)

suspend fun fetchDbSummary(): DbSummary? = withContext(Dispatchers.IO) {
    val token = ServiceState.bridgeToken ?: return@withContext null
    var conn: java.net.HttpURLConnection? = null
    try {
        val url = java.net.URL("http://127.0.0.1:8765/stats/db-summary")
        conn = url.openConnection() as java.net.HttpURLConnection
        conn.requestMethod = "POST"
        conn.connectTimeout = 3000
        conn.readTimeout = 3000
        conn.setRequestProperty("Content-Type", "application/json")
        conn.setRequestProperty("X-Bridge-Token", token)
        conn.doOutput = true
        conn.outputStream.use { it.write("{}".toByteArray(Charsets.UTF_8)) }

        val code = conn.responseCode
        if (code !in 200..299) {
            // Drain error stream to free the connection
            conn.errorStream?.bufferedReader()?.use { it.readText() }
            return@withContext null
        }

        val body = conn.inputStream.bufferedReader().use { it.readText() }
        val json = JSONObject(body)
        val today = if (json.has("today") && !json.isNull("today")) json.getJSONObject("today") else null
        val month = if (json.has("month") && !json.isNull("month")) json.getJSONObject("month") else null
        val memory = if (json.has("memory") && !json.isNull("memory")) json.getJSONObject("memory") else null

        DbSummary(
            todayRequests = today?.optInt("requests", 0) ?: 0,
            todayInputTokens = today?.optLong("input_tokens", 0) ?: 0,
            todayOutputTokens = today?.optLong("output_tokens", 0) ?: 0,
            todayAvgLatencyMs = today?.optInt("avg_latency_ms", 0) ?: 0,
            todayErrors = today?.optInt("errors", 0) ?: 0,
            todayCacheHitRate = today?.optDouble("cache_hit_rate", 0.0)?.toFloat() ?: 0f,
            monthRequests = month?.optInt("requests", 0) ?: 0,
            monthInputTokens = month?.optLong("input_tokens", 0) ?: 0,
            monthOutputTokens = month?.optLong("output_tokens", 0) ?: 0,
            monthCostEstimate = month?.optDouble("total_cost_estimate", 0.0)?.toFloat() ?: 0f,
            memoryFilesIndexed = memory?.optInt("files_indexed", 0) ?: 0,
            memoryChunksCount = memory?.optInt("chunks_count", 0) ?: 0,
            memoryLastIndexed = if (memory != null && memory.has("last_indexed") && !memory.isNull("last_indexed"))
                memory.getString("last_indexed") else null,
        )
    } catch (e: Exception) {
        if (e is kotlinx.coroutines.CancellationException) throw e
        Log.d(TAG, "fetchDbSummary failed: ${e.message}")
        null
    } finally {
        conn?.disconnect()
    }
}
