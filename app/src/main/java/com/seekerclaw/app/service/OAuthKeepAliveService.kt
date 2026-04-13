package com.seekerclaw.app.service

import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.seekerclaw.app.R
import com.seekerclaw.app.SeekerClawApplication

/**
 * Minimal foreground service that keeps the app process alive and with
 * unrestricted network access during the OpenAI OAuth browser flow.
 *
 * WHY THIS EXISTS (BAT-494)
 * -------------------------
 * When Chrome Custom Tab is in the foreground for the OAuth sign-in,
 * SeekerClaw goes to the background. On Pixel 7 (stock Android 14),
 * Android restricts the background process's internet access — DNS
 * resolution for `auth.openai.com` fails with `UnknownHostException`
 * even though WiFi is connected and Chrome (foreground) can reach it.
 *
 * A foreground service gives the process "foreground service" priority
 * and unrestricted network access. This service does NO work — it just
 * holds a notification ("Signing in...") for the duration of the
 * OAuth browser round-trip, then stops itself.
 *
 * LIFECYCLE
 * ---------
 * Started by OpenAIOAuthActivity BEFORE opening Chrome Custom Tab.
 * Stopped by OpenAIOAuthActivity's onComplete callback (success, error,
 * cancel, or timeout). Also auto-stops after 2 minutes via
 * [android.app.Service.stopSelf] as a safety net in case the callback
 * never arrives.
 */
class OAuthKeepAliveService : Service() {

    companion object {
        private const val TAG = "OAuthKeepAlive"
        private const val NOTIFICATION_ID = 9002
        private const val AUTO_STOP_DELAY_MS = 120_000L // 2 minutes

        fun start(context: Context) {
            try {
                val intent = Intent(context, OAuthKeepAliveService::class.java)
                context.startForegroundService(intent)
                Log.i(TAG, "Keep-alive service start requested")
            } catch (e: Exception) {
                Log.w(TAG, "Failed to start keep-alive service: ${e.message}")
            }
        }

        fun stop(context: Context) {
            try {
                val intent = Intent(context, OAuthKeepAliveService::class.java)
                context.stopService(intent)
                Log.i(TAG, "Keep-alive service stop requested")
            } catch (e: Exception) {
                Log.w(TAG, "Failed to stop keep-alive service: ${e.message}")
            }
        }
    }

    private val autoStopRunnable = Runnable {
        Log.w(TAG, "Auto-stopping after ${AUTO_STOP_DELAY_MS / 1000}s timeout")
        stopSelf()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = NotificationCompat.Builder(this, SeekerClawApplication.CHANNEL_ID)
            .setContentTitle("Signing in...")
            .setContentText("Completing OpenAI authentication")
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

        startForeground(NOTIFICATION_ID, notification)
        Log.i(TAG, "Keep-alive service started (foreground)")

        // Safety net: stop after 2 minutes in case the OAuth callback never arrives.
        android.os.Handler(mainLooper).postDelayed(autoStopRunnable, AUTO_STOP_DELAY_MS)

        return START_NOT_STICKY
    }

    override fun onDestroy() {
        android.os.Handler(mainLooper).removeCallbacks(autoStopRunnable)
        Log.i(TAG, "Keep-alive service destroyed")
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
