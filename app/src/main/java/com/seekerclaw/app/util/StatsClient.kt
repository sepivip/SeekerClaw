package com.seekerclaw.app.util

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File

private const val TAG = "StatsClient"

/**
 * Shared client for fetching DB summary stats written by the Node.js process.
 * Reads from workspace/db_summary_state file (cross-process file IPC, same
 * pattern as claude_usage_state and bridge_token).
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
    try {
        val filesDir = ServiceState.filesDir ?: return@withContext null
        val file = File(filesDir, "workspace/db_summary_state")
        if (!file.exists()) return@withContext null

        val body = file.readText()
        if (body.isBlank()) return@withContext null

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
    }
}
