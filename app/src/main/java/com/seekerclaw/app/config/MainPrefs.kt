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
     *
     * BAT-1661 (CodeRabbit on ca06bb79): every editor of the returned prefs commits and applies
     * under [writeMonitor], the lock [commitOrRestore] holds from its snapshot through its restore.
     * So an unlocked MAIN writer (the auto-start toggle, `lastCustomModel_*`, `lastAuthType_*`)
     * lands either before that snapshot or after the restore — never inside the window, where a
     * write of the same key and value could not be told apart from the failed edit's.
     *
     * Cost: a main-thread `apply()` (or `commit()`) can now wait for an in-flight commit on another
     * thread — typically milliseconds; on a failing disk up to two fsyncs (the failed commit plus
     * [commitOrRestore]'s restore commit).
     */
    fun forWrite(context: Context, site: String): SharedPreferences? {
        if (ProcessRole.isNode) {
            Log.e(TAG, "blocked a settings write from the agent process ($site)")
            LogCollector.append("[Config] blocked a settings write from the agent process ($site)", LogLevel.ERROR)
            return null
        }
        return Guarded(open(context))
    }

    /**
     * BAT-1661: the MAIN prefs write lock. A LEAF lock: held only around a prefs commit/apply (and
     * [commitOrRestore]'s snapshot → commit → restore), never while taking `ModelSelectionLock`, a
     * store lock or ResetGate, so it cannot join a lock cycle. Writers already inside
     * `ModelSelectionLock` take it last.
     *
     * Nothing may be called out to while it is held: no other lock, no listener, no callback, no
     * I/O beyond the prefs commit itself. Only `SharedPreferences` reads, `edit()` and the
     * commit/apply run under it. Keep it that way — a call-out is how a leaf lock becomes a cycle.
     *
     * Listeners: Android notifies `OnSharedPreferenceChangeListener`s from inside `commit()` when it
     * runs on the main thread (synchronously, before `commit()` returns) — i.e. UNDER this lock. No
     * listener is registered on MAIN prefs today. None may be registered without revisiting this
     * leaf rule (the listener would run while the lock is held).
     */
    private val writeMonitor = Any()

    /** [forWrite]'s prefs: reads delegate; every editor commits under [writeMonitor]. */
    private class Guarded(private val p: SharedPreferences) : SharedPreferences by p {
        override fun edit(): SharedPreferences.Editor = GuardedEditor(p.edit())
    }

    /** Puts return THIS editor, so a chained `commit()`/`apply()` always takes [writeMonitor]. */
    private class GuardedEditor(private val e: SharedPreferences.Editor) : SharedPreferences.Editor {
        override fun putString(key: String?, value: String?) = apply { e.putString(key, value) }
        override fun putStringSet(key: String?, values: MutableSet<String>?) = apply { e.putStringSet(key, values) }
        override fun putInt(key: String?, value: Int) = apply { e.putInt(key, value) }
        override fun putLong(key: String?, value: Long) = apply { e.putLong(key, value) }
        override fun putFloat(key: String?, value: Float) = apply { e.putFloat(key, value) }
        override fun putBoolean(key: String?, value: Boolean) = apply { e.putBoolean(key, value) }
        override fun remove(key: String?) = apply { e.remove(key) }
        override fun clear() = apply { e.clear() }
        override fun commit(): Boolean = synchronized(writeMonitor) { e.commit() }
        override fun apply() = synchronized(writeMonitor) { e.apply() }
    }

    /**
     * BAT-1661: a getter-only view of prefs a MAIN caller already holds from [forWrite] (the
     * runtime-state mirror reads the repair snapshot through the same handle it mirrors into).
     */
    fun view(p: SharedPreferences): PrefsReader = Reader(p)

    /**
     * BAT-1661: an edit of MAIN's prefs that records the keys it puts or removes, for
     * [commitOrRestore]. Obtain with [edit]. `clear()` is not supported (nothing could be restored).
     */
    class Edit internal constructor(val prefs: SharedPreferences) : SharedPreferences.Editor {
        private val inner = prefs.edit()

        /** Each key this edit writes, with the value it writes (null: removed). */
        val written = LinkedHashMap<String, Any?>()

        private fun rec(key: String?, value: Any?): Edit = apply { written[key!!] = value }
        override fun putString(key: String?, value: String?): Edit { inner.putString(key, value); return rec(key, value) }
        override fun putStringSet(key: String?, values: MutableSet<String>?): Edit {
            inner.putStringSet(key, values); return rec(key, values?.toSet())
        }
        override fun putInt(key: String?, value: Int): Edit { inner.putInt(key, value); return rec(key, value) }
        override fun putLong(key: String?, value: Long): Edit { inner.putLong(key, value); return rec(key, value) }
        override fun putFloat(key: String?, value: Float): Edit { inner.putFloat(key, value); return rec(key, value) }
        override fun putBoolean(key: String?, value: Boolean): Edit { inner.putBoolean(key, value); return rec(key, value) }
        override fun remove(key: String?): Edit { inner.remove(key); return rec(key, null) }
        override fun clear(): Edit = throw UnsupportedOperationException("clear() cannot be restored")
        override fun commit(): Boolean = inner.commit()
        override fun apply() = inner.apply()
    }

    /** A recording edit of [prefs] (see [Edit], [commitOrRestore]). */
    fun edit(prefs: SharedPreferences): Edit = Edit(prefs)

    /**
     * BAT-1661: commit [edit]; on failure, put back into this process's cache the values its keys
     * held just before the commit, and return false.
     *
     * Android's `commit()` applies the edit to the in-memory map first and only then writes the
     * file. When the write fails, the map keeps the new values: every later read sees them as if
     * they were saved, a comparison against them skips the retry, and the next successful commit
     * of ANY key writes the whole map — the failed values included — to disk. Restoring the cache
     * makes a failed write look failed. The restore is itself committed (it may land on disk;
     * those are the old values either way).
     *
     * Only the keys [edit] wrote are restored, and each only while the cache still holds the value
     * [edit] wrote: another key's write is kept, never reverted. The whole snapshot → commit →
     * restore runs under [writeMonitor], which every [forWrite] editor also takes, so no MAIN
     * writer can land inside it (a same-key, same-value write would otherwise be indistinguishable
     * from the failed edit's and be reverted). Pass prefs from [forWrite] (or a test fake).
     */
    fun commitOrRestore(edit: Edit): Boolean = synchronized(writeMonitor) { commitOrRestoreLocked(edit) }

    private fun commitOrRestoreLocked(edit: Edit): Boolean {
        val prefs = edit.prefs
        val all = prefs.all
        val before = edit.written.keys.associateWith { all[it] }
        if (edit.commit()) return true
        val now = prefs.all
        val restore = prefs.edit()
        var changed = false
        for ((key, wrote) in edit.written) {
            val old = before[key]
            if (now[key] != wrote || old == wrote) continue // another writer's value, or nothing to undo
            changed = true
            @Suppress("UNCHECKED_CAST")
            when (old) {
                null -> restore.remove(key)
                is String -> restore.putString(key, old)
                is Boolean -> restore.putBoolean(key, old)
                is Int -> restore.putInt(key, old)
                is Long -> restore.putLong(key, old)
                is Float -> restore.putFloat(key, old)
                is Set<*> -> restore.putStringSet(key, old as Set<String>)
            }
        }
        if (changed) restore.commit()
        return false
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
