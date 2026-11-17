package com.seekerclaw.app.config

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
import com.seekerclaw.app.util.ProcessRole

/**
 * BAT-1157 (BAT-1661 contract D6.1/D7.1): the only way to open `seekerclaw_prefs`.
 *
 * ## Why only MAIN may write it
 * `SharedPreferences.commit()/apply()` writes the calling process's WHOLE cached map, not just
 * the keys in the editor, and each process loads its cache once. A write from `:node` therefore
 * puts back every key as `:node` last saw it: a model the user changed in Settings, OAuth token
 * keys that MAIN has already swept, an agent name. So `:node` may read the file, never write it.
 *
 * ## How it is enforced
 * - [read] returns a [PrefsReader]: getters only, implemented by a private wrapper that does NOT
 *   implement [SharedPreferences], so an edit through the read accessor does not compile.
 * - [forWrite] returns the editable prefs in MAIN and `null` in `:node`, logging an ERROR; a
 *   blocked write is a bug, never a fallback.
 * - `PrefsNamesTest` pins that the file is opened nowhere else, and that a [PrefsReader] is never
 *   cast back to [SharedPreferences].
 */
object MainPrefs {
    private const val TAG = "MainPrefs"

    /** Read access, in either process. */
    fun read(context: Context): PrefsReader = Reader(open(context))

    /**
     * Write access: MAIN only. In `:node` returns `null` and logs
     * `[Config] blocked a settings write from the agent process (<site>)` at ERROR.
     */
    fun forWrite(context: Context, site: String): SharedPreferences? {
        if (ProcessRole.isNode) {
            Log.e(TAG, "blocked a settings write from the agent process ($site)")
            LogCollector.append("[Config] blocked a settings write from the agent process ($site)", LogLevel.ERROR)
            return null
        }
        return open(context)
    }

    private fun open(context: Context): SharedPreferences =
        context.getSharedPreferences(PrefsNames.MAIN, Context.MODE_PRIVATE)

    /** Getter-only view. Deliberately NOT a [SharedPreferences] (see the class KDoc). */
    private class Reader(private val p: SharedPreferences) : PrefsReader {
        override fun getString(key: String, defValue: String?): String? = p.getString(key, defValue)
        override fun getStringSet(key: String, defValues: Set<String>?): Set<String>? = p.getStringSet(key, defValues)
        override fun getBoolean(key: String, defValue: Boolean): Boolean = p.getBoolean(key, defValue)
        override fun getInt(key: String, defValue: Int): Int = p.getInt(key, defValue)
        override fun getLong(key: String, defValue: Long): Long = p.getLong(key, defValue)
        override fun getFloat(key: String, defValue: Float): Float = p.getFloat(key, defValue)
        override fun contains(key: String): Boolean = p.contains(key)
    }
}

/** BAT-1157: read-only access to `seekerclaw_prefs`. Obtain with [MainPrefs.read]. */
interface PrefsReader {
    fun getString(key: String, defValue: String?): String?
    fun getStringSet(key: String, defValues: Set<String>?): Set<String>?
    fun getBoolean(key: String, defValue: Boolean): Boolean
    fun getInt(key: String, defValue: Int): Int
    fun getLong(key: String, defValue: Long): Long
    fun getFloat(key: String, defValue: Float): Float
    fun contains(key: String): Boolean
}
