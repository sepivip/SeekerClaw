package com.seekerclaw.app.config

/**
 * BAT-1409 P1-C (amendment v3.3 M1) — the one registry of SharedPreferences file names.
 *
 * Boot link hygiene checks `shared_prefs/<name>.xml` and `<name>.xml.bak` for every name in
 * [ALL] before the first prefs load, so every `getSharedPreferences` call site must use a name
 * from here (`PrefsNamesTest` enforces it).
 */
object PrefsNames {
    /** Settings, credentials and most app state. */
    const val MAIN = "seekerclaw_prefs"

    /** Crash-loop counters for the `:node` service. */
    const val CRASH = "seekerclaw_crash"

    /** Bundle extraction bookkeeping (last APK update time). */
    const val NODEJS_MOBILE = "NODEJS_MOBILE_PREFS"

    val ALL: List<String> = listOf(MAIN, CRASH, NODEJS_MOBILE)
}
