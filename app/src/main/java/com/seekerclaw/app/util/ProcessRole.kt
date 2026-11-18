package com.seekerclaw.app.util

import android.app.Application

/**
 * BAT-1157: which Android process this code runs in, decided once.
 *
 * The app runs two processes over the same files: MAIN (the UI, sign-in, Settings) and `:node`
 * (the foreground service hosting the agent). Some writes are only safe from MAIN — above all
 * `seekerclaw_prefs`, because `SharedPreferences.commit()/apply()` writes the calling process's
 * WHOLE cached map, so a `:node` write can undo a newer MAIN save ([com.seekerclaw.app.config.MainPrefs]).
 *
 * `Application.getProcessName()` is static (API 28+) and cheap, but the answer never changes for a
 * process, so it is cached. In JVM unit tests the Android stub returns null, which reads as MAIN;
 * tests that need `:node` call [setForTest].
 */
object ProcessRole {
    @Volatile
    private var cached: Boolean? = null

    /** True in the `:node` service process. */
    val isNode: Boolean
        get() = cached ?: (Application.getProcessName()?.endsWith(":node") == true).also { cached = it }

    /** Tests only: force the role (`null` restores detection). */
    internal fun setForTest(isNode: Boolean?) {
        cached = isNode
    }
}
