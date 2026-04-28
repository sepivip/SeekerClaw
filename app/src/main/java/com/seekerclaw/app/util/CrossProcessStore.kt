package com.seekerclaw.app.util

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.FileObserver
import android.util.Log
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Generic JSON-backed store for state shared between the main UI process
 * and the `:node` service process (BAT-512, BAT-511 family).
 *
 * Pre-CrossProcessStore, the app had two patterns layered uneasily:
 *
 *  - One-off file-IPC primitives ([ServiceState], [LogCollector], owner_ids,
 *    bridge_token, cron jobs). Cross-process-correct, but each one was
 *    hand-rolled; no reuse across new fields.
 *  - SharedPreferences. Per-process cached, BROKEN cross-process — every
 *    field that's read on BOTH UI and `:node` sides has the same staleness
 *    bug (BAT-509 caught it for provider/authType/model; MCP servers,
 *    search provider, agent name and credentials are all latent
 *    instances of the same bug).
 *
 * `CrossProcessStore<T>` consolidates the file-IPC pattern so the rest of
 * the BAT-511 family migrations (BAT-513, BAT-514, BAT-515, BAT-516) can
 * reuse one implementation instead of inventing a new file format each
 * time.
 *
 * ## Refresh strategy
 *
 * Two layered notification mechanisms:
 *
 *  1. **`FileObserver` (Node-side writes path).** When `:node` writes the
 *     file directly via `fs.writeFileSync`, the inotify event fires on
 *     the main UI process and triggers a [reload]. This is the BAT-518
 *     pattern: kernel-level event delivery, no polling.
 *
 *  2. **Package-scoped broadcast (Kotlin-side writes path).** When the
 *     writer is in the same package (any of our processes), [write]
 *     emits an [ACTION_STORE_CHANGED] broadcast carrying the
 *     [EXTRA_FILE_NAME] so other-process receivers can match by file
 *     name and reload. Faster than waiting for the file event in some
 *     edge cases (process boundary just after registration, races with
 *     restart windows).
 *
 * Either mechanism alone is sufficient — both layered gives belt-and-
 * suspenders reliability. Codex's review explicitly forbade the
 * 2s mtime polling fallback the original sketch proposed; FileObserver
 * is the reliable mechanism.
 *
 * ## Atomicity
 *
 * Writes go through a `<filename>.tmp` and are then moved into place
 * with `java.nio.file.Files.move(..., REPLACE_EXISTING, ATOMIC_MOVE)`.
 * That move is atomic at the filesystem level on the filesystems
 * Android uses (ext4, F2FS), so a reader can never observe a half-
 * written file AND there is no DELETE-event window where observers
 * could briefly see `initial`. No fsync — Android-style mobile usage
 * doesn't justify the latency cost; if the device powers off mid-
 * write, the worst case is the previous good version stays on disk.
 *
 * ## Mutation safety (the boundary contract)
 *
 * The store treats T as a value type. Both [read] and [write]
 * defensively clone T at the boundary via [cloneSafe] so:
 *
 *  - **Caller mutates after write()**: the store's internal `_state`
 *    + StateFlow observers see the snapshot the caller intended at
 *    write-time, not whatever the caller's reference morphs into
 *    afterward. Without this, observers could see "writes" that were
 *    never persisted to disk and that diverge from what [read]
 *    returns.
 *  - **Caller mutates after read()**: the store's `initial` default
 *    and StateFlow backing field are unaffected. Without this, a
 *    mutable T (a class with var properties, or a MutableMap) could
 *    let caller-side mutation poison the store.
 *
 * The clone is JSON encode/decode round-trip — cheap on small
 * `@Serializable` data classes (the only realistic T for this store)
 * and produces a fresh object graph with no shared references. The
 * Node parity helper (`cross-process-store.js`) implements the same
 * boundary contract via `JSON.parse(JSON.stringify(value))`.
 *
 * ## What this class does NOT do
 *
 *  - Does not migrate any existing field. New code only — sibling
 *    tickets do migrations one field at a time (BAT-513 onward).
 *  - Does not provide encryption. Sensitive fields (API keys, OAuth
 *    tokens) stay in [com.seekerclaw.app.config.KeystoreHelper] /
 *    SharedPreferences for now. BAT-516 will revisit and add a
 *    Keystore-backed encryption layer.
 *  - Does not deprecate [ServiceState] or [LogCollector] — those are
 *    the prior-art that informed this abstraction; they keep their
 *    bespoke implementations for now (they've shipped and are stable).
 *
 * @param T type of the persisted value. Must be `@Serializable`-able
 *          via the supplied [serializer].
 * @param context any [Context] (process-scoped). Internally pinned to
 *                `context.applicationContext` for `filesDir`, broadcast
 *                send/register, and FileObserver attach so an Activity
 *                or Service Context passed in by mistake can't leak the
 *                receiver/observer for the lifetime of that component.
 * @param fileName basename of the JSON file relative to `filesDir`,
 *                 e.g. `"runtime_state.json"`. Avoid path separators —
 *                 only direct children of `filesDir` are supported.
 * @param serializer kotlinx.serialization serializer for [T]. Pass
 *                   `MyType.serializer()` (generated by `@Serializable`)
 *                   or `serializer<MyType>()`.
 * @param initial value to return from [read] / [state] when the file
 *                doesn't exist or fails to parse.
 * @param coroutineScope scope used to dispatch reload work off the
 *                       FileObserver / receiver threads. Defaults to
 *                       `Dispatchers.IO`.
 */
class CrossProcessStore<T>(
    context: Context,
    private val fileName: String,
    private val serializer: KSerializer<T>,
    private val initial: T,
    parentScope: CoroutineScope? = null,
) {
    init {
        // BAT-512 (Copilot review fix #1): fileName is documented as a
        // basename relative to filesDir. Without enforcement, a caller
        // passing "../etc/passwd" or "subdir/file.json" would resolve
        // OUTSIDE filesDir — path traversal. Validate up-front so
        // misuse is caught at construction, not at first write.
        require(isValidFileName(fileName)) {
            "fileName must be a non-empty basename without path separators or '..': '$fileName'"
        }
    }

    // BAT-512 (Copilot review fix #6): pin to applicationContext so a
    // caller passing an Activity/Service Context can't leak the
    // BroadcastReceiver / FileObserver for the lifetime of that
    // component. The application context survives configuration
    // changes and process boundaries cleanly.
    private val appContext: Context = context.applicationContext

    // BAT-512 (Copilot review fix #7): own a SupervisorJob so close()
    // can cancel in-flight reload coroutines for the default fresh
    // scope we create. If the caller passes their own scope, we use
    // it directly and they retain cancellation ownership; this class
    // does NOT cancel external scopes. The `closed` flag (declared
    // below) guards reload() so post-close updates are suppressed
    // even on external scopes that we can't cancel.
    private val ownedJob: kotlinx.coroutines.CompletableJob? =
        if (parentScope == null) kotlinx.coroutines.SupervisorJob() else null
    private val coroutineScope: CoroutineScope = parentScope
        ?: CoroutineScope(Dispatchers.IO + ownedJob!!)

    private val file: File = File(appContext.filesDir, fileName)
    private val tmpFile: File = File(appContext.filesDir, "$fileName.tmp")
    private val writeLock = Any()

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    // Initialize _state with a deep-cloned seed so a caller mutating
    // the returned value can't poison the StateFlow's backing field.
    // Declared after `json` because cloneSafe() uses it.
    private val _state = MutableStateFlow(cloneSafe(initial))

    /** Observable state. Emits new values on every successful write or reload. */
    val state: StateFlow<T> = _state.asStateFlow()

    private var fileObserver: FileObserver? = null
    private var receiver: BroadcastReceiver? = null

    // BAT-512 (Copilot review fix #1): suppress reload work after close.
    // Required even with an external scope (we don't own its
    // cancellation), and useful as a fast-path bailout for the owned-
    // scope case so a reload coroutine that was already in-flight
    // doesn't publish a value after close().
    private val closed = AtomicBoolean(false)

    // BAT-512 (Copilot review fix #2+3): coalesce reload work via a
    // CONFLATED channel + single drain coroutine. Without this,
    // FileObserver.onEvent fires multiple events per write (MODIFY +
    // CLOSE_WRITE per writeText, CREATE + MODIFY per atomic move) and
    // each one previously launched its own reload coroutine on
    // Dispatchers.IO. Concurrent reloads can complete out of order
    // and publish a stale on-disk value AFTER a newer one — a real
    // race that regresses _state. CONFLATED capacity-1 means: senders
    // never block, an extra signal arriving while one is already
    // queued is dropped (no work to coalesce — a single re-read
    // covers all pending change events), and the drain coroutine
    // reads them one at a time.
    private val reloadChannel: Channel<Unit> = Channel(Channel.CONFLATED)

    // Trailing init runs AFTER every `val` property above is
    // initialized — coroutineScope, _state, reloadChannel, etc. are
    // all valid here. Hydrates _state from disk, starts the drain
    // coroutine, and attaches observers.
    init {
        // Synchronous catch-up read: if the file exists from a prior
        // process, refresh _state immediately so the first
        // `state.value` access returns the persisted value, not the
        // initial seed.
        reload()
        // Single drain coroutine: bursts of FileObserver/broadcast
        // events collapse to a single re-read. Each re-read sees
        // whatever's on disk at that instant; a write that lands
        // DURING a re-read triggers a fresh channel signal, so the
        // NEXT iteration picks it up. Convergence-to-latest, not
        // strict snapshot-of-latest — but no out-of-order publish
        // because there's only ever one in-flight reader.
        coroutineScope.launch {
            for (signal in reloadChannel) {
                if (!isActive || closed.get()) break
                runCatching { reload() }
            }
        }
        startWatching()
    }

    /**
     * Synchronously parse the JSON file and return the value. Idempotent
     * and side-effect-free. Returns a freshly cloned copy of [initial]
     * on missing file or malformed JSON (logged at WARN — never
     * throws).
     *
     * BAT-512 (Copilot review fix #4): the returned value goes through
     * `cloneSafe(initial)` on missing/malformed paths, which JSON-
     * round-trips to produce a fresh instance with no shared
     * references. Without this, a mutable T (e.g. a class with
     * mutable fields, or a pre-Kotlin data type with var properties)
     * could let a caller's accidental mutation poison the store's
     * default and the StateFlow's backing field. The Node helper has
     * the same defensive clone. Edge case: if the JSON round-trip
     * itself throws (only possible for a misconfigured `@Serializable`
     * type — the live cases this store targets are all valid), we
     * fall back to returning the original `initial` reference and log
     * a WARN; in that scenario the caller MUST treat T as immutable.
     */
    fun read(): T {
        if (!file.exists()) return cloneSafe(initial)
        return try {
            json.decodeFromString(serializer, file.readText())
        } catch (e: Exception) {
            Log.w(TAG, "[$fileName] decode failed, returning initial: ${e.message}")
            cloneSafe(initial)
        }
    }

    /**
     * Deep-clone a T via JSON round-trip. Cheap on the small
     * `@Serializable` data classes this store deals with; safe for
     * mutable types because the round-trip produces a fresh object
     * graph with no shared references.
     *
     * Called from BOTH [read] (clone defaults before returning) AND
     * [write] (clone the caller's value before publishing to
     * [_state]) — the symmetric boundary contract that keeps
     * caller-side mutation from leaking through the store. See the
     * class-level "Mutation safety" KDoc.
     */
    private fun cloneSafe(value: T): T {
        return try {
            json.decodeFromString(serializer, json.encodeToString(serializer, value))
        } catch (e: Exception) {
            // Should never happen for a valid `@Serializable` type, but
            // if encodeToString throws we fall back to the original
            // reference rather than crashing the store. Logged so a
            // misuse is detectable.
            Log.w(TAG, "[$fileName] cloneSafe round-trip failed: ${e.message}")
            value
        }
    }

    /**
     * Persist [value] atomically and notify both same-process observers
     * (via [state]) and other-process observers (via FileObserver +
     * broadcast).
     *
     * Concurrent writes from the same process serialize via [writeLock]
     * — `writeText` to the `.tmp` file plus the
     * `Files.move(..., REPLACE_EXISTING, ATOMIC_MOVE)` (with a non-
     * atomic `REPLACE_EXISTING` fallback on
     * `AtomicMoveNotSupportedException`) are the critical section.
     * Cross-process concurrent writes are last-writer-wins (filesystem
     * move semantics); callers that need stronger ordering must
     * coordinate separately.
     *
     * Mutation safety: see the class-level "Mutation safety" doc
     * block. [value] is JSON-cloned via [cloneSafe] before being
     * stored in [_state] so a caller mutating their reference after
     * `write()` returns can't change what observers see.
     */
    fun write(value: T) {
        synchronized(writeLock) {
            try {
                val text = json.encodeToString(serializer, value)
                tmpFile.writeText(text)
                // BAT-512 (Copilot review fix): use NIO `Files.move`
                // with REPLACE_EXISTING + ATOMIC_MOVE so the rename is
                // atomic AT THE FILESYSTEM LEVEL even when the
                // destination already exists. The earlier delete +
                // renameTo fallback opened a window in which
                // FileObserver fired DELETE, the corresponding reload
                // landed `initial` in `_state`, and only the
                // subsequent CREATE/MOVED_TO restored the correct
                // value — observers briefly saw garbage.
                //
                // ATOMIC_MOVE + REPLACE_EXISTING is supported on the
                // filesystems Android uses (ext4, F2FS). Min SDK 34 so
                // java.nio.file is available. AtomicMoveNotSupported
                // can occur on cross-device moves only, which doesn't
                // happen here (both files are under filesDir on the
                // same partition); we still degrade gracefully if it
                // does.
                try {
                    java.nio.file.Files.move(
                        tmpFile.toPath(),
                        file.toPath(),
                        java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                        java.nio.file.StandardCopyOption.ATOMIC_MOVE,
                    )
                } catch (_: java.nio.file.AtomicMoveNotSupportedException) {
                    // Fall back to non-atomic REPLACE_EXISTING — still
                    // single-syscall (no DELETE event), just not
                    // strictly atomic if the kernel decides otherwise.
                    java.nio.file.Files.move(
                        tmpFile.toPath(),
                        file.toPath(),
                        java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                    )
                }
                // BAT-512 (Copilot review fix #4 round-4): clone before
                // publishing so a caller mutating their `value`
                // reference after this returns cannot mutate what
                // StateFlow observers see. Symmetric with read()'s
                // cloneSafe(initial). See class-level "Mutation
                // safety" KDoc.
                _state.value = cloneSafe(value)
                broadcastChanged()
            } catch (e: Exception) {
                Log.e(TAG, "[$fileName] write failed: ${e.message}", e)
            } finally {
                // Defensive: clean up a leftover .tmp on the failure path
                // so we don't accumulate cruft. No-op when the move
                // succeeded (the source inode is gone).
                if (tmpFile.exists()) tmpFile.delete()
            }
        }
    }

    /**
     * Re-read the file from disk and update [state]. Called from the
     * single drain coroutine (which receives signals from the
     * FileObserver and broadcast receiver) — public so tests and
     * pull-style consumers can force a refresh.
     *
     * BAT-512 (Copilot review fix #1): no-op when the store is
     * [closed] so a coroutine in flight on a caller-owned scope
     * (which we don't cancel) can't publish a value after close().
     */
    fun reload() {
        if (closed.get()) return
        _state.value = read()
    }

    private fun broadcastChanged() {
        try {
            val intent = Intent(ACTION_STORE_CHANGED)
                .setPackage(appContext.packageName)
                .putExtra(EXTRA_FILE_NAME, fileName)
            appContext.sendBroadcast(intent)
        } catch (e: Exception) {
            // Broadcast failure is non-fatal — FileObserver in the other
            // process will still pick up the file change.
            Log.w(TAG, "[$fileName] broadcast failed: ${e.message}")
        }
    }

    private fun startWatching() {
        attachFileObserver()
        registerBroadcastReceiver()
    }

    private fun attachFileObserver() {
        val parent = file.parentFile ?: run {
            Log.w(TAG, "[$fileName] no parent dir; FileObserver skipped")
            return
        }
        // Same FileObserver pattern LogCollector / ServiceState use post-
        // BAT-518: watch the parent dir, filter by basename in onEvent.
        // Mask covers every way the file can change in this codebase:
        //   - MODIFY / CLOSE_WRITE for the .tmp `writeText` step
        //   - MOVED_TO for the `Files.move(..., ATOMIC_MOVE)` step
        //     (and for atomic .tmp+rename writes from Node)
        //   - CREATE for first-time creation
        //   - DELETE for removal (e.g. user-initiated wipe)
        fileObserver = object : FileObserver(
            parent,
            FileObserver.MODIFY or FileObserver.CLOSE_WRITE or
                FileObserver.MOVED_TO or FileObserver.CREATE or
                FileObserver.DELETE,
        ) {
            override fun onEvent(event: Int, path: String?) {
                // path is the basename for file-level events, null for
                // directory-level events (also the only signal we get
                // for inotify queue overflow). Reload on either.
                val basename = path?.substringAfterLast('/')
                if (basename == null || basename == fileName) {
                    // BAT-512 (Copilot review fix #2+3): coalesce via
                    // CONFLATED channel — one drain coroutine handles
                    // all events sequentially, no out-of-order
                    // publication risk. trySend never fails for a
                    // CONFLATED channel and is non-blocking on the
                    // FileObserver thread.
                    if (!closed.get()) reloadChannel.trySend(Unit)
                }
            }
        }.also { it.startWatching() }
    }

    private fun registerBroadcastReceiver() {
        val r = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                if (intent.action != ACTION_STORE_CHANGED) return
                val name = intent.getStringExtra(EXTRA_FILE_NAME)
                if (name == fileName) {
                    // BAT-512 (Copilot review fix #2+3): same
                    // CONFLATED-channel coalescing as the
                    // FileObserver path — single drain serializes
                    // reloads across BOTH trigger sources, so two
                    // simultaneous events (file event + broadcast
                    // for the same write) don't race.
                    if (!closed.get()) reloadChannel.trySend(Unit)
                }
            }
        }
        ContextCompat.registerReceiver(
            appContext,
            r,
            IntentFilter(ACTION_STORE_CHANGED),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        receiver = r
    }

    /**
     * Release the FileObserver, broadcast receiver, and any in-flight
     * reload work owned by this store. Production stores live for
     * the process lifetime — calling [close] is only meaningful for
     * tests or hot-swap scenarios. Idempotent.
     *
     * Behaviour by scope ownership (BAT-512 Copilot review fixes #1, #7):
     *
     *  - **Owned scope** (no `parentScope` passed to the constructor):
     *    we own the [SupervisorJob] inside [coroutineScope] and
     *    cancel it here, so the drain coroutine + any pending reload
     *    work stop cleanly.
     *  - **External scope** (`parentScope` passed in): we do NOT
     *    cancel the caller's scope — they own its lifecycle. A
     *    reload coroutine that was already in flight on that scope
     *    can still execute, but it bails out of [reload] via the
     *    `closed` flag check before mutating `_state`. Same for the
     *    drain coroutine: the `closed` check inside its for-loop
     *    body causes it to exit on the next signal.
     *
     * The FileObserver and BroadcastReceiver are released
     * unconditionally — neither depends on scope ownership.
     */
    fun close() {
        // Set closed FIRST so any in-flight reload that wakes up
        // post-close immediately bails out instead of publishing a
        // stale value.
        closed.set(true)
        // Stop accepting new reload signals; already-queued ones
        // (max one for CONFLATED) drain into the for-loop's closed
        // check and exit.
        reloadChannel.close()
        fileObserver?.stopWatching()
        fileObserver = null
        receiver?.let {
            try {
                appContext.unregisterReceiver(it)
            } catch (_: Exception) {
                // Already unregistered, or never registered (test paths).
            }
        }
        receiver = null
        ownedJob?.cancel()
    }

    companion object {
        private const val TAG = "CrossProcessStore"

        /**
         * Package-scoped broadcast action used as the fast path for
         * Kotlin-side cross-process notification. Receivers must filter
         * on [EXTRA_FILE_NAME] so a single-store reload doesn't trigger
         * unrelated stores.
         */
        const val ACTION_STORE_CHANGED = "com.seekerclaw.app.action.CROSS_PROCESS_STORE_CHANGED"

        /** Intent extra carrying the basename of the changed store file. */
        const val EXTRA_FILE_NAME = "fileName"

        /**
         * BAT-512 (Copilot review fix #2): the same basename rule
         * `init {}` enforces, exposed as a pure function so tests can
         * target it without a Context. Returns true if [fileName] is a
         * non-empty basename safe to resolve under `filesDir`.
         */
        @JvmStatic
        fun isValidFileName(fileName: String): Boolean {
            if (fileName.isEmpty()) return false
            if (fileName != File(fileName).name) return false
            if (fileName.contains("..")) return false
            if (fileName.contains('/') || fileName.contains('\\')) return false
            return true
        }
    }
}
