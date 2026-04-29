package com.seekerclaw.app.state

import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import android.util.Log
import com.seekerclaw.app.config.KeystoreHelper

/**
 * Process-agnostic encrypted-prefs helper for MCP server auth tokens
 * (BAT-514).
 *
 * Each token is encrypted via [KeystoreHelper] (Keystore-backed AES-GCM,
 * same as the rest of the app's per-secret prefs entries), base64'd, and
 * stored in `seekerclaw_prefs` under the key `mcp_token_<id>`.
 *
 * ## Why this is split out from [McpServersStore]
 *
 * Token I/O has to work in BOTH processes:
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
 * which process invoked it; `init()` isn't a precondition. Shared prefs
 * are file-backed and accessible cross-process for read, and the
 * Keystore key itself is per-app (not per-process), so the same
 * encrypted blob decrypts identically in either process.
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
    private const val PREFS_NAME = "seekerclaw_prefs"
    private const val KEY_PREFIX = "mcp_token_"

    private fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private fun keyFor(id: String): String = KEY_PREFIX + id

    /**
     * Read the decrypted token for [id]. Returns `""` (empty) when no
     * token is stored OR decryption fails — callers can't distinguish,
     * which is intentional: a corrupt entry should behave the same as
     * "no token" (the connect path handles missing tokens by attempting
     * unauthenticated, and a `WARN` log here is enough for diagnostics).
     */
    fun read(context: Context, id: String): String {
        val raw = prefs(context).getString(keyFor(id), null) ?: return ""
        return try {
            KeystoreHelper.decrypt(Base64.decode(raw, Base64.NO_WRAP))
        } catch (e: Exception) {
            // Corrupt entry — treat as missing rather than crash the
            // bridge endpoint. The user can re-enter the token in
            // Settings if the connect attempt fails.
            Log.w(TAG, "Failed to decrypt mcp_token_$id: ${e.message}")
            ""
        }
    }

    /**
     * Encrypt + persist [token] under [id]. Returns `true` on success,
     * `false` on encryption / commit failure (caller surfaces via UX).
     * Empty / blank [token] writes nothing and returns `false` — use
     * [clear] to remove a token explicitly.
     */
    fun write(context: Context, id: String, token: String): Boolean {
        if (token.isBlank()) return false
        return try {
            val enc = KeystoreHelper.encrypt(token)
            prefs(context).edit()
                .putString(keyFor(id), Base64.encodeToString(enc, Base64.NO_WRAP))
                .commit()
        } catch (e: Exception) {
            Log.w(TAG, "Failed to write mcp_token_$id: ${e.message}")
            false
        }
    }

    /**
     * Remove the token entry for [id]. Returns `true` if the commit
     * succeeded (whether or not a key was present beforehand).
     */
    fun clear(context: Context, id: String): Boolean {
        return try {
            prefs(context).edit().remove(keyFor(id)).commit()
        } catch (e: Exception) {
            Log.w(TAG, "Failed to clear mcp_token_$id: ${e.message}")
            false
        }
    }

    /**
     * Return the set of server ids that currently have a token entry.
     * Used by [McpServersStore.init] to detect orphan tokens (tokens
     * whose server was deleted while a previous build was running and
     * the legacy `saveMcpServers` path didn't clean them up).
     */
    fun listAllIds(context: Context): List<String> {
        return prefs(context).all.keys
            .asSequence()
            .filter { it.startsWith(KEY_PREFIX) }
            .map { it.removePrefix(KEY_PREFIX) }
            .toList()
    }
}
