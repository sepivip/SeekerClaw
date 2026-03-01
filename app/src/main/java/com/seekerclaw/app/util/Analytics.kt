package com.seekerclaw.app.util

import android.content.Context
import android.os.Bundle
import android.util.Log

/**
 * Analytics wrapper that loads Firebase via reflection.
 * When Firebase classes are absent (dappStore flavor), all calls are no-ops.
 * M-19: Firebase is only bundled in googlePlay flavor.
 */
object Analytics {
    private const val TAG = "Analytics"
    private var fb: Any? = null  // FirebaseAnalytics instance (loaded via reflection)
    private var logEventMethod: java.lang.reflect.Method? = null
    private var setUserPropertyMethod: java.lang.reflect.Method? = null

    fun init(context: Context) {
        try {
            val clazz = Class.forName("com.google.firebase.analytics.FirebaseAnalytics")
            val getInstance = clazz.getMethod("getInstance", Context::class.java)
            fb = getInstance.invoke(null, context)
            logEventMethod = clazz.getMethod("logEvent", String::class.java, Bundle::class.java)
            setUserPropertyMethod = clazz.getMethod("setUserProperty", String::class.java, String::class.java)
        } catch (e: ClassNotFoundException) {
            // Firebase not bundled (dappStore flavor) — analytics disabled
            Log.d(TAG, "Firebase not available — analytics disabled")
            fb = null
        } catch (e: Exception) {
            Log.w(TAG, "Firebase init failed — analytics disabled", e)
            fb = null
        }
    }

    // ── Core ──

    fun logEvent(name: String, params: Map<String, Any?> = emptyMap()) {
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
        try {
            logEventMethod?.invoke(analytics, name, bundle)
        } catch (_: Exception) {}
    }

    fun setUserProperty(key: String, value: String?) {
        val analytics = fb ?: return
        try {
            setUserPropertyMethod?.invoke(analytics, key, value)
        } catch (_: Exception) {}
    }

    fun logScreenView(screenName: String) {
        logEvent("screen_view", mapOf("screen_name" to screenName))
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
