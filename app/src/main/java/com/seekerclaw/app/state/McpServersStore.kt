package com.seekerclaw.app.state

import android.content.Context
import android.util.Base64
import android.util.Log
import com.seekerclaw.app.bridge.NodeControlClient
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.config.KeystoreHelper
import com.seekerclaw.app.config.McpServerConfig
import com.seekerclaw.app.util.CrossProcessStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Cross-process MCP server config store (BAT-514).
 *
 * Mirrors [RuntimeStateStore]'s shape — a [CrossProcessStore]-backed
 * file (`mcp_servers.json`) wrapped with a validity gate, a rollback
 * shadow mirror to legacy [android.content.SharedPreferences], a
 * UI-safe StateFlow, AND token I/O wrappers that delegate to the
 * stateless [McpTokenStore].
 *
 * ## Field split (file vs. encrypted-token files)
 *
 *  - **File:** id, name, url, enabled, rateLimit. Plaintext JSON, safe
 *    for cross-process file IPC.
 *  - **Encrypted token files:** authToken per server in
 *    `filesDir/mcp_tokens/<id>`. Encrypted via [KeystoreHelper]
 *    AES-GCM. Read on every connect by the Node side via
 *    AndroidBridge `POST /config/mcp-token`. Backing storage is
 *    file-per-token so cross-process token edits propagate live —
 *    SharedPreferences would have a per-process cache that
 *    invalidates the BAT-514 live-edit contract (see
 *    [McpTokenStore]'s class doc).
 *
 * Tokens DO get reattached when reconstructing the legacy
 * `KEY_MCP_SERVERS_ENC` rollback shadow (BAT-514 v2 §2): pre-BAT-514
 * builds expect the token in each server entry, so a downgrade after
 * a token edit shouldn't lose it.
 *
 * ## Validity gate (UI-write fail-fast vs. observed-file drop-defensively)
 *
 * v2.1 §5 differentiates:
 *
 *  - [write] / [update] (the UI write boundary) returns `false` on the
 *    first invalid entry. The UI sees this and rebinds to last-valid
 *    via [state] (Toast + revert). NOT silent drop — a server the user
 *    just typed should never disappear without explanation.
 *  - The collector [observeFromCollector] running against the underlying
 *    [CrossProcessStore] DROPS individual invalid entries with a WARN
 *    log. A corrupt file from a manual edit / partial write loses only
 *    the bad entries; the rest stay usable.
 *
 * Both paths share [isValid] / [reasonFor] for predicate parity.
 *
 * ## Reconcile dispatch (Kotlin → Node)
 *
 * Every successful mutation (file write OR token write OR token clear)
 * fires `NodeControlClient.reconcile(id?)` best-effort. The Node side
 * runs an internal HTTP server on `127.0.0.1:8766` (the existing stats
 * server, extended to host `/mcp/reconcile` and `/healthz` in BAT-514).
 * If the service is stopped (port not bound), the reconcile call
 * returns false — that's fine, the next service start reads the file
 * fresh. See [NodeControlClient].
 */
object McpServersStore {
    private const val TAG = "McpServersStore"
    private const val FILE_NAME = "mcp_servers.json"
    private const val PREFS_NAME = "seekerclaw_prefs"
    private const val KEY_MCP_SERVERS_ENC = "mcp_servers_enc"

    /**
     * MCP server `id` must match this regex AND be unique after
     * `safeId` normalization (the Node side replaces
     * `[^A-Za-z0-9_-]` with `_`, so `-` is preserved). Because the
     * regex's allowed alphabet is exactly the set Node's `safeId`
     * leaves untouched, the post-normalization uniqueness check is
     * identity for any in-spec id — kept as defense-in-depth in case
     * the regex is ever loosened to allow characters Node would fold
     * (e.g. `.`, which `safeId` would map to `_`).
     */
    private val ID_REGEX = Regex("^[A-Za-z0-9_-]+$")

    private val initialized = AtomicBoolean(false)
    private val _state = MutableStateFlow<List<McpServer>>(emptyList())
    private var appContext: Context? = null

    /**
     * Last valid server list observed. UI binds here; invalid file
     * content (corrupt entry, manual edit) is filtered out so the UI
     * never displays a bad server.
     */
    val state: StateFlow<List<McpServer>> = _state.asStateFlow()

    /**
     * `true` once [init] has wired up the cross-process store. Mirrors
     * [RuntimeStateStore.isInitialized] — gates main-process-only
     * mutation paths so a `:node`-side caller (which never calls
     * [init]) can't trip an NPE on [store].
     */
    val isInitialized: Boolean get() = store != null

    private var ownedScope: CoroutineScope? = null
    private var store: CrossProcessStore<McpServersFile>? = null

    /**
     * Idempotent. Call once from `SeekerClawApplication.onCreate`.
     *
     * The body of this function does NO disk I/O — it only allocates
     * the owned IO scope. CrossProcessStore creation itself is
     * deferred to the IO scope so the legacy load can complete first
     * and seed the store's `initial` value (preserving the legacy
     * view if migration aborts). All work that touches disk or
     * Keystore runs inside the launched coroutine below, so this
     * call is safe to invoke from `Application.onCreate` on the
     * main thread.
     *
     * Ordering inside the IO coroutine:
     *
     *  1. If `mcp_servers.json` is missing: read legacy
     *     [KEY_MCP_SERVERS_ENC] prefs (Keystore decrypt + JSON
     *     parse), then encrypt each token to `mcp_tokens/<id>`. If
     *     ANY token write fails, abort: leave `KEY_MCP_SERVERS_ENC`
     *     intact, leave `_state` showing the legacy view, and
     *     return without creating [store] (UI writes return false
     *     until the user restarts). Steady-state launches (file
     *     exists) skip step 1 entirely.
     *  2. Construct [CrossProcessStore] with `initial = seeded` so
     *     `cps.read()` returns the legacy view if the file write
     *     below fails.
     *  3. Migration write of cleaned list + rollback shadow (only
     *     when the file was missing).
     *  4. Sweep orphan tokens: any `mcp_tokens/<id>` file whose id
     *     isn't in the current server list is cleared.
     *  5. Start the observe-and-mirror collector.
     */
    fun init(context: Context) {
        if (!initialized.compareAndSet(false, true)) return
        val app = context.applicationContext
        appContext = app

        // Caller is `SeekerClawApplication.onCreate` (main thread).
        // The legacy `ConfigManager.loadMcpServers` does Keystore
        // decrypt + JSON parse — slow enough to trip StrictMode and
        // add startup jank. Defer EVERYTHING that touches disk or
        // Keystore to the owned IO scope below. UI binds to `state`
        // which starts empty for a few ms while the catch-up reload
        // runs (steady state) or while the legacy load + migration
        // runs (upgrade path). (Copilot R12 PR #352 finding.)
        //
        // CrossProcessStore creation is also deferred — we want to
        // pass the legacy-seeded list as `initial` so a migration
        // abort (token write failure or file write failure) leaves
        // `cps.read()` returning the legacy view instead of an empty
        // list (Copilot R13 finding 1+2: an empty `initial` would
        // both clobber `_state` via the collector AND make the
        // orphan sweep clear all newly-written token files).
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        ownedScope = scope

        scope.launch {
            // Step 1: migration check + legacy load — only when the
            // file is missing. Steady-state launches (file exists)
            // skip the Keystore decrypt entirely; CrossProcessStore's
            // own catch-up reload populates `cps._state` from the
            // file, and the collector below mirrors that into our
            // `_state`. Run the raw legacy list through `onObserved`
            // so it gets the SAME treatment file-observed content
            // does: invalid entries dropped, name/url trimmed,
            // duplicates collapsed by id. Without this pass, a
            // corrupt legacy KEY_MCP_SERVERS_ENC (e.g. duplicate ids
            // from a buggy old write path, or whitespace-padded URLs
            // from a manual edit) would briefly publish to `_state`
            // AND get persisted into the migrated file (Copilot R6/R7).
            val file = File(app.filesDir, FILE_NAME)
            val needsMigration = !file.exists()
            var seeded: List<McpServer> = emptyList()
            if (needsMigration) {
                val legacy = ConfigManager.loadMcpServers(app)
                val rawSeed = legacy.map { it.toMcpServer() }
                // onObserved cleans + sets `_state.value` so the UI's
                // collectAsState binding sees the legacy view
                // immediately while migration finishes.
                seeded = onObserved(McpServersFile(servers = rawSeed))
                // Encrypt every legacy token into per-id token files
                // (`filesDir/mcp_tokens/<id>`) FIRST.
                // If ANY token write fails (Keystore error, prefs
                // commit failure), abort migration: don't seed the
                // file, don't rebuild the rollback shadow, and don't
                // even create the CrossProcessStore. Reasoning:
                //   - The legacy KEY_MCP_SERVERS_ENC blob is still
                //     intact and contains the tokens. Pre-BAT-514
                //     code (and this build's `loadMcpServers`) can
                //     still read it.
                //   - If we proceeded, `rebuildRollbackShadow` would
                //     read `""` for the failed entry from
                //     `McpTokenStore.read` and overwrite
                //     `KEY_MCP_SERVERS_ENC` with a tokenless copy —
                //     silently losing the token on downgrade AND
                //     breaking next-launch's Node-side connect.
                //   - Aborting leaves `mcp_servers.json` absent, so
                //     next launch retries the whole migration. UI
                //     writes via `McpServersStore.write` return false
                //     in the meantime (store is null) and surface
                //     the existing Toast — the user gets a clear
                //     "save failed" signal and the workflow is to
                //     restart.
                var allTokensOk = true
                for (s in legacy) {
                    if (s.authToken.isNotBlank()) {
                        if (!McpTokenStore.write(app, s.id, s.authToken)) {
                            allTokensOk = false
                            Log.w(
                                TAG,
                                "Migration token write failed for id=${s.id}; " +
                                    "aborting migration to keep KEY_MCP_SERVERS_ENC intact",
                            )
                        }
                    }
                }
                if (!allTokensOk) {
                    // Don't create the store. Don't start the
                    // collector. Don't run the orphan sweep —
                    // `cps.read()` would be `[]` and would clear
                    // every token file we just successfully wrote
                    // (Copilot R13 finding 2). _state retains the
                    // legacy view from `onObserved` above so the UI
                    // remains usable until the user restarts.
                    return@launch
                }
            }

            // Step 2: construct the CrossProcessStore. `initial` is
            // the seeded legacy view (when migration just ran) or
            // `emptyList()` (when file already existed). On a
            // file-missing read, cps.read() returns `cloneSafe(initial)`,
            // so post-migration the legacy view is still visible
            // even if the file write below fails.
            val cps = CrossProcessStore(
                context = app,
                fileName = FILE_NAME,
                serializer = McpServersFile.serializer(),
                initial = McpServersFile(servers = seeded),
                parentScope = scope,
            )
            store = cps

            // Step 3: migration write (if needed). Token files are
            // already on disk from step 1, so a file-write failure
            // here doesn't lose tokens — next launch sees the file
            // still missing and retries the file seed (token writes
            // are idempotent: McpTokenStore.write overwrites).
            if (needsMigration) {
                if (cps.write(McpServersFile(servers = seeded))) {
                    rebuildRollbackShadow(app, seeded)
                } else {
                    Log.w(
                        TAG,
                        "first-launch migration write to $FILE_NAME failed — " +
                            "tokens already persisted; next save retries the file write",
                    )
                }
            }

            // Step 4: orphan token sweep against the on-disk file —
            // NOT `_state.value`. `_state` may not have observed the
            // CrossProcessStore catch-up reload yet at this point,
            // and on the upgrade path it briefly held the legacy
            // view from the migration block above. Sweeping by an
            // out-of-sync view would clear `mcp_tokens/<id>` files
            // for servers that ARE in the file. (Copilot R3 PR #352
            // finding.)
            sweepOrphanTokens(app, cps.read().servers)

            // Step 5: observe-and-mirror collector.
            cps.state.collect { observed ->
                observeFromCollector(observed)
            }
        }
    }

    /**
     * Returns the last valid server list (the same value [state] exposes).
     */
    fun read(): List<McpServer> = _state.value

    /**
     * Persist [servers] atomically.
     *
     * Returns `false` (without persisting) on:
     *  - [init] not yet called (main-process gate)
     *  - any entry fails [isValid]
     *  - duplicate id after `safeId` normalization
     *  - any entry has `http://non-loopback` URL with a non-empty
     *    auth token in [McpTokenStore] (insecure bearer-over-HTTP)
     *  - underlying [CrossProcessStore.write] failure
     *
     * On success: rebuilds the rollback shadow (with tokens reattached)
     * AND fires a best-effort `reconcile(null)` to `:node`.
     */
    fun write(servers: List<McpServer>): Boolean {
        val app = appContext ?: return false
        val s = store ?: return false
        // Defensive copy so caller-side mutation can't poison the
        // validation/persist pipeline.
        val list = servers.toList()
        val invalid = list.firstOrNull { !isValid(it) }
        if (invalid != null) {
            Log.w(TAG, "rejected write: invalid server id=${invalid.id} reason=${reasonFor(invalid)}")
            return false
        }
        val normalizedSeen = mutableSetOf<String>()
        for (entry in list) {
            val normalized = normalizeId(entry.id)
            if (!normalizedSeen.add(normalized)) {
                Log.w(
                    TAG,
                    "rejected write: duplicate id after normalization: ${entry.id} (normalizes to $normalized)",
                )
                return false
            }
        }
        // Bearer-over-insecure-HTTP gate (v2.1 §5b). Mirrors
        // mcp-client.js's URL-vs-token check so the same rule fails
        // fast at write-time rather than only when Node tries to
        // connect.
        for (entry in list) {
            if (hasInsecureToken(app, entry)) {
                Log.w(
                    TAG,
                    "rejected write: ${entry.id} has token over insecure HTTP (use HTTPS or loopback)",
                )
                return false
            }
        }
        // Snapshot the disk's current servers BEFORE persisting, so
        // the orphan-token cleanup diff is accurate even when our
        // collector hasn't caught up to a recent prior write.
        // Reading `_state.value` here would observe collector lag —
        // by contrast, `s.read()` parses the JSON file synchronously
        // (CrossProcessStore.write uses atomic move, so the read is
        // never half-written). Best-effort against TOCTOU: another
        // process writing between this read and the write below
        // would race, but the orphan sweep at next `init()` catches
        // any drift, and main-process writes from here serialize via
        // CrossProcessStore.writeLock anyway.
        val preIds = s.read().servers.map { it.id }.toSet()
        if (!s.write(McpServersFile(servers = list))) return false

        // Side effects after successful persist (kept out of the
        // CrossProcessStore lock per BAT-513 round-18 pattern).
        // Clear orphan tokens for removed servers BEFORE rebuilding
        // the rollback shadow — otherwise the shadow would still see
        // the orphan via McpTokenStore.read and reattach it.
        val nextIds = list.map { it.id }.toSet()
        for (id in preIds - nextIds) {
            McpTokenStore.clear(app, id)
        }
        rebuildRollbackShadow(app, list)
        ownedScope?.launch { NodeControlClient.reconcile(null) }
        return true
    }

    /**
     * Read current state, run [transform] EXACTLY once on it, validate
     * the result, then atomically write. Same last-writer-wins
     * semantics as [write] — a concurrent writer between the read and
     * the write supersedes (acceptable for BAT-514: the only writer
     * is the UI process; `:node` only reads `mcp_servers.json`).
     *
     * Returns `false` on init-not-called, validation failure, or
     * persist failure. Validation runs OUTSIDE the
     * [CrossProcessStore] writeLock so the slow Keystore decrypt for
     * the http+token check doesn't block other writers/observers
     * (Copilot R11). Calling [transform] only once avoids the
     * non-deterministic foot-gun of running caller-supplied code
     * twice with different inputs (Copilot R13).
     *
     * Use this for delta-style edits where the transform composes a
     * new list from the current one (`current.map { ... }`,
     * `current.filter { ... }`); use [write] for direct
     * replace-the-whole-list flows.
     */
    suspend fun update(transform: (List<McpServer>) -> List<McpServer>): Boolean {
        val app = appContext ?: return false
        val s = store ?: return false
        // Snapshot the current disk state, run the transform exactly
        // once, validate the result, then write. The snapshot is also
        // used downstream for the orphan-token diff so it stays
        // consistent with what we're about to persist.
        val current = s.read().servers
        val computed = transform(current).toList()

        // Validation — all checks run outside the lock. `isValid`,
        // dedup, normalization are cheap; `hasInsecureToken` does
        // file I/O + Keystore decrypt and would unacceptably hold the
        // writeLock if run inside the transform per
        // CrossProcessStore.update's "cheap and pure" contract.
        val invalid = computed.firstOrNull { !isValid(it) }
        if (invalid != null) {
            Log.w(TAG, "update rejected: invalid entry id=${invalid.id} reason=${reasonFor(invalid)}")
            return false
        }
        val seen = mutableSetOf<String>()
        for (entry in computed) {
            val n = normalizeId(entry.id)
            if (!seen.add(n)) {
                Log.w(
                    TAG,
                    "update rejected: duplicate id after normalization: ${entry.id} (normalizes to $n)",
                )
                return false
            }
        }
        if (computed.any { hasInsecureToken(app, it) }) {
            // MCPClient.connect's `_checkUrlSafety` is the actual
            // security boundary at request time; this store-level
            // check is defense-in-depth.
            Log.w(TAG, "update rejected: server has token over insecure HTTP")
            return false
        }

        if (!s.write(McpServersFile(servers = computed))) return false

        // Side effects (post-write, outside the lock — same pattern
        // as [write]). The pre/next diff uses the snapshots captured
        // above, NOT `_state.value`, so a lagging collector can't
        // make us miss orphan tokens.
        val nextIds = computed.map { it.id }.toSet()
        for (id in current.map { it.id }.toSet() - nextIds) {
            McpTokenStore.clear(app, id)
        }
        rebuildRollbackShadow(app, computed)
        ownedScope?.launch { NodeControlClient.reconcile(null) }
        return true
    }

    /**
     * Persist [token] for [id] (encrypted file at `mcp_tokens/<id>`)
     * and trigger reconcile.
     *
     * Returns `false` if [init] wasn't called, [id] doesn't match a
     * server in the list (token-without-server is meaningless), the
     * server's URL is `http://non-loopback` (insecure bearer reject),
     * or [McpTokenStore.write] / [McpTokenStore.clear] fails (Keystore
     * encrypt error, atomic move failure, or `File.delete` failure
     * for an existing entry). Returns `true` once the token change
     * has been written via [McpTokenStore]; any rollback shadow
     * update and the reconcile dispatch are best-effort, and their
     * outcomes don't change this return value.
     */
    fun setAuthToken(context: Context, id: String, token: String): Boolean {
        if (!isInitialized) return false
        val s = store ?: return false
        // Read from disk, not `_state.value`. The collector observes
        // file changes asynchronously, so `_state.value` may still
        // reflect the prior list for a few coroutine ticks after a
        // just-successful `write()`. The McpConfigScreen Save flow
        // does write() then setAuthToken() back-to-back for new
        // servers — validating against the lagging `_state.value`
        // would make that flow flake with "unknown server id".
        // `s.read()` parses the on-disk file synchronously
        // (CrossProcessStore.write uses atomic move, so the read is
        // never half-written). (Copilot R2 PR #352 finding.)
        val server = s.read().servers.firstOrNull { it.id == id }
        if (server == null) {
            Log.w(TAG, "setAuthToken rejected: unknown server id=$id")
            return false
        }
        if (token.isNotBlank() && !isUrlSafeForToken(server.url)) {
            Log.w(TAG, "setAuthToken rejected: ${id} url is http://non-loopback (use HTTPS)")
            return false
        }
        val ok = if (token.isBlank()) {
            McpTokenStore.clear(context, id)
        } else {
            McpTokenStore.write(context, id, token)
        }
        if (ok) {
            // Use the same disk snapshot used for the existence
            // check above, NOT `_state.value` — the collector lag
            // means `_state` may be missing the server we just
            // validated against, and the rebuilt shadow would be
            // a stale list (potentially missing the just-added
            // server during the create-server -> write -> setAuthToken
            // flow). Copilot R3 PR #352 finding.
            rebuildRollbackShadow(context, s.read().servers)
            ownedScope?.launch { NodeControlClient.reconcile(id) }
        }
        return ok
    }

    /**
     * Read the decrypted token for [id]. `""` if absent or decryption
     * failed (matches [McpTokenStore.read]). Process-agnostic — works
     * in `:node` without [init] having run.
     */
    fun getAuthToken(context: Context, id: String): String =
        McpTokenStore.read(context, id)

    /**
     * Remove the stored token for [id]. Same return semantics as
     * [setAuthToken] with an empty token.
     */
    fun clearAuthToken(context: Context, id: String): Boolean = setAuthToken(context, id, "")

    // ---- Validation predicates (visible for testing) -------------------

    internal fun isValid(s: McpServer): Boolean {
        if (!ID_REGEX.matches(s.id)) return false
        if (s.name.isBlank()) return false
        if (!isValidUrl(s.url)) return false
        if (s.rateLimit <= 0) return false
        return true
    }

    internal fun reasonFor(s: McpServer): String {
        if (!ID_REGEX.matches(s.id)) return "id '${s.id}' fails $ID_REGEX"
        if (s.name.isBlank()) return "name blank"
        if (!isValidUrl(s.url)) return "url '${s.url}' invalid (must be http(s) with non-empty host)"
        if (s.rateLimit <= 0) return "rateLimit ${s.rateLimit} <= 0"
        return "ok"
    }

    private fun isValidUrl(raw: String): Boolean {
        // Trim before parse so whitespace-padded URLs from observed
        // file content (manual edit, or a Node-side pre-trim quirk)
        // don't get rejected here while Node's mcp-servers.js read()
        // accepts and normalizes them. `onObserved` separately trims
        // the stored value into _state so the cross-language behavior
        // is symmetric: both sides accept whitespace AND both sides
        // strip it before storage. Copilot R6/R7 PR #352 finding.
        val trimmed = raw.trim()
        if (trimmed.isBlank()) return false
        return try {
            val u = URL(trimmed)
            val scheme = u.protocol?.lowercase()
            val host = u.host?.lowercase()
            (scheme == "http" || scheme == "https") && !host.isNullOrBlank()
        } catch (_: Exception) {
            false
        }
    }

    /**
     * `false` iff the URL is `http://` AND the host is NOT a loopback.
     * Plain HTTPS — secure. Plain HTTP to localhost — secure (no wire).
     * Plain HTTP elsewhere — insecure for bearer tokens.
     *
     * Mirrors `mcp-client.js`'s constructor check (lines 186-194 of
     * the pre-BAT-514 file) so the same rule applies at write time
     * AND connect time.
     */
    private fun isUrlSafeForToken(raw: String): Boolean {
        // `isValidUrl` trims internally before parse, so a
        // whitespace-padded URL can pass it but `URL(raw)` here would
        // throw on the same input. Trim + try/catch defensively to
        // keep this predicate from killing callers on what is
        // logically a valid URL. (Copilot R10 PR #352 finding.)
        val trimmed = raw.trim()
        return try {
            val u = URL(trimmed)
            val scheme = u.protocol.lowercase()
            if (scheme == "https") return true
            val host = u.host.lowercase()
            host == "localhost" || host == "127.0.0.1" || host == "::1"
        } catch (_: Exception) {
            false
        }
    }

    private fun hasInsecureToken(context: Context, server: McpServer): Boolean {
        val token = McpTokenStore.read(context, server.id)
        if (token.isBlank()) return false
        return !isUrlSafeForToken(server.url)
    }

    /**
     * Mirror Node's `safeId` normalization (mcp-client.js line 174):
     * `replace(/[^a-zA-Z0-9_-]/g, '_')` — note the dash IS preserved
     * on both sides so `server-1` is NOT folded to `server_1`. The
     * post-normalization uniqueness check below is identity for any
     * id that already passes [ID_REGEX] (since the regex's allowed
     * set matches safeId's preserved set), but it remains as defense-
     * in-depth: if [ID_REGEX] is ever loosened to allow e.g. `.`,
     * Node would fold that to `_` via safeId, and this check would
     * catch the resulting collision before either side sees it.
     */
    private fun normalizeId(id: String): String =
        id.replace(Regex("[^A-Za-z0-9_-]"), "_")

    // ---- Collector path -------------------------------------------------

    /**
     * Production-side wrapper around [onObserved]: drops invalid
     * entries from the file (NOT a UI write — the file came from
     * elsewhere, possibly a partial write or a manual edit) and
     * publishes the cleaned list to [_state]. Also rebuilds the
     * rollback shadow + notifies UI when the cleaned list differs
     * from current state.
     */
    private fun observeFromCollector(observed: McpServersFile) {
        val cleaned = onObserved(observed)
        val app = appContext ?: return
        // Rebuild the legacy shadow only when the cleaned list
        // actually differs from the prior _state — otherwise the
        // cross-process broadcast amplifies on every redundant
        // FileObserver tick.
        if (cleaned != _previousMirrored) {
            rebuildRollbackShadow(app, cleaned)
            _previousMirrored = cleaned
            // Compose UI screens that read the legacy shadow via
            // ConfigManager.loadMcpServers need a configVersion bump
            // to recompose. Mirrors the BAT-513 RuntimeStateStore
            // collector path.
            ConfigManager.signalConfigChanged(app)
        }
    }

    /**
     * Pure helper: trim name + url, drop invalid entries with a WARN
     * log, drop duplicates after `safeId` normalization (keep first),
     * publish the cleaned list to [_state]. Returns the cleaned list
     * so callers can decide whether to fire side effects.
     *
     * Trimming mirrors Node's `mcp-servers.js read()` so the two
     * sides agree on the canonical stored shape; otherwise a
     * whitespace-padded value (manual file edit, copy-paste with a
     * trailing space) would be accepted by Node's tolerant parse but
     * stored verbatim by Kotlin and produce cross-language drift on
     * downstream comparisons.
     */
    internal fun onObserved(observed: McpServersFile): List<McpServer> {
        val cleaned = mutableListOf<McpServer>()
        val seen = mutableSetOf<String>()
        for (raw in observed.servers) {
            val s = raw.copy(name = raw.name.trim(), url = raw.url.trim())
            if (!isValid(s)) {
                Log.w(TAG, "dropped corrupt entry id=${s.id} reason=${reasonFor(s)}")
                continue
            }
            val normalized = normalizeId(s.id)
            if (!seen.add(normalized)) {
                Log.w(
                    TAG,
                    "dropped duplicate entry id=${s.id} (normalizes to $normalized)",
                )
                continue
            }
            cleaned.add(s)
        }
        _state.value = cleaned
        return cleaned
    }

    // Track last-mirrored to dedupe collector emissions (BAT-513
    // pattern). Nullable + sentinel-checked: the first emission after
    // init() always mirrors regardless of equality, since the legacy
    // shadow may be stale relative to a Node-side write that landed
    // before the collector started.
    @Volatile
    private var _previousMirrored: List<McpServer>? = null

    // ---- Rollback shadow + orphan sweep --------------------------------

    /**
     * Reconstruct legacy `KEY_MCP_SERVERS_ENC` from [servers] PLUS the
     * per-id tokens read fresh from [McpTokenStore]'s encrypted token
     * files (`filesDir/mcp_tokens/<id>`). A pre-BAT-514 build
     * downgraded onto the current state expects each server entry to
     * carry its `authToken` inline — without re-attaching here,
     * downgrade would silently break authenticated MCP servers.
     *
     * Writes the same JSON shape the pre-BAT-514 `loadMcpServers`
     * path expects (servers with `authToken` inline), encrypted via
     * [KeystoreHelper] and Base64'd into `KEY_MCP_SERVERS_ENC`. The
     * legacy writer (`ConfigManager.saveMcpServers`) was deleted in
     * BAT-514 — this method is now the only writer of that prefs
     * key, and the only reader is [ConfigManager.loadMcpServers]
     * (cold-start config.json regeneration + SettingsScreen count).
     */
    private fun rebuildRollbackShadow(context: Context, servers: List<McpServer>) {
        val arr = JSONArray()
        for (s in servers) {
            val token = McpTokenStore.read(context, s.id)
            arr.put(JSONObject().apply {
                put("id", s.id)
                put("name", s.name)
                put("url", s.url)
                put("authToken", token)
                put("enabled", s.enabled)
                put("rateLimit", s.rateLimit)
            })
        }
        try {
            val enc = KeystoreHelper.encrypt(arr.toString())
            // commit() not apply(): the rollback shadow is the
            // pre-BAT-514 build's source of truth on downgrade. The
            // PR's known-limitation note specifically scopes the
            // race to "the millisecond window during commit()" —
            // apply() is async and would widen that window to
            // include arbitrary deferred-write delay (Android batches
            // apply() flushes). All callers run on Dispatchers.IO so
            // the synchronous wait is benign, and synchronous
            // persistence here preserves the intended downgrade-
            // durability contract. (Copilot R8 PR #352 finding.)
            // Surface a commit() failure: the rollback shadow is
            // explicitly part of the downgrade-durability contract,
            // so a silent failure here would defeat that guarantee
            // for the user without any diagnostic trail. (Copilot
            // R11 PR #352 finding.)
            val committed = context.applicationContext
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_MCP_SERVERS_ENC, Base64.encodeToString(enc, Base64.NO_WRAP))
                .commit()
            if (!committed) {
                Log.w(TAG, "rebuildRollbackShadow commit failed; downgrade shadow not durably persisted")
            }
        } catch (e: Exception) {
            Log.w(TAG, "rebuildRollbackShadow failed: ${e.message}")
        }
    }

    /**
     * Clear `mcp_tokens/<id>` files for ids not present in [current].
     * Catches the case where a previous build deleted a server but the
     * pre-BAT-514 path didn't have a per-id token to clear (it just
     * rewrote the whole encrypted list).
     */
    private fun sweepOrphanTokens(context: Context, current: List<McpServer>) {
        val knownIds = current.map { it.id }.toSet()
        val tokenIds = McpTokenStore.listAllIds(context)
        for (id in tokenIds) {
            if (id !in knownIds) {
                Log.i(TAG, "clearing orphan token mcp_tokens/$id (no matching server)")
                McpTokenStore.clear(context, id)
            }
        }
    }

    // ---- Test seams ----------------------------------------------------

    @androidx.annotation.VisibleForTesting
    internal fun resetForTest() {
        ownedScope?.cancel()
        ownedScope = null
        store?.close()
        store = null
        appContext = null
        _state.value = emptyList()
        _previousMirrored = null
        initialized.set(false)
    }
}

/**
 * Convert the legacy [McpServerConfig] (which carries authToken inline)
 * to the BAT-514 [McpServer] (no authToken). The migration path uses
 * this to seed `_state` from the pre-BAT-514 prefs blob.
 */
private fun McpServerConfig.toMcpServer(): McpServer = McpServer(
    id = id,
    name = name,
    url = url,
    enabled = enabled,
    rateLimit = rateLimit,
)
