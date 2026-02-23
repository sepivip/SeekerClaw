package com.seekerclaw.app.util

import android.content.Context
import android.os.Bundle
import com.google.firebase.analytics.FirebaseAnalytics

object Analytics {
    private var fb: FirebaseAnalytics? = null

    fun init(context: Context) {
        try {
            fb = FirebaseAnalytics.getInstance(context)
        } catch (_: Exception) {
            fb = null
        }
    }

    // ── Core ──

    fun logEvent(name: String, params: Map<String, Any?> = emptyMap()) {
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
        fb?.logEvent(name, bundle)
    }

    fun setUserProperty(key: String, value: String?) {
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
