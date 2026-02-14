package com.seekerclaw.app.util

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

private const val TAG = "StatsClient"

/**
 * Shared client for fetching DB summary stats from the Node.js stats server.
 * Calls the internal stats server on port 8766 directly (no bridge proxy).
 * Used by DashboardScreen and SystemScreen for API analytics (BAT-32),
 * and by the memory index UI for memory stats (BAT-33).
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
    var conn: java.net.HttpURLConnection? = null
    try {
        // Call Node.js internal stats server directly (no bridge proxy needed)
        val url = java.net.URL("http://127.0.0.1:8766/stats/db-summary")
        conn = url.openConnection() as java.net.HttpURLConnection
        conn.requestMethod = "GET"
        conn.connectTimeout = 5000
        conn.readTimeout = 5000

        val code = conn.responseCode
        if (code !in 200..299) {
            Log.w(TAG, "fetchDbSummary HTTP $code")
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
        Log.w(TAG, "fetchDbSummary failed: ${e.message}")
        null
    } finally {
        conn?.disconnect()
    }
}
