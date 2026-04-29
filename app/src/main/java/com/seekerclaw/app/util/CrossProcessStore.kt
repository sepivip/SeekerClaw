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
 * The store treats T as a value type. T is JSON-cloned at every
 * boundary where it crosses between caller and store, so neither
 * side can poison the other through a shared reference:
 *
 *  - **Constructor input** (`initial` parameter): cloned once into
 *    `initialSnapshot` at construction. The caller's original
 *    reference goes out of scope. Subsequent caller mutations to
 *    that original reference can't change what missing/malformed
 *    [read] calls return.
 *  - **Caller mutates after `write()`**: the store's internal
 *    `_state` + StateFlow observers see the snapshot the caller
 *    intended at write-time, not whatever the caller's reference
 *    morphs into afterward. Without this, observers could see
 *    "writes" that were never persisted to disk and that diverge
 *    from what [read] returns.
 *  - **Caller mutates after `read()`**: the store's
 *    `initialSnapshot` and StateFlow backing field are unaffected.
 *    Without this, a mutable T (a class with var properties, or a
 *    MutableMap) could let caller-side mutation poison the store.
 *
 * The clone is JSON encode/decode round-trip — cheap on small
 * `@Serializable` data classes (the only realistic T for this store)
 * and produces a fresh object graph with no shared references. The
 * Node parity helper (`cross-process-store.js`) implements the same
 * three-boundary contract via `JSON.parse(JSON.stringify(value))`.
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
class CrossProcessStore<T> private constructor(
    private val filesDirRoot: File,
    // Null in the test-only constructor: skips FileObserver attach,
    // BroadcastReceiver register, and broadcastChanged. The store is
    // still fully functional for read/write/update/reload — exactly
    // what JVM tests need to drive the production update() under
    // contention without an Android Context (BAT-513 round-19).
    private val appContext: Context?,
    private val fileName: String,
    private val serializer: KSerializer<T>,
    initial: T,
    parentScope: CoroutineScope?,
) {
    /**
     * Production constructor. Pins to `applicationContext` so an
     * Activity/Service Context passed in by mistake can't leak the
     * BroadcastReceiver/FileObserver for the lifetime of that
     * component (BAT-512 review fix #6).
     */
    constructor(
        context: Context,
        fileName: String,
        serializer: KSerializer<T>,
        initial: T,
        parentScope: CoroutineScope? = null,
    ) : this(
        filesDirRoot = context.applicationContext.filesDir,
        appContext = context.applicationContext,
        fileName = fileName,
        serializer = serializer,
        initial = initial,
        parentScope = parentScope,
    )

    /**
     * Test-only constructor (BAT-513 round-19). Bypasses the Android
     * wiring (FileObserver + BroadcastReceiver + sendBroadcast) so
     * JVM unit tests can drive the production [read] / [write] /
     * [update] / [reload] methods against a real tmp filesDir
     * without instantiating Robolectric or running on a device.
     * Cross-process notification paths aren't exercised by tests
     * built with this constructor — those are validated separately
     * by device tests.
     */
    @androidx.annotation.VisibleForTesting
    internal constructor(
        filesDir: File,
        fileName: String,
        serializer: KSerializer<T>,
        initial: T,
        parentScope: CoroutineScope? = null,
    ) : this(
        filesDirRoot = filesDir,
        appContext = null,
        fileName = fileName,
        serializer = serializer,
        initial = initial,
        parentScope = parentScope,
    )

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

    private val file: File = File(filesDirRoot, fileName)
    private val tmpFile: File = File(filesDirRoot, "$fileName.tmp")
    // BAT-513 round-13: writeLock now also serves as the read-modify-write
    // serialization point for [update]. The earlier design used a separate
    // kotlinx Mutex for update, which protected update-vs-update but
    // missed update-vs-write: a `write()` from another thread could fire
    // between [update]'s `read()` and `write(next)` and the update would
    // overwrite it. By taking the same `synchronized(writeLock)` for the
    // entire RMW, update is now atomic w.r.t. concurrent `write()` too.
    // synchronized is reentrant on the JVM, so update's nested call to
    // write() (which also takes writeLock) is fine.
    private val writeLock = Any()

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    // BAT-512 (Copilot review fix round-5): snapshot the caller's
    // `initial` reference ONCE at construction so a caller mutating
    // their original `initial` object after `CrossProcessStore(...)`
    // returns can't change what subsequent missing/malformed reads
    // produce. The constructor parameter `initial` is non-stored
    // (no `private val`), so the original reference goes out of scope
    // after this snapshot — there's no way to reach it from inside
    // the class anymore. Declared after `json` because cloneSafe
    // depends on it.
    private val initialSnapshot: T = cloneSafe(initial)

    // Initialize _state with a fresh clone of the snapshot so an
    // external mutation of `_state.value` (theoretical — StateFlow
    // observers shouldn't mutate published values, but the type
    // system doesn't enforce that for mutable T) can't poison the
    // snapshot we'll keep returning from read() forever.
    private val _state = MutableStateFlow(cloneSafe(initialSnapshot))

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
    // all valid here. Starts the drain coroutine, attaches observers,
    // and dispatches the initial catch-up read.
    init {
        // BAT-512 (Copilot review fix round-6): defer the initial
        // catch-up read to coroutineScope (Dispatchers.IO) instead
        // of calling reload() synchronously on the caller thread.
        // BAT-513 onward will construct this store from
        // SeekerClawApplication.onCreate (main thread); blocking
        // disk I/O in the constructor would trip StrictMode and add
        // startup jank. Same pattern LogCollector / ServiceState
        // adopted post-BAT-518. Trade-off: `state.value` briefly
        // holds `initialSnapshot` before the async hydrate lands —
        // typically a few ms. Observers see eventual consistency.
        coroutineScope.launch { reload() }
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
     * and side-effect-free. Returns a freshly cloned copy of the
     * construction-time `initialSnapshot` (which itself was a clone of
     * the constructor's `initial` argument) on missing file or
     * malformed JSON (logged at WARN — never throws).
     *
     * BAT-512 (Copilot review fixes #4 + round-5): the returned value
     * goes through `cloneSafe(initialSnapshot)` on missing/malformed
     * paths, which JSON-round-trips a fresh instance off the
     * construction-time snapshot — see "Mutation safety" in the
     * class KDoc. Without this, a mutable T (e.g. a class with
     * mutable fields, or a pre-Kotlin data type with var properties)
     * could let a caller's accidental mutation poison the store's
     * default and the StateFlow's backing field. The Node helper has
     * the same defensive clone. Edge case: if the JSON round-trip
     * itself throws (only possible for a misconfigured `@Serializable`
     * type — the live cases this store targets are all valid), we
     * fall back to returning the un-cloned snapshot reference and log
     * a WARN; in that scenario the caller MUST treat T as immutable.
     */
    fun read(): T {
        if (!file.exists()) return cloneSafe(initialSnapshot)
        return try {
            json.decodeFromString(serializer, file.readText())
        } catch (e: Exception) {
            Log.w(TAG, "[$fileName] decode failed, returning initial: ${e.message}")
            cloneSafe(initialSnapshot)
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
     * Returns `true` IFF the file was persisted AND [_state] published
     * the new value. Returns `false` on a caught failure (full FS,
     * permission, IO error, encode failure) — callers translate this
     * into user-visible feedback (toast / snackbar / Telegram reply);
     * the store itself never throws so a hot path can't be killed by
     * a transient FS error. The failure is also logged at ERROR.
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
    fun write(value: T): Boolean {
        // BAT-512 (Copilot review fix round-7): clone `value` ONCE
        // up-front into a stable snapshot, then derive both the
        // serialized text and the `_state` update from that snapshot.
        // Without this, the disk encode and the _state.value clone
        // each see whatever `value` looks like at their respective
        // moment — if a caller mutates `value` from another thread
        // mid-write, disk and `_state` could publish different
        // snapshots. Cloning once also avoids the extra encode/decode
        // round-trip cloneSafe used to do for the in-memory copy.
        val snapshot: T = cloneSafe(value)
        // BAT-512 (Copilot review fix round-6) + BAT-513 round-18:
        // broadcast OUTSIDE the critical section. sendBroadcast is a
        // system IPC that can block briefly; holding writeLock across
        // it amplifies contention for concurrent writers without
        // protecting any additional invariant. This now goes through
        // [persistLocked] which both [write] and [update] share, so
        // both paths broadcast outside their own synchronized block.
        val didWrite = synchronized(writeLock) { persistLocked(snapshot) }
        if (didWrite) broadcastChanged()
        return didWrite
    }

    /**
     * Persist [snapshot] to disk and publish to [_state]. CALLER
     * holds `synchronized(writeLock)` — either [write]'s direct
     * synchronized block, or [update]'s outer block (reentrant on
     * the same monitor). The caller is also responsible for
     * broadcasting AFTER releasing the lock; this helper returns
     * `true` iff the caller should broadcast.
     *
     * Extracted in BAT-513 round-18 to share the locked-persist
     * logic between write and update without duplication AND so
     * update can drop the lock before broadcasting (round-18 review
     * caught update holding writeLock across the broadcast).
     *
     * The lock-required precondition isn't enforceable in the
     * Kotlin/JVM type system; documented here and structurally
     * obvious from call sites. Both call sites keep the
     * synchronized block tight to just this call.
     */
    private fun persistLocked(snapshot: T): Boolean {
        return try {
            val text = json.encodeToString(serializer, snapshot)
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
            // BAT-512 (Copilot review fix #4 round-4 + round-7):
            // publish the same snapshot we just wrote to disk. A
            // caller mutating their `value` reference after this
            // returns cannot mutate what StateFlow observers see
            // (because `snapshot` was cloned at write/update entry
            // and is no longer reachable from the caller). disk +
            // _state are guaranteed to publish the SAME snapshot.
            _state.value = snapshot
            true
        } catch (e: Exception) {
            Log.e(TAG, "[$fileName] write failed: ${e.message}", e)
            false
        } finally {
            // Defensive: clean up a leftover .tmp on the failure path
            // so we don't accumulate cruft. No-op when the move
            // succeeded (the source inode is gone).
            if (tmpFile.exists()) tmpFile.delete()
        }
    }

    /**
     * Read-modify-write under the same `synchronized(writeLock)` that
     * [write] uses, so the entire `read → transform → persistLocked`
     * sequence is atomic w.r.t. BOTH concurrent `update {}` calls AND
     * concurrent `write()` calls in the same process. A pre-round-13
     * design used a separate kotlinx Mutex; that protected
     * update-vs-update but missed update-vs-write — a `write()` could
     * fire between this `read()` and `write(next)` and the update
     * would overwrite it.
     *
     * Round 18 split the persistence into [persistLocked] so update
     * could broadcast OUTSIDE the lock (write's broadcast was already
     * outside ITS synchronized block, but with update calling write
     * inside its outer synchronized, the broadcast was still under
     * update's lock). update now does read+transform+persistLocked
     * directly, then drops the lock before [broadcastChanged].
     *
     * Returns the [persistLocked] result — `true` if the transformed
     * value persisted, `false` on caught FS failure.
     *
     * The [transform] callback is invoked under the lock with the
     * current persisted value (a fresh deserialized instance from
     * [read]) and must return the value to persist. Keep transforms
     * cheap and pure — the lock is held for the duration of the call,
     * and `synchronized` blocks the OS thread (no suspension allowed
     * inside).
     *
     * Cross-process `update` is still last-writer-wins per filesystem
     * move semantics; this lock is same-process only. No caller in
     * the BAT-511 family needs cross-process RMW.
     *
     * Declared `suspend` for forward compatibility — callers may
     * eventually want to invoke this from coroutine contexts that
     * could later add per-call work (e.g. metrics, tracing) before
     * the lock acquisition. The current body has no real suspension
     * points.
     */
    suspend fun update(transform: (T) -> T): Boolean {
        // BAT-513 round-18: broadcast OUTSIDE the synchronized block.
        // The pre-round-18 design called write() directly inside the
        // synchronized block, but write()'s own broadcast happened
        // outside ITS synchronized block — yet still INSIDE update's
        // outer synchronized block (reentrant monitor). That meant
        // sendBroadcast() ran while update held writeLock, blocking
        // other writers/updates on a slow IPC path.
        //
        // Fix: do the read + transform + persist inside the lock via
        // [persistLocked] (sharing the same locked-persist logic with
        // [write]). Drop the lock, then broadcast.
        val didWrite = synchronized(writeLock) {
            val current = read()
            val next = transform(current)
            val snapshot: T = cloneSafe(next)
            persistLocked(snapshot)
        }
        if (didWrite) broadcastChanged()
        return didWrite
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
     *
     * BAT-513 round-20: read+publish is wrapped in
     * `synchronized(writeLock)` to prevent a write-vs-reload race.
     * Without the lock, a reload that started its `read()` BEFORE a
     * concurrent `write()` completed could publish the stale value
     * to `_state.value` AFTER the write — regressing in-memory
     * state. With the lock, reload either completes entirely before
     * write begins (publishing whatever the file held at that
     * moment, then write supersedes), or starts AFTER write
     * released (reading the new value, publishing the same — no-op).
     * State can never end at a value older than the latest
     * successful write.
     */
    fun reload() {
        if (closed.get()) return
        synchronized(writeLock) {
            _state.value = read()
        }
    }

    private fun broadcastChanged() {
        // Test-only constructor leaves appContext null — skip the
        // broadcast cleanly. Same-process StateFlow observers still
        // see the update via _state.value emission inside
        // persistLocked; only cross-process notification is skipped.
        val ctx = appContext ?: return
        try {
            val intent = Intent(ACTION_STORE_CHANGED)
                .setPackage(ctx.packageName)
                .putExtra(EXTRA_FILE_NAME, fileName)
            ctx.sendBroadcast(intent)
        } catch (e: Exception) {
            // Broadcast failure is non-fatal — FileObserver in the other
            // process will still pick up the file change.
            Log.w(TAG, "[$fileName] broadcast failed: ${e.message}")
        }
    }

    private fun startWatching() {
        // Test-only constructor (appContext == null) skips the Android
        // wiring entirely — JVM tests don't have a Looper for FileObserver
        // and the broadcast receiver registration would NPE without a
        // real Context. Same-process behaviour (StateFlow updates from
        // local writes) is unaffected.
        if (appContext == null) return
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
        // The mask is on the parent dir; the OS delivers events for
        // EVERY file in that dir. onEvent below filters by basename
        // so only events on `fileName` itself trigger reload — events
        // on the sibling `<fileName>.tmp` are ignored. The mask
        // therefore needs to cover every way `fileName` can change:
        //   - MOVED_TO is the primary trigger: both Kotlin's
        //     `Files.move(.tmp → fileName, REPLACE_EXISTING,
        //     ATOMIC_MOVE)` and Node's `fs.renameSync(.tmp, fileName)`
        //     deliver MOVED_TO on the destination basename.
        //   - CREATE fires when fileName is created for the first
        //     time (no prior file existed at this path).
        //   - DELETE fires when fileName is removed (e.g. user-
        //     initiated wipe).
        //   - MODIFY / CLOSE_WRITE are defensive: they cover any
        //     hypothetical writer that bypasses the tmp+rename
        //     contract and writes directly to fileName. Current
        //     callers all use atomic move, so these fire on `.tmp`
        //     in practice and onEvent filters them out — keeping
        //     them in the mask costs nothing and guards against
        //     future direct-write callers.
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
        // appContext is non-null here — registerBroadcastReceiver is
        // only called from startWatching(), which already returns early
        // for the test-only (appContext == null) constructor.
        val ctx = appContext ?: return
        ContextCompat.registerReceiver(
            ctx,
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
            // appContext is null in the test-only constructor where the
            // receiver was never registered — receiver is itself null
            // there too, so this whole block is unreachable in that
            // path. Guard the unregister anyway so a future maintainer
            // can't trip an NPE by adding a register call without a
            // context.
            val ctx = appContext
            if (ctx != null) {
                try {
                    ctx.unregisterReceiver(it)
                } catch (_: Exception) {
                    // Already unregistered, or never registered (test paths).
                }
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
