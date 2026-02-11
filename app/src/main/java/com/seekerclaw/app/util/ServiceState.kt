package com.seekerclaw.app.util

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File
import java.util.Calendar

private const val TAG = "ServiceState"

enum class ServiceStatus { STOPPED, STARTING, RUNNING, ERROR }

sealed class ClaudeUsageData {
    abstract val updatedAt: Long
    abstract val error: String?

    data class OAuthUsage(
        val fiveHourUtilization: Float,
        val fiveHourResetsAt: String,
        val sevenDayUtilization: Float,
        val sevenDayResetsAt: String,
        override val updatedAt: Long,
        override val error: String? = null,
    ) : ClaudeUsageData()

    data class ApiKeyUsage(
        val requestsLimit: Int,
        val requestsRemaining: Int,
        val requestsReset: String,
        val tokensLimit: Long,
        val tokensRemaining: Long,
        val tokensReset: String,
        override val updatedAt: Long,
        override val error: String? = null,
    ) : ClaudeUsageData()
}

object ServiceState {
    private val _status = MutableStateFlow(ServiceStatus.STOPPED)
    val status: StateFlow<ServiceStatus> = _status

    private val _uptime = MutableStateFlow(0L)
    val uptime: StateFlow<Long> = _uptime

    private val _messageCount = MutableStateFlow(0)
    val messageCount: StateFlow<Int> = _messageCount

    private val _messagesToday = MutableStateFlow(0)
    val messagesToday: StateFlow<Int> = _messagesToday

    private val _lastActivityTime = MutableStateFlow(0L)
    val lastActivityTime: StateFlow<Long> = _lastActivityTime

    private val _tokensToday = MutableStateFlow(0L)
    val tokensToday: StateFlow<Long> = _tokensToday

    private val _tokensTotal = MutableStateFlow(0L)
    val tokensTotal: StateFlow<Long> = _tokensTotal

    private val _claudeUsage = MutableStateFlow<ClaudeUsageData?>(null)
    val claudeUsage: StateFlow<ClaudeUsageData?> = _claudeUsage

    private var stateFile: File? = null
    private var pollingJob: Job? = null
    private val scope = CoroutineScope(Dispatchers.IO)
    private var initialized = false

    /**
     * Initialize state file path AND restore persisted counters.
     * Must be called before any updateStatus/incrementMessages/addTokens.
     */
    fun init(context: Context) {
        stateFile = File(context.filesDir, "service_state")
        if (!initialized) {
            readFromFile()
            checkDailyReset()
            initialized = true
            LogCollector.append("[State] Restored counters: msgs=${_messageCount.value} today=${_messagesToday.value} tokens=${_tokensTotal.value}")
        }
    }

    fun updateStatus(s: ServiceStatus) {
        _status.value = s
        writeToFile()
    }

    fun updateUptime(millis: Long) {
        _uptime.value = millis
        writeToFile()
    }

    fun incrementMessages() {
        checkDailyReset()
        _messageCount.value++
        _messagesToday.value++
        _lastActivityTime.value = System.currentTimeMillis()
        writeToFile()
        LogCollector.append("[State] Message increment: total=${_messageCount.value} today=${_messagesToday.value}")
    }

    fun addTokens(count: Long) {
        checkDailyReset()
        _tokensToday.value += count
        _tokensTotal.value += count
        writeToFile()
        LogCollector.append("[State] Token addition: +$count today=${_tokensToday.value} total=${_tokensTotal.value}")
    }

    fun reset() {
        _status.value = ServiceStatus.STOPPED
        _uptime.value = 0L
        _messageCount.value = 0
        _messagesToday.value = 0
        _lastActivityTime.value = 0L
        _tokensToday.value = 0L
        _tokensTotal.value = 0L
        writeToFile()
    }

    /**
     * Start polling the state file for cross-process updates.
     * Call this from the UI process (Application.onCreate).
     */
    fun startPolling(context: Context) {
        init(context)
        pollingJob?.cancel()
        pollingJob = scope.launch {
            while (isActive) {
                readFromFile()
                readClaudeUsageFile()
                delay(1000)
            }
        }
    }

    /**
     * Reset "today" counters if the last activity was on a different day.
     * Uses the stored lastResetDay in the state file to track.
     */
    private fun checkDailyReset() {
        val file = stateFile ?: return
        try {
            val dayFile = File(file.parentFile, "service_state_day")
            val todayDay = Calendar.getInstance().get(Calendar.DAY_OF_YEAR)
            val todayYear = Calendar.getInstance().get(Calendar.YEAR)
            val todayKey = "${todayYear}_${todayDay}"

            val lastDay = if (dayFile.exists()) dayFile.readText().trim() else ""
            if (lastDay != todayKey) {
                _messagesToday.value = 0
                _tokensToday.value = 0
                dayFile.writeText(todayKey)
            }
        } catch (_: Exception) {}
    }

    /**
     * File format (one value per line):
     * 0: status name
     * 1: uptime millis
     * 2: messageCount (all-time)
     * 3: messagesToday
     * 4: lastActivityTime
     * 5: tokensToday
     * 6: tokensTotal
     */
    private fun writeToFile() {
        val file = stateFile ?: return
        try {
            val data = buildString {
                appendLine(_status.value.name)
                appendLine(_uptime.value)
                appendLine(_messageCount.value)
                appendLine(_messagesToday.value)
                appendLine(_lastActivityTime.value)
                appendLine(_tokensToday.value)
                append(_tokensTotal.value)
            }
            file.writeText(data)
        } catch (_: Exception) {}
    }

    private fun readFromFile() {
        val file = stateFile ?: return
        try {
            if (!file.exists()) return
            val lines = file.readLines()
            if (lines.size >= 5) {
                val fileStatus = try { ServiceStatus.valueOf(lines[0]) } catch (_: Exception) { return }
                val fileUptime = lines[1].toLongOrNull() ?: return
                val fileMsgCount = lines[2].toIntOrNull() ?: return
                val fileMsgToday = lines[3].toIntOrNull() ?: return
                val fileLastActivity = lines[4].toLongOrNull() ?: return

                if (_status.value != fileStatus) _status.value = fileStatus
                if (_uptime.value != fileUptime) _uptime.value = fileUptime
                if (_messageCount.value != fileMsgCount) _messageCount.value = fileMsgCount
                if (_messagesToday.value != fileMsgToday) _messagesToday.value = fileMsgToday
                if (_lastActivityTime.value != fileLastActivity) _lastActivityTime.value = fileLastActivity

                // Token fields (backwards compatible - may not exist in older files)
                if (lines.size >= 7) {
                    val fileTokensToday = lines[5].toLongOrNull() ?: 0L
                    val fileTokensTotal = lines[6].toLongOrNull() ?: 0L
                    if (_tokensToday.value != fileTokensToday) _tokensToday.value = fileTokensToday
                    if (_tokensTotal.value != fileTokensTotal) _tokensTotal.value = fileTokensTotal
                }
            }
        } catch (_: Exception) {}
    }

    private fun readClaudeUsageFile() {
        val parent = stateFile?.parentFile ?: return
        val file = File(parent, "workspace/claude_usage_state")
        try {
            if (!file.exists()) return
            val json = JSONObject(file.readText())
            val type = json.optString("type", "")
            val updatedAt = try {
                java.time.Instant.parse(json.optString("updated_at", "")).toEpochMilli()
            } catch (_: Exception) {
                System.currentTimeMillis()
            }
            val error = json.optString("error", "").ifBlank { null }

            val usage = if (type == "oauth") {
                val fh = json.optJSONObject("five_hour")
                val sd = json.optJSONObject("seven_day")
                ClaudeUsageData.OAuthUsage(
                    fiveHourUtilization = fh?.optDouble("utilization", 0.0)?.toFloat() ?: 0f,
                    fiveHourResetsAt = fh?.optString("resets_at", "") ?: "",
                    sevenDayUtilization = sd?.optDouble("utilization", 0.0)?.toFloat() ?: 0f,
                    sevenDayResetsAt = sd?.optString("resets_at", "") ?: "",
                    updatedAt = updatedAt,
                    error = error,
                )
            } else if (type == "api_key") {
                val req = json.optJSONObject("requests")
                val tok = json.optJSONObject("tokens")
                ClaudeUsageData.ApiKeyUsage(
                    requestsLimit = req?.optInt("limit", 0) ?: 0,
                    requestsRemaining = req?.optInt("remaining", 0) ?: 0,
                    requestsReset = req?.optString("reset", "") ?: "",
                    tokensLimit = tok?.optLong("limit", 0) ?: 0,
                    tokensRemaining = tok?.optLong("remaining", 0) ?: 0,
                    tokensReset = tok?.optString("reset", "") ?: "",
                    updatedAt = updatedAt,
                    error = error,
                )
            } else {
                return
            }

            if (_claudeUsage.value != usage) _claudeUsage.value = usage
        } catch (_: Exception) {}
    }
}
