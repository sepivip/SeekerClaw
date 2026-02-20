package com.seekerclaw.app

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.util.Analytics
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.ServiceState

class SeekerClawApplication : Application() {

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()

        // Firebase Analytics
        Analytics.init(this)
        ConfigManager.loadConfig(this)?.let { config ->
            Analytics.setUserProperty("model", config.model)
            Analytics.setUserProperty("auth_type", config.authType)
        }
        Analytics.setUserProperty("has_wallet", (!ConfigManager.getWalletAddress(this).isNullOrBlank()).toString())

        // Start cross-process polling so UI picks up state/logs from :node process.
        // Guard: only the main UI process should poll. The :node process writes state
        // files — if it also polled, both processes would detect health transitions
        // and write duplicate log entries to the shared service_logs file (BAT-217).
        val isMainProcess = getProcessName() == packageName
        if (isMainProcess) {
            ServiceState.startPolling(this)
            LogCollector.startPolling(this)
        }
    }

    private fun createNotificationChannel() {
        val manager = getSystemService(NotificationManager::class.java)

        // Silent low-priority channel for the always-on foreground service notification.
        val serviceChannel = NotificationChannel(
            CHANNEL_ID,
            "SeekerClaw Service",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Keeps the AI agent running in the background"
            setShowBadge(false)
        }
        manager.createNotificationChannel(serviceChannel)

        // High-importance channel for actionable errors (e.g., setup required).
        // Uses default sound so the user is clearly alerted to an issue.
        val errorChannel = NotificationChannel(
            ERROR_CHANNEL_ID,
            "SeekerClaw Alerts",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "Important alerts that require user action"
            setShowBadge(true)
        }
        manager.createNotificationChannel(errorChannel)
    }

    companion object {
        const val CHANNEL_ID = "seekerclaw_service"
        const val ERROR_CHANNEL_ID = "seekerclaw_errors"
    }
}
