package com.seekerclaw.app.util

import android.content.Context
import android.os.Bundle
import android.util.Log
import com.google.firebase.analytics.FirebaseAnalytics
import com.seekerclaw.app.config.PrefsNames

object Analytics {
    private const val TAG = "Analytics"
    private const val PREF_KEY = "analytics_enabled"
    private var fb: FirebaseAnalytics? = null
    @Volatile private var enabled = true // default ON

    fun init(context: Context) {
        try {
            fb = FirebaseAnalytics.getInstance(context)
            val prefs = context.getSharedPreferences(PrefsNames.MAIN, Context.MODE_PRIVATE)
            enabled = prefs.getBoolean(PREF_KEY, true) // default ON
            fb?.setAnalyticsCollectionEnabled(enabled)
        } catch (e: IllegalStateException) {
            Log.w(TAG, "Firebase unavailable — analytics disabled", e)
            fb = null
        } catch (e: Exception) {
            Log.e(TAG, "Unexpected error initializing Firebase — analytics disabled", e)
            fb = null
        }
    }

    fun isEnabled(context: Context): Boolean {
        return context.getSharedPreferences(PrefsNames.MAIN, Context.MODE_PRIVATE)
            .getBoolean(PREF_KEY, true)
    }

    fun setEnabled(context: Context, enable: Boolean) {
        enabled = enable
        context.getSharedPreferences(PrefsNames.MAIN, Context.MODE_PRIVATE)
            .edit().putBoolean(PREF_KEY, enable).apply()
        fb?.setAnalyticsCollectionEnabled(enable)
    }

    // ── Core ──

    fun logEvent(name: String, params: Map<String, Any?> = emptyMap()) {
        if (!enabled) return
        val analytics = fb ?: return
        val bundle = Bundle().apply {
            for ((k, v) in params) {
                when (v) {
                    is String -> putString(k, v)
                    is Long -> putLong(k, v)
                    is Int -> putLong(k, v.toLong())
                    is Double -> putDouble(k, v)
                    is Boolean -> putString(k, v.toString())
                    else -> if (v != null) putString(k, v.toString())
                }
            }
        }
        analytics.logEvent(name, bundle)
    }

    fun setUserProperty(key: String, value: String?) {
        if (!enabled) return
        fb?.setUserProperty(key, value)
    }

    fun logScreenView(screenName: String) {
        logEvent(FirebaseAnalytics.Event.SCREEN_VIEW, mapOf(
            FirebaseAnalytics.Param.SCREEN_NAME to screenName,
        ))
    }

    // ── Service lifecycle ──

    fun serviceStarted(attempt: Int) {
        logEvent("service_start", mapOf("attempt" to attempt))
    }

    fun serviceStopped(uptimeMinutes: Long) {
        logEvent("service_stop", mapOf("uptime_minutes" to uptimeMinutes))
    }

    fun serviceError(errorType: String) {
        logEvent("service_error", mapOf("error_type" to errorType))
    }

    // ── Engagement ──

    fun messageSent(model: String, tokensUsed: Long = 0) {
        logEvent("message_sent", mapOf("model" to model, "tokens_used" to tokensUsed))
    }

    fun modelSelected(model: String) {
        logEvent("model_selected", mapOf("model" to model))
        setUserProperty("model", model)
    }

    fun authTypeChanged(authType: String) {
        logEvent("auth_type_changed", mapOf("auth_type" to authType))
        setUserProperty("auth_type", authType)
    }

    // ── Features ──

    fun featureUsed(feature: String, params: Map<String, Any?> = emptyMap()) {
        logEvent(feature, params)
    }
}
