package com.seekerclaw.app.testing

import android.content.ContextWrapper
import android.content.SharedPreferences
import java.io.File

/**
 * BAT-1157 test fixture: `seekerclaw_prefs` as Android really behaves across two processes.
 *
 * There is one "disk" map. Each process ([proc]) loads its own cache from disk the FIRST time it
 * opens the prefs and never re-reads it. `commit()`/`apply()` write that process's WHOLE cached
 * map to disk (Android's `SharedPreferencesImpl` serialises the full map), so a write from a
 * process with a stale cache puts old values back. This is the race the store and the MAIN-only
 * writer rule exist to prevent; a single shared map would hide it.
 */
class TwoProcessPrefs(val filesDir: File) {
    /** The on-disk state. Tests may seed it before any process opens the prefs. */
    val disk: MutableMap<String, Any?> = linkedMapOf()

    private val caches = mutableMapOf<String, MutableMap<String, Any?>>()

    /** Forces [proc] to re-read from disk on its next open (a process restart). */
    fun restart(proc: String) {
        caches.remove(proc)
    }

    /** A Context for [proc] ("main" or "node"): filesDir plus this process's prefs view. */
    fun context(proc: String): ContextWrapper = object : ContextWrapper(null) {
        override fun getFilesDir(): File = this@TwoProcessPrefs.filesDir
        override fun getApplicationContext() = this
        override fun getSharedPreferences(name: String?, mode: Int): SharedPreferences = prefsFor(proc)
    }

    private fun cache(proc: String): MutableMap<String, Any?> =
        caches.getOrPut(proc) { LinkedHashMap(disk) }

    private fun prefsFor(proc: String): SharedPreferences = object : SharedPreferences {
        override fun getAll(): MutableMap<String, *> = LinkedHashMap(cache(proc))
        override fun getString(key: String?, defValue: String?): String? = cache(proc)[key] as? String ?: defValue
        @Suppress("UNCHECKED_CAST")
        override fun getStringSet(key: String?, defValues: MutableSet<String>?): MutableSet<String>? =
            (cache(proc)[key] as? Set<String>)?.toMutableSet() ?: defValues
        override fun getInt(key: String?, defValue: Int): Int = cache(proc)[key] as? Int ?: defValue
        override fun getLong(key: String?, defValue: Long): Long = cache(proc)[key] as? Long ?: defValue
        override fun getFloat(key: String?, defValue: Float): Float = cache(proc)[key] as? Float ?: defValue
        override fun getBoolean(key: String?, defValue: Boolean): Boolean = cache(proc)[key] as? Boolean ?: defValue
        override fun contains(key: String?): Boolean = cache(proc).containsKey(key)
        override fun registerOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) {}
        override fun unregisterOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) {}

        override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
            private val puts = linkedMapOf<String, Any?>()
            private val removes = mutableSetOf<String>()
            private var clear = false
            override fun putString(key: String?, value: String?) = apply { puts[key!!] = value }
            override fun putStringSet(key: String?, values: MutableSet<String>?) = apply { puts[key!!] = values?.toSet() }
            override fun putInt(key: String?, value: Int) = apply { puts[key!!] = value }
            override fun putLong(key: String?, value: Long) = apply { puts[key!!] = value }
            override fun putFloat(key: String?, value: Float) = apply { puts[key!!] = value }
            override fun putBoolean(key: String?, value: Boolean) = apply { puts[key!!] = value }
            override fun remove(key: String?) = apply { removes += key!! }
            override fun clear() = apply { clear = true }
            override fun commit(): Boolean {
                val c = cache(proc)
                if (clear) c.clear()
                removes.forEach { c.remove(it) }
                puts.forEach { (k, v) -> if (v == null) c.remove(k) else c[k] = v }
                // Android writes the process's WHOLE cached map, not just this editor's keys.
                disk.clear()
                disk.putAll(c)
                return true
            }
            override fun apply() {
                commit()
            }
        }
    }
}
