package com.seekerclaw.app.bridge

import android.app.ActivityManager

/**
 * BAT-1409 P1-H — may a bridge route open a screen right now?
 *
 * Android blocks activity starts from the background, and on Android 14+ a blocked start is
 * silent: `startActivity` neither throws nor reports it. Both processes share one uid, so a start
 * from `:node` is allowed while the MAIN (UI) process has a visible window. The decision is
 * therefore made on the main process alone, and only FOREGROUND (100) or VISIBLE (200) counts.
 * `:node`'s own foreground-service importance (125) never counts, and neither does a main process
 * at 125 — that is why the test is an exact match, not `<= IMPORTANCE_VISIBLE`.
 */
object UiForeground {

    /**
     * One entry of `ActivityManager.getRunningAppProcesses()`. [pid] (BAT-1724) is only read by
     * [com.seekerclaw.app.util.NodeLiveness]; [isVisible] ignores it, and callers that do not need
     * it leave the default.
     */
    data class Proc(val name: String, val importance: Int, val pid: Int = 0)

    /** True when the process named [packageName] (the main process) is FOREGROUND or VISIBLE. */
    fun isVisible(processes: List<Proc>?, packageName: String): Boolean {
        val main = processes?.firstOrNull { it.name == packageName } ?: return false
        return main.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND ||
            main.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE
    }
}
