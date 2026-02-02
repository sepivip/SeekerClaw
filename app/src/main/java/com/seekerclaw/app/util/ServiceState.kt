package com.seekerclaw.app.util

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File

enum class ServiceStatus { STOPPED, STARTING, RUNNING, ERROR }

object ServiceState {
    private val _status = kotlinx.coroutines.flow.MutableStateFlow(ServiceStatus.STOPPED)
    val status: kotlinx.coroutines.flow.StateFlow<ServiceStatus> = _status

    private val _uptime = kotlinx.coroutines.flow.MutableStateFlow(0L)
    val uptime: kotlinx.coroutines.flow.StateFlow<Long> = _uptime

    private val _messageCount = kotlinx.coroutines.flow.MutableStateFlow(0)
    val messageCount: kotlinx.coroutines.flow.StateFlow<Int> = _messageCount

    private val _messagesToday = kotlinx.coroutines.flow.MutableStateFlow(0)
    val messagesToday: kotlinx.coroutines.flow.StateFlow<Int> = _messagesToday

    private val _lastActivityTime = kotlinx.coroutines.flow.MutableStateFlow(0L)
    val lastActivityTime: kotlinx.coroutines.flow.StateFlow<Long> = _lastActivityTime

    private var stateFile: File? = null
    private var pollingJob: Job? = null
    private val scope = CoroutineScope(Dispatchers.IO)

    fun init(context: Context) {
        stateFile = File(context.filesDir, "service_state")
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
        _messageCount.value++
        _messagesToday.value++
        _lastActivityTime.value = System.currentTimeMillis()
        writeToFile()
    }

    fun reset() {
        _status.value = ServiceStatus.STOPPED
        _uptime.value = 0L
        _messageCount.value = 0
        _messagesToday.value = 0
        _lastActivityTime.value = 0L
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
                delay(1000)
            }
        }
    }

    private fun writeToFile() {
        val file = stateFile ?: return
        try {
            val data = "${_status.value.name}\n${_uptime.value}\n${_messageCount.value}\n${_messagesToday.value}\n${_lastActivityTime.value}"
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
            }
        } catch (_: Exception) {}
    }
}
