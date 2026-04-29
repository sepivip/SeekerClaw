package com.seekerclaw.app.state

import android.content.Context
import android.util.Log
import com.seekerclaw.app.config.KeystoreHelper
import java.io.File

/**
 * Process-agnostic encrypted-file helper for MCP server auth tokens
 * (BAT-514).
 *
 * Each token is encrypted via [KeystoreHelper] (Keystore-backed AES-GCM,
 * same primitive used elsewhere for at-rest secrets) and persisted as
 * its own file under `filesDir/mcp_tokens/<id>`. Atomic-rename writes
 * keep readers from observing partial files.
 *
 * ## Why files instead of SharedPreferences
 *
 * Earlier BAT-514 drafts stored tokens as encrypted blobs in
 * `seekerclaw_prefs` keyed by `mcp_token_<id>`. The
 * [com.seekerclaw.app.util.CrossProcessStore] class doc explicitly
 * calls SharedPreferences "BROKEN cross-process — every field that's
 * read on BOTH UI and `:node` sides has the same staleness bug": each
 * process has its own in-memory `SharedPreferencesImpl` cache that
 * doesn't reload after another process writes. For the BAT-514
 * live-token-edit contract this would mean the FIRST token read in
 * `:node` (cache miss → fresh disk load) sees the right value, but
 * every subsequent edit returns the cached pre-edit value. Token
 * rotation would silently fail until the service restarts.
 *
 * Switching to files-on-disk fixes this: every [read] does a fresh
 * `File.readBytes()`, so `:node`'s view always matches whatever the
 * main process most-recently wrote. (Copilot R10 PR #352 finding.)
 *
 * ## Token I/O works in BOTH processes
 *
 *  - **Main process:** Settings UI writes / clears via [McpServersStore]
 *    wrapper methods, which delegate to this object.
 *  - **`:node` process:** AndroidBridge's `POST /config/mcp-token`
 *    handler reads the token to give it to the Node MCP client. That
 *    handler runs in `:node` (where `AndroidBridge` lives — see
 *    `AndroidManifest.xml:55 android:process=":node"`).
 *
 * Putting reads in [McpServersStore] would gate them on
 * `McpServersStore.init()` (main-process-only, per the BAT-513 pattern).
 * Splitting reads here means the bridge endpoint works regardless of
 * which process invoked it; `init()` isn't a precondition. The
 * Keystore key is per-app (not per-process), so the same encrypted
 * file decrypts identically in either process.
 *
 * ## What this does NOT do
 *
 *  - Does NOT manage the server list (id/name/url/enabled/rateLimit) —
 *    that's [McpServersStore]'s domain.
 *  - Does NOT register secrets for log redaction — Node owns that
 *    after fetching the token in `MCPClient.connect`. See
 *    `mcp-client.js`.
 *  - Does NOT trigger reconnect on token change — [McpServersStore]
 *    wrappers call `NodeControlClient.reconcile(id)` for that.
 */
object McpTokenStore {
    private const val TAG = "McpTokenStore"
    private const val DIR_NAME = "mcp_tokens"

    /**
     * Same alphabet [McpServersStore.ID_REGEX] enforces. Validating at
     * the file boundary prevents path traversal (`../`, `/`) and any
     * caller bug from materializing a file outside `mcp_tokens/`.
     */
    private val ID_REGEX = Regex("^[A-Za-z0-9_-]+$")

    private fun dir(context: Context): File {
        val d = File(context.applicationContext.filesDir, DIR_NAME)
        if (!d.exists()) d.mkdirs()
        return d
    }

    private fun fileFor(context: Context, id: String): File? {
        if (!ID_REGEX.matches(id)) return null
        return File(dir(context), id)
    }

    /**
     * Read the decrypted token for [id]. Returns `""` (empty) when no
     * token is stored OR decryption fails — callers can't distinguish,
     * which is intentional: a corrupt entry should behave the same as
     * "no token" (the connect path handles missing tokens by attempting
     * unauthenticated, and a `WARN` log here is enough for diagnostics).
     *
     * Always reads fresh from disk — no caching layer that could go
     * stale after a write from another process.
     */
    fun read(context: Context, id: String): String {
        val file = fileFor(context, id) ?: return ""
        if (!file.exists()) return ""
        return try {
            KeystoreHelper.decrypt(file.readBytes())
        } catch (e: Exception) {
            // Corrupt or partially-written entry — treat as missing
            // rather than crash the bridge endpoint. The user can
            // re-enter the token in Settings if the connect attempt
            // fails.
            Log.w(TAG, "Failed to decrypt mcp_tokens/$id: ${e.message}")
            ""
        }
    }

    /**
     * Encrypt + persist [token] under [id]. Returns `true` on success,
     * `false` on encryption or filesystem failure (caller surfaces via
     * UX). Empty / blank [token] writes nothing and returns `false` —
     * use [clear] to remove a token explicitly.
     *
     * Atomic via tmp-file + `renameTo` — readers either see the prior
     * file (or no file, if first write) or the new one, never a
     * truncated mid-write.
     */
    fun write(context: Context, id: String, token: String): Boolean {
        if (token.isBlank()) return false
        val file = fileFor(context, id) ?: return false
        return try {
            val enc = KeystoreHelper.encrypt(token)
            val tmp = File(file.parentFile, "$id.tmp")
            tmp.writeBytes(enc)
            // renameTo on the same filesystem is atomic on the
            // Android-supported filesystems (ext4, F2FS) — same
            // guarantee CrossProcessStore relies on for its tmp+move
            // pattern. If the rename ever fails, fall through to
            // false so the caller knows the write didn't land.
            if (tmp.renameTo(file)) {
                true
            } else {
                Log.w(TAG, "renameTo failed for mcp_tokens/$id; tmp file left in place")
                false
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to write mcp_tokens/$id: ${e.message}")
            false
        }
    }

    /**
     * Remove the token entry for [id]. Returns `true` if the file is
     * gone after the call (whether or not it existed before).
     */
    fun clear(context: Context, id: String): Boolean {
        val file = fileFor(context, id) ?: return false
        return try {
            if (!file.exists()) return true
            file.delete()
        } catch (e: Exception) {
            Log.w(TAG, "Failed to clear mcp_tokens/$id: ${e.message}")
            false
        }
    }

    /**
     * Return the set of server ids that currently have a token file.
     * Used by [McpServersStore.init] to detect orphan tokens (tokens
     * whose server was deleted while a previous build was running and
     * the legacy `saveMcpServers` path didn't clean them up). Skips
     * stale `<id>.tmp` files left by a crashed write.
     */
    fun listAllIds(context: Context): List<String> {
        return dir(context).listFiles()
            ?.asSequence()
            ?.filter { it.isFile && ID_REGEX.matches(it.name) }
            ?.map { it.name }
            ?.toList()
            ?: emptyList()
    }
}
