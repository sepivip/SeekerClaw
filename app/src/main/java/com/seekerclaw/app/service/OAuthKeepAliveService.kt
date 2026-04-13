package com.seekerclaw.app.service

import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Handler
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
 * Explicitly stopped by OpenAIOAuthActivity in the normal completion
 * paths: onComplete callback (success/error), cancel button press,
 * server-start failure, and error/missing-code callback handler paths.
 * If the OAuth flow reaches its 10-minute timeout without an explicit
 * stop, this service's own auto-stop safety net (also 10 minutes)
 * cleans it up — the two timeouts are aligned by design.
 */
class OAuthKeepAliveService : Service() {

    companion object {
        private const val TAG = "OAuthKeepAlive"
        private const val NOTIFICATION_ID = 9002
        // Aligned with the 10-minute OAuth polling timeout in
        // rememberOpenAIOAuthController so the service doesn't die while
        // the user is still authenticating (e.g. slow MFA).
        private const val AUTO_STOP_DELAY_MS = 600_000L // 10 minutes

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

    // Single Handler instance — must be the SAME object in onStartCommand
    // and onDestroy so removeCallbacks actually finds the posted Runnable.
    // Using a different Handler instance would make removeCallbacks a no-op.
    private val handler = Handler(android.os.Looper.getMainLooper())

    private val autoStopRunnable = Runnable {
        Log.w(TAG, "Auto-stopping after ${AUTO_STOP_DELAY_MS / 1000}s timeout")
        stopSelf()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = NotificationCompat.Builder(this, SeekerClawApplication.CHANNEL_ID)
            .setContentTitle("Signing in...")
            .setContentText("Completing OpenAI authentication")
            .setSmallIcon(R.drawable.ic_notification)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

        startForeground(NOTIFICATION_ID, notification)
        Log.i(TAG, "Keep-alive service started (foreground)")

        // Clear any existing auto-stop from a prior start cycle, then
        // schedule a fresh one. Prevents stacked callbacks on rapid
        // stop/start cycles.
        handler.removeCallbacks(autoStopRunnable)
        handler.postDelayed(autoStopRunnable, AUTO_STOP_DELAY_MS)

        return START_NOT_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(autoStopRunnable)
        Log.i(TAG, "Keep-alive service destroyed")
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
