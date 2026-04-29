package com.seekerclaw.app.ui.settings

import android.net.Uri
import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.runtime.collectAsState
import com.seekerclaw.app.state.McpServer
import com.seekerclaw.app.state.McpServersStore
import com.seekerclaw.app.ui.components.CardSurface
import com.seekerclaw.app.ui.components.SectionLabel
import com.seekerclaw.app.ui.components.SeekerClawScaffold
import com.seekerclaw.app.ui.components.SeekerClawSwitch
import com.seekerclaw.app.ui.theme.RethinkSans
import com.seekerclaw.app.ui.theme.SeekerClawColors

@Composable
fun McpConfigScreen(onBack: () -> Unit) {
    val context = LocalContext.current

    // BAT-514: observe `McpServersStore.state` directly. Reads come
    // from `mcp_servers.json` (the cross-process source of truth),
    // not the legacy KEY_MCP_SERVERS_ENC prefs blob — so a Telegram
    // /mcp edit (when that lands) or any other-process write reflects
    // here within ~1-2s of the file change.
    val mcpServers by McpServersStore.state.collectAsState()
    var showMcpDialog by remember { mutableStateOf(false) }
    var editingMcpServer by remember { mutableStateOf<McpServer?>(null) }
    var showDeleteMcpDialog by remember { mutableStateOf(false) }
    var deletingMcpServer by remember { mutableStateOf<McpServer?>(null) }
    // BAT-514: no restart prompt for MCP edits. The Node side picks
    // up file changes via fs.watch + the bridge `/mcp/reconcile`
    // endpoint within ~1-2s, so the agent never needs to be
    // restarted for an MCP server add/edit/disable/delete/token
    // change. The StateFlow-driven list above provides the visual
    // confirmation (Copilot R5 PR #352 finding — the prior restart
    // prompt contradicted the BAT-514 design).

    // BAT-514 R2: McpServersStore.write / setAuthToken do disk I/O
    // (JSON encode + atomic move + KeystoreHelper encrypt for the
    // rollback-shadow rebuild) and need to run off the UI thread to
    // avoid jank / StrictMode / ANR. All click handlers below dispatch
    // through this scope onto Dispatchers.IO; UI state updates land
    // back on Main via withContext.
    val scope = rememberCoroutineScope()

    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)

    SeekerClawScaffold(title = "MCP Servers", onBack = onBack) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 20.dp, vertical = 8.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            SectionLabel("MCP Servers")
            Spacer(modifier = Modifier.height(10.dp))

            CardSurface {
                Text(
                    text = SettingsHelpTexts.MCP_SERVERS,
                    fontFamily = RethinkSans,
                    fontSize = 13.sp,
                    color = SeekerClawColors.TextDim,
                )

                Spacer(modifier = Modifier.height(12.dp))

                if (mcpServers.isEmpty()) {
                    Text(
                        text = "No servers configured",
                        fontFamily = RethinkSans,
                        fontSize = 13.sp,
                        color = SeekerClawColors.TextDim,
                        fontStyle = FontStyle.Italic,
                    )
                } else {
                    for (server in mcpServers) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 6.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    text = server.name,
                                    fontFamily = RethinkSans,
                                    fontSize = 14.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = SeekerClawColors.TextPrimary,
                                )
                                Text(
                                    text = server.url,
                                    fontFamily = FontFamily.Monospace,
                                    fontSize = 11.sp,
                                    color = SeekerClawColors.TextDim,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                SeekerClawSwitch(
                                    checked = server.enabled,
                                    onCheckedChange = { enabled ->
                                        val targetId = server.id
                                        // BAT-514 R9: route through
                                        // update() for atomic RMW
                                        // against the latest disk
                                        // snapshot. write(mcpServers.map{}
                                        // would compute from the UI's
                                        // collected StateFlow value,
                                        // which lags behind disk by a
                                        // collector tick — two rapid
                                        // toggles (or a toggle racing
                                        // a /provider write from :node)
                                        // could overwrite each other.
                                        scope.launch {
                                            val ok = withContext(Dispatchers.IO) {
                                                McpServersStore.update { current ->
                                                    current.map {
                                                        if (it.id == targetId) it.copy(enabled = enabled) else it
                                                    }
                                                }
                                            }
                                            // Success path is silent —
                                            // StateFlow refreshes the list
                                            // and Node reconciles within
                                            // ~1-2s. Failure surfaces a
                                            // Toast and reverts via the
                                            // StateFlow re-read.
                                            if (!ok) {
                                                Toast.makeText(
                                                    context,
                                                    "Couldn't update server",
                                                    Toast.LENGTH_SHORT,
                                                ).show()
                                            }
                                        }
                                    },
                                )
                                IconButton(onClick = {
                                    editingMcpServer = server
                                    showMcpDialog = true
                                }) {
                                    Icon(
                                        imageVector = Icons.Default.Edit,
                                        contentDescription = "Edit server",
                                        tint = SeekerClawColors.TextDim,
                                    )
                                }
                                IconButton(onClick = {
                                    deletingMcpServer = server
                                    showDeleteMcpDialog = true
                                }) {
                                    Icon(
                                        imageVector = Icons.Default.Delete,
                                        contentDescription = "Remove server",
                                        tint = SeekerClawColors.Error,
                                    )
                                }
                            }
                        }
                    }
                }

                Spacer(modifier = Modifier.height(8.dp))

                Button(
                    onClick = {
                        editingMcpServer = null
                        showMcpDialog = true
                    },
                    modifier = Modifier.fillMaxWidth(),
                    shape = shape,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = SeekerClawColors.ActionPrimary,
                        contentColor = Color.White,
                    ),
                ) {
                    Text("Add MCP Server", fontFamily = RethinkSans, fontSize = 14.sp)
                }
            }

            Spacer(modifier = Modifier.height(20.dp))
        }
    }

    // ==================== MCP Server Add/Edit Dialog ====================
    if (showMcpDialog) {
        var mcpName by remember(editingMcpServer) { mutableStateOf(editingMcpServer?.name ?: "") }
        var mcpUrl by remember(editingMcpServer) { mutableStateOf(editingMcpServer?.url ?: "") }
        // BAT-514: tokens live in encrypted files (`mcp_tokens/<id>`).
        // Hydrate the field via LaunchedEffect on Dispatchers.IO —
        // KeystoreHelper.decrypt is blocking and was running on the
        // composition thread inside `remember { }` before the R2 fix.
        // While the decrypt is in flight the field stays "" (the
        // PasswordVisualTransformation hides the placeholder anyway,
        // so the user doesn't see flicker).
        var mcpToken by remember(editingMcpServer) { mutableStateOf("") }
        // BAT-514 R16: track whether the user has typed in the token
        // field. Used for two related bugs the prior implementation
        // had:
        //   (a) The async hydration could clobber what the user typed
        //       between dialog open and getAuthToken returning
        //       (Copilot R16 t1).
        //   (b) The Save flow inferred "did this server have a stored
        //       token?" via `getAuthToken(...).isNotEmpty()`, which
        //       returns "" both for "no token" AND for
        //       "present-but-corrupt token" — the user couldn't clear
        //       a corrupted entry (Copilot R16 t2).
        // Tracking explicit user edits lets us:
        //   - skip auto-fill if the user has touched the field, AND
        //   - only call setAuthToken when the user explicitly typed
        //     (set or cleared) — never overwriting stored state via
        //     a stale empty mcpToken from a slow async hydrate.
        var tokenEdited by remember(editingMcpServer) { mutableStateOf(false) }
        LaunchedEffect(editingMcpServer) {
            val target = editingMcpServer
            if (target == null) {
                mcpToken = ""
            } else {
                val storedToken = withContext(Dispatchers.IO) {
                    McpServersStore.getAuthToken(context, target.id)
                }
                if (storedToken.isEmpty()) {
                    // `""` from getAuthToken means EITHER no token is
                    // stored OR the token file exists but couldn't be
                    // decrypted (Keystore failure, file corruption).
                    // Self-heal the corrupt-file case: force tokenEdited
                    // so the user's next Save calls setAuthToken("")
                    // and clears the stale file. Without this, the
                    // file lingers and the http+token gate keeps
                    // blocking edits via `hasToken` even though the
                    // UI shows an empty field. (Copilot R17 PR #352
                    // finding.)
                    val corruptFilePresent = withContext(Dispatchers.IO) {
                        McpServersStore.hasAuthToken(context, target.id)
                    }
                    if (corruptFilePresent) {
                        tokenEdited = true
                    }
                } else if (!tokenEdited) {
                    // Only auto-fill if the user hasn't started typing
                    // yet — otherwise we'd overwrite their input.
                    mcpToken = storedToken
                }
            }
        }

        AlertDialog(
            onDismissRequest = { showMcpDialog = false },
            title = {
                Text(
                    if (editingMcpServer != null) "Edit MCP Server" else "Add MCP Server",
                    fontFamily = RethinkSans,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.TextPrimary,
                )
            },
            text = {
                Column {
                    OutlinedTextField(
                        value = mcpName,
                        onValueChange = { mcpName = it },
                        label = { Text("Name", fontFamily = RethinkSans) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = SeekerClawColors.Accent,
                            unfocusedBorderColor = SeekerClawColors.BorderSubtle,
                            focusedTextColor = SeekerClawColors.TextPrimary,
                            unfocusedTextColor = SeekerClawColors.TextPrimary,
                            cursorColor = SeekerClawColors.Accent,
                            focusedLabelColor = SeekerClawColors.Accent,
                            unfocusedLabelColor = SeekerClawColors.TextDim,
                        ),
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    OutlinedTextField(
                        value = mcpUrl,
                        onValueChange = { mcpUrl = it },
                        label = { Text("Server URL", fontFamily = RethinkSans) },
                        placeholder = { Text("https://mcp.example.com/mcp", color = SeekerClawColors.TextDim) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = SeekerClawColors.Accent,
                            unfocusedBorderColor = SeekerClawColors.BorderSubtle,
                            focusedTextColor = SeekerClawColors.TextPrimary,
                            unfocusedTextColor = SeekerClawColors.TextPrimary,
                            cursorColor = SeekerClawColors.Accent,
                            focusedLabelColor = SeekerClawColors.Accent,
                            unfocusedLabelColor = SeekerClawColors.TextDim,
                        ),
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    OutlinedTextField(
                        value = mcpToken,
                        onValueChange = { mcpToken = it; tokenEdited = true },
                        label = { Text("Auth Token (optional)", fontFamily = RethinkSans) },
                        visualTransformation = PasswordVisualTransformation(),
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = SeekerClawColors.Accent,
                            unfocusedBorderColor = SeekerClawColors.BorderSubtle,
                            focusedTextColor = SeekerClawColors.TextPrimary,
                            unfocusedTextColor = SeekerClawColors.TextPrimary,
                            cursorColor = SeekerClawColors.Accent,
                            focusedLabelColor = SeekerClawColors.Accent,
                            unfocusedLabelColor = SeekerClawColors.TextDim,
                        ),
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        val trimName = mcpName.trim()
                        val trimUrl = mcpUrl.trim()
                        // Validate URL format before saving
                        val isValidUrl = try {
                            val uri = Uri.parse(trimUrl)
                            uri.scheme in listOf("https", "http") && !uri.host.isNullOrBlank()
                        } catch (_: Exception) { false }
                        if (!isValidUrl) {
                            Toast.makeText(context, "Invalid URL. Must start with https:// or http://", Toast.LENGTH_SHORT).show()
                            return@TextButton
                        }
                        // Warn if auth token + plain HTTP (non-localhost)
                        val trimToken = mcpToken.trim()
                        if (trimToken.isNotBlank()) {
                            val uri = Uri.parse(trimUrl)
                            val isHttps = uri.scheme == "https"
                            val isLocalhost = uri.host in listOf("localhost", "127.0.0.1", "::1", "[::1]")
                            if (!isHttps && !isLocalhost) {
                                Toast.makeText(context, "Auth token requires HTTPS (or localhost)", Toast.LENGTH_SHORT).show()
                                return@TextButton
                            }
                        }
                        if (trimName.isNotBlank() && trimUrl.isNotBlank()) {
                            // UUID generated for new entries — UUID
                            // characters (hex + "-") all match
                            // McpServersStore.ID_REGEX.
                            val serverId = editingMcpServer?.id
                                ?: java.util.UUID.randomUUID().toString()
                            val server = McpServer(
                                id = serverId,
                                name = trimName,
                                url = trimUrl,
                                enabled = editingMcpServer?.enabled ?: true,
                                rateLimit = editingMcpServer?.rateLimit ?: 10,
                            )
                            val tokenValue = mcpToken.trim()
                            val wasEditing = editingMcpServer != null
                            // BAT-514 R9/R13: route through update() for
                            // a fresh-disk-read + transform + atomic
                            // write. Picks up edits from another
                            // screen or the :node side that the UI's
                            // collected `mcpServers` snapshot might
                            // not have observed yet. Validation
                            // failures (invalid id, dup id, http +
                            // token) surface as `false` directly —
                            // McpServersStore.update returns false
                            // without throwing, so the Toast path
                            // handles them naturally.
                            scope.launch {
                                val writeOk = withContext(Dispatchers.IO) {
                                    McpServersStore.update { current ->
                                        if (wasEditing) {
                                            current.map { if (it.id == serverId) server else it }
                                        } else {
                                            current + server
                                        }
                                    }
                                }
                                if (!writeOk) {
                                    Toast.makeText(
                                        context,
                                        "Couldn't save server (check URL / token over insecure HTTP)",
                                        Toast.LENGTH_LONG,
                                    ).show()
                                    return@launch
                                }
                                // Token is optional. Only route through
                                // setAuthToken when the user explicitly
                                // typed in the token field — `tokenEdited`
                                // tracks that. This is more robust than
                                // the previous `getAuthToken(...).isNotEmpty()`
                                // check, which couldn't distinguish "no
                                // token" from "present-but-corrupt token"
                                // (both return "" by design) and would
                                // either silently skip a corrupt-clear OR
                                // overwrite a stored token with a stale
                                // empty `mcpToken` if the user clicked
                                // Save before the async hydrate completed.
                                // (Copilot R16 PR #352 finding.)
                                if (tokenEdited) {
                                    val tokenOk = withContext(Dispatchers.IO) {
                                        McpServersStore.setAuthToken(context, serverId, tokenValue)
                                    }
                                    if (!tokenOk) {
                                        Toast.makeText(
                                            context,
                                            "Server saved, but token couldn't be stored",
                                            Toast.LENGTH_LONG,
                                        ).show()
                                    }
                                }
                                showMcpDialog = false
                            }
                        }
                    },
                    enabled = mcpName.trim().isNotBlank() && mcpUrl.trim().isNotBlank(),
                ) {
                    Text(
                        "Save",
                        fontFamily = RethinkSans,
                        fontWeight = FontWeight.Bold,
                        color = if (mcpName.trim().isNotBlank() && mcpUrl.trim().isNotBlank()) SeekerClawColors.Accent else SeekerClawColors.TextDim,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showMcpDialog = false }) {
                    Text("Cancel", fontFamily = RethinkSans, color = SeekerClawColors.TextDim)
                }
            },
            containerColor = SeekerClawColors.Surface,
            shape = shape,
        )
    }

    // ==================== MCP Server Delete Dialog ====================
    if (showDeleteMcpDialog && deletingMcpServer != null) {
        AlertDialog(
            onDismissRequest = { showDeleteMcpDialog = false },
            title = {
                Text(
                    "Remove Server",
                    fontFamily = RethinkSans,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.TextPrimary,
                )
            },
            text = {
                Text(
                    "Remove \"${deletingMcpServer?.name}\"? Its tools will no longer be available to your agent.",
                    fontFamily = RethinkSans,
                    fontSize = 14.sp,
                    color = SeekerClawColors.TextSecondary,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    val targetId = deletingMcpServer?.id
                    // BAT-514 R9: route through update() for atomic
                    // RMW. Same rationale as the toggle handler —
                    // the UI's `mcpServers` snapshot lags behind disk
                    // by a collector tick, so a delete computed from
                    // a stale list could miss a concurrent edit.
                    scope.launch {
                        val ok = withContext(Dispatchers.IO) {
                            McpServersStore.update { current ->
                                current.filter { it.id != targetId }
                            }
                        }
                        if (ok) {
                            showDeleteMcpDialog = false
                            deletingMcpServer = null
                        } else {
                            Toast.makeText(
                                context,
                                "Couldn't remove server",
                                Toast.LENGTH_SHORT,
                            ).show()
                        }
                    }
                }) {
                    Text(
                        "Remove",
                        fontFamily = RethinkSans,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showDeleteMcpDialog = false }) {
                    Text("Cancel", fontFamily = RethinkSans, color = SeekerClawColors.TextDim)
                }
            },
            containerColor = SeekerClawColors.Surface,
            shape = shape,
        )
    }

    // No restart prompt — see comment at the top of this composable.
}
