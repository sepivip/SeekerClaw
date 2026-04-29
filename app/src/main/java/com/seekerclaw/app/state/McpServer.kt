package com.seekerclaw.app.state

import kotlinx.serialization.Serializable

/**
 * Single MCP (Model Context Protocol) server config entry persisted in
 * `mcp_servers.json` (BAT-514).
 *
 * `authToken` is intentionally NOT a field on this type — tokens live
 * in per-id encrypted files at `filesDir/mcp_tokens/<id>` (AES-GCM via
 * KeystoreHelper) and are fetched on connect by the Node side via the
 * AndroidBridge `/config/mcp-token` endpoint. Splitting credentials
 * from the file-IPC payload keeps `mcp_servers.json` plaintext-safe
 * (the legacy `KEY_MCP_SERVERS_ENC` rollback shadow stays the home
 * for tokens during downgrade — see [McpServersStore]).
 */
@Serializable
data class McpServer(
    val id: String,
    val name: String,
    val url: String,
    val enabled: Boolean = true,
    val rateLimit: Int = 10,
)

/**
 * Top-level shape persisted in `mcp_servers.json`. Wrapping the list in
 * an object (rather than serializing a bare `List<McpServer>`) gives
 * us a place to add file-level fields later without breaking parse
 * compatibility.
 */
@Serializable
data class McpServersFile(
    val servers: List<McpServer> = emptyList(),
)
