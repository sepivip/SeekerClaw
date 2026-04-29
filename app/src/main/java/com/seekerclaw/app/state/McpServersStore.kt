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
 * ## Field split (file vs. encrypted prefs)
 *
 *  - **File:** id, name, url, enabled, rateLimit. Plaintext JSON, safe
 *    for cross-process file IPC.
 *  - **Encrypted prefs:** authToken per server, keyed by `mcp_token_<id>`.
 *    Lives in `seekerclaw_prefs` via [KeystoreHelper] AES-GCM. Read on
 *    every connect by the Node side via AndroidBridge
 *    `POST /config/mcp-token`.
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
     * `safeId` normalization (the Node side replaces `[^A-Za-z0-9_]`
     * with `_`, so `server-1` and `server_1` would collide). The
     * regex itself doesn't allow `-` to be replaced — it allows `-`
     * intentionally — but `safeId` normalization is a stricter check
     * that catches collisions if the regex is ever loosened.
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
     * Ordering:
     *
     *  1. Read legacy [KEY_MCP_SERVERS_ENC] prefs (the pre-BAT-514
     *     source of truth). On upgrade, this contains servers WITH
     *     tokens; on fresh install, it's empty.
     *  2. If `mcp_servers.json` is missing AND prefs has servers:
     *     migrate. Split each entry → encrypt token to
     *     `mcp_token_<id>`, drop authToken from in-memory list,
     *     write cleaned list to file. Rebuild rollback shadow with
     *     tokens reattached.
     *  3. Sweep orphan tokens: any `mcp_token_*` key whose id isn't
     *     in the current server list is cleared.
     *  4. Start the observe-and-mirror collector.
     */
    fun init(context: Context) {
        if (!initialized.compareAndSet(false, true)) return
        val app = context.applicationContext
        appContext = app

        // Step 1: seed _state from prefs (last-valid pre-BAT-514 view).
        val legacy = ConfigManager.loadMcpServers(app)
        val seeded = legacy
            .map { it.toMcpServer() }
            .filter { isValid(it) }
        _state.value = seeded

        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        ownedScope = scope
        val cps = CrossProcessStore(
            context = app,
            fileName = FILE_NAME,
            serializer = McpServersFile.serializer(),
            initial = McpServersFile(servers = seeded),
            parentScope = scope,
        )
        store = cps

        scope.launch {
            // Step 2: migration write (one-shot if file is absent).
            val file = File(app.filesDir, FILE_NAME)
            if (!file.exists()) {
                // Encrypt every legacy token into per-id prefs FIRST,
                // so a crash after the file write but before this
                // loop doesn't lose tokens.
                for (s in legacy) {
                    if (s.authToken.isNotBlank()) {
                        McpTokenStore.write(app, s.id, s.authToken)
                    }
                }
                if (!cps.write(McpServersFile(servers = seeded))) {
                    Log.w(
                        TAG,
                        "first-launch migration write to $FILE_NAME failed — " +
                            "in-memory state retained; next save retries the file write",
                    )
                }
                rebuildRollbackShadow(app, seeded)
            }

            // Step 3: orphan token sweep.
            sweepOrphanTokens(app, _state.value)

            // Step 4: observe-and-mirror collector.
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
     * Read-modify-write under [CrossProcessStore]'s lock so
     * concurrent writes can't drop updates. The transformed list goes
     * through the same validity gate as [write] — an invalid result
     * throws [IllegalArgumentException] (caller tests / debug
     * builds) rather than silently persisting corrupt state.
     *
     * Returns `false` on init-not-called, lock acquisition failure,
     * or persist failure. The caller is expected to use [write] for
     * the simple replace-all path; this is for atomic delta cases
     * (toggle one server's `enabled`, edit one server's URL) where
     * read-then-write would race against `:node` writes.
     */
    suspend fun update(transform: (List<McpServer>) -> List<McpServer>): Boolean {
        val app = appContext ?: return false
        val s = store ?: return false
        // Capture pre-transform AND next snapshots inside the
        // CrossProcessStore.update lock so the post-update side
        // effects don't race the collector. Reading `_state.value`
        // after `s.update` returns is unreliable — the collector that
        // mirrors the disk write to `_state` runs on its own coroutine
        // and may not have observed the new value yet (Copilot R1
        // PR #352 finding).
        var pre: List<McpServer> = emptyList()
        var next: List<McpServer> = emptyList()
        val applied = s.update { current ->
            pre = current.servers
            val computed = transform(current.servers).toList()
            require(computed.all { isValid(it) }) {
                val bad = computed.firstOrNull { !isValid(it) }
                "Invalid entry after transform: id=${bad?.id} reason=${bad?.let { reasonFor(it) }}"
            }
            // Duplicate-id check inside the transform so the lock
            // covers it too (a concurrent write that produced the
            // duplicate can't slip through).
            val seen = mutableSetOf<String>()
            for (entry in computed) {
                val n = normalizeId(entry.id)
                require(seen.add(n)) {
                    "Duplicate id after normalization: ${entry.id} (normalizes to $n)"
                }
            }
            require(computed.none { hasInsecureToken(app, it) }) {
                "Server has token over insecure HTTP"
            }
            next = computed
            McpServersFile(servers = computed)
        }
        if (applied) {
            val nextIds = next.map { it.id }.toSet()
            for (id in pre.map { it.id }.toSet() - nextIds) {
                McpTokenStore.clear(app, id)
            }
            rebuildRollbackShadow(app, next)
            ownedScope?.launch { NodeControlClient.reconcile(null) }
        }
        return applied
    }

    /**
     * Persist [token] for [id] (encrypted prefs) and trigger reconcile.
     *
     * Returns `false` if [init] wasn't called, [id] doesn't match a
     * server in the list (token-without-server is meaningless), the
     * server's URL is `http://non-loopback` (insecure bearer reject),
     * or encryption / commit fails. Returns `true` once the token
     * lands in prefs — the reconcile dispatch is best-effort and its
     * outcome doesn't change this return.
     */
    fun setAuthToken(context: Context, id: String, token: String): Boolean {
        if (!isInitialized) return false
        val server = _state.value.firstOrNull { it.id == id }
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
            rebuildRollbackShadow(context, _state.value)
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
        if (raw.isBlank()) return false
        return try {
            val u = URL(raw)
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
        if (!isValidUrl(raw)) return false
        val u = URL(raw)
        val scheme = u.protocol.lowercase()
        if (scheme == "https") return true
        val host = u.host.lowercase()
        return host == "localhost" || host == "127.0.0.1" || host == "::1"
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
     * Pure helper: drop invalid entries with a WARN log, drop
     * duplicates after `safeId` normalization (keep first), publish
     * the cleaned list to [_state]. Returns the cleaned list so
     * callers can decide whether to fire side effects.
     */
    internal fun onObserved(observed: McpServersFile): List<McpServer> {
        val cleaned = mutableListOf<McpServer>()
        val seen = mutableSetOf<String>()
        for (s in observed.servers) {
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
     * encrypted-prefs tokens. A pre-BAT-514 build downgraded onto the
     * current state expects each server entry to carry its `authToken`
     * — without re-attaching here, downgrade would silently break
     * authenticated MCP servers.
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
            context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_MCP_SERVERS_ENC, Base64.encodeToString(enc, Base64.NO_WRAP))
                .apply()
        } catch (e: Exception) {
            Log.w(TAG, "rebuildRollbackShadow failed: ${e.message}")
        }
    }

    /**
     * Clear `mcp_token_<id>` entries for ids not present in [current].
     * Catches the case where a previous build deleted a server but the
     * pre-BAT-514 path didn't have a per-id token to clear (it just
     * rewrote the whole encrypted list).
     */
    private fun sweepOrphanTokens(context: Context, current: List<McpServer>) {
        val knownIds = current.map { it.id }.toSet()
        val tokenIds = McpTokenStore.listAllIds(context)
        for (id in tokenIds) {
            if (id !in knownIds) {
                Log.i(TAG, "clearing orphan token mcp_token_$id (no matching server)")
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
