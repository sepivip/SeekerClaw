package com.seekerclaw.app

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.core.content.ContextCompat
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
            registerConfigChangedReceiver()
        }
    }

    /**
     * Listen for cross-process config changes so the UI's configVersion
     * counter (per-process Compose state) bumps when ANY process writes
     * SharedPreferences via ConfigManager.saveConfig or
     * reconcileWithAgentSettings. Without this, after a /provider Telegram
     * switch (which runs in :node and triggers a service-start reconcile
     * that writes prefs), the main-process UI screens hold the stale
     * pre-switch values until the user manually navigates away and back —
     * remounting the screen forces a fresh loadConfig() read.
     *
     * The broadcast is package-scoped (setPackage(packageName) in
     * ConfigManager.broadcastConfigChanged) and the receiver is
     * NOT_EXPORTED, so this is internal-only — no external app can
     * trigger spurious recompositions or read our intent.
     *
     * Registered for the lifetime of the Application. No matching
     * unregister: the Application instance lives as long as the process,
     * so leaving the receiver registered is fine and avoids a missed-
     * unregister hazard.
     */
    private fun registerConfigChangedReceiver() {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.action == ConfigManager.ACTION_CONFIG_CHANGED) {
                    ConfigManager.configVersion.intValue++
                }
            }
        }
        ContextCompat.registerReceiver(
            this,
            receiver,
            IntentFilter(ConfigManager.ACTION_CONFIG_CHANGED),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
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
