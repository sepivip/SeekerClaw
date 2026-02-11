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

        // Start cross-process polling so UI picks up state/logs from :node process
        ServiceState.startPolling(this)
        LogCollector.startPolling(this)
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "SeekerClaw Service",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Keeps the AI agent running in the background"
            setShowBadge(false)
        }
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(channel)
    }

    companion object {
        const val CHANNEL_ID = "seekerclaw_service"
    }
}
