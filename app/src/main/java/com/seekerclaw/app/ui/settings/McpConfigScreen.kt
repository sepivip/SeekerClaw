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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
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
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.config.McpServerConfig
import com.seekerclaw.app.ui.components.CardSurface
import com.seekerclaw.app.ui.components.SectionLabel
import com.seekerclaw.app.ui.components.SeekerClawScaffold
import com.seekerclaw.app.ui.components.SeekerClawSwitch
import com.seekerclaw.app.ui.theme.RethinkSans
import com.seekerclaw.app.ui.theme.SeekerClawColors

@Composable
fun McpConfigScreen(onBack: () -> Unit) {
    val context = LocalContext.current

    var mcpServers by remember { mutableStateOf(emptyList<McpServerConfig>()) }
    var showMcpDialog by remember { mutableStateOf(false) }
    var editingMcpServer by remember { mutableStateOf<McpServerConfig?>(null) }
    var showDeleteMcpDialog by remember { mutableStateOf(false) }
    var deletingMcpServer by remember { mutableStateOf<McpServerConfig?>(null) }
    var showRestartDialog by remember { mutableStateOf(false) }

    // Load MCP servers off main thread (Keystore decrypt + JSON parse)
    val configVer by ConfigManager.configVersion
    LaunchedEffect(configVer) {
        mcpServers = withContext(Dispatchers.IO) {
            ConfigManager.loadMcpServers(context)
        }
    }

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
                                        mcpServers = mcpServers.map {
                                            if (it.id == server.id) it.copy(enabled = enabled) else it
                                        }
                                        ConfigManager.saveMcpServers(context, mcpServers)
                                        showRestartDialog = true
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
        var mcpToken by remember(editingMcpServer) { mutableStateOf(editingMcpServer?.authToken ?: "") }

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
                        onValueChange = { mcpToken = it },
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
                            val serverId = editingMcpServer?.id
                                ?: java.util.UUID.randomUUID().toString()
                            val server = if (editingMcpServer != null) {
                                editingMcpServer!!.copy(
                                    name = trimName,
                                    url = trimUrl,
                                    authToken = mcpToken.trim(),
                                )
                            } else {
                                McpServerConfig(
                                    id = serverId,
                                    name = trimName,
                                    url = trimUrl,
                                    authToken = mcpToken.trim(),
                                )
                            }
                            mcpServers = if (editingMcpServer != null) {
                                mcpServers.map { if (it.id == serverId) server else it }
                            } else {
                                mcpServers + server
                            }
                            ConfigManager.saveMcpServers(context, mcpServers)
                            showMcpDialog = false
                            showRestartDialog = true
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
                    mcpServers = mcpServers.filter { it.id != deletingMcpServer?.id }
                    ConfigManager.saveMcpServers(context, mcpServers)
                    showDeleteMcpDialog = false
                    deletingMcpServer = null
                    showRestartDialog = true
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

    // ==================== Restart Prompt ====================
    if (showRestartDialog) {
        RestartDialog(
            context = context,
            onDismiss = { showRestartDialog = false },
        )
    }
}
