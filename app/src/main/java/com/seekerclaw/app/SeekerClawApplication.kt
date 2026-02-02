package com.seekerclaw.app

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.ServiceState

class SeekerClawApplication : Application() {

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()

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
